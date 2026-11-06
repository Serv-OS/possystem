// The customer app brand form's rules, shared by the Back Office tab and customer-app-admin.
// Pure: no I/O. The payload shape is tenantAppSchema.json (the app's tenant.schema.json).

export const DISPLAY_FACES = ['Instrument Serif', 'DM Serif Display', 'Space Grotesk', 'Fraunces', 'Montserrat', 'Poppins', 'Bebas Neue'];
export const BODY_FACES = ['Schibsted Grotesk', 'Figtree', 'Public Sans', 'Inter', 'DM Sans'];
export const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'NZD'];
export const LOCALES = ['en-GB', 'en-US', 'en-IE', 'en-AU', 'en-CA', 'en-NZ'];
export const MODULES = [
  ['ordering', 'Ordering', 'The Order tab: web ordering opened inside the app'],
  ['stamps', 'Stamp cards', 'Stamp cards on the home screen and in the menu'],
  ['giftCards', 'Gift cards', 'Gift card balances and the balance check'],
];
export const ASSET_KINDS = ['logoLight', 'logoDark', 'icon'];
export const RADIUS_MIN = 4;
export const RADIUS_MAX = 34;
export const MIN_CONTRAST = 4.5;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const ASSET_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

export const NEUTRALS = {
  onAccent: '#FFFFFF',
  ink: '#14110F',
  inkMuted: '#6B625C',
  surface: '#FFFFFF',
  sunken: '#F5F2F0',
  line: '#E2DBD6',
};

export const TENANT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const BUNDLE_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/i;
const URL_RE = /^https:\/\/[^\s]+$/i;

/** "Coffee Boy  Ltd" -> "coffee-boy-ltd". Never empty: falls back to "app". */
export function slugify(name) {
  const s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  const t = /^[a-z]/.test(s) ? s : `a${s}`.slice(0, 32);
  return TENANT_ID_RE.test(t) ? t : 'app';
}

export function bundleIdFor(tenantId) {
  return `uk.co.servos.${String(tenantId).replace(/-/g, '')}`;
}

/** A complete payload for an organisation that has no row yet. */
export function defaultPayload({ orgName, currency, locale } = {}) {
  const tenantId = slugify(orgName);
  return {
    tenantId,
    displayName: String(orgName ?? '').trim() || 'My app',
    bundleId: bundleIdFor(tenantId),
    logo: { light: '', dark: '' },
    icon: '',
    color: { accent: '#A6412F', ...NEUTRALS },
    type: { display: DISPLAY_FACES[0], body: BODY_FACES[0] },
    shape: { radius: 26 },
    currency: CURRENCIES.includes(String(currency).toUpperCase()) ? String(currency).toUpperCase() : 'GBP',
    locale: LOCALES.includes(locale) ? locale : 'en-GB',
    modules: { ordering: true, stamps: true, giftCards: true },
    support: { privacyUrl: '', supportUrl: '', termsUrl: '' },
  };
}

/** The row's payload with every key the form shows, so an old row never leaves a field undefined. */
export function withFormDefaults(payload, fallback) {
  const d = fallback || defaultPayload({});
  const p = payload || {};
  return {
    ...d,
    ...p,
    logo: { ...d.logo, ...(p.logo || {}) },
    color: { ...d.color, ...(p.color || {}) },
    type: { ...d.type, ...(p.type || {}) },
    shape: { ...d.shape, ...(p.shape || {}) },
    modules: { ...d.modules, ...(p.modules || {}) },
    support: { ...d.support, ...(p.support || {}) },
  };
}

/**
 * What the form says before it saves. Empty strings are the form's blanks: optional URLs and
 * assets are dropped from the saved payload, required ones block the save.
 */
