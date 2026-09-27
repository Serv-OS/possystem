// bulkTax.js: give every product without a tax rate one, and say exactly what saved.
//
// Peter, 27 Sep 2026: "I have re applied Tax to all products but thats wrong
// please chase". The old "Apply to all" strip fired one unawaited save per
// product and showed "Standard Rate set on 432 items" before any of them had
// saved. It offered whatever rates the page held (at Leeds: Train Station's),
// and it wrote the chosen rate onto shared COPIES too, whose tax is not the
// venue's to choose.
//
// The rules here:
//   * Only this venue's own rates are offered (lib/venueTaxRates.js).
//   * A size takes its product's rate: sizes of one product share a rate
//     (store.updateMenuItem CASCADE_FIELDS), so a size is never given a
//     different one from its product. The other way round too: a product with
//     no rate whose sizes all carry the same one of this venue's rates takes
//     THAT rate, never the picked one (the sizes are what the till charges).
//   * A shared or global COPY takes its tax from its master at the owning
//     venue. tax_rate_id is not a field a venue may override
//     (lib/shareCopy.js SHARED_OVERRIDABLE is pricing, category, image), and
//     every edit of the master rewrites it (propagatedFields), so a rate
//     chosen here would silently change back. The copy gets the master's rate
//     mapped to this venue by name (what the next master edit would write
//     anyway); when the master has none, the copy is left and the owning venue
//     is named, so the tax is set once, where it belongs.
//   * Every save is awaited and counted; the words say how many saved, how
//     many did not and why. Never "done" for a row that did not save.
//   * A stale tab never replaces a rate set somewhere else. The products are
//     read fresh before planning (store loadVenueMenu), and each write goes
//     through the compare and set writer every Back Office edit uses
//     (lib/menuWriters.js, 27 Sep 2026): only the tax column, checked against
//     the value the plan started from. A row given another rate in between is
//     refused as changed elsewhere, left as it is and named: neither saved nor
//     failed (bulkTaxOutcome).
//
// Pure orchestration: saves and lookups are injected, so node:test can prove it.

import { productsWithoutOwnRate } from './venueTaxRates.js';
import { isMasterRow, fieldOf } from './shareCopy.js';
import { writeRowChecked, writeWithin } from './menuRowWrite.js';

const msgOf = (e) => (e && (e.message || e.details)) || (e ? String(e) : 'unknown error');
const nameOf = (i) => (i && (i.menuName || i.menu_name || i.name)) || 'Item';
const rateOf = (i) => (i ? (i.taxRateId ?? i.tax_rate_id ?? null) : null) || null;
const same = (a, b) => String(a ?? '') === String(b ?? '');

/** True for a row that is another venue's product copied here (its tax follows the master). */
export function isSharedCopy(item) {
  return !!item && !isMasterRow(item);
}

/**
 * How many products the fresh read showed with a different tax rate from the
 * copy this page held before it (27 Sep 2026): `before` and `after` are the
 * store's products either side of the read. Only rows on both sides count.
 */
export function taxRefreshed(before, after) {
  const was = new Map((Array.isArray(before) ? before : []).filter((i) => i && i.id != null).map((i) => [String(i.id), rateOf(i)]));
  let n = 0;
  for (const i of Array.isArray(after) ? after : []) {
    if (!i || i.id == null || !was.has(String(i.id))) continue;
    if (!same(was.get(String(i.id)), rateOf(i))) n += 1;
  }
  return n;
}

/**
 * What a bulk apply will do.
 *
 * @param {object}   p
 * @param {Array}    p.items         this venue's menu items (store shape)
 * @param {Array}    p.rates         the store's tax rates (tagged with their venue)
 * @param {string}   p.locationId    this venue
 * @param {string}   p.chosenRateId  the rate picked on screen (must be one of this venue's own)
 * @param {Map}      p.copyRates     copy id -> { taxRateId, reason, ownerName } from the master lookup
 * Each assignment carries `expect`: the rate the row held when planned (the
 * write only lands if the database still holds it), and a size carries its
 * `parentId`.
 * @returns {{ assign: Array<{id, taxRateId, via, item, expect, parentId?}>, skipped: Array<{item, reason, ownerName}>, targets: Array, ownRateIds: Array }}
 */
