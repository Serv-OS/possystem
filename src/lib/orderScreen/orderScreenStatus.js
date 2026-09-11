// src/lib/orderScreen/orderScreenStatus.js
//
// Order screens: the pure status, channel, name and config rules.
// NO imports, so node:test can load it and the Back Office preview and the TV share it.
//
// This file MIRRORS supabase/migrations/20260911_OPS_order_status_displays.sql:
//   channelKeyOf      = _osd_channel_key
//   orderTypeKey      = _osd_type_key
//   formatOrderName   = _osd_name
//   orderNumberOf     = _osd_number
//   evaluateOrder     = the judged, bucketed and visible CTEs of order_status_feed
//   parseIntLike      = _osd_int
//   resolveNumberClashes = the num column of the feed's limited CTE (4 characters on a clash)
//   evaluateOrder(..., { namesEnabled }) = order_status_names_enabled() in the feed
// Change both together. The TV never runs evaluateOrder on real orders: the feed RPC
// does the work in SQL (names are shortened there). evaluateOrder drives the Back Office
// preview on sample orders and pins the rules in tests.

// ── Constants ────────────────────────────────────────────────────────────────

export const CHANNELS = [
  { key: 'till', label: 'Till', group: 'venue' },
  { key: 'kiosk', label: 'Kiosk', group: 'venue' },
  { key: 'online', label: 'Online', group: 'venue' },
  { key: 'qr', label: 'Table QR', group: 'venue' },
  { key: 'catering', label: 'Catering', group: 'venue' },
  { key: 'deliveroo', label: 'Deliveroo', group: 'apps' },
  { key: 'ubereats', label: 'Uber Eats', group: 'apps' },
  { key: 'justeat', label: 'Just Eat', group: 'apps' },
  { key: 'other_app', label: 'Other apps through HubRise', group: 'apps' },
  { key: 'ezcater', label: 'ezCater', group: 'apps' },
];

export const ORDER_TYPES = [
  { key: 'dine-in', label: 'Eat in' },
  { key: 'takeaway', label: 'Takeaway' },
  { key: 'collection', label: 'Collection' },
  { key: 'delivery', label: 'Delivery' },
];

export const STEPS = ['received', 'preparing', 'ready'];
export const BUCKETS = ['received', 'preparing', 'ready', 'collected'];
export const NAME_FORMATS = ['short', 'full', 'number'];

export const DEFAULT_LABELS = {
  received: 'Order received',
  preparing: 'Preparing',
  ready: 'Ready to collect',
  collected: 'Collected',
};

export const DEFAULT_SETTINGS = {
  headerText: 'Orders ready for pickup',
  lingerMinutes: 2,
  maxAgeHours: 6,
  showUnacceptedPlatform: false,
  chime: false,
};

export const DEFAULT_THEME = {
  headerBg: '#15C26A',
  headerText: '#0F1211',
  bg: '#0F1211',
  text: '#FFFFFF',
  muted: '#9AA39F',
  readyBg: '#15C26A',
  readyText: '#0F1211',
  pillBg: '#2A302D',
  pillText: '#FFFFFF',
  logoUrl: '',
  uppercase: true,
};

