/**
 * kioskCheckout.js: the money and order rules behind the new kiosk design's Review and pay.
 *
 * CARD PATH RULE. Nothing here changes how an order is charged or saved. KioskApp's totals,
 * credits and submitOrder stay exactly as they are (kioskCardPathGuard.test.js). These
 * rules only:
 *   - stage a gift card, a promo code and a loyalty reward in the SAME shapes today's
 *     screens stage them (giftCommit.stageGiftCard, ScreenGiftPromo, ScreenLoyalty),
 *   - work out what to pass to submitOrder,
 *   - decide when Pay can be tapped, and
 *   - lay out the totals rows.
 *
 * REWARD MONEY has ONE implementation, src/lib/kioskLoyaltyReward.js (v5.8.67), shared with
 * today's kiosk: KioskApp works the loyalty credit out LIVE from the staged reward's type and
 * value against the current basket, submitOrder commits the redemption only when that credit
 * is above 0, and a tap is checked with kioskRewardTapCheck. Nothing in this file works out a
 * reward's money itself; it only calls those functions and says why a reward was refused.
 *
 * Pure apart from the imports below (all pure), so node:test can load it.
 */
import { stageGiftCard } from './giftCommit.js';
import { kioskOrderItem } from './kioskLine.js';
import { kioskRewardTapCheck, kioskRewardMissingItems, kioskLoyaltyCreditMinor } from './kioskLoyaltyReward.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ── Gift card ───────────────────────────────────────────────────────────────

/**
 * The amount a gift card should cover, in minor units: the order total after the reward and
 * after the promo. Unchanged KioskApp formulas then agree:
 *   promoCredit = min(P, max(0, T - L - G)),  grandTotal = max(0, T - L - G - promoCredit)
 * so a card with enough balance leaves nothing to pay, a short card leaves T - L - B - P,
 * and a promo that covers the order leaves 0 for the gift card (which is then removed).
 *
 * L here must be the reward's credit WITHOUT the gift card (kioskRewardCreditNoGift), not
 * KioskApp's loyaltyCredit: since v5.8.67 that live credit is capped at what the staged gift
 * card leaves due, so sizing the gift card from it would let the gift card take the reward's
 * share and hold the reward below its value on the next pass.
 */
export function giftDueMinor({ total, loyaltyCredit = 0, promoAmount = 0 } = {}) {
  const T = num(total);
  const L = num(loyaltyCredit);
  const afterReward = Math.max(0, T - L);
  const P = num(promoAmount) > 0 ? Math.min(num(promoAmount), afterReward) : 0;
  return Math.max(0, Math.round((T - L - P) * 100));
}

/**
 * The staged gift card against a new amount due. Keeps card_id, code, commit_key (the
 * idempotency key minted once at apply) and balance_at_apply; only applied and
 * remaining_balance move.
 */
export function restageGift(staged, dueMinor) {
  if (!isObj(staged)) return staged;
  const balance = Math.max(0, Math.round(num(staged.balance_at_apply)));
  const applied = Math.min(balance, Math.max(0, Math.round(num(dueMinor))));
  return { ...staged, applied, remaining_balance: balance - applied };
}

/**
 * What to do with a staged gift card after the order changed (Review and pay restaging).
 *   { action: 'none' }                  nothing to change
 *   { action: 'remove' }                nothing is left for it to cover (a staged card with 0
 *                                       applied would block a gift only order, F9)
 *   { action: 'restage', staged }       the same card against the new amount due
 * loyaltyCredit is the reward's credit with no gift card (kioskRewardCreditNoGift), see giftDueMinor.
 */
export function kioskGiftRestage({ staged, total = 0, loyaltyCredit = 0, promoAmount = 0 } = {}) {
  if (!isObj(staged)) return { action: 'none' };
  const due = giftDueMinor({ total, loyaltyCredit, promoAmount });
  if (due <= 0) return { action: 'remove' };
  const next = restageGift(staged, due);
  if (next.applied === staged.applied && next.remaining_balance === staged.remaining_balance) return { action: 'none' };
  return { action: 'restage', staged: next };
}

