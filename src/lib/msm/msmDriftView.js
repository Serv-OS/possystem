// src/lib/msm/msmDriftView.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 3.3): changes made AT a site since the
// last publish, in Review and publish, each with Keep or Put back. Pure, tested
// (msmDriftView.test.js). msmDiff.siteDrift finds them (products, option groups and options, kept
// values respected); this file says them in plain words with the site's name, works out which of
// them THIS publish would overwrite, and makes the draft changes for the two buttons:
//   * "Keep Leeds's"           the site's value goes into the draft as that site's own (msmDiff
//                              keepVenueChanges), so publishing never overwrites it;
//   * "Put the group's back"   the draft touches that field at that site only, so the next publish
//                              writes the group menu's value there (and nowhere else);
//   * an option the group menu does not know: "Bring it into the group" (msmDiff.bringOptionIn) or
//     "Leave it as Leeds's own" (nothing to stage: the option is never touched by publish).
// Unsettled lines never block; the publish needs one tick per site whose changes it overwrites
// (msmRisk 'overwrites').

import { siteDrift, keepVenueChanges, bringOptionIn } from '../../../supabase/functions/_shared/msmDiff.js';
import { money2 } from '../../../supabase/functions/_shared/msmModel.js';
import { colWord, PRICE_TYPE_WORDS, TAX_TYPE_WORDS, CHOICE_WORDS, keptValueWords } from './msmWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const has = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

/** The stable key of a drift line at a site (for "settled" and React keys). */
export function driftKey(loc, d) {
  return [loc, d.kind || 'item', d.venueItemId || d.venueGroupId || '', d.optionId || (d.entry && d.entry.id) || '', d.column].join('|');
}

