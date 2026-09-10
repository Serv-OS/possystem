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

import * as jsModule from './readerSettings.js';
import {
  DEFAULT_TIP_PRESETS, MAX_TIP_PRESETS, ONLINE_WINDOW_MS, READER_TIPS_KEY, READER_SYNC_KEY, STORE_SETTING_KEYS,
  STATUS_ONLINE, STATUS_NOT_SEEN, STATUS_NOT_ADDED, EVENTS_PATH, PAY_AT_TABLE_TITLE,
  parseTipPresetText, normaliseTipPresets, tipPresetChanges, tipChangeSentence, readReaderTips, readerTipsPatch,
  tipsFromTipConfig, tipsFromGratuities, tipConfigFromTips, buildGratuities, tipsSentence,
  eventUrlWithKey, eventsEndpoint, buildEventUrls, buildNotification, buildPayAtTable, buildStoreSettingsPatches,
  appliedLine, plainAdyenDetail, storeSettingsOutcome, readSyncState, syncStatePatch,
  readerStatus, normaliseSerial, serialFromPoiid, modelFromPoiid, nextReaderName, readerRows, tillSentence,
} from './readerSettings.js';

const NOW = Date.parse('2026-09-10T09:00:00Z');
const SB = 'https://abc.supabase.co';
const PAIR = { user: 'events_user', pass: 'p@ss w0rd' };
const noDashes = (lines) => { for (const l of lines) assert.ok(!/[–—]/.test(String(l)), `no dashes: ${l}`); };

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

test('tipPresetChanges and tipChangeSentence say what the cap and the rounding did, and only that', () => {
  // a fourth choice with the custom amount on is left off, and said so
  const four = tipPresetChanges('5, 10, 15, 20');
  assert.deepEqual(four, { kept: [5, 10, 15], dropped: [20], rounded: [] });
  assert.equal(tipChangeSentence(four), 'Only three fit with a custom amount, so 20% was left off.');
  assert.deepEqual(tipPresetChanges('5, 10, 15, 20').kept, normaliseTipPresets('5, 10, 15, 20'));
  // without the custom amount four fit
  const five = tipPresetChanges('5 10 15 20 25', { allowCustom: false });
  assert.deepEqual(five.dropped, [25]);
  assert.equal(tipChangeSentence(five, { allowCustom: false }), 'Only four fit, so 25% was left off.');
  // rounding is its own sentence, and a rounded value is never called left off
  const round = tipPresetChanges('5, 12.5, 15');
  assert.deepEqual(round, { kept: [5, 13, 15], dropped: [], rounded: [{ from: 12.5, to: 13 }] });
  assert.equal(tipChangeSentence(round), 'Tips are whole percentages, so 12.5 became 13.');
  // duplicates and junk are not news
  assert.equal(tipChangeSentence(tipPresetChanges('10, 10, x, 15')), null);
  assert.equal(tipChangeSentence(null), null);
  noDashes([tipChangeSentence(four), tipChangeSentence(round)]);
});

test('readReaderTips answers the default when nothing is saved or the saved list is empty', () => {
  assert.deepEqual(readReaderTips(null), { percentages: [5, 10, 15], allowCustom: true, enabled: true, source: 'default', syncedAt: null });
  assert.deepEqual(readReaderTips({}), { percentages: [5, 10, 15], allowCustom: true, enabled: true, source: 'default', syncedAt: null });
  assert.deepEqual(readReaderTips({ [READER_TIPS_KEY]: { percentages: [], allow_custom: false } }),
    { percentages: [5, 10, 15], allowCustom: false, enabled: true, source: 'default', syncedAt: null });
  assert.deepEqual([...DEFAULT_TIP_PRESETS], [5, 10, 15]);
  assert.ok(Object.isFrozen(DEFAULT_TIP_PRESETS));
});

test('readReaderTips reads the saved venue tips, the ask for a tip switch included', () => {
  const ps = { tip_on_receipt: { enabled: true }, [READER_TIPS_KEY]: { percentages: [10, 15, 20], allow_custom: false, synced_at: '2026-09-10T08:00:00Z' } };
  assert.deepEqual(readReaderTips(ps), { percentages: [10, 15, 20], allowCustom: false, enabled: true, source: 'saved', syncedAt: '2026-09-10T08:00:00Z' });
  assert.equal(readReaderTips({ [READER_TIPS_KEY]: { percentages: [10], enabled: false } }).enabled, false);
});

