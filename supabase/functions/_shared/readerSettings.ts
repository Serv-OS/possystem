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
// Whether the reader ASKS for a tip on a till payment is NOT the store's
// gratuities (they only set the choices): the charge path reads
// terminal_devices.tip_config per reader (terminal-job-create normTipConfig,
// null means off). tipConfigFromTips builds that row value from the venue's
// tips, so the venue box drives every reader here.
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
const boolOf = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

export interface ReaderTips { percentages: number[]; allowCustom: boolean; enabled?: boolean; source?: 'saved' | 'default' | 'readers' | 'adyen'; syncedAt?: string | null }
export interface AuthPair { user?: unknown; pass?: unknown }
export interface TipsSkip { text: string; problem: boolean }
export interface StorePatch { key: string; label: string; noun: string; notSent: string; body: Dict | null; missing: string | null; skipped: TipsSkip | null }
export interface PatchResult { key: string; ok: boolean; status?: number; detail?: unknown }
export interface SettingsError { key: string | null; text: string; detail: string | null }
export interface StoreSettingsOutcome { ok: boolean; applied: string[]; errors: SettingsError[]; at: string | null }
export interface TipChanges { kept: number[]; dropped: number[]; rounded: Array<{ from: number; to: number }> }
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

export function tipPresetChanges(input: unknown, { allowCustom = true }: { allowCustom?: boolean } = {}): TipChanges {
  const cap = allowCustom ? MAX_TIP_PRESETS - 1 : MAX_TIP_PRESETS;
  const whole: number[] = [];
  const rounded: Array<{ from: number; to: number }> = [];
  for (const raw of parseTipPresetText(input)) {
    const x = Number(raw);
    const n = Math.round(x);
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;
    if (n !== x && !rounded.some((r) => r.from === x)) rounded.push({ from: x, to: n });
    if (!whole.includes(n)) whole.push(n);
  }
  return { kept: whole.slice(0, cap), dropped: whole.slice(cap), rounded };
}

export function tipChangeSentence(changes: unknown, { allowCustom = true }: { allowCustom?: boolean } = {}): string | null {
  const c: Dict = isObj(changes) ? changes : {};
  const parts: string[] = [];
  const dropped = Array.isArray(c.dropped) ? (c.dropped as number[]) : [];
  const rounded = Array.isArray(c.rounded) ? (c.rounded as Array<{ from: number; to: number }>) : [];
  if (dropped.length) {
    const fit = allowCustom ? 'three fit with a custom amount' : 'four fit';
    parts.push(`Only ${fit}, so ${dropped.map((n) => `${n}%`).join(' and ')} ${dropped.length === 1 ? 'was' : 'were'} left off.`);
  }
  if (rounded.length) {
    parts.push(`Tips are whole percentages, so ${rounded.map((r) => `${r.from} became ${r.to}`).join(' and ')}.`);
  }
  return parts.length ? parts.join(' ') : null;
}

export function readReaderTips(posSettings: unknown): ReaderTips {
  const saved = isObj(posSettings) && isObj(posSettings[READER_TIPS_KEY]) ? (posSettings[READER_TIPS_KEY] as Dict) : null;
  const allowCustom = saved ? saved.allow_custom !== false : true;
  const enabled = saved ? saved.enabled !== false : true;
  const percentages = saved ? normaliseTipPresets(saved.percentages, { allowCustom }) : [];
  if (!saved || !percentages.length) {
    return { percentages: [...DEFAULT_TIP_PRESETS], allowCustom: saved ? allowCustom : true, enabled, source: 'default', syncedAt: saved?.synced_at ? str(saved.synced_at) : null };
  }
  return { percentages, allowCustom, enabled, source: 'saved', syncedAt: saved.synced_at ? str(saved.synced_at) : null };
}

