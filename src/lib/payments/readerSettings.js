/**
 * readerSettings.js: the pure half of the Card readers page for Adyen venues
 * (Back Office, Hardware, Card readers). No network, no Supabase, no Deno.
 *
 * MIRROR: supabase/functions/_shared/readerSettings.ts carries the SAME
 * builders (Deno cannot import from src/). Change both or neither.
 * readerSettings.test.js is the contract for both copies, with a parity test.
 *
 * WHAT LIVES HERE (10 Sep 2026):
 *   1. The store settings a venue's readers need, built as the PATCH bodies
 *      adyen-terminal-admin sends to /stores/{storeId}/terminalSettings when a
 *      reader is added (sync_store_settings), one patch per group so a refusal
 *      of one group (event URLs need the Terminal Advanced settings role) never
 *      blocks the others:
 *        nexo.eventUrls      the events endpoint with Basic auth, plus ?k=pass
 *        nexo.notification   the Pay at table wake up button (SaleWakeUp)
 *        payAtTable          enablePayAtTable, paymentInstrument Card
 *        gratuities          the venue's tip presets (whole percentages)
 *      https://docs.adyen.com/api-explorer/Management/3/patch/stores/(storeId)/terminalSettings
 *   2. The readers view: the venue's own readers (GET /terminals?storeIds=)
 *      joined to the ops terminal_devices rows, split into the readers that are
 *      added (a paired ops row) and the ones on the store that are not.
 *   3. The venue level tip settings kept on ops locations.pos_settings under
 *      READER_TIPS_KEY, and the last sync outcome under READER_SYNC_KEY.
 *
 * Adyen facts (research notes, 9 Sep 2026): gratuities take whole percentages
 * only ("12.5%" is refused); at most four presets, or three plus the custom
 * amount option (allowCustomAmount true shows only three); lastActivityAt is
 * absent after 14 days; eventPublicUrls entries carry explicit username and
 * password fields.
 */

export const DEFAULT_TIP_PRESETS = Object.freeze([5, 10, 15]);
export const MAX_TIP_PRESETS = 4;
export const ONLINE_WINDOW_MS = 5 * 60_000;
export const PAY_AT_TABLE_TITLE = 'Pay at table';
export const EVENTS_PATH = '/functions/v1/adyen-terminal-events';
export const READER_TIPS_KEY = 'reader_tips';
export const READER_SYNC_KEY = 'reader_settings_sync';
export const STATUS_ONLINE = 'online';
export const STATUS_NOT_SEEN = 'not seen recently';
export const STATUS_NOT_ADDED = 'not added yet';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v)).trim();

// ── tips ─────────────────────────────────────────────────────────────────────

// "5, 10, 15" or "5% 10% 15%" or [5, 10, 15] to numbers. Order kept.
export function parseTipPresetText(text) {
  if (Array.isArray(text)) return text.map((n) => Number(String(n).replace('%', '').trim()));
  return str(text).split(/[\s,;%]+/).filter(Boolean).map((s) => Number(s));
}