// ── Loyalty rewards (spending needs the text code, decision 7) ──────────────

/**
 * The rewards a verified customer can use, from the loyalty-otp verify response: earned
 * stamp card rewards first (already paid for), then points rewards. Mirrors ScreenLoyalty.
 * Only reward details are kept, never the customer's name, email, balance or tier.
 */
export function kioskRewardsFromVerify(data) {
  const loyalty = isObj(data?.loyalty) ? data.loyalty : {};
  const pointsOn = (loyalty.points_enabled ?? data?.points_enabled) !== false;
  const stampsOn = (loyalty.stamps_enabled ?? data?.stamps_enabled) !== false;
  const stamps = stampsOn ? (Array.isArray(loyalty.stamp_rewards) ? loyalty.stamp_rewards : []).map(sr => ({
    id: `stamp:${sr.program_id}`,
    label: sr.name,
    stamp: true,
    stampProgramId: sr.program_id,
    pointsCost: 0,
    type: sr.reward_type,
    value: isObj(sr.reward_config) ? sr.reward_config : {},
    available: sr.available,
  })) : [];
  const points = pointsOn ? (Array.isArray(loyalty.rewards_available) ? loyalty.rewards_available : []).map(r => ({
    id: r.id,
    label: r.name,
    stamp: false,
    stampProgramId: null,
    pointsCost: num(r.points_cost),
    type: r.reward_type,
    // loyalty-otp verify sends reward_value since v5.8.67. A deploy from before that sends
    // none: the reward then takes nothing off and the tap check refuses it.
    value: isObj(r.reward_value) ? r.reward_value : {},
    available: 1,
  })) : [];
  return [...stamps, ...points];
}

/**
 * The context kioskLoyaltyReward.js takes, built from KioskApp's own figures exactly as
 * KioskApp builds it for the live credit (goods after auto discounts, before tax and tip;
 * what is due; the staged gift card's applied amount, minor units).
 */
export function kioskRewardContext({ cart = [], discountedSubtotal = 0, total = 0, giftMinor = 0 } = {}) {
  return {
    cart: Array.isArray(cart) ? cart : [],
    goodsMinor: Math.round(num(discountedSubtotal) * 100),
    dueMinor: Math.round(num(total) * 100),
    giftMinor: num(giftMinor),
  };
}

/**
 * Stage a reward the way ScreenLoyalty.redeemReward does (apply only; submitOrder commits it),
 * through the same tap check (lib/kioskLoyaltyReward.js kioskRewardTapCheck) and in the same
 * shape, including reward_type and reward_value so KioskApp recomputes the credit live.
 *   ctx: { cart, discountedSubtotal, total, giftMinor, customerId } (KioskApp's figures)
 *   { ok: true, staged }                         staged is the loyaltyRedemption object
 *   { ok: false, reason: 'needsItem', items }    a free item reward with nothing eligible
 *   { ok: false, reason: 'giftFirst' }           a staged gift card would cut it down (the
 *                                                tap check's gift rule): remove the gift card first
 *   { ok: false, reason: 'zero' }                it takes nothing off this basket
 * A refused reward is never staged, so points or a stamp card are never spent for nothing or
 * for part of a reward (there is no member of staff to honour it).
 */
export function stageKioskReward(reward, { cart = [], discountedSubtotal = 0, total = 0, giftMinor = 0, customerId = null } = {}) {
  if (!isObj(reward)) return { ok: false, reason: 'zero' };
  const rv = isObj(reward.value) ? reward.value : {};
  const ctx = kioskRewardContext({ cart, discountedSubtotal, total, giftMinor });
  const check = kioskRewardTapCheck(reward.type, rv, ctx);
  if (check.error) {
    if (kioskRewardMissingItems(reward.type, rv, ctx.cart) !== null) {
      const eligible = Array.isArray(rv.eligible_items) ? rv.eligible_items : [];
      return { ok: false, reason: 'needsItem', items: eligible.map(ei => ei?.name).filter(Boolean) };
    }
    // The gift card is the only reason when the same check passes without it.
    if (ctx.giftMinor > 0 && !kioskRewardTapCheck(reward.type, rv, { ...ctx, giftMinor: 0 }).error) {
      return { ok: false, reason: 'giftFirst' };
    }
    return { ok: false, reason: 'zero' };
  }
  return {
    ok: true,
    staged: {
      reward_id: reward.stamp ? null : reward.id,
      stampProgramId: reward.stamp ? (reward.stampProgramId || String(reward.id).replace(/^stamp:/, '')) : null,
      customer_id: customerId || null,
      reward_name: reward.label,
      points_deducted: reward.stamp ? 0 : num(reward.pointsCost),
      discount_type: reward.type,
      // type + value ride along so KioskApp recomputes the credit against the live basket.
      reward_type: reward.type,
      reward_value: rv,
      discount_value: check.discountMinor,
      idempotency_key: null,
      balance_after: null,
      pending_commit: true,
    },
  };
}

