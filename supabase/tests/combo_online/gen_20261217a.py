#!/usr/bin/env python3
"""gen_20261217a.py: makes SQL 20261217a (5.12.125, Combos on the online page and the catering link).

  python3 supabase/tests/combo_online/gen_20261217a.py

The server values every line of a public order itself (public._public_order_value): a line is
worth at least its menu price. A Combo's picks are 0.00, or their step's price bump, or their own
price where the step keeps prices (src/lib/combo.js), so without this file a paid Combo order
from the online page or the catering link would come out "Payment short" with no kitchen ticket.

This script takes the function exactly as the Ops database has it. The repo copy in
20261020a_OPS_channel_parity_2.sql IS the live body: md5 db3790dba28aaef13a346a11d0a59a36, read
read only from Ops on 27 Nov 2026 (supabase/tests/combo_online/README.md). It swaps exact pieces
of text (each must be there exactly once), and writes:
  supabase/migrations/20261217a_OPS_public_order_combo_steps.sql            the change
  supabase/migrations/20261217a_OPS_public_order_combo_steps_ROLLBACK.sql   the live body back
The forward file refuses unless the live body is the one read (or this file's own result, so a
second run is safe). The rig (supabase/tests/combo_online/run.mjs) rehearses both.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SRC = os.path.join(REPO, 'supabase', 'migrations', '20261020a_OPS_channel_parity_2.sql')
OUT = os.path.join(REPO, 'supabase', 'migrations', '20261217a_OPS_public_order_combo_steps.sql')
BACK = os.path.join(REPO, 'supabase', 'migrations', '20261217a_OPS_public_order_combo_steps_ROLLBACK.sql')
LIVE_MD5 = 'db3790dba28aaef13a346a11d0a59a36'
SIG = 'public._public_order_value(text, text, text, jsonb, text)'

src = open(SRC, encoding='utf-8').read()
start = src.index('CREATE OR REPLACE FUNCTION public._public_order_value(')
body_at = src.index('AS $function$', start) + len('AS $function$')
body_end = src.index('$function$;', body_at)
HEAD = src[start:body_at]
LIVE = src[body_at:body_end]
if hashlib.md5(LIVE.encode()).hexdigest() != LIVE_MD5:
    sys.exit('20261020a no longer holds the body read on live: read it again from Ops.')

SWAPS = [
# 1. The new variables.
("""  v_r_menu   text;
begin
""", """  v_r_menu   text;
  -- 20261217a (5.12.125, Combos on the online page and the catering link): the Combos of this
  -- order (comboId -> where its line is, its steps, its quantity), what each step has used so
  -- far, and what this line is.
  v_combos   jsonb := '{}'::jsonb;
  v_cused    jsonb := '{}'::jsonb;
  v_crow     public.menu_items%rowtype;
  v_cid      text;
  v_cpos     integer;
  v_cpick    boolean;
  v_step     jsonb;
  v_entry    jsonb;
  v_eid      text;
  v_kind     text;
  v_cmax     integer;
  v_cq       integer;
  v_ckey     text;
  v_nsteps   jsonb;
  v_sids     text[];
  v_sid      text;
  v_k        integer;
  v_m        integer;
begin
"""),
# 2. Find the real Combos of the order, before any line is valued.
("""  for it in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) x loop
    if jsonb_typeof(it) is distinct from 'object' then
