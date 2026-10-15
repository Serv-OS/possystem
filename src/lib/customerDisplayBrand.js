// customerDisplayBrand.js: the customer display's own branding (30 Sep 2026).
//
// Peter, 30 Sep 2026: "The customer branding for the kiosk and the customer display should be
// separate, not sure why it would be the same". The display read the kiosk_brand_* columns of
// its device profile, and a till and a kiosk often share one profile (2 of 17 live profiles run
// both), so changing the kiosk's look in Back Office changed the display's look too.
//
// Where it is stored: device_profiles.customer_display_brand, its own jsonb column
// (supabase/migrations/20260930b_OPS_customer_display_branding.sql):
//   { name, color, bgColor, logoUrl }
// Not inside customer_display_images: Back Office builds from before this change are still
// running on some tills for days (the stale WebView), and they treat every entry of that array
// as an image URL, show an object as a broken tile, and write the array back from a stale copy.
// Old code never selects or writes a column it does not know. Until the migration runs the
// column is missing: the display reads without it and Back Office hides the editor
// (hasDisplayBrandColumn), so nothing breaks before it runs.
//
// How the display picks its look (resolveDisplayBrand), all or nothing:
//   own branding set (any field)  the display's own values; an empty field is the standard
//                                 value (venue name, standard green, Serv OS mark, the till's
//                                 light or dark background). Never the kiosk's: once set, a
//                                 kiosk change does not reach the display.
//   nothing set                   the kiosk values, exactly what the display showed before this
//                                 change, so nothing changes on screen until someone sets it.
// The background never comes from the kiosk: the display never used kiosk_brand_bg_color.
//
// Pure: imports nothing, so node:test can load it.

export const DISPLAY_BRAND_COLUMN = 'customer_display_brand';
export const DISPLAY_NAME_MAX = 60;
export const DEFAULT_DISPLAY_NAME = 'Serv OS';
// The accent the display used when no brand colour was set (CustomerDisplaySurface before 30 Sep).
export const DEFAULT_ACCENT_DARK = '#46E08C';
export const DEFAULT_ACCENT_LIGHT = '#0E9E55';
// The display's light theme text colour; a background is "light" when this reads better on it than white.
const INK = '#16191c';

export const EMPTY_DISPLAY_BRAND = Object.freeze({ name: '', color: '', bgColor: '', logoUrl: '' });
const COLOUR_FIELDS = ['color', 'bgColor'];

/** '#rrggbb' (lower case) for '#rgb', 'rgb', '#rrggbb' or 'rrggbb'; '' for anything else. */
export function normaliseHex(value) {
  const s = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) return '#' + s.split('').map(c => c + c).join('').toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
  return '';
}

function cleanUrl(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\/\S+$/i.test(s) ? s : '';
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, DISPLAY_NAME_MAX) : '';
}

/** The four fields, each a clean string ('' when empty or not usable). */
export function cleanDisplayBrand(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    name: cleanName(b.name),
    color: normaliseHex(b.color),
    bgColor: normaliseHex(b.bgColor),
    logoUrl: cleanUrl(b.logoUrl),
  };
}

/** True when any of the display's own branding fields is set. */
export function displayBrandIsSet(brand) {
  const b = cleanDisplayBrand(brand);
  return !!(b.name || b.color || b.bgColor || b.logoUrl);
}

/** The value Back Office writes to customer_display_brand: the cleaned fields, or null when none is set. */
export function displayBrandForDb(brand) {
  const b = cleanDisplayBrand(brand);
  return displayBrandIsSet(b) ? b : null;
}

/**
 * What a Back Office save writes when its editor changed the branding but the database copy has
 * moved on since the editor opened (another tab or manager saved it in the meantime).
 *   base    the branding as the editor opened with it
 *   mine    the branding as the editor holds it now
 *   theirs  the branding in the database at save time
 * Field by field: a field this editor changed takes its value (clearing included), any other
 * field keeps the database value. So a tab open since the morning that only picks an accent
 * colour cannot wipe a name and logo set elsewhere since. All three are cleaned first.
 */
