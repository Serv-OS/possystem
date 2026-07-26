import { useCompact } from '../lib/useCompact';
import { createPortal } from 'react-dom';
import { useState, useMemo, useRef, useEffect } from 'react';
import DrawerCashModal from '../components/DrawerCashModal';
import PosWasteModal from '../components/PosWasteModal';
import { useStore } from '../store';
import { fetchMenuCategoryLinks } from '../lib/db';
import { supabase } from '../lib/supabase';
import { pushReaderDisplay, clearReaderDisplay, cacheReaderDisplaySetting } from '../lib/readerDisplay';
import { publishDisplay, getCustomerDisplayMode, displayUsesReader, displayUsesScreen, cacheCustomerDisplayMode, onCustomerPhone, publishLoyalty, onRedeemReward, isLoyaltyEnabled } from '../lib/customerDisplay';
import { captureLoyaltyByPhone } from '../lib/customerLookup';
import { getAssignedNetworkReader } from '../lib/networkReader';
import { CATEGORIES, MENU_ITEMS as SEED_MENU_ITEMS, ALLERGENS, QUICK_IDS, getDaypart, CAT_META } from '../data/seed';
import { calculateOrderTax } from '../lib/tax';
import ProductModal, { AllergenModal } from '../components/ProductModal';
import InlineItemFlow from '../components/InlineItemFlow';
import CheckoutModal from './CheckoutModal';
import CustomerModal from '../components/CustomerModal';
import VoidModal from '../components/VoidModal';
import DiscountModal from '../components/DiscountModal';
import { ReceiptModal, ReprintModal } from '../components/ReceiptModal';
import { printService } from '../lib/printer';
import { isTrainingMode } from '../lib/trainingMode';
import CheckHistory from '../components/CheckHistory';
import DeliveriesPanel from '../components/DeliveriesPanel';
import ItemInfoModal from '../components/ItemInfoModal';
import OrderReviewModal from '../components/OrderReviewModal';
import OrderTypeModal from '../components/OrderTypeModal';
import AllergenCheckoutModal from '../components/AllergenCheckoutModal';
import TableActionsModal from '../components/TableActionsModal';
import Challenge21Modal from '../components/Challenge21Modal';
import { money, stripeCurrency, getActiveCurrencyCode } from '../lib/currency';
import { Icon, emojiToIcon } from '../components/ServOSIcons';

const COURSE_COLORS = {
  0:{label:'Immediate',color:'#22d3ee',bg:'rgba(34,211,238,.1)'},
  1:{label:'Course 1', color:'#22c55e',bg:'rgba(34,197,94,.1)'},
  2:{label:'Course 2', color:'#3b82f6',bg:'rgba(59,130,246,.1)'},
  3:{label:'Course 3', color:'#e8a020',bg:'rgba(232,160,32,.1)'},
};

