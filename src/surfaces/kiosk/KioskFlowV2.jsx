/**
 * KioskFlowV2: one customer's pass through the new kiosk design.
 *
 * KioskV2Root mounts this with key={sessionKey}, and the key changes every time the
 * kiosk returns to tap to start, so every local value here (open sheet, start step,
 * return path) starts fresh for the next customer without touching resetSession.
 *
 * Shared order state (screen, order type, table, cart, money) lives in KioskApp and
 * arrives as `engine`. This file only moves between screens and calls engine functions.
 *
 * Stage A: tap to start, start (every table mode), the language sheet.
 * Stage B: the menu, the item sheet, the basket sheet, the allergen sheet and the order
 * bar, plus the reprice when the customer switches eat in / take away.
 * Stage C: Review and pay (useKioskCheckout holds its state), the phone keypad, the text
 * code sheet for rewards and the allergen summary.
 * Stage D: the card screen is KioskApp's ScreenPay drawn with look="v2" (KioskCardScreen),
 * mounted ONLY on 'pay' (Review and pay never starts the reader). It reports its phase here,
 * which pauses the idle timer while the reader is live, the order is saving or staff are
 * needed, and raises one staff alert per incident. Then the done screen with its own
 * countdown, points only attribution for a number that did not go to submitOrder, and the
 * "Still there?" overlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t, tf, setLang } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { useStore } from '../../store';
import {
  resolveV2Screen, kioskStartModel, nextAfterStart, kioskStartFooterKey, kioskModeLabels,
  kioskIdlePaused, kioskDoneModel, kioskPointsOnlyAttribution, KIOSK_LANGUAGE_PICKER,
} from '../../lib/kioskFlow';
import { nextCardIncident, kioskStaffAlert, kioskPayTotal } from '../../lib/kioskPay';
import { kioskPrimary } from '../../lib/kioskTheme';
import { resolveItemPrice } from '../../lib/menuPricing';
import { repriceKioskCart, kioskAddedLineKey } from '../../lib/kioskBasket';
import { kioskSubmitNotice, kioskChargeTotal, kioskAttributionRecord } from '../../lib/kioskCheckout';
import KioskProductModal from '../KioskProductModal';
import KioskAttractScreen from './KioskAttractScreen';
import KioskStartScreen from './KioskStartScreen';
import KioskLanguageSheet from './KioskLanguageSheet';
import KioskMenuScreen from './KioskMenuScreen';
import KioskBasketSheet from './KioskBasketSheet';
import KioskAllergenSheet from './KioskAllergenSheet';
import KioskReviewScreen from './KioskReviewScreen';
import KioskPhoneSheet from './KioskPhoneSheet';
import KioskOtpSheet from './KioskOtpSheet';
import KioskAllergenSummarySheet from './KioskAllergenSummarySheet';
import KioskDoneScreen from './KioskDoneScreen';
import KioskIdleOverlay from './KioskIdleOverlay';
import useKioskCheckout from './useKioskCheckout';
import { KioskBackButton, KioskCancelPill } from './KioskChrome';

const NO_DEFS = [];
const NO_IDS = [];

export default function KioskFlowV2({
  engine, tables, groupRules = null, api = null, tipping = null, alcoholIds = NO_IDS, currency = null, ScreenPay = null,
}) {
  const screen = resolveV2Screen(engine.screen);
  // null | 'language' | 'item' | 'basket' | 'allergens' | 'phone' | 'otp' | 'allergenSummary'
  const [overlay, setOverlay] = useState(null);
  const [phoneIntent, setPhoneIntent] = useState('points'); // 'points' | 'sms'
  const [startStep, setStartStep] = useState('mode');   // 'mode' | 'table'
  const [returnTo, setReturnTo] = useState(null);       // null | 'review'
  const instructionDefs = useStore(s => s.instructionGroupDefs) || NO_DEFS;
  const primary = useMemo(() => kioskPrimary(engine.profile), [engine.profile]);

  // Reprice the basket when the customer switches eat in / take away ("switching eat in and
  // take away reprices the basket"), and ONLY then. Like today's kiosk, a line otherwise keeps
  // the price it was added at: a timed menu starting or a Back Office price edit arriving
  // mid order never moves a line the customer already saw (only a merge reprices, in
  // addToCart). Freeze rule: the switch can only happen on the start screen, and nothing runs
  // while saving, so the amount never moves once the card screen has it.
  const { setCart, items, orderType, activeMenuId, submitting } = engine;
  const repriceOpen = (screen === 'start' || screen === 'menu' || screen === 'review') && !submitting;
  const pricedTypeRef = useRef(orderType);
  useEffect(() => {
    if (!repriceOpen || pricedTypeRef.current === orderType) return;
    pricedTypeRef.current = orderType;
    setCart(c => repriceKioskCart(c, items, orderType, activeMenuId));
  }, [repriceOpen, setCart, items, orderType, activeMenuId]);

  const checkout = useKioskCheckout({ engine, api, screen, tipping, alcoholIds, currency });

  // ── Card screen phase (KioskCardScreen reports it) ──
  // The idle timer pauses while the reader is live, the order is saving or staff are needed
  // (KioskApp D2). One staff incident per card screen visit: its reference is fixed when staff
  // are first needed, and the tills get one urgent alert for it.
  const { checkIdRef, setIdlePaused } = engine;
  const [cardView, setCardView] = useState({ phase: null, incident: null });
  const incidentRef = useRef(null);
  const alertCtxRef = useRef({ api, locationId: engine.locationId, deviceName: engine.deviceName });
  useEffect(() => { alertCtxRef.current = { api, locationId: engine.locationId, deviceName: engine.deviceName }; });
  const onCardPhase = useCallback((report) => {
    const prev = incidentRef.current;
    const next = nextCardIncident(prev, report, { now: Date.now(), checkId: checkIdRef?.current || null });
    incidentRef.current = next;
    if (next && !prev) {
      const ctx = alertCtxRef.current;
      if (ctx.api?.logStaffAlert) {
        Promise.resolve(ctx.api.logStaffAlert(ctx.locationId, kioskStaffAlert({
          deviceName: ctx.deviceName, amountText: money(next.total), reference: next.reference, cause: next.cause, raw: next.raw,
        }))).catch(() => {});
      }
    }
    const phase = report?.phase ?? null;
    setCardView(v => (v.phase === phase && v.incident === next ? v : { phase, incident: next }));
  }, [checkIdRef]);
  const idlePaused = screen === 'pay' && kioskIdlePaused(cardView.phase);
  // The amount the card screen is given is fixed when it opens (lib/kioskPay.js kioskPayTotal):
  // nothing that lands while it shows can move the amount or turn it into "covered".
  const [fixedPayTotal, setFixedPayTotal] = useState(null);
  const payTotal = kioskPayTotal(fixedPayTotal, screen === 'pay', kioskChargeTotal(engine.grandTotal));
  if (payTotal !== fixedPayTotal) setFixedPayTotal(payTotal);
  useEffect(() => { if (setIdlePaused) setIdlePaused(idlePaused); }, [idlePaused, setIdlePaused]);
  useEffect(() => () => { if (setIdlePaused) setIdlePaused(false); }, [setIdlePaused]);

  // ── Done: points for a number that did not go to submitOrder (build spec 3.10, 4.4) ──
  // submitOrder attributes the order itself whenever it is given a phone, which the new design
  // only does for the take away ready text. A number given for points only is attributed here,
  // once per order, with the same order record submitOrder builds. Fire and forget.
  const submittedPhone = checkout.submitArgs[1];
  const pointsOnly = kioskPointsOnlyAttribution({ loyaltyEnabled: engine.loyaltyEnabled, phoneE164: checkout.phoneE164, submittedPhone });
  const attributedRef = useRef(null);
  const {
    orderNumber, grandTotal, tip, subtotal, cart, loyaltyCredit, giftCardCredit, promoCredit, locationId,
  } = engine;
  const phoneE164 = checkout.phoneE164;
  useEffect(() => {
    if (screen !== 'done' || !orderNumber || !pointsOnly || !api?.attributePointsOrder) return;
    const checkId = checkIdRef?.current || null;
    if (!checkId || attributedRef.current === checkId) return;
    attributedRef.current = checkId;
    const orderRecord = kioskAttributionRecord({
      checkId, orderNumber, grandTotal, tip, subtotal, cart, loyaltyCredit, giftCardCredit, promoCredit, orderType, locationId,
    });
    Promise.resolve(api.attributePointsOrder({
      customer: { name: null, phone: phoneE164, email: null, marketingOptIn: false },
      orderRecord,
    })).catch(() => {});
  }, [screen, orderNumber, pointsOnly, api, checkIdRef, grandTotal, tip, subtotal, cart, loyaltyCredit, giftCardCredit, promoCredit, orderType, locationId, phoneE164]);

  const model = kioskStartModel(engine.tableMode);
  const cancel = () => engine.resetSession('cancel');

  const leaveStart = () => {
    const next = nextAfterStart({ returnTo });
    setReturnTo(null);
    setStartStep('mode');
    engine.setScreen(next);
  };

  const onEatIn = () => {
    engine.setOrderType('dineIn');
    if (model.eatInLeadsTo === 'table') {
      setStartStep('table');
      return;
    }
    engine.setTableNumber('');
    leaveStart();
  };
  const onTakeaway = () => {
    engine.setOrderType('takeaway');
    engine.setTableNumber('');
    leaveStart();
  };
  const onPickTable = (label) => {
    engine.setTableNumber(String(label));
    leaveStart();
  };
  const onNoTable = () => {
    engine.setTableNumber('');
    leaveStart();
  };
  const backToStart = () => {
    setStartStep('mode');
    setReturnTo(null);
    engine.setScreen('start');
  };

  // ── Menu ──
  const openItem = (item) => {
    engine.setSelectedItem(item);
    setOverlay('item');
  };
  const closeItem = () => {
    setOverlay(null);
    engine.setSelectedItem(null);
  };
  const quickAdd = (item) => {
    engine.addToCart(item, 1, {}, '', resolveItemPrice(item, orderType, activeMenuId), [], '', null);
  };
  const goReview = () => {
    setOverlay(null);
    engine.setScreen('review');
  };

  // ── Review and pay ──
  const leaveReview = (next) => {
    checkout.clearNotices();
    setOverlay(null);
    engine.setScreen(next);
  };
  // Minus on the last item empties the basket, so go back to the menu with it.
  const reviewQty = (key, delta) => {
    const { cart } = engine;
    const emptying = delta < 0 && cart.length === 1 && cart[0].key === key && cart[0].qty <= 1;
    engine.updateCartQty(key, delta);
    if (emptying) leaveReview('menu');
  };
  const changeWhere = () => {
    checkout.clearNotices();
    setReturnTo('review');
    setStartStep('mode');
    engine.setScreen('start');
  };
  const openPhone = (intent) => {
    setPhoneIntent(intent);
    setOverlay('phone');
  };
  // Pay only moves to the card screen. The reader starts there, never here.
  const goPay = () => {
    engine.setSubmitError(null);
    leaveReview('pay');
  };
  const showTextRow = checkout.smsEnabled && checkout.textAllowed;
  const phoneSubKey = engine.loyaltyEnabled
    ? (showTextRow ? 'k2.phone.subBoth' : 'k2.phone.subPoints')
    : 'k2.phone.subText';
  // Minus on the last item closes the basket sheet with it.
  const basketQty = (key, delta) => {
    const { cart } = engine;
    if (delta < 0 && cart.length === 1 && cart[0].key === key && cart[0].qty <= 1) setOverlay(null);
    engine.updateCartQty(key, delta);
  };

  let body;
  if (screen === 'attract') {
    body = (
      <KioskAttractScreen
        brandName={engine.brandName}
        brandLogoUrl={engine.brandLogoUrl}
        attractVideoUrl={engine.attractVideoUrl}
        avgWaitMinutes={engine.avgWaitMinutes}
        onStart={() => { engine.resetIdle(); engine.setScreen('start'); }}
      />
    );
  } else if (screen === 'start') {
    body = (
      <KioskStartScreen
        model={model}
        step={startStep}
        brandName={engine.brandName}
        brandLogoUrl={engine.brandLogoUrl}
        lang={engine.lang}
        onOpenLanguage={() => setOverlay('language')}
        showLanguage={KIOSK_LANGUAGE_PICKER}
        showCancel={engine.cartItemCount > 0}
        onCancel={cancel}
        tables={tables}
        tableNumber={engine.tableNumber}
        onEatIn={onEatIn}
        onTakeaway={onTakeaway}
        onPickTable={onPickTable}
        onNoTable={onNoTable}
        onChangeMode={() => setStartStep('mode')}
        footerKey={kioskStartFooterKey({ loyaltyEnabled: engine.loyaltyEnabled, smsEnabled: engine.profile?.kiosk_sms_enabled === true })}
        showBackToOrder={returnTo === 'review'}
        onBackToOrder={() => { setReturnTo(null); setStartStep('mode'); engine.setScreen('review'); }}
      />
    );
  } else if (screen === 'menu') {
    body = (
      <KioskMenuScreen
        engine={engine}
        primary={primary}
        instructionDefs={instructionDefs}
        groupRules={groupRules}
        onBack={backToStart}
        onCancel={cancel}
        onOpenAllergens={() => setOverlay('allergens')}
        onOpenItem={openItem}
        onQuickAdd={quickAdd}
        onOpenBasket={() => setOverlay('basket')}
        onReview={goReview}
      />
    );
  } else if (screen === 'review') {
    body = (
      <KioskReviewScreen
        engine={engine}
        checkout={checkout}
        primary={primary}
        submitNoticeKey={engine.screen === 'gift' ? kioskSubmitNotice(engine.submitError) : null}
        onBack={() => leaveReview('menu')}
        onCancel={cancel}
        onAddMore={() => leaveReview('menu')}
        onChangeWhere={changeWhere}
        onQty={reviewQty}
        onOpenPhone={openPhone}
        onOpenOtp={() => setOverlay('otp')}
        onOpenAllergenSummary={() => setOverlay('allergenSummary')}
        onPay={goPay}
      />
    );
  } else if (screen === 'pay' && ScreenPay) {
    // KioskApp's ScreenPay, its logic unchanged, drawn as the new card screen (look="v2").
    // submitOrder gets two strings (lib/kioskCheckout.js kioskSubmitArgs): no name, and the
    // phone only for a take away ready text. The total is rounded to the penny so a covered
    // order never asks the reader for a fraction of a penny.
    body = (
      <ScreenPay
        look="v2"
        v2={{
          onPhase: onCardPhase,
          incident: cardView.incident,
          kioskTz: engine.kioskTz || null,
          onNewOrder: () => engine.resetSession('staff'),
        }}
        brandColor={primary}
        total={payTotal}
        loyaltyCredit={engine.loyaltyCredit}
        giftCardCredit={engine.giftCardCredit}
        promoCredit={engine.promoCredit}
        promoApplied={engine.promoApplied}
        locationId={engine.locationId}
        kioskId={engine.kioskId}
        cart={engine.cart}
        submitting={engine.submitting}
        error={engine.submitError}
        onPaid={() => engine.submitOrder(...checkout.submitArgs)}
        onBack={() => { engine.setSubmitError(null); engine.setScreen('review'); }}
        loyaltyRedemption={engine.loyaltyRedemption}
        onCancel={cancel}
      />
    );
  } else if (screen === 'done') {
    body = (
      <KioskDoneScreen
        orderNumber={engine.orderNumber}
        model={kioskDoneModel({
          orderType: engine.orderType,
          tableNumber: engine.tableNumber,
          textSent: !!submittedPhone,
          pointsMasked: checkout.phoneE164 ? checkout.masked : '',
          loyaltyEnabled: engine.loyaltyEnabled === true,
          hasAlcohol: checkout.hasAlcohol,
        })}
        onDone={() => engine.resetSession('done')}
        onCountdownEnd={() => engine.resetSession('countdown')}
      />
    );
  } else {
    body = <PlaceholderScreen engine={engine} onCancel={cancel} />;
  }

  return (
    <>
      {body}
      {screen === 'menu' && overlay === 'item' && engine.selectedItem && (
        <ItemSheet engine={engine} primary={primary} api={api} onLineAllergens={checkout.noteLineAllergens} onClose={closeItem} />
      )}
      {screen === 'menu' && overlay === 'basket' && engine.cart.length > 0 && (
        <KioskBasketSheet
          cart={engine.cart}
          cartItemCount={engine.cartItemCount}
          cartItemUsage={engine.cartItemUsage}
          dailyCounts={engine.dailyCounts}
          grandTotal={engine.grandTotal}
          primary={primary}
          onQty={basketQty}
          onClose={() => setOverlay(null)}
          onPay={goReview}
        />
      )}
      {screen === 'menu' && overlay === 'allergens' && (
        <KioskAllergenSheet
          allergenFilter={engine.allergenFilter}
          setAllergenFilter={engine.setAllergenFilter}
          onClose={() => setOverlay(null)}
        />
      )}
      {screen === 'review' && overlay === 'phone' && (
        <KioskPhoneSheet
          region={checkout.phoneRegion}
          initialDigits={engine.customerPhone}
          subKey={phoneSubKey}
          onConfirm={(digits) => { checkout.confirmPhone(digits, { turnOnText: phoneIntent === 'sms' }); setOverlay(null); }}
          onRemove={() => { checkout.removePhone(); setOverlay(null); }}
          onClose={() => setOverlay(null)}
        />
      )}
      {screen === 'review' && overlay === 'otp' && checkout.phoneE164 && (
        <KioskOtpSheet
          api={api}
          phoneE164={checkout.phoneE164}
          masked={checkout.masked}
          companyId={engine.companyId}
          locationId={engine.locationId}
          verifiedLoyalty={engine.verifiedLoyalty}
          onVerified={checkout.setVerifiedLoyalty}
          rewardCtx={checkout.rewardCtx}
          onUse={(staged) => { checkout.applyReward(staged); setOverlay(null); }}
          onClose={() => setOverlay(null)}
        />
      )}
      {screen === 'review' && overlay === 'allergenSummary' && (
        <KioskAllergenSummarySheet list={checkout.allergenList} onClose={() => setOverlay(null)} />
      )}
      {engine.idleWarning && screen !== 'attract' && screen !== 'done' && (
        <KioskIdleOverlay countdown={engine.warningCountdown} onContinue={engine.resetIdle} />
      )}
      {KIOSK_LANGUAGE_PICKER && overlay === 'language' && screen !== 'attract' && (
        <KioskLanguageSheet
          currentLang={engine.lang}
          onPick={(code) => { setLang(code); setOverlay(null); }}
          onClose={() => setOverlay(null)}
        />
      )}
    </>
  );
}

/**
 * The item sheet: today's item screen logic (KioskProductModal) drawn as the README 3 sheet.
 * It adds through the same addToCart as today's kiosk.
 */
