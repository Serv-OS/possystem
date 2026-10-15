// src/lib/payments/adyenRules.js
//
// ONE RULE ENGINE FOR BOTH SIDES (15 Oct 2026). Adyen charges the venue from
// the split configuration profile on its store; our ledger stamps
// adyen_payments.commission_minor. Until today the two were built apart (the
// profile from the rate card by funding source, the stamp by a classifier that
// never saw a funding source), so the bank and Back Office disagreed by a few
// pounds per settlement. From today:
//   rulesFromRateCard   builds the profile Adyen is sent FROM THE RATE CARD,
//                       keyed on the payment method VARIANT (present on both
//                       sides, priority 2 at Adyen) and the shopper interaction
//   matchAdyenRule      applies Adyen's documented rule priority to the SAME
//                       rule list on our side, so the stamp equals the charge
//                       by construction
//   stampForPayment     what the webhook writes: rules after the cutover, the
//                       flat legacy charge before it, today's answer when the
//                       venue has not been cut over
// PURE: no Supabase, no network, no clock. MIRROR: supabase/functions/_shared/
// adyenRules.js carries the same code (Deno cannot import from src/). KEEP IN
// SYNC: adyenRules.test.js is the contract for both copies.
//
// ADYEN FACTS (docs.adyen.com, Management API v3, read 15 Oct 2026):
//   commission.variablePercentage is in BASIS POINTS, fixedAmount in MINOR
//   units. 0.9% is 90; 1.1% plus 10p is 110 and 10.
//   Conditions: currency (an ISO code, never ANY), paymentMethod (a variant or
//   ANY), fundingSource, shopperInteraction (Ecommerce, ContAuth, Moto, POS,
//   ANY), cardUsageType and cardRegion (optional, pilot).
//   Priority between matching rules: currency, payment method, card usage
//   type, card region, funding source, shopper interaction; within a priority
//   the more specific rule wins. A rule applies only when every condition
//   matches. Always keep a catch all rule.
//   Refund booking: deductFromOneBalanceAccount (the venue bears the refund
//   and keeps no fee back), deductFromLiableAccount (the platform bears it),
//   deductAccordingToSplitRatio (pilot, not for partial captures).
// No dashes in any user facing line.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const lower = (v) => str(v).toLowerCase();
const any = (v) => !str(v) || lower(v) === 'any';
const rateNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// ── THE REFUND DECISION (one word) ───────────────────────────────────────────
// 'none'   the venue bears the refund and keeps no fee back: what every
//          venue's bank has received since go live, what card processors do
//          as a rule, and not a pilot feature
// 'ratio'  the fee comes back in proportion (deductAccordingToSplitRatio),
//          what Back Office displayed until today
// Flip the constant, write the rates again, and both sides move together.
export const REFUND_FEE_POLICY = 'none';
export const REFUND_POLICIES = Object.freeze(['none', 'ratio']);
export const REFUND_BOOKING = Object.freeze({ none: 'deductFromOneBalanceAccount', ratio: 'deductAccordingToSplitRatio' });
export function refundPolicyOf(v) {
  const p = lower(v);
  return REFUND_POLICIES.includes(p) ? p : REFUND_FEE_POLICY;
}
// The policy a stored row reads with: null means 'none', because that is what
// Adyen did on every row written before the policy column existed.
export function rowRefundPolicy(row) {
  return refundPolicyOf(isObj(row) ? row.fee_refund_policy : null);
}

// The split logic every ServOS rule has always carried, other than the refund
// keys: Adyen's own fees paid by ServOS, the rest of each sale, tips and
// surcharges to the venue, chargebacks against the venue, and the costs of
// refunds and disputes paid by ServOS.
export const DEFAULT_SPLIT_LOGIC = Object.freeze({
  paymentFee: 'deductFromLiableAccount',
  remainder: 'addToOneBalanceAccount',
  tip: 'addToOneBalanceAccount',
  surcharge: 'addToOneBalanceAccount',
  chargeback: 'deductFromOneBalanceAccount',
  chargebackCostAllocation: 'deductFromLiableAccount',
});
// The two keys the generator sets on purpose; everything else is copied from
// the profile read back (preservedLogicFrom).
export const DELIBERATE_LOGIC_KEYS = Object.freeze(['commission', 'refund', 'refundCostAllocation']);
export const REFUND_COST_ALLOCATION = 'deductFromLiableAccount';

