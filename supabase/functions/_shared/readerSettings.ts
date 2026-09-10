// supabase/functions/_shared/readerSettings.ts
//
// The pure half of the Card readers page for Adyen venues: the store settings
// PATCH bodies adyen-terminal-admin sends when a reader is added
// (sync_store_settings), the readers view (store scoped terminals joined to
// the ops link rows), and the venue level tip settings kept on ops
// locations.pos_settings. PURE: no Deno APIs, no Supabase, no network.
//
// MIRROR: src/lib/payments/readerSettings.js carries the SAME builders (Deno
// cannot import from src/). Change both or neither.
// src/lib/payments/readerSettings.test.js is the contract for both copies.
//
// Adyen facts (research notes, 9 Sep 2026): gratuities take whole percentages
// only; at most four presets, or three plus the custom amount option;
// lastActivityAt is absent after 14 days; eventPublicUrls entries carry
// explicit username and password fields.
// https://docs.adyen.com/api-explorer/Management/3/patch/stores/(storeId)/terminalSettings

export const DEFAULT_TIP_PRESETS: readonly number[] = Object.freeze([5, 10, 15]);
export const MAX_TIP_PRESETS = 4;
export const ONLINE_WINDOW_MS = 5 * 60_000;
export const PAY_AT_TABLE_TITLE = 'Pay at table';
export const EVENTS_PATH = '/functions/v1/adyen-terminal-events';
export const READER_TIPS_KEY = 'reader_tips';
export const READER_SYNC_KEY = 'reader_settings_sync';
export const STATUS_ONLINE = 'online';
export const STATUS_NOT_SEEN = 'not seen recently';
export const STATUS_NOT_ADDED = 'not added yet';

type Dict = Record<string, unknown>;

const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (v == null ? '' : String(v)).trim();

export interface ReaderTips { percentages: number[]; allowCustom: boolean; source?: 'saved' | 'default'; syncedAt?: string | null }
export interface AuthPair { user?: unknown; pass?: unknown }
export interface StorePatch { key: string; label: string; body: Dict | null; missing: string | null }
export interface PatchResult { key: string; ok: boolean; status?: number; detail?: unknown }
export interface StoreSettingsOutcome { ok: boolean; applied: string[]; errors: string[]; at: string | null }
export interface ReaderRow {
  id: string; poiid: string; label: string; model: string; serialNumber: string; firmwareVersion: string | null;
  lastActivityAt: string | null; status: string; onAdyen: boolean; boundPosDeviceId: string | null;
  modes: Dict; tipConfig: Dict | null; idleScreen: Dict | null; lastSeenAt: string | null;
}
export interface NotAddedRow { poiid: string; model: string; serialNumber: string; lastActivityAt: string | null; status: string; seen: string }

// ── tips ─────────────────────────────────────────────────────────────────────

export function parseTipPresetText(text: unknown): number[] {
  if (Array.isArray(text)) return text.map((n) => Number(String(n).replace('%', '').trim()));
  return str(text).split(/[\s,;%]+/).filter(Boolean).map((s) => Number(s));
}

