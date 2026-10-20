// src/lib/msm/msmImportReview.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the first import's REVIEW step, as pure rules (tested in
// msmImportReview.test.js and msmImportSizes.test.js). The matching itself is
// supabase/functions/_shared/msmImport.js (proposeImport, buildCentral, settleKept); this file holds
// the person's choices, turns them into buildCentral's decisions, and says every line in words.
//
// THE LISTS (review fix 20 Oct 2026, v5.11.83: products only, every size under its product)
//   family        already shared between sites: linked for you; Leave out takes the sizes too
//   name          set up separately (or a site's own joining a shared product) by name: Same
//                 product, Keep separate (the default) or Leave out
//   names         one product, different names on sale at different sites: pick the group's name
//   onlyOne       on sale at one site only: brought in (a product on at that site only), or Leave
//                 out (stays the venue's own). Bulk per site. ('extra' stays the internal value
//                 for "bring in", so saved choices still read.)
//   clashes       two products ON SALE with one name at one site: each line says what happens
//   Switched off (archived) rows are never listed: one line counts them.
//
// Nothing here writes anything. The import writes the central tables only (msm_import_commit).

const listOf = (v) => (Array.isArray(v) ? v : []);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C" */
export const andList = (xs) => {
  const a = listOf(xs).filter(Boolean);
  return a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
};
const possessive = (name) => (/s$/i.test(String(name)) ? `${name}'` : `${name}'s`);
const quoted = (names) => andList(listOf(names).map((n) => `"${n}"`));

// ── Choices ──────────────────────────────────────────────────────────────────

/** The starting choices for a proposal. */
export function initialChoices(proposal) {
  const onlyOne = {};
  for (const o of listOf(proposal?.review?.onlyOne)) onlyOne[o.productId] = o.defaultChoice || 'extra';
  return { tickName: [], leaveName: [], onlyOne, names: {}, leaveOut: [] };
}

/** Tick (Same product) or untick (Keep separate) a name match. Ticking also takes it out of Leave out. */
export function setNameTick(choices, productId, on) {
  const s = new Set(choices.tickName);
  if (on) s.add(productId); else s.delete(productId);
  const leave = listOf(choices.leaveName).filter((id) => !(on && id === productId));
  return { ...choices, tickName: [...s], leaveName: leave };
}

/** Every name match Same product (on) or Keep separate (off). Clears Leave out either way. */
export function tickAllNames(choices, proposal, on) {
  return { ...choices, tickName: on ? listOf(proposal?.review?.name).map((n) => n.productId) : [], leaveName: [] };
}

/** One name match: 'same' (Same product), 'apart' (Keep separate) or 'leave' (Leave out). */
export function setNameChoice(choices, productId, choice) {
  const tick = listOf(choices.tickName).filter((id) => id !== productId);
  const leave = listOf(choices.leaveName).filter((id) => id !== productId);
  if (choice === 'same') tick.push(productId);
  if (choice === 'leave') leave.push(productId);
  return { ...choices, tickName: tick, leaveName: leave };
}

/** The choice a name match has now: 'same', 'apart' (the default) or 'leave'. */
export function nameChoiceOf(choices, productId) {
  if (listOf(choices?.leaveName).includes(productId)) return 'leave';
  if (listOf(choices?.tickName).includes(productId)) return 'same';
  return 'apart';
}

/** One only at one site product: 'extra' or 'leave'. */
export function setOnlyOne(choices, productId, choice) {
  return { ...choices, onlyOne: { ...choices.onlyOne, [productId]: choice === 'leave' ? 'leave' : 'extra' } };
}

/**
 * Bulk for the only at one site list.
 *   filter   { location_id (null = every site), search }
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
export function filterOnlyOne(proposal, { location_id = null, search = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  return listOf(proposal?.review?.onlyOne).filter((o) => (!location_id || o.location_id === location_id)
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
    leaveName: [...listOf(choices.leaveName)],
    names,
    onlyOne: { ...choices.onlyOne },
    menuName: String(menuName || '').trim() || 'Group menu',
    menuDescription: String(menuDescription || ''),
  };
}

/**
 * The review's counts (products, never sizes), for the tabs and the per site table.
 *   siteIds   the sites being imported (in order)
 * Returns { family, name, nameSame, nameLeave, nameTicked, names, onlyOne: { extra, leave },
 *           clashes, switchedOff, perSite: { [loc]: { onlyOne, extra, leave } } }.
 */