// ── VARIANTS (Adyen's paymentMethodVariant names, lower case) ────────────────
// Debit and prepaid consumer variants pay the debit price in person; prepaid
// pays debit (PREPAID_CARDS_PAY), deferred debit and charge cards carry no
// variant word and so pay the credit price. Business, commercial, corporate,
// purchasing and fleet cards pay the Amex and business price on every channel.
export const DEBIT_VARIANTS = Object.freeze([
  'mcstandarddebit', 'visastandarddebit', 'visapremiumdebit', 'visasuperpremiumdebit', 'mcsuperpremiumdebit', 'mcdebit', 'mcpremiumdebit',
  'mcstandardprepaid', 'visastandardprepaid', 'mcprepaid', 'visaprepaid', 'maestro', 'maestrouk',
  // older debit names Adyen may still report
  'visadebit', 'visaelectron', 'electron', 'vpay', 'mcelectronic',
]);
export const BUSINESS_VARIANTS = Object.freeze([
  // seen on live payments in the 30 days to 15 Oct 2026
  'mccommercialdebit', 'visacommercialdebit', 'mccommercialcredit', 'visacorporatecredit', 'mcfleetcredit', 'visacommercialsuperpremiumcredit',
  'visacommercialpremiumcredit', 'visacommercialpremiumdebit', 'visacommercialcredit', 'visacorporatedebit', 'visacommercialsuperpremiumdebit',
  // Adyen's UK names not yet seen
  'mccorporatecredit', 'mccorporatedebit', 'mcpurchasingcredit', 'mcpurchasingdebit', 'visapurchasingcredit', 'visapurchasingdebit',
  'visabusinesscredit', 'visabusinessdebit', 'mcbusinesscredit', 'mcbusinessdebit', 'mcfleetdebit', 'visafleetcredit', 'visafleetdebit',
  // the bare names with no credit or debit word, which terminals have sent (webhook field notes, 19 Aug 2026)
  'visacorporate', 'visabusiness', 'visacommercial', 'visapurchasing', 'visafleet', 'mccorporate', 'mcbusiness', 'mccommercial', 'mcpurchasing', 'mcfleet',
]);
// Every Amex name Adyen reports. Whether a rule naming 'amex' also catches
// 'amexcorporate' at Adyen is not documented, so each name gets its own rule
// and the matcher compares the variant alone: equal whichever way Adyen reads it.
export const AMEX_VARIANTS = Object.freeze([
  'amex', 'amexcorporate', 'amexcommercial', 'amexconsumer', 'amexdebit', 'amexprepaid', 'amexprepaidreloadable', 'amexsmallbusiness', 'amexbusiness',
  'amex_applepay', 'amex_googlepay',
]);
export const VARIANT_TABLE = Object.freeze({ debit: DEBIT_VARIANTS, business: BUSINESS_VARIANTS, amex: AMEX_VARIANTS });
export const DEBIT_VARIANT_RE = /(debit|prepaid|maestro|electron|vpay)/;
export const BUSINESS_VARIANT_RE = /(business|corporate|commercial|purchasing|fleet)/;

export const INTERACTIONS = Object.freeze(['Ecommerce', 'ContAuth', 'Moto', 'POS']);
// The interaction a tier is written for; the catch all carries ANY.
const TIER_INTERACTION = Object.freeze({ keyed: 'Moto', card_not_present: 'Ecommerce' });

// ── COMMISSION, UNITS ────────────────────────────────────────────────────────
// A tier's price as Adyen's commission block: percent times 100 is basis
// points, pence as they are. A tier priced 0 and 0 is an explicit zero,
// because Adyen marks commission required on every rule.
export function commissionFromTier(tier) {
  const c = isObj(tier) ? tier : {};
  const pct = rateNumber(c.percent);
  const fix = rateNumber(c.fixedPence ?? c.fixed_pence);
  const out = {};
  if (pct !== null && pct > 0) out.variablePercentage = Math.round(pct * 100);
  if (fix !== null && fix > 0) out.fixedAmount = Math.round(fix);
  return Object.keys(out).length ? out : { variablePercentage: 0 };
}
// The fee on an amount under a commission block: basis points on the amount,
// rounded half up, plus the fixed pence. Null when there is no block.
export function feeFor(amountMinor, commission) {
  if (!isObj(commission)) return null;
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const bp = Number(commission.variablePercentage ?? 0) || 0;
  const fixed = Math.round(Number(commission.fixedAmount ?? 0) || 0);
  return Math.floor((amount * bp) / 10000 + 0.5) + fixed;
}
const sameCommission = (a, b) => {
  const x = isObj(a) ? a : {}; const y = isObj(b) ? b : {};
  const n = (v) => Math.round(Number(v) || 0);
  return n(x.variablePercentage) === n(y.variablePercentage) && n(x.fixedAmount) === n(y.fixedAmount);
};

// ── THE RATE CARD AS TIERS ───────────────────────────────────────────────────
const BASE_TIERS = ['card_present', 'card_not_present', 'amex', 'keyed'];
const DEBIT_BASE = Object.freeze({ card_present_debit: 'card_present', card_not_present_debit: 'card_not_present' });
const tierOf = (tiers, tier) => (isObj(tiers) && isObj(tiers[tier]) ? tiers[tier] : {});
const priced = (c) => rateNumber(c.percent) !== null || rateNumber(c.fixedPence ?? c.fixed_pence) !== null;
// What a debit card pays on a tier: its own price, else the credit tier's.
function debitPrice(tiers, debitTier) {
  const own = tierOf(tiers, debitTier);
  return priced(own) ? own : tierOf(tiers, DEBIT_BASE[debitTier]);
}
function debitApart(tiers, debitTier) {
  const own = tierOf(tiers, debitTier);
  return priced(own) && !sameCommission(commissionFromTier(own), commissionFromTier(tierOf(tiers, DEBIT_BASE[debitTier])));
}

