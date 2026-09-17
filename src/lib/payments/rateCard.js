/**
 * rateCard.js: the venue rate card editor's pure helpers, shared by the
 * Processing page and the go live flow (RateCardRows, 10 Sep 2026). No
 * network, no React.
 *
 * WHY (owner rule, 10 Sep 2026): "we set the rate that customers get charged
 * for the different card types". The payment types are priced with a
 * percent and pence each, stored as jsonb { tier: { percent, fixed_pence } }
 * on merchant_adyen_accounts.rate_card (venue) and
 * platform_settings.default_adyen_rate_card (platform default). The editor
 * keeps every field as a string ('' for empty) so inputs stay controlled,
 * and these helpers turn that state into the jsonb and back.
 *
 * CREDIT AND DEBIT APART (17 Sep 2026): six rows. card_present and
 * card_not_present keep their stored keys and their meaning (they are the
 * credit rows, and the price of every card until a debit rate is typed); the
 * two debit rows are new keys that, left blank, use the credit row above
 * them. So a card nobody has edited charges exactly what it charged before.
 * The server resolves the same way (_shared/adyen.ts resolveAdyenRateCard).
 */

// The six payment types, in the order every screen lists them. Plain words,
// no dashes. `base` names the credit row a blank debit row takes its rate from.
export const RATE_CARD_TIERS = Object.freeze([
  Object.freeze({ id: 'card_present', label: 'In person credit', note: 'credit cards at the till', base: null }),
  Object.freeze({ id: 'card_present_debit', label: 'In person debit', note: 'debit cards at the till', base: 'card_present' }),
  Object.freeze({ id: 'card_not_present', label: 'Online credit', note: 'credit cards, online orders', base: null }),
  Object.freeze({ id: 'card_not_present_debit', label: 'Online debit', note: 'debit cards, online orders', base: 'card_not_present' }),
  Object.freeze({ id: 'amex', label: 'Amex and business cards', note: null, base: null }),
  Object.freeze({ id: 'keyed', label: 'Keyed in', note: 'typed by hand', base: null }),
]);

// The two short lines every editor shows under the rows.
export const DEBIT_ROW_NOTES = Object.freeze([
  'A blank debit row uses the credit rate above it.',
  'Prepaid cards pay the debit rate.',
]);
// Shown in place of the debit inputs until the server can keep a debit rate.
export const DEBIT_NOT_READY_NOTE = 'Debit rates need a server update first. Until then debit uses the credit rate.';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v) => v === null || v === undefined || v === '';
const tierById = (id) => RATE_CARD_TIERS.find((t) => t.id === id) || null;

// Can the server keep a debit rate? payments-admin adyen_pricing names the
// tiers it knows (rate_tiers) from 17 Sep 2026. An older deploy names none
// and would DROP the two debit rows in silence on save, so the editor keeps
// them read only until this is true.
export const serverKnowsDebit = (answer) => Array.isArray(answer?.rate_tiers) && answer.rate_tiers.includes('card_present_debit') && answer.rate_tiers.includes('card_not_present_debit');

// The editor state with nothing typed.
export const emptyCard = () => Object.fromEntries(RATE_CARD_TIERS.map((t) => [t.id, { percent: '', fixed_pence: '' }]));

// jsonb rate card → editor state ('' for null so inputs stay controlled).
// Either spelling of the pence is read (fixed_pence on the row, fixedPence
// as the flow carries it).
export function cardToState(card) {
  const st = emptyCard();
  if (!isObj(card)) return st;
  for (const t of RATE_CARD_TIERS) {
    const row = card[t.id];
    if (!isObj(row)) continue;
    const fixed = row.fixed_pence ?? row.fixedPence;
    st[t.id] = {
      percent: empty(row.percent) ? '' : String(row.percent),
      fixed_pence: empty(fixed) ? '' : String(fixed),
    };
  }
  return st;
}