""", """  -- 20261217a (5.12.125): THE COMBOS ON THIS ORDER. A Combo is one line at the set price
  -- (comboRole 'parent', never sent to the kitchen) and one line per pick (comboRole 'pick'),
  -- every line of it sharing one comboId: the POS's own model since 5.12.123 (src/lib/combo.js).
  -- The server takes none of that from the page. A Combo counts only when its line is a product
  -- of this venue of type combo with steps (menu_items.combo, 20261215a), the first line naming
  -- that comboId; its picks are read against ITS steps below.
  for it, v_cpos in select x, (n - 1)::integer
                      from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality as t(x, n) loop
    continue when jsonb_typeof(it) is distinct from 'object' or coalesce(it ->> 'comboRole', '') <> 'parent';
    v_cid := nullif(left(btrim(coalesce(it ->> 'comboId', '')), 80), '');
    continue when v_cid is null or v_combos ? v_cid;
    v_crow := null;
    select * into v_crow from public.menu_items m
     where m.id = nullif(btrim(coalesce(it ->> 'itemId', it ->> 'item_id', '')), '') and m.location_id = p_loc;
    continue when v_crow.id is null or coalesce(v_crow.type, '') <> 'combo' or coalesce(v_crow.archived, false)
               or jsonb_typeof(v_crow.combo -> 'steps') is distinct from 'array'
               or jsonb_array_length(v_crow.combo -> 'steps') = 0;
    -- Each step's id as the app reads it (src/lib/combo.js comboStepsOf): its own id, else
    -- step-N for the Nth step, and a second step with the same id gets -2, -3 (a row written by
    -- hand; the Back Office and the Multi site menu always save them this way).
    v_nsteps := '[]'::jsonb;
    v_sids := '{}'::text[];
    v_k := 0;
    for v_step in select x from jsonb_array_elements(v_crow.combo -> 'steps') x loop
      continue when jsonb_typeof(v_step) is distinct from 'object';
      v_k := v_k + 1;
      v_sid := coalesce(nullif(btrim(coalesce(v_step ->> 'id', '')), ''), 'step-' || v_k);
      v_ckey := v_sid;
      v_m := 2;
      while v_sid = any(v_sids) loop
        v_sid := v_ckey || '-' || v_m;
        v_m := v_m + 1;
      end loop;
      v_sids := v_sids || v_sid;
      v_nsteps := v_nsteps || jsonb_build_array(v_step || jsonb_build_object('id', v_sid));
    end loop;
    continue when jsonb_array_length(v_nsteps) = 0;
    v_q := public._fence_num(it ->> 'qty');
    v_combos := v_combos || jsonb_build_object(v_cid, jsonb_build_object(
                  'at', v_cpos, 'steps', v_nsteps,
                  'qty', case when v_q >= 1 then least(999, ceil(v_q))::integer else 1 end));
  end loop;

  for it in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) x loop
    if jsonb_typeof(it) is distinct from 'object' then
"""),
# 3. Is this line a pick of one of them? Its step decides its floor.
("""    end if;
    v_item := round(public._fence_num(it ->> 'price') * 100)::bigint;