// ── WHAT TO CARRY OVER FROM THE PROFILE ON THE STORE ─────────────────────────
// The catch all rule's split logic (else the first rule's), every key other
// than the three we set on purpose. Warnings name anything that is not
// today's known logic, so the preview says it line by line before carrying
// it over. Null profile: the defaults, no warnings.
export function preservedLogicFrom(profile) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  const catchAll = rules.find((r) => any(r.paymentMethod) && any(r.shopperInteraction) && any(r.fundingSource) && any(r.cardUsageType) && any(r.cardRegion)) || rules[0] || null;
  const logic = isObj(catchAll?.splitLogic) ? catchAll.splitLogic : null;
  if (!logic) return { logic: { ...DEFAULT_SPLIT_LOGIC }, warnings: [], source: 'defaults' };
  const out = {};
  const warnings = [];
  for (const [k, v] of Object.entries(logic)) {
    if (DELIBERATE_LOGIC_KEYS.includes(k)) continue;
    if (/Id$/.test(k)) continue;   // splitLogicId and friends are Adyen's, never sent back
    if (v === null || v === undefined || v === '' || (isObj(v) && !Object.keys(v).length)) continue;   // an empty key is not carried into every rule
    out[k] = v;
    if (k in DEFAULT_SPLIT_LOGIC) {
      if (lower(v) !== lower(DEFAULT_SPLIT_LOGIC[k])) warnings.push(`${k} on Adyen is ${str(v)}, ServOS has always written ${DEFAULT_SPLIT_LOGIC[k]}.`);
    } else {
      warnings.push(`${k} is set on Adyen (${typeof v === 'string' ? v : 'a block'}) and ServOS never set it.`);
    }
  }
  for (const k of Object.keys(DEFAULT_SPLIT_LOGIC)) if (!(k in out)) out[k] = DEFAULT_SPLIT_LOGIC[k];
  return { logic: out, warnings, source: 'profile' };
}

function splitLogicWith(commission, preserved, refundPolicy) {
  const base = isObj(preserved) ? preserved : DEFAULT_SPLIT_LOGIC;
  const out = { commission };
  for (const [k, v] of Object.entries(base)) if (!DELIBERATE_LOGIC_KEYS.includes(k)) out[k] = v;
  out.refund = REFUND_BOOKING[refundPolicyOf(refundPolicy)];
  out.refundCostAllocation = REFUND_COST_ALLOCATION;
  return out;
}
const rule = (currency, paymentMethod, shopperInteraction, splitLogic) => ({
  currency: str(currency).toUpperCase() || 'GBP', fundingSource: 'ANY', paymentMethod, shopperInteraction, splitLogic,
});

// ── THE PROFILE FROM THE RATE CARD ───────────────────────────────────────────
//   tiers   { card_present: { percent, fixedPence | fixed_pence }, card_present_debit,
//             card_not_present, card_not_present_debit, amex, keyed }
// Answers { rules, tiers, lacking, refundPolicy, warnings }: rules are the
// bodies Adyen is sent, tiers the ServOS tier of each rule by index (never in
// the body), lacking the base tiers with no price (then rules is empty).
export function rulesFromRateCard(tiers, { currency = 'GBP', variants = VARIANT_TABLE, refundPolicy = REFUND_FEE_POLICY, preserved = null } = {}) {
  const t = isObj(tiers) ? tiers : {};
  const lacking = BASE_TIERS.filter((tier) => !priced(tierOf(t, tier)));
  const policy = refundPolicyOf(refundPolicy);
  if (lacking.length) return { rules: [], tiers: [], lacking, refundPolicy: policy, warnings: [] };
  const pres = isObj(preserved) ? preserved : null;
  const logic = (tier) => splitLogicWith(commissionFromTier(tier), pres, policy);
  const cur = str(currency).toUpperCase() || 'GBP';
  const rules = [];
  const names = [];
  const push = (tier, pm, si, price) => { rules.push(rule(cur, pm, si, logic(price))); names.push(tier); };
  // A. Amex, every channel, one rule per Amex name (the bare 'amex' first).
  // Payment method outranks interaction and funding.
  for (const v of (isObj(variants) && Array.isArray(variants.amex) ? variants.amex : AMEX_VARIANTS)) push('amex', v, 'ANY', tierOf(t, 'amex'));
  // B. Business cards, every channel, at the Amex and business price.
  for (const v of (isObj(variants) && Array.isArray(variants.business) ? variants.business : BUSINESS_VARIANTS)) push('amex', v, 'ANY', tierOf(t, 'amex'));
  // C. In person debit, only where the debit price differs from credit.
  const debitList = isObj(variants) && Array.isArray(variants.debit) ? variants.debit : DEBIT_VARIANTS;
  if (debitApart(t, 'card_present_debit')) for (const v of debitList) push('card_present_debit', v, 'POS', debitPrice(t, 'card_present_debit'));
  // D. Online debit, the same way.
  if (debitApart(t, 'card_not_present_debit')) for (const v of debitList) push('card_not_present_debit', v, 'Ecommerce', debitPrice(t, 'card_not_present_debit'));
  // E. Keyed in. F. Online. G. Stored card pays the online price.
  push('keyed', 'ANY', TIER_INTERACTION.keyed, tierOf(t, 'keyed'));
  push('card_not_present', 'ANY', TIER_INTERACTION.card_not_present, tierOf(t, 'card_not_present'));
  push('card_not_present', 'ANY', 'ContAuth', tierOf(t, 'card_not_present'));
  // H. The catch all: every other card on every other channel.
  push('card_present', 'ANY', 'ANY', tierOf(t, 'card_present'));
  return { rules, tiers: names, lacking: [], refundPolicy: policy, warnings: [] };
}

