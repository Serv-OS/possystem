// src/backoffice/sections/website/navDraft.js
//
// 5.12.8 (Peter, 1 Nov: "we need to be able to edit the header and navigation"). The pure half of
// the Header and navigation card: the rows the owner edits, built from site.nav (or, when none is
// saved, the automatic list the site shows: every page except venue pages, in order), and the
// save_site `nav` patch built back from those rows with the same rules the server checks
// (websiteRules.js navProblems: label 1 to 60 characters, page rows need a page, link rows a link).
//
// 5.12.19 (Peter: "I should be able to build a menu intelligently, drag one menu item under another
// or say sub menu item of this"): every row has a `key` and an `under` (the key of the row it sits
// under, '' at the top). One level deep, like the server. A top row with rows under it saves as a
// 'group' item that keeps its own page or link (the site shows it as a link that opens the list on
// hover); a 'group' row with no page is a heading only. A 'locations' row cannot hold rows.

export const MAX_NAV_ITEMS = 30;
export const MAX_LABEL = 60;

let keySeq = 0;
/** A fresh row with a key no other row in this session has. */
export const newRow = (r) => ({ key: `n${++keySeq}`, label: '', kind: 'page', page_id: '', href: '', under: '', ...r });
const row = newRow;

/** Pages a nav item may point at: every page with an id, drafts and venue pages included. */
export function navPages(pages) {
  return (Array.isArray(pages) ? pages : []).filter((p) => p && p.id);
}

/** The automatic nav the site shows when nothing is saved: published pages except venue pages, in order. */
export function autoNavRows(pages) {
  return navPages(pages).filter((p) => p.status !== 'draft' && p.kind !== 'location')
    .map((p) => row({ label: String(p.title || p.slug || 'Page'), kind: 'page', page_id: p.id }));
}

/** Editable rows from the saved nav; `auto` says the site is showing the automatic list instead. */
export function navRowsFrom(site, pages) {
  const saved = Array.isArray(site && site.nav) ? site.nav.filter((n) => n && typeof n === 'object') : [];
  if (!saved.length) return { rows: autoNavRows(pages), auto: true };
  const list = navPages(pages);
  // A saved page_id may be the page's id or its slug (the designer writes slugs).
  const pageId = (id) => { const pg = list.find((p) => p.id === id || p.slug === id); return pg ? pg.id : String(id || ''); };
  const rows = [];
  for (const n of saved) {
    if (n.kind === 'locations') { rows.push(row({ label: String(n.label || 'Locations'), kind: 'locations' })); continue; }
    if (n.kind === 'group') {
      const parent = row(n.page_id
        ? { label: String(n.label || ''), kind: 'page', page_id: pageId(n.page_id) }
        : (n.href ? { label: String(n.label || ''), kind: 'link', href: String(n.href) } : { label: String(n.label || ''), kind: 'group' }));
      rows.push(parent);
      const kids = Array.isArray(n.children) ? n.children.filter((c) => c && typeof c === 'object') : [];
      for (const c of kids) {
        rows.push(c.kind === 'link' || (!c.page_id && c.href)
          ? row({ label: String(c.label || ''), kind: 'link', href: String(c.href || ''), under: parent.key })
          : row({ label: String(c.label || ''), kind: 'page', page_id: pageId(c.page_id), under: parent.key }));
      }
      continue;
    }
    if (n.kind === 'link' || (!n.page_id && n.href)) { rows.push(row({ label: String(n.label || ''), kind: 'link', href: String(n.href || '') })); continue; }
    rows.push(row({ label: String(n.label || ''), kind: 'page', page_id: pageId(n.page_id) }));
  }
  return { rows, auto: false };
}

const hasKey = (rows, key) => rows.some((r) => r.key === key);
/** Top level rows in order (a row whose parent is gone counts as top level). */
export function topRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => !r.under || !hasKey(list, r.under));
}
/** The rows sitting under `key`, in order. */
export function childrenOf(rows, key) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r.under && r.under === key);
}
/** Rows in the order the card shows them: each top row followed by the rows under it. */
export function orderedRows(rows) {
  const out = [];
  for (const t of topRows(rows)) { out.push(t); out.push(...childrenOf(rows, t.key)); }
  return out;
}
/** Rows the row `key` may sit under: top level, not itself, not a venues dropdown. */
export function parentOptions(rows, key) {
  return topRows(rows).filter((r) => r.key !== key && r.kind !== 'locations');
}

/** Put row `key` under `parentKey` ('' = top level). Rows that were under it move to the top (one level only). */
export function setUnder(rows, key, parentKey) {
  const me = rows.find((r) => r.key === key);
  if (!me) return rows;
  if (parentKey && (me.kind === 'locations' || !parentOptions(rows, key).some((r) => r.key === parentKey))) return rows;
  // The moved row goes last among its new siblings (the end of the list keeps every order simple).
  const rest = rows.filter((r) => r.key !== key).map((r) => (parentKey && r.under === key ? { ...r, under: '' } : r));
  return [...rest, { ...me, under: parentKey || '' }];
}