test('readerTipsPatch merges onto pos_settings and never wipes other keys', () => {
  const ps = { tip_on_receipt: { enabled: true }, default_receipt_printer_id: 'p1' };
  const out = readerTipsPatch(ps, { percentages: [10, 20], allowCustom: true }, '2026-09-10T09:00:00Z');
  assert.deepEqual(out, {
    tip_on_receipt: { enabled: true }, default_receipt_printer_id: 'p1',
    [READER_TIPS_KEY]: { percentages: [10, 20], allow_custom: true, enabled: true, synced_at: '2026-09-10T09:00:00Z' },
  });
  assert.notEqual(out, ps);
  assert.deepEqual(readerTipsPatch(null, null)[READER_TIPS_KEY], { percentages: [5, 10, 15], allow_custom: true, enabled: true, synced_at: null });
  assert.equal(readerTipsPatch({}, { percentages: [10], enabled: false })[READER_TIPS_KEY].enabled, false);
});

test('tipsFromTipConfig: a reader row saved by the old page is the venue’s tips, in any band spelling', () => {
  assert.deepEqual(tipsFromTipConfig({ enabled: true, percentBands: [10, 12, 15], allowCustom: false }),
    { percentages: [10, 12, 15], allowCustom: false, enabled: true, source: 'readers', syncedAt: null });
  assert.deepEqual(tipsFromTipConfig({ tipping_enabled: true, tip_percentages: [8, 12], allow_custom: true }).percentages, [8, 12]);
  assert.equal(tipsFromTipConfig({ enabled: 'false', percentages: [10] }).enabled, false);
  assert.equal(tipsFromTipConfig({ enabled: true, percentBands: [] }), null);
  assert.equal(tipsFromTipConfig({ enabled: false, tipping_enabled: false }), null);
  assert.equal(tipsFromTipConfig(null), null);
});

test('tipsFromGratuities: the store’s own tip choices, in the venue currency when there is an entry for it', () => {
  const g = [
    { currency: 'EUR', predefinedTipEntries: ['1%'], allowCustomAmount: true },
    { currency: 'GBP', predefinedTipEntries: ['10%', '12%', '15%'], allowCustomAmount: false, usePredefinedTipEntries: true },
  ];
  assert.deepEqual(tipsFromGratuities(g, 'gbp'), { percentages: [10, 12, 15], allowCustom: false, enabled: true, source: 'adyen', syncedAt: null });
  assert.deepEqual(tipsFromGratuities(g, 'USD').percentages, [1]);
  assert.equal(tipsFromGratuities([], 'GBP'), null);
  assert.equal(tipsFromGratuities([{ currency: 'GBP', predefinedTipEntries: [] }], 'GBP'), null);
  assert.equal(tipsFromGratuities(null, 'GBP'), null);
});

test('tipConfigFromTips: the row value terminal-job-create reads, both vocabularies, or an explicit off', () => {
  assert.deepEqual(tipConfigFromTips({ percentages: [10, 15, 20], allowCustom: true, enabled: true }), {
    enabled: true, tipping_enabled: true, percentBands: [10, 15, 20], tip_percentages: [10, 15, 20], allowCustom: true, allow_custom: true,
  });
  const off = tipConfigFromTips({ percentages: [10], allowCustom: false, enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.tipping_enabled, false);
  assert.deepEqual(off.percentBands, [10]);
  // no choices at all never writes an empty band list
  assert.deepEqual(tipConfigFromTips(null).percentBands, [5, 10, 15]);
  // the round trip: a row built here reads back as the same tips
  const tips = { percentages: [10, 12], allowCustom: false, enabled: true };
  assert.deepEqual(tipsFromTipConfig(tipConfigFromTips(tips)), { ...tips, source: 'readers', syncedAt: null });
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

test('the events path and the wake up button title are what Adyen is sent', () => {
  assert.equal(EVENTS_PATH, '/functions/v1/adyen-terminal-events');
  assert.equal(PAY_AT_TABLE_TITLE, 'Pay at table');
});

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
  assert.deepEqual(patches.map((p) => p.skipped), [null, null, null, null]);
  assert.deepEqual(patches[0].body, { nexo: { eventUrls: buildEventUrls(SB, PAIR) } });
  assert.deepEqual(patches[1].body, { nexo: { notification: buildNotification() } });
  assert.deepEqual(patches[2].body, { payAtTable: { enablePayAtTable: true, paymentInstrument: 'Card' } });
  assert.deepEqual(patches[3].body, { gratuities: buildGratuities('GBP', { percentages: [5, 10, 15], allowCustom: true }) });
});

test('buildStoreSettingsPatches marks the event url patch missing with a plain reason, and still builds the rest', () => {
  const noPair = buildStoreSettingsPatches({ supabaseUrl: SB, pair: null, currency: 'GBP' });
  assert.equal(noPair[0].body, null);
  assert.equal(noPair[0].missing, 'ServOS is missing a password, so the reader updates were not set up.');
  assert.ok(noPair[1].body && noPair[2].body && noPair[3].body);
  const noUrl = buildStoreSettingsPatches({ supabaseUrl: '', pair: PAIR, currency: 'GBP' });
  assert.equal(noUrl[0].missing, 'ServOS is missing its own address, so the reader updates were not set up.');
  assert.deepEqual(buildStoreSettingsPatches()[3].body, { gratuities: buildGratuities('GBP', null) });
});

test('buildStoreSettingsPatches never sends tips it was told to skip', () => {
  const kept = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tipsSkip: { text: 'The tip choices Adyen already holds were kept.' } });
  assert.equal(kept[3].body, null);
  assert.deepEqual(kept[3].skipped, { text: 'The tip choices Adyen already holds were kept.', problem: false });
  const unread = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, tipsSkip: { text: 'x', problem: true } });
  assert.equal(unread[3].skipped.problem, true);
  // an empty skip is no skip
  assert.ok(buildStoreSettingsPatches({ tipsSkip: { text: '' } })[3].body);
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