export function reviewCounts(proposal, choices, siteIds = []) {
  const r = proposal?.review || {};
  const perSite = {};
  for (const loc of siteIds) perSite[loc] = { onlyOne: 0, extra: 0, leave: 0 };
  let extra = 0, leave = 0;
  for (const o of listOf(r.onlyOne)) {
    const c = choices.onlyOne[o.productId] || o.defaultChoice || 'extra';
    if (c === 'leave') leave++; else extra++;
    const s = perSite[o.location_id] || (perSite[o.location_id] = { onlyOne: 0, extra: 0, leave: 0 });
    s.onlyOne++;
    if (c === 'leave') s.leave++; else s.extra++;
  }
  const nameIds = listOf(r.name).map((n) => n.productId);
  const nameSame = nameIds.filter((id) => nameChoiceOf(choices, id) === 'same').length;
  const nameLeave = nameIds.filter((id) => nameChoiceOf(choices, id) === 'leave').length;
  return {
    family: listOf(r.family).length, name: nameIds.length, nameSame, nameLeave, nameTicked: nameSame,
    names: listOf(r.differentNames).length, onlyOne: { extra, leave }, clashes: listOf(r.clashes).length,
    switchedOff: r.switchedOff?.count || 0, perSite,
  };
}

/**
 * The lists that say "Needs you" and that "Go on without looking?" names. Clashes are never one:
 * there is nothing to choose there.
 */
export function needsOf(counts) {
  return {
    name: (counts?.name || 0) > 0,
    names: (counts?.names || 0) > 0,
    onlyOne: ((counts?.onlyOne?.extra || 0) + (counts?.onlyOne?.leave || 0)) > 0,
  };
}

/** The review's footer: one site products brought in, and every product left out. */
export function footerWords(counts, choices) {
  const left = (counts?.onlyOne?.leave || 0) + listOf(choices?.leaveOut).length + (counts?.nameLeave || 0);
  const x = counts?.onlyOne?.extra || 0;
  return `${x} one site product${x === 1 ? '' : 's'} brought in, ${left} left out.`;
}

/** Every product is left out: there is no group menu to make. */
export function nothingToMake(central) {
  return !listOf(central?.products).some((p) => !p.parent_product_id);
}

/** Whether step 3 may make the group menu: the check passed AND at least one product comes in. */
export function canMakeGroupMenu(central, check) {
  return !!check?.ok && !nothingToMake(central);
}

/** The headline after the self check: what the group menu will hold. */
export function importSummaryWords(central, check) {
  const ps = listOf(central?.products);
  const tops = ps.filter((p) => !p.parent_product_id);
  if (!tops.length) return 'Every product is left out, so there is nothing to make. Go back to the matches and bring in at least one product.';
  const sizes = ps.length - tops.length;
  const sites = listOf(central?.sites).length;
  const byId = new Map(ps.map((p) => [p.id, p]));
  const root = (id) => { let p = byId.get(id); for (let i = 0; p && p.parent_product_id && byId.has(p.parent_product_id) && i < 10; i++) p = byId.get(p.parent_product_id); return p?.id; };
  const keeps = new Set(listOf(central?.productSites).filter((s) => s.kept && Object.keys(s.kept).length).map((s) => root(s.product_id)).filter(Boolean));
  const head = sizes
    ? `${plural(tops.length, 'product')} with ${plural(sizes, 'size')}, at ${plural(sites, 'site')}.`
    : `${plural(tops.length, 'product')} at ${plural(sites, 'site')}.`;
  const kept = keeps.size ? ` ${keeps.size} of them keep${keeps.size === 1 ? 's' : ''} some details of ${keeps.size === 1 ? 'its' : 'their'} own at one or more sites.` : '';
  const proof = check?.ok ? 'Publishing now would change 0 things at 0 sites.' : `The check found ${check?.writes || 0} differences to settle before the group menu can be made.`;
  return `${head}${kept} ${proof}`;
}

/**
 * The venue menus a site could be imported from: [{ id, name, products, sizes, isDefault }], the
 * default first. A live row in the menu whose parent is another row of the site is a size; every
 * other live row is a product. The order still follows products and sizes together, so the menu
 * picked by default never moves. A site with one menu has it chosen for it.
 */
export function venueMenuChoices(raw) {
  const menus = listOf(raw?.menus).filter((m) => m && m.is_active !== false);
  const cats = listOf(raw?.categories);
  const links = listOf(raw?.links);
  const all = listOf(raw?.items).filter(Boolean);
  const ids = new Set(all.map((i) => i.id));
  const items = all.filter((i) => i.archived !== true);
  return menus.map((m) => {
    const inMenu = new Set(cats.filter((c) => c.menu_id === m.id).map((c) => c.id));
    for (const l of links) if (l.menu_id === m.id) inMenu.add(l.category_id);
    let products = 0, sizes = 0;
    for (const i of items) {
      if (!(inMenu.has(i.cat) || listOf(i.cats).some((c) => inMenu.has(c)))) continue;
      if (i.parent_id && i.parent_id !== i.id && ids.has(i.parent_id)) sizes++; else products++;
    }
    return { id: m.id, name: m.name || 'Menu', products, sizes, isDefault: !!m.is_default };
  }).sort((a, b) => (b.isDefault - a.isDefault) || ((b.products + b.sizes) - (a.products + a.sizes)) || String(a.name).localeCompare(String(b.name)));
}