// editor state → jsonb rate card ('' → null; the server sanitizes again).
export function stateToCard(st) {
  const s = isObj(st) ? st : {};
  return Object.fromEntries(RATE_CARD_TIERS.map((t) => {
    const row = isObj(s[t.id]) ? s[t.id] : {};
    const pct = empty(row.percent) ? null : Number(row.percent);
    const fix = empty(row.fixed_pence) ? null : Math.round(Number(row.fixed_pence));
    return [t.id, {
      percent: Number.isFinite(pct) ? pct : null,
      fixed_pence: Number.isFinite(fix) ? fix : null,
    }];
  }));
}

// Two editor states say the same card.
export const cardsEqual = (a, b) => JSON.stringify(stateToCard(a)) === JSON.stringify(stateToCard(b));

// A rate for a read only line: "1.40% + 5p", "1.40% + 5c" for a US venue,
// "Not set" when there is nothing.
export function fmtRate(pct, pence, currency) {
  if (empty(pct) && empty(pence)) return 'Not set';
  const minor = String(currency ?? '').toUpperCase() === 'USD' ? 'c' : 'p';
  return `${Number(pct ?? 0).toFixed(2)}% + ${Math.round(Number(pence ?? 0))}${minor}`;
}

// Is any field of the editor state typed (a venue override rather than the
// platform default)?
export function cardHasOverride(st) {
  const s = isObj(st) ? st : {};
  return RATE_CARD_TIERS.some((t) => {
    const row = isObj(s[t.id]) ? s[t.id] : {};
    return !empty(row.percent) || !empty(row.fixed_pence);
  });
}

// ── WHAT APPLIES WHEN A FIELD IS BLANK ───────────────────────────────────────
// The same walk the server does, for ONE field of ONE row of the editor:
//   a credit, Amex or keyed row   the caller's fallback (platform default,
//                                 then the old flat rate for in person)
//   a debit row                   the credit row typed in THIS editor first
//                                 (same level), then the caller's fallback for
//                                 the debit row (the platform debit default),
//                                 then the caller's fallback for the credit row
// Answers { value, label, sameAs }: value null when nothing applies; sameAs is
// the credit row's label when the value came through the credit row, so the
// screen can say "same as In person credit".
//   state        editor state { tier: { percent, fixed_pence } } (strings)
//   fallbackFor  (tierId, field) => { value, label }
export function rowFallback(state, tierId, field, fallbackFor) {
  const fb = typeof fallbackFor === 'function' ? fallbackFor : () => ({ value: null, label: null });
  const ask = (id) => {
    const r = fb(id, field);
    const value = isObj(r) && !empty(r.value) && Number.isFinite(Number(r.value)) ? Number(r.value) : null;
    return { value, label: value === null ? null : (r.label ?? null) };
  };
  const tier = tierById(tierId);
  if (!tier?.base) return { ...ask(tierId), sameAs: null };
  const baseLabel = tierById(tier.base)?.label ?? null;
  const typedBase = isObj(state) && isObj(state[tier.base]) ? state[tier.base][field] : '';
  if (!empty(typedBase) && Number.isFinite(Number(typedBase))) return { value: Number(typedBase), label: 'set here', sameAs: baseLabel };
  const own = ask(tierId);
  if (own.value !== null) return { ...own, sameAs: null };
  const base = ask(tier.base);
  return base.value !== null ? { ...base, sameAs: baseLabel } : { value: null, label: null, sameAs: null };
}

