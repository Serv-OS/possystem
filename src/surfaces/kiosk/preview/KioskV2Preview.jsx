/**
 * KioskV2Preview: DEV only preview of the new kiosk design on sample data.
 * Open with `npm run dev`, then /?mode=kiosk&kioskPreview=1, and compare with the design
 * prototype at 1080 by 1920. No pairing, no database, no card reader.
 *
 * It builds a fixture `engine` with the same keys KioskApp passes to KioskV2Root, keeps
 * the basket with the real kioskLine helpers, and simulates submitOrder. A small panel in
 * the corner switches the settings each screen reacts to (table mode, table list state,
 * logo, video, colour, points and text switches, stock, allergen tick, group rules, the order
 * save, the idle warning). The card screen is the real KioskCardScreen, driven by buttons
 * that force each reader state instead of a reader.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useKioskLang } from '../../../lib/i18n';
import { resolveItemPrice } from '../../../lib/menuPricing';
import { displayName } from '../../../lib/itemDisplay';
import { kioskVariant, kioskCartUsage, kioskLineRemaining, kioskLineRoom } from '../../../lib/kioskLine';
import { kioskLineKeyV2 } from '../../../lib/kioskBasket';
import { kioskLoyaltyCreditMinor } from '../../../lib/kioskLoyaltyReward';
import KioskV2Root from '../KioskV2Root';
import KioskCardScreen from '../KioskCardScreen';
import {
  FIXTURE_LOCATION_ID, FIXTURE_COMPANY_ID, FIXTURE_CATEGORIES, FIXTURE_ITEMS, FIXTURE_TABLE_STATES,
  FIXTURE_LOGO_URL, FIXTURE_MODIFIER_GROUPS, FIXTURE_DAILY_COUNTS, FIXTURE_EIGHTY_SIX, fixtureProfile,
  FIXTURE_ALCOHOL_CATEGORY_IDS, FIXTURE_TIPPING, FIXTURE_MENU_TRANSLATIONS, FIXTURE_GIFT_CARDS, FIXTURE_PROMOS, FIXTURE_OTP_CODE, fixtureVerifyReply,
} from './kioskFixtures';

const TABLE_MODES = ['either', 'enter', 'dispense', 'none'];
const NONE = [];
const NO_COUNTS = {};
const TABLE_STATES = Object.keys(FIXTURE_TABLE_STATES);
const TIPPING_STATES = Object.keys(FIXTURE_TIPPING);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

export default function KioskV2Preview() {
  const lang = useKioskLang();
  const [opts, setOpts] = useState({
    tableMode: 'either', tables: 'zones', logo: false, video: '', color: '', loyalty: true, sms: true, wait: 8,
    stock: true, allergenAck: false, rules: 'loaded', photos: true, tipping: 'venue', network: 'ok',
    submit: 'ok', idle: false,
  });
  const [log, setLog] = useState({ alert: null, points: null, adopted: null, ignoredResets: 0 });
  const note = useCallback((k, v) => setLog(l => ({ ...l, [k]: typeof v === 'function' ? v(l[k]) : v })), []);
  const [lastSubmit, setLastSubmit] = useState(null);
  const set = (k, v) => setOpts(o => ({ ...o, [k]: v }));
  const [panelOpen, setPanelOpen] = useState(true);

  const profile = useMemo(() => fixtureProfile({
    kiosk_table_mode: opts.tableMode,
    kiosk_brand_logo_url: opts.logo ? FIXTURE_LOGO_URL : null,
    kiosk_attract_video_url: opts.video || null,
    kiosk_brand_color: opts.color || null,
    kiosk_loyalty_enabled: opts.loyalty,
    kiosk_sms_enabled: opts.sms,
    kiosk_avg_wait_minutes: opts.wait,
    kiosk_allergen_required: opts.allergenAck,
    kiosk_category_photos: opts.photos,
  }), [opts]);

  const api = useMemo(() => ({
    loadCurrency: async () => 'GBP',
    loadTables: async () => FIXTURE_TABLE_STATES[opts.tables],
    loadGroupRules: async (ids) => (opts.rules === 'failed'
      ? null
      : new Map(FIXTURE_MODIFIER_GROUPS.filter(g => ids.includes(g.id)).map(g => [g.id, g]))),
    loadModifierGroups: async (ids) => ({ data: FIXTURE_MODIFIER_GROUPS.filter(g => ids.includes(g.id)), error: null }),
    loadTipping: async () => FIXTURE_TIPPING[opts.tipping],
    loadAlcoholCategoryIds: async () => FIXTURE_ALCOHOL_CATEGORY_IDS,
    loadMenuTranslations: async (_loc, lang) => FIXTURE_MENU_TRANSLATIONS[lang] || [],
    // The same result shapes as kioskApi, from sample codes. network 'down' fails every call.
    sendOtp: async () => { await wait(400); return opts.network === 'down' ? { errorKey: 'k2.otp.failed' } : { ok: true }; },
    verifyOtp: async ({ phone, code }) => {
      await wait(400);
      if (opts.network === 'down') return { errorKey: 'k2.otp.failed' };
      return code === FIXTURE_OTP_CODE ? { data: fixtureVerifyReply(phone) } : { errorKey: 'k2.otp.wrong' };
    },
    lookupGift: async ({ code }) => {
      await wait(300);
      if (opts.network === 'down') return { networkError: true };
      const card = FIXTURE_GIFT_CARDS[code];
      return card ? { httpOk: true, status: 200, body: card } : { httpOk: false, status: 404, body: { error: 'Card not found' } };
    },
    validatePromo: async ({ code, subtotal }) => {
      await wait(300);
      if (opts.network === 'down') return { networkError: true };
      const p = FIXTURE_PROMOS[code];
      if (!p) return { httpOk: true, status: 200, body: { valid: false, reason: 'not_found' } };
      if (p.min_spend && subtotal < p.min_spend) return { httpOk: true, status: 200, body: { valid: false, reason: 'min_spend', min_spend: p.min_spend } };
      return { httpOk: true, status: 200, body: { valid: true, code_id: `pc-${code}`, offer: { id: `offer-${code}`, name: p.label }, discount: { amount: p.amount, label: p.label } } };
    },
    // Stage D: recorded in the panel, never written anywhere.
    logStaffAlert: async (locationId, alert) => { note('alert', `${alert.title}: ${alert.body}`); return { ok: true }; },
    adoptLocation: (locationId) => note('adopted', locationId),
    attributePointsOrder: async ({ customer, orderRecord }) => { note('points', `${customer.phone} ref ${orderRecord.ref} total ${Number(orderRecord.total).toFixed(2)} ${orderRecord.method}`); return null; },
  }), [opts.tables, opts.rules, opts.tipping, opts.network, note]);

  // ── Order state (the same names KioskApp uses) ──
  const [screen, setScreen] = useState('attract');
  const [orderType, setOrderType] = useState(null);
  const [tableNumber, setTableNumber] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [allergenFilter, setAllergenFilter] = useState(() => new Set());
  const [cart, setCart] = useState([]);
  const [tip, setTip] = useState(0);
  const [loyaltyRedemption, setLoyaltyRedemption] = useState(null);
  const [verifiedLoyalty, setVerifiedLoyalty] = useState(null);
  const [giftCardPayment, setGiftCardPayment] = useState(null);
  const [promoApplied, setPromoApplied] = useState(null);
  const [customerPhone, setCustomerPhone] = useState('');
  const [orderNumber, setOrderNumber] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [idlePaused, setIdlePausedState] = useState(false);
  const setIdlePaused = useCallback((v) => setIdlePausedState(!!v), []);
  const checkIdRef = useRef(null);
  const activeMenuId = null;
  const eightySixIds = opts.stock ? FIXTURE_EIGHTY_SIX : NONE;
  const dailyCounts = opts.stock ? FIXTURE_DAILY_COUNTS : NO_COUNTS;

  const categories = FIXTURE_CATEGORIES;
  const items = FIXTURE_ITEMS;
  const cartItemUsage = useMemo(() => kioskCartUsage(cart), [cart]);
  const cartItemCount = cart.reduce((a, l) => a + l.qty, 0);
  const subtotal = cart.reduce((a, l) => a + l.lineTotal, 0);
  const discountedSubtotal = subtotal;
  const exclusiveTax = 0;
  const total = discountedSubtotal + exclusiveTax + tip;
  // The same credit formulas as KioskApp (the loyalty credit is live, lib/kioskLoyaltyReward.js).
  const loyaltyCredit = kioskLoyaltyCreditMinor(loyaltyRedemption, {
    cart,
    goodsMinor: Math.round(discountedSubtotal * 100),
    dueMinor: Math.round(total * 100),
    giftMinor: giftCardPayment?.applied || 0,
  }) / 100;
  const giftCardCredit = giftCardPayment?.applied ? giftCardPayment.applied / 100 : 0;
  const promoCredit = promoApplied ? Math.min(promoApplied.amount || 0, Math.max(0, total - loyaltyCredit - giftCardCredit)) : 0;
  const grandTotal = Math.max(0, total - loyaltyCredit - giftCardCredit - promoCredit);

  const resetIdle = useCallback(() => setOpts(o => (o.idle ? { ...o, idle: false } : o)), []);
  // The same D1 rule as KioskApp: a reset with no reason (submitOrder's 30 second timer) is ignored.
  const resetSession = useCallback((reason) => {
    if (reason === undefined) { note('ignoredResets', n => n + 1); return; }
    setScreen('attract'); setOrderType(null); setTableNumber(''); setCart([]); setTip(0);
    setCustomerPhone(''); setSelectedItem(null); setSelectedCategoryId(null);
    setLoyaltyRedemption(null); setGiftCardPayment(null); setPromoApplied(null); setVerifiedLoyalty(null);
    setAllergenFilter(new Set()); setOrderNumber(null); setSubmitError(null);
    setOpts(o => (o.idle ? { ...o, idle: false } : o));
    checkIdRef.current = null;
  }, [note]);

  // The same steps as KioskApp's addToCart with the new design on (kioskLineKeyV2).
  const addToCart = useCallback((item, qty = 1, selectedMods, summaryOverride = null, priceEachOverride = null, modsArrayOverride = null, instructions = '', variantItem = null) => {
    const variant = kioskVariant(item, variantItem);
    const maxAdd = kioskLineRoom({ item, variant }, dailyCounts, cartItemUsage);
    if (maxAdd !== null) {
      if (maxAdd <= 0) return;
      qty = Math.min(qty, maxAdd);
    }
    const linePrice = priceEachOverride ?? resolveItemPrice(item, orderType, activeMenuId);
    const modsArray = Array.isArray(modsArrayOverride) ? [...modsArrayOverride] : [];
    const note = instructions && instructions.trim();
    if (note) modsArray.push({ label: note, price: 0, groupLabel: 'Note', _instruction: true });
    const summary = summaryOverride || '';
    const key = kioskLineKeyV2({ item, variant, mods: modsArray });
    setCart(prev => {
      const existing = prev.find(l => l.key === key);
      if (existing) return prev.map(l => l.key === key ? { ...l, qty: l.qty + qty, linePrice, lineTotal: (l.qty + qty) * linePrice } : l);
      return [...prev, {
        key, item, variant, name: displayName(item), qty,
        mods: summary + (note ? ((summary ? ' · ' : '') + 'Note: ' + note) : ''),
        modsArray, instructions: instructions || '', linePrice, lineTotal: qty * linePrice,
      }];
    });
  }, [orderType, dailyCounts, cartItemUsage]);

  const updateCartQty = useCallback((key, delta) => {
    setCart(prev => prev.map(l => {
      if (l.key !== key) return l;
      let q = Math.max(0, l.qty + delta);
      const remaining = delta > 0 ? kioskLineRemaining(l, dailyCounts) : null;
      if (remaining !== null) q = Math.min(q, remaining);
      return { ...l, qty: q, lineTotal: q * l.linePrice };
    }).filter(l => l.qty > 0));
  }, [dailyCounts]);

  // Simulated submitOrder: records the two arguments the new flow passes, so the panel can
  // show them (the name is always '', the phone only for a take away ready text). The
  // Order save option makes it slow or fail. Like the real one, it starts a 30 second reset
  // with no reason, which the new design must ignore (F2).
  const submitOrder = useCallback(async (nameOverride, phoneOverride) => {
    if (!checkIdRef.current) checkIdRef.current = '3f9a2cde-1111-4222-8333-444455556666';
    // Like submitOrder since v5.8.67, a reward is only recorded (and committed) when it took money off.
    setLastSubmit({ nameOverride, phoneOverride, grandTotal, tip, gift: giftCardPayment?.applied || 0, promo: promoApplied?.code || null, reward: (loyaltyRedemption && loyaltyCredit > 0) ? loyaltyRedemption.reward_name || null : null });
    setSubmitting(true);
    setSubmitError(null);
    await wait(opts.submit === 'slow' ? 4000 : 600);
    setSubmitting(false);
    if (opts.submit === 'fails') {
      setSubmitError('Preview: the closed_checks insert failed');
      return;
    }
    setOrderNumber('R1247');
    setScreen('done');
    setTimeout(() => resetSession(), 30000);
  }, [grandTotal, tip, giftCardPayment, promoApplied, loyaltyRedemption, loyaltyCredit, opts.submit, resetSession]);

  // The same D2 rule as KioskApp: while the card screen pauses the timer, no idle warning.
  const idleWarning = opts.idle && !idlePaused && screen !== 'attract';

  const engine = {
    kioskId: 'preview-kiosk', deviceName: 'Preview kiosk', profile, locationId: FIXTURE_LOCATION_ID, companyId: FIXTURE_COMPANY_ID, kioskTz: 'Europe/London',
    items, visibleCategories: categories, railCategories: categories, activeMenuId, eightySixIds, dailyCounts,
    screen, setScreen, orderType, setOrderType, tableNumber, setTableNumber,
    selectedCategoryId, setSelectedCategoryId, selectedItem, setSelectedItem,
    allergenFilter, setAllergenFilter,
    cart, setCart, addToCart, updateCartQty, cartItemCount, cartItemUsage,
    subtotal, autoDiscounts: [], autoDiscountTotal: 0, discountedSubtotal, taxBreakdown: null, exclusiveTax,
    total, tip, setTip,
    loyaltyRedemption, setLoyaltyRedemption, verifiedLoyalty, setVerifiedLoyalty,
    giftCardPayment, setGiftCardPayment, promoApplied, setPromoApplied,
    loyaltyCredit, giftCardCredit, promoCredit, grandTotal,
    customerPhone, setCustomerPhone,
    checkIdRef, orderNumber, submitting, submitError, setSubmitError, submitOrder,
    brandName: profile.kiosk_brand_name, brandLogoUrl: profile.kiosk_brand_logo_url, attractVideoUrl: profile.kiosk_attract_video_url,
    avgWaitMinutes: profile.kiosk_avg_wait_minutes, tableMode: profile.kiosk_table_mode, loyaltyEnabled: profile.kiosk_loyalty_enabled !== false,
    menuBanner: (Array.isArray(profile.kiosk_banners) ? profile.kiosk_banners : []).find(b => b && b.screen === 'menu' && b.imageUrl) || null,
    categoryPhotos: profile.kiosk_category_photos !== false, categoryPhotoOrigin: null, idleTimeoutSec: profile.kiosk_idle_timeout_sec, lang,
    resetIdle, resetSession, idleWarning, warningCountdown: 7,
    setIdlePaused, deviceLocationId: FIXTURE_LOCATION_ID,
  };

  return (
    <>
      <KioskV2Root engine={engine} api={api} ScreenPay={PreviewPay} />
      <PreviewPanel
        open={panelOpen}
        onToggle={() => setPanelOpen(o => !o)}
        opts={opts}
        set={set}
        screen={screen}
        onJump={setScreen}
        onAddSample={() => addToCart(FIXTURE_ITEMS[0], 1)}
        cartItemCount={cartItemCount}
        orderType={orderType}
        tableNumber={tableNumber}
        lastSubmit={lastSubmit}
        log={log}
        idlePaused={idlePaused}
      />
    </>
  );
}

/**
 * Preview stand in for KioskApp's ScreenPay (same props, including look and v2). There is no
 * reader: it draws the real KioskCardScreen and the buttons along the top force each reader
 * state. Approved calls onPaid after 800ms, as ScreenPay does.
 */