test('storeSettingsOutcome: one fixed plain sentence per problem, Adyen’s own words only in the detail', () => {
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
      'The readers send payment updates to ServOS.',
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
    { key: 'event_url', text: 'Adyen refused the address the readers send updates to. Contact ServOS support.', detail: 'refused (403): the Adyen credential lacks the terminal settings role' },
    { key: 'pay_at_table', text: 'Adyen did not take Pay at table.', detail: 'Invalid paymentInstrument' },
    { key: 'tips', text: 'The tip choices were not sent.', detail: null },
  ]);
  assert.equal(some.at, null);
  // a timeout's raw path and store id stay in the detail, never the sentence
  const slow = storeSettingsOutcome(patches, [{ key: 'tips', ok: false, status: 0, detail: 'Adyen did not answer PATCH /stores/ST3224Z/terminalSettings within 15s' }]);
  const slowTips = slow.errors.find((e) => e.key === 'tips');
  assert.equal(slowTips.text, 'Adyen did not take the tip choices.');
  assert.match(slowTips.detail, /ST3224Z/);
  const missing = storeSettingsOutcome(buildStoreSettingsPatches({ supabaseUrl: SB, pair: null }), [
    { key: 'wakeup_button', ok: true }, { key: 'pay_at_table', ok: true }, { key: 'tips', ok: true },
  ]);
  assert.deepEqual(missing.errors, [{ key: 'event_url', text: 'ServOS is missing a password, so the reader updates were not set up.', detail: null }]);
  assert.equal(missing.applied.length, 3);
  // a skip that keeps Adyen's tips is a plain applied line; a skip that is a problem is an error
  const keptTips = storeSettingsOutcome(buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, tipsSkip: { text: 'The tip choices Adyen already holds were kept.' } }), [
    { key: 'event_url', ok: true }, { key: 'wakeup_button', ok: true }, { key: 'pay_at_table', ok: true },
  ]);
  assert.equal(keptTips.ok, true);
  assert.equal(keptTips.applied[3], 'The tip choices Adyen already holds were kept.');
  const unreadTips = storeSettingsOutcome(buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, tipsSkip: { text: 'The venue settings could not be read, so the tip choices were left as they are.', problem: true } }), [
    { key: 'event_url', ok: true }, { key: 'wakeup_button', ok: true }, { key: 'pay_at_table', ok: true },
  ]);
  assert.equal(unreadTips.ok, false);
  assert.equal(unreadTips.errors[0].key, 'tips');
  const texts = [...all.applied, ...some.errors.map((e) => e.text), ...missing.errors.map((e) => e.text), ...slow.errors.map((e) => e.text)];
  noDashes(texts);
  for (const t of texts) {
    assert.doesNotMatch(t, /\(\d{3}\)|credential|\bST[0-9A-Z]{4,}|\/stores\//, `raw detail in a sentence: ${t}`);
    assert.doesNotMatch(t, /\bwas refused\b|events was|tips on the reader was/i, t);
    assert.ok(t.length < 120, t);
  }
});

test('appliedLine has a plain line for every key', () => {
  for (const k of STORE_SETTING_KEYS) assert.ok(appliedLine(k).length > 8);
  assert.equal(appliedLine('other'), 'other applied.');
});

