-- Adyen region codes become 'UK' | 'US'. PLATFORM project (yhzjgyrkyjabvhblqxzu).
--
-- Owner facts 8 Sep 2026: the UK live Adyen account and the US live Adyen
-- account are DIFFERENT accounts (api key, client key, URL prefix, merchant
-- account, webhook HMAC key, hosts). The live secret set is therefore per
-- region (ADYEN_LIVE_UK_* and ADYEN_LIVE_US_*), and the owner wants the
-- region code to read 'UK' everywhere he sees it: secret names, the admin
-- select and the database value. The foundation migration
-- (20260801_PLATFORM_adyen_foundation.sql) created the column as
--   region text not null default 'EU' check (region in ('EU','US'))
-- so this file: drops that check, rewrites every 'EU' row to 'UK', moves the
-- default to 'UK' and adds check (region in ('UK','US')).
--
-- Until this runs, the edge functions READ a stored 'EU' as 'UK' (the
-- resolver normalises it) but cannot WRITE 'UK': the old check refuses it,
-- and set_region / row creates answer with a message naming this file.
--
-- Idempotent, bare statements, no transaction wrapper. Run by hand.

-- 1. Drop every check constraint on merchant_adyen_accounts that mentions
--    region, whatever Postgres named it (the inline one is
--    merchant_adyen_accounts_region_check).
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'merchant_adyen_accounts'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%region%'
  loop
    execute format('alter table public.merchant_adyen_accounts drop constraint %I', c.conname);
  end loop;
end
$$;

-- 2. Legacy rows: 'EU' was the old default and means the UK account.
update public.merchant_adyen_accounts
  set region = 'UK', updated_at = now()
  where region = 'EU';

-- 3. New rows default to UK.
alter table public.merchant_adyen_accounts
  alter column region set default 'UK';

-- 4. The new check. Step 1 already dropped any earlier copy, so this is safe
--    to re-run.
alter table public.merchant_adyen_accounts
  drop constraint if exists merchant_adyen_accounts_region_check;

alter table public.merchant_adyen_accounts
  add constraint merchant_adyen_accounts_region_check
  check (region in ('UK', 'US'));

comment on column public.merchant_adyen_accounts.region is
  'Adyen account region for this venue: UK (default, Adyen EU data centre, secrets ADYEN_LIVE_UK_*) or US (live-us, secrets ADYEN_LIVE_US_*). Picks the live secret set, the Drop-in environment and the terminal host. Legacy value EU was rewritten to UK on 8 Sep 2026.';