export function mergeDisplayBrand(base, mine, theirs) {
  const b = cleanDisplayBrand(base);
  const m = cleanDisplayBrand(mine);
  const t = cleanDisplayBrand(theirs);
  const out = {};
  for (const k of Object.keys(EMPTY_DISPLAY_BRAND)) out[k] = m[k] !== b[k] ? m[k] : t[k];
  return out;
}

/** The colour fields typed in the editor that are not a colour code (Save waits until they are fixed or cleared). */
export function badDisplayBrandColours(brand) {
  const b = brand && typeof brand === 'object' ? brand : {};
  return COLOUR_FIELDS.filter(k => String(b[k] ?? '').trim() !== '' && !normaliseHex(b[k]));
}

/** The kiosk look as a starting point for the display's own (name, accent, logo; no background). */
export function displayBrandFromKiosk(kiosk) {
  const k = kiosk && typeof kiosk === 'object' ? kiosk : {};
  return cleanDisplayBrand({ name: k.name, color: k.color, logoUrl: k.logoUrl });
}

/**
 * True when a device_profiles row read with select('*') carries the display's branding column,
 * that is, the 20260930b migration has run. Back Office shows the editor and writes the column
 * only then; before it, PostgREST would refuse the whole save (PGRST204).
 */
export function hasDisplayBrandColumn(row) {
  return !!row && typeof row === 'object' && Object.prototype.hasOwnProperty.call(row, DISPLAY_BRAND_COLUMN);
}

function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** True when dark text reads better than white text on the colour. False for '' or junk. */
export function isLightColour(value) {
  const hex = normaliseHex(value);
  if (!hex) return false;
  const l = relativeLuminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onInk = (l + 0.05) / (relativeLuminance(INK) + 0.05);
  return onInk > onWhite;
}

/**
 * What the customer display shows.
 *   profile   the device_profiles row (customer_display_brand, and the kiosk_brand_name,
 *             kiosk_brand_color and kiosk_brand_logo_url it falls back to while that is empty)
 *   theme     the till's 'light' or 'dark' (anything else counts as dark, as before)
 *   placeName the venue name the device was paired with, the name used when nothing is set
 *
 * Returns { name, color, logoUrl, bgColor, dark, source, from }: bgColor is null unless the
 * display's own background is set, `dark` says which text palette to use, `source` is 'own'
 * (any own field set) or 'kiosk', and `from` says where each value came from ('own', 'kiosk'
 * or 'default') for Back Office and the tests.
 */
export function resolveDisplayBrand(profile, { theme = 'dark', placeName = '' } = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const own = cleanDisplayBrand(p[DISPLAY_BRAND_COLUMN]);
  const source = displayBrandIsSet(own) ? 'own' : 'kiosk';
  // Own branding: own values only. Nothing set: the kiosk values, truthy, exactly as read before.
  const set = source === 'own'
    ? own
    : { name: p.kiosk_brand_name, color: p.kiosk_brand_color, logoUrl: p.kiosk_brand_logo_url, bgColor: '' };
  const bgColor = set.bgColor || null;
  const dark = bgColor ? !isLightColour(bgColor) : theme !== 'light';
  const pick = (value, fallback) => (value ? [value, source] : [fallback, 'default']);
  const place = typeof placeName === 'string' ? placeName.trim() : '';
  const [name, nameFrom] = pick(set.name, place || DEFAULT_DISPLAY_NAME);
  const [color, colorFrom] = pick(set.color, dark ? DEFAULT_ACCENT_DARK : DEFAULT_ACCENT_LIGHT);
  const [logoUrl, logoFrom] = pick(set.logoUrl, '');
  return {
    name, color, logoUrl, bgColor, dark, source,
    from: { name: nameFrom, color: colorFrom, logo: logoFrom, bg: bgColor ? 'own' : 'default' },
  };
}
