/**
 * Database fence stage 1, fix rounds 4 and 5 (19 Sep 2026): the ninth, tenth and eleventh ways
 * to forge "paid", and the two rules that were stricter than the storefront itself.
 *
 * NINTH   a loyalty reward with no money value of its own (free_item, which is the stamp card
 *         default, and discount_percent) was capped at the DEAREST SINGLE ITEM on the basket
 *         and stacked once per redeem row, so one genuine free coffee redemption paid for a 95
 *         pound Feast, and two paid a 190 pound basket for a penny.
 * TENTH   any menu_items row of the venue counted, including rows the storefront never sells (a
 *         variants parent, an option only sub item, an archived or 86'd row), so ten Colas rode
 *         along free on a paid ticket.
 * ELEVENTH (round 5) every redemption keyed to the check was valued honestly and then ADDED UP,
 *         with nothing tying the sum to the order. loyalty-redeem keys on
 *         'redeem:<check_id>:<reward_id>', so two DIFFERENT rewards on one check are two legal
 *         redemptions (the storefront only ever applies one: OnlineCheckout's rewardApplied is
 *         a single object). Two genuine 50 percent rewards took a 125 pound order to 0.00 and
 *         it booked as PAID with no money at all.
 *
 * THE RULE: when the server cannot work out what something is worth it never guesses in the
 * customer's favour. It is worth nothing to them, the order comes out short, and staff see it
 * and confirm on the till. A short order is safe; a wrongly paid one is not.
 *
 * ROUND 7 (20 Sep): both halves of the rule again, in the two places round 6 broke the honest
 * direction. An option the server cannot match by id is worth NOTHING (round 6 charged it at
 * the venue's price for that NAME, which charged the storefront's own free instruction picks
 * and typed notes, and refused guests who had paid in full). A 0.00 menu tier is a real price
 * on the menu the basket was BUILT on and nowhere else (round 6 let it into the lowest price of
 * any menu, so an item that is free on one menu was free to order on all of them). Plus: a free
 * item reward that names nothing is bounded, the tender SPLIT is proven and not just its sum,
 * the check's own method is the server's too, and a courier fee or added-on sales tax can never
 * become a tip.
 *
 * AND THE OTHER HALF OF THE RULE (round 5): the server must not be STRICTER than the storefront
 * either, or honest fully paid orders sit in "Payment short" and QR tab rounds are refused
 * outright. Round 4's sellability test also refused a row whose visibility.online was false (a
 * key no storefront reads) and any row the server could not price (a 0.00 tap water or free
 * side, which every storefront shows and sells). Both are gone.
 *
 * Proved end to end on the local Postgres harness (supabase/tests/fence_stage_1/testA.py,
 * "NINTH WAY", "TENTH WAY", "ELEVENTH WAY" and "FIX ROUND 5", including the reviewer's
 * scenarios to the penny, before and after). These checks hold the rules in place in the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { itemLabelKey } from './loyaltyMenuMatch.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

const FILE_A = read('../../supabase/migrations/20260919a_OPS_fence_1_after_release.sql');
const between = (from, to) => FILE_A.slice(FILE_A.indexOf(from), FILE_A.indexOf(to));
const floor = between('create or replace function public._menu_item_floor_minor', 'do $revoke_internal$');
const value = between('create or replace function public._public_order_value', 'create or replace function public._public_order_auto');
const loyalty = between('create or replace function public._loyalty_label_key', 'create or replace function public._public_order_due');

test('a price the server cannot work out is NULL, never zero', () => {
  assert.ok(floor.includes('if jsonb_typeof(p_pricing) is distinct from \'object\' then\n    return null;'),
    'no pricing object at all is unknown, not free');
  assert.ok(floor.includes('public._fence_num_or_null('), 'a missing or junk number is nothing, not 0');
  assert.ok(floor.includes('if coalesce(v_min, 0) <= 0 then\n    v_min := null;'),
    'a zero is not a price (every screen reads a zero as unpriced: menuPricing.variantFromPrice)');
  // fix round 6: a zero TYPED INTO A MENU TIER is a real price. menuPricing.menuTierPrice
  // uses isSet(), so 0 counts, and resolveItemPrice returns that tier and looks no further,
  // which means every storefront charges 0.00 for that row on that menu.
  assert.ok(floor.includes("if v_val is not null and v_val >= 0 then"), 'an explicit tier price counts, zero included');
  assert.ok(!/return round\(v_min \* 100\)::bigint;/.test(floor), 'the old unconditional 0 return is gone');
});

test('a 0.00 menu tier is a price on ITS OWN menu only (fix round 7)', () => {
  // Round 6 let a 0.00 tier into the lowest-price-of-any-menu floor, which made an item that is
  // free on one menu free to order on all of them (ten 0.00 Kids Squash beside one real Coffee
  // came out PAID for 3.00). The page now says which menu it priced on, exactly as
  // resolveItemPrice was told (OnlineSurface's effectiveMenuId).
  assert.ok(floor.includes("if nullif(btrim(coalesce(p_menu_id, '')), '') is not null\n"
    + "     and jsonb_typeof(p_pricing -> 'menus' -> p_menu_id) = 'object' then"),
    'the named menu\'s own tier is looked at first');
  assert.ok(floor.includes('-- The menu the basket was built on: its tier is the price, 0.00 included, and nothing else'),
    'and it wins outright, like resolveItemPrice');
  assert.ok(floor.includes("if nullif(btrim(coalesce(p_menu_id, '')), '') is null and jsonb_typeof(p_pricing -> 'menus') = 'object' then"),
    'the lowest-tier scan only runs when the menu is NOT known');
  assert.ok(floor.includes('if v_val is not null and v_val > 0 then\n        v_min := least(v_min, v_val);'),
    'and then a 0.00 tier is ignored: short is a question, free is a loss');
  // the menu id reaches the floor from the order, and is kept for a later re-valuation
  assert.ok(FILE_A.includes('public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_menu_id);'), 'the valuer passes it');
  assert.ok(FILE_A.includes("v_menu_id     text := nullif(left(btrim(coalesce(p_order ->> 'menu_id', '')), 80), '');"),
    'place_public_order reads it off the order');
  assert.ok(FILE_A.includes("'menu_id', v_menu_id);"), 'and keeps it in order_pricing');
  assert.ok(FILE_A.includes("v_pend.pricing ->> 'menu_id') -> 'lines'));"), 'Check payment re-values on the same menu');
  assert.ok(FILE_A.includes("q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint))), 0)"),
    'and a QR tab close values its rounds on theirs');
  assert.ok(FILE_A.includes('drop function if exists public._menu_item_floor_minor(jsonb, text, boolean);'),
    'the old three argument shape is dropped first (a new parameter cannot CREATE OR REPLACE)');
  assert.ok(FILE_A.includes('drop function if exists public._public_order_value(text, text, text, jsonb);'), 'the same for the valuer');
  // and the three checkouts really send it
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  const qr = read('../surfaces/qr/QrCheckout.jsx');
  const surface = read('../surfaces/online/OnlineSurface.jsx');
  assert.equal((online.match(/menu_id: menuId \|\| null/g) || []).length, 2, 'both online payloads carry it');
  assert.equal((qr.match(/menu_id: menuId \|\| null/g) || []).length, 2, 'the QR round and the QR pay now payload too');
  assert.ok(surface.includes('menuId={effectiveMenuId}'), 'from the surface that priced the basket');
  assert.equal((surface.match(/menuId=\{effectiveMenuId\}/g) || []).length, 2, 'to both checkouts');
  // catering prices from `base` only (CateringSurface), so it never sends one and the server
  // ignores any it is given
  assert.ok(FILE_A.includes("v_menu_id  text := case when p_source = 'catering' then null else"), 'catering keeps its base only rule');
});

test('only what the storefront really sells counts as the server\'s own value', () => {
  assert.ok(value.includes('not (r.id = any(v_parents))'), 'a variants parent is never a line');
  assert.ok(value.includes("m.parent_id is not null and coalesce(m.archived, false) = false"),
    'a parent is any row with a live size, worked out once for the order');
  assert.ok(value.includes("not (coalesce(r.type, '') = 'subitem' and r.sold_alone is not true)"),
    'menuRules rule 1, NOT "sold_alone is false" (that column defaults to false in the live Ops DB)');
  assert.ok(value.includes('coalesce(r.archived, false) = false'), 'archived rows are not sold');
  assert.ok(value.includes("to_regclass('public.eighty_six')") && value.includes('not (r.id = any(v_86))'),
    '86\'d items are not sellable for value, read through to_regclass so the file runs anywhere');
});

test('the sellability test is the storefront\'s, never stricter (fix round 5)', () => {
  // visibility.online: Back Office writes it (MenuVisualizer's "Visible on" toggles), but the
  // storefront never reads it, so an item switched off is still on the menu and still selling.
  assert.ok(!/visibility/.test(value), 'no visibility test: refusing one turned honest paid orders short');
  assert.ok(!/v_vis/.test(value), 'and the channel key it used is gone with it');
  // The storefront's own filter, for the record: parent_id, archived, sold_alone, allergens.
  const surface = read('../surfaces/online/OnlineSurface.jsx');
  assert.ok(surface.includes('if (i.parent_id || i.archived || i.sold_alone === false) return false'),
    'OnlineSurface (online AND qr) filters on these three and nothing else');
  assert.ok(!/visibility/.test(surface.slice(surface.indexOf('const itemsForCat'), surface.indexOf('const itemsForCat') + 400)),
    'itemsForCat never reads visibility');
  // A 0.00 row is sold for 0.00, so the server values it at 0.00 rather than calling it unknown.
  assert.ok(value.includes('if v_sell and v_floor is null then\n        v_floor := 0;'),
    'a row the storefront sells that the server cannot price is FREE, which is what the customer was charged');
});

test('an unknown line is flagged, never free, and still reaches the kitchen', () => {
  assert.ok(value.includes('if v_sell and v_floor is not null then\n      v_item := greatest(v_item, v_floor);'),
    'a line the storefront sells is floored at the menu price');
  assert.ok(value.includes('v_unknown := v_unknown + 1;\n      v_item := greatest(v_item, coalesce(v_floor, 0), 0);'),
    'anything else counts at no less than the page price and any price we do have, and is flagged');
  assert.ok(value.includes("it := it || jsonb_build_object('name', v_name);"), 'the menu\'s own name goes to the kitchen');
  // the order can never pay for itself with an unknown line on it
  assert.ok(FILE_A.includes('v_paid := v_unknown = 0'), 'place_public_order');
  assert.ok(FILE_A.includes('v_paid := coalesce(v_pend.unknown_lines, 0) = 0'), 'and Check payment');
});

test('an unknown line takes no part in the discounts or in what a reward can make free', () => {
  const push = value.slice(value.indexOf('v_lines := v_lines ||') - 400, value.indexOf('v_lines := v_lines ||') + 500);
  assert.ok(push.includes('if v_sell and v_floor is not null then'), 'only sellable, priced lines are handed to the rules');
  assert.ok(push.includes("'id', r.id, 'pid', r.parent_id, 'item', greatest(0, v_item)"), 'with the ids and the server\'s own price');
  assert.ok(value.includes("v_max_unit := greatest(v_max_unit, greatest(0, v_item));")
    && value.includes('if v_sell and v_floor is not null then\n      v_max_unit'), 'and the dearest item is one of those too');
});

test('a loyalty reward is worth what the SERVER can say it is worth, never the dearest item', () => {
  assert.ok(!loyalty.includes('p_max_unit'), 'the dearest single item fallback is gone');
  assert.ok(loyalty.includes('v_val := 0;'), 'a reward the server cannot value takes nothing off');
  assert.ok(loyalty.includes('if coalesce(v_amt, 0) > 1 then\n      v_val := v_amt;'), 'a real money value on the proof still wins');
  assert.ok(loyalty.includes("if v_type = 'discount_percent' then"), 'a percent reward');
  assert.ok(loyalty.includes('v_val := floor(v_base * v_pct / 100)::bigint;'),
    'is that percent of what is LEFT to pay, not of the raw goods (fix round 5)');
  assert.ok(loyalty.includes("elsif v_type = 'free_item' then") && loyalty.includes('public._loyalty_free_item_minor('),
    'a free item reward is valued from the order\'s own lines');
  // the reward's shape can only come from the proof the payment-proof function wrote
  assert.ok(loyalty.includes("jsonb_typeof(v_meta -> 'reward') = 'object'"), 'from meta.reward on the loyalty proof');
});

test('ONE reward per order, and never more than the order is worth (fix round 5)', () => {
  assert.ok(loyalty.includes('v_cap := greatest(v_cap, greatest(0, coalesce(v_val, 0)));'),
    'the dearest redemption the server can value, never the sum of them');
  assert.ok(!loyalty.includes('v_cap := v_cap +'), 'the adding up is gone: two rewards on one check took a 125 pound order to 0');
  assert.ok(loyalty.includes('return least(p_declared, v_cap, v_ceil);'),
    'never more than the page declared, and never more than the order has left to give away');
  assert.ok(loyalty.includes('v_ceil bigint := greatest(0, coalesce(p_cap_minor, 0));'), 'the ceiling is its own parameter');
  // fix round 6: the percent BASE and the CEILING are two different figures, because that is
  // what the storefront does. OnlineCheckout:891 takes the percent of discountedSubtotalMinor
  // (:291, the subtotal less the venue's AUTOMATIC deals, before any promo), and :338 then
  // subtracts the reward and the promo side by side inside a max(0, ...).
  assert.ok(loyalty.includes('v_base bigint := greatest(0, coalesce(p_base_minor, 0));'), 'the percent base is a parameter');
  assert.ok(loyalty.includes('-- mirrors OnlineCheckout.jsx:891 (percent of discountedSubtotalMinor, :291)'),
    'the percent line names the storefront line it mirrors');
  assert.equal((FILE_A.match(/public\._public_order_loyalty\(v_loc/g) || []).length, 2,
    'two callers: place_public_order and verify_public_order_payment');
  assert.ok(FILE_A.includes('greatest(0, v_goods_minor - v_auto_minor),\n'
    + '                                                  greatest(0, v_goods_minor - v_auto_minor - v_promo_minor),'),
    'place_public_order passes the goods less the deals as the base, less the promo as the ceiling');
  assert.ok(FILE_A.includes("greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)\n"
    + "                                                               - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)),\n"
    + "                                                   greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)\n"
    + "                                                               - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)\n"
    + "                                                               - coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)),"),
    'and Check payment re-values a late redemption on the same two figures');
  // every older shape is dropped, so the new signature can be created in place
  for (const sig of ['bigint, bigint)', 'bigint, bigint, jsonb)', 'bigint, bigint, bigint, jsonb)']) {
    assert.ok(FILE_A.includes(`drop function if exists public._public_order_loyalty(text, text, text, ${sig};`),
      `the ${sig} shape is dropped first (a new parameter cannot CREATE OR REPLACE)`);
  }
});

test('a free item reward is the CHEAPEST line it matches, on the same rule every screen uses', () => {
  const free = between('create or replace function public._loyalty_free_item_minor',
    'create or replace function public._public_order_loyalty');
  assert.ok(free.includes('v_min := least(v_min, greatest(0, coalesce((l ->> \'item\')::bigint, 0)));'), 'the cheapest match');
  assert.ok(free.includes('return greatest(0, coalesce(v_min, 0));'), 'nothing matched: worth nothing');
  // fix round 6: a reward that names NO item is the stamp card default, and the storefront
  // gives the cheapest line in the basket away (OnlineCheckout.jsx:911-913, "fallback to
  // cheapest in cart"). Valuing it at 0 put every honest redemption into "Payment short".
  assert.ok(free.includes('if cardinality(v_ids) = 0 and cardinality(v_keys) = 0 then\n'
    + '    for l in select x from jsonb_array_elements(p_lines) x loop'),
    'a reward that names no item falls back to the cheapest line the server priced');
  assert.ok(free.includes('src/surfaces/online/OnlineCheckout.jsx:911-913'), 'and names the storefront line it mirrors');
  assert.ok(!free.includes('if cardinality(v_ids) = 0 and cardinality(v_keys) = 0 then\n    return 0;'),
    'the old zero is gone');
  assert.ok(free.includes("coalesce(l ->> 'id', '') = any(v_ids)") && free.includes("coalesce(l ->> 'pid', '') = any(v_ids)"),
    'matched by the line id or its size parent');
  for (const key of ['name', 'label', 'pname']) {
    assert.ok(free.includes(`public._loyalty_label_key(l ->> '${key}')`), `and by ${key}`);
  }
});

test('the SQL name key is the JS name key (loyalty is per company: ids are per site, names are not)', () => {
  const key = between('create or replace function public._loyalty_label_key',
    'What a FREE ITEM loyalty reward is worth');
  assert.ok(key.includes("regexp_replace(coalesce(p, ''), '\\s+', ' ', 'g')") && key.includes('lower(btrim('),
    'trim, runs of whitespace to one space, lower case');
  assert.ok(key.includes("' [-' || chr(8208) || '-' || chr(8213) || chr(8722) || '] '"),
    'a spaced dash of any kind is one separator, exactly the JS character class');
  // the JS side, for the same strings the SQL folds
  assert.equal(itemLabelKey('  Cola — Half '), 'cola - half');
  assert.equal(itemLabelKey('Cola - Half'), 'cola - half');
  assert.equal(itemLabelKey('Cola − Half'), 'cola - half');
});

/* ── fix round 5: the money a QR tab books, and each file's own locks ───────────────── */