// A condition key for one rule: every condition Adyen matches on, ANY folded.
export function ruleKey(r) {
  const cond = (v) => (any(v) ? 'any' : lower(v));
  return [str(r?.currency).toUpperCase(), cond(r?.paymentMethod), cond(r?.shopperInteraction), cond(r?.fundingSource), cond(r?.cardUsageType), cond(r?.cardRegion)].join('|');
}

// Adyen's rules as returned (ruleIds included) with our tier name beside each
// one, matched on the conditions of what we sent. A returned rule we did not
// send carries servos_tier null, so the stamp refuses it (unrated), never
// guesses.
export function annotateRules(returnedRules, built) {
  const sent = Array.isArray(built?.rules) ? built.rules : [];
  const names = Array.isArray(built?.tiers) ? built.tiers : [];
  const byKey = new Map(sent.map((r, i) => [ruleKey(r), names[i] ?? null]));
  return (Array.isArray(returnedRules) ? returnedRules : []).filter(isObj).map((r) => ({ ...r, servos_tier: byKey.get(ruleKey(r)) ?? null }));
}
export function tierOfRule(r) {
  return str(r?.servos_tier) || null;
}

// ── THE FACTS OF ONE PAYMENT ─────────────────────────────────────────────────
// From the webhook item (additionalData) and the ledger channel, in this
// order of trust: the variant Adyen named, else the bare method; the funding
// source only when Adyen sent one (CREDIT, DEBIT, PREPAID and so on, mapped to
// the Management API's words); the interaction Adyen named, else keyed from
// the entry mode, else stored card, else online from the channel or the
// ecommerce only keys, else in person.
const FUNDING_WORDS = Object.freeze({
  credit: 'credit', debit: 'debit', prepaid: 'prepaid', prepaid_reloadable: 'prepaid', prepaid_nonreloadable: 'prepaid',
  deferred_debit: 'deferred_debit', deffered_debit: 'deferred_debit', charged: 'charged', charge: 'charged',
});
export function fundingWord(v) {
  const fs = lower(v).replace(/[\s-]+/g, '_');
  return fs ? (FUNDING_WORDS[fs] ?? null) : null;
}
const ONLINE_CHANNELS = ['online', 'booking', 'qr', 'gift', 'web', 'ecommerce'];
export function paymentFacts(item, channel) {
  const ad = isObj(item?.additionalData) ? item.additionalData : {};
  const method = lower(ad.paymentMethod ?? item?.paymentMethod) || null;
  const variant = lower(ad.paymentMethodVariant) || method;
  const siRaw = lower(ad.shopperInteraction ?? item?.shopperInteraction);
  const entry = lower(ad.posEntryMode);
  let shopperInteraction;
  if (siRaw === 'moto') shopperInteraction = 'Moto';
  else if (siRaw === 'contauth') shopperInteraction = 'ContAuth';
  else if (siRaw === 'ecommerce') shopperInteraction = 'Ecommerce';
  else if (siRaw === 'pos') shopperInteraction = 'POS';
  else if (entry.includes('key') || entry.includes('manual')) shopperInteraction = 'Moto';
  else if (str(ad.recurringProcessingModel)) shopperInteraction = 'ContAuth';
  else if (ONLINE_CHANNELS.includes(lower(channel))) shopperInteraction = 'Ecommerce';
  else if ('checkout.cardAddedBrand' in ad || 'threeds2.cardEnrolled' in ad || 'isCardCommercial' in ad || 'scaExemptionRequested' in ad) shopperInteraction = 'Ecommerce';
  else shopperInteraction = 'POS';
  return {
    currency: str(item?.amount?.currency).toUpperCase() || null,
    method, variant,
    fundingSource: fundingWord(ad.fundingSource ?? item?.fundingSource),
    cardUsageType: 'unknown',
    cardRegion: null,
    shopperInteraction,
  };
}

