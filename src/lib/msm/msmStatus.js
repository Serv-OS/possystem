// src/lib/msm/msmStatus.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): the status bar under the tabs, the first run
// guide and the draft names. Pure, tested (msmStatus.test.js). Peter, after round 1: "it is rather
// confusing in places". The first thing a manager needs to know is whether what they see is LIVE
// on the tills, a DRAFT that is not, or a scheduled push they are only looking at (design 2, item 1).

const listOf = (v) => (Array.isArray(v) ? v : []);

/** "Changes 17 Oct 14:05": a draft name that carries the time (design 2, item 3). */
export function draftTitle(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `Changes ${day} ${time}`;
}

/**
 * The status bar.
 *   working   the set being worked on (null = the live menu)
 *   rows      its staged changes
 *   when      for a scheduled push, its time in words ("Mon 1 Dec 06:00"), or null
 * Returns { state: 'live' | 'draft' | 'scheduled', tone, title, words }.
 */
export function statusBar({ working = null, rows = [], when = null, draft = null } = {}) {
  if (!working) {
    // A draft waiting while the live menu shows: say so, and offer the way back to it (one draft at
    // a time, design 2 item 3; round 2 review).
    if (draft) return { state: 'live', tone: 'good', title: 'Live menu', words: `This is your live menu. Your draft "${draft.title}" is waiting; your next change goes into it.`, draftId: draft.id };
    return { state: 'live', tone: 'good', title: 'Live menu', words: 'This is your live menu. Changes go into a draft first; nothing reaches the tills until you publish.' };
  }
  if (working.status === 'draft') {
    const n = listOf(rows).length;
    return {
      state: 'draft', tone: 'warn', title: `Draft "${working.title}"`,
      words: n ? `${n} change${n === 1 ? '' : 's'}, not on the tills yet.` : 'Empty so far. Your changes collect here until you publish.',
      count: n,
    };
  }
  return {
    state: 'scheduled', tone: 'info', title: `Read only: "${working.title}"`,
    words: `${working.status === 'running' ? 'Publishing now' : 'As it will be'}${when ? ` on ${when}` : ' once it runs'}. Go back to the live menu to make changes.`,
  };
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
 */
export function undoFor(eff, changes) {
  const updates = [];
  const unstageKeys = [];
  for (const c of listOf(changes)) {
    const key = `${c.target}|${c.entity_id}|${c.location_id || ''}`;
    let row = null;
    if (ENTITY[c.target]) row = listOf(eff?.[ENTITY[c.target][0]]).find((r) => r.id === c.entity_id) || null;
    else if (SITE[c.target]) row = listOf(eff?.[SITE[c.target][0]]).find((r) => r[SITE[c.target][1]] === c.entity_id && r.location_id === c.location_id) || null;
    if (c.op === 'create' || !row) { unstageKeys.push(key); continue; }
    const after = {};
    for (const k of Object.keys(c.after || {})) after[k] = copy(row[k]);
    updates.push({ target: c.target, entity_id: c.entity_id, location_id: c.location_id || null, op: c.op === 'remove' ? 'update' : c.op, after, before: copy(c.before || {}) });
  }
  return { updates, unstageKeys };
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

/** The draft a new edit goes into when none is picked: the only draft there is (never a second one). */
export function draftToStageInto(sets, workingId) {
  if (workingId) return workingId;
  const drafts = listOf(sets).filter((d) => d && d.status === 'draft');
  return drafts.length === 1 ? drafts[0].id : null;
}
