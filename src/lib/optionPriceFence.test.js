/**
 * Database fence stage 1, fix round 3 (19 Sep 2026): the eighth way to forge "paid".
 *
 * A line could be priced to zero by repeating the venue's OWN minus priced modifier option: a
 * 95 pound Feast with one real "No onions" (-0.50) sent 190 times came to 0, the amount due
 * fell back to the penny the phone declared, and the order was paid with a 1p check. It also
 * walked a QR round past its card hold and let settle_qr_tab close a whole tab for pennies.
 *
 * The server side is proved end to end on the local Postgres harness
 * (supabase/tests/fence_stage_1/testA.py, "EIGHTH WAY" and "GROUP MAX"). These checks hold the
 * rules in place in the file itself, and cover the Back Office side: the price box used to let
 * a minus price be typed and saved in silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

const FILE_A = read('../../supabase/migrations/20260919a_OPS_fence_1_after_release.sql');
const value = FILE_A.slice(
  FILE_A.indexOf('create or replace function public._public_order_value'),
  FILE_A.indexOf('create or replace function public._public_order_auto'),
);

test('the server checks an option against the groups the item really has', () => {
  assert.ok(value.includes('r.assigned_modifier_groups'), "the item's own group list");
  assert.ok(value.includes('p.assigned_modifier_groups'), 'a size with none of its own uses the main product\'s');
  assert.ok(value.includes("coalesce(e ->> 'groupId', e ->> 'id')"), 'an entry is a plain id or { groupId | id }');
  assert.ok(value.includes("o ->> 'subGroupId'"), 'a nested sub group pick still counts');
  assert.ok(value.includes("(v_opt ->> 'g') = any(v_groups)"), 'the option must be in one of them');
});

test('an option is counted no more times than its group allows', () => {
  assert.ok(value.includes("coalesce(nullif(g.max, 0), nullif(g.max_select, 0), 1)"), 'max, then max_select, then once');
  assert.ok(value.includes('greatest(1, least(99,'), 'never below 1, never above 99');
  assert.ok(value.includes("coalesce(g.selection_type, '') = 'quantity'"), 'only a "pick with qty" group repeats one option');
  assert.ok(value.includes("< (v_opt ->> 'max')::integer"), 'the per group counter');
});

test('anything else can only add to a line, never take money off', () => {
  assert.ok(value.includes("v_mod := greatest(v_mod, coalesce(v_menu, 0), 0);"),
    'an option that is not this item\'s, or one copy too many, counts at the largest of the page price, its menu price and 0');
  assert.ok(value.includes('v_unit := greatest(0, v_item + v_modsum);'), 'and a line is never worth less than nothing');
  assert.ok(value.includes("v_floor := public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_menu_id);")
    && value.includes('v_item := greatest(v_item, v_floor);'),
    'the item itself is still floored at its menu price (fix round 7: on the menu the page priced it on), '
    + 'so a line is never below that floor plus the options the venue allows');
  // fix round 7: an option the server cannot match by id at all is worth NOTHING to it, so the
  // storefront's own free instruction picks and typed notes stay free. It still cannot subtract.
  assert.ok(!value.includes('v_onames'), 'the round 6 option-by-NAME price is gone: it charged our own free choices');
});

test('the tab rules are valued the same way, so a round cannot walk past its hold', () => {
  assert.ok(FILE_A.includes('v_value_minor := greatest(round(v_total * 100)::bigint, v_goods_minor - v_auto_minor - v_tol);'),
    'a QR round is valued from the server goods total');
  assert.ok(/public\._public_order_value\(v_loc, 'qr', q\.type, q\.items,\s+q\.customer -> 'order_pricing' ->> 'menu_id'\) ->> 'goods_minor'/.test(FILE_A),
    'and settle_qr_tab values a round it has no stored price for the same way, on that round\'s own menu');
});

test('Back Office: a minus option price is confirmed, never saved by a stray minus sign', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  const i = mm.indexOf('onChange={e=>updOpt(opt.id,{price:parseFloat(e.target.value)||0})}');
  assert.ok(i > 0, 'the option price box');
  const after = mm.slice(i, i + 700);
  assert.ok(after.includes('onBlur={e=>{'), 'it is checked when the box is left');
  assert.ok(after.includes('if (v >= 0) return;'), 'a normal price is never interrupted');
  assert.ok(after.includes('takes money OFF the bill'), 'and the question says what a minus price does');
  assert.ok(after.includes('if (!ok) updOpt(opt.id,{price:0});'), 'declined, it goes back to 0');
});
