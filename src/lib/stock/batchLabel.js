/**
 * stock/batchLabel.js: the words on a batch label and a PPDS label (multi site stock Drop 2,
 * v5.11.91, design 2.7 and 2.11, map 4.6 and 8.3 step 7).
 *
 * PURE: no DOM, no Supabase, no React. Everything here is a printDoc document (DocBuilder, the
 * same ops every printer model understands) or plain words, so node --test drives every line
 * (batchLabel.test.js). lib/labelPrint.js sends the document to the Label printer role.
 *
 *   batchLabelDoc(args, { cols })   name, Made, Use by, Allergens, Made by, Lot, qty, a cut
 *   ppdsLabelDoc(args, { cols })    name, the ingredient declaration with every *allergen* in
 *                                   bold, Allergens, Use by, Made; refused until signed off
 *   useByFrom(madeAt, days, tz)     the use by day from the made time and the shelf life
 *   labelCols(printer)              58 mm paper: 32 columns; 80 mm: 42
 *   repeatDoc(doc, copies)          one print job with the label repeated
 *   labelLines(doc)                 the lines a screen preview shows, bold and big marked
 *
 * Allergen ids are the 14 of src/data/seed.js ALLERGENS (the test pins the labels to the seed).
 * A label never carries cost, a price or a method.
 */

import { DocBuilder } from '../printDoc.js';
import { fmtVenueDateTime, fmtVenueDate, fmtYmd, ymdInZone, addDaysYmd } from '../venueDate.js';

/** The two refusals the web shows (contract 1.9) and the one line under every label screen. */
export const PPDS_NOT_SIGNED_OFF = 'Check the allergens first. The label prints once the recipe is checked.';
export const NO_LABEL_PRINTER = 'No label printer set up. Add one under Hardware, Printers, with the Label printer role.';
export const LABEL_ROLE_WORDS = 'Labels print on the Label printer role (Hardware, Printers).';

/** The seed labels, word for word (src/data/seed.js ALLERGENS; 'Tree nuts' for nuts). */
export const ALLERGEN_LABELS = Object.freeze({
  gluten: 'Gluten', crustaceans: 'Crustaceans', eggs: 'Eggs', fish: 'Fish', peanuts: 'Peanuts', soy: 'Soy',
  milk: 'Milk', nuts: 'Tree nuts', celery: 'Celery', mustard: 'Mustard', sesame: 'Sesame', sulphites: 'Sulphites',
  lupin: 'Lupin', molluscs: 'Molluscs',
});

/** The 14 ids in the order the label lists them (the kiosk sheet's order, kioskAllergens.js). */
export const ALLERGEN_ORDER = Object.freeze([
  'gluten', 'milk', 'eggs', 'fish', 'crustaceans', 'nuts', 'peanuts',
  'soy', 'sesame', 'celery', 'mustard', 'sulphites', 'molluscs', 'lupin',
]);

const MAX_COPIES = 50;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 'milk' gives 'Milk'; an id ServOS does not know is shown as typed, first letter up. */
export function allergenLabel(id) {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) return '';
  if (ALLERGEN_LABELS[key]) return ALLERGEN_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The ids once each, the 14 first in label order, then any other id alphabetically. */
export function orderAllergens(ids) {
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw ?? '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  const known = ALLERGEN_ORDER.filter((id) => seen.has(id));
  const other = list.filter((id) => !ALLERGEN_LABELS[id]).sort();
  return [...known, ...other];
}

/** 'Allergens: Milk, Gluten' or 'Allergens: none'. */
export function allergenWords(ids) {
  const list = orderAllergens(ids).map(allergenLabel);
  return list.length ? `Allergens: ${list.join(', ')}` : 'Allergens: none';
}

/** 'Made 21 Oct 2026 14:05' on the venue's clock; '' when there is no time. */
export function madeWords(madeAt, venueTz) {
  const words = fmtVenueDateTime(madeAt, venueTz);
  return words ? `Made ${words}` : '';
}

/** 'Use by 23 Oct 2026' from a plain day or an instant; '' when there is none. */
export function expiryLine(useBy, venueTz) {
  if (useBy == null || useBy === '') return '';
  const words = YMD.test(String(useBy)) ? fmtYmd(String(useBy)) : fmtVenueDate(useBy, venueTz);
  return words ? `Use by ${words}` : '';
}

/**
 * The use by day: the venue day the batch was made plus the shelf life in days ('YYYY-MM-DD').
 * null when there is no shelf life or no made time (the label then has no Use by line).
 */