// ── WHICH RULE ADYEN PICKS ───────────────────────────────────────────────────
// Keep the rules whose currency equals the fact and whose every other
// condition is ANY or equals the fact (a null or unknown fact matches ANY
// only; a payment method condition matches the VARIANT alone, which is the
// bare method when Adyen sent no variant: paymentFacts sets it so).
// Among them the most specific wins, compared in Adyen's order: payment
// method, card usage type, card region, funding source, shopper interaction.
// Null when nothing matches: an unrated row is visible, a guessed one is not.
export function matchAdyenRule(facts, rules) {
  const f = isObj(facts) ? facts : {};
  const list = (Array.isArray(rules) ? rules : []).filter(isObj);
  const cur = str(f.currency).toUpperCase();
  const condOk = (cond, fact) => any(cond) || (!!str(fact) && lower(cond) === lower(fact));
  const pmOk = (cond) => any(cond) || (!!str(f.variant) && lower(cond) === lower(f.variant));
  const candidates = list.filter((r) => str(r.currency).toUpperCase() === cur && cur
    && pmOk(r.paymentMethod) && condOk(r.cardUsageType, f.cardUsageType) && condOk(r.cardRegion, f.cardRegion)
    && condOk(r.fundingSource, f.fundingSource) && condOk(r.shopperInteraction, f.shopperInteraction));
  if (!candidates.length) return null;
  const score = (r) => [r.paymentMethod, r.cardUsageType, r.cardRegion, r.fundingSource, r.shopperInteraction].map((c) => (any(c) ? 0 : 1));
  let best = candidates[0];
  let bestScore = score(best);
  for (const r of candidates.slice(1)) {
    const s = score(r);
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === bestScore[i]) continue;
      if (s[i] > bestScore[i]) { best = r; bestScore = s; }
      break;
    }
  }
  return best;
}

// ── THE RULES THAT GOVERNED AN INSTANT ───────────────────────────────────────
// merchant_adyen_accounts.adyen_rules is a list of { from, profile_id,
// refund_policy, rules } entries, appended on every write, never replaced. The
// entry with the latest from at or before the instant governs it.
export function rulesForInstant(adyenRules, atIso) {
  const list = (Array.isArray(adyenRules) ? adyenRules : isObj(adyenRules) ? [adyenRules] : []).filter((e) => isObj(e) && Array.isArray(e.rules));
  const at = Date.parse(String(atIso ?? ''));
  if (!list.length || !Number.isFinite(at)) return null;
  let best = null;
  for (const e of list) {
    const from = Date.parse(String(e.from ?? ''));
    if (!Number.isFinite(from) || from > at) continue;
    if (!best || from >= Date.parse(String(best.from))) best = e;
  }
  return best;
}
export function latestRulesEntry(adyenRules) {
  const list = (Array.isArray(adyenRules) ? adyenRules : isObj(adyenRules) ? [adyenRules] : []).filter((e) => isObj(e) && Array.isArray(e.rules));
  return list.reduce((b, e) => (!b || Date.parse(String(e.from)) >= Date.parse(String(b.from)) ? e : b), null);
}

// ── WHAT THE WEBHOOK STAMPS ──────────────────────────────────────────────────
//   payment  { amountMinor, authorisedAt, ok, facts }  (facts from paymentFacts)
//   venue    { adyen_rules, rates_live_at, legacy_charge } from the venue row
//   today    { rate_category, commission_minor } the pre cutover answer
//            (classifyRateCategory and commissionForAmount), kept for the
//            card type label and for a venue never cut over
// Answers { rate_category, commission_minor, fee_rule, fee_refund_policy }.
export const LEGACY_FEE_RULE = 'legacy_flat';
export const RULES_FEE_RULE_PREFIX = 'adyen_rules:';
export function legacyCommission(legacy) {
  if (!isObj(legacy)) return null;
  const bp = Number(legacy.percent_bp);
  const fixed = Number(legacy.fixed_minor ?? 0);
  if (!Number.isFinite(bp)) return null;
  return { variablePercentage: Math.round(bp), fixedAmount: Number.isFinite(fixed) ? Math.round(fixed) : 0 };
}
export function stampForPayment(payment, venue, today) {
  const p = isObj(payment) ? payment : {};
  const t = isObj(today) ? today : {};
  const base = { rate_category: t.rate_category ?? null, commission_minor: t.commission_minor ?? null, fee_rule: null, fee_refund_policy: null };
  const v = isObj(venue) ? venue : null;
  const live = Date.parse(String(v?.rates_live_at ?? ''));
  const at = Date.parse(String(p.authorisedAt ?? ''));
  if (!v || !Number.isFinite(live) || !Number.isFinite(at)) return base;
  const ok = p.ok !== false;
  if (at < live) {
    const legacy = legacyCommission(v.legacy_charge);
    if (!legacy) return base;
    return { rate_category: base.rate_category, commission_minor: ok ? feeFor(p.amountMinor, legacy) : null, fee_rule: LEGACY_FEE_RULE, fee_refund_policy: refundPolicyOf(v.legacy_charge?.refund) };
  }
  const entry = rulesForInstant(v.adyen_rules, p.authorisedAt);
  if (!entry) return base;
  const r = matchAdyenRule(p.facts, entry.rules);
  const feeRule = `${RULES_FEE_RULE_PREFIX}${str(entry.profile_id) || 'unknown'}`;
  const policy = refundPolicyOf(entry.refund_policy);
  if (!r || !tierOfRule(r)) return { rate_category: base.rate_category, commission_minor: null, fee_rule: `${feeRule}:unmatched`, fee_refund_policy: policy };
  return { rate_category: tierOfRule(r), commission_minor: ok ? feeFor(p.amountMinor, r.splitLogic?.commission) : null, fee_rule: feeRule, fee_refund_policy: policy };
}

