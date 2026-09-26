// src/lib/menuBoardSections.js
//
// What a MENU BOARD lists and how it is sized, in one place for the TV
// (surfaces/MenuBoardSurface.jsx) and the Back Office builder and its preview
// (backoffice/sections/MenuBoards.jsx). Drawing is surfaces/menuboard/BoardParts.jsx, also shared.
//
// v5.9.67, Peter 24 Sep 2026: "you can't add subcategories, only main categories, and that adds
// all the modifiers with no control. We need to add subcategories to the menu boards without
// the parents, and it should never show sub items unless they are set as sold alone."
//   1. A block may be ANY category that is not special, a SUBCATEGORY included. A subcategory
//      block lists that subcategory's own items under its own heading (or the heading typed on
//      the block); the parent need not be on the board. A parent block lists the items placed
//      directly in the parent, exactly as before.
//   2. A sub item that is not sold alone is an OPTION (Oat milk, No ice), never a product on a
//      board: lib/menuRules.js isOptionOnlyItem, the one rule the till, kiosk and online read.
//   3. Sizes (rows whose parent_id points at a listed item) nest under their parent as _variants.
//
// v5.9.68, the same night, from a photo of Coffee Boy's real board and "this is branding, it's
// very important":
//   4. ADD-ONS: a category block may tick option only sub items to list as small lines
//      (whipped cream 0.50, marshmallows 0.50) in their menu order (block.addOnIds). Untick and
//      they stay off; milks and syrups never appear by accident.
//   5. TEXT PANELS: a block of type 'text' (heading, lines, last line, boxed), e.g. the SYRUPS
//      box, placed anywhere among the categories. It stays when "Follow timed menus" narrows
//      the categories.
//   6. PRICE GRID BY SIZE: sizeRuns groups a section's lines so one header row (Small Boy |
//      Big Boy | XL Boy) serves every product beneath it until the sizes change.
//   7. ONE TEXT SIZE RULE: boardColumns, fitFont and scaledFont are the rule for both the TV and
//      the preview ("the font size override is not showing on the preview": the preview kept its
//      own copy with different caps). 100% = the largest text that fills the screen; smaller
//      leaves room; larger adds columns to make room.
//   8. Per element sizes and colours (title, logo, headings, items, prices, small print):
//      boardSizes / boardColors, with the fallbacks the TV has always used.
//
// Pure, no React, so node:test can load it (menuBoardSections.test.js).

import { isOptionOnlyItem } from './menuRules.js';
import { applyMenuToSections } from './menuBoardMenus.js';
import { isImageBlock, normaliseSlides, DEFAULT_SLIDE_SECONDS } from './menuBoardSlides.js';

const bySort = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);
const sortCats = (a, b) => bySort(a, b) || String(a.label || '').localeCompare(String(b.label || ''));
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** May this row be a product line on a board? (rule 2, plus archived and the kiosk visibility switch) */
export function boardVisibleItem(it) {
  if (!it || it.archived) return false;
  if (it.visibility && it.visibility.kiosk === false) return false;
  if (isOptionOnlyItem(it)) return false;
  return true;
}

/**
 * { [categoryId]: items } for every category id an item carries (cat and cats), in menu order,
 * each item with its sizes nested as _variants (rule 3). A size row is never a line of its own.
 */
export function boardItemsByCategory(items) {
  const vis = (Array.isArray(items) ? items : []).filter(boardVisibleItem);
  const byId = Object.fromEntries(vis.map(i => [i.id, i]));
  const kids = {};
  for (const it of vis) if (it.parent_id && byId[it.parent_id]) (kids[it.parent_id] ||= []).push(it);
  for (const k in kids) kids[k].sort(bySort);
  const out = {};
  for (const it of vis) {
    if (it.parent_id && byId[it.parent_id]) continue;   // a size: shown under its parent
    const ids = new Set([it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean));
    for (const cid of ids) (out[cid] ||= []).push({ ...it, _variants: kids[it.id] || [] });
  }
  for (const k in out) out[k].sort(bySort);
  return out;
}