/**
 * The staged reward's credit (major units) with NO gift card, from the same live function
 * KioskApp uses (kioskLoyaltyCreditMinor). The gift card is sized around this (giftDueMinor),
 * so the gift card gives way to the reward and KioskApp's capped credit comes out the same.
 */
export function kioskRewardCreditNoGift({ redemption = null, cart = [], discountedSubtotal = 0, total = 0 } = {}) {
  if (!isObj(redemption)) return 0;
  return kioskLoyaltyCreditMinor(redemption, kioskRewardContext({ cart, discountedSubtotal, total, giftMinor: 0 })) / 100;
}

/**
 * What to do with a staged reward after the order changed. Nothing is restaged: KioskApp
 * works the credit out live every render (lib/kioskLoyaltyReward.js). A reward that now takes
 * nothing off the basket (its free item left, the basket emptied) comes off, with a notice,
 * instead of sitting on the order at 0p (submitOrder would not commit it either).
 *   { action: 'none' } | { action: 'remove' }
 */
export function kioskRewardRestage({ redemption = null, cart = [], discountedSubtotal = 0, total = 0 } = {}) {
  if (!isObj(redemption)) return { action: 'none' };
  return kioskRewardCreditNoGift({ redemption, cart, discountedSubtotal, total }) > 0
    ? { action: 'none' }
    : { action: 'remove' };
}

/**
 * A loyalty-otp failure as a customer message key.
 *   action 'send':   429 wait, not configured, anything else failed
 *   action 'verify': 401 or 400 wrong code, 429 otp_locked locked, not configured, else failed
 */
export function kioskOtpErrorKey({ action, status, body } = {}) {
  const msg = String(body?.error || '').toLowerCase();
  if (msg.includes('not configured')) return 'k2.otp.notSetUp';
  if (action === 'verify') {
    if (status === 429) return 'k2.otp.locked';
    if (status === 401 || status === 400) return 'k2.otp.wrong';
    return 'k2.otp.failed';
  }
  if (status === 429) return 'k2.otp.wait';
  return 'k2.otp.failed';
}

// ── Codes (one box for gift cards and promo codes, decision 6) ──────────────

/** The code as typed, cleaned: trimmed and upper case, plus the 16 character gift form. */
export function classifyKioskCode(input) {
  const code = String(input ?? '').trim().toUpperCase();
  const stripped = code.replace(/[\s-]/g, '');
  return { code, stripped, giftCandidate: stripped.length === 16 };
}

/**
 * A gift-lookup body as a kiosk result.
 *   { ok: true } or { errorKey }
 */
export function kioskGiftLookupResult(body, now = Date.now()) {
  if (!isObj(body)) return { errorKey: 'k2.code.notRecognised' };
  if (body.status !== 'active') return { errorKey: 'k2.code.giftInactive' };
  if (!(num(body.balance) > 0)) return { errorKey: 'k2.code.giftEmpty' };
  if (body.expires_at && Date.parse(body.expires_at) < now) return { errorKey: 'k2.code.giftExpired' };
  return { ok: true };
}

/**
 * A promo-redeem validate reply as a kiosk result.
 *   { promo } | { errorKey, vars } | { failed: true } (network) | { notValid: true }
 */
