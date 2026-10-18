// src/lib/msm/msmPublishView.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the rules behind the Publish, Timeline, Sites and Price
// spread screens. Pure, tested (msmPublishView.test.js). No data, no React.
//
// Peter, 17 Oct 2026: "not just schedule price increase but schedule menu push so we can add items
// then say these items need to be on the POS by X date and time". These are the words and the
// sums those screens show: when a set runs and how long until then, what each site is doing, what
// a publish did at each site, and how far apart the sites' prices are.

import { money2, toPence, SITE_STATUS } from '../../../supabase/functions/_shared/msmModel.js';
import { whenText, LATE_MINUTES } from '../../../supabase/functions/_shared/msmSchedule.js';
import { indexCentral, cellFor } from './msmGrid.js';
import { priceLineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { keptValueWords } from './msmWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Picking a time ──────────────────────────────────────────────────────────

/** The date on a clock for an instant: { y, m, d, hh, mm } (numbers). */
export function clockParts(utcMs, tz = 'Europe/London') {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute };
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The time the schedule picker starts on: the NEXT 06:00 on the site's clock (before most cafes
 * open): today's when it is not 06:00 there yet (17 Oct verification: at 00:30 on Sunday the
 * coming morning is Sunday, not Monday), as "YYYY-MM-DDTHH:MM" for a datetime-local box.
 */
