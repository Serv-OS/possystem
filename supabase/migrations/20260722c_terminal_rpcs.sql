-- ─────────────────────────────────────────────────────────────────────────────
-- 20260722c_terminal_rpcs.sql   (OPS DB)
--
-- PaxPay transition RPCs. terminal_devices and terminal_jobs have NO insert and
-- NO update policies — every mutation lands here, so this file is the entire
-- write surface of the PaxPay payments path. Treat it accordingly.
--
-- Spec: docs/PAXPAY_TRANSPORT_SPEC.md
-- Precedent: claim_menu_board_screen / set_menu_board_screen (20260614*).
--
-- RULES OBSERVED THROUGHOUT
--   1. Every function is `security definer` + `set search_path = public`.
--      (A missing search_path is a function-hijack hole — flagged in this DB today.)
--   2. Every function re-derives the caller's terminal from auth.uid(). A device id
--      is never accepted as proof of identity.
--   3. location_id is ALWAYS taken from the terminal's own pairing row (which only
--      claim_terminal_device can set, after validating the manager's access) — never
--      from an argument. "Always resolve the real locationId before any DB write."
--   4. Money is bigint minor units, computed here, from values already on server-side
--      rows. The device supplies only a tip, and that tip is capped server-side.
--   5. EXECUTE is revoked from public and granted explicitly per function at the end.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── helpers ──────────────────────────────────────────────────────────────────

-- Does the CURRENT caller (a signed-in Back Office user) have access to a location?
create or replace function _terminal_user_has_location(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_loc is not null and (
    exists (select 1 from user_locations where user_id = auth.uid() and location_id = p_loc)
    or exists (select 1 from user_profiles where id = auth.uid() and role = 'super_admin')
  );
$$;

-- High-entropy, unambiguous pairing code. 10 uppercase hex chars = 40 bits, drawn
-- from gen_random_uuid() (CSPRNG), matching the ~39-bit menu-board precedent. Hex
-- contains no O/I/l, so there is nothing for an operator to mistype.
create or replace function _terminal_gen_code() returns text
language sql volatile security definer set search_path = public as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$$;

-- The calling terminal: its own PAIRED, ACTIVE row, resolved from auth.uid().
-- This is the single point at which "who is calling" is decided. Every RPC below
-- goes through it, so no RPC can be pointed at another venue's terminal.
create or replace function _terminal_for_caller() returns terminal_devices
language plpgsql stable security definer set search_path = public as $$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  select * into t from terminal_devices
   where device_uid = auth.uid() and status = 'paired' and active
   order by last_seen_at desc nulls last, claimed_at desc nulls last
   limit 1;
  if t.id is null then raise exception 'terminal is not paired'; end if;
  if t.location_id is null then raise exception 'terminal has no location'; end if;
  return t;
end; $$;

-- Is the caller the service role? Used to fence the sweeper-only functions.
-- nullif guards the empty-string case: ''::jsonb raises, and a raise here would
-- turn "no JWT" into a 500 instead of a clean denial.
create or replace function _terminal_is_service_role() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role';
$$;


-- ── 1. register_terminal_device ──────────────────────────────────────────────
-- Self-registration by an unpaired terminal. Idempotent per serial FOR THE SAME
-- device_uid. Returns { device_id, claim_code, status, location_id, label }.
--
-- HIJACK GUARD (read before "simplifying" this):
--   serial_number is client-supplied. If a PAIRED row already exists for this
--   serial under a DIFFERENT device_uid, we do NOT hand that row over — otherwise
--   anyone who learns a serial could adopt a live venue's terminal identity and
--   read its jobs (check contents + card data). Instead we mint a fresh UNPAIRED
--   row with a new claim code; the manager re-pairs it in Back Office, and
--   claim_terminal_device retires the stale row for that serial. Reinstall still
--   works; silent takeover does not.
create or replace function register_terminal_device(p_serial text, p_app_version text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_serial text := btrim(coalesce(p_serial, ''));
  v_row    terminal_devices;
  v_code   text;
  v_open   integer;
begin
  if v_uid is null then raise exception 'no session'; end if;
  if v_serial = '' then raise exception 'serial required'; end if;
  if length(v_serial) > 64 then raise exception 'serial too long'; end if;

  -- Already paired to THIS device_uid — re-adopt (app restart / reboot).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'paired' and active
   limit 1;
  if v_row.id is not null then
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', null, 'status', 'paired',
                              'location_id', v_row.location_id, 'label', v_row.label);
  end if;

  -- Already registered-but-unpaired by THIS device_uid — return the SAME code
  -- (idempotent: a retry must not churn the code the operator is reading).
  select * into v_row from terminal_devices
   where serial_number = v_serial and device_uid = v_uid and status = 'unpaired'
   order by created_at desc limit 1;
  if v_row.id is not null then
    -- Refresh the TTL clock so a terminal left on the pairing screen stays claimable.
    update terminal_devices
       set app_version = coalesce(p_app_version, app_version), last_seen_at = now(), updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                              'location_id', null, 'label', v_row.label);
  end if;

  -- Cheap abuse guard: one auth.uid() has no legitimate reason to hold a pile of
  -- pending registrations. (Anonymous sessions are free to mint, so bound them.)
  select count(*) into v_open from terminal_devices where device_uid = v_uid and status = 'unpaired';
  if v_open >= 5 then raise exception 'too many pending registrations for this device'; end if;

  -- Fresh unpaired row. Retry on the (astronomically unlikely) code collision.
  for i in 1..5 loop
    v_code := _terminal_gen_code();
    begin
      insert into terminal_devices (device_uid, serial_number, claim_code, status, app_version, last_seen_at)
      values (v_uid, v_serial, v_code, 'unpaired', p_app_version, now())
      returning * into v_row;
      exit;
    exception when unique_violation then
      v_row := null; -- code clash: try again
    end;
  end loop;
  if v_row.id is null then raise exception 'could not allocate a pairing code'; end if;

  return jsonb_build_object('device_id', v_row.id, 'claim_code', v_row.claim_code, 'status', 'unpaired',
                            'location_id', null, 'label', v_row.label);
