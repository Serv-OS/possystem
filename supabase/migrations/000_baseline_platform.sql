-- 000_baseline_platform.sql
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ⚠⚠⚠   PLATFORM DB ONLY   —   project ref  yhzjgyrkyjabvhblqxzu    ⚠⚠⚠   ║
-- ║                                                                          ║
-- ║  The Ops DB (tbetcegmszzotrwdtqhi) has its own baseline. These two       ║
-- ║  projects share table NAMES (`locations` exists on both and they are     ║
-- ║  different tables), so running the wrong file against the wrong project  ║
-- ║  would create plausible-looking garbage. The guard below aborts.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
--
-- WHAT THIS IS
-- A single-file reconstruction of the PLATFORM database as it actually stood on
-- 6 Aug 2026: 38 tables, 525 columns, 113 constraints, 107 indexes, 7 triggers,
-- 11 functions, 34 RLS policies, and the GRANT matrix. Run it against an empty
-- Supabase project and you get this database's shape back.
--
-- It exists because there is no migration ledger. supabase/migrations/ holds 178
-- files that were applied to two different databases by hand, in an order nobody
-- recorded, and at least one of them was never applied at all (see DRIFT below).
-- Replaying them is not a rebuild; it is a guess. This file was read off the live
-- catalogs instead.
--
--
-- WHAT THIS IS NOT
--   • Not a drift-repair tool. Every statement is idempotent so the file can be
--     re-run safely, but `create table if not exists` on an existing table adds
--     NOTHING — no missing column, no missing constraint. Against a drifted
--     database this file will report success and change nothing. Use it on an
--     empty project, or use the verification queries at the bottom to compare.
--   • Not a data migration. Zero rows are inserted. Live row counts are quoted in
--     the comments only as context for how load-bearing each table is.
--   • Not a fix. Several genuinely dangerous things are reproduced here verbatim
--     because they are live — anon holding ALL on customer_loyalty, plaintext gift
--     card codes, a secret in gift_brand_config.hmac_secret. They are labelled
--     where they appear. A baseline that silently improved the schema would be a
--     baseline you could not trust to match production.
--   • Not the auth, storage, realtime or vault schemas. Only `public`. Supabase
--     manages the rest, and this project has ZERO storage buckets and ZERO tables
--     in the supabase_realtime publication (both verified — nothing was omitted).
--
--
-- HOW IT WAS PRODUCED (6 Aug 2026)
-- Read-only queries against yhzjgyrkyjabvhblqxzu via the Supabase management API:
--   pg_class / pg_attribute / pg_attrdef      columns, defaults, RLS + FORCE flags
--   pg_constraint (pg_get_constraintdef)      PK / UNIQUE / CHECK / FK, verbatim
--   pg_indexes                                indexes, minus the constraint-backed
--   pg_trigger (pg_get_triggerdef)            triggers
--   pg_proc   (pg_get_functiondef)            function bodies, verbatim
--   pg_policies                               policy roles / cmd / USING / CHECK
--   pg_class.relacl, pg_attribute.attacl      the grant matrix (section 8)
--   pg_default_acl, pg_namespace.nspacl       why that matrix looks the way it does
--   pg_description                            the COMMENTs in section 9
-- Large result sets were paged (columns in five pages of 130, constraints in two of
-- 60) and the pages were re-counted against `select count(*)` before use, because a
-- silently truncated response here means silently losing schema.
--
-- Claims about client code were re-verified by grep on the same day rather than
-- copied from older migration comments — which is how the increment_gmv note below
-- turned out to be stale.
--
--
-- IT WAS THEN ACTUALLY RUN, NOT JUST READ
-- This file was applied to a scratch PostgreSQL 17.10 seeded with the three
-- Supabase roles (anon / authenticated / service_role), an `extensions` schema, a
-- stub auth.uid(), and Supabase's own `alter default privileges ... grant all` on
-- schema public — so the grant behaviour was tested against the same default ACL
-- the real project has, not a clean one.
--
--   • Applied to an empty database: clean, no errors.
--   • Applied a SECOND time over itself: clean, no errors (idempotent).
--   • The rebuilt database was then compared against the live catalogs on 913
--     facts — every column with its type / nullability / default, every constraint
--     definition, every index definition, every policy with its roles, USING and
--     WITH CHECK, every trigger, every function body by md5, every table, column
--     and function ACL, both RLS flags per table, and every COMMENT.
--     Differences: ZERO.
--   • The fences were then exercised as the `anon` role. Confirmed on the rebuild:
--       UPDATE locations                  → permission denied for table (8b)
--       SELECT loyalty_otp_codes          → permission denied for table (8c)
--       SELECT loyalty_redemption_claims  → permission denied for table (8c)
--       EXECUTE increment_gmv             → permission denied for function (8e)
--       EXECUTE challenge21_reset         → permission denied for function (8e)
--       INSERT locations / payment_devices→ RLS policy violation
--     and, just as importantly, the KNOWN HOLES reproduced too:
--       SELECT payment_devices.registration_code → ALLOWED (20260805d unapplied)
--       SELECT / DELETE customer_loyalty         → ALLOWED (service_all to public)
--       EXECUTE get_effective_markup             → ALLOWED (SECURITY DEFINER, anon)
--     A rebuild that quietly closed those would not be a copy of production.
--   • The wrong-database guard was tested against a database carrying Ops tables:
--     it aborted naming them, and the transaction rolled back with nothing created.
--
--
-- ⚠⚠ THE THING THAT MATTERS MOST ON THIS DATABASE: THE GRANTS (section 8)
--
-- The browser reaches THIS project as the `anon` DB role with no JWT at all.
-- src/lib/supabase.js:20 builds the platform client with
-- `auth: { persistSession: false }`, so there is no session, auth.uid() is null,
-- and every policy phrased `to authenticated` or joining user_company_roles
-- matches nothing from a browser. The anon key ships inside the bundle.
--
-- That has two consequences a rebuild must not lose:
--
--   1. On this project the GRANTS ARE THE SECURITY BOUNDARY, not the policies.
--      RLS cannot restrict columns; GRANTs can. Several of the fences added on
--      5-6 Aug 2026 (20260805c, 20260805d) are grant-level for exactly that reason.
--
--   2. Supabase's default ACL on schema `public` grants ALL to anon, authenticated
--      and service_role on every table postgres creates:
--          pg_default_acl → postgres@public r:
--            postgres=arwdDxtm | anon=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
--      So the CREATE TABLEs in section 2 hand `anon` full DML on all 38 tables the
--      moment they run, whether or not anyone types GRANT. A baseline that just
--      "didn't mention grants" would therefore silently REOPEN every hole
--      20260805c closed. Section 8 states the whole matrix explicitly — the grants
--      AND the revokes — so the result does not depend on the target project's
--      default ACL being in any particular state.
--
--
-- ⚠⚠ DRIFT FOUND WHILE WRITING THIS — READ BEFORE TRUSTING supabase/migrations/
--
--   20260805d_payment_devices_columns.sql IS IN THE REPO AND IS NOT APPLIED.
--   It revokes anon's table-level SELECT on payment_devices and grants back 21 of
--   24 columns, withholding registration_code, stripe_account_id and
--   registered_by_user_id. On the live database:
--       • pg_attribute.attacl is NULL for every column of every table in `public`
--         (zero column-level grants exist anywhere on this project), and
--       • has_column_privilege('anon','public.payment_devices',<col>,'SELECT') is
--         TRUE for all 24 columns.
--   Both checks agree: it never ran. Section 8 therefore reproduces the live,
--   UNFIXED state, and carries 20260805d's statement commented out immediately
--   below it so that applying it is one uncomment away and cannot be forgotten.
--   This is not a recommendation to leave it; it is a refusal to record a fix that
--   is not there.
--
--   20260805c IS applied (anon lost UPDATE on locations; increment_gmv and
--   close_billing_period lost EXECUTE from public/anon/authenticated; the four qr_*
--   CHECKs exist; loyalty_rewards and loyalty_earning_rules are service_role-scoped).
--   20260806_PLATFORM_location_rpcs IS applied (both RPCs exist, service_role only).
--   20260806c_redeem_atomic IS applied (loyalty_redemption_claims + the RPC exist).
--
--
-- ORDERING DISCIPLINE
--   0. extensions          — before anything that could reference them
--   1. trigger functions   — before the tables whose triggers call them
--   2. tables              — FK dependency order, roots first, annotated
--   3. indexes             — after the tables, before anything that needs them
--   4. triggers            — needs both the tables and section 1
--   5. RPC functions       — plpgsql bodies are not parsed at create time, so these
--                            come after the tables they read on purpose: a wrong
--                            column name here should fail at apply, not at runtime
--   6. RLS enable/force    — before policies, or the policies are inert
--   7. policies
--   8. GRANTS and REVOKES  — LAST. On this database they are the fence, so they must
--                            not be overwritten by anything that follows
--   9. comments            — documentation only, safe to run last
--
-- Everything is in ONE transaction. If any statement fails, nothing is created.


begin;

-- ──────────────────────────────────────────────────────────────────────────
-- Wrong-database guard
-- ──────────────────────────────────────────────────────────────────────────
-- The existing house guard (20260805c Section B, 20260806_PLATFORM_location_rpcs)
-- tests `billing_state exists and user_locations does not`. That is right for a
-- migration and WRONG for a baseline: on the empty project this file is meant for,
-- billing_state does not exist yet either, and the guard would refuse to run.
--
-- So this one tests the other side only: does this look like the OPS database?
-- Five Ops-only tables, verified present on tbetcegmszzotrwdtqhi and absent here
-- on 6 Aug 2026. An empty project trips none of them and proceeds.
do $guard$
declare
  found_ops text;
begin
  select string_agg(t, ', ')
    into found_ops
    from unnest(array[
      'public.user_locations',
      'public.user_profiles',
      'public.order_queue',
      'public.closed_checks',
      'public.menu_items'
    ]) as t
   where to_regclass(t) is not null;

  if found_ops is not null then
    raise exception
      'This is the OPS database (found: %). 000_baseline_platform.sql is for the PLATFORM DB (yhzjgyrkyjabvhblqxzu) — aborting.', found_ops;
  end if;
end
$guard$;


-- ══════════════════════════════════════════════════════════════════════════
-- 0. Extensions
-- ══════════════════════════════════════════════════════════════════════════
-- Live set on this project: pgcrypto 1.3 and uuid-ossp 1.1 in schema `extensions`,
-- pg_stat_statements 1.11, supabase_vault 0.3.1, plpgsql. The last three are
-- Supabase-managed and are not created here.
--
-- ⚠ HONEST NOTE: neither pgcrypto nor uuid-ossp is load-bearing for anything in
--   this file. Every uuid default on all 38 tables uses gen_random_uuid(), which
--   has been core Postgres since 13, and no function in section 5 calls a pgcrypto
--   routine — gift-card hashing (argon2id) and the HMAC index are done in the edge
--   functions, in Deno. They are listed because they are installed, so a rebuilt
--   project matches; not because removing them would break something known.
create extension if not exists pgcrypto  with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;


-- ══════════════════════════════════════════════════════════════════════════
-- 1. Trigger functions
-- ══════════════════════════════════════════════════════════════════════════
-- Both must exist before section 4 attaches them. Reproduced verbatim from
-- pg_get_functiondef — including the fact that they are byte-for-byte the same
-- function under two names. set_updated_at() drives six triggers,
-- _touch_location_reader_settings_updated_at() drives one. Consolidating them is
-- a change, so it is not made here.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $function$
begin new.updated_at = now(); return new; end;
$function$;

-- Body kept byte-identical to live — no semicolon after `end`, and the closing
-- delimiter on the same line — so pg_get_functiondef matches on a rebuilt project.
-- That difference from set_updated_at() above is the ONLY thing distinguishing the
-- two functions, and it was found by md5-diffing the rebuild against live rather
-- than by reading them.
create or replace function public._touch_location_reader_settings_updated_at()
returns trigger
language plpgsql
as $function$
begin new.updated_at = now(); return new; end $function$;


-- ══════════════════════════════════════════════════════════════════════════
-- 2. Tables
-- ══════════════════════════════════════════════════════════════════════════
-- FK dependency order: companies and platform_users first, then locations, then
-- everything that hangs off them. Column order, types, nullability, defaults and
-- constraint NAMES are exactly as live — the names matter, because half the
-- repo's later migrations do `drop constraint if exists <name>` by name.
--
-- CHECK and FK bodies are pg_get_constraintdef output, unedited. They are printed
-- in Postgres's own normalised form (`ANY (ARRAY[...])`, doubled parens) rather
-- than reformatted, so a diff against the live catalog is empty rather than noisy.
--
-- adyen_payout_lines.id is written `bigserial`, which is how the live
-- `default nextval('adyen_payout_lines_id_seq')` was made and reproduces the same
-- sequence name.
-- ──────────────────────────────────────────────────────────────────────────
-- 2a. Tenant roots
-- ──────────────────────────────────────────────────────────────────────────

-- companies — the tenant root. Every loyalty, gift-card, message-template and billing
-- row hangs off company_id. 5 rows live. `slug` is unique but nullable.

create table if not exists public.companies (
  id uuid not null default gen_random_uuid(),
  name text not null,
  slug text,
  plan text default 'pro'::text,
  created_at timestamptz default now(),
  constraint companies_pkey PRIMARY KEY (id),
  constraint companies_slug_key UNIQUE (slug)
);

-- platform_users — this project's own copy of who the users are. 3 rows live.
--
-- ⚠ `id` has NO foreign key to auth.users. Verified: the only constraints on this table
--   are the pkey and the email unique. Nothing at the database level keeps it in step
--   with auth, and a baseline must not invent the FK just because it looks like one.
--   user_company_roles.user_id and user_location_access.user_id DO reference it, and
--   those two tables are what half the RLS policies in section 7 read.

