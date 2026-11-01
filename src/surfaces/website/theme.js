// src/surfaces/website/theme.js
//
// The website theme contract (ARCHITECTURE.md section 5). One function, siteVars, turns the site's
// theme jsonb plus the venue's Appearance branding into the `--w-*` CSS variables every block
// uses. The SSR renderer emits them as a :root{} block and React sets them on the site wrapper,
// so the server paint and the React paint are the same colours.
//
// Rule from Peter: customer screens follow the Appearance branding, never random colours. The
// brand colour comes from online_branding.brand_color unless theme.brand_color overrides it, and
// the accent palette is deriveVars (the hue preserving engine the online menu already uses).
// Body text must read at 4.5:1 against the background in every mood; ensureContrast nudges the
// ink and the muted colour until they pass, so a bright brand colour can never make text vanish.
//
// Plain JS, no DOM: api/site.js imports this in Node.

import { deriveVars, THEME_DEFAULTS } from '../menu/menuTheme.js';

export const LAYOUTS = Object.freeze(['ember', 'ledger', 'marquee']);
export const TYPES = Object.freeze(['warm-serif', 'clean-sans', 'classic']);
export const BUTTONS = Object.freeze(['pill', 'rounded', 'square']);
export const MOODS = Object.freeze(['light', 'dark', 'brand']);
export const MIN_BODY_CONTRAST = 4.5;

// Display + body pairings. `google` is the css2 family list for fontLinks.
export const TYPE_PAIRINGS = Object.freeze({
  'warm-serif': {
    display: "'Fraunces', Georgia, serif", body: "'Hanken Grotesk', system-ui, sans-serif",
    google: ['Fraunces:opsz,wght@9..144,500;9..144,700', 'Hanken+Grotesk:wght@400;500;600;700'],
  },
  'clean-sans': {
    display: "'Space Grotesk', system-ui, sans-serif", body: "'Inter', system-ui, sans-serif",
    google: ['Space+Grotesk:wght@500;600;700', 'Inter:wght@400;500;600'],
  },
  classic: {
    display: "'Playfair Display', Georgia, serif", body: "'Source Sans 3', system-ui, sans-serif",
    google: ['Playfair+Display:wght@500;600;700', 'Source+Sans+3:wght@400;500;600'],
  },
});

const RADIUS = Object.freeze({ pill: '999px', rounded: '12px', square: '2px' });

// Paper and ink. The light mood reuses the online menu's fixed paper; the dark mood is the ServOS
// ink family (deep, slightly warm, never pure black so photos and cards still separate).
const PAPER = { bg: '#f6f2ec', card: '#ffffff', ink: '#241f1c', muted: '#6b615a', line: '#ece4da' };
const INK = { bg: '#14110f', card: '#1f1a17', ink: '#f6f2ec', muted: '#b8aea5', line: '#2d2622' };

