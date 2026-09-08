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

// Dietary badge resolution (GF/V/VG/DF from item tags) — shared with the
// menu board + online storefront via src/lib/dietary.js (pure, no DOM).
import { dietaryBadges } from './dietary';

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

  const headerHtml = `<header id="pm-header" class="${headerClass}">
    ${logoBlock}
    <div>
      <h1 class="pm-title">${esc(title)}</h1>
      ${c.subtitle ? `<div class="pm-sub">${esc(c.subtitle)}</div>` : ''}
    </div>
  </header>`;
  const notesHtml = disclaimers ? `<div id="pm-notes" class="pm-notes">${disclaimers}</div>` : '';

  // Page geometry (CSS px) for the JS paginator. Safari/WebKit collapse CSS
  // multi-column layouts and ignore break-inside when PRINTING, so we don't rely on
  // the browser's column/pagination engine — we measure each category and pack whole
  // categories into columns and pages ourselves. Works identically in every engine.
  const pxPerMm = 96 / 25.4;
  const contentWpx = Math.round((pageW - 24) * pxPerMm);   // printable width  (page − 2×12mm margin)
  const contentHpx = Math.round((pageH - 24) * pxPerMm);   // printable height
  const colWpx = Math.max(80, Math.floor((contentWpx - (cols - 1) * colGap) / cols));
  const PGEO = { COLS: cols, CONTENT_W: contentWpx, CONTENT_H: contentHpx, COL_W: colWpx, SECTION_GAP: sectionGap, HEADER_MB: Math.max(8, sectionGap), NOTES_MT: Math.max(10, sectionGap) };

  const paginate = `
(function(){
  var G = ${JSON.stringify(PGEO)};
  function build(){
    var stage=document.getElementById('pm-stage');
    var pagesRoot=document.getElementById('pm-pages');
    if(!stage||!pagesRoot){ done(); return; }
    var header=document.getElementById('pm-header');
    var notes=document.getElementById('pm-notes');
    var catsWrap=document.getElementById('pm-cats');
    stage.style.width = G.CONTENT_W + 'px';
    var headerH = header ? (header.offsetHeight + G.HEADER_MB) : 0;
    var notesH = notes ? (notes.offsetHeight + G.NOTES_MT) : 0;
    if(catsWrap){ catsWrap.style.width = G.COL_W + 'px'; }
    var els = catsWrap ? [].slice.call(catsWrap.children) : [];
    var measured = els.map(function(el){ return { el: el, h: el.offsetHeight + G.SECTION_GAP }; });
    var SAFETY = 30; // slack so a column never exceeds the fixed page height (print rendering can differ a little from our screen measurement)
    var pages=[];
    function newPage(){ var p={cols:[],isFirst:pages.length===0}; for(var i=0;i<G.COLS;i++)p.cols.push([]); pages.push(p); return p; }
    function usable(pg){ return G.CONTENT_H - (pg.isFirst?headerH:0) - SAFETY; }
    var page=newPage(), colIdx=0, used=0;
    for(var i=0;i<measured.length;i++){
      var m=measured[i];
      if(used>0 && (used+m.h)>usable(page)){
        colIdx++;
        if(colIdx>=G.COLS){ page=newPage(); colIdx=0; }
        used=0;
      }
      page.cols[colIdx].push(m); used+=m.h;
    }
    var last=pages[pages.length-1]||newPage();
    var maxH=0; for(var a=0;a<last.cols.length;a++){ var s=0; for(var b=0;b<last.cols[a].length;b++) s+=last.cols[a][b].h; if(s>maxH)maxH=s; }
    var notesOwnPage = !!notes && (maxH + notesH > usable(last));
    for(var pi=0;pi<pages.length;pi++){
      var p=pages[pi];
      var pd=document.createElement('div'); pd.className='pm-page';
      if(p.isFirst && header) pd.appendChild(header);
      var cd=document.createElement('div'); cd.className='pm-cols';
      for(var ci=0;ci<p.cols.length;ci++){
        var col=document.createElement('div'); col.className='pm-col';
        for(var k=0;k<p.cols[ci].length;k++) col.appendChild(p.cols[ci][k].el);
        cd.appendChild(col);
      }
      pd.appendChild(cd);
      if(notes && !notesOwnPage && pi===pages.length-1) pd.appendChild(notes);
      pagesRoot.appendChild(pd);
    }
    if(notes && notesOwnPage){ var np=document.createElement('div'); np.className='pm-page'; np.appendChild(notes); pagesRoot.appendChild(np); }
    if(stage.parentNode) stage.parentNode.removeChild(stage);
    done();
  }
  function done(){ window.__pmPaginated=true; if(typeof window.__pmOnReady==='function'){ try{ window.__pmOnReady(); }catch(e){} } }
  // NB: do NOT wait on requestAnimationFrame — it is throttled/never fires in background
  // or non-visible tabs (and in Safari's print window), which would stall pagination.
  // Reading offsetHeight in build() forces synchronous layout, so no paint frame is needed.
  function ready(){
    var ran=false;
    function go(){ if(ran) return; ran=true; try{ build(); }catch(e){ done(); } }
    // Measure only once fonts AND images (the logo) have settled, so the header height
    // is final before we paginate. Fixed .pm-logo height already makes this timing-safe,
    // but waiting also ensures the logo pixels are present in the printed PDF.
    var waits=[];
    if(document.fonts&&document.fonts.ready) waits.push(document.fonts.ready);
    var imgs=[].slice.call(document.images||[]);
    for(var i=0;i<imgs.length;i++){ (function(im){ if(!im.complete){ waits.push(new Promise(function(res){ im.addEventListener('load',res); im.addEventListener('error',res); })); } })(imgs[i]); }
    if(waits.length){ Promise.all(waits).then(go); } else { go(); }
    setTimeout(go, 2500); // fallback: never let a slow/broken logo stall the print
  }
  if(document.readyState==='complete') ready(); else window.addEventListener('load', ready);
})();`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Menu</title>
<style>
  @page { size: ${paper.label === 'A4' ? 'A4' : 'letter'} ${land ? 'landscape' : 'portrait'}; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${fontCss}; color: #1b1b1b; line-height: 1.35; font-size: ${z(12)}px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pm-head { padding: 0 0 10px; margin-bottom: ${Math.max(8, sectionGap)}px; border-bottom: 2px solid ${accent}; }
  .pm-head-center { text-align: center; }
  .pm-head-left { display: flex; align-items: center; gap: 14px; }
  /* Fixed height (not max-height) reserves the logo's vertical space even before the
     image loads, so the header measures the same whether or not the (remote) logo has
     arrived — otherwise a late logo grows the header after pagination and the whole
     column block gets shoved to page 2 in Safari. object-fit keeps the aspect ratio. */
  .pm-logo { height: 64px; max-width: 240px; object-fit: contain; ${c.logo === 'top-center' ? 'display:block;margin:0 auto 8px;' : ''} }
  .pm-title { font-size: ${z(26)}px; font-weight: 700; letter-spacing: .01em; color: ${accent}; margin: 0; }
  .pm-sub { font-size: ${z(12)}px; color: #666; margin-top: 2px; }
  /* Off-screen measuring area (removed once pagination runs). */
  #pm-stage { position: absolute; left: -100000px; top: 0; }
  .pm-cols { display: flex; gap: ${colGap}px; align-items: flex-start; }
  .pm-col { width: ${colWpx}px; }
  /* A category is packed as one whole block into a single column — never split.
     page-break-inside:avoid is belt-and-braces: if the print engine's layout drifts a
     little from our measurement, it still keeps a category whole across a page break. */
  .pm-cat { margin: 0 0 ${sectionGap}px; page-break-inside: avoid; break-inside: avoid; }
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
  .pm-notes { padding-top: 8px; border-top: 1px solid #ddd; margin-top: ${Math.max(10, sectionGap)}px; }
  .pm-note { font-size: ${z(9)}px; color: #777; margin-top: 3px; }
  .pm-footer { font-size: ${z(9.5)}px; color: #555; margin-top: 6px; text-align: center; font-weight: 600; }
  .pm-empty { color: #999; font-size: 13px; text-align: center; padding: 60px 20px; }
  /* On-screen preview: draw each page as a white sheet. */
  @media screen { body { background: #ececec; } .pm-page { background: #fff; width: ${pageW}mm; min-height: ${pageH}mm; padding: 12mm; margin: 0 auto 14px; box-shadow: 0 1px 8px rgba(0,0,0,.16); overflow: hidden; } }
  /* Print: one <div.pm-page> per sheet. FIXED height (= printable area) makes every
     page exactly one sheet, so the header and its columns live in the SAME single-sheet
     box and can never be split onto separate pages — no matter how the engine (Safari!)
     would otherwise want to break between them. Content is pre-packed to fit this height. */
  @media print {
    .pm-page { height: ${contentHpx}px; overflow: hidden; page-break-after: always; break-after: page; page-break-inside: avoid; }
    .pm-page:last-child { page-break-after: auto; break-after: auto; }
  }
</style></head>
<body>
${cats.length
  ? `<div id="pm-stage">${headerHtml}<div id="pm-cats">${cats.map(catHtml).join('')}</div>${notesHtml}</div><div id="pm-pages"></div><script>${paginate}</script>`
  : `<div class="pm-page">${headerHtml}<div class="pm-empty">No categories with items selected. Choose categories on the left.</div></div>`}
</body></html>`;
}
