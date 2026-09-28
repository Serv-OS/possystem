// venueTaxRates.js: a venue's tax rates belong to that venue and nobody else.
//
// Peter, 27 Sep 2026: "for some reason every products tax rate has been removed
// but they where there earlier I have re applied Tax to all products but thats
// wrong please chase".
//
// What the chase found (27 Sep 2026):
//   1. No venue creation path seeded any rates. Train Station and Barnsley only
//      had them because someone pressed "Seed UK rates" in Tax settings; Leeds,
//      Preston, Headingly and Huddersfield had none until a fix by hand.
//   2. Every tax rate loader replaced the store only when its read returned rows,
//      so a venue with no rates kept whatever rates the page already held: Leeds
//      Back Office held Train Station's, pushed them to its tills, and the tills
//      booked Leeds VAT against Train Station's rate.
//   3. The bulk "apply to all" at Leeds offered those foreign rates, and wrote
//      Train Station's rate ids onto Leeds products.
//
// So: every rate in the store carries the venue it belongs to, and nothing
// offers, pushes or applies a rate tagged for another venue. A read with rows
// replaces the slice. A read that comes back EMPTY with no error is believed
// only when it was made with a session the database answers truthfully: a
// device's anonymous session, or a person's login that finished its second
// step (sessionTrustsEmpty). Then the venue really has no rates and the slice
// is emptied. Any other empty answer (no session at all: the tax_rates policy
// is auth.role() = 'authenticated'; or a password only login held back by the
// RESTRICTIVE second_step_fence) says nothing, so the store keeps this venue's
// rates, pushed ones included: a till with no rates books no VAT (review of
// v1, 27 Sep 2026: every till booted on an old push would otherwise have lost
// all its rates on such a read). A failed read keeps this venue's rates too.
// Another venue's rates are never kept. New UK venues get the standard rates
// at creation.
//
// Pure (no database, no store), so node:test proves the rules.

import { UK_DEFAULT_RATES } from './tax.js';

const same = (a, b) => a != null && b != null && String(a) === String(b);
const msgOf = (e) => (e && (e.message || e.details)) || (e ? String(e) : 'unknown error');

/** A tax_rates row (or an already mapped store rate) in the store shape, tagged with its venue. */
export function toStoreRate(row, locationId = null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    rate: parseFloat(row.rate),
    type: row.type,
    appliesTo: row.applies_to || row.appliesTo || ['all'],
    isDefault: row.is_default ?? row.isDefault ?? false,
    active: row.active ?? true,
    locationId: row.location_id ?? row.locationId ?? locationId ?? null,
  };
}

/** The rates tagged with this venue, checked or not. An untagged rate is not known to be this venue's. */
export function ownVenueRates(rates, locationId) {
  if (!locationId || !Array.isArray(rates)) return [];
  return rates.filter((r) => r && same(r.locationId, locationId));
}

/**
 * The rates known to be this venue's: tagged with it and not taken unchecked
 * from an old style push (`unverified`, see ratesFromSnapshot). These are what
 * screens offer, a push carries and an empty read keeps.
 */
export function verifiedVenueRates(rates, locationId) {
  return ownVenueRates(rates, locationId).filter((r) => !r.unverified);
}

/**
 * The store's rates after a read of `locationId`'s tax_rates.
 *
 * `res` is the supabase answer ({ data, error }), or null/undefined when the
 * read never happened or threw. `trusted` says the read was made with a
 * session whose empty answer is real (sessionTrustsEmpty).
 *   rows                  -> those rows, tagged (another venue's row in the answer is dropped)
 *   empty answer, trusted -> none: the venue really has no live rates
 *   empty answer, else    -> this venue's rates the store already held (pushed ones too)
 *   failed read           -> this venue's rates the store already held
 * Another venue's rates are never kept, whatever happens (27 Sep 2026: the old
 * `if (rows.length)` guard kept EVERYTHING on an empty read, which is how
 * Leeds, with no rates, held Train Station's).
 */
export function ratesAfterRead(res, locationId, held = [], { activeOnly = false, trusted = false } = {}) {
  if (res && !res.error && Array.isArray(res.data)) {
    const rows = res.data
      .filter((r) => r && (!activeOnly || r.active !== false))
      .filter((r) => r.location_id == null || same(r.location_id, locationId))
      .map((r) => toStoreRate(r, locationId));
    if (rows.length) return rows;
    return trusted ? [] : ownVenueRates(held, locationId);
  }
  return ownVenueRates(held, locationId);
}

