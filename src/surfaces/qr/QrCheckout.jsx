// v5.5.145 — QR table-side checkout (commit 1: pay-now path only)
//
// Mirrors OnlineCheckout but for in-venue table service:
//   - No collection/delivery address; always dine-in
//   - No scheduled-time picker; always ASAP
//   - Tip selector (5% / 10% / 12.5% / 15% / Custom / No tip)
//   - Service charge auto-applied if location.qr_service_charge_pct is set
//   - Single "Pay & send to kitchen" button; the Adyen card and wallet form
//   - On success: writes closed_checks (status=paid, source=qr,
//     table_label='Table T5') AND order_queue (source='qr', type='dine-in',
//     status=prep, tableLabel) — kitchen routes via existing
//     routeKioskOrderPrints, prints with TABLE T5 header, KDS shows it
//
// Open-tab path (an Adyen pre-auth; no bar_tabs row, see feedback_qr_no_bartabs) landed in commit 2.
// Email receipts land in commit 3 (needs Resend/SES infra).

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { logOrderActivity, logActivity } from '../../lib/activity';
import { requestPaymentProof, placePublicOrder, publicRead } from '../../lib/publicOrderClient';
import { tabRoundJoinCode, publicOrderRefusalMessage, tabHoldFor, chooseTrackKey, afterPlaced, qrTableLabel, qrRowOnFloor } from '../../lib/publicOrder';
import AdyenPaymentForm from '../../components/AdyenPaymentForm';
import { attributeOnlineOrder } from '../../lib/customerLookup';
import { computeOrderTaxUnified, taxCtxHasConfig } from '../../lib/taxCompute';
import { publicCheckTaxFields, offerChargedTax, qrBillTotal } from '../../lib/publicCheckTax';
import VatGateNotice from '../online/VatGateNotice';
import { breakdownIsExclusive, taxTermFor } from '../../lib/receiptTax';   // v5.7.34: rate-null guards + VAT/Sales Tax wording
import { fetchActiveDiscountRules, venueServiceRuleCached, peekVenueServiceRule } from '../../lib/db';
import { qrServiceCharge } from '../../lib/venueServiceRule';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../../lib/discountEngine';
import { buildScheduleCtx } from '../../lib/locationTime';
import { stashTab } from '../../lib/qrTabStorage';
import { syncQrTableSession } from '../../lib/qrTableSession';
import { money, currencySymbol, venueCurrency } from '../../lib/currency';
import { tipRuleFor, tipChips, tipInitialKey, tipInitialKeyFor, tipAmount as calcTip } from '../../lib/tipping';
import { singleTender } from '../../lib/accounting/tenders';
import { writeClosedCheckRow } from '../../lib/closedCheckWrite';

