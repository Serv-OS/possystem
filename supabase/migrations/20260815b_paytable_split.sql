-- Split payments on on-reader Pay at Table (task #103, 15 Aug).
--
-- terminal_start_table_payment_for grows p_amount_minor:
--   * null  → charge everything still OWED (bill minus approved split legs) —
--             identical to the old behaviour on a table with no legs.
--   * value → a PARTIAL leg for that amount (clamped to the remaining balance).
--
-- Money model (mirrors the POS SplitModal): a partial leg NEVER books its own
-- closed check — legs accumulate as approved terminal_jobs rows and the FINAL
-- leg's draft carries a priorLegs snapshot so the reconciler books ONE check
-- (full items, method 'split', one payment_intents entry per card) and clears
-- the table exactly once. Reporting/tax stay correct because the single check
-- carries the full itemisation and the full charged total.
--
-- "Paid so far" is derived, never stored on the job: the sum of due_minor over
-- this OCCUPATION's approved/reconciled adyen_pay_at_table legs. Occupation
-- match = check_key AND draft sessionId AND draft seatedAt. seatedAt is an
-- epoch-ms stamp, so the triple is collision-proof even though ORD-<counter>
-- session ids recycle — which is why this scan carries NO time window (an
-- earlier draft bounded it to 6h and silently "forgot" legs on any sitting
-- longer than that, re-charging the full bill).
--
-- Hardening in this version, each closing a defect found in adversarial review:
--   • pg_advisory_xact_lock on the check key — the paid-scan and the in-flight
--     mutex were two READ COMMITTED statements, so a leg settling between them
--     was counted by NEITHER (double charge).
--   • CROSS-SOURCE approved guard restored. 20260814d refused any approved job
--     on the check_key regardless of source; scoping paid-so-far to
--     adyen_pay_at_table alone would have made an approved-but-unbooked POS
--     "send to terminal" job invisible — reopening the exact live 15 Aug T2
--     double charge that guard was written for.
--   • Occupation pinning (p_session_id / p_seated_at): the reader resolves the
--     table and shows the bill, then a human takes minutes over the menus. The
--     RPC used to bind to whatever occupation was live at execution time, so a
--     re-seat mid-flow charged the NEW party.
--   • active_sessions.paid_minor / paid_legs: part-paid money is now VISIBLE to
--     every till instead of living only inside terminal_jobs.
begin;

-- ── Part-paid state on the occupation itself ────────────────────────────────
-- Written ONLY by terminal_sync_table_paid (service role) — SessionSync's
-- upsert names its own columns, so PostgREST never clobbers these.
alter table active_sessions
  add column if not exists paid_minor bigint not null default 0,
  add column if not exists paid_legs  jsonb  not null default '[]'::jsonb;

comment on column active_sessions.paid_minor is
  'Sum of settled on-reader split legs for THIS occupation (minor units). Server-written; the bill (total_minor) is unchanged — this is what has already been collected against it.';

-- ── Shared occupation scan: what has this party already paid on the reader ──
-- One definition, used by the start RPC and the paid-state sync, so the two can
-- never disagree.
create or replace function _terminal_paid_legs_for(
  p_location_id uuid, p_table_id text, p_session_id text, p_seated_at text
) returns table (paid bigint, legs jsonb)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(j.due_minor), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'jobId',         j.id,
           'transactionId', j.transaction_id,
           'dueMinor',      j.due_minor,
           'tipMinor',      coalesce(j.tip_minor, 0),
           'chargeMinor',   j.charge_minor,
           'card',          j.card,
           'settledAt',     j.settled_at
         ) order by j.created_at), '[]'::jsonb)
    from terminal_jobs j
   where j.check_key = p_location_id::text || ':' || p_table_id || ':' || coalesce(p_session_id, '-')
     and j.status in ('approved', 'reconciled')
     and j.check_draft ->> 'source' = 'adyen_pay_at_table'
     and j.check_draft ->> 'sessionId' is not distinct from p_session_id
     and j.check_draft ->> 'seatedAt'  is not distinct from p_seated_at;
$$;
revoke all on function _terminal_paid_legs_for(uuid, text, text, text) from public, anon, authenticated;

