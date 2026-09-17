/**
 * rateCard.test.js: the rate card editor's pure helpers (RateCardRows).
 * Run: `node --test src/lib/payments/rateCard.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_CARD_TIERS, DEBIT_ROW_NOTES, DEBIT_NOT_READY_NOTE, emptyCard, cardToState, stateToCard, cardsEqual, fmtRate, cardHasOverride,
  serverKnowsDebit, rowFallback, rowView, venueRateRows, foldDebitCategories,
} from './rateCard.js';
import { RATE_CARD_TIER_ORDER, RATE_ROW_LABELS, DEBIT_TIER_BASE } from './adyenLink.js';

const BLANK = { percent: '', fixed_pence: '' };

test('RATE_CARD_TIERS: the six payment types in order, plain words, no dashes, the same words as every sentence', () => {
  assert.deepEqual(RATE_CARD_TIERS.map((t) => t.id), ['card_present', 'card_present_debit', 'card_not_present', 'card_not_present_debit', 'amex', 'keyed']);
  assert.deepEqual(RATE_CARD_TIERS.map((t) => t.label), ['In person credit', 'In person debit', 'Online credit', 'Online debit', 'Amex and business cards', 'Keyed in']);
  // one list of rows and one set of words across the editor, the table and the server sentences
  assert.deepEqual(RATE_CARD_TIERS.map((t) => t.id), [...RATE_CARD_TIER_ORDER]);
  for (const t of RATE_CARD_TIERS) assert.equal(t.label, RATE_ROW_LABELS[t.id]);
  // a debit row names the credit row it follows when blank, and nothing else does
  assert.deepEqual(Object.fromEntries(RATE_CARD_TIERS.filter((t) => t.base).map((t) => [t.id, t.base])), { ...DEBIT_TIER_BASE });
  for (const t of RATE_CARD_TIERS) {
    assert.doesNotMatch(t.label, /[-–—]/, t.label);
    if (t.note) assert.doesNotMatch(t.note, /[-–—]/, t.note);
  }
  for (const l of [...DEBIT_ROW_NOTES, DEBIT_NOT_READY_NOTE]) { assert.doesNotMatch(l, /[-–—]|commission/i, l); assert.ok(l.length < 120, l); }
  assert.ok(Object.isFrozen(RATE_CARD_TIERS));
});

test('emptyCard and cardToState: strings for every field, either spelling of the pence', () => {
  assert.deepEqual(emptyCard(), {
    card_present: BLANK, card_present_debit: BLANK, card_not_present: BLANK, card_not_present_debit: BLANK, amex: BLANK, keyed: BLANK,
  });
  const st = cardToState({ card_present: { percent: 1.4, fixed_pence: 5 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: null, fixed_pence: null } });
  assert.deepEqual(st.card_present, { percent: '1.4', fixed_pence: '5' });
  assert.deepEqual(st.amex, { percent: '2.5', fixed_pence: '10' });
  assert.deepEqual(st.keyed, BLANK);
  assert.deepEqual(st.card_not_present, BLANK);
  // A CARD STORED BEFORE DEBIT PRICING holds no debit key: both debit rows open blank
  assert.deepEqual(st.card_present_debit, BLANK);
  assert.deepEqual(st.card_not_present_debit, BLANK);
  assert.deepEqual(cardToState({ card_present_debit: { percent: 0.9, fixed_pence: 3 } }).card_present_debit, { percent: '0.9', fixed_pence: '3' });
  // 0 is a price, kept as '0'
  assert.deepEqual(cardToState({ amex: { percent: 0, fixed_pence: 0 } }).amex, { percent: '0', fixed_pence: '0' });
  // junk never throws
  assert.deepEqual(cardToState(null), emptyCard());
  assert.deepEqual(cardToState({ amex: 'x', other: { percent: 1 } }), emptyCard());
});

test('stateToCard: numbers, whole pence, null for empty, and the round trip', () => {
  const card = stateToCard({ card_present: { percent: '1.4', fixed_pence: '5' }, amex: { percent: '0', fixed_pence: '4.6' }, keyed: { percent: '', fixed_pence: '' } });
  const none = { percent: null, fixed_pence: null };
  assert.deepEqual(card, {
    card_present: { percent: 1.4, fixed_pence: 5 },
    card_present_debit: none,
    card_not_present: none,
    card_not_present_debit: none,
    amex: { percent: 0, fixed_pence: 5 },
    keyed: none,
  });
  assert.deepEqual(cardToState(card).card_present, { percent: '1.4', fixed_pence: '5' });
  // OPENING AND SAVING WITHOUT TYPING changes nothing: an old four key card and the six key card it saves as are the same card
  const old = { card_present: { percent: 1.4, fixed_pence: 5 }, card_not_present: { percent: 1.9, fixed_pence: 10 }, amex: { percent: 2.5, fixed_pence: 10 }, keyed: { percent: 2.9, fixed_pence: 15 } };
  assert.equal(cardsEqual(cardToState(old), cardToState(stateToCard(cardToState(old)))), true);
  assert.deepEqual(stateToCard(cardToState(old)).card_present_debit, none);
  // a typo is null, never NaN in the jsonb
  assert.deepEqual(stateToCard({ amex: { percent: 'x', fixed_pence: 'y' } }).amex, none);
  assert.deepEqual(stateToCard(null).keyed, none);
});

test('cardsEqual and cardHasOverride: the same card two ways, and whether anything is typed', () => {
  assert.equal(cardsEqual({ amex: { percent: '1', fixed_pence: '' } }, { amex: { percent: '1.0', fixed_pence: '' } }), true);
  assert.equal(cardsEqual({ amex: { percent: '1', fixed_pence: '' } }, { amex: { percent: '1', fixed_pence: '5' } }), false);
  assert.equal(cardsEqual(emptyCard(), null), true);
  assert.equal(cardsEqual({ card_present_debit: { percent: '0.9', fixed_pence: '' } }, emptyCard()), false);
  assert.equal(cardHasOverride(emptyCard()), false);
  assert.equal(cardHasOverride({ keyed: { percent: '', fixed_pence: '15' } }), true);
  assert.equal(cardHasOverride({ keyed: { percent: '0', fixed_pence: '' } }), true);
  assert.equal(cardHasOverride({ card_not_present_debit: { percent: '1.1', fixed_pence: '' } }), true);
  assert.equal(cardHasOverride(null), false);
});

test('fmtRate: two decimals, pence or cents, Not set for nothing', () => {
  assert.equal(fmtRate(1.4, 5), '1.40% + 5p');
  assert.equal(fmtRate(1.4, 5, 'USD'), '1.40% + 5c');
  assert.equal(fmtRate(null, 5), '0.00% + 5p');
  assert.equal(fmtRate(1, null), '1.00% + 0p');
  assert.equal(fmtRate(0, 0), '0.00% + 0p');
  assert.equal(fmtRate(null, null), 'Not set');
  assert.equal(fmtRate('', ''), 'Not set');
});

test('serverKnowsDebit: the debit rows stay read only until the server names them', () => {
  assert.equal(serverKnowsDebit({ rate_tiers: ['card_present', 'card_present_debit', 'card_not_present', 'card_not_present_debit', 'amex', 'keyed'] }), true);
  // a deploy from before debit pricing names no tiers at all
  assert.equal(serverKnowsDebit({ ok: true, defaults: {}, rate_card_ready: true }), false);
  assert.equal(serverKnowsDebit({ rate_tiers: ['card_present', 'card_not_present', 'amex', 'keyed'] }), false);
  assert.equal(serverKnowsDebit({ rate_tiers: ['card_present_debit'] }), false);
  assert.equal(serverKnowsDebit(null), false);
  assert.equal(serverKnowsDebit({ error: 'nope' }), false);
});

// The venue editor's fallback, as Processing and the go live flow build it:
// the platform default card, then the old flat rate for in person only.
const venueFallback = (defaults, account = {}) => (tierId, field) => {
  const defVal = defaults.rate_card?.[tierId]?.[field];
  if (defVal !== null && defVal !== undefined) return { value: Number(defVal), label: 'platform default' };
  if (tierId === 'card_present') {
    const lv = field === 'percent' ? account.markup_percent : account.markup_fixed_pence;
    if (lv !== null && lv !== undefined) return { value: Number(lv), label: 'old venue rate' };
    const ld = field === 'percent' ? defaults.default_markup_percent : defaults.default_markup_fixed_pence;
    if (ld !== null && ld !== undefined) return { value: Number(ld), label: 'old platform rate' };
  }
  return { value: null, label: null };
};

test('rowFallback: a blank debit field walks the credit row at the SAME level first, as the server does', () => {
  const defaults = { rate_card: { card_present: { percent: 1.2, fixed_pence: 4 }, card_present_debit: { percent: 0.5, fixed_pence: 1 }, card_not_present: { percent: 1.7, fixed_pence: 9 } } };
  const fb = venueFallback(defaults);
  // the venue typed its own in person credit rate: debit follows THAT, not the platform debit default
  const typed = { ...emptyCard(), card_present: { percent: '1.4', fixed_pence: '5' } };
  assert.deepEqual(rowFallback(typed, 'card_present_debit', 'percent', fb), { value: 1.4, label: 'set here', sameAs: 'In person credit' });
  assert.deepEqual(rowFallback(typed, 'card_present_debit', 'fixed_pence', fb), { value: 5, label: 'set here', sameAs: 'In person credit' });
  // nothing typed on the venue: the platform debit default, then the platform credit default
  assert.deepEqual(rowFallback(emptyCard(), 'card_present_debit', 'percent', fb), { value: 0.5, label: 'platform default', sameAs: null });
  assert.deepEqual(rowFallback(emptyCard(), 'card_not_present_debit', 'percent', fb), { value: 1.7, label: 'platform default', sameAs: 'Online credit' });
  // a credit row is the caller's fallback, untouched
  assert.deepEqual(rowFallback(typed, 'card_not_present', 'percent', fb), { value: 1.7, label: 'platform default', sameAs: null });
  assert.deepEqual(rowFallback(typed, 'amex', 'percent', fb), { value: null, label: null, sameAs: null });
  // the old flat rate still means in person, and in person debit through it, never online
  const legacy = venueFallback({}, { markup_percent: 0.8, markup_fixed_pence: 5 });
  assert.deepEqual(rowFallback(emptyCard(), 'card_present', 'percent', legacy), { value: 0.8, label: 'old venue rate', sameAs: null });
  assert.deepEqual(rowFallback(emptyCard(), 'card_present_debit', 'percent', legacy), { value: 0.8, label: 'old venue rate', sameAs: 'In person credit' });
  assert.deepEqual(rowFallback(emptyCard(), 'card_not_present_debit', 'percent', legacy), { value: null, label: null, sameAs: null });
  // no fallback function, junk state: never throws
  assert.deepEqual(rowFallback(null, 'card_present_debit', 'percent', null), { value: null, label: null, sameAs: null });
});

test('rowView: what applies, where it comes from, and the grey inherited value for a blank row', () => {
  const fb = venueFallback({ rate_card: { card_not_present: { percent: 1.7, fixed_pence: 9 } } });
  const st = { ...emptyCard(), card_present: { percent: '1.4', fixed_pence: '5' }, card_not_present_debit: { percent: '1.1', fixed_pence: '' } };
  // typed here
  assert.deepEqual(rowView(st, 'card_present', fb), { effPct: 1.4, effFix: 5, nothing: false, typed: true, source: 'set here', placeholderPct: 'none', placeholderFix: 'none' });
  // blank debit under a typed credit row: the credit numbers, not typed, "same as"
  assert.deepEqual(rowView(st, 'card_present_debit', fb), { effPct: 1.4, effFix: 5, nothing: false, typed: false, source: 'same as In person credit', placeholderPct: '1.40', placeholderFix: '5' });
  // a debit percent typed, its pence left blank: the pence comes through the credit row's platform default
  assert.deepEqual(rowView(st, 'card_not_present_debit', fb), { effPct: 1.1, effFix: 9, nothing: false, typed: true, source: 'set here', placeholderPct: '1.70', placeholderFix: '9' });
  // blank credit row: the platform default
  assert.deepEqual(rowView(st, 'card_not_present', fb), { effPct: 1.7, effFix: 9, nothing: false, typed: false, source: 'platform default', placeholderPct: '1.70', placeholderFix: '9' });
  // blank debit over a blank credit row that reads the platform default
  assert.equal(rowView(emptyCard(), 'card_not_present_debit', fb).source, 'same as Online credit, platform default');
  // nothing anywhere
  assert.deepEqual(rowView(emptyCard(), 'keyed', fb), { effPct: null, effFix: null, nothing: true, typed: false, source: null, placeholderPct: 'none', placeholderFix: 'none' });
  assert.equal(rowView(emptyCard(), 'card_present_debit', fb).nothing, true);
  // EDITING ONLY DEBIT moves only debit: every other row reads as it did before the debit rate was typed
  const before = Object.fromEntries(RATE_CARD_TIERS.map((t) => [t.id, rowView({ ...emptyCard(), card_present: { percent: '1.4', fixed_pence: '5' } }, t.id, fb)]));
  const after = Object.fromEntries(RATE_CARD_TIERS.map((t) => [t.id, rowView({ ...emptyCard(), card_present: { percent: '1.4', fixed_pence: '5' }, card_present_debit: { percent: '0.9', fixed_pence: '3' } }, t.id, fb)]));
  for (const t of RATE_CARD_TIERS) if (t.id !== 'card_present_debit') assert.deepEqual(after[t.id], before[t.id], t.id);
  assert.deepEqual([after.card_present_debit.effPct, after.card_present_debit.effFix, after.card_present_debit.source], [0.9, 3, 'set here']);
});

test('venueRateRows: one row for credit and debit until the venue pays them apart', () => {
  const four = { card_present: { percent: 1.4, fixed_pence: 5 }, card_not_present: { percent: 1.9, fixed_pence: 10 }, amex: { percent: 2.5, fixed_pence: 10 }, keyed: null };
  // an older server (no debit tiers) and a server whose debit tiers only follow credit read the same
  const same = { ...four, card_present_debit: { percent: 1.4, fixed_pence: 5 }, card_not_present_debit: { percent: 1.9, fixed_pence: 10 } };
  for (const card of [four, same]) {
    assert.deepEqual(venueRateRows(card).map((r) => r.label), ['In person (credit and debit)', 'Online (credit and debit)', 'American Express and business cards', 'Keyed in by hand']);
    assert.deepEqual(venueRateRows(card)[0].rate, { percent: 1.4, fixed_pence: 5 });
  }
  // priced apart in person only
  const apart = venueRateRows({ ...same, card_present_debit: { percent: 0.9, fixed_pence: 3 } });
  assert.deepEqual(apart.map((r) => r.label), ['In person credit', 'In person debit', 'Online (credit and debit)', 'American Express and business cards', 'Keyed in by hand']);
  assert.deepEqual(apart[1], { id: 'card_present_debit', label: 'In person debit', rate: { percent: 0.9, fixed_pence: 3 } });
  assert.equal(venueRateRows(four)[3].rate, null);
  assert.equal(venueRateRows(null).length, 4);
  for (const r of venueRateRows({ ...same, card_present_debit: { percent: 0.9 }, card_not_present_debit: { percent: 1 } })) assert.doesNotMatch(r.label, /[-–—&]/, r.label);
});

test('foldDebitCategories: the revenue table keeps one column per channel, and loses no money', () => {
  const bc = {
    card_present: { count: 10, volume_minor: 10000, commission_minor: 145, commission_known: 10 },
    card_present_debit: { count: 4, volume_minor: 4000, commission_minor: 40, commission_known: 4 },
    card_not_present_debit: { count: 1, volume_minor: 500, commission_minor: 6, commission_known: 1 },
    amex: { count: 2, volume_minor: 2000, commission_minor: 60, commission_known: 2 },
    unclassified: { count: 0, volume_minor: 0, commission_minor: 0, commission_known: 0 },
  };
  const out = foldDebitCategories(bc);
  assert.deepEqual(out.card_present, { count: 14, volume_minor: 14000, commission_minor: 185, commission_known: 14, debit_count: 4 });
  assert.deepEqual(out.card_not_present, { count: 1, volume_minor: 500, commission_minor: 6, commission_known: 1, debit_count: 1 });
  assert.deepEqual(out.amex, bc.amex);
  assert.equal('card_present_debit' in out, false);
  // the totals are untouched, and the input is never changed
  const total = (o, k) => Object.values(o).reduce((s, v) => s + (Number(v?.[k]) || 0), 0);
  for (const k of ['count', 'volume_minor', 'commission_minor']) assert.equal(total(out, k), total(bc, k), k);
  assert.equal(bc.card_present.count, 10);
  // an older server (no debit categories) folds to itself
  assert.deepEqual(foldDebitCategories({ card_present: bc.card_present }), { card_present: bc.card_present });
  assert.deepEqual(foldDebitCategories(null), {});
});
