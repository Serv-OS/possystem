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
  assert.ok(floor.includes("if coalesce(v_val, 0) > 0 then"), 'a menu tier only counts when it is a real price');
  assert.ok(!/return round\(v_min \* 100\)::bigint;/.test(floor), 'the old unconditional 0 return is gone');
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
  assert.ok(loyalty.includes('return least(p_declared, v_cap, v_base);'),
    'never more than the page declared, and never more than the order has left to give away');
  assert.ok(loyalty.includes('v_base bigint := greatest(0, coalesce(p_base_minor, 0));'), 'the ceiling is a parameter');
  // and the ceiling BOTH callers pass is the goods AFTER the venue's deals and the promo code
  assert.equal((FILE_A.match(/public\._public_order_loyalty\(v_loc/g) || []).length, 2,
    'two callers: place_public_order and verify_public_order_payment');
  assert.ok(FILE_A.includes('greatest(0, v_goods_minor - v_auto_minor - v_promo_minor),'),
    'place_public_order passes the goods less the automatic deals less the promo code');
  assert.ok(FILE_A.includes("greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)\n"
    + "                                                               - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)\n"
    + "                                                               - coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)),"),
    'and Check payment re-values a late redemption against the same ceiling');
  // the old 5 arg shape and the round 4 shape are both dropped, so the rename can apply in place
  assert.ok(FILE_A.includes('drop function if exists public._public_order_loyalty(text, text, text, bigint, bigint);')
    && FILE_A.includes('drop function if exists public._public_order_loyalty(text, text, text, bigint, bigint, jsonb);'),
    'both older signatures are dropped first (a parameter rename cannot CREATE OR REPLACE)');
});

test('a free item reward is the CHEAPEST line it matches, on the same rule every screen uses', () => {
  const free = between('create or replace function public._loyalty_free_item_minor',
    'create or replace function public._public_order_loyalty');
  assert.ok(free.includes('v_min := least(v_min, greatest(0, coalesce((l ->> \'item\')::bigint, 0)));'), 'the cheapest match');
  assert.ok(free.includes('return greatest(0, coalesce(v_min, 0));'), 'nothing matched: worth nothing');
  assert.ok(free.includes('if cardinality(v_ids) = 0 and cardinality(v_keys) = 0 then\n    return 0;'),
    'a reward that names no item is worth nothing');
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
    && settle.includes("(public._public_order_value(v_loc, 'qr', q.type, q.items) ->> 'goods_minor')::bigint, 0)")
    && settle.includes("- coalesce((q.customer -> 'order_pricing' ->> 'auto_minor')::bigint, 0)"),
    'valued from each round, or re-priced by the server for a round an old page placed');
  assert.ok(settle.includes('v_tip := least(greatest(0, v_tip), greatest(0, round((v_taken - v_goods)::numeric / 100, 2)));'),
    'the tip is capped at what the card took over that value');
  // the rest is the sale, so a phone can no longer book a 0.00 sale and a 95 pound tip
  assert.ok(settle.includes("'subtotal', greatest(0, v_booked - v_tip)"), 'and the rest is the sale');
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
