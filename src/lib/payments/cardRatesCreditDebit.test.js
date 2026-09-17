/**
 * cardRatesCreditDebit.test.js: credit and debit priced apart (17 Sep 2026).
 *
 * THE SAFETY RULE UNDER TEST: a rate card nobody has edited must charge every
 * payment EXACTLY what it charges today, write EXACTLY the six rules it writes
 * today on Adyen, and stamp EXACTLY today's ledger category. Only a typed
 * debit price changes anything, and it changes debit only.
 *
 * "Today" is frozen INSIDE this file (todayResolve, todayClassify, TODAY_RULES:
 * copies of the code as it stood on main before this change), so the proof
 * does not lean on the code it is checking.
 *
 * The resolver, the commission maths and the ledger classifier live in the
 * Deno copy supabase/functions/_shared/adyen.ts. Node strips types natively
 * from 23.6; anything older skips those tests instead of failing the run.
 *
 * Run: `node --test src/lib/payments/cardRatesCreditDebit.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMISSION_TIERS, DEBIT_TIER_BASE, DEBIT_TIERS, RATE_CARD_TIER_ORDER, FUNDING_POLICY,
  PREPAID_CARDS_PAY, DEFERRED_DEBIT_CARDS_PAY, CHARGE_CARDS_PAY, KEYED_DEBIT_PAYS, BUSINESS_DEBIT_PAYS,
  debitFundingSources, debitTiersApart, tieredCommissionRules, buildTieredProfile, profileTiers, tiersMatch,
  profileMatchesRules, ratesOnAdyen, ratesChangePreview, rateCardLine, rateCardProblems, tiersFromResolved, unpricedTiers,
  RATE_ROW_LABELS,
} from './adyenLink.js';

const SHARED_ADYEN = '../../../supabase/functions/_shared/adyen.ts';
const SHARED_LINK = '../../../supabase/functions/_shared/adyenLink.ts';
async function load(t, path) {
  try { return await import(path); }
  catch (e) { t.skip(`this node cannot import the .ts file here (${e?.code || e?.message})`); return null; }
}

// ── TODAY, FROZEN ────────────────────────────────────────────────────────────
// resolveAdyenRateCard as it stood on main (four tiers, no debit).
const TODAY_TIERS = ['card_present', 'card_not_present', 'amex', 'keyed'];
function todayResolve(account, settings) {
  const numOrNull = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const tierField = (card, tier, field) => numOrNull(card?.[tier]?.[field]);
  const legacyVenue = { percent: numOrNull(account?.markup_percent), fixed_pence: numOrNull(account?.markup_fixed_pence) };
  const legacyPlatform = { percent: numOrNull(settings?.default_adyen_markup_percent), fixed_pence: numOrNull(settings?.default_adyen_markup_fixed_pence) };
  const out = {};
  for (const tier of TODAY_TIERS) {
    const pick = (field) => {
      const venue = tierField(account?.rate_card, tier, field);
      if (venue !== null) return { value: venue, source: 'venue' };
      const def = tierField(settings?.default_adyen_rate_card, tier, field);
      if (def !== null) return { value: def, source: 'platform' };
      if (tier === 'card_present') {
        if (legacyVenue[field] !== null) return { value: legacyVenue[field], source: 'legacy_venue' };
        if (legacyPlatform[field] !== null) return { value: legacyPlatform[field], source: 'legacy_platform' };
      }
      return { value: null, source: null };
    };
    const pct = pick('percent');
    const fix = pick('fixed_pence');
    out[tier] = { percent: pct.value, fixed_pence: fix.value === null ? null : Math.round(fix.value), source: pct.source ?? fix.source };
  }
  return out;
}
// commissionForAmount as it stood on main.
function todayCommission(amountMinor, tier) {
  if (!tier || (tier.percent === null && tier.fixed_pence === null)) return null;
  if (!Number.isFinite(amountMinor) || amountMinor < 0) return null;
  return Math.floor((amountMinor * Number(tier.percent ?? 0)) / 100 + 0.5) + Math.round(Number(tier.fixed_pence ?? 0));
}
// classifyRateCategory as it stood in adyen-webhook on main.
function todayClassify(item, channel) {
  const ad = item?.additionalData ?? {};
  const brand = String(ad.paymentMethod ?? item?.paymentMethod ?? '').toLowerCase();
  const variant = String(ad.paymentMethodVariant ?? '').toLowerCase();
  const added = String(ad['checkout.cardAddedBrand'] ?? '').toLowerCase();
  if (brand.includes('amex') || variant.includes('amex') || added.includes('amex')) return 'amex';
  const commercial = String(ad.isCardCommercial ?? '').toLowerCase();
  if (commercial === 'true' || commercial === 'yes') return 'amex';
  if (/(business|corporate|commercial|purchasing|fleet)/.test(variant)) return 'amex';
  const si = String(ad.shopperInteraction ?? item?.shopperInteraction ?? '').toLowerCase();
  if (si === 'moto') return 'keyed';
  const entry = String(ad.posEntryMode ?? '').toLowerCase();
  if (entry.includes('key') || entry.includes('manual')) return 'keyed';
  const ch = String(channel ?? '').toLowerCase();
  if (['online', 'booking', 'qr', 'gift', 'web', 'ecommerce'].includes(ch)) return 'card_not_present';
  if (si === 'ecommerce') return 'card_not_present';
  if ('checkout.cardAddedBrand' in ad || 'threeds2.cardEnrolled' in ad || 'isCardCommercial' in ad || 'scaExemptionRequested' in ad) return 'card_not_present';
  return 'card_present';
}
// The six rules main writes for FOUR in GBP, as a literal.
const LOGIC = (commission) => ({
  commission,
  paymentFee: 'deductFromLiableAccount', remainder: 'addToOneBalanceAccount', tip: 'addToOneBalanceAccount', surcharge: 'addToOneBalanceAccount',
  chargeback: 'deductFromOneBalanceAccount', chargebackCostAllocation: 'deductFromLiableAccount', refund: 'deductAccordingToSplitRatio', refundCostAllocation: 'deductFromLiableAccount',
});
const RULE = (paymentMethod, shopperInteraction, commission, fundingSource = 'ANY', currency = 'GBP') => ({ currency, fundingSource, paymentMethod, shopperInteraction, splitLogic: LOGIC(commission) });
const FOUR = { card_present: { percent: 1.4, fixedPence: 5 }, card_not_present: { percent: 1.9, fixedPence: 10 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.9, fixedPence: 15 } };
const TODAY_RULES = [
  RULE('amex', 'Ecommerce', { variablePercentage: 250, fixedAmount: 10 }),
  RULE('amex', 'Moto', { variablePercentage: 250, fixedAmount: 10 }),
  RULE('amex', 'ANY', { variablePercentage: 250, fixedAmount: 10 }),
  RULE('ANY', 'Ecommerce', { variablePercentage: 190, fixedAmount: 10 }),
  RULE('ANY', 'Moto', { variablePercentage: 290, fixedAmount: 15 }),
  RULE('ANY', 'ANY', { variablePercentage: 140, fixedAmount: 5 }),
];

// Cards as they sit in the database today: no debit key anywhere.
const VENUE_CARD = { card_present: { percent: 1.4, fixed_pence: 5 }, card_not_present: { percent: 1.9, fixed_pence: 10 }, amex: { percent: 2.5, fixed_pence: 10 }, keyed: { percent: 2.9, fixed_pence: 15 } };
const PLATFORM_CARD = { card_present: { percent: 1.2, fixed_pence: 4 }, card_not_present: { percent: 1.7, fixed_pence: 9 }, amex: { percent: 2.4, fixed_pence: 9 }, keyed: { percent: 2.8, fixed_pence: 14 } };
const UNEDITED = [
  ['venue card only', { rate_card: VENUE_CARD }, {}],
  ['platform card only', {}, { default_adyen_rate_card: PLATFORM_CARD }],
  ['venue over platform', { rate_card: { card_present: { percent: 1.1, fixed_pence: null }, keyed: { percent: null, fixed_pence: 20 } } }, { default_adyen_rate_card: PLATFORM_CARD }],
  ['legacy venue flat', { markup_percent: 0.8, markup_fixed_pence: 5 }, {}],
  ['legacy platform flat', {}, { default_adyen_markup_percent: '0.9', default_adyen_markup_fixed_pence: 6 }],
  ['platform card over legacy venue', { markup_percent: 0.8, markup_fixed_pence: 5 }, { default_adyen_rate_card: { card_present: { percent: 1.2, fixed_pence: null } } }],
  ['every layer at once', { rate_card: { amex: { percent: 3, fixed_pence: 0 } }, markup_percent: 0.8, markup_fixed_pence: 5 }, { default_adyen_rate_card: { card_not_present: { percent: 1.7, fixed_pence: 9 } }, default_adyen_markup_percent: 1, default_adyen_markup_fixed_pence: 7 }],
  ['a stored card with empty debit rows (saved by the new editor, nothing typed)', { rate_card: { ...VENUE_CARD, card_present_debit: { percent: null, fixed_pence: null }, card_not_present_debit: { percent: null, fixed_pence: null } } }, { default_adyen_rate_card: PLATFORM_CARD }],
  ['nothing anywhere', {}, {}],
  ['null row and null settings', null, null],
];
const AMOUNTS = [0, 1, 49, 50, 99, 100, 250, 1234, 9999, 100000, 1234567];
// resolved card (fixed_pence) as the profile builder takes it (fixedPence)
const asTiers = (cards) => Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, { percent: v.percent, fixedPence: v.fixed_pence }]));

// ── 1. THE RATE CARD RESOLVER ────────────────────────────────────────────────

test('UNEDITED CARD: every base tier resolves exactly as today, and each debit tier IS its credit tier', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  assert.deepEqual([...ts.RATE_TIERS], RATE_CARD_TIER_ORDER.slice());
  assert.deepEqual([...ts.BASE_RATE_TIERS], TODAY_TIERS);
  assert.deepEqual({ ...ts.DEBIT_TIER_BASE }, { ...DEBIT_TIER_BASE });
  for (const [name, account, settings] of UNEDITED) {
    const today = todayResolve(account, settings);
    const now = ts.resolveAdyenRateCard(account, settings);
    for (const tier of TODAY_TIERS) assert.deepEqual(now[tier], today[tier], `${name}: ${tier}`);
    for (const [debit, base] of Object.entries(DEBIT_TIER_BASE)) {
      const priced = today[base].percent !== null || today[base].fixed_pence !== null;
      assert.deepEqual(now[debit], { ...today[base], inherited_from: priced ? base : null }, `${name}: ${debit}`);
    }
  }
});

test('UNEDITED CARD: commissionForAmount is identical to today for every category and amount', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  for (const [name, account, settings] of UNEDITED) {
    const today = todayResolve(account, settings);
    const now = ts.resolveAdyenRateCard(account, settings);
    for (const amount of AMOUNTS) {
      for (const tier of TODAY_TIERS) assert.equal(ts.commissionForAmount(amount, now[tier]), todayCommission(amount, today[tier]), `${name}: ${tier} on ${amount}`);
      // a debit payment is charged what the same payment is charged today
      for (const [debit, base] of Object.entries(DEBIT_TIER_BASE)) assert.equal(ts.commissionForAmount(amount, now[debit]), todayCommission(amount, today[base]), `${name}: ${debit} on ${amount}`);
    }
  }
  // the maths itself did not move: round half up, pence added, null for no rate
  assert.equal(ts.commissionForAmount(250, { percent: 1.4, fixed_pence: 5, source: 'venue' }), 9);
  assert.equal(ts.commissionForAmount(1234, { percent: 1.5, fixed_pence: null, source: 'venue' }), 19);
  assert.equal(ts.commissionForAmount(1000, { percent: null, fixed_pence: null, source: null }), null);
});

test('EDITING ONLY DEBIT changes only debit, on the venue card and on the platform card', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const before = ts.resolveAdyenRateCard({ rate_card: VENUE_CARD }, { default_adyen_rate_card: PLATFORM_CARD });
  // venue types an in person debit price
  const venueEdit = ts.resolveAdyenRateCard({ rate_card: { ...VENUE_CARD, card_present_debit: { percent: 0.9, fixed_pence: 3 } } }, { default_adyen_rate_card: PLATFORM_CARD });
  for (const tier of [...TODAY_TIERS, 'card_not_present_debit']) assert.deepEqual(venueEdit[tier], before[tier], tier);
  assert.deepEqual(venueEdit.card_present_debit, { percent: 0.9, fixed_pence: 3, source: 'venue', inherited_from: null });
  for (const amount of AMOUNTS) {
    for (const tier of [...TODAY_TIERS, 'card_not_present_debit']) assert.equal(ts.commissionForAmount(amount, venueEdit[tier]), ts.commissionForAmount(amount, before[tier]));
  }
  assert.equal(ts.commissionForAmount(10000, venueEdit.card_present_debit), 93);
  assert.equal(ts.commissionForAmount(10000, venueEdit.card_present), 145);
  // platform types an online debit price: a venue with NO card of its own picks it up, nothing else moves
  const bare = ts.resolveAdyenRateCard({}, { default_adyen_rate_card: PLATFORM_CARD });
  const platformEdit = ts.resolveAdyenRateCard({}, { default_adyen_rate_card: { ...PLATFORM_CARD, card_not_present_debit: { percent: 1.1, fixed_pence: 9 } } });
  for (const tier of [...TODAY_TIERS, 'card_present_debit']) assert.deepEqual(platformEdit[tier], bare[tier], tier);
  assert.deepEqual(platformEdit.card_not_present_debit, { percent: 1.1, fixed_pence: 9, source: 'platform', inherited_from: null });
});

test('SAME LEVEL FIRST: a venue with its own price never picks up a platform debit default by surprise', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const settings = { default_adyen_rate_card: { ...PLATFORM_CARD, card_present_debit: { percent: 0.5, fixed_pence: 1 }, card_not_present_debit: { percent: 0.6, fixed_pence: 2 } } };
  // the venue priced in person itself and never touched debit: debit stays the venue's own in person price
  const own = ts.resolveAdyenRateCard({ rate_card: { card_present: { percent: 1.4, fixed_pence: 5 } } }, settings);
  assert.deepEqual(own.card_present_debit, { percent: 1.4, fixed_pence: 5, source: 'venue', inherited_from: 'card_present' });
  // ...while online, which the venue never priced, follows the platform: debit default first, then base
  assert.deepEqual(own.card_not_present_debit, { percent: 0.6, fixed_pence: 2, source: 'platform', inherited_from: null });
  assert.deepEqual(own.card_not_present, { percent: 1.7, fixed_pence: 9, source: 'platform' });
  // per field, as every tier has always resolved: a venue debit percent with the venue's own pence under it
  const mixed = ts.resolveAdyenRateCard({ rate_card: { card_present: { percent: 1.4, fixed_pence: 5 }, card_present_debit: { percent: 0.9, fixed_pence: null } } }, settings);
  assert.deepEqual(mixed.card_present_debit, { percent: 0.9, fixed_pence: 5, source: 'venue', inherited_from: null });
});

test('THE LEGACY FLAT COLUMNS still mean in person (and in person debit through it), never online', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const r = ts.resolveAdyenRateCard({ markup_percent: 0.8, markup_fixed_pence: 5 }, { default_adyen_markup_percent: 1, default_adyen_markup_fixed_pence: 7 });
  assert.deepEqual(r.card_present, { percent: 0.8, fixed_pence: 5, source: 'legacy_venue' });
  assert.deepEqual(r.card_present_debit, { percent: 0.8, fixed_pence: 5, source: 'legacy_venue', inherited_from: 'card_present' });
  assert.deepEqual(r.card_not_present, { percent: null, fixed_pence: null, source: null });
  assert.deepEqual(r.card_not_present_debit, { percent: null, fixed_pence: null, source: null, inherited_from: null });
  assert.deepEqual(r.amex, { percent: null, fixed_pence: null, source: null });
  // a typed in person debit price sits over the legacy rate without moving it
  const d = ts.resolveAdyenRateCard({ rate_card: { card_present_debit: { percent: 0.4, fixed_pence: 2 } }, markup_percent: 0.8, markup_fixed_pence: 5 }, {});
  assert.deepEqual(d.card_present, { percent: 0.8, fixed_pence: 5, source: 'legacy_venue' });
  assert.deepEqual(d.card_present_debit, { percent: 0.4, fixed_pence: 2, source: 'venue', inherited_from: null });
});

test('sanitizeRateCard keeps the two debit rows (it used to drop them in silence) and still drops junk', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const kept = ts.sanitizeRateCard({ ...VENUE_CARD, card_present_debit: { percent: '0.9', fixed_pence: '3' }, card_not_present_debit: { percent: '', fixed_pence: null }, visa: { percent: 1 } });
  assert.deepEqual(kept.card_present_debit, { percent: 0.9, fixed_pence: 3 });
  assert.deepEqual(kept.card_not_present_debit, { percent: null, fixed_pence: null });
  assert.equal('visa' in kept, false);
  assert.deepEqual(kept.card_present, { percent: 1.4, fixed_pence: 5 });
  // a card holding ONLY a debit price is still a card
  assert.deepEqual(ts.sanitizeRateCard({ card_present_debit: { percent: 0.9 } }), { card_present_debit: { percent: 0.9, fixed_pence: null } });
  assert.equal(ts.sanitizeRateCard({ card_present_debit: { percent: '', fixed_pence: '' } }), null);
});

// ── 2. THE RULES ON ADYEN ────────────────────────────────────────────────────

test('UNEDITED CARD: the rules written to Adyen are today’s six, byte for byte', async (t) => {
  assert.deepEqual(tieredCommissionRules('GBP', FOUR).rules, TODAY_RULES);
  assert.deepEqual(buildTieredProfile({ description: 'ServOS Provo rates', currency: 'GBP', tiers: FOUR }), { description: 'ServOS Provo rates', rules: TODAY_RULES });
  // blank debit rows, null debit rows, and debit typed the SAME as credit: still the six
  assert.deepEqual(tieredCommissionRules('GBP', { ...FOUR, card_present_debit: {}, card_not_present_debit: { percent: null, fixedPence: null } }).rules, TODAY_RULES);
  assert.deepEqual(tieredCommissionRules('GBP', { ...FOUR, card_present_debit: { percent: 1.4, fixedPence: 5 }, card_not_present_debit: { percent: 1.9, fixed_pence: 10 } }).rules, TODAY_RULES);
  assert.deepEqual(debitTiersApart(FOUR), []);
  // straight through the real resolver: what set_split builds for a venue nobody edited
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const resolved = ts.resolveAdyenRateCard({ rate_card: VENUE_CARD }, { default_adyen_rate_card: PLATFORM_CARD });
  assert.deepEqual(tieredCommissionRules('GBP', asTiers(resolved)).rules, TODAY_RULES);
  assert.deepEqual(tieredCommissionRules('GBP', tiersFromResolved(resolved)).rules, TODAY_RULES);
  // and a profile written before this change still reads as a match for that venue
  assert.equal(ratesOnAdyen({ rules: TODAY_RULES }, tiersFromResolved(resolved), 'GBP').matches, true);
});

test('DEBIT PRICED APART: debit and prepaid rules sit just ahead of the ANY fallback, and the six do not move', () => {
  const inPerson = tieredCommissionRules('GBP', { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 } }).rules;
  assert.deepEqual(inPerson, [
    ...TODAY_RULES.slice(0, 5),
    RULE('ANY', 'POS', { variablePercentage: 90, fixedAmount: 3 }, 'debit'),
    RULE('ANY', 'POS', { variablePercentage: 90, fixedAmount: 3 }, 'prepaid'),
    TODAY_RULES[5],
  ]);
  const online = tieredCommissionRules('GBP', { ...FOUR, card_not_present_debit: { percent: 1.1, fixedPence: 9 } }).rules;
  assert.deepEqual(online, [
    ...TODAY_RULES.slice(0, 3),
    RULE('ANY', 'Ecommerce', { variablePercentage: 110, fixedAmount: 9 }, 'debit'),
    RULE('ANY', 'Ecommerce', { variablePercentage: 110, fixedAmount: 9 }, 'prepaid'),
    ...TODAY_RULES.slice(3),
  ]);
  const both = tieredCommissionRules('USD', { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 }, card_not_present_debit: { percent: 0, fixedPence: 0 } }).rules;
  assert.equal(both.length, 10);
  // the ANY rules are exactly today's, whatever debit says
  assert.deepEqual(both.filter((r) => r.fundingSource === 'ANY'), TODAY_RULES.map((r) => ({ ...r, currency: 'USD' })));
  // a debit tier priced 0% and 0p is a price: an explicit zero, as for every tier
  assert.deepEqual(both.find((r) => r.fundingSource === 'debit' && r.shopperInteraction === 'Ecommerce').splitLogic.commission, { variablePercentage: 0 });
  // no debit rule is ever written with interaction ANY (it would outrank ANY + Moto and take keyed debit off Keyed in)
  assert.equal(both.some((r) => r.fundingSource !== 'ANY' && r.shopperInteraction === 'ANY'), false);
  // Amex first: no amex rule names a funding source
  assert.equal(both.filter((r) => r.paymentMethod === 'amex').every((r) => r.fundingSource === 'ANY'), true);
  // a base tier with no price still refuses everything, and a debit row is never "lacking"
  assert.deepEqual(tieredCommissionRules('GBP', { ...FOUR, keyed: {}, card_present_debit: { percent: 0.9 } }), { rules: [], lacking: ['keyed'] });
  assert.deepEqual(unpricedTiers({ ...FOUR, card_present_debit: {} }), []);
});

test('ONLY VALUES ADYEN ALLOWS: fundingSource and shopperInteraction on every rule we can write', () => {
  const FUNDING = ['credit', 'debit', 'prepaid', 'deferred_debit', 'charged', 'ANY'];
  const INTERACTION = ['Ecommerce', 'ContAuth', 'Moto', 'POS', 'ANY'];
  const card = { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 }, card_not_present_debit: { percent: 1.1, fixedPence: 9 } };
  const policies = [FUNDING_POLICY, { prepaid: 'debit', deferredDebit: 'debit', charged: 'debit', keyedDebit: 'debit', businessDebit: 'debit' }, { prepaid: 'credit', deferredDebit: 'credit', charged: 'credit', keyedDebit: 'keyed', businessDebit: 'business' }];
  for (const policy of policies) {
    for (const r of tieredCommissionRules('GBP', card, policy).rules) {
      assert.ok(FUNDING.includes(r.fundingSource), r.fundingSource);
      assert.ok(INTERACTION.includes(r.shopperInteraction), r.shopperInteraction);
      assert.deepEqual(Object.keys(r).sort(), ['currency', 'fundingSource', 'paymentMethod', 'shopperInteraction', 'splitLogic']);
    }
  }
});

test('THE OWNER DEFAULTS: one constant each, and flipping one moves only what it names', () => {
  assert.deepEqual([PREPAID_CARDS_PAY, DEFERRED_DEBIT_CARDS_PAY, CHARGE_CARDS_PAY, KEYED_DEBIT_PAYS, BUSINESS_DEBIT_PAYS], ['debit', 'credit', 'credit', 'keyed', 'business']);
  assert.deepEqual({ ...FUNDING_POLICY }, { prepaid: 'debit', deferredDebit: 'credit', charged: 'credit', keyedDebit: 'keyed', businessDebit: 'business' });
  assert.deepEqual(debitFundingSources(), ['debit', 'prepaid']);
  assert.deepEqual(debitFundingSources({ ...FUNDING_POLICY, prepaid: 'credit' }), ['debit']);
  assert.deepEqual(debitFundingSources({ ...FUNDING_POLICY, deferredDebit: 'debit', charged: 'debit' }), ['debit', 'prepaid', 'deferred_debit', 'charged']);
  const card = { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 } };
  // prepaid flipped to credit: the prepaid rule goes, prepaid cards fall to the ANY (credit) rule
  const noPrepaid = tieredCommissionRules('GBP', card, { ...FUNDING_POLICY, prepaid: 'credit' }).rules;
  assert.deepEqual(noPrepaid.filter((r) => r.fundingSource !== 'ANY').map((r) => `${r.fundingSource}+${r.shopperInteraction}`), ['debit+POS']);
  // keyed debit stays on Keyed in by default: no Moto rule names a funding source
  assert.equal(tieredCommissionRules('GBP', card).rules.some((r) => r.shopperInteraction === 'Moto' && r.fundingSource !== 'ANY'), false);
  // flipped: a keyed debit card pays the in person debit price
  const keyedFlip = tieredCommissionRules('GBP', card, { ...FUNDING_POLICY, keyedDebit: 'debit' }).rules;
  assert.deepEqual(keyedFlip.filter((r) => r.shopperInteraction === 'Moto' && r.fundingSource !== 'ANY').map((r) => [r.fundingSource, r.splitLogic.commission]), [['debit', { variablePercentage: 90, fixedAmount: 3 }], ['prepaid', { variablePercentage: 90, fixedAmount: 3 }]]);
  // the default policy is what a call with no policy uses
  assert.deepEqual(tieredCommissionRules('GBP', card).rules, tieredCommissionRules('GBP', card, FUNDING_POLICY).rules);
});

test('profileTiers, tiersMatch, ratesOnAdyen: a debit profile round trips, and an old profile only matches an unedited card', () => {
  const card = { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 }, card_not_present_debit: { percent: 1.1, fixedPence: 9 } };
  const written = { rules: tieredCommissionRules('GBP', card).rules };
  assert.deepEqual(profileTiers(written), card);
  // a profile from before debit pricing reads back with NO debit keys, exactly as it always did
  assert.deepEqual(profileTiers({ rules: TODAY_RULES }), FOUR);
  // rule order never decides: a debit rule listed FIRST is not read as the online rate
  const reversed = { rules: [...written.rules].reverse() };
  assert.deepEqual(profileTiers(reversed), card);
  assert.equal(ratesOnAdyen(reversed, card, 'GBP').matches, true);
  assert.deepEqual(ratesOnAdyen(written, card, 'GBP'), { tiers: card, matches: true, missing: false, remainder: 'addToOneBalanceAccount', rules: 10 });
  // the prepaid rule alone is not the debit rate
  assert.equal(profileTiers({ rules: [RULE('ANY', 'POS', { variablePercentage: 90 }, 'prepaid')] }).card_present_debit, undefined);
  // tiersMatch: no debit rule on Adyen matches "debit blank" and "debit same as credit", nothing else
  assert.equal(tiersMatch(FOUR, FOUR), true);
  assert.equal(tiersMatch(FOUR, { ...FOUR, card_present_debit: {} }), true);
  assert.equal(tiersMatch(FOUR, { ...FOUR, card_present_debit: { percent: 1.4, fixedPence: 5 } }), true);
  assert.equal(tiersMatch(FOUR, card), false);
  assert.equal(tiersMatch(card, card), true);
  assert.equal(tiersMatch(card, { ...card, card_present_debit: { percent: 0.9, fixedPence: 4 } }), false);
  // an old six rule profile: a match for the unedited card, NOT for a card with debit apart (send is needed)
  assert.equal(ratesOnAdyen({ rules: TODAY_RULES }, FOUR, 'GBP').matches, true);
  assert.equal(ratesOnAdyen({ rules: TODAY_RULES }, card, 'GBP').matches, false);
  assert.equal(ratesOnAdyen({ rules: TODAY_RULES }, card, 'GBP').missing, false);
  // a debit profile left on Adyen after the debit price was cleared again: not a match either
  assert.equal(ratesOnAdyen(written, FOUR, 'GBP').matches, false);
  // the right numbers with the prepaid rule missing is not the whole profile
  const noPrepaid = { rules: written.rules.filter((r) => r.fundingSource !== 'prepaid') };
  assert.equal(tiersMatch(profileTiers(noPrepaid), card), true);
  assert.equal(profileMatchesRules(noPrepaid, written.rules), false);
  assert.equal(ratesOnAdyen(noPrepaid, card, 'GBP').matches, false);
});

test('ratesChangePreview: what Send would change, in short plain lines, and nothing for an unedited venue', () => {
  const card = { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 } };
  // Adyen holds today's six, the venue typed an in person debit price
  const p = ratesChangePreview({ rules: TODAY_RULES }, card, 'GBP');
  assert.equal(p.same, false);
  assert.equal(p.canSend, true);
  assert.deepEqual([p.rulesNow, p.rulesNext], [6, 8]);
  assert.deepEqual(p.lines, ['In person debit: 1.4% + 5p now, 0.9% + 3p after.']);
  assert.deepEqual(p.rows.map((r) => [r.tier, r.changed]), [['card_present', false], ['card_present_debit', true], ['card_not_present', false], ['card_not_present_debit', false], ['amex', false], ['keyed', false]]);
  assert.deepEqual(p.rows[1], { tier: 'card_present_debit', label: 'In person debit', now: '1.4% + 5p', next: '0.9% + 3p', changed: true });
  // an unedited venue whose profile is already on Adyen: nothing to send
  const same = ratesChangePreview({ rules: TODAY_RULES }, FOUR, 'GBP');
  assert.deepEqual([same.same, same.lines], [true, ['Adyen already holds these rates. Sending changes nothing.']]);
  assert.equal(same.rows.some((r) => r.changed), false);
  // no profile on the store yet
  const none = ratesChangePreview(null, FOUR, 'USD');
  assert.equal(none.lines[0], 'Adyen holds no rates for this venue yet.');
  assert.equal(none.lines[1], 'In person credit: 1.4% + 5c.');
  assert.equal(none.lines.length, 7);
  // a tier with no price: nothing can be sent, in the table's own row words
  const lacking = ratesChangePreview({ rules: TODAY_RULES }, { ...FOUR, keyed: {} }, 'GBP');
  assert.deepEqual([lacking.canSend, lacking.rulesNext, lacking.lines], [false, 0, ['No rate is set yet for: Keyed in. Nothing can be sent.']]);
  // the same numbers on rules that are not ours (every rule in USD on a GBP venue)
  const foreign = ratesChangePreview({ rules: TODAY_RULES.map((r) => ({ ...r, currency: 'USD' })) }, FOUR, 'GBP');
  assert.deepEqual([foreign.same, foreign.lines], [false, ['The rates are the same, but the rules on Adyen are not the ones ServOS writes. Sending puts that right.']]);
  for (const x of [p, same, none, lacking, foreign]) for (const l of x.lines) { assert.doesNotMatch(l, /[–—]|commission/i, l); assert.ok(l.length < 120, l); }
});

test('labels, the one line summary and the 5 percent and 50 pence guard cover the debit rows', () => {
  assert.deepEqual([...COMMISSION_TIERS], TODAY_TIERS);
  assert.deepEqual([...DEBIT_TIERS], ['card_present_debit', 'card_not_present_debit']);
  assert.deepEqual(RATE_CARD_TIER_ORDER.map((tier) => RATE_ROW_LABELS[tier]), ['In person credit', 'In person debit', 'Online credit', 'Online debit', 'Amex and business cards', 'Keyed in']);
  for (const label of Object.values(RATE_ROW_LABELS)) assert.doesNotMatch(label, /[-–—]/, label);
  // the line is today's line until debit is priced apart
  assert.equal(rateCardLine(FOUR), 'In person 1.4% + 5p, online 1.9% + 10p, Amex 2.5% + 10p, keyed 2.9% + 15p');
  assert.equal(rateCardLine({ ...FOUR, card_present_debit: { percent: 1.4, fixedPence: 5 } }), rateCardLine(FOUR));
  assert.equal(rateCardLine({ ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 } }), 'In person 1.4% + 5p, in person debit 0.9% + 3p, online 1.9% + 10p, Amex 2.5% + 10p, keyed 2.9% + 15p');
  // the guard: 9 typed for 0.9, 60p typed for 6p, and an impossible value, on the debit rows
  const slip = rateCardProblems({ card_present_debit: { percent: 9, fixed_pence: 3 }, card_not_present_debit: { percent: 1, fixed_pence: 60 } }, { verb: 'saved' });
  assert.deepEqual(slip.errors, []);
  assert.deepEqual(slip.overLimit.map((x) => x.text), [
    'In person debit is 9% + 3p. That is above the usual limit, so it was not saved.',
    'Online debit is 1% + 60p. That is above the usual limit, so it was not saved.',
  ]);
  assert.deepEqual(rateCardProblems({ card_present_debit: { percent: 140 }, card_not_present_debit: { fixed_pence: 4.5 } }).errors.map((e) => e.text), [
    'In person debit rate must be between 0 and 100.',
    'Online debit per payment must be a whole number.',
  ]);
  assert.deepEqual(rateCardProblems({ card_present_debit: { percent: 5, fixed_pence: 50 } }), { errors: [], overLimit: [] });
});

test('tiersFromResolved: debit tiers ride only when the server resolved them, with where the price came from', async (t) => {
  // an older server answers four tiers: four tiers out, as always
  assert.deepEqual(Object.keys(tiersFromResolved({ card_present: { percent: 1.4, fixed_pence: 5, source: 'venue' } })), TODAY_TIERS);
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const resolved = ts.resolveAdyenRateCard({ rate_card: { ...VENUE_CARD, card_not_present_debit: { percent: 1.1, fixed_pence: 9 } } }, {});
  const tiers = tiersFromResolved(resolved);
  assert.deepEqual(tiers.card_present_debit, { percent: 1.4, fixedPence: 5, source: 'venue', inheritedFrom: 'card_present' });
  assert.deepEqual(tiers.card_not_present_debit, { percent: 1.1, fixedPence: 9, source: 'venue', inheritedFrom: null });
  assert.deepEqual(tiers.card_present, { percent: 1.4, fixedPence: 5, source: 'venue' });
  assert.deepEqual(debitTiersApart(tiers), ['card_not_present_debit']);
});

// ── 3. THE LEDGER MIRROR ─────────────────────────────────────────────────────

const ITEMS = [
  ['terminal visa', { paymentMethod: 'visa', additionalData: { paymentMethod: 'visa', paymentMethodVariant: 'visa', cardSummary: '1111' } }, 'pos'],
  ['terminal mc, no channel', { paymentMethod: 'mc', additionalData: { paymentMethodVariant: 'mcstandarddebit' } }, null],
  ['online visa', { paymentMethod: 'visa', additionalData: { 'checkout.cardAddedBrand': 'visa', isCardCommercial: 'unknown', 'threeds2.cardEnrolled': 'true' } }, 'online'],
  ['booking', { paymentMethod: 'mc', additionalData: {} }, 'booking'],
  ['qr', { paymentMethod: 'visa', additionalData: {} }, 'qr'],
  ['ecommerce by interaction', { paymentMethod: 'visa', additionalData: { shopperInteraction: 'Ecommerce' } }, null],
  ['ecommerce by its keys', { paymentMethod: 'visa', additionalData: { scaExemptionRequested: 'lowValue' } }, 'pos'],
  ['amex in person', { paymentMethod: 'amex', additionalData: { paymentMethodVariant: 'amex' } }, 'pos'],
  ['amex online', { paymentMethod: 'visa', additionalData: { 'checkout.cardAddedBrand': 'amex' } }, 'online'],
  ['business by flag', { paymentMethod: 'visa', additionalData: { isCardCommercial: 'true' } }, 'online'],
  ['business by variant', { paymentMethod: 'visa', additionalData: { paymentMethodVariant: 'visacorporate' } }, 'pos'],
  ['keyed by interaction', { paymentMethod: 'visa', additionalData: { shopperInteraction: 'Moto' } }, 'pos'],
  ['keyed by entry mode', { paymentMethod: 'mc', additionalData: { posEntryMode: 'Keyed' } }, 'pos'],
  ['nothing at all', {}, null],
  ['null item', null, 'online'],
];
const withFunding = (item, fundingSource) => ({ ...(item ?? {}), additionalData: { ...(item?.additionalData ?? {}), fundingSource } });

test('LEDGER: with no funding source on the event the category is today’s, for every shape', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  for (const [name, item, channel] of ITEMS) {
    assert.equal(ts.classifyBaseRateCategory(item, channel), todayClassify(item, channel), `${name}: base`);
    assert.equal(ts.classifyRateCategory(item, channel), todayClassify(item, channel), `${name}: no funding source`);
    // a value we do not know is never guessed, and neither is an empty one
    for (const junk of ['', 'UNKNOWN', 'something_new', null]) assert.equal(ts.classifyRateCategory(withFunding(item, junk), channel), todayClassify(item, channel), `${name}: ${junk}`);
    // credit, deferred debit and charge cards pay the credit price: today's category
    for (const fs of ['CREDIT', 'credit', 'DEFFERED_DEBIT', 'DEFERRED_DEBIT', 'deferred_debit', 'CHARGED', 'charged']) assert.equal(ts.classifyRateCategory(withFunding(item, fs), channel), todayClassify(item, channel), `${name}: ${fs}`);
  }
});

test('LEDGER: a debit or prepaid card moves ONLY in person and online payments to their debit tier', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  for (const [name, item, channel] of ITEMS) {
    const today = todayClassify(item, channel);
    const expected = today === 'card_present' ? 'card_present_debit' : today === 'card_not_present' ? 'card_not_present_debit' : today;
    for (const fs of ['DEBIT', 'debit', 'PREPAID', 'PREPAID_RELOADABLE', 'PREPAID_NONRELOADABLE', 'prepaid']) {
      assert.equal(ts.classifyRateCategory(withFunding(item, fs), channel), expected, `${name}: ${fs}`);
    }
  }
  // Amex and business cards keep their price, a keyed debit card stays on Keyed in
  assert.equal(ts.classifyRateCategory(withFunding(ITEMS[7][1], 'DEBIT'), 'pos'), 'amex');
  assert.equal(ts.classifyRateCategory(withFunding(ITEMS[10][1], 'DEBIT'), 'pos'), 'amex');
  assert.equal(ts.classifyRateCategory(withFunding(ITEMS[11][1], 'DEBIT'), 'pos'), 'keyed');
  // the funding source may ride on the item itself
  assert.equal(ts.classifyRateCategory({ paymentMethod: 'visa', fundingSource: 'DEBIT', additionalData: {} }, 'pos'), 'card_present_debit');
  // fundingSide: the one place the owner defaults are read
  assert.deepEqual(['DEBIT', 'CREDIT', 'PREPAID', 'DEFFERED_DEBIT', 'CHARGED', 'nonsense', undefined].map((v) => ts.fundingSide(v)), ['debit', 'credit', 'debit', 'credit', 'credit', null, null]);
  // the same five owner defaults on both sides of the wire
  assert.deepEqual([ts.PREPAID_CARDS_PAY, ts.DEFERRED_DEBIT_CARDS_PAY, ts.CHARGE_CARDS_PAY, ts.KEYED_DEBIT_PAYS, ts.BUSINESS_DEBIT_PAYS], [PREPAID_CARDS_PAY, DEFERRED_DEBIT_CARDS_PAY, CHARGE_CARDS_PAY, KEYED_DEBIT_PAYS, BUSINESS_DEBIT_PAYS]);
});

test('LEDGER: the stamped commission for a debit payment is today’s until a debit price is typed', async (t) => {
  const ts = await load(t, SHARED_ADYEN); if (!ts) return;
  const debitTap = withFunding(ITEMS[0][1], 'DEBIT');
  const unedited = ts.resolveAdyenRateCard({ rate_card: VENUE_CARD }, { default_adyen_rate_card: PLATFORM_CARD });
  const edited = ts.resolveAdyenRateCard({ rate_card: { ...VENUE_CARD, card_present_debit: { percent: 0.9, fixed_pence: 3 } } }, { default_adyen_rate_card: PLATFORM_CARD });
  for (const amount of AMOUNTS) {
    // unedited: the debit category exists, the money is today's
    assert.equal(ts.commissionForAmount(amount, unedited[ts.classifyRateCategory(debitTap, 'pos')]), todayCommission(amount, todayResolve({ rate_card: VENUE_CARD }, { default_adyen_rate_card: PLATFORM_CARD })[todayClassify(debitTap, 'pos')]));
    // edited: a credit tap, an unknown tap and every other category are still today's
    for (const [, item, channel] of ITEMS) {
      assert.equal(ts.commissionForAmount(amount, edited[ts.classifyRateCategory(item, channel)]), todayCommission(amount, todayResolve({ rate_card: VENUE_CARD }, {})[todayClassify(item, channel)]));
    }
  }
  assert.equal(ts.commissionForAmount(10000, edited[ts.classifyRateCategory(debitTap, 'pos')]), 93);
});

// ── 4. THE TWO COPIES AGREE ──────────────────────────────────────────────────

test('TS mirror: the debit rules, the reads and the preview answer exactly as the JS copy', async (t) => {
  const ts = await load(t, SHARED_LINK); if (!ts) return;
  const cards = [
    FOUR,
    { ...FOUR, card_present_debit: { percent: 0.9, fixedPence: 3 } },
    { ...FOUR, card_not_present_debit: { percent: 1.1, fixed_pence: 9 } },
    { ...FOUR, card_present_debit: { percent: 0, fixedPence: 0 }, card_not_present_debit: { percent: 1.9, fixedPence: 10 } },
    { ...FOUR, keyed: {}, card_present_debit: { percent: 0.9 } },
  ];
  const policies = [undefined, FUNDING_POLICY, { ...FUNDING_POLICY, prepaid: 'credit' }, { prepaid: 'debit', deferredDebit: 'debit', charged: 'debit', keyedDebit: 'debit', businessDebit: 'debit' }];
  for (const card of cards) {
    for (const currency of ['GBP', 'USD']) {
      for (const policy of policies) assert.deepEqual(ts.tieredCommissionRules(currency, card, policy), tieredCommissionRules(currency, card, policy));
      const profile = { rules: tieredCommissionRules(currency, card).rules };
      assert.deepEqual(ts.profileTiers(profile), profileTiers(profile));
      for (const other of cards) {
        assert.equal(ts.tiersMatch(card, other), tiersMatch(card, other));
        assert.deepEqual(ts.ratesOnAdyen(profile, other, currency), ratesOnAdyen(profile, other, currency));
        assert.deepEqual(ts.ratesChangePreview(profile, other, currency), ratesChangePreview(profile, other, currency));
      }
      assert.deepEqual(ts.ratesChangePreview(null, card, currency), ratesChangePreview(null, card, currency));
      assert.equal(ts.rateCardLine(card, currency), rateCardLine(card, currency));
      assert.deepEqual(ts.debitTiersApart(card), debitTiersApart(card));
    }
  }
  assert.deepEqual([...ts.RATE_CARD_TIER_ORDER], [...RATE_CARD_TIER_ORDER]);
  assert.deepEqual({ ...ts.DEBIT_TIER_BASE }, { ...DEBIT_TIER_BASE });
  assert.deepEqual({ ...ts.FUNDING_POLICY }, { ...FUNDING_POLICY });
  assert.deepEqual(ts.debitFundingSources(), debitFundingSources());
  const resolved = { card_present: { percent: 1.4, fixed_pence: 5, source: 'venue' }, card_present_debit: { percent: 1.4, fixed_pence: 5, source: 'venue', inherited_from: 'card_present' }, card_not_present_debit: { percent: 1.1, fixed_pence: 9, source: 'platform', inherited_from: null } };
  assert.deepEqual(ts.tiersFromResolved(resolved), tiersFromResolved(resolved));
  const slip = { card_present_debit: { percent: 9, fixed_pence: 3 }, card_not_present_debit: { percent: 'x', fixed_pence: 60 } };
  assert.deepEqual(ts.rateCardProblems(slip, { verb: 'applied', currency: 'USD' }), rateCardProblems(slip, { verb: 'applied', currency: 'USD' }));
});
