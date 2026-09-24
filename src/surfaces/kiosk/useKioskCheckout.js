/**
 * useKioskCheckout: the Review and pay state for one customer (new kiosk design).
 *
 * Used by KioskFlowV2, which is keyed per customer, so everything here starts fresh for the
 * next customer. It lives above the screens so it survives going Review > Menu > Review and
 * Review > Card > Review.
 *
 * CARD PATH RULE. This only stages things in the SAME shapes today's kiosk stages them
 * (tip amount, giftCardPayment, promoApplied, loyaltyRedemption) and works out the
 * submitOrder arguments. KioskApp's totals, credits and submitOrder are untouched.
 *
 * REWARDS. The reward's money is KioskApp's live credit (lib/kioskLoyaltyReward.js, the one
 * implementation, shared with today's kiosk); a tap goes through its tap check
 * (lib/kioskCheckout.js stageKioskReward). Nothing here restages a reward's amount.
 *
 * FREEZE RULE. Every restaging effect runs only while the customer can still change the
 * order (start, menu, review) and nothing is saving. Nothing that changes grandTotal runs
 * on the card or done screens. A code typed on Review and pay blocks Pay until it answers,
 * and an answer that lands after the customer left Review and pay is dropped.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { tipInitialKey, tipAmount } from '../../lib/tipping';
import { basketAllergens } from '../../lib/kioskAllergens';
import { alcoholCategorySet, orderHasAlcohol } from '../../lib/kioskStaffFlags';
import { kioskPhoneRegion, kioskE164, kioskMaskPhone } from '../../lib/kioskPhone';
import {
  giftDueMinor, kioskGiftRestage, kioskRewardRestage, kioskRewardCreditNoGift, kioskPromoResult, applyKioskCodeWhileOpen,
  kioskPayBlock, kioskTotalsRows, kioskSubmitArgs, kioskTextAllowed,
} from '../../lib/kioskCheckout';

const PROMO_RECHECK_MS = 500;
const MAX_NOTICES = 3;

function noticesReducer(list, action) {
  if (action.type === 'clear') return list.length ? [] : list;
  if (action.type === 'push') {
    const next = list.filter(n => n.key !== action.key);
    next.push({ id: `${action.key}:${action.at || 0}`, key: action.key, vars: action.vars || {}, tone: action.tone || 'info' });
    return next.slice(-MAX_NOTICES);
  }
  return list;
}

const promoKeyFor = (promo, subtotal, customerId) => (
  promo ? `${promo.code}|${Math.round((Number(subtotal) || 0) * 100)}|${customerId || ''}` : null
);

export default function useKioskCheckout({ engine, api, screen, tipping, alcoholIds, currency }) {
  const {
    cart, items, categories, railCategories, orderType, profile, locationId, submitting,
    subtotal, discountedSubtotal, total, tip, setTip,
    loyaltyRedemption, setLoyaltyRedemption, verifiedLoyalty, setVerifiedLoyalty,
    giftCardPayment, setGiftCardPayment, promoApplied, setPromoApplied,
    loyaltyCredit, giftCardCredit, promoCredit, grandTotal,
    customerPhone, setCustomerPhone, cartItemCount, tableNumber,
  } = engine;
  const customerId = verifiedLoyalty?.customer?.id || null;
  const open = (screen === 'start' || screen === 'menu' || screen === 'review') && !submitting;
  // v5.9.12: the bill the gift card may cover is `total` less the sales tax the
  // loyalty / promo credits took off (engine.taxRelief, 0 for UK and whenever no
  // credit lowers added-on tax). Sizing on `total` alone debited the card for tax
  // the customer no longer owed.
  const giftTotal = engine.taxRelief > 0 ? +(total - engine.taxRelief).toFixed(2) : total;

  const [notices, dispatchNotice] = useReducer(noticesReducer, []);

  // ── Tip (venue tipping settings, tipping_config.kiosk) ──
  const tipRule = tipping?.rule || null;
  const [tipChoice, setTipChoice] = useState(null);
  const tipKey = useMemo(() => {
    if (!tipRule?.on) return '0';
    const ok = tipChoice === '0' || (tipChoice !== null && tipRule.pct.includes(Number(tipChoice)));
    return ok ? tipChoice : tipInitialKey(tipRule);
  }, [tipRule, tipChoice]);
  useEffect(() => {
    if (screen !== 'review' || submitting) return;
    const amount = tipRule?.on ? tipAmount(discountedSubtotal, tipKey) : 0;
    if (Math.abs(amount - (Number(tip) || 0)) > 1e-9) setTip(amount);
  }, [screen, submitting, tipRule, tipKey, discountedSubtotal, tip, setTip]);

  // ── Text me when it's ready (every order the customer collects, decision 9) ──
  const smsEnabled = profile?.kiosk_sms_enabled === true;
  const textAllowed = kioskTextAllowed({ orderType, tableNumber });
  const [smsChoice, setSmsChoice] = useState(false);
  // An order brought to a table hides the row and switches texts off (adjusting state while rendering).
  if (smsChoice && !textAllowed) setSmsChoice(false);
  const smsOn = smsEnabled && textAllowed && smsChoice;

  // ── Phone ──
  const phoneRegion = kioskPhoneRegion(currency);
  const phoneE164 = customerPhone ? kioskE164(customerPhone, phoneRegion) : null;
  const masked = customerPhone ? kioskMaskPhone(customerPhone) : '';

  const clearLoyalty = () => {
    setVerifiedLoyalty(null);
    setLoyaltyRedemption(null);
  };
  const confirmPhone = (digits, { turnOnText = false } = {}) => {
    if (digits !== customerPhone) clearLoyalty();
    setCustomerPhone(digits);
    if (turnOnText) setSmsChoice(true);
  };
  const removePhone = () => {
    clearLoyalty();
    setCustomerPhone('');
    setSmsChoice(false);
  };
  const toggleSms = () => setSmsChoice(v => !v);

  // ── Allergen check (decision 12). Any basket change after ticking clears the tick. ──
  // The item sheet records the allergens stored on picked options (modsArray does not carry
  // them) against the line key, so the check and the See allergens list include them.
  const [lineAllergens, setLineAllergens] = useState(() => new Map());
  const noteLineAllergens = (key, ids) => {
    if (!key) return;
    setLineAllergens(prev => {
      const had = prev.get(key) || [];
      const add = (Array.isArray(ids) ? ids : []).filter(id => !had.includes(id));
      if (!add.length) return prev;
      const next = new Map(prev);
      next.set(key, [...had, ...add]);
      return next;
    });
  };
  const allergenList = useMemo(() => basketAllergens(cart, items, lineAllergens), [cart, items, lineAllergens]);
  const allergenAckRequired = profile?.kiosk_allergen_required === true && allergenList.length > 0;
  const [ackedCart, setAckedCart] = useState(null);
  const allergenAck = ackedCart !== null && ackedCart === cart;
  const toggleAck = () => setAckedCart(allergenAck ? null : cart);

  // ── Alcohol (decision 16): the customer is told; staff see CHECK ID. ──
  const alcoholSet = useMemo(() => alcoholCategorySet(alcoholIds, railCategories), [alcoholIds, railCategories]);
  const itemsById = useMemo(() => new Map((items || []).map(i => [i.id, i])), [items]);
  const hasAlcohol = useMemo(() => orderHasAlcohol(cart, alcoholSet, itemsById), [cart, alcoholSet, itemsById]);

  // ── Reward: KioskApp's credit is live, so only a reward that no longer takes anything off
  // this basket (its free item left) is taken off, with a notice. ──
  useEffect(() => {
    if (!open || !loyaltyRedemption) return;
    const plan = kioskRewardRestage({ redemption: loyaltyRedemption, cart, discountedSubtotal, total });
    if (plan.action === 'remove') {
      setLoyaltyRedemption(null);
      if (cart.length) dispatchNotice({ type: 'push', key: 'k2.reward.removed', at: Date.now() });
    }
  }, [open, loyaltyRedemption, cart, discountedSubtotal, total, setLoyaltyRedemption]);

  // The reward's credit with no gift card. The gift card is sized around it, never around
  // KioskApp's loyaltyCredit, which is capped at what the staged gift card leaves due: sizing
  // from that would let the gift card keep the reward's share (lib/kioskCheckout.js giftDueMinor).
  const rewardCredit = kioskRewardCreditNoGift({ redemption: loyaltyRedemption, cart, discountedSubtotal, total });

  // ── Gift card restaging (a card with nothing to cover comes off, F9) ──
  useEffect(() => {
    if (!open || !giftCardPayment) return;
    const plan = kioskGiftRestage({ staged: giftCardPayment, total: giftTotal, loyaltyCredit: rewardCredit, promoAmount: promoApplied?.amount || 0 });
    if (plan.action === 'remove') {
      setGiftCardPayment(null);
      if (cart.length) dispatchNotice({ type: 'push', key: 'k2.code.giftNotNeeded', at: Date.now() });
    } else if (plan.action === 'restage') {
      setGiftCardPayment(plan.staged);
    }
  }, [open, giftCardPayment, giftTotal, rewardCredit, promoApplied, cart.length, setGiftCardPayment]);

  // ── Promo re-check after the basket changes (Pay waits while it is checking) ──
  const promoKey = promoKeyFor(promoApplied, subtotal, customerId);
  const [promoCheckedKey, setPromoCheckedKey] = useState(null);
  const checking = !!promoApplied && promoKey !== promoCheckedKey;
  useEffect(() => {
    // An empty basket is not re-checked (Pay is not shown); the next item triggers it.
    if (!open || !promoApplied || !cartItemCount || promoKey === promoCheckedKey) return;
    let alive = true;
    const code = promoApplied.code;
    const timer = setTimeout(async () => {
      const reply = await api.validatePromo({ code, locationId, customerId, subtotal });
      if (!alive) return;
      const r = kioskPromoResult(code, reply);
      if (r.promo) {
        if (Math.abs((r.promo.amount || 0) - (promoApplied.amount || 0)) > 1e-9) setPromoApplied({ ...promoApplied, ...r.promo });
        setPromoCheckedKey(promoKey);
      } else if (r.failed) {
        // A network blip keeps the code: the server checks it again when the order commits.
        setPromoCheckedKey(promoKey);
      } else {
        setPromoApplied(null);
        setPromoCheckedKey(null);
        dispatchNotice({ type: 'push', key: 'k2.code.promoGone', vars: { code }, tone: 'danger', at: Date.now() });
      }
    }, PROMO_RECHECK_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [open, promoApplied, promoKey, promoCheckedKey, cartItemCount, api, locationId, customerId, subtotal, setPromoApplied]);

  // ── The code box ──
  // One token per visit to Review and pay (new each time it opens, cleared when it closes or
  // the order starts saving). A lookup that answers under a different token is dropped, so a
  // late gift card or promo can never be staged on the card screen. `applying` counts the
  // lookups still out; Pay waits for them (kioskPayBlock).
  const reviewOpen = screen === 'review' && !submitting;
  const codeVisitRef = useRef(null);
  useEffect(() => {
    if (!reviewOpen) return undefined;
    const visit = {};
    codeVisitRef.current = visit;
    return () => { if (codeVisitRef.current === visit) codeVisitRef.current = null; };
  }, [reviewOpen]);
  const [applying, setApplying] = useState(0);
  const giftDue = giftDueMinor({ total: giftTotal, loyaltyCredit: rewardCredit, promoAmount: promoApplied?.amount || 0 });
  const applyCode = async (input) => {
    const visit = codeVisitRef.current;
    setApplying(n => n + 1);
    try {
      const result = await applyKioskCodeWhileOpen(
        { input, giftStaged: giftCardPayment, promoStaged: promoApplied, grandTotal, giftDue },
        {
          lookupGift: (code) => api.lookupGift({ code, locationId }),
          validatePromo: (code) => api.validatePromo({ code, locationId, customerId, subtotal }),
        },
        () => visit !== null && codeVisitRef.current === visit,
      );
      if (result.gift) setGiftCardPayment(result.gift);
      if (result.promo) {
        setPromoApplied(result.promo);
        setPromoCheckedKey(promoKeyFor(result.promo, subtotal, customerId));
      }
      return result;
    } finally {
      setApplying(n => Math.max(0, n - 1));
    }
  };
  const removeGift = () => setGiftCardPayment(null);
  const removePromo = () => { setPromoApplied(null); setPromoCheckedKey(null); };

  // ── Rewards ──
  // The tap check's figures, exactly as KioskApp passes them to kioskLoyaltyCreditMinor.
  const rewardCtx = { cart, categories, discountedSubtotal, total, giftMinor: giftCardPayment?.applied || 0, customerId };
  const applyReward = (staged) => { if (staged) setLoyaltyRedemption(staged); };
  const removeReward = () => setLoyaltyRedemption(null);

  // ── Pay ──
  const payBlock = kioskPayBlock({ cartCount: cartItemCount, allergenAckRequired, allergenAck, grandTotal, checking, applying: applying > 0 });
  const totalsRows = kioskTotalsRows({
    subtotal, autoDiscounts: engine.autoDiscounts, autoDiscountTotal: engine.autoDiscountTotal,
    // v5.9.12: the tax row shows the tax CHARGED (after any loyalty / promo
    // relief), so the rows still add up to the total. UK: taxRelief is 0.
    exclusiveTax: engine.taxRelief > 0 ? +(engine.exclusiveTax - engine.taxRelief).toFixed(2) : engine.exclusiveTax,
    tip, loyaltyCredit, promoCredit, giftCardCredit, grandTotal,
  });
  const submitArgs = kioskSubmitArgs({ smsEnabled, orderType, tableNumber, smsOn, phoneE164: phoneE164 || '' });

  return {
    tipRule, tipKey, setTipKey: setTipChoice,
    smsEnabled, textAllowed, smsOn, toggleSms,
    phoneRegion, phoneE164, masked, confirmPhone, removePhone,
    allergenList, allergenAckRequired, allergenAck, toggleAck, noteLineAllergens,
    hasAlcohol,
    notices, clearNotices: () => dispatchNotice({ type: 'clear' }),
    checking, applyCode, removeGift, removePromo,
    rewardCtx, applyReward, removeReward, setVerifiedLoyalty, customerId,
    payBlock, totalsRows, submitArgs,
  };
}
