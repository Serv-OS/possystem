// src/lib/printMenu.js
//
// Printable-menu builder. Turns the venue's programmed menu (categories + items with
// descriptions/allergens/prices) + a layout config into a single, print-optimised HTML
// document. The SAME output feeds the back-office live preview (in an <iframe srcDoc>) and
// the actual print/PDF export (a new window → window.print()), so what you see is what prints.
//
// Design goals (per the brief): choose which categories show; category name = section header;
// name + description + allergens per item; toggle each element on/off; portrait/landscape;
// normal paper sizes (A4/Letter) so venues can print themselves; a choice of fonts; logo
// placement; allergen + service-charge disclaimers. Vector text (via window.print) → crisp,
// small files, no image rasterisation.
//
// Pure — no React/DOM/Supabase. Unit-testable.

export const PRINT_FONTS = {
  serif:      { label: 'Elegant serif',  css: "Georgia, 'Times New Roman', serif" },
  sans:       { label: 'Clean sans',     css: "'Helvetica Neue', Arial, sans-serif" },
  rounded:    { label: 'Friendly',       css: "'Trebuchet MS', 'Segoe UI', sans-serif" },
  typewriter: { label: 'Typewriter',     css: "'Courier New', Courier, monospace" },
  didone:     { label: 'Fine dining',    css: "'Didot', 'Bodoni MT', Georgia, serif" },
};

export const PAPER = {
  a4:     { label: 'A4',        w: 210, h: 297 },   // mm
  letter: { label: 'US Letter', w: 216, h: 279 },
};

