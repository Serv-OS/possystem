// src/surfaces/website/blocks/rowPlan.js
//
// 5.12.9 Row block: the one place that turns a Row's props into what both renderers paint, so the
// server string (ssr/renderBlocks.js R.Row) and the React component (components/LayoutBlocks.jsx)
// agree on every attribute and style variable. Plain JS, no DOM, never throws.
//
// Every colour on the public site stays a --w-* variable; the owner's own hex values are the
// exception and travel in the style attribute as --w-row-bg and --w-col-bg. A photo becomes
// --w-row-img: url("..."), https only (a junk or javascript: value is dropped, never painted).

import { isDarkHex } from '../theme.js';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SIZES = ['none', 'small', 'normal', 'large'];

/** '#abc' or '#aabbcc' trimmed, else '' (anything else could break out of the style attribute). */
export function safeHex(v) {
  const s = String(v || '').trim();
  return HEX_RE.test(s) ? s : '';
}

/** An https(s) photo URL, else ''. */
export function safeImageUrl(v) {
  const s = String(v || '').trim();
  return /^https?:\/\/[^\s"'<>()\\]+$/i.test(s) && s.length <= 2048 ? s : '';
}

/**
 * rowPlan(props) → {
 *   cols, full, gap, pad, align, darken, tone ('' = inherit, 'light' or 'dark' text),
 *   hasBg, style: { '--w-row-cols', '--w-row-bg'?, '--w-row-img'? }, colBg: ['#hex' | '', ...] }
 */
const COL_PADS = ['none', 'small', 'normal', 'large'];
function colPadOf(p) {
  if (COL_PADS.includes(p.col_padding)) return p.col_padding;
  return ['full'].includes(p.width) ? 'normal' : 'none';
}

export function rowPlan(props) {
  const p = props && typeof props === 'object' ? props : {};
  const cols = Math.max(1, Math.min(4, parseInt(p.columns, 10) || 2));
  const bg = p.background && typeof p.background === 'object' ? p.background : {};
  const color = safeHex(bg.color);
  const image = safeImageUrl(bg.image);
  const darken = !!(image && bg.darken === true);
  let tone = bg.tone === 'light' || bg.tone === 'dark' ? bg.tone : '';
  if (!tone && ((color && isDarkHex(color)) || darken)) tone = 'light';
  const style = { '--w-row-cols': String(cols) };
  if (color) style['--w-row-bg'] = color;
  if (image) style['--w-row-img'] = `url(${JSON.stringify(image)})`;
  const colBgs = p.col_bg && typeof p.col_bg === 'object' ? p.col_bg : {};
  const colBg = [1, 2, 3, 4].map((i) => safeHex(colBgs[`col${i}`]));
  return {
    cols,
    full: p.full_width === true,
    width: ['page', 'wide', 'full'].includes(p.width) ? p.width : 'page',
    // 5.12.12 (Peter: "text is touching the edges"): auto = none at page width, normal edge to edge.
    colPad: colPadOf(p),
    gap: SIZES.includes(p.gap) ? p.gap : 'normal',
    pad: SIZES.includes(p.padding) ? p.padding : 'normal',
    align: p.align === 'center' ? 'center' : 'top',
    darken,
    tone,
    hasBg: !!(color || image),
    style,
    colBg,
  };
}

/** The style attribute text for the server renderer: "--w-row-cols:2;--w-row-bg:#111". Values are vetted above. */
export function styleText(style) {
  return Object.entries(style || {}).map(([k, v]) => `${k}:${v}`).join(';');
}
