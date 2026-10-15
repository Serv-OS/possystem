/**
 * adyenRules.test.js: ONE RULE ENGINE FOR BOTH SIDES (15 Oct 2026).
 *
 * The owner found the venue's bank receiving a few pounds MORE per settlement
 * than Back Office showed: Adyen charged a flat 0.85% on every card payment and
 * gave nothing back on refunds, while our ledger stamped 0.9% on in person
 * cards, the Amex price on business cards, and gave the fee back in proportion
 * on a refund. The two sides were built apart. From today ONE module builds the
 * profile Adyen is sent (rulesFromRateCard) and picks the rule Adyen would pick
 * on our side (matchAdyenRule), so the stamp equals the charge by construction.
 *
 * Pinned here, in the order of the design:
 *   units        0.9% is variablePercentage 90; 1.1% plus 10p is 110 and fixedAmount 10;
 *                a tier priced 0 and 0 is an explicit { variablePercentage: 0 }
 *   shape        the rules written for the UK card, exactly; no funding source or
 *                card usage condition anywhere; GBP on every rule
 *   preserved    every split logic key other than commission and the two refund
 *                keys is copied from the profile read back; a difference is a
 *                warning line, never a silent copy
 *   matching     Adyen's documented priority frozen in the test
 *   table        variant by interaction gives the tier and the pence
 *   facts        a terminal event and an online event resolve to POS and Ecommerce
 *   words        one plain line per rule, the refund line, no dashes
 *   mirrors      the Deno copy is byte identical to this one
 *   review 15 Oct  the legacy charge is never guessed from a tiered profile; every Amex
 *                name has its own rule and the matcher reads the variant alone; the
 *                webhook settings body adds, never replaces; a replay never demotes a stamp
 * Run: `node --test src/lib/payments/adyenRules.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REFUND_FEE_POLICY, REFUND_BOOKING, DEFAULT_SPLIT_LOGIC, DEBIT_VARIANTS, BUSINESS_VARIANTS, AMEX_VARIANTS, VARIANT_TABLE, DEBIT_VARIANT_RE, BUSINESS_VARIANT_RE,
  commissionFromTier, feeFor, preservedLogicFrom, rulesFromRateCard, ruleKey, annotateRules, tierOfRule,
  paymentFacts, fundingWord, matchAdyenRule, rulesForInstant, latestRulesEntry, stampForPayment, restampForAmount, legacyCommission, legacyChargeFrom,
  describeRules, ruleDiff, ruleWords, variantWords, refundWords, commissionWords, refundPolicyOf, rowRefundPolicy,
  LEGACY_FEE_RULE, RULES_FEE_RULE_PREFIX, mergedWebhookSettings, lostWebhookSettings,
} from './adyenRules.js';
import { profileTiers, tiersMatch, ratesOnAdyen, ratesChangePreview, rateCardProblems, tieredCommissionRules } from './adyenLink.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// The six UK tiers as the admin's resolver hands them over (percent, fixedPence).
const UK = {
  card_present: { percent: 0.9, fixedPence: null },
  card_present_debit: { percent: 0.85, fixedPence: null },
  card_not_present: { percent: 1.1, fixedPence: 10 },
  card_not_present_debit: { percent: 1.1, fixedPence: 10 },
  amex: { percent: 2.5, fixedPence: 10 },
  keyed: { percent: 2.2, fixedPence: 10 },
};
const built = rulesFromRateCard(UK, { currency: 'GBP' });
const RULES = annotateRules(built.rules, built);
const facts = (variant, si, extra = {}) => ({ currency: 'GBP', method: variant.startsWith('amex') ? 'amex' : variant.slice(0, variant.startsWith('visa') ? 4 : 2), variant, fundingSource: null, cardUsageType: 'unknown', cardRegion: null, shopperInteraction: si, ...extra });
const noDash = (l) => assert.doesNotMatch(l, /[–—]/, l);

// ── UNITS ────────────────────────────────────────────────────────────────────
test('units: percent times 100 is basis points, pence as they are, 0 and 0 is an explicit zero', () => {
  assert.deepEqual(commissionFromTier({ percent: 0.9 }), { variablePercentage: 90 });
  assert.deepEqual(commissionFromTier({ percent: 0.85, fixedPence: null }), { variablePercentage: 85 });
  assert.deepEqual(commissionFromTier({ percent: 1.1, fixed_pence: 10 }), { variablePercentage: 110, fixedAmount: 10 });
  assert.deepEqual(commissionFromTier({ percent: 2.5, fixedPence: 10 }), { variablePercentage: 250, fixedAmount: 10 });
  assert.deepEqual(commissionFromTier({ percent: 2.2, fixedPence: 10 }), { variablePercentage: 220, fixedAmount: 10 });
  assert.deepEqual(commissionFromTier({ percent: 0, fixedPence: 0 }), { variablePercentage: 0 });
  assert.deepEqual(commissionFromTier({}), { variablePercentage: 0 });
  // a rate finer than a basis point never reaches the generator: the editor refuses it
  assert.ok(rateCardProblems({ ...UK, card_present: { percent: 1.255, fixedPence: 0 } }).errors.length > 0);
  // feeFor: half up on the basis points, plus the pence
  assert.equal(feeFor(1000, { variablePercentage: 90 }), 9);
  assert.equal(feeFor(250, { variablePercentage: 85 }), 2);     // 2.125
  assert.equal(feeFor(250, { variablePercentage: 90 }), 2);     // 2.25
  assert.equal(feeFor(1000, { variablePercentage: 250, fixedAmount: 10 }), 35);
  assert.equal(feeFor(1000, { variablePercentage: 0 }), 0);
  assert.equal(feeFor(1000, null), null);
  assert.equal(feeFor(-1, { variablePercentage: 90 }), null);
  assert.equal(feeFor('abc', { variablePercentage: 90 }), null);
});

// ── SHAPE ────────────────────────────────────────────────────────────────────
test('shape: the UK card writes one rule per Amex name, one per business variant, one per debit variant at POS, Moto, Ecommerce, ContAuth and a catch all', () => {
  assert.deepEqual(built.lacking, []);
  assert.equal(built.refundPolicy, 'none');
  const byTier = (t) => RULES.filter((r) => r.servos_tier === t);
  // A. one rule per Amex name, the bare amex first, ANY interaction, at the amex price
  const amexRules = RULES.filter((r) => r.paymentMethod.startsWith('amex'));
  assert.deepEqual(amexRules.map((r) => r.paymentMethod), [...AMEX_VARIANTS]);
  assert.equal(AMEX_VARIANTS[0], 'amex');
  for (const r of amexRules) assert.deepEqual([r.shopperInteraction, r.fundingSource, r.servos_tier, r.splitLogic.commission], ['ANY', 'ANY', 'amex', { variablePercentage: 250, fixedAmount: 10 }], r.paymentMethod);
  for (const v of ['amexcorporate', 'amexprepaid', 'amex_applepay', 'amex_googlepay', 'amexsmallbusiness']) assert.ok(AMEX_VARIANTS.includes(v), v);
  // B. every business variant, ANY interaction, at the amex price
  const business = RULES.filter((r) => BUSINESS_VARIANT_RE.test(r.paymentMethod) && !r.paymentMethod.startsWith('amex'));
  assert.equal(business.length, BUSINESS_VARIANTS.length);
  for (const r of business) assert.deepEqual([r.shopperInteraction, r.servos_tier, r.splitLogic.commission], ['ANY', 'amex', { variablePercentage: 250, fixedAmount: 10 }], r.paymentMethod);
  // C. every consumer debit or prepaid variant, POS only, at 85
  const debit = byTier('card_present_debit');
  assert.deepEqual(debit.map((r) => r.paymentMethod), [...DEBIT_VARIANTS]);
  for (const r of debit) assert.deepEqual([r.shopperInteraction, r.splitLogic.commission], ['POS', { variablePercentage: 85 }], r.paymentMethod);
  // D. online debit is priced the same as online credit, so no Ecommerce variant rules
  assert.deepEqual(byTier('card_not_present_debit'), []);
  // E, F, G, H
  assert.deepEqual(byTier('keyed').map((r) => [r.paymentMethod, r.shopperInteraction, r.splitLogic.commission]), [['ANY', 'Moto', { variablePercentage: 220, fixedAmount: 10 }]]);
  assert.deepEqual(byTier('card_not_present').map((r) => [r.paymentMethod, r.shopperInteraction, r.splitLogic.commission]), [['ANY', 'Ecommerce', { variablePercentage: 110, fixedAmount: 10 }], ['ANY', 'ContAuth', { variablePercentage: 110, fixedAmount: 10 }]]);
  assert.deepEqual(byTier('card_present').map((r) => [r.paymentMethod, r.shopperInteraction, r.splitLogic.commission]), [['ANY', 'ANY', { variablePercentage: 90 }]]);
  assert.deepEqual(RULES.at(-1).servos_tier, 'card_present', 'the catch all is last');
  // no funding source, no card usage type, GBP everywhere
  for (const r of RULES) {
    assert.equal(r.fundingSource, 'ANY', ruleKey(r));
    assert.equal(r.cardUsageType, undefined, ruleKey(r));
    assert.equal(r.cardRegion, undefined, ruleKey(r));
    assert.equal(r.currency, 'GBP');
    assert.deepEqual(Object.keys(r).sort(), ['currency', 'fundingSource', 'paymentMethod', 'servos_tier', 'shopperInteraction', 'splitLogic']);
  }
  assert.equal(RULES.length, AMEX_VARIANTS.length + BUSINESS_VARIANTS.length + DEBIT_VARIANTS.length + 4);
  // the bare business names terminals have sent (visacorporate, mccorporate and so on) are named too
  for (const v of ['visacorporate', 'visabusiness', 'mccorporate', 'mcbusiness', 'visacommercial', 'mccommercial', 'visapurchasing', 'mcpurchasing', 'visafleet', 'mcfleet']) assert.ok(BUSINESS_VARIANTS.includes(v), v);
  for (const v of ['visadebit', 'visaelectron', 'electron', 'vpay', 'mcelectronic']) assert.ok(DEBIT_VARIANTS.includes(v), v);
  // the bodies sent carry NO servos_tier
  for (const r of built.rules) assert.equal('servos_tier' in r, false);
  assert.equal(built.tiers.length, built.rules.length);
  // online debit priced apart: the debit variants are written again with Ecommerce
  const apart = rulesFromRateCard({ ...UK, card_not_present_debit: { percent: 1.0, fixedPence: 10 } });
  const online = annotateRules(apart.rules, apart).filter((r) => r.servos_tier === 'card_not_present_debit');
  assert.deepEqual(online.map((r) => r.paymentMethod), [...DEBIT_VARIANTS]);
  for (const r of online) assert.deepEqual([r.shopperInteraction, r.splitLogic.commission], ['Ecommerce', { variablePercentage: 100, fixedAmount: 10 }]);
  // debit equal to credit: no debit variant rules at all
  const flat = rulesFromRateCard({ ...UK, card_present_debit: { percent: 0.9, fixedPence: null } });
  assert.equal(flat.rules.filter((r) => r.shopperInteraction === 'POS').length, 0);
  assert.equal(flat.rules.length, AMEX_VARIANTS.length + BUSINESS_VARIANTS.length + 4);
  // a blank debit row inherits credit: the same
  assert.equal(rulesFromRateCard({ ...UK, card_present_debit: {} }).rules.length, flat.rules.length);
  // a base tier with no price: nothing is written and lacking names it
  assert.deepEqual(rulesFromRateCard({ ...UK, keyed: {} }), { rules: [], tiers: [], lacking: ['keyed'], refundPolicy: 'none', warnings: [] });
  // USD: the currency on every rule
  for (const r of rulesFromRateCard(UK, { currency: 'usd' }).rules) assert.equal(r.currency, 'USD');
});

// ── PRESERVED LOGIC ──────────────────────────────────────────────────────────
test('preserved logic: every key other than commission and the refund keys is copied from the profile read back; a difference is a warning', () => {
  const known = { commission: { variablePercentage: 85 }, ...DEFAULT_SPLIT_LOGIC, refund: 'deductAccordingToSplitRatio', refundCostAllocation: 'deductFromLiableAccount', splitLogicId: 'SL1' };
  const profile = { splitConfigurationId: 'SC1', rules: [
    { ruleId: 'R1', currency: 'GBP', paymentMethod: 'amex', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { ...known, commission: { variablePercentage: 250, fixedAmount: 10 } } },
    { ruleId: 'R2', currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: known },
  ] };
  const p = preservedLogicFrom(profile);
  assert.deepEqual(p, { logic: { ...DEFAULT_SPLIT_LOGIC }, warnings: [], source: 'profile' });
  const gen = rulesFromRateCard(UK, { preserved: p.logic });
  for (const r of gen.rules) {
    for (const k of Object.keys(DEFAULT_SPLIT_LOGIC)) assert.equal(r.splitLogic[k], DEFAULT_SPLIT_LOGIC[k], `${ruleKey(r)} ${k}`);
    assert.equal(r.splitLogic.refund, 'deductFromOneBalanceAccount');
    assert.equal(r.splitLogic.refundCostAllocation, 'deductFromLiableAccount');
    assert.equal('splitLogicId' in r.splitLogic, false, 'Adyen ids are never sent back');
    assert.deepEqual(Object.keys(r.splitLogic)[0], 'commission');
  }
  // the policy word drives the refund key; the pilot ratio stays one word away
  assert.equal(rulesFromRateCard(UK, { refundPolicy: 'ratio' }).rules[0].splitLogic.refund, REFUND_BOOKING.ratio);
  assert.equal(rulesFromRateCard(UK, { refundPolicy: 'none' }).rules[0].splitLogic.refund, REFUND_BOOKING.none);
  assert.equal(rulesFromRateCard(UK, { refundPolicy: 'junk' }).rules[0].splitLogic.refund, REFUND_BOOKING[REFUND_FEE_POLICY]);
  assert.equal(REFUND_FEE_POLICY, 'none');
  assert.deepEqual([refundPolicyOf('ratio'), refundPolicyOf('RATIO'), refundPolicyOf(null), refundPolicyOf('x')], ['ratio', 'ratio', 'none', 'none']);
  assert.deepEqual([rowRefundPolicy({ fee_refund_policy: 'ratio' }), rowRefundPolicy({}), rowRefundPolicy(null)], ['ratio', 'none', 'none']);
  // a remainder kept by the platform is REPORTED, and copied only because the caller passes it on
  const odd = { rules: [{ paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { ...known, remainder: 'addToLiableAccount', acquiringFees: 'deductFromOneBalanceAccount' } }] };
  const q = preservedLogicFrom(odd);
  assert.deepEqual(q.warnings, [
    'remainder on Adyen is addToLiableAccount, ServOS has always written addToOneBalanceAccount.',
    'acquiringFees is set on Adyen (deductFromOneBalanceAccount) and ServOS never set it.',
  ]);
  assert.equal(q.logic.remainder, 'addToLiableAccount');
  assert.equal(q.logic.acquiringFees, 'deductFromOneBalanceAccount');
  for (const w of q.warnings) noDash(w);
  // a missing key is filled from the defaults; no profile at all is the defaults
  assert.equal(preservedLogicFrom({ rules: [{ paymentMethod: 'ANY', splitLogic: { commission: { variablePercentage: 1 } } }] }).logic.tip, 'addToOneBalanceAccount');
  assert.deepEqual(preservedLogicFrom(null), { logic: { ...DEFAULT_SPLIT_LOGIC }, warnings: [], source: 'defaults' });
  // an empty key read back (acquiringFees null) is not carried into every rule
  const sparse = preservedLogicFrom({ rules: [{ paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { ...known, acquiringFees: null, additionalCommission: {} } }] });
  assert.deepEqual(sparse.warnings, []);
  assert.equal('acquiringFees' in sparse.logic, false);
  assert.equal('additionalCommission' in sparse.logic, false);
  for (const r of rulesFromRateCard(UK, { preserved: sparse.logic }).rules) assert.equal('acquiringFees' in r.splitLogic, false);
  // the legacy charge is NEVER guessed from a tiered profile (review 15 Oct 2026): the 22 Sep
  // profile said 0.9% on its catch all and the bank took 0.85% on every card. Only a profile
  // whose every rule carries the same commission answers.
  assert.equal(legacyChargeFrom(profile), null, 'two prices: not flat');
  assert.equal(legacyChargeFrom({ rules: tieredCommissionRules('GBP', UK).rules }), null, 'the 8 rule profile of 22 Sep is not flat');
  assert.equal(legacyChargeFrom({ rules: built.rules }), null);
  assert.deepEqual(legacyChargeFrom({ rules: [{ paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { commission: { variablePercentage: 85 } } }] }), { percent_bp: 85, fixed_minor: 0, refund: 'none' });
  assert.deepEqual(legacyChargeFrom({ rules: [{ paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { commission: { variablePercentage: 80, fixedAmount: 5 } } }] }), { percent_bp: 80, fixed_minor: 5, refund: 'none' });
  // flat across several rules (the same price on every one) still answers
  assert.deepEqual(legacyChargeFrom({ rules: [
    { paymentMethod: 'amex', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { commission: { variablePercentage: 85 } } },
    { paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', splitLogic: { commission: { variablePercentage: 85, fixedAmount: 0 } } },
  ] }), { percent_bp: 85, fixed_minor: 0, refund: 'none' });
  assert.equal(legacyChargeFrom({ rules: [{ paymentMethod: 'amex', splitLogic: { commission: { variablePercentage: 80 } } }] }), null, 'no catch all');
  assert.equal(legacyChargeFrom(null), null);
});

// ── MATCHING ORDER ───────────────────────────────────────────────────────────
test('matching: Adyen\'s documented priority, frozen', () => {
  const pick = (variant, si, extra) => matchAdyenRule(facts(variant, si, extra), RULES);
  const t = (variant, si, extra) => tierOfRule(pick(variant, si, extra));
  assert.equal(t('visastandarddebit', 'POS'), 'card_present_debit', 'the variant rule beats the catch all');
  assert.equal(t('visastandarddebit', 'Moto'), 'keyed', 'a keyed debit card misses the POS variant rule and lands on ANY plus Moto');
  assert.equal(t('visastandarddebit', 'Ecommerce'), 'card_not_present');
  assert.equal(t('visastandarddebit', 'ContAuth'), 'card_not_present');
  assert.equal(t('mccommercialdebit', 'Moto'), 'amex', 'business beats keyed: payment method outranks interaction');
  assert.equal(t('mccommercialdebit', 'POS'), 'amex');
  assert.deepEqual(pick('mccommercialdebit', 'POS').splitLogic.commission, { variablePercentage: 250, fixedAmount: 10 });
  assert.equal(t('amex', 'Ecommerce'), 'amex', 'amex beats ANY plus Ecommerce');
  // every Amex name has its own rule and the matcher reads the VARIANT alone, so our pick equals
  // Adyen's whether Adyen reads 'amex' as the family or as one name (review 15 Oct 2026)
  assert.equal(pick('amexcorporate', 'POS').paymentMethod, 'amexcorporate');
  assert.equal(t('amexcorporate', 'POS'), 'amex');
  assert.equal(pick('amex_applepay', 'POS').paymentMethod, 'amex_applepay');
  assert.equal(pick('amex_applepay', 'Ecommerce').paymentMethod, 'amex_applepay');
  assert.equal(t('amex_applepay', 'Ecommerce'), 'amex');
  // an Amex name no rule names is the catch all on BOTH sides, never the amex family by its method
  assert.equal(pick('amexneverseen', 'POS').paymentMethod, 'ANY');
  assert.equal(t('amexneverseen', 'POS'), 'card_present');
  assert.equal(matchAdyenRule({ ...facts('visa', 'POS'), variant: null, method: 'amex' }, RULES).paymentMethod, 'ANY', 'the bare method alone never matches a name');
  assert.equal(t('visa_applepay', 'POS'), 'card_present', 'a wallet variant with no funding word is the catch all');
  assert.equal(t('visa_applepay', 'Ecommerce'), 'card_not_present');
  assert.equal(t('neverseenvariant', 'Ecommerce'), 'card_not_present');
  assert.equal(t('neverseenvariant', 'POS'), 'card_present');
  assert.equal(t('visastandardcredit', 'POS'), 'card_present');
  // a USD payment against GBP rules matches nothing: the stamp is null, never a guess
  assert.equal(matchAdyenRule(facts('visastandarddebit', 'POS', { currency: 'USD' }), RULES), null);
  assert.equal(matchAdyenRule(facts('visastandarddebit', 'POS', { currency: null }), RULES), null);
  // a funding source fact matches ANY only (no rule names one), so it changes nothing
  assert.equal(t('visastandardcredit', 'POS', { fundingSource: 'debit' }), 'card_present');
  // the priority between two specific rules: payment method first, then usage, region, funding, interaction
  const two = [
    { currency: 'GBP', paymentMethod: 'visastandarddebit', shopperInteraction: 'ANY', fundingSource: 'ANY', servos_tier: 'by_variant', splitLogic: {} },
    { currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'POS', fundingSource: 'debit', cardUsageType: 'consumer', cardRegion: 'domestic', servos_tier: 'by_everything_else', splitLogic: {} },
    { currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'ANY', servos_tier: 'catch_all', splitLogic: {} },
  ];
  assert.equal(tierOfRule(matchAdyenRule(facts('visastandarddebit', 'POS', { fundingSource: 'debit', cardUsageType: 'consumer', cardRegion: 'domestic' }), two)), 'by_variant');
  assert.equal(tierOfRule(matchAdyenRule(facts('visastandardcredit', 'POS', { fundingSource: 'debit', cardUsageType: 'consumer', cardRegion: 'domestic' }), two)), 'by_everything_else');
  assert.equal(tierOfRule(matchAdyenRule(facts('visastandardcredit', 'POS'), two)), 'catch_all', 'an unknown usage or region matches ANY only');
  // funding beats interaction
  const fi = [
    { currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'POS', fundingSource: 'ANY', servos_tier: 'interaction', splitLogic: {} },
    { currency: 'GBP', paymentMethod: 'ANY', shopperInteraction: 'ANY', fundingSource: 'debit', servos_tier: 'funding', splitLogic: {} },
  ];
  assert.equal(tierOfRule(matchAdyenRule(facts('visa', 'POS', { fundingSource: 'debit' }), fi)), 'funding');
  assert.equal(matchAdyenRule(null, RULES), null);
  assert.equal(matchAdyenRule(facts('visa', 'POS'), null), null);
});

// ── THE VARIANT TABLE ────────────────────────────────────────────────────────
test('variant table: every variant by every interaction gives the tier and the pence on 10.00 and 2.50', () => {
  const debitLike = [...DEBIT_VARIANTS];
  const creditLike = ['mcpremiumcredit', 'visapremiumcredit', 'mcsuperpremiumcredit', 'visastandardcredit', 'mcstandardcredit', 'visasuperpremiumcredit', 'mccredit', 'visa', 'mc', 'visa_applepay', 'mc_applepay', 'visa_googlepay', 'mc_googlepay', 'somethingnew'];
  const expect = {
    card_present_debit: { tier: 'card_present_debit', on1000: 9, on250: 2 },     // 85bp: 8.5 -> 9; 2.125 -> 2
    card_present: { tier: 'card_present', on1000: 9, on250: 2 },                 // 90bp: 9; 2.25 -> 2
    card_not_present: { tier: 'card_not_present', on1000: 21, on250: 13 },       // 110bp plus 10: 11 plus 10; 2.75 -> 3 plus 10
    keyed: { tier: 'keyed', on1000: 32, on250: 16 },                             // 220bp plus 10: 22 plus 10; 5.5 -> 6 plus 10
    amex: { tier: 'amex', on1000: 35, on250: 16 },                               // 250bp plus 10: 25 plus 10; 6.25 -> 6 plus 10
  };
  const check = (variant, si, key) => {
    const r = matchAdyenRule(facts(variant, si), RULES);
    assert.ok(r, `${variant} ${si}`);
    assert.equal(tierOfRule(r), expect[key].tier, `${variant} ${si}`);
    assert.equal(feeFor(1000, r.splitLogic.commission), expect[key].on1000, `${variant} ${si} on 10.00`);
    assert.equal(feeFor(250, r.splitLogic.commission), expect[key].on250, `${variant} ${si} on 2.50`);
  };
  for (const v of debitLike) { check(v, 'POS', 'card_present_debit'); check(v, 'Ecommerce', 'card_not_present'); check(v, 'ContAuth', 'card_not_present'); check(v, 'Moto', 'keyed'); }
  for (const v of creditLike) { check(v, 'POS', 'card_present'); check(v, 'Ecommerce', 'card_not_present'); check(v, 'ContAuth', 'card_not_present'); check(v, 'Moto', 'keyed'); }
  for (const v of BUSINESS_VARIANTS) for (const si of ['POS', 'Ecommerce', 'ContAuth', 'Moto']) check(v, si, 'amex');
  for (const v of AMEX_VARIANTS) for (const si of ['POS', 'Ecommerce', 'ContAuth', 'Moto']) check(v, si, 'amex');
  // the two regular expressions the profile reader uses agree with the lists
  for (const v of DEBIT_VARIANTS) assert.ok(DEBIT_VARIANT_RE.test(v) && !BUSINESS_VARIANT_RE.test(v), v);
  for (const v of BUSINESS_VARIANTS) assert.ok(BUSINESS_VARIANT_RE.test(v), v);
  assert.deepEqual(Object.keys(VARIANT_TABLE), ['debit', 'business', 'amex']);
  for (const v of AMEX_VARIANTS) assert.ok(v.startsWith('amex'), v);
});

// ── BOTH SIDES: THE FACTS OF A STORED EVENT ──────────────────────────────────
test('facts: a terminal event resolves to POS, an online event to Ecommerce, keyed and stored card from their marks', () => {
  const terminal = { amount: { value: 1000, currency: 'GBP' }, paymentMethod: 'mc', merchantReference: 'tj-123', additionalData: { paymentMethod: 'mc', paymentMethodVariant: 'mcstandarddebit', cardSummary: '1234', posEntryMode: 'CLESS_CHIP' } };
  assert.deepEqual(paymentFacts(terminal, 'pos'), { currency: 'GBP', method: 'mc', variant: 'mcstandarddebit', fundingSource: null, cardUsageType: 'unknown', cardRegion: null, shopperInteraction: 'POS' });
  const online = { amount: { value: 1000, currency: 'GBP' }, paymentMethod: 'visa', additionalData: { paymentMethod: 'visa', fundingSource: 'DEBIT', 'checkout.cardAddedBrand': 'visa', isCardCommercial: 'unknown' } };
  assert.deepEqual(paymentFacts(online, null), { currency: 'GBP', method: 'visa', variant: 'visa', fundingSource: 'debit', cardUsageType: 'unknown', cardRegion: null, shopperInteraction: 'Ecommerce' });
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa' } }, 'booking').shopperInteraction, 'Ecommerce');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', shopperInteraction: 'Ecommerce' } }, 'pos').shopperInteraction, 'Ecommerce', 'Adyen\'s own word wins');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', shopperInteraction: 'POS' } }, 'online').shopperInteraction, 'POS');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', shopperInteraction: 'Moto' } }, 'pos').shopperInteraction, 'Moto');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', posEntryMode: 'KEYED' } }, 'pos').shopperInteraction, 'Moto');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', posEntryMode: 'manual entry' } }, 'pos').shopperInteraction, 'Moto');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', shopperInteraction: 'ContAuth' } }, 'booking').shopperInteraction, 'ContAuth');
  assert.equal(paymentFacts({ additionalData: { paymentMethod: 'visa', recurringProcessingModel: 'CardOnFile' } }, 'booking').shopperInteraction, 'ContAuth');
  assert.equal(paymentFacts({ additionalData: {} }, 'pos').variant, null);
  assert.equal(paymentFacts({ paymentMethod: 'AMEX', additionalData: {} }, 'pos').variant, 'amex');
  assert.equal(paymentFacts(null, null).shopperInteraction, 'POS');
  // the funding source words, Adyen's webhook spelling to the Management API's
  assert.deepEqual(['CREDIT', 'DEBIT', 'PREPAID', 'PREPAID_RELOADABLE', 'PREPAID_NONRELOADABLE', 'DEFFERED_DEBIT', 'DEFERRED_DEBIT', 'CHARGED', 'charge', '', null, 'odd'].map(fundingWord),
    ['credit', 'debit', 'prepaid', 'prepaid', 'prepaid', 'deferred_debit', 'deferred_debit', 'charged', 'charged', null, null, null]);
});

// ── WORDS ────────────────────────────────────────────────────────────────────
test('words: one plain line per rule in Adyen\'s order, the refund line, no dashes', () => {
  const lines = describeRules({ rules: built.rules }, { currency: 'GBP' });
  assert.equal(lines.length, built.rules.length + 4);
  // most specific first, Adyen's order: a variant with an interaction, then variants with ANY, then the interaction rules, then the catch all
  assert.match(lines[0], /^[A-Z].* cards, in person: 0\.85%$/);
  assert.ok(lines.slice(0, DEBIT_VARIANTS.length).includes('Maestro cards, in person: 0.85%'));
  const amexLines = lines.slice(DEBIT_VARIANTS.length, DEBIT_VARIANTS.length + AMEX_VARIANTS.length);
  assert.ok(amexLines.includes('American Express cards, any channel: 2.5% plus 10p'), 'the Amex names follow the debit variant rules');
  assert.ok(lines.includes('American Express cards through Apple Pay, any channel: 2.5% plus 10p'));
  assert.ok(lines.includes('Visa corporate cards, any channel: 2.5% plus 10p'));
  assert.ok(lines.indexOf('American Express cards, any channel: 2.5% plus 10p') < lines.indexOf('Any other card, keyed in: 2.2% plus 10p'));
  assert.ok(lines.includes('Mastercard standard debit cards, in person: 0.85%'));
  assert.ok(lines.includes('Visa commercial super premium debit cards, any channel: 2.5% plus 10p'));
  assert.ok(lines.includes('Any other card, keyed in: 2.2% plus 10p'));
  assert.ok(lines.includes('Any other card, online: 1.1% plus 10p'));
  assert.ok(lines.includes('Any other card, stored card: 1.1% plus 10p'));
  assert.equal(lines[built.rules.length - 1], 'Any other card, any channel: 0.9%', 'the catch all is the last rule');
  assert.deepEqual(lines.slice(-4), [
    'Refunds: the venue keeps no fee back.',
    "Adyen's own fees: paid by ServOS.",
    'The rest of each sale: to the venue.',
    'Disputes: taken from the venue, the dispute cost paid by ServOS.',
  ]);
  for (const l of lines) { noDash(l); assert.doesNotMatch(l, /commission/i, l); }
  // the variant rules come before the interaction rules, whatever order Adyen returns them in
  const shuffled = { rules: [...built.rules].reverse() };
  assert.deepEqual(describeRules(shuffled, { currency: 'GBP' }), lines);
  // words for the names
  assert.equal(variantWords('visastandarddebit'), 'Visa standard debit cards');
  assert.equal(variantWords('mccommercialcredit'), 'Mastercard commercial credit cards');
  assert.equal(variantWords('maestrouk'), 'Maestro UK cards');
  assert.equal(variantWords('visa_applepay'), 'Visa cards through Apple Pay');
  assert.equal(variantWords('mc_googlepay'), 'Mastercard cards through Google Pay');
  assert.equal(variantWords('amex'), 'American Express cards');
  assert.equal(variantWords('amexcorporate'), 'American Express corporate cards');
  assert.equal(variantWords('amex_applepay'), 'American Express cards through Apple Pay');
  assert.equal(variantWords('visaelectron'), 'Visa Electron cards');
  assert.equal(variantWords('vpay'), 'V Pay cards');
  assert.equal(variantWords('mcelectronic'), 'Mastercard electronic cards');
  assert.equal(variantWords('ANY'), 'Any other card');
  assert.equal(variantWords('zzpay'), 'zzpay cards');
  assert.equal(commissionWords({ variablePercentage: 110, fixedAmount: 10 }, 'USD'), '1.1% plus 10c');
  assert.equal(commissionWords({ variablePercentage: 0 }), 'nothing');
  assert.equal(refundWords({ refund: 'deductAccordingToSplitRatio' }), 'Refunds: the fee comes back in proportion.');
  assert.equal(refundWords({}), 'Refunds: not set on Adyen.');
  assert.equal(ruleWords({ paymentMethod: 'ANY', shopperInteraction: 'POS', fundingSource: 'debit', splitLogic: { commission: { variablePercentage: 85 } } }), 'Any other card (debit), in person: 0.85%');
  // the old 8 rule profile reads in words too
  const old = describeRules({ rules: tieredCommissionRules('GBP', UK).rules });
  assert.ok(old.includes('Any other card (debit), in person: 0.85%'));
  assert.ok(old.includes('Any other card (prepaid), in person: 0.85%'));
  assert.equal(old.at(-4), 'Refunds: the fee comes back in proportion.');
  // BEFORE and AFTER: the old profile against the new rules
  const diff = ruleDiff({ rules: tieredCommissionRules('GBP', UK).rules }, built.rules, { currency: 'GBP' });
  assert.equal(diff.counts.now, 8);
  assert.equal(diff.counts.next, built.rules.length);
  assert.equal(diff.counts.kept, 0, 'the refund booking changed on every rule, so nothing is kept as is');
  assert.ok(diff.lines.some((l) => l === 'Removed: Any other card (debit), in person: 0.85%'));
  assert.ok(diff.lines.some((l) => l === 'Added: Mastercard standard debit cards, in person: 0.85%'));
  for (const l of diff.lines) noDash(l);
  // the same rules again: nothing added or removed
  const same = ruleDiff({ rules: built.rules }, built.rules);
  assert.deepEqual([same.counts.removed, same.counts.added, same.counts.kept, same.lines], [0, 0, built.rules.length, []]);
});

// ── READ BACK THROUGH adyenLink ──────────────────────────────────────────────
test('adyenLink reads the variant profile back into the six tiers, and ratesOnAdyen matches the card it came from', () => {
  const profile = { splitConfigurationId: 'SC_NEW', rules: built.rules.map((r, i) => ({ ...r, ruleId: `R${i}`, splitLogic: { ...r.splitLogic, splitLogicId: `SL${i}` } })) };
  assert.deepEqual(profileTiers(profile), {
    card_present: { percent: 0.9, fixedPence: 0 }, card_not_present: { percent: 1.1, fixedPence: 10 }, amex: { percent: 2.5, fixedPence: 10 }, keyed: { percent: 2.2, fixedPence: 10 },
    card_present_debit: { percent: 0.85, fixedPence: 0 },
  });
  assert.equal(tiersMatch(profileTiers(profile), UK), true);
  const on = ratesOnAdyen(profile, UK, 'GBP');
  assert.deepEqual([on.matches, on.missing, on.remainder, on.rules], [true, false, 'addToOneBalanceAccount', built.rules.length]);
  // the old 8 rule profile still matches exactly as before
  assert.equal(ratesOnAdyen({ rules: tieredCommissionRules('GBP', UK).rules }, UK, 'GBP').matches, true);
  // a different debit price on the card: no match
  assert.equal(ratesOnAdyen(profile, { ...UK, card_present_debit: { percent: 0.8, fixedPence: null } }, 'GBP').matches, false);
  // a rule missing from the profile: no match
  assert.equal(ratesOnAdyen({ rules: profile.rules.slice(1) }, UK, 'GBP').matches, false);
  // the preview with the variant rules: the row table and the rule lines
  const p = ratesChangePreview({ rules: tieredCommissionRules('GBP', UK).rules }, UK, 'GBP', { rules: built.rules });
  assert.deepEqual([p.same, p.canSend, p.rulesNow, p.rulesNext], [false, true, 8, built.rules.length]);
  assert.deepEqual(p.lines, ['The rates are the same, but the rules on Adyen are not the ones ServOS writes. Sending puts that right.']);
  assert.ok(p.ruleLines.length > 8);
  assert.ok(p.ruleLines.every((l) => /^(Removed|Added): /.test(l)));
  // already the variant profile: nothing to send, no rule lines
  const q = ratesChangePreview(profile, UK, 'GBP', { rules: built.rules });
  assert.deepEqual([q.same, q.lines, q.ruleLines], [true, ['Adyen already holds these rates. Sending changes nothing.'], []]);
  // no option: as it always was, with an empty ruleLines
  assert.deepEqual(ratesChangePreview({ rules: tieredCommissionRules('GBP', UK).rules }, UK, 'GBP').ruleLines, []);
  // a lacking tier with the option: still nothing to send
  assert.deepEqual([ratesChangePreview(null, { ...UK, keyed: {} }, 'GBP', { rules: built.rules }).canSend, ratesChangePreview(null, { ...UK, keyed: {} }, 'GBP', { rules: built.rules }).rulesNext], [false, 0]);
});

// ── THE RULES THAT GOVERN AN INSTANT ─────────────────────────────────────────
test('rulesForInstant: the entry with the latest from at or before the instant; the list is appended, never replaced', () => {
  const a = { from: '2026-10-15T20:00:00Z', profile_id: 'SC_A', refund_policy: 'none', rules: RULES };
  const b = { from: '2026-11-01T09:00:00Z', profile_id: 'SC_B', refund_policy: 'none', rules: RULES };
  assert.equal(rulesForInstant([a, b], '2026-10-15T20:00:00Z'), a);
  assert.equal(rulesForInstant([a, b], '2026-10-20T00:00:00Z'), a);
  assert.equal(rulesForInstant([a, b], '2026-11-01T09:00:00Z'), b);
  assert.equal(rulesForInstant([b, a], '2026-12-01T00:00:00Z'), b);
  assert.equal(rulesForInstant([a, b], '2026-10-15T19:59:59Z'), null);
  assert.equal(rulesForInstant(a, '2026-10-16T00:00:00Z'), a, 'a single entry is accepted too');
  assert.equal(rulesForInstant([], '2026-10-16T00:00:00Z'), null);
  assert.equal(rulesForInstant([a], 'not a date'), null);
  assert.equal(latestRulesEntry([a, b]), b);
  assert.equal(latestRulesEntry(null), null);
});

// ── WEBHOOK SETTINGS: ADDED, NEVER REPLACED ──────────────────────────────────
test('webhook settings: the body sent keeps every property already true and both event code lists; what was lost is named', () => {
  const before = { includeEventCodes: ['AUTHORISATION', 'CAPTURE'], excludeEventCodes: ['REPORT_AVAILABLE'], properties: { includeSubvariant: true, includeFundingSource: false, includeShopperInteraction: false, somethingElse: true } };
  const body = mergedWebhookSettings(before, ['includeFundingSource']);
  assert.deepEqual(body, { includeEventCodes: ['AUTHORISATION', 'CAPTURE'], excludeEventCodes: ['REPORT_AVAILABLE'], properties: { includeSubvariant: true, includeFundingSource: true, includeShopperInteraction: false, somethingElse: true } });
  assert.notEqual(body.properties, before.properties, 'a copy, never the object read');
  assert.deepEqual(before.properties.includeFundingSource, false, 'the object read is untouched');
  assert.deepEqual(mergedWebhookSettings(null, ['a']), { properties: { a: true } });
  assert.deepEqual(mergedWebhookSettings({ properties: { a: true } }, []), { properties: { a: true } });
  // after the PATCH: every key that was true must still be true, and the lists unchanged
  assert.deepEqual(lostWebhookSettings(before, body), { lost: [], lists: [], ok: true });
  assert.deepEqual(lostWebhookSettings(before, { properties: { includeFundingSource: true } }), { lost: ['includeSubvariant', 'somethingElse'], lists: ['includeEventCodes', 'excludeEventCodes'], ok: false });
  assert.deepEqual(lostWebhookSettings(before, { ...before, includeEventCodes: ['CAPTURE', 'AUTHORISATION'] }).lists, [], 'order does not matter');
  assert.deepEqual(lostWebhookSettings(null, null), { lost: [], lists: [], ok: true });
});

// ── MIRRORS ──────────────────────────────────────────────────────────────────
test('mirrors: the Deno copy is byte identical to this module below its first line, and node loads it', async () => {
  const js = read('src/lib/payments/adyenRules.js').split('\n').slice(1).join('\n');
  const deno = read('supabase/functions/_shared/adyenRules.js').split('\n').slice(1).join('\n');
  assert.equal(deno, js);
  const d = await import('../../../supabase/functions/_shared/adyenRules.js');
  const theirs = d.rulesFromRateCard(UK, { currency: 'GBP' });
  assert.deepEqual(theirs, built);
  assert.equal(d.tierOfRule(d.matchAdyenRule(facts('mcstandarddebit', 'POS'), RULES)), 'card_present_debit');
  assert.equal(d.REFUND_FEE_POLICY, REFUND_FEE_POLICY);
  assert.equal(d.LEGACY_FEE_RULE, LEGACY_FEE_RULE);
  assert.equal(d.RULES_FEE_RULE_PREFIX, RULES_FEE_RULE_PREFIX);
  assert.equal(typeof d.stampForPayment, 'function');
  assert.equal(typeof d.restampForAmount, 'function');
  assert.equal(typeof d.legacyCommission, 'function');
  assert.equal(typeof d.keepExistingStamp, 'function');
  assert.equal(typeof d.mergedWebhookSettings, 'function');
  assert.deepEqual(d.AMEX_VARIANTS, AMEX_VARIANTS);
  // neither copy reaches for Deno, Supabase or the clock
  for (const src of [read('src/lib/payments/adyenRules.js'), read('supabase/functions/_shared/adyenRules.js')]) {
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Deno\.|supabase|fetch\(|new Date\(\)|Date\.now\(|import /);
    assert.doesNotMatch(code, /[–—]/, 'no dashes in any string');
  }
  // the venue fee helpers (both copies) read the same policy word
  const vf = await import('./venueFees.js');
  assert.equal(vf.rowRefundPolicy({ fee_refund_policy: 'ratio' }), rowRefundPolicy({ fee_refund_policy: 'ratio' }));
  assert.equal(vf.rowRefundPolicy({}), rowRefundPolicy({}));
  // the stamp and restamp helpers are exercised in webhookStamp.test.js
  assert.equal(typeof stampForPayment, 'function');
  assert.equal(typeof restampForAmount, 'function');
  assert.equal(typeof legacyCommission, 'function');
});
