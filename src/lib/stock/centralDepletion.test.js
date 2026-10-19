/**
 * centralDepletion.test.js: the till's side of central stock depletion (v5.11.77, 20261018c), and
 * the pins that keep the release honest: the migration and its rollback exist, are ASCII only,
 * carry no begin or commit of their own and end with a visible check; deplete.js asks the venue
 * mode before it posts; the online checkout sends its options; the trading report sums signed
 * stock values; the version and changelog say 5.11.77. Run: npm test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modeFromRpc, isCentralMode, tillShouldDeplete, healthWords, ageWords, heldReason, MODE_TTL_MS, STOCK_MODES } from './centralMode.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MIG = '../../../supabase/migrations/20261018c_OPS_central_stock_depletion.sql';
const RB = '../../../supabase/migrations/20261018c_OPS_central_stock_depletion_ROLLBACK.sql';

test('no row, a missing RPC, a refusal or rubbish all read as browser: the old path', () => {
  assert.equal(modeFromRpc({ data: null, error: null }), 'browser');
  assert.equal(modeFromRpc({ data: 'central', error: { code: 'PGRST202', message: 'function not found' } }), 'browser');
  assert.equal(modeFromRpc({ data: 'central', error: { code: '42501' } }), 'browser');
  assert.equal(modeFromRpc({ data: 'sideways' }), 'browser');
  assert.equal(modeFromRpc(undefined), 'browser');
  assert.equal(modeFromRpc({ data: ' Central ' }), 'central');
  assert.equal(modeFromRpc({ data: 'paused' }), 'paused');
  assert.deepEqual(STOCK_MODES, ['browser', 'central', 'paused']);
});

test('the till depletes only at a browser venue; central and paused leave it to the database', () => {
  assert.equal(tillShouldDeplete('browser'), true);
  assert.equal(tillShouldDeplete('central'), false);
  assert.equal(tillShouldDeplete('paused'), false);
  assert.equal(isCentralMode('central'), true);
  assert.equal(isCentralMode('paused'), true);
  assert.equal(isCentralMode('browser'), false);
  assert.equal(MODE_TTL_MS, 60_000);
});

test('health words: browser venue, healthy central venue, backlog, held and dead rows', () => {
  const b = healthWords({ mode: 'browser', pending: 0 });
  assert.equal(b.tone, 'muted');
  assert.match(b.title, /at the till/);
  const h = healthWords({ mode: 'central', pending: 0, oldest_pending_s: 0, held: 0, dead: 0, done_24h: 12, needs_person: [] });
  assert.equal(h.tone, 'ok');
  assert.match(h.sub, /12 checks booked in the last 24 hours/);
  const late = healthWords({ mode: 'central', pending: 40, oldest_pending_s: 700, held: 0, dead: 0, done_24h: 1 });
  assert.equal(late.tone, 'alert');
  assert.match(late.sub, /40 waiting \(oldest 11 min 40 s\)/);
  const held = healthWords({ mode: 'central', pending: 0, held: 2, dead: 1, done_24h: 0, needs_person: [{ id: 1 }] });
  assert.equal(held.tone, 'warn');
  assert.match(held.sub, /2 need a person/);
  assert.match(held.sub, /1 failed 8 times/);
  assert.equal(held.needsPerson.length, 1);
  assert.equal(healthWords({ mode: 'paused', done_24h: 0 }).tone, 'warn');
  assert.equal(healthWords(null), null);
  assert.equal(ageWords(90), '1 min 30 s');
  assert.equal(ageWords(7200), '2 h');
  assert.equal(ageWords(3661), '1 h 1 min');
});

test('held reasons are plain words with the thing to do', () => {
  assert.match(heldReason({ flags: ['unproven'] }), /Release it if the sale is genuine/);
  assert.match(heldReason({ flags: ['proof_used'] }), /duplicate/i);
  assert.match(heldReason({ flags: ['items_changed'] }), /cannot be released/);
  assert.match(heldReason({ flags: ['moved'] }), /cannot be released/);
  assert.match(heldReason({ flags: ['too_old'] }), /31 days/);
  assert.match(heldReason({ flags: ['before_switch'] }), /switched to central/);
  assert.match(heldReason({ flags: ['swept', 'unproven'] }), /genuine/);
  assert.match(heldReason({ status: 'dead', flags: [], last_error: '23514: broken' }), /Failed 8 times: 23514/);
  assert.equal(heldReason({ flags: [] }), 'Needs a person.');
  // v5.11.77 review: a refund held behind its sale, and the undo of a refund netted before a catering event
  assert.match(heldReason({ flags: ['swept', 'sale_not_booked'] }), /Release the sale; this follows it/);
  assert.match(heldReason({ flags: ['netted_refund_failed'] }), /by hand/);
});

test('deplete.js asks the venue mode before every post and the server call, and skips at a central venue', () => {
  const src = read('./deplete.js');
  assert.match(src, /import \{ modeFromRpc, tillShouldDeplete, MODE_TTL_MS \} from '\.\/centralMode\.js'/);
  assert.match(src, /fetchStockVenueMode/);
  // each of the three entry points checks before it does anything with stock
  for (const fn of ['depleteForSaleServer', 'depleteForSale', 'reverseForSale']) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    const check = body.indexOf('tillShouldDeplete(await venueModeFor(loc))');
    const post = Math.min(...['postStockMovement(', "functions.invoke('stock-deplete'", 'explodeBasket('].map((k) => body.indexOf(k)).filter((i) => i > 0));
    assert.ok(check > 0 && check < post, `${fn} checks the venue mode before it posts`);
  }
  // any failure reading the mode is 'browser', never a thrown error into the sale path
  assert.match(src, /catch \{ mode = 'browser'; \}/);
  // the server call now leaves out removed options too, as the database does
  assert.match(src, /!m\._instruction && !m\.removed/);
});

test('the online checkout sends the chosen options to the server stock call (both paths)', () => {
  const src = read('../../surfaces/online/OnlineCheckout.jsx');
  const calls = src.match(/depleteForSaleServer\(\{ id: closedCheck\.id, items: cart\.map\(l => \(\{ itemId: l\.itemId, qty: l\.qty, mods: l\.mods \}\)\), orderType \}\)/g) || [];
  assert.equal(calls.length, 2, 'both online placement paths pass mods');
  assert.doesNotMatch(src, /items: cart\.map\(l => \(\{ itemId: l\.itemId, qty: l\.qty \}\)\)/, 'no path still drops the options');
});

test('the data layer exposes the three RPCs by their migration names', () => {
  const src = read('./data.js');
  assert.match(src, /supabase\.rpc\('stock_venue_mode', \{ p_location_id: locationId \}\)/);
  assert.match(src, /supabase\.rpc\('stock_outbox_health', \{ p_location_id: locationId \}\)/);
  assert.match(src, /supabase\.rpc\('stock_outbox_release', \{ p_id: Number\(id\) \}\)/);
});

test('the trading report sums signed stock values, so a refund reversal comes OFF recipe COGS', () => {
  const src = read('../../../supabase/functions/trading-report/index.ts');
  const i = src.indexOf('const recipeCogs');
  const block = src.slice(i, src.indexOf('const rows = days.map', i));
  assert.match(block, /const v = -\(Number\(m\.value_delta\) \|\| 0\);/);
  assert.doesNotMatch(block, /Math\.abs\(Number\(m\.value_delta\)/, 'Math.abs would add an unsale row to COGS');
});

test('the migration and its rollback: present, ASCII only, bare statements, a visible check at the end, the same door md5', () => {
  const mig = read(MIG), rb = read(RB);
  for (const [name, text] of [['migration', mig], ['rollback', rb]]) {
    assert.ok([...text].every((ch) => ch.charCodeAt(0) < 128), `${name} is ASCII only`);
    assert.doesNotMatch(text, /^(begin|commit|start transaction)\s*;/im, `${name} has no begin or commit of its own`);
    assert.match(text.trimEnd(), /;\s*$/, `${name} ends with a statement`);
    assert.match(text, /VISIBLE CHECK/, `${name} has a visible check at the bottom`);
    assert.match(text, /This is not the Ops database/, `${name} refuses the wrong database`);
  }
  const door = /not in \('ad53ab7ca7477bba0a56b2e512fc11e7', '([0-9a-f]{32})'\)/.exec(mig);
  assert.ok(door, 'the guard names the fenced text and the door text');
  assert.ok(rb.includes(`'${door[1]}'`), 'the rollback accepts the same door text');
  assert.match(mig, /insert into public\.stock_depletion_default \(one, mode, changed_by\)\s+select true, 'browser'/, 'the default is browser: nothing moves on day one');
  assert.match(mig, /public\._post_stock_movement\(/, 'posts through the fences core');
  assert.doesNotMatch(mig.replace(/create or replace function public\.post_stock_movement[\s\S]*?end \$\$;/, ''), /perform public\.post_stock_movement\(|:= public\.post_stock_movement\(/, 'never calls the public door from inside');
  assert.match(mig, /array_append\(flags, /, 'flags are appended with array_append (the prototype bug)');
  assert.doesNotMatch(mig, /flags \|\| '[a-z_]+'/, 'no text[] || text literal');
  assert.match(mig, /revoke all on routine %s from public, anon, authenticated, service_role/, 'every routine loses the default API grants');
  assert.match(mig, /cron\.schedule\('stock-outbox-drain', '\* \* \* \* \*', 'call public\.stock_outbox_drain\(\);'\)/);
  assert.match(mig, /voided_items/.test(mig) ? /never/ : /./, 'no voided_items column this release');
  assert.doesNotMatch(mig, /add column if not exists voided_items/, 'closed_checks is not altered (hottest realtime table)');
});

test('version and changelog say 5.11.77', async () => {
  const { VERSION } = await import('../version.js');
  assert.equal(VERSION, '5.11.77');
  const { CHANGELOG } = await import('../changelog.js');
  assert.equal(CHANGELOG[0].v, '5.11.77');
  assert.ok(CHANGELOG[0].items.some((t) => /20261018c/.test(t)), 'the changelog names the database update');
  assert.ok(CHANGELOG[0].items.some((t) => /Nothing changes at any venue until ServOS switches it on/.test(t)), 'and says nothing moves until a venue is switched on');
  for (const t of CHANGELOG[0].items) assert.doesNotMatch(t, /[–—]/, 'no dashes as punctuation');
});