function PreviewPay({ total, onPaid, onBack, onCancel, submitting, error, v2 }) {
  const [cardState, setCardState] = useState(total > 0 ? 'processing' : 'idle');
  const [cardError, setCardError] = useState(null);
  const force = (state, err = null) => {
    setCardState(state);
    setCardError(err);
    if (state === 'success') setTimeout(() => onPaid(), 800);
  };
  const btn = { fontSize: 18, padding: '8px 12px', borderRadius: 10, border: '1px dashed #B9AB9B', background: 'rgba(255,255,255,.7)', cursor: 'pointer' };
  return (
    <>
      <KioskCardScreen
        cardState={cardState}
        cardError={cardError}
        total={total}
        submitting={submitting}
        submitError={error}
        onRetry={() => force('processing')}
        onBack={onBack}
        onCancel={onCancel}
        onPlaceOrder={onPaid}
        {...v2}
      />
      {total > 0 ? (
        <div style={{ position: 'absolute', top: 132, left: 56, right: 56, display: 'flex', gap: 8, flexWrap: 'wrap', zIndex: 5 }}>
          <button type="button" style={btn} onClick={() => force('processing')}>processing</button>
          <button type="button" style={btn} onClick={() => force('collecting')}>collecting</button>
          <button type="button" style={btn} onClick={() => force('success')}>approved</button>
          <button type="button" style={btn} onClick={() => force('declined', 'Your card was declined (preview)')}>declined</button>
          <button type="button" style={btn} onClick={() => force('error', 'Timed out - customer did not complete payment within 5 minutes')}>error</button>
        </div>
      ) : null}
    </>
  );
}