export function useByFrom(madeAt, shelfLifeDays, venueTz) {
  const days = Number(shelfLifeDays);
  if (shelfLifeDays == null || shelfLifeDays === '' || !Number.isFinite(days) || days < 0) return null;
  const ymd = ymdInZone(madeAt, venueTz);
  return ymd ? addDaysYmd(ymd, Math.floor(days)) : null;
}

/** 58 mm label paper prints 32 columns, 80 mm prints 42; a printer that says its columns wins. */
export function labelCols(printer) {
  const cols = Number(printer?.cols);
  if (Number.isFinite(cols) && cols >= 16) return Math.floor(cols);
  const paper = Number(printer?.paperWidth ?? printer?.paper_width ?? printer?.paper);
  return paper === 58 ? 32 : 42;
}

/** '2.5 L', '12 each'; '' when there is no quantity. */
export function qtyWords(qty, unit) {
  const n = Number(qty);
  if (qty == null || qty === '' || !Number.isFinite(n)) return '';
  const num = Math.round(n * 1000) / 1000;
  return `${num}${unit ? ` ${String(unit).trim()}` : ''}`.trim();
}

// ── the declaration: *word* spans are bold ──────────────────────────────────────────────────────

/**
 * 'Flour (*wheat*), water, *milk*' gives [{ s: 'Flour (', bold: false }, { s: 'wheat', bold: true }, ...].
 * A lone * is kept as text. Empty text gives [].
 */
export function declarationSegments(text) {
  const src = String(text ?? '');
  if (!src) return [];
  const out = [];
  const push = (s, bold) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.bold === bold) last.s += s; else out.push({ s, bold });
  };
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('*', i);
    if (open < 0) { push(src.slice(i), false); break; }
    const close = src.indexOf('*', open + 1);
    if (close < 0) { push(src.slice(i), false); break; }
    push(src.slice(i, open), false);
    const inner = src.slice(open + 1, close);
    if (inner.trim()) push(inner, true); else push(src.slice(open, close + 1), false);
    i = close + 1;
  }
  return out;
}

/**
 * Word wrap a list of segments to `cols` characters a line, keeping each word's bold. A word longer
 * than a line is cut across lines. Answer: lines, each a list of { s, bold } (same bold merged).
 */
export function wrapSegments(segs, cols) {
  const width = Math.max(8, Math.floor(Number(cols) || 32));
  const words = [];
  for (const seg of segs || []) {
    const parts = String(seg.s ?? '').split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) words.push({ s: ' ', bold: !!seg.bold, space: true });
      else words.push({ s: p, bold: !!seg.bold, space: false });
    }
  }
  const lines = [];
  let cur = [];
  let len = 0;
  const flush = () => {
    while (cur.length && cur[cur.length - 1].space) cur.pop();
    lines.push(merge(cur));
    cur = []; len = 0;
  };
  for (const w of words) {
    if (w.space) { if (len > 0 && len < width) { cur.push(w); len += 1; } continue; }
    let s = w.s;
    while (s.length) {
      if (len > 0 && len + s.length > width) { flush(); continue; }
      const room = width - len;
      const take = s.length > width ? s.slice(0, room) : s;
      cur.push({ s: take, bold: w.bold, space: false });
      len += take.length;
      s = s.slice(take.length);
      if (len >= width && s.length) flush();
    }
  }
  if (cur.length) flush();
  return lines.length ? lines : [[]];
}

const merge = (parts) => {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.bold === p.bold) last.s += p.s; else out.push({ s: p.s, bold: p.bold });
  }
  return out;
};

/** Print wrapped segment lines on a builder, toggling bold only where it changes; bold off after. */
function printSegLines(b, lines) {
  let bold = false;
  for (const line of lines) {
    for (const seg of line) {
      if (seg.bold !== bold) { b.bold(seg.bold); bold = seg.bold; }
      b.text(seg.s);
    }
    b.lf();
  }
  if (bold) b.bold(false);
}

const plainLines = (b, text, cols) => printSegLines(b, wrapSegments([{ s: text, bold: false }], cols));

// ── the two labels ───────────────────────────────────────────────────────────────────────────────

/**
 * The batch label: name (bold, double height), 'Made <day time>', 'Use by <day>', 'Allergens:
 * <labels>' or 'Allergens: none', 'Made by <name>', 'Lot <code>', '<qty> <unit>', a cut. A line
 * with nothing to say is left off (no 'Made by' with no name). Never cost.
 */
