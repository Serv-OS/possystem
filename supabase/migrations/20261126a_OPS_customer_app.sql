-- 20261126a_OPS_customer_app.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 2 tables, 1 trigger and 1 function, service role only.             #
-- #  Changes no existing table, row or function.                             #
-- ############################################################################
--
-- WHY (6 Nov 2026)
--   The native customer app (one Expo app themed per tenant) needs three things the web loyalty
--   portal never did: a sign in that lasts (the loyalty-otp token dies after 24 hours and cannot
--   be extended), Delete my account (the stores require it; Peter, 18 Sep 2026: wipe personal
--   data, end the membership and stamps, keep sales and gift ledgers), and a per tenant theme
--   payload. The customer-app edge function serves all of it with the service role. Nothing
--   here is reachable with the public key.
--
-- WHAT THIS FILE ADDS
--   public.customer_app_sessions          one row per refresh token (only its sha256 is stored),
--                                         rotated on every use, 180 days, revoked by sign out,
--                                         by reuse of an old token, or by Delete my account
--   public.tenant_app_config              one row per app tenant: the theme payload the app
--                                         paints itself with; a trigger bumps version on every
--                                         payload change (the app applies a payload only when its
--                                         version is higher than the cached one)
--   public.customer_app_delete_account(p_customer_id uuid)
--     One transaction: the personal fields on customers go (name becomes 'Deleted customer'
--     because customers.name is NOT NULL; email, phone, birthday, notes cleared, marketing off,
--     every other personal column the table has cleared too), deleted_at is set, the staff notes
--     about the person at each venue go, every app session is revoked. Closed checks, orders,
--     loyalty_transactions and stamp_transactions are NOT touched: the money and the ledgers
--     stay. Answers a jsonb report. Safe to run twice (the second run changes nothing).
--
-- WHO MAY CALL
--   The service role only (the customer-app edge function, after it verified the member's own
--   token). Revoked from public, anon and authenticated. Both tables have row level security on
--   with no policy, so the public key reads and writes nothing.
--
-- WHAT IT DOES NOT DO
--   The loyalty membership and the stamp cards live in the Platform database:
--   20261126b_PLATFORM_customer_app.sql is the Platform twin (customer_app_end_loyalty). The
--   edge function calls the Platform function first, then this one.
--
-- Rollback: 20261126a_OPS_customer_app_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.customers') is null or to_regclass('public.organisations') is null then
    raise exception 'This is not the Ops database (customers or organisations is missing). Nothing was changed.';
  end if;
end
$guard$;