export function readerTipsPatch(posSettings: unknown, tips: Partial<ReaderTips> | null | undefined, at?: unknown): Dict {
  const allowCustom = tips?.allowCustom !== false;
  const percentages = normaliseTipPresets(tips?.percentages, { allowCustom });
  return {
    ...(isObj(posSettings) ? posSettings : {}),
    [READER_TIPS_KEY]: {
      percentages: percentages.length ? percentages : [...DEFAULT_TIP_PRESETS],
      allow_custom: allowCustom,
      enabled: tips?.enabled !== false,
      synced_at: at ? str(at) : null,
    },
  };
}

export function tipsFromTipConfig(tipConfig: unknown): ReaderTips | null {
  if (!isObj(tipConfig)) return null;
  let bands: unknown[] | null = null;
  for (const k of ['percentBands', 'tip_percentages', 'percentages']) {
    if (Array.isArray(tipConfig[k])) { bands = tipConfig[k] as unknown[]; break; }
  }
  const allowCustom = boolOf(tipConfig.allowCustom) ?? boolOf(tipConfig.allow_custom) ?? true;
  const percentages = normaliseTipPresets(bands || [], { allowCustom });
  if (!percentages.length) return null;
  const enabled = boolOf(tipConfig.enabled) ?? boolOf(tipConfig.tipping_enabled) ?? false;
  return { percentages, allowCustom, enabled, source: 'readers', syncedAt: null };
}

export function tipsFromGratuities(gratuities: unknown, currency: unknown): ReaderTips | null {
  const list = (Array.isArray(gratuities) ? gratuities : []).filter(isObj);
  if (!list.length) return null;
  const cur = str(currency).toUpperCase();
  const g = list.find((x) => str(x.currency).toUpperCase() === cur) || list[0];
  const allowCustom = g.allowCustomAmount !== false;
  const percentages = normaliseTipPresets(Array.isArray(g.predefinedTipEntries) ? g.predefinedTipEntries : [], { allowCustom });
  if (!percentages.length) return null;
  return { percentages, allowCustom, enabled: true, source: 'adyen', syncedAt: null };
}

