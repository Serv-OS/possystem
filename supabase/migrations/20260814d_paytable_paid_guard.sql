-- Double-charge guard (live incident 15 Aug: T2 charged twice via Pay at
-- Table). The in-flight mutex excluded 'approved' — fine on PAX where the till
-- books within seconds, but an Adyen pay-at-table check can sit approved and
-- unbooked, and a second wake-up then charged the same session again.
begin;

create or replace function terminal_start_table_payment_for(p_terminal_device_id uuid, p_table_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t          terminal_devices;
  a          active_sessions;
  v_key      text;
  v_bill     bigint;
  v_job      uuid := gen_random_uuid();
  v_ccid     text;
  v_currency text;
  v_tipcfg   jsonb;
  v_draft    jsonb;
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
  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  -- 'approved' INCLUDED: paid-but-not-yet-booked refuses a second charge.
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown','approved')) then
    raise exception 'this table has already been paid or has a payment in progress';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

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
    'source',      'adyen_pay_at_table'
  );

  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, charge_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key, t.location_id, t.id, null, false,
    v_bill, v_bill, v_bill,
    v_currency, v_tipcfg, v_ccid, v_draft,
    'charging_unsent', 'adyen',
    now() + interval '15 minutes',
    now()
  );

  return jsonb_build_object('job_id', v_job, 'due_minor', v_bill, 'currency', v_currency);
end; $$;

revoke all on function terminal_start_table_payment_for(uuid, text) from public, anon, authenticated;

commit;