// One row of the editor, worked out: what applies, where it comes from, and
// whether the row is only following its credit row.
//   { effPct, effFix, nothing, typed, source, placeholderPct, placeholderFix }
// source reads "set here", "platform default", "same as In person credit",
// "same as In person credit, platform default" and so on; null for nothing.
export function rowView(state, tierId, fallbackFor) {
  const s = isObj(state) ? state : {};
  const row = isObj(s[tierId]) ? s[tierId] : { percent: '', fixed_pence: '' };
  const fbPct = rowFallback(s, tierId, 'percent', fallbackFor);
  const fbFix = rowFallback(s, tierId, 'fixed_pence', fallbackFor);
  const typedPct = !empty(row.percent);
  const typedFix = !empty(row.fixed_pence);
  const effPct = typedPct ? Number(row.percent) : fbPct.value;
  const effFix = typedFix ? Math.round(Number(row.fixed_pence)) : (fbFix.value === null ? null : Math.round(fbFix.value));
  const typed = typedPct || typedFix;
  const nothing = effPct == null && effFix == null;
  let source = null;
  if (!nothing) {
    if (typed) source = 'set here';
    else {
      const from = fbPct.value !== null ? fbPct : fbFix;
      source = from.sameAs
        ? (from.label && from.label !== 'set here' ? `same as ${from.sameAs}, ${from.label}` : `same as ${from.sameAs}`)
        : from.label;
    }
  }
  return {
    effPct, effFix, nothing, typed, source,
    placeholderPct: fbPct.value === null ? 'none' : Number(fbPct.value).toFixed(2),
    placeholderFix: fbFix.value === null ? 'none' : String(Math.round(fbFix.value)),
  };
}

// ── READ ONLY SCREENS ────────────────────────────────────────────────────────
// The venue's own Card payments screen: the rows of "What you pay per card
// payment" from adyen-financial `settings` rate_card ({ tier: { percent,
// fixed_pence } | null }). Credit and debit share ONE row until the venue's
// debit rate differs from its credit rate (an older server sends no debit
// tier at all, which reads the same way), then each gets its own row.
export function venueRateRows(rateCard) {
  const card = isObj(rateCard) ? rateCard : {};
  const same = (a, b) => Math.round(Number(a?.percent ?? 0) * 100) === Math.round(Number(b?.percent ?? 0) * 100)
    && Math.round(Number(a?.fixed_pence ?? 0)) === Math.round(Number(b?.fixed_pence ?? 0));
  const pair = (baseId, debitId, together, credit, debit) => {
    const base = isObj(card[baseId]) ? card[baseId] : null;
    const deb = isObj(card[debitId]) ? card[debitId] : null;
    if (!deb || !base || same(base, deb)) return [{ id: baseId, label: together, rate: base }];
    return [{ id: baseId, label: credit, rate: base }, { id: debitId, label: debit, rate: deb }];
  };
  return [
    ...pair('card_present', 'card_present_debit', 'In person (credit and debit)', 'In person credit', 'In person debit'),
    ...pair('card_not_present', 'card_not_present_debit', 'Online (credit and debit)', 'Online credit', 'Online debit'),
    { id: 'amex', label: 'American Express and business cards', rate: isObj(card.amex) ? card.amex : null },
    { id: 'keyed', label: 'Keyed in by hand', rate: isObj(card.keyed) ? card.keyed : null },
  ];
}

// The revenue table keeps one column per channel: a debit category's count,
// volume and earnings are added into its credit column, and how many of them
// were debit rides along as debit_count for the tooltip. by_category is
// payments-admin `revenue` rows' { tier: { count, volume_minor,
// commission_minor, commission_known } }. Never mutates its input.
export function foldDebitCategories(byCategory) {
  const bc = isObj(byCategory) ? byCategory : {};
  const out = {};
  for (const [k, v] of Object.entries(bc)) out[k] = isObj(v) ? { ...v } : v;
  for (const t of RATE_CARD_TIERS) {
    if (!t.base || !isObj(bc[t.id])) continue;
    const d = bc[t.id];
    const b = isObj(out[t.base]) ? out[t.base] : { count: 0, volume_minor: 0, commission_minor: 0, commission_known: 0 };
    out[t.base] = {
      ...b,
      count: (Number(b.count) || 0) + (Number(d.count) || 0),
      volume_minor: (Number(b.volume_minor) || 0) + (Number(d.volume_minor) || 0),
      commission_minor: (Number(b.commission_minor) || 0) + (Number(d.commission_minor) || 0),
      commission_known: (Number(b.commission_known) || 0) + (Number(d.commission_known) || 0),
      debit_count: Number(d.count) || 0,
    };
    delete out[t.id];
  }
  return out;
}
