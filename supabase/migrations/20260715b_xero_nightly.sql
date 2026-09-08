-- Xero nightly auto-post (server-side, no Vercel involvement).
-- pg_cron fires at 04:10 UTC daily; xero_nightly_post() calls the xero-sales edge
-- function for YESTERDAY (a completed day) for every venue that is connected AND has
-- opted in (xero_config.auto_daily = true). The function key lives in Supabase Vault
-- under the name 'xero_cron_key' (inserted operationally, never committed).
-- xero-sales itself is idempotent per (location, date) and posts nothing on empty days,
-- so re-fires are harmless.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.xero_nightly_post() returns void
language plpgsql security definer set search_path = public as $$
declare
  loc record;
  key text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  if key is null then return; end if;
  for loc in
    select c.location_id
    from public.xero_connections c
    join public.xero_config g on g.location_id = c.location_id
    where g.auto_daily = true
  loop
    perform net.http_post(
      url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-sales',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
      body    := jsonb_build_object(
        'locationId', loc.location_id,
        'date', to_char((now() at time zone 'utc')::date - 1, 'YYYY-MM-DD'),
        'auto', true
      )
    );
  end loop;
end $$;

-- SECURITY DEFINER + reads Vault → must not be callable from the API roles.
revoke all on function public.xero_nightly_post() from public, anon, authenticated;

-- (Re)schedule idempotently.
do $$ begin perform cron.unschedule('xero-nightly-sales'); exception when others then null; end $$;
select cron.schedule('xero-nightly-sales', '10 4 * * *', $$select public.xero_nightly_post()$$);