// ── The review's words (20 Oct 2026, v5.11.83) ───────────────────────────────
// money and siteName are passed in by the screen. Every line is a product; its sizes are under it.

/** The words the screen and the tests share: list names, headers and empty texts. */
export const REVIEW_WORDS = {
  intro: 'Work down the lists marked "Needs you", then check. Products already shared between sites are linked for you.',
  needsYou: ' · Needs you',
  worthALook: ' · Worth a look',
  family: {
    tab: 'Already shared',
    header: 'Products already shared between your sites. They are linked for you, with their sizes. Leave one out only if you do not want it in the group menu: each site then keeps its own as it is today, outside the group menu.',
    optionsHeading: 'Used only inside other products (options)',
    empty: 'No products are shared between your sites yet.',
    leaveOut: 'Leave out',
    putBack: 'Put back',
  },
  name: {
    tab: 'Set up separately',
    header: 'Products with the same name at several sites that were set up separately, not shared. For each one pick Same product, Keep separate or Leave out. Sizes go with their product. Nothing changes at any site whatever you pick.',
    allSame: 'All same product',
    allApart: 'All separate',
    same: 'Same product',
    apart: 'Keep separate',
    leave: 'Leave out',
    empty: 'Nothing to pick here.',
  },
  names: {
    tab: 'Different names',
    header: 'These products have a different name at some sites. Pick the name the group menu uses. Every site keeps the name on its own menu today, so nothing changes at any site. A site\'s own menu only changes if you later publish a new name to it.',
    label: 'Group menu name:',
    empty: 'Every product has one name at all its sites.',
  },
  onlyOne: {
    tab: 'One site only',
    header: 'Products on sale at one site only. Bring in: it joins the group menu, switched on at that site only. Leave out: it stays that site\'s own product, exactly as today. Its sizes always go with it.',
    bringIn: 'Bring in',
    leaveOut: 'Leave out',
    empty: 'Nothing here.',
  },
  clashes: {
    tab: 'Clashes',
    header: 'Two products on sale with the same name at one site. There is nothing to choose here: each line says what happens. Nothing changes at any site.',
    empty: 'No clashes.',
  },
};

/** The one line that counts the switched off products ('' when there are none). */
export function switchedOffWords(review) {
  const n = review?.switchedOff?.count || 0;
  if (!n) return '';
  return n === 1
    ? '1 deleted or switched off product at your sites stays as it is, not in the group menu.'
    : `${n} deleted or switched off products at your sites stay as they are, not in the group menu.`;
}

// Every product under one of `ids` in `products` (its sizes, and theirs), closed.
function closeOver(products, ids) {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of products) if (p.parent_product_id && out.has(p.parent_product_id) && !out.has(p.id)) { out.add(p.id); grew = true; }
  }
  return out;
}

/**
 * The proposal as the choices have it: a row that joined a shared product by name and is not
 * Same product (Keep separate or Leave out) is taken out of that product and its sizes, and the
 * switched off copy it stood in for is back. A product of that match with no row on sale left goes,
 * with its sizes (as buildCentral does). Already shared and One site only lines read this.
 */
export function reviewView(proposal, choices) {
  let products = listOf(proposal?.products);
  let productSites = listOf(proposal?.productSites);
  for (const n of listOf(proposal?.review?.name)) {
    if (!n.joined || nameChoiceOf(choices, n.productId) === 'same') continue;
    const locs = new Set(listOf(n.byName));
    const under = closeOver(products, [n.productId]);
    productSites = productSites.filter((ps) => !(under.has(ps.product_id) && locs.has(ps.location_id))).concat(listOf(n.restore));
    const onSale = new Set(productSites.filter((ps) => ps.active !== false).map((ps) => ps.product_id));
    const gone = closeOver(products, [...under].filter((id) => !onSale.has(id)));
    if (gone.size) {
      products = products.filter((p) => !gone.has(p.id));
      productSites = productSites.filter((ps) => !gone.has(ps.product_id));
    }
  }
  return { ...proposal, products, productSites };
}

/**
 * Every venue row that comes into the group menu with these choices, as 'loc|venue_item_id' (on
 * sale or riding along switched off). The same rules as buildCentral, without its check: Leave
 * out takes the sizes, One site only Leave out, and each name match as Same product, Keep
 * separate (its sites' own products come in apart) or Leave out. The Clashes words read it, so
 * a copy that is left out never says it goes in the group menu.
 */