/** The claims of a JWT access token, or null. No signature check: only used to judge what an empty answer means. */
export function jwtClaims(token) {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part || typeof atob !== 'function') return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Can an EMPTY answer read with this supabase-js session be believed?
 * (Review of the 27 Sep 2026 fix.) tax_rates, discounts and discount_rules
 * answer EMPTY, not an error, to a caller with no session (their policies are
 * auth.role() = 'authenticated') and to a person's password only (aal1) login
 * that the RESTRICTIVE second_step_fence holds back. Only two kinds of session
 * pass both, and the database's answer to them is the truth:
 *   * a device's anonymous session (every till, KDS, kiosk): is_anonymous
 *   * a person's login that finished its second step: aal2
 * An expired token is not trusted either: supabase-js may send the bare public
 * key when its refresh fails.
 */
export function sessionTrustsEmpty(session, now = Date.now()) {
  const token = session && session.access_token;
  if (!token) return false;
  const c = jwtClaims(token);
  if (!c) return false;
  if (c.role && c.role !== 'authenticated') return false;
  if (Number.isFinite(Number(c.exp)) && Number(c.exp) * 1000 <= now) return false;
  return c.is_anonymous === true || c.aal === 'aal2';
}

/**
 * sessionTrustsEmpty for the session a supabase-js client will send with its
 * next read. Asked BEFORE the read, so an empty answer is judged by the
 * session it was read with (a sign in landing mid read is the next read's).
 * Never throws: no answer is "not trusted", which only ever keeps rates.
 */
export async function clientTrustsEmpty(client, now = Date.now()) {
  try {
    const { data } = await client.auth.getSession();
    return sessionTrustsEmpty(data && data.session, now);
  } catch {
    return false;
  }
}

/** True when the read above was a real answer (an empty list then means "no rates visible here"). */
export function readSucceeded(res) {
  return !!(res && !res.error && Array.isArray(res.data));
}

/**
 * May this read replace a store slice (discount presets, auto discount rules)?
 * Rows: yes. An empty answer: only from a session whose empty answer is real
 * (sessionTrustsEmpty: a device, or a second step login), because these
 * policies answer EMPTY, not an error, to a caller with no session and to a
 * password only login held back by second_step_fence, and wiping a till's
 * discounts on that would be wrong. A failed read: never.
 */
export function readMayReplace(res, { trusted = false } = {}) {
  if (!readSucceeded(res)) return false;
  return res.data.length > 0 || !!trusted;
}

const rowVenue = (r) => (r ? (r.locationId ?? r.location_id ?? null) : null);

/**
 * The rows of a slice a Push to POS may carry: tagged with the push venue,
 * nothing else (27 Sep 2026). Leeds pushed Train Station's discount presets and
 * Provo's auto discount rules (another organisation) because the push copied
 * whatever the page held. An untagged row is not known to be this venue's, so
 * it is not pushed; the tills keep their own (an empty pushed list changes
 * nothing there).
 */
export function taggedVenueRows(rows, venue) {
  if (!venue || !Array.isArray(rows)) return [];
  return rows.filter((r) => r && same(rowVenue(r), venue));
}

/**
 * The rows of a slice (discount presets, auto discount rules) a till may take
 * from a pushed snapshot, with the same rule as ratesFromSnapshot: a push for
 * another venue gives nothing; a row tagged for another venue is dropped; a
 * row tagged for this venue is taken; an untagged row (a push from Back Office
 * code older than 27 Sep 2026) only when the snapshot is labelled for this
 * venue and the till holds none tagged as its own. Returns null when the
 * snapshot has no such list (nothing to apply).
 */
export function venueRowsFromSnapshot(rows, snap, venueId, held = []) {
  const venue = venueId || snap?.locationId || null;
  if (!Array.isArray(rows) || !rows.length || !venue) return null;
  if (snap?.locationId && !same(snap.locationId, venue)) return null;
  const holdsOwn = Array.isArray(held) && held.some((r) => r && same(rowVenue(r), venue));
  const untaggedOk = !!snap?.locationId && !holdsOwn;
  const out = rows.filter((r) => r && (rowVenue(r) != null ? same(rowVenue(r), venue) : untaggedOk));
  return out.length ? out : null;
}

/** The rates a Push to POS snapshot may carry: the push venue's own, checked rates, nothing else. */
export function ratesForSnapshot(rates, locationId) {
  return verifiedVenueRates(rates, locationId);
}