export function formProblems(p) {
  const out = [];
  if (!TENANT_ID_RE.test(String(p?.tenantId ?? ''))) out.push('App id must be 2 to 32 lower case letters, digits or dashes, starting with a letter.');
  if (!String(p?.displayName ?? '').trim()) out.push('App name is required.');
  if (String(p?.displayName ?? '').trim().length > 30) out.push('App name must be 30 characters or fewer (Apple\'s limit).');
  if (p?.bundleId && !BUNDLE_ID_RE.test(p.bundleId)) out.push('Bundle id must look like uk.co.servos.yourapp.');
  if (!isHex(p?.color?.accent)) out.push('Accent colour must be a 6 digit hex like #A6412F.');
  if (!DISPLAY_FACES.includes(p?.type?.display)) out.push('Display typeface must be one of the approved faces.');
  if (!BODY_FACES.includes(p?.type?.body)) out.push('Body typeface must be one of the approved faces.');
  const r = Number(p?.shape?.radius);
  if (!Number.isInteger(r) || r < RADIUS_MIN || r > RADIUS_MAX) out.push(`Corner radius must be a whole number from ${RADIUS_MIN} to ${RADIUS_MAX}.`);
  if (!CURRENCIES.includes(p?.currency)) out.push('Currency must be one of the listed codes.');
  if (!LOCALES.includes(p?.locale)) out.push('Locale must be one of the listed codes.');
  for (const k of ['privacyUrl', 'supportUrl', 'termsUrl']) {
    const v = p?.support?.[k];
    if (v && !URL_RE.test(v)) out.push(`${k.replace('Url', '')} link must start with https://.`);
  }
  // The app needs both logos (the schema requires them): one for light grounds, one for the brand fill.
  if (!URL_RE.test(String(p?.logo?.light ?? ''))) out.push('Upload the logo for light backgrounds.');
  if (!URL_RE.test(String(p?.logo?.dark ?? ''))) out.push('Upload the logo for dark backgrounds.');
  if (p?.icon && !URL_RE.test(p.icon)) out.push('App icon must be an uploaded image.');
  return out;
}

/** The payload the app receives: blanks removed, hex upper cased, radius an integer. */
export function cleanPayload(p) {
  const support = {};
  for (const k of ['privacyUrl', 'supportUrl', 'termsUrl']) if (p?.support?.[k]) support[k] = String(p.support[k]).trim();
  const color = {};
  for (const [k, v] of Object.entries({ ...NEUTRALS, ...(p?.color || {}) })) color[k] = String(v).toUpperCase();
  const out = {
    tenantId: String(p?.tenantId ?? '').trim(),
    displayName: String(p?.displayName ?? '').trim(),
    bundleId: String(p?.bundleId || bundleIdFor(p?.tenantId)).trim(),
    logo: { light: String(p?.logo?.light ?? '').trim(), dark: String(p?.logo?.dark ?? '').trim() },
    color,
    type: { display: p?.type?.display, body: p?.type?.body },
    shape: { radius: Math.round(Number(p?.shape?.radius)) },
    currency: p?.currency,
    locale: p?.locale,
    modules: { ordering: !!p?.modules?.ordering, stamps: !!p?.modules?.stamps, giftCards: !!p?.modules?.giftCards },
  };
  if (p?.icon) out.icon = String(p.icon).trim();
  if (Object.keys(support).length) out.support = support;
  return out;
}

export function isHex(v) {
  return /^#[0-9a-f]{6}$/i.test(String(v ?? ''));
}

// ── Contrast, the same arithmetic as the app's src/theme/contrast.ts ──────────────────────
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Not a 6 digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
function channel(v) { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
export function luminance(hex) { const { r, g, b } = hexToRgb(hex); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
}
/** The same hue deepened until it reads at 4.5:1 on the ground; unchanged when it already does. */
export function reachContrast(colour, ground, min = MIN_CONTRAST) {
  if (contrastRatio(colour, ground) >= min) return colour.toUpperCase();
  const dir = luminance(ground) >= 0.5 ? -1 : 1;
  const hsl = rgbToHsl(hexToRgb(colour));
  let best = colour.toUpperCase();
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, Math.min(1, hsl.l + dir * step * 0.01));
    const candidate = rgbToHex(hslToRgb({ ...hsl, l }));
    best = candidate;
    if (contrastRatio(candidate, ground) >= min) return candidate;
    if (l === 0 || l === 1) break;
  }
  return best;
}

/** What the form prints next to the accent: the ratio, and the corrected colour the app will use for text. */
export function accentReadout(accent, surface = NEUTRALS.surface) {
  if (!isHex(accent)) return { ratio: 0, passes: false, accentText: null };
  const ratio = contrastRatio(accent, surface);
  const passes = ratio >= MIN_CONTRAST;
  return { ratio: Math.round(ratio * 10) / 10, passes, accentText: passes ? accent.toUpperCase() : reachContrast(accent, surface) };
}

/** Which organisation may hold this row: the row's org, or nobody when it belongs to another org. */
export function decideTenantWriter({ role, orgId, rowOrgId, orgRowTenantId, tenantId }) {
  if (role === 'super_admin') return { ok: true, via: 'super_admin' };
  if (!(role === 'owner' || role === 'admin') || !orgId) return { ok: false, code: 'forbidden' };
  if (rowOrgId && String(rowOrgId) !== String(orgId)) return { ok: false, code: 'tenant_taken' };
  if (orgRowTenantId && orgRowTenantId !== tenantId) return { ok: false, code: 'org_has_app', existing: orgRowTenantId };
  return { ok: true, via: 'owner_org' };
}