export function rowsComingIn(proposal, choices) {
  const products = listOf(proposal?.products);
  const kids = new Map();
  for (const p of products) if (p.parent_product_id) { if (!kids.has(p.parent_product_id)) kids.set(p.parent_product_id, []); kids.get(p.parent_product_id).push(p.id); }
  const under = (ids) => {
    const out = new Set(ids);
    const todo = [...out];
    while (todo.length) for (const k of listOf(kids.get(todo.pop()))) if (!out.has(k)) { out.add(k); todo.push(k); }
    return out;
  };
  const d = toDecisions(proposal, choices || initialChoices(proposal));
  const leave = new Set(d.leaveOut);
  for (const o of listOf(proposal?.review?.onlyOne)) if ((d.onlyOne[o.productId] || o.defaultChoice) === 'leave') leave.add(o.productId);
  const left = under(leave);
  const inMenu = new Set(products.filter((p) => !left.has(p.id)).map((p) => p.id));
  let rows = listOf(proposal?.productSites).filter((ps) => !left.has(ps.product_id));
  const reject = new Set(d.rejectName);
  const leaveName = new Set(d.leaveName);
  for (const n of listOf(proposal?.review?.name)) {
    const out = leaveName.has(n.productId);
    if (!out && !reject.has(n.productId)) continue;
    const locs = new Set(listOf(n.byName));
    const mine = under([n.productId]);
    rows = rows.filter((ps) => !(mine.has(ps.product_id) && locs.has(ps.location_id)));
    if (!left.has(n.productId)) rows = rows.concat(listOf(n.restore));
    const onSale = new Set(rows.filter((ps) => ps.active !== false).map((ps) => ps.product_id));
    const gone = under([...mine].filter((id) => !onSale.has(id) && inMenu.has(id)));
    if (gone.size) { for (const id of gone) inMenu.delete(id); rows = rows.filter((ps) => !gone.has(ps.product_id)); }
    if (!out) rows = rows.concat(listOf(n.apart?.productSites));
  }
  return new Set(rows.map((ps) => `${ps.location_id}|${ps.venue_item_id}`));
}

/** A clash whose copy marked to come in is left out with these choices (rowsComingIn's set). */
export function clashLeftOut(c, comingIn) {
  const chosen = listOf(c?.copies).find((x) => x.comesIn);
  return !!chosen && !!comingIn && !comingIn.has(`${c.location_id}|${chosen.id}`);
}

const viewIndex = new WeakMap();
/** A view's lookups, built once per view object: { productById, rowsByProduct, sizesByParent, categoryById }. */
export function indexView(view) {
  if (view && typeof view === 'object' && viewIndex.has(view)) return viewIndex.get(view);
  const productById = new Map();
  const sizesByParent = new Map();
  for (const p of listOf(view?.products)) {
    productById.set(p.id, p);
    if (p.parent_product_id) { if (!sizesByParent.has(p.parent_product_id)) sizesByParent.set(p.parent_product_id, []); sizesByParent.get(p.parent_product_id).push(p); }
  }
  const rowsByProduct = new Map();
  for (const ps of listOf(view?.productSites)) { if (!rowsByProduct.has(ps.product_id)) rowsByProduct.set(ps.product_id, []); rowsByProduct.get(ps.product_id).push(ps); }
  const categoryById = new Map(listOf(view?.categories).map((c) => [c.id, c]));
  const idx = { productById, rowsByProduct, sizesByParent, categoryById };
  if (view && typeof view === 'object') viewIndex.set(view, idx);
  return idx;
}

const nameOfP = (p) => String(p?.menu_name || p?.name || '').trim();

/**
 * One product's facts for a line: its sizes nested under it, where it is on, its prices and how it
 * is sold at each site.
 *   sites  [{ location_id, on, price, own, form }]   own = the site charges its own price;
 *          form = 'option' (only inside other products there), 'sized' (a size is on there) or
 *          'plain' (sold on its own)
 */
export function productFacts(view, productId) {
  const { productById, rowsByProduct, sizesByParent, categoryById } = indexView(view);
  const p = productById.get(productId);
  if (!p) return null;
  const forms = view?.review?.rowForms || {};
  const centralOption = p.type === 'subitem' && p.sold_alone !== true;
  const sitesOf = (x) => listOf(rowsByProduct.get(x.id)).map((ps) => ({
    location_id: ps.location_id, venue_item_id: ps.venue_item_id, on: ps.active !== false,
    price: ps.price ?? x.default_price ?? null, own: ps.price != null,
  }));
  const sizes = listOf(sizesByParent.get(p.id)).map((z) => ({ id: z.id, name: nameOfP(z), groupPrice: z.default_price ?? null, sites: sitesOf(z) }));
  const sized = new Set(sizes.flatMap((z) => z.sites.filter((s) => s.on).map((s) => s.location_id)));
  const sites = sitesOf(p).map((s) => {
    const rf = forms[`${s.location_id}|${s.venue_item_id}`];
    const option = rf ? rf.optionOnly === true : centralOption;
    return { location_id: s.location_id, on: s.on, price: s.price, own: s.own, form: option ? 'option' : sized.has(s.location_id) ? 'sized' : 'plain', usedBy: listOf(rf?.usedBy) };
  });
  const cat = categoryById.get(p.category_id);
  return {
    id: p.id, name: nameOfP(p), category: cat ? cat.label : null,
    optionOnly: centralOption,
    pricedBySize: p.type === 'variants',
    groupPrice: p.default_price ?? null, sites, sizes,
  };
}

