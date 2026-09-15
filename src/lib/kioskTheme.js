/**
 * kioskTheme.js: the new kiosk design look (decision 1: the design is the DEFAULT theme,
 * a venue can still change its main colour and logo).
 *
 * Pure: imports only categoryPhoto.js (itself import free), so node:test can load it.
 *
 * Static tokens (cream ground, ink, hairlines) live in globals.css under
 * [data-kiosk-theme="design"] and are mirrored in DESIGN_TOKENS (kioskTheme.test.js checks
 * the two agree). The venue colour is the only per venue token: kioskThemeVars() sets it
 * inline on the kiosk shell, with a deep shade, a light tint and the text colour to use
 * on it.
 */
import { safeCssColor } from './categoryPhoto.js';

export const DESIGN_GREEN = '#4E7B27';
export const DESIGN_INK = '#14110F';
// The old kiosk default colour. A profile still on it never chose a colour, so it gets
// the design green.
export const OLD_DEFAULT_BRAND = '#f97316';

export const DESIGN_TOKENS = Object.freeze({
  '--k2Ground': '#EFE4D9',
  '--k2GroundDeep': '#E5D8CA',
  '--k2Surface': '#FFFFFF',
  '--k2Sunken': '#FBF8F4',
  '--k2Muted': '#F7F4F0',
  '--k2Neutral': '#F1ECE6',
  '--k2Ink': '#14110F',
  '--k2InkBody': '#2A241E',
  '--k2InkMuted': '#5B5348',
  '--k2InkSubtle': '#7A6F63',
  '--k2InkOnDark': '#9C9388',
  '--k2Hairline': '#E7DFD6',
  '--k2Divider': '#F1ECE6',
  '--k2WarnBorder': '#E2C88A',
  '--k2WarnFill': '#FCF4E2',
  '--k2WarnInk': '#8A6A1E',
  '--k2Scrim': 'rgba(20,17,15,.45)',
  // Not in the README: the Unsafe badge and error text, and disabled buttons.
  '--k2Danger': '#B3261E',
  '--k2DangerFill': '#FBEAE8',
  '--k2Disabled': '#E2DDD6',
});

const DESIGN_PALETTE = Object.freeze({
  primary: DESIGN_GREEN,
  primaryDeep: '#3E6320',
  primaryTint: '#EDF3E6',
  onPrimary: '#FFFFFF',
  primaryInk: DESIGN_GREEN,
  primaryLine: DESIGN_GREEN,
  onInkEdge: 'none',
});

const WHITE_RGB = [255, 255, 255];
const GROUND_RGB = [0xEF, 0xE4, 0xD9];
const INK_RGB = [0x14, 0x11, 0x0F];

// CSS named colours (name:rrggbb), so a venue that typed "yellow" still gets readable
// text on its buttons.
const NAMED = new Map((
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,' +
  'bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,' +
  'burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,' +
  'cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,' +
  'darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,' +
  'darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
  'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
  'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,' +
  'dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,' +
  'fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,' +
  'green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,' +
  'indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,' +
  'lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,' +
  'lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,' +
  'lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
  'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,' +
  'maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,' +
  'mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,' +
  'mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,' +
  'navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,' +
  'orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,' +
  'palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,' +
  'powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,' +
  'saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,' +
  'silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,' +
  'springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,' +
  'turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,' +
  'yellowgreen:9acd32'
  ).split(',').map(p => p.split(':')),
);

function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

function hexOf(r, g, b) {
  return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
}

function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s <= 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

function rgbToHsl(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h * 60, s, l];
}

/** [r, g, b] (0 to 255) for a colour safeCssColor accepts, or null when it cannot be read. */
export function parseCssColor(input) {
  const c = safeCssColor(input);
  if (!c) return null;
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (NAMED.has(c)) return parseCssColor('#' + NAMED.get(c));
  m = /^(rgba?|hsla?)\((.*)\)$/i.exec(c);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const numOf = (s, scale) => {
    const v = parseFloat(s);
    if (!Number.isFinite(v)) return NaN;
    return s.endsWith('%') ? (v / 100) * scale : v;
  };
  if (m[1].toLowerCase().startsWith('rgb')) {
    const rgb = parts.slice(0, 3).map(s => numOf(s, 255));
    return rgb.some(Number.isNaN) ? null : rgb.map(clamp255);
  }
  const h = parseFloat(parts[0]);
  const s = numOf(parts[1], 1);
  const l = numOf(parts[2], 1);
  if (![h, s, l].every(Number.isFinite)) return null;
  return hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))).map(clamp255);
}

function luminance([r, g, b]) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of white text on the colour. */
export function contrastWithWhite(rgb) {
  return 1.05 / (luminance(rgb) + 0.05);
}

