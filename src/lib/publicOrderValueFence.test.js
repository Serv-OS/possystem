/**
 * Database fence stage 1, fix round 4 (19 Sep 2026): the ninth and tenth ways to forge "paid".
 *
 * NINTH  a loyalty reward with no money value of its own (free_item, which is the stamp card
 *        default, and discount_percent) was capped at the DEAREST SINGLE ITEM on the basket
 *        and stacked once per redeem row, so one genuine free coffee redemption paid for a 95
 *        pound Feast, and two paid a 190 pound basket for a penny.
 * TENTH  any menu_items row of the venue counted, including rows the storefront never sells (a
 *        variants parent, an option only sub item, an archived, hidden or 86'd row), and a row
 *        the server could not price was worth 0, so ten Colas rode along free on a paid ticket.
 *
 * THE RULE: when the server cannot work out what something is worth it never guesses in the
 * customer's favour. It is worth nothing to them, the order comes out short, and staff see it
 * and confirm on the till. A short order is safe; a wrongly paid one is not.
 *
 * Proved end to end on the local Postgres harness (supabase/tests/fence_stage_1/testA.py,
 * "NINTH WAY" and "TENTH WAY", including the reviewer's two scenarios to the penny). These
 * checks hold the rules in place in the file itself.
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
  assert.ok(value.includes("coalesce(r.visibility ->> v_vis, 'true') <> 'false'"),
    'only an explicit "hidden from this channel" hides a row, so a venue that never set it is untouched');
  assert.ok(value.includes("to_regclass('public.eighty_six')") && value.includes('not (r.id = any(v_86))'),
    '86\'d items are not sellable for value, read through to_regclass so the file runs anywhere');
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
  assert.ok(loyalty.includes('floor(greatest(0, coalesce(p_goods_minor, 0)) * v_pct / 100)::bigint'),
    'is that percent of the server\'s own goods value');
  assert.ok(loyalty.includes("elsif v_type = 'free_item' then") && loyalty.includes('public._loyalty_free_item_minor('),
    'a free item reward is valued from the order\'s own lines');
  assert.ok(loyalty.includes('return least(p_declared, v_cap);'), 'and never more than the page declared');
  // the reward's shape can only come from the proof the payment-proof function wrote
  assert.ok(loyalty.includes("jsonb_typeof(v_meta -> 'reward') = 'object'"), 'from meta.reward on the loyalty proof');
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