const show = (v, col = null) => {
  if (v == null) return 'nothing';
  if (typeof v === 'number') return money2(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? `${v.length} set` : 'none';
  if (typeof v === 'object') return 'its own setting';
  // A photo link, a VAT rate id, a kind code: in words (17 Oct verification).
  return col ? keptValueWords(col, v) : String(v);
};
const NAME_COLS = new Set(['name', 'menu_name', 'receipt_name', 'kitchen_name']);
const quote = (v) => (v == null || String(v).trim() === '' ? 'blank' : `"${String(v).trim().slice(0, 40)}"`);

/** One drift line in words, with the site's name: "Latte price 3.10 at Leeds (group menu says 3.00)". */
export function driftWords(d, siteName, names = {}) {
  const site = siteName || 'the site';
  const who = names[d.productId] || names[d.groupId] || 'A product';
  if (d.kind === 'unknown_option') {
    return `${names[d.groupId] || 'An option group'} at ${site} has an option the group menu does not know: ${d.entry?.name || 'an option'} ${money2(d.entry?.price ?? 0)}`;
  }
  if (d.kind === 'group') {
    const g = names[d.groupId] || 'An option group';
    if (d.column === 'option') {
      const b = d.venue || {}, a = d.group || {};
      if (money2(b.price) !== money2(a.price)) return `${g}: ${b.name || a.name || 'an option'} ${money2(b.price)} at ${site} (group menu says ${money2(a.price)})`;
      return `${g}: an option is called ${b.name || 'something else'} at ${site} (group menu says ${a.name || 'another name'})`;
    }
    if (d.column === '(option added)') return `${g}: ${d.group?.name || 'an option'} is not on at ${site} (group menu has it on)`;
    if (d.column === '(option off)') return `${g}: ${d.venue?.name || 'an option'} is on at ${site} (group menu has it off)`;
    if (d.column === 'selection_type') return `${g}: ${CHOICE_WORDS[d.venue] || 'another kind of choice'} at ${site} (group menu says ${CHOICE_WORDS[d.group] || 'another'})`;
    if (d.column === 'min' || d.column === 'max') return `${g}: ${colWord(d.column)} ${Number(d.venue ?? 0)} at ${site} (group menu says ${Number(d.group ?? 0)})`;
    return `${g}: ${colWord(d.column)} ${show(d.venue)} at ${site} (group menu says ${show(d.group)})`;
  }
  if (d.kept && String(d.column).startsWith('tax_overrides.')) {
    const k = d.column.slice(14);
    return `${who}: ${TAX_TYPE_WORDS[k] || 'order type'} VAT was changed again at ${site}; ${site} was keeping its own`;
  }
  if (d.kept) return `${who}: ${colWord(d.column)} was changed again at ${site}; ${site} was keeping ${show(d.group, d.column)}, now ${show(d.venue, d.column)}`;
  // A name: say both, so the person sees what the site calls it (17 Oct verification).
  if (NAME_COLS.has(d.column)) return `${who}: ${colWord(d.column)} is ${quote(d.venue)} at ${site} (group menu: ${quote(d.group)})`;
  if (d.column === 'archived') return d.venue === true ? `${who} is turned off at ${site} (group menu has it on)` : `${who} is turned on at ${site} (group menu has it off)`;
  if (String(d.column).startsWith('pricing.')) {
    const k = d.column.slice(8);
    const label = k === 'base' ? 'price' : `${(PRICE_TYPE_WORDS[k] || 'order type').toLowerCase()} price`;
    return `${who} ${label} ${show(d.venue)} at ${site} (group menu says ${show(d.group)})`;
  }
  if (String(d.column).startsWith('tax_overrides.')) {
    const k = d.column.slice(14);
    return `${who}: ${TAX_TYPE_WORDS[k] || 'order type'} VAT was changed at ${site}`;
  }
  return `${who}: ${colWord(d.column)} was changed at ${site}`;
}

/**
 * A site's drift that the draft has not already settled: against the published group menu (the
 * draft's own changes are never drift), less anything the draft already keeps as the site's own.
 */
export function openDrift(live, after, loc, raw, names = {}) {
  const stillOpen = new Set(siteDrift(after || live, loc, raw, names).map((d) => driftKey(loc, d)));
  return siteDrift(live, loc, raw, names).filter((d) => stillOpen.has(driftKey(loc, d)));
}

/**
 * Drift for every site a publish reaches, and which lines it would overwrite.
 *   live      the group menu as published (drift is the site against THIS: the draft's own changes
 *             are what the publish does, never drift)
 *   after     the group menu with the draft applied (a line the draft already keeps as the site's
 *             own is gone from it, so it is settled and not shown)
 *   preview   msmDiff.previewSet(...) (its plan per site says what this publish writes)
 *   venues    { loc: raw }
 *   opts      { siteNames, names, settled: Set(keys) }
 * Returns [{ location_id, name, lines: [{ key, d, words, overwritten, settled }], overwrite }] for
 * sites with any drift. overwrite = unsettled lines this publish would overwrite.
 */
export function publishDrift(live, after, preview, venues, opts = {}) {
  const out = [];
  const settled = opts.settled instanceof Set ? opts.settled : new Set();
  for (const s of listOf(preview?.sites)) {
    if (s.missing || !s.plan) continue;
    const raw = venues instanceof Map ? venues.get(s.location_id) : venues?.[s.location_id];
    if (!raw) continue;
    const lines = openDrift(live, after, s.location_id, raw, opts.names || {});
    if (!lines.length) continue;
    const written = new Set(listOf(s.plan.lines).map((l) => (l.table === 'groups' && l.optionId ? `g|${l.id}|${l.optionId}` : `${l.table === 'groups' ? 'g' : 'i'}|${l.id}|${l.column}`)));
    const name = opts.siteNames?.[s.location_id] || s.name || 'the site';
    const rows = lines.map((d) => {
      const key = driftKey(s.location_id, d);
      let overwritten = false;
      if (d.kind === 'group') overwritten = d.optionId ? written.has(`g|${d.venueGroupId}|${d.optionId}`) : written.has(`g|${d.venueGroupId}|${d.column}`);
      else if (d.kind !== 'unknown_option') overwritten = written.has(`i|${d.venueItemId}|${d.column}`);
      return { key, d, words: driftWords(d, name, opts.names || {}), overwritten, settled: settled.has(key) };
    });
    out.push({ location_id: s.location_id, name, lines: rows, overwrite: rows.filter((r) => r.overwritten && !r.settled).length });
  }
  return out;
}

/** { loc: count } of unsettled overwritten lines, for msmRisk's 'overwrites' tick. */
export function overwriteCounts(drift) {
  const m = {};
  for (const s of listOf(drift)) if (s.overwrite > 0) m[s.location_id] = s.overwrite;
  return m;
}

/** "Keep Leeds's": the draft changes that make the site's value its own. */
export function keepChanges(central, loc, d) {
  return keepVenueChanges(central, loc, [d]);
}

/**
 * "Put the group's back": the draft change that makes the next publish write the group menu's value
 * at this site only. The staged `before` holds the site's value (so the draft says "3.10 to the
 * group price"); the database logs the real before when it publishes.
 * Returns [change] or [] when there is nothing to touch.
 */
export function putBackChanges(central, loc, d) {
  if (!d || d.kind === 'unknown_option') return [];
  if (d.kind === 'group') {
    if (d.optionId) {
      const os = listOf(central?.optionSites).find((r) => r.option_id === d.optionId && r.location_id === loc);
      if (!os) return [];
      const base = { target: 'modifier_option_site', entity_id: d.optionId, location_id: loc, op: 'update' };
      if (d.column === '(option added)') return [{ ...base, after: { active: true }, before: { active: false } }];
      if (d.column === '(option off)') return [{ ...base, after: { active: false }, before: { active: true } }];
      if (d.column === 'option') {
        const out = [];
        if (money2(d.venue?.price) !== money2(d.group?.price)) out.push({ ...base, after: { price: os.price ?? null }, before: { price: Number(d.venue?.price ?? 0) } });
        if ((d.venue?.name || null) !== (d.group?.name || null)) {
          const kept = { ...(os.kept || {}) };
          delete kept.name;
          out.push({ ...base, after: { kept }, before: { kept: { ...kept, name: d.venue?.name ?? null } } });
        }
        if (out.length === 2) return [{ ...base, after: { ...out[0].after, ...out[1].after }, before: { ...out[0].before, ...out[1].before } }];
        return out;
      }
      return [];
    }
    const gs = listOf(central?.groupSites).find((r) => r.group_id === d.groupId && r.location_id === loc);
    if (!gs) return [];
    const kept = { ...(gs.kept || {}) };
    delete kept[d.column];
    return [{ target: 'modifier_group_site', entity_id: d.groupId, location_id: loc, op: 'update', after: { kept }, before: { kept: { ...kept, [d.column]: d.venue ?? null } } }];
  }
  const ps = listOf(central?.productSites).find((r) => r.product_id === d.productId && r.location_id === loc);
  if (!ps) return [];
  const base = { target: 'product_site', entity_id: d.productId, location_id: loc, op: 'update' };
  const col = String(d.column);
  if (col === 'archived') return [{ ...base, after: { active: ps.active !== false }, before: { active: d.venue !== true } }];
  if (col === 'pricing.base') return [{ ...base, after: { price: ps.price ?? null }, before: { price: d.venue ?? null } }];
  if (col.startsWith('pricing.')) {
    const k = col.slice(8);
    return [{ ...base, after: { channel_prices: ps.channel_prices ?? null }, before: { channel_prices: { ...(ps.channel_prices || {}), [k]: d.venue ?? null } } }];
  }
  const kept = { ...(ps.kept || {}) };
  if (col.startsWith('tax_overrides.')) {
    const k = col.slice(14);
    const t = { ...(kept.tax_overrides && typeof kept.tax_overrides === 'object' ? kept.tax_overrides : {}) };
    delete t[k];
    return [{ ...base, after: { kept: { ...kept, tax_overrides: t } }, before: { kept: { ...kept, tax_overrides: { ...t, [k]: d.venue === undefined ? false : d.venue } } } }];
  }
  // Any other column (a kept value changed again, or a managed column): "use the group's" here.
  if (has(kept, col)) delete kept[col];
  return [{ ...base, after: { kept }, before: { kept: { ...kept, [col]: d.venue ?? null } } }];
}

/** "Bring it into the group" for an option a site added (a new option id the screen makes). */
export function bringInOption(central, loc, d, optionId) {
  return bringOptionIn(central, loc, d, optionId);
}