test('a QR tab tip can only be money taken ABOVE the server\'s own value of the rounds', () => {
  const settle = between('create or replace function public.settle_qr_tab',
    'create or replace function public._qr_sync_table_session');
  // the server's own goods value for the tab's rounds, net of the venue's automatic deals
  assert.ok(settle.includes("coalesce((q.customer -> 'order_pricing' ->> 'goods_minor')::bigint,")
    && settle.includes("q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint, 0)")
    && settle.includes("- coalesce((q.customer -> 'order_pricing' ->> 'auto_minor')::bigint, 0)"),
    'valued from each round, or re-priced by the server on that round\'s own menu for a round an old page placed');
  assert.ok(settle.includes('v_tip := least(greatest(0, v_tip), greatest(0, round((v_taken - v_goods)::numeric / 100, 2)));'),
    'the tip is capped at what the card took over that value');
  // the rest is the sale, so a phone can no longer book a 0.00 sale and a 95 pound tip
  assert.ok(settle.includes("'subtotal', greatest(0, v_booked - v_tip)"), 'and the rest is the sale');
});

/* ── fix round 6: the server charges what our own storefront charged ────────────────── */

test('an online, QR or catering check books the SERVER\'s subtotal, service, tip and tenders', () => {
  const write = between('create or replace function public._public_order_write_check',
    'do $order_helper_grants$');
  // the same ceiling the tab close uses: money taken ABOVE what the order owed for its goods
  assert.ok(write.includes("v_head := greatest(0, greatest(0, coalesce((p_server ->> 'proven_minor')::bigint, 0))\n"
    + "                          - greatest(0, coalesce((p_server ->> 'owed_minor')::bigint, 0))\n"
    + "                          - v_fee - coalesce(v_xtax, 0));"),
    'the headroom is the proven money less what the order owed, the courier fee and added-on tax (round 7)');
  assert.ok(write.includes('v_svc  := least(v_svc, v_head);')
    && write.includes('v_tip  := least(v_tip, v_head - v_svc, greatest(0, p_total_minor));'),
    'the service charge first, then the tip, out of that headroom and never more than is booked');
  // the subtotal is the server's own cart sum, which is exactly what all three pages send
  assert.ok(write.includes('-- mirrors OnlineCheckout.jsx:237/:1358, QrCheckout.jsx:119/:528, CateringCheckout.jsx:281'),
    'and names the storefront lines it mirrors');
  assert.ok(write.includes("'subtotal', round(greatest(0, coalesce((p_server ->> 'goods_minor')::bigint, 0)) / 100.0, 2),"),
    'the subtotal is the server\'s own goods value');
  // the declared tenders are kept only when they add up, split right, on methods a page uses
  assert.ok(write.includes("in ('card', 'gift_card', 'loyalty', 'promo')"), 'no cash: no storefront takes it');
  assert.ok(write.includes('abs(v_sum - (greatest(0, p_total_minor) + v_gift + v_loy + v_promo)) > 2'),
    'the sum is the money the server proved (accounting/tenders.js THE RULE)');
  assert.ok(write.includes('abs(v_tsum - v_tip) > 2'), 'and the tips on them are the tip the server allowed');
  assert.ok(write.includes("v_row := v_row - 'tenders';"), 'anything else is dropped and rebuilt below');
  // all three call sites hand it the server's figures
  assert.equal((FILE_A.match(/:= public\._public_order_write_check\(/g) || []).length, 3,
    'place_public_order, verify_public_order_payment and confirm_public_order_payment');
  assert.ok(FILE_A.includes("'proven_minor', v_card_minor + v_gift_minor,"), 'place_public_order passes what it proved');
  assert.ok(FILE_A.includes("'proven_minor', v_card + v_gift,"), 'Check payment passes what it proved');
  assert.ok(FILE_A.includes("'proven_minor', v_book + v_gift,"), 'and a manager confirm passes what it booked');
});

test('an option the server cannot match by id is worth NOTHING, and can never take anything off (fix round 7)', () => {
  // Round 6 charged such an option at the dearest menu price of any option with the same NAME.
  // The storefront's own free choices arrive exactly like that: an ig-<group>-<value> id that
  // is on no modifier group, or no id at all, always at price 0. At a venue whose instruction
  // wording matches one of its option names ("Sauce", "Cheese") the guest who had paid in full
  // came out short, with no kitchen ticket and a charge they never paid on their own line.
  assert.ok(!value.includes('v_onames'), 'the option-name price table is gone');
  assert.ok(!/jsonb_object_agg\(k, v\), '\{\}'::jsonb\) into v_onames/.test(FILE_A), 'and nothing else builds one');
  assert.ok(value.includes('v_mod := greatest(v_mod, coalesce(v_menu, 0), 0);'),
    'an unmatched option keeps what the page said, floored at zero: it can only ADD to the line');
  assert.ok(value.includes('-- AN OPTION THE SERVER CANNOT MATCH BY ID IS WORTH NOTHING (fix round 7, 20 Sep).'),
    'the rule is written where the loop is');
  assert.ok(value.includes('THE ACCEPTED COST: a doctored page can put a free extra on a kitchen ticket'),
    'and so is what it costs');
  // the storefront lines that mint those ids, so the next reader can check them
  for (const ref of ['OnlineItemSheet.jsx:450', 'InlineItemFlow.jsx:271', 'kioskBasket.js:51']) {
    assert.ok(value.includes(ref), `names ${ref}`);
  }
  // round 3's repeated minus option forgery is still shut: a copy past the group's limit has
  // no v_pick either, and lands on the same floor-at-zero line
  assert.ok(value.includes("v_key := (v_opt ->> 'g') || '|' || (md ->> 'id');"), 'the per group, per option counter is still there');
  assert.ok(value.includes("or coalesce((v_used ->> v_key)::integer, 0) = 0"), 'and a non repeatable option counts once');
});