export function batchLabelDoc({ name, madeAt, useBy, allergens, madeBy, lot, qty, unit, venueTz } = {}, { cols = 32 } = {}) {
  const width = labelCols({ cols });
  const b = new DocBuilder(width);
  b.init().left();
  b.bold(true).doubleHeight();
  plainLines(b, String(name || 'Batch').trim() || 'Batch', width);
  b.normal();
  const made = madeWords(madeAt, venueTz);
  if (made) plainLines(b, made, width);
  const use = expiryLine(useBy, venueTz);
  if (use) { b.bold(true); plainLines(b, use, width); b.bold(false); }
  plainLines(b, allergenWords(allergens), width);
  const who = String(madeBy || '').trim();
  if (who) plainLines(b, `Made by ${who}`, width);
  const lotCode = String(lot || '').trim();
  if (lotCode) plainLines(b, `Lot ${lotCode}`, width);
  const q = qtyWords(qty, unit);
  if (q) plainLines(b, q, width);
  b.lf(2).cut();
  return b.toDoc();
}

/**
 * The PPDS label (Natasha's Law, design 2.11): name, 'Ingredients: ' with every *allergen* in
 * bold, 'Allergens: <labels>', 'Use by <day>', 'Made <day time>', a cut. Refused with the 1.9 words
 * ({ error }) until the recipe's facts are checked at this site (signedOff).
 */
export function ppdsLabelDoc({ name, ingredientsText, allergens, madeAt, useBy, venueTz, signedOff } = {}, { cols = 32 } = {}) {
  if (signedOff !== true) return { error: PPDS_NOT_SIGNED_OFF };
  const width = labelCols({ cols });
  const b = new DocBuilder(width);
  b.init().left();
  b.bold(true).doubleHeight();
  plainLines(b, String(name || 'Product').trim() || 'Product', width);
  b.normal();
  const declaration = String(ingredientsText || '').trim();
  const segs = [{ s: 'Ingredients: ', bold: false }, ...(declaration ? declarationSegments(declaration) : [{ s: 'none listed', bold: false }])];
  printSegLines(b, wrapSegments(segs, width));
  plainLines(b, allergenWords(allergens), width);
  const use = expiryLine(useBy, venueTz);
  if (use) { b.bold(true); plainLines(b, use, width); b.bold(false); }
  const made = madeWords(madeAt, venueTz);
  if (made) plainLines(b, made, width);
  b.lf(2).cut();
  return b.toDoc();
}

/** One print job with the label repeated `copies` times (1 to 50). A refused doc stays refused. */
export function repeatDoc(doc, copies = 1) {
  if (!doc || doc.error || !Array.isArray(doc.ops)) return doc;
  const n = Math.min(MAX_COPIES, Math.max(1, Math.floor(Number(copies) || 1)));
  const ops = [];
  for (let i = 0; i < n; i++) ops.push(...doc.ops.map((op) => ({ ...op })));
  return { ops, cols: doc.cols };
}

/**
 * The lines a screen preview shows for a document: [{ segs: [{ s, bold, big }] }], one per printed
 * line (a blank line is { segs: [] }). Cuts, init and alignment are not shown.
 */
export function labelLines(doc) {
  const lines = [];
  if (!doc || !Array.isArray(doc.ops)) return lines;
  let bold = false;
  let big = false;
  let cur = null;
  const flush = () => { lines.push(cur || { segs: [] }); cur = null; };
  for (const op of doc.ops) {
    switch (op.t) {
      case 'text': {
        if (!op.s) break;
        if (!cur) cur = { segs: [] };
        const last = cur.segs[cur.segs.length - 1];
        if (last && last.bold === bold && last.big === big) last.s += op.s; else cur.segs.push({ s: op.s, bold, big });
        break;
      }
      case 'lf': { flush(); for (let i = 1; i < (op.n || 1); i++) lines.push({ segs: [] }); break; }
      case 'bold': bold = !!op.on; break;
      case 'size': big = true; break;
      case 'normal': bold = false; big = false; break;
      default: break;
    }
  }
  if (cur) flush();
  while (lines.length && !lines[lines.length - 1].segs.length) lines.pop();
  return lines;
}

/** The preview as plain text, one string a line (bold and size dropped). */
export function labelText(doc) {
  return labelLines(doc).map((l) => l.segs.map((s) => s.s).join(''));
}