const sizesWords = (f, money) => f.sizes.map((z) => `${z.name} ${money(z.groupPrice) || 'no price'}`).join(', ');

// Sizes on at fewer sites than their product, grouped by the same sites: [{ sites, words }].
function sizeNoteGroups(f, siteName) {
  const onP = f.sites.filter((s) => s.on).map((s) => s.location_id);
  const bySet = new Map();
  for (const z of f.sizes) {
    const onZ = z.sites.filter((s) => s.on).map((s) => s.location_id);
    if (!onZ.length || !onP.some((l) => !onZ.includes(l))) continue;
    const k = onZ.slice().sort().join('|');
    if (!bySet.has(k)) bySet.set(k, { sites: onZ, names: [] });
    bySet.get(k).names.push(z.name);
  }
  return [...bySet.values()].map((g) => ({ sites: g.sites, words: `${andList(g.names)} ${g.names.length === 1 ? 'is' : 'are'} only at ${andList(g.sites.map(siteName))}.` }));
}

/** "Small and Large are only at Site B." for sizes on at fewer sites than their product. */
export function sizeNotes(f, siteName) {
  return sizeNoteGroups(f, siteName).map((g) => g.words);
}

/** "Site A and Site C charge their own price for Small and Large." per group of sites. */
export function sizePriceNotes(f, siteName) {
  const groups = new Map();
  for (const s of f.sites) {
    if (!s.on) continue;
    const names = f.sizes.filter((z) => z.sites.some((x) => x.location_id === s.location_id && x.on && x.own)).map((z) => z.name);
    if (!names.length) continue;
    const k = names.join('|');
    if (!groups.has(k)) groups.set(k, { sites: [], names });
    groups.get(k).sites.push(s.location_id);
  }
  return [...groups.values()].map((g) => (g.sites.length === 1
    ? `${siteName(g.sites[0])} charges its own price for ${andList(g.names)}.`
    : `${andList(g.sites.map(siteName))} charge their own price for ${andList(g.names)}.`));
}

const FORM_WORDS = [['plain', 'sold on its own at'], ['sized', 'sold with sizes at'], ['option', 'an option inside other products at']];
// Where a shared product is on sale, in one form of words; and whether its forms differ by site.
function whereShared(f, siteIds, siteName) {
  const onRows = f.sites.filter((s) => s.on);
  const on = onRows.map((s) => s.location_id);
  const off = f.sites.filter((s) => !s.on).map((s) => s.location_id);
  const total = listOf(siteIds).length;
  const forms = new Set(onRows.map((s) => s.form));
  const mixed = forms.size > 1;
  let w;
  if (mixed) {
    w = FORM_WORDS.filter(([k]) => forms.has(k)).map(([k, words]) => `${words} ${andList(onRows.filter((s) => s.form === k).map((s) => siteName(s.location_id)))}`).join('; ');
  } else if (on.length === total && total > 1) w = total === 2 ? 'on sale at both sites' : `on sale at all ${total} sites`;
  else if (on.length === 1) w = `on sale at ${siteName(on[0])} only`;
  else if (on.length <= 3) w = `on sale at ${andList(on.map(siteName))}`;
  else w = `on sale at ${on.length} sites`;
  if (off.length) w += `, not on sale at ${andList(off.map(siteName))}`;
  const optionsOnly = onRows.length ? onRows.every((s) => s.form === 'option') : f.optionOnly;
  return { words: w, mixed, optionsOnly, sizedSites: onRows.filter((s) => s.form === 'sized').map((s) => s.location_id) };
}
const priceShared = (f, money) => {
  if (f.pricedBySize) return 'priced by size';
  // Only the sites where it is on sale: a switched off copy's price is never charged there.
  const own = f.sites.filter((s) => s.on && s.own).length;
  return `group price ${money(f.groupPrice) || 'no price'}${own === 1 ? ' (1 site charges its own)' : own ? ` (${own} sites charge their own)` : ''}`;
};

/**
 * Already shared: one line per PRODUCT, its sizes under it.
 *   leftOut    the product is left out
 *   joinApart  the names of the sites whose own product of this name is under Set up separately
 *              and Kept separate (it still comes in as its own product)
 * Returns { title, sub, sizes, notes, optionsOnly } (optionsOnly: every on sale row is only an
 * option inside other products, so the line goes under its own heading).
 */
