-- ─────────────────────────────────────────────────────────────────────────────
-- 20260727_terminal_pos_close.sql   (OPS DB)
--
-- Lets an APPROVED terminal Table-Pay job (source='pax_table_pay') be CLOSED by the
-- POS — write its closed_check + clear the table — the same way the till closes a
-- check. terminal_report_result deliberately never closes the table (server-side
-- finalisation was always meant to ship PAIRED with a POS reconciler, so stock /
-- loyalty / receipt / tax stay in the client's close path). Until now the POS half
-- did not exist, so a table paid ON the PAX stayed open forever and could be paid
-- again. This ships that missing half.
--
-- THREE THINGS, all fast-channel (POS/edge deploy, no terminal APK needed):
--
--   0. COLLISION-PROOF the pre-minted closed_check_id. terminal_start_table_payment
--      minted `chk-<epoch_ms>`; two Table-Pay starts in the SAME millisecond collide
--      on the closed_checks primary key and the second real sale silently no-ops.
--      The reconciler now uses this id as its single-closer election key, so a
--      per-start collision would also make one paid table tombstone another. Fix:
--      append 6 hex from a uuid. Id stays opaque + `chk-`-prefixed; nothing parses
--      it for a timestamp (only ever used as an equality key).
--
--   1. Two POS-facing status RPCs — terminal_pos_mark_reconciled / _flag_stale.
--      Housekeeping only: they move the terminal_jobs row between approved →
--      reconciled / needs_human. THEY WRITE NO MONEY. The money guarantee is the
--      closed_checks PK (the reconciler's INSERT … ON CONFLICT DO NOTHING elects
--      exactly one closer). Fenced identically to terminal_job_cancel: an anon till
--      proves itself with a devices row at the job's location, a BO user via
--      user_locations. No SELECT/UPDATE policy is ever added to terminal_jobs —
--      every mutation still lands in a SECURITY DEFINER RPC (honours 20260722b).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ═══ -1. Amount-scoped acknowledge ═══════════════════════════════════════════
-- A manager's resolve_terminal_job('acknowledged') clears needs_human but leaves the
-- job approved. The reconciler must treat that as "close at what the card took" — but
-- ONLY for the bill the manager actually saw. A reason-blind override (any acknowledge,
-- forever) would let an acknowledge about an unrelated device-reporting mismatch
-- permanently disable the stale-total guard, silently losing items added later.
-- So: capture the live total AT THE MOMENT of acknowledgement. The reconciler honours
-- the override only while the live bill still equals this figure; if the bill moves
-- again, the guard re-arms and re-parks the job for a fresh decision.
alter table terminal_jobs add column if not exists acknowledged_total_minor bigint;

create or replace function resolve_terminal_job(
  p_job_id  uuid,
  p_outcome text,
  p_note    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j     terminal_jobs;
  v_out text;
  v_who text;
  v_stamp text;
begin
  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled','acknowledged') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'payment not found'; end if;

  -- Same fence as release_terminal_jobs: the manager must have this venue.
  if not _terminal_user_has_location(j.location_id) then
    raise exception 'no access to this payment';
  end if;

  -- Refuse while the payment is genuinely still running. A manager resolving a
  -- live charge from Back Office while a customer is mid-tap would be deciding
  -- the outcome of something that has not happened yet.
  if j.status in ('claimed','tipping','charging_unsent','charging') then
    return jsonb_build_object('ok', false,
      'reason', 'this payment is still running on the terminal — wait for it to finish');
  end if;

  v_who   := coalesce((select email from user_profiles where id = auth.uid()), auth.uid()::text, 'unknown user');
  v_stamp := concat_ws(' ', v_out, '— confirmed by', v_who, 'at', now()::text,
                       nullif(concat(': ', nullif(btrim(coalesce(p_note,'')), '')), ': '));

  if v_out = 'acknowledged' then
    -- The manager is signing off a discrepancy on an approved payment. Snapshot the
    -- live bill they signed off against (same-occupation match, like terminal-job-status)
    -- so the reconciler's override is scoped to exactly this figure. NULL live session →
    -- the frozen due_minor stands in: acknowledging an unchanged/gone bill still closes.
    update terminal_jobs
       set needs_human = false,
           acknowledged_total_minor = coalesce((
             select s.total_minor from active_sessions s
              where s.location_id = j.location_id
                and s.table_id = j.check_draft ->> 'tableId'
                and s.session ->> 'id' = j.check_draft ->> 'sessionId'
              limit 1), j.due_minor),
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  else
    update terminal_jobs
       set status      = v_out,
           needs_human = false,
           settled_at  = coalesce(settled_at, now()),
           reconcile_attempts = reconcile_attempts + 1,
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  end if;

  return jsonb_build_object('ok', true, 'outcome', v_out, 'by', v_who);
end;
$fn$;

revoke execute on function resolve_terminal_job(uuid, text, text) from public;
grant  execute on function resolve_terminal_job(uuid, text, text) to authenticated;


-- ═══ 0. Collision-proof the minted closed_check_id ═══════════════════════════
-- Exact CREATE OR REPLACE of the current terminal_start_table_payment, byte-for-byte
-- from 20260722c EXCEPT the v_ccid mint (now carries a 6-hex uuid suffix). Re-issued
-- in full because a single line inside a plpgsql body cannot be patched in place.
create or replace function terminal_start_table_payment(p_table_id text, p_staff_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t          terminal_devices;
  a          active_sessions;
  v_staff    record;
  v_key      text;
  v_bill     bigint;
  v_job      uuid := gen_random_uuid();
  v_ccid     text;
  v_currency text;
  v_tipcfg   jsonb;
  v_draft    jsonb;
begin
  t := _terminal_for_caller();

  -- The staff id came from the client. Re-validate it against THIS venue —
  -- otherwise a payment could be attributed to anyone, including at another site.
  select s.id, s.name, s.role into v_staff
    from staff_members s
   where s.id = p_staff_id and s.location_id = t.location_id and s.active
   limit 1;
  if v_staff.id is null then raise exception 'staff member not valid at this location'; end if;
  if coalesce(v_staff.role, '') = 'Kitchen' then raise exception 'this role cannot take payment'; end if;

  select * into a from active_sessions
   where location_id = t.location_id and table_id = p_table_id
   limit 1;
  if a.table_id is null then raise exception 'table is not open'; end if;

  if a.total_minor is null then
    raise exception 'this table has no server-side total yet — open and re-save it on the POS first';
  end if;
  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  -- Explicit, friendly refusals. The partial unique indexes are the real mutex —
  -- these just turn a 23505 into a sentence a waiter can act on.
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

  select coalesce(l.currency, 'GBP') into v_currency from locations l where l.id = t.location_id;

  -- Frozen at dispatch. The device's cached config is the only tip source available
  -- to Ops SQL (location_reader_settings lives in the Platform DB), and it fails
  -- SAFE: with no cached config the terminal shows no tip prompt rather than a
  -- guessed one. Back Office writes this cache when the terminal is paired.
  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  -- v5.5.846: epoch-ms + 6 hex from a uuid. The ms alone collided when two Table-Pay
  -- starts landed in the same millisecond, silently no-opping the second sale AND
  -- (now) risking one paid table tombstoning another via the reconciler's id-election.
  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  -- Everything recordClosedCheck needs EXCEPT the tip, so the check can be closed
  -- by the POS reconciler even if the till that started it never comes back.
  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from floor_tables f
                              -- same TEXT vs UUID mismatch as terminal_open_tables; cast down, not up
                              where f.id = p_table_id and f.location_id = t.location_id::text), p_table_id),
    'locationId',  t.location_id,
    'sessionId',   a.session ->> 'id',
    'server',      coalesce(v_staff.name, a.session ->> 'server'),
    'staffId',     v_staff.id,
    'covers',      coalesce((a.session ->> 'covers')::int, 1),
    'orderType',   'dine-in',
    'items',       coalesce(a.session -> 'items', '[]'::jsonb),
    'discounts',   coalesce(a.session -> 'discounts', '[]'::jsonb),
    'seatedAt',    a.session ->> 'seatedAt',
    'subtotalMinor', a.subtotal_minor,
    'totalMinor',    a.total_minor,
    'currency',    v_currency,
    'source',      'pax_table_pay'
  );

  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key,
    t.location_id,                 -- SERVER-resolved from the terminal's pairing row
    t.id, null,
    false,                         -- Table Pay is initiated by real hardware; there is
                                   -- no training till in this path. Mode 3 sets this
                                   -- from the dispatching POS device profile.
    v_bill,                        -- tip basis = the BILL (tip % applies to this)
    v_bill,                        -- due = the whole bill (no split, no gift credit here)
    v_currency, v_tipcfg, v_ccid, v_draft,
    'pending', 'ryft',
    now() + interval '15 minutes', -- undispatched jobs expire rather than linger
    now()
  );

  return jsonb_build_object(
    'job_id',          v_job,
    'tip_basis_minor', v_bill,
    'due_minor',       v_bill,
    'currency',        v_currency,
    'tip_config',      v_tipcfg
  );
