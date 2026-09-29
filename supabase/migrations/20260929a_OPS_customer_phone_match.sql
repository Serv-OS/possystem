-- 20260929a_OPS_customer_phone_match.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Replaces 2 functions and adds 2. No table, policy or row changes.        #
-- #  Takes a moment; outside service is best, as always.                      #
-- ############################################################################
--
-- WHAT WAS WRONG (29 Sep 2026, Peter: "I just placed an order online and its registered me again
-- as a customer")
--   An online or QR order finds its customer with attribute_public_order, and a till finds one
--   with customer_by_phone. Both compared only the DIGITS of the phone. The member was imported as
--   '+447931129015' (digits 447931129015); the order sent '07931129015' (digits 07931129015). They
--   never met, so a second customer was made (order QR-N2IYX, Coffee Boy Huddersfield, 11:35 UTC;
--   the same on 20 Sep with OL-0NWKJ at Provo). About 6,700 Coffee Boy members are stored as +44
--   and every one of them would have been made twice on a first online or QR order.
--
-- WHAT THIS FILE DOES
--   1. public.phone_region_from_currency(text)   GBP is 'GB', USD is 'US', anything else ''.
--   2. public.phone_match_key(text, text)        THE phone match key, the SQL twin of
--      supabase/functions/_shared/phoneKey.js (the till and the edge functions). '07931 129015',
--      '07931129015', '(0)7931 129015', '+447931129015', '0044 7931 129015' and
--      '+44 (0) 7931 129015' are all '+447931129015'; in a US venue '+1 650 555 1234',
--      '6505551234' and '(650) 555-1234' are all '+16505551234'. A number it cannot read is its
--      digits (with its + or 00 when it was typed so), exactly as before, so two different numbers
--      are never made one. The venue's region is its locations.currency. The key of a key is the
--      key.
--   3. A self test: the key of every fixture in phoneKey.fixtures.json, and the key of that key.
--      One wrong answer stops the file and NOTHING changes. src/lib/phoneKey.test.js checks this
--      list IS that file, and runs the node twin over it, so the two cannot drift apart.
--   4. customer_by_phone and attribute_public_order again, exactly as 20260921_OPS_customers_fence
--      wrote them (and as they are live today) except the phone lines:
--        a number we read (the key is E.164):
--          found by  the key, OR a row an older build stored without a + that reads as the same
--                    number: '07931129015', '447931129015' or '01172273489' in a UK venue, a
--                    number written with 00 anywhere. Never a stored 10 digit number read as
--                    American (a UK number stored without its 0 looks the same), and never
--                    another number that only shares the digits ('3235550147' is not +32 3 555
--                    0147).
--        a number we cannot read: its digits, exactly as before.
--        when two rows match, the one stored as the key wins, then the oldest.
--        stored as the key (E.164 when readable), phone_raw as typed (trimmed, 40 characters).
--      The node read (supabase/functions/_shared/phoneKey.js phoneLookupValues) finds the same
--      rows. Same arguments, same answers, same grants.
--
-- WHAT IT DOES NOT DO
--   No row is rewritten. The 7 older UK rows stored without a + (5 imported landlines and 2
--   duplicates) are found through the key anyway; the 2 that are not whole UK numbers (8 and 12
--   digits) are found by their digits, as before. Checked read only on 29 Sep 2026: every other
--   customer phone is already a + number, so the stricter rules above lose no row found today.
--   The 2 duplicate pairs made by this bug (Peter's own number, at Coffee Boy and at POSUP Test)
--   stay as they are: merge each in Back Office, Customers, Merge (the lookups already pick the
--   member, the older +44 row).
--
-- ORDER
--   Any time. The app release that carries phoneKey.js may go before or after: a till keeps
--   calling the same two functions with the same arguments.
--
-- SAFETY
--   Bare statements, no begin or commit: the SQL editor runs the whole paste as ONE transaction,
--   so any error means NOTHING changed and you can simply run it again. Every statement can run
--   twice (create or replace). 3 second lock wait. The guard stops before anything if this is not
--   the Ops database.
--
-- ROLLBACK: 20260929a_OPS_customer_phone_match_ROLLBACK.sql (puts back today's two functions
-- word for word, then drops the two new ones).
--
-- VERIFY AFTER RUNNING (read only, paste each):
--   V1. The key. Expect +447931129015, +447931129015, +447931129015, +16505551234, 6505551234.
--     select public.phone_match_key('07931 129015', 'GB'), public.phone_match_key('0044 7931 129015', ''),
--            public.phone_match_key('(0)7931 129015', 'GB'),
--            public.phone_match_key('(650) 555-1234', 'US'), public.phone_match_key('(650) 555-1234', 'GB');
--   V2. Peter's number. Expect 4 rows, 2 per organisation (the member and this bug's duplicate),
--       and found true on the member only: source import at Coffee Boy, source wifi at POSUP Test.
--     select c.org_id, c.id, c.phone, c.source, c.created_at,
--            row_number() over (partition by c.org_id
--                               order by (c.phone = '+447931129015') desc, c.created_at, c.id) = 1 as found
--       from public.customers c
--      where c.deleted_at is null and public.phone_match_key(c.phone, 'GB') = '+447931129015'
--      order by c.org_id, found desc;
--   V3. The functions (4 rows; the two new ones immutable).
--     select p.oid::regprocedure, p.provolatile, p.prosecdef from pg_proc p
--      where p.pronamespace = 'public'::regnamespace
--        and p.proname in ('phone_match_key', 'phone_region_from_currency', 'customer_by_phone', 'attribute_public_order');

-- ============================================================================
-- 0. Guards
-- ============================================================================

do $guard$
begin
  if current_setting('server_version_num')::int < 140000 then
    raise exception 'Postgres 14 or newer is needed. Nothing was changed.';
  end if;
  if to_regclass('public.customers') is null
     or to_regclass('public.customer_locations') is null
     or to_regclass('public.customer_orders') is null
     or to_regclass('public.order_queue') is null then
    raise exception 'This is not the Ops database (customers tables are missing). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'locations' and column_name = 'currency') then
    raise exception 'public.locations has no currency column (is this the Ops database?). Nothing was changed.';
  end if;
  if to_regprocedure('public.pos_can_access(text)') is null
     or to_regprocedure('public._order_track_ok(text, text, text)') is null then
    raise exception 'The database fence (20260919a1 and a2) has not run. Run it first. Nothing was changed.';
  end if;
  if to_regprocedure('public.customer_by_phone(text, text)') is null
     or to_regprocedure('public.attribute_public_order(text, text, text, jsonb, jsonb)') is null then
    raise exception '20260921_OPS_customers_fence has not run (its two functions are missing). Run it first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. The venue's phone region
-- ============================================================================

create or replace function public.phone_region_from_currency(p_currency text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $fn$
  select case upper(btrim(coalesce(p_currency, '')))
           when 'GBP' then 'GB'
           when 'USD' then 'US'
           else ''
         end
$fn$;
revoke all on function public.phone_region_from_currency(text) from public;
grant execute on function public.phone_region_from_currency(text) to anon, authenticated, service_role;

-- ============================================================================
-- 2. The phone match key (rule for rule supabase/functions/_shared/phoneKey.js phoneMatchKey)
--
-- [0-9] and [ \t], never \d or \s, so the answer is the same under any locale and the same as the
-- node twin. UK number (NSN): [1235789] and 9 digits, or [18] and 8. North American: [2-9]xx
-- [2-9]xx xxxx.
-- ============================================================================

create or replace function public.phone_match_key(p_raw text, p_region text default '')
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog
as $fn$
declare
  v_all    text;
  v_s      text;
  v_digits text;
  v_d      text;
  v_lead   boolean;
  v_intl   boolean;
  v_plus   boolean;
  v_typed  boolean;
  v_r      text := upper(btrim(coalesce(p_region, '')));
  v_m      text[];
begin
  if p_raw is null then
    return null;
  end if;
  -- 1. fewer than 7 digits is no number (the digits are also the answer we fall back to)
  v_all := regexp_replace(p_raw, '[^0-9]', '', 'g');
  if length(v_all) < 7 then
    return null;
  end if;
  -- 2. '+44 (0) 7931 ...', '+33 (0)1 ...': a (0) after a country code is not part of the number.
  --    Only then: '(0)7931 129015' is a UK number written with its own 0.
  v_s := regexp_replace(p_raw, '\([ \t]*0[ \t]*\)', '', 'g');
  v_lead := v_s ~ '^[^0-9+]*\+';
  v_digits := regexp_replace(v_s, '[^0-9]', '', 'g');
  v_intl := v_lead or v_digits like '00%' or (v_r = 'US' and v_digits like '011%');
  v_d := case when v_intl then v_digits else v_all end;
  -- 3. a + straight before a 0 is no country code; 00 anywhere, and 011 in a US venue, are the +
  v_plus := v_lead and v_d !~ '^0';
  v_typed := v_plus;
  if not v_plus and v_d like '00%' then
    v_plus := true;
    v_d := substr(v_d, 3);
  elsif not v_plus and v_r = 'US' and v_d like '011%' then
    v_plus := true;
    v_d := substr(v_d, 4);
  end if;
  if v_plus then
    -- 4. a number with its country code reads the same in every venue
    if v_d like '44%' then
      v_m := regexp_match(v_d, '^440?((?:[1235789][0-9]{9}|[18][0-9]{8}))$');
      if v_m is not null then
        return '+44' || v_m[1];
      end if;
    elsif v_d like '1%' then
      if v_d ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' then
        return '+' || v_d;
      end if;
    elsif v_d ~ '^[1-9][0-9]{6,14}$' then
      return '+' || v_d;
    end if;
    -- a country code we cannot read keeps its + (or 00), as the till stored it, so it is never
    -- read again as a number of the venue's own country
    if length(v_d) >= 7 then
      return case when v_typed then '+' else '00' end || v_d;
    end if;
  elsif v_r = 'GB' then
    -- 5. a UK venue reads a UK number without its country code
    v_m := regexp_match(v_d, '^0((?:[1235789][0-9]{9}|[18][0-9]{8}))$');
    if v_m is not null then
      return '+44' || v_m[1];
    end if;
    if v_d ~ '^44(?:[1235789][0-9]{9}|[18][0-9]{8})$' then
      return '+' || v_d;
    end if;
  elsif v_r = 'US' then
    -- 6. a US venue reads a whole North American number, with or without the 1
    v_m := regexp_match(v_d, '^1?([2-9][0-9]{2}[2-9][0-9]{6})$');
    if v_m is not null then
      return '+1' || v_m[1];
    end if;
  end if;
  -- 7. anything else: its digits, exactly as the database matched before. When a (0) was taken
  --    out and the rest still could not be read, the digits are read once more as written, so
  --    the key of the key is always the key.
  if v_intl and v_digits <> v_all then
    return public.phone_match_key(v_all, p_region);
  end if;
  return v_all;
end
$fn$;
revoke all on function public.phone_match_key(text, text) from public;
grant execute on function public.phone_match_key(text, text) to anon, authenticated, service_role;

-- ============================================================================
-- 3. Self test. One wrong key stops the file and nothing changes.
--    The list between the two FIXTURES lines IS supabase/functions/_shared/phoneKey.fixtures.json
--    (src/lib/phoneKey.test.js reads both and fails when they differ).
-- ============================================================================

do $selftest$
declare
  v_bad text;
begin
  select string_agg(format('%L in %L gave %L (keyed again %L), expected %L', f.raw, f.region,
                           public.phone_match_key(f.raw, f.region), public.phone_match_key(f.want, f.region), f.want), '; ')
    into v_bad
    from (values
      -- PHONE KEY FIXTURES BEGIN
      ('07931 129015'::text, 'GB'::text, '+447931129015'::text),
      ('07931129015'::text, 'GB'::text, '+447931129015'::text),
      ('+447931129015'::text, 'GB'::text, '+447931129015'::text),
      ('0044 7931 129015'::text, 'GB'::text, '+447931129015'::text),
      ('+44 (0) 7931 129015'::text, 'GB'::text, '+447931129015'::text),
      ('+4407931129015'::text, 'GB'::text, '+447931129015'::text),
      ('447931129015'::text, 'GB'::text, '+447931129015'::text),
      ('(07931) 129-015'::text, 'GB'::text, '+447931129015'::text),
      ('+447931129015'::text, 'US'::text, '+447931129015'::text),
      ('0044 7931 129015'::text, 'US'::text, '+447931129015'::text),
      ('011 44 7931 129015'::text, 'US'::text, '+447931129015'::text),
      ('011 44 7931 129015'::text, 'GB'::text, '011447931129015'::text),
      ('0117 227 3489'::text, 'GB'::text, '+441172273489'::text),
      ('020 1481 2891'::text, 'GB'::text, '+442014812891'::text),
      ('01128065044'::text, 'GB'::text, '+441128065044'::text),
      ('+1 650 555 1234'::text, 'US'::text, '+16505551234'::text),
      ('6505551234'::text, 'US'::text, '+16505551234'::text),
      ('(650) 555-1234'::text, 'US'::text, '+16505551234'::text),
      ('1-650-555-1234'::text, 'US'::text, '+16505551234'::text),
      ('+1 (650) 555-1234'::text, 'GB'::text, '+16505551234'::text),
      ('6505551234'::text, 'GB'::text, '6505551234'::text),
      ('07931129015'::text, 'US'::text, '07931129015'::text),
      ('4405551234'::text, 'US'::text, '+14405551234'::text),
      ('4405551234'::text, 'GB'::text, '4405551234'::text),
      ('7931129015'::text, 'GB'::text, '7931129015'::text),
      ('07070707'::text, 'GB'::text, '07070707'::text),
      ('079152518916'::text, 'GB'::text, '079152518916'::text),
      ('4407931129015'::text, 'GB'::text, '4407931129015'::text),
      ('+44 123'::text, 'GB'::text, null::text),
      ('123456'::text, 'GB'::text, null::text),
      (''::text, 'GB'::text, null::text),
      (null::text, 'GB'::text, null::text),
      ('+353768887706'::text, 'GB'::text, '+353768887706'::text),
      ('+33123456789'::text, 'GB'::text, '+33123456789'::text),
      ('+33 1 23 45 67 89'::text, 'US'::text, '+33123456789'::text),
      ('07931129015'::text, ''::text, '07931129015'::text),
      ('+447931129015'::text, ''::text, '+447931129015'::text),
      ('0044 7931 129015'::text, ''::text, '+447931129015'::text),
      ('6505551234'::text, ''::text, '6505551234'::text),
      ('+1 555 1234'::text, 'US'::text, '+15551234'::text),
      ('+44 7931 12901'::text, 'GB'::text, '+44793112901'::text),
      ('Tel: +44 7931 129015'::text, 'GB'::text, '+447931129015'::text),
      ('07931 129015 ext 12'::text, 'GB'::text, '0793112901512'::text),
      (' +447931129015'::text, 'GB'::text, '+447931129015'::text),
      ('+0447931129015'::text, 'GB'::text, '0447931129015'::text),
      ('016977 2345'::text, 'GB'::text, '+44169772345'::text),
      ('0800 1111'::text, 'GB'::text, '08001111'::text),
      ('0800 123456'::text, 'GB'::text, '+44800123456'::text),
      ('+44 1 2345 6789'::text, 'GB'::text, '+44123456789'::text),
      ('0712345678'::text, 'GB'::text, '0712345678'::text),
      ('+1 055 555 1234'::text, 'US'::text, '+10555551234'::text),
      ('+44 20 1481 2891'::text, 'US'::text, '+442014812891'::text),
      ('07931129015'::text, 'gb'::text, '+447931129015'::text),
      ('07931129015'::text, 'FR'::text, '07931129015'::text),
      ('+44(0)7931129015'::text, 'GB'::text, '+447931129015'::text),
      ('+44 7931 129015'::text, 'US'::text, '+447931129015'::text),
      ('00 1 650 555 1234'::text, 'GB'::text, '+16505551234'::text),
      ('+1 650 555 1234'::text, ''::text, '+16505551234'::text),
      ('16505551234'::text, 'US'::text, '+16505551234'::text),
      ('16505551234'::text, 'GB'::text, '16505551234'::text),
      ('2014812891'::text, 'US'::text, '+12014812891'::text),
      ('2014812891'::text, 'GB'::text, '2014812891'::text),
      ('440 555 1234'::text, 'US'::text, '+14405551234'::text),
      ('1234567'::text, 'GB'::text, '1234567'::text),
      ('+1234567'::text, 'GB'::text, '+1234567'::text),
      ('+3531234567'::text, 'US'::text, '+3531234567'::text),
      ('07931-129-015'::text, 'GB'::text, '+447931129015'::text),
      ('O7931 129015'::text, 'GB'::text, '7931129015'::text),
      ('(0)7931 129015'::text, 'GB'::text, '+447931129015'::text),
      ('(0) 20 1481 2891'::text, 'GB'::text, '+442014812891'::text),
      ('(0)7931 129015'::text, 'US'::text, '07931129015'::text),
      ('+07931129015'::text, 'GB'::text, '+447931129015'::text),
      ('+0044 7931 129015'::text, ''::text, '+447931129015'::text),
      ('+33 (0)1 23 45 67 89'::text, 'GB'::text, '+33123456789'::text),
      ('0033 (0)1 23 45 67 89'::text, 'US'::text, '+33123456789'::text),
      ('011 44 (0) 7931 129015'::text, 'US'::text, '+447931129015'::text),
      ('+44 3887 9681'::text, 'US'::text, '+4438879681'::text),
      ('0044 3887 9681'::text, 'GB'::text, '004438879681'::text),
      ('011 44 3887 9681'::text, 'US'::text, '004438879681'::text),
      ('0112(0)59633'::text, 'US'::text, '+2059633'::text),
      ('07931 129015 ext 123456'::text, 'GB'::text, '07931129015123456'::text)
      -- PHONE KEY FIXTURES END
    ) as f(raw, region, want)
   where public.phone_match_key(f.raw, f.region) is distinct from f.want
      -- the key of the key is the key (the till keys a number, the database keys it again)
      or public.phone_match_key(f.want, f.region) is distinct from f.want;
  if v_bad is not null then
    raise exception 'phone_match_key self test failed: %. Nothing was changed.', v_bad;
  end if;
  if public.phone_region_from_currency('gbp') <> 'GB' or public.phone_region_from_currency('USD') <> 'US'
     or public.phone_region_from_currency('EUR') <> '' or public.phone_region_from_currency(null) <> '' then
    raise exception 'phone_region_from_currency self test failed. Nothing was changed.';
  end if;
end
$selftest$;

-- ============================================================================
-- 4. The till's look up, by the key (20260921_OPS_customers_fence.sql section 2, phone lines only)
-- ============================================================================

create or replace function public.customer_by_phone(p_location_id text, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org      uuid;
  v_region   text;
  v_read     text;
  v_key      text;
  v_readable boolean;
  v_digits   text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_row      public.customers%rowtype;
begin
  if coalesce(p_location_id, '') = '' or length(v_digits) < 7 then
    return null;
  end if;
  -- the caller must reach THIS venue: a login linked to it, or a device bound to it
  if not public.pos_can_access(p_location_id) then
    return null;
  end if;
  select l.org_id, public.phone_region_from_currency(l.currency) into v_org, v_region
    from public.locations l where l.id::text = p_location_id;
  if v_org is null then
    return null;
  end if;
  -- 29 Sep 2026: by the phone match key, not the digits alone ('07931129015' IS '+447931129015').
  -- The till sends its own key of the number; keying it again gives the same key.
  v_key := public.phone_match_key(p_phone, v_region);
  v_readable := v_key ~ '^\+(?:44(?:[1235789][0-9]{9}|[18][0-9]{8})|1[2-9][0-9]{2}[2-9][0-9]{6}|(?!44|1)[1-9][0-9]{6,14})$';
  -- a row an older build stored without a + is read as a stored number: the UK reading in a UK
  -- venue only (a UK number stored without its 0 looks like a US one), 00 everywhere
  v_read := case when v_region = 'GB' then 'GB' else '' end;
  select * into v_row
    from public.customers c
   where c.org_id = v_org
     and c.deleted_at is null
     and (c.phone = v_key
          or (v_readable and c.phone !~ '^\+' and public.phone_match_key(c.phone, v_read) = v_key)
          -- a number we cannot read: its digits, exactly as before
          or (not v_readable and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = v_digits))
   order by (c.phone is not distinct from v_key) desc, c.created_at, c.id
   limit 1;
  if v_row.id is null then
    return null;
  end if;
  -- only what the till screen shows: never the notes, the tags or the stored payment method
  return jsonb_build_object(
    'id', v_row.id,
    'name', coalesce(v_row.name, ''),
    'email', v_row.email,
    'marketing_opt_in', coalesce(v_row.marketing_opt_in, false)
  );
end
$fn$;
revoke all on function public.customer_by_phone(text, text) from public, anon, authenticated;
grant execute on function public.customer_by_phone(text, text) to authenticated, service_role;

-- ============================================================================
-- 5. An online or QR order attaches itself (20260921_OPS_customers_fence.sql section 3, phone
--    lines only). The bug Peter hit.
-- ============================================================================

create or replace function public.attribute_public_order(
  p_location_id text,
  p_ref         text,
  p_key         text,
  p_customer    jsonb,
  p_order       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org       uuid;
  v_digits    text := regexp_replace(coalesce(p_customer ->> 'phone', ''), '[^0-9]', '', 'g');
  v_region    text;
  v_read      text;
  v_phone     text;
  v_readable  boolean;
  v_name      text := btrim(coalesce(p_customer ->> 'name', ''));
  v_email     text := nullif(btrim(coalesce(p_customer ->> 'email', '')), '');
  v_opt_in    boolean := coalesce((p_customer ->> 'marketing_opt_in')::boolean, false);
  v_cust      uuid;
  v_created   boolean := false;
  v_existing  public.customers%rowtype;
  v_total     numeric := coalesce((p_order ->> 'total')::numeric, 0);
  v_items     jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_channel   text := coalesce(nullif(btrim(coalesce(p_order ->> 'channel', '')), ''), 'online');
  v_loc_uuid  uuid;
  v_visits    int;
  v_revenue   numeric;
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_ref, '') = '' or length(v_digits) < 7 then
    return jsonb_build_object('ok', false, 'reason', 'not_enough');
  end if;
  -- the caller must hold this order's key, or be the venue itself
  if not (public._order_track_ok(p_location_id, p_ref, p_key) or public.pos_can_access(p_location_id)) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  -- the order must really exist at this venue
  if not exists (select 1 from public.order_queue q
                  where q.location_id = p_location_id and q.ref = p_ref) then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;
  select l.org_id, l.id, public.phone_region_from_currency(l.currency) into v_org, v_loc_uuid, v_region
    from public.locations l where l.id::text = p_location_id;
  if v_org is null then
    return jsonb_build_object('ok', false, 'reason', 'no_venue');
  end if;
  -- 29 Sep 2026: the phone match key of the venue ('07931129015' in a UK venue IS '+447931129015')
  v_phone := public.phone_match_key(p_customer ->> 'phone', v_region);
  v_readable := v_phone ~ '^\+(?:44(?:[1235789][0-9]{9}|[18][0-9]{8})|1[2-9][0-9]{2}[2-9][0-9]{6}|(?!44|1)[1-9][0-9]{6,14})$';
  v_read := case when v_region = 'GB' then 'GB' else '' end;

  -- 1. the customer: fill blanks only, never overwrite what the venue curated. Found by the key,
  --    or (a number we read) by a row an older build stored without a +, read as a stored number
  --    (the UK reading in a UK venue only: a UK number stored without its 0 looks like a US one),
  --    or (a number we cannot read) by its digits as before; the row stored as the key wins,
  --    then the oldest (the member, not a duplicate).
  select * into v_existing
    from public.customers c
   where c.org_id = v_org
     and c.deleted_at is null
     and (c.phone = v_phone
          or (v_readable and c.phone !~ '^\+' and public.phone_match_key(c.phone, v_read) = v_phone)
          or (not v_readable and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = v_digits))
   order by (c.phone is not distinct from v_phone) desc, c.created_at, c.id
   limit 1;

  if v_existing.id is not null then
    v_cust := v_existing.id;
    update public.customers
       set name             = case when coalesce(btrim(name), '') = '' and v_name <> '' then v_name else name end,
           email            = coalesce(email, v_email),
           marketing_opt_in = case when coalesce(marketing_opt_in, false) then true else v_opt_in end,
           updated_at       = now()
     where id = v_cust;
  else
    -- customers.name is NOT NULL with no default (17 Sep 2026): an empty name, never null
    insert into public.customers (org_id, phone, phone_raw, name, email, marketing_opt_in, source)
    values (v_org, v_phone,
            coalesce(nullif(left(btrim(coalesce(p_customer ->> 'phone', '')), 40), ''), v_phone),
            v_name, v_email, v_opt_in,
            coalesce(nullif(btrim(coalesce(p_customer ->> 'source', '')), ''), v_channel))
    returning id into v_cust;
    v_created := true;
  end if;

  if v_cust is null then
    return jsonb_build_object('ok', false, 'reason', 'no_customer');
  end if;

  -- 2. the venue stats
  select cl.visit_count, cl.lifetime_revenue into v_visits, v_revenue
    from public.customer_locations cl
   where cl.customer_id = v_cust and cl.location_id = v_loc_uuid;

  if found then
    update public.customer_locations
       set visit_count      = coalesce(v_visits, 0) + 1,
           lifetime_revenue = coalesce(v_revenue, 0) + v_total,
           last_visit_at    = now()
     where customer_id = v_cust and location_id = v_loc_uuid;
  else
    insert into public.customer_locations (customer_id, location_id, first_visit_at, last_visit_at, visit_count, lifetime_revenue)
    values (v_cust, v_loc_uuid, now(), now(), 1, v_total)
    on conflict do nothing;
  end if;

  -- 3. the order row, once per ref
  if not exists (select 1 from public.customer_orders co
                  where co.customer_id = v_cust
                    and co.location_id = v_loc_uuid
                    and co.closed_check_id = p_ref) then
    insert into public.customer_orders (customer_id, location_id, closed_check_id, ordered_at, total, channel, item_summary)
    values (v_cust, v_loc_uuid, p_ref, now(), v_total, v_channel,
            (select coalesce(jsonb_agg(jsonb_build_object('name', i ->> 'name', 'qty', i -> 'qty', 'price', i -> 'price')), '[]'::jsonb)
               from jsonb_array_elements(v_items) i));
  end if;

  return jsonb_build_object('ok', true, 'customer_id', v_cust, 'created', v_created);
end
$fn$;
revoke all on function public.attribute_public_order(text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.attribute_public_order(text, text, text, jsonb, jsonb) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