/** WCAG contrast ratio between two [r, g, b] colours. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The colour darkened in HSL lightness steps of 0.04 until readsOk(colour) is true
// (lightness 0 is the stop).
function darkenUntil(rgb, readsOk) {
  const [h, s, l0] = rgbToHsl(...rgb);
  let l = l0;
  let cur = rgb.map(clamp255);
  while (l > 0 && !readsOk(cur)) {
    l = Math.max(0, l - 0.04);
    cur = hslToRgb(h, s, l).map(clamp255);
  }
  return cur;
}

/**
 * The kiosk's main colour: the venue's kiosk_brand_color, or the design green when it is
 * empty, not a safe colour, not a colour a browser knows, or still the old untouched
 * orange default.
 */
export function kioskPrimary(profile) {
  const raw = profile?.kiosk_brand_color;
  const safe = safeCssColor(raw);
  // A word that is not a real colour (a typo) would paint every button invisible.
  if (!safe || safe === OLD_DEFAULT_BRAND || !parseCssColor(safe)) return DESIGN_GREEN;
  if (safe === DESIGN_GREEN.toLowerCase()) return DESIGN_GREEN;
  return safe;
}

/**
 * { primary, primaryDeep, primaryTint, onPrimary, primaryInk, primaryLine, onInkEdge } for a
 * main colour. primaryInk is the colour darkened until it reads as text on white and on the
 * tint; primaryLine is darkened until it reads as a border on white and on the cream ground;
 * onInkEdge is a light inset edge for a button in the colour on the ink order bar.
 * The design green gives exactly the README values. Any other colour: deep is the same hue
 * at 80% of its lightness, tint is 12% of the colour on white, and text on the colour is
 * white when white reads at 3:1 or better (every primary label is 26px or larger and
 * bold), otherwise ink.
 */
export function kioskPalette(primary) {
  const safe = safeCssColor(primary);
  if (!safe || safe === DESIGN_GREEN.toLowerCase()) return { ...DESIGN_PALETTE };
  const rgb = parseCssColor(safe);
  if (!rgb) return { ...DESIGN_PALETTE, primary: safe, primaryDeep: safe, primaryTint: DESIGN_TOKENS['--k2Neutral'], onPrimary: '#FFFFFF' };
  const [h, s, l] = rgbToHsl(...rgb);
  const deep = hslToRgb(h, s, l * 0.8);
  const tint = rgb.map(v => v * 0.12 + 255 * 0.88);
  return {
    primary: safe,
    primaryDeep: hexOf(...deep),
    primaryTint: hexOf(...tint),
    onPrimary: contrastWithWhite(rgb) >= 3 ? '#FFFFFF' : DESIGN_INK,
    // The colour used AS text or an icon on white and on the tint (4.5:1 on white, 3:1 on the tint).
    primaryInk: hexOf(...darkenUntil(rgb, c => contrastRatio(c, WHITE_RGB) >= 4.5 && contrastRatio(c, tint) >= 3)),
    // The colour used as a border or ring on white and on the cream ground (3:1).
    primaryLine: hexOf(...darkenUntil(rgb, c => contrastRatio(c, WHITE_RGB) >= 3 && contrastRatio(c, GROUND_RGB) >= 3)),
    // A light edge for a button in the colour on the ink order bar, when the two are too close.
    onInkEdge: contrastRatio(rgb, INK_RGB) < 3 ? 'inset 0 0 0 2px rgba(255,255,255,.45)' : 'none',
  };
}


/** The per venue CSS variables for the kiosk shell. */
export function kioskThemeVars(profile) {
  const p = kioskPalette(kioskPrimary(profile));
  return {
    '--k2Primary': p.primary,
    '--k2PrimaryDeep': p.primaryDeep,
    '--k2PrimaryTint': p.primaryTint,
    '--k2OnPrimary': p.onPrimary,
    '--k2PrimaryInk': p.primaryInk,
    '--k2PrimaryLine': p.primaryLine,
    '--k2PrimaryOnInkEdge': p.onInkEdge,
    '--kBrand': p.primary,
  };
}

/**
 * The colour block for a photo slot with no photo: a 135deg gradient from the colour to
 * the colour at `alpha` (hex pair). Item cards use '88'; category tiles keep
 * categoryPhoto.js with '99'. A colour with no hex form (it cannot be read) is a solid block.
 */
export function photoBlock(color, alpha = '88') {
  const a = /^[0-9a-f]{2}$/i.test(String(alpha)) ? String(alpha) : '88';
  const rgb = parseCssColor(color);
  if (rgb) {
    const hex = hexOf(...rgb);
    return `linear-gradient(135deg, ${hex}, ${hex}${a})`;
  }
  const safe = safeCssColor(color);
  if (safe) return safe;
  const g = DESIGN_GREEN.toLowerCase();
  return `linear-gradient(135deg, ${g}, ${g}${a})`;
}
