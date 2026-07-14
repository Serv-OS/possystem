// src/lib/printMenuPdf.js
//
// Deterministic print-menu PDF generator (jsPDF). We build the PDF ourselves rather
// than relying on the browser's print engine (window.print → CSS columns / page
// breaks), because that engine behaves differently in every browser — Safari in
// particular collapses CSS columns, ignores keep-together rules, and paginates
// unpredictably. jsPDF produces the SAME bytes in Node and in the browser, so what we
// verify in tests is exactly what the venue prints. WYSIWYG, engine-independent.
//
// The same doc feeds the back-office live preview (doc.output('bloburl') in an iframe)
// AND the export (doc.save / open + print), so preview === output.

import { jsPDF } from 'jspdf';
import { PAPER, DEFAULT_PRINT_CONFIG, PRINT_FONTS, priceOf } from './printMenu.js';

export { PAPER, DEFAULT_PRINT_CONFIG, PRINT_FONTS, priceOf };

// jsPDF ships the 14 standard PDF fonts; map our labelled choices onto them.
const FONT_PDF = { serif: 'times', sans: 'helvetica', rounded: 'helvetica', typewriter: 'courier', didone: 'times' };

const PT2MM = 25.4 / 72;            // 1 point → mm
const MM_PER_PX = 25.4 / 96;        // CSS px → mm (our spacing config is in px)

const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const hexToRgb = (hex) => { const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '')); if (!m) return [26, 26, 26]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

const DIET = { gf: 'GF', glutenfree: 'GF', 'gluten-free': 'GF', 'gluten free': 'GF', v: 'V', veg: 'V', vegetarian: 'V', vg: 'VG', vegan: 'VG', df: 'DF', dairyfree: 'DF', 'dairy-free': 'DF' };
function dietaryBadges(it) {
  const out = [], seen = new Set();
  for (const t of (Array.isArray(it.tags) ? it.tags : [])) { const b = DIET[String(t).toLowerCase().trim()]; if (b && !seen.has(b)) { seen.add(b); out.push(b); } }
  return out;
}
const fmtMoney = (n, sym) => `${sym}${(Number(n) || 0).toFixed(2)}`;

/**
 * @param {object} cfg   merged over DEFAULT_PRINT_CONFIG
 * @param {object} data  { venueName, logoDataUri, logoAspect(w/h), brandColor, currencySymbol,
 *                         categories:[{id,name,description}], itemsByCat:{catId:[item...]} }
 * @returns {jsPDF} the generated document
 */
