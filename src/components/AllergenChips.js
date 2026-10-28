// src/components/AllergenChips.js
//
// v5.11.108 (28 Oct 2026, Peter: "update the allergens so they show up the same on kiosk and on
// online ordering and QR etc so the UI is the same"). ONE allergen chip row for every place a
// guest or a member of staff sees an item: the online and QR menu cards and product sheet, both
// kiosk designs (cards and item sheet) and the till's product and item info modals.
//
// Words, not icons: a small warning mark and the allergen's name, in the kiosk's wording and the
// kiosk's order (lib/kioskAllergens.js: the 14 UK allergens first in the allergen sheet's order,
// then anything else the venue typed, with a capital first letter). Chips wrap; nothing is cut
// off. The list comes from the item's allergen FIELD, never from words in its description.
//
// Colours come from the surface's own theme tokens through a palette (the venue Appearance theme
// online and on QR, the kiosk's --kAllergen and --kError tokens, the till's --t2, --bg3, --red
// tokens), so it reads in light and dark and never brings a colour of its own. Sizes are in em,
// so each surface sets the scale with fontSize (the kiosk canvas is far bigger than a phone).
//
// Plain createElement (no JSX) so a node test renders it as the browser does (allergenChips.test.js).

import { createElement as h } from 'react';
import { t as i18nT } from '../lib/i18n.js';
import { itemAllergenIds, orderIds, kioskAllergenLabels } from '../lib/kioskAllergens.js';

// A warning sign drawn as text (U+FE0E asks for the plain glyph, so it takes the chip's colour).
export const ALLERGEN_MARK = '⚠︎';

// Default type size in px for each size, when the surface does not set its own.
export const CHIP_FONT_SIZE = Object.freeze({ card: 11, detail: 13 });

// The till (POS and bar): the till theme tokens.
export const TILL_ALLERGEN_PALETTE = Object.freeze({
  fg: 'var(--t2)', bg: 'var(--bg3)', line: 'var(--bdr)', mark: 'var(--t2)', heading: 'var(--t4)',
  hotFg: 'var(--red)', hotBg: 'var(--red-d)', hotLine: 'var(--red-b)', hotMark: 'var(--red)',
});

// Both kiosk designs: the allergen and error tokens every kiosk theme defines (globals.css,
// [data-kiosk-theme] dark, light and design). The design theme has no --kError-bg, so the hot
// chip falls back to its danger fill.
export const KIOSK_ALLERGEN_PALETTE = Object.freeze({
  fg: 'var(--kAllergen-fg)', bg: 'var(--kAllergen-bg)', line: 'var(--kAllergen-border)', mark: 'var(--kAllergen-fg)', heading: 'var(--kFgMuted)',
  hotFg: 'var(--kError-fg)', hotBg: 'var(--kError-bg, var(--k2DangerFill, transparent))', hotLine: 'var(--kError-border, var(--kError-fg))', hotMark: 'var(--kError-fg)',
});

// A colour at an opacity: rgba() for a #rgb or #rrggbb hex, color-mix for anything else.
export function withAlpha(colour, alpha) {
  const c = String(colour || '').trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const hex = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  if (!c) return 'transparent';
  return `color-mix(in srgb, ${c} ${Math.round(alpha * 100)}%, transparent)`;
}

/**
 * Online and QR: the palette from the venue's Appearance theme (online/sheetTheme.js: fg, bg,
 * accent). A plain chip is the venue's text colour on a faint wash of it; an allergen the guest
 * asked to avoid is the same chip inverted (venue background on venue text), so it stands out in
 * any theme without a colour the venue did not pick.
 */
export function allergenPaletteFromTheme(theme) {
  const fg = theme?.fg || 'currentColor';
  const bg = theme?.bg || 'transparent';
  return {
    fg, bg: withAlpha(fg, 0.06), line: withAlpha(fg, 0.24), mark: theme?.accent || fg, heading: withAlpha(fg, 0.62),
    hotFg: bg, hotBg: fg, hotLine: fg, hotMark: bg,
  };
}