/**
 * The rates a till may take from a pushed snapshot.
 *
 * A snapshot pushed for another venue gives nothing. A rate tagged for another
 * venue is dropped. A rate tagged for this venue is taken. An untagged rate (a
 * push from Back Office code older than 27 Sep 2026) is taken only when the
 * snapshot itself says it is for this venue AND the till holds no checked rates
 * of its own (`held`, e.g. an offline boot from the cached push). It is tagged
 * for this venue but marked `unverified`: it is used to charge until the till's
 * own read answers, and it is never offered by a screen, re-pushed or kept over
 * an empty read. Every Leeds push from 26 Sep 06:47 was labelled Leeds and
 * carried Train Station's rates untagged; a till that already read its own
 * rates must never swap them for those, and nothing may push them on again.
 */
export function ratesFromSnapshot(snap, venueId, held = []) {
  const venue = venueId || snap?.locationId || null;
  if (!venue || !snap || !Array.isArray(snap.taxRates)) return [];
  if (snap.locationId && !same(snap.locationId, venue)) return [];
  const untaggedOk = !!snap.locationId && !holdsOwnRates(held, venue);
  return snap.taxRates
    .filter((r) => r && r.id && (r.locationId ? same(r.locationId, venue) : untaggedOk))
    .map((r) => (r.locationId ? { ...r, locationId: String(venue) } : { ...r, locationId: String(venue), unverified: true }));
}

/** Does the store hold checked rates of this venue? (TaxManager's empty-read safety check.) */
export function holdsOwnRates(held, locationId) {
  return verifiedVenueRates(held, locationId).length > 0;
}

/** The ids of this venue's live rates. */
export function ownRateIds(rates, locationId) {
  return new Set(ownVenueRates(rates, locationId).filter((r) => r.active !== false).map((r) => r.id));
}

/**
 * Products with no usable tax rate at this venue: no rate at all, or a rate id
 * that is not one of this venue's own live rates (the Leeds case: Train
 * Station's ids). Archived products and layout spacers are not sold, so they
 * are never listed. `foreign` holds the ids that are not this venue's at all;
 * `inactive` the ones on one of this venue's own rates that is switched off
 * (it charges nothing, so it counts as none, but it is not another venue's:
 * second review, 27 Sep 2026). `foreignOverride` lists products whose per
 * order type override names a rate that is not this venue's (the till ignores
 * such an override, lineTaxRefs); they are shown, but a bulk apply never
 * touches them, because their own rate may be right.
 */
export function productsWithoutOwnRate(items, rates, locationId) {
  const own = ownRateIds(rates, locationId);
  const mine = new Set(ownVenueRates(rates, locationId).map((r) => r.id));
  const missing = [];
  const foreign = [];
  const inactive = [];
  const foreignOverride = [];
  for (const i of items || []) {
    if (!i || i.archived || i.type === 'spacer') continue;
    const id = i.taxRateId ?? i.tax_rate_id ?? null;
    if (!id) missing.push(i);
    else if (!own.has(id)) (mine.has(id) ? inactive : foreign).push(i);
    const ov = i.taxOverrides ?? i.tax_overrides ?? null;
    if (ov && typeof ov === 'object' && Object.values(ov).some((v) => v && !own.has(v))) foreignOverride.push(i);
  }
  return { missing, foreign, inactive, all: [...missing, ...foreign, ...inactive], foreignOverride };
}

/**
 * The tax references a till line takes from its product (27 Sep 2026, review
 * of the Leeds fix): a rate id the till does not hold is another venue's (or a
 * deleted rate), and resolving it gives NO rate, so the line would book no VAT.
 * Such an id becomes null, which the tax engine resolves to this venue's
 * DEFAULT rate, the same on every till and every path; an override naming an
 * unknown id is dropped, so the line falls to the product's own rate. Only
 * when the till holds rates: with none loaded yet (boot), nothing is judged
 * and the ids pass through as they are. Channel lines never come here (their
 * '__not_in_menu__' opt out is built elsewhere and stays).
 * Returns { taxRateId, taxOverrides, dropped: [ids] }.
 */
export function lineTaxRefs(taxRateId, taxOverrides, rates) {
  // An inactive rate charges nothing (resolveTaxRate), so it is not a rate this till holds.
  // 28 Sep 2026 (release review): nor is an `unverified` one (taken unchecked from an old style
  // push that may carry another venue's rates). Until this venue's own read answers, nothing is
  // judged, the same as with no rates loaded yet.
  const list = Array.isArray(rates) ? rates.filter((r) => r && r.id != null && r.active !== false && !r.unverified) : [];
  const ov = taxOverrides && typeof taxOverrides === 'object' ? taxOverrides : {};
  if (!list.length) return { taxRateId: taxRateId || null, taxOverrides: ov, dropped: [] };
  const known = new Set(list.map((r) => String(r.id)));
  const dropped = [];
  let rateId = taxRateId || null;
  if (rateId && !known.has(String(rateId))) { dropped.push(rateId); rateId = null; }
  let outOv = ov;
  for (const [k, v] of Object.entries(ov)) {
    if (v && !known.has(String(v))) {
      if (outOv === ov) outOv = { ...ov };
      delete outOv[k];
      dropped.push(v);
    }
  }
  return { taxRateId: rateId, taxOverrides: outOv, dropped };
}