export function planBulkTax({ items, rates, locationId, chosenRateId, copyRates = new Map() }) {
  const { all: targets } = productsWithoutOwnRate(items, rates, locationId);
  const own = new Set((rates || []).filter((r) => r && String(r.locationId) === String(locationId) && r.active !== false).map((r) => r.id));
  if (!chosenRateId || !own.has(chosenRateId)) {
    return { assign: [], skipped: targets.map((item) => ({ item, reason: 'pick one of this venue\'s own rates' })), targets, ownRateIds: [...own] };
  }
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const targetIds = new Set(targets.map((i) => i.id));
  const assign = [];
  const skipped = [];
  const planned = new Map();   // id -> rate this run gives it

  // The rate a product (top level, not a copy) ends up with after this run.
  const productRate = (p) => {
    if (!p) return null;
    if (planned.has(p.id)) return planned.get(p.id);
    const cur = p.taxRateId ?? p.tax_rate_id ?? null;
    if (cur && own.has(cur) && !targetIds.has(p.id)) return cur;
    return null;
  };

  // The one rate all of a product's live sizes already carry (this venue's own), else null.
  const sizesRate = (p) => {
    const sizes = (items || []).filter((i) => i && !i.archived && String(fieldOf(i, 'parent_id') ?? '') === String(p.id));
    if (!sizes.length) return null;
    const ids = new Set(sizes.map((s) => s.taxRateId ?? s.tax_rate_id ?? null));
    const [only] = [...ids];
    return ids.size === 1 && only && own.has(only) ? only : null;
  };

  // Products first, then sizes, so a size can follow the rate its product is given.
  const ordered = [...targets].sort((a, b) => (fieldOf(a, 'parent_id') ? 1 : 0) - (fieldOf(b, 'parent_id') ? 1 : 0));
  for (const item of ordered) {
    if (isSharedCopy(item)) {
      const m = copyRates.get(item.id);
      if (m && m.taxRateId && own.has(m.taxRateId)) {
        assign.push({ id: item.id, taxRateId: m.taxRateId, via: 'master', item, expect: rateOf(item) });
        planned.set(item.id, m.taxRateId);
      } else {
        skipped.push({ item, reason: m?.reason || 'master not found', ownerName: m?.ownerName || null });
      }
      continue;
    }
    const parentId = fieldOf(item, 'parent_id');
    if (parentId) {
      const parent = byId.get(parentId);
      const fromParent = parent && !isSharedCopy(parent) ? productRate(parent) : null;
      if (fromParent) {
        assign.push({ id: item.id, taxRateId: fromParent, via: 'product', item, expect: rateOf(item), parentId });
        planned.set(item.id, fromParent);
        continue;
      }
    } else {
      const fromSizes = sizesRate(item);
      if (fromSizes) {
        assign.push({ id: item.id, taxRateId: fromSizes, via: 'sizes', item, expect: rateOf(item) });
        planned.set(item.id, fromSizes);
        continue;
      }
    }
    assign.push({ id: item.id, taxRateId: chosenRateId, via: 'chosen', item, expect: rateOf(item) });
    planned.set(item.id, chosenRateId);
  }
  return { assign, skipped, targets, ownRateIds: [...own] };
}

/**
 * One tax write's result from the compare and set writer (lib/menuWriters.js
 * items.edit, lib/menuRowWrite.js writeRowChecked) in the words runBulkTax
 * counts (27 Sep 2026):
 *   applied, merged, already, noop  -> {} saved (already: the database held it)
 *   conflict                        -> { changedElsewhere, current }: given another
 *                                      rate somewhere else since this page read it
 *   gone, dropped, error, anything  -> { error }: NOT saved, with the reason
 */
export function bulkTaxOutcome(result) {
  const o = result?.outcome;
  if (['applied', 'merged', 'already', 'noop'].includes(o) && result?.ok !== false) return {};
  if (o === 'conflict') {
    const fresh = result.fresh || null;
    return { changedElsewhere: true, current: fresh ? (fresh.tax_rate_id ?? fresh.taxRateId ?? null) : null };
  }
  if (o === 'gone') return { error: result.error || new Error('not at this venue any more') };
  if (o === 'dropped') return { error: new Error('not saved: an earlier change to it was refused') };
  return { error: result?.error || new Error(o ? `not saved (${o})` : 'not saved') };
}

/**
 * The save runBulkTax calls for one assignment (27 Sep 2026): the tax column only, through the
 * compare and set writer every Back Office edit uses, checked against the rate the plan started
 * from (`expect`, the base of the compare), never a whole row. Used by store applyBulkTaxRates.
 *   getRow(id)                           this page's copy of the row now
 *   edit(id, patch, prev, next, opened)  the writer (store: menuWriters.items.edit, quiet, with
 *                                        opened as opts.opened)
 *   onSaved(a, result)                   after a save landed (the store shows it; a master propagates)
 * `opened` is the row as the PLAN saw it (a.item): the compare and set token and the base both
 * come from it (27 Sep 2026). This page's row can be newer than the plan (a realtime update or
 * a reload landed while Apply to all ran); its token then matched the database, the write went
 * straight through, and a rate set somewhere else after the plan was replaced and counted as
 * saved. Checked against the plan's row, that rate is reported as changed elsewhere and left.
 * Resolves what bulkTaxOutcome says.
 */