// ── colour maths ─────────────────────────────────────────────────────────────
export function hexToRgb(hex) {
  const c = String(hex || '').trim().replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const m = /^[0-9a-fA-F]{6}$/.test(n) ? n : '000000';
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  const h = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
function mix(hex, towards, amount) {
  const a = hexToRgb(hex), t = hexToRgb(towards);
  return rgbToHex(a[0] + (t[0] - a[0]) * amount, a[1] + (t[1] - a[1]) * amount, a[2] + (t[2] - a[2]) * amount);
}
export function isLightColor(hex) { return luminance(hex) > 0.4; }

/**
 * 5.12.9 Row block: true when white text reads better than black on this background, so a row
 * with a dark owner colour gets light text. Pure: a 3 or 6 digit hex (with or without #) only;
 * anything else is false (no colour = inherit the page tone).
 */
export function isDarkHex(hex) {
  const v = String(hex || '').trim();
  if (!/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return false;
  return contrastRatio('#ffffff', v) >= contrastRatio('#000000', v);
}

/**
 * Move `fg` towards white or black in small steps until it reads at `min` contrast against `bg`,
 * taking whichever direction gets there with the smaller change. When neither extreme reaches
 * `min` (a mid grey background) the extreme with the higher contrast is returned.
 */
export function ensureContrast(fg, bg, min = MIN_BODY_CONTRAST) {
  if (contrastRatio(fg, bg) >= min) return fg;
  let best = null;
  for (const towards of ['#ffffff', '#000000']) {
    for (let i = 1; i <= 20; i++) {
      const c = mix(fg, towards, i / 20);
      if (contrastRatio(c, bg) >= min) { if (!best || i < best.i) best = { i, c }; break; }
    }
  }
  if (best) return best.c;
  return contrastRatio('#ffffff', bg) >= contrastRatio('#000000', bg) ? '#ffffff' : '#000000';
}

const validHex = (v) => /^#?[0-9a-fA-F]{6}$/.test(String(v || '').trim()) || /^#?[0-9a-fA-F]{3}$/.test(String(v || '').trim());
const withHash = (v) => (String(v).startsWith('#') ? String(v) : `#${v}`);

/** The theme with every field valid (bad or missing values fall to the defaults). */
export function normaliseTheme(theme) {
  const t = theme && typeof theme === 'object' ? theme : {};
  return {
    layout: LAYOUTS.includes(t.layout) ? t.layout : 'ember',
    type: TYPES.includes(t.type) ? t.type : 'warm-serif',
    buttons: BUTTONS.includes(t.buttons) ? t.buttons : 'rounded',
    mood: MOODS.includes(t.mood) ? t.mood : 'light',
    brand_color: validHex(t.brand_color) ? withHash(String(t.brand_color).trim()) : null,
  };
}

/** The brand colour in force: theme override, else Appearance branding, else the ServOS default. */
export function brandColorFor(theme, onlineBranding) {
  const t = normaliseTheme(theme);
  if (t.brand_color) return t.brand_color;
  const b = onlineBranding && onlineBranding.brand_color;
  return validHex(b) ? withHash(String(b).trim()) : THEME_DEFAULTS.brandColor;
}

/**
 * siteVars(theme, onlineBranding) → { '--w-bg': ..., ... }. Every value is a CSS value string.
 * Keys: --w-bg --w-card --w-ink --w-muted --w-line --w-brand --w-brand-deep --w-on-brand --w-warm
 *       --w-radius --w-font-display --w-font-body
 */
export function siteVars(theme, onlineBranding) {
  const t = normaliseTheme(theme);
  const brand = brandColorFor(t, onlineBranding);
  const d = deriveVars(brand);
  const pair = TYPE_PAIRINGS[t.type];
  let bg, card, ink, muted, line, accent, accentDeep, onAccent, warm;
  if (t.mood === 'dark') {
    ({ bg, card, ink, muted, line } = INK);
    // A dark brand colour disappears on ink: lift the accent until buttons read.
    accent = ensureContrast(d['--brand'], bg, 3);
    accentDeep = mix(accent, '#ffffff', 0.15);
    warm = d['--ember1'];
  } else if (t.mood === 'brand') {
    // The brand colour IS the page. Text is paper or ink, whichever reads; buttons invert.
    bg = brand;
    card = isLightColor(brand) ? mix(brand, '#ffffff', 0.55) : mix(brand, '#000000', 0.28);
    ink = isLightColor(brand) ? PAPER.ink : PAPER.bg;
    muted = isLightColor(brand) ? mix(brand, '#000000', 0.55) : mix(brand, '#ffffff', 0.7);
    line = isLightColor(brand) ? mix(brand, '#000000', 0.12) : mix(brand, '#ffffff', 0.18);
    accent = ink;
    accentDeep = isLightColor(brand) ? '#000000' : '#ffffff';
    warm = d['--ember1'];
  } else {
    ({ bg, card, ink, muted, line } = PAPER);
    accent = ensureContrast(d['--brand'], bg, 3);
    accentDeep = d['--brand-deep'];
    warm = d['--ember1'];
  }
  ink = ensureContrast(ink, bg);
  muted = ensureContrast(muted, bg);
  // Button text: white when it reads (the storefront look), else ink; 3:1 is the UI floor (WCAG AA).
  onAccent = contrastRatio('#ffffff', accent) >= 3 ? '#ffffff' : ensureContrast(PAPER.ink, accent, 3);
  return {
    '--w-bg': bg,
    '--w-card': card,
    '--w-ink': ink,
    '--w-muted': muted,
    '--w-line': line,
    '--w-brand': accent,
    '--w-brand-deep': accentDeep,
    '--w-on-brand': onAccent,
    '--w-warm': warm,
    // Text over a hero photo always sits on a dark scrim, whatever the mood.
    '--w-on-photo': '#ffffff',
    '--w-scrim': 'linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.72))',
    // 5.12.9 Row block: dark text for a row the owner set to a light tone, and the even "darken"
    // layer over a row photo (the hero scrim fades in from the top, a row needs the whole photo dimmed).
    '--w-on-light': PAPER.ink,
    '--w-dim': 'rgba(0,0,0,.5)',
    '--w-radius': RADIUS[t.buttons],
    '--w-font-display': pair.display,
    '--w-font-body': pair.body,
  };
}

/** A :root{} block for the SSR head. Values are CSS tokens we built, never user text. */
export function cssText(vars) {
  const v = vars && typeof vars === 'object' ? vars : {};
  const body = Object.entries(v)
    .filter(([k, val]) => /^--w-[a-z-]+$/.test(k) && typeof val === 'string' && !/[<>{};]/.test(val))
    .map(([k, val]) => `${k}:${val}`)
    .join(';');
  return `:root{${body}}`;
}

/** Google Fonts css2 hrefs for the theme's type pairing (one link, both families). */
export function fontLinks(theme) {
  const t = normaliseTheme(theme);
  const fams = TYPE_PAIRINGS[t.type].google.map((f) => `family=${f}`).join('&');
  return [`https://fonts.googleapis.com/css2?${fams}&display=swap`];
}

/** The theme colour for <meta name="theme-color">: the page background. */
export function themeColor(vars) {
  return (vars && vars['--w-bg']) || PAPER.bg;
}