// vatGate / onRetryRates (8 Oct 2026): ratesGate's answer from the surface (null when the venue's
// tax rates are in) and the way to load them again. Payment never opens while it is shut.
export default function QrCheckout({ cart, theme, location, tableId, tableLabel, loyalty, taxRates = [], taxCtx = null, existingTab = null, onClose, onPlaced, menuId = null, vatGate = null, onRetryRates = null }) {
  // v5.5.155: when existingTab is set the customer is in "Add more"
  // mode — they already opened a tab earlier and tapped Add more on
  // the resume screen. Skip the pre-auth + card input entirely;
  // append a new order_queue row with the same payment_intent_id and
  // tab_open=true. Force-close (or the customer's Close & pay) captures
  // the lot at end. No tip/service/customer-detail re-prompts —
  // the round just goes to the kitchen.
  const isAddMoreRound = !!existingTab;
  const opsLocationId      = location.ops_location_id || location.id;
  const platformLocationId = location.id;
  const tz                 = location.timezone || 'Europe/London';
  // v5.11.81 (Peter: the POS is central): the QR service charge follows the venue's ONE table
  // service rule (lib/venueServiceRule.js: the service charge switched on for table service on the
  // device profiles), not its own QR setting. `undefined` while it is asked; null when the database
  // cannot answer yet (update 20261020a not run): then the QR setting, as before.
  // v5.11.81 round 1: the menu page started this read as it loaded (venueServiceRuleCached), so a
  // rule already known is used at once and Pay is not held while it is asked again.
  const [venueServiceRule, setVenueServiceRule] = useState(() => peekVenueServiceRule(location.ops_location_id || location.id));
  useEffect(() => {
    let live = true;
    if (venueServiceRule !== undefined) return () => { live = false; };
    const timer = setTimeout(() => { if (live) setVenueServiceRule((r) => (r === undefined ? null : r)); }, 4000);
    venueServiceRuleCached(location.ops_location_id || location.id)
      .then((r) => { if (live) setVenueServiceRule(r || null); })
      .catch(() => { if (live) setVenueServiceRule(null); });
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.ops_location_id, location.id]);
  const serviceRuleLoading = venueServiceRule === undefined;
  const serviceChargePct   = qrServiceCharge({ rule: venueServiceRule || null, legacyPct: location.qr_service_charge_pct, discountedSubtotal: 0 }).pct;
  // v5.5.149: open-tab support is BO-toggleable. When the venue allows tabs
  // we surface the customer-facing warning message + (commit 3b) a Pay-now
  // / Open-tab radio. paymentMode='pay_now' is the safe default.
  const paymentMode    = location.qr_payment_mode || 'pay_now';
  const tabWarning     = (location.qr_tab_warning_message || '').trim();
  const tabsAllowed    = paymentMode === 'open_tab' || paymentMode === 'both';

  const [step, setStep] = useState('details');
  const processor = 'adyen';   // ServOS takes card payments on Adyen only

  const [name, setName]   = useState(loyalty?.name  || '');
  const [phone, setPhone] = useState(loyalty?.phone || '');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  // v5.8.8: the rule is set on the module (Back Office > Online Ordering >
  // Tipping at the table). This used to hardcode '10' as the starting value,
  // which pre-ticked a 10% gratuity at every venue with no way to turn it off.
  const tipRule = tipRuleFor(location, 'qr');
  const [tipMode, setTipMode] = useState(() => tipInitialKey(tipRule));
  // v5.8.19: once the venue's service charge is known, a pre-selected tip on top
  // of it is the "tipping twice" trap. Reset to No tip (chips stay available).
  useEffect(() => { if (Number(serviceChargePct) > 0) setTipMode(tipInitialKeyFor(tipRule, { serviceCharge: 1 })); }, [serviceChargePct]); // eslint-disable-line react-hooks/exhaustive-deps
  const [customTip, setCustomTip] = useState('');

  // v5.5.150: payNow vs openTab. Defaults sensibly per location.qr_payment_mode:
  //   pay_now  → forced 'pay_now'
  //   open_tab → forced 'open_tab'
  //   both     → customer chooses, defaults to 'pay_now'
  const [payChoice, setPayChoice] = useState(
    paymentMode === 'open_tab' ? 'open_tab' : 'pay_now'
  );
  const openTabAvailable = true;   // v5.8.17: Adyen open tabs via pre-auth (was hidden in v5.8.15)
  useEffect(() => { if (!openTabAvailable && payChoice === 'open_tab') setPayChoice('pay_now'); }, [openTabAvailable, payChoice]);
  const isOpenTab = payChoice === 'open_tab' && openTabAvailable;
  // v5.5.160: enforce a sensible MINIMUM pre-auth even when the venue config
  // is 0 / null. A zero hold cannot be authorised and leaves nothing to capture
  // from. £25 is a safe starter; a bill above it is captured up to the hold at
  // close and the rest is settled with staff (fence C22 below sizes the hold).
  const MIN_PRE_AUTH = 25;
  const configuredPreAuth = Number(location.qr_tab_pre_auth_amount ?? 0);
  // (tabPreAuthAmount itself is worked out below, once this round's total is known: fence C22.)

  // Database fence stage 1 (contract C8): the table code is made by the SERVER now
  // (place_public_order answers tab_join_code, 6 digits). This browser made code is the
  // FENCE STAGE 1 FALLBACK, used only while place_public_order does not exist.
  // v5.5.716: a 4-digit table code shown to the tab opener. Other phones must enter it to add to /
  // settle this tab (validated against customer.tab_join_code in OnlineSurface), so a passer-by who
  // just scans the printed QR can't order against someone else's tab. Re-used when adding a round to
  // an existing tab; a fresh code per newly-opened tab.
  const [tabJoinCode] = useState(() =>
    existingTab?.tab_join_code
    || existingTab?.rounds?.[0]?.customer?.tab_join_code
    || String(1000 + Math.floor(Math.random() * 9000)));

  const [working, setWorking] = useState(false);
  const [error, setError]     = useState('');

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const subtotal = useMemo(() => cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0), [cart]);

  // Auto-discount rules — fetched live (QR runs customer-side, no SyncBridge). Raw DB rows go
  // straight into the engine (it reads snake_case). Channel 'qr'; schedule/expiry in location tz.
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
      uid: l.key || l.uid || l.id || `l${i}`,
      cat: l.cat || null,
      cats: l.cats || null,
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      name: l.name || l.item?.name || 'Item',
    }));
    return evaluateAutoDiscounts(items, autoRules, 'qr', buildScheduleCtx(location.timezone)).map(toAppliedDiscount);
  }, [cart, autoRules, location.timezone]);
  const autoDiscountTotal = +autoDiscounts.reduce((s, d) => s + (d.value || 0), 0).toFixed(2);
  const discountedSubtotal = Math.max(0, +(subtotal - autoDiscountTotal).toFixed(2));

  const serviceCharge = useMemo(() =>
    qrServiceCharge({ rule: venueServiceRule || null, legacyPct: location.qr_service_charge_pct, discountedSubtotal }).amount,
    [discountedSubtotal, venueServiceRule, location.qr_service_charge_pct]);

  const tipAmount = useMemo(() => (
    tipRule.on ? calcTip(discountedSubtotal, tipMode, customTip) : 0
  ), [tipRule.on, tipMode, customTip, discountedSubtotal]);

  // v5.5.154: UK VAT breakdown over the gross subtotal — items only.
  // Service charge and tip aren't VAT-rated. UK uses inclusive tax so
  // the figure shown is "incl. VAT £X.XX", not added on top.
  // v5.7.34: through the unified seam — profiles cascade when the venue has
  // any assigned, byte-identical calculateOrderTax otherwise.
  // v5.9.12: ADDED-ON tax on the bill's own basis: offers come off the lines
  // they hit (uid = the key evaluateAutoDiscounts saw) and the table service
  // charge is taxed where the line's profile says so (US default: yes). UK
  // inclusive VAT never uses the basis, so UK totals and VAT are unchanged.
  // v5.11.81: the bill's tax lines, named once (the seam and the per line VAT both read them).
  const qrTaxLinesForBill = useMemo(() => cart.map((l, i) => ({
      uid: l.key || l.uid || l.id || `l${i}`,
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      itemId: l.itemId ?? null,
      cat: l.cat ?? null,
      cats: Array.isArray(l.cats) ? l.cats : null,
      taxProfileId: l.taxProfileId ?? null,
      taxRateId: l.taxRateId || l.tax_rate_id || null,
      taxOverrides: l.taxOverrides || l.tax_overrides || {},
    })), [cart]);
  const goodsTaxBreakdown = useMemo(() => computeOrderTaxUnified(
    cart.map((l, i) => ({
      uid: l.key || l.uid || l.id || `l${i}`,
      price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
      qty: l.qty || 1,
      itemId: l.itemId ?? null,
      cat: l.cat ?? null,
      cats: Array.isArray(l.cats) ? l.cats : null,
      taxProfileId: l.taxProfileId ?? null,
      taxRateId: l.taxRateId || l.tax_rate_id || null,
      taxOverrides: l.taxOverrides || l.tax_overrides || {},
    })),
    taxCtx || { taxRates },
    'dine-in',
    { discounts: autoDiscounts, service: serviceCharge },
  ), [cart, taxCtx, taxRates, autoDiscounts, serviceCharge]);
  // 2 Oct 2026: with an automatic offer, UK VAT is the VAT on what was CHARGED, as the till
  // books a discounted bill (the engine works it out on the full menu price: 10.00 with 5.00
  // off showed and sent 1.67, the till books 0.83). This one record is shown, charged from and
  // booked. No offer: the same object as before. Added-on (US) tax: never scaled, it already
  // has the offer in its basis (lib/publicCheckTax.js offerChargedTax).
  const taxBreakdown = useMemo(
    () => offerChargedTax(goodsTaxBreakdown, subtotal, discountedSubtotal, autoDiscountTotal, {
      // v5.11.81: a deal on some lines takes VAT off those lines' rates only, as at the till.
      lines: qrTaxLinesForBill, discounts: autoDiscounts,
      retax: (ls) => computeOrderTaxUnified(ls, taxCtx || { taxRates }, 'dine-in', null),
    }),
    [goodsTaxBreakdown, subtotal, discountedSubtotal, autoDiscountTotal, qrTaxLinesForBill, autoDiscounts, taxCtx, taxRates],
  );
  // 8 Oct 2026: does this page hold tax set up (rates or profiles)? With it, a sale is never sent
  // without VAT (publicCheckTaxFields throws a named error instead; the gate below stops payment first).
  const hasTaxConfig = useMemo(() => taxCtxHasConfig(taxCtx || { taxRates }), [taxCtx, taxRates]);

  // v5.7.31: ADDED-ON sales tax (US exclusive rates) is charged, not just shown.
  // UK inclusive VAT contributes exactly 0 here, so UK totals are unchanged.
  const exclusiveTax = +(Number(taxBreakdown?.exclusiveTax) || 0).toFixed(2);

  const total = useMemo(
    () => qrBillTotal({ discountedSubtotal, exclusiveTax, serviceCharge, tip: tipAmount }),
    [discountedSubtotal, exclusiveTax, serviceCharge, tipAmount]
  );
  // 19 Oct 2026 (v5.11.78, channel parity): a round added to an open tab is the same bill with no
  // tip (the Add to your tab sheet never asks for one): the offers, any added on tax and the QR
  // service charge, exactly as pay now. It used to be the shelf goods plus a hidden default tip.
  const roundTotal = useMemo(
    () => qrBillTotal({ discountedSubtotal, exclusiveTax, serviceCharge, tip: 0 }),
    [discountedSubtotal, exclusiveTax, serviceCharge]
  );

  // Database fence stage 1, fix round 2 (C22): the server refuses any round that would take a tab
  // past its card hold (place_public_order 'over_hold'), the FIRST round too. So a new tab holds at
  // least its first round, in whole units: max(the venue's hold, the minimum, this round's total).
  // An existing tab's rounds are checked against the hold it opened with (addToExistingTab).
  const tabPreAuthAmount = tabHoldFor({ configured: configuredPreAuth, minimum: MIN_PRE_AUTH, firstRound: total });

  // v5.5.156: phone required (was optional). Tab resume + force-close
  // identification key off phone-last-4, so an empty phone breaks the
  // recovery flow. Email stays optional.
  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (!/^\+?[0-9 ]{7,}$/.test(phone)) return false;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
    return true;
  }, [name, phone, email]);

  // Fix round (19 Sep, contract C18): one ref per checkout, not per step. The card payment
  // carries this ref as its merchant reference, which the proof records as
  // meta.order_ref; a new ref per step would have left every card order "Payment being checked".
  const orderRefRef = useRef(null);
  if (!orderRefRef.current) orderRefRef.current = `QR-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const orderShape = useMemo(() => {
    const ref = orderRefRef.current;
    const customer = {
      name: name.trim(),
      phone: phone.replace(/\s+/g, ''),
      email: email.trim(),
      tableId,
      tableLabel: tableLabel || tableId,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const items = cart.map((l, i) => ({
      // v5.11.81: the line's id, the one the automatic deals name (autoDiscounts above), so the
      // saved deal finds its lines again (the daily VAT check, a refund).
      uid: l.key || l.uid || l.id || `l${i}`,
      itemId: l.itemId, name: l.name, price: l.price,
      qty: l.qty || 1, mods: l.mods || [],
      // v5.11.81: the menu this line was priced on (it keeps its price when a timed menu flips,
      // the till's rule); the server values the line on it (migration 20261020a).
      menuId: l.menuId || null,
      cat: l.cat || null,
      cats: l.cats || null,
      parentId: l.parentId || null,
      kitchenName: l.kitchenName || null,
      receiptName: l.receiptName || null,
      // v5.5.145: stamp items as already 'sent' + fired:true (paid order
      // means kitchen owns it now, no operator click needed). Mirrors what
      // OnlineCheckout does for paid online orders.
      status: 'sent',
      fired: true,
      course: 1,
    }));
    return { ref, customer, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // v5.5.155: append a new round to an already-open tab. No card call —
  // we reuse the existing pre-auth (payment_intent_id) taken at first
  // open. Just insert another order_queue row tagged with the same
  // payment_intent_id so the close-and-capture sweep finds it.
  const addToExistingTab = async () => {
    if (working) return;
    if (!cart.length) { setError('Cart is empty.'); return; }
    setWorking(true); setError('');
    try {
      const { ref, customer, items } = orderShape;
      const roundCustomer = {
        ...customer,
        // Inherit identity + payment refs from the round-1 customer record
        // so the close-and-capture sweep can join all rounds by PI.
        ...(existingTab?.rounds?.[0]?.customer || {}),
        // Override per-round: a new ref per round, but keep tab_open until close
        tab_open: true,
        tab_join_code: existingTab?.rounds?.[0]?.customer?.tab_join_code || tabJoinCode,
        round_ref: ref,
        // 19 Oct 2026 (v5.11.78): THIS round's own figures, set after the round 1 spread so round
        // 1's are never copied onto it. No tip (none was asked for); its own QR service charge,
        // which every tab close books as service (headlessTax.qrTabService).
        tip: 0,
        service_charge: serviceCharge,
      };
      // The server keeps the tab's own code in customer (fence stage 1, C9). Fix round (C16): a
      // round from a phone that is neither the opener nor a member must CARRY the table code, so
      // it goes as p_order.tab_join_code. Only a code this phone really holds is sent: a made up
      // one would count towards the tab's lock (8 wrong per hour).
      const { tab_join_code: legacyJoinCode, ...roundCustomerForServer } = roundCustomer;
      const roundCode = tabRoundJoinCode(existingTab);
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: 'dine-in',
        status: 'prep',
        source: 'qr',
        items,
        customer: roundCustomer,
        total: roundTotal,   // 19 Oct 2026: offers, added on tax and service charge as pay now; no tip
        sent_at: new Date().toISOString(),
        collection_time: null,
        is_asap: true,
      };
      // Database fence stage 1 (contract C9): one server call. The tab's card hold must be
      // proven on the server; a tab opened before this release has no hold proof yet, so on
      // 'tab_not_verified' the proof is asked for once and the round sent again.
      // FENCE STAGE 1 FALLBACK: the direct insert, only while place_public_order does not exist.
      const tabPi = roundCustomer.payment_intent_id || existingTab?.payment_intent_id || null;
      const tabProcessor = 'adyen';
      const sendRound = () => placePublicOrder({
        opsLocationId,
        // Database fence stage 1 (fix round 7): the menu these prices came from. A per menu price
        // of 0.00 is a real price on THAT menu, so the server prices the basket on the same one;
        // with no menu id it floors every line at the lowest price above zero instead. It rides
        // on the RPC payload only: order_queue has no such column and the legacy insert uses the
        // same row (FENCE STAGE 1 FALLBACK).
        order: { ...queueRow, menu_id: menuId || null, customer: roundCustomerForServer, ...(roundCode ? { tab_join_code: roundCode } : {}) },
        legacyInsert: async () => {
          const { error: qErr } = await supabase.from('order_queue').insert({ ...queueRow, customer: { ...roundCustomerForServer, tab_join_code: legacyJoinCode } });
          return qErr ? { ok: false, error: qErr } : { ok: true };
        },
      });
      let placed = await sendRound();
      if (!placed.ok && placed.reason === 'tab_not_verified' && tabPi) {
        const pr = await requestPaymentProof({ opsLocationId, processor: tabProcessor, kind: 'preauth', paymentRef: tabPi });
        if (pr.proofId) placed = await sendRound();
      }
      if (!placed.ok) {
        // tab_not_yours (no code and not a member), locked (too many wrong codes), tab_closed:
        // the server's own words (fence C16).
        throw new Error(publicOrderRefusalMessage(placed, placed.message || 'Could not add to tab.'));
      }
      try { logOrderActivity(opsLocationId, queueRow); } catch { /* feed best-effort */ }
      // v5.5.157: refresh the floor-plan table session so the new round
      // shows up on TablesSurface alongside any other open QR rounds.
      // STAGE 1 CLEANUP: remove after 20260919b (its order_queue_qr_floor trigger does this;
      // until then this helper only ever writes a QR owned session, contract S1).
      syncQrTableSession(opsLocationId, tableId).catch(() => {});
      onPlaced?.({ ref, total: roundTotal, addedToTab: true, trackToken: placed.trackToken, paymentIntentId: tabPi });
    } catch (e) {
      console.error('[QrCheckout addToTab] failed:', e);
      setError(e?.message || 'Could not add to tab.');
    } finally {
      setWorking(false);
    }
  };

  const continueToPayment = async () => {
    if (!valid) {
      setError('Please enter your name and a valid phone number (we use the last 4 digits to reconnect you with your tab).');
      return;
    }
    // 8 Oct 2026 (VAT audit, Preston QR-4OGI7): no payment, no tab hold, while this venue's tax
    // rates are not loaded. The card is never charged for a sale the page cannot book right.
    if (vatGate) { setError(vatGate.message); return; }
    try { publicCheckTaxFields(taxBreakdown, { hasTaxConfig, goods: subtotal }); }
    catch (e) { setError(e?.message || 'Could not work out the VAT. Try again.'); return; }
    // The Adyen Drop-in creates its own session (adyen-checkout), exactly as OnlineCheckout
    // does. v5.8.17: an open tab is a pre-authorisation (capture_method manual) captured at
    // close through adyen-checkout tab_capture.
    setError(''); setStep('pay');
  };

  const onPaymentSuccess = async (paymentIntent) => {
    try {
      const { ref, customer, items } = orderShape;
      // The Adyen psp reference of the payment (pay now) or of the hold (open tab).
      const payId = paymentIntent?.id || null;
      const tabMode = isOpenTab;

      // v5.5.155: sub-numbering for multiple QR TABS at the same table.
      // 2 Oct 2026 (Peter, Leeds: "one on the actual table 6 and 6.1, that needs to not
      // happen"): a pay now order always carries the table itself, "T6". v5.5.162 numbered pay
      // now orders too, and a lone order read as a second table ("T6.1"). Numbering them only
      // "while another is open" does not work either: a paid order stays open in the queue
      // until staff tap it through to collected (QR-FAUOB was still 'prep' 40 minutes on), so
      // the next guest would have read "T6.2". Staff tell pay now orders apart by the name and
      // the order number on the card.
      // An OPEN TAB is still numbered: the first tab on a table is "2", a second tab opened
      // while that one is still running is "2.2", and so on (lib/publicOrder.js qrTableLabel).
      // Rounds of one tab share its payment_intent_id, so they share one number.
      let effectiveTableLabel = tableLabel || tableId;
      if (tableId && tabMode) {
        try {
          // Database fence stage 1 (contract C7): qr_table_tab_count counts the distinct open tabs.
          // FENCE STAGE 1 FALLBACK: today's direct read, only while it does not exist.
          const cnt = await publicRead('qr_table_tab_count',
            { p_location_id: String(opsLocationId), p_table_id: String(tableId) },
            () => supabase
              .from('order_queue')
              .select('ref, customer')
              .eq('location_id', opsLocationId)
              .eq('source', 'qr')
              .neq('status', 'collected')
              .filter('customer->>tableId', 'eq', String(tableId)));
          let count = 0;
          if (cnt.legacy) {
            // Count DISTINCT payment_intent_id (one number per tab/charge),
            // fall back to ref for any order without a PI. Open tabs only (2 Oct 2026): a
            // paid pay now order still in the queue is not a tab and takes no number.
            const distinctPIs = new Set();
            (cnt.data || []).filter(qrRowOnFloor).forEach(r => {
              const k = r.customer?.payment_intent_id || `ref:${r.ref}`;
              distinctPIs.add(k);
            });
            count = distinctPIs.size;
          } else {
            count = Number(cnt.data) || 0;
          }
          effectiveTableLabel = qrTableLabel(tableLabel || tableId, count);
        } catch (e) { console.warn('[QrCheckout] sub-numbering query failed:', e?.message); }
      }
      const tableLabelStr = `Table ${effectiveTableLabel}`;

      // v5.5.150: stash payment metadata in the order_queue.customer jsonb
      // (no schema migration needed). Force-close on POS reads these fields,
      // captures the hold (adyen-tab tab_capture), then writes closed_checks + marks the
      // queue row collected. tab_open=true tells the operator UI it's an
      // unpaid tab so it can show a "Force close & charge" button instead
      // of the regular advance buttons.
      const customerWithPayment = {
        ...customer,
        // The label staff read. A pay now order: the table itself ("Table 4"). A second
        // open tab on the same table: the sub-numbered version ("Table 4.2").
        tableLabel: effectiveTableLabel,
        // payment_intent_id is the universal pooling key (the psp reference of the hold) for
        // OrdersHub pooling + sub-numbering.
        payment_intent_id: payId,
        processor,   // close + refund route by this
        ...(tabMode ? {
          tab_open: true,
          tab_opened_at: new Date().toISOString(),
          pre_auth_amount: tabPreAuthAmount,
          tab_running_total: total,
          // v5.5.151: snapshot the venue's surcharge config at tab-open time
          // so the operator's force-close can apply auto-surcharge without
          // another platform.locations fetch. Snapshotting also means a
          // BO config change after tabs are open doesn't retroactively
          // change the policy customers already agreed to.
          tab_surcharge_pct:           Number(location.qr_tab_left_open_surcharge_pct ?? 0),
          tab_surcharge_fixed:         Number(location.qr_tab_left_open_surcharge_fixed ?? 0),
          tab_force_close_after_min:   Number(location.qr_tab_force_close_after_minutes ?? 0),
        } : { paid: true }),
        // v5.8.9: order_queue has no tip column, and `total` above already
        // INCLUDES the tip. Without these two the close paths (force-close,
        // customer self-close) had nothing to subtract, so they booked the
        // whole total as goods: the guest paid a tip, it never reached the
        // tips report or the tronc pool, and Xero posted it as VAT-able sales.
        tip: tipAmount,
        service_charge: serviceCharge,
      };

      // 1. order_queue — kitchen routing fires off this INSERT (master device
      // realtime handler). source='qr' + type='dine-in' + table_label so the
      // kitchen ticket prints "TABLE T5" header, the orders panel shows it
      // in the right bucket. No sent_at delay — fire immediately, even for
      // open-tab orders (table-service pattern: cook now, pay later).
      const queueRow = {
        ref,
        location_id: opsLocationId,
        type: 'dine-in',
        status: 'prep',
        source: 'qr',
        items, customer: customerWithPayment,
        total,
        sent_at: new Date().toISOString(),
        collection_time: null,
        is_asap: true,
      };
      // 2. closed_checks: only on PAY-NOW orders. For open-tab the bill isn't paid yet
      // (the card is only held); the check is written when the tab is settled.
      const closedCheckRow = tabMode ? null : {
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
        ref,
        location_id: opsLocationId,
        server: 'QR',
        staff_id: null,
        covers: 1,
        order_type: 'dine-in',
        customer: customerWithPayment,
        items: items.map(i => ({ ...i, voided: false })),
        discounts: autoDiscounts,
        subtotal,
        service: serviceCharge,
        tip: tipAmount,
        // 2 Oct 2026 (QR-FAUOB, Coffee Boy Leeds, booked with VAT 0): tax_amount in pence, never
        // the raw figure (the server read 0.9333333333333327 as 0), and the tax record by rate
        // whenever a rate was resolved, UK included, as the till writes it (lib/publicCheckTax.js).
        // With an automatic offer this is the VAT on what was charged (taxBreakdown above).
        // 8 Oct 2026: with tax set up this throws rather than sending null (checked before payment).
        ...publicCheckTaxFields(taxBreakdown, { hasTaxConfig, goods: subtotal }),
        total,
        method: 'card',
        // v5.9.11: what paid the check, per tender. place_public_order keeps it on the row it
        // writes, so a QR sale still posts to the right accounts.
        tenders: singleTender('card', total, tipAmount, { pspRef: payId, processor }),
        stripe_payment_intent_id: payId,   // the column holds the Adyen reference (renamed later, never dropped)
        payment_intents: payId ? [{ id: payId, amountMinor: Math.round(total * 100) }] : null,
        processor,   // refund routes by this
        drawer_id: null,
        shift_id: null,
        closed_at: new Date().toISOString(),
        status: 'paid',
        refunds: [],
        table_id: tableId || null,
        table_label: tableLabelStr,
        source: 'qr',
      };

      // Database fence stage 1 (contract C8): proof of the card payment (pay now) or of the
      // card hold (open tab), read from the processor by the payment-proof function, then ONE
      // server call writes the order (and the paid check for pay now). The server makes the
      // tab's table code. The money was taken, so the order is never dropped: without proof
      // it still reaches the kitchen, marked for staff to confirm.
      const proof = payId
        ? await requestPaymentProof({ opsLocationId, processor, kind: tabMode ? 'preauth' : 'card', paymentRef: payId })
        : { failed: true, reason: 'missing' };
      const placed = await placePublicOrder({
        opsLocationId,
        // Database fence stage 1 (fix round 7): the menu these prices came from. A per menu price
        // of 0.00 is a real price on THAT menu, so the server prices the basket on the same one;
        // with no menu id it floors every line at the lowest price above zero instead. It rides
        // on the RPC payload only: order_queue has no such column and the legacy insert uses the
        // same row (FENCE STAGE 1 FALLBACK).
        order: { ...queueRow, menu_id: menuId || null }, check: closedCheckRow,
        proofIds: proof.proofId ? [proof.proofId] : [],
        proofUnavailable: !!proof.unavailable, moneyTaken: true,
        // Fence C17: a pay now order the server could not prove yet is checked again in the
        // background. A tab has no paid check to verify (it is settled at close).
        reprove: (!tabMode && payId) ? [{ processor, kind: 'card', paymentRef: payId }] : null,
        // FENCE STAGE 1 FALLBACK: today's direct inserts (with the browser made table code),
        // used only while place_public_order does not exist or the proof function is not live.
        legacyInsert: async () => {
          const legacyRow = tabMode ? { ...queueRow, customer: { ...customerWithPayment, tab_join_code: tabJoinCode } } : queueRow;
          const { error: qErr } = await supabase.from('order_queue').insert(legacyRow);
          if (qErr) return { ok: false, error: qErr };
          if (closedCheckRow) {
            // v5.9.11: writeClosedCheckRow drops a column the database does not have yet and
            // retries, so a paid sale is never lost to a migration Peter has not run.
            try { await writeClosedCheckRow(supabase, closedCheckRow, { tag: 'QrCheckout' }); }
            catch (e) { console.warn('[QrCheckout] closed_checks insert failed:', e?.message); }
          }
          return { ok: true, tabJoinCode: tabMode ? tabJoinCode : null };
        },
      });
      if (!placed.ok) {
        console.error('[QrCheckout] order write failed AFTER payment:', placed.reason, placed.message);
        // Fence C19: a refusal the server explains (for example 'payment': a QR order must be
        // paid now or be a round of a tab) is shown in its words.
        setError(isOpenTab
          ? publicOrderRefusalMessage(placed, placed.message || `Card was authorised but we could not save the tab. Please show this to staff. Ref ${ref}.`)
          : publicOrderRefusalMessage(placed, `Payment succeeded but we could not save the order. Please show this to staff. Ref ${ref}.`));
        return;
      }
      const joinCode = tabMode ? (placed.tabJoinCode || null) : null;
      try { logOrderActivity(opsLocationId, queueRow); } catch { /* feed best-effort */ }
      if (placed.unverified) {
        logActivity(opsLocationId, { kind: 'order', severity: 'action', refType: 'order', refId: ref,
          title: `QR order ${ref}: payment not confirmed`,
          body: 'The card payment could not be verified automatically. Check the payment before serving.' }).catch(() => {});
      }

      // 3. Customer CRM (fire-and-forget — phone optional for QR, only
      // attributes when phone provided so we don't clutter the customer
      // table with anonymous one-shot scans).
      // afterPlaced: the order is saved, so nothing here may throw into the catch below.
      if (customer.phone) {
        afterPlaced('QrCheckout attribute', () => attributeOnlineOrder({
          phone: customer.phone, name: customer.name, email: customer.email,
          marketingOptIn: false,
          locationId: opsLocationId,
          // 19 Oct 2026 (v5.11.78, channel parity): the check's own id (loyalty-earn earns from the
          // server's closed_checks row, whose id this page minted) so a guest who left a phone earns
          // like a till customer. It sent the display ref (QR-XXXXX), which no check carries, and
          // was refused: 0 of 40 QR checks with a phone earned in 60 days. An open tab has no check
          // until it is settled, so a tab round earns nothing here.
          orderRecord: { ref, checkId: closedCheckRow?.id || null, total, items, type: 'dine-in', channel: 'qr' },
          // A signed in member's own token, as online sends it.
          memberToken: loyalty?.token || null,
          memberCustomerId: loyalty?.customer?.id || null,
          // Database fence stage 2: this order's own key proves the page placed it. payId is the
          // payment id this order's row carries (a new tab's hold, or the pay now charge). It
          // named tabPi from v5.9.16, which only exists in addToTab, so a guest who left a phone
          // number and had no payment id got "could not save the order" on a saved order.
          trackKey: chooseTrackKey({ trackToken: placed?.trackToken, paymentIntentId: payId || null, phone: customer.phone }),
        }));
      }

      // v5.5.155: stash for silent resume on next scan from this device.
      // Only for OPEN-TAB orders — pay-now orders are already paid in full
      // and don't need a resume flow.
      if (tabMode && location.online_slug && tableId) {
        try {
          stashTab(location.online_slug, tableId, {
            tab_ref: ref,
            payment_intent_id: payId,
            // v5.11.81: this order's own key, so the tab earns loyalty when it is settled (TabResumeScreen).
            track_token: placed?.trackToken || null,
            tab_join_code: joinCode,   // v5.5.716: so the opener can re-share it from the resume screen (fence stage 1: the server's code)
            processor,
            phone_last4: (customer.phone || '').replace(/\D/g, '').slice(-4),
            opened_at: new Date().toISOString(),
            table_label: effectiveTableLabel, // the table; a second open tab is sub-numbered (4.2, 4.3, ...)
            pre_auth_amount: tabPreAuthAmount,
          });
        } catch (e) { console.warn('[QrCheckout] stashTab:', e?.message); }
      }
      // v5.5.157: also surface the order on the floor-plan table session
      // so operators see the table as in-service from the moment of
      // first round, not just in the OrdersHub QR-tabs section.
      // 2 Oct 2026 (Peter, Leeds: "it's opening 2 tables ... that needs to not happen"): an
      // OPEN TAB only. A pay now order is paid in full, so it never touches the floor plan: it
      // was written onto the table as an open, unpaid check next to its own paid QR card, and
      // nothing took it off again (lib/publicOrder.js qrRowOnFloor).
      // STAGE 1 CLEANUP: remove after 20260919b (its order_queue_qr_floor trigger does this;
      // until then this helper only ever writes a QR owned session, contract S1).
      if (tableId && tabMode) {
        syncQrTableSession(opsLocationId, tableId).catch(() => {});
      }
      onPlaced?.({ ref, total, paymentIntent, joinCode, trackToken: placed.trackToken, paymentIntentId: payId, paymentUnverified: !!placed.unverified });
    } catch (e) {
      console.error('[QrCheckout] post-payment write failed:', e);
      setError('Payment succeeded but we could not save the order. Show this to staff. Ref ' + orderShape.ref + '.');
    }
  };

  // v5.5.155: ADD-MORE-TO-TAB sheet — short-circuit render. Customer is
  // already on an open tab; no card round-trip, no re-collect of name/
  // tip/service. Just confirm the round and send to kitchen.
  if (isAddMoreRound) {
    return (
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          width: '100%', maxWidth: 600, maxHeight: '96vh', overflowY: 'auto',
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
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>Add to your tab</div>
              <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                Table {existingTab?.table_label || tableLabel || tableId} · already on the tab: {money(Number(existingTab?.runningTotal || 0))}
              </div>
            </div>
            <button onClick={onClose} style={{
              padding: '0 14px', height: 36, borderRadius: 99, border: `1px solid ${cardBdr}`,
              background: inputBg, color: theme.fg,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}>×</button>
          </div>

          <div style={{ padding: '0 24px 12px' }}>
            <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted, marginBottom: 8 }}>
                This round
              </div>
              {cart.map(line => {
                const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
                return (
                  <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                    <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
                  </div>
                );
              })}
              {autoDiscounts.map((d, i) => (
                <div key={`ad-${i}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0 0', fontSize: 13, color: '#16a34a' }}>
                  <span>{d.label || 'Offer'}</span>
                  <span style={{ fontWeight: 700 }}>-{money(Number(d.value) || 0)}</span>
                </div>
              ))}
              {serviceCharge > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0 0', fontSize: 13, color: muted }}>
                  <span>Service charge ({serviceChargePct}%)</span>
                  <span style={{ fontWeight: 700 }}>{money(serviceCharge)}</span>
                </div>
              )}
              {exclusiveTax > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0 0', fontSize: 13, color: muted }}>
                  <span>{taxTermFor(taxBreakdown)}</span>
                  <span style={{ fontWeight: 700 }}>{money(exclusiveTax)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 800 }}>This round</span>
                <span style={{ fontSize: 18, fontWeight: 900 }}>{money(roundTotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0 0', fontSize: 12, color: muted }}>
                <span>Tab total after this round</span>
                <span style={{ fontWeight: 700 }}>{money((Number(existingTab?.runningTotal || 0) + roundTotal))}</span>
              </div>
            </div>
            <div style={{ marginTop: 14, fontSize: 11, color: muted, lineHeight: 1.5 }}>
              No card needed — added to the tab you opened earlier. Pay it all when you tap "Close &amp; pay" on the welcome-back screen.
            </div>
          </div>

          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={addToExistingTab} disabled={working || !cart.length || serviceRuleLoading}
              className="op-btn-primary"
              style={{
                width: '100%', padding: '16px 22px', borderRadius: 14,
                background: cart.length ? theme.accent : `${theme.fg}20`,
                color: cart.length ? contrastFg(theme.accent) : `${theme.fg}60`,
                border: 'none', fontSize: 16, fontWeight: 800,
                cursor: working ? 'wait' : (cart.length ? 'pointer' : 'not-allowed'),
                fontFamily: 'inherit',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <span>{working ? 'Sending…' : '🍽 Send to kitchen'}</span>
              <span>{money(roundTotal)}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 600, maxHeight: '96vh', overflowY: 'auto',
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
              {step === 'pay' ? 'Payment' : 'Checkout'}
            </div>
            <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
              Table {tableLabel || tableId || '?'} · {cart.length} item{cart.length === 1 ? '' : 's'} · {money(total)}
            </div>
          </div>
          <button onClick={step === 'pay' ? () => { setStep('details'); setError(''); } : onClose}
            style={{
              padding: '0 14px', height: 36, borderRadius: 99, border: `1px solid ${cardBdr}`,
              background: inputBg, color: theme.fg,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}>{step === 'pay' ? '← Edit' : '×'}</button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '0 24px 14px' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: theme.accent }}/>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: step === 'pay' ? theme.accent : cardBdr }}/>
        </div>

        {step === 'pay' ? (
          <div style={{ padding: '0 24px 16px' }}>
            {/* 8 Sep 2026: storeCard is OFF for an Adyen tab. The Adyen close
                path never charges an overage off session (it captures the
                hold, clamped), so storePaymentMethod bought nothing, and on a
                live account without tokenisation it is refused outright. */}
            <AdyenPaymentForm
              locationId={platformLocationId}
              amountMinor={Math.round((isOpenTab ? tabPreAuthAmount : total) * 100)}
              currency={venueCurrency()}
              reference={orderShape?.ref}
              merchantName={location?.name || ''}
              captureMethod={isOpenTab ? 'manual' : 'automatic'}
              storeCard={false}
              shopperReference={orderShape?.ref}
              customerEmail={orderShape?.customer?.email}
              onSuccess={onPaymentSuccess}
              onError={(e) => setError(e?.message || 'Payment failed')}
            />
            {error && <div style={{ color: theme.danger || '#e5484d', fontSize: 13, marginTop: 10 }}>{error}</div>}
          </div>
        ) : (
        <div style={{ padding: '0 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <SectionTitle>Your details</SectionTitle>
          <Field label="Name" value={name} onChange={setName} placeholder="Your name (so we know whose order this is)" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone" value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
            <Field label="Email (optional)" value={email} onChange={setEmail} placeholder="for receipt" type="email" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          </div>
          <Field label="Notes for the kitchen (optional)" value={notes} onChange={setNotes} placeholder="Allergies, preferences, etc." theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>

          {/* v5.5.150: Pay-now / Open-tab choice — only when venue allows
              both. Open-tab pre-authorises the card; the bill is captured
              when staff close the tab from the POS. */}
          {paymentMode === 'both' && (
            <>
              <SectionTitle>How would you like to pay?</SectionTitle>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <PayChoiceCard active={payChoice === 'pay_now'} onClick={() => setPayChoice('pay_now')}
                  theme={theme} cardBdr={cardBdr} inputBg={inputBg}
                  title="💳 Pay now" sub="Pay this round and we'll bring it over."/>
                {openTabAvailable && (
                  <PayChoiceCard active={payChoice === 'open_tab'} onClick={() => setPayChoice('open_tab')}
                    theme={theme} cardBdr={cardBdr} inputBg={inputBg}
                    title="📋 Open tab" sub={`Hold ${currencySymbol()}${tabPreAuthAmount} on your card; staff close the tab when you're done.`}/>
                )}
              </div>
            </>
          )}

          {tipRule.on && (<>
          <SectionTitle>Tip</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(6, tipChips(tipRule).length)}, 1fr)`, gap: 6 }}>
            {tipChips(tipRule).map(c => (
              <TipChip key={c.key} active={tipMode === c.key} onClick={() => setTipMode(c.key)}
                theme={theme} cardBdr={cardBdr}>
                {c.label}
              </TipChip>
            ))}
          </div>
          </>)}
          {tipRule.on && tipMode === 'custom' && (
            <Field label="Custom tip (£)" value={customTip} onChange={setCustomTip} placeholder="0.00" type="number" theme={theme} cardBdr={cardBdr} inputBg={inputBg}/>
          )}

          <SectionTitle>Order summary</SectionTitle>
          <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 12, padding: '12px 14px' }}>
            {cart.map(line => {
              const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={line.uid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{line.qty || 1} × {line.name}</span>
                  <span style={{ fontWeight: 700 }}>{money((unit * (line.qty || 1)))}</span>
                </div>
              );
            })}
            <SummaryLine label="Subtotal" value={subtotal} muted={muted}/>
            {/* Auto-discount promos (BOGO / bundle / scheduled) */}
            {autoDiscounts.map((ad, i) => (
              <div key={ad.id || i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 13, color: '#16a34a', fontWeight: 700 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ad.label}</span>
                <span>−{money(ad.value)}</span>
              </div>
            ))}
            {/* v5.5.154: UK VAT breakdown — required on every customer-
                facing total for compliance. Inclusive: shown as "incl."
                on top of the subtotal which already contains the tax.
                v5.7.31: exclusive (added-on) rates show "+" and ARE charged
                — the Total below includes them. */}
            {taxBreakdown.totalTax > 0 && taxBreakdown.breakdown.map((b, i) => (
              <SummaryLine key={`vat-${i}`}
                label={`${breakdownIsExclusive(b) ? '+ ' : 'incl. '}${b.rate?.name || b.name || (b.rate ? `${taxTermFor(taxBreakdown)} ${(Number(b.rate.rate) * 100).toFixed(0)}%` : 'Tax')}`}
                value={b.tax} muted={muted}/>
            ))}
            {serviceCharge > 0 && <SummaryLine label={`Service charge (${serviceChargePct}%)`} value={serviceCharge} muted={muted}/>}
            {tipAmount > 0 && <SummaryLine label="Tip" value={tipAmount} muted={muted}/>}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 18, fontWeight: 900 }}>{money(total)}</span>
            </div>
          </div>
        </div>
        )}

        {step === 'details' && (
          <div style={{
            position: 'sticky', bottom: 0,
            padding: '14px 24px calc(14px + env(safe-area-inset-bottom)) 24px',
            background: theme.bg, borderTop: `1px solid ${cardBdr}`,
          }}>
            {/* v5.5.149: customer-facing tab guardrail warning. Only shown
                when the venue allows open tabs; hidden for pay-now-only
                venues since the surcharge wouldn't apply to them. */}
            {tabsAllowed && tabWarning && (
              <div style={{
                marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                background: '#fef3c7', border: '1px solid #f59e0b',
                color: '#78350f', fontSize: 12, fontWeight: 600, lineHeight: 1.5,
              }}>
                {tabWarning}
              </div>
            )}
            <VatGateNotice gate={vatGate} onRetry={onRetryRates} theme={theme}/>
            {error && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 10 }}>{error}</div>}
            <button onClick={continueToPayment} disabled={!valid || working || !!vatGate || serviceRuleLoading}
              className={valid && !working && !vatGate ? 'op-btn-primary' : undefined}
              style={{
                width: '100%', padding: '16px 22px', borderRadius: 14,
                background: valid ? theme.accent : `${theme.fg}20`,
                color: valid ? contrastFg(theme.accent) : `${theme.fg}60`,
                border: 'none', fontSize: 16, fontWeight: 800,
                cursor: valid && !working ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <span>{working ? 'Starting payment…' : (isOpenTab ? 'Continue — open a tab' : 'Continue to payment')}</span>
              <span>{money((isOpenTab ? tabPreAuthAmount : total))}{isOpenTab ? ' hold' : ''}</span>
            </button>
            <div style={{ fontSize: 10, color: muted, textAlign: 'center', marginTop: 8 }}>
              {isOpenTab
                ? `🔒 We'll hold ${currencySymbol()}${tabPreAuthAmount} on your card. Final bill is taken when staff close the tab.`
                : '🔒 Card next, processed securely by ServOS Payments.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em', textTransform: 'uppercase', opacity: 0.7 }}>{children}</div>;
}

function Field({ label, value, onChange, placeholder, type = 'text', theme, cardBdr, inputBg }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: theme.isLight ? '#6b6b70' : '#a0a0a8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      <input type={type} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          background: inputBg, color: theme.fg, border: `1.5px solid ${cardBdr}`,
          fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        }}/>
    </div>
  );
}