test('readSyncState and syncStatePatch round trip the last outcome on pos_settings, old string errors included', () => {
  assert.equal(readSyncState(null), null);
  assert.equal(readSyncState({}), null);
  const outcome = { ok: false, applied: ['a'], errors: [{ key: 'tips', text: 'b', detail: 'raw' }], at: '2026-09-10T09:00:00Z' };
  const ps = syncStatePatch({ tip_on_receipt: { enabled: true } }, outcome);
  assert.deepEqual(ps.tip_on_receipt, { enabled: true });
  assert.deepEqual(ps[READER_SYNC_KEY], { at: '2026-09-10T09:00:00Z', ok: false, applied: ['a'], errors: [{ key: 'tips', text: 'b', detail: 'raw' }] });
  assert.deepEqual(readSyncState(ps), { at: '2026-09-10T09:00:00Z', ok: false, applied: ['a'], errors: [{ key: 'tips', text: 'b', detail: 'raw' }] });
  // an outcome saved before 10 Sep 2026 held plain strings
  assert.deepEqual(readSyncState({ [READER_SYNC_KEY]: { at: 'x', ok: false, applied: [], errors: ['old line', '', null] } }).errors, [{ key: null, text: 'old line', detail: null }]);
  assert.deepEqual(syncStatePatch(null, null)[READER_SYNC_KEY], { at: null, ok: false, applied: [], errors: [] });
});

// ── the readers view ─────────────────────────────────────────────────────────

