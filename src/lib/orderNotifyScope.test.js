/**
 * orderNotifyScope.test.js: order texts must reach the right venue's customer when two
 * venues hold the same order ref (finding F13).
 * Run: `npm test`. No database needed.
 *
 * Covers supabase/functions/_shared/orderNotifyScope.js (the pure half of order-notify),
 * static checks on supabase/functions/order-notify/index.ts, and static checks on
 * supabase/migrations/20260915_OPS_order_notify_by_location.sql.
 *
 * The rule these protect: a payload WITH location_id is scoped to that venue in every read,
 * claim and ledger row; a payload WITHOUT it (the trigger before the migration runs) behaves
 * exactly as the function always has.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  parseNotifyPayload, scopeToOrder, scopeToOtherVenues, ledgerClaimFor, isMissingTableError,
  legacyLedgerBlocks, legacyRowOwnedElsewhere, stampColumnFor,
  LEGACY_LEDGER_TABLE, LEDGER_TABLE, LEGACY_LEDGER_SKEW_MS, LEGACY_READY_WINDOW_MS,
} from '../../supabase/functions/_shared/orderNotifyScope.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const fnSrc = read('../../supabase/functions/order-notify/index.ts');
const sql = read('../../supabase/migrations/20260915_OPS_order_notify_by_location.sql');
const lower = sql.toLowerCase();

// ── A fake PostgREST holding R12 at two venues (live key: (location_id, ref)) ────────────────
const ROWS = [
  { location_id: 'venue-a', ref: 'R12', source: 'kiosk', created_at: '2026-09-14T12:00:00Z' },
  { location_id: 'venue-b', ref: 'R12', source: 'kiosk', created_at: '2026-09-14T12:05:00Z' },
  { location_id: 'venue-c', ref: 'R7', source: 'pos', created_at: '2026-09-14T12:06:00Z' },
];
function fakeDb() {
  const urls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    urls.push(u.pathname + u.search);
    let out = ROWS;
    for (const [k, v] of u.searchParams) {
      if (v.startsWith('eq.')) out = out.filter((r) => String(r[k]) === v.slice(3));
      if (v.startsWith('neq.')) out = out.filter((r) => String(r[k]) !== v.slice(4));
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const db = createClient('http://fake.local', 'fake-key', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { db, urls };
}

// ── parseNotifyPayload ───────────────────────────────────────────────────────────────────────
test('an old trigger payload (no location_id) parses with locationId null', () => {
  assert.deepEqual(parseNotifyPayload({ ref: ' R12 ', event: 'confirmed' }), { ref: 'R12', event: 'confirmed', locationId: null });
});

test('a new trigger payload carries the venue', () => {
  assert.deepEqual(
    parseNotifyPayload({ ref: 'R12', event: 'ready', location_id: 'venue-b' }),
    { ref: 'R12', event: 'ready', locationId: 'venue-b' },
  );
});

test('an empty or null location_id is treated as absent, never as a venue', () => {
  assert.equal(parseNotifyPayload({ ref: 'R12', event: 'ready', location_id: '' }).locationId, null);
  assert.equal(parseNotifyPayload({ ref: 'R12', event: 'ready', location_id: '   ' }).locationId, null);
  assert.equal(parseNotifyPayload({ ref: 'R12', event: 'ready', location_id: null }).locationId, null);
});

test('ref and a known event are still required, as before', () => {
  assert.deepEqual(parseNotifyPayload({ event: 'confirmed' }), { error: 'ref + event required' });
  assert.deepEqual(parseNotifyPayload({ ref: 'R12', event: 'shipped' }), { error: 'ref + event required' });
  assert.deepEqual(parseNotifyPayload(null), { error: 'ref + event required' });
});

// ── scopeToOrder ────────────────────────────────────────────────────────────────────────────
function recorder() {
  const calls = [];
  const b = {
    eq: (col, val) => { calls.push([col, val]); return b; },
    neq: (col, val) => { calls.push(['not ' + col, val]); return b; },
  };
  return { b, calls };
}

test('without a location the filter is exactly today\'s .eq(ref)', () => {
  const { b, calls } = recorder();
  scopeToOrder(b, { ref: 'R12', event: 'confirmed', locationId: null });
  assert.deepEqual(calls, [['ref', 'R12']]);
});

test('with a location the filter is location and ref', () => {
  const { b, calls } = recorder();
  scopeToOrder(b, { ref: 'R12', event: 'confirmed', locationId: 'venue-b' });
  assert.deepEqual(calls, [['location_id', 'venue-b'], ['ref', 'R12']]);
});

// ── The defect and the fix, through the real supabase-js client ─────────────────────────────
test('PROOF: today\'s unscoped maybeSingle over a shared ref returns no order (text dropped as "order gone")', async () => {
  const { db } = fakeDb();
  const { data, error } = await db.from('order_queue').select('*').eq('ref', 'R12').maybeSingle();
  assert.equal(data, null);
  assert.equal(error?.code, 'PGRST116');
});

test('FIX: the scoped load finds exactly the venue\'s order', async () => {
  const { db } = fakeDb();
  const target = parseNotifyPayload({ ref: 'R12', event: 'confirmed', location_id: 'venue-b' });
  const { data, error } = await scopeToOrder(db.from('order_queue').select('*'), target).maybeSingle();
  assert.equal(error, null);
  assert.equal(data.location_id, 'venue-b');
});

test('an old payload sends the byte-identical request the function sends today', async () => {
  const { db, urls } = fakeDb();
  await db.from('order_queue').select('*').eq('ref', 'R7').maybeSingle();
  const target = parseNotifyPayload({ ref: 'R7', event: 'confirmed' });
  const r = await scopeToOrder(db.from('order_queue').select('*'), target).maybeSingle();
  assert.equal(urls[1], urls[0]);
  assert.equal(r.data.location_id, 'venue-c');
});

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────
// Simulates ON CONFLICT (cols) DO NOTHING RETURNING: a claim returns 1 row once per key.
function ledgerSim() {
  const keys = new Set();
  return (claim) => {
    const key = claim.table + '|' + claim.onConflict.split(',').map((c) => claim.row[c]).join('|');
    if (keys.has(key)) return [];
    keys.add(key);
    return [claim.row];
  };
}

test('PROOF: the (ref, event) ledger blocks the second venue\'s text', () => {
  const claim = ledgerSim();
  assert.equal(claim(ledgerClaimFor({ ref: 'R12', event: 'confirmed', locationId: null })).length, 1);
  assert.equal(claim(ledgerClaimFor({ ref: 'R12', event: 'confirmed', locationId: null })).length, 0);
});

test('FIX: the location ledger lets each venue claim once, and only once', () => {
  const claim = ledgerSim();
  const a = { ref: 'R12', event: 'confirmed', locationId: 'venue-a' };
  const b = { ref: 'R12', event: 'confirmed', locationId: 'venue-b' };
  assert.equal(claim(ledgerClaimFor(a)).length, 1);
  assert.equal(claim(ledgerClaimFor(b)).length, 1);
  assert.equal(claim(ledgerClaimFor(a)).length, 0, 'a replay for venue A is still refused');
  assert.equal(claim(ledgerClaimFor({ ...b, event: 'ready' })).length, 1, 'ready is its own event');
});

test('ledger claim shapes: legacy without a location, per venue with one', () => {
  assert.deepEqual(ledgerClaimFor({ ref: 'R12', event: 'ready', locationId: null }), {
    table: LEGACY_LEDGER_TABLE, row: { ref: 'R12', event: 'ready' }, onConflict: 'ref,event',
  });
  assert.deepEqual(ledgerClaimFor({ ref: 'R12', event: 'ready', locationId: 'venue-a' }), {
    table: LEDGER_TABLE, row: { location_id: 'venue-a', ref: 'R12', event: 'ready' }, onConflict: 'location_id,ref,event',
  });
  assert.equal(LEGACY_LEDGER_TABLE, 'order_notifications');
  assert.equal(LEDGER_TABLE, 'order_notify_ledger');
});

test('missing table errors are recognised, other errors are not', () => {
  assert.equal(isMissingTableError({ code: '42P01' }), true);
  assert.equal(isMissingTableError({ code: 'PGRST205' }), true);
  assert.equal(isMissingTableError({ code: '23505' }), false);
  assert.equal(isMissingTableError(null), false);
});

// ── legacyLedgerBlocks: texts sent before the location ledger existed ───────────────────────
const SENT = '2026-09-14T12:00:10Z';
const at = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

test('no legacy row, or no legacy table: not blocked', () => {
  assert.equal(legacyLedgerBlocks({ data: null, error: null }, SENT), false);
  assert.equal(legacyLedgerBlocks({ data: null, error: { code: 'PGRST205' } }, SENT), false);
});

test('any other legacy read error blocks (never risk a double text)', () => {
  assert.equal(legacyLedgerBlocks({ data: null, error: { code: '57014' } }, SENT), true);
});

test('the same order (created before the legacy text) is blocked, including a replay', () => {
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, '2026-09-14T12:00:00Z'), true);
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, '2026-09-07T12:00:00Z'), true);
});

test('a device clock running ahead (within the allowance) is still the same order', () => {
  assert.equal(LEGACY_LEDGER_SKEW_MS, 5 * 60 * 1000, 'the allowance is a few minutes, not an hour');
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, at(SENT, 4 * 60 * 1000)), true);
});

test('another venue\'s later order with the same ref is NOT blocked', () => {
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, at(SENT, LEGACY_LEDGER_SKEW_MS + 1000)), false);
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, '2026-09-20T09:00:00Z'), false);
});

test('an order with no readable created_at is blocked when a legacy row exists (today\'s behaviour)', () => {
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, null), true);
  assert.equal(legacyLedgerBlocks({ data: { sent_at: SENT }, error: null }, 'not a date'), true);
});

// ── Legacy rows that belong to another venue (review finding, 14 Sep 2026) ─────────────────
// Venue A's R1100 was texted on the old (ref, event) ledger. Venue B issues R1100 too.
const A_SENT = '2026-09-15T12:00:00Z';
const A_READY_SENT = '2026-09-15T12:20:00Z';
const legacyRow = (sentAt) => ({ data: { sent_at: sentAt }, error: null });

test('PROBE 1: B confirmed 30 min after A\'s legacy text is no longer blocked (it was with the 1 hour allowance)', () => {
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), '2026-09-15T12:30:00Z', { event: 'confirmed' }), false);
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), '2026-09-15T12:30:00Z', { event: 'confirmed', otherVenueRows: [] }), false);
});

test('PROBE 1b: B confirmed 3 min after A is not blocked when A\'s order accounts for the legacy row', () => {
  const bCreated = '2026-09-15T12:03:00Z';
  const aStamped = { location_id: 'venue-a', created_at: '2026-09-15T11:59:59.662Z', notify_confirmed_at: '2026-09-15T12:00:00.054Z', notify_ready_at: null };
  const aNoContact = { location_id: 'venue-a', created_at: '2026-09-15T11:59:59.662Z', notify_confirmed_at: null, notify_ready_at: null };
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), bCreated, { event: 'confirmed', otherVenueRows: [aStamped] }), false);
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), bCreated, { event: 'confirmed', otherVenueRows: [aNoContact] }), false);
  // No other venue's order left to account for it: the time rule stands (a possible replay).
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), bCreated, { event: 'confirmed', otherVenueRows: [] }), true);
});

test('PROBE 2: B\'s ready, placed before A\'s legacy ready text, is not blocked when A\'s order accounts for it', () => {
  const bCreated = '2026-09-15T11:50:00Z';
  const aStamped = { location_id: 'venue-a', created_at: '2026-09-15T12:00:00Z', notify_confirmed_at: null, notify_ready_at: '2026-09-15T12:20:00.031Z' };
  const aNoContact = { location_id: 'venue-a', created_at: '2026-09-15T12:00:00Z', notify_confirmed_at: null, notify_ready_at: null };
  assert.equal(legacyLedgerBlocks(legacyRow(A_READY_SENT), bCreated, { event: 'ready', otherVenueRows: [aStamped] }), false);
  assert.equal(legacyLedgerBlocks(legacyRow(A_READY_SENT), bCreated, { event: 'ready', otherVenueRows: [aNoContact] }), false);
  assert.equal(legacyLedgerBlocks(legacyRow(A_READY_SENT), bCreated, { event: 'ready', otherVenueRows: [] }), true);
});

test('replay guard kept: another venue\'s order that does NOT account for the legacy row never unblocks', () => {
  const replayCreated = '2026-09-15T11:58:00Z';
  // Stamped, but at a different time (texted on its own, later): not the legacy row's order.
  const stampedLater = { location_id: 'venue-a', created_at: '2026-09-15T13:00:00Z', notify_confirmed_at: '2026-09-15T13:00:00Z', notify_ready_at: '2026-09-15T13:30:00Z' };
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), replayCreated, { event: 'confirmed', otherVenueRows: [stampedLater] }), true);
  assert.equal(legacyLedgerBlocks(legacyRow(A_READY_SENT), replayCreated, { event: 'ready', otherVenueRows: [stampedLater] }), true);
  // Unstamped, but placed an hour before a 'confirmed' text, or days before a 'ready' text.
  const hourBefore = { location_id: 'venue-a', created_at: '2026-09-15T11:00:00Z', notify_confirmed_at: null, notify_ready_at: null };
  const daysBefore = { location_id: 'venue-a', created_at: '2026-09-01T12:00:00Z', notify_confirmed_at: null, notify_ready_at: null };
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), replayCreated, { event: 'confirmed', otherVenueRows: [hourBefore] }), true);
  assert.equal(legacyLedgerBlocks(legacyRow(A_READY_SENT), replayCreated, { event: 'ready', otherVenueRows: [daysBefore] }), true);
  // Rows with nothing readable prove nothing.
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), replayCreated, { event: 'confirmed', otherVenueRows: [null, {}, { notify_confirmed_at: 'garbage' }] }), true);
});

test('legacyRowOwnedElsewhere: windows and the stamp column per event', () => {
  assert.equal(stampColumnFor('confirmed'), 'notify_confirmed_at');
  assert.equal(stampColumnFor('ready'), 'notify_ready_at');
  const unstamped = (created) => [{ created_at: created, notify_confirmed_at: null, notify_ready_at: null }];
  assert.equal(legacyRowOwnedElsewhere(A_READY_SENT, 'ready', unstamped(at(A_READY_SENT, -LEGACY_READY_WINDOW_MS + 1000))), true);
  assert.equal(legacyRowOwnedElsewhere(A_READY_SENT, 'ready', unstamped(at(A_READY_SENT, -LEGACY_READY_WINDOW_MS - 1000))), false);
  assert.equal(legacyRowOwnedElsewhere(A_SENT, 'confirmed', unstamped(at(A_SENT, LEGACY_LEDGER_SKEW_MS + 1000))), false);
  // A 'ready' stamp does not account for a 'confirmed' legacy row.
  assert.equal(legacyRowOwnedElsewhere(A_SENT, 'confirmed', [{ created_at: '2026-09-10T00:00:00Z', notify_confirmed_at: null, notify_ready_at: A_SENT }]), false);
  assert.equal(legacyRowOwnedElsewhere('not a date', 'confirmed', unstamped(A_SENT)), false);
  assert.equal(legacyRowOwnedElsewhere(A_SENT, 'confirmed', null), false);
});

test('without an event the other venues are ignored (time rule only)', () => {
  const aStamped = [{ created_at: A_SENT, notify_confirmed_at: A_SENT }];
  assert.equal(legacyLedgerBlocks(legacyRow(A_SENT), '2026-09-15T12:03:00Z', { otherVenueRows: aStamped }), true);
});

test('scopeToOtherVenues reads the ref at every venue but this one', async () => {
  const { b, calls } = recorder();
  scopeToOtherVenues(b, { ref: 'R12', event: 'ready', locationId: 'venue-b' });
  assert.deepEqual(calls, [['ref', 'R12'], ['not location_id', 'venue-b']]);
  const { db } = fakeDb();
  const { data } = await scopeToOtherVenues(db.from('order_queue').select('*'), { ref: 'R12', locationId: 'venue-b' });
  assert.deepEqual(data.map((r) => r.location_id), ['venue-a']);
});

// ── Static: the edge function ───────────────────────────────────────────────────────────────
test('order-notify imports the shared scope helpers', () => {
  assert.match(fnSrc, /from '\.\.\/_shared\/orderNotifyScope\.js'/);
  assert.ok(fnSrc.includes('parseNotifyPayload(body)'));
});

test('order-notify never touches order_queue by ref alone', () => {
  assert.ok(!/from\('order_queue'\)[^;]*?\.eq\('ref', ref\)/s.test(fnSrc), 'no unscoped .eq(ref) on order_queue');
  const scoped = fnSrc.match(/scopeToOrder\(\s*opsAdmin\.from\('order_queue'\)/g) || [];
  assert.equal(scoped.length, 2, 'the load and the claim stamp are both scoped');
});

test('order-notify claims the ledger through ledgerClaimFor, with the missing-table fallback', () => {
  assert.ok(!fnSrc.includes(".from('order_notifications')"), 'no hard-coded (ref, event) ledger claim');
  assert.ok(fnSrc.includes('ledgerClaimFor(target)'));
  assert.ok(fnSrc.includes('isMissingTableError(ledgerRes.error)'));
  assert.ok(fnSrc.includes('legacyLedgerBlocks(legacy, order.created_at, { event, otherVenueRows })'));
});

test('the legacy check runs before the location claim and only for location payloads', () => {
  const legacyAt = fnSrc.indexOf('legacyLedgerBlocks(legacy');
  const claimAt = fnSrc.indexOf('.upsert(claim.row');
  assert.ok(legacyAt > 0 && claimAt > legacyAt);
  const guard = fnSrc.lastIndexOf('if (target.locationId) {', legacyAt);
  assert.ok(guard > 0 && guard < legacyAt);
});

test('the other venues are read only when a legacy row exists, and a failed read falls back to the time rule', () => {
  const guardAt = fnSrc.indexOf('if (!legacy.error && legacy.data?.sent_at) {');
  const readAt = fnSrc.indexOf('scopeToOtherVenues(');
  const blocksAt = fnSrc.indexOf('legacyLedgerBlocks(legacy');
  assert.ok(guardAt > 0 && readAt > guardAt && blocksAt > readAt);
  assert.ok(fnSrc.includes("select('location_id, created_at, notify_confirmed_at, notify_ready_at')"));
  assert.ok(fnSrc.includes('if (!others.error && Array.isArray(others.data)) otherVenueRows = others.data;'));
});

// ── Static: the migration ───────────────────────────────────────────────────────────────────
function triggerBody() {
  const start = lower.indexOf('create or replace function public.tg_order_queue_notify()');
  assert.ok(start >= 0, 'trigger function is defined');
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open, close + 2);
}

test('the trigger sends location_id with ref and event', () => {
  assert.ok(triggerBody().includes("jsonb_build_object('ref', new.ref, 'event', evt, 'location_id', new.location_id)"));
});

test('the trigger keeps the age gate and never fails the order write', () => {
  const body = triggerBody();
  assert.ok(body.includes("coalesce(new.created_at, now()) < now() - interval '6 hours'"));
  assert.match(body, /begin\s+perform net\.http_post\([\s\S]*?\);\s+exception when others then\s+null;\s+end;/);
  assert.ok(body.includes("elsif new.status = 'ready' and coalesce(old.status, '') <> 'ready' then"));
});

test('the ledger is keyed by location, ref and event, and is service role only', () => {
  assert.ok(lower.includes('create table if not exists public.order_notify_ledger'));
  assert.ok(lower.includes('primary key (location_id, ref, event)'));
  assert.ok(lower.includes('alter table public.order_notify_ledger enable row level security;'));
  assert.ok(lower.includes('revoke all on table public.order_notify_ledger from public, anon, authenticated;'));
  assert.ok(!/create policy[^;]*order_notify_ledger/.test(lower), 'no client policies');
});

test('the migration is idempotent and leaves the old ledger and order_queue alone', () => {
  const code = lower.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/alter table\s+(public\.)?order_notifications/.test(code));
  assert.ok(!/alter table\s+(public\.)?order_queue/.test(code));
  assert.ok(!/\bdrop\s+(table|trigger|constraint|column)/.test(code));
  assert.ok(!/\btruncate\b|\bdelete\s+from\b/.test(code));
  assert.ok(code.includes('if not exists'));
  assert.ok(code.includes("to_regclass('public.billing_state') is not null"), 'wrong-database guard');
  assert.ok(code.includes("notify pgrst, 'reload schema';"));
});

test('the migration backfills the per venue ledger from both claim stamps, idempotently', () => {
  const code = lower.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');
  for (const [evt, col] of [['confirmed', 'notify_confirmed_at'], ['ready', 'notify_ready_at']]) {
    const stmt = `insert into public.order_notify_ledger (location_id, ref, event, sent_at) select location_id::text, ref, '${evt}', ${col} from public.order_queue where ${col} is not null and location_id is not null and ref is not null on conflict (location_id, ref, event) do nothing;`;
    assert.ok(code.includes(stmt), 'backfill for ' + evt);
  }
  const tableAt = code.indexOf('create table if not exists public.order_notify_ledger');
  const backfillAt = code.indexOf('insert into public.order_notify_ledger');
  const triggerAt = code.indexOf('create or replace function public.tg_order_queue_notify()');
  assert.ok(tableAt >= 0 && backfillAt > tableAt && triggerAt > backfillAt, 'backfill runs before the trigger sends locations');
});

test('the rollback copies the per venue ledger back before reverting the trigger', () => {
  const rb = sql.slice(sql.indexOf('-- Rollback'), sql.indexOf('set lock_timeout'));
  const flat = rb.replace(/--/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const copyAt = flat.indexOf('insert into public.order_notifications (ref, event, sent_at) select ref, event, min(sent_at) from public.order_notify_ledger group by ref, event on conflict (ref, event) do nothing;');
  const revertAt = flat.indexOf('20260730b_order_notify_replay_guard.sql');
  assert.ok(copyAt > 0 && revertAt > copyAt);
});
