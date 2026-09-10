/**
 * readerSettings.test.js: the contract for BOTH copies of the Card readers
 * page helpers, src/lib/payments/readerSettings.js (this one) and
 * supabase/functions/_shared/readerSettings.ts (the Deno copy, which cannot
 * import from src/). When a test here changes, the Deno copy changes with it.
 *
 * Run: `node --test src/lib/payments/readerSettings.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIP_PRESETS, MAX_TIP_PRESETS, ONLINE_WINDOW_MS, READER_TIPS_KEY, READER_SYNC_KEY, STORE_SETTING_KEYS,
  STATUS_ONLINE, STATUS_NOT_SEEN, STATUS_NOT_ADDED,
  parseTipPresetText, normaliseTipPresets, readReaderTips, readerTipsPatch, buildGratuities, tipsSentence,
  eventUrlWithKey, eventsEndpoint, buildEventUrls, buildNotification, buildPayAtTable, buildStoreSettingsPatches,
  appliedLine, plainAdyenDetail, storeSettingsOutcome, readSyncState, syncStatePatch,
  readerStatus, normaliseSerial, serialFromPoiid, modelFromPoiid, nextReaderName, readerRows, tillSentence,
} from './readerSettings.js';

const NOW = Date.parse('2026-09-10T09:00:00Z');
const SB = 'https://abc.supabase.co';
const PAIR = { user: 'events_user', pass: 'p@ss w0rd' };

// ── tips ─────────────────────────────────────────────────────────────────────

test('parseTipPresetText reads text, arrays and percent signs', () => {
  assert.deepEqual(parseTipPresetText('5, 10, 15'), [5, 10, 15]);
  assert.deepEqual(parseTipPresetText('5% 10% 15%'), [5, 10, 15]);
  assert.deepEqual(parseTipPresetText(['10%', 12.5, '15']), [10, 12.5, 15]);
  assert.deepEqual(parseTipPresetText(''), []);
  assert.deepEqual(parseTipPresetText(null), []);
});

test('normaliseTipPresets keeps whole percentages, dedupes, caps at three with custom and four without', () => {
  assert.deepEqual(normaliseTipPresets('5, 10, 15'), [5, 10, 15]);
  assert.deepEqual(normaliseTipPresets([12.5, 12.4, 15]), [13, 12, 15]);   // 12.5 rounds to 13 (Adyen refuses 12.5%)
  assert.deepEqual(normaliseTipPresets([10, 10, 20, 0, -5, 101, 'x']), [10, 20]);
  assert.deepEqual(normaliseTipPresets([5, 10, 15, 20, 25]), [5, 10, 15]);
  assert.deepEqual(normaliseTipPresets([5, 10, 15, 20, 25], { allowCustom: false }), [5, 10, 15, 20]);
  assert.equal(MAX_TIP_PRESETS, 4);
  assert.deepEqual(normaliseTipPresets(undefined), []);
});

test('readReaderTips answers the default when nothing is saved or the saved list is empty', () => {
  assert.deepEqual(readReaderTips(null), { percentages: [5, 10, 15], allowCustom: true, source: 'default', syncedAt: null });
  assert.deepEqual(readReaderTips({}), { percentages: [5, 10, 15], allowCustom: true, source: 'default', syncedAt: null });
  assert.deepEqual(readReaderTips({ [READER_TIPS_KEY]: { percentages: [], allow_custom: false } }),
    { percentages: [5, 10, 15], allowCustom: false, source: 'default', syncedAt: null });
  assert.deepEqual([...DEFAULT_TIP_PRESETS], [5, 10, 15]);
  assert.ok(Object.isFrozen(DEFAULT_TIP_PRESETS));
});

test('readReaderTips reads the saved venue tips', () => {
  const ps = { tip_on_receipt: { enabled: true }, [READER_TIPS_KEY]: { percentages: [10, 15, 20], allow_custom: false, synced_at: '2026-09-10T08:00:00Z' } };
  assert.deepEqual(readReaderTips(ps), { percentages: [10, 15, 20], allowCustom: false, source: 'saved', syncedAt: '2026-09-10T08:00:00Z' });
});

test('readerTipsPatch merges onto pos_settings and never wipes other keys', () => {
  const ps = { tip_on_receipt: { enabled: true }, default_receipt_printer_id: 'p1' };
  const out = readerTipsPatch(ps, { percentages: [10, 20], allowCustom: true }, '2026-09-10T09:00:00Z');
  assert.deepEqual(out, {
    tip_on_receipt: { enabled: true }, default_receipt_printer_id: 'p1',
    [READER_TIPS_KEY]: { percentages: [10, 20], allow_custom: true, synced_at: '2026-09-10T09:00:00Z' },
  });
  assert.notEqual(out, ps);
  assert.deepEqual(readerTipsPatch(null, null)[READER_TIPS_KEY], { percentages: [5, 10, 15], allow_custom: true, synced_at: null });
});

test('buildGratuities is one entry in the venue currency with percent strings', () => {
  assert.deepEqual(buildGratuities('GBP', { percentages: [5, 10, 15], allowCustom: true }), [{
    currency: 'GBP', usePredefinedTipEntries: true, predefinedTipEntries: ['5%', '10%', '15%'], allowCustomAmount: true,
  }]);
  assert.deepEqual(buildGratuities('USD', { percentages: [18, 20, 22, 25], allowCustom: false })[0].predefinedTipEntries, ['18%', '20%', '22%', '25%']);
  assert.equal(buildGratuities('', null)[0].currency, 'GBP');
  assert.deepEqual(buildGratuities('GBP', null)[0].predefinedTipEntries, ['5%', '10%', '15%']);
});

test('tipsSentence is plain words', () => {
  assert.equal(tipsSentence({ percentages: [5, 10, 15], allowCustom: true }), '5%, 10%, 15% and a custom amount');
  assert.equal(tipsSentence({ percentages: [10, 20], allowCustom: false }), '10%, 20%');
  assert.equal(tipsSentence(null), '5%, 10%, 15% and a custom amount');
});

// ── the store settings patches ───────────────────────────────────────────────

test('eventsEndpoint and eventUrlWithKey build the events url with the key encoded', () => {
  assert.equal(eventsEndpoint(SB), 'https://abc.supabase.co/functions/v1/adyen-terminal-events');
  assert.equal(eventsEndpoint(SB + '/'), 'https://abc.supabase.co/functions/v1/adyen-terminal-events');
  assert.equal(eventsEndpoint(''), '');
  assert.equal(eventUrlWithKey('https://x/e', 'p@ss w0rd'), 'https://x/e?k=p%40ss%20w0rd');
  assert.equal(eventUrlWithKey('https://x/e/', ''), 'https://x/e');
  assert.equal(eventUrlWithKey('', 'p'), '');
});

test('buildEventUrls carries explicit username and password and ?k on the url; null without a pair', () => {
  assert.deepEqual(buildEventUrls(SB, PAIR), {
    eventLocalUrls: [],
    eventPublicUrls: [{ url: 'https://abc.supabase.co/functions/v1/adyen-terminal-events?k=p%40ss%20w0rd', username: 'events_user', password: 'p@ss w0rd' }],
  });
  assert.equal(buildEventUrls(SB, null), null);
  assert.equal(buildEventUrls(SB, { user: 'u', pass: '' }), null);
  assert.equal(buildEventUrls('', PAIR), null);
});

test('buildNotification is the Pay at table wake up button with empty details; buildPayAtTable is card only', () => {
  assert.deepEqual(buildNotification(), { enabled: true, showButton: true, title: 'Pay at table', category: 'SaleWakeUp', details: '' });
  assert.equal(buildNotification('  ').title, 'Pay at table');
  assert.equal(buildNotification('x'.repeat(50)).title.length, 40);
  assert.deepEqual(buildPayAtTable(), { enablePayAtTable: true, paymentInstrument: 'Card' });
});

test('buildStoreSettingsPatches is four patches in order, each its own PATCH body', () => {
  const patches = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips: { percentages: [5, 10, 15], allowCustom: true } });
  assert.deepEqual(patches.map((p) => p.key), [...STORE_SETTING_KEYS]);
  assert.deepEqual(patches.map((p) => p.missing), [null, null, null, null]);
  assert.deepEqual(patches[0].body, { nexo: { eventUrls: buildEventUrls(SB, PAIR) } });
  assert.deepEqual(patches[1].body, { nexo: { notification: buildNotification() } });
  assert.deepEqual(patches[2].body, { payAtTable: { enablePayAtTable: true, paymentInstrument: 'Card' } });
  assert.deepEqual(patches[3].body, { gratuities: buildGratuities('GBP', { percentages: [5, 10, 15], allowCustom: true }) });
});

test('buildStoreSettingsPatches marks the event url patch missing with a plain reason, and still builds the rest', () => {
  const noPair = buildStoreSettingsPatches({ supabaseUrl: SB, pair: null, currency: 'GBP' });
  assert.equal(noPair[0].body, null);
  assert.equal(noPair[0].missing, 'The events password for this environment is not set on ServOS.');
  assert.ok(noPair[1].body && noPair[2].body && noPair[3].body);
  const noUrl = buildStoreSettingsPatches({ supabaseUrl: '', pair: PAIR, currency: 'GBP' });
  assert.equal(noUrl[0].missing, 'ServOS does not know its own events address.');
  assert.deepEqual(buildStoreSettingsPatches()[3].body, { gratuities: buildGratuities('GBP', null) });
});

test('plainAdyenDetail picks detail, title, message or error, never a JSON dump', () => {
  assert.equal(plainAdyenDetail({ detail: 'Store not found', title: 'Not found' }), 'Store not found');
  assert.equal(plainAdyenDetail({ title: 'Forbidden' }), 'Forbidden');
  assert.equal(plainAdyenDetail({ message: 'boom' }), 'boom');
  assert.equal(plainAdyenDetail({ invalidFields: [{ name: 'gratuities', message: 'Invalid tip entry' }] }), 'Invalid tip entry');
  assert.equal(plainAdyenDetail('  raw text '), 'raw text');
  assert.equal(plainAdyenDetail({}), 'Adyen refused the change.');
  assert.equal(plainAdyenDetail(null, 'fallback'), 'fallback');
});

test('storeSettingsOutcome gives one plain line per patch and ok only when nothing failed', () => {
  const tips = { percentages: [5, 10, 15], allowCustom: true };
  const patches = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips });
  const all = storeSettingsOutcome(patches, [
    { key: 'event_url', ok: true, status: 200 },
    { key: 'wakeup_button', ok: true, status: 200 },
    { key: 'pay_at_table', ok: true, status: 200 },
    { key: 'tips', ok: true, status: 200 },
  ], { tips, at: '2026-09-10T09:00:00Z' });
  assert.deepEqual(all, {
    ok: true,
    applied: [
      'Reader events go to ServOS.',
      'The Pay at table button is on the reader menu.',
      'Pay at table is on.',
      'Tip choices on the reader: 5%, 10%, 15% and a custom amount.',
    ],
    errors: [],
    at: '2026-09-10T09:00:00Z',
  });
  const some = storeSettingsOutcome(patches, [
    { key: 'event_url', ok: false, status: 403, detail: { detail: 'Forbidden' } },
    { key: 'wakeup_button', ok: true, status: 200 },
    { key: 'pay_at_table', ok: false, status: 422, detail: { detail: 'Invalid paymentInstrument' } },
  ], { tips });
  assert.equal(some.ok, false);
  assert.deepEqual(some.applied, ['The Pay at table button is on the reader menu.']);
  assert.deepEqual(some.errors, [
    'Reader events was refused: the Adyen credential lacks the terminal settings role (403).',
    'Pay at table was refused: Invalid paymentInstrument',
    'Tips on the reader was not sent.',
  ]);
  assert.equal(some.at, null);
  const missing = storeSettingsOutcome(buildStoreSettingsPatches({ supabaseUrl: SB, pair: null }), [
    { key: 'wakeup_button', ok: true }, { key: 'pay_at_table', ok: true }, { key: 'tips', ok: true },
  ]);
  assert.deepEqual(missing.errors, ['Reader events was not sent: The events password for this environment is not set on ServOS.']);
  assert.equal(missing.applied.length, 3);
  for (const line of [...all.applied, ...some.errors, ...missing.errors]) {
    assert.ok(!/[–—]/.test(line), `no dashes: ${line}`);
  }
});

test('appliedLine has a plain line for every key', () => {
  for (const k of STORE_SETTING_KEYS) assert.ok(appliedLine(k).length > 8);
  assert.equal(appliedLine('other'), 'other applied.');
});

test('readSyncState and syncStatePatch round trip the last outcome on pos_settings', () => {
  assert.equal(readSyncState(null), null);
  assert.equal(readSyncState({}), null);
  const outcome = { ok: false, applied: ['a'], errors: ['b'], at: '2026-09-10T09:00:00Z' };
  const ps = syncStatePatch({ tip_on_receipt: { enabled: true } }, outcome);
  assert.deepEqual(ps.tip_on_receipt, { enabled: true });
  assert.deepEqual(ps[READER_SYNC_KEY], { at: '2026-09-10T09:00:00Z', ok: false, applied: ['a'], errors: ['b'] });
  assert.deepEqual(readSyncState(ps), { at: '2026-09-10T09:00:00Z', ok: false, applied: ['a'], errors: ['b'] });
  assert.deepEqual(syncStatePatch(null, null)[READER_SYNC_KEY], { at: null, ok: false, applied: [], errors: [] });
});

// ── the readers view ─────────────────────────────────────────────────────────

test('readerStatus is online inside five minutes, otherwise not seen recently', () => {
  assert.equal(ONLINE_WINDOW_MS, 300000);
  assert.equal(readerStatus(new Date(NOW - 60_000).toISOString(), NOW), STATUS_ONLINE);
  assert.equal(readerStatus(new Date(NOW - ONLINE_WINDOW_MS).toISOString(), NOW), STATUS_NOT_SEEN);
  assert.equal(readerStatus(null, NOW), STATUS_NOT_SEEN);
  assert.equal(readerStatus('garbage', NOW), STATUS_NOT_SEEN);
  assert.equal(STATUS_ONLINE, 'online');
  assert.equal(STATUS_NOT_SEEN, 'not seen recently');
  assert.equal(STATUS_NOT_ADDED, 'not added yet');
});

test('normaliseSerial, serialFromPoiid and modelFromPoiid', () => {
  assert.equal(normaliseSerial(' 0001-6825 4080216 '), '000168254080216');
  assert.equal(serialFromPoiid('AMS1-000168254080216'), '000168254080216');
  assert.equal(serialFromPoiid('S1F2L-1234-5678'), '1234-5678');
  assert.equal(serialFromPoiid('nodash'), 'nodash');
  assert.equal(modelFromPoiid('AMS1-000168254080216'), 'AMS1');
  assert.equal(modelFromPoiid('nodash'), '');
});

test('nextReaderName is the first free Reader N, case insensitive', () => {
  assert.equal(nextReaderName([]), 'Reader 1');
  assert.equal(nextReaderName(['Reader 1', 'reader 2', 'Bar']), 'Reader 3');
  assert.equal(nextReaderName(['Reader 2']), 'Reader 1');
  assert.equal(nextReaderName(null), 'Reader 1');
});

const TERMINALS = [
  { id: 'AMS1-000168254080216', model: 'AMS1', serialNumber: '000168254080216', firmwareVersion: '1.90', lastActivityAt: new Date(NOW - 30_000).toISOString(), assignment: { storeId: 'ST1', status: 'deployed' } },
  { id: 'AMS1-000168254080999', model: 'AMS1', serialNumber: '000168254080999', lastActivityAt: new Date(NOW - 3 * 3600_000).toISOString() },
  { id: 'S1F2L-123', model: 'S1F2L', serialNumber: '123' },
];
const LINKS = [
  { id: 'td-1', label: 'Bar reader', adyen_terminal_id: 'AMS1-000168254080216', bound_pos_device_id: 'pos-1', modes: { pos_dispatch: true }, tip_config: { enabled: true }, idle_screen: null, last_seen_at: null, serial_number: '000168254080216' },
  { id: 'td-2', label: '', adyen_terminal_id: 'AMS1-GONE', bound_pos_device_id: null, modes: null, serial_number: 'GONE' },
  { id: 'td-3', label: 'Skip me', adyen_terminal_id: null },
];

test('readerRows joins the store scoped terminals to the ops rows, keeps a linked reader Adyen no longer lists, and lists the rest as not added', () => {
  const { readers, notAdded } = readerRows({ terminals: TERMINALS, links: LINKS, now: NOW });
  assert.deepEqual(readers.map((r) => r.id), ['td-2', 'td-1']);   // sorted by label; a blank label reads as the POIID
  const bar = readers.find((r) => r.id === 'td-1');
  assert.deepEqual(bar, {
    id: 'td-1', poiid: 'AMS1-000168254080216', label: 'Bar reader', model: 'AMS1', serialNumber: '000168254080216', firmwareVersion: '1.90',
    lastActivityAt: TERMINALS[0].lastActivityAt, status: 'online', onAdyen: true, boundPosDeviceId: 'pos-1',
    modes: { pos_dispatch: true }, tipConfig: { enabled: true }, idleScreen: null, lastSeenAt: null,
  });
  const gone = readers.find((r) => r.id === 'td-2');
  assert.equal(gone.label, 'AMS1-GONE');
  assert.equal(gone.onAdyen, false);
  assert.equal(gone.status, 'not seen recently');
  assert.equal(gone.serialNumber, 'GONE');
  assert.deepEqual(gone.modes, {});
  assert.deepEqual(notAdded, [
    { poiid: 'AMS1-000168254080999', model: 'AMS1', serialNumber: '000168254080999', lastActivityAt: TERMINALS[1].lastActivityAt, status: 'not added yet', seen: 'not seen recently' },
    { poiid: 'S1F2L-123', model: 'S1F2L', serialNumber: '123', lastActivityAt: null, status: 'not added yet', seen: 'not seen recently' },
  ]);
});

test('readerRows tolerates garbage', () => {
  assert.deepEqual(readerRows(), { readers: [], notAdded: [] });
  assert.deepEqual(readerRows({ terminals: 'x', links: [null, 3] }), { readers: [], notAdded: [] });
});

test('tillSentence names the till or says Any till', () => {
  const devices = [{ id: 'pos-1', name: 'Bar till' }, { id: 'pos-2', name: '' }];
  assert.equal(tillSentence(null, devices), 'Any till');
  assert.equal(tillSentence('pos-1', devices), 'Bar till');
  assert.equal(tillSentence('pos-2', devices), 'a till');
  assert.equal(tillSentence('pos-9', devices), 'a till that is no longer here');
});

// ── TS mirror ────────────────────────────────────────────────────────────────

const TS_MIRROR = '../../../supabase/functions/_shared/readerSettings.ts';

test('TS mirror: every builder answers exactly as the JS copy', async (t) => {
  let ts;
  try { ts = await import(TS_MIRROR); }
  catch (e) { t.skip(`this node cannot import the .ts mirror here (${e?.code || e?.message})`); return; }
  const tips = { percentages: [12.5, 10, 10, 20, 30], allowCustom: true };
  assert.deepEqual(ts.normaliseTipPresets(tips.percentages), normaliseTipPresets(tips.percentages));
  assert.deepEqual(ts.normaliseTipPresets('5 10 15 20', { allowCustom: false }), normaliseTipPresets('5 10 15 20', { allowCustom: false }));
  const ps = { tip_on_receipt: { enabled: true }, [READER_TIPS_KEY]: { percentages: [10, 15], allow_custom: false } };
  assert.deepEqual(ts.readReaderTips(ps), readReaderTips(ps));
  assert.deepEqual(ts.readReaderTips(null), readReaderTips(null));
  assert.deepEqual(ts.readerTipsPatch(ps, tips, NOW), readerTipsPatch(ps, tips, NOW));
  assert.deepEqual(ts.buildGratuities('USD', tips), buildGratuities('USD', tips));
  assert.equal(ts.tipsSentence(tips), tipsSentence(tips));
  assert.deepEqual(ts.buildEventUrls(SB, PAIR), buildEventUrls(SB, PAIR));
  assert.deepEqual(ts.buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips }), buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips }));
  assert.deepEqual(ts.buildStoreSettingsPatches({ supabaseUrl: '', pair: null }), buildStoreSettingsPatches({ supabaseUrl: '', pair: null }));
  const patches = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips });
  const results = [
    { key: 'event_url', ok: false, status: 403, detail: { detail: 'Forbidden' } },
    { key: 'wakeup_button', ok: true, status: 200 },
    { key: 'tips', ok: false, status: 422, detail: { invalidFields: [{ name: 'gratuities', message: 'bad' }] } },
  ];
  assert.deepEqual(ts.storeSettingsOutcome(patches, results, { tips, at: '2026-09-10T09:00:00Z' }), storeSettingsOutcome(patches, results, { tips, at: '2026-09-10T09:00:00Z' }));
  const outcome = storeSettingsOutcome(patches, results, { tips, at: '2026-09-10T09:00:00Z' });
  assert.deepEqual(ts.syncStatePatch(ps, outcome), syncStatePatch(ps, outcome));
  assert.deepEqual(ts.readSyncState(syncStatePatch(ps, outcome)), readSyncState(syncStatePatch(ps, outcome)));
  assert.deepEqual(ts.readerRows({ terminals: TERMINALS, links: LINKS, now: NOW }), readerRows({ terminals: TERMINALS, links: LINKS, now: NOW }));
  assert.equal(ts.nextReaderName(['Reader 1']), nextReaderName(['Reader 1']));
  assert.equal(ts.readerStatus(TERMINALS[0].lastActivityAt, NOW), readerStatus(TERMINALS[0].lastActivityAt, NOW));
  assert.equal(ts.plainAdyenDetail({ title: 'T' }), plainAdyenDetail({ title: 'T' }));
  assert.equal(ts.tillSentence('pos-1', [{ id: 'pos-1', name: 'Bar' }]), tillSentence('pos-1', [{ id: 'pos-1', name: 'Bar' }]));
  assert.deepEqual([...ts.STORE_SETTING_KEYS], [...STORE_SETTING_KEYS]);
  assert.equal(ts.READER_SYNC_KEY, READER_SYNC_KEY);
});