function PreviewPanel({ open, onToggle, opts, set, screen, onJump, onAddSample, cartItemCount, orderType, tableNumber, lastSubmit, log, idlePaused }) {
  const box = { position: 'fixed', left: 12, bottom: 12, zIndex: 1000, fontFamily: 'system-ui, sans-serif', fontSize: 15, color: '#fff' };
  const btn = { fontSize: 15, padding: '6px 10px', borderRadius: 8, border: '1px solid #555', background: '#2a2a2e', color: '#fff', cursor: 'pointer' };
  if (!open) return <div style={box}><button type="button" style={btn} onClick={onToggle}>Preview settings</button></div>;
  const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
  return (
    <div style={{ ...box, background: 'rgba(20,20,24,.92)', borderRadius: 12, padding: 14, width: 320, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <b>New kiosk design preview</b>
        <button type="button" style={btn} onClick={onToggle}>Hide</button>
      </div>
      <div>Screen: {screen} | {orderType || 'no order type'}{tableNumber ? ` | table ${tableNumber}` : ''} | basket {cartItemCount}</div>
      <div>Idle paused: {idlePaused ? 'yes' : 'no'} | ignored resets: {log.ignoredResets} | venue set: {log.adopted || 'no'}</div>
      {log.alert ? <div style={{ fontSize: 13 }}>Staff alert: {log.alert}</div> : null}
      {log.points ? <div style={{ fontSize: 13 }}>Points attribution: {log.points}</div> : null}
      <label style={row}>Order save
        <select value={opts.submit} onChange={e => set('submit', e.target.value)} style={{ fontSize: 15 }}>
          <option value="ok">ok</option>
          <option value="slow">slow</option>
          <option value="fails">fails</option>
        </select>
      </label>
      <label style={row}><input type="checkbox" checked={opts.idle} onChange={e => set('idle', e.target.checked)} /> Show idle warning</label>
      <div style={row}>
        {['attract', 'start', 'menu', 'review'].map(s => <button key={s} type="button" style={btn} onClick={() => onJump(s)}>{s}</button>)}
        <button type="button" style={btn} onClick={onAddSample}>Add a pizza</button>
      </div>
      <label style={row}>Table mode
        <select value={opts.tableMode} onChange={e => set('tableMode', e.target.value)} style={{ fontSize: 15 }}>
          {TABLE_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label style={row}>Table list
        <select value={opts.tables} onChange={e => set('tables', e.target.value)} style={{ fontSize: 15 }}>
          {TABLE_STATES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      {lastSubmit ? (
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
          submitOrder({JSON.stringify(lastSubmit.nameOverride)}, {JSON.stringify(lastSubmit.phoneOverride)}) total {lastSubmit.grandTotal.toFixed(2)} tip {lastSubmit.tip.toFixed(2)} gift {lastSubmit.gift} promo {String(lastSubmit.promo)} reward {String(lastSubmit.reward)}
        </div>
      ) : null}
      <div style={{ fontSize: 13, opacity: 0.8 }}>Codes: GIFT0000 1111 2222, GIFTEMPTY0000000, SAVE5 (min 10), BIGSAVE. Text code {FIXTURE_OTP_CODE}.</div>
      <label style={row}>Tipping
        <select value={opts.tipping} onChange={e => set('tipping', e.target.value)} style={{ fontSize: 15 }}>
          {TIPPING_STATES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label style={row}>Network
        <select value={opts.network} onChange={e => set('network', e.target.value)} style={{ fontSize: 15 }}>
          <option value="ok">ok</option>
          <option value="down">down</option>
        </select>
      </label>
      <label style={row}><input type="checkbox" checked={opts.logo} onChange={e => set('logo', e.target.checked)} /> Logo</label>
      <label style={row}><input type="checkbox" checked={opts.loyalty} onChange={e => set('loyalty', e.target.checked)} /> Collect points</label>
      <label style={row}><input type="checkbox" checked={opts.stock} onChange={e => set('stock', e.target.checked)} /> Stock states (low, sold out, 86)</label>
      <label style={row}><input type="checkbox" checked={opts.allergenAck} onChange={e => set('allergenAck', e.target.checked)} /> Allergen tick required</label>
      <label style={row}><input type="checkbox" checked={opts.photos} onChange={e => set('photos', e.target.checked)} /> Category photos switch</label>
      <label style={row}>Group rules
        <select value={opts.rules} onChange={e => set('rules', e.target.value)} style={{ fontSize: 15 }}>
          <option value="loaded">loaded</option>
          <option value="failed">failed</option>
        </select>
      </label>
      <label style={row}><input type="checkbox" checked={opts.sms} onChange={e => set('sms', e.target.checked)} /> Text me when ready</label>
      <label style={row}>Colour
        <input value={opts.color} placeholder="design green" onChange={e => set('color', e.target.value)} style={{ fontSize: 15, width: 140 }} />
      </label>
      <label style={row}>Wait minutes
        <input type="number" value={opts.wait} onChange={e => set('wait', Number(e.target.value))} style={{ fontSize: 15, width: 70 }} />
      </label>
      <label style={row}>Video URL
        <input value={opts.video} placeholder="MP4 link" onChange={e => set('video', e.target.value)} style={{ fontSize: 15, width: 200 }} />
      </label>
    </div>
  );
}