/** The option only sub items per category: the ADD-ONS a block may tick (rule 4). */
export function boardAddOnsByCategory(items) {
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.id || it.archived || !isOptionOnlyItem(it)) continue;
    const ids = new Set([it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean));
    for (const cid of ids) (out[cid] ||= []).push({ ...it, _addOn: true, _variants: [] });
  }
  for (const k in out) out[k].sort(bySort);
  return out;
}

/**
 * Every category a board may show (rule 1), in tree order: a parent, then its subcategories,
 * each with `depth` and a `path` label ("Coffee › Iced") for the builder. Special categories
 * are left out, as they are on every screen. A category whose parent is missing is a root.
 */
export function boardCategoryChoices(cats) {
  const list = (Array.isArray(cats) ? cats : []).filter(c => c && c.id && !c.is_special);
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  const kidsOf = {};
  for (const c of list) {
    const p = c.parent_id && byId[c.parent_id] ? c.parent_id : null;
    (kidsOf[p] ||= []).push(c);
  }
  for (const k in kidsOf) kidsOf[k].sort(sortCats);
  const out = [];
  const seen = new Set();
  const walk = (parentId, depth, prefix) => {
    for (const c of kidsOf[parentId] || []) {
      if (seen.has(c.id) || depth > 6) continue;   // a cycle in parent_id must not loop
      seen.add(c.id);
      const path = prefix ? `${prefix} › ${c.label ?? ''}` : String(c.label ?? '');
      out.push({ ...c, depth, path });
      walk(c.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return out;
}

/** The heading a block shows on the TV: the heading typed on the block, else the category's own label. */
export function boardSectionTitle(block, cat) {
  return str(block?.title) || String(cat?.label ?? '');
}

/** A text panel block for layout.blocks (rule 5). */
export function newTextBlock() {
  return { type: 'text', id: `text-${Math.random().toString(36).slice(2, 8)}`, title: '', body: '', footer: '', boxed: true, span: 1 };
}
export const isTextBlock = (b) => !!b && b.type === 'text';

/** A page break block (v5.9.71, Peter: "the fonts need a way to force them to be bigger"): the
 * blocks above it are one screen, the blocks below the next. Each page fits on its own, so the
 * type grows; the TV rotates the pages every layout.pageSeconds. */
export const isPageBreak = (b) => !!b && b.type === 'page';
export function newPageBreak() {
  return { type: 'page', id: `page-${Math.random().toString(36).slice(2, 8)}` };
}
export const DEFAULT_PAGE_SECONDS = 12;
export function pageSeconds(layout) {
  const n = Number(layout?.pageSeconds);
  return Number.isFinite(n) && n >= 5 ? Math.min(600, n) : DEFAULT_PAGE_SECONDS;
}

/** Sections split into pages at the page markers; empty pages vanish; no marker = one page. */
export function boardPages(sections) {
  const pages = [[]];
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!s) continue;
    if (s.type === 'page') { pages.push([]); continue; }
    pages[pages.length - 1].push(s);
  }
  const out = pages.filter(pg => pg.length > 0);
  return out.length ? out : [[]];
}

/**
 * Ordered, non empty sections for a board.
 *   blocks       board.layout.blocks: category blocks { categoryId, span?, title?, addOnIds? }
 *                and text blocks { type:'text', id, title, body, footer, boxed, span }. Empty or
 *                missing = every TOP LEVEL category in menu order (the board's default).
 *   cats         the venue's menu_categories rows
 *   itemsByCat   boardItemsByCategory(items)
 *   addOnsByCat  boardAddOnsByCategory(items) (optional)
 * → category sections { type:'category', id, cat, title, span, items } (add-ons merged into the
 *   items in menu order, each flagged _addOn) and text sections { type:'text', id, title, body,
 *   footer, boxed, span, items: [] }. A block whose category is gone, or an empty one, is skipped.
 */
export function boardSections({ blocks, cats, itemsByCat, addOnsByCat } = {}) {
  const all = (Array.isArray(cats) ? cats : []).filter(c => c && c.id && !c.is_special);
  const byId = Object.fromEntries(all.map(c => [c.id, c]));
  const list = Array.isArray(blocks) && blocks.length
    ? blocks.map((b, i) => (isTextBlock(b) ? { text: b, i } : isImageBlock(b) ? { image: b, i } : isPageBreak(b) ? { page: b, i } : { block: b || {}, cat: byId[b?.categoryId] })).filter(x => x.text || x.image || x.page || x.cat)
    : all.filter(c => !c.parent_id).sort(sortCats).map(c => ({ block: { categoryId: c.id }, cat: c }));
  const out = [];
  for (const x of list) {
    if (x.page) {
      out.push({ type: 'page', id: x.page.id || `page-${x.i}`, items: [] });
      continue;
    }
    if (x.image) {
      // v5.9.71: an image panel (one picture or a slideshow) among the categories. No slides = nothing to draw.
      const b = x.image;
      const slides = normaliseSlides(b.slides, { seconds: Number(b.seconds) > 0 ? Number(b.seconds) : DEFAULT_SLIDE_SECONDS });
      if (!slides.length) continue;
      out.push({ type: 'image', id: b.id || `image-${x.i}`, slides, fit: b.fit === 'contain' ? 'contain' : 'cover', ratio: str(b.ratio) || '16:9', span: b.span, items: [] });
      continue;
    }
    if (x.text) {
      const t = x.text;
      const title = str(t.title), body = str(t.body), footer = str(t.footer);
      if (!title && !body && !footer) continue;
      out.push({ type: 'text', id: t.id || `text-${x.i}`, title, body, footer, boxed: t.boxed !== false, span: t.span, items: [] });
      continue;
    }
    const { block, cat } = x;
    const products = (itemsByCat && itemsByCat[cat.id]) || [];
    const chosen = new Set(Array.isArray(block.addOnIds) ? block.addOnIds : []);
    const addOns = chosen.size ? ((addOnsByCat && addOnsByCat[cat.id]) || []).filter(a => chosen.has(a.id)) : [];
    const items = addOns.length ? [...products, ...addOns].sort(bySort) : products;
    if (!items.length) continue;
    out.push({ type: 'category', id: cat.id, cat, title: boardSectionTitle(block, cat), span: block.span, items });
  }
  return out;
}

/** "Follow timed menus": category sections narrow to the menu that is on; text and image panels always stay. */
export function boardSectionsForMenu(sections, { categories, links, activeMenuId } = {}) {
  const list = Array.isArray(sections) ? sections : [];
  if (!activeMenuId) return list;
  const catSecs = list.filter(s => s.type === 'category');
  const kept = new Set(applyMenuToSections(catSecs, { categories, links, activeMenuId }).map(s => s.id));
  return list.filter(s => s.type !== 'category' || kept.has(s.id));
}

/** A size's name as the grid header shows it. */
export const sizeName = (v) => str(v?.menu_name) || str(v?.name);

/**
 * Price grid by size (rule 6): a section's lines in RUNS that share the same size names, so one
 * header row serves every product beneath it until the sizes change (Single | Double for
 * espresso). A line with no sizes (Flat White 8oz, an add-on) joins the run above it and prices
 * in the first column. → [{ sizes: string[], lines }], sizes [] for a run with no sized product.
 */
export function sizeRuns(lines) {
  const runs = [];
  let cur = null;
  for (const it of Array.isArray(lines) ? lines : []) {
    if (!it) continue;
    const names = (Array.isArray(it._variants) ? it._variants : []).map(sizeName).filter(Boolean);
    const sig = names.join('\u001f');
    if (!cur || (sig && sig !== cur.sig)) { cur = { sig, sizes: names, lines: [] }; runs.push(cur); }
    cur.lines.push(it);
  }
  return runs.map(({ sizes, lines: ls }) => ({ sizes, lines: ls }));
}

// ── ONE text size rule (rule 7) ──────────────────────────────────────────────────────────────
// More columns = bigger text, because the fit fills the height and the content is spread
// thinner per column. An explicit integer count, never column-width:auto (Chromium clips
// overflow from an auto count without reporting it).
// v5.9.71: the top tiers open one more column (portrait 3, landscape 6): the fit fills the
// height, so a column more is the honest way to make the type bigger without clipping.
const COLS_FOR_TIER = { portrait: [1, 1, 2, 3], landscape: [2, 3, 5, 6] };
export const scaleTier = (ts) => (ts <= 0.9 ? 0 : ts < 1.075 ? 1 : ts < 1.225 ? 2 : 3);

/**
 * Columns to flow into. fixedCols (the operator's Columns setting) wins. Below 100% the text
 * shrinks instead of losing a column (scaledFont), so the tier floor is 1. Above 100% the board
 * opens columns to make room, allowing as few as two items per column.
 */
export function boardColumns({ textScale = 1, orientation = 'landscape', fixedCols = 0, totalItems = 0 } = {}) {
  const portrait = orientation === 'portrait';
  const maxN = portrait ? 3 : 6;
  const tier = Math.max(1, scaleTier(Number(textScale) || 1));
  const perCol = tier >= 2 ? 2 : 3;
  const want = Number(fixedCols) || COLS_FOR_TIER[portrait ? 'portrait' : 'landscape'][tier];
  return Math.max(1, Math.min(want, maxN, Math.ceil((Number(totalItems) || 1) / perCol)));
}

/** The largest whole px that fits, by binary search over fits(px) (the callers probe the DOM). */
export function fitFont(fits, { min = 4, max = 44 } = {}) {
  let lo = Math.round(min), hi = Math.round(max), best = Math.round(min);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * The text size the operator asked for, against the fill. The fill (100%) is the largest text
 * that fits. Below 100% the board shrinks from the fill and leaves room. Above 100% the fill is
 * already the ceiling (boardColumns opened columns to make room), so it is honoured up to the fit.
 */
export function scaledFont(best, textScale = 1, min = 4) {
  const ts = Number(textScale) || 1;
  if (ts >= 1) return best;
  return Math.max(min, Math.round(best * ts));
}

// ── Per element sizes and colours (rule 8), em against the fitted base ────────────────────────
export const SIZE_OPTS = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Extra large']];
export const LOGO_EM = { s: 1.0, m: 1.4, l: 2.2, xl: 3.2 };
export const TITLE_EM = { s: 0.9, m: 1.2, l: 1.6, xl: 2.1 };
export const HEADING_EM = { s: 0.7, m: 0.82, l: 1.0, xl: 1.2 };
export const ITEM_EM = { s: 0.48, m: 0.56, l: 0.66, xl: 0.78 };
// The note under the title (v5.9.71, Peter: "subtitle text far too small"): its own size, larger by default.
// v5.9.74 (Peter: "the subtitle is so small you cannot read it"): about 40% up at every size.
// M is 0.7 of the base, which on a 1080p portrait TV reads at arm's length from the counter.
export const NOTE_EM = { s: 0.5, m: 0.7, l: 0.9, xl: 1.15 };

// Defaults are the photo's look (Peter, 24 Sep: "the design is not peak like I asked for"): a
// large logo; medium everything else. A venue picks its own in Design.
export const SIZE_DEFAULTS = { logo: 'l', title: 'm', note: 'm', heading: 'm', item: 'm' };
export function boardSizes(theme = {}) {
  const pick = (map, v, d) => (map[v] !== undefined ? map[v] : map[d]);
  return {
    logo: pick(LOGO_EM, theme.logoSize, SIZE_DEFAULTS.logo),
    title: pick(TITLE_EM, theme.titleSize, SIZE_DEFAULTS.title),
    note: pick(NOTE_EM, theme.subtitleSize, SIZE_DEFAULTS.note),
    heading: pick(HEADING_EM, theme.headingSize, SIZE_DEFAULTS.heading),
    item: pick(ITEM_EM, theme.itemSize, SIZE_DEFAULTS.item),
  };
}

/** Colours with the fallbacks the TV has always used: headings and pills take the accent. */
export function boardColors(theme = {}) {
  const accent = theme.accent || '#E8A23C';
  const text = theme.textColor || '#F5EFE6';
  const plain = theme.priceStyle === 'plain';
  return {
    bg: theme.bgColor || '#14110d',
    text,
    muted: theme.mutedColor || '#B8AE9E',
    accent,
    heading: theme.headingColor || accent,
    title: theme.titleColor || text,
    price: theme.priceColor || (plain ? text : accent),
    priceText: '#1c1206',
  };
}

// ── Filling the columns (v5.9.76) ─────────────────────────────────────────────────────────
// Peter's photo of the Leeds board (26 Sep 2026): two columns of whole categories left the
// bottom right corner empty, because nothing could move into it, and the fit could not grow the
// type past the tallest column. Now the board is packed from MEASURED row heights: a category may
// continue in the next column, newspaper style, with its size header (Small · Big · XL) repeated
// at the top of the continuation; a heading never ends a column; a size header never ends a
// column; a text or image panel moves whole; a Full width block is its own band across every
// column. The columns of a band are levelled at the lowest height that holds everything (a
// binary search), so the fit loop can grow the type until the screen is full.
//
// measured: the page's sections in order, in px at the font being tried (null = nothing to show):
//   { atomic: true, h, span }                          a panel or a Full width block (whole)
//   { head, runs: [{ sizes, items: [h, ...] }], after } a category: heading height, each size run's
//                                                       header row (0 = none) and row heights, the gap below
// Returns { fits, height, bands }:
//   bands  [{ wide: true, sec, height }] or [{ cols: [[piece, ...], ...], height }]
//   piece  { sec, kind: 'head' | 'atomic' | 'run', run, from, to, last }   rows from..to (to exclusive)
// whole = true keeps every category in one column (the look before v5.9.76, Layout & display).
export function packBoard(measured, { cols = 1, height = 0, whole = false } = {}) {
  const n = Math.max(1, Math.floor(Number(cols) || 1));
  const H = Math.max(0, Number(height) || 0);
  const bands = [];
  let cur = [];
  const flush = () => { if (cur.length) { bands.push({ units: cur }); cur = []; } };
  (Array.isArray(measured) ? measured : []).forEach((sec, si) => {
    if (!sec) return;
    if (sec.atomic && sec.span === 'all') { flush(); bands.push({ wide: true, sec: si, h: Number(sec.h) || 0 }); return; }
    cur.push(...sectionUnits(sec, si, whole));
  });
  flush();
  let total = 0, fits = true;
  const out = bands.map((b) => {
    if (b.wide) { total += b.h; return { wide: true, sec: b.sec, height: b.h }; }
    const packed = packBand(b.units, n, H);
    if (!packed) { fits = false; return { cols: [], height: 0 }; }
    total += packed.height;
    return { cols: packed.cols.map(piecesOf), height: packed.height };
  });
  if (total > H + 0.5) fits = false;
  return { fits, height: total, bands: out };
}

/** A section as the rows the packer moves, in order; the gap below rides on its last row. */
function sectionUnits(sec, si, whole) {
  const units = [];
  if (sec.atomic) units.push({ sec: si, kind: 'atomic', h: Number(sec.h) || 0 });
  else {
    const runs = Array.isArray(sec.runs) ? sec.runs : [];
    if ((Number(sec.head) || 0) > 0 || !runs.length) units.push({ sec: si, kind: 'head', h: Number(sec.head) || 0 });
    runs.forEach((r, ri) => {
      const sizes = Number(r?.sizes) || 0;
      const items = Array.isArray(r?.items) ? r.items : [];
      if (sizes > 0) units.push({ sec: si, kind: 'sizes', run: ri, at: 0, h: sizes });
      items.forEach((h, i) => units.push({ sec: si, kind: 'item', run: ri, i, h: Number(h) || 0, sizes }));
    });
    if (units.length) units[units.length - 1].h += Number(sec.after) || 0;
  }
  if (units.length) units[units.length - 1].last = true;
  if (whole) units.forEach((u) => { u.whole = true; });
  return units;
}

/** How many rows from k must stay together: a heading with its first row (and size header), a size header with a row, a whole section when asked. */
function groupLen(units, k) {
  const u = units[k];
  if (u.whole) { let g = 1; while (units[k + g] && units[k + g].sec === u.sec) g++; return k === firstOf(units, k) ? g : 1; }
  if (u.kind === 'head') { let g = 1; if (units[k + g] && units[k + g].kind === 'sizes') g++; if (units[k + g] && units[k + g].kind === 'item') g++; return g; }
  if (u.kind === 'sizes') return units[k + 1] && units[k + 1].kind === 'item' ? 2 : 1;
  return 1;
}
const firstOf = (units, k) => { let j = k; while (j > 0 && units[j - 1].sec === units[k].sec) j--; return j; };

/** The rows into at most n columns of height t, in order; null when they do not fit. */
function packAt(units, n, t) {
  const cols = [[]];
  let y = 0;
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    const g = groupLen(units, k);
    let need = 0;
    for (let j = 0; j < g; j++) need += units[k + j].h;
    const cont = u.kind === 'item' && u.i > 0 && u.sizes > 0;   // a continuation repeats its size header
    if (y + need > t + 0.01) {
      if (y === 0 || cols.length >= n) return null;
      cols.push([]); y = 0;
      if (cont) { cols[cols.length - 1].push({ sec: u.sec, kind: 'sizes', run: u.run, at: u.i, h: u.sizes, repeat: true }); y = u.sizes; }
      if (y + need > t + 0.01) return null;
    }
    cols[cols.length - 1].push(u); y += u.h;
  }
  return cols;
}

/** The lowest column height that holds a band's rows in n columns, and the columns at it. */
function packBand(units, n, H) {
  if (!units.length) return { cols: [], height: 0 };
  if (!packAt(units, n, H)) return null;
  let lo = 0, hi = Math.ceil(H), best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = packAt(units, n, mid);
    if (c) { best = c; hi = mid - 1; } else lo = mid + 1;
  }
  const cols = best || packAt(units, n, H);
  const height = Math.max(0, ...cols.map((c) => c.reduce((s, u) => s + u.h, 0)));
  return { cols, height };
}

