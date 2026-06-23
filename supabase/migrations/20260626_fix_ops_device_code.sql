-- ============================================================================
-- FIX: register_ops_device claim-code generation
-- ----------------------------------------------------------------------------
-- The original fn used gen_random_bytes() (pgcrypto). On this project pgcrypto
-- lives in the `extensions` schema, which is NOT on the function's
-- `search_path = public`, so the call raised 42883 "function gen_random_bytes
-- does not exist" — registration failed and the floor app (?mode=ops) showed an
-- EMPTY pairing code, so tablets could never be claimed.
--
-- Switch to gen_random_uuid() (core Postgres, in pg_catalog — always resolvable)
-- and derive the 6-char code from its hex. Idempotent (create or replace).
-- ============================================================================

create or replace function public.register_ops_device(p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v ops_devices; v_code text;
begin
  select * into v from ops_devices where device_uid = auth.uid() limit 1;
  if found then return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id); end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into ops_devices (device_uid, name, claim_code, last_seen_at)
    values (auth.uid(), coalesce(p_name,'Ops tablet'), v_code, now()) returning * into v;
  return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id);
end $$;

grant execute on function public.register_ops_device(text) to authenticated, anon;
