// src/components/DietaryChips.js
//
// v5.11.110 (28 Oct 2026, Peter: "I have just made a product on Habitum with Vegetarian and vegan
// dietary but the icons have not shown on either the online ordering or kiosk"). Online ordering
// has shown the dietary tags (lib/dietary.js: GF, V, VG, DF) since the print menu work; the kiosk
// never did. This is ONE dietary chip row for both kiosk designs: the menu cards and the item
// screens. Words, not icons, like the allergen chips next to it (AllergenChips.js): Vegetarian,
// Vegan, Gluten free, Dairy free, in the kiosk's language. Chips wrap; nothing is cut off.
//
// The tags come from the item's dietary FIELD (menu_items.tags, Back Office, Menu, item, Allergens
// & dietary), never from words typed in the description. On an item screen the picked size's own
// tags win over the item's, the same own then parent rule online uses.
//
// Colours come from the kiosk theme tokens (--kDiet-fg, -bg, -border, set for the dark, light and
// design themes in styles/globals.css), so the row never brings a colour of its own.
//
// Plain createElement (no JSX) so a node test renders it as the browser does (dietaryChips.test.js).

import { createElement as h } from 'react';
import { t as i18nT } from '../lib/i18n.js';
import { dietaryBadges, DIET_LABELS } from '../lib/dietary.js';

// Default type size in px for each size, when the surface does not set its own.
export const DIET_CHIP_FONT_SIZE = Object.freeze({ card: 11, detail: 13 });

// Both kiosk designs: the dietary tokens every kiosk theme defines.
export const KIOSK_DIET_PALETTE = Object.freeze({
  fg: 'var(--kDiet-fg)', bg: 'var(--kDiet-bg)', line: 'var(--kDiet-border)',
});

const DEFAULT_PALETTE = Object.freeze({ fg: 'inherit', bg: 'transparent', line: 'currentColor' });

/** The badges a chip row shows: the first of item, fallback with any; [] when neither has one. */
export function dietaryChipCodes(item, fallback = null) {
  const own = dietaryBadges(item);
  return own.length ? own : dietaryBadges(fallback);
}

/** [{ code, label }] in the kiosk's wording (i18n diet.<code>, English label when a language lacks one). */
export function dietaryChipLabels(item, fallback = null, translate = i18nT) {
  return dietaryChipCodes(item, fallback).map((code) => {
    const key = `diet.${code}`;
    const word = translate(key);
    return { code, label: word && word !== key ? word : DIET_LABELS[code] };
  });
}

/**
 * <DietaryChips item={item} size="card" palette={KIOSK_DIET_PALETTE} fontSize={16} translate={t} />
 *   item     : the menu item (its tags field is read)
 *   fallback : an item whose tags are used when item has none (the parent of a picked size)
 *   size     : 'card' (menu cards, compact) or 'detail' (item screens, a little larger)
 *   palette  : the surface's colours (KIOSK_DIET_PALETTE)
 *   fontSize : the surface's scale (px number or any CSS size); chips size in em from it
 *   translate: the i18n t function (default lib/i18n t)
 */
export default function DietaryChips({ item, fallback = null, size = 'card', palette = null, fontSize = null, style = null, translate = i18nT } = {}) {
  const rows = dietaryChipLabels(item, fallback, translate);
  if (!rows.length) return null;
  const pal = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const detail = size === 'detail';
  const words = rows.map((r) => r.label).join(', ');

  return h('div', {
    role: 'list', 'aria-label': words, 'data-dietary-chips': detail ? 'detail' : 'card',
    style: {
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: detail ? '0.4em' : '0.3em',
      fontSize: fontSize ?? DIET_CHIP_FONT_SIZE[detail ? 'detail' : 'card'], minWidth: 0, ...(style || {}),
    },
  },
  ...rows.map(({ code, label }) => h('span', {
    key: code, role: 'listitem', 'data-diet': code,
    style: {
      display: 'inline-flex', alignItems: 'center', maxWidth: '100%',
      padding: detail ? '0.3em 0.75em' : '0.18em 0.6em', borderRadius: 999,
      border: `1px solid ${pal.line}`, background: pal.bg, color: pal.fg,
      fontWeight: 700, lineHeight: 1.25, overflowWrap: 'anywhere', textAlign: 'left',
    },
  }, label)));
}
