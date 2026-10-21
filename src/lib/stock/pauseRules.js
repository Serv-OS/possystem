/**
 * stock/pauseRules.js: what "paused" means to the readers of Drop 1 (v5.11.86, multi site stock,
 * map 4.3 Pause). Pure: no React, no Supabase (pauseRules.test.js).
 *
 * A paused item is not suggested and cannot be ordered at that site (the Order pad, and the
 * Manager app's po.raise through manager-approve, which builds the same words on the server). It
 * is still counted and still taken off by sales: nothing here touches a number.
 *
 * The rows come from stock_paused_items(p_location): the items paused at that site TODAY on its
 * venue clock, `{ site_item_id, item_id, everywhere, until }` (until a 'YYYY-MM-DD' day, or null
 * for "until you unpause").
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' as 'D Mon' ('2026-11-03' -> '3 Nov'); '' for anything that is not such a day. */
export function dayWords(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
  if (!m) return '';
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day} ${MONTHS[month - 1]}`;
}

/**
 * Is the pause still on for that venue day? ({ everywhere, until }: a pause everywhere and a pause
 * at one site end the same way.) No end day: yes. todayIso is 'YYYY-MM-DD'.
 */
export function pausedNow({ until = null } = {}, todayIso = null) {
  if (!until) return true;
  if (!todayIso) return true;
  return String(todayIso).slice(0, 10) <= String(until).slice(0, 10);
}

/** 'Paused at Leeds until 3 Nov', 'Paused at Leeds', 'Paused everywhere until 3 Nov', 'Paused everywhere'. */
export function pauseWords({ siteName = '', everywhere = false, until = null } = {}) {
  const where = everywhere ? 'everywhere' : (String(siteName ?? '').trim() ? `at ${String(siteName).trim()}` : '');
  const day = dayWords(until);
  return ['Paused', where, day ? `until ${day}` : ''].filter(Boolean).join(' ');
}

/** The site item ids of the rows (the Order pad's items are site items). */
export function pausedSet(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.site_item_id) out.add(String(r.site_item_id));
  return out;
}

/** Site item id to its row, the rows still paused on todayIso (all of them when no day is given). */
export function pausedMap(rows, todayIso = null) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.site_item_id) continue;
    if (!pausedNow({ everywhere: r.everywhere === true, until: r.until || null }, todayIso)) continue;
    out.set(String(r.site_item_id), { siteItemId: String(r.site_item_id), itemId: r.item_id || null, everywhere: r.everywhere === true, until: r.until || null });
  }
  return out;
}

/** The refusal for an order line of a paused item: '<item>: Paused at Leeds until 3 Nov.' */
export function pausedLineWords(itemName, pause, siteName = '') {
  return `${String(itemName ?? '').trim() || 'This item'}: ${pauseWords({ siteName, everywhere: !!pause?.everywhere, until: pause?.until || null })}.`;
}