end; $$;


-- ═══ 1. POS-facing status transitions (housekeeping only — no money write) ═══

-- approved → reconciled, once the POS has recorded the closed_check. The CAS
-- (WHERE status='approved' AND needs_human=false) yields one winner; everyone else
-- gets ok:false and moves on. Never the money gate — the closed_checks PK is.
create or replace function terminal_pos_mark_reconciled(p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare j terminal_jobs; v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  update terminal_jobs
     set status = 'reconciled', settled_at = coalesce(settled_at, now()), updated_at = now()
   where id = j.id and status = 'approved' and needs_human = false;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $$;

-- Flag an approved job whose live bill moved after the terminal froze its amount.
-- The reconciler must NOT close at a wrong amount, so it parks the job for a human
-- (needs_human=true) and leaves the table seated. Surfaces in Back Office
-- UnresolvedPayments; a manager takes the delta then resolve_terminal_job('acknowledged').
create or replace function terminal_pos_flag_stale(p_job_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare j terminal_jobs; v_ok boolean; v_n integer;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;
  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  update terminal_jobs
     set needs_human = true,
         last_error  = concat_ws(' | ', last_error, coalesce(p_note, 'bill changed after payment frozen')),
         updated_at  = now()
   where id = j.id and status = 'approved' and needs_human = false;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $$;

-- Grants — anon till + BO user, same as terminal_job_cancel. NOT service_role-only:
-- the whole point is the paired POS device (anonymous session) can call them.
revoke execute on function terminal_pos_mark_reconciled(uuid)       from public;
revoke execute on function terminal_pos_flag_stale(uuid, text)      from public;
grant  execute on function terminal_pos_mark_reconciled(uuid)       to anon, authenticated;
grant  execute on function terminal_pos_flag_stale(uuid, text)      to anon, authenticated;


-- ═══ 2. Harden terminal_report_result: no silent chargeless approvals ════════
-- Exact re-issue of 20260722c's function with ONE addition: a device reporting
-- 'approved' while the job has NO server-computed charge (charge_minor null — i.e. it
-- skipped terminal_commit_tip) is parked needs_human. Previously such a row sailed
-- through with needs_human=false: the fixed POS reconciler fail-closes on it (won't
-- book a £0 sale), but that left it stranded OUTSIDE the manager queue — invisible
-- everywhere. An approval the server never priced is exactly what the queue is for.
create or replace function terminal_report_result(
  p_job_id         uuid,
  p_status         text,
  p_transaction_id text default null,
  p_auth_code      text default null,
  p_card           jsonb default null,
  p_reported_minor bigint default null,
  p_decline_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; j terminal_jobs; v_status text; v_human boolean := false; v_err text;
begin
  t := _terminal_for_caller();

  v_status := lower(btrim(coalesce(p_status, '')));
  if v_status not in ('approved','declined','cancelled','unknown') then
    raise exception 'invalid result status %', p_status;
  end if;

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.status in ('approved','declined','cancelled','expired','reconciled') then
    return jsonb_build_object('ok', true, 'idempotent', true);   -- already settled
  end if;

  -- A cancel we cannot prove is deterministic becomes an unknown.
  if v_status = 'cancelled' and j.status = 'charging' then
    v_status := 'unknown';
    v_err := 'device reported cancelled after dispatch — outcome not established';
  end if;

  if v_status = 'unknown' then v_human := true; end if;

  -- Server computed the money; the device only reports it. Any disagreement stops
  -- the check closing until a human looks.
  if v_status = 'approved' and p_reported_minor is not null
     and j.charge_minor is not null and p_reported_minor <> j.charge_minor then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || format('amount mismatch: device %s vs server %s',
                                                    p_reported_minor, j.charge_minor);
  end if;

  -- v5.5.846: an approval with NO server charge should be impossible (terminal_commit_tip
  -- is the only path that prices a job). If a device claims approved anyway, money may
  -- have moved for an amount the server never authorised — park it for a human instead
  -- of letting it strand with needs_human=false, invisible to every queue.
  if v_status = 'approved' and j.charge_minor is null then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || 'approved with no server charge amount — investigate before closing';
  end if;

  update terminal_jobs
     set status         = v_status,
         transaction_id = coalesce(p_transaction_id, transaction_id),
         auth_code      = coalesce(p_auth_code, auth_code),
         card           = coalesce(p_card, card),
         reported_minor = coalesce(p_reported_minor, reported_minor),
         decline_reason = coalesce(p_decline_reason, decline_reason),
         needs_human    = needs_human or v_human,
         last_error     = coalesce(v_err, last_error),
         settled_at     = now(),
         updated_at     = now()
   where id = j.id;

  return jsonb_build_object('ok', true);
end; $$;

commit;


-- ── CHECK ───────────────────────────────────────────────────────────────────
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as sec_def
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('terminal_start_table_payment','terminal_pos_mark_reconciled','terminal_pos_flag_stale')
order by p.proname;
