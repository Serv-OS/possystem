// v5.5.243 — Online ordering checkout w/ Stripe, gift cards, & loyalty rewards.
// Four-step flow (rewards step only if loyalty signed in):
//   STEP 1: Details + when (name/phone/email/address, ASAP / scheduled slot)
//   STEP 2: Gift card (optional — enter code, apply balance toward order)
//   STEP 3: Rewards (if loyalty signed in — browse & redeem a reward for a discount)
//   STEP 4: Card details (Stripe Elements + CardElement, skipped if fully covered)
//
// Auth: online customers aren't logged in to Supabase, so we use
// signInAnonymously() — the edge fns accept anon-role JWTs for the
// online channel.
//
// v5.5.243 additions:
//   - Phone → loyalty member detection: debounced lookup on phone input,
//     shows "You're a member! Sign in" banner if found.
//   - Rewards step: browse available rewards, redeem for a discount.
//     Calls loyalty-redeem edge fn. Discount applied like gift cards.

import { useEffect, useMemo, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, platformSupabase } from '../../lib/supabase';
import { decrementStockRPC, fetchActiveDiscountRules } from '../../lib/db';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../../lib/discountEngine';
import { buildScheduleCtx } from '../../lib/locationTime';
import { depleteForSaleServer } from '../../lib/stock/deplete';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';
import { getLocationProcessor } from '../../lib/payments/processor';
import RyftPaymentForm from '../../components/RyftPaymentForm';
import AddressAutocomplete from '../../components/AddressAutocomplete';
import { attributeOnlineOrder } from '../../lib/customerLookup';
import { getDeliveryQuote, recordDeliverySurcharge } from '../../lib/delivery/quoteService';
import { dispatchDelivery } from '../../lib/delivery/dispatch';
import { sendEmailReceipt } from '../../lib/sendReceipt';
import { getDayWindows } from '../../lib/openingHours';
import { calculateOrderTax } from '../../lib/tax';
import { money, stripeCurrency } from '../../lib/currency';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// v5.5.287: Decrement stock for each item in an online order.
// Fire-and-forget — stock decrement failures never block order confirmation.
function decrementOnlineStock(cart, locationId) {
  try {
    for (const line of cart) {
      const itemId = line.itemId;
      if (itemId) {
        decrementStockRPC(itemId, line.qty || 1, locationId)
          .catch(e => console.warn('[online] stock decrement failed:', itemId, e?.message));
      }
      // Modifier sub-items with linked itemId (e.g. "Bueno Donut" inside a "Box of 3")
      if (line.mods) {
        for (const mod of line.mods) {
          if (mod.itemId) {
            decrementStockRPC(mod.itemId, (mod.qty || 1) * (line.qty || 1), locationId)
              .catch(e => console.warn('[online] mod stock decrement failed:', mod.itemId, e?.message));
          }
        }
      }
    }
  } catch (e) {
    console.warn('[online] stock decrement batch failed:', e?.message);
  }
}

