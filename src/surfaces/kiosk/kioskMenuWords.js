// kioskMenuWords.js: the venue's menu text in the customer's language on the CLASSIC kiosk
// (v5.11.81, channel parity round 2). The new design has shown it since v5.8.82 (KioskV2Root);
// the classic kiosk's language picker changed the screen words only.
//
// Kept out of KioskApp.jsx on purpose: the kiosk engine (basket, order, kitchen, receipt) never
// touches the translations (menuText.test.js holds that), only what a card or the product sheet
// SHOWS goes through these.
import { useEffect } from 'react';
import { useMenuText, setMenuTranslations, clearMenuTranslations, itemName, itemDescription } from '../../lib/menuText';
import { displayName } from '../../lib/itemDisplay';
import { loadMenuTranslations } from './kioskApi';

/** Load the venue's rows for the picked language (the classic kiosk only; KioskV2Root loads its own). */
export function useClassicKioskMenuWords(lang, locationId, enabled) {
  useMenuText();   // re-render when the rows arrive
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    if (!lang || lang === 'en' || !locationId) { clearMenuTranslations(); return undefined; }
    Promise.resolve(loadMenuTranslations(locationId, lang)).then((rows) => {
      if (!alive) return;
      if (Array.isArray(rows) && rows.length) setMenuTranslations(lang, rows); else clearMenuTranslations();
    }).catch(() => { if (alive) clearMenuTranslations(); });
    return () => { alive = false; };
  }, [lang, locationId, enabled]);
}

/** A card's name: translated, else the menu name. */
export const shownItemName = (item) => itemName(item) || displayName(item);
/** A card's description: translated, else the English ('' when none). */
export const shownItemDescription = (item) => (item ? itemDescription(item) : '');