// Exactly the regex source inside _osd_name. The SQL test asserts it appears verbatim.
export const NAME_PLACEHOLDER_PATTERN = '^(order\\s*#?\\s*\\d+|hubrise customer|ezcater customer|guest|customer|walk\\s*-?\\s*in|counter|dine\\s*-?\\s*in|eat\\s*-?\\s*in|take\\s*-?\\s*away|collection|delivery|table\\s*\\S+)$';
const NAME_PLACEHOLDER_RE = new RegExp(NAME_PLACEHOLDER_PATTERN, 'i');
// Exactly the contact detail regex inside _osd_name: an @ or any digit anywhere means a phone
// number, an email, a flat or a table number was typed into the name field, so the row shows
// its number instead (stripping the digits would leave broken words like "Bob nd").
export const NAME_CONTACT_PATTERN = '@|\\d';
const NAME_CONTACT_RE = new RegExp(NAME_CONTACT_PATTERN);
// Mirrors '[^[:alpha:][:space:]''’-]' in _osd_name: letters, spaces, apostrophes and hyphens only.
const NAME_STRIP_RE = /[^\p{L}\s'’-]/gu;
// Sources where the customer types the name. Mirrors the name gate in order_status_feed.
export const CUSTOMER_TYPED_SOURCES = ['kiosk', 'online', 'qr', 'catering'];
// Refs that are order tracking lookup keys. Mirrors '^(OL|CA|QR)-' in _osd_number.
const TRACKING_REF_RE = /^(OL|CA|QR)-/;

export const COLOUR_KEYS = ['headerBg', 'headerText', 'bg', 'text', 'muted', 'readyBg', 'readyText', 'pillBg', 'pillText'];
export const MAX_SECTIONS = 4;
// Side by side columns on a landscape TV get too narrow for names and status pills past 3.
export const MAX_LANDSCAPE_SECTIONS = 3;
export const ABSENT_CODES = ['PGRST205', '42P01', 'PGRST202', '42883', '42703', 'PGRST204'];

const CHANNEL_KEYS = CHANNELS.map(c => c.key);
const TYPE_KEYS = ORDER_TYPES.map(t => t.key);
const COLOUR_RE = /^#[0-9a-f]{6}$/i;
const INT_RE = /^\s*-?\d{1,4}\s*$/;
const MIN = 60000;
const HOUR = 3600000;

const COURIER_LABELS = { stuart: 'Stuart', uber_api: 'Uber Direct', hubrise_bridge: 'Courier' };
const CHANNEL_SCREEN_LABELS = {
  till: 'Till', kiosk: 'Kiosk', online: 'Online', qr: 'Table QR', catering: 'Catering',
  deliveroo: 'Deliveroo', ubereats: 'Uber Eats', justeat: 'Just Eat', ezcater: 'ezCater',
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const leftCp = (s, n) => Array.from(String(s)).slice(0, n).join('');
const rightCp = (s, n) => { const a = Array.from(String(s)); return a.slice(Math.max(0, a.length - n)).join(''); };
const cpLen = (s) => Array.from(String(s)).length;
// Postgres btrim(x) with no second argument trims spaces only.
const trimSpaces = (s) => String(s).replace(/^ +| +$/g, '');
// What `jsonb ->> key` would give: null stays null, strings as is, everything else as JSON text.
const textOf = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
const lettersOnly = (v) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** ms, ISO string, Date or null to ms or null. */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** Same as SQL _osd_int: parse only a plain integer of up to 4 digits, then clamp. */
export function parseIntLike(v, def, min, max) {
  const n = (v != null && INT_RE.test(String(v))) ? parseInt(String(v).trim(), 10) : def;
  return Math.min(Math.max(n, min), max);
}

function pickKeys(list, allowed) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const k of list) if (typeof k === 'string' && allowed.includes(k) && !out.includes(k)) out.push(k);
  return out;
}

// ── Keys and names ─────────────────────────────────────────────────────────────

/** Mirrors _osd_channel_key. */
export function channelKeyOf(source, customerChannel) {
  if (source === 'hubrise') {
    const c = lettersOnly(customerChannel);
    if (c.includes('deliveroo')) return 'deliveroo';
    if (c.includes('ubereats')) return 'ubereats';
    if (c.includes('justeat')) return 'justeat';
    return 'other_app';
  }
  if (source === 'ezcater') return 'ezcater';
  if (source === 'kiosk' || source === 'online' || source === 'qr' || source === 'catering') return source;
  return 'till';
}

/** Mirrors _osd_type_key. Unknown gives null, which matches no section. */
export function orderTypeKey(type) {
  switch (lettersOnly(type)) {
    case 'dinein': case 'eatin': return 'dine-in';
    case 'takeaway': case 'takeout': return 'takeaway';
    case 'collection': case 'pickup': return 'collection';
    case 'delivery': return 'delivery';
    default: return null;
  }
}

