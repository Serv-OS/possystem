// src/surfaces/website/blocks/editorFields.js
//
// 5.12.9: the pure rules behind the Back Office page editor's pickers (editorFields.jsx renders
// them). Plain JS, no React, so node:test checks every rule: which link options a site offers,
// which option an existing href selects, the menu and category dropdown rows, the category toggle,
// the hex colour check and the markdown toolbar's text edits. Stored values never change shape:
// an href stays a string, a menu id stays a string, categories stay [{ id }], a colour stays
// '#rrggbb' or ''.

/** The ServOS links every site offers, in the order the dropdown shows them. */
export const SERVOS_LINKS = Object.freeze([
  { label: 'Order online', value: 'servos:order' },
  { label: 'Catering', value: 'servos:catering' },
  { label: 'Book a table', value: 'servos:book' },
  { label: 'Loyalty', value: 'servos:loyalty' },
  { label: 'Gift cards', value: 'servos:gift' },
  { label: 'Waitlist', value: 'servos:waitlist' },
  { label: 'Blog', value: '/blog' },
]);

/** The dropdown row that reveals the web address box. */
export const CUSTOM_LINK = 'custom';

const str = (v) => (v == null ? '' : String(v));
const slugOf = (p) => str(p && p.slug).replace(/^\/+/, '');

/** The site's pages in dropdown order: home first, then by sort order, then by title. */
export function orderedPages(pages) {
  const list = Array.isArray(pages) ? pages.filter((p) => p && p.id) : [];
  return list.slice().sort((a, b) => {
    const ha = slugOf(a) === '' ? 0 : 1; const hb = slugOf(b) === '' ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const sa = Number(a.sort_order ?? 0); const sb = Number(b.sort_order ?? 0);
    if (sa !== sb) return sa - sb;
    return str(a.title).localeCompare(str(b.title));
  });
}

/** The label a page shows in a dropdown: "Home" for the home page, else its title, else its address. */
export function pageLabel(page) {
  if (!page) return '';
  const slug = slugOf(page);
  if (slug === '') return 'Home';
  return str(page.title).trim() || `/${slug}`;
}

/**
 * linkOptions(pages) → [{ label, value }]: the site pages as page:<id>, the ServOS links, then
 * "Web address" (CUSTOM_LINK) which opens a text box for https://, mailto: or tel:.
 */
export function linkOptions(pages) {
  const pageRows = orderedPages(pages).map((p) => ({ label: pageLabel(p), value: `page:${p.id}` }));
  return [...pageRows, ...SERVOS_LINKS.map((o) => ({ ...o })), { label: 'Web address', value: CUSTOM_LINK }];
}

/**
 * classifyHref(value, pages) → { choice, custom }: which dropdown row an existing href selects.
 * page:<id> or page:<slug> of a known page, or that page's site path ('/menu'), selects the page;
 * a ServOS link or /blog selects its row; anything else (https, mailto, tel, an unknown page,
 * '') selects "Web address" with the value kept in the box so nothing is lost.
 */
export function classifyHref(value, pages) {
  const v = str(value).trim();
  const list = orderedPages(pages);
  if (v.startsWith('page:')) {
    const id = v.slice(5);
    const hit = list.find((p) => p.id === id || slugOf(p) === id);
    if (hit) return { choice: `page:${hit.id}`, custom: '' };
    return { choice: CUSTOM_LINK, custom: v };
  }
  if (SERVOS_LINKS.some((o) => o.value === v)) return { choice: v, custom: '' };
  if (v === '/' || /^\/[a-z0-9-]+$/i.test(v)) {
    const slug = v.slice(1);
    const hit = list.find((p) => slugOf(p) === slug);
    if (hit) return { choice: `page:${hit.id}`, custom: '' };
  }
  return { choice: CUSTOM_LINK, custom: v };
}

/** True for a plain web address the box accepts: https://, http://, mailto: or tel:. */
export function isWebAddress(v) {
  return /^(https?:\/\/\S+|mailto:\S+|tel:\S+)$/i.test(str(v).trim());
}

/**
 * menuOptions(menu, current) → [{ label, value }]: "Live right now" ('follow') first, then every
 * venue menu by name. `menu` is the loadMenu result (its `menus` list) or a plain list of menus.
 * A current id no menu owns is kept as "Menu <id>" so a saved page never loses its value.
 */
