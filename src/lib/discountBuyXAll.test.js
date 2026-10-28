// discountBuyXAll.test.js: v5.11.109 wiring for the Buy X rules in Back Office, Discounts and on the
// server. The engine itself is in discountEngine.test.js, the words in discountWords.test.js, and the
// server's figures against the engine's on a real Postgres in supabase/tests/discount_buy_x_all/run.mjs.
// Run: node --test src/lib/discountBuyXAll.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const DM = read('src/backoffice/sections/DiscountManager.jsx');
const MIG = read('supabase/migrations/20261105b_OPS_discount_buy_x_all.sql');
const RB = read('supabase/migrations/20261105b_OPS_discount_buy_x_all_ROLLBACK.sql');
const LIVE = read('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
const fnOf = (s) => s.slice(s.indexOf('CREATE OR REPLACE FUNCTION public._public_order_auto('), s.indexOf('$function$;', s.indexOf('CREATE OR REPLACE FUNCTION public._public_order_auto(')) + 11);

test('the editor offers the third rule type and says the rule in one live sentence', () => {
  assert.match(DM, /\[\['buy_x','Buy X get Y'\],\['buy_x_all','Buy X, discount the lot'\],\['bundle','Bundle \/ Meal deal'\]\]/);
  assert.match(DM, /import \{ ruleSentence \} from '\.\.\/\.\.\/lib\/discountWords';/);
  assert.match(DM, /summary = ruleSentence\(form, categories, \{ sym: currencySymbol\(\), sameRewardCats \}\);/);
  assert.match(DM, /How many items get the discount after the full price ones/);
  assert.match(DM, /aria-live="polite"/, 'the sentence is read out as it changes');
  // the list of rules says the same sentence
  assert.match(DM, /ruleSentence\(rule, categories, \{ sym: currencySymbol\(\), sameRewardCats: !\(rule\.rewardCategoryIds \|\| \[\]\)\.length \}\)/);
  // Buy X, discount the lot has no reward quantity, no reward categories and no Free
  assert.match(DM, /\{!isAll && <option value="free">Free \(100% off\)<\/option>\}/);
  assert.match(DM, /rewardCategoryIds: sameRewardCats \|\| isAll \? \[\] : form\.rewardCategoryIds,/);
});

test('the server function is the live 20261020a one plus one buy_x_all branch, and the rollback is the live one word for word', () => {
  const live = fnOf(LIVE), fwd = fnOf(MIG), back = fnOf(RB);
  assert.equal(back, live, 'the rollback puts back exactly the live function');
  const start = fwd.indexOf("    elsif coalesce(r.trigger_type, 'buy_x') = 'buy_x_all' then");
  assert.ok(start > 0, 'the new branch');
  const end = fwd.indexOf('    else\n      continue;\n    end if;', start);
  assert.equal(fwd.slice(0, start) + fwd.slice(end), live, 'nothing else in the function changed');
  const branch = fwd.slice(start, end);
  assert.match(branch, /order by u_price\[s\], s\);/, 'cheapest units first, as the engine');
  assert.match(branch, /v_fire := cardinality\(v_avail\) \/ v_need;/, 'once per full set');
  assert.match(branch, /u_used\[k\] := true;/, 'a unit takes one deal');
});

test('both files: Ops only guard, 3 s lock wait, ASCII, no exclamation mark, a visible check', () => {
  for (const [name, s] of [['migration', MIG], ['rollback', RB]]) {
    assert.ok([...s].every((c) => c.charCodeAt(0) < 128), `${name} is ASCII`);
    assert.ok(!s.includes('!'), `${name} has no exclamation mark`);
    assert.match(s, /to_regclass\('public\.billing_state'\) is not null/);
    assert.match(s, /set local lock_timeout = '3s';/);
    assert.match(s, /-- VISIBLE CHECK/);
    assert.ok(s.indexOf('do $guard$') < s.indexOf('CREATE OR REPLACE FUNCTION'), `${name}: the guard runs first`);
  }
  assert.doesNotMatch(MIG, /grant execute[^;]*(anon|authenticated)/i, 'never opened to the API roles');
});
