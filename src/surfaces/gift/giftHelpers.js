// v5.5.208 — Shared helpers for customer-facing gift card surfaces.
// Calls the Ops DB edge functions. Customer surfaces use anon-key auth
// (same pattern as OnlineCheckout).

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ── Branding cache (per company, per page load) ────────────────────────────
const _brandingCache = {};

/**
 * Fetch gift-specific branding for a company from gift_brand_config.
 * Returns the branding object or null. Caches per company_id.
 */
export async function fetchGiftBranding(companyId) {
  if (!companyId) return null;
  if (_brandingCache[companyId] !== undefined) return _brandingCache[companyId];
  try {
    const data = await callGiftPublic('gift-branding-public', { company_id: companyId });
    _brandingCache[companyId] = data?.branding || null;
    return _brandingCache[companyId];
  } catch {
    _brandingCache[companyId] = null;
    return null;
  }
}

/**
 * Call a gift-card edge function on the Ops DB project.
 * For customer-facing (anonymous) calls, we pass the anon key as bearer.
 */
export async function callGiftPublic(fnName, body) {
  const res = await fetch(`${OPS_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPS_ANON}`,
      'apikey': OPS_ANON,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** Format minor currency units → display string (e.g. 2500 → "£25.00") */
export function formatAmount(minor, currency = 'gbp') {
  const major = (minor || 0) / 100;
  const sym = currency === 'usd' ? '$' : '£';
  return `${sym}${major.toFixed(2)}`;
}

/** Common preset amounts for gift card purchase (minor units) */
export const PRESET_AMOUNTS = [1000, 2000, 2500, 5000, 7500, 10000];

// ── Default dark theme (fallback when no branding is set) ───────────────
const DEFAULT_THEME = {
  bg: '#0e0e10',
  card: 'rgba(255,255,255,0.07)',
  border: 'rgba(255,255,255,0.14)',
  inputBg: 'rgba(0,0,0,0.25)',
  accent: '#e8a020',
  accentHover: '#f0b040',
  accentText: '#0b0c10',
  text: '#fff',
  textMuted: 'rgba(255,255,255,0.65)',
  textDim: 'rgba(255,255,255,0.35)',
  error: '#ff4466',
  success: '#22c55e',
  radius: 14,
  logo: null,
  hero: null,
  companyName: null,
};

/**
 * Build a theme object from gift-specific branding if set, otherwise from
 * the location's online_branding. Falls back to the default dark theme if
 * neither is configured.
 *
 * v5.5.209: rgba-based cards and borders that adapt to ANY background.
 * Section labels use foreground (not accent). Added inputBg for sunken
 * text fields. Accent is reserved for interactive elements only.
 *
 * @param {object} location - Platform DB location row (has online_branding)
 * @param {object} [giftBranding] - gift_brand_config.branding (per-feature override)
 */
export function buildGiftTheme(location, giftBranding) {
  // v5.5.897 (Appearance hub, slice 1): PER-KEY resolution — the previous
  // `online_branding || giftBranding` took whichever object existed WHOLESALE, so a venue
  // with only (say) a logo set lost its gift accent AND fell to the dark default for
  // everything else. Every key now resolves independently:
  //     online_branding.key → gift_brand_config.branding.key → legacy alias → STOREFRONT default
  // The unbranded default is now the same warm-light storefront palette customers see on the
  // online menu (#f6f2ec / #e2581f) — ONE unbranded look everywhere. Venues that want the old
  // dark look set online_branding.portal.scheme = 'dark' in Appearance → Loyalty portal.
  const b1 = location?.online_branding || {};
  const b2 = giftBranding || {};
  const pb = b1.portal || {};   // portal/gift page overrides: { scheme, background, show_hero }

  // Background: portal override → scheme forcing → per-key chain → warm storefront default.
  const scheme = ['match', 'light', 'dark'].includes(pb.scheme) ? pb.scheme : 'match';
  let bg;
  if (pb.background) bg = pb.background;
  else if (scheme === 'dark') bg = '#0e0e10';
  else if (scheme === 'light') bg = '#f6f2ec';
  else bg = b1.background || b2.background || '#f6f2ec';

  // Accent: one brand colour drives everything (legacy gift accent as fallback only).
  const accent = b1.brand_color || b2.accent_color || b2.brand_color || '#e2581f';

  const bgLum = luminance(bg);
  const isDark = bgLum < 0.45;
  // Auto-contrast text against the chosen background (a stale stored foreground could
  // otherwise be unreadable — deliberate, unchanged behaviour).
  const fg = isDark ? '#ffffff' : '#16191c';
  return {
    bg,
    // Cards: transparent overlays that adapt to any background colour
    card: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    border: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
    // Input fields sit inside cards — slightly darker to create a "sunken" look
    inputBg: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.06)',
    accent,
    accentHover: isDark ? lightenColor(accent, 0.12) : darkenColor(accent, 0.12),
    // Button text: auto-contrast — dark text on light accent, white on dark
    accentText: luminance(accent) > 0.45 ? '#0b0c10' : '#ffffff',
    text: fg,
    textMuted: blendColor(bg, fg, 0.65),
    textDim: blendColor(bg, fg, 0.38),
    error: '#ff4466',
    success: '#22c55e',
    radius: 14,
    logo: b1.logo_url || b2.logo_url || null,
    hero: b1.hero_url || b2.hero_url || null,
    showHero: pb.show_hero === true,   // portal/gift pages render the hero banner only when opted in
    isDark,                            // consumers use this instead of sniffing bg === '#0e0e10'
    // Display name: trading name override → venue name → company (legal) name.
    companyName: b1.display_name || location?.name || location?.company_name || null,
    showPoweredBy: b1.show_powered_by !== false,
  };
}

// ── Colour utilities ────────────────────────────────────────────────────

/** Parse hex to [r,g,b] 0-255. */
function parseHex(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

/** Format [r,g,b] → hex string. */
function toHex(r, g, b) {
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

/** Blend two hex colours. t=0 → bg, t=1 → fg. */
function blendColor(bg, fg, t) {
  try {
    const [br,bg2,bb] = parseHex(bg);
    const [fr,fg2,fb] = parseHex(fg);
    const r = Math.round(br + (fr - br) * t);
    const g = Math.round(bg2 + (fg2 - bg2) * t);
    const b2 = Math.round(bb + (fb - bb) * t);
    return toHex(r, g, b2);
  } catch {
    return t > 0.5 ? fg : bg;
  }
}

/** Relative luminance (0-1) for contrast decisions. */
function luminance(hex) {
  try {
    const [r, g, b] = parseHex(hex).map(c => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  } catch { return 0.5; }
}

/** Lighten a hex colour by a factor (0-1). */
function lightenColor(hex, amount) {
  try {
    const [r, g, b] = parseHex(hex);
    return toHex(
      Math.min(255, Math.round(r + (255 - r) * amount)),
      Math.min(255, Math.round(g + (255 - g) * amount)),
      Math.min(255, Math.round(b + (255 - b) * amount)),
    );
  } catch { return hex; }
}

/** Darken a hex colour by a factor (0-1). */
function darkenColor(hex, amount) {
  try {
    const [r, g, b] = parseHex(hex);
    return toHex(
      Math.round(r * (1 - amount)),
      Math.round(g * (1 - amount)),
      Math.round(b * (1 - amount)),
    );
  } catch { return hex; }
}

/**
 * Build a customer-facing gift URL that preserves the slug context.
 * On subdomain hosts (posup-test.serv-os.app) the slug is implicit.
 * On Vercel/test hosts (?loc=posup-test) we must carry the ?loc= param
 * forward, otherwise the link falls through to back office.
 */
export function giftUrl(path) {
  const params = new URLSearchParams(window.location.search);
  const loc = params.get('loc');
  const base = `${window.location.origin}${path}`;
  return loc ? `${base}?loc=${encodeURIComponent(loc)}` : base;
}

/** Legacy export — kept for import compatibility, returns default theme */
export const giftTheme = DEFAULT_THEME;