// A CAPTURE that moves the amount (a tip landing, a hold captured below its
// hold) restamps the fee at the SAME rule the row was stamped with: the legacy
// charge, the rules entry the row names (else the one governing the capture
// instant, since an updated profile applies to a later capture), or today's
// answer for a venue never cut over. A row marked legacy whose capture lands
// at or after the cutover follows the new profile too, as Adyen does.
//   existing  { fee_rule, raw: { authorisation }, channel, fee_refund_policy }
const capturedUnderRules = (v, atIso) => !!v && Number.isFinite(Date.parse(String(v.rates_live_at ?? ''))) && Date.parse(String(atIso ?? '')) >= Date.parse(String(v.rates_live_at));
export function restampForAmount(existing, amountMinor, atIso, venue, todayCommission) {
  const e = isObj(existing) ? existing : {};
  const v = isObj(venue) ? venue : null;
  const base = { commission_minor: todayCommission ?? null, fee_rule: e.fee_rule ?? null, fee_refund_policy: e.fee_refund_policy ?? null };
  const feeRule = str(e.fee_rule);
  const list = Array.isArray(v?.adyen_rules) ? v.adyen_rules : [];
  if (feeRule === LEGACY_FEE_RULE && !(capturedUnderRules(v, atIso) && rulesForInstant(list, atIso))) {
    const legacy = legacyCommission(v?.legacy_charge);
    return legacy ? { ...base, commission_minor: feeFor(amountMinor, legacy) } : { ...base, commission_minor: null };
  }
  let entry = null;
  if (feeRule.startsWith(RULES_FEE_RULE_PREFIX)) {
    const id = feeRule.slice(RULES_FEE_RULE_PREFIX.length).split(':')[0];
    entry = list.find((x) => isObj(x) && str(x.profile_id) === id) || rulesForInstant(list, atIso);
  } else if (capturedUnderRules(v, atIso)) {
    entry = rulesForInstant(list, atIso);
  }
  if (!entry) return base;
  const facts = paymentFacts(e.raw?.authorisation ?? null, e.channel ?? null);
  const r = matchAdyenRule(facts, entry.rules);
  const rule = `${RULES_FEE_RULE_PREFIX}${str(entry.profile_id) || 'unknown'}`;
  const policy = refundPolicyOf(entry.refund_policy);
  if (!r || !tierOfRule(r)) return { commission_minor: null, fee_rule: `${rule}:unmatched`, fee_refund_policy: policy };
  return { commission_minor: feeFor(amountMinor, r.splitLogic?.commission), fee_rule: rule, fee_refund_policy: policy, rate_category: tierOfRule(r) };
}

// ── WORDS ────────────────────────────────────────────────────────────────────
const plainNumber = (n) => String(Number(Number(n).toFixed(4)));
export function commissionWords(commission, currency) {
  const c = isObj(commission) ? commission : {};
  const bp = Number(c.variablePercentage) || 0;
  const fix = Math.round(Number(c.fixedAmount) || 0);
  const minor = str(currency).toUpperCase() === 'USD' ? 'c' : 'p';
  const parts = [];
  if (bp > 0) parts.push(`${plainNumber(bp / 100)}%`);
  if (fix > 0) parts.push(`${fix}${minor}`);
  return parts.length ? parts.join(' plus ') : 'nothing';
}
const SCHEME_WORDS = [['maestro', 'Maestro'], ['amex', 'American Express'], ['visa', 'Visa'], ['mc', 'Mastercard'], ['electron', 'Visa Electron'], ['vpay', 'V Pay']];
const KIND_WORDS = [['superpremium', 'super premium'], ['premium', 'premium'], ['standard', 'standard'], ['commercial', 'commercial'], ['corporate', 'corporate'],
  ['business', 'business'], ['purchasing', 'purchasing'], ['fleet', 'fleet'], ['prepaid', 'prepaid'], ['reloadable', 'reloadable'], ['smallbusiness', 'small business'], ['consumer', 'consumer'],
  ['electronic', 'electronic'], ['electron', 'Electron'], ['debit', 'debit'], ['credit', 'credit'], ['uk', 'UK']];