export function sharedLine(view, productId, { siteName, money, siteIds = [], leftOut = false, joinApart = [] }) {
  const f = productFacts(view, productId);
  if (!f) return { title: '', sub: '', sizes: '', notes: [], optionsOnly: false };
  const where = whereShared(f, siteIds, siteName);
  const sub = [f.category || 'No category', !where.mixed && where.optionsOnly ? 'option only' : null, where.words, priceShared(f, money)].filter(Boolean).join(' · ');
  const sizedKey = where.sizedSites.slice().sort().join('|');
  const notes = sizeNoteGroups(f, siteName).filter((n) => !(where.mixed && n.sites.slice().sort().join('|') === sizedKey)).map((n) => n.words);
  notes.push(...sizePriceNotes(f, siteName));
  if (leftOut) {
    notes.push(f.sizes.length
      ? 'Left out with its sizes: each site keeps its own as it is today, outside the group menu.'
      : 'Left out: each site keeps its own as it is today, outside the group menu.');
    const apart = listOf(joinApart);
    if (apart.length === 1) notes.push(`${possessive(apart[0])} own ${f.name} is under Set up separately: it still comes in as its own product unless you leave it out there too.`);
    else if (apart.length > 1) notes.push(`${andList(apart)} each have their own ${f.name} under Set up separately: each still comes in as its own product unless you leave it out there too.`);
  }
  return { title: f.name, sub, sizes: f.sizes.length ? `Sizes: ${sizesWords(f, money)}` : '', notes, optionsOnly: where.optionsOnly };
}

// The sites a size is at, in words, against its product's sites.
const sizeSitesWords = (n, locs, siteName) => {
  if (locs.length === 1) return `${siteName(locs[0])} only`;
  if (locs.length === n) return n === 2 ? 'both sites' : `all ${n} sites`;
  return locs.length <= 3 ? andList(locs.map(siteName)) : `${locs.length} sites`;
};
const sameNamesNote = (n, name) => (n >= 3
  ? `${n} shared products are also called ${name}. These are not joined to any of them, because it could be any of them.`
  : `${n} shared products are also called ${name}. These are not joined to either, because it could be either one.`);

// Each site's own product, as it comes in with Keep separate (cached per entry).
const apartViews = new WeakMap();
function apartView(proposal, entry) {
  const key = entry && typeof entry === 'object' ? entry : null;
  if (key && apartViews.has(key)) return apartViews.get(key);
  const v = { ...proposal, products: listOf(entry?.apart?.products), productSites: listOf(entry?.apart?.productSites) };
  if (key) apartViews.set(key, v);
  return v;
}

/**
 * Whether a group price change reaches each site of the LINKED form where the product is on: a site
 * follows when every price row there (its sizes on there, else the product itself) has no price of
 * its own. Returns { follow: [loc], own: [{ loc, sized, price }] }.
 */
export function priceReach(proposal, productId) {
  const f = productFacts(proposal, productId);
  const follow = [];
  const own = [];
  if (!f) return { follow, own };
  for (const s of f.sites) {
    if (!s.on) continue;
    const sizeRows = f.sizes.map((z) => z.sites.find((x) => x.location_id === s.location_id && x.on)).filter(Boolean);
    const rows = sizeRows.length ? sizeRows : [s];
    if (rows.every((r) => !r.own)) follow.push(s.location_id);
    else own.push({ loc: s.location_id, sized: sizeRows.length > 0, price: s.price });
  }
  return { follow, own };
}

function reachWords(proposal, productId, siteName, money) {
  const { follow, own } = priceReach(proposal, productId);
  const total = follow.length + own.length;
  if (!total) return '';
  if (!own.length) return `A group price change reaches ${total === 1 ? siteName(follow[0]) : total === 2 ? 'both sites' : `all ${total} sites`}.`;
  if (!follow.length) return 'Every site keeps its own price until you change it there.';
  const head = `A group price change reaches ${follow.length <= 3 ? andList(follow.map(siteName)) : `${follow.length} of the ${total} sites`}.`;
  const O = andList(own.map((o) => siteName(o.loc)));
  let tail;
  if (own.every((o) => o.sized)) tail = own.length === 1 ? `${O} charges its own size prices and keeps them until you change them there.` : `${O} charge their own size prices and keep them until you change them there.`;
  else if (own.length === 1) tail = `${O} charges its own ${money(own[0].price) || 'price'} and keeps it until you change it there.`;
  else tail = `${O} charge their own prices and keep them until you change them there.`;
  return `${head} ${tail}`;
}

/**
 * Set up separately: one line per product, with what each choice does, each site's own product
 * today (its price and sizes) and notes.
 *   sharedLeftOut   a joined entry whose shared product is left out under Already shared
 * Returns { title, lead, choices: { same, apart, leave }, rows, notes, footer }.
 */
