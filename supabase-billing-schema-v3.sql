-- ═══════════════════════════════════════════════════════════════════════════
-- Stripe Connect — per-merchant markup + platform defaults (v3)
-- Run on: yhzjgyrkyjabvhblqxzu (RPOS Platform)
--
-- Adds two negotiable markup % columns to merchant_stripe_accounts (one for
-- card-present, one for online), and a small platform_settings table holding
-- the global default values used when a merchant doesn't have a per-merchant
-- override.
--
-- application_fee_amount on every PaymentIntent is then computed as:
--   markup% = COALESCE(merchant_stripe_accounts.<channel>_markup_percent,
--                      platform_settings.default_<channel>_markup_percent)
--   fee_minor = ROUND(amount_minor * markup% / 100)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Per-merchant markup columns ──────────────────────────────────────
alter table merchant_stripe_accounts
  add column if not exists cardpresent_markup_percent numeric(6,3),
  add column if not exists online_markup_percent      numeric(6,3),
  add column if not exists pricing_notes              text;

comment on column merchant_stripe_accounts.cardpresent_markup_percent is
  'Per-transaction markup % for card-present (in-person) charges. Null = use platform default.';
comment on column merchant_stripe_accounts.online_markup_percent is
  'Per-transaction markup % for online charges. Null = use platform default.';

-- ── 2. Platform-wide settings (singleton) ────────────────────────────────
create table if not exists platform_settings (
  id boolean primary key default true,                      -- enforces 1 row
  default_cardpresent_markup_percent numeric(6,3) not null default 1.0,
  default_online_markup_percent      numeric(6,3) not null default 0.5,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references platform_users(id),
  constraint platform_settings_singleton check (id = true)
);

insert into platform_settings (id) values (true) on conflict (id) do nothing;

alter table platform_settings enable row level security;

-- read access for any authed user (so the BO can show effective rates if ever needed)
drop policy if exists ps_read on platform_settings;
create policy ps_read on platform_settings for select to authenticated using (true);

-- writes via service role only (Edge Functions / admin actions)

-- ── 3. RPC for markup resolution ─────────────────────────────────────────
-- Returns the effective markup % for a location + channel.
-- Falls back to platform_settings if the merchant doesn't override.
create or replace function get_effective_markup(
  p_location_id uuid,
  p_channel text                                              -- 'card_present' | 'online'
) returns numeric as $$
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
$$ language plpgsql stable security definer;

grant execute on function get_effective_markup(uuid, text) to authenticated, anon, service_role;

-- ── 4. Verification ──────────────────────────────────────────────────────
select 'markup_columns_added' as check_kind,
       count(*)::text as result
  from information_schema.columns
 where table_schema='public'
   and table_name='merchant_stripe_accounts'
   and column_name in ('cardpresent_markup_percent','online_markup_percent','pricing_notes')
union all
select 'platform_settings_row',
       count(*)::text from platform_settings
union all
select 'rpc_get_effective_markup',
       count(*)::text from information_schema.routines
 where routine_schema='public' and routine_name='get_effective_markup';