export function buildMenuPdf(cfg, data) {
  const c = { ...DEFAULT_PRINT_CONFIG, ...(cfg || {}),
    allergenNote: { ...DEFAULT_PRINT_CONFIG.allergenNote, ...((cfg && cfg.allergenNote) || {}) },
    serviceNote: { ...DEFAULT_PRINT_CONFIG.serviceNote, ...((cfg && cfg.serviceNote) || {}) } };
  const { venueName = 'Menu', logoDataUri = null, logoAspect = 3, brandColor = '#1a1a1a', currencySymbol = '£' } = data || {};
  const allCats = Array.isArray(data?.categories) ? data.categories : [];
  const itemsByCat = data?.itemsByCat || {};

  const chosen = (c.categoryIds && c.categoryIds.length)
    ? c.categoryIds.map(id => allCats.find(k => k.id === id)).filter(Boolean)
    : allCats;
  const cats = chosen.filter(k => (itemsByCat[k.id] || []).length > 0);

  const paperKey = c.paper === 'letter' ? 'letter' : 'a4';
  const land = c.orientation === 'landscape';
  const doc = new jsPDF({ unit: 'mm', format: paperKey, orientation: land ? 'landscape' : 'portrait' });

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const MARGIN = 12;
  const accent = hexToRgb(/^#[0-9a-fA-F]{6}$/.test(c.accent) ? c.accent : brandColor);
  const font = FONT_PDF[c.font] || 'times';
  const fs = clampNum(c.fontScale, 0.7, 1.5, 1);
  const cols = Math.max(1, Math.min(3, Number(c.columns) || 1));
  const colGap = clampNum(c.columnGap, 6, 40, 16) * MM_PER_PX;
  const itemGap = clampNum(c.itemGap, 0, 30, 6) * MM_PER_PX;
  const sectionGap = clampNum(c.sectionGap, 0, 48, 12) * MM_PER_PX;

  const contentW = pageW - 2 * MARGIN;
  const colW = (contentW - (cols - 1) * colGap) / cols;
  const colX = (i) => MARGIN + i * (colW + colGap);
  const pageBottom = pageH - MARGIN;

  // Font sizes (pt) — jsPDF font sizes are always in points regardless of doc unit.
  const SZ = { title: 22 * fs, sub: 10.5 * fs, catH: 12 * fs, name: 10.5 * fs, price: 10.5 * fs, desc: 9 * fs, variant: 9 * fs, alg: 7.5 * fs, note: 8, footer: 8.5 };
  const lh = (pt) => pt * 1.18 * PT2MM;   // line height in mm for a given pt size

  const setFont = (style, pt, rgb) => { doc.setFont(font, style); doc.setFontSize(pt); if (rgb) doc.setTextColor(rgb[0], rgb[1], rgb[2]); };
  const wrap = (text, width, style, pt) => { setFont(style, pt); return doc.splitTextToSize(String(text == null ? '' : text), width); };

  // ── measure heights (mm) ───────────────────────────────────────────────────
  function itemHeight(it) {
    const variants = Array.isArray(it._variants) ? it._variants : [];
    const nameLines = wrap(it.name || it.menuName || '', colW - 16, 'bold', SZ.name).length || 1;
    let h = nameLines * lh(SZ.name);
    if (c.showDescription && it.description) h += wrap(it.description, colW, 'italic', SZ.desc).length * lh(SZ.desc);
    if (variants.length) h += lh(SZ.variant);
    if (c.showAllergens && Array.isArray(it.allergens) && it.allergens.length) h += lh(SZ.alg);
    return h + itemGap;
  }
  function catHeaderHeight(k) {
    let h = lh(SZ.catH) + 1.6;   // title + rule + gap
    if (k.description) h += wrap(k.description, colW, 'italic', SZ.desc).length * lh(SZ.desc);
    return h + 1.2;
  }
  function catHeight(k) {
    let h = catHeaderHeight(k);
    for (const it of (itemsByCat[k.id] || [])) h += itemHeight(it);
    return h + sectionGap;
  }

  // ── header (page 1) ─────────────────────────────────────────────────────────
  function drawHeader() {
    let y = MARGIN;
    const centered = c.logo !== 'top-left';
    let logoH = 0, logoW = 0;
    if (c.logo !== 'none' && logoDataUri) {
      logoH = 16; logoW = Math.min(60, logoH * (logoAspect || 3));
      try {
        const fmt = /^data:image\/jpe?g/i.test(logoDataUri) ? 'JPEG' : 'PNG';
        if (centered) doc.addImage(logoDataUri, fmt, (pageW - logoW) / 2, y, logoW, logoH);
      } catch { logoH = 0; }
    }
    const title = c.title || venueName || 'Menu';
    if (centered) {
      if (logoH) y += logoH + 2.5;
      setFont('bold', SZ.title, accent); doc.text(title, pageW / 2, y + lh(SZ.title) * 0.75, { align: 'center' });
      y += lh(SZ.title);
      if (c.subtitle) { setFont('normal', SZ.sub, [110, 110, 110]); doc.text(c.subtitle, pageW / 2, y, { align: 'center' }); y += lh(SZ.sub); }
    } else {
      let tx = MARGIN;
      if (logoH) { try { const fmt = /^data:image\/jpe?g/i.test(logoDataUri) ? 'JPEG' : 'PNG'; doc.addImage(logoDataUri, fmt, MARGIN, y, logoW, logoH); } catch { logoH = 0; } tx = MARGIN + logoW + 5; }
      const baseY = y + (logoH ? logoH / 2 : lh(SZ.title) / 2);
      setFont('bold', SZ.title, accent); doc.text(title, tx, baseY + lh(SZ.title) * 0.30);
      if (c.subtitle) { setFont('normal', SZ.sub, [110, 110, 110]); doc.text(c.subtitle, tx, baseY + lh(SZ.title) * 0.30 + lh(SZ.sub)); }
      y += Math.max(logoH, lh(SZ.title) + (c.subtitle ? lh(SZ.sub) : 0));
    }
    y += 2.5;
    doc.setDrawColor(accent[0], accent[1], accent[2]); doc.setLineWidth(0.6); doc.line(MARGIN, y, pageW - MARGIN, y);
    return y + Math.max(3, sectionGap);   // content top on page 1
  }

  // ── draw one category at (x, y); returns new y ──────────────────────────────
  function drawCategory(k, x, y) {
    setFont('bold', SZ.catH, accent);
    doc.text(String(k.name || '').toUpperCase(), x, y + lh(SZ.catH) * 0.75);
    let yy = y + lh(SZ.catH);
    doc.setDrawColor(210, 210, 210); doc.setLineWidth(0.2); doc.line(x, yy, x + colW, yy); yy += 1.6;
    if (k.description) { const dl = wrap(k.description, colW, 'italic', SZ.desc); setFont('italic', SZ.desc, [120, 120, 120]); doc.text(dl, x, yy + lh(SZ.desc) * 0.7); yy += dl.length * lh(SZ.desc); }
    yy += 1.2;
    for (const it of (itemsByCat[k.id] || [])) yy = drawItem(it, x, yy);
    return yy + sectionGap;
  }

  function drawItem(it, x, y) {
    const variants = Array.isArray(it._variants) ? it._variants : [];
    const price = priceOf(it);
    const showLinePrice = c.showPrice && !variants.length && price > 0;
    const badges = c.showDietary ? dietaryBadges(it) : [];
    const priceStr = showLinePrice ? fmtMoney(price, currencySymbol) : '';
    setFont('bold', SZ.price); const priceW = priceStr ? doc.getTextWidth(priceStr) : 0;
    const nameMaxW = colW - (priceStr ? priceW + 3 : 0);
    const nameLines = wrap(it.name || it.menuName || '', nameMaxW, 'bold', SZ.name);
    setFont('bold', SZ.name, [27, 27, 27]);
    doc.text(nameLines, x, y + lh(SZ.name) * 0.75);
    const firstBaseY = y + lh(SZ.name) * 0.75;
    // dietary badges after the (single-line) name
    if (badges.length && nameLines.length === 1) {
      setFont('bold', SZ.name); const nw = doc.getTextWidth(nameLines[0]);
      setFont('bold', SZ.alg, [47, 143, 78]); doc.text(badges.join(' '), x + nw + 2, firstBaseY);
    }
    if (priceStr) {
      if (c.leaders) {
        setFont('bold', SZ.name); const nameW = doc.getTextWidth(nameLines[nameLines.length - 1]) + (nameLines.length === 1 && badges.length ? 10 : 0);
        const dotY = firstBaseY + (nameLines.length - 1) * lh(SZ.name) - 1;
        doc.setDrawColor(180, 180, 180); doc.setLineWidth(0.15); doc.setLineDashPattern([0.4, 0.7], 0);
        const lx = x + Math.min(nameW + 2, colW - priceW - 4);
        doc.line(lx, dotY, x + colW - priceW - 2, dotY); doc.setLineDashPattern([], 0);
      }
      setFont('bold', SZ.price, [27, 27, 27]); doc.text(priceStr, x + colW, firstBaseY + (nameLines.length - 1) * lh(SZ.name), { align: 'right' });
    }
    let yy = y + nameLines.length * lh(SZ.name);
    if (c.showDescription && it.description) { const dl = wrap(it.description, colW, 'italic', SZ.desc); setFont('italic', SZ.desc, [90, 90, 90]); doc.text(dl, x, yy + lh(SZ.desc) * 0.7); yy += dl.length * lh(SZ.desc); }
    if (variants.length) {
      const parts = variants.map(v => { const vp = priceOf(v); return `${v.name || v.menuName || ''}${c.showPrice && vp > 0 ? ' ' + fmtMoney(vp, currencySymbol) : ''}`; });
      setFont('normal', SZ.variant, [70, 70, 70]); const vl = wrap(parts.join('    '), colW, 'normal', SZ.variant); doc.text(vl, x, yy + lh(SZ.variant) * 0.7); yy += vl.length * lh(SZ.variant);
    }
    if (c.showAllergens && Array.isArray(it.allergens) && it.allergens.length) { setFont('italic', SZ.alg, [138, 138, 138]); doc.text(`Allergens: ${it.allergens.join(', ')}`, x, yy + lh(SZ.alg) * 0.7); yy += lh(SZ.alg); }
    return yy + itemGap;
  }

  // ── pack categories into balanced columns / pages, then draw ────────────────
  const headerBottom = cats.length ? drawHeader() : MARGIN;
  if (!cats.length) { setFont('normal', 12, [150, 150, 150]); doc.text('No categories with items selected. Choose categories on the left.', pageW / 2, pageH / 2, { align: 'center' }); return doc; }

  const heights = cats.map(catHeight);
  // Balance target: spread total height across the columns it will occupy so a short
  // menu fills its columns evenly instead of piling into column 1.
  const firstColCap = pageBottom - headerBottom;
  const fullColCap = pageBottom - MARGIN;
  const total = heights.reduce((s, h) => s + h, 0);
  const estCols = Math.max(cols, Math.ceil((total + (headerBottom - MARGIN)) / fullColCap));
  const target = Math.max(...heights, total / estCols); // never smaller than the tallest category

  let colIdx = 0, y = headerBottom, onFirstPage = true;
  const cap = () => (onFirstPage ? firstColCap : fullColCap);
  const colTop = () => (onFirstPage ? headerBottom : MARGIN);
  function nextColumn() {
    colIdx++;
    if (colIdx >= cols) { doc.addPage(); colIdx = 0; onFirstPage = false; }
    y = colTop();
  }
  for (let i = 0; i < cats.length; i++) {
    const h = heights[i];
    const usedInCol = y - colTop();
    // Move on if this category won't fit in the remaining column space, OR the column
    // has already met its balance target (and this isn't the very first thing in it).
    if (usedInCol > 0 && (y + h > pageBottom || usedInCol >= target)) nextColumn();
    if (h > cap() && y === colTop()) {
      // Taller than a whole column: draw it here and let following content continue after.
      y = drawCategory(cats[i], colX(colIdx), y);
    } else {
      y = drawCategory(cats[i], colX(colIdx), y);
    }
  }

  // ── disclaimers + footer (full width, after the last content) ────────────────
  const notes = [];
  if (c.allergenNote.show && c.allergenNote.text) notes.push({ t: c.allergenNote.text, footer: false });
  if (c.serviceNote.show && c.serviceNote.text) notes.push({ t: c.serviceNote.text, footer: false });
  if (c.footer) notes.push({ t: c.footer, footer: true });
  if (notes.length) {
    // measure block height
    let nh = 4;
    for (const n of notes) nh += wrap(n.t, contentW, 'normal', n.footer ? SZ.footer : SZ.note).length * lh(n.footer ? SZ.footer : SZ.note) + 1.5;
    // place below the tallest column on the current (last) page, else a new page
    let ny = pageBottom - nh; // default: bottom of page
    // if content already reaches near the bottom, push to a new page
    const lowest = Math.max(y, ...Array.from({ length: cols }, () => 0)); // y is last column's cursor
    if (lowest + 3 > pageBottom - nh) { doc.addPage(); ny = MARGIN; }
    doc.setDrawColor(215, 215, 215); doc.setLineWidth(0.2); doc.line(MARGIN, ny, pageW - MARGIN, ny); ny += 3;
    for (const n of notes) {
      const pt = n.footer ? SZ.footer : SZ.note;
      const lines = wrap(n.t, contentW, n.footer ? 'bold' : 'normal', pt);
      if (n.footer) { setFont('bold', pt, [85, 85, 85]); doc.text(lines, pageW / 2, ny + lh(pt) * 0.7, { align: 'center' }); }
      else { setFont('normal', pt, [120, 120, 120]); doc.text(lines, MARGIN, ny + lh(pt) * 0.7); }
      ny += lines.length * lh(pt) + 1.5;
    }
  }

  return doc;
}