test('the money on a public check does not depend on the tenders column (fix round 7)', () => {
  const write = between('create or replace function public._public_order_write_check',
    'do $order_helper_grants$');
  // accountingDay.js legacyTenders reads `method` and `payment_method`; both were the phone's,
  // so a card sale declared as cash booked cash takings on a database without the column.
  assert.ok(write.includes("v_method := case when p_total_minor > 0 then 'card'"), 'the method is the server\'s own');
  assert.ok(write.includes("'method', v_method,") && write.includes("'payment_method', case"),
    'and payment_method with it, in the list form legacyTenders parses');
  const acct = read('../../supabase/functions/_shared/accountingDay.js');
  assert.ok(acct.includes("const raw = String(row?.payment_method || row?.method || 'other');"),
    'which is exactly what the fallback reads');
  // and the tab close carries a server built list too
  const settle = between('create or replace function public.settle_qr_tab',
    'create or replace function public._qr_sync_table_session');
  assert.ok(settle.includes("'tenders', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object("), 'settle_qr_tab writes its own tender');
  assert.ok(settle.includes("'psp_ref', p_payment_intent_id,"), 'naming the capture it booked');
});

test('the tender SPLIT is proven, not just the sum (fix round 7)', () => {
  const write = between('create or replace function public._public_order_write_check',
    'do $order_helper_grants$');
  for (const [name, server] of [['card', 'greatest(0, p_total_minor) + 2'], ['gift', 'v_gift + 2'],
                                ['loy', 'v_loy + 2'], ['prom', 'v_promo + 2']]) {
    assert.ok(write.includes(`v_t_${name} > ${server}`), `the ${name} line is held to what the server proved`);
  }
  assert.ok(write.includes('-- THE SPLIT, NOT JUST THE SUM (fix round 7, 20 Sep).'), 'and says why');
  assert.ok(write.includes("v_row := v_row - 'tenders';"), 'anything else is dropped and rebuilt from the server\'s figures');
});