/**
 * The activity feed alert a till raises once a day when it has no tax rates,
 * or null when it must not (27 Sep 2026, review): only after a read whose
 * empty answer is real, never at a venue whose tax is set up as tax profiles
 * (a US venue is never seeded with rates on purpose), and worded for the
 * venue's currency.
 */
export function noTaxRatesAlert({ trusted = false, rateCount = 0, hasProfiles = false, currency = 'GBP' } = {}) {
  if (!trusted || rateCount > 0 || hasProfiles) return null;
  const uk = String(currency || 'GBP').toUpperCase() === 'GBP';
  return {
    title: 'This venue has no tax rates',
    body: uk
      ? 'Sales here are recording no VAT. In Back Office open Tax & VAT and press Seed UK rates, then Push to POS.'
      : 'Sales here are recording no sales tax. In Back Office open Tax & VAT and set up this venue\'s tax profiles (or Seed US rates), then Push to POS.',
  };
}

/**
 * The shared COPIES at a venue whose tax rate must come from their master:
 * live rows whose master is another row, holding no rate or a rate id that is
 * not one of this venue's own live rates. `rows` are menu_items rows (snake or
 * camel), `ownRateIds` this venue's live rate ids.
 */
export function copiesNeedingMasterRate(rows, ownRateIds) {
  const own = new Set((ownRateIds || []).map(String));
  return (rows || []).filter((r) => {
    if (!r || r.archived) return false;
    const master = r.master_id ?? r.masterId ?? null;
    if (!master || String(master) === String(r.id)) return false;
    const rate = r.tax_rate_id ?? r.taxRateId ?? null;
    return !rate || !own.has(String(rate));
  });
}

/**
 * The standard rates a new venue gets at creation, by its currency.
 * UK (GBP): Standard 20% (the default), Reduced 5%, Zero, exactly the rows the
 * Seed UK rates button wrote at Train Station and Barnsley. Anything else gets
 * none here: US venues set their tax up through tax profiles (a US rate is set
 * by state, county and city, so no single rate is right to guess).
 */
export function defaultSeedRatesFor(currency) {
  if (String(currency || '').toUpperCase() !== 'GBP') return null;
  return UK_DEFAULT_RATES.map((r) => ({ ...r, applies_to: [...r.applies_to] }));
}

/**
 * Give a venue its standard rates, once. Transport is injected so the Back
 * Office (supabase-js) and the admin portal (REST) share the same rules:
 *   readExisting(locationId) -> { data: rows, error }
 *   insertRows(rows)         -> { data: inserted rows, error }
 * Never seeds on top of existing rates, never seeds when it could not check,
 * and inserts all rows in ONE statement so a venue can never be half seeded.
 */
export async function seedVenueTaxRates({ locationId, currency, readExisting, insertRows }) {
  if (!locationId) return { ok: false, added: 0, error: 'no venue id' };
  const defaults = defaultSeedRatesFor(currency);
  if (!defaults) return { ok: true, added: 0, skipped: 'not-uk' };
  let existing;
  try { existing = await readExisting(locationId); } catch (e) { existing = { data: null, error: e }; }
  if (!readSucceeded(existing)) {
    return { ok: false, added: 0, error: `could not check the venue's tax rates (${msgOf(existing?.error)}), none were added` };
  }
  if (existing.data.length) return { ok: true, added: 0, skipped: 'has-rates' };
  const rows = defaults.map((r) => ({ ...r, location_id: locationId }));
  let res;
  try { res = await insertRows(rows); } catch (e) { res = { data: null, error: e }; }
  if (res?.error) return { ok: false, added: 0, error: msgOf(res.error) };
  const added = Array.isArray(res?.data) ? res.data.length : 0;
  if (added !== rows.length) return { ok: false, added, error: `only ${added} of ${rows.length} rates came back saved` };
  return { ok: true, added, rows: res.data };
}

/** Words for the operator after a seed, or null when there is nothing to say. */
export function seedWords(result, venueName = 'the new venue') {
  if (!result) return null;
  if (result.ok && result.added) return `${result.added} UK tax rates added to ${venueName} (Standard 20% is the default).`;
  if (result.ok) return null;
  return `Tax rates were NOT added to ${venueName}: ${result.error}. Open Back Office, Tax, and press Seed UK rates before taking payments.`;
}
