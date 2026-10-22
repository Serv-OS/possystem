/**
 * centralDepletion.test.js: the till's side of central stock depletion (v5.11.77, 20261018c), and
 * the pins that keep the release honest: the migration and its rollback exist, are ASCII only,
 * carry no begin or commit of their own and end with a visible check; the online checkout sends its
 * options; the trading report sums signed stock values; the changelog keeps the 5.11.77 entry.
 * v5.11.92 (the drainer release, 20261023a): the till never posts sale stock in any mode, so
 * tillShouldDeplete is false for every mode and every deplete.js entry point is a no op with no
 * reads. Run: npm test.
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

test('v5.11.92: the till never depletes, in any mode; the database books every channel', () => {
  // was: browser true (the till path). Since 20261023a the database is the one stock rule, so a
  // venue ServOS switched back to browser takes no sale stock off at all, never the till's copy.
  for (const mode of [...STOCK_MODES, 'sideways', '', null, undefined, modeFromRpc({ data: 'browser' }), modeFromRpc(undefined)]) {
    assert.equal(tillShouldDeplete(mode), false, `tillShouldDeplete(${JSON.stringify(mode)}) is false`);
  }
  assert.equal(isCentralMode('central'), true);
  assert.equal(isCentralMode('paused'), true);
  assert.equal(isCentralMode('browser'), false);
  assert.equal(MODE_TTL_MS, 60_000);
});

test('health words: browser venue, healthy central venue, backlog, held and dead rows', () => {
  const b = healthWords({ mode: 'browser', pending: 0 });
  assert.equal(b.tone, 'muted');
  // v5.11.92: a browser venue no longer takes stock off at the till; it takes none until switched back on
  assert.equal(b.title, 'Stock does not come off at this venue');
  assert.equal(b.sub, 'The database takes stock off every channel. This venue was switched off by ServOS, so no sale takes stock off here until it is switched back on.');
  assert.doesNotMatch(b.title, /at the till/);
  for (const t of [b.title, b.sub]) assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes as punctuation');
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

test('v5.11.92: deplete.js reads nothing, asks no venue mode and posts nothing (source)', () => {
  const src = read('./deplete.js');
  // was: it imported the recipe book, the data layer, explode.js and centralMode.js, read the venue
  // mode once a minute and posted SALE_DEPLETION and RETURN rows at a browser venue.
  assert.doesNotMatch(src, /^import /m, 'no imports at all: no supabase client, no recipes, no data layer');
  for (const gone of ['recipes.js', 'data.js', 'explode.js', 'centralMode.js', 'supabase', 'fetchStockVenueMode', 'buildDepletionCtx', 'explodeBasket', 'postStockMovement', 'venueModeFor', 'tillShouldDeplete(', 'getActiveLocationSync', 'functions.invoke']) {
    assert.ok(!src.includes(gone), `deplete.js no longer mentions ${gone}`);
  }
  assert.doesNotMatch(src, /movementType|idempotencyKey|SALE_DEPLETION'|'RETURN'/, 'no movement is built here');
  // every export callers use is still there, with the same names and arguments
  assert.match(src, /^export async function depleteForSale\(_check\) \{ \/\* the database books every channel's checks \*\/ \}$/m);
  assert.match(src, /^export async function reverseForSale\(_check, _refundItems, _refundId\) \{ \/\* the database books every refund \*\/ \}$/m);
  assert.match(src, /^export function invalidateVenueMode\(\) \{/m);
  assert.match(src, /^export function invalidateDepletionCtx\(\) \{/m);
  assert.match(src, /^export function saleTimeOf\(check, nowMs = Date\.now\(\)\) \{/m);
  // the store still calls them on every close and refund (store/index.js is not edited; the calls do nothing)
  const store = read('../../store/index.js');
  assert.match(store, /import \{ depleteForSale, reverseForSale \} from '\.\.\/lib\/stock\/deplete';/);
});

test('v5.11.92: every deplete.js entry point is a no op that never throws and never reads', async () => {
  const dep = await import('./deplete.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { calls.push(a); throw new Error('no read may happen'); };
  try {
    const check = { id: 'chk-1', items: [{ uid: 'u1', itemId: 'latte', qty: 2, mods: [{ itemId: 'oat', qty: 1 }] }], orderType: 'takeaway', closedAt: Date.now() };
    for (const args of [[check], [null], [undefined], [{}], [{ items: 'rubbish' }]]) {
      assert.equal(await dep.depleteForSale(...args), undefined);
      assert.equal(await dep.depleteForSaleServer(...args), undefined);
    }
    assert.equal(await dep.reverseForSale(check, [{ itemId: 'latte', refundQty: 1 }], 'r1'), undefined);
    assert.equal(await dep.reverseForSale(null, null, null), undefined);
    assert.equal(await dep.reverseForSale(), undefined);
    assert.equal(dep.invalidateVenueMode(), undefined);
    assert.equal(dep.invalidateDepletionCtx(), undefined);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 0, 'nothing was fetched');
  // saleTimeOf stays pure
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(dep.saleTimeOf({ closedAt: now - 60000 }, now), '2026-10-19T11:59:00.000Z');
  assert.equal(dep.saleTimeOf({ closedAt: now + 3600000 }, now), null);
});

test('v5.11.79: the kiosk and online browser stock calls are gone (the database books those checks)', () => {
  const dep = read('./deplete.js');
  // the kiosk's fingerprinted submitOrder still calls it, so it stays exported, and does nothing
  const fn = dep.slice(dep.indexOf('export async function depleteForSaleServer('));
  assert.match(fn, /^export async function depleteForSaleServer\(_check, _opts = \{\}\) \{ \/\* the database books every channel's checks \*\/ \}/);
  assert.doesNotMatch(dep, /functions\.invoke\('stock-deplete'/, 'no browser call to the stock-deplete function');
  const online = read('../../surfaces/online/OnlineCheckout.jsx');
  assert.doesNotMatch(online, /depleteForSaleServer/, 'online checkout makes no stock call of its own');
  assert.equal((online.match(/v5\.11\.79: no browser stock call/g) || []).length, 2, 'both placement paths say why');
});

test('the data layer exposes the three RPCs by their migration names', () => {
  const src = read('./data.js');
  assert.match(src, /supabase\.rpc\('stock_venue_mode', \{ p_location_id: locationId \}\)/);
  assert.match(src, /supabase\.rpc\('stock_outbox_health', \{ p_location_id: locationId \}\)/);
  assert.match(src, /supabase\.rpc\('stock_outbox_release', \{ p_id: Number\(id\) \}\)/);
});

test('the trading report sums signed stock values, so a refund reversal comes OFF recipe COGS', () => {
  // v5.11.99 (Reports align): the loop moved to _shared/tradingSales.js ledgerDays, which the report calls.
  const src = read('../../../supabase/functions/trading-report/index.ts');
  assert.match(src, /const ledger = ledgerDays\(\{ movements: mv, dayOf \}\);/);
  const shared = read('../../../supabase/functions/_shared/tradingSales.js');
  const i = shared.indexOf('export function ledgerDays');
  const block = shared.slice(i, shared.indexOf('return { cogs, waste, demoLeft };', i));
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

test('the changelog keeps the 5.11.77 entry', async () => {
  // v5.11.79 is on top now (the stock safety pass, 20261019b); 5.11.77's own words stay as shipped.
  const { CHANGELOG } = await import('../changelog.js');
  const e = CHANGELOG.find((x) => x.v === '5.11.77');
  assert.ok(e, 'the 5.11.77 entry is there');
  assert.ok(e.items.some((t) => /20261018c/.test(t)), 'the changelog names the database update');
  assert.ok(e.items.some((t) => /Nothing changes at any venue until ServOS switches it on/.test(t)), 'and says what 5.11.77 shipped');
  for (const t of e.items) assert.doesNotMatch(t, /[–—]/, 'no dashes as punctuation');
});

test('v5.11.92: the version and the drainer release changelog entry, in plain words', async () => {
  const { VERSION } = await import('../version.js');
  const num = (v) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
  assert.ok(num(VERSION) >= num('5.11.92'), `version ${VERSION} is at least 5.11.92`);
  const { CHANGELOG } = await import('../changelog.js');
  const e = CHANGELOG.find((x) => x.v === '5.11.92');
  assert.ok(e, 'the 5.11.92 entry is there');
  const all = e.items.join(' ');
  assert.match(all, /20261023a/, 'names the database update');
  assert.match(all, /The till no longer takes stock off itself at any venue/, 'the retired till path');
  assert.match(all, /stock-deplete function now only answers that it is retired/, 'the retired edge path');
  assert.match(all, /each discount now has a Kind/, 'the Kind on Discounts');
  assert.match(all, /stock-deplete and stock-nightly edge function deploys, which Peter runs/, 'who runs the SQL and the deploys');
  for (const t of e.items) assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes as punctuation');
});
