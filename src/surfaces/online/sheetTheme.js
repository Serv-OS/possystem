// src/surfaces/online/sheetTheme.js
//
// The theme object OnlineItemSheet reads (accent, bg, fg, isLight, ...), built
// from a venue's online branding. ONE builder, shared by the storefront
// (OnlineSurface) and the guest booking page's pre-order choices
// (BookingWidget, 10 Sep 2026), so the sheet looks the same in both.
// Moved here verbatim from OnlineSurface.jsx.

export const FALLBACK_ACCENT = '#e8a020';
export const FALLBACK_BG     = '#ffffff';
export const FALLBACK_FG     = '#1a1a1a';

// Some venues saved a colour without its leading # (a bare hex). The item
// sheet rendered fully transparent and the sticky bar fell back to white, while
// the rest of the page looked right because the newer theme pipeline repairs
// the value on its way through. Repair it here too, on read, so existing venues
// are fixed without anybody having to re-save. (v5.7.80)
export function normaliseColour(v) {
  if (!v) return null;
  const t = String(v).trim();
  if (!t) return null;
  if (/^#/.test(t)) return t;
  // A bare 3, 4, 6 or 8 digit hex is the case we have actually seen in the wild.
  if (/^[0-9a-f]{3,8}$/i.test(t) && [3, 4, 6, 8].includes(t.length)) return `#${t}`;
  return t;   // named colours, rgb(), anything else: leave alone
}

export function isLightBackground(hex) {
  if (!hex) return true;
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return true;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  // Standard luminance check
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
}

export function sheetThemeFrom(branding, name) {
  return {
    // Menu Appearance saves the brand colour as `brand_color` — prefer it (accent_color is legacy).
    accent: normaliseColour(branding?.brand_color || branding?.accent_color) || FALLBACK_ACCENT,
    bg:     normaliseColour(branding?.background) || FALLBACK_BG,
    fg:     normaliseColour(branding?.foreground) || FALLBACK_FG,
    logo:   branding?.logo_url      || null,
    hero:   branding?.hero_url      || null,
    logoShape: branding?.logo_shape || 'rounded',
    headerStyle: branding?.header_style || 'cinematic',
    name:   name                    || 'Restaurant',
    isLight: isLightBackground(normaliseColour(branding?.background) || FALLBACK_BG),
  };
}