export function kioskPromoResult(code, reply) {
  if (!reply || reply.networkError) return { failed: true };
  const body = isObj(reply.body) ? reply.body : {};
  if (reply.httpOk && body.valid) {
    return {
      promo: {
        code,
        code_id: body.code_id,
        offer_id: body.offer?.id || null,
        label: body.discount?.label || body.offer?.name || 'Promo code',
        amount: num(body.discount?.amount),
        // Display only (kioskPromoLabel): the order still records label as the server sent it.
        ...(body.discount?.type ? { discountType: String(body.discount.type), discountValue: num(body.discount.value) } : {}),
      },
    };
  }
  if (body.reason === 'min_spend') return { errorKey: 'k2.code.minSpend', vars: { amount: num(body.min_spend) } };
  return { notValid: true };
}

/**
 * The applied promo chip's label, in the customer's language where it can be.
 * promo-redeem (supabase/functions/_shared/promo.ts computeDiscount) sends the offer's own
 * reward_label, or else an English label it built: "10% off", "£5.00 off", "Free item",
 * "Free delivery", "3 bonus points", "Offer". Only a label that is exactly the one the server
 * would build for that type and value becomes a key; a venue's own wording shows as written.
 * Resolves { key, vars, plural?, money? } or { text }. `money` names the var to format as money.
 */
export function kioskPromoLabel(promo) {
  const label = String(promo?.label ?? '').trim();
  const v = num(promo?.discountValue);
  switch (promo?.discountType) {
    case 'percent':
      if (label === `${v}% off`) return { key: 'k2.code.promoPercentOff', vars: { pct: v } };
      break;
    case 'amount':
      if (label === `£${v.toFixed(2)} off`) return { key: 'k2.code.promoAmountOff', vars: { amount: v }, money: 'amount' };
      if (label === 'Offer') return { key: 'k2.code.promoOffer', vars: {} };
      break;
    case 'free_item':
      if (label === 'Free item') return { key: 'k2.code.promoFreeItem', vars: {} };
      break;
    case 'free_delivery':
      if (label === 'Free delivery') return { key: 'k2.code.promoFreeDelivery', vars: {} };
      break;
    case 'points_bonus':
      if (label === `${v} bonus points`) return { key: 'k2.code.promoBonusPoints', vars: { n: v }, plural: true };
      break;
    default:
      break;
  }
  return { text: label };
}

/**
 * Apply what the customer typed in the code box. The same order of checks as today's
 * ScreenGiftPromo, calling the same endpoints through `deps`:
 *   deps.lookupGift(stripped)  resolves { httpOk, body } or { networkError: true }
 *   deps.validatePromo(code)   resolves { httpOk, body } or { networkError: true }
 * Resolves one of:
 *   { gift: staged }   a staged gift card (giftCommit.stageGiftCard shape)
 *   { promo }          the promoApplied object
 *   { errorKey, vars } a customer message key
 *   { none: true }     nothing typed
 */
export async function applyKioskCode({ input, giftStaged = null, promoStaged = null, grandTotal = 0, giftDue = 0 } = {}, deps = {}) {
  const { code, stripped, giftCandidate } = classifyKioskCode(input);
  if (!code) return { none: true };
  // A gift card that covers the order still leaves room for a promo (decision 6: both can be
  // on one order). The promo is checked against the goods, and the gift card is restaged to
  // what is left after it, so the customer keeps that gift card balance.
  const promoCanStillApply = !!giftStaged && !promoStaged;
  if (!(kioskChargeTotal(grandTotal) > 0) && !promoCanStillApply) return { errorKey: 'k2.code.nothingToPay' };

  const tryPromo = async () => {
    if (promoStaged) return { notValid: true };
    try {
      return kioskPromoResult(code, await deps.validatePromo(code));
    } catch {
      return { failed: true };
    }
  };
  const promoOutcome = (r, fallbackKey) => {
    if (r.promo) return { promo: r.promo };
    if (r.errorKey) return { errorKey: r.errorKey, vars: r.vars };
    if (r.failed) return { errorKey: 'k2.code.failed' };
    return { errorKey: fallbackKey };
  };

  // A gift card is already on the order: this code can only be a promo.
  if (giftStaged) return promoOutcome(await tryPromo(), 'k2.code.oneGift');
  // Gift codes are exactly 16 characters without spaces and dashes.
  if (!giftCandidate) return promoOutcome(await tryPromo(), 'k2.code.notRecognised');

  let reply;
  try {
    reply = await deps.lookupGift(stripped);
  } catch {
    reply = { networkError: true };
  }
  if (!reply || reply.networkError) return { errorKey: 'k2.code.failed' };
  const body = isObj(reply.body) ? reply.body : {};
  if (!reply.httpOk || body.error) return promoOutcome(await tryPromo(), 'k2.code.notRecognised');
  const check = kioskGiftLookupResult(body);
  if (!check.ok) return { errorKey: check.errorKey };
  return {
    gift: stageGiftCard({
      cardId: body.card_id,
      code: stripped,
      codeLast4: body.code_last4,
      balanceMinor: body.balance,
      amountDueMinor: giftDue,
    }),
  };
}

