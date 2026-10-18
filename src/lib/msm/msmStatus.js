// src/lib/msm/msmStatus.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): the status bar under the tabs, the first run
// guide and the draft names. Pure, tested (msmStatus.test.js). Peter, after round 1: "it is rather
// confusing in places". The first thing a manager needs to know is whether what they see is LIVE
// on the tills, a DRAFT that is not, or a scheduled push they are only looking at (design 2, item 1).

import { isOptionOnlyItem } from '../menuRules.js';

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * "Changes 17 Oct 14:05": a draft name that carries the time (design 2, item 3), on the SITES' clock
 * when tz is given (17 Oct verification: Peter in California named UK drafts by his own clock).
 */
export function draftTitle(now = new Date(), tz = null) {
  const d = now instanceof Date ? now : new Date(now);
  const zone = tz ? { timeZone: tz } : {};
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...zone });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...zone });
  return `Changes ${day} ${time}`;
}

/**
 * The Admin switch for a company (UI item 12c, 17 Oct verification: it failed open while the check
 * was still running or had failed, and a blocked switch looked like an open one).
 *   enabled   the company is on now
 *   many      null while the check of the sites' menus runs, else { ok, sites }
 *   ticked    the note is ticked
 *   working   a change is being saved
 * Returns { checking, needsTick, failed, blocked, disabled, note, title }.
 */
export function adminSwitchState({ enabled = false, many = null, ticked = false, working = false } = {}) {
  const checking = !enabled && many == null;
  const failed = !enabled && !!many && many.ok === false;
  const needsTick = !enabled && !!many && (many.ok === false || listOf(many.sites).length > 0);
  const blocked = !enabled && (checking || (needsTick && !ticked));
  const note = checking ? "Checking the sites' menus…"
    : failed ? "Could not check the sites' menus. The multi site menu changes one menu per site for now."
      : needsTick ? 'This company has sites with more than one menu. The multi site menu changes one menu per site for now.' : '';
  return {
    checking, needsTick, failed, blocked, disabled: !!working || blocked, note,
    title: checking ? "Checking the sites' menus first" : blocked ? 'Tick the note below first' : undefined,
  };
}

/**
 * The status bar.
 *   working   the set being worked on (null = the live menu)
 *   rows      its staged changes
 *   when      for a scheduled push, its time in words ("Mon 1 Dec 06:00"), or null
 * Returns { state: 'live' | 'draft' | 'scheduled', tone, title, words }.
 */
export function statusBar({ working = null, rows = [], when = null, draft = null, central = null } = {}) {
  if (!working) {
    // A draft waiting while the live menu shows: say so, and offer the way back to it (one draft at
    // a time, design 2 item 3; round 2 review).
    if (draft) return { state: 'live', tone: 'good', title: 'Live menu', words: `This is your live menu. Your draft "${draft.title}" is waiting; your next change goes into it.`, draftId: draft.id };
    return { state: 'live', tone: 'good', title: 'Live menu', words: 'This is your live menu. Changes go into a draft first; nothing reaches the tills until you publish.' };
  }
  if (working.status === 'draft') {
    // The one counting rule (draftCount): "3 products changed", never the rows the database holds.
    const c = draftCount(rows, central);
    return {
      state: 'draft', tone: 'warn', title: `Draft "${working.title}"`,
      words: c.total ? `${c.words}, not on the tills yet.` : 'Empty so far. Your changes collect here until you publish.',
      count: c.total,
    };
  }
  return {
    state: 'scheduled', tone: 'info', title: `Read only: "${working.title}"`,
    words: `${working.status === 'running' ? 'Publishing now' : 'As it will be'}${when ? ` on ${when}` : ' once it runs'}. Go back to the live menu to make changes.`,
  };
}

// ── One counting rule, everywhere (Builder B recheck, item 5) ───────────────
// Before: the status bar and the "Add N changes to draft" buttons counted the rows the database
// holds (House Red and its 3 sizes turned on at a site read "5 changes"), while the publish tab
// counted the columns it writes at each site ("12 changes at 2 sites"). Now every screen counts
// what a manager changed: products (a size counts with its product, a sub item used only as an
// option counts with its option group), option groups, categories, and sites added. The option
// rows a product brings to a site where its option groups are not yet are part of that product.

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const andJoin = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const gidOfRef = (a) => (typeof a === 'string' ? a : a && typeof a === 'object' ? (a.groupId ?? null) : null);