/** Remove row `key`; rows under it move to the top so nothing is lost by accident. */
export function removeRow(rows, key) {
  return rows.filter((r) => r.key !== key).map((r) => (r.under === key ? { ...r, under: '' } : r));
}

/** Move row `key` one place among the rows beside it (same parent). The same list when it is already at the end. */
export function moveSibling(rows, key, delta) {
  const me = rows.find((r) => r.key === key);
  if (!me) return rows;
  const sibs = me.under && hasKey(rows, me.under) ? childrenOf(rows, me.under) : topRows(rows);
  const at = sibs.findIndex((r) => r.key === key);
  const other = sibs[at + delta];
  if (!other) return rows;
  const i = rows.indexOf(me);
  const j = rows.indexOf(other);
  const out = rows.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The save_site nav patch from the rows, or the problems the owner must fix first. */
export function navPatchFrom(rows) {
  const errors = [];
  const nav = [];
  const list = Array.isArray(rows) ? rows : [];
  const tops = topRows(list);
  if (tops.length > MAX_NAV_ITEMS) errors.push(`The menu can hold at most ${MAX_NAV_ITEMS} items.`);
  // One saved item from a row, or null after an error. `child` = sits under another row.
  const item = (r, at, child) => {
    const label = String((r && r.label) || '').trim();
    if (!label) { errors.push(`${at} needs a label.`); return null; }
    if (label.length > MAX_LABEL) { errors.push(`${at} label is longer than ${MAX_LABEL} characters.`); return null; }
    if (r.kind === 'link') {
      const href = String(r.href || '').trim();
      if (!href) { errors.push(`${at} (${label}) needs a link.`); return null; }
      if (!/^(https?:\/\/|mailto:|tel:|\/|#|servos:|page:)/i.test(href)) { errors.push(`${at} (${label}): a link starts with https://, /, mailto: or tel:.`); return null; }
      return { label, kind: 'link', href };
    }
    if (r.kind === 'locations') {
      if (child) { errors.push(`${at} (${label}) lists every venue and cannot sit under another item.`); return null; }
      return { label, kind: 'locations' };
    }
    if (r.kind === 'group') {
      if (child) { errors.push(`${at} (${label}) is a heading and cannot sit under another item.`); return null; }
      return { label, kind: 'group' };
    }
    if (!r.page_id) { errors.push(`${at} (${label}) needs a page.`); return null; }
    return { label, kind: 'page', page_id: String(r.page_id) };
  };
  tops.forEach((t, i) => {
    const at = `Item ${i + 1}`;
    const own = item(t, at, false);
    if (!own) return;
    const kids = childrenOf(list, t.key);
    if (!kids.length) {
      if (own.kind === 'group') { errors.push(`${at} (${own.label}) is a heading with nothing under it. Put an item under it or remove it.`); return; }
      nav.push(own);
      return;
    }
    if (own.kind === 'locations') { errors.push(`${at} (${own.label}) lists every venue by itself; nothing can sit under it.`); return; }
    if (kids.length > MAX_NAV_ITEMS) { errors.push(`${at} (${own.label}) has more than ${MAX_NAV_ITEMS} items under it.`); return; }
    const before = errors.length;
    const children = kids.map((k, j) => item(k, `${at}, under it ${j + 1}`, true)).filter(Boolean);
    if (errors.length > before) return;
    const out = { label: own.label, kind: 'group', children };
    if (own.kind === 'page') out.page_id = own.page_id;
    if (own.kind === 'link') out.href = own.href;
    nav.push(out);
  });
  return { nav, errors };
}

/** Move row i by delta (-1 up, +1 down); the same list when the move falls off either end. */
export function moveRow(rows, i, delta) {
  const j = i + delta;
  if (i < 0 || j < 0 || i >= rows.length || j >= rows.length) return rows;
  const out = rows.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The header option choices, with the words the card shows. */
export const HEADER_BRAND_OPTIONS = [['logo', 'Logo', 'Your logo; the venue name when there is none'], ['name', 'Name', 'The venue name as text'], ['both', 'Logo and name', 'The logo with the name beside it']];
export const HEADER_LOGO_OPTIONS = [['small', 'Small', 'A 28px tall mark'], ['normal', 'Normal', 'A 40px tall mark'], ['large', 'Large', 'A 60px tall mark; the header grows with it'], ['xlarge', 'Extra large', 'An 84px tall mark; the header grows with it']];
export const HEADER_CTA_OPTIONS = [['none', 'None', ''], ['order', 'Order now', 'Goes to online ordering (the choose a venue page on a group site)'], ['book', 'Book a table', 'Goes to bookings']];

/** The header options as saved, with the defaults the site uses filled in. */
export function headerDraft(site) {
  const h = (site && site.settings && site.settings.header) || {};
  return { brand: ['logo', 'name', 'both'].includes(h.brand) ? h.brand : 'logo', cta: ['none', 'order', 'book'].includes(h.cta) ? h.cta : 'none', sticky: h.sticky !== false, logo_size: ['small', 'normal', 'large', 'xlarge'].includes(h.logo_size) ? h.logo_size : 'normal' };
}