export function bulkTaxSaver({ getRow, edit, onSaved = null }) {
  return async (a) => {
    const row = getRow ? getRow(a.id) : null;
    if (!row) return { error: new Error('not on this screen any more') };
    const was = a.expect ?? null;
    const prev = { ...row, taxRateId: was, tax_rate_id: was };
    const next = { ...row, taxRateId: a.taxRateId, tax_rate_id: a.taxRateId };
    const r = await edit(a.id, { taxRateId: a.taxRateId }, prev, next, a.item);
    const out = bulkTaxOutcome(r);
    if (!out.error && !out.changedElsewhere && onSaved) {
      try { onSaved(a, r); } catch (e) { console.warn('[bulkTax] after a save:', e?.message || e); }
    }
    return out;
  };
}

/**
 * Save every assignment, a few at a time, and count. `save(a)` returns
 * { error } or throws (failed), { changedElsewhere, current } (the row was
 * given another rate since the plan: left as it is, `changed`), anything else
 * counts as saved. A row found already holding the planned rate counts as
 * saved. `shouldStop()` ends the run after the saves in flight.
 *
 * Products first, then sizes: a size follows its product (via 'product'), so
 * when its product turns out to have been changed elsewhere, the size takes the
 * product's rate as the database now holds it when that is one of this venue's
 * own live rates (`ownRateIds`), and is otherwise left as it is and named. A
 * size never takes the picked rate over a rate its product was given somewhere else.
 */
export async function runBulkTax({ assign, save, concurrency = 6, onProgress, shouldStop, ownRateIds = [] }) {
  const ok = [];
  const failed = [];
  const changed = [];
  const list = Array.isArray(assign) ? assign : [];
  let done = 0;
  let stopped = false;
  const tick = () => { done += 1; if (onProgress) onProgress({ done, total: list.length }); };
  const runPhase = async (items) => {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        if (shouldStop && shouldStop()) { stopped = true; return; }
        const a = items[next++];
        try {
          const r = await save(a);
          if (r && r.error) failed.push({ ...a, error: msgOf(r.error) });
          else if (r && r.changedElsewhere) {
            if (same(r.current, a.taxRateId)) ok.push({ ...a, already: true });
            else changed.push({ ...a, current: r.current ?? null, why: 'changed' });
          } else ok.push(a);
        } catch (e) {
          failed.push({ ...a, error: msgOf(e) });
        }
        tick();
      }
    };
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, worker));
  };
  const sizes = list.filter((a) => a && a.via === 'product');
  await runPhase(list.filter((a) => a && a.via !== 'product'));
  if (!stopped && sizes.length) {
    const own = new Set([...(ownRateIds || [])].map(String));
    const movedOn = new Map(changed.map((c) => [String(c.id), c.current]));
    const ready = [];
    for (const a of sizes) {
      const key = a.parentId != null ? String(a.parentId) : null;
      if (key == null || !movedOn.has(key)) { ready.push(a); continue; }
      const now = movedOn.get(key);
      if (now && own.has(String(now))) ready.push({ ...a, taxRateId: now });
      else { changed.push({ ...a, current: a.expect ?? null, why: 'product' }); tick(); }
    }
    await runPhase(ready);
  }
  const notTried = list.length - ok.length - failed.length - changed.length;
  return { ok, failed, changed, total: list.length, notTried, stopped };
}

/**
 * The toast: how many saved, how many did not and why, which were changed
 * elsewhere and left, and which copies are the owner's to set. `rates` (this
 * venue's own) names the rate a changed row now holds; `refreshed` is how many products the fresh read
 * showed with a different rate from this page's copy.
 */
