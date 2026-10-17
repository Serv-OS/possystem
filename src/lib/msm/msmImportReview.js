// src/lib/msm/msmImportReview.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the first import's REVIEW step, as pure rules (tested in
// msmImportReview.test.js). The matching itself is supabase/functions/_shared/msmImport.js
// (proposeImport, buildCentral, settleKept); this file holds the person's choices and turns them
// into buildCentral's decisions.
//
// THE BUCKETS (design section 2, review finding "bulk actions for the 237 local only items")
//   family        matched by shared family: linked, nothing to do
//   name          matched by name only: NOT linked until ticked (each site keeps its own if not)
//   names         one product, different names at different sites: pick the group's name
//   onlyOne       only at one site: a site only extra, or Leave out (stays the venue's own).
//                 Archived ones start as Leave out. Bulk: per site, all extras or all left out.
//   clashes       two products with one name at one site: listed, each stays the venue's own
//
// Nothing here writes anything. The import writes the central tables only (msm_import_commit).

const listOf = (v) => (Array.isArray(v) ? v : []);

/** The starting choices for a proposal. */
export function initialChoices(proposal) {
  const onlyOne = {};
  for (const o of listOf(proposal?.review?.onlyOne)) onlyOne[o.productId] = o.defaultChoice || 'extra';
  return { tickName: [], onlyOne, names: {}, leaveOut: [] };
}

/** Tick or untick a name only match. */
export function setNameTick(choices, productId, on) {
  const s = new Set(choices.tickName);
  if (on) s.add(productId); else s.delete(productId);
  return { ...choices, tickName: [...s] };
}

/** Tick every name only match (or none). */
export function tickAllNames(choices, proposal, on) {
  return { ...choices, tickName: on ? listOf(proposal?.review?.name).map((n) => n.productId) : [] };
}

/** One only at one site product: 'extra' or 'leave'. */
export function setOnlyOne(choices, productId, choice) {
  return { ...choices, onlyOne: { ...choices.onlyOne, [productId]: choice === 'leave' ? 'leave' : 'extra' } };
}

/**
 * Bulk for the only at one site bucket.
 *   filter   { location_id (null = every site), archived: true | false | null (null = both), search }
 *   choice   'extra' | 'leave'
 * Returns { choices, count } (count = rows that matched the filter).
 */
export function setOnlyOneMany(choices, proposal, filter, choice) {
  const rows = filterOnlyOne(proposal, filter);
  const next = { ...choices.onlyOne };
  for (const o of rows) next[o.productId] = choice === 'leave' ? 'leave' : 'extra';
  return { choices: { ...choices, onlyOne: next }, count: rows.length };
}

/** The only at one site rows a filter shows. */
export function filterOnlyOne(proposal, { location_id = null, archived = null, search = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  return listOf(proposal?.review?.onlyOne).filter((o) => (!location_id || o.location_id === location_id)
    && (archived == null || !!o.archived === !!archived)
    && (!q || String(o.name || '').toLowerCase().includes(q)));
}

/** Pick the group's name for a product whose sites call it different things. */
export function setGroupName(choices, productId, name) {
  return { ...choices, names: { ...choices.names, [productId]: String(name ?? '') } };
}

/** Leave a matched product out of the group menu altogether (each site keeps its own). */
export function setLeaveOut(choices, productId, out) {
  const s = new Set(choices.leaveOut);
  if (out) s.add(productId); else s.delete(productId);
  return { ...choices, leaveOut: [...s] };
}

/** buildCentral's decisions from the person's choices, with the menu's name and description. */
export function toDecisions(proposal, choices, { menuName = '', menuDescription = '' } = {}) {
  const ticked = new Set(choices.tickName);
  const names = {};
  for (const [pid, n] of Object.entries(choices.names || {})) if (String(n).trim()) names[pid] = String(n).trim();
  return {
    leaveOut: [...choices.leaveOut],
    rejectName: listOf(proposal?.review?.name).map((n) => n.productId).filter((id) => !ticked.has(id)),
    names,
    onlyOne: { ...choices.onlyOne },
    menuName: String(menuName || '').trim() || 'Group menu',
    menuDescription: String(menuDescription || ''),
  };
}

/**
 * The review's counts, for the headline and the per site table.
 *   siteIds   the sites being imported (in order)
 * Returns { family, name, nameTicked, names, onlyOne: { extra, leave }, clashes,
 *           perSite: { [loc]: { onlyOne, extra, leave, archived } } }.
 */
export function reviewCounts(proposal, choices, siteIds = []) {
  const r = proposal?.review || {};
  const perSite = {};
  for (const loc of siteIds) perSite[loc] = { onlyOne: 0, extra: 0, leave: 0, archived: 0 };
  let extra = 0, leave = 0;
  for (const o of listOf(r.onlyOne)) {
    const c = choices.onlyOne[o.productId] || o.defaultChoice || 'extra';
    if (c === 'leave') leave++; else extra++;
    const s = perSite[o.location_id] || (perSite[o.location_id] = { onlyOne: 0, extra: 0, leave: 0, archived: 0 });
    s.onlyOne++;
    if (c === 'leave') s.leave++; else s.extra++;
    if (o.archived) s.archived++;
  }
  return {
    family: listOf(r.family).length, name: listOf(r.name).length, nameTicked: listOf(choices.tickName).length,
    names: listOf(r.differentNames).length, onlyOne: { extra, leave }, clashes: listOf(r.clashes).length, perSite,
  };
}

/** The headline after the self check: what the group menu will hold. */
export function importSummaryWords(central, check) {
  const products = listOf(central?.products).length;
  const sites = listOf(central?.sites).length;
  const extras = listOf(central?.products).filter((p) => p.site_only_location_id).length;
  const kept = listOf(central?.productSites).filter((s) => s.kept && Object.keys(s.kept).length).length;
  const head = `${products} product${products === 1 ? '' : 's'} at ${sites} site${sites === 1 ? '' : 's'}`
    + (extras ? `, ${extras} of them site only extras` : '')
    + (kept ? `. ${kept} site${kept === 1 ? ' keeps' : 's keep'} some values of its own` : '');
  const proof = check?.ok ? 'Publishing now would change 0 things at 0 sites.' : `The check found ${check?.writes || 0} differences to settle before the group menu can be made.`;
  return `${head}. ${proof}`;
}

/**
 * The venue menus a site could be imported from: [{ id, name, products, isDefault }], the
 * default first. A site with one menu has it chosen for it.
 */
export function venueMenuChoices(raw) {
  const menus = listOf(raw?.menus).filter((m) => m && m.is_active !== false);
  const cats = listOf(raw?.categories);
  const links = listOf(raw?.links);
  const items = listOf(raw?.items).filter((i) => i && i.archived !== true);
  return menus.map((m) => {
    const inMenu = new Set(cats.filter((c) => c.menu_id === m.id).map((c) => c.id));
    for (const l of links) if (l.menu_id === m.id) inMenu.add(l.category_id);
    const n = items.filter((i) => inMenu.has(i.cat) || listOf(i.cats).some((c) => inMenu.has(c))).length;
    return { id: m.id, name: m.name || 'Menu', products: n, isDefault: !!m.is_default };
  }).sort((a, b) => (b.isDefault - a.isDefault) || (b.products - a.products) || String(a.name).localeCompare(String(b.name)));
}
