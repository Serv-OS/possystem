// src/lib/menuTextLoad.js: the venue's menu translations on every customer channel (v5.11.81).
//
// The kiosk has shown the venue's menu text (items, descriptions, categories, options) in the
// guest's language since v5.8.82 (menu_translations, lib/menuText.js). The online page, QR at the
// table and catering showed English only. This file is the one way any of them reads the rows and
// picks the language:
//   loadMenuTranslationRows  every row for one venue and language, page by page (the Data API
//                            stops at 1,000 rows a request; a big menu holds more, and the kiosk's
//                            single read silently left the rest in English)
//   customerMenuLang         the guest's browser language, when it is one the menu is translated
//                            into (es, fr, zh), else null (English)
//   applyMenuLang            show that language (or English) through lib/menuText.js
//   languageLabel            the pill's words ("Espanol", "English")
// Only what is SHOWN changes. The basket, the order, the kitchen ticket and the receipt keep the
// English, as on the kiosk.
//
// Pure apart from the Supabase client passed in, so node --test drives it with a fake.

import { setMenuTranslations, clearMenuTranslations } from './menuText.js';

export const MENU_LANGS = Object.freeze(['es', 'fr', 'zh']);
const NATIVE = Object.freeze({ en: 'English', es: 'Español', fr: 'Français', zh: '中文' });
const PAGE = 1000;
const MAX_PAGES = 20;

/**
 * Every menu_translations row for the venue and language, as [{ entity_type, entity_id, text }].
 * null when a page failed (the caller keeps English), [] when there are none.
 */
export async function loadMenuTranslationRows(client, locationId, lang, { page = PAGE, maxPages = MAX_PAGES } = {}) {
  if (!client || !locationId || !lang || lang === 'en') return [];
  const rows = [];
  for (let i = 0; i < maxPages; i++) {
    let res;
    try {
      res = await client.from('menu_translations').select('entity_type,entity_id,text')
        .eq('location_id', locationId).eq('lang', lang)
        .order('entity_type').order('entity_id')
        .range(i * page, i * page + page - 1);
    } catch { return null; }
    if (!res || res.error || !Array.isArray(res.data)) return null;
    rows.push(...res.data);
    if (res.data.length < page) return rows;
  }
  return rows;
}

/** The first of the browser's languages the menu is translated into ('es-MX' gives 'es'), else null. */
export function customerMenuLang(browserLangs) {
  const list = Array.isArray(browserLangs) ? browserLangs : [browserLangs];
  for (const raw of list) {
    const code = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
    if (!code || code === 'en') return null;          // English first: stay in English
    if (MENU_LANGS.includes(code)) return code;
  }
  return null;
}

/** Show `lang` from the loaded offer ({ lang, rows }), or English. */
export function applyMenuLang(lang, offer) {
  if (lang && lang !== 'en' && offer && offer.lang === lang && Array.isArray(offer.rows) && offer.rows.length) {
    setMenuTranslations(lang, offer.rows);
  } else {
    clearMenuTranslations();
  }
}

/** The language's own name, for the switch. */
export function languageLabel(lang) {
  return NATIVE[lang] || NATIVE.en;
}