""", """    end if;
    -- 20261217a (5.12.125): IS THIS LINE A PICK OF A COMBO ON THIS ORDER? Its step (comboStepId)
    -- must list the row, or the product a size belongs to, and have room left: the step's most
    -- (99 = no limit) times the Combo's quantity, and one product only once per Combo where the
    -- step takes each product once. A real pick is valued by its step: its price bump (0.00 when
    -- it has none) where the step is part of the set price, so a product with no price of its own
    -- is fine there; its own menu price where the step keeps prices, as any line. Its own options
    -- are valued below as every line's are.
    v_cpick := false;
    v_cid := nullif(left(btrim(coalesce(it ->> 'comboId', '')), 80), '');
    if v_cid is not null and coalesce(it ->> 'comboRole', '') = 'pick' and v_sell and v_combos ? v_cid then
      select s into v_step from jsonb_array_elements(v_combos -> v_cid -> 'steps') s
       where jsonb_typeof(s) = 'object' and coalesce(s ->> 'id', '') <> '' and s ->> 'id' = coalesce(it ->> 'comboStepId', '')
       limit 1;
      v_entry := null;
      if v_step is not null then
        -- The entry the guest tapped (comboEntryId) when the step lists it for this row (a step may
        -- list a product and one of its sizes on their own); else the row itself, else its product,
        -- the first listed (src/lib/combo.js keeps the first of a product listed twice).
        select t.e into v_entry
          from jsonb_array_elements(case when jsonb_typeof(v_step -> 'products') = 'array' then v_step -> 'products' else '[]'::jsonb end) with ordinality as t(e, n)
         where (case when jsonb_typeof(t.e) = 'object' then btrim(coalesce(t.e ->> 'itemId', t.e ->> 'item_id', t.e ->> 'id', ''))
                     when jsonb_typeof(t.e) in ('string', 'number') then btrim(t.e #>> '{}') end) in (r.id, coalesce(r.parent_id, r.id))
         order by (case when jsonb_typeof(t.e) = 'object' then btrim(coalesce(t.e ->> 'itemId', t.e ->> 'item_id', t.e ->> 'id', ''))
                        when jsonb_typeof(t.e) in ('string', 'number') then btrim(t.e #>> '{}') end) = btrim(coalesce(it ->> 'comboEntryId', '')) desc,
                  (case when jsonb_typeof(t.e) = 'object' then btrim(coalesce(t.e ->> 'itemId', t.e ->> 'item_id', t.e ->> 'id', ''))
                        when jsonb_typeof(t.e) in ('string', 'number') then btrim(t.e #>> '{}') end) = r.id desc,
                  t.n
         limit 1;
      end if;
      if v_entry is not null then
        v_eid := case when jsonb_typeof(v_entry) = 'object' then btrim(coalesce(v_entry ->> 'itemId', v_entry ->> 'item_id', v_entry ->> 'id', ''))
                      else btrim(v_entry #>> '{}') end;
        -- The step's rule, read as src/lib/combo.js normaliseStep reads it.
        v_kind := coalesce(nullif(v_step ->> 'selectionType', ''), nullif(v_step ->> 'selection_type', ''), 'single');
        if v_kind not in ('single', 'multiple', 'multiple_once', 'quantity') then
          v_kind := 'single';
        end if;
        v_cmax := least(99999, greatest(0, round(public._fence_num(v_step ->> 'max'))))::integer;
        if v_kind = 'single' then
          v_cmax := 1;
        elsif v_kind = 'quantity' then
          v_cmax := least(98, greatest(1, coalesce(nullif(v_cmax, 0),
                      nullif(least(99999, greatest(0, round(public._fence_num(v_step ->> 'min'))))::integer, 0), 1)));
        elsif v_cmax >= 99 then
          v_cmax := 99;
        else
          v_cmax := least(98, greatest(1, v_cmax));
        end if;
        v_cq := case when public._fence_num(it ->> 'qty') >= 1 then least(999, ceil(public._fence_num(it ->> 'qty')))::integer else 1 end;
        v_ckey := v_cid || '|' || (v_step ->> 'id');
        if (v_cmax >= 99 or coalesce((v_cused ->> v_ckey)::integer, 0) + v_cq <= v_cmax * (v_combos -> v_cid ->> 'qty')::integer)
           and (v_kind in ('multiple', 'quantity')
                or coalesce((v_cused ->> (v_ckey || '|' || v_eid))::integer, 0) + v_cq <= (v_combos -> v_cid ->> 'qty')::integer) then
          v_cpick := true;
          v_cused := v_cused || jsonb_build_object(v_ckey, coalesce((v_cused ->> v_ckey)::integer, 0) + v_cq,
                                                   v_ckey || '|' || v_eid, coalesce((v_cused ->> (v_ckey || '|' || v_eid))::integer, 0) + v_cq);
          if coalesce(v_step ->> 'pricing', '') <> 'own' then
            v_floor := least(100000000, greatest(0, round(public._fence_num(case when jsonb_typeof(v_entry) = 'object' then v_entry ->> 'bump' end) * 100)))::bigint;
            v_noprice := false;
          end if;
        end if;
      end if;
    end if;
    -- A line that only SAYS it belongs to a Combo (no such Combo on this order, not in its steps,
    -- past its room, a second line claiming to be the Combo, or words that mean nothing) loses
    -- those words: it is priced, shown and counted as the line it is.
    if (it ? 'comboId' or it ? 'comboRole') and not v_cpick
       and not (coalesce(it ->> 'comboRole', '') = 'parent' and v_cid is not null and v_combos ? v_cid
                and (v_combos -> v_cid ->> 'at')::integer = jsonb_array_length(v_out)) then
      it := it - 'comboId' - 'comboRole' - 'comboName' - 'comboStepId' - 'comboStepName' - 'comboEntryId' - 'comboKeepsPrice' - 'comboBump';
    end if;
    v_item := round(public._fence_num(it ->> 'price') * 100)::bigint;
"""),
# 4. A pick is never the dearest line a reward is capped at.
("""    if v_sell and v_floor is not null then
      v_max_unit := greatest(v_max_unit, greatest(0, v_item));
    end if;
""", """    -- 20261217a: a pick is never the dearest line (the POS's rule: a pick is never the free item).
    if v_sell and v_floor is not null and not v_cpick then
      v_max_unit := greatest(v_max_unit, greatest(0, v_item));
    end if;
"""),
# 5. Nor does it take part in the automatic deals, a promo code's items or a free item reward.
("""      if v_sell and v_floor is not null then
        -- Only a line the storefront really sells, at the server's own price, takes part in
""", """      -- 20261217a (5.12.125): a pick of a Combo is part of the Combo. The Combo's own line takes
      -- part in deals, promo codes and rewards at its set price; its picks never do: the POS's
      -- rule for deals and a free item (lib/discountEngine.js, lib/combo.js linesForPromo). The
      -- online page and the catering link leave picks out of a promo code's lines too, so the
      -- page and this function always agree (the POS still counts what picks add there).
      if v_sell and v_floor is not null and not v_cpick then
        -- Only a line the storefront really sells, at the server's own price, takes part in
"""),
# 6. A real pick's own options may take its line below zero (the venue's own minus options).
("""    v_unit := greatest(0, v_item + v_modsum);
""", """    -- 20261217a (5.12.125): a real pick of a Combo is 0.00 or its bump, so the venue's own minus
    -- option ("No cheese, minus 0.50") can take its line below zero, as on the POS and the page
    -- (lib/combo.js pickPrice). Only options this function matched to the product, within their
    -- group's limits, can do that: one it cannot match never takes a penny off. Every other line
    -- is never below zero, as before.
    v_unit := case when v_cpick then v_item + v_modsum else greatest(0, v_item + v_modsum) end;
"""),
]

body = LIVE
for old, new in SWAPS:
    n = body.count(old)
    if n != 1:
        sys.exit(f'a swapped piece is there {n} times, not once:\n{old[:200]}')
    body = body.replace(old, new, 1)
NEW = body
NEW_MD5 = hashlib.md5(NEW.encode()).hexdigest()
for name, text in (('new body', NEW),):
    bad = [c for c in text if ord(c) > 127]
    if bad:
        sys.exit(f'{name}: not ASCII ({bad[:5]})')
# Every swap reverses: the live body comes back exactly.
back = NEW
for old, new in reversed(SWAPS):
    back = back.replace(new, old, 1)
assert back == LIVE, 'the swaps do not reverse to the live body'

GUARD = f"""-- Fail fast in the wrong database rather than creating a stray function there.
do $$
begin
  if to_regclass('public.menu_items') is null or to_regprocedure('{SIG}') is null then
    raise exception 'wrong database: public.menu_items or public._public_order_value is missing. This file is for the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;
"""

FWD = f"""-- 20261217a_OPS_public_order_combo_steps.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- OPS project ONLY. Peter runs this by hand in the SQL editor, BEFORE release 5.12.125.
-- Safe to run twice. It replaces ONE function and adds one small read only one.
-- Made by supabase/tests/combo_online/gen_20261217a.py; rehearsed by supabase/tests/combo_online/run.mjs.
--
-- ORDER FOR PETER
--   1. 20261215a_OPS_menu_item_combo_steps.sql (stage 1): RUN on 27 Nov 2026.
--   2. This file, on Ops (SQL editor). Read the check row at the end: every value true.
--   3. Then deploy the edge function catering-release (from release 5.12.125).
--   4. Then launch 5.12.125.
--   The pages show a Combo built from steps only once this file has run (they ask
--   public.public_order_features), so nothing breaks if the code lands first.
--
-- WHAT THIS IS
-- Combo products, stage 3 (Peter, 27 Nov 2026: YES to customers building a Combo on the
-- catering link and the online page, "this is just a combo product so yes is the answer thats
-- what we are building these features for").
--
-- The server values every line of a public order itself (public._public_order_value, called by
-- place_public_order, verify_public_order_payment and settle_qr_tab): a line is worth at least its
-- menu price. A Combo is one line at the set price plus one line per pick, and a pick is 0.00,
-- or its step's price bump, or its own price where the step keeps prices (src/lib/combo.js, the
-- POS's own model since 5.12.123). Without this file every pick would be valued at its full menu
-- price, so a guest who paid exactly what the page asked would land in "Payment short" with no
-- kitchen ticket.
--
-- WHAT CHANGES IN public._public_order_value (nothing else is replaced)
--   * Before any line is valued, the order's real Combos are found: a line with comboRole
--     'parent' whose product is this venue's, of type combo, with steps. The first line naming a
--     comboId is that Combo.
--   * A line with comboRole 'pick' counts as a pick only when its step of THAT Combo lists its
--     product (or the product its size belongs to) and the step has room left: its most picks (99
--     = no limit) times the Combo's quantity, and a product once per Combo where the step takes
--     each product once. Then:
--       part of the set price: worth its price bump (0.00 when it has none), never less; a
--                              product with no price of its own is fine here;
--       keeps its price:       worth its own menu price, as any line.
--     Its own options are valued as every line's are.
--   * A line that only says it belongs to a Combo loses the Combo words and is valued, shown and
--     counted as the line it is. So a doctored page can never take a product for less.
--   * A real pick is left out of the lines the automatic deals, promo codes and loyalty rewards
--     read, and is never the dearest line: the POS's rule (lib/discountEngine.js, linesForPromo).
--     The Combo's own line takes part at its set price, as on the POS.
--   * Everything else is the live function, byte for byte (the rollback puts it back exactly).
--
-- WHAT IT ADDS
--   public.public_order_features(): read only, {{"combo_steps": true}}. The online page and the
--   catering link ask it before they offer a Combo built from steps, so the pages and this file
--   can land in any order. The rollback drops it, and the pages hide Combos again.
--
-- WHAT DOES NOT CHANGE
--   No table, column, policy, trigger or other function. An order with no Combo is valued
--   exactly as today: every new line of the function only acts on a line that names a comboId.

-- Never sit behind a long running lock on a live venue.
set lock_timeout = '3s';
set client_min_messages = warning;

{GUARD}
begin;

-- Refuse unless 20261215a has run and the function is the one read on live (or this file's own
-- result: a second run is safe). Nothing has changed if this stops.
do $same$
declare
  v_md5 text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo') then
    raise exception 'Run 20261215a_OPS_menu_item_combo_steps.sql first (menu_items.combo). Nothing was changed.';
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = to_regprocedure('{SIG}');
  if v_md5 not in ('{LIVE_MD5}', '{NEW_MD5}') then
    raise exception '_public_order_value is not the body read on live on 27 Nov 2026 (md5 %). Read it again and rerun the generator. Nothing was changed.', v_md5;
  end if;
end $same$;

{HEAD}{NEW}$function$;

create or replace function public.public_order_features()
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $fn$
  -- What the public order functions know (5.12.125): a page offers a Combo built from steps only
  -- once the server values its picks (20261217a). Rolled back, this is gone and the pages hide
  -- Combos again.
  select jsonb_build_object('combo_steps', true)
$fn$;
revoke all on function public.public_order_features() from public;
grant execute on function public.public_order_features() to anon, authenticated, service_role;

do $done$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('{SIG}')) <> '{NEW_MD5}' then
    raise exception '_public_order_value is not the body this file makes. Nothing was changed.';
  end if;
end $done$;

commit;

-- The API learns the new function when it reloads its schema.
notify pgrst, 'reload schema';

-- The check: every value true.
select
  (select md5(p.prosrc) = '{NEW_MD5}' from pg_proc p where p.oid = to_regprocedure('{SIG}')) as pricer_knows_combos,
  (select public.public_order_features() ->> 'combo_steps' = 'true') as pages_can_offer_combos,
  has_function_privilege('anon', 'public.public_order_features()', 'execute') as guests_can_ask;
"""

RB = f"""-- 20261217a_OPS_public_order_combo_steps_ROLLBACK.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Puts public._public_order_value back exactly as live had it before 20261217a (md5
-- {LIVE_MD5}) and drops public.public_order_features. Safe to run twice.
-- The online page and the catering link then stop offering Combos built from steps (they ask
-- public_order_features first). An order already placed keeps the values it was given.
-- Made by supabase/tests/combo_online/gen_20261217a.py.

set lock_timeout = '3s';
set client_min_messages = warning;

{GUARD}
begin;

do $same$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = to_regprocedure('{SIG}');
  if v_md5 not in ('{NEW_MD5}', '{LIVE_MD5}') then
    raise exception '_public_order_value is neither the body 20261217a made nor the one before it (md5 %). Nothing was changed.', v_md5;
  end if;
end $same$;

{HEAD}{LIVE}$function$;

drop function if exists public.public_order_features();

do $done$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('{SIG}')) <> '{LIVE_MD5}' then
    raise exception '_public_order_value is not back as live had it. Nothing was changed.';
  end if;
end $done$;

commit;

notify pgrst, 'reload schema';

-- The check: every value true.
select
  (select md5(p.prosrc) = '{LIVE_MD5}' from pg_proc p where p.oid = to_regprocedure('{SIG}')) as pricer_back_as_it_was,
  to_regprocedure('public.public_order_features()') is null as features_gone;
"""

for path, text in ((OUT, FWD), (BACK, RB)):
    bad = [c for c in text if ord(c) > 127]
    if bad:
        sys.exit(f'{path}: not ASCII ({bad[:5]})')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
print(f'live {LIVE_MD5}\nnew  {NEW_MD5}\nwrote {os.path.relpath(OUT, REPO)}\nwrote {os.path.relpath(BACK, REPO)}')