export function nameLine(proposal, entry, { siteName, money, siteIds = [], sharedLeftOut = false }) {
  const f = productFacts(proposal, entry.productId);
  if (!f) return { title: '', lead: '', choices: { same: '', apart: '', leave: '' }, rows: [], notes: [], footer: '' };
  const name = f.name;
  const joinSites = listOf(entry.byName);
  const joinNames = joinSites.map(siteName);
  const one = joinSites.length === 1;
  const reach = reachWords(proposal, entry.productId, siteName, money);
  let lead, same, apart, leave;
  if (entry.joined) {
    const shared = f.sites.map((s) => s.location_id).filter((l) => !joinSites.includes(l));
    const theirs = one ? `${possessive(joinNames[0])} ${name}` : `The ${name} at ${andList(joinNames)}`;
    lead = `${name} is shared at ${andList(shared.map(siteName))}. ${andList(joinNames)} set up ${one ? 'its' : 'their'} own ${name} separately.`;
    same = `Same product: ${theirs} joins the shared one.${reach ? ` ${reach}` : ''}`;
    apart = one
      ? `Keep separate: ${theirs} comes into the group menu as its own product, apart from the shared one.`
      : `Keep separate: ${theirs} each come in as their own product, apart from the shared one.`;
    leave = `Leave out: ${theirs} stays out of the group menu, exactly as today. The shared ${name} still comes in.`;
  } else {
    const n = f.sites.length;
    lead = `${name} was set up separately at ${n} sites, not shared.`;
    same = `Same product: one ${name} in the group menu.${reach ? ` ${reach}` : ''}`;
    apart = `Keep separate: ${name} comes into the group menu as ${n} separate products, one for each site, each with its own price${f.sizes.length ? ' and sizes' : ''}.`;
    leave = `Leave out: ${name} stays out of the group menu. Each site keeps its own ${name}, exactly as today.`;
  }
  // Each site's own product as it is today (the apart form: its own category, price and sizes).
  const av = apartView(proposal, entry);
  const avIdx = indexView(av);
  const rows = joinSites.map((loc) => {
    const ownP = av.products.find((x) => !x.parent_product_id && listOf(avIdx.rowsByProduct.get(x.id)).some((ps) => ps.location_id === loc));
    const g = ownP ? productFacts(av, ownP.id) : null;
    if (!g) return `${siteName(loc)}`;
    const zs = sizesWords(g, money);
    const option = g.sites.some((s) => s.location_id === loc && s.form === 'option');
    return `${siteName(loc)}: ${[g.category || 'No category', option ? 'option only' : null, zs ? `sizes ${zs}` : money(g.groupPrice) || 'no price'].filter(Boolean).join(' · ')}`;
  });
  if (entry.joined) {
    const shared = f.sites.map((s) => s.location_id).filter((l) => !joinSites.includes(l));
    rows.unshift(`Shared at ${andList(shared.map(siteName))}: ${f.pricedBySize && f.sizes.length ? `sizes ${sizesWords(f, money)}` : `group price ${money(f.groupPrice) || 'no price'}`}`);
  }
  const notes = [];
  if (f.sizes.length) {
    const n = f.sites.length;
    notes.push(`With Same product, sizes with the same name become one size: ${f.sizes.map((z) => `${z.name} (${sizeSitesWords(n, z.sites.map((s) => s.location_id), siteName)})`).join(', ')}.`);
  }
  const missing = listOf(siteIds).filter((l) => !f.sites.some((x) => x.location_id === l));
  if (missing.length) notes.push(`Not at ${andList(missing.map(siteName))}.`);
  if (entry.namesakes > 0) notes.push(sameNamesNote(entry.namesakes, name));
  if (entry.joined && sharedLeftOut) notes.push(`The shared ${name} is left out under Already shared, so Same product leaves ${one ? `${possessive(joinNames[0])} ${name}` : `the ${name} at ${andList(joinNames)}`} out too.`);
  return { title: name, lead, choices: { same, apart, leave }, rows, notes, footer: 'Nothing changes at any site whatever you pick.' };
}

/** Different names: the name the group menu uses, and every site's own name today. */
export function namesLine(proposal, entry, chosen, { siteName }) {
  const byName = new Map();
  for (const x of listOf(entry.names)) { if (!byName.has(x.name)) byName.set(x.name, []); byName.get(x.name).push(x.location_id); }
  const today = [...byName.entries()].sort((a, b) => b[1].length - a[1].length).map(([nm, locs]) => `${nm} at ${andList(locs.map(siteName))}`).join(' · ');
  const value = chosen || entry.groupName;
  return { title: `${REVIEW_WORDS.names.label} ${value}`, label: REVIEW_WORDS.names.label, value, options: [...byName.keys()], sub: `On each site's own menu today: ${today}` };
}

/** One site only: a product on sale at one site, with its sizes. */
export function onlyOneLine(view, entry, { siteName, money, choice }) {
  const f = productFacts(view, entry.productId);
  if (!f) return { title: entry.name || '', sub: '', sizes: '', notes: [] };
  const site = siteName(entry.location_id);
  const at = f.sites.find((s) => s.location_id === entry.location_id) || f.sites[0];
  const option = at ? at.form === 'option' : f.optionOnly;
  const used = option && at && at.usedBy.length ? `used in ${quoted(at.usedBy)}` : null;
  const where = entry.namesakes > 0 ? `${possessive(site)} own` : `only at ${site}`;
  const price = f.pricedBySize && f.sizes.length ? 'priced by size' : money(f.groupPrice) || 'no price';
  const sub = [f.category || 'No category', option ? 'option only' : null, used, where, price].filter(Boolean).join(' · ');
  const notes = [];
  if (entry.namesakes > 0) {
    notes.push(entry.namesakes >= 3
      ? `${entry.namesakes} shared products are also called ${f.name}. This one is not joined to any of them, because it could be any of them.`
      : `${entry.namesakes} shared products are also called ${f.name}. This one is not joined to either, because it could be either one.`);
  }
  if (choice === 'leave') notes.push(`Left out${f.sizes.length ? ' with its sizes' : ''}: it stays ${possessive(site)} own, exactly as today.`);
  return { title: f.name, sub, sizes: f.sizes.length ? `Sizes: ${sizesWords(f, money)}` : '', notes };
}