// Whole percentages between 1 and 100, deduped, order kept, capped at four
// (three when a custom amount is allowed, so what Adyen shows is what was
// saved). Anything unusable is dropped; an empty answer means "use the
// default", which readReaderTips applies.
export function normaliseTipPresets(input, { allowCustom = true } = {}) {
  const cap = allowCustom ? MAX_TIP_PRESETS - 1 : MAX_TIP_PRESETS;
  const out = [];
  for (const raw of parseTipPresetText(input)) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;
    if (out.includes(n)) continue;
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

// The venue's saved tip settings off locations.pos_settings, or the default.
export function readReaderTips(posSettings) {
  const saved = isObj(posSettings) && isObj(posSettings[READER_TIPS_KEY]) ? posSettings[READER_TIPS_KEY] : null;
  const allowCustom = saved ? saved.allow_custom !== false : true;
  const percentages = saved ? normaliseTipPresets(saved.percentages, { allowCustom }) : [];
  if (!saved || !percentages.length) {
    return { percentages: [...DEFAULT_TIP_PRESETS], allowCustom: saved ? allowCustom : true, source: 'default', syncedAt: saved?.synced_at ? str(saved.synced_at) : null };
  }
  return { percentages, allowCustom, source: 'saved', syncedAt: saved.synced_at ? str(saved.synced_at) : null };
}

// pos_settings with the tip settings merged in. NEVER wipes other keys: the
// caller reads the current value first (a failed read aborts the save).
export function readerTipsPatch(posSettings, tips, at) {
  const allowCustom = tips?.allowCustom !== false;
  const percentages = normaliseTipPresets(tips?.percentages, { allowCustom });
  return {
    ...(isObj(posSettings) ? posSettings : {}),
    [READER_TIPS_KEY]: {
      percentages: percentages.length ? percentages : [...DEFAULT_TIP_PRESETS],
      allow_custom: allowCustom,
      synced_at: at ? str(at) : null,
    },
  };
}

// The gratuities group of the store settings.
export function buildGratuities(currency, tips) {
  const allowCustom = tips?.allowCustom !== false;
  const pcts = normaliseTipPresets(tips?.percentages, { allowCustom });
  const list = pcts.length ? pcts : [...DEFAULT_TIP_PRESETS];
  return [{
    currency: str(currency) || 'GBP',
    usePredefinedTipEntries: true,
    predefinedTipEntries: list.map((n) => `${n}%`),
    allowCustomAmount: allowCustom,
  }];
}

// One sentence for the tips line: "5%, 10%, 15% and a custom amount".
export function tipsSentence(tips) {
  const allowCustom = tips?.allowCustom !== false;
  const pcts = normaliseTipPresets(tips?.percentages, { allowCustom });
  const list = (pcts.length ? pcts : [...DEFAULT_TIP_PRESETS]).map((n) => `${n}%`).join(', ');
  return allowCustom ? `${list} and a custom amount` : list;
}

// ── the store settings patches ───────────────────────────────────────────────

export function eventUrlWithKey(base, pass) {
  const b = str(base).replace(/\/+$/, '');
  if (!b) return '';
  const p = str(pass);
  return p ? `${b}?k=${encodeURIComponent(p)}` : b;
}

export function eventsEndpoint(supabaseUrl) {
  const b = str(supabaseUrl).replace(/\/+$/, '');
  return b ? `${b}${EVENTS_PATH}` : '';
}

// nexo.eventUrls: our events endpoint with Basic auth, and ?k=pass on the url
// as well (some firmware drops userinfo; the events fn accepts either).
// null when the endpoint or the credential pair is missing.
export function buildEventUrls(supabaseUrl, pair) {
  const endpoint = eventsEndpoint(supabaseUrl);
  const user = str(pair?.user);
  const pass = str(pair?.pass);
  if (!endpoint || !user || !pass) return null;
  return { eventLocalUrls: [], eventPublicUrls: [{ url: eventUrlWithKey(endpoint, pass), username: user, password: pass }] };
}

// nexo.notification: the Pay at table button on the reader menu. Empty
// details means the button fires the SaleWakeUp event straight away and the
// responder answers with the open tables menu.
export function buildNotification(title = PAY_AT_TABLE_TITLE) {
  return { enabled: true, showButton: true, title: str(title).slice(0, 40) || PAY_AT_TABLE_TITLE, category: 'SaleWakeUp', details: '' };
}

export function buildPayAtTable() {
  return { enablePayAtTable: true, paymentInstrument: 'Card' };
}

export const STORE_SETTING_KEYS = Object.freeze(['event_url', 'wakeup_button', 'pay_at_table', 'tips']);

// The four patches, in order. A patch that cannot be built carries `missing`
// (one plain sentence) and a null body; the caller reports it and moves on.
export function buildStoreSettingsPatches({ supabaseUrl, pair, currency, tips } = {}) {
  const eventUrls = buildEventUrls(supabaseUrl, pair);
  const eventPatch = eventUrls
    ? { key: 'event_url', label: 'Reader events', body: { nexo: { eventUrls } }, missing: null }
    : { key: 'event_url', label: 'Reader events', body: null, missing: !eventsEndpoint(supabaseUrl) ? 'ServOS does not know its own events address.' : 'The events password for this environment is not set on ServOS.' };
  return [
    eventPatch,
    { key: 'wakeup_button', label: 'Pay at table button', body: { nexo: { notification: buildNotification() } }, missing: null },
    { key: 'pay_at_table', label: 'Pay at table', body: { payAtTable: buildPayAtTable() }, missing: null },
    { key: 'tips', label: 'Tips on the reader', body: { gratuities: buildGratuities(currency, tips) }, missing: null },
  ];
}

// The plain line for an applied patch.
export function appliedLine(key, tips) {
  switch (key) {
    case 'event_url': return 'Reader events go to ServOS.';
    case 'wakeup_button': return 'The Pay at table button is on the reader menu.';
    case 'pay_at_table': return 'Pay at table is on.';
    case 'tips': return `Tip choices on the reader: ${tipsSentence(tips)}.`;
    default: return `${key} applied.`;
  }
}

// An Adyen refusal as one plain string: RFC 7807 detail, then title, then a
// message, then the fallback. Never a JSON dump.
export function plainAdyenDetail(data, fallback = 'Adyen refused the change.') {
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
  if (isObj(data)) {
    for (const k of ['detail', 'title', 'message', 'error']) {
      const v = data[k];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    }
    if (Array.isArray(data.invalidFields) && data.invalidFields.length) {
      const f = data.invalidFields[0];
      if (isObj(f) && (f.message || f.name)) return str(f.message || f.name).slice(0, 300);
    }
  }
  return fallback;
}

// The outcome of sending the patches: { ok, applied, errors, at }, one plain
// line per patch. `results` is [{ key, ok, status, detail }] for the patches
// that were sent; a patch with `missing` is an error line without a result;
// a patch with no result at all is "not sent".
export function storeSettingsOutcome(patches, results, { tips, at } = {}) {
  const byKey = new Map((Array.isArray(results) ? results : []).filter(isObj).map((r) => [str(r.key), r]));
  const applied = [];
  const errors = [];
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!isObj(p)) continue;
    if (p.missing) { errors.push(`${p.label} was not sent: ${p.missing}`); continue; }
    const r = byKey.get(str(p.key));
    if (!r) { errors.push(`${p.label} was not sent.`); continue; }
    if (r.ok) applied.push(appliedLine(str(p.key), tips));
    else if (r.status === 401 || r.status === 403) errors.push(`${p.label} was refused: the Adyen credential lacks the terminal settings role (${r.status}).`);
    else errors.push(`${p.label} was refused: ${plainAdyenDetail(r.detail, `Adyen answered ${r.status || 'with an error'}`)}`);
  }
  return { ok: errors.length === 0, applied, errors, at: at ? str(at) : null };
}

