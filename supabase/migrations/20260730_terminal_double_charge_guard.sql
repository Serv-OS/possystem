-- 20260730_terminal_double_charge_guard.sql   (OPS DB)
--
-- R1 — the Table-Pay double-charge window (scale audit 22 Jul 2026, adversarially
-- confirmed). The per-CHECK mutex releases the moment a job reaches 'approved'. A
-- bill paid on a PAX stays re-payable via Table Pay for the ~8s until the client
-- reconciler flips it to 'reconciled' — and for the WHOLE outage if the POS/Wi-Fi
-- drops while the PAX keeps DB connectivity. A second Table-Pay start on the same
-- table+session in that window mints a job with a fresh closed_check_id, charges the
-- card AGAIN, and both settle with needs_human=false. (Seen in test data: one
-- check_key charged 10x because the mutex kept releasing at 'approved'.)
--
-- SCOPE OF THIS FIX — Table Pay ONLY. Both functions below require a table + open
-- session, so they are the mode-1 (on-terminal Table Pay) path exclusively. The
-- counter / walk-in / POS-push path (edge fn terminal-job-create, source
-- 'pos_send_to_terminal') is NOT touched here on purpose: its check_key reuse model
-- is different (a constant walk-in key; a per-sale closed_check_id) and hardening it
-- safely needs coordinated client changes (unique per-sale key + a mode-3 close
-- transition). That is a separate, planned follow-up — doing it in this migration
-- would permanently wedge every counter till after its first card sale.
--
-- WHY 'approved' ONLY (not 'reconciled'): 'approved' is the transient danger state
-- (card charged, close not yet recorded). The reconciler releases it to 'reconciled'
-- once the check is closed at the POS — past the danger. Adding the PERMANENT
-- 'reconciled' state to a key that RECURS (session ids like ORD-100X reset on reload)
-- would refuse a future party seated on the same (table, session-id) — a false block.
-- So we block on 'approved' and let it release.
--
-- WHY the friendly-refusal guards are enough here (no index change): the existing
-- live-state unique index already blocks the "two starts, no job yet" race; the ONLY
-- gap is the approved-but-not-reconciled window, and 'approved' is a STABLE state that
-- both concurrent Table-Pay starts observe, so the EXISTS refusal closes it without a
-- TOCTOU hole. Leaving the shared index untouched is what keeps the counter path safe.

begin;

-- ── terminal_start_table_payment — refuse a second charge on an already-paid table ─
create or replace function terminal_start_table_payment(p_table_id text, p_staff_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $function$
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
  -- R1 (20260730): a table whose card charge already SUCCEEDED ('approved') but whose
  -- close has not yet been recorded must refuse a second charge. This is the double
  -- charge. 'approved' releases to 'reconciled' the moment the POS closes the check,
  -- so this never permanently blocks a table (and 'reconciled' is deliberately NOT
  -- listed — the session-id can recur, and blocking on a permanent state would refuse
  -- a future party on the same table).
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status = 'approved') then
    raise exception 'this table has already been paid — wait for it to finish closing';
  end if;
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
end; $function$;

-- ── terminal_open_tables — a paid-but-not-yet-closed table is NOT offered again ────
create or replace function terminal_open_tables()
returns table(table_id text, label text, session_id text, total_minor bigint, server_name text, opened_at timestamptz)
language plpgsql stable security definer set search_path = public as $function$
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
        -- floor_tables.location_id is TEXT while active_sessions.location_id is
        -- UUID (this schema is genuinely mixed). Cast the UUID side DOWN to text
        -- rather than casting floor_tables up: that column legitimately holds
        -- 'loc-demo', which is not a valid UUID, so ::uuid would throw 22P02.
        on f.id = a.table_id and f.location_id = a.location_id::text
     where a.location_id = t.location_id
       and a.total_minor is not null
       and a.total_minor > 0
       and jsonb_array_length(coalesce(a.session -> 'items', '[]'::jsonb)) > 0
       and not exists (
             select 1 from terminal_jobs j
              where j.check_key = t.location_id::text || ':' || a.table_id || ':' || coalesce(a.session ->> 'id', '-')
                -- R1 (20260730): 'approved' added — a table whose bill is already paid
                -- (charge succeeded, close pending) must NOT be offered for a re-charge.
                -- Transient: releases to 'reconciled' on close. 'reconciled' is NOT
                -- listed (permanent + session-id recurs) — see terminal_start_table_payment.
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown','approved')
           )
     order by 6 asc;
end; $function$;

commit;
