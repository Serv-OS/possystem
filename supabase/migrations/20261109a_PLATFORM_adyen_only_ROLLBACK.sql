-- Rollback of 20261109a_PLATFORM_adyen_only.sql (Drop D, 29 Oct 2026). PLATFORM project.
-- Restores the two processor account tables from their archive copies, re adds every dropped
-- column (nullable, no defaults), the unique constraint and index on payment_devices, the three
-- way processor fields check, and get_effective_markup. The archive tables are left in place.

begin;

-- ── 1. The processor account tables, from the archives ────────────────────────
create table if not exists public.merchant_stripe_accounts as
  select * from public.archive_merchant_stripe_accounts;
alter table public.merchant_stripe_accounts
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column location_id set not null,
  alter column company_id set not null,
  alter column stripe_account_id set not null,
  alter column link_method set not null;
alter table public.merchant_stripe_accounts
  add constraint merchant_stripe_accounts_pkey primary key (id),
  add constraint merchant_stripe_accounts_location_id_key unique (location_id),
  add constraint merchant_stripe_accounts_stripe_account_id_key unique (stripe_account_id),
  add constraint merchant_stripe_accounts_link_method_check
    check (link_method = any (array['express_onboarding'::text, 'admin_manual'::text])),
  add constraint merchant_stripe_accounts_company_id_fkey
    foreign key (company_id) references public.companies(id) on delete cascade,
  add constraint merchant_stripe_accounts_location_id_fkey
    foreign key (location_id) references public.locations(id) on delete cascade;
create index if not exists idx_msa_company on public.merchant_stripe_accounts using btree (company_id);
create index if not exists idx_msa_stripe  on public.merchant_stripe_accounts using btree (stripe_account_id);
alter table public.merchant_stripe_accounts enable row level security;   -- no policies: closed, as before
drop trigger if exists trg_msa_updated on public.merchant_stripe_accounts;
create trigger trg_msa_updated before update on public.merchant_stripe_accounts
  for each row execute function public.set_updated_at();

create table if not exists public.merchant_ryft_accounts as
  select * from public.archive_merchant_ryft_accounts;
alter table public.merchant_ryft_accounts
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column location_id set not null,
  alter column company_id set not null,
  alter column ryft_account_id set not null;
alter table public.merchant_ryft_accounts
  add constraint merchant_ryft_accounts_pkey primary key (id),
  add constraint merchant_ryft_accounts_location_id_key unique (location_id),
  add constraint merchant_ryft_accounts_ryft_account_id_key unique (ryft_account_id);
create index if not exists idx_mra_location on public.merchant_ryft_accounts using btree (location_id);
alter table public.merchant_ryft_accounts enable row level security;
drop policy if exists mra_read_authenticated on public.merchant_ryft_accounts;
create policy mra_read_authenticated on public.merchant_ryft_accounts
  for select to authenticated using (true);

-- ── 2. get_effective_markup (as 000_baseline_platform.sql) ────────────────────
create or replace function public.get_effective_markup(p_location_id uuid, p_channel text)
 returns numeric
 language plpgsql
 stable security definer
as $function$
declare
  v_msa merchant_stripe_accounts%rowtype;
  v_default numeric;
  v_override numeric;
begin
  select * into v_msa from merchant_stripe_accounts where location_id = p_location_id;

  if p_channel = 'card_present' then
    v_override := v_msa.cardpresent_markup_percent;
    select default_cardpresent_markup_percent into v_default from platform_settings where id = true;
  elsif p_channel = 'online' then
    v_override := v_msa.online_markup_percent;
    select default_online_markup_percent into v_default from platform_settings where id = true;
  else
    raise exception 'channel must be card_present or online (got %)', p_channel;
  end if;

  return coalesce(v_override, v_default, 0);
end;
$function$;

-- ── 3. platform_settings: the four live Ryft columns, nullable ────────────────
alter table public.platform_settings
  add column if not exists default_ryft_markup_percent     numeric,
  add column if not exists default_ryft_markup_fixed_pence integer,
  add column if not exists ryft_cost_percent               numeric,
  add column if not exists ryft_cost_fixed_pence           integer;

-- ── 4. location_reader_settings ───────────────────────────────────────────────
alter table public.location_reader_settings
  add column if not exists stripe_configuration_id        text,
  add column if not exists stripe_configuration_synced_at timestamptz;

-- ── 5. locations ──────────────────────────────────────────────────────────────
alter table public.locations
  add column if not exists stripe_terminal_location_id text;

-- ── 6. payment_devices ────────────────────────────────────────────────────────
alter table public.payment_devices
  add column if not exists stripe_reader_id            text,
  add column if not exists stripe_account_id           text,
  add column if not exists stripe_terminal_location_id text,
  add column if not exists ryft_terminal_id            text;
alter table public.payment_devices drop constraint if exists payment_devices_stripe_reader_id_key;
alter table public.payment_devices add constraint payment_devices_stripe_reader_id_key unique (stripe_reader_id);
create unique index if not exists uq_payment_devices_ryft_terminal_id
  on public.payment_devices using btree (ryft_terminal_id);
alter table public.payment_devices drop constraint if exists payment_devices_processor_fields_check;
alter table public.payment_devices add constraint payment_devices_processor_fields_check check (
  ((processor = 'stripe'::text) and (stripe_reader_id is not null) and (stripe_account_id is not null)
     and (device_type is not null) and (connection_kind is not null))
  or ((processor = 'ryft'::text)  and (ryft_terminal_id is not null))
  or ((processor = 'adyen'::text) and (adyen_terminal_id is not null))
);
-- The browser column grants of 20260907b for the re added columns (the same list):
grant select (stripe_reader_id, stripe_terminal_location_id, ryft_terminal_id)
  on public.payment_devices to anon, authenticated;
-- stripe_account_id stays withheld, as before.

commit;

-- VERIFY (read only):
--   select count(*) from public.merchant_stripe_accounts;  -- = archive count
--   select count(*) from public.merchant_ryft_accounts;    -- = archive count
--   select proname from pg_proc where proname = 'get_effective_markup';   -- expect 1 row