export function normaliseTipPresets(input: unknown, { allowCustom = true }: { allowCustom?: boolean } = {}): number[] {
  const cap = allowCustom ? MAX_TIP_PRESETS - 1 : MAX_TIP_PRESETS;
  const out: number[] = [];
  for (const raw of parseTipPresetText(input)) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;
    if (out.includes(n)) continue;
    out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

export function readReaderTips(posSettings: unknown): ReaderTips {
  const saved = isObj(posSettings) && isObj(posSettings[READER_TIPS_KEY]) ? posSettings[READER_TIPS_KEY] : null;
  const allowCustom = saved ? saved.allow_custom !== false : true;
  const percentages = saved ? normaliseTipPresets(saved.percentages, { allowCustom }) : [];
  if (!saved || !percentages.length) {
    return { percentages: [...DEFAULT_TIP_PRESETS], allowCustom: saved ? allowCustom : true, source: 'default', syncedAt: saved?.synced_at ? str(saved.synced_at) : null };
  }
  return { percentages, allowCustom, source: 'saved', syncedAt: saved.synced_at ? str(saved.synced_at) : null };
}

export function readerTipsPatch(posSettings: unknown, tips: Partial<ReaderTips> | null | undefined, at?: unknown): Dict {
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

export function buildGratuities(currency: unknown, tips: Partial<ReaderTips> | null | undefined): Dict[] {
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

export function tipsSentence(tips: Partial<ReaderTips> | null | undefined): string {
  const allowCustom = tips?.allowCustom !== false;
  const pcts = normaliseTipPresets(tips?.percentages, { allowCustom });
  const list = (pcts.length ? pcts : [...DEFAULT_TIP_PRESETS]).map((n) => `${n}%`).join(', ');
  return allowCustom ? `${list} and a custom amount` : list;
}

// ── the store settings patches ───────────────────────────────────────────────

export function eventUrlWithKey(base: unknown, pass: unknown): string {
  const b = str(base).replace(/\/+$/, '');
  if (!b) return '';
  const p = str(pass);
  return p ? `${b}?k=${encodeURIComponent(p)}` : b;
}

export function eventsEndpoint(supabaseUrl: unknown): string {
  const b = str(supabaseUrl).replace(/\/+$/, '');
  return b ? `${b}${EVENTS_PATH}` : '';
}

export function buildEventUrls(supabaseUrl: unknown, pair: AuthPair | null | undefined): Dict | null {
  const endpoint = eventsEndpoint(supabaseUrl);
  const user = str(pair?.user);
  const pass = str(pair?.pass);
  if (!endpoint || !user || !pass) return null;
  return { eventLocalUrls: [], eventPublicUrls: [{ url: eventUrlWithKey(endpoint, pass), username: user, password: pass }] };
}

export function buildNotification(title: unknown = PAY_AT_TABLE_TITLE): Dict {
  return { enabled: true, showButton: true, title: str(title).slice(0, 40) || PAY_AT_TABLE_TITLE, category: 'SaleWakeUp', details: '' };
}

export function buildPayAtTable(): Dict {
  return { enablePayAtTable: true, paymentInstrument: 'Card' };
}

export const STORE_SETTING_KEYS: readonly string[] = Object.freeze(['event_url', 'wakeup_button', 'pay_at_table', 'tips']);

export function buildStoreSettingsPatches({ supabaseUrl, pair, currency, tips }: { supabaseUrl?: unknown; pair?: AuthPair | null; currency?: unknown; tips?: Partial<ReaderTips> | null } = {}): StorePatch[] {
  const eventUrls = buildEventUrls(supabaseUrl, pair);
  const eventPatch: StorePatch = eventUrls
    ? { key: 'event_url', label: 'Reader events', body: { nexo: { eventUrls } }, missing: null }
    : { key: 'event_url', label: 'Reader events', body: null, missing: !eventsEndpoint(supabaseUrl) ? 'ServOS does not know its own events address.' : 'The events password for this environment is not set on ServOS.' };
  return [
    eventPatch,
    { key: 'wakeup_button', label: 'Pay at table button', body: { nexo: { notification: buildNotification() } }, missing: null },
    { key: 'pay_at_table', label: 'Pay at table', body: { payAtTable: buildPayAtTable() }, missing: null },
    { key: 'tips', label: 'Tips on the reader', body: { gratuities: buildGratuities(currency, tips) }, missing: null },
  ];
}

export function appliedLine(key: string, tips?: Partial<ReaderTips> | null): string {
  switch (key) {
    case 'event_url': return 'Reader events go to ServOS.';
    case 'wakeup_button': return 'The Pay at table button is on the reader menu.';
    case 'pay_at_table': return 'Pay at table is on.';
    case 'tips': return `Tip choices on the reader: ${tipsSentence(tips)}.`;
    default: return `${key} applied.`;
  }
}

export function plainAdyenDetail(data: unknown, fallback = 'Adyen refused the change.'): string {
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

export function storeSettingsOutcome(patches: unknown, results: unknown, { tips, at }: { tips?: Partial<ReaderTips> | null; at?: unknown } = {}): StoreSettingsOutcome {
  const byKey = new Map<string, Dict>((Array.isArray(results) ? results : []).filter(isObj).map((r) => [str(r.key), r]));
  const applied: string[] = [];
  const errors: string[] = [];
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

export function readSyncState(posSettings: unknown): { at: string | null; ok: boolean; applied: string[]; errors: string[] } | null {
  const s = isObj(posSettings) && isObj(posSettings[READER_SYNC_KEY]) ? posSettings[READER_SYNC_KEY] : null;
  if (!s) return null;
  return {
    at: s.at ? str(s.at) : null,
    ok: s.ok === true,
    applied: Array.isArray(s.applied) ? s.applied.map(str).filter(Boolean) : [],
    errors: Array.isArray(s.errors) ? s.errors.map(str).filter(Boolean) : [],
  };
}

export function syncStatePatch(posSettings: unknown, outcome: Partial<StoreSettingsOutcome> | null | undefined): Dict {
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

export function readerStatus(lastActivityAt: unknown, now: number = Date.now()): string {
  const t = lastActivityAt ? new Date(lastActivityAt as string).getTime() : NaN;
  return Number.isFinite(t) && now - t < ONLINE_WINDOW_MS ? STATUS_ONLINE : STATUS_NOT_SEEN;
}

export function normaliseSerial(text: unknown): string {
  return str(text).replace(/[^a-zA-Z0-9]/g, '');
}

export function serialFromPoiid(poiid: unknown): string {
  const p = str(poiid);
  return p.includes('-') ? p.split('-').slice(1).join('-') : p;
}

export function modelFromPoiid(poiid: unknown): string {
  const p = str(poiid);
  return p.includes('-') ? p.split('-')[0] : '';
}

export function nextReaderName(labels: unknown): string {
  const taken = new Set((Array.isArray(labels) ? labels : []).map((l) => str(l).toLowerCase()));
  for (let n = 1; n < 1000; n++) {
    const name = `Reader ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `Reader ${Date.now() % 100000}`;
}

export function readerRows({ terminals, links, now = Date.now() }: { terminals?: unknown; links?: unknown; now?: number } = {}): { readers: ReaderRow[]; notAdded: NotAddedRow[] } {
  const terms = (Array.isArray(terminals) ? terminals : []).filter(isObj);
  const byPoiid = new Map<string, Dict>(terms.map((t) => [str(t.id), t]));
  const linked = new Set<string>();
  const readers: ReaderRow[] = [];
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
  const notAdded: NotAddedRow[] = terms
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

export function tillSentence(boundPosDeviceId: unknown, devices: unknown): string {
  if (!boundPosDeviceId) return 'Any till';
  const d = (Array.isArray(devices) ? devices : []).find((x) => isObj(x) && str(x.id) === str(boundPosDeviceId)) as Dict | undefined;
  return d ? (str(d.name) || 'a till') : 'a till that is no longer here';
}
