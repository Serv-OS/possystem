// src/backoffice/sections/website/navDraft.js
//
// 5.12.8 (Peter, 1 Nov: "we need to be able to edit the header and navigation"). The pure half of
// the Header and navigation card: the rows the owner edits, built from site.nav (or, when none is
// saved, the automatic list the site shows: every page except venue pages, in order), and the
// save_site `nav` patch built back from those rows with the same rules the server checks
// (websiteRules.js navProblems: label 1 to 60 characters, page rows need a page, link rows a link).

export const MAX_NAV_ITEMS = 30;
export const MAX_LABEL = 60;

/** Pages a nav item may point at: every page with an id, drafts and venue pages included. */
export function navPages(pages) {
  return (Array.isArray(pages) ? pages : []).filter((p) => p && p.id);
}

/** The automatic nav the site shows when nothing is saved: published pages except venue pages, in order. */
export function autoNavRows(pages) {
  return navPages(pages).filter((p) => p.status !== 'draft' && p.kind !== 'location')
    .map((p) => ({ label: String(p.title || p.slug || 'Page'), kind: 'page', page_id: p.id, href: '' }));
}

/** Editable rows from the saved nav; `auto` says the site is showing the automatic list instead. */
export function navRowsFrom(site, pages) {
  const saved = Array.isArray(site && site.nav) ? site.nav.filter((n) => n && typeof n === 'object') : [];
  if (!saved.length) return { rows: autoNavRows(pages), auto: true };
  const list = navPages(pages);
  const rows = saved.map((n) => {
    // 5.12.12: dropdowns. 'locations' = every venue page; 'group' = the pages ticked (links inside a
    // group are kept as they are, the card edits pages only).
    if (n.kind === 'locations') return { label: String(n.label || 'Locations'), kind: 'locations', page_id: '', href: '' };
    if (n.kind === 'group') {
      const kids = Array.isArray(n.children) ? n.children.filter((c) => c && typeof c === 'object') : [];
      const pageIds = kids.filter((c) => c.kind !== 'link').map((c) => { const pg = list.find((p) => p.id === c.page_id || p.slug === c.page_id); return pg ? pg.id : String(c.page_id || ''); }).filter(Boolean);
      return { label: String(n.label || ''), kind: 'group', page_id: '', href: '', page_ids: pageIds, links: kids.filter((c) => c.kind === 'link') };
    }
    if (n.kind === 'link' || (!n.page_id && n.href)) return { label: String(n.label || ''), kind: 'link', page_id: '', href: String(n.href || '') };
    // A saved page_id may be the page's id or its slug (the designer writes slugs).
    const page = list.find((p) => p.id === n.page_id || p.slug === n.page_id);
    return { label: String(n.label || ''), kind: 'page', page_id: page ? page.id : String(n.page_id || ''), href: '' };
  });
  return { rows, auto: false };
}

/** The save_site nav patch from the rows, or the problems the owner must fix first. */
export function navPatchFrom(rows, pageTitles = null) {
  const errors = [];
  const nav = [];
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_NAV_ITEMS) errors.push(`The menu can hold at most ${MAX_NAV_ITEMS} items.`);
  list.forEach((r, i) => {
    const at = `Item ${i + 1}`;
    const label = String((r && r.label) || '').trim();
    if (!label) { errors.push(`${at} needs a label.`); return; }
    if (label.length > MAX_LABEL) { errors.push(`${at} label is longer than ${MAX_LABEL} characters.`); return; }
    if (r.kind === 'link') {
      const href = String(r.href || '').trim();
      if (!href) { errors.push(`${at} (${label}) needs a link.`); return; }
      if (!/^(https?:\/\/|mailto:|tel:|\/|#|servos:|page:)/i.test(href)) { errors.push(`${at} (${label}): a link starts with https://, /, mailto: or tel:.`); return; }
      nav.push({ label, kind: 'link', href });
      return;
    }
    if (r.kind === 'locations') { nav.push({ label, kind: 'locations' }); return; }
    if (r.kind === 'group') {
      const ids = Array.isArray(r.page_ids) ? r.page_ids.filter(Boolean) : [];
      const links = Array.isArray(r.links) ? r.links.filter((l) => l && l.label && l.href) : [];
      if (!ids.length && !links.length) { errors.push(`${at} (${label}) is a dropdown with nothing in it. Tick at least one page.`); return; }
      const children = [...ids.map((id) => ({ label: String((pageTitles && pageTitles[id]) || 'Page'), kind: 'page', page_id: String(id) })), ...links.map((l) => ({ label: String(l.label), kind: 'link', href: String(l.href) }))];
      nav.push({ label, kind: 'group', children });
      return;
    }
    if (!r.page_id) { errors.push(`${at} (${label}) needs a page.`); return; }
    nav.push({ label, kind: 'page', page_id: String(r.page_id) });
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