export function defaultRunLocal(nowMs = Date.now(), tz = 'Europe/London', hour = 6) {
  const c = clockParts(nowMs, tz);
  const next = new Date(Date.UTC(c.y, c.m - 1, c.hh < hour ? c.d : c.d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(hour)}:00`;
}

/** The earliest time the picker allows: now on that clock, to the minute. */
export function minRunLocal(nowMs = Date.now(), tz = 'Europe/London') {
  const c = clockParts(nowMs, tz);
  return `${c.y}-${pad(c.m)}-${pad(c.d)}T${pad(c.hh)}:${pad(c.mm)}`;
}

/** "in 2 days 4 hours", "in 3 hours 10 minutes", "in 12 minutes", "due now". */
export function countdownWords(targetMs, nowMs = Date.now()) {
  const t = ms(targetMs);
  if (t == null || !Number.isFinite(t)) return '';
  const mins = Math.round((t - nowMs) / 60000);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${plural(mins, 'minute')}`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return `in ${plural(h, 'hour')}${m ? ` ${plural(m, 'minute')}` : ''}`;
  const d = Math.floor(h / 24), hh = h % 24;
  return `in ${plural(d, 'day')}${hh ? ` ${plural(hh, 'hour')}` : ''}`;
}

/**
 * The sites a publish really changes (17 Oct verification: "Publish to 6 sites now? 1 change at 1
 * site"): once the preview is read, only sites with something to write (or that could not be read);
 * until then every site it reaches. The server still visits the rest and writes nothing there.
 */
export function changingSites(preview, reach) {
  if (!preview || !Array.isArray(preview.sites)) return listOf(reach);
  const on = new Set(preview.sites.filter((s) => s.missing || (s.plan?.lines?.length || 0) > 0).map((s) => s.location_id));
  return listOf(reach).filter((loc) => on.has(loc));
}

/** "Or schedule it for Sun 18 Oct 06:00": the shortcut names the real day, never "tomorrow". */
export function nextMorningWords(local, whenText) {
  return `Or schedule it for ${whenText}`;
}

/** The publish button: "Publish to 6 sites now" or "Publish to Station now". */
export function publishNowWords(sites) {
  const list = listOf(sites);
  if (!list.length) return 'Publish now';
  if (list.length === 1) return `Publish to ${list[0].name || 'one site'} now`;
  return `Publish to ${list.length} sites now`;
}

// ── A publish and its sites ─────────────────────────────────────────────────

const DONE = new Set(['done', 'nothing']);
const OPEN = new Set(['scheduled', 'running']);

/** Is a version site row late (still not done 15 minutes after its time)? */
export function isLate(vs, nowMs = Date.now()) {
  if (!vs || !OPEN.has(vs.status)) return false;
  if (vs.late_at) return true;
  const due = ms(vs.due_at);
  return due != null && nowMs - due > LATE_MINUTES * 60000;
}

/**
 * One version in words, for the timeline and history.
 *   version     a readHistory row ({ status, title, version_no, sites: [...] })
 *   siteNames   Map or object locationId -> name
 * Returns { tone: good|warn|bad|blue|neutral, head, detail, failed: [{ location_id, name, error }], late: [...], done, total }.
 */
export function versionSummary(version, siteNames = {}, nowMs = Date.now()) {
  const name = (id) => (siteNames instanceof Map ? siteNames.get(id) : siteNames[id]) || 'One site';
  const sites = listOf(version?.sites);
  const total = sites.length;
  const done = sites.filter((s) => DONE.has(s.status)).length;
  const failed = sites.filter((s) => s.status === 'failed').map((s) => ({ location_id: s.location_id, name: name(s.location_id), error: s.error || 'It did not go through.' }));
  const late = sites.filter((s) => isLate(s, nowMs)).map((s) => ({ location_id: s.location_id, name: name(s.location_id) }));
  const willFail = sites.filter((s) => s.status === 'scheduled' && s.precheck_ok === false).map((s) => ({ location_id: s.location_id, name: name(s.location_id), words: s.precheck_words || 'A problem was found an hour before.' }));
  const firstDue = sites.filter((s) => s.status === 'scheduled').map((s) => ms(s.due_at)).filter((x) => x != null).sort((a, b) => a - b)[0] ?? null;
  const st = version?.status;
  let tone = 'neutral', head = '', detail = '';
  if (st === 'cancelled') { tone = 'neutral'; head = 'Cancelled'; detail = 'It did not run. Nothing changed at any site.'; }
  else if (late.length) { tone = 'bad'; head = 'Late'; detail = `${late.map((l) => l.name).join(', ')} should have updated by now. The editors have been emailed.`; }
  else if (st === 'scheduled') {
    tone = willFail.length ? 'warn' : 'blue';
    head = 'Scheduled';
    detail = firstDue != null ? `Starts ${whenText(firstDue, 'Europe/London')} at ${plural(total, 'site')}` : `At ${plural(total, 'site')}`;
    if (willFail.length) detail += `. ${willFail[0].name} will fail unless it is fixed: ${willFail[0].words.replace(/\.$/, '')}.`;
  } else if (st === 'running') { tone = 'blue'; head = 'Running'; detail = `Done at ${done} of ${plural(total, 'site')} so far`; }
  else if (st === 'done') { tone = 'good'; head = 'Done'; detail = total ? `On the tills at ${total === 1 ? name(sites[0].location_id) : `all ${total} sites`}` : 'Done'; }
  else if (st === 'partly_done') { tone = 'warn'; head = `Done at ${done} of ${total}`; detail = failed.map((f) => `${f.name} failed: ${f.error.replace(/\.$/, '')}.`).join(' '); }
  else if (st === 'failed') { tone = 'bad'; head = 'Failed'; detail = failed.map((f) => `${f.name}: ${f.error.replace(/\.$/, '')}.`).join(' ') || 'Nothing changed.'; }
  else { head = st ? String(st) : ''; }
  return { tone, head, detail, failed, late, willFail, done, total, firstDue };
}

/** A site row's status in words ("Done", "Failed", "Starts Mon 20 Oct 05:55"). */
export function siteRowWords(vs, tz = 'Europe/London', nowMs = Date.now()) {
  if (!vs) return '';
  if (isLate(vs, nowMs)) return 'Late';
  if (vs.status === 'scheduled') {
    if (vs.precheck_ok === false) return `Will fail: ${vs.precheck_words || 'a problem was found'}`;
    return `Starts ${whenText(ms(vs.due_at), tz)}`;
  }
  if (vs.status === 'failed') return `Failed: ${vs.error || 'it did not go through'}`;
  return SITE_STATUS[vs.status] || vs.status;
}

/**
 * Scheduled and running sets in the order they run, joined to their versions.
 *   sets      msm_change_sets rows
 *   history   readHistory rows (each with sites)
 * Returns [{ set, version, firstDue, sites }], earliest first.
 */
export function timelineEntries(sets, history, nowMs = Date.now()) {
  const byId = new Map(listOf(history).map((v) => [v.id, v]));
  const out = [];
  for (const s of listOf(sets)) {
    if (s.status !== 'scheduled' && s.status !== 'running') continue;
    const version = byId.get(s.version_id) || null;
    const sites = listOf(version?.sites);
    const dues = sites.map((x) => ms(x.due_at)).filter((x) => x != null);
    const firstDue = dues.length ? Math.min(...dues) : (s.run_local ? Date.parse(String(s.run_local).replace(' ', 'T') + 'Z') : nowMs);
    out.push({ set: s, version, firstDue, sites });
  }
  return out.sort((a, b) => a.firstDue - b.firstDue || String(a.set.id).localeCompare(String(b.set.id)));
}

/** Can this scheduled set still be unscheduled or cancelled (no site has started)? */
export function canStillChange(entry) {
  if (!entry || entry.set?.status !== 'scheduled') return false;
  if (entry.version && entry.version.version_no != null) return false;
  return listOf(entry.sites).every((s) => s.status === 'scheduled');
}

// ── Sites ───────────────────────────────────────────────────────────────────

const STATE_ORDER = ['late', 'failed', 'running', 'will_fail', 'scheduled', 'changed', 'waiting', 'in_sync', 'unchecked'];
const STATE_LABEL = {
  late: 'Late', failed: 'Failed', running: 'Running', will_fail: 'Will fail', scheduled: 'Scheduled',
  changed: 'Changed at the site', waiting: 'Changes waiting', in_sync: 'In sync', unchecked: 'Not checked yet',
};
const STATE_TONE = { late: 'bad', failed: 'bad', running: 'blue', will_fail: 'warn', scheduled: 'blue', changed: 'warn', waiting: 'acc', in_sync: 'good', unchecked: 'neutral' };

/**
 * A card per site: what it is doing now.
 *   sites     [{ id, name, timezone }]
 *   history   readHistory rows, newest first
 *   opts      { waiting: Set(locationId) reached by drafts, drift: { loc: count }, now,
 *               checked: false until "Find changes made at sites" has run (then no site claims
 *               "In sync" without being looked at: 17 Oct verification) }
 * Returns [{ id, name, state, label, tone, flags: [{ state, label, tone }], nextAt, failed, lastDoneAt, lastVersionNo }].
 */
export function siteCards(sites, history, opts = {}) {
  const now = opts.now ?? Date.now();
  const waiting = opts.waiting || new Set();
  const drift = opts.drift || {};
  return listOf(sites).map((site) => {
    const flags = new Set();
    let nextAt = null, failed = null, lastDoneAt = null, lastVersionNo = null, willFailWords = null;
    let settled = false;      // the newest finished run at this site decides failed or not
    for (const v of listOf(history)) {
      const vs = listOf(v.sites).find((x) => x.location_id === site.id);
      if (!vs) continue;
      if (isLate(vs, now)) flags.add('late');
      if (vs.status === 'running') flags.add('running');
      if (vs.status === 'scheduled') {
        const due = ms(vs.due_at);
        if (due != null && (nextAt == null || due < nextAt)) nextAt = due;
        flags.add('scheduled');
        if (vs.precheck_ok === false) { flags.add('will_fail'); willFailWords = vs.precheck_words || null; }
      }
      if (!settled && (DONE.has(vs.status) || vs.status === 'failed')) {
        settled = true;
        if (vs.status === 'failed') { flags.add('failed'); failed = { versionId: v.id, title: v.title, error: vs.error || 'It did not go through.' }; }
      }
      if (lastDoneAt == null && DONE.has(vs.status)) { lastDoneAt = ms(vs.finished_at) ?? ms(v.finished_at); lastVersionNo = v.version_no ?? null; }
    }
    if ((drift[site.id] || 0) > 0) flags.add('changed');
    if (waiting.has(site.id)) flags.add('waiting');
    if (!flags.size) flags.add(opts.checked === false ? 'unchecked' : 'in_sync');
    const ordered = STATE_ORDER.filter((s) => flags.has(s));
    const state = ordered[0];
    return {
      id: site.id, name: site.name, timezone: site.timezone || 'Europe/London', state, label: STATE_LABEL[state], tone: STATE_TONE[state],
      flags: ordered.map((s) => ({ state: s, label: STATE_LABEL[s], tone: STATE_TONE[s] })),
      nextAt, failed, lastDoneAt, lastVersionNo, willFailWords, drift: drift[site.id] || 0,
    };
  });
}

/** Venues of the company not yet in the group menu (for Add a site). */
export function sitesToAdd(companySites, central) {
  const inMenu = new Set(listOf(central?.sites).map((s) => s.location_id));
  return listOf(companySites).filter((s) => !inMenu.has(s.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ── What a publish wrote at a site (msm_version_sites.writes) ───────────────

const COL_WORDS = {
  name: 'name', menu_name: 'menu name', receipt_name: 'receipt name', kitchen_name: 'kitchen name', description: 'description',
  cat: 'category', cats: 'extra categories', parent_id: 'size of', tax_rate_id: 'VAT rate', allergens: 'allergens', image: 'photo',
  assigned_modifier_groups: 'modifier groups', visibility: 'where it shows', sold_alone: 'sold on its own', item_code: 'item code',
  tags: 'tags', type: 'type', label: 'name', sort_order: 'order', tax_overrides: 'VAT by order type', tax_profile_id: 'tax profile',
};
const PRICE_WORDS = { base: '', dineIn: ' (eat in)', takeaway: ' (takeaway)', collection: ' (collection)', delivery: ' (delivery)', driveThru: ' (drive thru)' };

/**
 * The audit of one site's publish in plain words: ["Latte: 2.80 to 2.95", "Mince pie: new here"].
 *   writes   [{ table, id, before, after }]
 *   names    Map or object venue id -> name (falls back to the row's own name)
 */
export function auditLines(writes, names = {}) {
  const nm = (id, row) => (names instanceof Map ? names.get(id) : names[id]) || row?.menu_name || row?.name || row?.label || id;
  const out = [];
  for (const w of listOf(writes)) {
    const after = w?.after || {};
    const before = w?.before || null;
    if (w.table === 'items') {
      const who = nm(w.id, after);
      if (!before) { out.push(`${who}: new here${after.pricing?.base != null ? ` at ${money2(after.pricing.base)}` : ''}`); continue; }
      for (const k of Object.keys(after)) {
        if (k === 'pricing') {
          for (const ch of Object.keys(after.pricing || {})) {
            if (!(ch in PRICE_WORDS)) continue;
            out.push(priceLineWords(who, ch, before.pricing?.[ch] ?? null, after.pricing[ch] ?? null));
          }
        } else if (k === 'archived') out.push(`${who}: ${after.archived ? 'turned off' : 'turned on'}`);
        else if (k === 'updated_at') continue;
        else if (['name', 'menu_name', 'receipt_name', 'kitchen_name'].includes(k)) {
          const q = (v) => (v == null || String(v).trim() === '' ? 'blank' : `"${String(v).trim()}"`);
          out.push(`${who}: ${COL_WORDS[k]} ${q(before[k])} to ${q(after[k])}`);
        } else {
          // Never a raw value (an id, a photo link, true or false): in words (17 Oct verification).
          const word = COL_WORDS[k] || 'a setting';
          const objectish = (v) => v != null && typeof v === 'object';
          out.push(objectish(before[k]) || objectish(after[k]) || ['description', 'cat', 'cats', 'parent_id', 'tax_rate_id', 'tax_profile_id'].includes(k)
            ? `${who}: ${word} changed`
            : `${who}: ${word} ${keptValueWords(k, before[k] ?? null)} to ${keptValueWords(k, after[k] ?? null)}`);
        }
      }
    } else if (w.table === 'categories') {
      out.push(before ? `Category ${nm(w.id, after)}: changed` : `Category ${nm(w.id, after)}: new here`);
    } else if (w.table === 'menus') {
      out.push(before ? 'The site\'s menu: name or description changed' : 'The site\'s menu: made');
    } else if (w.table === 'groups') {
      out.push(`Modifier group ${nm(w.id, after)}: ${before ? 'changed' : 'copied here'}`);
    } else if (w.table === 'options') {
      out.push(`Option ${after?.name || ''}: follows its product`);
    }
  }
  return out;
}

// ── Price spread ────────────────────────────────────────────────────────────

/**
 * Per product: the lowest and highest price where it is on sale, the spread, and the sites more
 * than `outlierPct` from the median (design 4f). Products on sale at fewer than two sites, and
 * variants parents (never charged), are left out.
 *   central   central state (the draft applied)
 *   siteIds   the sites to compare
 * Returns [{ product, prices: [{ loc, price }], min, max, spread, pct, median, outliers: Set(loc) }],
 * the widest spread first.
 */
export function spreadRows(central, siteIds, { channel = null, outlierPct = 15 } = {}) {
  const ix = central && central.products instanceof Map ? central : indexCentral(central);
  const out = [];
  // Priced by its sizes (typed so, or with live sizes: 17 Oct recheck, as Menu Manager and publish see it).
  const withSizes = new Set([...ix.products.values()].filter((x) => x.parent_product_id && !x.archived).map((x) => x.parent_product_id));
  for (const p of ix.products.values()) {
    if (p.archived || p.type === 'variants' || withSizes.has(p.id)) continue;
    const prices = [];
    for (const loc of listOf(siteIds)) {
      const c = cellFor(ix, p, loc, channel);
      if (c.exists && c.active && c.price != null) prices.push({ loc, price: Number(c.price), pence: toPence(c.price) });
    }
    if (prices.length < 2) continue;
    const pence = prices.map((x) => x.pence).sort((a, b) => a - b);
    const min = pence[0], max = pence[pence.length - 1];
    const mid = Math.floor(pence.length / 2);
    const median = pence.length % 2 ? pence[mid] : Math.round((pence[mid - 1] + pence[mid]) / 2);
    const outliers = new Set(median > 0 ? prices.filter((x) => Math.abs(x.pence - median) * 100 > outlierPct * median).map((x) => x.loc) : []);
    // A size is never shown alone (UI item 9): "Americano, Large" (17 Oct verification).
    const parent = p.parent_product_id ? ix.products.get(p.parent_product_id) : null;
    const own = p.menu_name || p.name;
    out.push({
      product: p, label: parent ? `${parent.menu_name || parent.name}, ${own}` : own, prices, min: min / 100, max: max / 100, spread: (max - min) / 100,
      pct: min > 0 ? Math.round(((max - min) * 1000) / min) / 10 : null, median: median / 100, outliers,
    });
  }
  return out.sort((a, b) => b.spread - a.spread || (b.pct ?? 0) - (a.pct ?? 0) || String(a.label).localeCompare(String(b.label)));
}

/** One line over the spread: "21 of 58 products are priced differently between sites; widest Latte, 0.40 (12%)." */
export function spreadSummary(rows, comparable) {
  const differ = listOf(rows).filter((r) => r.spread > 0);
  if (!differ.length) return `Every product costs the same at every site${comparable ? ` (${plural(comparable, 'product')} compared)` : ''}.`;
  const w = differ[0];
  return `${differ.length}${comparable ? ` of ${comparable}` : ''} product${differ.length === 1 ? ' is' : 's are'} priced differently between sites; the widest is ${w.label || w.product.menu_name || w.product.name}, ${money2(w.spread)}${w.pct != null ? ` (${w.pct}%)` : ''}.`;
}

// ── Spreadsheet ─────────────────────────────────────────────────────────────

/** "group-menu-coffee-co-2026-10-17.csv" */
export function csvFileName(menuName, nowMs = Date.now()) {
  const slug = String(menuName || 'menu').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'menu';
  const d = new Date(nowMs);
  return `group-menu-${slug}-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}.csv`;
}

// ── Preview totals ──────────────────────────────────────────────────────────

/**
 * The headline over a publish preview.
 *   preview   msmDiff.previewSet(...) result
 * Returns { blocking, warnings, sitesBlocked: [names], sitesOk, sitesChanging, words }.
 */
export function previewHeadline(preview) {
  const sites = listOf(preview?.sites);
  const blocking = listOf(preview?.central?.blocking).length + sites.reduce((n, s) => n + listOf(s.health?.blocking).length, 0);
  const warnings = listOf(preview?.central?.warnings).length + sites.reduce((n, s) => n + listOf(s.health?.warnings).length, 0);
  const sitesBlocked = sites.filter((s) => s.missing || listOf(s.health?.blocking).length).map((s) => s.name);
  const sitesChanging = sites.filter((s) => (s.plan?.lines?.length || 0) > 0).length;
  const total = preview?.total || 0;
  const words = total
    ? `${plural(total, 'change')} at ${plural(sitesChanging, 'site')}`
    : 'Publishing this changes nothing at any site';
  return { blocking, warnings, sitesBlocked, sitesOk: sites.length - sitesBlocked.length, sitesChanging, words };
}

/**
 * Why the Publish now and Schedule buttons are grey (round 2 review: a rule tested by what it does,
 * not by the source text). Returns true when the button must stay grey.
 *   checking   sales (and, publishing now, which sites trade) still being read
 */
export function publishBlocked({ canEdit, busy, blocked, ready, checking }) {
  return !canEdit || !!busy || !!blocked || !ready || !!checking;
}
export function scheduleBlocked({ canEdit, busy, blocked, past, noteOk, ready, salesReading }) {
  return !canEdit || !!busy || !!blocked || !!past || !noteOk || !ready || !!salesReading;
}
/** The product and option group sheets' "Add to draft": grey until it can be added. */
export function sheetSaveBlocked({ saving, problems = false, words = '', changes = 0, create = false, ready, salesReading }) {
  return !!saving || !!problems || !!words || (!create && !changes) || !ready || !!salesReading;
}