// The last sync outcome off locations.pos_settings, or null.
export function readSyncState(posSettings) {
  const s = isObj(posSettings) && isObj(posSettings[READER_SYNC_KEY]) ? posSettings[READER_SYNC_KEY] : null;
  if (!s) return null;
  return {
    at: s.at ? str(s.at) : null,
    ok: s.ok === true,
    applied: Array.isArray(s.applied) ? s.applied.map(str).filter(Boolean) : [],
    errors: Array.isArray(s.errors) ? s.errors.map(str).filter(Boolean) : [],
  };
}

export function syncStatePatch(posSettings, outcome) {
  return {
    ...(isObj(posSettings) ? posSettings : {}),
    [READER_SYNC_KEY]: {
      at: outcome?.at ? str(outcome.at) : null,
      ok: outcome?.ok === true,
      applied: Array.isArray(outcome?.applied) ? outcome.applied.map(str) : [],
      errors: Array.isArray(outcome?.errors) ? outcome.errors.map(str) : [],
    },
  };
}

// ── the readers view ─────────────────────────────────────────────────────────

export function readerStatus(lastActivityAt, now = Date.now()) {
  const t = lastActivityAt ? new Date(lastActivityAt).getTime() : NaN;
  return Number.isFinite(t) && now - t < ONLINE_WINDOW_MS ? STATUS_ONLINE : STATUS_NOT_SEEN;
}