-- ── Publish part-paid state onto the live session (service role) ────────────
-- Recomputes rather than increments, so a replayed call is a no-op and a
-- sync/async settle race can never double-count.
create or replace function terminal_sync_table_paid(p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j      terminal_jobs;
  d      jsonb;
  v_paid bigint;
  v_legs jsonb;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;
  select * into j from terminal_jobs where id = p_job_id;
  if j.id is null then return jsonb_build_object('ok', false, 'reason', 'job not found'); end if;
  d := coalesce(j.check_draft, '{}'::jsonb);
  if d ->> 'source' is distinct from 'adyen_pay_at_table' or d ->> 'tableId' is null then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  select paid, legs into v_paid, v_legs
    from _terminal_paid_legs_for(j.location_id, d ->> 'tableId', d ->> 'sessionId', d ->> 'seatedAt');

  update active_sessions a
     set paid_minor = v_paid, paid_legs = v_legs, updated_at = now()
   where a.location_id = j.location_id
     and a.table_id = d ->> 'tableId'
     and a.session ->> 'id' is not distinct from d ->> 'sessionId'
     and a.session ->> 'seatedAt' is not distinct from d ->> 'seatedAt';

  return jsonb_build_object('ok', true, 'paid_minor', v_paid);
end; $$;
revoke all on function terminal_sync_table_paid(uuid) from public, anon, authenticated;

-- ── The start RPC ───────────────────────────────────────────────────────────
-- Signature change (2 args → 5 with defaults): OR REPLACE would CREATE AN
-- OVERLOAD and make 2-arg PostgREST calls ambiguous — drop first.
drop function if exists terminal_start_table_payment_for(uuid, text);

create function terminal_start_table_payment_for(
  p_terminal_device_id uuid,
  p_table_id           text,
  p_amount_minor       bigint default null,
  p_session_id         text   default null,
  p_seated_at          text   default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t           terminal_devices;
  a           active_sessions;
  v_key       text;
  v_bill      bigint;
  v_paid      bigint;
  v_prior     jsonb;
  v_remaining bigint;
  v_due       bigint;
  v_final     boolean;
  v_job       uuid := gen_random_uuid();
  v_ccid      text;
  v_currency  text;
  v_tipcfg    jsonb;
  v_draft     jsonb;
begin
  select * into t from terminal_devices
   where id = p_terminal_device_id and status = 'paired' and active
   limit 1;
  if t.id is null then raise exception 'terminal not paired'; end if;
  if t.adyen_terminal_id is null then raise exception 'terminal has no Adyen link'; end if;
  if coalesce((t.modes ->> 'table_pay')::boolean, true) = false then
    raise exception 'Table Pay is switched off for this terminal';
  end if;

  select * into a from active_sessions
   where location_id = t.location_id and table_id = p_table_id
   limit 1;
  if a.table_id is null then raise exception 'table is not open'; end if;
  if a.total_minor is null then
    raise exception 'this table has no server-side total yet — open and re-save it on the POS first';
  end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  -- SERIALISE every reader/till decision on this check. Without it the paid
  -- scan and the in-flight mutex below are separate READ COMMITTED snapshots,
  -- and a leg settling in the gap is invisible to both → double charge.
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));

  -- Occupation pin: refuse if the party changed while staff were on the menus.
  if p_session_id is not null and (a.session ->> 'id') is distinct from p_session_id then
    raise exception 'this table changed while you were choosing — start again';
  end if;
  if p_seated_at is not null and (a.session ->> 'seatedAt') is distinct from p_seated_at then
    raise exception 'this table changed while you were choosing — start again';
  end if;

  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  -- CROSS-SOURCE guard (restores 20260814d). A POS "send to terminal" or PAX
  -- Table-Pay job that is approved but not yet booked shares this exact
  -- check_key; charging again on top of it is the live T2 double charge.
  -- Time-bounded 6h because ORD-<counter> session ids recycle and those
  -- sources do not stamp seatedAt in the draft.
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and coalesce(j.check_draft ->> 'source', '') <> 'adyen_pay_at_table'
                and (j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
                     or (j.status = 'approved' and j.created_at > now() - interval '6 hours'))) then
    raise exception 'this table has already been paid or has a payment in progress';
  end if;

  -- Paid so far on THIS occupation (no time window — see header).
  select paid, legs into v_paid, v_prior
    from _terminal_paid_legs_for(t.location_id, p_table_id, a.session ->> 'id', a.session ->> 'seatedAt');

  v_remaining := v_bill - v_paid;
  if v_remaining <= 0 then
    if v_paid > 0 then
      -- Voids/comps can drop the bill BELOW what has been collected. Say so
      -- precisely: this is a refund-due situation for a manager, not a
      -- "someone already paid" duplicate press.
      raise exception 'this table is fully paid (% already taken on the reader) — settle any difference on the till',
        to_char(v_paid / 100.0, 'FM999999990.00');
    end if;
    raise exception 'this table has already been paid';
  end if;

  -- One live leg per check and per terminal (idx_tj_one_live_per_check /
  -- _per_terminal back these with real uniqueness).
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this table already has a payment in progress';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

  if p_amount_minor is not null and p_amount_minor <= 0 then
    raise exception 'invalid split amount';
  end if;
  v_due   := coalesce(least(p_amount_minor, v_remaining), v_remaining);
  v_final := (v_due = v_remaining);

  select coalesce(l.currency, 'GBP') into v_currency from locations l where l.id = t.location_id;
  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from floor_tables f
                              where f.id = p_table_id and f.location_id = t.location_id::text), p_table_id),
    'locationId',  t.location_id,
    'sessionId',   a.session ->> 'id',
    'server',      coalesce(a.session ->> 'server', 'Pay at table'),
    'covers',      coalesce((a.session ->> 'covers')::int, 1),
    'orderType',   'dine-in',
    'items',       coalesce(a.session -> 'items', '[]'::jsonb),
    'discounts',   coalesce(a.session -> 'discounts', '[]'::jsonb),
    'seatedAt',    a.session ->> 'seatedAt',
    'subtotalMinor', a.subtotal_minor,
    'totalMinor',    a.total_minor,
    'currency',    v_currency,
    'source',      'adyen_pay_at_table',
    -- Split-leg bookkeeping. partial=true legs are INVISIBLE to the reconciler
    -- (they must never book a check / clear the table); the final leg books the
    -- whole occupation via priorLegs.
    'billMinor',           v_bill,
    'paidBeforeMinor',     v_paid,
    'remainingAfterMinor', v_remaining - v_due,
    'partial',             (not v_final)
  );
  if v_final and v_paid > 0 then
    v_draft := v_draft || jsonb_build_object('priorLegs', v_prior);
  end if;

  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, charge_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key, t.location_id, t.id, null, false,
    v_due, v_due, v_due,
    v_currency, v_tipcfg, v_ccid, v_draft,
    'charging_unsent', 'adyen',
    now() + interval '15 minutes',
    now()
  );

  return jsonb_build_object(
    'job_id', v_job, 'due_minor', v_due, 'currency', v_currency,
    'bill_minor', v_bill, 'paid_before_minor', v_paid,
    'remaining_after_minor', v_remaining - v_due, 'partial', (not v_final)
  );
end; $$;

revoke all on function terminal_start_table_payment_for(uuid, text, bigint, text, text) from public, anon, authenticated;

commit;