function PayChoiceCard({ active, onClick, title, sub, theme, cardBdr, inputBg }) {
  return (
    <button onClick={onClick} className="op-btn"
      style={{
        padding: '14px 14px', borderRadius: 14,
        background: active ? `${theme.accent}28` : inputBg,
        color: theme.fg,
        border: `${active ? 3 : 1.5}px solid ${active ? theme.accent : cardBdr}`,
        boxShadow: active ? `0 4px 14px ${theme.accent}40` : 'none',
        cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        opacity: active ? 1 : 0.85,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
      <div style={{ fontSize: 14, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 11, color: theme.isLight ? '#6b6b70' : '#a0a0a8', lineHeight: 1.4 }}>{sub}</div>
    </button>
  );
}

function TipChip({ active, onClick, theme, cardBdr, children }) {
  return (
    <button onClick={onClick} className="op-btn"
      style={{
        padding: '12px 6px', borderRadius: 12,
        background: active ? theme.accent : 'transparent',
        color: active ? contrastFg(theme.accent) : theme.fg,
        border: `2px solid ${active ? theme.accent : cardBdr}`,
        boxShadow: active ? `0 4px 14px ${theme.accent}55` : 'none',
        fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
        opacity: active ? 1 : 0.75,
      }}>{children}</button>
  );
}

function SummaryLine({ label, value, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: muted }}>
      <span>{label}</span>
      <span>{money(value)}</span>
    </div>
  );
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