/**
 * applyKioskCode for the code box on Review and pay, with the freeze rule: a result that comes
 * back after the customer has left Review and pay (or while the order is saving) is dropped,
 * so a slow gift card lookup or promo check can never change the order on the card screen
 * while the reader is live. stillOpen() is asked before the lookup and again when it answers.
 * Returns { dropped: true } for a dropped result (it stages nothing), else applyKioskCode's.
 */
export async function applyKioskCodeWhileOpen(args, deps, stillOpen) {
  const open = () => typeof stillOpen !== 'function' || stillOpen() === true;
  if (!open()) return { dropped: true };
  const result = await applyKioskCode(args, deps);
  if (!open()) return { dropped: true };
  return result;
}

// ── Pay ─────────────────────────────────────────────────────────────────────

/**
 * The amount left to pay, to the penny. KioskApp's credit formulas are left exactly as they
 * are, and in floating point they can leave a crumb such as 1.8e-15 when a gift card and a
 * promo together cover the order (23.10 - 3 - 15.10 - 5). ScreenPay starts the reader for any
 * total above 0, so the card screen is given this rounded amount: a crumb is 0 (Place order,
 * which submitOrder already treats as gift only, grandTotal <= 0.005), and a real amount is
 * unchanged (ScreenPay charges Math.round(total * 100) either way).
 */
export function kioskChargeTotal(grandTotal) {
  return Math.max(0, Math.round(num(grandTotal) * 100)) / 100;
}

// Stripe refuses a card charge under 30 minor units (stripe-process-payment-on-reader).
export const KIOSK_CARD_MINIMUM = 0.30;

/**
 * Why Pay cannot be tapped (an i18n key), or null.
 *   checking  the applied promo is being checked again after a basket change
 *   applying  a code typed in the code box is still being looked up. Pay waits for the answer,
 *             as today's kiosk disables Continue while a code is applying (giftApplying): the
 *             card screen must never open with a gift card or promo still on its way.
 */
export function kioskPayBlock({ cartCount = 0, allergenAckRequired = false, allergenAck = false, grandTotal = 0, checking = false, applying = false } = {}) {
  if (!(num(cartCount) > 0)) return null;
  if (checking || applying) return 'k2.pay.blockedChecking';
  if (allergenAckRequired && !allergenAck) return 'k2.pay.blockedAllergens';
  const g = Math.round(num(grandTotal) * 100);
  if (g > 0 && g < Math.round(KIOSK_CARD_MINIMUM * 100)) return 'k2.pay.blockedMinimum';
  return null;
}

/**
 * The totals card rows (README 5.7). Items always shows; every other row only when it is
 * above zero. Negative rows take money off. The last row is the total.
 *   [{ id, labelKey, label, amount, negative }]
 */