const WALLET_WORDS = [['applepay', 'Apple Pay'], ['googlepay', 'Google Pay']];
export function variantWords(variant) {
  const v = lower(variant);
  if (!v || v === 'any') return 'Any other card';
  if (v === 'amex') return 'American Express cards';
  let rest = v;
  const words = [];
  const scheme = SCHEME_WORDS.find(([k]) => rest.startsWith(k));
  if (scheme) { words.push(scheme[1]); rest = rest.slice(scheme[0].length); }
  let wallet = null;
  for (const [k, w] of WALLET_WORDS) if (rest.includes(k)) { wallet = w; rest = rest.replace(k, ''); }
  rest = rest.replace(/_/g, '');
  let moved = true;
  while (rest && moved) {
    moved = false;
    for (const [k, w] of KIND_WORDS) if (rest.startsWith(k)) { words.push(w); rest = rest.slice(k.length); moved = true; break; }
  }
  if (rest) words.push(rest);
  if (!scheme && !wallet && words.length === 1) return `${variant} cards`;
  return `${words.join(' ')} cards${wallet ? ` through ${wallet}` : ''}`;
}
export const INTERACTION_WORDS = Object.freeze({ any: 'any channel', pos: 'in person', ecommerce: 'online', moto: 'keyed in', contauth: 'stored card' });
export function interactionWords(si) {
  return INTERACTION_WORDS[lower(si) || 'any'] ?? lower(si);
}
export function ruleWords(r, currency) {
  const who = variantWords(r?.paymentMethod);
  const funding = any(r?.fundingSource) ? '' : ` (${lower(r.fundingSource).replace('_', ' ')})`;
  const usage = any(r?.cardUsageType) ? '' : ` (${lower(r.cardUsageType)})`;
  return `${who}${funding}${usage}, ${interactionWords(r?.shopperInteraction)}: ${commissionWords(r?.splitLogic?.commission, currency ?? r?.currency)}`;
}
export function refundWords(logic) {
  const refund = lower(logic?.refund);
  if (refund === lower(REFUND_BOOKING.none)) return 'Refunds: the venue keeps no fee back.';
  if (refund === lower(REFUND_BOOKING.ratio)) return 'Refunds: the fee comes back in proportion.';
  if (refund === 'deductfromliableaccount') return 'Refunds: ServOS bears the refund.';
  return 'Refunds: not set on Adyen.';
}
// The rules in Adyen's priority order (most specific first), then the policy
// lines read from the catch all rule. One plain line each, no dashes.
export function describeRules(profile, { currency } = {}) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  const specificity = (r) => [r.paymentMethod, r.cardUsageType, r.cardRegion, r.fundingSource, r.shopperInteraction].map((c) => (any(c) ? 0 : 1));
  const sorted = [...rules].sort((a, b) => {
    const x = specificity(a); const y = specificity(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i] - x[i];
    return ruleKey(a).localeCompare(ruleKey(b));
  });
  const lines = sorted.map((r) => ruleWords(r, currency));
  const logic = preservedLogicFrom(profile).logic;
  const catchAll = rules.find((r) => any(r.paymentMethod) && any(r.shopperInteraction) && any(r.fundingSource)) || rules[0] || null;
  if (catchAll) {
    lines.push(refundWords(catchAll.splitLogic));
    lines.push(lower(logic.paymentFee) === 'deductfromliableaccount' ? "Adyen's own fees: paid by ServOS." : "Adyen's own fees: paid by the venue.");
    lines.push(lower(logic.remainder) === 'addtoonebalanceaccount' ? 'The rest of each sale: to the venue.' : 'The rest of each sale: kept by ServOS.');
    lines.push(lower(logic.chargeback) === 'deductfromonebalanceaccount' ? 'Disputes: taken from the venue, the dispute cost paid by ServOS.' : 'Disputes: borne by ServOS.');
  }
  return lines;
}

// BEFORE and AFTER, rule by rule: what the store holds now against what would
// be written. A rule is the same when its conditions and its commission and
// refund booking agree.
export function ruleDiff(profileNow, nextRules, { currency } = {}) {
  const now = (Array.isArray(profileNow?.rules) ? profileNow.rules : []).filter(isObj);
  const next = (Array.isArray(nextRules) ? nextRules : []).filter(isObj);
  const same = (a, b) => ruleKey(a) === ruleKey(b) && sameCommission(a.splitLogic?.commission, b.splitLogic?.commission) && lower(a.splitLogic?.refund) === lower(b.splitLogic?.refund);
  const removed = now.filter((a) => !next.some((b) => same(a, b)));
  const added = next.filter((b) => !now.some((a) => same(a, b)));
  const kept = next.filter((b) => now.some((a) => same(a, b)));
  const words = (list) => list.map((r) => ruleWords(r, currency));
  const lines = [
    ...words(removed).map((l) => `Removed: ${l}`),
    ...words(added).map((l) => `Added: ${l}`),
  ];
  return { removed: words(removed), added: words(added), kept: words(kept), lines, counts: { now: now.length, next: next.length, removed: removed.length, added: added.length, kept: kept.length } };
}