create table if not exists public.platform_users (
  id uuid not null,
  email text not null,
  full_name text,
  created_at timestamptz default now(),
  constraint platform_users_pkey PRIMARY KEY (id),
  constraint platform_users_email_key UNIQUE (email)
);

-- locations — the venue record the whole platform keys on, and the single most exposed
-- table here: 49 browser call sites across 27 files reach it through platformSupabase.
--
-- ⚠ A TABLE CALLED `locations` ALSO EXISTS ON THE OPS DB AND IS A DIFFERENT TABLE.
--   ops_location_id and ops_db_url are SOFT pointers at the Ops project
--   (tbetcegmszzotrwdtqhi). A foreign key cannot span two Postgres clusters, so nothing
--   enforces them, and this file does not pretend otherwise.
--
-- The four qr_* CHECK constraints below arrived with 20260805c B3. They matter more than
-- they look: the browser clamps that used to bound those money columns are gone with the
-- browser's UPDATE grant (section 8), so these constraints are now the only floor/ceiling
-- on service charge and left-open-tab surcharge anywhere in the system.
--
-- challenge_21_* is a LICENSING control. Only challenge21_reset() (section 5) can now set
-- challenge_21_counter, and only to 0.

create table if not exists public.locations (
  id uuid not null default gen_random_uuid(),
  company_id uuid,
  name text not null,
  address text,
  ops_db_url text,
  ops_location_id uuid,
  created_at timestamptz default now(),
  timezone text default 'Europe/London'::text,
  business_day_start text default '06:00'::text,
  shifts jsonb default '[]'::jsonb,
  collection_lead_minutes integer default 30,
  stripe_terminal_location_id text,
  opening_hours jsonb,
  online_slug text,
  online_enabled boolean not null default false,
  qr_enabled boolean not null default false,
  online_branding jsonb,
  online_menu_id text,
  online_collection_lead_min integer not null default 30,
  online_delivery_enabled boolean not null default false,
  qr_payment_mode text default 'pay_now'::text,
  qr_table_mode text default 'confirm'::text,
  qr_service_charge_pct numeric(5,2) default 0,
  qr_tab_pre_auth_amount numeric(10,2) default 100,
  qr_tab_warning_message text,
  qr_tab_left_open_surcharge_pct numeric(5,2) default 0,
  qr_tab_left_open_surcharge_fixed numeric(10,2) default 0,
  qr_tab_force_close_after_minutes integer default 0,
  challenge_21_enabled boolean default false,
  challenge_21_alcohol_category_ids text[] default '{}'::text[],
  challenge_21_trigger_every integer default 10,
  challenge_21_counter integer default 0,
  currency text not null default 'GBP'::text,
  payment_processor text not null default 'stripe'::text,
  latitude double precision,
  longitude double precision,
  constraint locations_pkey PRIMARY KEY (id),
  constraint locations_payment_processor_check CHECK ((payment_processor = ANY (ARRAY['stripe'::text, 'ryft'::text, 'adyen'::text]))),
  constraint locations_qr_service_charge_pct_chk CHECK (((qr_service_charge_pct >= (0)::numeric) AND (qr_service_charge_pct <= (50)::numeric))),
  constraint locations_qr_tab_pre_auth_chk CHECK (((qr_tab_pre_auth_amount >= (0)::numeric) AND (qr_tab_pre_auth_amount <= (10000)::numeric))),
  constraint locations_qr_tab_surcharge_fixed_chk CHECK (((qr_tab_left_open_surcharge_fixed >= (0)::numeric) AND (qr_tab_left_open_surcharge_fixed <= (100)::numeric))),
  constraint locations_qr_tab_surcharge_pct_chk CHECK (((qr_tab_left_open_surcharge_pct >= (0)::numeric) AND (qr_tab_left_open_surcharge_pct <= (50)::numeric))),
  constraint locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2b. SaaS billing
-- ──────────────────────────────────────────────────────────────────────────

-- billing_state / billing_invoices — SaaS tier billing.
--
-- Written only by increment_gmv() and close_billing_period() (section 5). Both currently
-- have ZERO callers: verified 6 Aug 2026 by grepping src/ and supabase/functions/ — the
-- only hits for either name are historical entries in src/lib/changelog.js, and
-- src/lib/billing.js, named as the live caller in 20260805c B2, no longer exists.
-- So GMV is not accumulating today. Live: billing_state 4 rows, billing_invoices 0.
--
-- Both tables have RLS on and NO policies (section 7), so they are service_role-only in
-- practice. src/admin/sections/AdminBillingManager.jsx:99 still selects billing_state
-- from the browser and gets an empty array — that is the documented 20260805c B4b
-- breakage, not a schema fault.

create table if not exists public.billing_state (
  id uuid not null default gen_random_uuid(),
  location_id uuid not null,
  company_id uuid not null,
  current_period_start date not null default (date_trunc('month'::text, now()))::date,
  current_period_currency text not null default 'gbp'::text,
  gmv_this_month numeric(12,2) not null default 0,
  gmv_last_month numeric(12,2) not null default 0,
  current_plan text not null default 'free'::text,
  current_monthly_fee numeric(8,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_state_pkey PRIMARY KEY (id),
  constraint billing_state_location_id_key UNIQUE (location_id),
  constraint billing_state_current_period_currency_check CHECK ((current_period_currency = ANY (ARRAY['gbp'::text, 'usd'::text]))),
  constraint billing_state_current_plan_check CHECK ((current_plan = ANY (ARRAY['free'::text, 'starter'::text, 'growth'::text, 'scale'::text, 'enterprise'::text]))),
  constraint billing_state_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint billing_state_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- (see the billing_state note above — same pair.)

create table if not exists public.billing_invoices (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  location_id uuid not null,
  period_start date not null,
  period_end date not null,
  billing_currency text not null,
  gmv_total numeric(12,2) not null,
  tier text not null,
  fee_amount numeric(8,2) not null,
  status text not null default 'draft'::text,
  override_tier text,
  override_reason text,
  override_by_user_id uuid,
  stripe_transfer_id text,
  stripe_transfer_amount bigint,
  stripe_transfer_currency text,
  skim_attempted_at timestamptz,
  skim_completed_at timestamptz,
  skim_failure_code text,
  skim_failure_message text,
  skim_attempts integer not null default 0,
  fallback_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_invoices_pkey PRIMARY KEY (id),
  constraint billing_invoices_location_id_period_start_key UNIQUE (location_id, period_start),
  constraint billing_invoices_billing_currency_check CHECK ((billing_currency = ANY (ARRAY['gbp'::text, 'usd'::text]))),
  constraint billing_invoices_fallback_method_check CHECK (((fallback_method = ANY (ARRAY['manual'::text, 'card_on_file'::text, 'direct_invoice'::text])) OR (fallback_method IS NULL))),
  constraint billing_invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'skim_pending'::text, 'skim_complete'::text, 'skim_failed'::text, 'manual_paid'::text, 'void'::text]))),
  constraint billing_invoices_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'starter'::text, 'growth'::text, 'scale'::text, 'enterprise'::text]))),
  constraint billing_invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint billing_invoices_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2c. Gift cards
-- ──────────────────────────────────────────────────────────────────────────

-- gift_brand_config — per-company gift-card settings, and it holds hmac_secret: the
-- per-org key that turns a plaintext gift-card code into the code_lookup index.
--
-- ⚠ That is a live secret in a table on which `anon` holds ALL privileges (section 8).
--   The ONLY thing between the anon key and those 3 secrets is the RLS policy set in
--   section 7, which is scoped `to authenticated` and joins user_company_roles — and the
--   platform browser client has no JWT at all, so it never matches. That is why the
--   policies look over-tight for a table the Back Office genuinely uses: the two Back
--   Office call sites read it through an edge function, not directly.

create table if not exists public.gift_brand_config (
  company_id uuid not null,
  enabled boolean not null default false,
  currency text not null default 'gbp'::text,
  pin_threshold_minor integer not null default 10000,
  default_expiry_months integer,
  max_card_value_minor integer not null default 50000,
  min_card_value_minor integer not null default 500,
  hmac_secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  branding jsonb,
  constraint gift_brand_config_pkey PRIMARY KEY (company_id),
  constraint gift_brand_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- gift_cards — the money. code_hash is argon2id, code_lookup is the HMAC index built with
-- gift_brand_config.hmac_secret, balance_minor is a cache the transaction ledger reconciles.
--
-- ⚠ code_plain is a live column holding the plaintext code, populated on 7 of 11 rows
--   (counted, not sampled — no code values were read to write this file). It sits on the
--   same row as the hash, which defeats the hashing for anyone who can read the table.
--   Recorded here because it is what the database contains. A baseline states the schema;
--   it does not quietly improve it.

create table if not exists public.gift_cards (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  code_hash text not null,
  code_lookup text not null,
  code_last4 text not null,
  initial_amount_minor bigint not null,
  balance_minor bigint not null default 0,
  status text not null default 'active'::text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  issued_by_staff_id uuid,
  issued_at_location_id uuid,
  recipient_name text,
  recipient_email text,
  note text,
  voided_at timestamptz,
  voided_by uuid,
  voided_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  batch_id uuid,
  batch_name text,
  source text default 'manual'::text,
  recipient_phone text,
  code_plain text,
  constraint gift_cards_pkey PRIMARY KEY (id),
  constraint gift_cards_initial_amount_minor_check CHECK ((initial_amount_minor > 0)),
  constraint gift_cards_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'online'::text, 'bulk'::text, 'import'::text]))),
  constraint gift_cards_status_check CHECK ((status = ANY (ARRAY['active'::text, 'redeemed'::text, 'voided'::text, 'expired'::text]))),
  constraint gift_cards_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- gift_card_pins — optional PIN hashes for high-value cards, keyed 1:1 on the card.

create table if not exists public.gift_card_pins (
  card_id uuid not null,
  pin_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gift_card_pins_pkey PRIMARY KEY (card_id),
  constraint gift_card_pins_card_id_fkey FOREIGN KEY (card_id) REFERENCES gift_cards(id) ON DELETE CASCADE
);

-- gift_card_purchases — the online buy-a-gift-card flow (Stripe or Ryft).
--
-- ⚠ fulfilled_code is plaintext by design (see the COMMENT in section 9: kept so a
--   support agent can resend). 4 of 6 rows carry one. Same caveat as gift_cards.code_plain.
--
-- ⚠ Its `gift_card_purchases_service` policy is FOR ALL TO public USING(true) — one of the
--   two remaining tables where the raw anon key can read and DELETE rows. 20260805c B5b
--   wrote the fix and left it commented out because GiftCards.jsx:1266 is the only reader
--   and it goes through the anon role. Still open on the live database.

create table if not exists public.gift_card_purchases (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  location_id uuid not null,
  amount_minor integer not null,
  currency text not null default 'gbp'::text,
  stripe_session_id text,
  stripe_account_id text,
  stripe_payment_intent_id text,
  sender_name text not null,
  sender_email text not null,
  recipient_name text not null,
  recipient_email text not null,
  message text,
  delivery_type text not null default 'email'::text,
  status text not null default 'pending'::text,
  gift_card_id uuid,
  code_last4 text,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fulfilled_code text,
  sender_phone text,
  processor text not null default 'stripe'::text,
  ryft_payment_session_id text,
  constraint gift_card_purchases_pkey PRIMARY KEY (id),
  constraint gift_card_purchases_amount_minor_check CHECK ((amount_minor > 0)),
  constraint gift_card_purchases_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id),
  constraint gift_card_purchases_gift_card_id_fkey FOREIGN KEY (gift_card_id) REFERENCES gift_cards(id)
);

-- gift_card_transactions — the append-only balance ledger. idx_gift_card_tx_idempotency
-- (section 3) is what makes redeem_gift_card_atomic() safe to retry.