const DEFAULT_PALETTE = Object.freeze({
  fg: 'inherit', bg: 'transparent', line: 'currentColor', mark: 'currentColor', heading: 'inherit',
  hotFg: 'inherit', hotBg: 'transparent', hotLine: 'currentColor', hotMark: 'currentColor',
});

/** The ids a chip row shows: normalised ('Dairy' is milk), no repeats, in the kiosk's order. */
export function allergenChipIds(ids) {
  return orderIds(itemAllergenIds({ allergens: Array.isArray(ids) ? ids : [] }));
}

/** [{ id, label }] for a chip row, in the kiosk's wording. */
export function allergenChipLabels(ids, translate = i18nT) {
  const list = allergenChipIds(ids);
  const labels = kioskAllergenLabels(list, translate);
  return list.map((id, i) => ({ id, label: labels[i] || id }));
}

/**
 * <AllergenChips ids={item.allergens} size="card" />
 *   ids      : allergen values (ids or older spellings), any order
 *   size     : 'card' (menu cards, compact, no heading) or 'detail' (product screens, with the
 *              word Allergens above the chips)
 *   active   : allergens to highlight (the guest's own on the till, the ones a customer asked
 *              to avoid on the kiosk, online and QR); a highlighted chip that is not in ids is
 *              never added, the row only shows what the item contains
 *   palette  : the surface's colours (TILL_ALLERGEN_PALETTE, KIOSK_ALLERGEN_PALETTE,
 *              allergenPaletteFromTheme(theme))
 *   fontSize : the surface's scale (px number or any CSS size); chips size in em from it
 *   heading  : the detail heading text, or false for none (default: the translated "Allergens")
 *   translate: the i18n t function (default lib/i18n t)
 */
export default function AllergenChips({ ids, size = 'card', active = null, palette = null, fontSize = null, heading = null, style = null, translate = i18nT } = {}) {
  const rows = allergenChipLabels(ids, translate);
  if (!rows.length) return null;
  const pal = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const detail = size === 'detail';
  const hot = new Set(allergenChipIds(active instanceof Set ? Array.from(active) : active));
  const headingText = heading === false ? '' : (heading || translate('product.allergens'));
  const words = rows.map((r) => r.label).join(', ');

  const chips = rows.map(({ id, label }) => {
    const on = hot.has(id);
    return h('span', {
      key: id, role: 'listitem', 'data-allergen': id, 'data-hot': on ? 'true' : undefined,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '0.3em', maxWidth: '100%',
        padding: detail ? '0.3em 0.75em' : '0.18em 0.6em', borderRadius: 999,
        border: `1px solid ${on ? pal.hotLine : pal.line}`, background: on ? pal.hotBg : pal.bg,
        color: on ? pal.hotFg : pal.fg, fontWeight: on ? 800 : 700, lineHeight: 1.25,
        overflowWrap: 'anywhere', textAlign: 'left',
      },
    },
    h('span', { 'aria-hidden': 'true', style: { color: on ? pal.hotMark : pal.mark, fontSize: '0.95em', lineHeight: 1 } }, ALLERGEN_MARK),
    h('span', null, label));
  });

  return h('div', {
    role: 'list', 'aria-label': `${translate('product.allergens')}: ${words}`, 'data-allergen-chips': detail ? 'detail' : 'card',
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: detail ? '0.4em' : '0.3em',
      fontSize: fontSize ?? CHIP_FONT_SIZE[detail ? 'detail' : 'card'], minWidth: 0, ...(style || {}),
    },
  },
  detail && headingText
    ? h('span', { 'aria-hidden': 'true', style: { flexBasis: '100%', fontSize: '0.8em', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: pal.heading } }, headingText)
    : null,
  ...chips);
}
