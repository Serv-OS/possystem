-- 20260801_terminal_paid_guard_occupation.sql   (OPS DB)
--
-- HOTFIX to the R1 guard (20260730): it matched by check_key ALONE, and check_keys
-- RECUR — session ids are ORD-<counter> with the counter reset on every till
-- reload, so a brand-new party on the same table can mint the same key as an old
-- payment. Worse, mode-3 (pos_send_to_terminal) jobs are parked in 'approved'
-- FOREVER (the reconciler only closes pax_table_pay jobs — the known durable
-- cash-off gap), so "approved is transient" does not hold for them. Net effect,
-- seen live within hours of shipping: a fresh transaction refused with "this
-- table has already been paid" against a parked approved job from a PREVIOUS
-- occupation. A guard that blocks a legitimate NEW payment is the exact
-- never-block failure this system promises not to have.
--
-- Refinement: block only when the approved job is provably the SAME OCCUPATION —
--   * its check_draft->>'seatedAt' equals the live session's seatedAt
--     (terminal_start_table_payment writes seatedAt into every Table-Pay draft), OR
--   * it carries no seatedAt (mode-3 drafts don't) AND is recent (< 2 hours) —
--     inside that window a same-key approved job is far more likely the live
--     party's real payment than a recurring-counter collision; beyond it the row
--     is an artifact and must never block a new party.
-- The genuine R1 window (seconds-to-minutes between charge and reconcile, or a
-- POS outage) is fully inside both branches, so the double-charge protection is
-- intact; the false block self-heals.

begin;

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
  -- R1 (20260730, refined 20260801): refuse a second charge only when the approved
  -- job is the SAME occupation — seatedAt match, or a recent (<2h) job with no
  -- seatedAt (mode-3 drafts). Recurring ORD-N keys from PAST occupations must
  -- never block a new party.
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status = 'approved'
                and (
                      (j.check_draft ->> 'seatedAt') is not null
                        and j.check_draft ->> 'seatedAt' = a.session ->> 'seatedAt'
                   or (j.check_draft ->> 'seatedAt') is null
                        and j.created_at > now() - interval '2 hours'
                    )) then
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
                and (
                      j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
                      -- R1 (20260730, refined 20260801): hide a PAID table only for
                      -- the same occupation (seatedAt match) or a recent no-seatedAt
                      -- job — a recurring ORD-N key from a past party must not hide
                      -- a new party's bill.
                   or (j.status = 'approved'
                        and (
                              (j.check_draft ->> 'seatedAt') is not null
                                and j.check_draft ->> 'seatedAt' = a.session ->> 'seatedAt'
                           or (j.check_draft ->> 'seatedAt') is null
                                and j.created_at > now() - interval '2 hours'
                            ))
                    )
           )
     order by 6 asc;
end; $function$;

commit;