export default function POSSurface() {
  const compact = useCompact();
  const {
    staff, allergens, toggleAllergen, clearAllergens,
    addItem, addCustomItem, removeItem, updateItemQty, updateItemNote,
    updateItemSeat, updateItemCourse, setOrderNote,
    sendToKitchen, fireCourse, saveTableSession, toggleServiceCharge,
    openCashDrawer,
    cashDrawers, myDrawer, needsCashIn,
    cashInDrawer, cashOutDrawer, computeExpectedCash, currentDrawerSession,
    loadCurrentDrawerSession,
    getPOSItems, getPOSTotals, getPOSOrderNote, quoteDelivery,
    activeTableId, tables, clearTable, clearDraftItems, clearWalkIn, setActiveTableId, recordWalkInClosed,
    orderType, setOrderType, customer, setCustomer, setAllergens, clearCustomer,
    orderQueue, updateQueueStatus, removeFromQueue, showToast,
    pendingItem, setPendingItem, clearPendingItem,
    eightySixIds, toggle86,
    dailyCounts, setDailyCount, clearDailyCount,
    setSurface,
    seatTableWithItems, mergeItemsToTable, splitTableCheck,
    voidItem, voidCheck,
    addCheckDiscount, removeCheckDiscount, addWalkInDiscount, removeWalkInDiscount,
    addItemDiscount, removeItemDiscount,
    deviceConfig,
    setDeviceConfig,
    menuItems: storeMenuItems,
    menuCategories,
    quickScreenIds,
    menus,
    taxRates,
    showItemImages,
    takeawayCustomerDetails,
    location,
  } = useStore();

  // BUILD_TEST_1777051985417
  // v4.6.54: drawer workflow state (menu + cash actions + recent activity)
  const [showDrawerMenu, setShowDrawerMenu] = useState(false);
  const [showWaste, setShowWaste] = useState(false);
  const [showCashIn, setShowCashIn]         = useState(false);
  const [showCashOut, setShowCashOut]       = useState(false);
  const [expectedForCashOut, setExpectedForCashOut] = useState(0);
  const [cashAction, setCashAction] = useState(null);
  const [cashActionAmount, setCashActionAmount] = useState('');
  const [cashActionReason, setCashActionReason] = useState('');
  useEffect(() => {
    if (typeof loadCurrentDrawerSession === 'function') loadCurrentDrawerSession();
    // v5.5.890: the old v4.6.52 15s "_lockPoll" here did the SAME work as the poll below,
    // and its cleanup lived on window.__rposLockPollClean which nothing ever called — so it
    // LEAKED a permanent 15s DB poll on every POS mount (stacking on each surface switch).
    // That leak is what actually generated the 394k cash_drawers calls in pg_stat_statements.
    // Deleted; the interval below is the one poll.
    // v4.6.49: periodic poll of cashDrawers + drawer session. Catches remote
    // changes from the back office (manager cashes up / cashes in a drawer)
    // without needing to refresh the POS. v5.5.889: 15s → 60s.
    const _poll = setInterval(async () => {
      try {
        if (typeof useStore.getState().loadCashDrawers === 'function') await useStore.getState().loadCashDrawers();
        if (typeof loadCurrentDrawerSession === 'function') await loadCurrentDrawerSession();
      } catch {}
    }, 60000);
    return () => clearInterval(_poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const _myDrw = typeof myDrawer === 'function' ? myDrawer() : null;
  const _needsCashIn = typeof needsCashIn === 'function' ? needsCashIn() : false;
  const _canCashup = Array.isArray(staff?.permissions) && staff.permissions.includes('cashup');

  // v5.5.882: when the allergen filter changes AND a customer is attached AND the filter differs
  // from the customer's stored allergens, AUTO-SAVE to the customer profile (debounced so rapid
  // toggling settles into one write). This used to "prompt to save" via a showToast action button —
  // but showToast only takes (msg, type), so the button was silently discarded and the save was
  // UNREACHABLE (the feature never worked). Auto-save matches the intended behaviour: attach a
  // customer, record their allergens, the profile remembers. Clearing the filter to empty never
  // auto-removes stored allergens (safety: removal is a deliberate act, done in BO → Customers).
  const _lastAllergenSaveRef = useRef('');
  useEffect(() => {
    if (!customer?.phone) return;
    if (!Array.isArray(allergens) || allergens.length === 0) return;
    const filterKey = [...allergens].sort().join(',');
    const storedKey = (customer.allergens || []).slice().sort().join(',');
    if (filterKey === storedKey) return;                        // already matches
    if (_lastAllergenSaveRef.current === filterKey) return;     // already saved this exact set
    const timer = setTimeout(async () => {
      const st = useStore.getState();
      const list = st.allergens || [];
      if (!list.length) return;
      const savedKey = [...list].sort().join(',');
      const updatedId = await st.saveAllergensToCustomer(customer);
      if (updatedId) {
        _lastAllergenSaveRef.current = savedKey;
        const updatedCustomer = { ...customer, allergens: [...list] };
        setCustomer(updatedCustomer);
        // Persist to the current table session too, so re-seating carries them. (The old code
        // passed a session object into saveTableSession's COVERS slot — setSessionCustomer is
        // the real session.customer writer.)
        const tblId = st.activeTableId;
        if (tblId && (st.tables || []).find(x => x.id === tblId)?.session) {
          st.setSessionCustomer(tblId, updatedCustomer);
        }
        const labels = list.map(a => (ALLERGENS.find(x => x.id === a)?.label || a)).join(', ');
        st.showToast(`${labels} saved to ${customer.name}'s profile`, 'success');
      }
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allergens, customer?.phone]);

  // v4.6.65: hydrate `customer` state from the active table's session so the
  // attached customer chip + Edit/Remove pills show up when staff returns to a table.
  useEffect(() => {
    if (!activeTableId) return;
    const t = tables.find(x => x.id === activeTableId);
    const sessionCust = t?.session?.customer;
    if (sessionCust && sessionCust.phone && (!customer || customer.phone !== sessionCust.phone)) {
      setCustomer(sessionCust);
      // v4.4.9: auto-apply guest's saved allergen filters when re-entering their table
      if (Array.isArray(sessionCust.allergens)) setAllergens(sessionCust.allergens);
    } else if (!sessionCust && customer && orderType === 'dine-in') {
      // Table switched and the new table has no attached customer
      setCustomer(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTableId, tables]);

  // v4.6.5: Active menu resolver — picks the right menu based on schedule, priority, device profile.
  // Recomputes every minute via clockTick so menus auto-switch at schedule boundaries.
  const [_clockTick, _setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => _setClockTick(x => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const deviceMenuId = useMemo(() => {
    const now = new Date();
    const day = now.getDay() || 7; // ISO: Mon=1, Sun=7
    const time = now.getHours() * 60 + now.getMinutes();
    const isActive = (m) => {
      if (!m.schedule) return true;
      const s = m.schedule;
      if (s.days && Array.isArray(s.days) && !s.days.includes(day)) return false;
      if (s.from && s.to) {
        const [fh, fm] = s.from.split(':').map(Number);
        const [th, tm] = s.to.split(':').map(Number);
        const fromMin = fh * 60 + fm;
        const toMin = th * 60 + tm;
        if (fromMin <= toMin) return time >= fromMin && time <= toMin;
        // crosses midnight (e.g. 22:00–02:00)
        return time >= fromMin || time <= toMin;
      }
      return true;
    };
    const liveMenus = (menus || []).filter(m => m.isActive !== false && m.is_active !== false);
    // v5.5.x: NEVER resolve to a menu that has no categories — an empty menu (e.g. a
    // half-built "New Test" menu that's still active) would otherwise win the schedule/
    // priority race and blank the POS grid entirely. Prefer menus that actually have at
    // least one top-level category; only fall back to all live menus if none do.
    const menusWithCats = new Set((menuCategories || []).filter(c => !c.parentId && !c.isSpecial && c.menuId).map(c => c.menuId));
    const withCats = liveMenus.filter(m => menusWithCats.has(m.id));
    const allMenus = withCats.length ? withCats : liveMenus;
    const activeNow = allMenus.filter(isActive);
    const preferred = deviceConfig?.menuId;
    const preferredOk = preferred && allMenus.some(m => m.id === preferred);   // pinned menu must itself have cats
    // 1. If device pinned to a (non-empty) menu that's currently active, honour it.
    if (preferredOk && activeNow.some(m => m.id === preferred)) return preferred;
    // 2. Otherwise pick highest-priority menu currently active.
    if (activeNow.length > 0) {
      return activeNow.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0].id;
    }
    // 3. No menus active right now: fall back to default flagged menu.
    const def = allMenus.find(m => m.isDefault || m.is_default);
    if (def) return def.id;
    // 4. Device pinned (even if its schedule says inactive), provided it has cats.
    if (preferredOk) return preferred;
    // 5. Any non-empty menu (highest priority) so the grid is never blank when items exist.
    if (allMenus.length) return allMenus.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0].id;
    // 6. Nothing matches: show all categories (legacy behaviour).
    return null;
  }, [menus, deviceConfig?.menuId, menuCategories, _clockTick]);

  // v4.7.7: mirror the resolved deviceMenuId into the store's activeMenuId so internal
  // getItemPrice calls (addItem fallback, setOrderType reprice) pick up per-menu pricing
  // tiers. Other surfaces (kiosk, online, mobile) will set this from their own resolvers.
  const _setActiveMenuId = useStore(s => s.setActiveMenuId);
  useEffect(() => {
    if (_setActiveMenuId) _setActiveMenuId(deviceMenuId);
  }, [deviceMenuId, _setActiveMenuId]);
  // Use store's editable menu — prefer menuName for display, fall back to name
  // IMPORTANT: useMemo keeps object references stable so modalItem doesn't change
  // identity on re-renders (which would remount ProductModal and reset selections state)
  const rawItems = storeMenuItems || SEED_MENU_ITEMS;
  const { getItemPrice } = useStore.getState();
  const MENU_ITEMS = useMemo(() => rawItems
    .filter(i => {
      if (i.type === 'subitem' && !i.soldAlone) return false;
      return true;
    }) // filter soldAlone
    .map(i => ({
      ...i,
      name: i.menuName || i.name,
      price: getItemPrice ? getItemPrice(i, orderType, deviceMenuId) : (i.pricing?.base ?? i.price ?? 0),
      // v5.5.892: deviceMenuId was MISSING from the deps — switching the device's menu (or a
      // per-menu tier resolving to a different menu) kept STALE PRICES until an unrelated
      // rerender happened to rebuild the memo. Pricing correctness bug, not just perf.
    })), [rawItems, orderType, deviceMenuId, getItemPrice]);

  // v5.5.890: index lookups the product grid used to do INLINE per tile per render —
  // menuCategories.find + MENU_ITEMS.filter were O(tiles × menu size) on every keystroke
  // and every store write, the prime tap/type-lag suspect on Sunmi WebViews. Display-only.
  const catById = useMemo(() => new Map((menuCategories || []).map(c => [c.id, c])), [menuCategories]);
  const childrenByParent = useMemo(() => {
    const m = new Map();
    for (const it of MENU_ITEMS) {
      if (!it.parentId || it.archived) continue;
      const arr = m.get(it.parentId);
      if (arr) arr.push(it); else m.set(it.parentId, [it]);
    }
    return m;
  }, [MENU_ITEMS]);
  // v5.5.890: per-category eligible-item counts in ONE pass — the category rail used to run a
  // full MENU_ITEMS.filter per category per render. Same predicate as before; sub-category
  // counts roll up via the subIds sum at the call site.
  const directCountByCat = useMemo(() => {
    const m = new Map();
    for (const i of MENU_ITEMS) {
      if (i.archived || i.parentId || (i.type === 'subitem' && !i.soldAlone)) continue;
      m.set(i.cat, (m.get(i.cat) || 0) + 1);
    }
    return m;
  }, [MENU_ITEMS]);

  // Order types this terminal is allowed to show (from device profile)
  const allowedOrderTypes = deviceConfig?.enabledOrderTypes || ['dine-in', 'takeaway', 'collection'];

  // v4.7.6: load menu_category_links on mount + provide a Set of cat ids linked to deviceMenuId
  const [_categoryLinks, _setCategoryLinks] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await fetchMenuCategoryLinks();
        if (alive) _setCategoryLinks(data || []);
      } catch (e) {
        console.warn('[POSSurface] fetchMenuCategoryLinks failed:', e?.message || e);
      }
    })();
    return () => { alive = false; };
  }, []);
  // Set of category ids linked to the active deviceMenuId via menu_category_links.
  // Used to extend the cat-strip filter so cats appear in linked menus too.
  const _linkedCatIdsForDeviceMenu = useMemo(() => {
    if (!deviceMenuId) return new Set();
    return new Set((_categoryLinks||[]).filter(l => l.menu_id === deviceMenuId).map(l => l.category_id));
  }, [_categoryLinks, deviceMenuId]);
  const ALL_ORDER_TYPES = [['dine-in','🍽','Dine in'],['takeaway','🥡','Takeaway'],['collection','📦','Collect']];
  const visibleOrderTypes = ALL_ORDER_TYPES.filter(([t]) => allowedOrderTypes.includes(t));

  const [cat, setCat]             = useState('quick');
  const [subCat, setSubCat]       = useState(null);
  const [expandedCats, setExpandedCats] = useState(new Set());
  const [namesOnly, setNamesOnly] = useState(false);
  const [modalItem, setModalItem] = useState(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [search, setSearch]       = useState('');
  const [showAllergens, setShowAllergens] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customNote, setCustomNote] = useState('');
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [pendingOrderType, setPendingOrderType] = useState(null);
  const [rightTab, setRightTab] = useState('menu');  // 'menu' | 'orders'
  const [voidTarget, setVoidTarget]   = useState(null);
  const [showDiscount, setShowDiscount] = useState(false);
  const [showReceipt, setShowReceipt]   = useState(false);
  const [showReprint, setShowReprint]   = useState(false);
  const [infoItem, setInfoItem]         = useState(null);  // long-press item info
  const [showReview, setShowReview]     = useState(false);
  const [showSendModal, setShowSendModal] = useState(false);
  const [showAllergenGate, setShowAllergenGate] = useState(false);
  const [showTableActions, setShowTableActions] = useState(false);
  const [lastAddedUid, setLastAddedUid] = useState(null);
  const longPressTimer = useRef(null);
  // v5.5.791: order panel follows adds — when a line is appended (or an existing
  // line's qty goes up) the items list scrolls it into view and flashes it.
  // Diffed against the previous uid→qty map so unrelated re-renders never
  // re-trigger; the baseline resets when switching table / walk-in context.
  const orderListRef = useRef(null);
  const prevOrderLinesRef = useRef(null);   // Map<uid, qty> | null
  const prevOrderKeyRef = useRef(null);     // activeTableId | 'walkin'
  const lineFlashTimerRef = useRef(null);
  const [flashLineUid, setFlashLineUid] = useState(null);

  const activeTable = activeTableId ? tables.find(t=>t.id===activeTableId) : null;
  const session = activeTable?.session;
  const items = getPOSItems();
  // v5.5.890: footer tax breakdown was an un-memoized IIFE in the totals JSX — recomputed the
  // whole tax engine on every render (every keystroke / store write). Same memo pattern as
  // CheckoutModal. Display-only.
  const footerTaxBreakdown = useMemo(() => {
    if (!taxRates?.length || !items.length) return null;
    try { return calculateOrderTax(items.filter(i => !i.voided), taxRates, orderType || 'dine-in'); }
    catch { return null; }
  }, [items, taxRates, orderType]);
  const { subtotal, service, total, itemCount, checkDiscount, discountedSub, serviceChargeWaived, serviceChargeApplicable, autoDiscounts = [], deliveryFee = 0, deliveryQuote = null } = getPOSTotals();
  // v5.5.646: auto-fetch an Uber Direct delivery quote when a delivery order has an
  // address + items, so the surcharge is on the bill BEFORE checkout. Debounced; the
  // resolved quote lands on store.deliveryQuote and getPOSTotals folds it into total.
  const _addrKey = orderType === 'delivery' ? JSON.stringify(customer?.address || null) : '';
  useEffect(() => {
    if (orderType !== 'delivery' || !customer?.address || items.length === 0) return;
    // v5.5.854: never quote OUR courier for a channel order loaded for payment — the
    // channel (Deliveroo/UberEats) delivers it. The quote was failing on the channel's
    // address ("Delivery unavailable — out of range") and its gate blocked payment.
    if (useStore.getState().walkInOrder?._channelRef) return;
    const t = setTimeout(() => { quoteDelivery?.(); }, 450);
    return () => clearTimeout(t);
  }, [orderType, _addrKey, subtotal, items.length]);
  // Manual portion of the check discount = total check discount minus the auto-discount savings,
  // so we can show each auto-promo on its own line and the staff discount (if any) separately.
  const autoDiscountTotal = autoDiscounts.reduce((s, d) => s + (d.value || 0), 0);
  const manualCheckDiscount = Math.max(0, checkDiscount - autoDiscountTotal);
  const orderNote = getPOSOrderNote();

  // v5.5.791: detect a just-added line (new uid) or a qty bump on an existing
  // line, then scroll it into view in the order panel + flash it. Covers every
  // add path (quick tap, product modal, inline flow, custom item) because it
  // diffs the items list itself rather than hooking each caller.
  useEffect(() => {
    const key = activeTableId || 'walkin';
    const prev = prevOrderLinesRef.current;
    const sameOrder = prevOrderKeyRef.current === key && prev !== null;
    const next = new Map(items.map(i => [i.uid, i.qty || 0]));
    prevOrderKeyRef.current = key;
    prevOrderLinesRef.current = next;
    if (!sameOrder) return;                       // first render / switched order — baseline only
    let target = null;
    for (const it of items) {
      if (!prev.has(it.uid)) target = it.uid;                      // new line appended
      else if ((it.qty || 0) > prev.get(it.uid)) target = it.uid;  // qty increased on an existing line
    }
    if (!target) return;
    setFlashLineUid(target);
    clearTimeout(lineFlashTimerRef.current);
    lineFlashTimerRef.current = setTimeout(() => setFlashLineUid(null), 1000);
    // Effects run after the DOM commit, so the new line already exists — scroll
    // it into view directly (no rAF: it never fires on hidden/background tabs,
    // where smooth scrolling also stalls — jump instantly there instead).
    try {
      orderListRef.current?.querySelector(`[data-line-uid="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ behavior: document.hidden ? 'auto' : 'smooth', block: 'nearest' });
    } catch { /* noop */ }
  }, [items, activeTableId]);

  // v5.5.188: cache the per-reader customer display setting on boot.
  // Reads payment_devices.customer_display_enabled once; pushReaderDisplay
  // then checks localStorage synchronously on every cart change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const reader = await getAssignedNetworkReader();
        if (cancelled) return;
        cacheReaderDisplaySetting(reader?.customer_display_enabled);
      } catch {}
      // v5.5.346: cache this terminal's customer-display destination (off|reader|screen|auto).
      try {
        const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        if (dev?.profileId && supabase) {
          const { data } = await supabase
            .from('device_profiles').select('customer_display_mode').eq('id', dev.profileId).maybeSingle();
          if (!cancelled) cacheCustomerDisplayMode(data?.customer_display_mode || 'auto');
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // v5.5.171: live cart push to the connected Stripe reader. As items are
  // added/removed/modified — the customer-facing reader screen updates in
  // real time. Debounced 600ms inside readerDisplay.js. Edge fn no-ops if
  // no reader assigned, and skips when a payment is in flight.
  // v5.5.175: track previous item count so we only push "Welcome" when
  // going from a non-empty cart back to empty (post-transaction). On a
  // fresh POS mount with no cart the reader keeps its prior state.
  const _prevItemCountRef = useRef(0);
  const _loyaltyEnabledRef = useRef(false); // v5.5.369: broadcast to the customer display so its keypad shows reliably
  useEffect(() => {
    const nonVoided = (items || []).filter(i => !i.voided);
    const lineItems = nonVoided.map(i => {
      const unitMods = (i.mods || []).reduce((s, m) => s + (Number(m.price) || 0), 0);
      const unit = (Number(i.price) || 0) + unitMods - (Number(i.discountAmount) || 0);
      return {
        description: String(i.menuName || i.name || 'Item').slice(0, 60),
        amount: Math.max(0, Math.round(unit * 100)),
        quantity: Math.max(1, Number(i.qty) || 1),
      };
    });
    // Richer items for the dedicated customer-display screen (vs the reader's flat lines).
    const displayItems = nonVoided.map(i => {
      const unitMods = (i.mods || []).reduce((s, m) => s + (Number(m.price) || 0), 0);
      const unit = (Number(i.price) || 0) + unitMods - (Number(i.discountAmount) || 0);
      const qty = Math.max(1, Number(i.qty) || 1);
      return {
        uid: i.uid,
        name: i.menuName || i.name || 'Item',
        qty,
        lineTotal: Math.max(0, unit * qty),
        mods: (i.mods || []).map(m => ({ label: m.label, price: Number(m.price) || 0 })),
        notes: i.notes || '',
      };
    });
    const totalMinor = Math.round(((total || 0)) * 100);
    const mode = getCustomerDisplayMode();
    const prevCount = _prevItemCountRef.current;
    _prevItemCountRef.current = lineItems.length;

    if (lineItems.length === 0) {
      // Only reset displays if we previously HAD a cart — avoids stomping the
      // idle screen on every fresh POS load with no active check.
      if (prevCount > 0) {
        if (displayUsesReader(mode)) clearReaderDisplay();
        if (displayUsesScreen(mode)) publishDisplay({ items: [], total: 0, state: 'idle', currency: getActiveCurrencyCode() });
      }
    } else {
      if (displayUsesReader(mode)) pushReaderDisplay({ lineItems, totalMinor, currency: stripeCurrency() });
      if (displayUsesScreen(mode)) publishDisplay({ items: displayItems, total: total || 0, state: 'active', currency: getActiveCurrencyCode(), loyaltyEnabled: _loyaltyEnabledRef.current });
    }
  }, [items, total]);

  // v5.5.348: customer typed their phone on the dedicated display → capture for
  // loyalty. Look up / enrol by phone, attach to the order, reply to the display.
  useEffect(() => {
    if (!displayUsesScreen()) return;
    // POS resolves loyalty-enabled (it has reliable auth + locationId) and
    // broadcasts it so the rear screen's keypad gate is dependable.
    isLoyaltyEnabled().then(v => { _loyaltyEnabledRef.current = !!v; }).catch(() => {});
    const unsubPhone = onCustomerPhone(async (phone) => {
      if (!phone) return;
      try {
        const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        const res = await captureLoyaltyByPhone(phone, dev?.locationId, dev?.orgId);
        if (res?.ok) {
          const cur = useStore.getState().customer || {};
          setCustomer({ ...cur, phone, name: res.name || cur.name });
          publishLoyalty({ known: res.known, name: res.name, points: res.points, rewards: res.rewards || [], customerId: res.customerId, smsSent: res.smsSent });
        } else {
          publishLoyalty({ error: true });
        }
      } catch { publishLoyalty({ error: true }); }
    });
    // Customer tapped a reward on the display → stage it (applied at checkout).
    const unsubRedeem = onRedeemReward((reward) => {
      if (!reward) return;
      try {
        useStore.getState().setPendingLoyaltyReward(reward);
        publishLoyalty({ rewardSelected: reward.label || reward.reward_name || reward.name || 'Reward' });
      } catch { /* noop */ }
    });
    return () => { unsubPhone(); unsubRedeem(); };
  }, []);

  const firedCourses = session?.firedCourses || [];
  // v4.5.1: course management is gated per device profile. Hides per-course header (Fire button)
  // and the standalone Fire-course banner. Item.course data is preserved internally.
  const hideCourses = (deviceConfig?.hiddenFeatures || []).includes('courses');
  const covers = session?.covers || 2;
  const hasSent = !!session?.sentAt;
  const daypart = getDaypart();
  const catMeta = CAT_META[cat] || CAT_META.quick;
  const activeQueueCount = orderQueue.filter(o=>o.status!=='collected').length;

  // Smart quick screen: filter to assigned section, exclude 86'd, show available items
  // For bar terminal (assignedSection='bar'), show bar/drinks items first
  const assignedSection = deviceConfig?.assignedSection;
  const quickItems = useMemo(() => {
    // If quick screen has been explicitly configured in back office, show ONLY those items
    if (quickScreenIds && quickScreenIds.length > 0) {
      return quickScreenIds
        .map(id => MENU_ITEMS.find(i => i.id === id))
        .filter(i => i && !eightySixIds.includes(i.id) && !i.archived)
        .slice(0, 16);
    }
    // Not configured yet — show nothing (empty quick screen prompts setup)
    return [];
  }, [quickScreenIds, MENU_ITEMS, eightySixIds]);

  // When the main category changes, reset the subcategory selection
  useEffect(() => { setSubCat(null); }, [cat]);

  // Find subcategories of the active category
  const subCategories = useMemo(() =>
    menuCategories.filter(c => c.parentId === cat).sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0)),
  [cat, menuCategories]);

  const catItems = useMemo(() => {
    if (cat === 'quick') return quickItems;
    const base = MENU_ITEMS.filter(i => !i.archived && (i.type !== 'subitem' || i.soldAlone) && !i.parentId)
      .slice().sort((a,b) => (a.sortOrder??999) - (b.sortOrder??999));
    const inCat = (i, id) => i.cat === id || (i.cats||[]).includes(id);
    let items;
    if (subCat) items = base.filter(i => inCat(i, subCat));
    else if (subCategories.length > 0) {
      const subIds = subCategories.map(s => s.id);
      items = base.filter(i => inCat(i, cat) || subIds.some(sid => inCat(i, sid)));
    } else {
      items = base.filter(i => inCat(i, cat));
    }
    // Inject spacers from category config — pure layout cells, zero data
    const activeCat = menuCategories.find(c => c.id === (subCat || cat));
    const rawSpacers = activeCat?.spacerSlots || [];
    if (!rawSpacers.length) return items;
    const spacers = rawSpacers.map(s => typeof s === 'object' ? s : { id: `spacer-${s}`, sortOrder: s });
    const all = [
      ...items,
      ...spacers.map(s => ({ _spacer: true, id: s.id, sortOrder: s.sortOrder })),
    ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
    return all;
  }, [cat, subCat, subCategories, MENU_ITEMS, quickItems, menuCategories]);

  const displayItems = useMemo(() => {
    if (!search.trim()) return catItems;
    const q = search.toLowerCase();
    return MENU_ITEMS.filter(i =>
      !i.archived && (i.type !== 'subitem' || i.soldAlone) && !i.parentId &&
      ((i.menuName||i.name||'').toLowerCase().includes(q) || i.description?.toLowerCase().includes(q))
    );
  }, [cat, search, catItems, MENU_ITEMS]);

  const byCourse = useMemo(()=>{
    const g = {};
    items.forEach(item => { const c=item.course??1; if(!g[c])g[c]=[]; g[c].push(item); });
    return g;
  },[items]);
  const courseNums = Object.keys(byCourse).map(Number).sort();
  const nextToFire = courseNums.find(c=>c>1&&!firedCourses.includes(c)&&(firedCourses.includes(c-1)||firedCourses.includes(1)));

  const handleTypeChange = (t) => {
    if (t!=='dine-in') {
      // v5.5.799: quick-service venues — 'Not needed' skips the customer prompt on
      // takeaway/collection entirely; the order carries its short ref like an unnamed walk-in.
      if (takeawayCustomerDetails === 'none' && (t === 'takeaway' || t === 'collection')) { setOrderType(t); return; }
      setPendingOrderType(t); setShowCustomerModal(true);
    }
    else { setOrderType('dine-in'); clearCustomer(); }
  };

  const handleItemTap = (item) => {
    if (eightySixIds.includes(item.id)) { showToast(`${item.name} is 86'd`,'error'); return; }
    // v5.5.311: also block when this item's tracked stock is exhausted, even if
    // it isn't (yet) in eightySixIds. Guards the cross-device oversell window
    // where another terminal sold the last unit (dailyCounts arrives via
    // realtime ahead of / alongside the auto-86).
    const _dc = useStore.getState().dailyCounts || {};
    const _stock = _dc[item.id];
    if (_stock && typeof _stock.remaining === 'number' && _stock.remaining <= 0) {
      showToast(`${item.name} is out of stock`,'error'); return;
    }
    // v5.5.189: block item if ALL options in any required modifier group are 86'd.
    // The combo/modifiable item can't be fulfilled if no choices remain.
    const _modGroupDefs = useStore.getState().modifierGroupDefs || [];
    const assignedGroups = item.assignedModifierGroups || [];
    for (const ag of assignedGroups) {
      const def = _modGroupDefs.find(d => d.id === ag.groupId);
      if (!def || (def.min || 0) === 0) continue; // not required — skip
      const opts = def.options || [];
      if (opts.length === 0) continue;
      const availableOpts = opts.filter(opt => {
        const optItemId = opt.itemId || (() => {
          const name = (opt.name || '').toLowerCase();
          if (!name) return null;
          return (MENU_ITEMS || []).find(i => i.type === 'subitem' && !i.archived && (i.menuName || i.name || '').toLowerCase() === name)?.id;
        })();
        return !optItemId || !eightySixIds.includes(optItemId);
      });
      if (availableOpts.length === 0) {
        showToast(`${item.name} unavailable — all ${def.name || 'required'} options are 86'd`, 'error');
        return;
      }
    }
    if (allergens.some(a=>(item.allergens||[]).includes(a))) { setPendingItem(item); return; }
    openFlow(item);
  };
  const openFlow = (item) => {
    if (item.type === 'subitem' && !item.soldAlone) return;

    // Variant parent: detected by type OR by having linked children
    const variantChildren = MENU_ITEMS
      .filter(i => i.parentId === item.id && !i.archived && !eightySixIds.includes(i.id))
      .sort((a,b) => (a.sortOrder??999) - (b.sortOrder??999));
    if (item.type === 'variants' || variantChildren.length > 0) {
      if (variantChildren.length > 0) {
        setModalItem({
          ...item,
          type: 'variants',
          variantLabel: item.variantLabel || 'Size',
          variants: variantChildren.map(c => ({
            id: c.id,
            label: c.menuName || c.name,
            price: c.pricing?.base ?? c.price ?? 0,
            _childItem: c,
          })),
        });
        return;
      }
    }

    // type='simple' always skips modal — even if stale modifier data exists in the record
    const needsModal = item.type !== 'simple' && (
      item.assignedModifierGroups?.length > 0
      || item.assignedInstructionGroups?.length > 0
      || item.modifierGroups?.length > 0
      || ['modifiable','modifiers','pizza'].includes(item.type)
    );

    if (!needsModal) {
      addItem(item, [], null, { displayName: item.menuName || item.name, qty: 1, linePrice: item.pricing?.base ?? item.price ?? 0 });
      showToast(`${item.menuName || item.name} added`, 'success');
      setLastAddedUid(item.id);
      setTimeout(() => setLastAddedUid(null), 300);
      return;
    }
    setModalItem(item);
  };

  const handleSave = () => {
    // Save the session (seat the table) with or without items — no kitchen send
    if (!activeTableId) return;
    const label = activeTable?.label || activeTableId;
    saveTableSession(activeTableId, covers);
    setActiveTableId(null);
    showToast(`Table ${label} — saved`, 'success');
  };

  const handleSend = () => {
    // Walk-in with no table
    if (!activeTableId) {
      if (!items.length) { showToast('No items on order', 'error'); return; }
      // v4.6.5 Bug 1: if user already picked takeaway/collection/delivery AND gave customer
      // details, skip the SendWithoutTableModal — it was forcing them to re-pick the type
      // and losing the original orderType (Bug 2 downstream).
      const preSelected = (orderType === 'takeaway' || orderType === 'collection' || orderType === 'delivery');
      // v5.5.799: 'Not needed' mode — takeaway/collection sends straight through with no
      // customer prompt. An empty-name customer means Orders Hub falls back to the short
      // order ref (R-number), matching unnamed walk-ins; delivery always needs details.
      const skipDetails = takeawayCustomerDetails === 'none' && (orderType === 'takeaway' || orderType === 'collection');
      if (preSelected && (customer?.name || skipDetails)) {
        if (!customer?.name) setCustomer({ name: '', isASAP: true });
        const name = customer?.name;
        const type = orderType;
        setShowCheckout(false);
        sendToKitchen();
        // v4.6.5 follow-up: clear the POS after send, matching every OrderTypeModal branch
        // (counter/takeaway/collection/delivery/dine-in/bar). Without this, items stay in
        // the checkout and the user has no visual cue that the send fired.
        clearWalkIn();
        showToast(name ? `${name} — ${type} sent` : `${type} sent`, 'success');
        return;
      }
      setShowSendModal(true);
      return;
    }
    // Table order — send unsent items to kitchen then save
    if (!items.length) { showToast('Add items before sending to kitchen', 'error'); return; }
    const label = activeTable?.label || activeTableId;
    setShowCheckout(false);
    sendToKitchen();
    setActiveTableId(null);
    showToast(`${label} — sent to kitchen`, 'success');
  };

  // Keep deviceConfig.autoPrintReceiptOnClose + orderNotifications fresh from DB.
  // The cached value may be stale if the profile was edited in Back Office but this
  // terminal hasn't re-applied the profile. Without this, the print-decision logic
  // reads undefined and defaults to 'print', and the new-order notification gate
  // (realtime.js) would keep alerting a terminal the operator just silenced.
  useEffect(() => {
    const sync = async () => {
      const profId = deviceConfig?.profileId;
      if (!profId) return;
      try {
        const { data, error } = await supabase
          .from('device_profiles')
          .select('auto_print_receipt_on_close, order_notifications')
          .eq('id', profId)
          .single();
        if (error || !data) return;
        const apcChanged = deviceConfig?.autoPrintReceiptOnClose !== data.auto_print_receipt_on_close;
        const notifChanged = (deviceConfig?.orderNotifications !== false) !== (data.order_notifications !== false);
        if (apcChanged || notifChanged) {
          const next = {
            ...deviceConfig,
            autoPrintReceiptOnClose: data.auto_print_receipt_on_close,
            orderNotifications: data.order_notifications !== false,
          };
          setDeviceConfig(next);
          // realtime.js reads orderNotifications from the live store first but also
          // falls back to this cached config — keep both in step.
          try {
            const ls = JSON.parse(localStorage.getItem('rpos-device-config') || '{}');
            localStorage.setItem('rpos-device-config', JSON.stringify({ ...ls, orderNotifications: data.order_notifications !== false }));
          } catch { /* non-fatal */ }
        }
      } catch (e) {
        console.warn('[POSSurface] deviceConfig sync failed:', e?.message || e);
      }
    };
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceConfig?.profileId]);

  const handlePayComplete = (paymentInfo = {}) => {
    setShowCheckout(false);

    // ── Snapshot everything needed to print the customer receipt BEFORE
    //    we clear the table/walk-in. After clear, items/session are gone.
    const shouldPrint = paymentInfo.printReceipt !== false
      && (deviceConfig?.autoPrintReceiptOnClose !== false || paymentInfo.printReceipt === true);

    const receiptSnapshot = shouldPrint ? (() => {
      const nonVoided = items.filter(i => !i.voided);
      const tip = paymentInfo.tip || 0;
      const grand = total + tip;
      let taxBreakdown = null;
      if (taxRates?.length) {
        try { taxBreakdown = calculateOrderTax(nonVoided, taxRates, orderType || 'dine-in'); } catch {}
      }
      const tableLabel = activeTable?.label || null;
      const server = session?.server || staff?.name || null;
      // Use a timestamp-based ref; the durable closed_checks row gets its own
      // ref inside the store, but the printer only needs a stable display
      // string and an idempotency key (which printService generates itself).
      // Placeholder — will be overwritten after clearTable/recordWalkInClosed runs,
      // using the store-assigned "#NNNN" ref from the freshly appended closedCheck.
      const ref = 'PENDING';
      return {
        location,
        check: { ref, server, tableLabel, orderType, covers, method: paymentInfo.method, customer, processor: paymentInfo.processor || null, cardReceipt: paymentInfo.cardReceipt || null },
        items: nonVoided,
        totals: { subtotal, service, tip, grand, taxBreakdown },
      };
    })() : null;

    // v4.4.7: Wrap state mutations in try/catch so a throw inside clearTable/
    // recordWalkInClosed does NOT prevent the auto-print dispatch. Print is
    // fire-and-forget via the durable print_jobs queue.
    console.info('[PayComplete] shouldPrint=', shouldPrint, 'deviceConfig.apc=', deviceConfig?.autoPrintReceiptOnClose, 'paymentInfo.printReceipt=', paymentInfo.printReceipt);
    try {
      if (activeTableId) {
        // v5.5.792: unsent/held lines now fire INSIDE clearTable (store choke point,
        // shared with MPOS) as one combined payment-time send. The old pre-fire here
        // was also broken — it read the table row (not .session), so hasUnsent was
        // always false and table orders paid with unsent items never fired.
        clearTable(activeTableId, paymentInfo);
        showToast('Payment complete, table cleared', 'success');
        setSurface('tables');
      } else {
        // v5.5.792: unsent lines fire INSIDE recordWalkInClosed (store choke point)
        // as one combined send — all courses at once, no holds, no double-fire.
        recordWalkInClosed(useStore.getState().walkInOrder, orderType, customer, paymentInfo);
        clearWalkIn();
        showToast('Payment complete', 'success');
      }
      // v4.4.9: reset attached customer + allergen filter so the next walk-in/seat starts clean
      clearCustomer();
      clearAllergens();
    } catch (mutErr) {
      console.error('[PayComplete] State mutation failed — continuing to print:', mutErr?.message || mutErr);
    }

    // Fire-and-forget: dispatch happens via the durable print_jobs queue so
    // a failed printer doesn't block the UI. Errors surface via StatusDrawer.
    if (receiptSnapshot) {
      // Pull the real ref from closedCheck that clearTable/recordWalkInClosed
      // just appended. Fall back to a short timestamp if for any reason the
      // store didn't record one (shouldn't happen, but print should never fail here).
      const closedChecks = useStore.getState().closedChecks;
      // v5.5.316: newest check is at index 0 (records are prepended with
      // [record, ...]). Was reading length-1 (the OLDEST check), so the printed/
      // emailed receipt carried the wrong order ref whenever >1 check existed.
      const freshRef = closedChecks[0]?.ref
        || ('#' + Date.now().toString().slice(-4));
      receiptSnapshot.check.ref = freshRef;
      // TRAINING MODE: don't auto-print a physical customer receipt on close.
      if (isTrainingMode()) {
        console.info('[PayComplete] training mode — auto-print suppressed');
      } else {
        console.info('[PayComplete] dispatching auto-print with ref=', freshRef);
        // v5.5.835: printReceipt now returns { ok:false, reason:'no-printer' } instead of
        // silently browser-printing when this till has no receipt printer mapped. Surface
        // it — a receipt going nowhere with no warning is what caused this whole fix.
        printService.printReceipt(receiptSnapshot).then(result => {
          if (!result?.ok) {
            useStore.getState().showToast?.(`Receipt not printed: ${result?.error || 'no printer set for this device'}`, 'error');
          }
        }).catch(err => {
          console.warn('[Print] Auto-print on close failed:', err?.message || err);
          useStore.getState().showToast?.(`Receipt print failed: ${err?.message || err}`, 'error');
        });
      }
    } else {
      console.info('[PayComplete] no receiptSnapshot — auto-print skipped');
    }
  };

  const seatList = useMemo(()=>{ const a=['shared']; for(let i=1;i<=covers;i++)a.push(i); return a; },[covers]);

  return (
    <div style={{display:'flex',flex:1,overflow:'visible',minWidth:0,gap:12}}>

      {/* v5.5.163: Challenge 21 prompt — fires when the alcohol-sale counter hits the threshold */}
      <Challenge21PromptHost/>

      {/* v5.5.190: removed duplicate POS lock overlay (v4.6.53) — the canonical
          version is in the overlay section near the end of POSSurface return. */}

      {/* v4.6.54: drawer menu (POSSurface main return) */}
      {showDrawerMenu && (() => {
        let _mDevId = null;
        try { _mDevId = JSON.parse(localStorage.getItem('rpos-device') || '{}')?.id || null; } catch {}
        const _mDrw = Array.isArray(cashDrawers) ? cashDrawers.find(d => d.deviceId === _mDevId) || null : null;
        // No cash drawer bound to this device: still offer till functions that don't need one (waste).
        if (!_mDrw) return (
          <div className="modal-back" style={{ zIndex: 99998 }} onClick={e => e.target === e.currentTarget && setShowDrawerMenu(false)}>
            <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:420, padding:'18px 20px', boxShadow:'var(--sh3)' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>Till functions</div>
                <button onClick={() => setShowDrawerMenu(false)} style={{ background:'transparent', border:'none', fontSize:24, color:'var(--t4)', cursor:'pointer', padding:4 }}>×</button>
              </div>
              <button onClick={() => { setShowDrawerMenu(false); setShowWaste(true); }}
                style={{ width:'100%', padding:'13px', borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', fontWeight:800, fontSize:14, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span>Record waste</span><span style={{ fontSize:10, fontWeight:500, color:'var(--t4)' }}>spoilage · breakage · spillage</span>
              </button>
              <div style={{ fontSize:11.5, color:'var(--t4)', marginTop:12, lineHeight:1.5 }}>No cash drawer is bound to this device, so cash functions aren’t available. Bind one in Back Office → Devices → Cash drawers.</div>
            </div>
          </div>
        );
        const _mCan = staff?.role === 'Manager' || staff?.role === 'Admin' || (Array.isArray(staff?.permissions) && staff.permissions.includes('cashup'));
        const _mStatus = _mDrw.status || 'idle';
        const _float = Number(_mDrw.currentFloat || 0);
        const _entries = (useStore.getState().pettyCashEntries || []).filter(e => e.drawerId === _mDrw.id).slice(0, 6);
        const _SIGN = { cash_sale: +1, float_in: +1, adjustment: +1, downlift_from_safe: +1, cash_drop: -1, drop: -1, expense: -1, uplift_to_safe: -1, drawer_open: 0 };
        const _TYPE_LABEL = { cash_sale: 'Cash sale', float_in: 'Pay in', expense: 'Pay out', cash_drop: 'Cash drop', drop: 'Cash drop', drawer_open: 'Drawer opened', adjustment: 'Adjustment', uplift_to_safe: 'To safe', downlift_from_safe: 'From safe' };
        const requirePerm = () => {
          if (_mCan) return true;
          useStore.getState().showToast?.('Cashup permission required', 'error');
          return false;
        };
        return (
          <div className="modal-back" style={{ zIndex: 99998 }} onClick={e => e.target === e.currentTarget && setShowDrawerMenu(false)}>
            <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:480, maxHeight:'86vh', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'var(--sh3)' }}>
              <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div>
                    <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>{_mDrw.name}</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:2, textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 }}>
                      <span style={{ color: _mStatus === 'open' ? 'var(--grn)' : _mStatus === 'counting' ? 'var(--amb,#e8a020)' : 'var(--t4)' }}>{_mStatus}</span>
                      {' · '}Float <span style={{ color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(_float)}</span>
                    </div>
                  </div>
                  <button onClick={() => setShowDrawerMenu(false)} style={{ background:'transparent', border:'none', fontSize:24, color:'var(--t4)', cursor:'pointer', padding:4 }}>×</button>
                </div>
              </div>
              {_mStatus === 'open' && (
                <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--bdr)' }}>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8 }}>
                    <button disabled={!_mCan} onClick={() => { if (!requirePerm()) return; setShowDrawerMenu(false); setCashAction({ type:'float_in', title:'Pay in cash' }); setCashActionAmount(''); setCashActionReason(''); }}
                      style={{ padding:'14px 8px', borderRadius:10, border:`1.5px solid ${_mCan?'var(--grn)':'var(--bdr)'}`, background:_mCan?'var(--bg2)':'var(--bg3)', color:_mCan?'var(--grn)':'var(--t4)', fontFamily:'inherit', fontWeight:800, fontSize:13, cursor:_mCan?'pointer':'not-allowed', display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>Pay in</span><span style={{ fontSize:10, fontWeight:500, opacity:.75 }}>+ cash</span>
                    </button>
                    <button disabled={!_mCan} onClick={() => { if (!requirePerm()) return; setShowDrawerMenu(false); setCashAction({ type:'expense', title:'Pay out / expense' }); setCashActionAmount(''); setCashActionReason(''); }}
                      style={{ padding:'14px 8px', borderRadius:10, border:`1.5px solid ${_mCan?'var(--red,#cc5959)':'var(--bdr)'}`, background:_mCan?'var(--bg2)':'var(--bg3)', color:_mCan?'var(--red,#cc5959)':'var(--t4)', fontFamily:'inherit', fontWeight:800, fontSize:13, cursor:_mCan?'pointer':'not-allowed', display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>Pay out</span><span style={{ fontSize:10, fontWeight:500, opacity:.75 }}>− cash</span>
                    </button>
                    <button disabled={!_mCan} onClick={() => { if (!requirePerm()) return; setShowDrawerMenu(false); setCashAction({ type:'cash_drop', title:'Cash drop to safe' }); setCashActionAmount(''); setCashActionReason(''); }}
                      style={{ padding:'14px 8px', borderRadius:10, border:`1.5px solid ${_mCan?'var(--amb,#e8a020)':'var(--bdr)'}`, background:_mCan?'var(--bg2)':'var(--bg3)', color:_mCan?'var(--amb,#e8a020)':'var(--t4)', fontFamily:'inherit', fontWeight:800, fontSize:13, cursor:_mCan?'pointer':'not-allowed', display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>Cash drop</span><span style={{ fontSize:10, fontWeight:500, opacity:.75 }}>to safe</span>
                    </button>
                    <button onClick={() => { setShowDrawerMenu(false); openCashDrawer?.({ type:'drawer_open', reason:'No sale (POS)', amount:0 }); }}
                      style={{ padding:'14px 8px', borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t2)', fontFamily:'inherit', fontWeight:800, fontSize:13, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>No sale</span><span style={{ fontSize:10, fontWeight:500, opacity:.75 }}>open drawer</span>
                    </button>
                    <button disabled={!_mCan} onClick={async () => { if (!requirePerm()) return; setShowDrawerMenu(false); const exp = typeof computeExpectedCash === 'function' ? await computeExpectedCash(_mDrw.id) : 0; setExpectedForCashOut(exp); setShowCashOut(true); }}
                      style={{ padding:'14px 8px', borderRadius:10, border:`1.5px solid ${_mCan?'var(--red,#cc5959)':'var(--bdr)'}`, background:_mCan?'var(--red-d, rgba(235,97,97,0.12))':'var(--bg3)', color:_mCan?'var(--red,#cc5959)':'var(--t4)', fontFamily:'inherit', fontWeight:800, fontSize:13, cursor:_mCan?'pointer':'not-allowed', display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      <span>Cash up</span><span style={{ fontSize:10, fontWeight:500, opacity:.75 }}>close drawer</span>
                    </button>
                  </div>
                </div>
              )}
              {(!_mStatus || _mStatus === 'idle') && (
                <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--bdr)' }}>
                  <button onClick={() => { setShowDrawerMenu(false); setShowCashIn(true); }} style={{ width:'100%', padding:'14px', borderRadius:10, border:'1px solid var(--grn-b)', background:'var(--grn-d)', color:'var(--grn)', fontFamily:'inherit', fontWeight:800, fontSize:14, cursor:'pointer' }}>
                    Cash in drawer
                    <div style={{ fontSize:11, fontWeight:500, marginTop:3, opacity:.8 }}>Declare opening float. Drawer opens for trading.</div>
                  </button>
                </div>
              )}
              {_mStatus === 'counting' && (
                <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--bdr)', textAlign:'center', fontSize:13, color:'var(--amb,#e8a020)' }}>
                  Cash-up in progress. Finish from Back Office &rarr; Cash drawers.
                </div>
              )}
              <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--bdr)' }}>
                <button onClick={() => { setShowDrawerMenu(false); setShowWaste(true); }}
                  style={{ width:'100%', padding:'13px', borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', fontWeight:800, fontSize:14, cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span>Record waste</span><span style={{ fontSize:10, fontWeight:500, color:'var(--t4)' }}>spoilage · breakage · spillage</span>
                </button>
              </div>
              <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>
                <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Recent activity</div>
                {_entries.length === 0 ? (
                  <div style={{ fontSize:12, color:'var(--t4)', fontStyle:'italic' }}>No activity yet.</div>
                ) : (
                  _entries.map(e => {
                    const sign = _SIGN[e.type] ?? 0;
                    const amt = Number(e.amount) || 0;
                    const tStr = new Date(e.timestamp || Date.now()).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
                    return (
                      <div key={e.id} style={{ display:'grid', gridTemplateColumns:'60px 1fr auto', gap:10, padding:'5px 0', fontSize:12, alignItems:'baseline' }}>
                        <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{tStr}</span>
                        <span style={{ color:'var(--t2)' }}>{_TYPE_LABEL[e.type] || e.type}{e.reason ? <span style={{ color:'var(--t4)' }}> &middot; {e.reason}</span> : null}</span>
                        <span style={{ color: sign > 0 ? 'var(--grn)' : sign < 0 ? 'var(--red)' : 'var(--t4)', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                          {sign === 0 ? '—' : (sign > 0 ? '+' : '\u2212') + money(amt)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* v4.6.54: cash action modal */}
      {cashAction && (() => {
        let _mDevId = null;
        try { _mDevId = JSON.parse(localStorage.getItem('rpos-device') || '{}')?.id || null; } catch {}
        const _mDrw = Array.isArray(cashDrawers) ? cashDrawers.find(d => d.deviceId === _mDevId) || null : null;
        if (!_mDrw) return null;
        const _amt = parseFloat(cashActionAmount) || 0;
        const _valid = _amt > 0 && cashActionReason.trim().length > 0;
        const _btnColor = cashAction.type === 'float_in' ? 'var(--grn)' : cashAction.type === 'expense' ? 'var(--red,#cc5959)' : 'var(--amb,#e8a020)';
        const _placeholder = cashAction.type === 'float_in' ? 'e.g. Change from safe' : cashAction.type === 'expense' ? 'e.g. Milk delivery, tip out' : 'e.g. Bank drop';
        return (
          <div className="modal-back" style={{ zIndex: 99999 }} onClick={e => e.target === e.currentTarget && setCashAction(null)}>
            <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:420, padding:'22px 24px', boxShadow:'var(--sh3)' }}>
              <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>{cashAction.title}</div>
              <div style={{ fontSize:12, color:'var(--t3)', marginBottom:18 }}>Drawer: {_mDrw.name}</div>
              <label style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:6 }}>Amount</label>
              <div style={{ position:'relative', marginBottom:14 }}>
                <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', fontSize:22, fontWeight:700, color:'var(--t3)' }}>£</span>
                <input type="number" step="0.01" min="0" autoFocus value={cashActionAmount} onChange={e => setCashActionAmount(e.target.value)} placeholder="0.00"
                  style={{ width:'100%', padding:'14px 14px 14px 36px', fontSize:22, fontWeight:800, fontFamily:'var(--font-mono)', borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)' }} />
              </div>
              <label style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:6 }}>Reason</label>
              <input type="text" value={cashActionReason} onChange={e => setCashActionReason(e.target.value)} placeholder={_placeholder}
                style={{ width:'100%', padding:'10px 12px', fontSize:14, borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', marginBottom:20 }} />
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={() => setCashAction(null)} style={{ flex:1, padding:'11px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontFamily:'inherit', fontWeight:600, fontSize:13, cursor:'pointer' }}>Cancel</button>
                <button disabled={!_valid} onClick={async () => {
                  const type = cashAction.type;
                  const reason = cashActionReason.trim();
                  setCashAction(null);
                  await openCashDrawer?.({ type, amount: _amt, reason, force: true });
                  setCashActionAmount(''); setCashActionReason('');
                }}
                  style={{ flex:2, padding:'11px', borderRadius:10, background: _valid ? _btnColor : 'var(--bg4)', border:'none', color: _valid ? '#fff' : 'var(--t4)', fontFamily:'inherit', fontWeight:800, fontSize:14, cursor: _valid ? 'pointer' : 'not-allowed' }}>
                  {_valid ? `Confirm ${money(_amt)}` : 'Enter amount & reason'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Staff-facing waste logging → stock ledger (same path as BO Wastage) */}
      <PosWasteModal
        open={showWaste}
        onClose={() => setShowWaste(false)}
        locationId={(() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.locationId || null; } catch { return null; } })()}
        showToast={showToast}
      />

      {/* v4.6.54: explicit cash-in from menu (non-locked) */}
      {showCashIn && (() => {
        let _mDevId = null;
        try { _mDevId = JSON.parse(localStorage.getItem('rpos-device') || '{}')?.id || null; } catch {}
        const _mDrw = Array.isArray(cashDrawers) ? cashDrawers.find(d => d.deviceId === _mDevId) || null : null;
        if (!_mDrw) return null;
        return (
          <DrawerCashModal mode="in" drawer={_mDrw} locked={false} onClose={() => setShowCashIn(false)}
            onComplete={async ({ amount, denominations }) => {
              await cashInDrawer?.(_mDrw.id, { openingFloat: amount, denominations });
              await loadCurrentDrawerSession?.();
              if (typeof useStore.getState().loadCashDrawers === 'function') await useStore.getState().loadCashDrawers();
              setShowCashIn(false);
            }} />
        );
      })()}

      {/* v4.6.54: cash-out flow */}
      {showCashOut && (() => {
        let _mDevId = null;
        try { _mDevId = JSON.parse(localStorage.getItem('rpos-device') || '{}')?.id || null; } catch {}
        const _mDrw = Array.isArray(cashDrawers) ? cashDrawers.find(d => d.deviceId === _mDevId) || null : null;
        if (!_mDrw) return null;
        return (
          <DrawerCashModal mode="out" drawer={_mDrw} expectedCash={expectedForCashOut} onClose={() => setShowCashOut(false)}
            onComplete={async ({ amount, denominations, notes }) => {
              await cashOutDrawer?.(_mDrw.id, { declaredCash: amount, denominations, notes });
              setShowCashOut(false);
            }} />
        );
      })()}

      {/* ══ ORDER PANEL ════════════════════════════════════════ */}
      {/* v5.5.352 ServOS: glass material on the order panel (was solid var(--bg1)) */}
      <div style={{width:compact?300:420,minWidth:compact?260:360,maxWidth:compact?350:500,flexShrink:0,display:'flex',flexDirection:'column',background:'var(--glass-bg)',backdropFilter:'blur(22px) saturate(150%)',WebkitBackdropFilter:'blur(22px) saturate(150%)',border:'1px solid var(--glass-border)',borderRadius:22,boxShadow:'var(--glass-shadow), var(--glass-hi), var(--glass-lo)',overflow:'hidden'}}>

        {/* Context header */}
        <div style={{padding:'10px 12px 8px',borderBottom:'1px solid var(--bdr)',flexShrink:0}}>
          {activeTable ? (
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <div onClick={()=>setShowTableActions(true)} style={{width:compact?30:40,height:compact?30:40,borderRadius:activeTable.shape==='rd'?'50%':compact?7:10,background:'var(--acc-d)',border:'1.5px solid var(--acc-b)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:activeTable.parentId?(compact?8:9):(compact?9:11),fontWeight:800,color:'var(--acc)',flexShrink:0,letterSpacing:'-.01em',textAlign:'center',lineHeight:1.1,cursor:'pointer'}}>
                {activeTable.label}
              </div>
              <div style={{flex:1,minWidth:0,cursor:'pointer'}} onClick={()=>setShowTableActions(true)}>
                <div style={{fontSize:compact?12:15,fontWeight:800,color:'var(--t1)',letterSpacing:'-.01em',display:'flex',alignItems:'center',gap:6}}>
                  {activeTable.label}
                  {activeTable.parentId && (
                    <span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:20,background:'var(--acc)',color:'#0b0c10'}}>Check 2</span>
                  )}
                  <Icon name="edit" size={11} style={{color:'var(--t4)'}} />
                </div>
                <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>
                  {session?.covers} covers · {session?.server}
                  {session?.seatedAt?<span style={{color:'var(--t4)'}}> · {Math.floor((Date.now()-session.seatedAt)/60000)}m</span>:''}
                </div>
              </div>
              {/* v4.6.36: drawer pulse shortcut — shows the bound drawer's name */}
              {Array.isArray(staff?.permissions) && staff.permissions.includes('openDrawer') && (() => {
                const _drw = typeof myDrawer === 'function' ? myDrawer() : null;
                const _label = _drw ? _drw.name : 'Drawer';
                const _title = _drw ? `Open ${_drw.name} cash drawer` : 'No drawer bound to this device (Back Office > Devices > Cash drawers)';
                return (
                  <button
                    onClick={()=> setShowDrawerMenu(true)}
                    title={_title}
                    style={{fontSize:12,fontWeight:700,color: _drw ? 'var(--acc)' : 'var(--t4)',background:'var(--bg3)',border:`1px solid ${_drw ? 'var(--acc-b)' : 'var(--bdr)'}`,borderRadius:8,cursor:'pointer',fontFamily:'inherit',padding:'4px 10px',marginRight:8,flexShrink:0}}>
                    {_label}
                  </button>
                );
              })()}
              <button onClick={()=>setSurface('tables')} style={{fontSize:12,fontWeight:700,color:'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:'4px 0',flexShrink:0}}>← Floor</button>
            </div>
          ) : (
            <>
              {/* v4.6.36: drawer pulse shortcut — shows the bound drawer's name */}
              {Array.isArray(staff?.permissions) && staff.permissions.includes('openDrawer') && (() => {
                const _drw = typeof myDrawer === 'function' ? myDrawer() : null;
                const _label = _drw ? _drw.name : 'Drawer';
                const _title = _drw ? `Open ${_drw.name} cash drawer` : 'No drawer bound to this device (Back Office > Devices > Cash drawers)';
                return (
                  <div style={{display:'flex',justifyContent:'flex-end',marginBottom:6}}>
                    <button
                      onClick={()=> setShowDrawerMenu(true)}
                      title={_title}
                      style={{fontSize:11,fontWeight:700,color: _drw ? 'var(--acc)' : 'var(--t3)',background:'var(--bg3)',border:`1px solid ${_drw ? 'var(--acc-b)' : 'var(--bdr)'}`,borderRadius:8,cursor:'pointer',fontFamily:'inherit',padding:'3px 10px'}}>
                      {_label}
                    </button>
                  </div>
                );
              })()}
              {/* v5.5.357 ServOS: recessed segmented track (reference .seg) — active tab raised in glass + signal-green icon */}
              <div style={{display:'flex',gap:4,padding:4,borderRadius:13,background:'var(--inset)',border:'1px solid var(--inset-border)',marginBottom:orderType==='dine-in'?0:8}}>
                {visibleOrderTypes.map(([t,ic,l])=>{
                  const on=orderType===t;
                  const iconName=t==='dine-in'?'dinein':t==='takeaway'?'takeaway':t==='collection'?'collect':t==='delivery'?'delivery':'dinein';
                  return (
                  <button key={t} onClick={()=>handleTypeChange(t)} style={{flex:1,padding:'9px 4px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',border:'none',background:on?'var(--glass-bg)':'transparent',boxShadow:on?'var(--glass-hi)':'none',color:on?'var(--t1)':'var(--t3)',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',justifyContent:'center',gap:6,letterSpacing:.01,transition:'all .14s'}}>
                    <Icon name={iconName} size={15} stroke={1.8} style={{color:on?'var(--acc)':'var(--t3)'}} />{l}
                  </button>
                  );
                })}
              </div>
              {/* Named order: show customer name even on dine-in type */}
              {customer&&(
                <div style={{background:'var(--bg3)',borderRadius:10,padding:'8px 12px',marginTop:8,display:'flex',alignItems:'center',gap:10,border:'1px solid var(--bdr)'}}>
                  <div style={{width:32,height:32,borderRadius:'50%',background:'var(--acc-d)',border:'1.5px solid var(--acc-b)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:'var(--acc)',flexShrink:0}}>{customer.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase()}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:'var(--t1)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{customer.name}</div>
                    <div style={{fontSize:11,color:'var(--t3)'}}>{customer.phone}{orderType==='collection'?` · ${customer.isASAP?'⚡ ASAP':`🕐 ${customer.collectionTime}`}`:orderType==='dine-in'?' · Named order':''}</div>
                    {/* v5.5.894: persistent allergy warning — the attach toast is only ~3s */}
                    {Array.isArray(customer.allergens)&&customer.allergens.length>0&&(
                      <div style={{fontSize:11,fontWeight:800,color:'var(--red)',marginTop:2}}>
                        ⚠ ALLERGY: {customer.allergens.map(a=>(ALLERGENS.find(x=>x.id===a)?.label||a)).join(', ')}
                      </div>
                    )}
                  </div>
                  <button onClick={()=>{setShowCustomerModal(true);setPendingOrderType(orderType);}} style={{fontSize:11,fontWeight:700,color:'var(--acc)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0,flexShrink:0}}>Edit</button>
                </div>
              )}
              {!customer&&(
                <button onClick={()=>{setShowCustomerModal(true);setPendingOrderType(orderType);}} style={{width:'100%',padding:'9px 12px',borderRadius:10,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1.5px dashed var(--bdr2)',color:'var(--t3)',fontSize:13,fontWeight:600,display:'flex',alignItems:'center',gap:8,justifyContent:'center',marginTop:8,transition:'all .14s'}}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.color='var(--acc)';}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>
                  <Icon name="user" size={15} /> Add customer details
                </button>
              )}
            </>
          )}
        </div>

        {/* Order label row */}
        <div style={{padding:'6px 12px 3px',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <span style={{fontSize:10,fontWeight:800,color:'var(--t4)',textTransform:'uppercase',letterSpacing:'.08em'}}>
            {activeTable?`${activeTable.label}`:orderType} · {staff?.name}
          </span>
          <div style={{display:'flex',alignItems:'center',gap:6}}>
            {items.length>0&&(
              <button
                onClick={()=>setNamesOnly(n=>!n)}
                style={{fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:5,cursor:'pointer',fontFamily:'inherit',
                  border:`1px solid ${namesOnly?'var(--acc-b)':'var(--bdr)'}`,
                  background:namesOnly?'var(--acc-d)':'transparent',
                  color:namesOnly?'var(--acc)':'var(--t4)',transition:'all .12s'}}
              >≡ Names</button>
            )}
            {/* v5.5.644: on a TABLE, "Clear" now drops only the unsent draft
                (clearDraftItems) — sent items + the table session survive. It no
                longer wipes a whole occupied table's order. Walk-in carts still
                clear fully. */}
            {items.length>0&&(
              <button onClick={()=>activeTableId?clearDraftItems(activeTableId):clearWalkIn()} style={{fontSize:11,fontWeight:700,color:'var(--t4)',cursor:'pointer',background:'none',border:'none',fontFamily:'inherit',padding:0,transition:'color .12s'}}
                onMouseEnter={e=>e.currentTarget.style.color='var(--red)'}
                onMouseLeave={e=>e.currentTarget.style.color='var(--t4)'}>Clear</button>
            )}
          </div>
        </div>

        {/* Items by course */}
        <div ref={orderListRef} style={{flex:1,overflowY:'auto',padding:'4px 10px'}}>

          {/* Empty state */}
          {items.length===0&&(
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:compact?'16px 12px':'52px 20px',textAlign:'center'}}>
              <div style={{width:compact?36:56,height:compact?36:56,borderRadius:compact?10:16,background:'var(--bg3)',border:'1px solid var(--bdr)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:compact?8:14,opacity:.6,color:'var(--t3)'}}><Icon name="receipt" size={compact?20:28} /></div>
              <div style={{fontSize:14,fontWeight:700,color:'var(--t3)',marginBottom:4}}>Order is empty</div>
              <div style={{fontSize:12,color:'var(--t4)'}}>Tap items from the menu →</div>
            </div>
          )}

          {courseNums.map(courseNum=>{
            const cc=COURSE_COLORS[courseNum]||COURSE_COLORS[1];
            const isFired=firedCourses.includes(courseNum)||courseNum===0;
            const canFire=hasSent&&!isFired&&courseNum>1&&(firedCourses.includes(courseNum-1)||firedCourses.includes(1));
            return(
              <div key={courseNum} style={{marginBottom:8}}>
                {!hideCourses && courseNums.length>1&&(
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5,marginTop:3}}>
                    <div style={{height:1,flex:1,background:'var(--bdr)'}}/>
                    <div style={{display:'flex',alignItems:'center',gap:5}}>
                      <span style={{fontSize:10,fontWeight:800,padding:'2px 8px',borderRadius:20,background:isFired?'var(--grn-d)':cc.bg,border:`1px solid ${isFired?'var(--grn-b)':cc.color+'44'}`,color:isFired?'var(--grn)':cc.color,letterSpacing:.03}}>{isFired?'✓ ':''}{cc.label}</span>
                      {canFire&&<button onClick={()=>fireCourse(courseNum)} style={{fontSize:10,fontWeight:800,padding:'2px 10px',borderRadius:20,background:'var(--acc)',color:'#0b0c10',border:'none',cursor:'pointer',fontFamily:'inherit',display:'inline-flex',alignItems:'center',gap:4}}><Icon name="fire" size={11}/>Fire</button>}
                    </div>
                    <div style={{height:1,flex:1,background:'var(--bdr)'}}/>
                  </div>
                )}
                {byCourse[courseNum].map(item=>(
                  <OrderItem key={item.uid} item={item} covers={covers} orderType={orderType} seatList={seatList} namesOnly={namesOnly}
                    flash={flashLineUid===item.uid}
                    onQty={d=>updateItemQty(item.uid,d)}
                    onRemove={()=>removeItem(item.uid)}
                    onNote={n=>updateItemNote(item.uid,n)}
                    onSeat={s=>updateItemSeat(item.uid,s)}
                    onCourse={c=>updateItemCourse(item.uid,c)}
                    onVoid={()=>setVoidTarget({type:'item',item})}
                    onDiscount={()=>setDiscountTarget({scope:'item',item})}
                    onRemoveDiscount={()=>removeItemDiscount(activeTableId,item.uid)}
                  />
                ))}
              </div>
            );
          })}
        </div>

        {/* Order note */}
        {items.length>0&&(
          <div style={{padding:'5px 10px 0',flexShrink:0}}>
            <textarea value={orderNote} onChange={e=>setOrderNote(e.target.value)} placeholder="Order note for kitchen…" rows={orderNote?2:1}
              style={{width:'100%',background:'var(--bg3)',border:'1.5px solid var(--bdr)',borderRadius:10,padding:'7px 11px',color:'var(--t1)',fontSize:12,fontFamily:'inherit',resize:'none',outline:'none',lineHeight:1.5,display:'block',transition:'border-color .15s'}}
              onFocus={e=>e.target.style.borderColor='var(--acc-b)'}
              onBlur={e=>e.target.style.borderColor='var(--bdr)'}/>
          </div>
        )}

        {/* Footer — totals + actions */}
        <div style={{flexShrink:0,borderTop:'1px solid var(--bdr)',background:'var(--bg2)'}}>
          {items.length>0&&(
            <>
              {/* Totals */}
              <div style={{padding:'10px 12px 6px'}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t3)',marginBottom:3}}>
                  <span>{itemCount} item{itemCount!==1?'s':''}</span>
                  <span style={{fontFamily:'var(--font-mono)'}}>{money(subtotal)}</span>
                </div>
                {/* Auto-discount promos (BOGO / bundle / scheduled) — one line each, tagged AUTO */}
                {autoDiscounts.map((ad,i)=>(
                  <div key={ad.id||i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12,color:'var(--grn)',marginBottom:3}}>
                    <span style={{display:'flex',alignItems:'center',gap:5,minWidth:0}}>
                      <span style={{fontSize:9,fontWeight:800,letterSpacing:'.04em',color:'var(--grn)',border:'1px solid var(--grn-b)',background:'var(--grn-d)',borderRadius:4,padding:'0 4px',flexShrink:0}}>AUTO</span>
                      <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ad.label}</span>
                    </span>
                    <span style={{fontFamily:'var(--font-mono)',flexShrink:0}}>−{money(ad.value)}</span>
                  </div>
                ))}
                {manualCheckDiscount>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--grn)',marginBottom:3}}>
                  <span>Discount</span><span style={{fontFamily:'var(--font-mono)'}}>−{money(manualCheckDiscount)}</span>
                </div>}
                {/* Service charge — only dine-in, from device profile, tap to remove/restore */}
                {serviceChargeApplicable && (
                  serviceChargeWaived ? (
                    // Waived — show restore option
                    <div onClick={toggleServiceCharge} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11,color:'var(--t4)',marginBottom:3,cursor:'pointer',padding:'2px 0'}}>
                      <span style={{display:'flex',alignItems:'center',gap:4}}>
                        <span style={{fontSize:10,color:'var(--grn)',fontWeight:700,border:'1px solid var(--grn-b)',background:'var(--grn-d)',borderRadius:4,padding:'1px 5px'}}>+</span>
                        <span style={{textDecoration:'line-through',color:'var(--t4)'}}>Service charge removed</span>
                      </span>
                      <span style={{color:'var(--grn)',fontSize:10,fontWeight:600}}>Restore</span>
                    </div>
                  ) : service > 0 ? (
                    // Active — show with remove button
                    <div onClick={toggleServiceCharge} style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12,color:'var(--t3)',marginBottom:3,cursor:'pointer',padding:'2px 0',borderRadius:6}}
                      onMouseEnter={e=>{e.currentTarget.style.background='var(--bg3)';e.currentTarget.style.padding='2px 4px';}}
                      onMouseLeave={e=>{e.currentTarget.style.background='';e.currentTarget.style.padding='2px 0';}}>
                      <span>{(() => { const sc = deviceConfig?.serviceCharge; const pct = sc?.rate ?? 12.5; return sc?.applyTo==='minCovers' ? `Service (${pct}%, ${sc.minCovers}+ cvr)` : `Service (${pct}%)`; })()} <span style={{fontSize:10,color:'var(--t4)',marginLeft:4}}>tap to remove</span></span>
                      <span style={{fontFamily:'var(--font-mono)'}}>{money(service)}</span>
                    </div>
                  ) : null
                )}
                {/* v5.5.646: delivery surcharge (Uber Direct) — delivery orders only */}
                {orderType === 'delivery' && deliveryQuote && (
                  deliveryQuote.available ? (
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:12,color:'var(--t3)',marginBottom:3,padding:'2px 0'}}>
                      <span>Delivery{deliveryQuote.freeDelivery ? ' (free)' : ''}{deliveryQuote.etaMinutes != null ? ` · ~${deliveryQuote.etaMinutes} min` : ''}{deliveryQuote.fallback ? ' · est.' : ''}</span>
                      <span style={{fontFamily:'var(--font-mono)'}}>{money(deliveryFee)}</span>
                    </div>
                  ) : (
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:11,color:'var(--red)',marginBottom:3,padding:'2px 0'}}>
                      <span>Delivery unavailable{deliveryQuote.reason === 'out_of_radius' ? ' — out of range' : deliveryQuote.reason === 'out_of_coverage' ? ' — outside courier area' : deliveryQuote.reason === 'not_configured' ? ' — not set up' : deliveryQuote.reason === 'disabled' ? '' : ''}</span>
                      <span style={{fontSize:10,color:'var(--t4)'}}>offer collection</span>
                    </div>
                  )
                )}
                {orderType === 'delivery' && deliveryQuote?.available && deliveryQuote.belowMinimum && (
                  <div style={{fontSize:11,color:'var(--red)',marginBottom:3,padding:'2px 0'}}>
                    Below the {deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor/100) : ''} delivery minimum
                  </div>
                )}
                {/* Tax breakdown — shown below service charge (memoized v5.5.890) */}
                {footerTaxBreakdown?.breakdown?.length > 0 && footerTaxBreakdown.breakdown.filter(b => b.tax >= 0).map(b => {
                  const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
                  const label = footerTaxBreakdown.hasExclusiveTax ? `+ ${b.rate.name} (${pct}%)` : `incl. ${b.rate.name} (${pct}%)`;
                  return (
                    <div key={b.rate.id} style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--t4)',marginBottom:2}}>
                      <span>{label}</span>
                      <span style={{fontFamily:'var(--font-mono)'}}>{money(b.tax)}</span>
                    </div>
                  );
                })}
                <div style={{display:'flex',justifyContent:'space-between',fontSize:22,fontWeight:800,marginTop:8,paddingTop:8,borderTop:'1px solid var(--bdr)'}}>
                  <span>Total</span>
                  <span style={{color:'var(--acc)',fontFamily:'var(--font-mono)',letterSpacing:'-.01em'}}>{money(total)}</span>
                </div>
              </div>

              {/* Check discounts */}
              {(()=>{
                const checkDiscounts=activeTableId?(tables.find(t=>t.id===activeTableId)?.session?.discounts||[]):(useStore.getState().walkInOrder?.discounts||[]);
                return checkDiscounts.length>0?(
                  <div style={{padding:'0 12px 4px'}}>
                    {checkDiscounts.map(d=>(
                      <div key={d.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:11,color:'var(--grn)',marginBottom:2}}>
                        <span style={{display:'inline-flex',alignItems:'center',gap:5}}><Icon name="tag" size={12}/>{d.label}</span>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <span style={{fontFamily:'var(--font-mono)'}}>−{money(d.amount)}</span>
                          <button onClick={()=>activeTableId?removeCheckDiscount(activeTableId,d.id):removeWalkInDiscount(d.id)} style={{fontSize:11,color:'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit'}}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ):null;
              })()}

              {/* Fire course banner — v4.5.1 gated by deviceConfig.hiddenFeatures.courses */}
              {!hideCourses && hasSent&&nextToFire&&(
                <div style={{margin:'4px 10px 0',padding:'8px 12px',background:'rgba(232,160,32,.1)',border:'1px solid rgba(232,160,32,.25)',borderRadius:10,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span style={{fontSize:12,color:'var(--acc)',fontWeight:700}}>{COURSE_COLORS[nextToFire]?.label} ready to fire</span>
                  <button onClick={()=>fireCourse(nextToFire)} style={{fontSize:12,fontWeight:800,padding:'4px 12px',borderRadius:8,background:'var(--acc)',color:'#0b0c10',border:'none',cursor:'pointer',fontFamily:'inherit',display:'inline-flex',alignItems:'center',gap:5}}><Icon name="fire" size={12}/>Fire</button>
                </div>
              )}

              {/* Action row */}
              <div style={{padding:'6px 10px 4px',display:'flex',gap:4,flexWrap:'wrap'}}>
                <button onClick={()=>setShowReview(true)} style={{flex:1,height:32,borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11,fontWeight:700,minWidth:60,display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5}}><Icon name="orders" size={13}/>Review</button>
                <button onClick={()=>setShowDiscount(true)} style={{flex:1,height:32,borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11,fontWeight:700,minWidth:60,display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5}}><Icon name="tag" size={13}/>Discount</button>
                <button onClick={()=>setShowReceipt(true)} style={{flex:1,height:32,borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11,fontWeight:700,minWidth:60,display:'inline-flex',alignItems:'center',justifyContent:'center',gap:5}}><Icon name="print" size={13}/>Print</button>
                {hasSent&&<button onClick={()=>setShowReprint(true)} style={{flex:1,height:32,borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11,fontWeight:700,minWidth:60}}>↻ Reprint</button>}
                {activeTableId&&hasSent&&<button onClick={()=>setVoidTarget({type:'check',items:items.filter(i=>!i.voided)})} style={{flex:1,height:32,borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:11,fontWeight:700,minWidth:60}}>⊘ Void</button>}
              </div>
            </>
          )}

          {/* Send / Pay */}
          <div style={{padding:'6px 10px 12px',display:'flex',gap:6}}>
            <button onClick={()=>setShowCustom(true)} title="Custom item" style={{width:40,height:40,borderRadius:11,border:'1px solid var(--bdr2)',background:'var(--bg3)',color:'var(--t3)',cursor:'pointer',fontFamily:'inherit',fontSize:20,flexShrink:0,transition:'all .14s'}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--bdr3)';e.currentTarget.style.color='var(--t2)';}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>+</button>
            {activeTableId ? (() => {
              // Table mode: one button — label depends on state
              // No items → Save (hold table)
              // Items exist, not all sent → Save & Send
              // All items already sent → Save
              const hasUnsent = items.some(i => !i.voided && !i.sentAt);
              const label = items.length === 0 ? 'Save' : hasUnsent ? 'Save & Send →' : 'Save';
              const isActive = items.length > 0 && hasUnsent;
              return (
                <button className="btn btn-ghost"
                  style={{flex:1,height:compact?34:40,fontSize:compact?12:13,fontWeight:700,letterSpacing:.01,
                    ...(isActive ? {borderColor:'var(--acc-b)',color:'var(--acc)'} : {})}}
                  onClick={isActive ? handleSend : handleSave}>
                  {label}
                </button>
              );
            })() : (
              // Walk-in mode: Send only
              <button className="btn btn-ghost" style={{flex:1,height:compact?34:40,opacity:items.length===0?.3:1,fontSize:compact?12:13,fontWeight:700,letterSpacing:.01}} onClick={handleSend}>
                Send →
              </button>
            )}
            <button className="btn btn-acc" style={{flex:1.4,height:compact?34:40,opacity:items.length===0?.3:1,fontSize:compact?12:14,fontWeight:800,letterSpacing:.01}} onClick={()=>{
              if (!items.length) return;
              // v5.5.657: delivery gates — can't take payment for an undeliverable address or
              // an order below the delivery minimum.
              if (orderType === 'delivery' && deliveryQuote) {
                if (!deliveryQuote.available) { showToast('Delivery unavailable for this address — switch to collection or takeaway.', 'error'); return; }
                if (deliveryQuote.belowMinimum) { showToast(`Minimum delivery order is ${deliveryQuote.minOrderMinor != null ? money(deliveryQuote.minOrderMinor/100) : 'higher'} — add more items or change the order type.`, 'error'); return; }
              }
              const hasAllergens = items.some(i=>!i.voided&&i.allergens?.length);
              if (hasAllergens) setShowAllergenGate(true);
              else setShowCheckout(true);
            }}>
              {items.length>0?`Pay ${money(total)}`:'Pay'}
            </button>
          </div>
        </div>
      </div>

      {/* ══ CATEGORY NAV ══════════════════════════════════════════ */}
      {/* v5.5.352 ServOS: glass material on the category column */}
      <div style={{width:'var(--cat)',flexShrink:0,background:'var(--glass-bg)',backdropFilter:'blur(22px) saturate(150%)',WebkitBackdropFilter:'blur(22px) saturate(150%)',border:'1px solid var(--glass-border)',borderRadius:22,boxShadow:'var(--glass-shadow), var(--glass-hi), var(--glass-lo)',display:'flex',flexDirection:'column',overflow:'hidden'}}>
        <div style={{padding:'12px 10px 8px',borderBottom:'1px solid var(--bdr)',flexShrink:0}}>
          <div style={{fontSize:9,fontWeight:800,color:'var(--t4)',textTransform:'uppercase',letterSpacing:'.12em',paddingLeft:2}}>Menu</div>
        </div>
        <div style={{flex:1,overflowY:'auto',padding:compact?'4px':'6px 7px'}}>
          {/* Quick screen always first */}
          {[{ id:'quick', label:'Quick', icon:'⚡', color:'var(--acc)' }].concat(
            // v4.7.6: cat is in this menu if its primary menu_id matches OR it's joined via menu_category_links
          menuCategories.filter(c => !c.parentId && !c.isSpecial && (!deviceMenuId||c.menuId===deviceMenuId||_linkedCatIdsForDeviceMenu.has(c.id))).sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0))
          ).map(c => {
            const isActive = cat === c.id && !search;
            const color = c.color || 'var(--acc)';
            const subIds = menuCategories.filter(s => s.parentId === c.id).map(s => s.id);
            // v5.5.890: one-pass memoized counts (was a full MENU_ITEMS.filter per category per render)
            const count = c.id === 'quick'
              ? quickItems.length
              : (directCountByCat.get(c.id) || 0) + subIds.reduce((s, id) => s + (directCountByCat.get(id) || 0), 0);
            const hasSubcats = subIds.length > 0;
            return (
              <button key={c.id} onClick={() => { setCat(c.id); setSearch(''); }} className="cat-btn" style={{
                marginBottom:3, gap:10,
                background:isActive?`${color}1f`:'transparent',
                borderColor:isActive?`${color}66`:'transparent',
                boxShadow:isActive?'var(--glass-hi)':'none',
              }}>
                {/* v5.5.358 ServOS: colour-tinted icon chip (reference .cat .ci) replaces the thin stripe */}
                <div style={{width:compact?30:34,height:compact?30:34,borderRadius:9,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:`${color}24`,border:`1px solid ${color}40`,color:color}}>
                  {emojiToIcon(c.icon)
                    ? <Icon name={emojiToIcon(c.icon)} size={compact?15:17} />
                    : <span style={{fontSize:compact?14:16,lineHeight:1}}>{c.icon||'•'}</span>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontSize:13,fontWeight:600,color:isActive?color:'var(--t1)',letterSpacing:'-.01em',overflow:'hidden',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',lineHeight:1.2,wordBreak:'break-word'}}>{c.label}</span>
                    {hasSubcats && <span style={{fontSize:8,color:'var(--t4)',flexShrink:0}}>▾</span>}
                  </div>
                  <div style={{fontSize:9,fontFamily:'var(--font-mono)',color:'var(--t4)',marginTop:2,letterSpacing:'.06em'}}>{count} items</div>
                </div>
                {isActive && <div style={{width:6,height:6,borderRadius:'50%',background:color,flexShrink:0,boxShadow:`0 0 6px ${color}`}}/>}
              </button>
            );
          })}
        </div>
        <div style={{padding:'8px 7px 10px',borderTop:'1px solid var(--bdr)'}}>
          <button onClick={()=>setShowAllergens(s=>!s)} style={{
            width:'100%',padding:'9px 10px',borderRadius:10,cursor:'pointer',fontFamily:'inherit',
            display:'flex',alignItems:'center',gap:7,
            background:allergens.length>0?'var(--red-d)':'var(--bg3)',
            border:`1.5px solid ${allergens.length>0?'var(--red-b)':'var(--bdr)'}`,
            color:allergens.length>0?'var(--red)':'var(--t3)',fontSize:11,fontWeight:700,
            transition:'all .14s',
          }}>
            <Icon name="warn" size={15} />
            <span style={{flex:1,textAlign:'left'}}>
              {allergens.length>0?`${allergens.length} filter${allergens.length>1?'s':''} active`:'Allergen filter'}
            </span>
            {allergens.length>0&&<div style={{width:7,height:7,borderRadius:'50%',background:'var(--red)',animation:'pulse 1.5s ease-in-out infinite'}}/>}
          </button>
        </div>
      </div>

      {/* ══ PRODUCT GRID / ORDERS HUB ═════════════════════════════ */}
      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0,background:'var(--glass-bg)',backdropFilter:'blur(22px) saturate(150%)',WebkitBackdropFilter:'blur(22px) saturate(150%)',border:'1px solid var(--glass-border)',borderRadius:22,boxShadow:'var(--glass-shadow), var(--glass-hi), var(--glass-lo)'}}>

        {/* Tab bar */}
        <div style={{padding:'0 14px',borderBottom:'1px solid var(--glass-border)',background:'transparent',flexShrink:0,display:'flex',alignItems:'center',gap:0}}>
          {[['menu','Menu'],['history','History'],['deliveries','Deliveries']].map(([t,l])=>{
            const isActive = rightTab===t;
            const badge = t==='orders' ? orderQueue.filter(o=>o.status!=='collected').length : 0;
            return (
              <button key={t} onClick={()=>setRightTab(t)} style={{
                padding:'11px 16px',cursor:'pointer',fontFamily:'inherit',border:'none',
                borderBottom:`2px solid ${isActive?'var(--acc)':'transparent'}`,
                background:'transparent',
                color:isActive?'var(--acc)':'var(--t3)',
                fontSize:compact?11:13,fontWeight:isActive?700:500,
                display:'flex',alignItems:'center',gap:6,
                transition:'all .12s',
              }}>
                {l}
                {badge>0&&<span style={{background:'var(--acc)',color:'#0e0f14',borderRadius:20,padding:'1px 7px',fontSize:10,fontWeight:800}}>{badge}</span>}
              </button>
            );
          })}
          {/* Send / Pay always in tab bar */}
          <div style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center',padding:'6px 0'}}>
            {rightTab==='menu'&&(
              <div style={{position:'relative',maxWidth:200}}>
                <Icon name="search" size={14} style={{position:'absolute',left:11,top:'50%',transform:'translateY(-50%)',color:'var(--t3)'}} />
                <input className="input" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{paddingLeft:32,height:32,fontSize:12,width:180}}/>
                {search&&<button onClick={()=>setSearch('')} style={{position:'absolute',right:9,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:15,lineHeight:1}}>×</button>}
              </div>
            )}
          </div>
        </div>

        {/* ── Menu tab ── */}
        {/* InlineItemFlow: variants/modifiers shown inline. Pizza uses modal overlay instead. */}
        {modalItem && modalItem.type !== 'pizza' && rightTab==='menu' && (
          <div style={{flex:1, overflow:'hidden'}}>
            <InlineItemFlow
              key={modalItem.id}
              item={modalItem}
              menuItems={MENU_ITEMS}
              activeAllergens={allergens}
              onConfirm={(item,mods,cfg,opts)=>{ addItem(item,mods,cfg,opts); setModalItem(null); showToast(`${opts.displayName||item.name} added`,'success'); }}
              onCancel={()=>setModalItem(null)}
            />
          </div>
        )}
        {(!modalItem || modalItem.type === 'pizza') && rightTab==='menu'&&(
          <>
            {showAllergens&&(
              <div style={{padding:'8px 14px',borderBottom:'1px solid var(--bdr)',background:'var(--bg1)',flexShrink:0}}>
                <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                  {allergens.length>0&&<button onClick={clearAllergens} style={{padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600,background:'var(--bg3)',border:'1px solid var(--bdr2)',color:'var(--t2)',cursor:'pointer',fontFamily:'inherit'}}>Clear all</button>}
                  {ALLERGENS.map(a=>{const on=allergens.includes(a.id);return(<button key={a.id} onClick={()=>toggleAllergen(a.id)} style={{display:'inline-flex',alignItems:'center',gap:4,padding:'3px 8px',borderRadius:20,fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit',border:`1px solid ${on?'var(--red-b)':'var(--bdr)'}`,background:on?'var(--red-d)':'transparent',color:on?'var(--red)':'var(--t3)'}}><span style={{width:13,height:13,borderRadius:3,background:on?'var(--red)':'var(--bg3)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:8,fontWeight:700,color:on?'#fff':'var(--t3)',flexShrink:0}}>{a.icon}</span>{a.label}</button>);})}
                </div>
              </div>
            )}
            <div style={{flex:1,overflowY:'auto',padding:'10px 12px'}}>
              {!search&&cat==='quick'&&(
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,paddingBottom:10,borderBottom:'1px solid var(--bdr)'}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:'var(--t1)'}}>Quick picks</div>
                    <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>AI-curated · {daypart}</div>
                  </div>
                  <span style={{fontSize:11,fontWeight:700,padding:'3px 10px',borderRadius:20,background:'var(--acc-d)',border:'1px solid var(--acc-b)',color:'var(--acc)',display:'inline-flex',alignItems:'center',gap:4}}><Icon name="sparkle" size={11}/>Live</span>
                </div>
              )}
              {search&&displayItems.length>0&&(
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,paddingBottom:8,borderBottom:'1px solid var(--bdr)'}}>
                  <div style={{fontSize:12,color:'var(--t3)'}}>
                    <span style={{fontWeight:700,color:'var(--t1)'}}>{displayItems.length}</span> result{displayItems.length!==1?'s':''} for <span style={{color:'var(--acc)',fontWeight:600}}>"{search}"</span>
                  </div>
                  <button onClick={()=>setSearch('')} style={{fontSize:11,color:'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:600,padding:0}}>✕ Clear</button>
                </div>
              )}
            {/* Subcategory pills */}
            {!search && cat !== 'quick' && subCategories.length > 0 && (
              <div style={{ display:'flex', gap:4, padding:'6px 0 10px', flexWrap:'wrap' }}>
                <button onClick={() => setSubCat(null)} style={{ padding:'4px 12px', borderRadius:20, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:!subCat?800:500, border:'none', background:!subCat?'var(--acc)':'var(--bg3)', color:!subCat?'#0b0c10':'var(--t3)' }}>All</button>
                {subCategories.map(sc => {
                  const a = subCat === sc.id, cl = sc.color||'var(--acc)';
                  return (<button key={sc.id} onClick={() => setSubCat(sc.id)} style={{ padding:'4px 12px', borderRadius:20, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:a?800:500, border:`1.5px solid ${a?cl:'var(--bdr)'}`, background:a?`${cl}20`:'var(--bg3)', color:a?cl:'var(--t3)', display:'inline-flex', alignItems:'center', gap:5 }}>{sc.icon && (emojiToIcon(sc.icon) ? <Icon name={emojiToIcon(sc.icon)} size={13}/> : <span>{sc.icon}</span>)}{sc.label}</button>);
                })}
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'repeat(6, 1fr)',gridAutoRows:`minmax(${compact?80:110}px,auto)`,gap:compact?4:8}}>
                {displayItems.map(item=>{
                  // Spacer — empty transparent cell, invisible to customers
                  if (item._spacer) return <div key={item.id} style={{ borderRadius:14, background:'transparent', pointerEvents:'none' }}/>;

                  // Resolve category colour/icon from store (Menu Manager categories)
                  // v5.5.890: Map lookups (memoized above) — was a full scan per tile per render.
                  const storeCat = catById.get(item.cat);
                  const legacyMeta = CAT_META[item.cat] || CAT_META.quick;
                  const catColor = storeCat?.color || legacyMeta.color || 'var(--acc)';
                  const catIcon  = storeCat?.icon  || legacyMeta.icon  || '🍽';
                  const flagged=allergens.some(a=>item.allergens?.includes(a));
                  const is86=eightySixIds.includes(item.id);
                  const rank=cat==='quick'?QUICK_IDS.indexOf(item.id):-1;
                  const isHot=rank>=0&&rank<3;
                  const variantKids=childrenByParent.get(item.id)||[];
                  const isVariantParent=variantKids.length>0||item.type==='variants';
                  const fromPrice=isVariantParent&&variantKids.length>0
                    ? Math.min(...variantKids.map(c=>c.pricing?.base??c.price??0))
                    : (item.pricing?.base??item.price??0);
                  const hasOptions=(item.assignedModifierGroups?.length>0)||(item.assignedInstructionGroups?.length>0)||(item.modifierGroups?.length>0);
                  const accentColor = is86?'var(--t4)':flagged?'var(--red)':catColor;
                  const count = dailyCounts[item.id];
                  const isLow = count && count.remaining <= 3 && count.remaining > 0;
                  const displayName = item.menuName || item.name || 'Item';

                  // Long-press handlers — 600ms hold opens item info sheet
                  const handlePressStart = (e) => {
                    e.preventDefault();
                    longPressTimer.current = setTimeout(() => {
                      setInfoItem(item);
                    }, 600);
                  };
                  const handlePressEnd = () => {
                    clearTimeout(longPressTimer.current);
                  };

                  const hasImg = showItemImages && item.image && !is86;

                  return(
                    <button key={item.id}
                      onClick={()=>handleItemTap(item)}
                      onMouseDown={handlePressStart}
                      onMouseUp={handlePressEnd}
                      onMouseLeave={handlePressEnd}
                      onTouchStart={handlePressStart}
                      onTouchEnd={handlePressEnd}
                      className={`prod-card${is86?' prod-card--disabled':''}${lastAddedUid===item.id?' add-pulse':''}`}
                      style={{
                        minHeight:108,
                        ...(hasImg ? {
                          backgroundImage: `url(${item.image})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        } : (is86 ? {} : {
                          // v5.5.353 ServOS: category-colour tinted tile (left stripe already uses catColor)
                          backgroundImage: `linear-gradient(160deg, ${catColor}1c, ${catColor}06)`,
                          borderColor: `${catColor}33`,
                        })),
                      }}>
                      {/* Full overlay when image is showing — dark at bottom for text, subtle at top */}
                      {hasImg && (
                        <div style={{
                          position:'absolute', inset:0, borderRadius:'inherit',
                          background:'linear-gradient(to top, rgba(0,0,0,.88) 0%, rgba(0,0,0,.55) 45%, rgba(0,0,0,.25) 75%, rgba(0,0,0,.1) 100%)',
                          zIndex:0,
                        }}/>
                      )}
                      {/* Left colour bar — hidden when image is showing */}
                      {!hasImg && <div style={{
                        position:'absolute',left:0,top:0,bottom:0,width:4,
                        background:is86?'var(--bg5)':flagged?'var(--red)':isHot?catColor:`${catColor}60`,
                        borderRadius:'14px 0 0 14px',
                      }}/>}
                      <div style={{padding:compact?'6px 6px 5px 8px':'12px 12px 11px 16px',flex:1,display:'flex',flexDirection:'column',position:'relative',zIndex:1}}>
                        {/* Top row: emoji/icon + badges — hide emoji when image fills the space */}
                        <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:8}}>
                          {!hasImg && (
                      is86 ? <span style={{fontSize:24,lineHeight:1}}>🚫</span>
                      : flagged ? <Icon name="warn" size={23} style={{color:'var(--red)'}} />
                      : emojiToIcon(catIcon) ? <Icon name={emojiToIcon(catIcon)} size={23} stroke={1.8} style={{color:catColor}} />
                      : <span style={{fontSize:24,lineHeight:1}}>{catIcon}</span>
                    )}
                          {hasImg && <span/>}
                          <div style={{display:'flex',gap:3,flexDirection:'column',alignItems:'flex-end'}}>
                            {count&&!is86&&(
                              <span style={{fontSize:9,fontWeight:800,padding:'2px 6px',borderRadius:4,
                                background:hasImg?(isLow?'rgba(232,160,32,.85)':'rgba(34,197,94,.85)'):(isLow?'rgba(232,160,32,.2)':'rgba(34,197,94,.15)'),
                                color:hasImg?'#fff':(isLow?'var(--acc)':'var(--grn)'),
                                border:'none',
                              }}>
                                {count.remaining} left
                              </span>
                            )}
                            {isHot&&!is86&&!flagged&&!count&&(
                              <span style={{fontSize:9,fontWeight:800,padding:'2px 5px',borderRadius:4,
                                background:hasImg?'rgba(0,0,0,.5)':`${catColor}25`,
                                color:hasImg?'#fff':catColor,letterSpacing:.02,
                              }}>#{rank+1}</span>
                            )}
                            {flagged&&<span style={{fontSize:9,fontWeight:800,padding:'2px 5px',borderRadius:4,background:'var(--red)',color:'#fff'}}>⚠ allergen</span>}
                            {is86&&<span style={{fontSize:9,fontWeight:800,padding:'2px 5px',borderRadius:4,background:'var(--red-d)',color:'var(--red)',border:'1px solid var(--red-b)'}}>86'd</span>}
                          </div>
                        </div>
                        {/* Name */}
                        <div style={{
                          fontSize:13,fontWeight:700,lineHeight:1.3,flex:1,marginBottom:8,
                          color:is86?'var(--t4)':flagged?'var(--red)':hasImg?'#fff':'var(--t1)',
                          textShadow:hasImg?'0 1px 4px rgba(0,0,0,1), 0 2px 8px rgba(0,0,0,.8)':'none',
                        }}>{item.name}</div>
                        {/* Bottom: price + type badge + 86 button */}
                        <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:4}}>
                          <div style={{
                            fontSize:compact?13:18,fontWeight:800,
                            color:hasImg?'#fff':accentColor,
                            fontFamily:'var(--font-mono)',letterSpacing:'-.01em',
                            textShadow:hasImg?'0 1px 6px rgba(0,0,0,1)':'none',
                          }}>
                            {item.type==='variants'?`from ${money(fromPrice)}`:`${money(fromPrice)}`}
                          </div>
                          <div style={{display:'flex',gap:3,alignItems:'center',flexShrink:0}}>
                            {item.type!=='simple'&&<span style={{fontSize:9,fontWeight:700,padding:'2px 5px',borderRadius:5,
                              background:hasImg?'rgba(255,255,255,.2)':'var(--bg4)',
                              color:hasImg?'#fff':'var(--t3)',
                              letterSpacing:.02,
                              border:hasImg?'1px solid rgba(255,255,255,.3)':'none',
                            }}>
                              {item.type==='variants'?'▾ sizes':'⊕ opts'}
                            </span>}

                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {displayItems.length===0&&(
                <div style={{textAlign:'center',padding:'80px 0',color:'var(--t3)'}}>
                  {cat === 'quick' && (!quickScreenIds || quickScreenIds.length === 0) ? (
                    <>
                      <div style={{marginBottom:12,opacity:.4,display:'flex',justifyContent:'center',color:'var(--t3)'}}><Icon name="bolt" size={40}/></div>
                      <div style={{fontSize:15,fontWeight:700,color:'var(--t2)',marginBottom:6}}>Quick screen not configured</div>
                      <div style={{fontSize:12,color:'var(--t4)',marginBottom:4}}>Go to Back Office → Menu Manager → Quick Screen to add items</div>
                    </>
                  ) : (
                    <>
                      <div style={{marginBottom:12,opacity:.4,display:'flex',justifyContent:'center',color:'var(--t3)'}}><Icon name="search" size={40}/></div>
                      <div style={{fontSize:15,fontWeight:700,color:'var(--t2)',marginBottom:6}}>No items found</div>
                      <button onClick={()=>setSearch('')} style={{fontSize:13,color:'var(--acc)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:600}}>Clear search →</button>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Orders hub tab ── */}

        {/* ── History tab ── */}
        {rightTab==='history'&&<CheckHistory/>}

        {/* ── Deliveries (live courier board) tab ── */}
        {rightTab==='deliveries'&&<DeliveriesPanel/>}
      </div>

      {/* Modals */}
      {pendingItem&&<AllergenModal item={pendingItem} activeAllergens={allergens} onConfirm={()=>{const i=pendingItem;clearPendingItem();openFlow(i);}} onCancel={clearPendingItem}/>}
      {modalItem&&modalItem.type==='pizza'&&<ProductModal key={modalItem.id} item={modalItem} activeAllergens={allergens} onConfirm={(item,mods,cfg,opts)=>{addItem(item,mods,cfg,opts);setModalItem(null);showToast(`${opts.displayName||item.name} added`,'success');}} onCancel={()=>setModalItem(null)}/>}
      {showCheckout&&<CheckoutModal items={items} subtotal={subtotal} service={service} deliveryFee={deliveryFee} total={total} orderType={orderType} covers={covers} tableId={activeTableId} seatList={seatList} customer={customer} onClose={()=>setShowCheckout(false)} onComplete={handlePayComplete}/>}
      {showCustomerModal&&<CustomerModal orderType={pendingOrderType||orderType} existing={customer} onConfirm={c=>{setShowCustomerModal(false);setCustomer(c);if(pendingOrderType&&pendingOrderType!=='dine-in'){setOrderType(pendingOrderType);}setPendingOrderType(null);if(activeTableId){const t=tables.find(x=>x.id===activeTableId);if(t)saveTableSession(activeTableId,{...t.session,customer:c});}showToast(`${c.name} attached to order`,'success');}} onCancel={()=>{setShowCustomerModal(false);if(!customer)setOrderType('dine-in');}}/>}

      {/* Void modal */}
      {voidTarget&&(
        <VoidModal
          type={voidTarget.type}
          items={voidTarget.type==='item'?[voidTarget.item]:items.filter(i=>!i.voided)}
          totalValue={voidTarget.type==='item'?voidTarget.item.price*voidTarget.item.qty:subtotal}
          onConfirm={(opts)=>{
            if (voidTarget.type==='item') voidItem(activeTableId, voidTarget.item.uid, opts);
            else voidCheck(activeTableId, opts);
            setVoidTarget(null);
          }}
          onCancel={()=>setVoidTarget(null)}
        />
      )}

      {/* Discount modal */}
      {showDiscount&&(
        <DiscountModal
          items={items}
          subtotal={subtotal}
          onConfirm={(disc)=>{
            if (disc.scope==='check') {
              if (activeTableId) addCheckDiscount(activeTableId, disc);
              else addWalkInDiscount(disc);
            } else {
              // Item-level: apply to each selected item
              disc.itemUids?.forEach(uid => {
                const item = items.find(i=>i.uid===uid);
                if (item) addItemDiscount(activeTableId, uid, { id:`disc-${uid}`, label:disc.label, type:disc.type, value:disc.value });
              });
            }
            showToast(`${disc.label} applied`, 'success');
            setShowDiscount(false);
          }}
          onCancel={()=>setShowDiscount(false)}
        />
      )}

      {/* Receipt modal */}
      {showReceipt&&(
        <ReceiptModal
          items={items} subtotal={subtotal} service={service} total={total}
          checkDiscount={checkDiscount}
          orderType={orderType}
          tableLabel={activeTable?.label}
          server={session?.server || staff?.name}
          covers={covers}
          customer={customer}
          onClose={()=>setShowReceipt(false)}
        />
      )}

      {/* Reprint modal */}
      {showReprint&&(
        <ReprintModal
          items={items.filter(i=>i.status==='sent')}
          tableLabel={activeTable?.label || orderType}
          onClose={()=>setShowReprint(false)}
          onReprint={(uids)=>showToast(`Reprinted ${uids.length} ticket${uids.length!==1?'s':''} to kitchen`, 'success')}
        />
      )}
      {showCustom&&(
        <div className="modal-back"><div className="modal-box" style={{maxWidth:360}}>
          <div style={{fontSize:16,fontWeight:600,marginBottom:16,color:'var(--t1)'}}>Custom item</div>
          <div style={{marginBottom:12}}><label style={{display:'block',fontSize:11,color:'var(--t2)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Item name</label><input className="input" placeholder="Today's special, Staff meal…" value={customName} onChange={e=>setCustomName(e.target.value)} autoFocus/></div>
          <div style={{marginBottom:12}}><label style={{display:'block',fontSize:11,color:'var(--t2)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Price (£)</label><input className="input" type="number" placeholder="0.00" value={customPrice} onChange={e=>setCustomPrice(e.target.value)}/></div>
          <div style={{marginBottom:20}}><label style={{display:'block',fontSize:11,color:'var(--t2)',fontWeight:700,textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6}}>Kitchen note</label><input className="input" placeholder="Allergy note, special request…" value={customNote} onChange={e=>setCustomNote(e.target.value)}/></div>
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-ghost" style={{flex:1}} onClick={()=>{setShowCustom(false);setCustomName('');setCustomPrice('');setCustomNote('');}}>Cancel</button>
            <button className="btn btn-acc" style={{flex:1}} disabled={!customName.trim()||!customPrice} onClick={()=>{addCustomItem(customName.trim(),customPrice,customNote);showToast(`${customName} added`,'success');setShowCustom(false);setCustomName('');setCustomPrice('');setCustomNote('');}}>Add to order</button>
          </div>
        </div></div>
      )}

      {/* Allergen confirmation gate before checkout */}
      {showAllergenGate && (
        <AllergenCheckoutModal
          items={items}
          onConfirm={()=>{ setShowAllergenGate(false); setShowCheckout(true); }}
          onCancel={()=>setShowAllergenGate(false)}
        />
      )}

      {/* Table actions — covers edit + transfer */}
      {showTableActions && activeTable && (
        <TableActionsModal
          table={activeTable}
          onClose={()=>setShowTableActions(false)}
        />
      )}

      {/* Order type / send modal */}
      {showSendModal && (
        <OrderTypeModal
          items={items}
          onClose={() => setShowSendModal(false)}
          onComplete={(result) => {
            // Always close modals first
            setShowSendModal(false);
            setShowCheckout(false);

            // Use store directly for all actions to avoid async state timing issues
            const store = useStore.getState();

            if (result.type === 'counter') {
              store.setCustomer({ name: result.name, isASAP: true, isNamedDineIn: true, channel: 'counter' });
              store.setOrderType('dine-in');
              store.sendToKitchen();
              store.clearWalkIn();
              showToast(result.name ? `${result.name} — sent to kitchen` : 'Sent to kitchen', 'success');

            } else if (result.type === 'takeaway' || result.type === 'collection') {
              store.setCustomer({ name: result.name, phone: result.phone, collectionTime: result.time, isASAP: result.isASAP });
              store.setOrderType(result.type);
              store.sendToKitchen();
              store.clearWalkIn();
              // v5.5.799: 'Not needed' mode sends with no name — the order shows its short ref.
              showToast(result.name ? `${result.name} — ${result.type} sent` : `${result.type} sent`, 'success');

            } else if (result.type === 'delivery') {
              store.setCustomer({ name: result.name, phone: result.phone, address: result.address, isASAP: false });
              store.setOrderType('delivery');
              store.sendToKitchen();
              store.clearWalkIn();
              showToast(`Delivery for ${result.name} sent`, 'success');

            } else if (result.type === 'dine-in' && result.action === 'new') {
              // Seat items at a free table, then immediately send to kitchen
              store.seatTableWithItems(result.tableId, items, { server: store.staff?.name, covers: 1 });
              // seatTableWithItems sets the active table — send to kitchen right away
              store.sendToKitchen();
              store.clearWalkIn();
              store.setActiveTableId(null);
              setSurface('tables');
              showToast(`${result.tableLabel} — seated & sent to kitchen`, 'success');

            } else if (result.type === 'dine-in' && result.action === 'merge') {
              // Add items to an occupied table's existing check, then send to kitchen
              store.mergeItemsToTable(result.tableId, items);
              // mergeItemsToTable sets activeTableId to the target table
              store.sendToKitchen();
              store.clearWalkIn();
              store.setActiveTableId(null);
              setSurface('tables');
              showToast(`Added to ${result.tableLabel} — sent to kitchen`, 'success');

            } else if (result.type === 'dine-in' && result.action === 'split') {
              // Create a new separate check on the same table (T1.2)
              store.splitTableCheck(result.tableId, items, store.staff?.name);
              // splitTableCheck sets activeTableId to the new child — send to kitchen now
              store.sendToKitchen();
              store.clearWalkIn();
              setActiveTableId(null);
              setSurface('tables');
              showToast(`New check at ${result.tableLabel} — sent to kitchen`, 'success');

            } else if (result.type === 'bar' && result.action === 'new') {
              const tab = store.openTab({ name: result.tabName });
              store.addRoundToTab(tab.id, items);
              store.setCustomer({ name: result.tabName });
              store.setOrderType('dine-in');
              store.sendToKitchen();
              store.clearWalkIn();
              setSurface('bar');
              showToast(`Bar tab "${result.tabName}" opened`, 'success');

            } else if (result.type === 'bar' && result.action === 'add') {
              const addRes = store.addRoundToTab(result.tabId, items);
              if (addRes && addRes.ok === false) {
                // Over the tab's card hold — keep the order on the POS so staff can cash off or trim it.
                // addRoundToTab already showed the explanatory toast.
              } else {
                store.setCustomer({ name: result.tabName });
                store.setOrderType('dine-in');
                store.sendToKitchen();
                store.clearWalkIn();
                setSurface('bar');
                showToast(`Added to "${result.tabName}"`, 'success');
              }
            }
          }}
        />
      )}

      {/* Item info modal — long press */}
      {infoItem&&(
        <ItemInfoModal
          item={infoItem}
          is86={eightySixIds.includes(infoItem.id)}
          onToggle86={()=>{
            // v5.5.825: say so when the un-86 also cleared an exhausted count, so
            // staff know the item is now untracked and a new count is needed.
            const _was86 = eightySixIds.includes(infoItem.id);
            const _dc = dailyCounts?.[infoItem.id];
            const _clearedCount = _was86 && _dc && typeof _dc.remaining === 'number' && _dc.remaining <= 0;
            toggle86(infoItem.id);
            showToast(
              _was86
                ? `${infoItem.name} un-86'd${_clearedCount ? ' — count cleared, set a new count to track it again' : ''}`
                : `${infoItem.name} 86'd`,
              'warning');
          }}
          onClose={()=>setInfoItem(null)}
          onAddToOrder={()=>{ setInfoItem(null); handleItemTap(infoItem); }}
        />
      )}

      {/* Order review modal */}
      {showReview&&(
        <OrderReviewModal
          items={items}
          subtotal={subtotal}
          service={service}
          total={total}
          checkDiscount={checkDiscount}
          orderType={orderType}
          tableLabel={activeTable?.label}
          server={session?.server||staff?.name}
          covers={covers}
          customer={customer}
          onClose={()=>setShowReview(false)}
          onCheckout={()=>{ setShowReview(false); if(items.length>0) setShowCheckout(true); }}
          onPrint={()=>{ setShowReview(false); setShowReceipt(true); }}
        />
      )}
    </div>
  );
}

function OrderItem({
  item, covers, orderType, seatList, onQty, onRemove, onNote, onSeat, onCourse, onVoid, onDiscount, onRemoveDiscount, namesOnly=false, flash=false }) {
  const compact = useCompact();
  const [showMenu, setShowMenu] = useState(false);
  const [editNote, setEditNote] = useState(false);
  const [noteVal, setNoteVal]   = useState(item.notes||'');

  const isCommitted = item.status === 'sent';
  const isVoided    = item.voided || item.status === 'voided';

  const discountedPrice = item.discount
    ? (item.discount.type==='percent'
        ? item.price * (1 - item.discount.value/100)
        : Math.max(0, item.price - item.discount.value/item.qty))
    : item.price;
  const lineTotal = discountedPrice * item.qty;

  if (namesOnly) {
    const price = item.price * item.qty;
    return (
      <div data-line-uid={item.uid} className={flash?'line-flash':undefined} style={{display:'flex',justifyContent:'space-between',alignItems:'center',
        padding:'4px 10px',borderBottom:'1px solid var(--bdr)',gap:8,
        opacity:isVoided?0.4:1}}>
        <span style={{fontSize:11,color:'var(--t1)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}}>
          {item.qty>1&&<span style={{fontWeight:800,color:'var(--acc)',marginRight:4}}>{item.qty}×</span>}
          {item.menuName||item.name}
          {item.variantName&&<span style={{color:'var(--t4)'}}> · {item.variantName}</span>}
          {isVoided&&<span style={{color:'var(--red)',marginLeft:4,fontSize:9}}>VOID</span>}
        </span>
        <span style={{fontSize:11,fontWeight:700,color:'var(--t2)',fontFamily:'var(--font-mono)',flexShrink:0}}>
          {money(price)}
        </span>
      </div>
    );
  }

  return (
    <div data-line-uid={item.uid} className={flash?'line-flash':undefined} style={{
      background: isVoided ? 'rgba(239,68,68,.04)' : isCommitted ? 'var(--bg2)' : 'var(--bg2)',
      border:`1.5px solid ${isVoided?'var(--red-b)':isCommitted?'rgba(34,197,94,.2)':'var(--bdr)'}`,
      borderRadius:12,
      marginBottom:5,
      opacity: isVoided ? .55 : 1,
      overflow:'hidden',
      position:'relative',
    }}>
      {/* Left status bar */}
      <div style={{
        position:'absolute',left:0,top:0,bottom:0,width:3,
        background:isVoided?'var(--red)':isCommitted?'var(--grn)':'var(--bg5)',
        borderRadius:'12px 0 0 12px',
      }}/>

      <div style={{padding:compact?'6px 8px 6px 10px':'9px 10px 9px 14px'}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'flex-start'}}>
          <div style={{flex:1}}>
            <div style={{
              fontSize:13, fontWeight:700, lineHeight:1.3,
              color: isVoided ? 'var(--red)' : 'var(--t1)',
              textDecoration: isVoided ? 'line-through' : 'none',
              display:'flex',alignItems:'center',gap:6,
            }}>
              {item.name}
              {isVoided && <span style={{fontSize:9,fontWeight:800,padding:'1px 5px',borderRadius:4,background:'var(--red-d)',color:'var(--red)',letterSpacing:.04}}>VOIDED</span>}
            </div>
            {item.mods?.filter(m => !m._instruction).map((m,i)=>(
              <div key={i} style={{fontSize:11,color:'var(--t3)',marginTop:1,display:'flex',justifyContent:'space-between'}}>
                <span>{m.label}</span>
                {m.price>0&&<span style={{color:'var(--acc)',fontFamily:'var(--font-mono)'}}>+{money(m.price)}</span>}
              </div>
            ))}
            {item.mods?.filter(m => m._instruction).map((m,i)=>(
              <div key={`inst-${i}`} style={{fontSize:11,color:'var(--t3)',marginTop:1,fontStyle:'italic'}}>
                {m.label}
              </div>
            ))}
            {item.notes && (
              <div style={{fontSize:11,color:'var(--t3)',marginTop:1,fontStyle:'italic'}}><Icon name="note" size={11} style={{display:'inline-block',verticalAlign:'-2px',marginRight:4}}/>{item.notes}</div>
            )}

            {/* Item discount */}
            {item.discount && !isVoided && (
              <div style={{display:'flex',alignItems:'center',gap:5,marginTop:3}}>
                <span style={{fontSize:11,color:'var(--grn)',fontWeight:600,display:'inline-flex',alignItems:'center',gap:4}}><Icon name="tag" size={11}/>{item.discount.label}</span>
                <span style={{fontSize:11,color:'var(--grn)',fontFamily:'var(--font-mono)'}}>−{money((item.price*item.qty - lineTotal))}</span>
                <button onClick={onRemoveDiscount} style={{fontSize:11,color:'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',lineHeight:1}}>✕</button>
              </div>
            )}

            {/* Inline note editor */}
            {!isVoided && (editNote ? (
              <div style={{marginTop:6}}>
                <input autoFocus value={noteVal} onChange={e=>setNoteVal(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'){onNote(noteVal);setEditNote(false);}if(e.key==='Escape'){setNoteVal(item.notes||'');setEditNote(false);}}}
                  placeholder="No ice, well done, allergy note…"
                  style={{width:'100%',background:'var(--bg4)',border:'1.5px solid var(--acc-b)',borderRadius:7,padding:'5px 9px',color:'var(--t1)',fontSize:12,fontFamily:'inherit',outline:'none'}}/>
                <div style={{display:'flex',gap:5,marginTop:4}}>
                  <button onClick={()=>{onNote(noteVal);setEditNote(false);}} style={{flex:1,height:26,borderRadius:6,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0b0c10',fontSize:11,fontWeight:800}}>Save</button>
                  <button onClick={()=>{setNoteVal(item.notes||'');setEditNote(false);}} style={{flex:1,height:26,borderRadius:6,cursor:'pointer',fontFamily:'inherit',background:'var(--bg4)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11}}>Cancel</button>
                </div>
              </div>
            ) : (
              <div onClick={()=>{setNoteVal(item.notes||'');setEditNote(true);}} style={{marginTop:5,padding:'4px 8px',borderRadius:7,cursor:'pointer',border:`1px dashed ${item.notes?'rgba(249,115,22,.4)':'var(--bdr)'}`,fontSize:11,display:'flex',alignItems:'center',gap:5,color:item.notes?'#f97316':'var(--t4)',transition:'all .12s'}}>
                <Icon name="note" size={12} />
                <span style={{fontStyle:item.notes?'italic':'normal'}}>{item.notes||'Add note…'}</span>
              </div>
            ))}

            {item.allergens?.length>0&&!isVoided&&(
              <div style={{fontSize:10,color:'var(--red)',marginTop:3,fontWeight:600,display:'flex',alignItems:'center',gap:4}}><Icon name="warn" size={11}/>{item.allergens.map(a=>ALLERGENS.find(x=>x.id===a)?.label).filter(Boolean).join(' · ')}</div>
            )}

            {/* Tags row */}
            {!isVoided && (
              <div style={{display:'flex',gap:4,marginTop:6,flexWrap:'wrap'}}>
                {orderType==='dine-in'&&covers>1&&(
                  <button onClick={()=>setShowMenu(s=>!s)} style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:5,background:'var(--acc-d)',border:'1px solid var(--acc-b)',color:'var(--acc)',cursor:'pointer',fontFamily:'inherit'}}>
                    {item.seat==='shared'?'Shared':`Seat ${item.seat}`}
                  </button>
                )}
                {!isCommitted && (
                  <button onClick={()=>setShowMenu(s=>!s)} style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:5,background:COURSE_COLORS[item.course]?.bg||'var(--bg3)',border:`1px solid ${(COURSE_COLORS[item.course]?.color||'var(--t3)')+'44'}`,color:COURSE_COLORS[item.course]?.color||'var(--t3)',cursor:'pointer',fontFamily:'inherit'}}>
                    {COURSE_COLORS[item.course]?.label || 'Course 1'}
                  </button>
                )}
                {isCommitted&&<span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:5,background:'var(--grn-d)',border:'1px solid var(--grn-b)',color:'var(--grn)'}}>✓ Sent</span>}
              </div>
            )}
          </div>

          {/* Price column */}
          <div style={{textAlign:'right',flexShrink:0}}>
            <div style={{fontSize:15,fontWeight:800,color:isVoided?'var(--red)':item.discount?'var(--grn)':'var(--t1)',fontFamily:'var(--font-mono)',textDecoration:isVoided?'line-through':'none'}}>
              {money(lineTotal)}
            </div>
            {item.discount&&!isVoided&&<div style={{fontSize:10,color:'var(--t4)',textDecoration:'line-through',fontFamily:'var(--font-mono)'}}>{money((item.price*item.qty))}</div>}
            {item.qty>1&&!item.discount&&!isVoided&&<div style={{fontSize:10,color:'var(--t4)',fontFamily:'var(--font-mono)'}}>{money(item.price)} ea</div>}
          </div>
        </div>

        {/* Seat/course drawer */}
        {showMenu&&!isVoided&&(
          <div style={{marginTop:8,padding:'10px',background:'var(--bg3)',borderRadius:10,border:'1px solid var(--bdr)'}}>
            {orderType==='dine-in'&&covers>1&&(
              <div style={{marginBottom:10}}>
                <div style={{fontSize:9,fontWeight:800,color:'var(--t4)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6}}>Move to seat</div>
                <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                  {seatList.map(s=>(
                    <button key={s} onClick={()=>{onSeat(s);setShowMenu(false);}} style={{padding:'4px 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:11,fontWeight:700,background:item.seat===s?'var(--acc-d)':'var(--bg4)',border:`1.5px solid ${item.seat===s?'var(--acc)':'var(--bdr)'}`,color:item.seat===s?'var(--acc)':'var(--t3)'}}>
                      {s==='shared'?'Shared':`S${s}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div style={{fontSize:9,fontWeight:800,color:'var(--t4)',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:6}}>Move to course</div>
              <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                {Object.entries(COURSE_COLORS).map(([c,cc])=>(
                  <button key={c} onClick={()=>{onCourse(parseInt(c));setShowMenu(false);}} style={{padding:'4px 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:11,fontWeight:700,background:item.course===parseInt(c)?cc.bg:'var(--bg4)',border:`1.5px solid ${item.course===parseInt(c)?cc.color:'var(--bdr)'}`,color:item.course===parseInt(c)?cc.color:'var(--t3)'}}>
                    {cc.label}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={()=>setShowMenu(false)} style={{marginTop:8,fontSize:11,color:'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:600}}>Done</button>
          </div>
        )}

        {/* Bottom controls */}
        {!isVoided && (
          <div style={{display:'flex',alignItems:'center',gap:8,marginTop:8}}>
            {/* Qty stepper — bigger touch targets */}
            <div style={{display:'flex',alignItems:'center',background:'var(--bg3)',border:'1px solid var(--bdr)',borderRadius:9,overflow:'hidden'}}>
              <button onClick={()=>onQty(-1)} style={{width:30,height:28,background:'transparent',border:'none',color:'var(--t2)',fontSize:16,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',transition:'background .1s'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg4)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>−</button>
              <div style={{width:28,height:28,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:800,color:'var(--t1)',fontFamily:'var(--font-mono)'}}>{item.qty}</div>
              <button onClick={()=>onQty(1)} style={{width:30,height:28,background:'transparent',border:'none',color:'var(--t2)',fontSize:16,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',transition:'background .1s'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg4)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>+</button>
            </div>

            <div style={{marginLeft:'auto',display:'flex',gap:6}}>
              {/* Pending: Remove. Committed: Void (requires PIN) */}
              {isCommitted ? (
                <button onClick={onVoid} style={{height:28,padding:'0 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:11,fontWeight:700,background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)'}}>Void</button>
              ) : (
                <button onClick={onRemove} style={{height:28,padding:'0 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:11,fontWeight:700,background:'var(--bg4)',border:'1px solid var(--bdr)',color:'var(--t3)'}}>Remove</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline Orders Hub ─────────────────────────────────────────────────────────
const ORDER_STATUS = {
  received: { label:'Received',  color:'#3b82f6', bg:'rgba(59,130,246,.1)',  next:'Start prep',  icon:'📥' },
  prep:     { label:'In prep',   color:'#f97316', bg:'rgba(249,115,22,.1)',   next:'Mark ready',  icon:'👨‍🍳' },
  ready:    { label:'Ready',     color:'#22c55e', bg:'rgba(34,197,94,.1)',    next:'Collected',   icon:'✅' },
  collected:{ label:'Collected', color:'#5c5a64', bg:'rgba(92,90,100,.1)',    next:null,          icon:'👋' },
};

function OrdersHub({ orderQueue, updateQueueStatus, removeFromQueue, showToast }) {
  const [filter, setFilter] = useState('active');
  const now = new Date();
  // v5.5.134: manual re-send button needs the routing function from the store.
  const routeKioskOrderPrints = useStore(s => s.routeKioskOrderPrints);

  const resendToKitchen = (order) => {
    // Fire the same path the realtime handler fires — but on demand. The
    // routing function emits on-screen toasts at every decision point so
    // the operator can see exactly what's happening (no DevTools needed).
    routeKioskOrderPrints?.({
      ref: order.ref,
      source: order.source || 'pos',
      tableLabel: order.customer?.tableLabel || null,
      items: order.items || [],
      customer: order.customer || null,
      sentAt: order.sentAt || Date.now(),
    });
  };

  const filtered = [...(orderQueue||[])].filter(o =>
    filter==='active' ? o.status!=='collected' :
    filter==='collected' ? o.status==='collected' : true
  );

  const counts = {
    received: orderQueue.filter(o=>o.status==='received').length,
    prep:     orderQueue.filter(o=>o.status==='prep').length,
    ready:    orderQueue.filter(o=>o.status==='ready').length,
  };

  const advance = (o) => {
    const flow = ['received','prep','ready','collected'];
    const idx = flow.indexOf(o.status);
    if (idx < flow.length-1) {
      const next = flow[idx+1];
      updateQueueStatus(o.ref, next);
      if (next==='ready') showToast(`${o.ref} ready for ${o.customer?.name}`, 'success');
      else if (next==='collected') { showToast(`${o.ref} collected`, 'info'); setTimeout(()=>removeFromQueue(o.ref), 5000); }
      else showToast(`${o.ref} in prep`, 'info');
    }
  };

  return (
    <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
      {/* Summary pills */}
      <div style={{padding:'10px 14px',borderBottom:'1px solid var(--bdr)',background:'var(--bg1)',flexShrink:0}}>
        <div style={{display:'flex',gap:6,marginBottom:10,flexWrap:'wrap'}}>
          {Object.entries(ORDER_STATUS).filter(([k])=>k!=='collected').map(([s,m])=>(
            <div key={s} style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:20,background:m.bg,border:`1px solid ${m.color}44`}}>
              <span style={{fontSize:13}}>{m.icon}</span>
              <span style={{fontSize:11,fontWeight:600,color:m.color}}>{m.label}</span>
              <span style={{fontSize:13,fontWeight:800,color:m.color}}>{counts[s]||0}</span>
            </div>
          ))}
        </div>
        <div style={{display:'flex',gap:4}}>
          {[['active','Active'],['collected','Completed'],['all','All']].map(([f,l])=>(
            <button key={f} onClick={()=>setFilter(f)} style={{padding:'4px 12px',borderRadius:20,cursor:'pointer',fontFamily:'inherit',background:filter===f?'var(--acc-d)':'transparent',border:`1px solid ${filter===f?'var(--acc-b)':'var(--bdr)'}`,color:filter===f?'var(--acc)':'var(--t3)',fontSize:12,fontWeight:600}}>{l}</button>
          ))}
        </div>
      </div>

      {/* Orders list */}
      <div style={{flex:1,overflowY:'auto',padding:'10px 14px'}}>
        {filtered.length===0&&(
          <div style={{textAlign:'center',padding:'60px 0',color:'var(--t3)'}}>
            <div style={{fontSize:40,marginBottom:12,opacity:.4}}>📦</div>
            <div style={{fontSize:14,fontWeight:600,color:'var(--t2)',marginBottom:6}}>No orders</div>
            <div style={{fontSize:12,lineHeight:1.6}}>Takeaway and collection orders appear here after Send</div>
          </div>
        )}
        {filtered.map(order=>{
          const sm = ORDER_STATUS[order.status] || ORDER_STATUS.received;
          const isOverdue = order.status!=='collected' && !order.isASAP && order.collectionTime && false; // placeholder
          return (
            <div key={order.ref} style={{background:'var(--bg2)',border:'1px solid var(--bdr)',borderRadius:12,marginBottom:10,overflow:'hidden',opacity:order.status==='collected'?.55:1}}>
              {/* Header */}
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderBottom:'1px solid var(--bdr)'}}>
                <span style={{fontSize:18}}>{order.type==='collection'?'📦':'🥡'}</span>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'baseline',gap:8}}>
                    <span style={{fontSize:13,fontWeight:800,color:'var(--t1)',fontFamily:'DM Mono,monospace'}}>{order.ref}</span>
                    <span style={{fontSize:13,fontWeight:600,color:'var(--t2)'}}>{order.customer?.name}</span>
                  </div>
                  <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>{order.customer?.phone}</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <div style={{fontSize:13,fontWeight:700,color:'var(--acc)',fontFamily:'DM Mono,monospace'}}>{money((order.total||0))}</div>
                  <div style={{fontSize:10,color:'var(--t3)',textTransform:'capitalize'}}>{order.type}</div>
                </div>
              </div>

              {/* Body */}
              <div style={{padding:'8px 12px',display:'flex',alignItems:'flex-start',gap:10}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,flexWrap:'wrap'}}>
                    <span style={{fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:20,background:sm.bg,color:sm.color}}>{sm.icon} {sm.label}</span>
                    {order.type==='collection'&&(
                      <span style={{fontSize:12,fontWeight:700,color:order.isASAP?'var(--acc)':'var(--t2)'}}>
                        {order.isASAP ? '⚡ ASAP' : `🕐 ${order.collectionTime||'—'}`}
                      </span>
                    )}
                    <span style={{fontSize:10,color:'var(--t4)'}}>by {order.staff}</span>
                  </div>
                  <div style={{fontSize:11,color:'var(--t3)',lineHeight:1.6}}>
                    {(order.items||[]).slice(0,4).map((i,idx)=>(
                      <span key={idx}>{i.qty>1?`${i.qty}× `:''}{i.name}{idx<Math.min((order.items||[]).length,4)-1?', ':''}</span>
                    ))}
                    {(order.items||[]).length>4&&<span style={{color:'var(--t4)'}}> +{(order.items||[]).length-4} more</span>}
                  </div>
                  {order.customer?.notes&&<div style={{fontSize:11,color:'#f97316',marginTop:4,fontStyle:'italic'}}>📝 {order.customer.notes}</div>}
                </div>
                {sm.next&&(
                  <button onClick={()=>advance(order)} style={{padding:'7px 14px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',fontSize:12,fontWeight:700,background:order.status==='prep'?'var(--grn-d)':'var(--bg3)',border:`1px solid ${order.status==='prep'?'var(--grn-b)':'var(--bdr2)'}`,color:order.status==='prep'?'var(--grn)':'var(--t2)'}}>
                    {sm.next} →
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      
{/* v4.6.49: role-aware sign-in gate. When the POS has a drawer bound
          and it's not in a usable state (idle/closed), lock the whole POS.
          Manager/Admin or staff with cashup permission → shown the cash-in
          modal. Other roles → shown a read-only "ask a manager" screen
          that can't be dismissed without signing out. No drawer bound =
          no gate (POS trades card-only). */}
      {_myDrw && _myDrw.status !== 'open' && _myDrw.status !== 'counting' && staff && !showCashIn && (
        _canCashup || staff?.role === 'Manager' || staff?.role === 'Admin' ? (
          <DrawerCashModal
            mode="in"
            drawer={_myDrw}
            locked={true}
            onComplete={async ({ amount, denominations }) => {
              await cashInDrawer?.(_myDrw.id, { openingFloat: amount, denominations });
              await loadCurrentDrawerSession?.();
              if (typeof useStore.getState().loadCashDrawers === 'function') await useStore.getState().loadCashDrawers();
            }}
          />
        ) : (
          <div className="modal-back" style={{ zIndex:9999 }}>
            <div style={{
              background:'var(--bg1)', border:'1.5px solid var(--bdr2)', borderRadius:20,
              padding:'32px 28px', maxWidth:440, textAlign:'center',
              boxShadow:'var(--sh3)',
            }}>
              <div style={{ fontSize:42, marginBottom:14 }}>&#128274;</div>
              <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>POS locked</div>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:6, lineHeight:1.5 }}>
                <b>{_myDrw.name}</b> needs to be cashed in before this POS can trade.
              </div>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:22, lineHeight:1.5 }}>
                Ask a manager to cash in the drawer, or sign out and let them sign in.
              </div>
              <button
                onClick={() => { try { useStore.getState().logout?.(); } catch {} }}
                style={{ padding:'10px 24px', borderRadius:10, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontFamily:'inherit', fontWeight:700, fontSize:13, cursor:'pointer' }}>
                Sign out
              </button>
            </div>
          </div>
        )
      )}
      {/* Explicit cash-in flow from the drawer menu (always dismissable). */}
      {showCashIn && _myDrw && (
        <DrawerCashModal
          mode="in"
          drawer={_myDrw}
          locked={false}
          onClose={() => setShowCashIn(false)}
          onComplete={async ({ amount, denominations }) => {
            await cashInDrawer?.(_myDrw.id, { openingFloat: amount, denominations });
            await loadCurrentDrawerSession?.();
            if (typeof useStore.getState().loadCashDrawers === 'function') await useStore.getState().loadCashDrawers();
            setShowCashIn(false);
          }}
        />
      )}

      {/* v4.6.40: drawer action sheet — opens from the 🔓 Drawer button */}
      {showDrawerMenu && _myDrw && (
        <div className="modal-back" onClick={e => e.target === e.currentTarget && setShowDrawerMenu(false)}>
          <div style={{
            background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20,
            width:'100%', maxWidth:380, padding:'18px 20px', boxShadow:'var(--sh3)',
          }}>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>{_myDrw.name}</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:16 }}>
              Status: <b style={{color: _myDrw.status === 'open' ? 'var(--grn)' : 'var(--t3)'}}>{_myDrw.status || 'idle'}</b>
              {' · '}Float: <b style={{color:'var(--t1)', fontFamily:'var(--font-mono)'}}>{money(Number(_myDrw.currentFloat || 0))}</b>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {/* v4.6.48: status-aware actions */}
              {(!_myDrw.status || _myDrw.status === 'idle') && (
                <button
                  onClick={() => { setShowDrawerMenu(false); setShowCashIn(true); }}
                  style={{ padding:'12px 14px', borderRadius:10, border:'1px solid var(--grn-b)', background:'var(--grn-d)', color:'var(--grn)', fontFamily:'inherit', fontWeight:700, fontSize:13, cursor:'pointer', textAlign:'left' }}>
                  Cash in drawer
                  <div style={{ fontSize:11, color:'var(--grn)', fontWeight:500, marginTop:2, opacity:.8 }}>Declare opening float. Drawer opens for trading.</div>
                </button>
              )}
              {_myDrw.status === 'open' && (
                <>
                  <button
                    onClick={() => { setShowDrawerMenu(false); openCashDrawer?.({ type:'drawer_open', reason:'Manual open (POS)', amount:0 }); }}
                    style={{ padding:'12px 14px', borderRadius:10, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t1)', fontFamily:'inherit', fontWeight:700, fontSize:13, cursor:'pointer', textAlign:'left' }}>
                    Open drawer (pulse)
                    <div style={{ fontSize:11, color:'var(--t3)', fontWeight:500, marginTop:2 }}>Pops the drawer open. Logged as a drawer_open event.</div>
                  </button>
                  <button
                    onClick={async () => {
                      if (!_canCashup) { useStore.getState().showToast?.('Cashup permission required', 'error'); return; }
                      setShowDrawerMenu(false);
                      const exp = typeof computeExpectedCash === 'function' ? await computeExpectedCash(_myDrw.id) : 0;
                      setExpectedForCashOut(exp);
                      setShowCashOut(true);
                    }}
                    disabled={!_canCashup}
                    style={{ padding:'12px 14px', borderRadius:10, border:'1px solid var(--red-b)', background: _canCashup ? 'var(--red-d)' : 'var(--bg3)', color: _canCashup ? 'var(--red)' : 'var(--t4)', fontFamily:'inherit', fontWeight:700, fontSize:13, cursor: _canCashup ? 'pointer' : 'not-allowed', textAlign:'left' }}>
                    Cash up drawer
                    <div style={{ fontSize:11, color: _canCashup ? 'var(--red)' : 'var(--t4)', fontWeight:500, marginTop:2, opacity:.8 }}>
                      {_canCashup ? 'Count cash, declare variance, close this drawer.' : 'Manager / cashup permission required.'}
                    </div>
                  </button>
                </>
              )}
              {_myDrw.status === 'counting' && (
                <div style={{ padding:'12px 14px', borderRadius:10, background:'rgba(232,160,32,.12)', border:'1px solid var(--amb,#e8a020)', color:'var(--amb,#e8a020)', fontSize:13, fontWeight:600 }}>
                  Cash-up in progress. Finish the count from Back Office &rarr; Cash drawers.
                </div>
              )}
            </div>
            <button onClick={() => setShowDrawerMenu(false)}
              style={{ marginTop:14, width:'100%', padding:'9px', borderRadius:8, background:'transparent', border:'1px solid var(--bdr)', color:'var(--t3)', fontFamily:'inherit', fontWeight:600, fontSize:12, cursor:'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* v4.6.40: cash-out flow */}
      {showCashOut && _myDrw && (
        <DrawerCashModal
          mode="out"
          drawer={_myDrw}
          expectedCash={expectedForCashOut}
          onClose={() => setShowCashOut(false)}
          onComplete={async ({ amount, denominations, notes }) => {
            await cashOutDrawer?.(_myDrw.id, { declaredCash: amount, denominations, notes });
            setShowCashOut(false);
            // v5.5.190: after cash-up, log the user out so the POS returns to
            // the PINScreen. The next person logging in will see the drawer-idle
            // blocker — non-managers get a "POS locked" message, managers get
            // the cash-in denomination screen to open the next trading day.
            try { useStore.getState().logout?.(); } catch {}
          }}
        />
      )}
    </div>


  );
}

// v5.5.163 — small host component that subscribes to challenge21Prompt state
// and renders the modal when .open is true. Loads config on mount so the
// trigger has something to compare against when a sale closes.
function Challenge21PromptHost() {
  const prompt = useStore(s => s.challenge21Prompt);
  const dismiss = useStore(s => s.dismissChallenge21Prompt);
  const loadCfg = useStore(s => s.loadChallenge21Config);
  useEffect(() => { loadCfg?.(); /* eslint-disable-next-line */ }, []);
  if (!prompt?.open) return null;
  return (
    <Challenge21Modal
      open={true}
      locationId={prompt.locationId}
      opsLocationId={prompt.opsLocationId}
      triggerCount={prompt.triggerCount}
      onClose={() => dismiss?.(true)}
    />
  );
}