export const DEFAULT_PRINT_CONFIG = {
  title: '',                 // '' → venue name
  subtitle: '',              // optional tagline under the title
  categoryIds: [],           // [] → all categories in menu order; else the chosen set, in this order
  columns: 2,                // 1 | 2 | 3
  orientation: 'portrait',   // 'portrait' | 'landscape'
  paper: 'a4',               // key of PAPER
  font: 'serif',             // key of PRINT_FONTS
  accent: '',                // '' → brand colour; else hex
  logo: 'top-center',        // 'top-center' | 'top-left' | 'none'
  showDescription: true,
  showAllergens: true,
  showPrice: true,
  showDietary: false,        // GF/V/VG badges from tags
  leaders: true,             // dotted leader between name and price
  fontScale: 1,              // overall text size — 0.9 (S) | 1 (M) | 1.15 (L)
  itemGap: 6,                // px — vertical space below each item
  sectionGap: 12,            // px — vertical space below each category block
  columnGap: 16,             // px — space between columns
  allergenNote: { show: true, text: 'Allergen information: please speak to a member of staff before ordering. All 14 major allergens are handled in our kitchen and we cannot guarantee any dish is free from traces.' },
  serviceNote:  { show: false, text: 'A discretionary 12.5% service charge is added to your bill; 100% goes to the team.' },
  footer: '',                // free footer line (e.g. address / phone / website)
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Resolve an item's display price (mirrors the menu-board/pos resolution).
export function priceOf(it) {
  const p = it && it.pricing;
  if (p && typeof p === 'object') {
    for (const k of ['dineIn', 'all', 'base']) if (p[k] != null && Number(p[k]) > 0) return Number(p[k]);
    if (p.base != null) return Number(p.base) || 0;
  }
  return Number(it && it.price) || 0;
}

const DIET = { gf: 'GF', glutenfree: 'GF', 'gluten-free': 'GF', 'gluten free': 'GF', v: 'V', veg: 'V', vegetarian: 'V', vg: 'VG', vegan: 'VG', df: 'DF', dairyfree: 'DF', 'dairy-free': 'DF' };
function dietaryBadges(it) {
  const out = [], seen = new Set();
  for (const t of (Array.isArray(it.tags) ? it.tags : [])) { const b = DIET[String(t).toLowerCase().trim()]; if (b && !seen.has(b)) { seen.add(b); out.push(b); } }
  return out;
}

const fmtMoney = (n, sym) => `${sym}${(Number(n) || 0).toFixed(2)}`;

/**
 * @param {object} cfg   merged over DEFAULT_PRINT_CONFIG
 * @param {object} data  { venueName, logoUrl, brandColor, currencySymbol,
 *                         categories: [{id,name,description}], itemsByCat: {catId:[item...]} }
 * @returns {string} a complete printable HTML document
 */
export function buildPrintMenuHtml(cfg, data) {
  const c = { ...DEFAULT_PRINT_CONFIG, ...(cfg || {}),
    allergenNote: { ...DEFAULT_PRINT_CONFIG.allergenNote, ...((cfg && cfg.allergenNote) || {}) },
    serviceNote:  { ...DEFAULT_PRINT_CONFIG.serviceNote,  ...((cfg && cfg.serviceNote)  || {}) } };
  const { venueName = 'Menu', logoUrl = null, brandColor = '#1a1a1a', currencySymbol = '£' } = data || {};
  const allCats = Array.isArray(data?.categories) ? data.categories : [];
  const itemsByCat = data?.itemsByCat || {};

  // Category order: explicit selection (in chosen order) else all in menu order.
  const chosen = (c.categoryIds && c.categoryIds.length)
    ? c.categoryIds.map(id => allCats.find(k => k.id === id)).filter(Boolean)
    : allCats;
  // Only categories that actually have items.
  const cats = chosen.filter(k => (itemsByCat[k.id] || []).length > 0);

  const paper = PAPER[c.paper] || PAPER.a4;
  const land = c.orientation === 'landscape';
  const pageW = land ? paper.h : paper.w;   // mm, for the on-screen page frame aspect
  const pageH = land ? paper.w : paper.h;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(c.accent) ? c.accent : (brandColor || '#1a1a1a');
  const fontCss = (PRINT_FONTS[c.font] || PRINT_FONTS.serif).css;
  const cols = Math.max(1, Math.min(3, Number(c.columns) || 1));

  // Spacing + size controls (all clamped so a bad config can't break the layout).
  const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const fs = clamp(c.fontScale, 0.7, 1.5, 1);      // overall text-size multiplier
  const z = (n) => +(n * fs).toFixed(2);           // scale a base px size by fs
  const itemGap = clamp(c.itemGap, 0, 30, 6);      // px below each item
  const sectionGap = clamp(c.sectionGap, 0, 48, 12); // px below each category
  const colGap = clamp(c.columnGap, 6, 40, 16);    // px between columns

  const itemHtml = (it) => {
    const price = priceOf(it);
    const variants = Array.isArray(it._variants) ? it._variants : [];
    const showLinePrice = c.showPrice && !variants.length && price > 0;
    const badges = c.showDietary ? dietaryBadges(it) : [];
    const nameRow = `
      <div class="pm-item-row">
        <span class="pm-name">${esc(it.name || it.menuName || '')}${badges.length ? ` <span class="pm-diet">${badges.map(esc).join(' ')}</span>` : ''}</span>
        ${c.leaders && showLinePrice ? '<span class="pm-leader"></span>' : ''}
        ${showLinePrice ? `<span class="pm-price">${fmtMoney(price, currencySymbol)}</span>` : ''}
      </div>`;
    const desc = (c.showDescription && it.description) ? `<div class="pm-desc">${esc(it.description)}</div>` : '';
    const varHtml = variants.length ? `<div class="pm-variants">${variants.map(v => {
      const vp = priceOf(v);
      return `<span class="pm-variant">${esc(v.name || v.menuName || '')}${c.showPrice && vp > 0 ? ` <b>${fmtMoney(vp, currencySymbol)}</b>` : ''}</span>`;
    }).join('')}</div>` : '';
    const alg = (c.showAllergens && Array.isArray(it.allergens) && it.allergens.length)
      ? `<div class="pm-alg">Allergens: ${esc(it.allergens.join(', '))}</div>` : '';
    return `<div class="pm-item">${nameRow}${desc}${varHtml}${alg}</div>`;
  };

  const catHtml = (k) => `
    <section class="pm-cat">
      <h2 class="pm-cat-h">${esc(k.name || '')}</h2>
      ${k.description ? `<div class="pm-cat-desc">${esc(k.description)}</div>` : ''}
      ${(itemsByCat[k.id] || []).map(itemHtml).join('')}
    </section>`;

  const disclaimers = [
    c.allergenNote.show && c.allergenNote.text ? `<div class="pm-note">${esc(c.allergenNote.text)}</div>` : '',
    c.serviceNote.show && c.serviceNote.text ? `<div class="pm-note">${esc(c.serviceNote.text)}</div>` : '',
    c.footer ? `<div class="pm-footer">${esc(c.footer)}</div>` : '',
  ].filter(Boolean).join('');

  const title = c.title || venueName || 'Menu';
  const logoBlock = (c.logo !== 'none' && logoUrl)
    ? `<img class="pm-logo" src="${esc(logoUrl)}" alt="">`
    : '';
  const headerClass = c.logo === 'top-left' ? 'pm-head pm-head-left' : 'pm-head pm-head-center';

  const body = cats.length
    ? `<div class="pm-cols">${cats.map(catHtml).join('')}</div>`
    : `<div class="pm-empty">No categories with items selected. Choose categories on the left.</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Menu</title>
<style>
  @page { size: ${paper.label === 'A4' ? 'A4' : 'letter'} ${land ? 'landscape' : 'portrait'}; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${fontCss}; color: #1b1b1b; line-height: 1.35; font-size: ${z(12)}px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pm-head { padding: 0 0 10px; margin-bottom: ${Math.max(8, sectionGap)}px; border-bottom: 2px solid ${accent}; }
  .pm-head-center { text-align: center; }
  .pm-head-left { display: flex; align-items: center; gap: 14px; }
  .pm-logo { max-height: 64px; max-width: 240px; object-fit: contain; ${c.logo === 'top-center' ? 'display:block;margin:0 auto 8px;' : ''} }
  .pm-title { font-size: ${z(26)}px; font-weight: 700; letter-spacing: .01em; color: ${accent}; margin: 0; }
  .pm-sub { font-size: ${z(12)}px; color: #666; margin-top: 2px; }
  .pm-cols { column-count: ${cols}; column-gap: ${colGap}px; }
  .pm-cat { break-inside: avoid; -webkit-column-break-inside: avoid; page-break-inside: avoid; margin: 0 0 ${sectionGap}px; }
  .pm-cat-h { font-size: ${z(15)}px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: ${accent}; margin: 0 0 ${Math.max(2, Math.round(itemGap / 3))}px; padding-bottom: 3px; border-bottom: 1px solid #ddd; }
  .pm-cat-desc { font-size: ${z(10.5)}px; color: #777; font-style: italic; margin: 0 0 ${Math.max(3, Math.round(itemGap * 0.8))}px; }
  .pm-item { margin: 0 0 ${itemGap}px; }
  .pm-item-row { display: flex; align-items: baseline; gap: 4px; }
  .pm-name { font-size: ${z(12)}px; font-weight: 600; white-space: nowrap; }
  .pm-diet { font-size: ${z(8.5)}px; font-weight: 700; color: #2f8f4e; letter-spacing: .04em; }
  .pm-leader { flex: 1 1 auto; border-bottom: 1px dotted #bbb; transform: translateY(-3px); min-width: 8px; }
  .pm-price { font-size: ${z(12)}px; font-weight: 700; white-space: nowrap; }
  .pm-desc { font-size: ${z(10.5)}px; color: #555; margin-top: 1px; }
  .pm-variants { font-size: ${z(10.5)}px; color: #444; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .pm-variant b { font-weight: 700; }
  .pm-alg { font-size: ${z(9)}px; color: #8a8a8a; font-style: italic; margin-top: 1px; }
  .pm-notes { margin-top: ${Math.max(10, sectionGap)}px; padding-top: 8px; border-top: 1px solid #ddd; column-span: all; }
  .pm-note { font-size: ${z(9)}px; color: #777; margin-top: 3px; }
  .pm-footer { font-size: ${z(9.5)}px; color: #555; margin-top: 6px; text-align: center; font-weight: 600; }
  .pm-empty { color: #999; font-size: 13px; text-align: center; padding: 60px 20px; }
  /* On-screen preview only: draw the page as a white sheet. Print ignores this via @media. */
  @media screen { body { background: #fff; width: ${pageW}mm; min-height: ${pageH}mm; padding: 12mm; margin: 0 auto; } }
</style></head>
<body>
  <header class="${headerClass}">
    ${logoBlock}
    <div>
      <h1 class="pm-title">${esc(title)}</h1>
      ${c.subtitle ? `<div class="pm-sub">${esc(c.subtitle)}</div>` : ''}
    </div>
  </header>
  ${body}
  ${disclaimers ? `<div class="pm-notes">${disclaimers}</div>` : ''}
</body></html>`;
}