export function tipConfigFromTips(tips: Partial<ReaderTips> | null | undefined): Dict {
  const allowCustom = tips?.allowCustom !== false;
  const pcts = normaliseTipPresets(tips?.percentages, { allowCustom });
  const list = pcts.length ? pcts : [...DEFAULT_TIP_PRESETS];
  const enabled = tips?.enabled !== false;
  return {
    enabled,
    tipping_enabled: enabled,
    percentBands: list,
    tip_percentages: list,
    allowCustom,
    allow_custom: allowCustom,
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

const PATCH_WORDS: Readonly<Record<string, { label: string; noun: string; notSent: string }>> = Object.freeze({
  event_url: { label: 'Reader updates', noun: 'the address the readers send updates to', notSent: 'The address the readers send updates to was not sent.' },
  wakeup_button: { label: 'Pay at table button', noun: 'the Pay at table button', notSent: 'The Pay at table button was not sent.' },
  pay_at_table: { label: 'Pay at table', noun: 'Pay at table', notSent: 'Pay at table was not sent.' },
  tips: { label: 'Tip choices', noun: 'the tip choices', notSent: 'The tip choices were not sent.' },
});

export function buildStoreSettingsPatches({ supabaseUrl, pair, currency, tips, tipsSkip }: { supabaseUrl?: unknown; pair?: AuthPair | null; currency?: unknown; tips?: Partial<ReaderTips> | null; tipsSkip?: Partial<TipsSkip> | null } = {}): StorePatch[] {
  const eventUrls = buildEventUrls(supabaseUrl, pair);
  const w = PATCH_WORDS;
  const eventPatch: StorePatch = eventUrls
    ? { key: 'event_url', ...w.event_url, body: { nexo: { eventUrls } }, missing: null, skipped: null }
    : {
      key: 'event_url', ...w.event_url, body: null, skipped: null,
      missing: !eventsEndpoint(supabaseUrl)
        ? 'ServOS is missing its own address, so the reader updates were not set up.'
        : 'ServOS is missing a password, so the reader updates were not set up.',
    };
  const skip: TipsSkip | null = isObj(tipsSkip) && str(tipsSkip.text) ? { text: str(tipsSkip.text), problem: tipsSkip.problem === true } : null;
  return [
    eventPatch,
    { key: 'wakeup_button', ...w.wakeup_button, body: { nexo: { notification: buildNotification() } }, missing: null, skipped: null },
    { key: 'pay_at_table', ...w.pay_at_table, body: { payAtTable: buildPayAtTable() }, missing: null, skipped: null },
    skip
      ? { key: 'tips', ...w.tips, body: null, missing: null, skipped: skip }
      : { key: 'tips', ...w.tips, body: { gratuities: buildGratuities(currency, tips) }, missing: null, skipped: null },
  ];
}

export function appliedLine(key: string, tips?: Partial<ReaderTips> | null): string {
  switch (key) {
    case 'event_url': return 'The readers send payment updates to ServOS.';
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

function errorEntry(e: unknown): SettingsError | null {
  if (typeof e === 'string') return str(e) ? { key: null, text: str(e), detail: null } : null;
  if (!isObj(e) || !str(e.text)) return null;
  return { key: str(e.key) || null, text: str(e.text), detail: str(e.detail) || null };
}

export function storeSettingsOutcome(patches: unknown, results: unknown, { tips, at }: { tips?: Partial<ReaderTips> | null; at?: unknown } = {}): StoreSettingsOutcome {
  const byKey = new Map<string, Dict>((Array.isArray(results) ? results : []).filter(isObj).map((r) => [str(r.key), r]));
  const applied: string[] = [];
  const errors: SettingsError[] = [];
  for (const p of Array.isArray(patches) ? patches : []) {
    if (!isObj(p)) continue;
    const key = str(p.key);
    const words = PATCH_WORDS[key] || { noun: str(p.label) || key, notSent: `${str(p.label) || key} was not sent.` };
    if (p.missing) { errors.push({ key, text: str(p.missing), detail: null }); continue; }
    if (isObj(p.skipped)) {
      if (p.skipped.problem === true) errors.push({ key, text: str(p.skipped.text), detail: null });
      else applied.push(str(p.skipped.text));
      continue;
    }
    const r = byKey.get(key);
    if (!r) { errors.push({ key, text: words.notSent, detail: null }); continue; }
    if (r.ok) applied.push(appliedLine(key, tips));
    else if (r.status === 401 || r.status === 403) errors.push({ key, text: `Adyen refused ${words.noun}. Contact ServOS support.`, detail: `refused (${r.status}): the Adyen credential lacks the terminal settings role` });
    else errors.push({ key, text: `Adyen did not take ${words.noun}.`, detail: plainAdyenDetail(r.detail, `Adyen answered ${r.status || 'with an error'}`) });
  }
  return { ok: errors.length === 0, applied, errors, at: at ? str(at) : null };
}

export function readSyncState(posSettings: unknown): { at: string | null; ok: boolean; applied: string[]; errors: SettingsError[] } | null {
  const s = isObj(posSettings) && isObj(posSettings[READER_SYNC_KEY]) ? (posSettings[READER_SYNC_KEY] as Dict) : null;
  if (!s) return null;
  return {
    at: s.at ? str(s.at) : null,
    ok: s.ok === true,
    applied: Array.isArray(s.applied) ? s.applied.map(str).filter(Boolean) : [],
    errors: Array.isArray(s.errors) ? s.errors.map(errorEntry).filter((x): x is SettingsError => !!x) : [],
  };
}

export function syncStatePatch(posSettings: unknown, outcome: Partial<StoreSettingsOutcome> | null | undefined): Dict {
  return {
    ...(isObj(posSettings) ? posSettings : {}),
    [READER_SYNC_KEY]: {
      at: outcome?.at ? str(outcome.at) : null,
      ok: outcome?.ok === true,
      applied: Array.isArray(outcome?.applied) ? outcome.applied.map(str) : [],
      errors: Array.isArray(outcome?.errors) ? (outcome.errors as unknown[]).map(errorEntry).filter((x): x is SettingsError => !!x) : [],
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
