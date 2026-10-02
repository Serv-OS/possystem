// src/lib/customerDisplayAccent.js
//
// The customer display's accent colour (the big total, the quantities, the borders, the phone
// keypad button) only when it can be read on the display.
//
// 30 Sep 2026 (Peter: "we made brand changes to the Kiosk and it's made changes to the customer
// display?"). Yes: the display reads the kiosk branding (kiosk_brand_color, logo, name) from its
// own device profile, and at Coffee Boy Barnsley Kiosk 1 and POS 1 share one profile ("Main").
// Back Office Kiosk Settings saved the brand colour '#000000' there, and the display is dark
// (#0F1211), so every total and quantity on it turned black on near black: effectively gone.
//
// The rule: the brand colour is used when it reads against the display's background at 3:1 or
// better (the WCAG figure for large bold text; everything drawn in the accent is 20px and bold
// or larger). Otherwise the display keeps its own ServOS green for its light or dark look, as
// when no colour is set. The colour is handed back as '#rrggbb', so the display's '<colour>44'
// style tints stay valid CSS.
//
// 2 Oct 2026 (merged with the display's own branding, lib/customerDisplayBrand.js): that resolver
// says WHICH colour is the brand (the display's own, else the kiosk's, exactly as stored, so a
// black one still comes through) and whether the display has its own background. This rule runs
// after it, against the background the display really has. An own background can be one the
// ServOS green does not read on either (a mid red, a green), so with `text` given the last
// resort is the display's text colour, which the resolver picks to read on that background.
//
// Pure: imports only kioskTheme.js (itself pure), so node:test can load it.
import { parseCssColor, contrastRatio } from './kioskTheme.js';

// The accents the display used when no brand colour was set (CustomerDisplaySurface).
export const DISPLAY_ACCENT_DARK = '#46E08C';
export const DISPLAY_ACCENT_LIGHT = '#0E9E55';
// The display's own backgrounds (CustomerDisplaySurface palette()).
export const DISPLAY_BG_DARK = '#0F1211';
export const DISPLAY_BG_LIGHT = '#F4F6F2';
export const MIN_ACCENT_CONTRAST = 3;

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');

const groundFor = (dark, bg) => parseCssColor(bg) || parseCssColor(dark ? DISPLAY_BG_DARK : DISPLAY_BG_LIGHT);

/**
 * True when `color` is a colour and does NOT read on the display's background, that is, when
 * displayAccent swaps it for another. Back Office uses it to say so beside its preview.
 */
export function accentUnreadable(color, { dark = true, bg = null } = {}) {
  const rgb = parseCssColor(color);
  const ground = groundFor(dark, bg);
  return !!rgb && !!ground && contrastRatio(rgb, ground) < MIN_ACCENT_CONTRAST;
}

/**
 * The accent colour for the display.
 *   color  the brand colour (the display's own, else the kiosk's kiosk_brand_color)
 *   dark   true for the dark look (the default), false for light
 *   bg     the background it is drawn on; the look's own background when not given
 *   text   the display's text colour, the last resort on an own background where neither the
 *          brand colour nor the default accent reads; not given, the default accent is the end
 * Returns '#rrggbb': the colour when it reads on the background, else the default accent, else
 * (only when that does not read either and `text` does) the text colour.
 */
export function displayAccent(color, { dark = true, bg = null, text = null } = {}) {
  const fallback = dark ? DISPLAY_ACCENT_DARK : DISPLAY_ACCENT_LIGHT;
  const ground = groundFor(dark, bg);
  if (!ground) return fallback;
  const reads = (rgb) => !!rgb && contrastRatio(rgb, ground) >= MIN_ACCENT_CONTRAST;
  const rgb = parseCssColor(color);
  if (reads(rgb)) return '#' + rgb.map(hex2).join('');
  if (reads(parseCssColor(fallback))) return fallback;
  const ink = parseCssColor(text);
  return reads(ink) ? '#' + ink.map(hex2).join('') : fallback;
}