end; $$;


-- ── 2. claim_terminal_device ─────────────────────────────────────────────────
-- Back Office pairing. The ONLY place location_id is ever written.
-- Returns { ok, device_id }.
create or replace function claim_terminal_device(p_claim_code text, p_location_id uuid, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row terminal_devices; v_org uuid;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  -- The manager must have access to the location they are pairing INTO. This is
  -- what stops a code from one venue being bound to another venue's terminal.
  if not _terminal_user_has_location(p_location_id) then raise exception 'no access to this location'; end if;

  select * into v_row from terminal_devices
   where lower(claim_code) = lower(btrim(coalesce(p_claim_code, ''))) and status = 'unpaired'
   limit 1;
  if v_row.id is null then raise exception 'pairing code not found'; end if;

  -- TTL — only a terminal that is actually live (or just registered) may be
  -- claimed. Stops abandoned codes being pre-claimed later.
  if coalesce(v_row.last_seen_at, v_row.created_at) < now() - interval '30 minutes' then
    raise exception 'pairing code expired — restart the terminal to get a new code';
  end if;

  select org_id into v_org from locations where id = p_location_id;

  -- Retire any prior PAIRED row for the same physical serial (reinstall / re-pair).
  -- Also frees idx_td_serial for the new row. Only rows at a location this manager
  -- can see are touched — a serial collision across tenants must not let one venue
  -- retire another's terminal.
  update terminal_devices
     set status = 'retired', active = false, claim_code = null, updated_at = now()
   where serial_number = v_row.serial_number
     and id <> v_row.id
     and status = 'paired'
     and _terminal_user_has_location(location_id);

  update terminal_devices
     set location_id = p_location_id,          -- SERVER-validated, never device-supplied
         org_id      = v_org,
         label       = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         status      = 'paired',
         active      = true,
         claim_code  = null,                   -- single use: the code cannot be replayed
         claimed_at  = now(),
         updated_at  = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'device_id', v_row.id);
end; $$;


-- ── 3. terminal_heartbeat ────────────────────────────────────────────────────
-- Own row only. A device id that isn't yours simply matches nothing.
create or replace function terminal_heartbeat(p_device_id uuid, p_app_version text default null)
returns void
language sql security definer set search_path = public as $$
  update terminal_devices
     set last_seen_at = now(),
         app_version  = coalesce(p_app_version, app_version),
         updated_at   = now()
   where id = p_device_id and device_uid = auth.uid();