/** "3 products changed", "1 product and 1 option group changed", "1 site added, 40 products changed". */
export function countWords(c) {
  const changed = [];
  if (c?.products) changed.push(plural(c.products, 'product', 'products'));
  if (c?.groups) changed.push(plural(c.groups, 'option group', 'option groups'));
  if (c?.categories) changed.push(plural(c.categories, 'category', 'categories'));
  if (c?.menu) changed.push("the menu's name");
  const head = c?.sites ? `${plural(c.sites, 'site', 'sites')} added` : '';
  const tail = changed.length ? `${andJoin(changed)} changed` : '';
  return head && tail ? `${head}, ${tail}` : head || tail;
}

// Look ups shared by both counts: products and options of the group menu plus any this list
// creates; a size's product; an option only sub item's option group; a product's option groups
// (with the "Then ask" groups they lead to).
function countIndex(central, rows = []) {
  const products = new Map(listOf(central?.products).map((p) => [p.id, p]));
  const options = new Map(listOf(central?.options).map((o) => [o.id, o]));
  for (const r of rows) {
    if (r.op === 'create' && r.target === 'product') products.set(r.entity_id, { id: r.entity_id, ...(r.after || {}) });
    if (r.op === 'create' && r.target === 'modifier_option') options.set(r.entity_id, { id: r.entity_id, ...(r.after || {}) });
  }
  const top = (id) => {
    let cur = id;
    for (let n = 0; n < 5; n++) { const p = products.get(cur); if (!p || !p.parent_product_id) break; cur = p.parent_product_id; }
    return cur;
  };
  const subGroup = (id) => {
    const p = products.get(id);
    if (!isOptionOnlyItem(p)) return null;
    for (const o of options.values()) if (o.product_id === id && o.group_id) return o.group_id;
    return null;
  };
  const groupsOf = (id) => {
    const want = new Set(listOf(products.get(id)?.modifier_groups).map(gidOfRef).filter(Boolean));
    for (let round = 0; round < 10; round++) {
      const n = want.size;
      for (const o of options.values()) if (o.sub_group_id && want.has(o.group_id)) want.add(o.sub_group_id);
      if (want.size === n) break;
    }
    return want;
  };
  return { products, options, top, subGroup, groupsOf };
}

function tally(P, G, K, S, menu) {
  const out = { products: P.size, groups: G.size, categories: K.size, sites: S.size, menu: !!menu };
  out.total = out.products + out.groups + out.categories + out.sites + (out.menu ? 1 : 0);
  out.words = countWords(out);
  return out;
}

/**
 * What a draft (or a list of changes about to go into it) changes, counted the one way.
 *   rows      msm_changes rows (or changes not staged yet)
 *   central   the group menu (the draft applied is best: names a product made in the draft)
 * Returns { products, groups, categories, sites, menu, total, words }.
 */
export function draftCount(rows, central = null) {
  const list = listOf(rows).filter((r) => r && typeof r === 'object' && r.target);
  const ix = countIndex(central, list);
  const P = new Set(), G = new Set(), K = new Set(), S = new Set();
  let menu = false;
  // The products (never an option only sub item) this list puts on or changes at each site.
  const productAt = new Map();
  for (const r of list) {
    if (r.target !== 'product_site' || ix.subGroup(r.entity_id)) continue;
    if (!productAt.has(r.location_id)) productAt.set(r.location_id, new Set());
    productAt.get(r.location_id).add(r.entity_id);
  }
  // Brought to a site by a product this list turns on there (an option row, or the sub item an
  // option sells): part of that product's change.
  const brought = (loc, g) => [...(productAt.get(loc) || [])].some((pid) => ix.groupsOf(pid).has(g));
  const product = (id) => { const g = ix.subGroup(id); if (g) G.add(g); else P.add(ix.top(id)); };
  for (const r of list) {
    if (r.target === 'product') product(r.entity_id);
    else if (r.target === 'product_site') {
      const g = ix.subGroup(r.entity_id);
      if (g && r.op === 'create' && brought(r.location_id, g)) continue;
      product(r.entity_id);
    } else if (r.target === 'category') K.add(r.entity_id);
    else if (r.target === 'modifier_group' || r.target === 'modifier_group_site') G.add(r.entity_id);
    else if (r.target === 'modifier_option') G.add(ix.options.get(r.entity_id)?.group_id || `option:${r.entity_id}`);
    else if (r.target === 'menu_site') S.add(r.location_id);
    else if (r.target === 'menu') menu = true;
  }
  for (const r of list) {
    if (r.target !== 'modifier_option_site') continue;
    const g = ix.options.get(r.entity_id)?.group_id || null;
    if (r.op === 'create' && g && brought(r.location_id, g)) continue;
    G.add(g || `option:${r.entity_id}`);
  }
  return tally(P, G, K, S, menu);
}