export function normaliseSerial(text) {
  return str(text).replace(/[^a-zA-Z0-9]/g, '');
}

// The serial part of a POIID (AMS1-000168254080216 has model then serial).
export function serialFromPoiid(poiid) {
  const p = str(poiid);
  return p.includes('-') ? p.split('-').slice(1).join('-') : p;
}

export function modelFromPoiid(poiid) {
  const p = str(poiid);
  return p.includes('-') ? p.split('-')[0] : '';
}

// A friendly default name that no reader here has yet: Reader 1, Reader 2...
export function nextReaderName(labels) {
  const taken = new Set((Array.isArray(labels) ? labels : []).map((l) => str(l).toLowerCase()));
  for (let n = 1; n < 1000; n++) {
    const name = `Reader ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `Reader ${Date.now() % 100000}`;
}

// The venue's readers: Adyen's store scoped terminal list joined to the ops
// link rows on the POIID. `readers` are the rows the till can use (a paired
// ops row, listed even when Adyen no longer shows the terminal on the store,
// so a reader is never lost from the page); `notAdded` are terminals on the
// store with no ops row yet.
export function readerRows({ terminals, links, now = Date.now() } = {}) {
  const terms = (Array.isArray(terminals) ? terminals : []).filter(isObj);
  const byPoiid = new Map(terms.map((t) => [str(t.id), t]));
  const linked = new Set();
  const readers = [];
  for (const l of (Array.isArray(links) ? links : []).filter(isObj)) {
    const poiid = str(l.adyen_terminal_id);
    if (!poiid) continue;
    linked.add(poiid);
    const t = byPoiid.get(poiid) || null;
    const lastActivityAt = t?.lastActivityAt ? str(t.lastActivityAt) : null;
    readers.push({
      id: str(l.id),
      poiid,
      label: str(l.label) || poiid,
      model: str(t?.model) || modelFromPoiid(poiid),
      serialNumber: str(t?.serialNumber) || str(l.serial_number) || serialFromPoiid(poiid),
      firmwareVersion: t?.firmwareVersion ? str(t.firmwareVersion) : null,
      lastActivityAt,
      status: readerStatus(lastActivityAt, now),
      onAdyen: !!t,
      boundPosDeviceId: l.bound_pos_device_id ? str(l.bound_pos_device_id) : null,
      modes: isObj(l.modes) ? l.modes : {},
      tipConfig: isObj(l.tip_config) ? l.tip_config : null,
      idleScreen: isObj(l.idle_screen) ? l.idle_screen : null,
      lastSeenAt: l.last_seen_at ? str(l.last_seen_at) : null,
    });
  }
  readers.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const notAdded = terms
    .filter((t) => str(t.id) && !linked.has(str(t.id)))
    .map((t) => {
      const poiid = str(t.id);
      const lastActivityAt = t.lastActivityAt ? str(t.lastActivityAt) : null;
      return {
        poiid,
        model: str(t.model) || modelFromPoiid(poiid),
        serialNumber: str(t.serialNumber) || serialFromPoiid(poiid),
        lastActivityAt,
        status: STATUS_NOT_ADDED,
        seen: readerStatus(lastActivityAt, now),
      };
    })
    .sort((a, b) => a.poiid.localeCompare(b.poiid));
  return { readers, notAdded };
}

// The page's "Sends payments from" words for a reader.
export function tillSentence(boundPosDeviceId, devices) {
  if (!boundPosDeviceId) return 'Any till';
  const d = (Array.isArray(devices) ? devices : []).find((x) => isObj(x) && str(x.id) === str(boundPosDeviceId));
  return d ? (str(d.name) || 'a till') : 'a till that is no longer here';
}