/**
 * Clashes: two products ON SALE with one name at one site. What happens, and what can be done.
 *   leftOut   the copy marked to come in is left out with the person's choices (clashLeftOut):
 *             then no copy goes in the group menu and the words say so.
 */
export function clashLine(c, { siteName, money, leftOut = false }) {
  const site = siteName(c.location_id);
  const whose = possessive(site);
  const what = c.level === 'size' ? `${c.name} (a size of ${c.parentName})` : c.name;
  const copies = listOf(c.copies);
  const out = !!leftOut && copies.some((x) => x.comesIn);
  const label = (x, i) => (c.kind === 'shared' ? (x.comesIn ? 'The shared one' : `${whose} own one`) : c.kind === 'copies' ? `Copy ${i + 1}` : `${i + 1}.`);
  const lines = copies.map((x, i) => `${label(x, i)}: ${money(x.price) || 'no price'} · ${x.category || 'no category'}${x.optionOnly ? ' · option only' : ''} · ${x.onMenu ? 'on the menu' : 'not on this menu'}${listOf(x.usedBy).length ? ` · used in ${quoted(x.usedBy)}` : ''}${x.comesIn ? (out ? ' · left out of the group menu' : ' · goes in the group menu') : ''}`);
  const thing = c.level === 'size' ? 'sizes' : 'products';
  const situation = c.kind === 'copies' ? `${site} sells ${copies.length} copies of the shared ${what}:`
    : c.kind === 'shared' ? `${site} sells the shared ${what} and also its own separate one:`
      : `${site} sells ${copies.length} ${thing} called ${what}, not shared:`;
  const stays = copies.filter((x) => !x.comesIn);
  const usedNames = [...new Set(stays.flatMap((x) => listOf(x.usedBy)))];
  let words;
  if (out) {
    // A size is left out with its product: name the product the person left out.
    const two = copies.length === 2;
    const gone = c.level === 'size' && c.parentName ? c.parentName : c.kind === 'shared' ? `the shared ${c.name}` : c.name;
    words = c.kind === 'shared'
      ? `You left ${gone} out, so neither goes in the group menu: both stay as they are at ${site}.`
      : `You left ${gone} out, so ${two ? 'neither copy goes' : 'none of the copies goes'} in the group menu: ${two ? 'both stay' : 'all of them stay'} as they are at ${site}.`;
  } else if (c.kind === 'copies') {
    const many = stays.length > 1;
    words = usedNames.length
      ? `The one marked "goes in the group menu" comes in. ${many ? 'The others stay' : 'The other stays'} ${whose} own, as ${many ? 'they are' : 'it is'} today: ${many ? 'they are' : 'it is'} used in ${quoted(usedNames)}, so keep ${many ? 'them' : 'it'} on.`
      : `The one marked "goes in the group menu" comes in and ${many ? 'the others stay' : 'the other stays'} ${whose} own, as ${many ? 'they are' : 'it is'} today; if ${site} no longer sells ${many ? 'them' : 'it'}, switch ${many ? 'them' : 'it'} off in ${whose} Menu Manager.`;
  } else if (c.kind === 'shared') {
    words = usedNames.length
      ? `The shared one goes in the group menu. ${whose} own one stays as it is: it is used in ${quoted(usedNames)}, so keep it on.`
      : `The shared one goes in the group menu and ${whose} own one stays as it is; if it is an old copy, switch it off in ${whose} Menu Manager.`;
  } else {
    const two = copies.length === 2;
    const head = `${two ? 'Neither goes' : 'None of them goes'} in the group menu, so ${two ? 'both' : 'all of them'} stay as they are at ${site}.`;
    if (copies.length && copies.every((x) => listOf(x.usedBy).length)) words = `${head} ${two ? 'Both are' : 'All of them are'} used in options there, so keep them on.`;
    else if (c.level === 'size' || copies.some((x) => x.optionOnly)) words = `${head} If one is an old copy that no option uses, switch it off in ${whose} Menu Manager, then start this set up again: the other one then comes in${c.level === 'size' && c.parentName ? ` with ${c.parentName}` : ''}.`;
    else words = `${head} If one is an old copy that no option uses, switch it off in ${whose} Menu Manager, then bring the other in from the Sites tab once the group menu is made.`;
  }
  return { title: what, situation, copies: lines, words };
}