// The flat charge the store's profile took before the cutover, as
// legacy_charge is stored. ONLY a truly flat profile answers: every rule must
// carry the same commission and one of them must be the catch all. A tiered
// profile answers null, because its catch all is NOT what the bank took (the
// 8 rule profile of 22 Sep said 0.9% on its catch all and the bank took 0.85%
// on every card), and a guessed legacy charge would restate the history wrong.
export function legacyChargeFrom(profile) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  const catchAll = rules.find((r) => any(r.paymentMethod) && any(r.shopperInteraction) && any(r.fundingSource)) || null;
  const c = catchAll?.splitLogic?.commission;
  if (!isObj(c)) return null;
  if (!rules.every((r) => sameCommission(r.splitLogic?.commission, c))) return null;
  return { percent_bp: Math.round(Number(c.variablePercentage) || 0), fixed_minor: Math.round(Number(c.fixedAmount) || 0), refund: 'none' };
}

// ── WHAT AN AUTHORISATION REPLAY MAY OVERWRITE ───────────────────────────────
// stampForPayment is recomputed on every AUTHORISATION apply (the ?backfill=1
// replay). Two answers must never demote a row already stamped under the new
// scheme: (1) an unmarked answer (fee_rule null: the venue row could not be
// read, or has no cutover) on a row that carries a fee_rule, which would hand
// a restated row back to the restatement's where clause; (2) the legacy answer
// on a hold authorised before the cutover and CAPTURED at or after it, which
// Adyen charged under the new profile and the CAPTURE path stamped from the
// rules. In both cases the row keeps what it has.
//   existing  { fee_rule, fee_refund_policy, commission_minor, rate_category, captured_at }
export function keepExistingStamp(existing, stamped, venue) {
  const e = isObj(existing) ? existing : null;
  const s = isObj(stamped) ? stamped : { rate_category: null, commission_minor: null, fee_rule: null, fee_refund_policy: null };
  const had = str(e?.fee_rule);
  if (!had) return s;
  const keep = { rate_category: e.rate_category ?? s.rate_category ?? null, commission_minor: e.commission_minor ?? null, fee_rule: had, fee_refund_policy: e.fee_refund_policy ?? null };
  if (s.fee_rule === null || s.fee_rule === undefined) return keep;
  if (s.fee_rule === LEGACY_FEE_RULE && had.startsWith(RULES_FEE_RULE_PREFIX) && capturedUnderRules(isObj(venue) ? venue : null, e.captured_at)) return keep;
  return s;
}

// ── WEBHOOK SETTINGS, ADDED NEVER REPLACED ───────────────────────────────────
// The Management API takes the additionalSettings object as sent, so a PATCH
// that carries only the keys being switched on could drop the event code lists
// and every property already true (Include Subvariant, which the whole variant
// design rests on). The body sent is the object read seconds earlier with the
// asked keys set true.
export function mergedWebhookSettings(additionalSettings, keys) {
  const before = isObj(additionalSettings) ? additionalSettings : {};
  const props = isObj(before.properties) ? before.properties : {};
  const next = { ...props };
  for (const k of (Array.isArray(keys) ? keys : [])) if (str(k)) next[str(k)] = true;
  const out = { ...before, properties: next };
  if (Array.isArray(before.includeEventCodes)) out.includeEventCodes = [...before.includeEventCodes];
  if (Array.isArray(before.excludeEventCodes)) out.excludeEventCodes = [...before.excludeEventCodes];
  return out;
}
// The property keys that were true before and are false or missing after, and
// the event code lists that changed: what Peter must restore by hand if any.
export function lostWebhookSettings(before, after) {
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const bp = isObj(b.properties) ? b.properties : {};
  const ap = isObj(a.properties) ? a.properties : {};
  const lost = Object.keys(bp).filter((k) => bp[k] === true && ap[k] !== true);
  const sameList = (x, y) => JSON.stringify(Array.isArray(x) ? [...x].sort() : null) === JSON.stringify(Array.isArray(y) ? [...y].sort() : null);
  const lists = [];
  if (!sameList(b.includeEventCodes, a.includeEventCodes)) lists.push('includeEventCodes');
  if (!sameList(b.excludeEventCodes, a.excludeEventCodes)) lists.push('excludeEventCodes');
  return { lost, lists, ok: !lost.length && !lists.length };
}