-- ===== 1. App sessions =====
create table if not exists public.customer_app_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  company_id uuid not null,
  family_id uuid not null default gen_random_uuid(),
  refresh_token_hash text not null,
  device jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null default (now() + interval '180 days'),
  revoked_at timestamptz,
  replaced_by uuid,
  constraint customer_app_sessions_hash_key unique (refresh_token_hash),
  constraint customer_app_sessions_hash_shape check (refresh_token_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists idx_customer_app_sessions_customer on public.customer_app_sessions (customer_id);
create index if not exists idx_customer_app_sessions_family on public.customer_app_sessions (family_id);

alter table public.customer_app_sessions enable row level security;
revoke all on table public.customer_app_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.customer_app_sessions to service_role;

comment on table public.customer_app_sessions is
  'Customer app refresh tokens (sha256 only). Rotated on every use; a reused old token revokes its family. Service role only; the customer-app edge function writes it.';

-- ===== 2. Tenant app config =====
create table if not exists public.tenant_app_config (
  tenant_id text primary key,
  org_id uuid not null references public.organisations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_app_config_tenant_id_shape check (tenant_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  constraint tenant_app_config_version_min check (version >= 1)
);

create index if not exists idx_tenant_app_config_org on public.tenant_app_config (org_id);

alter table public.tenant_app_config enable row level security;
revoke all on table public.tenant_app_config from public, anon, authenticated;
grant select, insert, update, delete on table public.tenant_app_config to service_role;

-- version belongs to the trigger: it goes up by one on every payload change and never otherwise.
create or replace function public.tenant_app_config_bump()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.payload is distinct from old.payload then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists trg_tenant_app_config_bump on public.tenant_app_config;
create trigger trg_tenant_app_config_bump
  before update on public.tenant_app_config
  for each row execute function public.tenant_app_config_bump();

revoke all on function public.tenant_app_config_bump() from public, anon, authenticated;

comment on table public.tenant_app_config is
  'Customer app theme per tenant (the payload shape is the app''s tenant.schema.json). version goes up on every payload change. Service role only; the customer-app edge function reads it.';

-- ===== 3. Delete my account =====
create or replace function public.customer_app_delete_account(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  cust record;
  n_customers integer := 0;
  n_notes integer := 0;
  n_sessions integer := 0;
  cleared text[] := array['name', 'email', 'phone', 'birthday', 'notes', 'marketing_opt_in'];
  col text;
begin
  if p_customer_id is null then
    raise exception 'customer id required';
  end if;

  select id, deleted_at into cust from public.customers where id = p_customer_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'customer_id', p_customer_id);
  end if;

  -- The personal fields every Ops database has. customers.name is NOT NULL: a fixed placeholder.
  update public.customers
     set name = 'Deleted customer',
         email = null,
         phone = null,
         birthday = null,
         notes = null,
         marketing_opt_in = false,
         deleted_at = coalesce(deleted_at, now()),
         updated_at = now()
   where id = p_customer_id;
  get diagnostics n_customers = row_count;

  -- The other personal columns, cleared when the table has them (older databases may not).
  for col in
    select column_name::text from information_schema.columns
     where table_schema = 'public' and table_name = 'customers'
       and column_name in ('phone_raw', 'first_name', 'last_name', 'marketing_opt_in_at',
                           'shopper_reference', 'stored_payment_method_id', 'is_local')
     order by column_name
  loop
    execute format('update public.customers set %I = null where id = $1', col) using p_customer_id;
    cleared := cleared || col;
  end loop;
  for col in
    select column_name::text from information_schema.columns
     where table_schema = 'public' and table_name = 'customers'
       and column_name in ('allergens', 'tags')
     order by column_name
  loop
    execute format('update public.customers set %I = %L where id = $1', col, '{}') using p_customer_id;
    cleared := cleared || col;
  end loop;

  -- Staff notes about the person at each venue (the visit counts and revenue stay: sales data).
  if to_regclass('public.customer_locations') is not null then
    update public.customer_locations set notes = null
     where customer_id = p_customer_id and notes is not null;
    get diagnostics n_notes = row_count;
  end if;

  -- Every app sign in ends now.
  update public.customer_app_sessions set revoked_at = now()
   where customer_id = p_customer_id and revoked_at is null;
  get diagnostics n_sessions = row_count;

  return jsonb_build_object(
    'ok', true,
    'customer_id', p_customer_id,
    'already_deleted', cust.deleted_at is not null,
    'customers_updated', n_customers,
    'personal_columns_cleared', to_jsonb(cleared),
    'notes_cleared', n_notes,
    'sessions_revoked', n_sessions,
    'kept', jsonb_build_array('closed_checks', 'customer_orders', 'loyalty_transactions', 'stamp_transactions')
  );
end
$fn$;

-- ===== Who may call: the service role only =====
revoke all on function public.customer_app_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.customer_app_delete_account(uuid) to service_role;

comment on function public.customer_app_delete_account(uuid) is
  'Customer app Delete my account (Ops side): clears the personal fields, sets deleted_at, revokes every app session; keeps checks, orders and ledgers. Service role only; the customer-app edge function calls it after verifying the member''s token.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 2 tables, 1 function, nothing for the public key.
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('customer_app_sessions', 'tenant_app_config')) as tables_added,
  (select count(*) from pg_trigger where tgname = 'trg_tenant_app_config_bump' and not tgisinternal) as trigger_added,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'customer_app_delete_account') as functions_added,
  has_function_privilege('anon', 'public.customer_app_delete_account(uuid)', 'execute') as anon_can_delete,
  has_function_privilege('authenticated', 'public.customer_app_delete_account(uuid)', 'execute') as login_can_delete,
  has_function_privilege('service_role', 'public.customer_app_delete_account(uuid)', 'execute') as service_can_delete,
  has_table_privilege('anon', 'public.customer_app_sessions', 'select') as anon_reads_sessions,
  has_table_privilege('anon', 'public.tenant_app_config', 'select') as anon_reads_config;

-- ===== EXAMPLE: the first tenant (not run by this file) =====
-- The tenant id is the app's own slug (the same word the app sends as tenantId). The payload
-- shape is the app's schemas/tenant.schema.json; the gateway refuses a row that does not match
-- it, so the app never paints itself with a broken theme. tenantId and version inside the
-- payload are ignored: the row's own tenant_id and version always win.
--
-- insert into public.tenant_app_config (tenant_id, org_id, payload) values (
--   'mozz',
--   '00000000-0000-0000-0000-000000000000',   -- the organisation id (public.organisations.id)
--   '{
--     "displayName": "MOZZ",
--     "bundleId": "uk.co.servos.mozz",
--     "logo": { "light": "https://cdn.example.com/mozz/mark-dark.svg", "dark": "https://cdn.example.com/mozz/mark-light.svg" },
--     "icon": "https://cdn.example.com/mozz/icon-1024.png",
--     "color": { "accent": "#A6412F", "onAccent": "#FFFFFF", "ink": "#14110F", "inkMuted": "#6B625C",
--                "surface": "#FFFFFF", "sunken": "#F5F2F0", "line": "#E2DBD6" },
--     "type": { "display": "Instrument Serif", "body": "Schibsted Grotesk" },
--     "shape": { "radius": 26 },
--     "currency": "GBP",
--     "locale": "en-GB",
--     "modules": { "ordering": true, "stamps": true, "giftCards": true },
--     "support": { "privacyUrl": "https://example.com/privacy", "supportUrl": "https://example.com/support", "termsUrl": "https://example.com/terms" }
--   }'::jsonb
-- )
-- on conflict (tenant_id) do update set payload = excluded.payload;
--
-- select tenant_id, org_id, version, updated_at from public.tenant_app_config where tenant_id = 'mozz';