/** One column's rows as pieces to draw: a heading, a panel, or a run's rows from..to (with its size header). */
function piecesOf(col) {
  const out = [];
  for (const u of col) {
    const last = out[out.length - 1];
    if (u.kind === 'head' || u.kind === 'atomic') { out.push({ sec: u.sec, kind: u.kind, last: !!u.last }); continue; }
    if (u.kind === 'sizes') {
      if (!(last && last.kind === 'run' && last.sec === u.sec && last.run === u.run && last.to === u.at)) out.push({ sec: u.sec, kind: 'run', run: u.run, from: u.at, to: u.at, last: false });
      continue;
    }
    if (last && last.kind === 'run' && last.sec === u.sec && last.run === u.run && last.to === u.i) { last.to = u.i + 1; last.last = !!u.last; }
    else out.push({ sec: u.sec, kind: 'run', run: u.run, from: u.i, to: u.i + 1, last: !!u.last });
  }
  return out;
}

/** Layout & display → keep categories whole? Default: fill (a category may continue in the next column). */
export const boardKeepsWhole = (disp) => (disp && disp.flow) === 'whole';

// ── The header is sized by the SCREEN, not by the menu (v5.9.77) ─────────────────────────────
// Peter, 26 Sep 2026: "two menu boards, same settings, logo at different sizes, sub text different
// sizes, title different size, how is that possible?" Because every size was em against the fitted
// base, and the base is whatever makes THAT board's menu fill the screen: more items, smaller base,
// smaller logo. Branding must be the same on every screen, so the header and footer take their base
// from the screen's short side (like vmin), and only the menu body follows the fit.
export const HEADER_VMIN = 2.8;   // 2.8% of the short side: a 1080p TV gives 30px, the base the Leeds board fitted at
export function headerBasePx(w, h) {
  const m = Math.min(Number(w) || 0, Number(h) || 0);
  return m > 0 ? Math.max(6, Math.round((m * HEADER_VMIN) / 100)) : 0;
}