export function kioskTotalsRows({
  subtotal = 0, autoDiscounts = [], autoDiscountTotal = 0, exclusiveTax = 0, tip = 0,
  loyaltyCredit = 0, promoCredit = 0, giftCardCredit = 0, grandTotal = 0,
} = {}) {
  const above = (v) => Math.round(num(v) * 100) > 0;
  const rows = [{ id: 'items', labelKey: 'k2.totals.items', label: null, amount: num(subtotal), negative: false }];
  if (above(autoDiscountTotal)) {
    const one = Array.isArray(autoDiscounts) && autoDiscounts.length === 1 && autoDiscounts[0]?.label;
    rows.push({ id: 'offers', labelKey: one ? null : 'k2.totals.offers', label: one ? String(autoDiscounts[0].label) : null, amount: num(autoDiscountTotal), negative: true });
  }
  if (above(exclusiveTax)) rows.push({ id: 'tax', labelKey: 'k2.totals.tax', label: null, amount: num(exclusiveTax), negative: false });
  if (above(tip)) rows.push({ id: 'tip', labelKey: 'k2.totals.tip', label: null, amount: num(tip), negative: false });
  if (above(loyaltyCredit)) rows.push({ id: 'reward', labelKey: 'k2.totals.reward', label: null, amount: num(loyaltyCredit), negative: true });
  if (above(promoCredit)) rows.push({ id: 'promo', labelKey: 'k2.totals.promo', label: null, amount: num(promoCredit), negative: true });
  if (above(giftCardCredit)) rows.push({ id: 'gift', labelKey: 'k2.totals.gift', label: null, amount: num(giftCardCredit), negative: true });
  rows.push({ id: 'total', labelKey: 'k2.totals.total', label: null, amount: num(grandTotal), negative: false });
  return rows;
}

/**
 * Whether "Text me when it's ready" is offered for this order (decision 9). Every order the
 * customer collects: take away, and eat in with no table (sit anywhere, we call the number).
 * An order brought to a table needs no text.
 */
export function kioskTextAllowed({ orderType = null, tableNumber = '' } = {}) {
  if (orderType === 'takeaway') return true;
  const table = tableNumber == null ? '' : String(tableNumber).trim();
  return orderType === 'dineIn' && !table;
}

/**
 * What to pass to submitOrder(nameOverride, phoneOverride). ALWAYS two strings:
 * submitOrder reads (override ?? state) || null, so undefined would fall back to the number
 * held in state and text a customer who only wanted points. '' becomes null.
 *   name:  always '' (decision 8: no name).
 *   phone: the E.164 number only when the text switch is on, the order is one the customer
 *          collects (kioskTextAllowed) and the customer ticked "Text me when it's ready".
 *          Otherwise ''.
 */
export function kioskSubmitArgs({ smsEnabled = false, orderType = null, tableNumber = '', smsOn = false, phoneE164 = '' } = {}) {
  const phone = smsEnabled === true && kioskTextAllowed({ orderType, tableNumber }) && smsOn === true && typeof phoneE164 === 'string' && phoneE164
    ? phoneE164
    : '';
  return ['', phone];
}

/**
 * The CRM order record for points only attribution (the customer gave a number for points
 * but no ready text, so submitOrder did not attribute). The same field names and method
 * rule as submitOrder's orderRecord.
 */
export function kioskAttributionRecord({
  checkId, orderNumber, grandTotal = 0, tip = 0, subtotal = 0, cart = [],
  loyaltyCredit = 0, giftCardCredit = 0, promoCredit = 0, orderType = null, locationId = null, now = Date.now(),
} = {}) {
  return {
    id: checkId,
    ref: orderNumber,
    total: grandTotal,
    tip,
    subtotal,
    items: (Array.isArray(cart) ? cart : []).map(kioskOrderItem),
    method: (loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) ? 'split' : 'card',
    order_type: orderType === 'dineIn' ? 'dine-in' : 'takeaway',
    location_id: locationId,
    closedAt: now,
    source: 'kiosk',
  };
}

/**
 * submitOrder's gift only abort messages (English, KioskApp.jsx) as customer message keys.
 * Anything else is null (not a message for Review and pay).
 */
export function kioskSubmitNotice(submitError) {
  if (typeof submitError !== 'string' || !submitError) return null;
  if (submitError.startsWith('That gift card no longer has enough balance')) return 'k2.code.giftShort';
  if (submitError.startsWith('Gift card could not be applied')) return 'k2.code.giftFailed';
  return null;
}