$$;


-- ── 4. terminal_staff_login ──────────────────────────────────────────────────
-- Validates a staff PIN against staff_members FOR THE CALLING TERMINAL'S PAIRED
-- LOCATION ONLY. Returns { staff_id, name, can_take_payment } or NULL.
--
-- PINs NEVER leave the server — the same model as workforce-clock. This function
-- selects id/name/role only; the pin column is compared in-DB and never returned.
--
-- Throttled: a 4-digit PIN behind an anonymous bearer token on a device left on
-- tables is brute-forceable in seconds otherwise. 5 failures locks that terminal's
-- PIN pad for 5 minutes. Counters live on terminal_devices and only this function
-- writes them.
create or replace function terminal_staff_login(p_pin text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; m record; v_pin text := btrim(coalesce(p_pin, ''));
begin
  t := _terminal_for_caller();

  if t.pin_locked_until is not null and t.pin_locked_until > now() then
    raise exception 'too many incorrect PINs — try again in a minute';
  end if;

  if v_pin = '' then return null; end if;

  select s.id, s.name, s.role into m
    from staff_members s
   where s.location_id = t.location_id      -- the fence: this terminal's venue only
     and s.active
     and s.pin is not null
     and s.pin::text = v_pin
   limit 1;

  if m.id is null then
    update terminal_devices
       set pin_fail_count  = pin_fail_count + 1,
           pin_locked_until = case when pin_fail_count + 1 >= 5 then now() + interval '5 minutes' else pin_locked_until end,
           updated_at = now()
     where id = t.id;
    -- Reset the counter once the lock is applied, so the next window starts clean.
    update terminal_devices set pin_fail_count = 0 where id = t.id and pin_locked_until > now();
    return null;
  end if;

  update terminal_devices
     set pin_fail_count = 0, pin_locked_until = null, last_seen_at = now(), updated_at = now()
   where id = t.id;

  -- There is no dedicated "take payment" permission in staff_members today (see
  -- PERM_GROUPS in StaffManager.jsx). Kitchen is the one POS role that never
  -- handles a card; everyone else on the floor does. Narrow this the moment a
  -- real permission exists — do not widen it.
  return jsonb_build_object(
    'staff_id',         m.id,
    'name',             m.name,
    'can_take_payment', coalesce(m.role, '') is distinct from 'Kitchen'
  );
end; $$;


-- ── 5. terminal_open_tables ──────────────────────────────────────────────────
-- Open tables for the calling terminal's paired location, derived from
-- active_sessions. Whole-bill Table Pay only — splits stay on the POS.
--
-- Tables with a live job are excluded so two terminals cannot be pointed at the
-- same check (belt and braces alongside idx_tj_one_live_per_check).
create or replace function terminal_open_tables()
returns table (
  table_id     text,
  label        text,
  session_id   text,
  total_minor  bigint,
  server_name  text,
  opened_at    timestamptz
)
language plpgsql stable security definer set search_path = public as $$
-- The RETURNS TABLE output names (table_id, label, total_minor, …) collide with
-- real column names below. Every reference is table-qualified, but be explicit:
-- a column always wins, so a future edit that drops a qualifier fails loudly
-- rather than silently reading an OUT variable.
#variable_conflict use_column
declare t terminal_devices;
begin
  t := _terminal_for_caller();
  return query
    select a.table_id::text,
           coalesce(f.label, a.table_id)::text,
           (a.session ->> 'id')::text,
           a.total_minor::bigint,
           coalesce(a.session ->> 'server', '')::text,
           case
             when (a.session ->> 'seatedAt') ~ '^[0-9]+$'
               then to_timestamp(((a.session ->> 'seatedAt')::bigint) / 1000.0)
             else a.updated_at
           end
      from active_sessions a
      left join floor_tables f
        on f.id = a.table_id and f.location_id = a.location_id
     where a.location_id = t.location_id
       and a.total_minor is not null
       and a.total_minor > 0
       and jsonb_array_length(coalesce(a.session -> 'items', '[]'::jsonb)) > 0
       and not exists (
             select 1 from terminal_jobs j
              where j.check_key = t.location_id::text || ':' || a.table_id || ':' || coalesce(a.session ->> 'id', '-')
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
           )
     order by 6 asc;
end; $$;


-- ── 6. terminal_start_table_payment ──────────────────────────────────────────
-- Creates the terminal_jobs row for a table. Returns
-- { job_id, tip_basis_minor, due_minor, currency, tip_config }.
--
-- THE AMOUNT IS NEVER SUPPLIED BY THE CALLER. It is read from
-- active_sessions.total_minor, which the POS — the owner of the pricing engine —
-- stamps on every session flush. If that stamp is missing this function REFUSES.
-- Fail closed: no server-side total, no Table Pay. It does not guess, and it does
-- not re-implement item discounts / auto-discounts / service charge / tax in SQL.
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

  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text;

  -- Everything recordClosedCheck needs EXCEPT the tip, so the check can be closed
  -- by the POS reconciler even if the till that started it never comes back.
  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from floor_tables f
                              where f.id = p_table_id and f.location_id = t.location_id), p_table_id),
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