/**
 * The Review and publish tab's badge (18 Oct follow up): the same number as the "Review and publish
 * (N)" button beside it, never the rows the database holds (a new size at 3 sites read 4 there).
 *   s   the screen's shared state: { working, rows, eff, live, counted (draftCount, when worked out) }
 */
export function publishBadge(s) {
  if (s?.working?.status !== 'draft') return 0;
  if (s.counted && Number.isFinite(s.counted.total)) return s.counted.total;
  return draftCount(s.rows, s.eff || s.live || null).total;
}

/**
 * What a publish changes at ONE site, counted the same way, from the planner's lines there
 * (msmPlan.planSite(...).lines).
 */
export function siteCount(lines, central = null, locationId = null) {
  const ix = countIndex(central);
  const byVenueItem = new Map(listOf(central?.productSites).filter((ps) => ps.location_id === locationId).map((ps) => [ps.venue_item_id, ps.product_id]));
  const P = new Set(), G = new Set(), K = new Set(), S = new Set();
  const list = listOf(lines).filter(Boolean);
  const itemOf = (l) => ((l.table === 'items' || (l.table === 'links' && l.productId)) ? (l.productId || byVenueItem.get(l.id) || `item:${l.id}`) : null);
  // The products (never an option only sub item) changing at this site.
  const here = new Set();
  for (const l of list) { const pid = itemOf(l); if (pid && !ix.subGroup(pid)) here.add(pid); }
  const asked = (g) => [...here].some((pid) => ix.groupsOf(pid).has(g));
  for (const l of list) {
    const pid = itemOf(l);
    if (!pid) continue;
    const g = ix.subGroup(pid);
    if (!g) P.add(ix.top(pid));
    else if (!(l.column === '(new)' && asked(g))) G.add(g);   // a sub item a new option needs here
  }
  // A category new at this site because a product here needs it is part of that product.
  const parentOf = new Map(listOf(central?.categories).map((c) => [c.id, c.parent_id || null]));
  const needed = new Set();
  for (const pid of here) {
    const p = ix.products.get(pid);
    for (let cid of [p?.category_id, ...listOf(p?.extra_category_ids)]) {
      for (let n = 0; cid && n < 20; n++) { needed.add(cid); cid = parentOf.get(cid); }
    }
  }
  for (const l of list) {
    if (!(l.table === 'categories' || (l.table === 'links' && l.categoryId && !l.productId))) continue;
    if (l.column === '(new)' && l.categoryId && needed.has(l.categoryId)) continue;
    K.add(l.categoryId || `category:${l.id}`);
  }
  for (const l of list) {
    if (l.table !== 'groups') continue;
    const g = l.groupId || `group:${l.id}`;
    if (['(new)', '(option added)'].includes(l.column) && asked(g)) continue;
    G.add(g);
  }
  return tally(P, G, K, S, false);
}

/** Why a greyed button is grey (design 2, item 16). null when it is not. */
export function whyReadOnly({ canEdit, working }) {
  if (!canEdit) return 'You can look but not change the group menu. Ask ServOS to make you an editor.';
  if (working && working.status !== 'draft') return 'Read only while viewing a scheduled push. Go back to the live menu to make changes.';
  return null;
}