export function menuOptions(menu, current) {
  const raw = Array.isArray(menu) ? menu : (menu && Array.isArray(menu.menus) ? menu.menus : []);
  const rows = raw.filter((m) => m && m.id).map((m) => ({ label: str(m.name).trim() || `Menu ${m.id}`, value: str(m.id) }));
  const out = [{ label: 'Live right now (follows your menu times)', value: 'follow' }, ...rows];
  const cur = str(current).trim();
  if (cur && !out.some((o) => o.value === cur)) out.push({ label: `Menu ${cur}`, value: cur });
  return out;
}

/** categoryOptions(menu) → [{ id, label }] from the loadMenu result's categories, in menu order. */
export function categoryOptions(menu) {
  const raw = Array.isArray(menu) ? menu : (menu && Array.isArray(menu.categories) ? menu.categories : []);
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: str(c.id), label: str(c.label || c.name).trim() || `Category ${c.id}` });
  }
  return out;
}

/** The ids ticked in a categories value ([{ id }]), junk dropped. */
export function categoryIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => x && typeof x === 'object' && str(x.id)).map((x) => str(x.id));
}

/**
 * toggleCategory(value, id, order) → the new [{ id }] value with `id` ticked or unticked, kept in
 * category `order` (an array of ids); ids not in the order stay at the end in their old order.
 */
export function toggleCategory(value, id, order) {
  const want = str(id);
  if (!want) return categoryIds(value).map((x) => ({ id: x }));
  const ids = categoryIds(value);
  const next = ids.includes(want) ? ids.filter((x) => x !== want) : [...ids, want];
  const rank = new Map((Array.isArray(order) ? order : []).map((x, i) => [str(x), i]));
  const sorted = next.slice().sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity; const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    return next.indexOf(a) - next.indexOf(b);
  });
  return sorted.map((x) => ({ id: x }));
}

/** True for '#rrggbb' (any case). '' is "none" and is handled by the caller. */
export function isHexColor(v) {
  return /^#[0-9a-f]{6}$/i.test(str(v));
}

/** '#rgb' or 'rrggbb' typed by hand → '#rrggbb' lower case; '' for anything that is not a colour. */
export function normaliseHex(v) {
  const s = str(v).trim().toLowerCase();
  if (/^#?[0-9a-f]{6}$/.test(s)) return s.startsWith('#') ? s : `#${s}`;
  if (/^#?[0-9a-f]{3}$/.test(s)) { const h = s.replace('#', ''); return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`; }
  return '';
}

/**
 * insertMarkdown(text, start, end, kind, extra) → { text, start, end }: the markdown toolbar's edit
 * on a textarea's selection. kind: 'heading' | 'bold' | 'italic' | 'bullet' | 'link'.
 * Heading and bullet work on whole lines; bold, italic and link wrap the selection (a placeholder
 * word when nothing is selected). The returned start and end re-select the edited text.
 */
export function insertMarkdown(text, start, end, kind, extra = {}) {
  const src = str(text);
  let a = Math.max(0, Math.min(Number(start) || 0, src.length));
  let b = Math.max(a, Math.min(Number(end) || a, src.length));
  const wrap = (open, close, placeholder) => {
    const sel = src.slice(a, b) || placeholder;
    const out = `${src.slice(0, a)}${open}${sel}${close}${src.slice(b)}`;
    return { text: out, start: a + open.length, end: a + open.length + sel.length };
  };
  switch (kind) {
    case 'bold': return wrap('**', '**', 'bold text');
    case 'italic': return wrap('*', '*', 'italic text');
    case 'link': {
      const target = str(extra.target).trim() || 'https://';
      const sel = src.slice(a, b) || str(extra.label).trim() || 'link text';
      const ins = `[${sel}](${target})`;
      return { text: `${src.slice(0, a)}${ins}${src.slice(b)}`, start: a + 1, end: a + 1 + sel.length };
    }
    case 'heading': case 'bullet': {
      // Whole lines: from the start of the first selected line to the end of the last.
      const ls = src.lastIndexOf('\n', a - 1) + 1;
      const leEnd = src.indexOf('\n', b);
      const le = leEnd === -1 ? src.length : leEnd;
      const lines = src.slice(ls, le).split('\n');
      const edited = lines.map((line) => {
        if (kind === 'heading') {
          const bare = line.replace(/^#{1,6}\s+/, '');
          return /^#{1,6}\s+/.test(line) ? bare : `## ${bare}`;
        }
        return /^\s*[-*+]\s+/.test(line) ? line.replace(/^\s*[-*+]\s+/, '') : `- ${line}`;
      }).join('\n');
      return { text: `${src.slice(0, ls)}${edited}${src.slice(le)}`, start: ls, end: ls + edited.length };
    }
    default: return { text: src, start: a, end: b };
  }
}