export function bulkTaxWords({ result, skipped = [], rateName = 'Tax rate', rates = [], refreshed = 0 }) {
  const parts = [];
  const total = result?.total ?? 0;
  const saved = result?.ok?.length ?? 0;
  const failed = result?.failed || [];
  const changed = result?.changed || [];
  if (total) {
    parts.push(saved < total
      ? `${rateName}: saved on ${saved} of ${total} products.`
      : `${rateName} saved on all ${saved} product${saved === 1 ? '' : 's'}.`);
  }
  if (failed.length) {
    const eg = failed.slice(0, 3).map((f) => `${nameOf(f.item)} (${f.error})`).join('; ');
    parts.push(`${failed.length} NOT saved: ${eg}${failed.length > 3 ? '…' : ''}. Try again.`);
  }
  if (changed.length) {
    const label = (id) => (id ? ((rates || []).find((r) => r && same(r.id, id))?.name || 'a rate not of this venue') : 'no rate');
    const eg = changed.slice(0, 3).map((c) => (c.why === 'product'
      ? `${nameOf(c.item)} (its product was changed)`
      : `${nameOf(c.item)} (now ${label(c.current)})`)).join('; ');
    parts.push(`${changed.length} changed somewhere else since this page loaded, left as ${changed.length === 1 ? 'it is' : 'they are'}: ${eg}${changed.length > 3 ? '…' : ''}.`);
  }
  if (result?.notTried) parts.push(`${result.notTried} not tried (stopped).`);
  if (skipped.length) {
    const owners = [...new Set(skipped.map((s) => s.ownerName).filter(Boolean))];
    const where = owners.length ? ` at ${owners.slice(0, 3).join(', ')}` : ' at the venue that owns them';
    parts.push(`${skipped.length} shared product${skipped.length === 1 ? ' takes its' : 's take their'} tax from the master${where}: set it there and it follows here.`);
  }
  if (refreshed) {
    parts.push(`${refreshed} product${refreshed === 1 ? ' had' : 's had'} a different rate saved than this page showed (changed somewhere else); this page now shows the saved one.`);
  }
  return parts.join(' ') || 'Nothing needed a tax rate.';
}

/**
 * Give shared COPIES at a venue their master's tax rate (27 Sep 2026, when the
 * venue gains rates: lib/db.js mapCopiesTaxFromMasters). A copy made while the
 * venue had no rates arrived with none, and nothing mapped it again when the
 * rates were added (Leeds, Preston, Headingly, Huddersfield).
 *
 * Each copy is written through the compare and set writer every Back Office
 * edit uses (lib/menuRowWrite.js writeRowChecked): ONLY tax_rate_id, on the
 * updated_at it was read with, checked against the rate it held then. A copy
 * given a rate in between is left as it is (`changed`), never replaced.
 *   copies    menu_items rows (snake case: id, updated_at, tax_rate_id, name)
 *   answers   Map(copy id -> { taxRateId, reason, ownerName }) (db.masterTaxRatesForCopies)
 *   write     writeRowChecked (injected by the tests)
 * Resolves { ok, mapped: [{ id, taxRateId, row }], unmapped: [{ id, name, reason, ownerName }],
 *   changed: [{ id, name, current }], failed: [{ id, name, error }] }.
 */
export async function saveCopyTaxRates({ client, locationId, copies, answers, write = writeRowChecked, concurrency = 6, timeoutMs } = {}) {
  const mapped = []; const unmapped = []; const changed = []; const failed = [];
  const list = Array.isArray(copies) ? copies : [];
  const todo = [];
  for (const c of list) {
    if (!c || c.id == null) continue;
    const name = nameOf(c);
    const a = answers && typeof answers.get === 'function' ? answers.get(c.id) : null;
    if (!a || !a.taxRateId) { unmapped.push({ id: c.id, name, reason: a?.reason || 'no answer', ownerName: a?.ownerName || null }); continue; }
    todo.push({ c, name, taxRateId: a.taxRateId });
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { c, name, taxRateId } = todo[next++];
      const prior = c.tax_rate_id ?? c.taxRateId ?? null;
      const r = await writeWithin(write({
        client, table: 'menu_items', id: c.id, locationId,
        srvAt: c.updated_at ?? c.srvAt ?? null,
        cols: { tax_rate_id: taxRateId },
        base: { tax_rate_id: prior },
        freshCols: (db) => ({ tax_rate_id: db?.tax_rate_id ?? null }),
      }), `saving the tax rate of ${name}`, ...(timeoutMs ? [timeoutMs] : []));
      const o = r?.outcome;
      if (r?.ok && ['applied', 'merged', 'already', 'noop'].includes(o)) mapped.push({ id: c.id, taxRateId, row: r.row || null });
      else if (o === 'conflict') changed.push({ id: c.id, name, current: r.fresh?.tax_rate_id ?? null });
      else if (o === 'gone') changed.push({ id: c.id, name, current: null, gone: true });
      else failed.push({ id: c.id, name, error: msgOf(r?.error) });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length || 1)) }, worker));
  return { ok: failed.length === 0, mapped, unmapped, changed, failed };
}