export default function OnlineCheckout({ cart, theme, location, orderType, loyalty, taxRates = [], onClose, onPlaced, onOpenLoyalty, onLoyaltyVerified }) {
  const opsLocationId = location.ops_location_id || location.id; // ops DB
  const platformLocationId = location.id;                         // platform DB
  const tz = location.timezone || 'Europe/London';
  const leadMin = Number(location.online_collection_lead_min) || 30;

  // Payment step: 'details' → 'gift' → 'pay'
  const [step, setStep] = useState('details');
  const [pi, setPi] = useState(null);             // { client_secret, stripe_account, ... }
  const [stripePromise, setStripePromise] = useState(null);
  const [processor, setProcessor] = useState('stripe');   // 'stripe' | 'ryft' — defaults stripe (fail-safe)

  // Resolve the location's processor once (defaults to stripe on any error).
  useEffect(() => { getLocationProcessor(platformLocationId).then(setProcessor).catch(() => {}); }, [platformLocationId]);

  // Customer details — pre-fill from loyalty sign-in if available
  const [name, setName]   = useState(loyalty?.customer?.name || '');
  const [phone, setPhone] = useState(loyalty?.phone || '');
  const [email, setEmail] = useState(loyalty?.customer?.email || '');
  const [address1, setAddress1] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');

  // v5.5.221: Gift card payment
  const [giftCode, setGiftCode] = useState('');
  const [giftCard, setGiftCard] = useState(null);   // looked-up card info
  const [giftApplied, setGiftApplied] = useState(null); // { card_id, applied, remaining_balance, idempotency_key, code_last4 }
  const [giftLoading, setGiftLoading] = useState(false);
  const [giftError, setGiftError] = useState('');

  // v5.5.243: Loyalty reward redemption
  const [rewardApplied, setRewardApplied] = useState(null); // { reward_id, reward_name, points_deducted, discount_type, discount_value, idempotency_key }
  const [rewardLoading, setRewardLoading] = useState(false);
  const [rewardError, setRewardError] = useState('');
  const [availableRewards, setAvailableRewards] = useState(null); // fetched when entering rewards step
  const hasLoyalty = !!(loyalty?.verified && loyalty?.loyalty);

  // v5.5.243: Phone → loyalty member detection
  const [loyaltyHint, setLoyaltyHint] = useState(null); // { enrolled, points_balance, member_code, points_enabled, stamps_enabled }

  // Loyalty program mode flags (from loyalty-balance / loyalty-member-lookup).
  // A venue can run points-only, stamp-cards-only, or both. Treat a
  // MISSING/undefined flag as enabled — only hide a section when its flag is
  // EXPLICITLY false. Read from the verified loyalty object first, then the
  // phone-lookup hint, whichever is present.
  const pointsEnabled = (loyalty?.loyalty?.points_enabled ?? loyaltyHint?.points_enabled) !== false;
  // No stamp-card UI is rendered at checkout, but keep the flag derived so the
  // rewards routing / progress indicator can treat a stamps-only venue as
  // "no points rewards here".
  // (stamps_enabled is read but unused for layout — checkout shows no stamp UI.)
  // The rewards (points-redemption) step only applies when a member is signed
  // in AND the venue runs points — a stamps-only venue skips straight to pay.
  const rewardsAvailable = hasLoyalty && pointsEnabled;
  const [loyaltyHintDismissed, setLoyaltyHintDismissed] = useState(false);
  // v5.5.249: gate prompt — shown when user clicks Continue and phone is a loyalty member
  const [showLoyaltyGate, setShowLoyaltyGate] = useState(false);
  // v5.5.250: Inline OTP flow inside the loyalty gate (no more closing checkout)
  const [gateStep, setGateStep]       = useState('prompt'); // 'prompt' | 'code' | 'done'
  const [gateCode, setGateCode]       = useState('');
  const [gateWorking, setGateWorking] = useState(false);
  const [gateError, setGateError]     = useState('');

  // Debounced phone lookup for loyalty member detection
  useEffect(() => {
    if (loyalty?.verified || loyaltyHintDismissed) return; // already signed in or dismissed
    const normalised = (phone || '').replace(/[\s\-()]/g, '');
    if (normalised.length < 7) { setLoyaltyHint(null); return; }
    const companyId = location.company_id;
    if (!companyId) return;
    const timer = setTimeout(() => {
      fetch(`${FUNCTIONS_URL}/loyalty-balance?phone=${encodeURIComponent(normalised)}&company_id=${encodeURIComponent(companyId)}`)
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j?.member_code) setLoyaltyHint(j); })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [phone, loyalty?.verified, loyaltyHintDismissed, location.company_id]);

  // Clear hint when loyalty sign-in succeeds
  useEffect(() => { if (loyalty?.verified) setLoyaltyHint(null); }, [loyalty?.verified]);

  // Timing — ASAP or scheduled
  const [timeMode, setTimeMode] = useState('asap'); // 'asap' | 'scheduled'
  const [slot, setSlot]         = useState(null);

  // Submit
  const [working, setWorking] = useState(false);
  const [error, setError]     = useState('');

  // Subtotal
  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0), [cart]);

  // Auto-discount rules — fetched live (online runs anonymously, no SyncBridge). Raw DB rows
  // feed the engine directly (it reads snake_case). Channel 'online'; schedule/expiry in location tz.
  // Discounts apply to the GOODS first (before gift card + loyalty reward) — discount, then tender.
  const [autoRules, setAutoRules] = useState([]);
  useEffect(() => {
    let live = true;
    fetchActiveDiscountRules(opsLocationId)
      .then(({ data }) => { if (live && Array.isArray(data)) setAutoRules(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [opsLocationId]);

  const autoDiscounts = useMemo(() => {
    const items = cart.map((l, i) => ({
      uid: l.uid || l.key || l.id || `l${i}`,
      cat: l.cat || null,
      cats: l.cats || null,
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      name: l.name || 'Item',
    }));
    return evaluateAutoDiscounts(items, autoRules, 'online', buildScheduleCtx(tz)).map(toAppliedDiscount);
  }, [cart, autoRules, tz]);
  const autoDiscountMinor = Math.round(autoDiscounts.reduce((s, d) => s + (d.value || 0), 0) * 100);

  // v5.5.154: UK VAT breakdown — required on customer-facing receipts/totals.
  const taxBreakdown = useMemo(() => calculateOrderTax(
    cart.map(l => ({
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      taxRateId: l.taxRateId || l.tax_rate_id || null,
      taxOverrides: l.taxOverrides || l.tax_overrides || {},
    })),
    taxRates,
    orderType || 'collection',
  ), [cart, taxRates, orderType]);

  // v5.5.243: Combined deduction calculation (auto-discount → gift card → loyalty reward)
  const giftAppliedMinor = giftApplied?.applied || 0;
  const rewardDiscountMinor = rewardApplied?.discount_value || 0;
  const subtotalMinor = Math.round(subtotal * 100);
  // Auto-discounts reduce the goods first; gift/loyalty then apply to the discounted bill.
  const discountedSubtotalMinor = Math.max(0, subtotalMinor - autoDiscountMinor);
  // v5.5.648: live delivery quote (Uber Direct, or the configured fee for HubRise-bridge
  // venues) — fold the customer fee into the amount payable so it's charged + shown.
  const [deliveryQuote, setDeliveryQuote] = useState(null);
  const [deliveryGeo, setDeliveryGeo] = useState(null);   // precise coords from address autocomplete
  const _delivAddrKey = orderType === 'delivery' ? `${address1}|${postcode}` : '';
  useEffect(() => {
    if (orderType !== 'delivery' || !address1.trim() || !postcode.trim()) { setDeliveryQuote(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const q = await getDeliveryQuote({ opsLocationId, dropoff: { line1: address1.trim(), postcode: postcode.trim().toUpperCase(), ...(deliveryGeo ? { lat: deliveryGeo.lat, lng: deliveryGeo.lng } : {}) }, orderSubtotalMinor: discountedSubtotalMinor });
      if (live) setDeliveryQuote(q);
    }, 500);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderType, _delivAddrKey, discountedSubtotalMinor, opsLocationId]);
  const deliveryFeeMinor = (orderType === 'delivery' && deliveryQuote?.available) ? (deliveryQuote.customerFeeMinor || 0) : 0;
  const remainingMinor = Math.max(0, discountedSubtotalMinor - giftAppliedMinor - rewardDiscountMinor) + deliveryFeeMinor;
  const fullyPaid = remainingMinor <= 0;
  const giftCoversAll = giftAppliedMinor >= discountedSubtotalMinor && deliveryFeeMinor === 0; // gift-only (no-card) path

  // Build collection slots — every 15 min between (now + leadMin) and the
  // next close time, snapped to :00 / :15 / :30 / :45.
  const slots = useMemo(() => buildCollectionSlots(location, tz, leadMin), [location, tz, leadMin]);

  // When the customer first picks Schedule, auto-select the earliest slot
  // so the dropdowns aren't empty and "Place order" isn't blocked on a
  // micro-interaction.
  useEffect(() => {
    if (timeMode === 'scheduled' && !slot && slots.length) setSlot(slots[0]);
  }, [timeMode, slot, slots]);

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const isDelivery = orderType === 'delivery';
  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (!/^\+?[0-9 ]{7,}$/.test(phone)) return false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
    if (isDelivery && (!address1.trim() || !postcode.trim())) return false;
    // v5.5.648: block delivery checkout if we have a quote result and it's not deliverable
    // (out of range / not available). null = still quoting; don't block on that.
    if (isDelivery && deliveryQuote && !deliveryQuote.available) return false;
    // v5.5.657: enforce the delivery minimum order value.
    if (isDelivery && deliveryQuote && deliveryQuote.belowMinimum) return false;
    if (timeMode === 'scheduled' && !slot) return false;
    return true;
  }, [name, phone, email, address1, postcode, isDelivery, timeMode, slot, deliveryQuote]);

  // Compose order ref + customer + items + collection ISO once details are valid.
  // Used by both the createPaymentIntent description/metadata and the
  // post-payment order_queue write.
  const orderShape = useMemo(() => {
    const collectionAt = timeMode === 'asap'
      ? new Date(Date.now() + leadMin * 60_000)
      : (slot ? new Date(slot.iso) : new Date(Date.now() + leadMin * 60_000));
    const sentAt = new Date(collectionAt.getTime() - leadMin * 60_000);
    const ref = `OL-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const customer = {
      name: name.trim(),
      phone: phone.replace(/\s+/g, ''),
      email: email.trim(),
      paid: true,   // v5.5.658: online orders are paid before they hit the queue — stamp it so the POS opens them READ-ONLY (never re-charges). Survives in the order_queue.customer jsonb.
      ...(isDelivery ? { address: { line1: address1.trim(), postcode: postcode.trim().toUpperCase(), ...(deliveryGeo ? { lat: deliveryGeo.lat, lng: deliveryGeo.lng } : {}) } } : {}),
      // v5.5.657: always record the delivery fee + mode for delivery orders (even £0), so the
      // ticket/receipt/reports show them and downstream routing knows self vs courier.
      ...(isDelivery && deliveryQuote?.available ? { delivery_fee: deliveryFeeMinor / 100, delivery_mode: deliveryQuote.mode || 'self' } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    // v5.5.128: include cat / cats / parentId on the queued items so the
    // operator-side production routing (routeKioskOrderPrints → centresForItem)
    // can bucket them into the right kitchen station even if the master
    // device's local menuItems cache hasn't loaded a matching row yet.
    // Pulled from the cart line if present (set by OnlineSurface when the
    // item was added) — falls back to undefined if not, in which case the
    // master still does its own menuItems lookup as a safety net.
    // v5.5.132: stamp items as already 'sent' + fired:true. Online orders
    // are paid before they enter order_queue — the kitchen DOES have them,
    // there's no operator decision pending. Without these flags the
    // operator's queue UI shows them as "to send" and the operator has
    // to manually open + click save-and-send before anything fires.
    const items = cart.map(l => ({
      itemId: l.itemId, name: l.name, price: l.price,
      qty: l.qty || 1, mods: l.mods || [], notes: l.notes || '',
      cat: l.cat || null,
      cats: l.cats || null,
      parentId: l.parentId || null,
      kitchenName: l.kitchenName || null,
      status: 'sent',
      fired: true,
      course: 1,
    }));
    return { ref, collectionAt, sentAt, customer, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]); // freeze on step transition so ref stays stable

  // ── Auth helper — get or create anonymous Supabase session ──────────
  const getAuthToken = async () => {
    const existing = await supabase?.auth.getSession();
    let token = existing?.data?.session?.access_token || null;
    if (!token) {
      const { data, error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) throw new Error('Could not start payment session: ' + anonErr.message);
      token = data?.session?.access_token;
    }
    if (!token) throw new Error('Could not obtain auth token.');
    return token;
  };

  // Step 1 → Gift step: validate details, move to gift card entry.
  // v5.5.249: If the phone matches a loyalty member and they haven't signed in,
  // show a gate prompt instead of proceeding. If they've already signed in,
  // dismissed the hint, or the phone isn't a member — proceed straight through.
  const continueToGift = async () => {
    if (!valid) {
      if (isDelivery && deliveryQuote && !deliveryQuote.available) {
        setError((deliveryQuote.reason === 'out_of_radius' || deliveryQuote.reason === 'out_of_coverage') ? 'Sorry, your address is outside our delivery area — please choose collection.' : 'Delivery isn’t available for this address — please choose collection.');
        return;
      }
      if (isDelivery && deliveryQuote?.belowMinimum) {
        const min = deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor / 100) : '';
        setError(`Minimum order for delivery is ${min}. Add more to your basket or switch to collection.`);
        return;
      }
      const missing = [];
      if (!name.trim()) missing.push('name');
      if (!/^\+?[0-9 ]{7,}$/.test(phone)) missing.push('phone number');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push('email');
      if (isDelivery && !address1.trim()) missing.push('delivery address');
      if (isDelivery && !postcode.trim()) missing.push('postcode');
      setError(missing.length ? `Please enter your ${missing.join(', ')}` : 'Please complete all required fields.');
      return;
    }
    setError('');
    // Already signed in or already dismissed loyalty — go straight through
    if (loyalty?.verified || loyaltyHintDismissed) { setStep('gift'); return; }
    // If we already detected a hint, show the gate
    if (loyaltyHint) { setShowLoyaltyGate(true); return; }
    // Otherwise do a quick one-shot check before proceeding
    const companyId = location.company_id;
    if (companyId && phone) {
      const normalised = phone.replace(/[\s\-()]/g, '');
      if (normalised.length >= 7) {
        try {
          const r = await fetch(`${FUNCTIONS_URL}/loyalty-balance?phone=${encodeURIComponent(normalised)}&company_id=${encodeURIComponent(companyId)}`);
          if (r.ok) {
            const j = await r.json();
            if (j?.member_code) { setLoyaltyHint(j); setShowLoyaltyGate(true); return; }
          }
        } catch {}
      }
    }
    setStep('gift');
  };
  // Gate: user chose "continue without loyalty"
  const skipLoyaltyGate = () => { setShowLoyaltyGate(false); setGateStep('prompt'); setGateCode(''); setGateError(''); setLoyaltyHintDismissed(true); setStep('gift'); };

  // v5.5.250: Inline OTP — send code using the phone already in the checkout form
  const otpUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-otp`;
  const sendGateCode = async () => {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.length < 10) { setGateError('Phone number is too short.'); return; }
    const companyId = location.company_id;
    if (!companyId) { setGateError('Unable to resolve venue.'); return; }
    setGateError(''); setGateWorking(true);
    try {
      const res = await fetch(otpUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', phone: cleaned, company_id: companyId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setGateStep('code');
    } catch (e) {
      setGateError(e?.message || 'Failed to send code.');
    } finally {
      setGateWorking(false);
    }
  };

  // v5.5.250: Inline OTP — verify code, then proceed with loyalty
  const verifyGateCode = async () => {
    const cleaned = gateCode.replace(/\D/g, '');
    if (cleaned.length < 6) { setGateError('Enter the 6-digit code.'); return; }
    const companyId = location.company_id;
    setGateError(''); setGateWorking(true);
    try {
      const res = await fetch(otpUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', phone: phone.replace(/[^\d+]/g, ''), company_id: companyId, code: cleaned }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Invalid code.');
      if (!j.verified) throw new Error('Verification failed.');
      // Success — update loyalty state in parent, then proceed
      setGateStep('done');
      onLoyaltyVerified?.(phone.replace(/[^\d+]/g, ''), {
        customer: j.customer,
        loyalty: j.loyalty,
        giftCards: j.gift_cards,
        stampCards: j.stamp_cards,
        token: j.token,
      });
      // Brief success flash, then close gate and advance
      setTimeout(() => {
        setShowLoyaltyGate(false);
        setGateStep('prompt'); setGateCode(''); setGateError('');
        setStep('gift');
      }, 800);
    } catch (e) {
      setGateError(e?.message || 'Verification failed.');
    } finally {
      setGateWorking(false);
    }
  };

  // ── Gift card lookup ──────────────────────────────────────────────────
  const lookupGiftCard = async () => {
    const clean = giftCode.replace(/[\s-]/g, '');
    if (clean.length < 16) { setGiftError('Enter the full 16-character code'); return; }
    setGiftLoading(true); setGiftError(''); setGiftCard(null);
    try {
      const token = await getAuthToken();
      const baseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${baseUrl}/functions/v1/gift-lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify({ code: clean, location_id: opsLocationId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.status !== 'active') throw new Error(`Card is ${j.status}`);
      if (j.balance <= 0) throw new Error('Card has zero balance');
      setGiftCard(j);
    } catch (e) {
      setGiftError(e?.message || 'Could not look up card');
    } finally {
      setGiftLoading(false);
    }
  };

  // ── Gift card redeem + continue ───────────────────────────────────────
  const applyGiftCard = async () => {
    if (!giftCard) return;
    setGiftLoading(true); setGiftError('');
    try {
      const redeemAmount = Math.min(giftCard.balance, subtotalMinor);
      if (redeemAmount <= 0) { setGiftError('Nothing to redeem'); setGiftLoading(false); return; }
      const idempotencyKey = `online:${orderShape.ref}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const token = await getAuthToken();
      const baseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${baseUrl}/functions/v1/gift-redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify({
          code: giftCode.replace(/[\s-]/g, ''),
          amount: redeemAmount,
          order_id: `online-${orderShape.ref}`,
          location_id: opsLocationId,
          channel: 'online',
          idempotency_key: idempotencyKey,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setGiftApplied({
        card_id: j.card_id,
        applied: j.applied,
        remaining_balance: j.remaining_balance,
        idempotency_key: idempotencyKey,
        code_last4: giftCard.code_last4 || giftCode.slice(-4),
      });
    } catch (e) {
      setGiftError(e?.message || 'Could not redeem gift card');
    } finally {
      setGiftLoading(false);
    }
  };

  // Gift step → rewards (if loyalty) or pay
  const continueFromGift = async () => {
    // v5.5.243: route through rewards step if loyalty is active
    // Only when points are enabled — a stamps-only venue has no points rewards.
    if (rewardsAvailable && !giftCoversAll) {
      setStep('rewards');
      return;
    }
    setWorking(true); setError('');
    try {
      if (giftCoversAll || fullyPaid) {
        await onGiftOnlyPayment();
      } else {
        await startPayment();
      }
    } catch (e) {
      console.error('[OnlineCheckout] continueFromGift failed:', e);
      setError(e?.message || 'Could not start payment.');
    } finally {
      setWorking(false);
    }
  };

  // Skip gift card → rewards (if loyalty + points) or Stripe payment
  const skipGiftCard = async () => {
    if (rewardsAvailable) { setStep('rewards'); return; }
    setWorking(true); setError('');
    try {
      await startPayment();
    } catch (e) {
      console.error('[OnlineCheckout] skipGiftCard failed:', e);
      setError(e?.message || 'Could not start payment.');
    } finally {
      setWorking(false);
    }
  };

  // Rewards step → pay (or place order if fully covered)
  const continueFromRewards = async () => {
    setWorking(true); setError('');
    try {
      if (fullyPaid) {
        await onGiftOnlyPayment();
      } else {
        await startPayment();
      }
    } catch (e) {
      console.error('[OnlineCheckout] continueFromRewards failed:', e);
      setError(e?.message || 'Could not start payment.');
    } finally {
      setWorking(false);
    }
  };

  // v5.5.243: Shared Stripe PI creation (used by multiple paths)
  // Dispatch to the location's processor. Ryft is card-not-present here —
  // RyftPaymentForm creates its own session, so we just advance to the pay step.
  // v5.5.660: hard delivery gate, evaluated at the LAST step before any payment/placement.
  // The valid() gate only governs the details→gift button; a fast customer could reach pay
  // before the debounced quote resolved, slipping a below-minimum / out-of-range delivery
  // order through. Returns an error string to block, or null to allow.
  const deliveryGateError = () => {
    if (!isDelivery) return null;
    if (!deliveryQuote) return 'Checking delivery for your address — one moment, then try again.';
    if (!deliveryQuote.available) return (deliveryQuote.reason === 'out_of_radius' || deliveryQuote.reason === 'out_of_coverage')
      ? 'Sorry, your address is outside our delivery area — please choose collection.'
      : 'Delivery isn’t available for this address — please choose collection.';
    if (deliveryQuote.belowMinimum) return `Minimum order for delivery is ${deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor / 100) : ''}. Add more to your basket or choose collection.`;
    return null;
  };

  const startPayment = async () => {
    const gate = deliveryGateError();
    if (gate) { setError(gate); setStep('details'); return; }
    if (processor === 'ryft') { setError(''); setStep('pay'); return; }
    return startStripePayment();
  };

  const startStripePayment = async () => {
    const token = await getAuthToken();
    const { ref, customer } = orderShape;
    const amountMinor = remainingMinor;
    const parts = [];
    if (giftApplied) parts.push('gift card');
    if (rewardApplied) parts.push('loyalty');
    const desc = `Online order ${ref} · ${customer.name}${parts.length ? ` (partial ${parts.join(' + ')})` : ''}`;
    const piRes = await createPaymentIntent({
      authToken: token,
      locationId: platformLocationId,
      amountMinor,
      currency: stripeCurrency(),
      channel: 'online',
      description: desc,
      paymentMethodTypes: ['card'],
      metadata: {
        source: 'online',
        ref,
        ops_location_id: String(opsLocationId),
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        order_type: orderType,
        ...(giftApplied ? { gift_card_applied: String(giftApplied.applied) } : {}),
        ...(rewardApplied ? { loyalty_reward: rewardApplied.reward_name, loyalty_discount: String(rewardApplied.discount_value) } : {}),
      },
    });
    if (!piRes?.client_secret) throw new Error('Payment could not start. Please try again.');
    setPi(piRes);
    setStripePromise(getStripeForAccount(piRes.stripe_account));
    setStep('pay');
  };

  // ── Fetch available rewards when entering rewards step ─────────────────
  useEffect(() => {
    if (step !== 'rewards' || !rewardsAvailable || availableRewards) return;
    (async () => {
      try {
        setRewardLoading(true);
        const token = await getAuthToken();
        const res = await fetch(`${FUNCTIONS_URL}/loyalty-rewards?company_id=${encodeURIComponent(loyalty.loyalty.company_id)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setAvailableRewards(j.rewards || []);
      } catch (e) {
        console.warn('[OnlineCheckout] fetch rewards failed:', e?.message);
        setAvailableRewards([]);
      } finally {
        setRewardLoading(false);
      }
    })();
  }, [step, rewardsAvailable]);

  // ── Redeem a loyalty reward ───────────────────────────────────────────
  const redeemReward = async (reward) => {
    setRewardLoading(true); setRewardError('');
    try {
      const token = await getAuthToken();
      const idempotencyKey = `online:${orderShape.ref}:reward:${Date.now()}`;
      const res = await fetch(`${FUNCTIONS_URL}/loyalty-redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company_id: loyalty.loyalty.company_id,
          customer_id: loyalty.loyalty.customer_id,
          reward_id: reward.id,
          order_id: `online-${orderShape.ref}`,
          channel: 'online',
          idempotency_key: idempotencyKey,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      // Calculate discount value in minor units
      // v5.5.247: normalise field names (DB uses reward_type/reward_value, some
      // legacy code used discount_type/discount_value)
      const rType = reward.reward_type || reward.discount_type || '';
      const rValue = reward.reward_value || {};
      let discountMinor = 0;
      if (rType === 'discount_fixed' || rType === 'fixed') {
        discountMinor = rValue.amount_minor || Math.round((reward.discount_value || 0) * 100);
      } else if (rType === 'discount_percent' || rType === 'percentage') {
        discountMinor = Math.round(subtotalMinor * (rValue.percent || reward.discount_value || 0) / 100);
      } else if (rType === 'free_item') {
        // v5.5.247: free item — find cheapest eligible item in cart
        const eligibleIds = new Set((rValue.eligible_items || []).map(ei => ei.id));
        if (eligibleIds.size > 0) {
          const matching = cart.filter(l => eligibleIds.has(l.itemId));
          if (matching.length > 0) {
            const cheapest = matching.reduce((a, b) => (a.price < b.price ? a : b));
            discountMinor = Math.round(cheapest.price * 100);
          }
        } else {
          // No eligible items configured — fallback to cheapest in cart
          const cheapest = [...cart].sort((a, b) => a.price - b.price)[0];
          discountMinor = cheapest ? Math.round(cheapest.price * 100) : 0;
        }
      }
      discountMinor = Math.min(discountMinor, subtotalMinor - giftAppliedMinor); // can't exceed remaining
      setRewardApplied({
        reward_id: reward.id,
        reward_name: reward.name,
        points_deducted: j.points_deducted || reward.points_cost || 0,
        discount_type: reward.reward_type || reward.discount_type,
        discount_value: discountMinor,
        idempotency_key: idempotencyKey,
        redemption_id: j.redemption_id || j.id,
      });
    } catch (e) {
      setRewardError(e?.message || 'Could not redeem reward');
    } finally {
      setRewardLoading(false);
    }
  };

  // ── Remove applied reward ─────────────────────────────────────────────
  const removeReward = () => {
    setRewardApplied(null);
    setRewardError('');
  };

  // Email + SMS the customer their order confirmation / receipt (best-effort; never blocks the
  // on-screen confirmation). Reuses the same receipt pipeline as catering/POS. The just-inserted
  // closed_checks row clears the send-receipt tenant fence via check_id.
  const sendOrderConfirmation = (closedCheck) => {
    try {
      const { ref, customer, items } = orderShape;
      const total = subtotal + deliveryFeeMinor / 100;
      const toEmail = (customer?.email || '').trim();
      if (toEmail) {
        sendEmailReceipt({
          to: toEmail, locationId: opsLocationId, locationLabel: location?.name,
          check: {
            id: closedCheck.id, ref, items, customer, closedAt: Date.now(), total,
            service: 0, tip: 0, taxAmount: taxBreakdown?.totalTax || 0, taxBreakdown,
            method: closedCheck.method || 'card', server: 'Online',
          },
        }).catch(() => {});
      }
      const toPhone = (customer?.phone || '').trim();
      if (toPhone && supabase) {
        supabase.functions.invoke('send-sms', {
          body: { to: toPhone, location_id: opsLocationId, type: 'order_confirmation',
            message: `Thanks for ordering with ${location?.name || 'us'}! Order ${ref} is confirmed — we'll let you know when it's ready.` },
        }).catch(() => {});
      }
    } catch { /* best-effort */ }
  };

  // ── Gift-only payment (no Stripe) ─────────────────────────────────────
  const onGiftOnlyPayment = async () => {
    const gate = deliveryGateError();
    if (gate) { setError(gate); setStep('details'); return; }
    try {
      const { ref, collectionAt, sentAt, customer, items } = orderShape;
      const collectionTimeLabel = collectionAt.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: orderType,
        status: 'prep',
        source: 'online',
        items, customer,
        total: subtotal + deliveryFeeMinor / 100,   // v5.5.657: include the delivery fee so the queue/kitchen total matches what was charged
        sent_at: sentAt.toISOString(),
        collection_time: collectionTimeLabel,
        is_asap: timeMode === 'asap',
      };
      const { error: insErr } = await supabase.from('order_queue').insert(queueRow);
      if (insErr) {
        console.error('[OnlineCheckout] order_queue write failed:', insErr);
        setError('Could not save the order. Contact the venue with ref ' + ref + '.');
        return;
      }

      try {
        const closedCheck = {
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref,
          location_id: opsLocationId,
          server: 'Online',
          staff_id: null,
          covers: 1,
          order_type: orderType,
          customer,
          items: items.map(i => ({ ...i, voided: false })),
          discounts: autoDiscounts,
          subtotal,
          service: 0,
          tip: 0,
          tax_amount: taxBreakdown?.totalTax || null,
          total: remainingMinor / 100,   // NET of gift card + loyalty (what was actually paid) — matches POS/kiosk
          method: rewardApplied && giftApplied ? 'split' : giftApplied ? 'gift_card' : rewardApplied ? 'loyalty' : 'gift_card',
          drawer_id: null,
          shift_id: null,
          closed_at: new Date().toISOString(),
          status: 'paid',
          refunds: [],
          table_id: null,
          table_label: `Online ${ref}`,
          source: 'online',
          gift_card: giftApplied ? {
            card_id: giftApplied.card_id,
            idempotency_key: giftApplied.idempotency_key,
            amount: giftApplied.applied,
          } : null,
          // v5.5.671: the column is `loyalty` (NOT loyalty_reward) — the wrong key made Postgres
          // reject the WHOLE insert ("column loyalty_reward does not exist"), silently caught, so
          // NO online order ever reached closed_checks (history / reports / EOD). Fixed.
          loyalty: rewardApplied ? {
            reward_id: rewardApplied.reward_id,
            reward_name: rewardApplied.reward_name,
            points_deducted: rewardApplied.points_deducted,
            discount_value: rewardApplied.discount_value,
            idempotency_key: rewardApplied.idempotency_key,
          } : null,
        };
        const { error: ccErr } = await supabase.from('closed_checks').insert(closedCheck);
        if (ccErr) console.warn('[OnlineCheckout] closed_checks insert failed:', ccErr.message);
        // v5.5.583: deplete recipe ingredients from the stock ledger (server-side, online is anonymous). Fire-and-forget.
        depleteForSaleServer({ id: closedCheck.id, items: cart.map(l => ({ itemId: l.itemId, qty: l.qty })), orderType });
        // v5.5.677: email + SMS the customer their confirmation/receipt (gift-only path).
        sendOrderConfirmation(closedCheck);
      } catch (e) {
        console.warn('[OnlineCheckout] closed_checks write threw:', e?.message);
      }

      attributeOnlineOrder({
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        marketingOptIn: false,
        locationId: opsLocationId,
        orderRecord: { ref, total: subtotal, items, type: orderType },
      }).catch(e => console.warn('[OnlineCheckout] attribute failed:', e?.message || e));

      // v5.5.287: Decrement stock for each item in the order
      decrementOnlineStock(cart, opsLocationId);

      onPlaced?.({ ref, collectionAt, total: subtotal, paymentIntent: null });
    } catch (e) {
      console.error('[OnlineCheckout] gift-only order failed:', e);
      setError('Could not save the order. Contact the venue.');
    }
  };

  // Called by the inner ConfirmStep after stripe.confirmCardPayment succeeds.
  // Writes the order_queue row (status='received' so the operator chimes/
  // sees it instantly), clears cart, hands ref up to OnlineSurface so it
  // shows the live OrderTracker.
  const onPaymentSuccess = async (paymentIntent) => {
    try {
      const { ref, collectionAt, sentAt, customer, items } = orderShape;
      // The success payload is a Stripe PaymentIntent OR a Ryft payment-session.
      // Store the right id + processor so the order is refundable later.
      const payId = processor === 'ryft' ? (paymentIntent?.sessionId || paymentIntent?.id || null) : (paymentIntent?.id || null);
      const collectionTimeLabel = collectionAt.toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: orderType,
        // v5.5.137: paid online orders go straight to 'prep' — payment is
        // confirmed, the kitchen owns it. 'received' was a redundant stage
        // that required the operator to manually advance every order.
        // KDS auto-status integration (next commit) ties bumped → ready
        // → collected so operators don't touch the order at all.
        status: 'prep',
        source: 'online',
        items, customer,
        total: subtotal + deliveryFeeMinor / 100,   // v5.5.657: include the delivery fee so the queue/kitchen total matches what was charged
        sent_at: sentAt.toISOString(),
        collection_time: collectionTimeLabel,
        is_asap: timeMode === 'asap',
      };
      const { error: insErr } = await supabase.from('order_queue').insert(queueRow);
      if (insErr) {
        console.error('[OnlineCheckout] order_queue write failed AFTER payment:', insErr);
        setError('Payment succeeded but we could not save the order. Contact the venue with ref ' + ref + '.');
        return;
      }

      // v5.5.127: also write to closed_checks so the paid online order shows
      // up in History / EOD / Payments reports identically to in-store paid
      // orders. status='paid' (not 'open') because Stripe already collected.
      // The receipt formatter prints check.ref as "ORDER #" — no extra wiring.
      try {
        const closedCheck = {
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref,
          location_id: opsLocationId,
          server: 'Online',
          staff_id: null,
          covers: 1,
          order_type: orderType,
          customer,
          items: items.map(i => ({ ...i, voided: false })),
          discounts: autoDiscounts,
          subtotal,
          service: 0,
          tip: 0,
          tax_amount: taxBreakdown?.totalTax || null, // v5.5.154: VAT for reports + receipt
          total: remainingMinor / 100,   // NET of gift card + loyalty (what was actually paid) — matches POS/kiosk
          method: (giftApplied || rewardApplied) ? 'split' : 'card',
          stripe_payment_intent_id: payId,
          payment_intents: payId ? [{ id: payId, amountMinor: remainingMinor }] : null,
          processor,   // 'stripe' | 'ryft' — refund routes by this
          payment_method: (giftApplied || rewardApplied)
            ? [
                giftApplied ? `gift_card:${(giftApplied.applied / 100).toFixed(2)}` : null,
                rewardApplied ? `loyalty:${(rewardApplied.discount_value / 100).toFixed(2)}` : null,
                `card:${(remainingMinor / 100).toFixed(2)}`,
              ].filter(Boolean).join(',')
            : undefined,
          drawer_id: null,
          shift_id: null,
          closed_at: new Date().toISOString(),
          status: 'paid',
          refunds: [],
          table_id: null,
          table_label: `Online ${ref}`,
          source: 'online', // v5.5.140: tag closed_checks for report filtering
          gift_card: giftApplied ? {
            card_id: giftApplied.card_id,
            idempotency_key: giftApplied.idempotency_key,
            amount: giftApplied.applied,
          } : null,
          // v5.5.671: the column is `loyalty` (NOT loyalty_reward) — the wrong key made Postgres
          // reject the WHOLE insert ("column loyalty_reward does not exist"), silently caught, so
          // NO online order ever reached closed_checks (history / reports / EOD). Fixed.
          loyalty: rewardApplied ? {
            reward_id: rewardApplied.reward_id,
            reward_name: rewardApplied.reward_name,
            points_deducted: rewardApplied.points_deducted,
            discount_value: rewardApplied.discount_value,
            idempotency_key: rewardApplied.idempotency_key,
          } : null,
        };
        const { error: ccErr } = await supabase.from('closed_checks').insert(closedCheck);
        if (ccErr) console.warn('[OnlineCheckout] closed_checks insert failed:', ccErr.message);
        // v5.5.583: deplete recipe ingredients from the stock ledger (server-side, online is anonymous). Fire-and-forget.
        depleteForSaleServer({ id: closedCheck.id, items: cart.map(l => ({ itemId: l.itemId, qty: l.qty })), orderType });
        // v5.5.677: email + SMS the customer their confirmation/receipt (was never wired for online).
        sendOrderConfirmation(closedCheck);
      } catch (e) {
        console.warn('[OnlineCheckout] closed_checks write threw:', e?.message);
      }

      // Customer profile: every online order/visit flows into the same CRM
      // the operator UI uses (customers + customer_locations + customer_orders).
      // Fire-and-forget — a CRM blip never blocks the confirmation flow.
      attributeOnlineOrder({
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        marketingOptIn: false,
        locationId: opsLocationId,
        orderRecord: { ref, total: subtotal, items, type: orderType },
      }).catch(e => console.warn('[OnlineCheckout] attribute failed:', e?.message || e));

      // v5.5.287: Decrement stock for each item in the order
      decrementOnlineStock(cart, opsLocationId);

      // v5.5.648: delivery surcharge log + courier dispatch (edge fn routes by venue
      // dispatch_backend: Uber API or HubRise Bridge). Fire-and-forget — never blocks
      // the customer's confirmation.
      if (isDelivery && deliveryQuote?.available) {
        const dq = { ...deliveryQuote, dropoff: customer.address };
        recordDeliverySurcharge({ opsLocationId, orderRef: ref, quote: dq }).catch(() => {});
        // Only dispatch a courier in 'uber' mode; self-delivery just fires to the kitchen.
        if (deliveryQuote.dispatchable) {
          dispatchDelivery({ opsLocationId, order: { ref, items, total: subtotal + deliveryFeeMinor / 100, customer }, quote: dq }).catch(() => {});
        }
      }

      onPlaced?.({ ref, collectionAt, total: subtotal, paymentIntent });
    } catch (e) {
      console.error('[OnlineCheckout] post-payment write failed:', e);
      setError('Payment succeeded but we could not save the order. Contact the venue with ref ' + orderShape.ref + '.');
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600,
        maxHeight: '96vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      }}>
        <div style={{ padding: '12px 0 6px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>

        <div style={{ padding: '8px 24px 16px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>
              {step === 'pay' ? 'Payment' : step === 'rewards' ? 'Rewards' : step === 'gift' ? 'Gift Card' : 'Checkout'}
            </div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              {isDelivery ? 'Delivery' : 'Collection'} · {cart.length} item{cart.length === 1 ? '' : 's'} · {money(subtotal)}
              {autoDiscountMinor > 0 ? ` · Offers -${money((autoDiscountMinor / 100))}` : ''}
              {giftApplied ? ` · Gift card -${money((giftApplied.applied / 100))}` : ''}
              {rewardApplied ? ` · Reward -${money((rewardApplied.discount_value / 100))}` : ''}
              {deliveryFeeMinor > 0 ? ` · Delivery +${money((deliveryFeeMinor / 100))}` : (isDelivery && deliveryQuote?.available && deliveryQuote.freeDelivery ? ' · Delivery free' : '')}
              {isDelivery && deliveryQuote?.belowMinimum ? ` · Min order ${deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor / 100) : ''}` : ''}
            </div>
          </div>
          <button onClick={
            step === 'pay' ? () => { setStep(rewardsAvailable ? 'rewards' : 'gift'); setPi(null); setError(''); }
            : step === 'rewards' ? () => { setStep('gift'); setRewardError(''); setError(''); }
            : step === 'gift' ? () => { setStep('details'); setError(''); }
            : onClose
          }
            className="op-btn"
            style={{
              padding: '0 14px', height: 36, borderRadius: 99, border: `1px solid ${cardBdr}`,
              background: inputBg, color: theme.fg,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}>{step === 'details' ? '×' : '← Back'}</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, padding: '0 24px 14px' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: theme.accent }}/>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step !== 'details' ? theme.accent : cardBdr }}/>
          {rewardsAvailable && <div style={{ flex: 1, height: 4, borderRadius: 2, background: (step === 'rewards' || step === 'pay') ? theme.accent : cardBdr }}/>}
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'pay' ? theme.accent : cardBdr }}/>
        </div>

        {/* ── STEP: PAY (Ryft card, card-not-present) ─────────────────── */}
        {step === 'pay' && processor === 'ryft' ? (
          <div style={{ padding: '0 24px 16px' }}>
            <RyftPaymentForm
              amountMinor={remainingMinor}
              currency={stripeCurrency()}
              locationId={platformLocationId}
              channel="online"
              merchantName={location?.name || ''}
              customerEmail={orderShape?.customer?.email}
              payLabel={`Pay ${money(remainingMinor / 100)}`}
              onSuccess={onPaymentSuccess}
              onError={(e) => setError(e?.message || 'Payment failed')}
            />
            {error && <div style={{ color: theme.danger || '#e5484d', fontSize: 13, marginTop: 10 }}>{error}</div>}
          </div>
        ) : /* ── STEP: PAY (Stripe card) ──────────────────────────────── */
        step === 'pay' && pi && stripePromise ? (
          <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret, appearance: { theme: theme.isLight ? 'stripe' : 'night' } }}>
            <PayStep
              pi={pi} subtotal={remainingMinor / 100} theme={theme} cardBdr={cardBdr} inputBg={inputBg} muted={muted}
              cart={cart} giftApplied={giftApplied} rewardApplied={rewardApplied}
              onPaid={onPaymentSuccess}
              onError={setError}
              error={error}
            />
          </Elements>
        ) : step === 'gift' ? (
        /* ── STEP: GIFT CARD ──────────────────────────────────────────── */
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SectionTitle>Have a gift card?</SectionTitle>
          <div style={{ fontSize: 13, color: muted, lineHeight: 1.5, marginTop: -8 }}>
            Enter your gift card code to apply it to this order. You can also skip this step and pay by card.
          </div>

          {/* Gift card code entry */}
          {!giftApplied && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={giftCode}
                  onChange={e => setGiftCode(e.target.value.toUpperCase())}
                  placeholder="XXXX XXXX XXXX XXXX"
                  maxLength={19}
                  style={{
                    flex: 1, padding: '13px 14px', borderRadius: 10,
                    background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
                    fontSize: 15, fontFamily: 'monospace', letterSpacing: '0.06em',
                    outline: 'none', boxSizing: 'border-box',
                  }}
                />
                <button
                  onClick={lookupGiftCard}
                  disabled={giftLoading || giftCode.replace(/[\s-]/g, '').length < 16}
                  className="op-btn"
                  style={{
                    padding: '0 18px', borderRadius: 10,
                    background: theme.accent, color: contrastFg(theme.accent),
                    border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    fontFamily: 'inherit', opacity: giftLoading ? 0.6 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {giftLoading ? '…' : 'Look up'}
                </button>
              </div>

              {giftError && <div style={{ fontSize: 12, color: '#ef4444' }}>{giftError}</div>}

              {/* Card info + apply button */}
              {giftCard && (
                <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, color: muted, fontWeight: 600 }}>Gift card ····{giftCard.code_last4}</div>
                      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2 }}>
                        {money((giftCard.balance / 100))} <span style={{ fontSize: 12, fontWeight: 500, color: muted }}>balance</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 28 }}>💳</div>
                  </div>
                  <div style={{ fontSize: 12, color: muted, marginBottom: 10 }}>
                    {giftCard.balance >= subtotalMinor
                      ? `This card will cover the full order (${money(subtotal)}). No card payment needed.`
                      : `This card will pay ${money((giftCard.balance / 100))} of your ${money(subtotal)} order. You'll pay the remaining ${money(((subtotalMinor - giftCard.balance) / 100))} by card.`
                    }
                  </div>
                  <button
                    onClick={applyGiftCard}
                    disabled={giftLoading}
                    className="op-btn-primary"
                    style={{
                      width: '100%', padding: '13px', borderRadius: 10,
                      background: theme.accent, color: contrastFg(theme.accent),
                      border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                      fontFamily: 'inherit', opacity: giftLoading ? 0.6 : 1,
                    }}
                  >
                    {giftLoading ? 'Applying…' : `Apply ${money((Math.min(giftCard.balance, subtotalMinor) / 100))} from gift card`}
                  </button>
                </div>
              )}
            </>
          )}

          {/* Applied confirmation */}
          {giftApplied && (
            <div style={{
              background: `${theme.accent}18`, border: `1.5px solid ${theme.accent}50`,
              borderRadius: 12, padding: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>✅</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Gift card applied</span>
              </div>
              <div style={{ fontSize: 13, color: muted }}>
                {money((giftApplied.applied / 100))} deducted from card ····{giftApplied.code_last4}
              </div>
              {!giftCoversAll && (
                <div style={{ fontSize: 13, color: muted, marginTop: 4 }}>
                  Remaining to pay by card: <strong style={{ color: theme.fg }}>{money((remainingMinor / 100))}</strong>
                </div>
              )}
              {giftCoversAll && (
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.accent, marginTop: 4 }}>
                  Your order is fully covered — no card needed!
                </div>
              )}
            </div>
          )}

          {/* Order summary */}
          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {line.qty || 1} × {line.name}
                    {line.notes ? <span style={{ display: 'block', fontSize: 12, color: `${theme.fg}99`, fontStyle: 'italic', marginTop: 2 }}>📝 {line.notes}</span> : null}
                  </span>
                  <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
                </div>
              );
            })}
            {giftApplied && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: theme.accent }}>
                <span>💳 Gift card</span>
                <span style={{ fontWeight: 700 }}>-{money((giftApplied.applied / 100))}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{giftApplied ? 'Remaining' : 'Total'}</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>{money((remainingMinor / 100))}</span>
            </div>
          </div>
        </div>
        ) : step === 'rewards' ? (
        /* ── STEP: REWARDS ───────────────────────────────────────────── */
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SectionTitle>Your rewards</SectionTitle>
          <div style={{ fontSize: 13, color: muted, lineHeight: 1.5, marginTop: -8 }}>
            {loyalty?.loyalty?.points_balance != null
              ? `You have ${loyalty.loyalty.points_balance} points. Browse available rewards below.`
              : 'Browse available rewards to redeem with your order.'}
          </div>

          {/* Applied reward confirmation */}
          {rewardApplied && (
            <div style={{
              background: `${theme.accent}18`, border: `1.5px solid ${theme.accent}50`,
              borderRadius: 12, padding: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>🎁</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Reward applied</span>
              </div>
              <div style={{ fontSize: 13, color: muted }}>
                {rewardApplied.reward_name} — {money((rewardApplied.discount_value / 100))} off
              </div>
              <button onClick={removeReward} className="op-btn" style={{
                marginTop: 10, padding: '8px 16px', borderRadius: 8,
                background: 'transparent', color: '#ef4444',
                border: '1px solid #ef444440', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>Remove reward</button>
            </div>
          )}

          {/* Available rewards list */}
          {!rewardApplied && (
            <>
              {rewardLoading && (
                <div style={{ textAlign: 'center', padding: '20px 0', color: muted, fontSize: 13 }}>
                  Loading rewards...
                </div>
              )}
              {!rewardLoading && availableRewards && availableRewards.length === 0 && (
                <div style={{
                  background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12,
                  padding: '20px 16px', textAlign: 'center',
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🏆</div>
                  <div style={{ fontSize: 13, color: muted }}>
                    No rewards available right now. Keep earning points!
                  </div>
                </div>
              )}
              {!rewardLoading && availableRewards && availableRewards.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {availableRewards.map(reward => {
                    const canAfford = (loyalty?.loyalty?.points_balance || 0) >= (reward.points_cost || 0);
                    return (
                      <div key={reward.id} style={{
                        background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12,
                        padding: '14px 16px', opacity: canAfford ? 1 : 0.5,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700 }}>{reward.name}</div>
                            {reward.description && (
                              <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{reward.description}</div>
                            )}
                            <div style={{ fontSize: 12, color: theme.accent, fontWeight: 600, marginTop: 4 }}>
                              {reward.points_cost} points
                              {(reward.reward_type === 'discount_fixed' || reward.discount_type === 'fixed') && ` · ${money(((reward.reward_value?.amount_minor || 0) / 100))} off`}
                              {(reward.reward_type === 'discount_percent' || reward.discount_type === 'percentage') && ` · ${reward.reward_value?.percent || reward.discount_value || 0}% off`}
                              {(reward.reward_type === 'free_item' || reward.discount_type === 'free_item') && ' · Free item'}
                            </div>
                          </div>
                          <button
                            onClick={() => redeemReward(reward)}
                            disabled={!canAfford || rewardLoading}
                            className="op-btn"
                            style={{
                              padding: '8px 16px', borderRadius: 8, marginLeft: 10,
                              background: canAfford ? theme.accent : `${theme.fg}20`,
                              color: canAfford ? contrastFg(theme.accent) : `${theme.fg}60`,
                              border: 'none', fontSize: 12, fontWeight: 700,
                              cursor: canAfford ? 'pointer' : 'not-allowed',
                              fontFamily: 'inherit', whiteSpace: 'nowrap',
                            }}
                          >
                            {canAfford ? 'Redeem' : 'Not enough'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {rewardError && <div style={{ fontSize: 12, color: '#ef4444' }}>{rewardError}</div>}
            </>
          )}

          {/* Order summary */}
          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {line.qty || 1} × {line.name}
                    {line.notes ? <span style={{ display: 'block', fontSize: 12, color: `${theme.fg}99`, fontStyle: 'italic', marginTop: 2 }}>📝 {line.notes}</span> : null}
                  </span>
                  <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
                </div>
              );
            })}
            {giftApplied && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: theme.accent }}>
                <span>💳 Gift card</span>
                <span style={{ fontWeight: 700 }}>-{money((giftApplied.applied / 100))}</span>
              </div>
            )}
            {rewardApplied && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: theme.accent }}>
                <span>🎁 {rewardApplied.reward_name}</span>
                <span style={{ fontWeight: 700 }}>-{money((rewardApplied.discount_value / 100))}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{(giftApplied || rewardApplied) ? 'Remaining' : 'Total'}</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>{money((remainingMinor / 100))}</span>
            </div>
          </div>
        </div>
        ) : (
        /* ── STEP: DETAILS ────────────────────────────────────────────── */
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 1. Your details */}
          <SectionTitle>Your details</SectionTitle>
          <Field label="Name" value={name} onChange={setName} placeholder="Full name" required theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone" value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" required theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            <Field label="Email" value={email} onChange={setEmail} placeholder="you@example.com" type="email" required theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          </div>
          {/* v5.5.243: Loyalty member detection hint */}
          {loyaltyHint && !loyaltyHintDismissed && !loyalty?.verified && (
            <div style={{
              background: `${theme.accent}12`, border: `1.5px solid ${theme.accent}40`,
              borderRadius: 12, padding: '12px 14px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 22 }}>⭐</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>You're a loyalty member!</div>
                <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                  {pointsEnabled && loyaltyHint.points_balance != null ? `${loyaltyHint.points_balance} points available. ` : ''}
                  {pointsEnabled ? 'Sign in to redeem rewards with your order.' : 'Sign in to apply your loyalty rewards.'}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                {onOpenLoyalty && (
                  <button onClick={onOpenLoyalty} className="op-btn" style={{
                    padding: '7px 14px', borderRadius: 8,
                    background: theme.accent, color: contrastFg(theme.accent),
                    border: 'none', fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                  }}>Sign in</button>
                )}
                <button onClick={() => setLoyaltyHintDismissed(true)} className="op-btn" style={{
                  padding: '4px 8px', background: 'transparent', border: 'none',
                  fontSize: 11, color: muted, cursor: 'pointer', fontFamily: 'inherit',
                }}>Dismiss</button>
              </div>
            </div>
          )}

          {isDelivery && (
            <>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Delivery address</div>
                <AddressAutocomplete
                  value={address1}
                  onChangeText={(t) => { setAddress1(t); setDeliveryGeo(null); }}
                  onSelect={(a) => { setAddress1(a.line1 || a.label); if (a.postcode) setPostcode(a.postcode); setDeliveryGeo(a.lat != null ? { lat: a.lat, lng: a.lng } : null); }}
                  proximity={(location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) ? { lat: location.lat, lng: location.lng } : undefined}
                  placeholder="Start typing your address…"
                  inputStyle={{ width: '100%', padding: '12px 14px', borderRadius: 10, background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
              <Field label="Postcode" value={postcode} onChange={(v) => { setPostcode(v); setDeliveryGeo(null); }} placeholder="SW1A 1AA" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            </>
          )}
          {isDelivery && deliveryQuote?.belowMinimum && (
            <div style={{ background: '#fffbeb', border: '1.5px solid #f59e0b', borderRadius: 12, padding: '12px 14px', color: '#92400e', fontSize: 13.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <span>Minimum order for delivery is {deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor / 100) : ''}. Add {money(Math.max(0, ((deliveryQuote.minOrderMinor || 0) - discountedSubtotalMinor) / 100))} more, or switch to collection.</span>
            </div>
          )}
          <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Buzzer / leave at door / dietary…" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>

          {/* 2. When? */}
          <SectionTitle>When?</SectionTitle>
          <div style={{ display: 'flex', gap: 8 }}>
            <ModeChip active={timeMode === 'asap'} onClick={() => setTimeMode('asap')}
              theme={theme} cardBdr={cardBdr}>
              ⚡ ASAP <span style={{ opacity: 0.6, marginLeft: 4 }}>· ~{leadMin} min</span>
            </ModeChip>
            <ModeChip active={timeMode === 'scheduled'} onClick={() => setTimeMode('scheduled')}
              theme={theme} cardBdr={cardBdr}>
              🗓 Schedule
            </ModeChip>
          </div>
          {timeMode === 'scheduled' && (
            <SlotPicker slots={slots} value={slot} onChange={setSlot} theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          )}

          {/* 3. Summary */}
          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {line.qty || 1} × {line.name}
                    {line.notes ? <span style={{ display: 'block', fontSize: 12, color: `${theme.fg}99`, fontStyle: 'italic', marginTop: 2 }}>📝 {line.notes}</span> : null}
                  </span>
                  <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
                </div>
              );
            })}
            {taxBreakdown.totalTax > 0 && taxBreakdown.breakdown.map((b, i) => (
              <div key={`vat-${i}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: muted }}>
                <span>incl. {b.rate.name || `VAT ${(Number(b.rate.rate) * 100).toFixed(0)}%`}</span>
                <span>{money(b.tax)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>{money(subtotal)}</span>
            </div>
          </div>
        </div>
        )}

        {/* Sticky bottom button — details step */}
        {step === 'details' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={continueToGift} disabled={!valid || working} className="op-btn-primary" style={{
              width: '100%', padding: '16px 22px', borderRadius: 14,
              background: valid ? theme.accent : `${theme.fg}20`,
              color: valid ? contrastFg(theme.accent) : `${theme.fg}60`,
              border: 'none', fontSize: 16, fontWeight: 800, cursor: valid && !working ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Continue to payment</span>
              <span>{money(subtotal)}</span>
            </button>
          </div>
        )}

        {/* Sticky bottom buttons — gift step */}
        {step === 'gift' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            {giftApplied ? (
              <button onClick={continueFromGift} disabled={working} className="op-btn-primary" style={{
                width: '100%', padding: '16px 22px', borderRadius: 14,
                background: theme.accent, color: contrastFg(theme.accent),
                border: 'none', fontSize: 16, fontWeight: 800, cursor: working ? 'wait' : 'pointer',
                fontFamily: 'inherit', opacity: working ? 0.7 : 1,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>{working ? 'Processing…' : giftCoversAll ? 'Place order' : rewardsAvailable ? 'Continue to rewards' : 'Continue to card payment'}</span>
                <span>{money((remainingMinor / 100))}</span>
              </button>
            ) : (
              <button onClick={skipGiftCard} disabled={working} className="op-btn-primary" style={{
                width: '100%', padding: '16px 22px', borderRadius: 14,
                background: theme.accent, color: contrastFg(theme.accent),
                border: 'none', fontSize: 16, fontWeight: 800, cursor: working ? 'wait' : 'pointer',
                fontFamily: 'inherit', opacity: working ? 0.7 : 1,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>{working ? 'Starting payment…' : rewardsAvailable ? 'Skip to rewards' : 'Pay by card'}</span>
                <span>{money(subtotal)}</span>
              </button>
            )}
            {!giftApplied && !rewardsAvailable && (
              <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
                🔒 Card details next, processed securely by Stripe.
              </div>
            )}
          </div>
        )}

        {/* Sticky bottom button — rewards step */}
        {step === 'rewards' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={continueFromRewards} disabled={working} className="op-btn-primary" style={{
              width: '100%', padding: '16px 22px', borderRadius: 14,
              background: theme.accent, color: contrastFg(theme.accent),
              border: 'none', fontSize: 16, fontWeight: 800, cursor: working ? 'wait' : 'pointer',
              fontFamily: 'inherit', opacity: working ? 0.7 : 1,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>{working ? 'Processing…' : fullyPaid ? 'Place order' : rewardApplied ? 'Continue to card payment' : 'Skip rewards'}</span>
              <span>{money((remainingMinor / 100))}</span>
            </button>
            {!rewardApplied && !fullyPaid && (
              <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
                🔒 Card details next, processed securely by Stripe.
              </div>
            )}
          </div>
        )}
      </div>

      {/* v5.5.250: Loyalty gate with inline OTP — stays inside checkout,
          no form data lost. Three sub-steps: prompt → code → done */}
      {showLoyaltyGate && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }} onClick={() => { if (gateStep === 'prompt') { setShowLoyaltyGate(false); } }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: theme.bg, borderRadius: 20, padding: '28px 24px',
            maxWidth: 380, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            border: `1px solid ${cardBdr}`,
          }}>
            {gateStep === 'done' ? (
              /* ── Success flash ─────────────────────────────────────── */
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 10 }}>✦</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: theme.accent }}>
                  You're signed in!
                </div>
                <div style={{ fontSize: 13, color: muted, marginTop: 8 }}>
                  Your rewards will be available at the next step.
                </div>
              </div>
            ) : gateStep === 'code' ? (
              /* ── Enter 6-digit code ────────────────────────────────── */
              <>
                <div style={{ textAlign: 'center', marginBottom: 18 }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>📱</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: theme.fg }}>
                    Check your texts
                  </div>
                  <div style={{ fontSize: 13, color: muted, marginTop: 8, lineHeight: 1.5 }}>
                    We've sent a 6-digit code to <strong style={{ color: theme.fg }}>{phone}</strong>. Enter it below to sign in.
                  </div>
                </div>

                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={gateCode}
                  onChange={e => setGateCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => { if (e.key === 'Enter') verifyGateCode(); }}
                  placeholder="000000"
                  autoFocus
                  style={{
                    width: '100%', padding: '16px 0', borderRadius: 12,
                    background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
                    fontSize: 28, fontWeight: 800, fontFamily: 'monospace',
                    textAlign: 'center', letterSpacing: '0.3em',
                    outline: 'none', boxSizing: 'border-box', marginBottom: 12,
                  }}
                />

                {gateError && <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center', marginBottom: 10 }}>{gateError}</div>}

                <button
                  onClick={verifyGateCode}
                  disabled={gateWorking || gateCode.length < 6}
                  className="op-btn"
                  style={{
                    width: '100%', padding: '14px 20px', borderRadius: 12,
                    background: gateCode.length >= 6 ? theme.accent : `${theme.fg}20`,
                    color: gateCode.length >= 6 ? contrastFg(theme.accent) : `${theme.fg}60`,
                    border: 'none', fontSize: 15, fontWeight: 800,
                    cursor: gateWorking ? 'wait' : gateCode.length >= 6 ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit', marginBottom: 10,
                    opacity: gateWorking ? 0.7 : 1,
                  }}
                >
                  {gateWorking ? 'Verifying…' : 'Verify & sign in'}
                </button>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => { setGateStep('prompt'); setGateCode(''); setGateError(''); }}
                    className="op-btn"
                    style={{
                      flex: 1, padding: '10px 14px', borderRadius: 10,
                      background: 'transparent', color: muted,
                      border: `1px solid ${cardBdr}`, fontSize: 12, fontWeight: 600,
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    ← Back
                  </button>
                  <button
                    onClick={sendGateCode}
                    disabled={gateWorking}
                    className="op-btn"
                    style={{
                      flex: 1, padding: '10px 14px', borderRadius: 10,
                      background: 'transparent', color: theme.accent,
                      border: `1px solid ${theme.accent}40`, fontSize: 12, fontWeight: 600,
                      cursor: gateWorking ? 'wait' : 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Resend code
                  </button>
                </div>
              </>
            ) : (
              /* ── Initial prompt ────────────────────────────────────── */
              <>
                <div style={{ textAlign: 'center', marginBottom: 18 }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>⭐</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: theme.fg }}>
                    You're a loyalty member!
                  </div>
                  <div style={{ fontSize: 13, color: muted, marginTop: 8, lineHeight: 1.5 }}>
                    {pointsEnabled
                      ? (loyaltyHint?.points_balance != null
                          ? `You have ${loyaltyHint.points_balance} points. Sign in to redeem rewards and earn points on this order.`
                          : 'Sign in to redeem rewards and earn points on this order.')
                      : 'Sign in to apply your loyalty rewards on this order.'}
                  </div>
                </div>

                {gateError && <div style={{ fontSize: 12, color: '#ef4444', textAlign: 'center', marginBottom: 10 }}>{gateError}</div>}

                <button
                  onClick={sendGateCode}
                  disabled={gateWorking}
                  className="op-btn"
                  style={{
                    width: '100%', padding: '14px 20px', borderRadius: 12,
                    background: theme.accent, color: contrastFg(theme.accent),
                    border: 'none', fontSize: 15, fontWeight: 800,
                    cursor: gateWorking ? 'wait' : 'pointer', fontFamily: 'inherit', marginBottom: 10,
                    opacity: gateWorking ? 0.7 : 1,
                  }}
                >
                  {gateWorking ? 'Sending code…' : 'Sign in with text code'}
                </button>
                <button
                  onClick={skipLoyaltyGate}
                  className="op-btn"
                  style={{
                    width: '100%', padding: '12px 20px', borderRadius: 12,
                    background: 'transparent', color: muted,
                    border: `1px solid ${cardBdr}`, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Continue without loyalty
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PayStep — renders the CardElement + Pay button. Lives inside <Elements>
// so it can use useStripe() / useElements() to confirm the PaymentIntent.
function PayStep({ pi, subtotal, theme, cardBdr, inputBg, muted, cart, giftApplied, rewardApplied, onPaid, onError, error }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true); onError('');
    const card = elements.getElement(CardElement);
    const { error: stripeErr, paymentIntent } = await stripe.confirmCardPayment(pi.client_secret, {
      payment_method: { card },
    });
    setBusy(false);
    if (stripeErr) {
      onError(stripeErr.message || 'Card declined.');
      return;
    }
    if (paymentIntent?.status === 'succeeded') {
      await onPaid(paymentIntent);
    } else {
      onError(`Payment status: ${paymentIntent?.status || 'unknown'}.`);
    }
  };

  return (
    <>
      <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionTitle>Card details</SectionTitle>
        <div style={{
          padding: 14, borderRadius: 12, border: `1.5px solid ${cardBdr}`,
          background: inputBg,
        }}>
          <CardElement options={{
            style: { base: {
              color: theme.fg,
              fontSize: '16px',
              fontFamily: 'inherit',
              '::placeholder': { color: theme.isLight ? '#9a9aa1' : '#7d7d85' },
            } },
          }}/>
        </div>
        <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
          Test mode: use card <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>4242 4242 4242 4242</code> · any future expiry · any CVC.
        </div>

        {/* Mini summary so customer sees what they're paying for */}
        <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px', marginTop: 4 }}>
          {cart.map(line => {
            const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
            return (
              <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
              </div>
            );
          })}
          {giftApplied && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: theme.accent }}>
              <span>💳 Gift card</span>
              <span style={{ fontWeight: 700 }}>-{money((giftApplied.applied / 100))}</span>
            </div>
          )}
          {rewardApplied && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: theme.accent }}>
              <span>🎁 {rewardApplied.reward_name}</span>
              <span style={{ fontWeight: 700 }}>-{money((rewardApplied.discount_value / 100))}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>{(giftApplied || rewardApplied) ? 'Card payment' : 'Total'}</span>
            <span style={{ fontSize: 18, fontWeight: 900 }}>{money(subtotal)}</span>
          </div>
        </div>
      </div>

      <div style={{
        position: 'sticky', bottom: 0,
        padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
        background: theme.bg, borderTop: `1px solid ${cardBdr}`,
      }}>
        {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
        <button onClick={submit} disabled={busy || !stripe} className="op-btn-primary" style={{
          width: '100%', padding: '16px 22px', borderRadius: 14,
          background: theme.accent, color: contrastFg(theme.accent),
          border: 'none', fontSize: 16, fontWeight: 800, cursor: busy ? 'wait' : 'pointer',
          fontFamily: 'inherit', opacity: busy ? 0.7 : 1,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{busy ? 'Processing payment…' : 'Pay & place order'}</span>
          <span>{money(subtotal)}</span>
        </button>
        <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
          🔒 Your order is only sent to the kitchen once payment clears.
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em', textTransform: 'uppercase', opacity: 0.7 }}>{children}</div>;
}

function Field({ label, value, onChange, placeholder, type = 'text', required, theme, cardBdr, inputBg }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
      </div>
      <input type={type} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
          fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        }}/>
    </div>
  );
}

function ModeChip({ active, onClick, theme, cardBdr, children }) {
  return (
    <button onClick={onClick} className="op-btn" style={{
      flex: 1, padding: '16px 16px', borderRadius: 12,
      // Active = solid accent fill + contrast text + checkmark.
      // Inactive = transparent with thin border, dimmed.
      background: active ? theme.accent : 'transparent',
      color: active ? contrastFg(theme.accent) : theme.fg,
      border: `2px solid ${active ? theme.accent : cardBdr}`,
      boxShadow: active ? `0 4px 14px ${theme.accent}55` : 'none',
      fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
      opacity: active ? 1 : 0.7,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    }}>
      {active && <span style={{ fontSize: 14 }}>✓</span>}
      {children}
    </button>
  );
}

function SlotPicker({ slots, value, onChange, theme, cardBdr, inputBg }) {
  if (!slots.length) {
    return <div style={{ padding: 14, fontSize: 12, color: theme.isLight ? '#6b6b70' : '#a0a0a8', background: inputBg, borderRadius: 10, border: `1px solid ${cardBdr}` }}>
      No collection slots available right now. Try ASAP, or come back during opening hours.
    </div>;
  }
  // Group by day, preserving insertion order (already chronological)
  const byDay = {};
  slots.forEach(s => {
    if (!byDay[s.day]) byDay[s.day] = [];
    byDay[s.day].push(s);
  });
  const days = Object.keys(byDay);
  // If no value yet, default to first slot of first day so the time
  // dropdown isn't blank when the customer first picks Schedule.
  const selectedDay = value ? value.day : days[0];
  const selectedTime = value ? value.iso : '';
  const timesForDay = byDay[selectedDay] || [];

  const handleDayChange = (day) => {
    const list = byDay[day] || [];
    if (list.length) onChange(list[0]);
  };
  const handleTimeChange = (iso) => {
    const slot = (byDay[selectedDay] || []).find(s => s.iso === iso);
    if (slot) onChange(slot);
  };

  const selectStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 10,
    background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
    fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
    fontWeight: 600,
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1 1l5 5 5-5' stroke='%23${(theme.isLight ? '6b6b70' : 'a0a0a8')}' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 14px center',
    paddingRight: 36,
    cursor: 'pointer',
  };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, display: 'block' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <div>
        <label style={labelStyle}>Day</label>
        <select value={selectedDay} onChange={e => handleDayChange(e.target.value)} style={selectStyle}>
          {days.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Time</label>
        <select value={selectedTime} onChange={e => handleTimeChange(e.target.value)} style={selectStyle}>
          {timesForDay.map(s => (
            <option key={s.iso} value={s.iso}>{s.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the next ~24h of valid collection slots.
// Slots are 15-min increments inside opening windows, starting at the
// earliest slot ≥ now+leadMin, snapped to :00/:15/:30/:45.
function buildCollectionSlots(location, tz, leadMin) {
  const hours = location.opening_hours;
  if (!hours?.weekly) return [];
  const out = [];
  const now = new Date();
  const earliest = new Date(now.getTime() + leadMin * 60_000);
  // Round up to next 15-min boundary
  const m = earliest.getMinutes();
  const ceil = Math.ceil(m / 15) * 15;
  earliest.setMinutes(ceil, 0, 0);

  // Walk up to 7 days ahead, generate slots inside open windows ≥ earliest
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60_000);
    const windows = getDayWindows(hours, tz, probe);
    if (!windows.length) continue;
    const dayLabel = probe.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    for (const w of windows) {
      const [oh, om] = w.open.split(':').map(Number);
      const [ch, cm] = w.close.split(':').map(Number);
      // Earliest valid slot in this window
      const cur = new Date(probe);
      cur.setHours(oh, om, 0, 0);
      const end = new Date(probe);
      end.setHours(ch, cm, 0, 0);
      while (cur.getTime() < end.getTime()) {
        if (cur.getTime() >= earliest.getTime()) {
          out.push({
            iso: cur.toISOString(),
            day: dayOffset === 0 ? 'Today' : (dayOffset === 1 ? 'Tomorrow' : dayLabel),
            label: cur.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
          });
        }
        cur.setMinutes(cur.getMinutes() + 15);
      }
    }
    if (out.length >= 60) break; // reasonable upper bound
  }
  return out;
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}