/** The first run guide, four steps (design 6.7). */
export const GUIDE_STEPS = Object.freeze([
  { n: 1, title: 'Change things here', words: 'Prices, products and option groups, for every site at once or one site at a time.' },
  { n: 2, title: 'They collect in a draft', words: 'The tills do not change. You can take any change back.' },
  { n: 3, title: 'Review and publish', words: 'Shows exactly what changes at each site, and checks for problems first.' },
  { n: 4, title: 'Publish now, or schedule it', words: 'Pick a date and time. The tills update by themselves; nobody needs to be there.' },
]);

const GUIDE_KEY = (menuId) => `msm-guide-closed:${menuId || 'any'}`;
/** Has this viewer closed the guide? (localStorage, so in try and catch: private windows refuse it). */
export function guideClosed(menuId, store = null) {
  try { return (store || globalThis.localStorage)?.getItem(GUIDE_KEY(menuId)) === '1'; } catch { return false; }
}
export function setGuideClosed(menuId, closed, store = null) {
  try {
    const s = store || globalThis.localStorage;
    if (!s) return;
    if (closed) s.setItem(GUIDE_KEY(menuId), '1'); else s.removeItem(GUIDE_KEY(menuId));
  } catch { /* private mode: the guide just shows again next time */ }
}

/**
 * The words for the note after a single cell action, with an Undo (design 2, item 7):
 * "Latte turned off at Leeds (in the draft)."
 */
export function cellNoteWords({ product, site, active, price, money = (v) => String(v) }) {
  if (active !== undefined) return `${product} turned ${active ? 'on' : 'off'} at ${site} (in the draft).`;
  if (price === null) return `${product} at ${site} goes back to the group price (in the draft).`;
  return `${product} at ${site}: ${money(price)} (in the draft).`;
}

/**
 * The note after the bulk bar's Turn on at or Turn off at (17 Oct verification: it counted the hidden
 * "one site mark" clears, so House Red and 3 sizes read "8 turned on"). Counts products the one way.
 *   result   activeMany(...)'s { changes, words }
 *   central  the group menu (the draft applied), to count a size with its product
 */
export function bulkActiveWords(result, on = true, central = null) {
  // The one counting rule (draftCount, Builder B recheck): a size counts with its product, so House
  // Red and its 3 sizes read "1 product turned on".
  const sitesRows = (result?.changes || []).filter((c) => c && c.target === 'product_site');
  const n = sitesRows.length ? draftCount(sitesRows, central).products : 0;
  const why = (result?.words || [])[0] || '';
  if (!n) return why || `Nothing to turn ${on ? 'on' : 'off'}: it is already like that.`;
  return `${n} product${n === 1 ? '' : 's'} turned ${on ? 'on' : 'off'} (in the draft).${why ? ` ${why}` : ''}`;
}

/** A product turned on at a site with no category yet: the hint at the moment it is flipped. */
export function noCategoryHint(product) {
  if (!product || product.category_id || (product.type === 'subitem' && product.sold_alone !== true) || product.parent_product_id) return '';
  return 'It has no category yet: open the product and pick one before you publish.';
}

// ── Undo for a single action (design 2, item 7: "nothing instant without Undo") ──

const ENTITY = { product: ['products', 'id'], category: ['categories', 'id'], modifier_group: ['groups', 'id'], modifier_option: ['options', 'id'] };
const SITE = { product_site: ['productSites', 'product_id'], modifier_group_site: ['groupSites', 'group_id'], modifier_option_site: ['optionSites', 'option_id'] };
const copy = (v) => (v == null ? v ?? null : JSON.parse(JSON.stringify(v)));

/**
 * What puts a just made edit back, worked out BEFORE it is staged, from what the screen showed
 * (central with the draft applied):
 *   updates     the same targets with each field back at the value shown before (staging them
 *               merges into the draft; back at where it started, the draft row goes)
 *   unstageKeys `${target}|${entity}|${location}` of rows that did not exist before (a create): the
 *               Undo takes that row out of the draft
 *   restage     draft rows an edit takes out of the draft (a turn on taken out again before
 *               publishing, msmEdit dropCreate): the Undo stages them again exactly as they were
 *               (Builder B recheck: it built an update for a row that no longer existed, and the
 *               database refused it)
 *   rows        the draft's rows as the screen holds them before the edit
 */
