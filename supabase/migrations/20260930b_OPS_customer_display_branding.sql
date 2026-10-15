-- 20260930b_OPS_customer_display_branding.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 column and 1 check to device_profiles. No data changes.           #
-- #  Takes a moment; outside service is best, as always.                      #
-- ############################################################################
--
-- WHY (Peter, 30 Sep 2026: "The customer branding for the kiosk and the customer display should
-- be separate, not sure why it would be the same")
--   The customer display showed the kiosk_brand_* values of its device profile, so changing the
--   kiosk's look changed the display's look too. The display now has its own branding, set in
--   Back Office, Device profiles, Customer display branding.
--
-- WHAT THIS FILE DOES
--   device_profiles.customer_display_brand  jsonb, null when not set:
--     { "name": "...", "color": "#rrggbb", "bgColor": "#rrggbb", "logoUrl": "https://..." }
--   device_profiles_customer_display_brand_shape  it must be an object and small (4 KB).
--
-- WHY A NEW COLUMN (and not inside customer_display_images)
--   Back Office builds from before this change stay on some tills for days (the stale WebView).
--   They treat every entry of customer_display_images as an image, so a branding entry there
--   showed as a broken tile and was wiped by any save from a stale tab. Old code never reads or
--   writes a column it does not know.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. The display shows the kiosk branding, Back Office says the
--   display branding needs a database update, and no save sends the column.
--   After: refresh Back Office, open a device profile, and the Customer display branding editor
--   shows. Nothing changes on any display until someone sets it there. A display picks up new
--   branding when it next loads (as it does for images today).
--
-- ONE NOTE FOR LATER
--   device_profile_public() in 20260907b_ops_rls_1_fences_and_rpcs.sql (not live on 30 Sep) is
--   the branding read planned for the display. If the display is moved onto it, add
--   'customer_display_brand', p.customer_display_brand to its jsonb_build_object.
--
-- Rollback: 20260930b_OPS_customer_display_branding_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null then
    raise exception 'This is not the Ops database (device_profiles is missing). Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast on a busy table instead of making till and kiosk reads queue behind this script.
set local lock_timeout = '3s';

alter table public.device_profiles add column if not exists customer_display_brand jsonb;

comment on column public.device_profiles.customer_display_brand is
  'Customer display branding, separate from the kiosk: {name, color, bgColor, logoUrl}. Null = not set, and the display shows the kiosk branding. Written only by Back Office Device profiles (src/lib/customerDisplayBrand.js).';

do $shape$
begin
  if not exists (select 1 from pg_constraint where conname = 'device_profiles_customer_display_brand_shape') then
    alter table public.device_profiles add constraint device_profiles_customer_display_brand_shape
      check (customer_display_brand is null
        or (jsonb_typeof(customer_display_brand) = 'object' and pg_column_size(customer_display_brand) <= 4096));
  end if;
end
$shape$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 1 and 1.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'device_profiles' and column_name = 'customer_display_brand') as column_added,
  (select count(*) from pg_constraint where conname = 'device_profiles_customer_display_brand_shape') as check_added;
