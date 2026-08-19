-- ⚠ HAND-APPLY (Peter, SQL editor). Claude cannot apply DDL to production.
--
-- Demo reader: reader-initiated Pay at table (19 Aug, v5.6.95).
--
-- The browser demo reader (?mode=readerdemo) must start Pay at table from its
-- own screen, exactly like a real Adyen reader. The real path already funnels
-- through terminal_start_table_payment_for (20260815b), whose money model —
-- paid-so-far scan, partial flag, priorLegs snapshot, advisory lock, occupation
-- pinning, both mutexes — is precisely what the demo must exercise. So the demo
-- does not get its own RPC: this migration teaches THE SAME function to mint a
-- demo-shaped job when the target terminal is a demo reader.
--
-- WHAT CHANGES FOR A DEMO TERMINAL (serial_number LIKE 'DEMO-%'):
--   * the "terminal has no Adyen link" refusal is skipped — the demo reader has
--     no adyen_terminal_id by construction (register_terminal_device only stores
--     the serial; nothing ever links a DEMO- row to a POIID).
--   * the job is born in the PENDING shape terminal-job-create births for the
--     PAX fleet: status='pending', processor='ryft' (the column default),
--     simulated=true, charge_minor NULL, tip_basis_minor = due_minor = v_due.
--     The demo window's EXISTING lifecycle then just works: it polls pending
--     jobs addressed to itself, terminal_claim_job → tip screen →
--     terminal_commit_tip (charge computed server-side, tj_charge_identity
--     holds) → terminal_job_sent → terminal_report_result, which keeps the full
--     settle path for simulated jobs (20260729).
--
-- WHAT DOES NOT CHANGE — for ANY terminal:
--   * every guard, the advisory lock, the paid-so-far maths, the partial flag,
--     the priorLegs snapshot and the occupation pin are shared and identical.
--   * a NON-demo terminal's insert is byte-identical to 20260815b:
--     status='charging_unsent', processor='adyen', charge_minor = v_due,
--     simulated=false (the column default, now written explicitly).
--
-- The serial on the SERVER'S OWN terminal row is the authority (same rule as
-- terminal-job-create and the DEMO-HOLD branch): a caller can neither talk a
-- real terminal into a simulated job nor a demo terminal into a real one.
--
-- QUALIFICATION NOTE (the 19 Aug lesson, same day): every table reference is
-- written public.<name> and every rowtype public.<name>%rowtype. plpgsql
-- resolves DECLARE types at CREATE time using the creating session's
-- search_path, and the Supabase SQL editor does not necessarily have public on
-- it — unqualified rowtypes fail there with 'type "terminal_devices" does not
-- exist'.
begin;

create or replace function public.terminal_start_table_payment_for(
  p_terminal_device_id uuid,
  p_table_id           text,
  p_amount_minor       bigint default null,
  p_session_id         text   default null,
  p_seated_at          text   default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t           public.terminal_devices%rowtype;
  a           public.active_sessions%rowtype;
  v_demo      boolean;
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
  select * into t from public.terminal_devices
   where id = p_terminal_device_id and status = 'paired' and active
   limit 1;
  if t.id is null then raise exception 'terminal not paired'; end if;

  -- Demo reader (v5.6.95): the terminal row's own serial is the authority.
  v_demo := upper(coalesce(t.serial_number, '')) like 'DEMO-%';

  if t.adyen_terminal_id is null and not v_demo then
    raise exception 'terminal has no Adyen link';
  end if;
  if coalesce((t.modes ->> 'table_pay')::boolean, true) = false then
    raise exception 'Table Pay is switched off for this terminal';
  end if;

  select * into a from public.active_sessions
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
  if exists (select 1 from public.terminal_jobs j
              where j.check_key = v_key
                and coalesce(j.check_draft ->> 'source', '') <> 'adyen_pay_at_table'
                and (j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
                     or (j.status = 'approved' and j.created_at > now() - interval '6 hours'))) then
    raise exception 'this table has already been paid or has a payment in progress';
  end if;

  -- Paid so far on THIS occupation (no time window — see 20260815b header).
  select paid, legs into v_paid, v_prior
    from public._terminal_paid_legs_for(t.location_id, p_table_id, a.session ->> 'id', a.session ->> 'seatedAt');

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
  if exists (select 1 from public.terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this table already has a payment in progress';
  end if;
  if exists (select 1 from public.terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

  if p_amount_minor is not null and p_amount_minor <= 0 then
    raise exception 'invalid split amount';
  end if;
  v_due   := coalesce(least(p_amount_minor, v_remaining), v_remaining);
  v_final := (v_due = v_remaining);

  select coalesce(l.currency, 'GBP') into v_currency from public.locations l where l.id = t.location_id;
  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from public.floor_tables f
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

  -- One insert, two shapes:
  --   demo  → the PENDING shape terminal-job-create births (the demo window's
  --           claim → commit_tip → sent → report lifecycle picks it up;
  --           commit_tip computes charge_minor server-side).
  --   real  → byte-identical to 20260815b: born charging_unsent for the
  --           adyen-terminal-events / adyen-terminal-charge cloud path.
  insert into public.terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, charge_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, simulated, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key, t.location_id, t.id, null, false,
    v_due, v_due,
    case when v_demo then null else v_due end,
    v_currency, v_tipcfg, v_ccid, v_draft,
    case when v_demo then 'pending' else 'charging_unsent' end,
    case when v_demo then 'ryft' else 'adyen' end,   -- 'ryft' is the column default
    v_demo,
    now() + interval '15 minutes',
    now()
  );

  return jsonb_build_object(
    'job_id', v_job, 'due_minor', v_due, 'currency', v_currency,
    'bill_minor', v_bill, 'paid_before_minor', v_paid,
    'remaining_after_minor', v_remaining - v_due, 'partial', (not v_final),
    'simulated', v_demo
  );
end; $$;

-- CREATE OR REPLACE preserves ACLs, but re-assert the fence: service-role-only.
revoke all on function public.terminal_start_table_payment_for(uuid, text, bigint, text, text) from public, anon, authenticated;

commit;