function ItemSheet({ engine, primary, api, onLineAllergens, onClose }) {
  const item = engine.selectedItem;
  // The picked options' own allergens, handed over by the sheet just before it adds.
  const pickAllergensRef = useRef([]);
  return (
    <KioskProductModal
      look="sheet"
      item={item}
      allItems={engine.items}
      brandColor={primary}
      basePrice={resolveItemPrice(item, engine.orderType, engine.activeMenuId)}
      orderType={engine.orderType || undefined}
      activeMenuId={engine.activeMenuId}
      dailyCounts={engine.dailyCounts}
      cartItemUsage={engine.cartItemUsage}
      avoidAllergens={engine.allergenFilter}
      ackRequired={engine.profile?.kiosk_allergen_required === true}
      onPickAllergens={(ids) => { pickAllergensRef.current = Array.isArray(ids) ? ids : []; }}
      fetchGroups={api?.loadModifierGroups}
      onAdd={({ qty, selections, summary, priceEach, mods, instructions, variantItem }) => {
        const ids = pickAllergensRef.current;
        if (ids.length && onLineAllergens) {
          onLineAllergens(kioskAddedLineKey({ item, variantItem, mods, instructions }), ids);
        }
        engine.addToCart(item, qty, selections, summary, priceEach, mods, instructions, variantItem);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

/**
 * Fallback for a screen with nothing to draw (only 'pay' when no ScreenPay was passed): the
 * README 2 header (back, mode block, Cancel) over an empty body, so the kiosk is never blank
 * and Cancel always works.
 */
function PlaceholderScreen({ engine, onBack, onCancel }) {
  const labels = kioskModeLabels({ orderType: engine.orderType, tableNumber: engine.tableNumber });
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '26px 28px', background: '#FFFFFF', borderBottom: '1px solid rgba(0,0,0,.07)' }}>
        {onBack ? <KioskBackButton onClick={onBack} /> : null}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)' }}>{t(labels.titleKey)}</div>
          <div style={{ fontSize: 17, color: 'var(--k2InkSubtle)' }}>{tf(labels.subKey, labels.vars)}</div>
        </div>
        <div style={{ flex: 1 }} />
        <KioskCancelPill onClick={onCancel} />
      </div>
      <div style={{ flex: 1, margin: 28, border: '3px dashed var(--k2Hairline)', borderRadius: 26 }} aria-hidden="true" />
    </div>
  );
}