test('a service charge and a tip come out of the GOODS headroom only (fix round 7)', () => {
  const write = between('create or replace function public._public_order_write_check',
    'do $order_helper_grants$');
  assert.ok(write.includes("v_fee  := greatest(0, round(public._fence_num(v_row -> 'customer' ->> 'delivery_fee') * 100)::bigint);"),
    'the courier fee is not headroom (OnlineCheckout.jsx:450 puts it on the customer)');
  assert.ok(write.includes("where lower(coalesce(e -> 'rate' ->> 'type', e ->> 'type', '')) = 'exclusive';"),
    'nor is ADDED-ON sales tax (lib/tax.js: only exclusive rates are charged on top)');
  assert.ok(write.includes('- v_fee - coalesce(v_xtax, 0));'), 'both come off before a tip can be taken');
  // UK VAT is inside the goods the server priced, so it must NOT come off, or honest tips die
  assert.ok(write.includes('-- Only EXCLUSIVE (added-on) tax counts: UK VAT is already inside the goods the server'),
    'and the file says why inclusive VAT is left alone');
});

test('a free item reward that names nothing is BOUNDED (fix round 7)', () => {
  const free = between('drop function if exists public._loyalty_free_item_minor(jsonb, jsonb);',
    'create or replace function public._public_order_loyalty');
  assert.ok(free.includes('v_no_item_cap constant bigint := 1500;'), '15.00 when the programme sets no ceiling');
  assert.ok(free.includes('return least(greatest(0, coalesce(v_min, 0)),\n'
    + '                 greatest(0, coalesce(nullif(p_cap_minor, 0), v_no_item_cap)));'),
    'the cheapest line, capped');
  assert.ok(FILE_A.includes("greatest(0, round(public._fence_num(v_rw ->> 'max_minor'))::bigint));"),
    'the programme\'s own ceiling comes off the proof meta');
  const rules = read('../../supabase/functions/_shared/paymentProofRules.js');
  assert.ok(rules.includes('max_minor: cap') || rules.includes('{ type, items, max_minor: cap }'),
    'payment-proof writes it');
  assert.ok(rules.includes('posInt(v.max_value_minor) || posInt(v.max_amount_minor) || posInt(v.cap_minor)'),
    'from the reward row or the stamp programme');
  // and the Back Office says so where the rows are made
  const bo = read('../backoffice/sections/LoyaltyManager.jsx');
  assert.equal((bo.match(/No item picked yet\./g) || []).length, 2, 'both editors warn while nothing is named');
  assert.ok(bo.includes('No items named: this gives away the cheapest line on the order'), 'and the saved rewards list warns too');
});

test('every fence file bounds its own locks, step 1b included', () => {
  const caps = read('../../supabase/migrations/20260919_OPS_fence_0_caps.sql');
  assert.ok(caps.includes("set local lock_timeout = '3s';"),
    'step 1b is the only file run DURING service and both its ALTERs take ACCESS EXCLUSIVE on devices');
  assert.ok(caps.includes('exception when lock_not_available or deadlock_detected then'),
    'and it says "wait 10 seconds and press Run again" like file A, not a raw Postgres error');
  assert.ok(FILE_A.includes("set local lock_timeout = '3s';"), 'file A');
});

test('the closed_checks rule is widened without re-reading every past bill', () => {
  assert.ok(/add constraint closed_checks_source_check[\s\S]{0,400}?\)\) not valid;/.test(FILE_A),
    'NOT VALID: the new list is a superset, so no scan is needed and step 3 keeps its 5 seconds');
  assert.ok(FILE_A.includes("'ezcater', 'qr'"), 'and QR checks are still accepted');
});
