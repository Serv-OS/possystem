// src/surfaces/menu/menuTheme.js
//
// Shared theme engine for the customer menu (online ordering + catering + the back-office
// "Menu appearance" preview). One brand colour drives the whole accent palette; the rest are fixed
// tokens. CSS custom properties go on a root wrapper (deriveVars) so any brand colour works and the
// orange is never hard-coded anywhere downstream.
//
// MenuTheme (persisted on the location's online_branding jsonb — no migration, it's already jsonb):
//   brand_color, header_style ('cinematic'|'framed'|'compact'), hero_url (header image),
//   logo_url, logo_shape ('auto'|'square'|'wide'|'tall'|'circle'), show_open_status

export const FIXED = { ink: '#241f1c', muted: '#82776e', bg: '#f6f2ec', card: '#ffffff', line: '#ece4da' };
export const DISPLAY_FONT = "'Space Grotesk', system-ui, sans-serif";
export const BODY_FONT = "'Hanken Grotesk', system-ui, sans-serif";
export const THEME_DEFAULTS = { brandColor: '#e2581f', headerStyle: 'cinematic', headerImageUrl: null, logoUrl: null, logoShape: 'auto', showOpenStatus: true };

// ── colour maths (no external lib) ───────────────────────────────────────────
function hexToRgb(hex) {
  const c = String(hex || '').trim().replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const m = /^[0-9a-fA-F]{6}$/.test(n) ? n : 'e2581f';
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) { const h = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'); return `#${h(r)}${h(g)}${h(b)}`; }
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
    const t2c = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    r = t2c(h + 1 / 3); g = t2c(h); b = t2c(h - 1 / 3);
  }
  return rgbToHex(r * 255, g * 255, b * 255);
}
export function isLight(hex) { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) > 150; }
export function readableOn(hex) { return isLight(hex) ? '#241f1c' : '#ffffff'; }

// brandColor → { --brand, --brand-deep, --ember1, --ember2, + fixed tokens }. Matches the prototype
// for #e2581f and generalises to any hue (embers keep the brand hue so non-orange brands stay on-brand).
export function deriveVars(brandColor, bodyBg) {
  const brand = /^#?[0-9a-fA-F]{3,6}$/.test(String(brandColor || '')) ? (String(brandColor).startsWith('#') ? brandColor : `#${brandColor}`) : THEME_DEFAULTS.brandColor;
  const [h, s, l] = rgbToHsl(...hexToRgb(brand));
  // v5.5.744: the storefront body background is now operator-controllable (Menu appearance → Body
  // background colour, stored on online_branding.background). Falls back to the warm default.
  const bg = /^#?[0-9a-fA-F]{3,6}$/.test(String(bodyBg || '')) ? (String(bodyBg).startsWith('#') ? bodyBg : `#${bodyBg}`) : FIXED.bg;
  return {
    '--brand': brand,
    '--brand-deep': hslToHex(h, Math.min(100, s + 6), l * 0.76),
    '--ember1': hslToHex(h + 6, Math.min(100, s + 20), Math.min(92, l + 9)),
    '--ember2': hslToHex(h - 4, Math.min(100, s + 12), l * 0.82),
    '--ink': FIXED.ink, '--muted': FIXED.muted, '--bg': bg, '--card': FIXED.card, '--line': FIXED.line,
  };
}

// Read a MenuTheme out of a location's online_branding (or receipt_branding) jsonb.
export function readTheme(branding) {
  const b = branding || {};
  return {
    brandColor: b.brand_color || THEME_DEFAULTS.brandColor,
    headerStyle: ['cinematic', 'framed', 'compact'].includes(b.header_style) ? b.header_style : THEME_DEFAULTS.headerStyle,
    headerImageUrl: b.hero_url || null,
    logoUrl: b.logo_url || null,
    logoShape: ['auto', 'square', 'wide', 'tall', 'circle'].includes(b.logo_shape) ? b.logo_shape : THEME_DEFAULTS.logoShape,
    showOpenStatus: b.show_open_status !== false,
    bodyBg: b.background || null,   // v5.5.744: operator-set storefront body background
  };
}

// Logo plate geometry from the shape (auto = let the image's own ratio drive width).
export function logoGeom(shape) {
  const circle = shape === 'circle';
  return {
    plateRadius: circle ? '50%' : '16px',
    imgRadius: circle ? '50%' : '10px',
    aspect: { square: '1 / 1', wide: '2.6 / 1', tall: '0.72 / 1', circle: '1 / 1' }[shape] || null, // null = auto (intrinsic)
    fit: circle ? 'cover' : 'contain',
  };
}

export const EMBER_GRADIENT = 'radial-gradient(125% 150% at 14% 130%, var(--ember1) 0%, var(--ember2) 24%, #6f1c08 46%, #2a0f08 70%, #160a06 100%)';