/** Mirrors _osd_name. Returns null when the row should show its number instead. */
export function formatOrderName(name, format) {
  const raw = String(name ?? '').replace(/\s+/g, ' ').replace(/^ +| +$/g, '');
  if ((format ?? 'short') === 'number' || raw === '') return null;
  if (NAME_CONTACT_RE.test(raw)) return null;
  if (NAME_PLACEHOLDER_RE.test(raw) || /^[0-9#\s]+$/.test(raw)) return null;
  const n = raw.replace(NAME_STRIP_RE, '').replace(/\s+/g, ' ').replace(/^ +| +$/g, '');
  if (!/\p{L}/u.test(n)) return null;
  if (NAME_PLACEHOLDER_RE.test(n)) return null;
  if (format === 'full') return leftCp(n, 24);
  const parts = n.split(' ');
  const first = leftCp(parts[0], 16);
  if (parts.length === 1) return first;
  const initial = leftCp(parts[parts.length - 1].replace(/[^\p{L}]/gu, ''), 1).toUpperCase();
  if (!initial) return first;
  return `${first} ${initial}`;
}

/** Mirrors _osd_number. */
export function orderNumberOf({ ref, source, customer, courierBackend } = {}) {
  const r = ref == null ? '' : String(ref);
  const cust = isObj(customer) ? customer : {};
  if (source === 'hubrise') {
    const v = trimSpaces(textOf(cust.collectionCode));
    if (!v) return rightCp(r, 4);
    if (cpLen(v) > 10) return rightCp(v, 6);
    return v;
  }
  if (source === 'ezcater') {
    const v = trimSpaces(textOf(cust.ezcater_order_number));
    return v || rightCp(r, 6);
  }
  // Online, catering and QR refs are the order tracking lookup key: last 3 only.
  if (TRACKING_REF_RE.test(r)) return rightCp(r, 3);
  if (!courierBackend) {
    const m = /^R(\d+)$/.exec(r);
    if (m) return rightCp(m[1], 2);
  }
  return ref == null ? null : r;
}

/** Screen label for a row's channel. Other apps show the app name HubRise sent. */
export function channelLabel(row) {
  const ch = row?.channel;
  if (ch === 'other_app') {
    const name = row?.channelName ? leftCp(trimSpaces(String(row.channelName)), 20) : '';
    return name || 'Delivery app';
  }
  return CHANNEL_SCREEN_LABELS[ch] || '';
}

/** Courier label added after the channel when a courier row exists. */
export function courierLabel(backend) {
  if (!backend) return null;
  return COURIER_LABELS[backend] || 'Courier';
}

// ── Config ─────────────────────────────────────────────────────────────────────

export function newSection(n = 1) {
  return {
    id: `s${n}`, title: '', subtitle: '',
    channels: [], orderTypes: [], statuses: [...STEPS],
    nameFormat: 'short', showChannel: true,
  };
}

export function newDisplayTemplate() {
  return {
    name: 'Order screen',
    is_active: true,
    orientation: 'portrait',
    rotate: 0,
    sections: [
      { id: 's1', title: 'Eat in orders', subtitle: 'Pick up at the counter',
        channels: ['till', 'kiosk'], orderTypes: ['dine-in'],
        statuses: ['received', 'preparing', 'ready'], nameFormat: 'short', showChannel: true },
      { id: 's2', title: 'Takeaway and collection', subtitle: 'Pick up from the shelf',
        channels: ['till', 'kiosk', 'online', 'catering'], orderTypes: ['takeaway', 'collection'],
        statuses: ['received', 'preparing', 'ready'], nameFormat: 'short', showChannel: true },
      { id: 's3', title: 'Delivery and app orders', subtitle: 'Find your app name and order code',
        channels: ['deliveroo', 'ubereats', 'justeat', 'other_app', 'ezcater', 'till', 'online', 'catering'],
        orderTypes: ['delivery', 'collection'],
        statuses: ['preparing', 'ready'], nameFormat: 'number', showChannel: true },
    ],
    labels: { ...DEFAULT_LABELS },
    settings: { ...DEFAULT_SETTINGS },
    theme: { ...DEFAULT_THEME },
  };
}

function normaliseSection(s, i) {
  if (!isObj(s)) return { ...newSection(i + 1), statuses: [] };
  return {
    id: typeof s.id === 'string' && s.id.trim() ? leftCp(s.id.trim(), 40) : `s${i + 1}`,
    title: typeof s.title === 'string' ? leftCp(s.title, 40) : '',
    subtitle: typeof s.subtitle === 'string' ? leftCp(s.subtitle, 60) : '',
    channels: pickKeys(s.channels, CHANNEL_KEYS),
    orderTypes: pickKeys(s.orderTypes, TYPE_KEYS),
    statuses: pickKeys(s.statuses, STEPS),
    nameFormat: NAME_FORMATS.includes(s.nameFormat) ? s.nameFormat : 'short',
    showChannel: s.showChannel !== false,
  };
}

/** Defaults, clamps and drops unknown keys. Safe on any input. Idempotent. */
export function normaliseDisplay(dbRow) {
  const r = isObj(dbRow) ? dbRow : {};
  const rot = parseIntLike(r.rotate, 0, -9999, 9999);
  const sections = Array.isArray(r.sections) ? r.sections.slice(0, MAX_SECTIONS).map(normaliseSection) : [];

  const rl = isObj(r.labels) ? r.labels : {};
  const labels = {};
  for (const k of BUCKETS) {
    const v = typeof rl[k] === 'string' ? leftCp(rl[k].trim(), 24) : '';
    labels[k] = v || DEFAULT_LABELS[k];
  }

  const rs = isObj(r.settings) ? r.settings : {};
  const settings = {
    headerText: typeof rs.headerText === 'string' ? leftCp(rs.headerText, 40) : DEFAULT_SETTINGS.headerText,
    lingerMinutes: parseIntLike(rs.lingerMinutes, DEFAULT_SETTINGS.lingerMinutes, 0, 30),
    maxAgeHours: parseIntLike(rs.maxAgeHours, DEFAULT_SETTINGS.maxAgeHours, 1, 24),
    showUnacceptedPlatform: rs.showUnacceptedPlatform === true || rs.showUnacceptedPlatform === 'true',
    chime: rs.chime === true,
  };

  const rt = isObj(r.theme) ? r.theme : {};
  const theme = {};
  for (const k of COLOUR_KEYS) theme[k] = (typeof rt[k] === 'string' && COLOUR_RE.test(rt[k])) ? rt[k] : DEFAULT_THEME[k];
  theme.logoUrl = (typeof rt.logoUrl === 'string' && rt.logoUrl.startsWith('https://')) ? rt.logoUrl : '';
  theme.uppercase = typeof rt.uppercase === 'boolean' ? rt.uppercase : DEFAULT_THEME.uppercase;

  const out = {
    name: typeof r.name === 'string' ? leftCp(r.name, 60) : 'Order screen',
    is_active: r.is_active !== false,
    orientation: r.orientation === 'landscape' ? 'landscape' : 'portrait',
    rotate: [0, 90, 270].includes(rot) ? rot : 0,
    sections, labels, settings, theme,
    version: Number.isInteger(r.version) ? r.version : 1,
  };
  if (r.id != null) out.id = r.id;
  if (r.location_id != null) out.location_id = r.location_id;
  return out;
}

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_LARGE_CONTRAST = 3;

const channelLum = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const relLuminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => channelLum(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two 6 digit hex colours, 1 to 21. Anything else gives 1. */
export function contrastRatio(a, b) {
  if (!COLOUR_RE.test(String(a)) || !COLOUR_RE.test(String(b))) return 1;
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Plain word messages for the Back Office. Checks the raw draft, before any clamping. */
export function validateDisplay(display) {
  const d = isObj(display) ? display : {};
  const out = [];
  if (typeof d.name !== 'string' || !d.name.trim()) out.push('Give this order screen a name.');
  const secs = Array.isArray(d.sections) ? d.sections : [];
  if (secs.length === 0) out.push('Add at least one section.');
  if (d.orientation === 'landscape' && secs.length > MAX_LANDSCAPE_SECTIONS) {
    out.push('A landscape screen fits up to 3 sections. Remove one or choose Portrait.');
  }
  secs.slice(0, MAX_SECTIONS).forEach((raw, i) => {
    const s = isObj(raw) ? raw : {};
    const n = i + 1;
    if (typeof s.title !== 'string' || !s.title.trim()) out.push(`Section ${n} needs a title.`);
    if (pickKeys(s.channels, CHANNEL_KEYS).length === 0) out.push(`Section ${n} needs at least one place orders come from.`);
    if (pickKeys(s.orderTypes, TYPE_KEYS).length === 0) out.push(`Section ${n} needs at least one order type.`);
    if (pickKeys(s.statuses, STEPS).length === 0) out.push(`Section ${n} needs at least one step to show.`);
  });
  const st = isObj(d.settings) ? d.settings : {};
  const intIn = (v, min, max) => v != null && INT_RE.test(String(v)) && Number(v) >= min && Number(v) <= max;
  if (st.lingerMinutes !== undefined && !intIn(st.lingerMinutes, 0, 30)) out.push('Keep collected orders for 0 to 30 minutes.');
  if (st.maxAgeHours !== undefined && !intIn(st.maxAgeHours, 1, 24)) out.push('Hide orders after 1 to 24 hours.');
  const th = isObj(d.theme) ? d.theme : {};
  if (COLOUR_KEYS.some(k => th[k] !== undefined && !(typeof th[k] === 'string' && COLOUR_RE.test(th[k])))) {
    out.push('Colours must be a colour code like #15C26A.');
  } else {
    // The TV works its muted grey and pill colours out from the page pair, so an unreadable
    // pair makes every order unreadable. WCAG: 4.5 for page text, 3 for big header and pill text.
    const col = (k) => (typeof th[k] === 'string' ? th[k] : DEFAULT_THEME[k]);
    if (contrastRatio(col('text'), col('bg')) < MIN_TEXT_CONTRAST
        || contrastRatio(col('headerText'), col('headerBg')) < MIN_LARGE_CONTRAST
        || contrastRatio(col('readyText'), col('readyBg')) < MIN_LARGE_CONTRAST) {
      out.push('Some text is hard to read on its background. Choose a darker or lighter colour.');
    }
  }
  if (typeof st.headerText === 'string' && cpLen(st.headerText) > 40) out.push('The header text can be up to 40 characters.');
  return out;
}

// ── Evaluation ─────────────────────────────────────────────────────────────────

const LIVE_STATUSES = ['received', 'scheduled', 'prep', 'ready', 'collected'];
const DEAD_COURIER = ['canceled', 'returned', 'failed'];
const RANK = { ready: 0, preparing: 1, received: 2 };

/**
 * One order against one display, at server time nowMs. Mirrors order_status_feed.
 * order: { ref, source, type, status, customer, sentAt, createdAt, statusChangedAt,
 *          firstSeenAt, departedAt, departedFrom, courier:{backend,status,pickedAt,updatedAt}|null,
 *          hubrise:{hrStatus,updatedAt}|null }
 * firstSeenAt is the mark's first_seen_at: a kiosk, online, QR or catering name shows only
 * when statusChangedAt is later than it (a status change made in a separate request).
 * opts.namesEnabled false (the feed's order_status_names_enabled()) gives every row a null name.
 * Returns { visible, reason, row }. reason is one of no_section, removed, unaccepted,
 * status_hidden, future, stale, status_off, expired, ok.
 */
export function evaluateOrder(order, display, nowMs, opts = {}) {
  const namesEnabled = !(isObj(opts) && opts.namesEnabled === false);
  const o = isObj(order) ? order : {};
  const d = normaliseDisplay(display);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const { lingerMinutes: linger, maxAgeHours: maxAge, showUnacceptedPlatform } = d.settings;
  const cust = isObj(o.customer) ? o.customer : {};
  const hidden = (reason, row = null) => ({ visible: false, reason, row });

  const departedAt = toMs(o.departedAt);
  const departed = departedAt != null;
  if (departed) {
    // SQL keeps only marks deleted from ready or collected, and only inside the linger window.
    if (o.departedFrom !== 'ready' && o.departedFrom !== 'collected') return hidden('removed');
    if (!(linger > 0) || !(departedAt > now - linger * MIN)) return hidden('expired');
  } else if (!LIVE_STATUSES.includes(o.status)) {
    return hidden('status_hidden');
  }

  const channel = channelKeyOf(o.source, cust.channel);
  const orderType = orderTypeKey(o.type);
  const sectionIndex = orderType
    ? d.sections.findIndex(s => s.channels.includes(channel) && s.orderTypes.includes(orderType))
    : -1;
  if (sectionIndex < 0) return hidden('no_section');
  const section = d.sections[sectionIndex];

  const courier = isObj(o.courier) && o.courier.backend && !DEAD_COURIER.includes(o.courier.status) ? o.courier : null;
  const courierBackend = courier ? courier.backend : null;
  const status = departed ? o.departedFrom : o.status;
  const statusChangedAt = toMs(o.statusChangedAt);

  // judged: the first matching rule wins, even when its time is missing.
  const courierDone = !!courier && (toMs(courier.pickedAt) != null || courier.status === 'dropoff' || courier.status === 'delivered');
  const courierAt = courierDone ? (toMs(courier.pickedAt) ?? toMs(courier.updatedAt)) : null;
  const platformDone = o.source === 'hubrise' && isObj(o.hubrise) && o.hubrise.hrStatus === 'completed';
  const platformAt = platformDone ? toMs(o.hubrise.updatedAt) : null;
  let collectedAt = null;
  if (departed) {
    // SQL least(): the earliest collection signal wins, nulls ignored.
    collectedAt = Math.min(...[departedAt, courierAt, platformAt].filter(v => v != null));
  } else if (status === 'collected') collectedAt = statusChangedAt;
  else if (courierDone) collectedAt = courierAt;
  else if (platformDone) collectedAt = platformAt;

  let bucket = null;
  let reason = 'ok';
  if (collectedAt != null) bucket = 'collected';
  else if (departed || status === 'collected') reason = 'removed';
  else if (status === 'received' || status === 'scheduled') {
    if ((o.source === 'hubrise' || o.source === 'ezcater') && !showUnacceptedPlatform) reason = 'unaccepted';
    else bucket = 'received';
  } else if (status === 'prep') bucket = 'preparing';
  else if (status === 'ready') bucket = 'ready';
  else reason = 'status_hidden';

  const sentAt = toMs(o.sentAt);
  const createdAt = toMs(o.createdAt);
  const firstSeenAt = toMs(o.firstSeenAt);
  const staffMoved = statusChangedAt != null && firstSeenAt != null && statusChangedAt > firstSeenAt;
  const nameHidden = !namesEnabled || (CUSTOMER_TYPED_SOURCES.includes(o.source) && !staffMoved);
  const row = {
    key: o.ref ?? null,
    sectionId: section.id,
    sectionIndex,
    bucket,
    number: orderNumberOf({ ref: o.ref, source: o.source, customer: cust, courierBackend }),
    name: nameHidden ? null : formatOrderName(cust.name, section.nameFormat),
    channel,
    channelName: channel === 'other_app' ? (leftCp(trimSpaces(textOf(cust.channel)), 20) || null) : null,
    courier: courierBackend,
    orderType,
    sinceMs: departed ? (statusChangedAt ?? now) : (statusChangedAt ?? sentAt ?? createdAt ?? now),
    expiresAtMs: bucket === 'collected' ? collectedAt + linger * MIN : null,
  };
  if (!bucket) return hidden(reason, row);

  if (bucket === 'collected') {
    if (!(linger > 0) || !(collectedAt > now - linger * MIN)) return hidden('expired', row);
    return { visible: true, reason: 'ok', row };
  }
  // A till pre order waits as scheduled with no fire time. It shows once the till fires it.
  if (status === 'scheduled' && sentAt == null) return hidden('future', row);
  const allowance = o.source === 'ezcater' ? 60 * MIN : 0;
  if (sentAt != null && sentAt > now + allowance) return hidden('future', row);
  const base = sentAt != null ? Math.min(sentAt, now) : (createdAt ?? now);
  if (base < now - maxAge * HOUR) return hidden('stale', row);
  if (!section.statuses.includes(bucket)) return hidden('status_off', row);
  return { visible: true, reason: 'ok', row };
}

/**
 * Mirrors the num column in order_status_feed: when two rows in one section show the same
 * number and a row's key (its ref, as evaluateOrder sets it) is an online, catering or QR ref,
 * that row shows the last 4 characters of its ref instead of 3. Counts every row passed in, so
 * pass the visible rows. Returns new row objects; rows are never reordered.
 */
export function resolveNumberClashes(rows) {
  if (!Array.isArray(rows)) return [];
  const counts = new Map();
  const slot = (r) => `${r.sectionIndex} ${r.number}`;
  for (const r of rows) if (r) counts.set(slot(r), (counts.get(slot(r)) || 0) + 1);
  return rows.map((r) => {
    if (!r || r.key == null || !TRACKING_REF_RE.test(String(r.key)) || counts.get(slot(r)) < 2) return r;
    return { ...r, number: rightCp(String(r.key), 4) };
  });
}

/** A snake_case order_status_feed row to the shared row shape. */
export function rowFromFeed(obj) {
  const f = isObj(obj) ? obj : {};
  const idx = Number(f.section_index);
  return {
    key: f.key ?? null,
    sectionId: f.section_id ?? null,
    sectionIndex: Number.isInteger(idx) ? idx : 0,
    bucket: BUCKETS.includes(f.bucket) ? f.bucket : null,
    number: f.number == null ? null : String(f.number),
    name: f.name == null ? null : String(f.name),
    channel: f.channel ?? null,
    channelName: f.channel_name ?? null,
    courier: f.courier ?? null,
    orderType: f.order_type ?? null,
    sinceMs: toMs(f.since),
    expiresAtMs: toMs(f.expires_at),
  };
}

/** Drops rows with no bucket and collected rows whose linger has run out. */
export function visibleRows(rows, nowMs) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(r => r && r.bucket && !(r.bucket === 'collected' && r.expiresAtMs != null && r.expiresAtMs <= nowMs));
}

/** Section, then ready, preparing, received, collected, then oldest first, then number, then key. */
export function sortRows(rows) {
  if (!Array.isArray(rows)) return [];
  const rank = (b) => (b in RANK ? RANK[b] : 3);
  const since = (v) => (Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);
  const str = (v) => (v == null ? '' : String(v));
  return [...rows].sort((a, b) =>
    (a.sectionIndex - b.sectionIndex)
    || (rank(a.bucket) - rank(b.bucket))
    || (since(a.sinceMs) - since(b.sinceMs))
    || str(a.number).localeCompare(str(b.number), 'en', { numeric: true })
    || str(a.key).localeCompare(str(b.key)));
}

// ── Pairing and errors ─────────────────────────────────────────────────────────

/** Upper case, keep A to Z and 0 to 9. Exactly 8 characters becomes XXXX-XXXX. */
export function normalisePairCode(input) {
  const c = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

const messageOf = (e) => (typeof e === 'string' ? e : String(e?.message || ''));

/** True when the error means the migration is not applied yet. */
export function isAbsentError(err) {
  if (!err) return false;
  if (err === 'absent' || err.absent === true) return true;
  if (typeof err === 'object' && ABSENT_CODES.includes(String(err.code || ''))) return true;
  const msg = messageOf(err).toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find') || msg.includes('schema cache');
}

export function friendlyPairError(errOrMessage) {
  if (isAbsentError(errOrMessage)) return 'Order screens need a database update first. Ask ServOS support.';
  const m = messageOf(errOrMessage).toLowerCase();
  if (m.includes('order screen not found')) return 'That order screen no longer exists. Refresh and try again.';
  if (m.includes('pairing code not found') || m.includes('code not found')) return 'We could not find that code. Check the TV and try again.';
  if (m.includes('expired')) return 'That code has expired. Restart the TV app to get a new code.';
  if (m.includes('another venue') || m.includes('another location')) return 'That TV is paired to another venue.';
  if (m.includes('different venue') || m.includes('different location')) return 'That order screen belongs to a different venue.';
  if (m.includes('sign in')) return 'Sign in to Back Office again, then try again.';
  if (m.includes('no access')) return 'You do not have access to this venue.';
  return 'Could not pair the TV. Try again.';
}

/** "Online" within 3 minutes, then minutes, hours or days since the last heartbeat. */
export function lastSeenLabel(ts, nowMs) {
  const t = toMs(ts);
  if (t == null) return { online: false, text: 'Never seen' };
  const mins = Math.max(0, Math.round((nowMs - t) / MIN));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (mins <= 3) return { online: true, text: 'Online' };
  if (mins < 90) return { online: false, text: `Last seen ${plural(mins, 'minute')} ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return { online: false, text: `Last seen ${plural(hrs, 'hour')} ago` };
  return { online: false, text: `Last seen ${plural(Math.round(hrs / 24), 'day')} ago` };
}

// ── Sample orders for the Back Office preview (invented names only) ──────────────

export function sampleOrders(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ago = (mins) => now - mins * MIN;
  // firstSeenAt defaults to createdAt, so a sample whose status changed since shows its name.
  const base = (o) => ({
    sentAt: null, departedAt: null, departedFrom: null, courier: null, hubrise: null, firstSeenAt: o.createdAt, ...o,
  });
  return [
    base({ ref: 'R1047', source: 'pos', type: 'dine-in', status: 'prep', customer: { name: 'Sam Taylor' }, createdAt: ago(14), statusChangedAt: ago(13) }),
    base({ ref: 'R1052', source: 'kiosk', type: 'dine-in', status: 'ready', customer: { name: 'Priya Kaur' }, createdAt: ago(11), statusChangedAt: ago(1) }),
    base({ ref: 'R1055', source: 'kiosk', type: 'takeaway', status: 'received', customer: { name: 'Alex Morgan' }, createdAt: ago(4), statusChangedAt: ago(4) }),
    base({ ref: 'OL-7K2QX', source: 'online', type: 'collection', status: 'ready', customer: { name: 'Jordan Lee' }, createdAt: ago(20), statusChangedAt: ago(2) }),
    base({ ref: 'R1049', source: 'pos', type: 'takeaway', status: 'prep', customer: { name: 'takeaway' }, createdAt: ago(9), statusChangedAt: ago(8) }),
    base({ ref: 'CA-4H8PD', source: 'catering', type: 'collection', status: 'received', customer: { name: 'Robin Hart' }, createdAt: ago(6), statusChangedAt: ago(6) }),
    base({ ref: 'HR-a1b2c3', source: 'hubrise', type: 'delivery', status: 'prep', customer: { name: 'Jamie P.', channel: 'Deliveroo', collectionCode: 'A7F3' }, createdAt: ago(12), statusChangedAt: ago(10), hubrise: { hrStatus: 'accepted', updatedAt: ago(10) } }),
    base({ ref: 'HR-d4e5f6', source: 'hubrise', type: 'delivery', status: 'ready', customer: { name: 'Chris Adams', channel: 'Uber Eats', collectionCode: '4821' }, createdAt: ago(18), statusChangedAt: ago(3), hubrise: { hrStatus: 'in_delivery', updatedAt: ago(3) } }),
    base({ ref: 'HR-g7h8i9', source: 'hubrise', type: 'collection', status: 'prep', customer: { name: 'Nadia Rahman', channel: 'Just Eat', collectionCode: 'JE5520' }, createdAt: ago(7), statusChangedAt: ago(6), hubrise: { hrStatus: 'accepted', updatedAt: ago(6) } }),
    base({ ref: 'OL-9QW3M', source: 'online', type: 'delivery', status: 'prep', customer: { name: 'Ellis Grant' }, createdAt: ago(15), statusChangedAt: ago(15), courier: { backend: 'stuart', status: 'pickup', pickedAt: null, updatedAt: ago(2) } }),
    base({ ref: 'R1044', source: 'pos', type: 'dine-in', status: 'ready', customer: { name: 'Casey Brooks' }, createdAt: ago(19), statusChangedAt: ago(5), departedAt: now - 30000, departedFrom: 'ready' }),
    base({ ref: 'EZ-5b1c', source: 'ezcater', type: 'delivery', status: 'prep', customer: { name: 'Riley Stone', ezcater_order_number: '9XK22M' }, createdAt: ago(16), sentAt: ago(10), statusChangedAt: ago(10) }),
    base({ ref: 'R1058', source: 'kiosk', type: 'dine-in', status: 'prep', customer: { name: 'Morgan Reid' }, createdAt: ago(3), statusChangedAt: ago(3) }),
    base({ ref: 'R1060', source: 'pos', type: 'collection', status: 'ready', customer: { name: 'Dana Wells' }, createdAt: ago(10), statusChangedAt: ago(1) }),
  ];
}