-- ── 7. terminal_claim_job ────────────────────────────────────────────────────
-- Atomic, lease-based claim. Returns { ok }. The UPDATE ... WHERE status='pending'
-- is the CAS: two terminals racing the same job, one wins.
create or replace function terminal_claim_job(p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; v_n integer;
begin
  t := _terminal_for_caller();
  begin
    update terminal_jobs
       set status = 'claimed', claimed_by = t.id, claimed_at = now(),
           claim_expires_at = now() + interval '5 minutes', updated_at = now()
     where id = p_job_id
       and target_terminal_id = t.id      -- only the addressed terminal may claim
       and status = 'pending';
    get diagnostics v_n = row_count;
  exception when unique_violation then
    -- idx_tj_one_live_per_terminal: this PAX already holds a live charge.
    return jsonb_build_object('ok', false, 'reason', 'terminal already has a live job');
  end;
  return jsonb_build_object('ok', v_n = 1);
end; $$;


-- ── 8. terminal_commit_tip ───────────────────────────────────────────────────
-- Writes the tip and the resulting charge BEFORE any card is touched, so the row
-- always says exactly what is about to be charged. Returns { charge_minor }.
--
--   * charge_minor is computed HERE from due_minor already on the row. The device
--     supplies only a tip. (tj_charge_identity then makes it impossible for any
--     code path to write a total that is not the sum of its parts.)
--   * The tip is capped server-side at greatest(tip_basis_minor, 2000) — a keypad
--     bug or a rooted device cannot turn a £12 bill into a £10,000 charge.
--   * A training job never reaches the card and never gets a charge.
create or replace function terminal_commit_tip(p_job_id uuid, p_tip_minor bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; j terminal_jobs; v_tip bigint; v_charge bigint;
begin
  t := _terminal_for_caller();

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.training then raise exception 'training job — no card may be charged'; end if;
  if j.status not in ('claimed','tipping') then
    raise exception 'job is not awaiting a tip (status %)', j.status;
  end if;

  v_tip    := least(greatest(coalesce(p_tip_minor, 0), 0), greatest(j.tip_basis_minor, 2000));
  v_charge := j.due_minor + v_tip;

  update terminal_jobs
     set tip_minor    = v_tip,
         charge_minor = v_charge,
         charged_at   = now(),         -- stamped BEFORE the controller is launched
         status       = 'charging_unsent',
         updated_at   = now()
   where id = j.id;

  return jsonb_build_object('charge_minor', v_charge);
end; $$;


-- ── 8b. terminal_job_sent (additive) ─────────────────────────────────────────
-- charging_unsent -> charging. The point of no return.
--
-- Not in the agreed contract, but the two-charging-states split is a money-safety
-- rule (spec rule 5 / risk 6): 'charging_unsent' is deterministically safe and
-- auto-cancels on lease expiry, 'charging' must be reconciled by a human. Collapse
-- them and the reconcile queue fills with ordinary customer cancellations, staff
-- rubber-stamp it, and the one genuine unknown gets mis-resolved.
create or replace function terminal_job_sent(p_job_id uuid, p_transaction_id text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; v_n integer;
begin
  t := _terminal_for_caller();
  update terminal_jobs
     set status = 'charging',
         transaction_id = coalesce(p_transaction_id, transaction_id),
         updated_at = now()
   where id = p_job_id and target_terminal_id = t.id and status = 'charging_unsent';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $$;


-- ── 9. terminal_report_result ────────────────────────────────────────────────
-- The device reports an outcome. Returns { ok }.
--
--   * The device's figure lands in reported_minor and is COMPARED, never trusted.
--     A mismatch against the server-computed charge_minor sets needs_human and
--     blocks the close.
--   * 'cancelled' is only believed from a pre-dispatch state. A cancel claimed
--     after the request went out is an UNKNOWN — the card may well have been
--     charged, and telling staff "cancelled" while money moves is exactly the
--     failure spec rule 15 exists to stop.
--   * 'unknown' is terminal: never auto-retried (double charge), never dropped
--     (lost sale), always needs_human.
--   * This function does NOT write closed_checks. Server-side finalisation ships
--     PAIRED with the POS reconciler, never before it (spec rule 12): a check
--     closed here with no clearTable / stock / loyalty / receipt leaves a paid
--     check on a seated table and staff charge again. The POS reconciler observes
--     the job and closes the check.
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


-- ── 9a. terminal_targets_for_pos (additive) ──────────────────────────────────
-- "Which card terminals can this till send a payment to?"
--
-- WHY AN RPC AND NOT A POLICY: a POS till runs on an ANONYMOUS session. It has no
-- user_locations rows, and its auth.uid() is not the device_uid of the terminal —
-- so td_select matches nothing for it and a direct select comes back empty. The
-- alternative was widening the SELECT policy on a payments table, which is exactly
-- the thing this whole design refuses to do. So the read is fenced here instead.
--
-- Returns ONLY paired, active terminals at the caller's own location, and only
-- the fields the till needs to dispatch. It never returns claim_code (a pairing
-- capability) and never returns rows for any other venue.
create or replace function terminal_targets_for_pos(p_location_id uuid)
returns table (
  id                  uuid,
  label               text,
  bound_pos_device_id uuid,
  last_seen_at        timestamptz,
  tip_config          jsonb
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_location_id is null then raise exception 'location required'; end if;

  select (
    _terminal_user_has_location(p_location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = p_location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this location'; end if;

  return query
    select td.id, td.label, td.bound_pos_device_id, td.last_seen_at, td.tip_config
      from terminal_devices td
     where td.location_id = p_location_id
       and td.status = 'paired'
       and td.active
     order by td.last_seen_at desc nulls last;
end; $$;


-- ── 9b. terminal_job_cancel (additive) ───────────────────────────────────────
-- The POS's "cancel this payment" button. Returns { ok, reason? }.
--
-- REFUSES once charged_at is set. charged_at is stamped by terminal_commit_tip
-- BEFORE the controller is launched, so any job past that point may already have
-- money moving. Telling staff "cancelled" while the card is being charged is the
-- exact failure spec rule 15 exists to prevent — so we say no, and the POS must
-- not report cancelled until it OBSERVES the state.
--
-- Fenced for an ANONYMOUS POS session: the till proves itself with a devices row
-- at the job's location (devices.device_uid = auth.uid()), the same identity
-- terminal-job-status accepts. Back Office users are fenced on user_locations.
create or replace function terminal_job_cancel(p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare j terminal_jobs; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;

  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  if j.charged_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already charging — cannot cancel', 'status', j.status);
  end if;
  if j.status not in ('pending','claimed','tipping') then
    return jsonb_build_object('ok', false, 'reason', 'job is no longer cancellable', 'status', j.status);
  end if;

  update terminal_jobs
     set status = 'cancelled', settled_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'cancelled from the POS')
   where id = j.id;

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end; $$;


-- ── 10. sweeper (service_role only) ──────────────────────────────────────────
-- Called by the terminal-job-reconcile edge function on a schedule. It NEVER
-- charges and NEVER retries — it only resolves leases that have run out:
--   pending / claimed / tipping  -> expired   (nothing was sent; safe)
--   charging_unsent              -> cancelled (tip taken, request never sent; safe)
--   charging                     -> unknown   (dispatched, outcome unestablished)
create or replace function terminal_jobs_sweep(p_limit integer default 200)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_expired int := 0; v_cancelled int := 0; v_unknown int := 0;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status in ('pending','claimed','tipping')
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'expired', updated_at = now(),
         last_error = coalesce(j.last_error, 'lease expired before dispatch')
    from due where j.id = due.id;
  get diagnostics v_expired = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging_unsent'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'cancelled', updated_at = now(),
         last_error = coalesce(j.last_error, 'tip taken but request never dispatched')
    from due where j.id = due.id;
  get diagnostics v_cancelled = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'unknown', needs_human = true, updated_at = now(),
         reconcile_attempts = j.reconcile_attempts + 1,
         last_error = coalesce(j.last_error, 'dispatched but no result received — outcome not established')
    from due where j.id = due.id;
  get diagnostics v_unknown = row_count;

  return jsonb_build_object('expired', v_expired, 'cancelled', v_cancelled, 'unknown', v_unknown);
end; $$;

-- The sweeper's verdict on a single quarantined job — a HUMAN decision, relayed
-- by the edge function under the service role. Never called by a device.
create or replace function terminal_job_reconcile(p_job_id uuid, p_outcome text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out text; v_n integer;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;
  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled','reconciled') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  update terminal_jobs
     set status = v_out, needs_human = false, settled_at = now(), updated_at = now(),
         reconcile_attempts = reconcile_attempts + 1,
         last_error = coalesce(p_note, last_error)
   where id = p_job_id and status = 'unknown';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end; $$;


-- ── grants ───────────────────────────────────────────────────────────────────
-- SECURITY DEFINER runs as the owner, so EXECUTE is the whole access control.
-- Revoke from public first, then grant deliberately. `anon` is included where the
-- terminal needs it — the PAX authenticates with an anonymous session.

revoke execute on function _terminal_user_has_location(uuid)      from public;
revoke execute on function _terminal_gen_code()                   from public;
revoke execute on function _terminal_for_caller()                 from public;
revoke execute on function _terminal_is_service_role()            from public;
revoke execute on function register_terminal_device(text, text)   from public;
revoke execute on function claim_terminal_device(text, uuid, text) from public;
revoke execute on function terminal_heartbeat(uuid, text)         from public;
revoke execute on function terminal_staff_login(text)             from public;
revoke execute on function terminal_open_tables()                 from public;
revoke execute on function terminal_start_table_payment(text, uuid) from public;
revoke execute on function terminal_claim_job(uuid)               from public;
revoke execute on function terminal_commit_tip(uuid, bigint)      from public;
revoke execute on function terminal_job_sent(uuid, text)          from public;
revoke execute on function terminal_report_result(uuid, text, text, text, jsonb, bigint, text) from public;
revoke execute on function terminal_job_cancel(uuid)              from public;
revoke execute on function terminal_targets_for_pos(uuid)         from public;
revoke execute on function terminal_jobs_sweep(integer)           from public;
revoke execute on function terminal_job_reconcile(uuid, text, text) from public;

-- Terminal-facing (anonymous session on the PAX).
grant execute on function register_terminal_device(text, text)     to anon, authenticated;
grant execute on function terminal_heartbeat(uuid, text)           to anon, authenticated;
grant execute on function terminal_staff_login(text)               to anon, authenticated;
grant execute on function terminal_open_tables()                   to anon, authenticated;
grant execute on function terminal_start_table_payment(text, uuid) to anon, authenticated;
grant execute on function terminal_claim_job(uuid)                 to anon, authenticated;
grant execute on function terminal_commit_tip(uuid, bigint)        to anon, authenticated;
grant execute on function terminal_job_sent(uuid, text)            to anon, authenticated;
grant execute on function terminal_report_result(uuid, text, text, text, jsonb, bigint, text) to anon, authenticated;

-- POS-facing (the till also runs on an anonymous session).
grant execute on function terminal_job_cancel(uuid)                to anon, authenticated;
grant execute on function terminal_targets_for_pos(uuid)           to anon, authenticated;

-- Back Office only. NOT anon — pairing binds a device to a venue.
grant execute on function claim_terminal_device(text, uuid, text)  to authenticated;

-- Sweeper only. No client grant at all; the functions also re-check the JWT role.
grant execute on function terminal_jobs_sweep(integer)             to service_role;
grant execute on function terminal_job_reconcile(uuid, text, text) to service_role;
