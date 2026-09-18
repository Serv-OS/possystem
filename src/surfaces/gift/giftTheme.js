// src/surfaces/gift/giftTheme.js
//
// The pure parts of the gift card pages: the theme built from a venue's branding
// (including the gift card art), the preset amounts and the card value limits.
// No network and no Vite settings here, so node tests can load it. giftHelpers.js
// re-exports everything, so existing imports keep working.

export const PRESET_AMOUNTS = [1000, 2000, 2500, 5000, 7500, 10000];

/** The limits gift-checkout-session enforces when nothing is set (500 and 50000 minor units). */
export const GIFT_DEFAULT_LIMITS = { minMinor: 500, maxMinor: 50000 };

export function normaliseGiftLimits(limits) {
  const min = Number(limits?.min_minor) > 0 ? Number(limits.min_minor) : GIFT_DEFAULT_LIMITS.minMinor;
  const max = Number(limits?.max_minor) > 0 ? Number(limits.max_minor) : GIFT_DEFAULT_LIMITS.maxMinor;
  return max >= min ? { minMinor: min, maxMinor: max } : { ...GIFT_DEFAULT_LIMITS };
}

/**
 * The preset amounts to show: the standard list, without any the venue's limits
 * would refuse. The live page and the Back Office preview both use this, so the
 * preview shows what customers really see. Never empty: if the limits exclude
 * every preset, the minimum is offered.
 */
export function giftPresetsFor(limits = GIFT_DEFAULT_LIMITS) {
  const minMinor = Number(limits?.minMinor) || GIFT_DEFAULT_LIMITS.minMinor;
  const maxMinor = Number(limits?.maxMinor) || GIFT_DEFAULT_LIMITS.maxMinor;
  const inRange = PRESET_AMOUNTS.filter((a) => a >= minMinor && a <= maxMinor);
  return inRange.length ? inRange : [minMinor];
}

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
  cardArt: null,
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
    // Gift card art, uploaded in Back Office, Appearance, Gift cards (~1200x750).
    // Saved as online_branding.gift.card_art_url; the live page never read it before.
    cardArt: safeImageUrl((b1.gift && b1.gift.card_art_url) || b2.card_art_url),
    showHero: pb.show_hero === true,   // portal/gift pages render the hero banner only when opted in
    isDark,                            // consumers use this instead of sniffing bg === '#0e0e10'
    // Display name: trading name override → venue name → company (legal) name.
    companyName: b1.display_name || location?.name || location?.company_name || null,
    showPoweredBy: b1.show_powered_by !== false,
  };
}

/** Only an http(s) address is used as an image source; anything else is ignored. */
function safeImageUrl(v) {
  const u = typeof v === 'string' ? v.trim() : '';
  return /^https?:\/\//i.test(u) ? u : null;
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
export const giftTheme = DEFAULT_THEME;