test('readerStatus is online inside five minutes, otherwise not seen recently', () => {
  assert.equal(ONLINE_WINDOW_MS, 300000);
  assert.equal(readerStatus(new Date(NOW - 60_000).toISOString(), NOW), STATUS_ONLINE);
  assert.equal(readerStatus(new Date(NOW - 6 * 60_000).toISOString(), NOW), STATUS_NOT_SEEN);
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

test('TS mirror: every export, function and constant, answers exactly as the JS copy', async (t) => {
  let ts;
  try { ts = await import(TS_MIRROR); }
  catch (e) { t.skip(`this node cannot import the .ts mirror here (${e?.code || e?.message})`); return; }
  // the SAME names on both sides, and every constant the same value
  // (ONLINE_WINDOW_MS, EVENTS_PATH, PAY_AT_TABLE_TITLE and the status words included)
  const jsNames = Object.keys(jsModule).sort();
  const tsNames = Object.keys(ts).filter((k) => typeof ts[k] !== 'undefined').sort();
  assert.deepEqual(tsNames, jsNames, 'the two copies export the same names');
  for (const k of jsNames) {
    if (typeof jsModule[k] !== 'function') assert.deepEqual(ts[k], jsModule[k], `constant ${k}`);
  }
  const tips = { percentages: [12.5, 10, 10, 20, 30], allowCustom: true };
  assert.deepEqual(ts.normaliseTipPresets(tips.percentages), normaliseTipPresets(tips.percentages));
  assert.deepEqual(ts.normaliseTipPresets('5 10 15 20', { allowCustom: false }), normaliseTipPresets('5 10 15 20', { allowCustom: false }));
  for (const text of ['5, 10, 15', '5% 10% 15%', ['10%', 12.5, '15'], '', null, '5,12.5,15,20,20,x']) {
    assert.deepEqual(ts.parseTipPresetText(text), parseTipPresetText(text));
    assert.deepEqual(ts.tipPresetChanges(text), tipPresetChanges(text));
    assert.equal(ts.tipChangeSentence(tipPresetChanges(text)), tipChangeSentence(tipPresetChanges(text)));
  }
  const ps = { tip_on_receipt: { enabled: true }, [READER_TIPS_KEY]: { percentages: [10, 15], allow_custom: false, enabled: false } };
  assert.deepEqual(ts.readReaderTips(ps), readReaderTips(ps));
  assert.deepEqual(ts.readReaderTips(null), readReaderTips(null));
  assert.deepEqual(ts.readerTipsPatch(ps, tips, NOW), readerTipsPatch(ps, tips, NOW));
  for (const tc of [{ enabled: true, percentBands: [10, 12, 15], allowCustom: false }, { tipping_enabled: true, tip_percentages: [8] }, { enabled: false }, null]) {
    assert.deepEqual(ts.tipsFromTipConfig(tc), tipsFromTipConfig(tc));
  }
  const grat = [{ currency: 'GBP', predefinedTipEntries: ['10%', '12%'], allowCustomAmount: false }];
  assert.deepEqual(ts.tipsFromGratuities(grat, 'GBP'), tipsFromGratuities(grat, 'GBP'));
  assert.deepEqual(ts.tipConfigFromTips({ ...tips, enabled: false }), tipConfigFromTips({ ...tips, enabled: false }));
  assert.deepEqual(ts.buildGratuities('USD', tips), buildGratuities('USD', tips));
  assert.equal(ts.tipsSentence(tips), tipsSentence(tips));
  for (const [base, pass] of [['https://x/e', 'p@ss w0rd'], ['https://x/e/', ''], ['', 'p'], ['https://x/e', 'a&b=c?d']]) {
    assert.equal(ts.eventUrlWithKey(base, pass), eventUrlWithKey(base, pass));
  }
  for (const u of [SB, `${SB}///`, '', null]) assert.equal(ts.eventsEndpoint(u), eventsEndpoint(u));
  assert.deepEqual(ts.buildEventUrls(SB, PAIR), buildEventUrls(SB, PAIR));
  for (const title of [undefined, '  ', 'x'.repeat(50), 'Open tables']) assert.deepEqual(ts.buildNotification(title), buildNotification(title));
  assert.deepEqual(ts.buildPayAtTable(), buildPayAtTable());
  assert.deepEqual(ts.buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips }), buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips }));
  assert.deepEqual(ts.buildStoreSettingsPatches({ supabaseUrl: '', pair: null }), buildStoreSettingsPatches({ supabaseUrl: '', pair: null }));
  assert.deepEqual(ts.buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, tipsSkip: { text: 'kept' } }), buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, tipsSkip: { text: 'kept' } }));
  for (const k of [...STORE_SETTING_KEYS, 'other']) assert.equal(ts.appliedLine(k, tips), appliedLine(k, tips));
  const patches = buildStoreSettingsPatches({ supabaseUrl: SB, pair: PAIR, currency: 'GBP', tips });
  // every applied line AND every refusal kind, on every key
  const resultSets = [
    STORE_SETTING_KEYS.map((key) => ({ key, ok: true, status: 200 })),
    [
      { key: 'event_url', ok: false, status: 403, detail: { detail: 'Forbidden' } },
      { key: 'wakeup_button', ok: true, status: 200 },
      { key: 'tips', ok: false, status: 422, detail: { invalidFields: [{ name: 'gratuities', message: 'bad' }] } },
    ],
    [{ key: 'pay_at_table', ok: false, status: 0, detail: 'no answer' }, { key: 'event_url', ok: false, status: 401 }],
  ];
  for (const results of resultSets) {
    assert.deepEqual(ts.storeSettingsOutcome(patches, results, { tips, at: '2026-09-10T09:00:00Z' }), storeSettingsOutcome(patches, results, { tips, at: '2026-09-10T09:00:00Z' }));
  }
  const outcome = storeSettingsOutcome(patches, resultSets[1], { tips, at: '2026-09-10T09:00:00Z' });
  assert.deepEqual(ts.syncStatePatch(ps, outcome), syncStatePatch(ps, outcome));
  assert.deepEqual(ts.readSyncState(syncStatePatch(ps, outcome)), readSyncState(syncStatePatch(ps, outcome)));
  assert.deepEqual(ts.readSyncState({ [READER_SYNC_KEY]: { errors: ['old line'] } }), readSyncState({ [READER_SYNC_KEY]: { errors: ['old line'] } }));
  assert.deepEqual(ts.readerRows({ terminals: TERMINALS, links: LINKS, now: NOW }), readerRows({ terminals: TERMINALS, links: LINKS, now: NOW }));
  assert.equal(ts.nextReaderName(['Reader 1']), nextReaderName(['Reader 1']));
  // the online window on both sides, at its edge
  for (const ago of [30_000, 4 * 60_000, 5 * 60_000, 6 * 60_000, 3 * 3600_000]) {
    const at = new Date(NOW - ago).toISOString();
    assert.equal(ts.readerStatus(at, NOW), readerStatus(at, NOW), `status ${ago}ms ago`);
  }
  for (const d of [{ title: 'T' }, 'raw', { invalidFields: [{ name: 'n' }] }, null]) assert.equal(ts.plainAdyenDetail(d), plainAdyenDetail(d));
  for (const s of [' 0001-6825 4080216 ', '', null]) assert.equal(ts.normaliseSerial(s), normaliseSerial(s));
  for (const p of ['AMS1-000168254080216', 'S1F2L-1234-5678', 'nodash', '']) {
    assert.equal(ts.serialFromPoiid(p), serialFromPoiid(p));
    assert.equal(ts.modelFromPoiid(p), modelFromPoiid(p));
  }
  assert.equal(ts.tillSentence('pos-1', [{ id: 'pos-1', name: 'Bar' }]), tillSentence('pos-1', [{ id: 'pos-1', name: 'Bar' }]));
  assert.equal(ts.tillSentence('pos-9', []), tillSentence('pos-9', []));
});