create table if not exists public.gift_card_transactions (
  id uuid not null default gen_random_uuid(),
  card_id uuid not null,
  company_id uuid not null,
  type text not null,
  amount_minor bigint not null,
  balance_after_minor bigint not null,
  location_id uuid,
  order_id text,
  channel text,
  idempotency_key text,
  staff_id uuid,
  note text,
  created_at timestamptz not null default now(),
  constraint gift_card_transactions_pkey PRIMARY KEY (id),
  constraint gift_card_transactions_channel_check CHECK ((channel = ANY (ARRAY['pos'::text, 'online'::text, 'kiosk'::text, 'backoffice'::text]))),
  constraint gift_card_transactions_type_check CHECK ((type = ANY (ARRAY['issue'::text, 'redeem'::text, 'refund'::text, 'void'::text]))),
  constraint gift_card_transactions_card_id_fkey FOREIGN KEY (card_id) REFERENCES gift_cards(id) ON DELETE CASCADE,
  constraint gift_card_transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2d. Loyalty (points)
-- ──────────────────────────────────────────────────────────────────────────

-- loyalty_config — one row per company, PK is company_id. 3 rows live.

create table if not exists public.loyalty_config (
  company_id uuid not null,
  enabled boolean default false,
  currency text default 'GBP'::text,
  points_enabled boolean default true,
  points_per_currency_unit numeric(8,2) default 1,
  points_currency_value numeric(8,4) default 0.01,
  points_rounding text default 'floor'::text,
  points_expiry_months integer,
  earn_on_gift_card_purchase boolean default false,
  earn_on_staff_discount boolean default false,
  earn_on_comps boolean default false,
  earn_on_delivery_fee boolean default false,
  earn_on_service_charge boolean default false,
  earn_on_tax boolean default false,
  excluded_category_ids text[] default '{}'::text[],
  excluded_item_ids text[] default '{}'::text[],
  registration_bonus integer default 0,
  birthday_bonus integer default 0,
  referral_bonus integer default 0,
  referral_referee_bonus integer default 0,
  branding jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  stamps_enabled boolean not null default true,
  constraint loyalty_config_pkey PRIMARY KEY (company_id),
  constraint loyalty_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- loyalty_tiers — created before customer_loyalty because customer_loyalty.tier_id
-- references it.

create table if not exists public.loyalty_tiers (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  sort_order integer default 0,
  color text default '#cd7f32'::text,
  icon text default 'star'::text,
  min_points_earned integer default 0,
  min_visits integer default 0,
  min_spend_minor integer default 0,
  qualification_period text default 'rolling_12m'::text,
  points_multiplier numeric(5,2) default 1.0,
  perks jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  constraint loyalty_tiers_pkey PRIMARY KEY (id),
  constraint loyalty_tiers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- customer_loyalty — the member record and the POINTS BALANCE. 2 rows live.
--
-- ⚠ THE LEDGER FOR THIS TABLE IS NOT ON THIS DATABASE. loyalty_transactions lives on the
--   OPS project (tbetcegmszzotrwdtqhi) — verified today, and verified NOT to exist here.
--   loyalty_redemption_claims below is a claims/idempotency anchor, not the ledger.
--   The split is reconciled by supabase/functions/loyalty-reconcile. Do not add a
--   loyalty_transactions table here to "complete" the schema; there is no such table on
--   this project and inventing one would be a lie about the live system.
--
-- ⚠ customer_id has NO foreign key — public.customers lives on Ops too. Soft pointer.
--
-- ⚠ Its only policy is `service_all` FOR ALL TO public USING(true) WITH CHECK(true), so
--   the raw anon key can read, rewrite and DELETE every member's balance. 20260805c B5b
--   wrote the service_role-scoped replacement and left it COMMENTED OUT because that one
--   policy is also the only thing letting Back Office → Loyalty work (5 browser call
--   sites across LoyaltyManager.jsx, Customers.jsx and reports/LoyaltyReport.jsx, two of
--   which are writes). Still open on the live database — see section 7.

create table if not exists public.customer_loyalty (
  id uuid not null default gen_random_uuid(),
  customer_id uuid not null,
  company_id uuid not null,
  points_balance integer default 0,
  points_earned_total integer default 0,
  points_redeemed_total integer default 0,
  points_expired_total integer default 0,
  tier_id uuid,
  tier_qualified_at timestamptz,
  visit_count integer default 0,
  lifetime_spend_minor integer default 0,
  member_code text,
  referral_code text,
  referred_by uuid,
  birthday date,
  wallet_pass_serial text,
  enrolled_at timestamptz default now(),
  last_earn_at timestamptz,
  last_redeem_at timestamptz,
  points_expire_at timestamptz,
  constraint customer_loyalty_pkey PRIMARY KEY (id),
  constraint customer_loyalty_customer_id_company_id_key UNIQUE (customer_id, company_id),
  constraint customer_loyalty_member_code_key UNIQUE (member_code),
  constraint customer_loyalty_referral_code_key UNIQUE (referral_code),
  constraint customer_loyalty_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint customer_loyalty_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES customer_loyalty(id) ON DELETE SET NULL,
  constraint customer_loyalty_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES loyalty_tiers(id) ON DELETE SET NULL
);

-- loyalty_rewards / loyalty_earning_rules — the two loyalty tables 20260805c B5a DID
-- close: their `service_all` policies are scoped `to service_role` (section 7), because
-- no browser path exists for either. Zero browser call sites, verified again today.

create table if not exists public.loyalty_rewards (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  description text default ''::text,
  icon text default 'gift'::text,
  points_cost integer not null,
  reward_type text not null,
  reward_value jsonb default '{}'::jsonb,
  active boolean default true,
  location_ids text[] default '{}'::text[],
  channels text[] default '{pos,kiosk,online,qr}'::text[],
  min_order_minor integer default 0,
  max_per_order integer default 1,
  max_per_customer integer,
  total_available integer,
  total_redeemed integer default 0,
  sort_order integer default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint loyalty_rewards_pkey PRIMARY KEY (id),
  constraint loyalty_rewards_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- (see loyalty_rewards above — the same B5a pair.)

create table if not exists public.loyalty_earning_rules (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  type text not null,
  active boolean default true,
  priority integer default 0,
  conditions jsonb default '{}'::jsonb,
  multiplier numeric(5,2) default 1.0,
  bonus_points integer default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz default now(),
  constraint loyalty_earning_rules_pkey PRIMARY KEY (id),
  constraint loyalty_earning_rules_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- loyalty_otp_codes — phone verification for loyalty sign-up.
--
-- This is the ONE table on this database that is properly locked: RLS enabled AND FORCED
-- (section 6), no policies at all, and anon/authenticated hold no privileges whatsoever
-- (section 8, from 20260610e). It is the shape every other table here should eventually
-- have. FORCE means even the table owner is subject to RLS.

create table if not exists public.loyalty_otp_codes (
  id uuid not null default gen_random_uuid(),
  phone text not null,
  company_id uuid not null,
  code text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  constraint loyalty_otp_codes_pkey PRIMARY KEY (id),
  constraint loyalty_otp_codes_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- loyalty_redemption_claims — the idempotency anchor for the points debit, from
-- 20260806c. PK is the caller-supplied idempotency_key; loyalty_redeem_points() inserts
-- into it inside the same transaction as the debit. Also locked away from anon and
-- authenticated (section 8). 0 rows live.
--
-- membership_id / reward_id / company_id have no FKs, matching live.

create table if not exists public.loyalty_redemption_claims (
  idempotency_key text not null,
  membership_id uuid not null,
  company_id uuid,
  reward_id uuid,
  points integer not null,
  balance_after integer not null,
  created_at timestamptz not null default now(),
  constraint loyalty_redemption_claims_pkey PRIMARY KEY (idempotency_key)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2e. Loyalty (stamp cards)
-- ──────────────────────────────────────────────────────────────────────────

-- stamp_card_programs / customer_stamp_cards — the stamp-card half of loyalty.
--
-- ⚠ Neither has a company_id foreign key, and customer_stamp_cards has no FK on
--   customer_id either (customers is on Ops). Only program_id is enforced. Live shape.
--
-- Both keep an `anon_read_*` SELECT policy plus a `service_all_*` FOR ALL TO public
-- policy (section 7), so anon can still delete stamp balances. 20260805c B5b left both
-- commented out for the same reason as customer_loyalty: 9 + 4 browser call sites.

create table if not exists public.stamp_card_programs (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  name text not null,
  description text,
  icon text default '☕'::text,
  stamps_required integer not null default 10,
  reward_type text not null default 'free_item'::text,
  reward_description text,
  qualifying_category_ids jsonb default '[]'::jsonb,
  qualifying_item_ids jsonb default '[]'::jsonb,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  reward_config jsonb default '{}'::jsonb,
  constraint stamp_card_programs_pkey PRIMARY KEY (id)
);

-- (see stamp_card_programs above.) The uniqueness that makes upsert_customer_stamp_card()
-- work is idx_customer_stamp_cards_uniq in section 3, NOT a table constraint — the
-- function's ON CONFLICT (customer_id, program_id, company_id) resolves against that
-- unique INDEX. Drop the index and the RPC starts raising instead of upserting.

create table if not exists public.customer_stamp_cards (
  id uuid not null default gen_random_uuid(),
  customer_id uuid not null,
  program_id uuid not null,
  company_id uuid not null,
  stamps_collected integer default 0,
  completed_count integer default 0,
  last_stamp_at timestamptz,
  created_at timestamptz default now(),
  constraint customer_stamp_cards_pkey PRIMARY KEY (id),
  constraint customer_stamp_cards_program_id_fkey FOREIGN KEY (program_id) REFERENCES stamp_card_programs(id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2f. Card readers
-- ──────────────────────────────────────────────────────────────────────────

-- location_reader_settings — tipping prompts and idle screen per venue.
--
-- ⚠ Its three policies are SELECT/INSERT/UPDATE TO public with USING(true)/CHECK(true),
--   so anyone with the anon key can rewrite any venue's tip percentages. 7 browser call
--   sites depend on exactly that. Not fixed here; recorded.

create table if not exists public.location_reader_settings (
  location_id uuid not null,
  tipping_enabled boolean not null default true,
  tip_percentages integer[] not null default ARRAY[15, 18, 20],
  allow_custom_tip boolean not null default true,
  smart_tip_threshold_minor integer,
  idle_screen_enabled boolean not null default false,
  idle_screen_file_id text,
  idle_screen_mime text,
  idle_screen_uploaded_at timestamptz,
  idle_screen_uploaded_by uuid,
  stripe_configuration_id text,
  stripe_configuration_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  idle_screen_image_url text,
  constraint location_reader_settings_pkey PRIMARY KEY (location_id),
  constraint location_reader_settings_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- payment_devices — every card reader on the platform. 4 rows live.
--
-- ⚠⚠ THE MOST IMPORTANT GRANT ON THIS DATABASE HANGS OFF THIS TABLE. See section 8.
--    pd_read_all is SELECT TO anon,authenticated USING(true), i.e. the anon key can read
--    serial_number, registration_code and stripe_account_id for every terminal on the
--    platform. It survives because it is also how a till finds its reader
--    (src/lib/networkReader.js:62, StatusDrawerCardReaders.jsx:70, CardReaders.jsx:85).
--    20260805d exists to fix this with a column-level GRANT — and it is NOT APPLIED on
--    the live database. Verified today, two ways: zero rows in pg_attribute.attacl for
--    this schema, and has_column_privilege('anon', ...) true for all 24 columns.
--
-- ⚠ pd_write_bt / pd_update_bt / pd_delete_bt are all fenced on
--   connection_kind = 'bluetooth', but payment_devices_connection_kind_check only permits
--   'network' and 'tap_to_pay'. No row can satisfy those three policies, so anon has no
--   usable write path here. Reproduced verbatim because that is the live state, but they
--   are dead policies and the table COMMENT in section 9 still describes Bluetooth pairing.

create table if not exists public.payment_devices (
  id uuid not null default gen_random_uuid(),
  location_id uuid not null,
  stripe_reader_id text,
  stripe_account_id text,
  device_type text,
  connection_kind text,
  serial_number text,
  label text,
  registration_code text,
  bound_pos_device_id text,
  status text default 'unknown'::text,
  battery_level numeric(5,2),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  registered_by_user_id uuid,
  notes text,
  ip_address text,
  firmware_version text,
  last_status_check_at timestamptz,
  stripe_terminal_location_id text,
  customer_display_enabled boolean not null default true,
  processor text not null default 'stripe'::text,
  ryft_terminal_id text,
  adyen_terminal_id text,
  constraint payment_devices_pkey PRIMARY KEY (id),
  constraint payment_devices_stripe_reader_id_key UNIQUE (stripe_reader_id),
  constraint payment_devices_connection_kind_check CHECK ((connection_kind = ANY (ARRAY['network'::text, 'tap_to_pay'::text]))),
  constraint payment_devices_processor_check CHECK ((processor = ANY (ARRAY['stripe'::text, 'ryft'::text, 'adyen'::text]))),
  constraint payment_devices_processor_fields_check CHECK ((((processor = 'stripe'::text) AND (stripe_reader_id IS NOT NULL) AND (stripe_account_id IS NOT NULL) AND (device_type IS NOT NULL) AND (connection_kind IS NOT NULL)) OR ((processor = 'ryft'::text) AND (ryft_terminal_id IS NOT NULL)) OR ((processor = 'adyen'::text) AND (adyen_terminal_id IS NOT NULL)))),
  constraint payment_devices_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2g. Stripe
-- ──────────────────────────────────────────────────────────────────────────

-- merchant_stripe_accounts — the Stripe Connect account per venue, plus OUR OWN margin
-- (cardpresent_markup_percent / online_markup_percent / pricing_notes).
--
-- RLS on, no policies (msa_read_all was dropped by 20260805c B4b), so it is service_role
-- only. AdminBillingManager.jsx:97 and AdminStripeTest.jsx:52 still read it from the
-- browser and get nothing back — the documented, accepted breakage.
--
-- ⚠ But get_effective_markup() (section 5) is SECURITY DEFINER and still EXECUTE-able by
--   anon, and it reads this table. So the margin is still reachable with the anon key,
--   one location at a time. See the note in section 5 — it is recorded, not fixed.

create table if not exists public.merchant_stripe_accounts (
  id uuid not null default gen_random_uuid(),
  location_id uuid not null,
  company_id uuid not null,
  stripe_account_id text not null,
  link_method text not null,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  default_currency text,
  country text,
  capabilities jsonb not null default '{}'::jsonb,
  requirements jsonb,
  debit_negative_balances boolean not null default false,
  linked_by_user_id uuid,
  linked_at timestamptz not null default now(),
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cardpresent_markup_percent numeric(6,3),
  online_markup_percent numeric(6,3),
  pricing_notes text,
  constraint merchant_stripe_accounts_pkey PRIMARY KEY (id),
  constraint merchant_stripe_accounts_location_id_key UNIQUE (location_id),
  constraint merchant_stripe_accounts_stripe_account_id_key UNIQUE (stripe_account_id),
  constraint merchant_stripe_accounts_link_method_check CHECK ((link_method = ANY (ARRAY['express_onboarding'::text, 'admin_manual'::text]))),
  constraint merchant_stripe_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint merchant_stripe_accounts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

-- stripe_webhook_events — raw webhook archive + dedupe. Service-role only in practice.

create table if not exists public.stripe_webhook_events (
  id text not null,
  type text not null,
  livemode boolean not null,
  account_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  constraint stripe_webhook_events_pkey PRIMARY KEY (id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2h. Ryft
-- ──────────────────────────────────────────────────────────────────────────

-- Ryft: the second processor. merchant_ryft_accounts has NO foreign key on location_id or
-- company_id (unlike its Stripe equivalent, which has both) — live asymmetry, kept.

create table if not exists public.merchant_ryft_accounts (
  id uuid not null default gen_random_uuid(),
  location_id uuid not null,
  company_id uuid not null,
  ryft_account_id text not null,
  link_method text not null default 'hosted'::text,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  details_submitted boolean not null default false,
  default_currency text,
  country text,
  requirements jsonb,
  cardpresent_markup_percent numeric,
  online_markup_percent numeric,
  pricing_notes text,
  linked_by_user_id uuid,
  linked_at timestamptz not null default now(),
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  markup_percent numeric,
  markup_fixed_pence integer,
  ryft_inperson_location_id text,
  constraint merchant_ryft_accounts_pkey PRIMARY KEY (id),
  constraint merchant_ryft_accounts_location_id_key UNIQUE (location_id),
  constraint merchant_ryft_accounts_ryft_account_id_key UNIQUE (ryft_account_id)
);

-- merchant_ryft_disputes — deadline-driven dispute queue (respond_by).

create table if not exists public.merchant_ryft_disputes (
  id uuid not null default gen_random_uuid(),
  dispute_id text not null,
  ryft_account_id text,
  location_id uuid,
  payment_session_id text,
  amount integer,
  currency text,
  status text,
  category text,
  reason_code text,
  reason_description text,
  respond_by timestamptz,
  recommended_evidence jsonb,
  evidence jsonb,
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_event_at timestamptz,
  constraint merchant_ryft_disputes_pkey PRIMARY KEY (id),
  constraint merchant_ryft_disputes_dispute_id_key UNIQUE (dispute_id)
);

-- ryft_payments / ryft_webhook_events — server-truth payments ledger + webhook dedupe.

create table if not exists public.ryft_payments (
  payment_session_id text not null,
  ryft_account_id text,
  location_id uuid,
  amount integer,
  amount_refunded integer default 0,
  currency text,
  status text,
  channel text,
  order_ref text,
  matched_closed_check text,
  captured_at timestamptz,
  refunded_at timestamptz,
  raw jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint ryft_payments_pkey PRIMARY KEY (payment_session_id)
);

create table if not exists public.ryft_webhook_events (
  event_id text not null,
  event_type text,
  account_id text,
  received_at timestamptz default now(),
  constraint ryft_webhook_events_pkey PRIMARY KEY (event_id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2i. Adyen
-- ──────────────────────────────────────────────────────────────────────────

-- Adyen: the third processor, from 20260801_PLATFORM_adyen_foundation. All six tables
-- have RLS on and NO policies — service_role only by design, and the only group on this
-- database that was built that way from the start. Zero browser call sites, 0 rows live.
--
-- ⚠ None of them has a foreign key on location_id (adyen_payout_lines.payout_id is the
--   only FK in the group). Live shape.

create table if not exists public.merchant_adyen_accounts (
  id uuid not null default gen_random_uuid(),
  location_id uuid not null,
  region text not null default 'EU'::text,
  legal_entity_id text,
  account_holder_id text,
  balance_account_id text,
  transfer_instrument_id text,
  business_line_id text,
  merchant_account text,
  store_id text,
  split_profile_id text,
  receive_payments_ok boolean not null default false,
  payouts_ok boolean not null default false,
  verification_status jsonb,
  onboarding_link_url text,
  onboarding_link_expires_at timestamptz,
  markup_percent numeric,
  markup_fixed_pence integer,
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_adyen_accounts_pkey PRIMARY KEY (id),
  constraint merchant_adyen_accounts_location_id_key UNIQUE (location_id),
  constraint merchant_adyen_accounts_region_check CHECK ((region = ANY (ARRAY['EU'::text, 'US'::text])))
);

create table if not exists public.merchant_adyen_disputes (
  dispute_psp_reference text not null,
  payment_psp_reference text,
  location_id uuid,
  status text,
  reason_code text,
  reason text,
  amount_minor bigint,
  currency text,
  respond_by timestamptz,
  outcome text,
  defense jsonb,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_adyen_disputes_pkey PRIMARY KEY (dispute_psp_reference)
);

create table if not exists public.adyen_payments (
  psp_reference text not null,
  merchant_reference text,
  original_reference text,
  location_id uuid,
  merchant_account text,
  store text,
  channel text,
  last_event_code text,
  success boolean,
  amount_minor bigint,
  currency text,
  amount_refunded_minor bigint not null default 0,
  card jsonb,
  matched_closed_check text,
  matched_terminal_job uuid,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint adyen_payments_pkey PRIMARY KEY (psp_reference)
);

create table if not exists public.adyen_payouts (
  id uuid not null default gen_random_uuid(),
  location_id uuid,
  balance_account_id text,
  payout_date date,
  amount_minor bigint,
  currency text,
  fees_minor bigint,
  status text,
  destination_last4 text,
  reference text,
  report_name text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint adyen_payouts_pkey PRIMARY KEY (id),
  constraint adyen_payouts_reference_key UNIQUE (reference)
);

-- adyen_payout_lines.id is the only serial on this database; the sequence it owns is
-- granted explicitly in section 8.

create table if not exists public.adyen_payout_lines (
  id bigserial not null,
  payout_id uuid,
  psp_reference text,
  line_type text,
  gross_minor bigint,
  fee_minor bigint,
  net_minor bigint,
  raw jsonb,
  constraint adyen_payout_lines_pkey PRIMARY KEY (id),
  constraint adyen_payout_lines_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES adyen_payouts(id) ON DELETE CASCADE
);

create table if not exists public.adyen_webhook_events (
  event_key text not null,
  received_at timestamptz not null default now(),
  raw jsonb,
  constraint adyen_webhook_events_pkey PRIMARY KEY (event_key)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2j. Platform config
-- ──────────────────────────────────────────────────────────────────────────

-- message_templates — per-company email/SMS copy. RLS on, no policies, zero browser call
-- sites: read by edge functions only.

create table if not exists public.message_templates (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  message_type text not null,
  channel text not null,
  subject text,
  body_text text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint message_templates_pkey PRIMARY KEY (id),
  constraint message_templates_company_id_message_type_channel_key UNIQUE (company_id, message_type, channel),
  constraint message_templates_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text]))),
  constraint message_templates_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- platform_settings — singleton (id boolean PK, CHECK id = true). Holds the DEFAULT
-- markups the per-merchant columns fall back to. ps_read is SELECT TO authenticated, and
-- the platform browser client is anon, so the 3 browser call sites read nothing directly.

create table if not exists public.platform_settings (
  id boolean not null default true,
  default_cardpresent_markup_percent numeric(6,3) not null default 1.0,
  default_online_markup_percent numeric(6,3) not null default 0.5,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid,
  default_ryft_markup_percent numeric default 1.50,
  default_ryft_markup_fixed_pence integer default 0,
  ryft_cost_percent numeric default 0.80,
  ryft_cost_fixed_pence integer default 8,
  default_adyen_markup_percent numeric,
  default_adyen_markup_fixed_pence integer,
  constraint platform_settings_pkey PRIMARY KEY (id),
  constraint platform_settings_singleton CHECK ((id = true))
);

-- ──────────────────────────────────────────────────────────────────────────
-- 2k. Access control
-- ──────────────────────────────────────────────────────────────────────────

-- ⚠ THREE OVERLAPPING ACCESS TABLES LIVE HERE. This is confusing and it is real:
--
--   user_company_roles   — READ BY THE RLS POLICIES. companies, gift_*, gift_brand_config.
--   user_location_access — READ BY THE RLS POLICIES. `users read their locations`.
--   user_access          — READ BY NOTHING. No client code, no policy on any table
--                          subqueries it, no edge function. It leaks
--                          (user_id, email, company_id, location_id, role) for every
--                          staff member across every tenant, which is why 20260805c B4a
--                          dropped its only policy. 5 rows live. It is kept in this
--                          baseline because it exists; it is a candidate for deletion,
--                          not for growth.
--
-- None of the three has a foreign key to auth.users (only to platform_users).

create table if not exists public.user_access (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  email text not null,
  company_id uuid,
  location_id uuid,
  role text default 'admin'::text,
  created_at timestamptz default now(),
  constraint user_access_pkey PRIMARY KEY (id),
  constraint user_access_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint user_access_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
);

create table if not exists public.user_company_roles (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  company_id uuid,
  role text default 'admin'::text,
  created_at timestamptz default now(),
  constraint user_company_roles_pkey PRIMARY KEY (id),
  constraint user_company_roles_user_id_company_id_key UNIQUE (user_id, company_id),
  constraint user_company_roles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  constraint user_company_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE
);

create table if not exists public.user_location_access (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  location_id uuid,
  created_at timestamptz default now(),
  constraint user_location_access_pkey PRIMARY KEY (id),
  constraint user_location_access_user_id_location_id_key UNIQUE (user_id, location_id),
  constraint user_location_access_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
  constraint user_location_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES platform_users(id) ON DELETE CASCADE
);
-- ══════════════════════════════════════════════════════════════════════════
-- 3. Indexes
-- ══════════════════════════════════════════════════════════════════════════
-- 51 indexes. The other 56 of the live 107 are constraint-backed (38 primary
-- keys + 18 uniques) and were created by section 2 — reproducing them here would
-- duplicate them under different names, so they are deliberately excluded.
-- Verified: 51 + 56 = 107 = count(*) from pg_indexes where schemaname='public'.
--
-- Definitions are pg_indexes.indexdef verbatim with `if not exists` inserted, so
-- partial predicates and DESC orderings survive exactly.

--   adyen_payments
create index if not exists idx_adyen_payments_location ON public.adyen_payments USING btree (location_id, created_at DESC);
create index if not exists idx_adyen_payments_mref ON public.adyen_payments USING btree (merchant_reference);

--   adyen_payout_lines
create index if not exists idx_adyen_payout_lines_payout ON public.adyen_payout_lines USING btree (payout_id);

--   adyen_payouts
create index if not exists idx_adyen_payouts_location ON public.adyen_payouts USING btree (location_id, payout_date DESC);

--   billing_invoices
create index if not exists idx_billing_invoices_company ON public.billing_invoices USING btree (company_id);
create index if not exists idx_billing_invoices_location ON public.billing_invoices USING btree (location_id);
create index if not exists idx_billing_invoices_status ON public.billing_invoices USING btree (status);

--   billing_state
create index if not exists idx_billing_state_company ON public.billing_state USING btree (company_id);

--   customer_loyalty
create index if not exists idx_customer_loyalty_company ON public.customer_loyalty USING btree (company_id);
create index if not exists idx_customer_loyalty_customer ON public.customer_loyalty USING btree (customer_id);
create index if not exists idx_customer_loyalty_member ON public.customer_loyalty USING btree (member_code);

--   customer_stamp_cards
-- ⚠ LOAD-BEARING: upsert_customer_stamp_card()'s ON CONFLICT resolves against this
--   unique INDEX, not a table constraint. Without it that RPC raises.
create unique index if not exists idx_customer_stamp_cards_uniq ON public.customer_stamp_cards USING btree (customer_id, program_id, company_id);
create index if not exists idx_customer_stamps_customer ON public.customer_stamp_cards USING btree (customer_id, company_id);
create index if not exists idx_customer_stamps_program ON public.customer_stamp_cards USING btree (program_id);

--   gift_card_purchases
create index if not exists idx_gift_card_purchases_company ON public.gift_card_purchases USING btree (company_id, created_at DESC);
create index if not exists idx_gift_card_purchases_ryft_session ON public.gift_card_purchases USING btree (ryft_payment_session_id) WHERE (ryft_payment_session_id IS NOT NULL);
create index if not exists idx_gift_card_purchases_session ON public.gift_card_purchases USING btree (stripe_session_id) WHERE (stripe_session_id IS NOT NULL);

--   gift_card_transactions
create index if not exists idx_gift_card_tx_card_id ON public.gift_card_transactions USING btree (card_id, created_at DESC);
create index if not exists idx_gift_card_tx_company_id ON public.gift_card_transactions USING btree (company_id);
-- ⚠ LOAD-BEARING: this is what makes redeem_gift_card_atomic() safe to retry — the
--   unique_violation its exception handler catches comes from here.
create unique index if not exists idx_gift_card_tx_idempotency ON public.gift_card_transactions USING btree (card_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
create index if not exists idx_gift_card_tx_order_id ON public.gift_card_transactions USING btree (order_id) WHERE (order_id IS NOT NULL);

--   gift_cards
create index if not exists idx_gift_cards_batch ON public.gift_cards USING btree (batch_id) WHERE (batch_id IS NOT NULL);
-- ⚠ LOAD-BEARING: the only unique constraint on a gift-card code anywhere. gift_cards
--   has no UNIQUE table constraint at all, so a lost index means duplicate codes.
create unique index if not exists idx_gift_cards_code_lookup ON public.gift_cards USING btree (code_lookup);
create index if not exists idx_gift_cards_company_id ON public.gift_cards USING btree (company_id);
create index if not exists idx_gift_cards_company_last4 ON public.gift_cards USING btree (company_id, code_last4);
create index if not exists idx_gift_cards_expires_at ON public.gift_cards USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (status = 'active'::text));
create index if not exists idx_gift_cards_recipient_phone ON public.gift_cards USING btree (recipient_phone) WHERE (recipient_phone IS NOT NULL);

--   locations
-- ⚠ Named like a constraint but it is a partial UNIQUE INDEX (WHERE online_slug IS NOT
--   NULL), not a UNIQUE constraint — that is how several venues share a null slug.
--   `alter table ... drop constraint locations_online_slug_key` will NOT find it.
create unique index if not exists locations_online_slug_key ON public.locations USING btree (online_slug) WHERE (online_slug IS NOT NULL);

--   loyalty_earning_rules
create index if not exists idx_earning_rules_company ON public.loyalty_earning_rules USING btree (company_id, active);

--   loyalty_otp_codes
create index if not exists idx_loyalty_otp_expires ON public.loyalty_otp_codes USING btree (expires_at);
create index if not exists idx_loyalty_otp_phone_company ON public.loyalty_otp_codes USING btree (phone, company_id);

--   loyalty_rewards
create index if not exists idx_loyalty_rewards_company ON public.loyalty_rewards USING btree (company_id, active);

--   loyalty_tiers
create index if not exists idx_loyalty_tiers_company ON public.loyalty_tiers USING btree (company_id, sort_order);

--   merchant_adyen_disputes
create index if not exists idx_adyen_disputes_location ON public.merchant_adyen_disputes USING btree (location_id, respond_by);

--   merchant_ryft_accounts
create index if not exists idx_mra_location ON public.merchant_ryft_accounts USING btree (location_id);

--   merchant_ryft_disputes
create index if not exists idx_ryft_disputes_account ON public.merchant_ryft_disputes USING btree (ryft_account_id);
create index if not exists idx_ryft_disputes_location ON public.merchant_ryft_disputes USING btree (location_id);
create index if not exists idx_ryft_disputes_status ON public.merchant_ryft_disputes USING btree (status);

--   merchant_stripe_accounts
create index if not exists idx_msa_company ON public.merchant_stripe_accounts USING btree (company_id);
create index if not exists idx_msa_stripe ON public.merchant_stripe_accounts USING btree (stripe_account_id);

--   payment_devices
create index if not exists payment_devices_location_idx ON public.payment_devices USING btree (location_id);
create index if not exists payment_devices_pos_device_idx ON public.payment_devices USING btree (bound_pos_device_id) WHERE (bound_pos_device_id IS NOT NULL);
create unique index if not exists uq_payment_devices_adyen_terminal_id ON public.payment_devices USING btree (adyen_terminal_id) WHERE (adyen_terminal_id IS NOT NULL);
-- ⚠ Asymmetry, live: the Ryft unique index has NO partial WHERE clause while the Adyen
--   one does. Both still tolerate many NULLs (nulls are distinct in a btree), so the
--   difference is cosmetic today. Reproduced as-is.
create unique index if not exists uq_payment_devices_ryft_terminal_id ON public.payment_devices USING btree (ryft_terminal_id);

--   ryft_payments
create index if not exists ryft_payments_account_idx ON public.ryft_payments USING btree (ryft_account_id);
create index if not exists ryft_payments_unmatched_idx ON public.ryft_payments USING btree (matched_closed_check) WHERE (matched_closed_check IS NULL);

--   stamp_card_programs
create index if not exists idx_stamp_programs_company ON public.stamp_card_programs USING btree (company_id);

--   stripe_webhook_events
create index if not exists idx_swe_account ON public.stripe_webhook_events USING btree (account_id);
create index if not exists idx_swe_received ON public.stripe_webhook_events USING btree (received_at DESC);
create index if not exists idx_swe_type ON public.stripe_webhook_events USING btree (type);

--   user_access
create unique index if not exists user_access_user_loc ON public.user_access USING btree (user_id, location_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Triggers
-- ══════════════════════════════════════════════════════════════════════════
-- Seven, all BEFORE UPDATE FOR EACH ROW updated_at touches. There are no other
-- triggers on this database — no audit triggers, no notify triggers, nothing that
-- writes to another table. (pg_trigger, tgisinternal excluded; FK enforcement
-- triggers are internal and come with the constraints in section 2.)
--
-- ⚠ NOT EVERY TABLE WITH AN updated_at HAS ONE. gift_card_purchases,
--   merchant_ryft_accounts, merchant_adyen_accounts, merchant_adyen_disputes,
--   merchant_ryft_disputes, adyen_payments, adyen_payouts, loyalty_config,
--   loyalty_rewards and stamp_card_programs all carry an updated_at column with no
--   trigger behind it — those are maintained by whatever writes the row, or not at
--   all. Live state; do not "complete the set" in a baseline.

drop trigger if exists trg_inv_updated on public.billing_invoices;
create trigger trg_inv_updated before update on public.billing_invoices
  for each row execute function public.set_updated_at();

drop trigger if exists trg_bs_updated on public.billing_state;
create trigger trg_bs_updated before update on public.billing_state
  for each row execute function public.set_updated_at();

drop trigger if exists trg_gift_brand_config_updated_at on public.gift_brand_config;
create trigger trg_gift_brand_config_updated_at before update on public.gift_brand_config
  for each row execute function public.set_updated_at();

drop trigger if exists trg_gift_card_pins_updated_at on public.gift_card_pins;
create trigger trg_gift_card_pins_updated_at before update on public.gift_card_pins
  for each row execute function public.set_updated_at();

drop trigger if exists trg_gift_cards_updated_at on public.gift_cards;
create trigger trg_gift_cards_updated_at before update on public.gift_cards
  for each row execute function public.set_updated_at();

drop trigger if exists trg_msa_updated on public.merchant_stripe_accounts;
create trigger trg_msa_updated before update on public.merchant_stripe_accounts
  for each row execute function public.set_updated_at();

-- The one that uses the duplicate function rather than set_updated_at().
drop trigger if exists trg_lrs_updated_at on public.location_reader_settings;
create trigger trg_lrs_updated_at before update on public.location_reader_settings
  for each row execute function public._touch_location_reader_settings_updated_at();


-- ══════════════════════════════════════════════════════════════════════════
-- 5. RPC functions
-- ══════════════════════════════════════════════════════════════════════════
-- Nine, reproduced verbatim from pg_get_functiondef — bodies, comments, typos and
-- all. Section 8 sets who may execute each one; five of the nine are service_role
-- only and four are open to anon.
--
-- They come AFTER the tables on purpose. A plpgsql body is not parsed at CREATE
-- time, so a function referencing a column that section 2 failed to create would
-- be created cleanly and fail at runtime instead. Putting them here at least means
-- the tables they read exist by the time anyone calls them.

-- get_plan_and_fee_for_gmv — pure tier lookup, IMMUTABLE, no table access.
-- ⚠ The USD branch returns a NULL fee at every tier above free. That is live, not a
--   transcription slip: US pricing was never decided. Any caller that treats the fee
--   as a number gets null arithmetic.
CREATE OR REPLACE FUNCTION public.get_plan_and_fee_for_gmv(gmv numeric, currency text DEFAULT 'gbp'::text)
 RETURNS TABLE(tier text, fee numeric)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
begin
  if gmv <= 5000 then
    tier := 'free';
    fee  := 0;
  elsif gmv <= 8000 then
    tier := 'starter';
    fee  := case when currency = 'usd' then null::numeric else 99 end;
  elsif gmv <= 10000 then
    tier := 'growth';
    fee  := case when currency = 'usd' then null::numeric else 149 end;
  elsif gmv <= 20000 then
    tier := 'scale';
    fee  := case when currency = 'usd' then null::numeric else 199 end;
  else
    tier := 'enterprise';
    fee  := case when currency = 'usd' then null::numeric else 249 end;
  end if;
  return next;
end;
$function$;

-- increment_gmv / close_billing_period — SECURITY DEFINER, and EXECUTE is revoked from
-- public, anon AND authenticated in section 8 (20260805c B2; `public` has to be named
-- explicitly or the built-in PUBLIC grant survives the other two revokes).
--
-- ⚠ Neither has a caller. Verified 6 Aug 2026 across src/ and supabase/functions/: the
--   only hits are historical entries in src/lib/changelog.js. src/lib/billing.js — named
--   as increment_gmv's live caller in 20260805c B2 — no longer exists in the repo. So
--   GMV genuinely stops at whatever billing_state holds today. Recorded because a
--   baseline that repeated the older comment would be repeating something now false.
--
-- ⚠ increment_gmv contains a stale comment of its own ("locations doesn't have a
--   `currency` column in this schema") and then hardcodes v_currency := 'gbp'.
--   locations.currency HAS existed since 20260529_location_currency. The body is
--   reproduced unedited — fixing it here would put a change in a baseline.
CREATE OR REPLACE FUNCTION public.increment_gmv(p_location_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_state billing_state%rowtype;
  v_new_gmv numeric;
  v_new_plan text;
  v_new_fee numeric;
  v_currency text;
  v_company_id uuid;
begin
  select * into v_state from billing_state where location_id = p_location_id for update;

  if not found then
    -- Resolve company + currency from locations
    select l.company_id, coalesce(lower(l.timezone), 'gbp') into v_company_id, v_currency
      from locations l where l.id = p_location_id;
    -- Note: locations doesn't have a `currency` column in this schema; default to gbp.
    -- TODO: if you add locations.currency, replace the line above.
    v_currency := 'gbp';

    insert into billing_state (location_id, company_id, current_period_currency)
    values (p_location_id, v_company_id, v_currency)
    returning * into v_state;
  end if;

  v_currency := v_state.current_period_currency;
  v_new_gmv  := v_state.gmv_this_month + coalesce(p_amount, 0);

  select tier, fee into v_new_plan, v_new_fee
    from get_plan_and_fee_for_gmv(v_new_gmv, v_currency);

  -- Highest-tier wins: only PROMOTE within a period
  if v_state.current_plan = 'enterprise'
     or (v_state.current_plan = 'scale'   and v_new_plan in ('free','starter','growth'))
     or (v_state.current_plan = 'growth'  and v_new_plan in ('free','starter'))
     or (v_state.current_plan = 'starter' and v_new_plan = 'free') then
    v_new_plan := v_state.current_plan;
    v_new_fee  := v_state.current_monthly_fee;
  end if;

  update billing_state
     set gmv_this_month = v_new_gmv,
         current_plan = v_new_plan,
         current_monthly_fee = coalesce(v_new_fee, 0),
         updated_at = now()
   where id = v_state.id;

  return jsonb_build_object(
    'billing_state_id', v_state.id,
    'gmv_this_month', v_new_gmv,
    'current_plan', v_new_plan,
    'current_monthly_fee', coalesce(v_new_fee, 0)
  );
end;
$function$;

-- (see increment_gmv above — same pair, same revoke.)
CREATE OR REPLACE FUNCTION public.close_billing_period(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_state billing_state%rowtype;
  v_invoice_id uuid;
  v_period_end date;
begin
  select * into v_state from billing_state where location_id = p_location_id for update;
  if not found then return jsonb_build_object('error','no_billing_state'); end if;

  v_period_end := (v_state.current_period_start + interval '1 month')::date;

  insert into billing_invoices (
    company_id, location_id, period_start, period_end, billing_currency,
    gmv_total, tier, fee_amount, status
  ) values (
    v_state.company_id, p_location_id, v_state.current_period_start, v_period_end,
    v_state.current_period_currency,
    v_state.gmv_this_month, v_state.current_plan, v_state.current_monthly_fee,
    'draft'
  )
  on conflict (location_id, period_start) do nothing
  returning id into v_invoice_id;

  update billing_state
     set gmv_last_month = gmv_this_month,
         gmv_this_month = 0,
         current_plan = 'free',
         current_monthly_fee = 0,
         current_period_start = v_period_end,
         updated_at = now()
   where id = v_state.id;

  return jsonb_build_object('invoice_id', v_invoice_id, 'billing_state_id', v_state.id);
end;
$function$;

-- get_effective_markup — resolves per-merchant markup → platform default → 0. Called by
-- three service_role edge functions (stripe-create-payment-intent:83,
-- stripe-process-payment-on-reader:116, gift-checkout-session:196).
--
-- ⚠ It is SECURITY DEFINER, owned by postgres, and EXECUTE is still granted to PUBLIC,
--   anon and authenticated (section 8). merchant_stripe_accounts itself is closed —
--   RLS on, no policies — but this function bypasses that by definition. So OUR OWN
--   margin is readable with the anon key, one location_id at a time. It is left open
--   here because closing it is a behaviour change and this file is a baseline; it is
--   written down so the next person does not have to rediscover it.
CREATE OR REPLACE FUNCTION public.get_effective_markup(p_location_id uuid, p_channel text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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

-- challenge21_reset / location_branding_merge — from 20260806_PLATFORM_location_rpcs,
-- the pair that replaced the browser's UPDATE on `locations` after 20260805c B1 revoked
-- it. Called only by supabase/functions/location-admin (:438 and :427). Both are
-- SECURITY DEFINER with a pinned search_path and both are revoked from public/anon/
-- authenticated in section 8.
--
-- challenge21_reset can only ever write 0, which is the point: challenge_21_counter is a
-- licensing control, and a caller that could set it freely could disable the ID prompt.
--
-- location_branding_merge does `online_branding || p_patch` in ONE statement because
-- Menu Appearance and the Review card write different keys of the same jsonb column; any
-- read-modify-write loses one screen's keys with no error anywhere.
CREATE OR REPLACE FUNCTION public.challenge21_reset(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
begin
  update public.locations
     set challenge_21_counter = 0
   where id = p_location_id
   returning id into v_id;

  if v_id is null then
    return null;
  end if;

  return jsonb_build_object('ok', true, 'location_id', v_id, 'challenge_21_counter', 0);
end
$function$;

CREATE OR REPLACE FUNCTION public.location_branding_merge(p_location_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merged jsonb;
begin
  -- The edge function already rejects a non-object patch, but once the write is
  -- remote that check is advisory. `'{}'::jsonb || '3'::jsonb` raises a bare
  -- "invalid concatenation of jsonb objects" that says nothing about where it
  -- came from.
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'p_patch must be a JSON object' using errcode = '22023';
  end if;

  update public.locations
     set online_branding = coalesce(online_branding, '{}'::jsonb) || p_patch
   where id = p_location_id
   returning online_branding into v_merged;

  return v_merged;
end
$function$;

-- loyalty_redeem_points — from 20260806c. Locks the member row, then checks the claim
-- table, so concurrent redemptions serialise; the debit and the
-- loyalty_redemption_claims insert are one transaction.
--
-- ⚠ This is the function that makes the split-brain loyalty design safe: the BALANCE it
--   debits is here on Platform (customer_loyalty), the LEDGER row it corresponds to is
--   written on Ops (loyalty_transactions), and supabase/functions/loyalty-reconcile
--   joins the two afterwards. Nothing in this database can enforce that pairing.
CREATE OR REPLACE FUNCTION public.loyalty_redeem_points(p_membership_id uuid, p_points integer, p_idempotency_key text, p_reward_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member public.customer_loyalty%rowtype;
  v_claim  public.loyalty_redemption_claims%rowtype;
  v_new    integer;
begin
  -- Without a key this function has no idempotency at all, which is the whole
  -- point of it — refuse rather than silently behaving like the old path.
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'loyalty_redeem_points requires an idempotency key';
  end if;
  if coalesce(p_points, 0) < 0 then
    raise exception 'loyalty_redeem_points: p_points must not be negative';
  end if;

  -- Lock first, then probe: this serialises concurrent redemptions for the member,
  -- so the claim lookup cannot be overtaken between the read and the insert.
  select * into v_member from public.customer_loyalty where id = p_membership_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into v_claim from public.loyalty_redemption_claims
   where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'result', 'already_redeemed',
      'balance', coalesce(v_member.points_balance, 0),
      'points_deducted', v_claim.points);
  end if;

  if coalesce(v_member.points_balance, 0) < p_points then
    return jsonb_build_object('result', 'insufficient', 'balance', coalesce(v_member.points_balance, 0));
  end if;

  v_new := coalesce(v_member.points_balance, 0) - p_points;

  update public.customer_loyalty set
    points_balance        = v_new,
    points_redeemed_total = coalesce(points_redeemed_total, 0) + p_points,
    last_redeem_at        = now()
  where id = p_membership_id;

  insert into public.loyalty_redemption_claims
    (idempotency_key, membership_id, company_id, reward_id, points, balance_after)
  values
    (p_idempotency_key, p_membership_id, v_member.company_id, p_reward_id, p_points, v_new);

  if p_reward_id is not null then
    update public.loyalty_rewards
       set total_redeemed = coalesce(total_redeemed, 0) + 1,
           updated_at     = now()
     where id = p_reward_id;
  end if;

  return jsonb_build_object('result', 'redeemed', 'balance', v_new, 'points_deducted', p_points);

exception when unique_violation then
  -- Only reachable if the same key is used against two DIFFERENT memberships (the
  -- row lock serialises same-member callers). The handler's subtransaction rolls
  -- the debit back, so nothing was deducted here.
  select * into v_claim from public.loyalty_redemption_claims
   where idempotency_key = p_idempotency_key;
  return jsonb_build_object(
    'result', 'already_redeemed',
    'balance', coalesce((select points_balance from public.customer_loyalty where id = p_membership_id), 0),
    'points_deducted', coalesce(v_claim.points, p_points));
end;
$function$;

-- redeem_gift_card_atomic — the gift-card debit. Called by supabase/functions/gift-redeem
-- (:182) with the service_role client.
--
-- ⚠ NOT security definer, unlike every other money RPC here. It runs as the caller, so it
--   is the caller's RLS that applies. anon holds EXECUTE (section 8), but gift_cards has
--   no INSERT/UPDATE/DELETE policy at all, so an anon caller's conditional UPDATE matches
--   zero rows and the function returns {"status":"insufficient"} rather than moving money.
--   The protection is therefore RLS-on-gift_cards, not the function. Worth knowing before
--   anyone adds a write policy to gift_cards.
CREATE OR REPLACE FUNCTION public.redeem_gift_card_atomic(p_card_id uuid, p_company_id uuid, p_amount_minor integer, p_idempotency_key text, p_location_id uuid, p_order_id text, p_channel text, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
    DECLARE v_existing record; v_new_balance int; v_new_status text;
    BEGIN
      SELECT amount_minor, balance_after_minor INTO v_existing
        FROM gift_card_transactions
        WHERE card_id = p_card_id AND idempotency_key = p_idempotency_key LIMIT 1;
      IF FOUND THEN
        RETURN jsonb_build_object('status','already_applied','applied',abs(v_existing.amount_minor),'balance_after_minor',v_existing.balance_after_minor);
      END IF;

      UPDATE gift_cards
        SET balance_minor = balance_minor - p_amount_minor
        WHERE id = p_card_id AND company_id = p_company_id AND status = 'active' AND balance_minor >= p_amount_minor
        RETURNING balance_minor INTO v_new_balance;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('status','insufficient');
      END IF;

      v_new_status := CASE WHEN v_new_balance <= 0 THEN 'redeemed' ELSE 'active' END;
      UPDATE gift_cards SET status = v_new_status WHERE id = p_card_id;

      INSERT INTO gift_card_transactions
        (card_id, company_id, type, amount_minor, balance_after_minor, location_id, order_id, channel, idempotency_key, staff_id)
      VALUES
        (p_card_id, p_company_id, 'redeem', -p_amount_minor, v_new_balance, p_location_id, p_order_id, p_channel, p_idempotency_key, p_staff_id);

      RETURN jsonb_build_object('status','ok','applied',p_amount_minor,'balance_after_minor',v_new_balance,'new_status',v_new_status);
    EXCEPTION WHEN unique_violation THEN
      SELECT amount_minor, balance_after_minor INTO v_existing
        FROM gift_card_transactions WHERE card_id = p_card_id AND idempotency_key = p_idempotency_key LIMIT 1;
      RETURN jsonb_build_object('status','already_applied','applied',abs(COALESCE(v_existing.amount_minor,0)),'balance_after_minor',v_existing.balance_after_minor);
    END $function$;

-- upsert_customer_stamp_card — called by supabase/functions/loyalty-earn (:244).
-- Its ON CONFLICT resolves against idx_customer_stamp_cards_uniq (section 3), a unique
-- INDEX rather than a table constraint. Create the table without that index and this
-- function raises instead of upserting.
CREATE OR REPLACE FUNCTION public.upsert_customer_stamp_card(p_customer_id uuid, p_program_id uuid, p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$ DECLARE v_row customer_stamp_cards%ROWTYPE; BEGIN INSERT INTO customer_stamp_cards (customer_id, program_id, company_id, stamps_collected, completed_count) VALUES (p_customer_id, p_program_id, p_company_id, 0, 0) ON CONFLICT (customer_id, program_id, company_id) DO NOTHING RETURNING * INTO v_row; IF v_row.id IS NULL THEN SELECT * INTO v_row FROM customer_stamp_cards WHERE customer_id = p_customer_id AND program_id = p_program_id AND company_id = p_company_id; END IF; RETURN jsonb_build_object('id', v_row.id, 'stamps_collected', v_row.stamps_collected, 'completed_count', v_row.completed_count); END; $function$;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. Row level security
-- ══════════════════════════════════════════════════════════════════════════
-- RLS is enabled on ALL 38 tables (verified: pg_class.relrowsecurity is true for
-- every one). 21 of them carry policies; the other 17 have RLS on and no policies
-- at all, which is the "service_role only" shape — service_role bypasses RLS, so a
-- policy-less table is readable and writable by edge functions and by nobody else.
--
-- The 17 with no policies:
--   adyen_payments, adyen_payout_lines, adyen_payouts, adyen_webhook_events,
--   billing_invoices, billing_state, loyalty_otp_codes, loyalty_redemption_claims,
--   merchant_adyen_accounts, merchant_adyen_disputes, merchant_ryft_disputes,
--   merchant_stripe_accounts, message_templates, ryft_payments,
--   ryft_webhook_events, stripe_webhook_events, user_access
--
-- ⚠ RLS being ON is not the same as the table being safe: it only bites where the
--   policies are narrower than the GRANTs. Section 8 is the other half.

alter table public.adyen_payments             enable row level security;
alter table public.adyen_payout_lines         enable row level security;
alter table public.adyen_payouts              enable row level security;
alter table public.adyen_webhook_events       enable row level security;
alter table public.billing_invoices           enable row level security;
alter table public.billing_state              enable row level security;
alter table public.companies                  enable row level security;
alter table public.customer_loyalty           enable row level security;
alter table public.customer_stamp_cards       enable row level security;
alter table public.gift_brand_config          enable row level security;
alter table public.gift_card_pins             enable row level security;
alter table public.gift_card_purchases        enable row level security;
alter table public.gift_card_transactions     enable row level security;
alter table public.gift_cards                 enable row level security;
alter table public.location_reader_settings   enable row level security;
alter table public.locations                  enable row level security;
alter table public.loyalty_config             enable row level security;
alter table public.loyalty_earning_rules      enable row level security;
alter table public.loyalty_otp_codes          enable row level security;
alter table public.loyalty_redemption_claims  enable row level security;
alter table public.loyalty_rewards            enable row level security;
alter table public.loyalty_tiers              enable row level security;
alter table public.merchant_adyen_accounts    enable row level security;
alter table public.merchant_adyen_disputes    enable row level security;
alter table public.merchant_ryft_accounts     enable row level security;
alter table public.merchant_ryft_disputes     enable row level security;
alter table public.merchant_stripe_accounts   enable row level security;
alter table public.message_templates          enable row level security;
alter table public.payment_devices            enable row level security;
alter table public.platform_settings          enable row level security;
alter table public.platform_users             enable row level security;
alter table public.ryft_payments              enable row level security;
alter table public.ryft_webhook_events        enable row level security;
alter table public.stamp_card_programs        enable row level security;
alter table public.stripe_webhook_events      enable row level security;
alter table public.user_access                enable row level security;
alter table public.user_company_roles         enable row level security;
alter table public.user_location_access       enable row level security;

-- The only FORCE on this database. FORCE makes the table OWNER subject to RLS too,
-- so even a `postgres` session cannot read the codes without a policy — and there
-- is no policy. Combined with the section 8 revoke, loyalty_otp_codes is the only
-- genuinely sealed table here.
alter table public.loyalty_otp_codes force row level security;


-- ══════════════════════════════════════════════════════════════════════════
-- 7. RLS policies
-- ══════════════════════════════════════════════════════════════════════════
-- All 34 live policies, reproduced with their live names, roles, commands and
-- expressions. Each is preceded by `drop policy if exists` so the file re-runs.
--
-- READ THIS BEFORE JUDGING THEM. Two facts explain almost every oddity below:
--
--   (a) The platform browser client has NO JWT (src/lib/supabase.js:20,
--       persistSession:false), so it arrives as the `anon` DB role and auth.uid()
--       is NULL. Every policy written `to authenticated`, and every policy that
--       joins user_company_roles or user_location_access on auth.uid(), matches
--       NOTHING from a browser. Those policies are effectively dead weight today —
--       the screens that need that data go through service_role edge functions.
--
--   (b) The policies that DO fire for the browser are the ones with USING(true).
--       That is not sloppiness so much as the shape forced by (a): with no
--       identity to fence on, USING(true) was the only expression that worked.
--       It is also why several of them are known holes.
--
-- ⚠ Policies are OR'd. A table with one `to service_role using(true)` policy AND
--   one `to public using(true)` policy is wide open; only the narrowest set counts.

-- ── companies ────────────────────────────────────────────────────────────
-- The anon read is required: src/lib/customerUrl.js resolves a venue's company
-- name from a public slug before any session exists. 20260805c B6 kept it
-- deliberately.
drop policy if exists "anon can read companies" on public.companies;
create policy "anon can read companies" on public.companies
  for select to anon
  using (true);

drop policy if exists "users read their companies" on public.companies;
create policy "users read their companies" on public.companies
  for select to public
  using (id in ( select user_company_roles.company_id
                   from user_company_roles
                  where user_company_roles.user_id = auth.uid() ));

-- ── locations ────────────────────────────────────────────────────────────
-- Same story as companies, and the same 20260805c B6 decision. Note there is NO
-- update, insert or delete policy on locations at all — every write now goes
-- through supabase/functions/location-admin with service_role.
drop policy if exists "anon can read locations" on public.locations;
create policy "anon can read locations" on public.locations
  for select to anon
  using (true);

drop policy if exists "users read their locations" on public.locations;
create policy "users read their locations" on public.locations
  for select to public
  using (id in ( select user_location_access.location_id
                   from user_location_access
                  where user_location_access.user_id = auth.uid() ));

-- ── platform_users / user_company_roles / user_location_access ───────────
-- ⚠ `users update own profile` has no WITH CHECK. In Postgres an UPDATE policy
--   with USING and no WITH CHECK reuses USING as the check, so the new row must
--   still satisfy auth.uid() = id — a user cannot rewrite their row into someone
--   else's. Reproduced exactly as live rather than "helpfully" adding the clause.
drop policy if exists "users read own profile" on public.platform_users;
create policy "users read own profile" on public.platform_users
  for select to public
  using (auth.uid() = id);

drop policy if exists "users update own profile" on public.platform_users;
create policy "users update own profile" on public.platform_users
  for update to public
  using (auth.uid() = id);

drop policy if exists "users read own company roles" on public.user_company_roles;
create policy "users read own company roles" on public.user_company_roles
  for select to public
  using (auth.uid() = user_id);

drop policy if exists "users read own location access" on public.user_location_access;
create policy "users read own location access" on public.user_location_access
  for select to public
  using (auth.uid() = user_id);

-- user_access deliberately has NO policy — 20260805c B4a dropped
-- "anon can read user_access" and nothing replaced it. See its note in section 2.

-- ── gift cards ───────────────────────────────────────────────────────────
-- gift_cards, gift_card_pins and gift_card_transactions each have exactly ONE
-- policy, a SELECT scoped to authenticated + user_company_roles. There is no
-- insert/update/delete policy on any of the three, so all writes are service_role
-- only. That is what keeps redeem_gift_card_atomic() safe despite not being
-- SECURITY DEFINER (see section 5).
drop policy if exists gift_cards_select on public.gift_cards;
create policy gift_cards_select on public.gift_cards
  for select to authenticated
  using (company_id in ( select user_company_roles.company_id
                           from user_company_roles
                          where user_company_roles.user_id = auth.uid() ));

drop policy if exists gift_card_pins_select on public.gift_card_pins;
create policy gift_card_pins_select on public.gift_card_pins
  for select to authenticated
  using (card_id in ( select gift_cards.id
                        from gift_cards
                       where gift_cards.company_id in ( select user_company_roles.company_id
                                                          from user_company_roles
                                                         where user_company_roles.user_id = auth.uid() ) ));

drop policy if exists gift_card_tx_select on public.gift_card_transactions;
create policy gift_card_tx_select on public.gift_card_transactions
  for select to authenticated
  using (company_id in ( select user_company_roles.company_id
                           from user_company_roles
                          where user_company_roles.user_id = auth.uid() ));

drop policy if exists gift_brand_config_select on public.gift_brand_config;
create policy gift_brand_config_select on public.gift_brand_config
  for select to authenticated
  using (company_id in ( select user_company_roles.company_id
                           from user_company_roles
                          where user_company_roles.user_id = auth.uid() ));

drop policy if exists gift_brand_config_insert on public.gift_brand_config;
create policy gift_brand_config_insert on public.gift_brand_config
  for insert to authenticated
  with check (company_id in ( select user_company_roles.company_id
                                from user_company_roles
                               where user_company_roles.user_id = auth.uid() ));

drop policy if exists gift_brand_config_update on public.gift_brand_config;
create policy gift_brand_config_update on public.gift_brand_config
  for update to authenticated
  using      (company_id in ( select user_company_roles.company_id
                                from user_company_roles
                               where user_company_roles.user_id = auth.uid() ))
  with check (company_id in ( select user_company_roles.company_id
                                from user_company_roles
                               where user_company_roles.user_id = auth.uid() ));

-- ⚠ OPEN HOLE, LIVE. gift_card_purchases_service is FOR ALL TO public USING(true)
--   WITH CHECK(true) — `public` includes anon, so the raw anon key can read, alter
--   and DELETE purchase records (which carry sender/recipient names and emails and
--   the plaintext fulfilled_code). The narrower `_company_read` policy next to it
--   is inert for the browser, per note (a) above. 20260805c B5b wrote the
--   service_role-scoped replacement and left it commented out because GiftCards.jsx
--   is the only reader and it arrives as anon. Reproduced because it is live.
drop policy if exists gift_card_purchases_company_read on public.gift_card_purchases;
create policy gift_card_purchases_company_read on public.gift_card_purchases
  for select to public
  using (company_id in ( select user_company_roles.company_id
                           from user_company_roles
                          where user_company_roles.user_id = auth.uid() ));

drop policy if exists gift_card_purchases_service on public.gift_card_purchases;
create policy gift_card_purchases_service on public.gift_card_purchases
  for all to public
  using (true) with check (true);

-- ── loyalty ──────────────────────────────────────────────────────────────
-- ⚠ THE FOUR `service_all` POLICIES BELOW THAT SAY `to public` ARE MISNAMED. The
--   name says service_role; `to public` includes anon. On customer_loyalty this
--   means anyone holding the anon key can read every member's points balance and
--   member_code, adjust it, or DELETE it. Same for loyalty_config, loyalty_tiers
--   and the two stamp-card tables.
--
--   They are still here because they are also the ONLY policies on those tables,
--   and the Back Office reaches them as anon: 5 call sites on customer_loyalty
--   (LoyaltyManager.jsx:1023/1331/1351 — two of which are writes — Customers.jsx:145,
--   reports/LoyaltyReport.jsx:45), 6 on loyalty_tiers, 9 on stamp_card_programs,
--   4 on customer_stamp_cards, 1 on loyalty_config. Re-scoping them to service_role
--   is equivalent to dropping them and takes Back Office → Loyalty offline. That is
--   the structural blocker 20260805c B5b documents: the writes have to move behind
--   an edge function first.
--
--   ⚠ DO NOT "fix" this in the baseline. If a future migration closes them, this
--     file should be regenerated from the live catalogs, not hand-edited.
drop policy if exists service_all on public.customer_loyalty;
create policy service_all on public.customer_loyalty
  for all to public
  using (true) with check (true);

drop policy if exists service_all on public.loyalty_config;
create policy service_all on public.loyalty_config
  for all to public
  using (true) with check (true);

drop policy if exists service_all on public.loyalty_tiers;
create policy service_all on public.loyalty_tiers
  for all to public
  using (true) with check (true);

-- These two ARE correctly scoped — 20260805c B5a, the half that was safe to close
-- because no browser path exists for either table. Verified again 6 Aug 2026:
-- zero call sites in src/ for both.
drop policy if exists service_all on public.loyalty_rewards;
create policy service_all on public.loyalty_rewards
  for all to service_role
  using (true) with check (true);

drop policy if exists service_all on public.loyalty_earning_rules;
create policy service_all on public.loyalty_earning_rules
  for all to service_role
  using (true) with check (true);

-- ── stamp cards ──────────────────────────────────────────────────────────
-- The anon_read_* policies are redundant while the service_all_* ones exist (both
-- are USING(true) and policies are OR'd). They matter only as the survivors if the
-- service_all_* pair is ever re-scoped: reads would keep working, writes would not.
-- That is why 20260805c B5b describes closing these as breaking "only writes".
drop policy if exists anon_read_stamp_programs on public.stamp_card_programs;
create policy anon_read_stamp_programs on public.stamp_card_programs
  for select to public
  using (true);

drop policy if exists service_all_stamp_programs on public.stamp_card_programs;
create policy service_all_stamp_programs on public.stamp_card_programs
  for all to public
  using (true) with check (true);

drop policy if exists anon_read_stamp_cards on public.customer_stamp_cards;
create policy anon_read_stamp_cards on public.customer_stamp_cards
  for select to public
  using (true);

drop policy if exists service_all_stamp_cards on public.customer_stamp_cards;
create policy service_all_stamp_cards on public.customer_stamp_cards
  for all to public
  using (true) with check (true);

-- ── card readers ─────────────────────────────────────────────────────────
-- ⚠ Any anon-key holder can rewrite any venue's tipping prompts and idle screen.
--   Seven browser call sites depend on exactly this. Live; not fixed here.
drop policy if exists location_reader_settings_read on public.location_reader_settings;
create policy location_reader_settings_read on public.location_reader_settings
  for select to public
  using (true);

drop policy if exists location_reader_settings_insert on public.location_reader_settings;
create policy location_reader_settings_insert on public.location_reader_settings
  for insert to public
  with check (true);

drop policy if exists location_reader_settings_write on public.location_reader_settings;
create policy location_reader_settings_write on public.location_reader_settings
  for update to public
  using (true) with check (true);

-- pd_read_all is the policy 20260805d exists to neutralise at the column level.
-- It stays: it is how a till finds its reader. See section 8.
drop policy if exists pd_read_all on public.payment_devices;
create policy pd_read_all on public.payment_devices
  for select to anon, authenticated
  using (true);

-- ⚠ These three are DEAD. They are fenced on connection_kind = 'bluetooth', and
--   payment_devices_connection_kind_check (section 2) permits only 'network' and
--   'tap_to_pay'. No row can satisfy them, so anon has no write path to this table.
--   Reproduced verbatim because they are live, and because deleting them here would
--   hide the fact that a CHECK constraint silently retired three policies.
drop policy if exists pd_write_bt on public.payment_devices;
create policy pd_write_bt on public.payment_devices
  for insert to anon, authenticated
  with check (connection_kind = 'bluetooth'::text);

drop policy if exists pd_update_bt on public.payment_devices;
create policy pd_update_bt on public.payment_devices
  for update to anon, authenticated
  using      (connection_kind = 'bluetooth'::text)
  with check (connection_kind = 'bluetooth'::text);

drop policy if exists pd_delete_bt on public.payment_devices;
create policy pd_delete_bt on public.payment_devices
  for delete to anon, authenticated
  using (connection_kind = 'bluetooth'::text);

-- ── processors / platform config ─────────────────────────────────────────
-- merchant_ryft_accounts is readable by any authenticated session with no tenant
-- fence at all (USING(true)). It is harmless for the platform browser client,
-- which is anon and never matches — but it is not harmless for anything that ever
-- signs a user in against THIS project. It exposes ryft_account_id and our
-- markup_percent for every venue.
drop policy if exists mra_read_authenticated on public.merchant_ryft_accounts;
create policy mra_read_authenticated on public.merchant_ryft_accounts
  for select to authenticated
  using (true);

drop policy if exists ps_read on public.platform_settings;
create policy ps_read on public.platform_settings
  for select to authenticated
  using (true);

-- merchant_stripe_accounts, billing_state and billing_invoices intentionally have
-- NO policies: 20260805c B4b dropped msa_read_all, bs_read_all and inv_read_all.
-- The admin-portal screens that used to read them (AdminBillingManager.jsx:97/:99,
-- AdminStripeTest.jsx:52) now render empty until they move behind the payments-admin
-- edge function. That is the accepted trade, not an omission from this file.


-- ══════════════════════════════════════════════════════════════════════════
-- 8. GRANTS AND REVOKES  ——  ⚠ THE SECURITY BOUNDARY ON THIS DATABASE ⚠
-- ══════════════════════════════════════════════════════════════════════════
-- Read the header block before changing anything here.
--
-- The browser reaches this project as the `anon` role with no JWT. RLS cannot
-- restrict columns and cannot help where a policy says USING(true); the GRANT
-- matrix can. Two of the fixes applied on 5-6 Aug 2026 (20260805c B1/B2,
-- 20260610e, 20260806c) are grant-level, and one more (20260805d) is grant-level
-- and still unapplied.
--
-- WHY THE EXPLICIT `grant all` BELOW EXISTS AT ALL, given it looks alarming:
-- Supabase's default ACL already grants ALL on every new public table to anon,
-- authenticated and service_role. The tables in section 2 therefore arrive with
-- that grant whether or not this section says so. Writing it out makes the live
-- privilege matrix VISIBLE and makes this file independent of the target project's
-- pg_default_acl. It is a statement of what is, not an endorsement.
--
-- WHAT ACTUALLY PROTECTS EACH TABLE, given anon holds ALL on nearly all of them.
-- (These are overlapping descriptions, not a partition — loyalty_otp_codes appears
-- twice because it is protected twice, which is the point.)
--
--   • 17 tables: RLS on, NO policies → service_role only. Effectively closed.
--   •  2 tables: the GRANT itself revoked from anon and authenticated →
--        loyalty_otp_codes, loyalty_redemption_claims. Closed at both layers.
--   •  1 table: a PARTIAL revoke → locations, where anon lost UPDATE only.
--
--   •  7 tables carry a `FOR ALL ... TO public USING(true) WITH CHECK(true)` policy,
--      and `public` includes anon. On these the anon key can READ, REWRITE AND
--      DELETE every row on the platform:
--        customer_loyalty · loyalty_config · loyalty_tiers · stamp_card_programs
--        customer_stamp_cards · gift_card_purchases · location_reader_settings
--      Every one of them is a known, documented hole (20260805c B5b) that is open
--      because the Back Office reaches it as anon. See section 7.
--
--   •  3 tables are open to anon for READ only, deliberately:
--        locations, companies  — public slug resolution before any session exists
--                                (20260805c B6, kept on purpose)
--        payment_devices       — reader discovery; this is the one 20260805d is
--                                meant to narrow to 21 of 24 columns, and has not.
--
-- The 14 tables a browser can reach on this project, with call-site counts taken
-- from a grep of src/ for `platformSupabase ... .from('<table>')` on 6 Aug 2026:
--   locations 49 · companies 10 · stamp_card_programs 9 · location_reader_settings 7
--   loyalty_tiers 6 · customer_loyalty 5 · customer_stamp_cards 4 · platform_settings 3
--   payment_devices 3 · merchant_stripe_accounts 2 · gift_brand_config 2
--   billing_state 1 · gift_card_purchases 1 · loyalty_config 1
-- The other 24 tables have zero browser call sites.

-- ── 8a. The live table-level matrix ──────────────────────────────────────
-- Exactly reproduces pg_class.relacl for all 38 tables (arwdDxtm for each of the
-- three roles). The two exceptions and one partial revoke follow immediately after,
-- so the wide grant is never the last word on those tables.
grant all on table
  public.adyen_payments,
  public.adyen_payout_lines,
  public.adyen_payouts,
  public.adyen_webhook_events,
  public.billing_invoices,
  public.billing_state,
  public.companies,
  public.customer_loyalty,
  public.customer_stamp_cards,
  public.gift_brand_config,
  public.gift_card_pins,
  public.gift_card_purchases,
  public.gift_card_transactions,
  public.gift_cards,
  public.location_reader_settings,
  public.locations,
  public.loyalty_config,
  public.loyalty_earning_rules,
  public.loyalty_otp_codes,
  public.loyalty_redemption_claims,
  public.loyalty_rewards,
  public.loyalty_tiers,
  public.merchant_adyen_accounts,
  public.merchant_adyen_disputes,
  public.merchant_ryft_accounts,
  public.merchant_ryft_disputes,
  public.merchant_stripe_accounts,
  public.message_templates,
  public.payment_devices,
  public.platform_settings,
  public.platform_users,
  public.ryft_payments,
  public.ryft_webhook_events,
  public.stamp_card_programs,
  public.stripe_webhook_events,
  public.user_access,
  public.user_company_roles,
  public.user_location_access
to anon, authenticated, service_role;

-- ── 8b. locations: anon loses UPDATE (20260805c B1) ──────────────────────
-- This one revoke is why Back Office location/QR/Challenge-21/branding saves go
-- through supabase/functions/location-admin instead of PATCHing the table, and why
-- challenge21_reset() and location_branding_merge() exist at all.
--
-- ⚠ It ALSO revokes the till's silent write to locations.challenge_21_counter. That
--   was a deliberate decision (Peter, 5 Aug 2026: no live customers yet) with a hard
--   deadline attached — Challenge 21 is a licensing control and must be working
--   again before the first real alcohol sale. This baseline reproduces the decision;
--   it does not extend the deadline.
--
-- ⚠ anon still holds INSERT and DELETE on locations. Nothing uses them, and RLS
--   blocks them today because there is no insert or delete policy — but the grant is
--   there, so a single permissive policy pasted into the dashboard reopens both.
--   Left as live rather than tightened, because tightening is a change.
revoke update on table public.locations from anon;

-- ── 8c. Fully sealed tables ──────────────────────────────────────────────
-- 20260610e. With RLS forced and no policies, this revoke makes loyalty_otp_codes
-- unreachable by anything but service_role. The strongest posture on this database.
revoke all on table public.loyalty_otp_codes from anon, authenticated;

-- 20260806c B1. The idempotency anchor behind loyalty_redeem_points(); if a client
-- could delete rows here, every redemption becomes replayable.
revoke all on table public.loyalty_redemption_claims from anon, authenticated;

-- ── 8d. Sequence ─────────────────────────────────────────────────────────
-- The only sequence on this database (owned by adyen_payout_lines.id). Live acl is
-- rwU for all three roles, which is ALL for a sequence.
grant all on sequence public.adyen_payout_lines_id_seq to anon, authenticated, service_role;

-- ── 8e. Function EXECUTE ─────────────────────────────────────────────────
-- Four of the nine RPCs plus both trigger functions are executable by anon. The
-- other five are service_role only.
--
-- ⚠ A newly created function carries a default EXECUTE grant to PUBLIC. Revoking
--   from anon and authenticated alone leaves that intact and changes nothing — the
--   trap 20260805c B2 documents. `public` must be named explicitly in every revoke
--   below, and it is.
grant execute on function public.set_updated_at()                            to anon, authenticated, service_role;
grant execute on function public._touch_location_reader_settings_updated_at() to anon, authenticated, service_role;
grant execute on function public.get_plan_and_fee_for_gmv(numeric, text)      to anon, authenticated, service_role;
grant execute on function public.get_effective_markup(uuid, text)             to anon, authenticated, service_role;
grant execute on function public.upsert_customer_stamp_card(uuid, uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.redeem_gift_card_atomic(uuid, uuid, integer, text, uuid, text, text, uuid)
                                                                              to anon, authenticated, service_role;
-- Those six also keep the built-in PUBLIC execute grant (that is the `=X/postgres`
-- entry in their live proacl). It is left at the default rather than restated,
-- because restating it would imply someone chose it.
--
-- ⚠ get_effective_markup is SECURITY DEFINER and reads merchant_stripe_accounts,
--   which is otherwise closed. Leaving EXECUTE open to anon means our own margin is
--   readable with the bundled anon key. Recorded, not changed — see section 5.

revoke execute on function public.increment_gmv(uuid, numeric)                        from public, anon, authenticated;
revoke execute on function public.close_billing_period(uuid)                          from public, anon, authenticated;
revoke execute on function public.challenge21_reset(uuid)                             from public, anon, authenticated;
revoke execute on function public.location_branding_merge(uuid, jsonb)                from public, anon, authenticated;
revoke execute on function public.loyalty_redeem_points(uuid, integer, text, uuid)    from public, anon, authenticated;

-- ── 8f. Column-level grants ──────────────────────────────────────────────
-- ⚠ THERE ARE NONE ON THE LIVE DATABASE. Verified 6 Aug 2026: pg_attribute.attacl
--   is NULL for all 525 columns of all 38 tables, and has_column_privilege() for
--   anon is TRUE on all 24 columns of payment_devices.
--
--   That means 20260805d_payment_devices_columns.sql — which is in the repo, dated,
--   and reads as though it were applied — was never run. Its effect is NOT part of
--   this baseline, because a baseline that records a fix which is not on the
--   database is worse than one that records the hole.
--
--   The hole: pd_read_all (section 7) is SELECT TO anon USING(true), so the anon key
--   reads serial_number, registration_code and stripe_account_id for every terminal
--   on the platform. Dropping the policy is not an option — it is how a till finds
--   its reader (src/lib/networkReader.js:62, StatusDrawerCardReaders.jsx:70,
--   CardReaders.jsx:85). The column grant below is the fix.
--
--   TO APPLY IT: uncomment the two statements, having FIRST re-checked the column
--   list against the live table. A column-level grant is exhaustive — any column
--   added to payment_devices after this list was written is NOT granted, and the POS
--   boot query selecting it fails. The list below is the 21 columns live on
--   6 Aug 2026 (24 total, minus the three withheld). 20260805d also depends on a
--   client change: CardReaders.jsx must stop selecting registration_code first.
--
-- revoke select on table public.payment_devices from anon;
-- grant select (
--   id, location_id, stripe_reader_id, device_type, connection_kind,
--   serial_number, label, bound_pos_device_id, status, battery_level,
--   last_seen_at, created_at, notes, ip_address, firmware_version,
--   last_status_check_at, stripe_terminal_location_id, customer_display_enabled,
--   processor, ryft_terminal_id, adyen_terminal_id
-- ) on public.payment_devices to anon;
-- -- withheld from the browser: registration_code, stripe_account_id,
-- --                            registered_by_user_id

-- ── 8g. Schema usage ─────────────────────────────────────────────────────
-- Matches live nspacl. Supabase sets this up on a new project; restated so a
-- rebuilt project does not depend on that having happened.
grant usage on schema public to anon, authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════
-- 9. Comments
-- ══════════════════════════════════════════════════════════════════════════
-- All 28 COMMENTs live on this database, verbatim. They are documentation only and
-- run last so nothing depends on them.
--
-- ⚠ At least one is now WRONG: the payment_devices table comment describes Bluetooth
--   readers bound to a single POS, but connection_kind no longer accepts 'bluetooth'
--   (see section 2). It is reproduced unchanged — this file's job is to say what the
--   database contains, and correcting a comment is a change, not a baseline.

comment on table public.gift_brand_config is
  'Per-org gift card configuration and defaults';
comment on column public.gift_brand_config.branding is
  'Per-feature branding for gift card pages: { logo_url, hero_url, accent_color, background, foreground }. Falls back to location.online_branding if null.';
comment on column public.gift_brand_config.hmac_secret is
  'Per-org HMAC-SHA256 key for gift card code lookup index generation';

comment on table public.gift_card_pins is
  'Optional PIN hashes for high-value gift cards';

comment on column public.gift_card_purchases.fulfilled_code is
  'Plaintext 16-char gift card code, stored at fulfillment for resend capability. Only visible to company admins via RLS.';

comment on table public.gift_card_transactions is
  'Append-only ledger of all gift card balance changes';
comment on column public.gift_card_transactions.amount_minor is
  'Signed amount: positive = credit (issue, refund), negative = debit (redeem, void)';

comment on table public.gift_cards is
  'All issued gift cards. Code stored hashed, balance cached.';
comment on column public.gift_cards.balance_minor is
  'Cached balance in minor currency units. Reconciled on every write.';
comment on column public.gift_cards.batch_id is
  'Groups cards from the same bulk-create or import operation';
comment on column public.gift_cards.batch_name is
  'User-defined label for the batch';
comment on column public.gift_cards.code_hash is
  'argon2id hash of the full 16-char gift card code';
comment on column public.gift_cards.code_lookup is
  'HMAC-SHA256 of code using per-org secret, for fast indexed retrieval';
comment on column public.gift_cards.source is
  'How the card was created: manual, online, bulk, import';

comment on column public.locations.currency is
  'ISO currency code for this location (GBP/USD/EUR). Drives money formatting + Stripe charge currency.';
comment on column public.locations.latitude is
  'Venue latitude (WGS84). Used by the group venue-picker map/distance sort; null = venue hidden from the map.';
comment on column public.locations.longitude is
  'Venue longitude (WGS84). See latitude.';

comment on column public.loyalty_otp_codes.attempts is
  'Failed verify attempts against this code; locked once it hits the verify cap (brute-force guard).';

comment on column public.merchant_ryft_accounts.markup_percent is
  'What we add on top of Ryft cost for this merchant (the platformFee %). Null = platform default.';
comment on column public.merchant_ryft_accounts.ryft_inperson_location_id is
  'Ryft in-person location (iploc_) for this venue — terminals are registered under it. Created on first terminal pairing.';

comment on column public.merchant_stripe_accounts.cardpresent_markup_percent is
  'Per-transaction markup % for card-present (in-person) charges. Null = use platform default.';
comment on column public.merchant_stripe_accounts.online_markup_percent is
  'Per-transaction markup % for online charges. Null = use platform default.';

comment on table public.payment_devices is
  'All Stripe Terminal readers registered to a location. Bluetooth readers are bound to a single POS device; network readers serve all POS at the location.';
comment on column public.payment_devices.bound_pos_device_id is
  'Set for Bluetooth readers — the rpos-device.id of the POS that paired the reader. Null for network/tap-to-pay readers.';
comment on column public.payment_devices.customer_display_enabled is
  'When true, the POS pushes live cart line items to this reader screen. Disable for table service where the reader is not customer-facing.';

comment on column public.platform_settings.default_ryft_markup_percent is
  'Our standard markup % added on top of Ryft cost (the platformFee). Per-location override on merchant_ryft_accounts.markup_percent.';
comment on column public.platform_settings.ryft_cost_fixed_pence is
  'Fixed pence Ryft charges us per transaction (our cost).';
comment on column public.platform_settings.ryft_cost_percent is
  'Blended % Ryft charges us (our cost) — feeds the customer-facing rate (cost + markup) and margin view. One number, editable.';

commit;


-- ══════════════════════════════════════════════════════════════════════════
--  POST-APPLY VERIFICATION  (run separately — these are queries, not DDL)
-- ══════════════════════════════════════════════════════════════════════════
-- Compare a rebuilt project against the numbers this file was read off on
-- 6 Aug 2026. A mismatch means either drift on the live database since then or a
-- defect in this file; both are worth knowing, and neither is visible from a
-- successful `commit`.
--
-- Expect: tables 38, columns 525, constraints 113, indexes 107, triggers 7,
--         functions 11, policies 34, rls_enabled 38, rls_forced 1.
--
--   select
--     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relkind = 'r')                          as tables,
--     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--       where n.nspname = 'public' and c.relkind = 'r')                          as columns,
--     (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
--       join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public') as constraints,
--     (select count(*) from pg_indexes where schemaname = 'public')              as indexes,
--     (select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
--       join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and not tg.tgisinternal)                      as triggers,
--     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public')                                              as functions,
--     (select count(*) from pg_policies where schemaname = 'public')             as policies,
--     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity)     as rls_enabled,
--     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity) as rls_forced;
--
-- THE GRANT MATRIX — the check that actually matters here. Expect exactly three
-- rows: locations/anon missing UPDATE, and loyalty_otp_codes + loyalty_redemption_claims
-- with no anon or authenticated privileges at all.
--
--   select c.relname, array_to_string(c.relacl::text[], ' | ') as acl
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r'
--      and c.relacl::text not like '%anon=arwdDxtm%'
--    order by 1;
--
-- COLUMN-LEVEL GRANTS — expect 0 rows today. If this ever returns rows, 20260805d
-- (or something like it) has been applied and section 8f of this file is stale.
--
--   select c.relname, a.attname, array_to_string(a.attacl::text[], ' | ')
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
--    where n.nspname = 'public' and a.attacl is not null;
--
-- FUNCTION EXECUTE — expect exactly five rows (increment_gmv, close_billing_period,
-- challenge21_reset, location_branding_merge, loyalty_redeem_points), each with an
-- acl of `postgres=X/postgres | service_role=X/postgres` and nothing else.
--
--   select p.proname, array_to_string(p.proacl::text[], ' | ') as acl
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proacl is not null
--      and p.proacl::text not like '%anon=X%'
--    order by 1;
--
-- POLICIES STILL WIDE OPEN — expect exactly 10 rows, run live on 6 Aug 2026:
--   customer_loyalty         service_all                    ALL
--   customer_stamp_cards     anon_read_stamp_cards          SELECT
--   customer_stamp_cards     service_all_stamp_cards        ALL
--   gift_card_purchases      gift_card_purchases_service    ALL
--   location_reader_settings location_reader_settings_read  SELECT
--   location_reader_settings location_reader_settings_write UPDATE
--   loyalty_config           service_all                    ALL
--   loyalty_tiers            service_all                    ALL
--   stamp_card_programs      anon_read_stamp_programs       SELECT
--   stamp_card_programs      service_all_stamp_programs     ALL
-- (location_reader_settings_insert is absent only because an INSERT policy has no
-- USING clause, so qual is null — it is just as open.)
-- MORE rows than this means a new hole. FEWER means someone closed one and this
-- baseline is stale: regenerate it from the live catalogs rather than hand-editing.
--
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public' and 'public' = any(roles) and qual = 'true'
--    order by 1, 2;


-- ══════════════════════════════════════════════════════════════════════════
--  DELIBERATELY NOT IN THIS FILE  (so nobody has to wonder)
-- ══════════════════════════════════════════════════════════════════════════
--   • auth, storage, realtime, vault, graphql schemas — Supabase-managed. This
--     project has ZERO storage buckets (storage.buckets is empty) and ZERO tables
--     in the supabase_realtime publication (puballtables false, no members). Both
--     verified; neither is an omission.
--   • Data. No INSERTs. platform_settings is a singleton with 1 live row and a
--     rebuilt database will have none — whatever bootstraps it must run separately.
--   • Secrets. vault.decrypted_secrets was not queried and nothing here contains a
--     key. gift_brand_config.hmac_secret is a column definition only; the 3 live
--     values are not in this file.
--   • Edge functions. supabase/functions/ deploys manually and separately, and this
--     database is useless without them — every loyalty, gift-card, billing and
--     location write path is a service_role function. A rebuilt project needs
--     PLATFORM_SUPABASE_SERVICE_ROLE_KEY wired before anything works.
--   • pg_cron / pg_net. Not installed on this project (extension list verified:
--     pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault, plpgsql). Anything
--     scheduled against the Platform DB runs from elsewhere.
--   • The Ops database. loyalty_transactions, customers, closed_checks and
--     user_profiles are all on tbetcegmszzotrwdtqhi and none of them exists here.
--     locations.ops_location_id, locations.ops_db_url, customer_loyalty.customer_id
--     and customer_stamp_cards.customer_id are unenforced pointers at that project.
--     No cross-database reference has been invented to make them look enforced.