export function undoFor(eff, changes, rows = []) {
  const updates = [];
  const unstageKeys = [];
  const restage = [];
  const staged = new Map(listOf(rows).filter(Boolean).map((r) => [`${r.target}|${r.entity_id}|${r.location_id || ''}`, r]));
  for (const c of listOf(changes)) {
    const key = `${c.target}|${c.entity_id}|${c.location_id || ''}`;
    if (c.dropCreate) {
      const was = staged.get(key);
      if (was && was.op === 'create') restage.push({ target: was.target, entity_id: was.entity_id, location_id: was.location_id || null, op: 'create', after: copy(was.after || {}), before: copy(was.before || {}) });
      continue;
    }
    let row = null;
    if (ENTITY[c.target]) row = listOf(eff?.[ENTITY[c.target][0]]).find((r) => r.id === c.entity_id) || null;
    else if (SITE[c.target]) row = listOf(eff?.[SITE[c.target][0]]).find((r) => r[SITE[c.target][1]] === c.entity_id && r.location_id === c.location_id) || null;
    if (c.op === 'create' || !row) { unstageKeys.push(key); continue; }
    const after = {};
    for (const k of Object.keys(c.after || {})) after[k] = copy(row[k]);
    updates.push({ target: c.target, entity_id: c.entity_id, location_id: c.location_id || null, op: c.op === 'remove' ? 'update' : c.op, after, before: copy(c.before || {}) });
  }
  return { updates, unstageKeys, restage };
}

// ── A site's menu times in words (Menu details, UI issue 12a) ───────────────
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/**
 * "All day, every day", "16:00 to 23:00, every day", "07:00 to 11:30, Mon to Fri", "Sat, Sun".
 * The same reading as the tills (lib/menus/resolveActiveMenu.js isMenuActiveNow): no schedule is
 * always on; an empty days list is every day; a window may cross midnight.
 */
export function menuTimesWords(menu) {
  const s = menu && menu.schedule;
  if (!s || typeof s !== 'object') return 'All day, every day';
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b) : [];
  let dayWords = 'every day';
  if (days.length && days.length < 7) {
    const run = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    dayWords = run && days.length > 2 ? `${DAY[days[0]]} to ${DAY[days[days.length - 1]]}` : days.map((d) => DAY[d]).join(', ');
  }
  const time = s.from && s.to ? `${s.from} to ${s.to}` : 'All day';
  return `${time}, ${dayWords}`;
}

/**
 * Does the draft clash with the one time option group refresh? The server refuses only a draft or a
 * scheduled push that changes option groups, a product's option groups or VAT by order type
 * (msm_import_groups); any other change waiting is no reason to grey the button (round 2 review).
 */
export function refreshClash(rows) {
  return listOf(rows).some((r) => ['modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site'].includes(r?.target)
    || (r?.target === 'product' && r.after && typeof r.after === 'object' && ('modifier_groups' in r.after || 'tax_by_type' in r.after)));
}
export const REFRESH_CLASH_WORDS = 'Your draft changes option groups. Publish it, or take those changes out (See the changes), then refresh.';

/**
 * May the Undo on a note still run? (17 Oct verification: after a publish the old note's Undo said
 * "Taken back" and made a new empty draft, while the tills kept the new price.) Only while the draft
 * the change went into is still a draft, and is the one edits go into now.
 *   sets        the menu's change sets as the screen holds them
 *   workingId   the set picked now (or null)
 *   noteSetId   the set the change went into
 * Returns { ok, words }.
 */
export function undoTarget({ sets, workingId = null, noteSetId = null } = {}) {
  if (!noteSetId) return { ok: true, words: '' };
  const set = listOf(sets).find((x) => x && x.id === noteSetId);
  if (!set || set.status !== 'draft') return { ok: false, words: 'That change is already published or scheduled, so Undo cannot take it back here. To take it back, use Put back in Scheduled and history.' };
  if (draftToStageInto(sets, workingId) !== noteSetId) return { ok: false, words: `That change is in the draft "${set.title || 'another draft'}". Pick that draft to take it back.` };
  return { ok: true, words: '' };
}

/** The draft a new edit goes into when none is picked: the only draft there is (never a second one). */
export function draftToStageInto(sets, workingId) {
  if (workingId) return workingId;
  const drafts = listOf(sets).filter((d) => d && d.status === 'draft');
  return drafts.length === 1 ? drafts[0].id : null;
}
