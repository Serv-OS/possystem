import { create } from 'zustand';
import { supabase, platformSupabase, isMock, getLocationId, ensureAuthToken, getActiveLocationSync } from '../lib/supabase';
import { calculateOrderTax } from '../lib/tax';
import { resolveServiceCharge } from '../lib/serviceCharge';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../lib/discountEngine';
import { buildScheduleCtx } from '../lib/locationTime';
import { computeCheckTotals } from '../lib/payments/checkTotals';
import { operatorSwitchPatch, logoutPatch } from '../lib/cartHold';
import { kitchenOverride, receiptOverride } from '../lib/itemDisplay';
import { normaliseMenuRow } from '../lib/rowMapping';
import { upsertMenuItem, upsertFloorTable, deleteFloorTable, insertKDSTicket, insertClosedCheck, upsertClosedCheck, toggle86DB, getNextOrderRefLocal, updateClosedCheckRefunds, upsertStockLevel, deleteStockLevel, decrementStockRPC, restoreStockRPC, upsertModifierGroup, deleteModifierGroup } from '../lib/db';
import { isSessionClosed } from '../sync/sessionClosure';
import { markJobReconciled, closeTerminalSession, recallJob, forgetJob, cancelTerminalJob, buildCheckKey, fetchJob, fetchJobCapture } from '../lib/payments/terminalJobs';
import { printService } from '../lib/printer';
import { hubrisePushStock, isHubriseConnected, hubrisePushStatus, isHubriseAutoReceipt } from '../lib/hubrise';
import { buildChannelCloseFields } from '../lib/channelMoney';
import { logActivity } from '../lib/activity';
import { depleteForSale, reverseForSale } from '../lib/stock/deplete';
import { setTrainingMode as applyTrainingFlag, isTrainingMode } from '../lib/trainingMode';
import { getDeliveryQuote, recordDeliverySurcharge } from '../lib/delivery/quoteService';
import { dispatchDelivery, sendDeliveryTrackingSMS } from '../lib/delivery/dispatch';
import { STALE_ORDER_FLOOR_MS } from '../sync/staleness';
import { giftRecordFrom, giftLegs, reverseGiftCard } from '../lib/giftCommit';
// v5.6.79 (#107/#108) — refund money maths + the per-leg processor router.
import {
  refundBreakdown, cardLegsOf, legRefundedMinor, allocateToLegs,
  rollUpLegStatus, retryableLegs, r2, toMinor as toMinorAmt,
} from '../lib/payments/refundMath';
import { reverseCardLeg } from '../lib/payments/cardReversal';
import { commitRedemption } from '../lib/commitRedemptions';
import { waitlistSlice } from './waitlistSlice';
import { bookingsSlice } from './bookingsSlice';
import { reportSave } from '../lib/saveHealth';
import { bumpChallenge21 } from '../lib/challenge21Counter';

// v5.5.944: terminal jobs whose closed_check upsert failed and were flagged to the
// activity feed — once per job per boot, so the 8s retry loop doesn't spam the feed.
const _closeFailFlagged = new Set();

// ── Closed-check ceiling (v5.6.83) ───────────────────────────────────────────
// closedChecks was prepend-only and never trimmed — printJobs has been capped at 50
// for ages, this one never was. A till left running for days grew the array without
// limit, and until v5.6.83 every entry was also being re-serialised into localStorage
// on every order change.
//
// 2000 is deliberately set ABOVE the largest deliberate read in the app (MPOS order
// history asks for 2000 on its "All" range; every other path asks for 500). So the
// cap can only ever trim runaway growth and can never silently truncate history an
// operator has just asked to see.
export const MAX_CLOSED_CHECKS = 2000;
export const capClosedChecks = (list) =>
  list.length > MAX_CLOSED_CHECKS ? list.slice(0, MAX_CLOSED_CHECKS) : list;

// ── Auto-print age gate ──────────────────────────────────────────────────────
// An order that has been sitting around for hours must never produce a receipt
// just because a screen opened. (Three tabs opening Back Office re-printed two
// orders from 22 July — six receipts in 0.6s.) The clock that decides is the
// ORDER's own created_at, never this device's boot/read time.
//
// 6h: comfortably longer than any legitimate placed-to-printed lag inside one
// service — a channel order still unprinted 6h after it was placed is not being
// cooked — and far short of the ~24h back to the same point in yesterday's
// service.
const AUTO_PRINT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// True when <order> is too old to print WITHOUT a human asking for it. Fails
// OPEN in every uncertain case (no created_at, unparseable, clock skew putting
// it in the future): an extra receipt is an annoyance, a missing one is not.
const tooOldToAutoPrint = (order, label) => {
  const raw = order?.createdAt ?? order?.created_at;
  if (raw == null) return false;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  const ageMs = Date.now() - ms;
  if (ageMs <= AUTO_PRINT_MAX_AGE_MS) return false;
  console.warn(`[${label}] auto-print BLOCKED — ${order?.ref || '(no ref)'} was created ${(ageMs / 3_600_000).toFixed(1)}h ago (limit ${AUTO_PRINT_MAX_AGE_MS / 3_600_000}h). Print it from Orders if that was intended.`);
  return true;
};

// ── Payment-intent normaliser ────────────────────────────────────────────────
// v5.5.323: a check can have MULTIPLE card PaymentIntents — one per card portion
// of a split. Collapse whatever the checkout flow handed us into a single array
// [{ id, amountMinor }] stored on the closed check, so refundCheck can refund
// every card leg back to its own card. Falls back to the legacy single-id field
// (single-card POS flow) so that path is byte-for-byte unchanged.
// v5.5.719: persist the card-scheme receipt block on the payment leg it belongs to (single-card
// payments → the only leg). payment_intents is jsonb, so the card object rides into closed_checks
// with no migration and re-prints/emails from history can render it.
function attachCardToIntents(intents, cardReceipt) {
  if (!cardReceipt) return intents;
  if (!intents || !intents.length) return intents;
  return [{ ...intents[0], card: cardReceipt }, ...intents.slice(1)];
}

// v5.7.5 - TIP ON PRINTED RECEIPT. Stamp the open capture window onto the card
// leg it belongs to (slot 0 - ALWAYS the till's own leg: single-card sales have
// one leg, and on a reader split the till's final leg deliberately keeps slot 0,
// which is also the only leg that can be a manual-capture auth). The server's
// applyTipToClosedCheck matches this leg back by captureId, then psp, then the
// single-leg fallback, and moves the flag pending → adjusting/capturing →
// captured | failed as the money actually moves. Legs without a window are
// untouched - every other sale keeps its exact prior shape.
const CAPTURE_LEG_STATES = ['pending', 'adjusting', 'capturing', 'captured', 'failed', 'expired', 'cancelled'];
// v5.7.8 - History capture-window self-heal. Check ids whose capture status has
// already been looked up this session (hit or miss), so opening the same check
// twice never re-fires the read. Module-level on purpose: survives store updates,
// dies with the tab, exactly the "once per check per session" contract.
const _captureStatusChecked = new Set();
function attachCaptureToIntents(intents, capture) {
  if (!capture) return intents;
  const legPatch = {
    capture: CAPTURE_LEG_STATES.includes(capture.status) ? capture.status : 'pending',
    ...(capture.id ? { captureId: capture.id } : {}),
    ...(capture.psp_reference ? { capturePsp: capture.psp_reference } : {}),
    ...(capture.deadline_at ? { captureDeadline: capture.deadline_at } : {}),
    ...(Number.isFinite(Number(capture.auth_minor)) ? { captureAuthMinor: Number(capture.auth_minor) } : {}),
  };
  if (!intents || !intents.length) {
    // An approved settle can carry no pspReference at all (leg id null) - an
    // open window must still be visible in History, so mint an amount-only leg.
    return [{ id: null, amountMinor: legPatch.captureAuthMinor ?? null, ...legPatch }];
  }
  return [{ ...intents[0], ...legPatch }, ...intents.slice(1)];
}

function derivePaymentIntents(paymentInfo = {}) {
  const list = Array.isArray(paymentInfo.paymentIntents) ? paymentInfo.paymentIntents : null;
  if (list && list.length) {
    // v5.6.70: keep a leg that has a real AMOUNT but no processor id (an approved
    // settle can carry no pspReference) — dropping it silently made the intents
    // stop summing to the check total and shifted position 0, which is the slot
    // attachCardToIntents stamps the card onto. Also carries any per-leg card
    // block through (reader splits snapshot one per leg).
    const clean = list
      .filter(p => p && (p.id || Number.isFinite(p.amountMinor)))
      .map(p => ({
        id: p.id || null,
        amountMinor: Number.isFinite(p.amountMinor) ? p.amountMinor : null,
        ...(p.card ? { card: p.card } : {}),
        // v5.7.21 — booking tender legs (method 'booking_prepaid' /
        // 'booking_deposit', id null) ride payment_intents so the credit that
        // paid part of the check is on the record. cardLegsOf filters on p.id,
        // so refunds can never aim card money at one of these.
        ...(p.method ? { method: p.method } : {}),
      }));
    return clean.length ? clean : null;
  }
  if (paymentInfo.stripePaymentIntentId) {
    return [{ id: paymentInfo.stripePaymentIntentId, amountMinor: Math.round((paymentInfo.grand || 0) * 100) || null }];
  }
  // Single-flow card-present (Stripe reader OR Ryft terminal) hands back the id
  // as `paymentIntentId` (for Ryft this is the ps_ payment-session id). Capture
  // it so the check is refundable; refundCheck routes by the check's processor.
  if (paymentInfo.paymentIntentId) {
    return [{ id: paymentInfo.paymentIntentId, amountMinor: Math.round((paymentInfo.grand || 0) * 100) || null }];
  }
  return null;
}

// Marketing promo → an entry in the closed_check.discounts jsonb (reuses the existing discount slot).
function promoDiscountEntry(promo) {
  if (!promo?.code) return [];
  return [{ source: 'promo', code: promo.code, name: promo.label || promo.code, type: promo.type, value: promo.value, amount: Number(promo.amount) || 0 }];
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
// v5.5.954 — ONE serialised write chain for menus AND categories. The banner caught
// menu_categories_menu_id_fkey live: a category referencing a menu whose own insert
// had failed SILENTLY (sbUpsertMenu was still console.error-only). Chain order =
// creation order, so a new menu's row always lands before its first category, and a
// parent category before its subs (v5.5.952).
let _menuWriteChain = Promise.resolve();
const enqueueMenuWrite = (job) => {
  _menuWriteChain = _menuWriteChain.then(job).catch(() => {});
  return _menuWriteChain;
};
const sbUpsertMenu = (menu) => enqueueMenuWrite(() => _sbUpsertMenuNow(menu));
const _sbUpsertMenuNow = async (menu) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — menu not saved');
  // v5.7.15 - read BOTH spellings. A tab holding raw snake rows (pre-5.7.14
  // loaders) saved isDefault undefined here and silently un-starred the
  // default menu on ANY save (live 20 Aug: saving a menu SCHEDULE wiped the
  // flag). Same clobber class as the v5.7.9 device-profile guard.
  // v5.7.17: the both-spellings read now goes through the shared normaliser
  // in lib/rowMapping.js, same as every menus loader.
  const m = normaliseMenuRow(menu);
  const { error } = await supabase.from('menus').upsert({
    id: m.id,
    location_id: locationId,
    name: m.name,
    description: m.description || '',
    is_default: m.isDefault || false,
    is_active: m.isActive !== false,
    sort_order: m.sortOrder || 0,
    // v4.6.4: schedule (timed menus) + priority (tiebreaker when multiple menus active)
    schedule:   m.schedule ?? null,
    priority:   m.priority ?? 0,
    // v4.6.0 sharing fields
    scope:      m.scope    || 'local',
    org_id:     m.orgId    ?? m.org_id    ?? null,
    updated_at: new Date().toISOString(),
  });
  reportSave('menu', error);   // v5.5.954 — was console-only
};
const sbDeleteMenu = async (id) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.279: location_id guard — never delete across tenants
  const { error } = await supabase.from('menus').delete().eq('id', id).eq('location_id', locationId);
  reportSave('menu delete', error);   // v5.5.954
};
// v5.5.952 — category writes are SERIALISED in call order + FK-retried.
// THE BANNER CAUGHT THE REAL KILLER LIVE (30 Jul): create "Beer", then its sub
// "Draught" a moment later — two independent fire-and-forget upserts race, the
// CHILD can reach Postgres before the PARENT commits, and dies on
// menu_categories_parent_id_fkey. The child then existed only on screen: the
// exact "sub categories vanish on refresh" Peter hit ~20 times (menu import
// bulk-creates make the race near-certain). Creation order is always
// parent-before-child in the UI, so executing writes in call order fixes the
// ordering; one delayed retry mops up a parent that was still in flight.
const sbUpsertCategory = (cat) => enqueueMenuWrite(() => _sbUpsertCategoryNow(cat));
const _sbUpsertCategoryNow = async (cat, isRetry = false) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — category not saved');
  const { error } = await supabase.from('menu_categories').upsert({
    id: cat.id,
    location_id: locationId,
    menu_id: cat.menuId || null,
    parent_id: cat.parentId || null,
    label: cat.label,
    icon: cat.icon || '🍽',
    color: cat.color || '#3b82f6',
    accounting_group: cat.accountingGroup || '',
    sort_order: cat.sortOrder || 0,
    default_course: cat.defaultCourse ?? 1,
    spacer_slots: cat.spacerSlots ?? [],
    is_special: cat.isSpecial ?? cat.is_special ?? false,  // v5.5.316: persist so kiosk/online hide special cats
    updated_at: new Date().toISOString(),
  });
  // Parent still landing (or landed by ANOTHER tab a beat later): wait and retry once
  // before going loud — this heals the race instead of just reporting it.
  if (error && !isRetry && /parent_id_fkey|menu_id_fkey/.test(String(error.message || ''))) {
    await new Promise(r => setTimeout(r, 900));
    return _sbUpsertCategoryNow(cat, true);
  }
  // v5.5.951: failures must be LOUD — a silent console.error here is how "Premium
  // Sauces" lived on screen all session and never existed after refresh.
  reportSave('category', error);
};
const sbDeleteCategory = async (id) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.279: location_id guard — never delete across tenants
  const { error } = await supabase.from('menu_categories').delete().eq('id', id).eq('location_id', locationId);
  reportSave('category delete', error);   // v5.5.951
};
const sbUpsertMenuItem = async (item) => {
  if (isMock) return;
  const locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId) return console.warn('[Supabase] no location ID — item not saved');
  const { error } = await supabase.from('menu_items').upsert({
    id: item.id, location_id: locationId, name: item.menuName||item.menu_name||item.name||'Item',
    menu_name: item.menuName||item.menu_name||item.name||'Item', receipt_name: item.receiptName||item.name,
    kitchen_name: item.kitchenName||item.name, description: item.description||'',
    type: item.type||'simple', cat: item.cat||null, cats: item.cats||[],
    parent_id: item.parentId||null, sort_order: item.sortOrder||0,
    pricing: item.pricing||{base:0}, allergens: item.allergens||[], tags: item.tags||[],
    assigned_modifier_groups: item.assignedModifierGroups||[],
    // v5.5.948: combined flow order — conditional so this path can't clobber a saved order.
    ...(item.optionGroupOrder !== undefined ? { option_group_order: item.optionGroupOrder } : {}),
    visibility: item.visibility||{pos:true,kiosk:true,online:true},
    sold_alone: item.soldAlone||false, archived: item.archived||false,
    updated_at: new Date().toISOString()
  });
  reportSave('item', error);   // v5.5.951 — this writer previously didn't even LOOK at the result
};
import { INITIAL_KDS, SHIFT, MENU_ITEMS, CATEGORIES, STAFF as STAFF_SEED, QUICK_IDS, ALLERGENS as ALLERGEN_DEFS } from '../data/seed';
import { money } from '../lib/currency';

// ─── ID helpers ──────────────────────────────────────────────────────────────
let _itemUid = 1;
const uid = () => `i${_itemUid++}`;
let _orderNum = 1000;
let _tabNum   = 1;
let _autoSignoutTimer = null;   // v5.5.734: pending auto-sign-out timeout, cancelled on any login/logout

const CAT_COURSE = { starters:1, mains:2, pizza:2, sides:2, desserts:3, drinks:0, cocktails:0, quick:1 };

// ─── Tables with static config + runtime session ──────────────────────────────
// session: null | { id, items[], firedCourses[], sentAt, server, covers, seatedAt, note }
const TABLES_CONFIG = [
  { id:'t1',  label:'T1',        maxCovers:2, shape:'sq', x:18,  y:30,  w:70,  h:60,  section:'main'  },
  { id:'t2',  label:'T2',        maxCovers:4, shape:'sq', x:110, y:30,  w:80,  h:60,  section:'main'  },
  { id:'t3',  label:'T3',        maxCovers:2, shape:'sq', x:214, y:30,  w:70,  h:60,  section:'main'  },
  { id:'t4',  label:'T4',        maxCovers:4, shape:'sq', x:306, y:30,  w:80,  h:60,  section:'main'  },
  { id:'t5',  label:'T5',        maxCovers:3, shape:'rd', x:18,  y:118, w:78,  h:78,  section:'main'  },
  { id:'t6',  label:'T6',        maxCovers:3, shape:'rd', x:120, y:118, w:78,  h:78,  section:'main'  },
  { id:'t7',  label:'Banquette', maxCovers:8, shape:'sq', x:224, y:120, w:150, h:68,  section:'main'  },
  { id:'t8',  label:'T8',        maxCovers:2, shape:'sq', x:18,  y:220, w:68,  h:60,  section:'main'  },
  { id:'t9',  label:'T9',        maxCovers:4, shape:'sq', x:108, y:220, w:80,  h:60,  section:'main'  },
  { id:'t10', label:'T10',       maxCovers:4, shape:'sq', x:208, y:220, w:80,  h:60,  section:'main'  },
  { id:'b1',  label:'B1',        maxCovers:1, shape:'rd', x:415, y:30,  w:50,  h:50,  section:'bar'   },
  { id:'b2',  label:'B2',        maxCovers:1, shape:'rd', x:415, y:96,  w:50,  h:50,  section:'bar'   },
  { id:'b3',  label:'B3',        maxCovers:1, shape:'rd', x:415, y:162, w:50,  h:50,  section:'bar'   },
  { id:'b4',  label:'B4',        maxCovers:1, shape:'rd', x:415, y:228, w:50,  h:50,  section:'bar'   },
  { id:'p1',  label:'P1',        maxCovers:4, shape:'sq', x:500, y:30,  w:78,  h:64,  section:'patio' },
  { id:'p2',  label:'P2',        maxCovers:4, shape:'sq', x:500, y:118, w:78,  h:64,  section:'patio' },
  { id:'p3',  label:'P3',        maxCovers:6, shape:'sq', x:500, y:206, w:90,  h:68,  section:'patio' },
];

// Seed with a couple of occupied tables for demo
function buildInitialTables() {
  return TABLES_CONFIG.map(t => {
    const base = { ...t, status:'available', session:null, reservation:null };
    if (t.id==='t2') return { ...base, status:'occupied', session:{ id:'ORD-DEMO1', items:[
      { uid:'d1', itemId:'m-soup',    name:'Soup of the day',  price:6.5,  qty:2, mods:[], notes:'', allergens:['gluten','milk'], course:1, fired:true, status:'sent', seat:'shared' },
      { uid:'d2', itemId:'m-salmon',  name:'Grilled salmon',   price:19.0, qty:2, mods:[], notes:'', allergens:['fish','milk'],   course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d3', itemId:'m-hwine-250',name:'House white 250ml',price:8.5, qty:1, mods:[], notes:'', allergens:['sulphites'],    course:0, fired:true, status:'sent', seat:'shared' },
    ], firedCourses:[0,1], sentAt:Date.now()-18*60000, server:'Sarah', covers:2, seatedAt:Date.now()-22*60000, note:'', orderNote:'' } };
    if (t.id==='t5') return { ...base, status:'occupied', session:{ id:'ORD-DEMO2', items:[
      { uid:'d4', itemId:'m-rib8',    name:'8oz Ribeye',       price:28.0, qty:1, mods:[{label:'Side: Chips',price:0},{label:'Sauce: Peppercorn',price:0}], notes:'', allergens:['milk'], course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d5', itemId:'m-sir6',    name:'6oz Sirloin',      price:22.0, qty:1, mods:[{label:'Side: Side salad',price:0},{label:'Cooking: Medium rare',price:0}], notes:'', allergens:['milk'], course:2, fired:true, status:'sent', seat:'shared' },
      { uid:'d6', itemId:'m-hrwine-175',name:'House red 175ml',price:6.5,  qty:2, mods:[], notes:'', allergens:['sulphites'], course:0, fired:true, status:'sent', seat:'shared' },
    ], firedCourses:[0,2], sentAt:Date.now()-35*60000, server:'Tom', covers:2, seatedAt:Date.now()-40*60000, note:'', orderNote:'' } };
    if (t.id==='t3') return { ...base, status:'reserved', reservation:{ name:'Johnson party', phone:'07700 900111', time:'7:30 PM', partySize:2 } };
    if (t.id==='p2') return { ...base, status:'reserved', reservation:{ name:'Chen table',   phone:'07700 900222', time:'8:00 PM', partySize:4 } };
    return base;
  });
}

// ─── Utility: recalc session totals ──────────────────────────────────────────
function calcSessionTotals(session) {
  if (!session) return null;
  const subtotal = session.items.reduce((s,i) => s + i.price * i.qty, 0);
  return { ...session, subtotal, total: subtotal * 1.125 };
}

export function getCollectionSlots() {
  const slots = [], now = new Date(), start = new Date(now);
  start.setMinutes(Math.ceil((now.getMinutes()+15)/15)*15, 0, 0);
  for (let i=0; i<12; i++) {
    const t = new Date(start.getTime() + i*15*60000);
    slots.push({ value:t.toISOString(), label:t.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}), isASAP:i===0 });
  }
  return slots;
}

// ─── Store ────────────────────────────────────────────────────────────────────
// Restore back-office config from localStorage — ONLY in mock mode
// In real mode, data comes from Supabase (loaded in BackOfficeApp on mount)
const _isMockMode = import.meta.env.VITE_USE_MOCK === 'true';
const _savedBO = (() => {
  if (!_isMockMode) return {}; // real mode: always load from Supabase
  try { return JSON.parse(localStorage.getItem('rpos-bo-config')||'{}'); } catch { return {}; }
})();

// ── Duplicate product-name rule (v5.5.797) ───────────────────────────────────
// Within one location, live TOP-LEVEL products must have unique display names,
// compared case-insensitively on the trimmed name. Exempt: variants (parentId
// set — sizes legitimately repeat "Small"/"Large" across parents), sub-items,
// spacers, and archived items. Returns the conflicting item, or null.
// The store menuItems list is already scoped to the active location.
export const findDuplicateProductName = (items, name, excludeId = null) => {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return (items || []).find(i =>
    i.id !== excludeId &&
    !i.parentId &&
    !i.archived &&
    !['subitem', 'spacer'].includes(i.type || 'simple') &&
    String(i.menuName || i.name || '').trim().toLowerCase() === key
  ) || null;
};

// ── Kitchen print routing: which production centre(s) does an item belong to? ──
// v5.5.974: these three were declared with `const` INSIDE sendToKitchen, but
// transferTable also calls getCentresForItem — from a different function scope, so it
// threw "getCentresForItem is not defined" every time. The throw landed in
// transferTable's `catch (err) { console.warn(...) }`, so transferring a table has
// never printed the transfer notice: the operator saw "Transferred to Table 12" and
// the kitchen was never told the food had moved. Lifted to module scope so both
// callers share one implementation.
// NOTE: two further near-copies of this logic still live inside other store actions
// (the KDS ticket builder and the kiosk print router). They work; folding them in is a
// separate cleanup, deliberately not bundled into a pre-stage hardening pass.

// catId → parentId, for walking the category hierarchy.
const buildCatParentMap = () => {
  try {
    const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
    const cats = snap.menuCategories || useStore.getState().menuCategories || [];
    const map = {};
    cats.forEach(c => { map[c.id] = c.parentId || null; });
    return map;
  } catch { return {}; }
};

// Is catId, or any ancestor of it, in the assigned set?
const catOrAncestorMatches = (catId, assignedSet, parentMap, depth = 0) => {
  if (!catId || depth > 5) return false;
  if (assignedSet.has(catId)) return true;
  const parentId = parentMap[catId];
  if (!parentId) return false;
  return catOrAncestorMatches(parentId, assignedSet, parentMap, depth + 1);
};

const getCentresForItem = (item, config) => {
  const { centres, routing } = config;
  if (!centres?.length || !routing) return [];

  // Order line items only carry itemId — look up the full menu item to get cat/parentId
  const allItems = useStore.getState().menuItems || [];
  const menuItem = allItems.find(i => i.id === (item.itemId || item.id));

  // Direct category from the item (or looked-up menu item)
  let itemCat = item.cat || item.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;

  // For variant items (e.g. Small Latte), also check the parent item's category
  // (variants often inherit their routing from the parent: Latte → Coffee → Hot Drinks → KDS Bar)
  const parentId = item.parentId || menuItem?.parentId || null;
  const parentMenuItem = parentId ? allItems.find(i => i.id === parentId) : null;
  const parentCat = parentMenuItem?.cat || parentMenuItem?.cats?.[0] || null;

  const parentMap = buildCatParentMap();
  const matched = [];
  centres.forEach(centre => {
    const r = routing[centre.id];
    if (!r?.assignedCategories?.length) return;
    if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
    const assignedSet = new Set(r.assignedCategories);
    const catMatches = (itemCat && catOrAncestorMatches(itemCat, assignedSet, parentMap)) ||
                       (parentCat && catOrAncestorMatches(parentCat, assignedSet, parentMap));
    if (catMatches) matched.push(centre.id);
  });
  return matched;
};

export const useStore = create((set, get) => ({
  // Tables Ready — walk-in waitlist / live table-queue (slice in ./waitlistSlice.js).
  ...waitlistSlice(set, get),

  // Table Bookings — diary/optimiser/rules (slice in ./bookingsSlice.js).
  ...bookingsSlice(set, get),

  // ── Location integrity (v5.5.238) ─────────
  // Stamps which location the in-memory data belongs to. SyncBridge sets this
  // after loading data. If a subsequent boot detects a mismatch, it purges
  // stale data BEFORE loading fresh — preventing cross-location bleed.
  _dataLocationId: null,

  // ── Auth ──────────────────────────────────
  staff: null,
  staffMembers: isMock ? STAFF_SEED : [],
  addStaffMember:    s    => set(st => ({ staffMembers: [...st.staffMembers, { ...s, id: s.id || `s-${Date.now()}` }] })),
  updateStaffMember: (id,patch) => set(st => ({ staffMembers: st.staffMembers.map(s => s.id===id ? {...s,...patch} : s) })),
  removeStaffMember: id  => set(st => ({ staffMembers: st.staffMembers.filter(s => s.id!==id) })),
  // v5.5.734: per-operator counter checkout on a shared till. When the operator changes, the
  // outgoing person's in-progress COUNTER order (walkInOrder + its context) is PARKED under their
  // staff id, and the incoming person gets THEIR parked order back — or a clean, empty checkout.
  // So one user can add items and walk away without sending/paying, another can sign in and ring up
  // their own sale, and the first user's order is waiting for them when they sign back in. Table
  // orders are NOT touched — those live on the table (tables[].session). Pure logic + tests in
  // lib/cartHold.js. Holds are in-memory (like walkInOrder itself — ephemeral until sent/paid).
  heldOrders: {},   // { [staffId]: { walkInOrder, customer, orderType, pendingLoyaltyReward, deliveryQuote, parkedAt } }

  login: (newStaff) => {
    if (_autoSignoutTimer) { clearTimeout(_autoSignoutTimer); _autoSignoutTimer = null; }   // cancel a stale pay/send sign-out
    const { patch, restored } = operatorSwitchPatch(get(), newStaff, Date.now());
    set(patch);
    if (restored && restored.count) {
      get().showToast?.(`Your held order is back — ${restored.count} item${restored.count === 1 ? '' : 's'}`, 'info');
    }
  },

  logout: () => {
    if (_autoSignoutTimer) { clearTimeout(_autoSignoutTimer); _autoSignoutTimer = null; }
    set(logoutPatch(get(), Date.now()));
  },

  // v5.5.731: per-device auto sign-out policy (deviceConfig.signout). trigger 'pay' = a check was
  // cashed off; 'send' = an order went to the kitchen. Short delay so the confirmation shows first.
  // The idle-timeout trigger lives in the <AutoSignout> component (needs DOM activity listeners).
  maybeAutoSignout: (trigger) => {
    const { deviceConfig, staff } = get();
    const so = deviceConfig?.signout;
    if (!staff || !so) return;
    if ((trigger === 'pay' && so.onPay) || (trigger === 'send' && so.onSend)) {
      const who = staff.name?.split(' ')[0] || '';
      const sid = staff.id;   // v5.5.734: only sign out if it's STILL this operator — a card-swap in
      if (_autoSignoutTimer) clearTimeout(_autoSignoutTimer);   // the 1.4s window must not sign the NEW
      _autoSignoutTimer = setTimeout(() => {                    // operator out; and a new pay/send supersedes.
        _autoSignoutTimer = null;
        const now = get().staff;
        if (now && String(now.id) === String(sid)) { get().logout(); get().showToast?.(`Signed out ${who}`.trim(), 'info'); }
      }, 1400);
    }
  },

  // v5.5.983: sign out after a successful cash-up. Separate from maybeAutoSignout because that one
  // is gated on the per-device signout policy (onPay / onSend) and cashing up should always end the
  // operator's session — the drawer is counted and closed, there is nothing left for them to do.
  //
  // The delay is the whole reason this is not a bare logout() at the call site. Logging out swaps
  // the tree to PINScreen, which renders no Toast, so an immediate logout destroys the message
  // cashOutDrawer just set — and that message is the variance figure, or the warning that the
  // variance was NOT written to the cash ledger. Toasts clear themselves at 2800ms (showToast), so
  // this waits longer than that and the operator always sees the number before the screen changes.
  //
  // Same two guards as maybeAutoSignout: cancel any pending timer, and only sign out if the SAME
  // operator is still signed in, so a card-swap during the wait cannot sign the new person out.
  signOutAfterCashUp: () => {
    const { staff } = get();
    if (!staff) return;
    const who = staff.name?.split(' ')[0] || '';
    const sid = staff.id;
    if (_autoSignoutTimer) clearTimeout(_autoSignoutTimer);
    _autoSignoutTimer = setTimeout(() => {
      _autoSignoutTimer = null;
      const now = get().staff;
      if (now && String(now.id) === String(sid)) {
        get().logout();
        get().showToast?.(`Drawer closed. Signed out ${who}`.trim(), 'info');
      }
    }, 3200);
  },

  // v5.5.731: a re-entrant guard that stops the idle auto-sign-out from firing mid-transaction.
  // Any open payment surface (CheckoutModal, CardTerminal collect) holds this while mounted, so a
  // customer taking >15s to tap the reader — which is NOT POS DOM activity — can never sign the
  // operator out and orphan the charge. The idle timer re-arms instead of logging out while held.
  _signoutBlock: 0,
  blockSignout: () => set(s => ({ _signoutBlock: (s._signoutBlock || 0) + 1 })),
  unblockSignout: () => set(s => ({ _signoutBlock: Math.max(0, (s._signoutBlock || 0) - 1) })),

  // ── Navigation ────────────────────────────
  surface: (() => {
    // Apply defaultSurface from device config on startup
    try {
      const dc = JSON.parse(localStorage.getItem('rpos-device-config') || 'null');
      if (dc?.defaultSurface) return dc.defaultSurface;
    } catch {}
    return 'tables';
  })(),
  setSurface: s => set({ surface:s }),

  // ── Back Office config push workflow ────────────────────────────────────────
  // pendingBOChanges: count of BO changes not yet pushed to POS
  // configVersion: incremented on each push — POS compares this to know if it's stale
  // Print routing config — read from localStorage, updated via Push to POS
  printRouting: (() => {
    try { return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; }
    catch { return { centres:[], routing:{} }; }
  })(),

  // configUpdateAvailable: true on POS when a push has been received but not applied
  // configUpdateSnapshot: the incoming config snapshot waiting to be applied
  pendingBOChanges: 0,
  configVersion: 0,
  configUpdateAvailable: false,
  configUpdateSnapshot: null,
  markBOChange: () => set(s => ({ pendingBOChanges: s.pendingBOChanges + 1 })),
  clearBOChanges: () => set({ pendingBOChanges: 0 }),
  setConfigUpdate: (snapshot) => set({ configUpdateAvailable: true, configUpdateSnapshot: snapshot }),
  applyConfigUpdate: () => {
    const snap = useStore.getState().configUpdateSnapshot;
    if (!snap) return;

    // v5.5.893: keep the boot cache fresh on EVERY apply (boot fetch, live config push) so the
    // next boot paints the newest menu instantly and an offline boot still has one. Offline-
    // fallback caching is the sanctioned localStorage exception. Best-effort; keyed by location
    // so the SyncBridge cache-apply honours the cross-location purge guard.
    try {
      const locId = getActiveLocationSync();
      if (locId && locId !== 'loc-demo') {
        localStorage.setItem('rpos-config-cache', JSON.stringify({ locationId: locId, snapshot: snap, at: Date.now() }));
      }
    } catch { /* cache is best-effort */ }

    // Tables: merge layout into existing live tables, AND add new tables from snapshot
    let updatedTables = useStore.getState().tables;
    if (snap.tables) {
      // v5.5.2: preserve table.locationId on every merge path so the cross-location upsert
      // guard has data to work with. Config snapshots may have a top-level snap.locationId
      // that the snapshot was generated for; fall back to that if the individual table row
      // doesn't carry it explicitly.
      const snapLoc = snap.locationId || null;
      // Update layout of existing tables
      updatedTables = updatedTables.map(t => {
        const st = snap.tables.find(s => s.id === t.id);
        return st ? { ...t, label:st.label, x:st.x, y:st.y, w:st.w, h:st.h, shape:st.shape, maxCovers:st.maxCovers, section:st.section, locationId: st.locationId ?? st.location_id ?? t.locationId ?? snapLoc } : t;
      });
      // Add new tables that exist in snapshot but not in store
      const existingIds = new Set(updatedTables.map(t => t.id));
      const newTables = snap.tables
        .filter(st => !existingIds.has(st.id))
        .map(st => ({ ...st, locationId: st.locationId ?? st.location_id ?? snapLoc, status:'available', session:null, firedCourses:[], sentAt:null }));
      updatedTables = [...updatedTables, ...newTables];
    }

    // v5.5.833: every ARRAY slice below is guarded on `?.length`, NEVER on plain
    // truthiness. An empty array is TRUTHY in JavaScript, so a partial or empty
    // snapshot carrying e.g. `modifierGroupDefs: []` used to full-replace good data
    // with nothing — that is the "modifier groups disappear on refresh" bug. Same
    // trap applied to menuItems / menus / menuCategories / discounts / instructions.
    // An absent-or-empty slice must be a NO-OP: keep what the store already has.
    // Do NOT "simplify" these back to `snap.x ? ... : {}`.
    // printRouting is an OBJECT (`{ centres, routing }`), so it gets the equivalent
    // non-empty-object guard — `{}` is truthy too and would wipe the routing table.
    const hasEntries = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length > 0;

    set({
      tables: updatedTables,
      // Sections
      locationSections: snap.locationSections || useStore.getState().locationSections,
      // Menu items — full replace with pushed version
      ...(snap.menuItems?.length ? { menuItems: snap.menuItems } : {}),
      // Menus list
      // v5.7.11: same camelCase normalisation as SyncBridge's DB read — push
      // snapshots carry raw snake rows and MenuManager reads isDefault/isActive.
      // v5.7.17: the shared normaliser in lib/rowMapping.js is the one copy.
      ...(snap.menus?.length ? { menus: snap.menus.map(normaliseMenuRow) } : {}),
      // Menu categories — full replace
      ...(snap.menuCategories?.length ? { menuCategories: snap.menuCategories } : {}),
      // Tax rates — full replace
      ...(snap.taxRates?.length ? { taxRates: snap.taxRates } : {}),
      // Discount presets + rules — full replace
      ...(snap.discountPresets?.length ? { discountPresets: snap.discountPresets } : {}),
      ...(snap.discountRules?.length ? { discountRules: snap.discountRules } : {}),
      // Modifier + instruction groups — full replace
      ...(snap.modifierGroupDefs?.length ? { modifierGroupDefs: snap.modifierGroupDefs } : {}),
      ...(snap.instructionGroupDefs?.length ? { instructionGroupDefs: snap.instructionGroupDefs } : {}),

      // Print routing config from back office
      ...(hasEntries(snap.printRouting) ? { printRouting: snap.printRouting } : {}),

      // v5.5.799: takeaway customer-details level rides the push so tills pick
      // up a Location settings change without a reboot (boot path: SyncBridge).
      ...(snap.takeawayCustomerDetails ? { takeawayCustomerDetails: snap.takeawayCustomerDetails } : {}),

      // v5.5.962: quick screen rides the push. quickScreenIds was in every snapshot
      // since day one but this merge silently dropped it — tills only ever picked
      // pins up on reboot. Same non-empty guard as menus: a push can never CLEAR a
      // till's quick screen, only replace it.
      ...(snap.quickScreenIds?.length ? { quickScreenIds: snap.quickScreenIds } : {}),
      ...(['manual','auto','hybrid'].includes(snap.quickScreenMode) ? { quickScreenMode: snap.quickScreenMode } : {}),
      ...(hasEntries(snap.quickScreenAuto?.lists) ? { quickScreenAuto: snap.quickScreenAuto } : {}),

      // v5.6.25 Table Bookings — packages + rules ride the push (same non-empty
      // guards: a push can never CLEAR a till's packages, only replace them).
      ...(snap.packages?.length ? { packages: snap.packages } : {}),
      ...(hasEntries(snap.bookingRules) ? { bookingRules: snap.bookingRules } : {}),

      configVersion: snap.version,
      configUpdateAvailable: false,
      configUpdateSnapshot: null,
    });
    // Persist print routing to localStorage so it survives reload
    // v5.5.833: same non-empty-object guard as the store write above — otherwise an
    // empty `{}` would be cached to localStorage and re-hydrated as empty on next boot.
    if (hasEntries(snap.printRouting)) {
      try { localStorage.setItem('rpos-print-routing', JSON.stringify(snap.printRouting)); } catch {}
    }
    // Sync printers registry to this device so FOH and print service can read them
    if (snap.printers?.length) {
      try { localStorage.setItem('rpos-printers', JSON.stringify(snap.printers)); } catch {}
      try { window.dispatchEvent(new Event('rpos-printers-updated')); } catch {}
    }
    try { sessionStorage.setItem('rpos-config-version', String(snap.version)); } catch {}
  },
  locationSections: [
    { id:'main',  label:'Main dining', color:'#3b82f6', icon:'🍽' },
    { id:'bar',   label:'Bar',         color:'#e8a020', icon:'🍸' },
    { id:'patio', label:'Patio',       color:'#22c55e', icon:'🌿' },
  ],
  addSection: (section) => set(s => ({ locationSections: [...s.locationSections, { id:`sec-${Date.now()}`, ...section }] })),
  updateSection: (id, patch) => set(s => ({ locationSections: s.locationSections.map(sec => sec.id===id ? { ...sec, ...patch } : sec) })),
  removeSection: (id) => set(s => ({
    locationSections: s.locationSections.filter(sec => sec.id !== id),
    // Move tables in deleted section to 'main'
    tables: s.tables.map(t => t.section===id ? { ...t, section:'main' } : t),
  })),
  // v4.6.56: reorder a section by moving it up or down within the array.
  moveSection: (id, direction) => set(s => {
    const arr = [...(s.locationSections || [])];
    const idx = arr.findIndex(sec => sec.id === id);
    if (idx < 0) return s;
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= arr.length) return s;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    return { locationSections: arr };
  }),

  // ── Sync status — tracks whether POS config is current ───────────────────
  syncStatus: {
    lastConfigChange: null,      // timestamp when BO last pushed a change
    lastTerminalSync: Date.now(), // timestamp when this terminal last received config
    pendingChanges: false,
    printerOnline: true,
    paymentTerminalOnline: true,
    kdsOnline: true,
  },
  setSyncStatus: (patch) => set(s => ({ syncStatus: { ...s.syncStatus, ...patch } })),
  markConfigChanged: () => set(s => ({
    syncStatus: { ...s.syncStatus, lastConfigChange: Date.now(), pendingChanges: true }
  })),
  markTerminalSynced: () => set(s => ({
    syncStatus: { ...s.syncStatus, lastTerminalSync: Date.now(), pendingChanges: false }
  })),
  appMode: 'pos',
  setAppMode: mode => set({ appMode: mode }),

  // ── Organisations & Locations ──────────────────────────────────────────────
  currentLocationId: 'loc-demo',
  locations: [
    { id:'loc-demo', name:'The Anchor — High Street', address:'1 High Street, London EC1A 1BB', timezone:'Europe/London', currency:'GBP', vat:20, serviceCharge:12.5, plan:'standard', isActive:true, receiptHeader:'', receiptFooter:'Thank you for dining with us!', createdAt:Date.now() },
  ],
  setCurrentLocation: id => set({ currentLocationId: id }),
  addLocation: loc => set(s => ({ locations: [...s.locations, loc] })),
  updateLocation: (id, patch) => set(s => ({ locations: s.locations.map(l => l.id===id ? { ...l,...patch } : l) })),
  removeLocation: id => set(s => ({ locations: s.locations.filter(l => l.id!==id) })),

  // ── Device config — uses sessionStorage so each browser tab is a separate terminal
  // URL param ?t=bar or ?t=counter2 overrides on load (for testing)
  // In Phase 2: loaded from Supabase by device ID on pairing
  deviceConfig: (() => {
    try {
      // Check URL param first — ?t=bar, ?t=counter, ?t=handheld etc.
      const urlParam = new URLSearchParams(window.location.search).get('t');
      const PRESET_PROFILES = {
        'counter':  { terminalName:'Counter 1',  profileName:'Main counter',    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], assignedSection:null,  hiddenFeatures:[],                    tableServiceEnabled:true,  quickScreenEnabled:true },
        'counter2': { terminalName:'Counter 2',  profileName:'Main counter',    defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], assignedSection:null,  hiddenFeatures:[],                    tableServiceEnabled:true,  quickScreenEnabled:true },
        'bar':      { terminalName:'Bar',        profileName:'Bar terminal',     defaultSurface:'bar',    enabledOrderTypes:['dine-in'],                         assignedSection:'bar', hiddenFeatures:['courses','reports'], tableServiceEnabled:false, quickScreenEnabled:true, menuId:'menu-2' },
        'handheld': { terminalName:'Handheld 1', profileName:'Server handheld', defaultSurface:'pos',    enabledOrderTypes:['dine-in'],                         assignedSection:null,  hiddenFeatures:['reports','kiosk'],   tableServiceEnabled:true,  quickScreenEnabled:true },
        'kiosk':    { terminalName:'Kiosk 1',    profileName:'Kiosk',           defaultSurface:'pos',    enabledOrderTypes:['dine-in','takeaway'],               assignedSection:null,  hiddenFeatures:['reports','staff'],   tableServiceEnabled:false, quickScreenEnabled:true },
        'kds':      { terminalName:'KDS',        profileName:'Kitchen display',  defaultSurface:'kds',   enabledOrderTypes:[],                                   assignedSection:null,  hiddenFeatures:['reports'],           tableServiceEnabled:false, quickScreenEnabled:false },
      };
      if (urlParam && PRESET_PROFILES[urlParam]) {
        const config = { ...PRESET_PROFILES[urlParam], source:'url-param', param:urlParam };
        try { sessionStorage.setItem('rpos-terminal-config', JSON.stringify(config)); } catch {}
        return config;
      }
      // Then check sessionStorage (tab-specific — each tab is a separate terminal)
      const saved = sessionStorage.getItem('rpos-terminal-config');
      if (saved) {
        const cfg = JSON.parse(saved);
        // Backfill serviceCharge from stored profiles if missing
        if (!cfg.serviceCharge && cfg.profileId) {
          const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          const match = profiles.find(p => p.id === cfg.profileId);
          if (match?.serviceCharge) cfg.serviceCharge = match.serviceCharge;
        }
        return cfg;
      }
      // Fall back to localStorage device config (set when device was paired/profiled)
      const localConfig = localStorage.getItem('rpos-device-config');
      if (localConfig) {
        const cfg = JSON.parse(localConfig);
        // Backfill serviceCharge from stored profiles if missing
        if (!cfg.serviceCharge && cfg.profileId) {
          const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          const match = profiles.find(p => p.id === cfg.profileId);
          if (match?.serviceCharge) cfg.serviceCharge = match.serviceCharge;
        }
        return cfg;
      }
      return null;
    } catch { return null; }
  })(),
  // v5.5.645: per-device Training Mode. Initialised from the cached device config at
  // module load (so a training till is gated before App's profile fetch completes)
  // and kept authoritative by setDeviceConfig (boot + device_profiles realtime).
  trainingMode: (() => {
    try {
      const raw = sessionStorage.getItem('rpos-terminal-config') || localStorage.getItem('rpos-device-config');
      const cfg = raw ? JSON.parse(raw) : null;
      const on = !!cfg?.trainingMode;
      applyTrainingFlag(on);   // seed the module singleton read by db.js / sync gates
      return on;
    } catch { return false; }
  })(),
  setDeviceConfig: (config) => {
    // Always backfill serviceCharge from stored profiles if the config is missing it
    let finalConfig = config;
    if (config && !config.serviceCharge && config.profileId) {
      try {
        const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
        const match = profiles.find(p => p.id === config.profileId);
        if (match?.serviceCharge) finalConfig = { ...config, serviceCharge: match.serviceCharge };
      } catch {}
    }
    try { sessionStorage.setItem('rpos-terminal-config', JSON.stringify(finalConfig)); } catch {}
    // v5.5.645: per-device Training Mode rides the device profile. Mirror it into the
    // module singleton (read by db.js / sync / surfaces gates) AND the React state
    // (drives the banner). setDeviceConfig is the single funnel for boot + realtime.
    const training = !!finalConfig?.trainingMode;
    applyTrainingFlag(training);
    // v5.7.7: snap to the profile's default surface only when the DEFAULT
    // actually changed (or on first apply). A silent profile refresh that
    // re-applies an identical profile must never yank the operator off the
    // screen they are working on mid-shift.
    const prevDefaultSurface = get().deviceConfig?.defaultSurface;
    set({ deviceConfig: finalConfig, trainingMode: training });
    if (finalConfig?.defaultSurface && finalConfig.defaultSurface !== prevDefaultSurface) set({ surface: finalConfig.defaultSurface });
  },
  // v5.5.645: explicit setter (used at boot + by any manual override). Keeps the
  // module singleton and the React state in lock-step.
  setTrainingMode: (on) => { applyTrainingFlag(!!on); set({ trainingMode: !!on }); },
  clearDeviceConfig: () => {
    try { sessionStorage.removeItem('rpos-terminal-config'); } catch {}
    set({ deviceConfig: null });
  },

  // ── Registered POS terminals ───────────────────────────────────────────────
  devices: isMock ? [
    { id:'dev-1', label:'Counter 1', type:'counter', section:'main', status:'online', hardwareModel:'Sunmi T2s', ipAddress:'192.168.1.10' },
    { id:'dev-2', label:'Counter 2', type:'counter', section:'bar',  status:'offline',hardwareModel:'Sunmi T2s', ipAddress:'192.168.1.11' },
    { id:'dev-3', label:'Handheld 1',type:'handheld',section:'main', status:'online', hardwareModel:'Sunmi V2s', ipAddress:'192.168.1.20' },
  ] : [],
  addDevice: (device) => set(s => ({ devices:[...s.devices, { id:`dev-${Date.now()}`, status:'offline', ...device }] })),
  updateDevice: (id, patch) => set(s => ({ devices:s.devices.map(d=>d.id===id?{...d,...patch}:d) })),
  removeDevice: (id) => set(s => ({ devices:s.devices.filter(d=>d.id!==id) })),

  // ── Menus (multiple menus per location, assigned to device profiles) ─────────
  menus: _savedBO.menus || (isMock ? [
    { id:'menu-1', name:'Main menu',    description:'Full food and drinks', scope:'local', assignedProfiles:[], isDefault:true,  isActive:true, sortOrder:0 },
    { id:'menu-2', name:'Bar menu',     description:'Drinks and bar snacks',scope:'local', assignedProfiles:['prof-2'],isDefault:false, isActive:true, sortOrder:1 },
    { id:'menu-3', name:'Lunch menu',   description:'Midday menu',          scope:'local', assignedProfiles:[], isDefault:false, isActive:true, sortOrder:2 },
  ] : []),
  activeMenuId: 'menu-1',
  setActiveMenuId: id => set({ activeMenuId: id }),
  // v5.7.18 - menu_category_links, store-held. The links used to live in
  // one-shot component fetches inside POSSurface/BarSurface; when the fetch
  // raced boot (location id not resolved yet) it silently stored [] forever,
  // every links-only menu counted as EMPTY, and the active-menu resolver could
  // never pick a timed menu whose categories are attached via links (live
  // 20 Aug: the Doboy 5-6pm window lost to the default every day). Loaded at
  // boot by SyncBridge and refreshed by the App self-heal cycle.
  categoryLinks: [],
  setCategoryLinks: rows => set({ categoryLinks: Array.isArray(rows) ? rows : [] }),
  addMenu: menu => {
    const newMenu = { id:`menu-${Date.now()}`, ...menu };
    set(s => ({ menus: [...s.menus, newMenu] }));
    sbUpsertMenu(newMenu);
    return newMenu;   // v5.5.958: callers auto-creating a first menu need the id
  },
  updateMenu: (id, patch) => {
    set(s => ({ menus: s.menus.map(m => m.id===id ? { ...m, ...patch } : m) }));
    const updated = useStore.getState().menus.find(m => m.id===id);
    if (updated) sbUpsertMenu(updated);
  },
  removeMenu: id => {
    set(s => ({ menus: s.menus.filter(m => m.id!==id) }));
    sbDeleteMenu(id);
  },

  // ── Categories (hierarchical — parentId for subcategories) ───────────────────
  // accountingGroup → for financial reporting (P&L, tax)
  // statisticGroup  → for operational reporting (bestsellers, waste)
  menuCategories: _savedBO.menuCategories || (isMock ? [
    // ── The Anchor — category tree ──────────────────────────────────────────
    // Root categories
    { id:'cat-starters',  menuId:'menu-1', parentId:null, label:'Starters',  icon:'🥗', color:'#22c55e', accountingGroup:'Food',      sortOrder:0 },
    { id:'cat-mains',     menuId:'menu-1', parentId:null, label:'Mains',     icon:'🍖', color:'#e8a020', accountingGroup:'Food',      sortOrder:1 },
    { id:'cat-pizza',     menuId:'menu-1', parentId:null, label:'Pizza',     icon:'🍕', color:'#f97316', accountingGroup:'Food',      sortOrder:2 },
    { id:'cat-desserts',  menuId:'menu-1', parentId:null, label:'Desserts',  icon:'🎂', color:'#ec4899', accountingGroup:'Food',      sortOrder:3 },
    { id:'cat-drinks',    menuId:'menu-1', parentId:null, label:'Drinks',    icon:'🍸', color:'#a855f7', accountingGroup:'Beverages', sortOrder:4 },
    { id:'cat-hot',       menuId:'menu-1', parentId:null, label:'Hot drinks',icon:'☕', color:'#78716c', accountingGroup:'Beverages', sortOrder:5 },
    // Mains subcategories
    { id:'cat-grills',    menuId:'menu-1', parentId:'cat-mains',  label:'From the grill', icon:'🥩', color:'#ef4444', accountingGroup:'Food',      sortOrder:0 },
    { id:'cat-fish',      menuId:'menu-1', parentId:'cat-mains',  label:'Fish',           icon:'🐟', color:'#3b82f6', accountingGroup:'Food',      sortOrder:1 },
    { id:'cat-veggie',    menuId:'menu-1', parentId:'cat-mains',  label:'Vegetarian',     icon:'🌿', color:'#22c55e', accountingGroup:'Food',      sortOrder:2 },
    // Drinks subcategories
    { id:'cat-draught',   menuId:'menu-1', parentId:'cat-drinks', label:'Draught beer', icon:'🍺', color:'#e8a020', accountingGroup:'Beverages', sortOrder:0 },
    { id:'cat-wine',      menuId:'menu-1', parentId:'cat-drinks', label:'Wine',         icon:'🍷', color:'#8b1e3f', accountingGroup:'Beverages', sortOrder:1 },
    { id:'cat-softs',     menuId:'menu-1', parentId:'cat-drinks', label:'Soft drinks',  icon:'🥤', color:'#22d3ee', accountingGroup:'Beverages', sortOrder:2 },

    // ── Bar menu (menu-2) ───────────────────────────────────────────────────
    { id:'bcat-draught',  menuId:'menu-2', parentId:null, label:'Draught',      icon:'🍺', color:'#e8a020', accountingGroup:'Beverages', sortOrder:0 },
    { id:'bcat-wine',     menuId:'menu-2', parentId:null, label:'Wine',         icon:'🍷', color:'#8b1e3f', accountingGroup:'Beverages', sortOrder:1 },
    { id:'bcat-spirits',  menuId:'menu-2', parentId:null, label:'Spirits',      icon:'🥃', color:'#a855f7', accountingGroup:'Beverages', sortOrder:2 },
    { id:'bcat-softs',    menuId:'menu-2', parentId:null, label:'Soft drinks',  icon:'🥤', color:'#22d3ee', accountingGroup:'Beverages', sortOrder:3 },
    { id:'bcat-hot',      menuId:'menu-2', parentId:null, label:'Hot drinks',   icon:'☕', color:'#78716c', accountingGroup:'Beverages', sortOrder:4 },
    { id:'bcat-snacks',   menuId:'menu-2', parentId:null, label:'Bar snacks',   icon:'🍟', color:'#22c55e', accountingGroup:'Food',      sortOrder:5 },
  ] : []),
  addCategory: cat => {
    const newCat = { id:`cat-${Date.now()}`, ...cat };
    set(s => ({ menuCategories: [...s.menuCategories, newCat] }));
    sbUpsertCategory(newCat);
  },
  updateCategory: (id, patch) => {
    set(s => ({ menuCategories: s.menuCategories.map(c => c.id===id ? { ...c, ...patch } : c) }));
    const updated = useStore.getState().menuCategories.find(c => c.id===id);
    if (updated) sbUpsertCategory(updated);
  },
  removeCategory: id => {
    set(s => ({ menuCategories: s.menuCategories.filter(c => c.id!==id) }));
    sbDeleteCategory(id);
  },

  // ── Modifier library — create modifiers here, add to groups ─────────────────
  modifierLibrary: [
    { id:'ml-1',  name:'Rare',           price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-2',  name:'Medium rare',    price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-3',  name:'Medium',         price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-4',  name:'Medium well',    price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-5',  name:'Well done',      price:0,    category:'Cooking',   allergens:[] },
    { id:'ml-6',  name:'Peppercorn',     price:0,    category:'Sauce',     allergens:['milk'] },
    { id:'ml-7',  name:'Béarnaise',      price:0,    category:'Sauce',     allergens:['eggs','milk'] },
    { id:'ml-8',  name:'Chimichurri',    price:0,    category:'Sauce',     allergens:[] },
    { id:'ml-9',  name:'No sauce',       price:0,    category:'Sauce',     allergens:[] },
    { id:'ml-10', name:'Truffle oil',    price:3.50, category:'Extra',     allergens:[] },
    { id:'ml-11', name:'Extra pancetta', price:2.50, category:'Extra',     allergens:[] },
    { id:'ml-12', name:'Side salad',     price:0,    category:'Side swap', allergens:[] },
    { id:'ml-13', name:'Mac & cheese',   price:3.00, category:'Side swap', allergens:['gluten','milk','eggs'] },
    { id:'ml-14', name:'Chips',          price:0,    category:'Side swap', allergens:['gluten'] },
    { id:'ml-15', name:'Gluten-free base',price:2.00,category:'Pizza base', allergens:[] },
    { id:'ml-16', name:'Sourdough base', price:0,    category:'Pizza base', allergens:['gluten'] },
    { id:'ml-17', name:'With bread',     price:0,    category:'Bread',     allergens:['gluten'] },
    { id:'ml-18', name:'No bread',       price:0,    category:'Bread',     allergens:[] },
  ],
  addModifier: mod => set(s => ({ modifierLibrary: [...s.modifierLibrary, { id:`ml-${Date.now()}`, ...mod }] })),
  updateModifier: (id, patch) => set(s => ({ modifierLibrary: s.modifierLibrary.map(m => m.id===id ? {...m,...patch} : m) })),
  removeModifier: id => set(s => ({ modifierLibrary: s.modifierLibrary.filter(m => m.id!==id) })),

  // ── Modifier groups — reusable paid option groups ─────────────────────────
  // These change the price. Assigned to items in the Product Builder.
  modifierGroupDefs: isMock ? [
    // Options reference sub item IDs from MENU_ITEMS (type:'subitem')
    { id:'mgd-sides',        name:'Side choice',       min:1, max:1,
      options:[
        {id:'sub-chips',   name:'Chips',               price:0,   soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-salad',   name:'Side salad',          price:0,   soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-spfries', name:'Sweet potato fries',  price:1.5, soldAlone:true,  soldAloneCat:'cat-starters'},
        {id:'sub-mash',    name:'Creamy mash',         price:0,   soldAlone:false},
      ]},
    { id:'mgd-sauces',       name:'Sauce',              min:0, max:1,
      options:[
        {id:'sub-pepper',  name:'Peppercorn sauce',    price:0, subGroupId:'mgd-sauce-temp'},
        {id:'sub-bearn',   name:'Béarnaise',           price:0},
        {id:'sub-chimich', name:'Chimichurri',         price:0},
        {id:'sub-nosace',  name:'No sauce',            price:0},
      ]},
    { id:'mgd-sauce-temp',   name:'Sauce preference',   min:0, max:1,
      options:[
        {id:'sub-st-hot',  name:'Served hot',          price:0},
        {id:'sub-st-side', name:'On the side',         price:0},
      ]},
    { id:'mgd-pizza-extras', name:'Pizza extras',       min:0, max:5,
      options:[
        {id:'sub-extra-ch',  name:'Extra cheese',      price:1.5},
        {id:'sub-extra-pep', name:'Extra pepperoni',   price:1.5},
        {id:'sub-truffle',   name:'Truffle oil',       price:3.0},
      ]},
    { id:'mgd-milk',         name:'Milk choice',        min:1, max:1,
      options:[
        {id:'sub-whole',   name:'Whole milk',          price:0},
        {id:'sub-oat',     name:'Oat milk',            price:0.5},
        {id:'sub-almond',  name:'Almond milk',         price:0.5},
        {id:'sub-soy',     name:'Soy milk',            price:0.5},
      ]},
  ] : [],
  // Helper: persist a modifier group to Supabase (upsert by id).
  // Returns true on success, false on failure — callers that need to know
  // (the item-rename cascade) check it; existing callers ignore it.
  // v5.5.834: was a raw fetch() that sent the ANON KEY as the bearer token, so the
  // 13 Jul RLS lock (20260713f) 403'd every write — see db.upsertModifierGroup for
  // the full story. Now goes through the authenticated client like every other
  // writer in the app.
  _saveModGroup: async (group) => {
    if (isMock) return true;
    try {
      const { error } = await upsertModifierGroup(group);
      reportSave('modifier group', error);   // v5.5.971 — toast alone; now raises the banner too
      if (error) { console.warn('modifier group save failed:', error.message); return false; }
      return true;
    } catch (e) {
      reportSave('modifier group', e);
      console.warn('modifier group save failed', e); return false;
    }
  },

  // v5.5.834: a failed modifier-group write must be VISIBLE. The old code
  // console.warn'd and moved on, so the optimistic set() above it showed "saved"
  // while the DB never changed — the operator only found out on the next refresh,
  // which is what turned a hard regression into "a mysterious intermittent thing".
  _saveModGroupOrWarn: (group) => {
    useStore.getState()._saveModGroup(group).then(ok => {
      if (!ok) useStore.getState().showToast?.(`"${group?.name || 'Modifier group'}" was NOT saved — your change is only on this screen. Check you're signed in, then try again`, 'error');
    });
  },

  addModifierGroupDef: g => {
    const newGroup = { id: `mgd-${Date.now()}`, ...g };
    set(s => ({ modifierGroupDefs: [...s.modifierGroupDefs, newGroup] }));
    useStore.getState()._saveModGroupOrWarn(newGroup);
  },
  updateModifierGroupDef: (id, patch) => set(s => {
    const updated = s.modifierGroupDefs.map(g => g.id === id ? { ...g, ...patch } : g);
    const group = updated.find(g => g.id === id);
    if (group) useStore.getState()._saveModGroupOrWarn(group);
    return { modifierGroupDefs: updated };
  }),
  updateModifierGroupOption: (groupId, optId, patch) => set(s => {
    const updated = s.modifierGroupDefs.map(g =>
      g.id === groupId ? { ...g, options: (g.options||[]).map(o => o.id===optId ? { ...o, ...patch } : o) } : g
    );
    const group = updated.find(g => g.id === groupId);
    if (group) useStore.getState()._saveModGroupOrWarn(group);
    return { modifierGroupDefs: updated };
  }),
  removeModifierGroupDef: id => {
    const removed = useStore.getState().modifierGroupDefs.find(g => g.id === id);
    set(s => ({ modifierGroupDefs: s.modifierGroupDefs.filter(g => g.id !== id) }));
    if (isMock) return;
    // v5.5.834: authenticated client + a location_id filter (the old raw fetch
    // deleted on id ALONE — cross-tenant hazard) + a VISIBLE failure. The old
    // .catch(() => {}) meant a 403'd delete looked done until the group came
    // straight back on the next refresh.
    const warn = () => useStore.getState().showToast?.(`"${removed?.name || 'Modifier group'}" was NOT deleted — it will come back on refresh. Check you're signed in, then try again`, 'error');
    deleteModifierGroup(id)
      .then(({ error }) => {
        reportSave('modifier group delete', error);   // v5.5.971
        if (error) {
          console.warn('modifier group delete failed:', error.message);
          // Put it back — the row still exists and returns on the next refresh.
          if (removed) set(s => (s.modifierGroupDefs.some(g => g.id === id) ? {} : { modifierGroupDefs: [...s.modifierGroupDefs, removed] }));
          warn();
        }
      })
      .catch(e => {
        reportSave('modifier group delete', e);
        console.warn('modifier group delete failed', e);
        if (removed) set(s => (s.modifierGroupDefs.some(g => g.id === id) ? {} : { modifierGroupDefs: [...s.modifierGroupDefs, removed] }));
        warn();
      });
  },
  reorderModifierGroupDefs: (fromIdx, toIdx) => set(s => {
    const arr = [...s.modifierGroupDefs];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    // v5.5.834: RETURN the remapped array. Previously the DB was written with the
    // new sortOrder while the store kept every group's STALE one, so store and DB
    // disagreed about the order until the next boot re-read.
    const remapped = arr.map((g, i) => ({ ...g, sortOrder: i }));
    // One toast for the whole reorder, not one per group.
    const warn = () => useStore.getState().showToast?.('Modifier group order was NOT saved — check you\'re signed in, then try again', 'error');
    Promise.all(remapped.map(g => useStore.getState()._saveModGroup(g)))
      .then(results => { if (results.some(r => r === false)) warn(); })
      .catch(warn);
    return { modifierGroupDefs: remapped };
  }),

  // ── Instruction groups — preparation instructions (no price change) ────────
  // These DON'T change the price. e.g. "Cooking preference: Rare / Medium / Well done"
  instructionGroupDefs: [
    { id:'igd-cook-temp', name:'Cooking preference',
      options:['Rare','Medium rare','Medium','Medium well','Well done'] },
    { id:'igd-bread',     name:'Bread service',
      options:['With bread','No bread','Gluten-free bread (+£1)'] },
    { id:'igd-spice',     name:'Spice level',
      options:['Mild','Medium','Hot','Extra hot'] },
    { id:'igd-allergen',  name:'Allergy note',
      options:['Gluten-free option please','Dairy-free please','Nut allergy — check with kitchen','Speak to server'] },
  ],
  addInstructionGroupDef: g => set(s => ({ instructionGroupDefs:[...s.instructionGroupDefs,{id:`igd-${Date.now()}`,...g}] })),
  updateInstructionGroupDef: (id,patch) => set(s => ({ instructionGroupDefs:s.instructionGroupDefs.map(g=>g.id===id?{...g,...patch}:g) })),
  removeInstructionGroupDef: id => set(s => ({ instructionGroupDefs:s.instructionGroupDefs.filter(g=>g.id!==id) })),
  reorderInstructionGroupDefs: (fromIdx, toIdx) => set(s => {
    const arr = [...s.instructionGroupDefs];
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    return { instructionGroupDefs: arr };
  }),

  // ── Menu items — full enhanced model ─────────────────────────────────────────
  //
  // Triple naming:  menuName | receiptName | kitchenName
  // Pricing:        per order type (dineIn / takeaway / collection / delivery)
  //                 null = use base price for that channel
  // Scope:          local | shared | global
  // Routing:        productionCentreId (null = inherit from category), course
  // Type:           simple | modifiers | variants | pizza | bundle
  // Visibility:     { pos, kiosk, online, onlineDelivery }
  //
  // Quick Screen — list of item IDs shown on the ⚡ Quick tab, ordered
  quickScreenIds: isMock ? QUICK_IDS : [],
  // v5.5.962 Smart Quick Screen: 'manual' = pins only (default), 'auto' = best
  // sellers for the current daypart, 'hybrid' = pins first + best-seller fill.
  // quickScreenAuto = { computed_at, days, lists: { breakfast/lunch/dinner/late: [ids] } }
  // — computed in Back Office from closed_checks, stored on locations, read-only here.
  quickScreenMode: 'manual',
  quickScreenAuto: null,
  locationConfig: { timezone: 'Europe/London', businessDayStart: '06:00', shifts: [] },
  taxRates: [],
  discountPresets: [],   // from discounts table — manual presets staff can apply
  discountRules: [],     // from discount_rules table — auto-discount rules
  setQuickScreenIds: (ids) => set({ quickScreenIds: ids }),
  setQuickScreenMode: (m) => set({ quickScreenMode: m }),
  setQuickScreenAuto: (a) => set({ quickScreenAuto: a }),

  menuItems: (isMock ? MENU_ITEMS : []).map((item, idx) => ({
    ...item,
    sortOrder: item.sortOrder ?? idx,  // assign sequential sortOrder if not set
    menuName:    item.menuName    || item.name,
    receiptName: item.receiptName || item.name,
    kitchenName: item.kitchenName || item.name,
    scope: item.scope || 'local',
    // Per-order-type pricing (replaces per-menu pricing)
    pricing: item.pricing || {
      base:       item.price || 0,
      dineIn:     null,   // null = use base
      takeaway:   null,
      collection: null,
      delivery:   null,
    },
    productionCentreId: item.centreId || null,
    course: item.course || null,
    instructions: item.instructions || '',
    image: item.image || null,
    tags: item.tags || [],
    visibility: item.visibility || { pos:true, kiosk:true, online:true, onlineDelivery:true },
  })),

  updateMenuItem: (id, patch) => {
    set(s => {
      // DUPLICATE-NAME GUARD (v5.5.797) — refuse a rename that would give two
      // live top-level products the same (trimmed, case-insensitive) name.
      // The BO editors pre-check and show their own visible errors; this is
      // the choke-point backstop so no caller can persist a duplicate. Only
      // fires when the display name actually CHANGES — pre-existing
      // duplicates stay editable (price etc.) until someone renames them.
      {
        const cur = s.menuItems.find(i => i.id === id);
        if (cur) {
          const pick = (camel, snake, fallback) =>
            (camel in patch) ? patch[camel] : (snake in patch) ? patch[snake] : fallback;
          const nextDisplay = pick('menuName', 'menu_name', cur.menuName) || ('name' in patch ? patch.name : cur.name) || '';
          const norm = v => String(v || '').trim().toLowerCase();
          const resParent = 'parentId' in patch ? patch.parentId : cur.parentId;
          const resType   = ('type' in patch ? patch.type : cur.type) || 'simple';
          if (norm(nextDisplay) && norm(nextDisplay) !== norm(cur.menuName || cur.name)
              && !resParent && !['subitem','spacer'].includes(resType)
              && !cur.archived && !patch.archived) {
            const dup = findDuplicateProductName(s.menuItems, nextDisplay, id);
            if (dup) {
              console.warn(`[store] updateMenuItem blocked: a product called "${nextDisplay}" already exists (${dup.id})`);
              return {};
            }
          }
        }
      }
      let items = s.menuItems.map(item => {
        if (item.id !== id) return item;
        const updated = { ...item, ...patch };
        if (patch.modifierGroups !== undefined && !['subitem','variants','combo','pizza'].includes(updated.type)) {
          updated.type = patch.modifierGroups?.length > 0 ? 'modifiable' : 'simple';
        }
        // v5.5.797: AUTO-MODIFIABLE — the BO editor attaches modifier groups
        // via assignedModifierGroups (NOT the legacy modifierGroups field
        // above), so the auto-type flip never fired and the till skipped the
        // options screen for those products (POSSurface needsModal hard-skips
        // type='simple'). A top-level product with groups attached and still
        // on the plain type flips to 'modifiable' on any save; emptying the
        // attach list flips it back (unless instruction groups still need the
        // modal). Never overrides an explicit type in the same patch and
        // never touches subitem/variants/combo/pizza/spacer types.
        if (!('type' in patch) && !updated.parentId) {
          const t = updated.type || 'simple';
          const nMods = updated.assignedModifierGroups?.length || 0;
          const nInst = updated.assignedInstructionGroups?.length || 0;
          if (t === 'simple' && nMods > 0) updated.type = 'modifiable';
          else if (t === 'modifiable' && nMods === 0 && nInst === 0 && patch.assignedModifierGroups !== undefined) updated.type = 'simple';
        }
        return updated;
      });
      if (patch.parentId) {
        items = items.map(item => {
          if (item.id !== patch.parentId || item.type === 'subitem') return item;
          return { ...item, type: 'variants' };
        });
      }
      if ('parentId' in patch && !patch.parentId) {
        const oldParentId = s.menuItems.find(i => i.id === id)?.parentId;
        if (oldParentId) {
          const remainingChildren = items.filter(i => i.parentId === oldParentId && i.id !== id && !i.archived);
          if (remainingChildren.length === 0) {
            items = items.map(item => item.id === oldParentId ? { ...item, type: 'simple' } : item);
          }
        }
      }
      // Write the FULL updated item to Supabase (not just the patch)
      const fullItem = items.find(i => i.id === id);
      if (fullItem) {
        upsertMenuItem(fullItem);
      }

      // v5.5.261: VARIANT INHERITANCE CASCADE — when certain parent fields
      // change, push them to every child variant. Variants are just sizes of
      // the same product — they must share category, allergens, tax rate, KDS
      // centre, and secondary categories with their parent. Without this,
      // moving a product to a new category (or editing allergens, tax, etc.)
      // leaves variants with stale data, breaking reports, stamp cards, KDS
      // routing, compliance, and more.
      const CASCADE_FIELDS = ['cat', 'cats', 'allergens', 'taxRateId', 'taxOverrides', 'centreId'];
      const hasCascade = CASCADE_FIELDS.some(f => f in patch);
      if (hasCascade && fullItem && !fullItem.parentId) {
        const cascadePatch = {};
        CASCADE_FIELDS.forEach(f => { if (f in patch) cascadePatch[f] = fullItem[f]; });
        const childIds = [];
        items = items.map(i => {
          if (i.parentId !== id) return i;
          // Only update children that actually differ
          const needsUpdate = Object.keys(cascadePatch).some(f =>
            JSON.stringify(i[f]) !== JSON.stringify(cascadePatch[f])
          );
          if (!needsUpdate) return i;
          childIds.push(i.id);
          return { ...i, ...cascadePatch };
        });
        // Persist each updated child to Supabase
        if (childIds.length > 0) {
          childIds.forEach(cid => {
            const child = items.find(i => i.id === cid);
            if (child) upsertMenuItem(child);
          });
        }
      }

      // RENAME CASCADE — if the display name changed, walk modifier_groups
      // and update any option that references this menu_item, so the picker
      // labels (and the cart-line mod entries built from them) reflect the
      // new name. Options link three ways:
      //   1. opt.itemId === item.id — the primary linkage (BO "add item as
      //      option" sets it; also how the kiosk 86-check resolves).
      //   2. Legacy composite ids of the form "opt-NNN-m-<menu_item_id>" —
      //      match on the m-<id> tail (only works for m-* item ids).
      //   3. No itemId at all — the resolveOptItemId name-match fallback.
      //      Rename those whose name matches the OLD item name (same
      //      trim+lowercase normalisation) so the 86 fallback keeps working.
      const nameChanged = (
        ('menuName' in patch && patch.menuName !== undefined) ||
        ('name'     in patch && patch.name     !== undefined) ||
        ('menu_name' in patch && patch.menu_name !== undefined)
      ) && fullItem;
      if (nameChanged) {
        const prevItem = s.menuItems.find(i => i.id === id);
        const oldName = prevItem ? (prevItem.menuName || prevItem.name || '') : '';
        const oldKey = String(oldName).trim().toLowerCase();
        const newName = fullItem.menuName || fullItem.name || 'Item';
        const idTail = `-m-${id.replace(/^m-/, '')}`;
        let touched = 0;
        const updatedGroups = s.modifierGroupDefs.map(g => {
          if (!Array.isArray(g.options) || g.options.length === 0) return g;
          let groupChanged = false;
          const newOptions = g.options.map(o => {
            const optItemId = o.itemId || o.item_id || null;
            const matchesId = optItemId === id
              || o.id === id
              || (typeof o.id === 'string' && o.id.endsWith(idTail))
              || (!optItemId && oldKey && String(o.name || '').trim().toLowerCase() === oldKey);
            if (!matchesId) return o;
            if (o.name === newName) return o;
            groupChanged = true;
            touched++;
            return { ...o, name: newName };
          });
          return groupChanged ? { ...g, options: newOptions } : g;
        });
        if (touched > 0) {
          // Persist every group whose options changed (rare, so the parallel
          // saves are bounded). A group-save failure must NEVER fail the item
          // save — warn so the operator knows to re-check the modifier lists.
          const saves = [];
          updatedGroups.forEach((g, i) => {
            if (g !== s.modifierGroupDefs[i]) saves.push(useStore.getState()._saveModGroup(g));
          });
          Promise.all(saves).then(results => {
            if (results.some(r => r === false)) {
              useStore.getState().showToast?.('Item saved — modifier lists may need a manual refresh', 'warning');
            }
          }).catch(() => {
            useStore.getState().showToast?.('Item saved — modifier lists may need a manual refresh', 'warning');
          });
          return { menuItems: items, modifierGroupDefs: updatedGroups };
        }
      }
      return { menuItems: items };
    });
  },
  addMenuItem: item => {
    const base = item.price || item.basePrice || 0;
    const isSubitem = item.type === 'subitem';
    // DUPLICATE-NAME GUARD (v5.5.797) — a live top-level product may not share
    // a (trimmed, case-insensitive) name with another. Refuse + return null;
    // callers surface the visible error (store toasts don't render in BO).
    if (!item.parentId && !['subitem','spacer'].includes(item.type || 'simple') && !item.archived) {
      const dup = findDuplicateProductName(useStore.getState().menuItems, item.menuName || item.name);
      if (dup) {
        console.warn(`[store] addMenuItem blocked: a product called "${item.menuName || item.name}" already exists (${dup.id})`);
        return null;
      }
    }
    const newItem = {
      id:`m-${Date.now()}`, scope:'local', instructions:'', image:null, tags:[],
      // Subitems are hidden from POS/kiosk/online by default - they only appear in modifier groups
      visibility: isSubitem
        ? { pos:false, kiosk:false, online:false, onlineDelivery:false }
        : (item.visibility || { pos:true, kiosk:true, online:true, onlineDelivery:true }),
      sortOrder: useStore.getState().menuItems.length,
      ...item,
      menuName:    item.menuName    || item.name || 'New item',
      receiptName: item.receiptName || item.name || 'New item',
      kitchenName: item.kitchenName || item.name || 'New item',
      pricing: item.pricing || { base, dineIn:null, takeaway:null, collection:null, delivery:null },
    };
    // v5.5.797: AUTO-MODIFIABLE on create — a top-level product born with
    // modifier groups attached (clone, import, AI add) and the plain type
    // must be 'modifiable' or the till skips its options screen.
    if (!newItem.parentId && (newItem.type || 'simple') === 'simple' && (newItem.assignedModifierGroups?.length > 0)) {
      newItem.type = 'modifiable';
    }
    // v5.5.961: new products are born with the venue's default tax rate stamped on
    // (same resolution as lib/tax.js), so pricing before/after setting up tax rates
    // never leaves items untaxed. An explicit taxRateId from the caller wins.
    if (!newItem.taxRateId && newItem.type !== 'spacer') {
      const def = (useStore.getState().taxRates || []).find(r => (r.isDefault || r.is_default) && r.active !== false);
      if (def) newItem.taxRateId = def.id;
    }
    set(s => ({ menuItems: [...s.menuItems, newItem] }));
    upsertMenuItem(newItem);
    return newItem;
  },

  // Get effective price for an order type
  // v4.7.7: per-menu pricing tiers. Resolution order:
  //   1. p.menus[menuId][channel]   — menu-specific channel price (e.g. Deliveroo takeaway)
  //   2. p.menus[menuId].all        — menu-wide flat (applies to every channel for this menu)
  //   3. p[channel]                 — channel default (the existing dineIn/takeaway/collection/delivery)
  //   4. p.base                     — fallback
  // Backward compatible: callers passing (item, orderType) still work — menuId is optional.
  getItemPrice: (item, orderType = 'dineIn', menuId = null) => {
    const p = item?.pricing;
    if (!p) return item?.price || 0;
    const MAP = { 'dine-in':'dineIn', 'takeaway':'takeaway', 'collection':'collection', 'delivery':'delivery', 'dineIn':'dineIn' };
    const key = MAP[orderType] || 'dineIn';
    // 1+2: menu-specific tier, if set
    if (menuId && p.menus && p.menus[menuId]) {
      const tier = p.menus[menuId];
      if (tier[key] !== null && tier[key] !== undefined) return tier[key];
      if (tier.all  !== null && tier.all  !== undefined) return tier.all;
    }
    // 3+4: channel default → base
    return (p[key] !== null && p[key] !== undefined) ? p[key] : (p.base || 0);
  },

  // Reorder items within a category
  reorderMenuItems: (catId, fromIdx, toIdx) => {
    set(s => {
      const catItems = s.menuItems.filter(i => i.cat === catId).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
      const others   = s.menuItems.filter(i => i.cat !== catId);
      const moved    = [...catItems];
      const [item]   = moved.splice(fromIdx, 1);
      moved.splice(toIdx, 0, item);
      const reindexed = moved.map((it, idx) => ({ ...it, sortOrder: idx }));
      return { menuItems: [...others, ...reindexed] };
    });
  },

  // Reorder categories
  reorderCategories: (fromIdx, toIdx) => {
    set(s => {
      const cats = [...s.menuCategories];
      const [cat] = cats.splice(fromIdx, 1);
      cats.splice(toIdx, 0, cat);
      const reindexed = cats.map((c, idx) => ({ ...c, sortOrder: idx }));
      return { menuCategories: reindexed };
    });
  },
  duplicateMenuItem: id => {
    const source = useStore.getState().menuItems.find(i => i.id === id);
    if (!source) return;
    const dupe = { ...source, id:`m-${Date.now()}`, menuName:`${source.menuName} (copy)`, receiptName:`${source.receiptName} (copy)`, kitchenName:`${source.kitchenName} (copy)` };
    set(s => ({ menuItems: [...s.menuItems, dupe] }));
  },
  // v5.5.971: was two fire-and-forget .then(console.error) writes behind an optimistic
  // set() — the archive looked done and came straight back on the next refresh. Now
  // awaited, reported to saveHealth, and REVERTED locally when the DB refuses.
  archiveMenuItem: async id => {
    // v5.5.261: CASCADE — archiving a parent also archives all its variants.
    // Orphaned variants with no parent would break the menu display and create
    // ghost items that appear in reports but not on the POS.
    const _target = useStore.getState().menuItems.find(i => i.id === id);
    const itemName = _target?.menuName || _target?.name || 'Item';
    let flippedChildIds = [];
    set(s => {
      const target = s.menuItems.find(i => i.id === id);
      const childIds = target && !target.parentId
        ? s.menuItems.filter(i => i.parentId === id && !i.archived).map(i => i.id)
        : [];
      flippedChildIds = childIds;
      return {
        menuItems: s.menuItems.map(item => {
          if (item.id === id) return { ...item, archived: true };
          if (childIds.includes(item.id)) return { ...item, archived: true };
          return item;
        }),
      };
    });
    if (isMock) return true;
    // Only un-archive the rows THIS call flipped — anything already archived
    // before we started must stay archived.
    const unarchive = (ids) => set(s => ({
      menuItems: s.menuItems.map(it => ids.includes(it.id) ? { ...it, archived: false } : it),
    }));
    // v5.5.279: location_id guard on archive operations. Fall back to the async
    // resolve (same as archiveVariantRow) — with the 0-row check below, an
    // unresolved sync cache would otherwise read as a refused archive.
    const locId = getActiveLocationSync() || await getLocationId().catch(() => null);
    const patch = { archived: true, parent_id: null, updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('menu_items')
      .update(patch)
      .eq('id', id)
      .eq('location_id', locId)
      .select('id');
    // An update that matched NO rows comes back as a plain success with an empty body —
    // an RLS refusal, or a row scoped to another location, reads exactly like a save, and
    // the caller toasts "Archived" for an item still selling on every till. Ask for the id
    // back and treat nothing as the failure it is.
    const err = error || (!data?.length
      ? new Error('Item archive matched 0 rows — RLS blocked it or the row is scoped to another location')
      : null);
    reportSave('item archive', err);
    if (err) {
      unarchive([id, ...flippedChildIds]);
      useStore.getState().showToast?.(`"${itemName}" was NOT archived — it will come back on refresh. Check you're signed in, then try again`, 'error');
      return false;
    }
    // Archive children in DB too
    const children = useStore.getState().menuItems.filter(i => i.parentId === id);
    if (children.length > 0) {
      const { data: childRows, error: childErr } = await supabase.from('menu_items')
        .update(patch)
        .in('id', children.map(c => c.id))
        .eq('location_id', locId)
        .select('id');
      const cErr = childErr || (!childRows?.length
        ? new Error('Variant archive matched 0 rows — RLS blocked it or the rows are scoped to another location')
        : null);
      reportSave('item archive (variants)', cErr);
      if (cErr) {
        // The parent DID archive, so only the variants are rolled back.
        unarchive(flippedChildIds);
        useStore.getState().showToast?.(`"${itemName}" was archived but its variants were NOT — they will reappear on refresh`, 'error');
        return false;
      }
    }
    return true;
  },

  // ── Editable floor plan ────────────────────────────────────────────────────
  // Tables state already exists in `tables` — floor plan builder just edits positions
  updateTableLayout: (id, patch) => {
    set(s => ({ tables: s.tables.map(t => t.id===id ? { ...t, ...patch } : t) }));
    // v4.6.6 Bug: must upsert the FULL merged table, not { id, ...patch }. upsertFloorTable
    // builds a row from scratch and defaults every column that isn't passed in
    // (w/h→80, shape→'rect', section→null, label→undefined, max_covers→4, ...). Passing a
    // partial patch like {x,y} from a drag wiped label/size/shape/section on every mousemove,
    // so after a refresh every table came back as an 80×80 unlabelled rect with no section —
    // visually stacked/overlapping. Read the freshly-merged table and upsert the full object.
    const full = useStore.getState().tables.find(t => t.id === id);
    if (full) upsertFloorTable(full);
  },
  addTableToLayout: async (table) => {
    // v5.5.2: stamp locationId at creation time so the cross-location guard in upsertFloorTable
    // has data to work with from the very first upsert. Without this, a brand-new table has no
    // locationId and the guard can't tell whether subsequent moves are legitimate.
    let locId = null;
    try { locId = getActiveLocationSync() || await getLocationId(); } catch {}
    const wantLoc = table.locationId || locId || null;
    // v5.5.739: table labels must be unique per location — a duplicate "number" breaks seating,
    // session sync (matched by table) and reports. Backstop the UI guard here so no path creates one.
    const norm = (s) => String(s || '').trim().toLowerCase();
    const dup = useStore.getState().tables.some(t =>
      !t.parentId && norm(t.label) === norm(table.label) &&
      (!t.locationId || !wantLoc || t.locationId === wantLoc));
    if (dup) {
      useStore.getState().showToast?.(`Table “${String(table.label || '').trim()}” already exists`, 'error');
      return;
    }
    const newTable = { id:`t-${Date.now()}`, status:'available', session:null, locationId: locId, ...table };
    // If caller passed an explicit locationId in `table`, that wins (spread above).
    set(s => ({ tables: [...s.tables, newTable] }));
    upsertFloorTable(newTable);
  },
  removeTableFromLayout: (id) => {
    // v5.5.2: pull the table's locationId BEFORE we filter it out of state, so the DB delete
    // can be scoped to that exact location (defense against the cross-location-leak class).
    const tbl = useStore.getState().tables.find(t => t.id === id);
    const locId = tbl?.locationId || null;
    const removed = useStore.getState().tables.filter(t => t.id === id || t.parentId === id);
    set(s => ({ tables: s.tables.filter(t => t.id!==id && t.parentId!==id) }));
    // v4.6.5 Bug 6: previously removed from local state only, so it re-appeared on every boot.
    // v5.5.971: PostgREST returns { error } on a RESOLVED promise, so the old
    // .catch()-only handler never saw an RLS refusal — the table vanished from the
    // screen and came back on the next boot. Report the outcome, not just throws.
    const failed = (err) => {
      reportSave('table delete', err);
      // Put them back — the rows still exist and WILL reappear at next boot.
      set(s => ({ tables: [...s.tables, ...removed.filter(r => !s.tables.some(t => t.id === r.id))] }));
      useStore.getState().showToast?.(`"${tbl?.label || 'Table'}" was NOT deleted — check you're signed in, then try again`, 'error');
    };
    Promise.resolve(deleteFloorTable(id, locId))
      .then(({ error }) => { if (error) failed(error); else reportSave('table delete', null); })
      .catch(e => { console.warn('[removeTableFromLayout] DB delete failed:', e?.message || e); failed(e); });
  },

  // ── Tables (source of truth for all orders) ──────────
  tables: isMock ? buildInitialTables() : [],

  // Helper to update a single table
  _updateTable: (id, patch) => set(s => ({ tables: s.tables.map(t => t.id===id ? { ...t, ...patch } : t) })),

  // Seat a table: create session, go to POS
  // v5.7.21: optional `booking` — the seated booking's identity + captured
  // prepay/deposit credit (minor units), stamped on the session so the POS
  // shows "Package X PAID" from seating and CheckoutModal applies the money
  // as a tender leg at close. Rides the session jsonb into active_sessions,
  // so it survives cross-device pickup like everything else on the session.
  seatTable: (tableId, { covers, server, customer, booking = null } = {}) => {
    // v4.6.67: pull the existing reservation's customer (if any) into the session
    // so the dine-in flow attributes loyalty automatically. v5.5.x: an explicit
    // `customer` (e.g. from Tables Ready seating a waitlist party) takes precedence —
    // this carries the guest's phone/profile onto the table so checkout can trigger
    // the loyalty flow (or use their existing membership) automatically.
    const tbl = get().tables.find(t => t.id === tableId);
    const seatCustomer = customer || tbl?.reservation?.customer || null;
    const session = {
      id: `ORD-${++_orderNum}`,
      items: [], firedCourses: [],
      sentAt: null, covers, server,
      seatedAt: Date.now(), note: '', orderNote: '',
      subtotal: 0, total: 0,
      customer: seatCustomer,
      ...(booking ? { booking } : {}),
    };
    get()._updateTable(tableId, { status:'open', session, reservation:null });
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
    // Auto-apply the customer's stored allergens (if any) on next visit.
    if (seatCustomer?.allergens?.length) {
      set({ allergens: [...seatCustomer.allergens] });
      get().showToast?.(`Allergen filter applied — ${seatCustomer.name} is allergic to ${seatCustomer.allergens.join(', ')}`, 'info');
    }
  },

  // Seat a table AND pre-populate its session with walk-in items.
  // v5.6.27: optional customer (bookings hand the guest across so dine-in
  // checkout gets loyalty + allergens, exactly like seatTable).
  // v5.7.21: optional `booking` — same contract as seatTable above.
  seatTableWithItems: (tableId, items, { covers, server, customer = null, booking = null }) => {
    const now = Date.now();
    const session = {
      id: `ORD-${++_orderNum}`,
      items: items.map(i => ({ ...i, status:'pending' })),
      firedCourses: [], sentAt: null, covers, server,
      seatedAt: now, note: '', orderNote: '',
      subtotal: items.reduce((s,i)=>s+i.price*i.qty, 0),
      total: items.reduce((s,i)=>s+i.price*i.qty, 0) * 1.125,
      ...(customer ? { customer } : {}),
      ...(booking ? { booking } : {}),
    };
    get()._updateTable(tableId, { status:'open', session, reservation:null });
    if (customer?.allergens?.length) {
      set({ allergens: [...customer.allergens] });
      get().showToast?.(`Allergen filter applied — ${customer.name} is allergic to ${customer.allergens.join(', ')}`, 'info');
    }
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in', walkInOrder:null, customer:null });
    get().showToast(`Items moved to ${get().tables.find(t=>t.id===tableId)?.label}`, 'success');
  },

  // Merge walk-in items into an already-occupied table
  mergeItemsToTable: (tableId, newItems) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = [...t.session.items, ...newItems.map(i=>({...i, status:'pending'}))];
        const subtotal = items.reduce((s,i)=>s+i.price*i.qty, 0);
        return { ...t, session: { ...t.session, items, subtotal, total: subtotal*1.125 } };
      }),
      walkInOrder: null, customer: null,
    }));
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
    get().showToast(`Items merged into ${get().tables.find(t=>t.id===tableId)?.label}`, 'success');
  },

  // Split a table — create a child table (T1.2) with the given items
  splitTableCheck: (parentTableId, splitItems, staffName) => {
    const parent = get().tables.find(t => t.id === parentTableId);
    if (!parent) return;

    // Determine child label: T1 → T1.2, T1.2 → T1.3, etc.
    const existingChildren = get().tables.filter(t => t.parentId === parentTableId);
    const checkNum = existingChildren.length + 2;
    const childLabel = `${parent.label}.${checkNum}`;
    const childId = `${parentTableId}-${checkNum}`;

    const childSession = {
      id: `ORD-${++_orderNum}`,
      items: splitItems.map(i => ({...i, status:'pending'})),
      firedCourses: [], sentAt: null,
      covers: parent.session?.covers || 2,
      server: staffName || parent.session?.server || 'Server',
      seatedAt: Date.now(), note: '', orderNote: '',
      subtotal: splitItems.reduce((s,i)=>s+i.price*i.qty, 0),
      total: splitItems.reduce((s,i)=>s+i.price*i.qty, 0) * 1.125,
    };

    // Remove split items from parent
    const parentItems = (parent.session?.items || []).filter(
      pi => !splitItems.some(si => si.uid === pi.uid)
    );
    const parentSub = parentItems.reduce((s,i)=>s+i.price*i.qty, 0);

    // Child table — same position as parent, flagged virtual
    const childTable = {
      ...parent,
      id: childId,
      label: childLabel,
      parentId: parentTableId,
      status: 'open',
      session: childSession,
      reservation: null,
    };

    set(s => ({
      tables: [
        ...s.tables.map(t => {
          if (t.id !== parentTableId) return t;
          const session = { ...t.session, items: parentItems, subtotal: parentSub, total: parentSub*1.125 };
          return { ...t, session, childIds: [...(t.childIds||[]), childId] };
        }),
        childTable,
      ],
      walkInOrder: null, customer: null,
      activeTableId: childId, surface: 'pos', orderType: 'dine-in',
    }));
    get().showToast(`Check 2 created — ${childLabel}`, 'success');
  },

  // Open an already-seated table (go to its POS)
  openTableInPOS: (tableId) => {
    // A QR open-tab carries a held card pre-auth that ONLY OrdersHub force-close can capture. Opening
    // it in the POS to take a fresh payment would DOUBLE-charge (new charge + uncaptured hold) and the
    // close would write a source-less, un-cleaned check. Redirect to Orders Hub instead.
    const t = get().tables.find(x => x.id === tableId);
    if (t?.session?.source === 'qr') {
      get().showToast('QR tab — close it from Orders Hub → Open QR tabs (captures the card hold + saves to history)', 'info');
      return;
    }
    set({ activeTableId:tableId, surface:'pos', orderType:'dine-in' });
  },

  // Save a table session without sending to kitchen — creates session if needed (seats the table)
  saveTableSession: (tableId, covers) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId) return t;
        const session = t.session || {
          id: `ORD-${++_orderNum}`,
          items: [], firedCourses: [], sentAt: null,
          covers: covers || 2,
          server: s.staff?.name || 'Staff',
          seatedAt: Date.now(),
          note: '', orderNote: '', subtotal: 0, total: 0,
        };
        // Update covers if changed
        const updatedSession = { ...session, covers: covers || session.covers };
        return { ...t, status: 'occupied', session: updatedSession };
      }),
    }));
  },

  // Close / clear a table after payment
  clearTable: (tableId, paymentInfo = {}) => {
    // QR open-tabs MUST be closed via OrdersHub force-close (captures the held pre-auth, writes a
    // source='qr' closed_check, marks the order_queue rounds collected + clears the session). The
    // floor-plan close path (recordClosedCheck) is QR-blind — it would lose the capture, write a
    // source-less check and orphan the queue/session. Block it and point the operator to Orders Hub.
    const qrTable = get().tables.find(t => t.id === tableId);
    if (qrTable?.session?.source === 'qr') {
      get().showToast('QR tab — close it from Orders Hub → Open QR tabs (captures the card hold + saves to history)', 'info');
      return;
    }
    // v5.5.792: PAYING MUST GUARANTEE PRODUCTION. If the check being paid still has
    // lines the kitchen never fired (never sent, or sent-but-held courses), fire them
    // ALL now in one combined send — course holds ignored, the customer is paying.
    // Gated on a real payment (method present) so a manual table clear/void never
    // fires the kitchen. Lines already sent+fired are excluded (no double-fire).
    // KDS insert / print / queue writes are training-gated at the leaf fns.
    if (paymentInfo?.method) {
      const closing = get().tables.find(t => t.id === tableId);
      const hasUnfired = closing?.session?.items?.some(i =>
        !i.voided && (i.status === 'pending' || (i.status === 'sent' && !i.fired)));
      if (hasUnfired) get().sendToKitchen({ fireAll: true, tableId });
    }
    // v5.5.851: closing the check by ANY tender cancels a terminal job still live for
    // it. Live wedge this fixes: staff sent the bill to the PAX, customer paid cash
    // instead, staff cashed off — the claimed job then held BOTH the reader and the
    // POS panel forever. The pax path itself can't self-cancel here: PaxTerminal
    // forgets its handle BEFORE complete() runs, so recallJob finds nothing. And
    // terminal_job_cancel is safe by construction — the server refuses the moment a
    // card may have been charged, so a mid-charge job is never yanked.
    try {
      const _locId = getActiveLocationSync();
      const _sess = get().tables.find(t => t.id === tableId)?.session;
      const _key = buildCheckKey({ locationId: _locId, tableId, sessionId: _sess?.id });
      const _handle = recallJob(_key);
      if (_handle?.jobId) {
        const _jobId = _handle.jobId;
        // v5.5.903: that job may have DEBITED A GIFT CARD when it was dispatched — the
        // PAX path commits at dispatch, not at close (CheckoutModal.startTerminalJob).
        // Cancelling it leaves the debit with no check to live on, so it has to go back
        // on the card. EXCEPT where the check we are recording instead legitimately
        // claims the same leg (staff backed out to cash, and the idempotent re-commit
        // booked it here): reversing that one would hand the customer the goods AND
        // their balance back.
        const _claimedKeys = giftLegs({ giftCard: giftRecordFrom(paymentInfo) })
          .map(g => g?.idempotency_key).filter(Boolean);
        cancelTerminalJob(_jobId)
          .then(r => {
            // ONLY a server-confirmed cancel proves no card was charged. A refusal
            // (ALREADY_CAPTURED, or mid-charge) means the sale may still settle and be
            // closed by the reconciler WITH that gift leg recorded on it — never
            // reverse on a refusal, or the card is credited for a check that kept it.
            if (!r?.ok) { console.warn('[clearTable] terminal job not cancellable:', r?.reason || r?.status); return undefined; }
            return get()._reverseTerminalJobGift(_jobId, _claimedKeys, 'Card machine payment cancelled at the till');
          })
          .catch(() => {});
        forgetJob(_key);
      }
    } catch { /* never block a cash-off on cleanup */ }
    get().recordClosedCheck(tableId, paymentInfo);
    get()._dropTableFromFloor(tableId);
  },

  // Remove a table (and its children) from the floor and clear it as the active table.
  // Extracted from clearTable so the terminal-job reconciler can drop a table it has
  // closed WITHOUT re-recording the check. Idempotent — a table already gone is a no-op.
  _dropTableFromFloor: (tableId) => {
    const table = get().tables.find(t => t.id === tableId);

    if (table?.parentId) {
      // Child table (T1.2) — remove it, update parent childIds
      set(s => {
        const remaining = s.tables.filter(t => t.id !== tableId);
        const parent = remaining.find(t => t.id === table.parentId);
        const newChildIds = (parent?.childIds || []).filter(id => id !== tableId);
        // If parent has no more children and no active session, set to available
        const parentHasSession = parent?.session?.items?.some(i => !i.voided);
        return {
          tables: remaining.map(t => {
            if (t.id !== table.parentId) return t;
            if (newChildIds.length === 0 && !parentHasSession) {
              return { ...t, status:'available', session:null, childIds:[] };
            }
            return { ...t, childIds: newChildIds };
          }),
        };
      });
    } else {
      // Parent table — clear it and all its children
      const childIds = table?.childIds || [];
      set(s => ({
        tables: s.tables
          .filter(t => !childIds.includes(t.id))
          .map(t => t.id === tableId ? { ...t, status:'available', session:null, childIds:[] } : t),
      }));
    }
    set(s => ({ activeTableId: s.activeTableId === tableId ? null : s.activeTableId }));
  },

  // Add/remove reservation — since v5.6.27 a reservation IS a booking (Peter,
  // 11 Aug: bookings replace the thin per-table reservation entirely). The
  // signature survives for existing call sites; the body writes through the
  // bookings slice. The Tables screen derives its "reserved" display from
  // upcomingBookingForTable — table.reservation is no longer persisted state.
  setReservation: (tableId, res) => {
    if (!res) {
      const b = get().upcomingBookingForTable?.(tableId);
      if (b) get().cancelBooking?.(b.id, { reason: 'cancelled at the table' });
      get()._updateTable(tableId, { status: 'available', reservation: null });
      return;
    }
    const customer = res.customer
      ? { ...res.customer, name: res.customer.name || res.name, phone: res.customer.phone || res.phone }
      : { name: res.name || 'Guest', phone: res.phone || null };
    get().createBooking?.({
      covers: res.partySize || 2,
      time: res.time,
      date: res.date || undefined,           // createBooking defaults to today
      tables: [tableId],
      primaryTableId: tableId,
      customerId: res.customer?.customerId || res.customer?.id || null,
      customer,
      note: res.notes || '',
      source: 'pos',
    }).then((r) => {
      if (!r?.ok) {
        get().showToast?.(r?.error === 'table_taken'
          ? 'That table is already booked for this time'
          : `Reservation NOT saved — ${r?.error || 'write refused'}`, 'error');
      }
    }).catch(() => {});
  },

  // Update covers count mid-service
  updateCovers: (tableId, covers) => {
    set(s => ({
      tables: s.tables.map(t =>
        t.id === tableId && t.session
          ? { ...t, session: { ...t.session, covers } }
          : t
      ),
    }));
  },

  // Transfer or combine a table's session onto another table.
  // v4.6.28:
  //   - Destination empty: straight transfer (session moves across, source freed).
  //   - Destination has a session: COMBINE — destination keeps its items and we
  //     append the source's items. Covers sum, totals recomputed.
  //   - If the source had any sent items, a transfer-notice docket is fired to
  //     every centre that saw any of those items, so kitchen/expo sees the new
  //     location for already-prepared food.
  transferTable: (fromId, toId) => {
    const { tables } = get();
    const from = tables.find(t => t.id === fromId);
    const to   = tables.find(t => t.id === toId);
    if (!from?.session || !to) return;

    const destHasSession = !!to.session;
    const fromItems = from.session.items || [];
    const toItems   = to.session?.items || [];
    const sentItems = fromItems.filter(i => i.status === 'sent' && !i.voided);

    const mergedItems = destHasSession ? [...toItems, ...fromItems] : fromItems;
    const mergedSubtotal = mergedItems.reduce((s, i) => s + (i.price||0)*(i.qty||1), 0);
    const mergedSession = destHasSession
      ? {
          ...to.session,
          items: mergedItems,
          covers: (to.session.covers || 0) + (from.session.covers || 0),
          subtotal: mergedSubtotal,
          total: mergedSubtotal * 1.125,
        }
      : { ...from.session, items: mergedItems, subtotal: mergedSubtotal, total: mergedSubtotal * 1.125 };

    set(s => ({
      tables: s.tables.map(t => {
        if (t.id === fromId) return { ...t, status:'available', session:null, childIds:[] };
        if (t.id === toId)   return { ...t, status:'occupied', session: mergedSession, reservation:null };
        return t;
      }),
      activeTableId: toId,
    }));

    if (sentItems.length) {
      try {
        const routingConfig = (() => {
          try {
            const stored = get().printRouting;
            if (stored?.centres?.length) return stored;
            return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
          } catch { return { centres: [], routing: {} }; }
        })();
        const byCenter = {};
        sentItems.forEach(item => {
          const centres = getCentresForItem(item, routingConfig);
          centres.forEach(cid => {
            if (!byCenter[cid]) byCenter[cid] = [];
            byCenter[cid].push(item);
          });
        });
        const centrePrinterName = (centreId) => {
          const c = routingConfig.centres?.find(x => x.id === centreId);
          return c?.printer?.name || c?.name || 'Kitchen';
        };
        Object.entries(byCenter).forEach(([centreId, items]) => {
          get().routePrintJob({
            centreId,
            printerName: centrePrinterName(centreId),
            fromTable: from.label,
            tableLabel: to.label,
            items: items.map(i => ({
              qty: i.qty,
              name: i.kitchenName || i.menu_name || i.menuName || i.name,
              mods: i.mods,
              course: i.course,
            })),
            server: from.session?.server || to.session?.server || '',
            type: 'transfer-notice',
          });
        });
      } catch (err) {
        // A printing failure must never block the in-memory transfer.
        console.warn('[transferTable] transfer notice failed:', err);
      }
    }

    get().showToast(
      destHasSession
        ? `Combined ${from.label} into ${to.label}`
        : `Transferred to ${to.label}`,
      'success'
    );
  },

  // ── Active table context ───────────────────
  activeTableId: null,
  setActiveTableId: id => set({ activeTableId:id }),

  getActiveTable: () => get().tables.find(t => t.id === get().activeTableId) || null,

  // ── Add item to active table's session ────
  addItem: (item, mods=[], pizzaConfig=null, opts={}) => {
    const { activeTableId, staff, tables } = get();
    const qty = opts.qty || 1;
    // v4.5.5: when caller doesn't pass an explicit linePrice (e.g. quick add),
    // resolve the price via getItemPrice(item, currentOrderType) so per-channel pricing
    // (dineIn / takeaway / collection / delivery) is applied. Fixes pricing schema being
    // wired but POS never reading channel keys.
    const _currentOrderType = get().orderType;
    const _channelPrice = (() => {
      try { return get().getItemPrice(item, _currentOrderType); }
      catch { return item?.pricing?.base ?? item?.price ?? 0; }
    })();
    // v4.5.7: if caller passed linePrice but it equals item.pricing.base * qty, the
    // caller is using the dumb-base shortcut (e.g. QuickAdd) and we should swap in the
    // channel-aware price instead. If linePrice differs from base*qty, modifiers are at
    // play (e.g. ProductModal added surcharges) — we SCALE the linePrice by the channel
    // ratio so per-channel pricing applies even when modifiers are stacked.
    let price;
    const _basePrice = item?.pricing?.base ?? item?.price ?? 0;
    if (opts.linePrice == null) {
      price = _channelPrice;
    } else if (_basePrice && Math.abs(opts.linePrice/qty - _basePrice) < 0.001) {
      // Caller passed plain base — use channel price instead
      price = _channelPrice;
    } else if (_basePrice && _channelPrice && _basePrice !== _channelPrice) {
      // Caller passed modifiers-included price — scale by channel ratio
      const ratio = _channelPrice / _basePrice;
      price = (opts.linePrice / qty) * ratio;
    } else {
      price = opts.linePrice / qty;
    }
    const newItem = {
      uid: uid(), itemId: item.id,
      name: opts.displayName || item.name,
      // Triple-naming: snapshot the item's explicit kitchen/receipt names onto
      // the line (null when not set — see itemDisplay.js). KDS tickets read
      // kitchenName || name (createKdsTickets), receipts read receiptName ||
      // name (printer.js / sendReceipt.js). The POS order panel keeps `name`.
      kitchenName: kitchenOverride(item),
      receiptName: receiptOverride(item),
      price, qty, mods: mods||[], notes: opts.notes||'',
      pizzaConfig, allergens: item.allergens||[],
      centreId: item.centreId,
      cat: (() => {
        // v5.5.259: Variants use the parent's category. Variant rows in the DB
        // can have a stale/wrong cat from creation or reassignment bugs.
        if (item.parentId) {
          const parent = (useStore.getState().menuItems || []).find(m => m.id === item.parentId);
          if (parent?.cat) return parent.cat;
        }
        return item.cat || null;
      })(),
      parentId: item.parentId || null,
      // v5.5.338: variants inherit the parent's tax settings (default rate +
      // per-order-type overrides). Variant rows store empty tax_overrides, so
      // without this a sized item's takeaway/zero-rate override is lost and it's
      // taxed at the default rate. Mirrors the category inheritance above.
      ...(() => {
        let txRate = item.taxRateId || item.tax_rate_id || null;
        let txOv = item.taxOverrides || item.tax_overrides || {};
        if (item.parentId && (!txOv || Object.keys(txOv).length === 0)) {
          const parent = (useStore.getState().menuItems || []).find(m => m.id === item.parentId);
          if (parent) {
            txOv = parent.taxOverrides || parent.tax_overrides || txOv;
            if (!txRate) txRate = parent.taxRateId || parent.tax_rate_id || null;
          }
        }
        return { taxRateId: txRate, taxOverrides: txOv };
      })(),
      seat: 'shared',
      course: (() => {
        const cats = useStore.getState().menuCategories || [];
        const cat = cats.find(c => c.id === item.cat) ||
                    cats.find(c => c.id === item.cats?.[0]) ||
                    (item.parentId ? cats.find(c => c.id === (useStore.getState().menuItems||[]).find(m=>m.id===item.parentId)?.cat) : null);
        return cat?.defaultCourse ?? 1;
      })(),
      fired: (() => {
        const cats = useStore.getState().menuCategories || [];
        const cat = cats.find(c => c.id === item.cat) ||
                    cats.find(c => c.id === item.cats?.[0]) ||
                    (item.parentId ? cats.find(c => c.id === (useStore.getState().menuItems||[]).find(m=>m.id===item.parentId)?.cat) : null);
        return (cat?.defaultCourse ?? 1) === 0;
      })(),
      status: 'pending',
    };

    // Decrement daily count if set (respects qty per v4.6.11)
    if (item.id) get().decrementDailyCount(item.id, qty);
    // v5.5.189: also decrement daily counts for modifier options that reference
    // menu items (e.g. "Bueno Donut" as a sub-item in a "Box of 3" combo).
    // Each mod's usage = (mod.qty || 1) per parent unit × parent qty.
    if (mods?.length) {
      mods.forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * qty);
      });
    }

    if (activeTableId) {
      // Add to the table's session
      set(s => ({
        tables: s.tables.map(t => {
          if (t.id !== activeTableId) return t;
          const session = t.session || { id:`ORD-${++_orderNum}`, items:[], firedCourses:[], sentAt:null, covers:2, server:staff?.name||'Staff', seatedAt:Date.now(), note:'', orderNote:'', subtotal:0, total:0 };
          const items = [...session.items, newItem];
          const subtotal = items.reduce((s,i)=>s+i.price*i.qty, 0);
          return { ...t, status:t.status==='available'?'open':t.status, session:{ ...session, items, subtotal, total:subtotal*1.125, lastUpdated: Date.now() } };
        }),
      }));
    } else {
      // Walk-in / takeaway: use standalone order
      set(s => {
        const items = [...(s.walkInOrder?.items||[]), newItem];
        const subtotal = items.reduce((a,i)=>a+i.price*i.qty, 0);
        return { walkInOrder:{ ...(s.walkInOrder||{id:`ORD-${++_orderNum}`}), items, subtotal, total:subtotal } };
      });
    }
  },

  addCustomItem: (name, price, notes) => {
    const { activeTableId, staff } = get();
    const newItem = { uid:uid(), itemId:'custom', name, price:parseFloat(price)||0, qty:1, mods:[], notes, allergens:[], seat:'shared', course:1, fired:false, status:'pending' };
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if (t.id!==activeTableId) return t;
        const session = t.session||{ id:`ORD-${++_orderNum}`, items:[], firedCourses:[], sentAt:null, covers:2, server:staff?.name||'Staff', seatedAt:Date.now(), note:'', orderNote:'', subtotal:0, total:0 };
        const items=[...session.items, newItem];
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t, session:{...session, items, subtotal, total:subtotal*1.125, lastUpdated: Date.now()}};
      }) }));
    } else {
      set(s=>{const items=[...(s.walkInOrder?.items||[]),newItem];return{walkInOrder:{...(s.walkInOrder||{id:`ORD-${++_orderNum}`}),items}};});
    }
  },

  removeItem: (itemUid) => {
    const { activeTableId } = get();
    // v4.6.11: restore daily count for the removed item (only if it was never sent —
    // sent items can't be removed via this path, only voided). Look up before mutation.
    const sourceItems = activeTableId
      ? (get().tables.find(t => t.id === activeTableId)?.session?.items || [])
      : (get().walkInOrder?.items || []);
    const removed = sourceItems.find(i => i.uid === itemUid);
    if (removed && !removed.voided && removed.status !== 'sent') {
      get().decrementDailyCount(removed.itemId, -(removed.qty || 1));
      // v5.5.189: restore modifier sub-item counts too
      (removed.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (removed.qty || 1)));
      });
    }
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        const items=t.session.items.filter(i=>i.uid!==itemUid);
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t, session:{...t.session, items, subtotal, total:subtotal*1.125}};
      })}) );
    } else {
      set(s=>{const items=(s.walkInOrder?.items||[]).filter(i=>i.uid!==itemUid);return{walkInOrder:{...s.walkInOrder,items}};});
    }
  },

  // v5.5.644: clear ONLY the unsent draft (status 'pending', not voided) on a
  // table. Sent items and the table session are preserved. This replaces the old
  // POS "Clear → clearTable" path, which wiped a whole occupied table's order
  // (incl. already-sent food) with no payment — a data-loss / lost-table risk.
  // To remove a SENT item you must void it (auditable); to discard the draft you
  // built but haven't fired, use this. Daily counts are restored per discarded
  // line + its modifier sub-items, mirroring removeItem.
  clearDraftItems: (tableId) => {
    const table = get().tables.find(t => t.id === tableId);
    const draft = (table?.session?.items || []).filter(i => i.status === 'pending' && !i.voided);
    if (!draft.length) return;
    draft.forEach(removed => {
      get().decrementDailyCount(removed.itemId, -(removed.qty || 1));
      (removed.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (removed.qty || 1)));
      });
    });
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = t.session.items.filter(i => !(i.status === 'pending' && !i.voided));
        const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
        const hasSent = items.some(i => i.status === 'sent' && !i.voided);
        // If nothing fired remains, the table is just "seated" again (open), not occupied.
        return {
          ...t,
          status: (t.status === 'occupied' && !hasSent) ? 'open' : t.status,
          session: { ...t.session, items, subtotal, total: subtotal * 1.125 },
        };
      }),
    }));
  },

  updateItemQty: (itemUid, delta) => {
    const { activeTableId } = get();
    // v4.6.11: compute actual qty change first so we can adjust inventory.
    // The clamp can swallow a portion of delta (e.g. qty=1, delta=-1 → newQty=1,
    // actual change = 0) so we rely on the observed change, not the requested delta.
    const sourceItems = activeTableId
      ? (get().tables.find(t => t.id === activeTableId)?.session?.items || [])
      : (get().walkInOrder?.items || []);
    const target = sourceItems.find(i => i.uid === itemUid);
    let actualChange = 0;
    if (target && !target.voided) {
      const newQty = Math.max(1, target.qty + delta);
      actualChange = newQty - target.qty;
      if (actualChange !== 0) {
        get().decrementDailyCount(target.itemId, actualChange);
        // v5.5.189: adjust modifier sub-item counts too
        (target.mods || []).forEach(mod => {
          if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * actualChange);
        });
      }
    }

    const applyQty = items => {
      const item = items.find(i => i.uid === itemUid);
      if (!item || item.voided) return items;
      const newQty = Math.max(1, item.qty + delta); // Clamp at 1 — never auto-remove
      return items.map(i => i.uid === itemUid ? { ...i, qty: newQty } : i);
    };
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        const items=applyQty(t.session.items);
        const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
        return {...t,session:{...t.session,items,subtotal,total:subtotal*1.125}};
      })}) );
    } else {
      set(s=>{const items=applyQty(s.walkInOrder?.items||[]);return{walkInOrder:{...s.walkInOrder,items}};});
    }
  },

  updateItemNote: (itemUid, note) => {
    const { activeTableId } = get();
    const apply = items => items.map(i=>i.uid===itemUid?{...i,notes:note}:i);
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:apply(t.session.items)}};
      })}) );
    } else {
      set(s=>({walkInOrder:{...s.walkInOrder,items:apply(s.walkInOrder?.items||[])}}));
    }
  },

  // v5.7.27 — set options on an EXISTING line in place (same uid). Built for
  // materialised booking pre-order lines ("16oz Ribeye" seated bare — nobody
  // asked how the guest wants it cooked): the POS opens the SAME InlineItemFlow
  // the add flow uses and this replaces the line's mods/variant/notes. Pricing
  // rule: the line's base price is untouched (prepay lines stay 0.00 — the food
  // is already paid) and modifier PRICES, if any, add on top per unit, exactly
  // like a normal item. Notes MERGE (the line's existing note carries
  // "Seat N · Guest" — replacing it would lose whose plate it is). Modifier
  // sub-item daily counts decrement here, mirroring addItem, so removeItem /
  // updateItemQty restore maths stay balanced.
  configureLineOptions: (itemUid, { mods = [], notes = '', variantName = null } = {}) => {
    const { activeTableId } = get();
    const sourceItems = activeTableId
      ? (get().tables.find(t => t.id === activeTableId)?.session?.items || [])
      : (get().walkInOrder?.items || []);
    const line = sourceItems.find(i => i.uid === itemUid);
    if (!line || line.voided || line.status === 'sent') return;

    // Base = current unit price minus whatever the current mods already add
    // (fresh pre-order lines have mods: [], so base is simply the line price).
    const modSum = arr => (arr || []).reduce((s, m) => s + (Number(m?.price) || 0), 0);
    const base = (Number(line.price) || 0) - modSum(line.mods);
    const price = base + modSum(mods);

    // Daily counts: restore the old mods' linked items, decrement the new ones
    // (per parent unit × line qty — the same maths addItem uses).
    (line.mods || []).forEach(mod => {
      if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (line.qty || 1)));
    });
    (mods || []).forEach(mod => {
      if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * (line.qty || 1));
    });

    const nextNotes = [line.notes, (notes || '').trim()].filter(Boolean).join(' · ');
    const apply = items => items.map(i => i.uid !== itemUid ? i : {
      ...i,
      mods: mods || [],
      notes: nextNotes,
      price,
      ...(variantName ? { variantName, name: `${i.name} · ${variantName}` } : {}),
    });
    if (activeTableId) {
      set(s => ({ tables: s.tables.map(t => {
        if (t.id !== activeTableId || !t.session) return t;
        const items = apply(t.session.items);
        const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
        return { ...t, session: { ...t.session, items, subtotal, total: subtotal * 1.125, lastUpdated: Date.now() } };
      }) }));
    } else {
      set(s => {
        const items = apply(s.walkInOrder?.items || []);
        const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
        return { walkInOrder: { ...s.walkInOrder, items, subtotal, total: subtotal } };
      });
    }
  },

  setOrderNote: (note) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>t.id===activeTableId&&t.session?{...t,session:{...t.session,orderNote:note}}:t) }));
    } else {
      set(s=>({ walkInOrder:{...s.walkInOrder,orderNote:note} }));
    }
  },

  // Toggle service charge waiver for the current order
  toggleServiceCharge: () => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,serviceChargeWaived:!t.session.serviceChargeWaived}};
      })}));
    } else {
      set(s=>({ walkInOrder:{...s.walkInOrder,serviceChargeWaived:!s.walkInOrder?.serviceChargeWaived} }));
    }
  },

  updateItemSeat: (itemUid, seat) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:t.session.items.map(i=>i.uid===itemUid?{...i,seat}:i)}};
      })}) );
    }
  },

  updateItemCourse: (itemUid, course) => {
    const { activeTableId } = get();
    if (activeTableId) {
      set(s=>({ tables:s.tables.map(t=>{
        if(t.id!==activeTableId||!t.session)return t;
        return {...t,session:{...t.session,items:t.session.items.map(i=>i.uid===itemUid?{...i,course}:i)}};
      })}) );
    } else {
      // Walk-in / takeaway / collection order
      set(s=>({ walkInOrder: s.walkInOrder ? {
        ...s.walkInOrder,
        items: (s.walkInOrder.items||[]).map(i=>i.uid===itemUid?{...i,course}:i)
      } : s.walkInOrder }));
    }
  },

  // ── SEND TO KITCHEN ────────────────────────
  // Fires courses 0+1, marks table occupied, updates totals
  sendToKitchen: (opts) => {
    // v4.6.44: tolerate any arg shape. POSSurface legacy callers pass
    // sendToKitchen(null) or sendToKitchen(tableId) as positional args.
    // Destructuring `null` throws; this internal default doesn't.
    const bypassSchedule = (opts && typeof opts === 'object') ? !!opts.bypassSchedule : false;
    // v5.5.792: payment-time fire (see clearTable / recordWalkInClosed). fireAll
    // sends EVERY line the kitchen has never fired — never-sent lines AND
    // sent-but-held later courses — in ONE combined send with course holds
    // ignored (the customer is paying; course sequencing no longer applies).
    // Lines already sent AND fired are excluded, so nothing double-fires.
    const fireAll = (opts && typeof opts === 'object') ? !!opts.fireAll : false;
    const { activeTableId, staff, orderType, customer, addToQueue, tables } = get();
    // fireAll callers pass the table being closed explicitly (clearTable can run
    // with a tableId that is not the activeTableId, e.g. MPOS).
    const targetTableId = (opts && typeof opts === 'object' && 'tableId' in opts) ? opts.tableId : activeTableId;
    // The lines a send should pick up. Normal send: pending only (original
    // behaviour). fireAll: pending PLUS sent-but-held (fired === false).
    const isUnsentLine = (i) => !i.voided && (i.status === 'pending' || (fireAll && i.status === 'sent' && !i.fired));

    // Get routing config — prefer store value (pushed from back office), fall back to localStorage
    const getRoutingConfig = () => {
      try {
        const stored = useStore.getState().printRouting;
        if (stored?.centres?.length) return stored;
        return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} };
      } catch { return { centres:[], routing:{} }; }
    };

    // buildCatParentMap / catOrAncestorMatches / getCentresForItem now live at module
    // scope (see the block above useStore) — transferTable needs them too and could not
    // see these local copies.

    // v5.5.191: compute which courses auto-fire on send. Always includes 0
    // (immediate) and 1 (starters). If the lowest occupied course is higher
    // than 1 (e.g. only course 2 items exist), auto-fire all empty leading
    // courses up through it so the kitchen doesn't hold items for a course
    // that has no food in it.
    const computeFiredOnSend = (items) => {
      // v5.5.792: fireAll = payment-time send — every unsent line's course fires
      // at once, regardless of course number or hold state.
      if (fireAll) {
        return [...new Set([0, ...(items || []).filter(isUnsentLine).map(i => i.course ?? 1)])].sort((a,b) => a-b);
      }
      const pending = (items || []).filter(i => !i.voided && (i.status === 'pending' || i.status === 'sent'));
      const courses = [...new Set(pending.map(i => i.course ?? 1))].filter(c => c >= 1).sort((a,b) => a-b);
      const lowest = courses[0] || 1;
      const fired = [0];
      for (let c = 1; c <= lowest; c++) fired.push(c);
      return fired;
    };

    const createKdsTickets = (items, tableLabel, serverName, covers, _firedOnSend) => {
      const routingConfig = getRoutingConfig();
      const byCenter = {};
      const FIRED_ON_SEND = _firedOnSend;
      // Send ALL non-voided pending items — not just courses 0+1
      // (v5.5.792: in fireAll mode isUnsentLine also picks up sent-but-held lines)
      // v5.7.28: noKitchen lines (the prepaid booking package revenue line) never
      // reach KDS or the kitchen printers — the print jobs below are built FROM
      // these tickets, so this one filter covers both. buildKitchenTicket
      // (printer.js) guards again at the docket builder.
      items.filter(isUnsentLine).filter(i => !i.noKitchen).forEach(item => {
        const centres = getCentresForItem(item, routingConfig);
        centres.forEach(cid => {
          if (!byCenter[cid]) byCenter[cid] = [];
          byCenter[cid].push(item);
        });
      });
      return Object.entries(byCenter).map(([centreId, centreItems]) => {
        const allCourses = [...new Set(centreItems.map(i => i.course ?? 1))].sort((a,b)=>a-b);
        return {
          id: `kds-${Date.now()}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
          table: tableLabel, server: serverName, covers, centreId,
          sentAt: Date.now(), minutes: 0,
          firedCourses: FIRED_ON_SEND,
          allCourses,
          items: centreItems.map(i => ({
            qty: i.qty, name: i.kitchenName || i.menu_name || i.menuName || i.name,
            mods: [
              // v4.6.10: drop the `${groupLabel}: ` prefix on mods shown on KDS and
              // production dockets. Kitchens care about the modifier itself, not which
              // picker group it came from. The groupLabel field stays on the source mod
              // object (BarSurface.jsx:677) as metadata in case we need it later.
              // v5.5.965: ONE pass in line order — the old two-filter concat forced
              // instructions last on every ticket, overriding the BO flow order the
              // line was committed with (v964).
              ...(i.mods?.map(m => (m._instruction ? m.label : (m.name || m.label))).filter(Boolean) || []),
              ...(i.allergens?.length ? [`⚠ ${i.allergens.map(a=>a.toUpperCase()).join(' · ')}`] : []),
              ...(i.notes ? [`📝 ${i.notes}`] : []),
            ],
            course: i.course ?? 1,
            fired: FIRED_ON_SEND.includes(i.course ?? 1),
            centreId, uid: i.uid,
          })),
        };
      });
    };

    if (targetTableId) {
      const table = tables.find(t => t.id === targetTableId);
      const session = table?.session;
      const pendingItems = session?.items?.filter(isUnsentLine) || [];
      const firedOnSend = computeFiredOnSend(session?.items || []);
      const newTickets = createKdsTickets(pendingItems, table?.label || targetTableId, staff?.name || 'Server', session?.covers || 2, firedOnSend);
      // Route print jobs for each ticket (fires to mapped printer per centre)
      const printConfig = getRoutingConfig();
      const getCentrePrinter = (centreId) => {
        const centre = printConfig.centres?.find(c => c.id === centreId);
        return centre?.printer?.name || centre?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[centreId] || 'Kitchen';
      };
      newTickets.forEach(t => {
        // v4.6.9: print ALL items — the docket mirrors the KDS, grouping by course
        // with FIRING/HOLD headers (see buildKitchenTicket). A later fireCourse()
        // emits a separate "FIRE COURSE N" marker docket. Revert of the v4.6.8
        // fired-only filter.
        if (t.items.length) get().routePrintJob({
          centreId: t.centreId,
          printerName: getCentrePrinter(t.centreId),
          tableLabel: t.table,
          server: t.server,
          covers: t.covers,
          course: t.firedCourses?.[0] ?? 1,
          items: t.items,
          type: 'kitchen',
        });
      });
      set(s=>({
        tables: s.tables.map(t=>{
          if(t.id!==targetTableId||!t.session)return t;
          // v5.5.4: TWO independent concepts on each item:
          //   status: 'pending' | 'sent'  — whether the kitchen has SEEN this item yet.
          //                                  An item is 'sent' as soon as it's printed.
          //   fired:  bool                — whether the kitchen should COOK it now.
          //                                  Course 0/1 are auto-fired, course 2+ are
          //                                  printed on a HOLD ticket and only become
          //                                  fired:true when fireCourse(N) is called.
          // Pre-v5.5.4 bug: this map only updated status to 'sent' when the course
          // was in firedCourses (= auto-fire courses). Course 2+ items stayed
          // 'pending' even after save+send had printed them, so the NEXT save+send
          // re-included them in pendingItems and re-printed every fired course's
          // tickets. Now: every printed item flips to status:'sent', and only the
          // 'fired' flag gates fire-vs-hold.
          const firedCourses=[...new Set([...(t.session.firedCourses||[]),...firedOnSend])];
          const items=t.session.items.map(i => {
            // v5.5.792: isUnsentLine ≡ the old (status==='pending' && !voided) guard
            // for a normal send; in fireAll mode it also flips sent-but-held lines.
            if (!isUnsentLine(i)) return i;
            return { ...i, fired: firedCourses.includes(i.course), status: 'sent' };
          });
          const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
          return {...t, status:'occupied', session:{...t.session, items, firedCourses, sentAt:t.session.sentAt||Date.now(), server:staff?.name||t.session.server, subtotal, total:subtotal*1.125, lastUpdated: Date.now() }};
        }),
        kdsTickets: [...s.kdsTickets, ...newTickets],
      }));
      newTickets.forEach(t => insertKDSTicket(t));
      get().showToast('Sent to kitchen','success');
      // v5.5.792: fireAll runs mid-payment-close — let the payment path's own
      // maybeAutoSignout('pay') handle sign-out; signing out here would yank the
      // staff context before recordClosedCheck writes the check.
      if (!fireAll) get().maybeAutoSignout('send');   // v5.5.731 per-device sign-out-on-send
    } else {
      const order = get().walkInOrder;
      if (!order?.items?.length) return;

      // v4.6.29: scheduled-collection deferral. If the customer set a
      // non-ASAP collection time that's more than 30 minutes away, skip
      // the kitchen send entirely and stash the order as status=scheduled
      // with a scheduledFireAt timestamp. A background tick
      // (tickScheduledOrders → fireScheduledOrder) runs the print + KDS
      // path 30 minutes before the collection time.
      const _parseCollectionTimeToMs = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const [h, m] = timeStr.split(':').map(Number);
        if (Number.isNaN(h) || Number.isNaN(m)) return null;
        const d = new Date();
        d.setHours(h, m, 0, 0);
        // If that time has already passed today, assume tomorrow
        // (handles overnight pre-orders).
        if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
        return d.getTime();
      };
      if (!bypassSchedule && customer?.collectionTime && !customer?.isASAP) {
        const collectAt = _parseCollectionTimeToMs(customer.collectionTime);
        // v4.6.60: lead time configurable via Location settings (default 30min, 5-min increments)
      const _leadMin = (typeof get().locationConfig?.collectionLeadMinutes === 'number') ? get().locationConfig.collectionLeadMinutes : 30;
      const LEAD_MS = _leadMin * 60 * 1000;
        if (collectAt && collectAt - Date.now() > LEAD_MS) {
          const scheduledFireAt = collectAt - LEAD_MS;
          const pendingItems = order.items.filter(i => i.status === 'pending' && !i.voided);
          if (!pendingItems.length) return;
          const label = customer?.name
            ? `${orderType.charAt(0).toUpperCase()+orderType.slice(1)} · ${customer.name}`
            : orderType;
          const ref = order.ref || getNextOrderRefLocal();
          const scheduledEntry = {
            ref, type: orderType,
            customer: { ...customer },
            // Keep items as pending — nothing has hit the kitchen yet.
            items: pendingItems.map(i => ({ ...i })),
            total: pendingItems.reduce((s, i) => s + i.price * i.qty, 0),
            status: 'scheduled',
            scheduledFireAt,
            createdAt: order.createdAt || Date.now(),
            collectionTime: customer.collectionTime,
            isASAP: false,
            staff: staff?.name,
            label,
          };
          const alreadyQueued = get().orderQueue.find(o => o.ref === ref);
          if (alreadyQueued) {
            set(s => ({ orderQueue: s.orderQueue.map(o => o.ref === ref ? { ...o, ...scheduledEntry } : o) }));
          } else {
            addToQueue(scheduledEntry);
          }
          const fireTime = new Date(scheduledFireAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
          get().showToast(
            customer?.name
              ? `${customer.name} — collection ${customer.collectionTime}, kitchen fires ${fireTime}`
              : `Scheduled — kitchen fires at ${fireTime}`,
            'success'
          );
          return;
        }
      }
      const pendingItems = order.items.filter(isUnsentLine);
      const label = customer?.name ? `${orderType.charAt(0).toUpperCase()+orderType.slice(1)} · ${customer.name}` : orderType;
      const wiFiredOnSend = computeFiredOnSend(order.items || []);
      const newTickets = createKdsTickets(pendingItems, label, staff?.name || 'Server', 1, wiFiredOnSend);
      // v4.6.5 Bug 3: walk-in / takeaway / collection / delivery orders must ALSO route
      // print jobs to each production centre. Previously only the table branch did this,
      // so non-table orders only hit the KDS screen and silently skipped every printer.
      const printConfig = getRoutingConfig();
      const getCentrePrinter = (centreId) => {
        const centre = printConfig.centres?.find(c => c.id === centreId);
        return centre?.printer?.name || centre?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[centreId] || 'Kitchen';
      };
      newTickets.forEach(t => {
        // v4.6.9: print ALL items (see comment at the table branch).
        if (t.items.length) get().routePrintJob({
          centreId: t.centreId,
          printerName: getCentrePrinter(t.centreId),
          tableLabel: t.table,
          server: t.server,
          covers: t.covers,
          course: t.firedCourses?.[0] ?? 1,
          items: t.items,
          type: 'kitchen',
        });
      });
      // Always add walk-in orders to queue so they appear in Orders Hub
      const ref = order.ref || getNextOrderRefLocal();
      const queueEntry = {
        ref, type: orderType,
        customer: customer ? { ...customer } : { name: customer?.name || label },
        // v4.6.5 follow-up: align with dine-in visual semantics. Table sessions persist
        // the fired+sent mutation on their items until payment, so reopening a table shows
        // them green. Walk-ins had the same mutation applied to walkInOrder but clearWalkIn()
        // wipes it immediately — and the queueEntry (the only persistent record OrdersHub can
        // rehydrate from) was capturing items pre-mutation, so reopens rendered them as
        // pending (not green). Apply the same mutation here so reopens show them sent/green.
        items: order.items.filter(i => !i.voided).map(i =>
          wiFiredOnSend.includes(i.course ?? 1) ? { ...i, fired: true, status: 'sent' } : i
        ),
        total: order.items.reduce((s, i) => s + i.price * i.qty, 0),
        status: 'prep', createdAt: order.createdAt || Date.now(), sentAt: Date.now(),
        collectionTime: customer?.collectionTime, isASAP: customer?.isASAP, staff: staff?.name,
      };
      const alreadyQueued = get().orderQueue.find(o => o.ref === ref);
      if (alreadyQueued) {
        set(s => ({ orderQueue: s.orderQueue.map(o => o.ref === ref ? { ...o, ...queueEntry } : o) }));
      } else {
        addToQueue(queueEntry);
      }
      set(s => ({
        walkInOrder: { ...(s.walkInOrder||{}), ref, sentAt: Date.now(), items: (s.walkInOrder?.items||[]).map(i => wiFiredOnSend.includes(i.course ?? 1) ? {...i, fired:true, status:'sent'} : i) },
        kdsTickets: [...s.kdsTickets, ...newTickets],
      }));
      newTickets.forEach(t => insertKDSTicket(t));
      get().showToast(customer?.name ? `Order sent — ${customer.name}` : 'Sent to kitchen', 'success');
    }
  },

  // v4.6.29: fires a previously-scheduled collection order through the normal
  // sendToKitchen path. Reconstructs walkInOrder/customer/orderType from the
  // stored queue entry, runs sendToKitchen with bypassSchedule=true so it
  // doesn't re-queue as scheduled, then restores the POS context.
  fireScheduledOrder: (ref) => {
    const { orderQueue } = get();
    const entry = orderQueue.find(o => o.ref === ref);
    if (!entry || entry.status !== 'scheduled') return;

    const reconstructed = {
      id: `ORD-scheduled-${Date.now()}`,
      ref: entry.ref,
      items: (entry.items || []).map(i => ({ ...i, status: 'pending', fired: false })),
      subtotal: entry.total || 0,
      total: entry.total || 0,
      createdAt: entry.createdAt || Date.now(),
    };
    const prev = {
      walkInOrder: get().walkInOrder,
      customer:    get().customer,
      orderType:   get().orderType,
    };
    set({
      walkInOrder: reconstructed,
      customer: entry.customer,
      orderType: entry.type || 'collection',
    });
    try {
      // bypassSchedule=true: this order is already at/past its fire time,
      // don't let the scheduler re-defer it.
      get().sendToKitchen({ bypassSchedule: true });
    } finally {
      // Restore prior POS context. orderQueue mutations persist because
      // sendToKitchen matched the ref via alreadyQueued and merged into the
      // existing entry (flipping status scheduled → prep, setting sentAt).
      set(prev);
    }
  },

  // v4.6.29: iterate orderQueue for any scheduled orders whose
  // scheduledFireAt is in the past and fire them. Called on an interval
  // from SyncBridge (every 60s).
  tickScheduledOrders: () => {
    const { orderQueue } = get();
    const now = Date.now();
    // Two guards so a long-offline device never dumps a stale scheduled backlog into the kitchen:
    //  (1) require a real scheduledFireAt > 0. After a reload it is NOT rehydrated (not persisted to
    //      order_queue), so the old `(o.scheduledFireAt || 0) <= now` was ALWAYS TRUE → every
    //      rehydrated scheduled order (even ones due tomorrow) fired on the first boot tick.
    //  (2) skip anything whose fire moment passed more than STALE_ORDER_FLOOR_MS ago — it stays
    //      'scheduled' and visible in the Orders Hub for a staff member to release manually.
    const due = orderQueue.filter(o =>
      o.status === 'scheduled'
      && o.scheduledFireAt > 0
      && o.scheduledFireAt <= now
      && (now - o.scheduledFireAt) <= STALE_ORDER_FLOOR_MS
    );
    if (!due.length) return;
    due.forEach(o => {
      try { get().fireScheduledOrder(o.ref); } catch (err) {
        console.warn('[tickScheduledOrders] failed to fire', o.ref, err);
      }
    });
  },

  // Catering pre-orders are held in the DB (NOT the live in-memory queue) until their event day,
  // then fired to the kitchen at sent_at (the kitchen fire time). This master-only tick queries the
  // DB directly for catering whose fire time has arrived and routes them through routeKioskOrderPrints
  // — which has the atomic kitchen_routed_at claim, so the order fires (prints + KDS) exactly once
  // across all devices. Decoupled from the in-memory queue so it scales to thousands of bookings.
  // Throttled to ~5 min; piggybacks the SyncBridge 60s tick.
  releaseDueCateringOrders: async () => {
    if (!supabase) return;
    let isMaster = false;
    try { isMaster = JSON.parse(localStorage.getItem('rpos-device-config') || '{}').isMaster === true; } catch { /* default false */ }
    if (!isMaster) return;
    if (useStore._cateringReleaseRunning) return;   // no overlapping runs
    useStore._cateringReleaseRunning = true;
    const locId = getActiveLocationSync() || await getLocationId().catch(() => null);
    if (!locId || locId === 'loc-demo') { useStore._cateringReleaseRunning = false; return; }
    try {
      // Drain all due catering oldest-fire-first; loop while a full page returns so a big
      // same-time batch clears in one tick (not 50/5-min). routeKioskOrderPrints' atomic
      // kitchen_routed_at claim makes each route fire exactly once across devices, and a routed
      // row drops out of the next page's `kitchen_routed_at is null` filter so the loop terminates.
      // Lower bound: don't fetch catering whose fire moment passed more than STALE_ORDER_FLOOR_MS
      // ago — a long-offline master must not auto-dump a stale backlog. Genuinely-due catering is
      // still fired server-side by the catering-release cron; anything older stays visible in the
      // Orders Hub for manual release. (The routeKioskOrderPrints backstop is the belt-and-braces.)
      const floorIso = new Date(Date.now() - STALE_ORDER_FLOOR_MS).toISOString();
      const PAGE = 200;
      for (let i = 0; i < 10; i++) {   // safety cap ≤ 2000/tick
        const { data, error } = await supabase.from('order_queue')
          .select('ref, type, total, items, customer, sent_at, collection_time, is_asap')
          .eq('location_id', locId).eq('source', 'catering')
          .is('kitchen_routed_at', null).neq('status', 'collected')
          .lte('sent_at', new Date().toISOString())
          .gte('sent_at', floorIso)
          .order('sent_at', { ascending: true })
          .limit(PAGE);
        if (error || !data?.length) break;
        for (const row of data) {
          await get().routeKioskOrderPrints?.({
            ref: row.ref, source: 'catering',
            items: row.items || [], customer: row.customer || null,
            collectionTime: row.collection_time || null, isASAP: !!row.is_asap,
            sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
          });
          // v5.5.653: FIRE-TIME courier dispatch — a catering delivery order set to 'uber' mode
          // dispatches its courier now (event day), not at order time. Master-only (this fn is
          // master-gated) + each row routes once (kitchen_routed_at), so no double dispatch.
          // Self-delivery orders just fire to the kitchen above (no dispatch).
          if (row.type === 'delivery' && row.customer?.delivery_mode === 'uber' && !isTrainingMode()) {
            const quote = { customerFeeMinor: Math.round(Number(row.customer.delivery_fee || 0) * 100), dropoff: row.customer.address || null, currency: 'GBP', dispatchable: true, quoteId: null };
            dispatchDelivery({ opsLocationId: locId, order: { ref: row.ref, items: row.items || [], total: row.total, customer: row.customer }, quote })
              .then((res) => { if (res?.trackingUrl) sendDeliveryTrackingSMS({ opsLocationId: locId, phone: row.customer?.phone, trackingUrl: res.trackingUrl, ref: row.ref }); })
              .catch(() => {});
          }
        }
        if (data.length < PAGE) break;
      }
    } catch (e) { console.warn('[releaseDueCateringOrders]', e?.message); }
    finally { useStore._cateringReleaseRunning = false; }
  },

  fireCourse: (courseNum) => {
    const { activeTableId, tables } = get();
    if (!activeTableId) return;
    const table = tables.find(t => t.id === activeTableId);
    const session = table?.session;
    if (!session) return;

    // Mark course as fired in POS session
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== activeTableId || !t.session) return t;
        const firedCourses = [...new Set([...(t.session.firedCourses||[]), courseNum])];
        const items = t.session.items.map(i => i.course === courseNum ? { ...i, fired:true, status:'sent' } : i);
        return { ...t, session: { ...t.session, items, firedCourses } };
      }),
      // Update in-store kds tickets: mark course items as fired
      kdsTickets: s.kdsTickets.map(ticket => {
        if (ticket.table !== (table?.label || activeTableId)) return ticket;
        if ((ticket.firedCourses||[]).includes(courseNum)) return ticket;
        const firedCourses = [...new Set([...(ticket.firedCourses||[0,1]), courseNum])];
        const items = (ticket.items||[]).map(i => i.course === courseNum ? { ...i, fired:true } : i);
        return { ...ticket, firedCourses, items };
      }),
    }));

    // Update kds_tickets in Supabase so KDS screen reacts via realtime
    import('../lib/supabase.js').then(async ({ supabase, getLocationId, getActiveLocationSync }) => {
      try {
        if (!supabase) return;
        if (isTrainingMode()) return;   // TRAINING MODE: no real kds_tickets fired_courses write
        const locId = getActiveLocationSync() || await getLocationId();
        if (!locId) return;
        const { data: tickets } = await supabase
          .from('kds_tickets')
          .select('id, fired_courses, items')
          .eq('location_id', locId)
          .eq('table_label', table?.label || activeTableId)
          .eq('status', 'pending')
          .order('sent_at', { ascending: false })
          .limit(3);
        if (!tickets?.length) return;
        for (const ticket of tickets) {
          if ((ticket.fired_courses||[]).includes(courseNum)) continue;
          const firedCourses = [...new Set([...(ticket.fired_courses||[0,1]), courseNum])];
          const updatedItems = (ticket.items||[]).map(i => i.course === courseNum ? { ...i, fired:true } : i);
          await supabase.from('kds_tickets')
            .update({ fired_courses: firedCourses, items: updatedItems })
            .eq('id', ticket.id);
        }
      } catch (e) { console.warn('fireCourse Supabase update failed', e); }
    });

    // v4.6.8: print a minimal "FIRE COURSE N" marker docket to each centre that
    // has items in the newly-fired course. Courses 0+1 already printed on initial
    // send, so skip those. Guard against double-fire by checking firedCourses
    // from the PRE-patch session above (already updated in our set() above — we use
    // kdsTickets snapshot to determine which centres to notify).
    if (courseNum > 1) {
      const tableLabel = table?.label || activeTableId;
      const centresInCourse = new Set();
      // Primary: read from in-memory kdsTickets (still populated if KDS hasn't bumped it)
      (get().kdsTickets || []).forEach(tk => {
        if (tk.table !== tableLabel) return;
        if ((tk.items || []).some(i => i.course === courseNum)) centresInCourse.add(tk.centreId);
      });
      // v4.6.58: fallback — derive centres directly from the table session items + routing.
      // kdsTickets gets cleared once dishes are bumped from KDS, so by the time staff hits
      // Fire course on a later course there may be no ticket left to read centres from.
      // The session items are still there and still carry their categories, so we can
      // route them ourselves using the SAME routing config used at send time.
      // Resolve exactly as sendToKitchen's getRoutingConfig does — store first, then
      // localStorage. Reading the snapshot first meant a device whose routing arrived by
      // Push-to-POS but whose snapshot was stale saw centres:[], which resolved no centre
      // for every item AND suppressed the guard below, so the green "fired to kitchen"
      // came back with nothing printed — the exact failure the guard exists to catch.
      const routingConfig = (() => {
        try {
          const stored = useStore.getState().printRouting;
          if (stored?.centres?.length) return stored;
          const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}')?.printRouting;
          if (snap?.centres?.length) return snap;
          return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
        } catch { return { centres: [], routing: {} }; }
      })();
      const courseItems = (table?.session?.items || []).filter(i => i.course === courseNum && i.status !== 'voided');
      if (centresInCourse.size === 0) {
        try {
          // v5.5.977: this used to be a LOCAL near-copy of the routing walk, and it was
          // handed a MENU-ITEM parent map where the walk expects a CATEGORY parent map.
          // Different key spaces, so the ancestor step could never fire and every item
          // whose production centre is assigned on a PARENT category resolved to no
          // centre at all — no fire docket, while the toast still said "fired to
          // kitchen". Call the shared module-level helper instead: it is the same one
          // sendToKitchen routed these items with, so the marker lands where the food did.
          courseItems.forEach(item => {
            getCentresForItem(item, routingConfig).forEach(cid => centresInCourse.add(cid));
          });
          if (centresInCourse.size > 0) {
            console.log('[fireCourse] derived centres from session items:', [...centresInCourse]);
          }
        } catch (err) {
          console.warn('[fireCourse] fallback centre derivation failed:', err?.message || err);
        }
      }
      centresInCourse.forEach(centreId => {
        get().routePrintJob({
          centreId,
          tableLabel,
          course: courseNum,
          type: 'fire-marker',
        });
      });
      // v5.5.977: the course has food and this venue routes to production centres, but
      // nothing resolved — no docket printed and the kitchen has NOT been told. Say so
      // rather than showing the success toast that hid this for so long.
      if (centresInCourse.size === 0 && courseItems.length > 0 && (routingConfig.centres || []).length > 0) {
        get().showToast(
          `Course ${courseNum} was NOT sent to the kitchen — no production centre matched these items. Check Print routing, and tell the kitchen directly.`,
          'error',
        );
        return;
      }
    }
    get().showToast('Course ' + courseNum + ' fired to kitchen', 'success');
  },

  // ── Walk-in order (non-table) ──────────────
  walkInOrder: null,
  clearWalkIn: () => set({ walkInOrder:null, customer:null, orderType:'dine-in', pendingLoyaltyReward:null }),

  // activeSessions — map of tableId → session for all tables that have a session
  // Used by Reports, AI assistant, and back office dashboard
  getActiveSessions: () => {
    const tables = get().tables;
    return Object.fromEntries(
      tables.filter(t => t.session).map(t => [t.id, t.session])
    );
  },

  // Get current items/totals for POS (works for both table and walk-in)
  getPOSItems: () => {
    const { activeTableId, tables, walkInOrder } = get();
    if (activeTableId) {
      return tables.find(t=>t.id===activeTableId)?.session?.items || [];
    }
    return walkInOrder?.items || [];
  },

  getPOSTotals: () => {
    const { activeTableId, tables, walkInOrder, orderType, deviceConfig } = get();
    let items, checkDiscounts, covers, serviceChargeWaived;
    if (activeTableId) {
      const session = tables.find(t=>t.id===activeTableId)?.session;
      items = session?.items || [];
      checkDiscounts = session?.discounts || [];
      covers = session?.covers || 1;
      serviceChargeWaived = session?.serviceChargeWaived || false;
    } else {
      items = walkInOrder?.items || [];
      checkDiscounts = walkInOrder?.discounts || [];
      covers = 1;
      serviceChargeWaived = walkInOrder?.serviceChargeWaived || false;
    }
    // v5.5.837: the maths itself now lives in lib/payments/checkTotals.js so that
    // SessionSync can stamp the SAME figure onto active_sessions for PaxPay Table
    // Pay. Behaviour is unchanged — this is a move, not a rewrite. Do not
    // reintroduce a second copy of the pricing rules here.
    return computeCheckTotals({
      items, checkDiscounts, covers, serviceChargeWaived,
      orderType, deviceConfig,
      discountRules: get().discountRules,
      timezone: get().locationConfig?.timezone,
      deliveryQuote: get().deliveryQuote,
      // v5.7.31: added-on (exclusive) sales tax now rides the bill. The POS
      // rendered "+ Sales Tax" lines but never charged them — total now carries
      // the exclusive share so screen, charge and record agree. UK inclusive
      // VAT contributes 0: totals unchanged.
      taxRates: get().taxRates,
    });
  },

  getPOSOrderNote: () => {
    const { activeTableId, tables, walkInOrder } = get();
    if (activeTableId) return tables.find(t=>t.id===activeTableId)?.session?.orderNote || '';
    return walkInOrder?.orderNote || '';
  },

  // ── Allergens ─────────────────────────────
  // v4.6.67: when allergen filter is set on a customer-attached order, the toast
  // offers Save to profile. This action runs upsertCustomer with the active filter.
  saveAllergensToCustomer: async (customer) => {
    if (!customer?.phone) return null;
    const list = get().allergens || [];
    return await get().upsertCustomer({ ...customer, allergens: list });
  },
  // ── Allergens ─────────────────────────────
  allergens: [],
  toggleAllergen: id => set(s=>({ allergens:s.allergens.includes(id)?s.allergens.filter(a=>a!==id):[...s.allergens,id] })),
  clearAllergens: () => set({ allergens:[] }),
  // Bulk-set the active allergen filter (e.g. from a seated guest's saved allergens). POSSurface's
  // table-customer hydrate calls this; without it, seating a table that carries a customer with
  // allergens (a reservation / waitlist party) threw "setAllergens is not a function".
  setAllergens: (arr) => set({ allergens: Array.isArray(arr) ? [...arr] : [] }),

  // ── Order type / customer ─────────────────
  orderType: 'dine-in',
  // v4.5.6: when order type changes (dine-in / takeaway / collection / delivery),
  // reprice every item in every cart against the new channel. Covers BOTH:
  //   - tables[].session.items (dine-in tables)
  //   - walkInOrder.items (walk-in / takeaway / collection / delivery flow)
  // Without this, items added BEFORE the toggle keep their old price (was the bug).
  setOrderType: t => set(s => {
    const fn = s.getItemPrice;
    if (!fn) return { orderType:t };
    const menu = (s.menuItems || []).concat(s.SEED_MENU_ITEMS || []);
    const repriceItems = (items) => (items || []).map(it => {
      const src = menu.find(m => m && m.id === it.itemId);
      if (!src) return it;
      const newUnitPrice = fn(src, t);
      if (newUnitPrice == null) return it;
      return { ...it, price: newUnitPrice };
    });
    const tables = (s.tables || []).map(tb => {
      if (!tb.session?.items) return tb;
      return { ...tb, session: { ...tb.session, items: repriceItems(tb.session.items) } };
    });
    const walkInOrder = s.walkInOrder?.items
      ? { ...s.walkInOrder, items: repriceItems(s.walkInOrder.items) }
      : s.walkInOrder;
    // v5.5.646: leaving delivery clears any held Uber Direct quote so a stale fee can't ride along.
    return { orderType:t, tables, walkInOrder, ...(t !== 'delivery' ? { deliveryQuote: null } : {}) };
  }),
  customer: null,
  // v5.5.894: pulling a customer up RE-ATTACHES their stored allergens — the saved profile
  // allergens now apply to the POS allergen filter automatically, and staff get a loud red
  // warning. Attaching a customer WITHOUT allergens (or clearing) leaves the filter alone.
  setCustomer: c => {
    if (c && Array.isArray(c.allergens) && c.allergens.length) {
      set({ customer: c, allergens: [...c.allergens] });
      const labels = c.allergens.map(a => (ALLERGEN_DEFS.find(x => x.id === a)?.label || a)).join(', ');
      const st = get();
      if (typeof st.showToast === 'function') st.showToast(`⚠️ ALLERGY — ${c.name || 'Customer'}: ${labels}`, 'error');
    } else {
      set({ customer: c });
    }
  },
  clearCustomer: () => set({ customer:null, pendingLoyaltyReward:null }),

  // ── Delivery (Uber Direct) — address-based quote + surcharge ───────────────
  // deliveryQuote holds the latest DeliveryQuoteService result for the current
  // walk-in delivery order: { available, customerFeeMinor, trueCostMinor, etaMinutes,
  // quoteId, reason, ... }. getPOSTotals folds customerFeeMinor into the bill when
  // orderType==='delivery' && available. quoteDelivery() refreshes it from the address.
  deliveryQuote: null,
  setDeliveryQuote: (q) => set({ deliveryQuote: q }),
  clearDeliveryQuote: () => set({ deliveryQuote: null }),
  quoteDelivery: async () => {
    const { orderType, customer } = get();
    if (orderType !== 'delivery') { set({ deliveryQuote: null }); return null; }
    const addr = customer?.address;
    const dropoff = typeof addr === 'string' ? { line1: addr } : (addr || {});
    if (!dropoff.postcode && dropoff.lat == null && !dropoff.line1) { set({ deliveryQuote: null }); return null; }
    const opsLocationId = getActiveLocationSync();
    const subtotalMinor = Math.round((get().getPOSTotals().discountedSub || 0) * 100);
    const q = await getDeliveryQuote({ opsLocationId, dropoff, orderSubtotalMinor: subtotalMinor });
    set({ deliveryQuote: q });
    return q;
  },
  // v5.5.349: a loyalty reward the customer chose on the customer display, staged
  // until checkout (points are only deducted when CheckoutModal applies it).
  pendingLoyaltyReward: null,
  setPendingLoyaltyReward: r => set({ pendingLoyaltyReward: r }),

  // v4.4.9: write a customer record onto a specific table's session. Used by
  // TablesSurface (Add/Edit Guest from detail panel + ReservationModal) so that
  // the existing POSSurface hydrate-from-session-on-mount path picks the customer
  // up automatically when staff returns to the table. Persists immutably; if the
  // table has no session yet (rare, but possible during reservation), this is a
  // no-op since reservation flow stores the customer on tbl.reservation, not session.
  setSessionCustomer: (tableId, c) => set(s => ({
    tables: s.tables.map(t =>
      t.id === tableId && t.session
        ? { ...t, session: { ...t.session, customer: c || null } }
        : t
    ),
  })),
  // v4.6.62: customer cache (session). DB-backed via searchCustomersLive + upsertCustomer.
  customerHistory: [],
  _cachedOrgId: null,
  // ── Customers (v4.6.62) ──────────────────────────────────────
  // Phone is the primary identifier (normalised to E.164). DB-backed via Supabase.

  // Normalise UK-ish phone strings into E.164. Falls back to digits-only if format unknown.
  _normalisePhone: (raw) => {
    if (!raw) return null;
    const digits = String(raw).replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
    if (digits.startsWith('44')) return '+' + digits;
    return digits;
  },

  // Synchronous filter against the session cache. Used by CustomerModal alongside the live
  // Supabase search for instant feedback.
  searchCustomers: q => {
    if (!q || q.length < 2) return [];
    const l = String(q).toLowerCase();
    const qd = String(q).replace(/\s/g, '');
    return (get().customerHistory || []).filter(c =>
      (c.name || '').toLowerCase().includes(l) ||
      (c.phone || '').replace(/\s/g, '').includes(qd) ||
      (c.phone_raw || '').replace(/\s/g, '').includes(qd) ||
      (c.email || '').toLowerCase().includes(l)
    ).slice(0, 8);
  },

  // Live Supabase search. CustomerModal calls this with debounce.
  // v5.5.280: raised minimum from 2→3 chars for Supabase queries to reduce
  // load at scale. Phone queries additionally gated to 6+ digits in CustomerModal.
  searchCustomersLive: async (q) => {
    if (!q || q.length < 3) return [];
    if (isMock || !supabase) return get().searchCustomers(q);
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) { console.warn('[searchCustomersLive] no locId'); return []; }
      let orgId = get()._cachedOrgId;
      if (!orgId) {
        const { data: loc, error: locErr } = await supabase.from('locations').select('org_id').eq('id', locId).single();
        if (locErr) console.warn('[searchCustomersLive] locations lookup failed:', locErr.message);
        orgId = loc?.org_id;
        if (orgId) set({ _cachedOrgId: orgId });
      }
      const term = String(q).trim();
      const safe = term.replace(/[,%]/g, '');
      let enriched = [];
      if (orgId) {
        // Primary path: search within the organisation
        const { data, error: searchErr } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, marketing_opt_in, notes, allergens')
          .eq('org_id', orgId)
          .is('deleted_at', null)
          .or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,phone_raw.ilike.%${safe}%,email.ilike.%${safe}%`)
          .limit(8);
        if (searchErr) console.warn('[searchCustomersLive] query failed:', searchErr.message);
        enriched = data || [];
      }
      // v5.5.248: fallback — if org_id lookup failed or query returned nothing,
      // try a direct phone match using normalised phone. Ensures POS devices
      // with anonymous auth can still find customers by phone number.
      // v5.5.279: MUST scope fallback by org_id — the previous version queried
      // the entire customers table, leaking PII across organisations.
      // v5.5.280: raised phone fallback threshold from 3→6 digits to reduce result set at scale
      if (enriched.length === 0 && safe.length >= 6 && orgId) {
        const phoneN = get()._normalisePhone(safe);
        const phoneFilters = [safe];
        if (phoneN && phoneN !== safe) phoneFilters.push(phoneN);
        const orFilter = phoneFilters.map(p => `phone.eq.${p},phone_raw.eq.${p}`).join(',');
        const { data: fallback } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, marketing_opt_in, notes, allergens')
          .eq('org_id', orgId)
          .is('deleted_at', null)
          .or(orFilter)
          .limit(8);
        if (fallback?.length) enriched = fallback;
      }
      // Merge into customerHistory cache, deduped
      const merged = [...enriched, ...(get().customerHistory || [])];
      const seen = new Set();
      const dedup = merged.filter(c => {
        const key = c.phone || c.email || c.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 50);
      set({ customerHistory: dedup });
      return enriched;
    } catch (err) {
      console.warn('[searchCustomersLive] failed:', err?.message || err);
      return get().searchCustomers(q);
    }
  },

  // Entry point from CustomerModal when the operator confirms customer details.
  addToHistory: (c) => {
    const phoneN = get()._normalisePhone(c.phone);
    const cached = {
      ...c,
      id: c.id || `c${Date.now()}`,
      phone: phoneN,
      phone_raw: c.phone,
      visits: (c.visits || 0) + 1,
      lastOrder: 'Just now',
    };
    set(s => ({
      customerHistory: [
        cached,
        ...(s.customerHistory || []).filter(x => x.phone !== phoneN && x.phone_raw !== c.phone),
      ].slice(0, 50),
    }));
    // Async upsert to Supabase (don't block the UI)
    get().upsertCustomer(c).catch(err => console.warn('[addToHistory upsert]', err?.message || err));
    return cached;
  },

  // Persist a customer. Returns the customer's UUID. Phone wins on conflict;
  // if a different operator types a different name, the existing one stands.
  upsertCustomer: async (c) => {
    if (isMock || !supabase) return null;
    if (isTrainingMode()) return null;   // TRAINING MODE: don't create a real CRM customer record
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) {
        console.warn('[upsertCustomer] no locationId resolved — customer not saved');
        return null;
      }
      let orgId = get()._cachedOrgId;
      if (!orgId) {
        const { data: loc, error: locErr } = await supabase.from('locations').select('org_id').eq('id', locId).single();
        if (locErr) {
          console.warn('[upsertCustomer] failed to read locations.org_id for', locId, ':', locErr.message);
        }
        orgId = loc?.org_id;
        if (orgId) set({ _cachedOrgId: orgId });
      }
      if (!orgId) {
        console.warn('[upsertCustomer] no orgId for location', locId, '— customer not saved. The location row may be missing org_id.');
        return null;
      }
      const phoneN = get()._normalisePhone(c.phone);
      if (!phoneN) {
        console.warn('[upsertCustomer] phone normalisation returned null for', c.phone);
        return null;
      }
      const row = {
        org_id: orgId,
        phone: phoneN,
        phone_raw: c.phone || phoneN,
        email: c.email || null,
        name: c.name || 'Customer',
        notes: c.notes || null,
        marketing_opt_in: !!c.marketingOptIn,
        marketing_opt_in_at: c.marketingOptIn ? new Date().toISOString() : null,
        // v4.6.67: allergens carried through. Caller decides whether to include them.
        allergens: Array.isArray(c.allergens) ? c.allergens : undefined,
        updated_at: new Date().toISOString(),
      };
      const { data: existing, error: lookupErr } = await supabase.from('customers')
        .select('id, name, email, marketing_opt_in, allergens')
        .eq('org_id', orgId).eq('phone', phoneN).is('deleted_at', null).maybeSingle();
      if (lookupErr) {
        console.warn('[upsertCustomer] lookup failed:', lookupErr.message, '(may be RLS — check customers SELECT policy)');
      }
      if (existing?.id) {
        const patch = { updated_at: row.updated_at };
        if (!existing.name && row.name) patch.name = row.name;
        if (!existing.email && row.email) patch.email = row.email;
        if (row.marketing_opt_in && !existing.marketing_opt_in) {
          patch.marketing_opt_in = true;
          patch.marketing_opt_in_at = row.marketing_opt_in_at;
        }
        // v4.6.67: replace allergens array if caller passed one (explicit save
        // from the toast / detail page). Don't merge — operator decides exact set.
        if (Array.isArray(row.allergens)) patch.allergens = row.allergens;
        if (Object.keys(patch).length > 1) {
          const { error: updErr } = await supabase.from('customers').update(patch).eq('id', existing.id);
          if (updErr) console.warn('[upsertCustomer] update existing failed:', updErr.message);
        }
        return existing.id;
      } else {
        const { data: created, error } = await supabase.from('customers').insert(row).select('id').single();
        if (error) {
          console.warn('[upsertCustomer] insert failed:', error.message, '(may be RLS — check customers INSERT policy; or unique constraint on (org_id, phone))');
          return null;
        }
        return created?.id || null;
      }
    } catch (err) {
      console.warn('[upsertCustomer] failed:', err?.message || err);
      return null;
    }
  },

  // Attribute a closed check / walk-in to a customer. Increments visit_count + spend
  // on customer_locations and inserts a customer_orders row. Returns customer_id.
  attributeOrderToCustomer: async ({ customer, orderRecord }) => {
    if (isMock || !supabase) return null;
    // TRAINING MODE: never create/update a real CRM customer or earn loyalty points.
    if (isTrainingMode()) return null;
    if (!customer?.phone || !orderRecord) {
      console.warn('[attributeOrderToCustomer] skipped — missing customer.phone or orderRecord');
      return null;
    }
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) {
        console.warn('[attributeOrderToCustomer] skipped — no locationId resolved');
        return null;
      }
      // v5.5.5: explicit step logging so we can see exactly which write failed when
      // a customer doesn't appear in the CRM after an order. Previous version was
      // fire-and-forget with a generic catch-all that hid which step broke.
      const customerId = await get().upsertCustomer(customer);
      if (!customerId) {
        console.warn('[attributeOrderToCustomer] upsertCustomer returned null for', customer.phone, '— check upsertCustomer logs above');
        return null;
      }
      console.log('[attributeOrderToCustomer] step 1/3 — customer upserted:', customerId, 'phone:', customer.phone, 'location:', locId);

      // Step 2: bump visit_count + lifetime_revenue on customer_locations.
      // v5.5.7: removed dependency on the upsert_customer_visit RPC entirely.
      // Two failure modes that the v5.5.5 fallback didn't catch:
      //   (a) RPC returns error:null but writes nothing (broken function body,
      //       missing GRANT, RLS in SECURITY INVOKER mode that hides write).
      //       v5.5.5's fallback only fired on rpcErr — silent success was fatal.
      //   (b) The fallback's onConflict:'customer_id,location_id' upsert
      //       requires that unique constraint to exist on the table. If the
      //       v4.6.62 migration ran without creating it, the upsert errors.
      // New approach: explicit read → INSERT or UPDATE. No RPC. No onConflict.
      // No DB-side requirements beyond the table existing. Race-prone if two
      // devices close orders for the same customer simultaneously, but for
      // restaurant load that's a non-issue, and correctness > theoretical races.
      let cl_step_status = 'unknown';
      try {
        const { data: existingLoc, error: readErr } = await supabase
          .from('customer_locations')
          .select('visit_count, lifetime_revenue')
          .eq('customer_id', customerId)
          .eq('location_id', locId)
          .maybeSingle();
        if (readErr) {
          console.warn('[attributeOrderToCustomer] customer_locations read failed:', readErr.message, '(may be RLS — check customer_locations SELECT policy)');
        }
        const incRevenue = Number(orderRecord.total) || 0;
        const nowIso = new Date().toISOString();
        if (existingLoc) {
          // UPDATE existing row
          const newCount = (Number(existingLoc.visit_count) || 0) + 1;
          const newRevenue = (Number(existingLoc.lifetime_revenue) || 0) + incRevenue;
          const { error: updErr } = await supabase
            .from('customer_locations')
            .update({
              visit_count: newCount,
              lifetime_revenue: newRevenue,
              last_visit_at: nowIso,
            })
            .eq('customer_id', customerId)
            .eq('location_id', locId);
          if (updErr) {
            console.warn('[attributeOrderToCustomer] customer_locations UPDATE failed:', updErr.message, '(may be RLS — check customer_locations UPDATE policy)');
            cl_step_status = 'update_failed';
          } else {
            console.log('[attributeOrderToCustomer] step 2/3 — customer_locations UPDATE (visit', newCount, ', rev', newRevenue.toFixed(2), ')');
            cl_step_status = 'updated';
          }
        } else {
          // INSERT new row
          const { error: insErr } = await supabase
            .from('customer_locations')
            .insert({
              customer_id: customerId,
              location_id: locId,
              visit_count: 1,
              lifetime_revenue: incRevenue,
              last_visit_at: nowIso,
            });
          if (insErr) {
            // If a concurrent insert beat us, the row exists now — try update.
            if (/duplicate|conflict/i.test(insErr.message)) {
              console.warn('[attributeOrderToCustomer] customer_locations INSERT raced — retrying as UPDATE');
              const { error: retryErr } = await supabase
                .from('customer_locations')
                .update({ last_visit_at: nowIso })
                .eq('customer_id', customerId).eq('location_id', locId);
              if (retryErr) {
                console.warn('[attributeOrderToCustomer] customer_locations retry-update failed:', retryErr.message);
                cl_step_status = 'race_retry_failed';
              } else {
                cl_step_status = 'inserted_via_race_retry';
              }
            } else {
              console.warn('[attributeOrderToCustomer] customer_locations INSERT failed:', insErr.message, '(may be RLS — check customer_locations INSERT policy)');
              cl_step_status = 'insert_failed';
            }
          } else {
            console.log('[attributeOrderToCustomer] step 2/3 — customer_locations INSERT (first visit at this location)');
            cl_step_status = 'inserted';
          }
        }
      } catch (e) {
        console.warn('[attributeOrderToCustomer] customer_locations write threw:', e?.message || e);
        cl_step_status = 'threw';
      }
      void cl_step_status; // keep for breakpoint readability if needed

      // Step 3: insert customer_orders row.
      const itemSummary = (orderRecord.items || []).map(i => ({
        name: i.name, qty: i.qty, price: i.price,
      }));
      const { error: ordersErr } = await supabase.from('customer_orders').insert({
        customer_id: customerId,
        location_id: locId,
        closed_check_id: orderRecord.ref || orderRecord.id || null,
        ordered_at: new Date().toISOString(),
        total: Number(orderRecord.total) || 0,
        channel: orderRecord.orderType || orderRecord.type || orderRecord.source || 'unknown',
        item_summary: itemSummary,
      });
      if (ordersErr) {
        console.warn('[attributeOrderToCustomer] customer_orders insert failed:', ordersErr.message);
      } else {
        console.log('[attributeOrderToCustomer] step 3/3 — customer_orders inserted');
      }

      // Stamp customer_id on the closed_check (best-effort; scope by location_id
      // to avoid the cross-location ref collision that would otherwise update
      // closed_checks at OTHER locations sharing the same ref string).
      if (orderRecord.ref) {
        const { error: stampErr } = await supabase.from('closed_checks')
          .update({ customer_id: customerId })
          .eq('ref', orderRecord.ref)
          .eq('location_id', locId);
        if (stampErr) console.warn('[attributeOrderToCustomer] closed_checks customer_id stamp failed:', stampErr.message);
      }

      // v5.5.272: Send welcome SMS invite for new customers (pre-register for loyalty).
      // Fire-and-forget — send-welcome has atomic dedup via welcome_sent_at so calling
      // it for existing customers is a harmless no-op. Covers kiosk guest checkout,
      // POS customer capture, and any other surface using attributeOrderToCustomer.
      // (Online ordering already fires this from customerLookup.js; OTP-verified
      // customers get it from loyalty-otp verify. The dedup prevents double sends.)
      (async () => {
        try {
          let companyId = null;
          if (platformSupabase) {
            const { data: pLoc } = await platformSupabase
              .from('locations')
              .select('company_id')
              .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
              .limit(1).maybeSingle();
            companyId = pLoc?.company_id;
          }
          if (companyId) {
            const wToken = await ensureAuthToken();
            fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-welcome`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(wToken ? { Authorization: `Bearer ${wToken}` } : {}) },
              body: JSON.stringify({
                customer_id: customerId,
                company_id: companyId,
                location_id: locId,
              }),
            }).catch(() => {});
          }
        } catch (e) {
          console.warn('[attributeOrderToCustomer] welcome send failed (non-fatal):', e?.message);
        }
      })();

      // v5.5.315: link any reward redemption to this check so a future refund
      // restores the spent points. The redeem ran in CheckoutModal BEFORE the
      // check existed, so its loyalty_transactions row has closed_check_id=NULL
      // — loyalty-refund (which reverses by closed_check_id) would never find it.
      // Back-patch it to the same unique check id the earn uses. Best-effort: if
      // it no-ops, behaviour is unchanged from before (redeem just won't reverse).
      const redeemKey = orderRecord.loyaltyRedemption?.idempotency_key;
      if (redeemKey && supabase) {
        supabase.from('loyalty_transactions')
          .update({ closed_check_id: orderRecord.id })
          .eq('idempotency_key', redeemKey)
          .is('closed_check_id', null)
          .then(({ error }) => { if (error) console.warn('[attributeOrderToCustomer] redeem link failed:', error.message); });
      }

      // v5.5.218: Loyalty points earn — fire-and-forget after customer is resolved.
      // Same async IIFE pattern as gift card reversal: local mutation already happened
      // so UX stays snappy. If the edge function is unreachable the points aren't
      // earned — acceptable because the customer can contact support, and we log it.
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[attributeOrderToCustomer] loyalty earn skipped — no auth token'); return; }
          // v5.5.256: resolve parent category for variants so stamp cards can
          // match qualifying categories. Variants (sizes) don't have their own
          // cat field — they inherit from their master product.
          const allMenuItems = get().menuItems || [];
          const menuById = new Map(allMenuItems.map(m => [m.id, m]));
          const earnBody = {
            customer_id: customerId,
            location_id: locId,
            // v5.5.311: use the globally-unique closed-check id (chk-<ts>, the
            // closed_checks PK) NOT the display ref. Refs cycle R1–R99 per
            // location and repeat across locations, so an `earn:<ref>`
            // idempotency key collided — a 2nd customer 99 orders later (or in
            // another tenant) was told "already processed" and earned 0 points,
            // or hit the global UNIQUE constraint and silently dropped the
            // ledger row. The chk id is unique, so the key never collides.
            closed_check_id: orderRecord.id || orderRecord.ref,
            channel: orderRecord.orderType || orderRecord.source || 'pos',
            items: (orderRecord.items || []).map(i => {
              let cat = i.cat || i.category || null;
              // v5.5.259: Variants ALWAYS use parent's category. Variant
              // rows in the DB can have a stale/wrong cat (e.g. Sandwiches
              // instead of Coffee) from category reassignment or creation
              // bugs. The parent's cat is the source of truth for what
              // "type" of product this is.
              if (i.parentId) {
                const parent = menuById.get(i.parentId);
                const parentCat = parent?.cat || parent?.cats?.[0] || null;
                if (parentCat) cat = parentCat;
              }
              // Double fallback: look up the original menu item's cat
              if (!cat) {
                const mi = menuById.get(i.itemId || i.id);
                if (mi?.parentId) {
                  // Variant via menu lookup — use parent's cat
                  const parent = menuById.get(mi.parentId);
                  cat = parent?.cat || parent?.cats?.[0] || null;
                } else {
                  cat = mi?.cat || mi?.cats?.[0] || null;
                }
              }
              return {
                name: i.name, qty: i.qty || 1, price: i.price || 0,
                cat,
                id: i.itemId || i.id || null,
                isComp: !!i.isComp,
                staffDiscount: !!i.isStaffDiscount,
                isGiftCard: !!i.isGiftCard,
              };
            }),
            subtotal: Number(orderRecord.total) || 0,
            staff_id: orderRecord.staffId || null,
          };
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-earn`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify(earnBody),
            }
          );
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            console.info('[loyalty-earn] ✓', j.points_earned, 'pts → balance:', j.balance, j.is_new_member ? '(new member)' : '');
            // Show points-earned toast (fire after short delay so payment toast clears first)
            if (j.points_earned > 0) {
              setTimeout(() => {
                get().showToast?.(
                  j.is_new_member
                    ? `⭐ Welcome! ${j.points_earned} loyalty points earned`
                    : `⭐ ${j.points_earned} loyalty points earned (balance: ${j.balance})`,
                  'success'
                );
              }, 1500);
            }
            // Stamp card notifications
            if (j.stamps_awarded && j.stamps_awarded.length > 0) {
              j.stamps_awarded.forEach((sa, idx) => {
                setTimeout(() => {
                  get().showToast?.(
                    sa.completed
                      ? `☕ ${sa.program_name} COMPLETE! Reward earned 🎁`
                      : `☕ +${sa.stamps} stamp${sa.stamps > 1 ? 's' : ''} on ${sa.program_name} (${sa.new_total} collected)`,
                    sa.completed ? 'success' : 'info'
                  );
                }, 2500 + idx * 1200);
              });
            }
            // Stamp loyalty summary on the closed check in local state for receipt/refund use
            if (j.points_earned > 0 || j.is_new_member) {
              const loyaltySummary = {
                points_earned: j.points_earned,
                balance: j.balance,
                member_code: j.member_code || null,
                is_new_member: !!j.is_new_member,
              };
              set(s => ({
                closedChecks: s.closedChecks.map(chk =>
                  chk.id === orderRecord.id ? { ...chk, loyalty: loyaltySummary } : chk
                ),
              }));
              // Best-effort persist loyalty jsonb to Supabase
              // v5.5.279: location_id guard on closed_checks update
              const loyLocId = getActiveLocationSync();
              supabase.from('closed_checks')
                .update({ loyalty: loyaltySummary })
                .eq('id', orderRecord.id)
                .eq('location_id', loyLocId)
                .then(({ error: le }) => { if (le) console.warn('[loyalty-earn] closed_check update:', le.message); });
            }
          } else {
            // 404 = loyalty not configured for this company — not an error
            if (res.status !== 404) {
              console.warn('[loyalty-earn] HTTP', res.status, j.error || '');
            }
          }
        } catch (e) {
          console.warn('[loyalty-earn] failed:', e?.message || e);
        }
      })();

      return customerId;
    } catch (err) {
      console.warn('[attributeOrderToCustomer] failed:', err?.message || err);
      return null;
    }
  },

  // ── Collection queue ──────────────────────
  orderQueue: [],
  addToQueue: o => set(s => ({ orderQueue: [o, ...s.orderQueue] })),
  updateQueueStatus: (ref, status) => set(s => ({ orderQueue: s.orderQueue.map(o => o.ref===ref ? {...o, status} : o) })),
  updateQueueItem: (ref, patch) => set(s => ({ orderQueue: s.orderQueue.map(o => o.ref===ref ? {...o,...patch} : o) })),
  removeFromQueue: ref => {
    set(s => ({ orderQueue: s.orderQueue.filter(o => o.ref!==ref) }));
    // v5.5.557: also delete the DB row. Previously this only cleared the local screen;
    // the order_queue row lingered (QueueSync only writes/deletes via in-memory tracking
    // that resets on reload), so a finished/collected order RESURRECTED on the next boot
    // (loadQueues re-pulls any row that isn't status 'collected'). Location-scoped because
    // refs (e.g. #1002) collide across locations.
    try {
      const locId = getActiveLocationSync();
      if (supabase && locId && ref) {
        // v5.5.971: PostgREST resolves with { error } — the old .catch()-only handler
        // never saw a refusal, which is exactly how the order RESURRECTS at next boot.
        Promise.resolve(supabase.from('order_queue').delete().eq('ref', ref).eq('location_id', locId))
          .then(({ error }) => reportSave('order queue delete', error))
          .catch(e => { reportSave('order queue delete', e); console.warn('[removeFromQueue] db delete:', e?.message); });
      }
    } catch { /* non-fatal */ }
  },

  // ── 86 ────────────────────────────────────
  eightySixIds: [],
  showItemImages: false,
  setShowItemImages: (val) => set({ showItemImages: val }),
  // v5.5.799: how much customer detail the POS asks for on takeaway/collection orders.
  // 'full' = name+phone modal (default) · 'name' = single required name field · 'none' = no prompt.
  // Persisted on ops locations.pos_settings.takeaway_customer_details; loaded at boot in SyncBridge
  // and refreshed via the config-push snapshot. POS-only — online/QR/kiosk flows are untouched.
  takeawayCustomerDetails: 'full',
  setTakeawayCustomerDetails: (val) => set({ takeawayCustomerDetails: ['full','name','none'].includes(val) ? val : 'full' }),
  // v5.7.5 - TIP ON PRINTED RECEIPT (United States signature flow). Venue-wide,
  // read from ops locations.pos_settings.tip_on_receipt at boot (SyncBridge).
  // The POS uses it for the merchant-slip print decision and the History
  // countdown fallback; the SERVER re-reads the setting itself on every job
  // create, so a stale client value can never open or widen a capture window.
  tipOnReceipt: { enabled: false, captureHours: 24 },
  setTipOnReceipt: (val) => {
    const hours = Number(val?.capture_hours ?? val?.captureHours);
    set({ tipOnReceipt: {
      enabled: val?.enabled === true,
      captureHours: Number.isFinite(hours) ? Math.max(1, Math.min(72, hours)) : 24,
    } });
  },
  toggle86: id => {
    const is86 = get().eightySixIds.includes(id);
    set(s => ({ eightySixIds: is86 ? s.eightySixIds.filter(x=>x!==id) : [...s.eightySixIds, id] }));
    // Write to Supabase (no-op in mock mode)
    toggle86DB(id, is86);
    // v5.5.825: un-86ing an item whose daily count is exhausted must ALSO clear the
    // count. POSSurface blocks any item with remaining <= 0 independently of the 86
    // list (the cross-device oversell guard), so on its own the un-86 silently does
    // nothing — staff tap it, the toast says un-86'd, and the item still refuses to
    // add with "out of stock". Clearing returns the item to untracked until someone
    // sets a new count. Only when EXHAUSTED: a count with stock left is still valid,
    // so un-86ing a manually-86'd item must not wipe its remaining quantity.
    if (is86) {
      const dc = get().dailyCounts?.[id];
      if (dc && typeof dc.remaining === 'number' && dc.remaining <= 0) {
        get().clearDailyCount(id);
      }
    }
    // Best-effort: mirror the new 86 state to HubRise channels (instant out-of-stock).
    // The reconcile cron also resyncs, so a missed push self-heals. !is86 = now 86'd.
    try {
      const locId = getActiveLocationSync();
      if (locId && isHubriseConnected(locId)) hubrisePushStock(locId, [{ itemId: id, is86: !is86 }]).catch(() => {});
    } catch { /* non-fatal */ }
    // v5.5.735: record the 86 change on the activity timeline so it shows in the feed AND the AI
    // assistant can answer "when/who marked the donut 86". is86 = state BEFORE the toggle.
    try {
      const locId = getActiveLocationSync();
      const it = get().menuItems.find(i => i.id === id);
      const nm = it?.name || it?.menuName || 'Item';
      if (locId) logActivity(locId, {
        kind: 'stock',
        severity: is86 ? 'info' : 'action',
        title: is86 ? `${nm} back on` : `${nm} marked 86 (sold out)`,
        actorName: get().staff?.name || null,
        refType: 'item', refId: id,
      });
    } catch { /* feed best-effort */ }
  },

  // ── Daily counts / par levels ──────────────────────────────────────────────
  dailyCounts: {},
  setDailyCount: (itemId, count) => {
    const n = parseInt(count);
    if (!n || n <= 0) return;
    const was86 = get().eightySixIds.includes(itemId);
    const prevCount = get().dailyCounts?.[itemId];   // v5.5.971 — for the revert below
    set(s => ({
      dailyCounts: { ...s.dailyCounts, [itemId]: { par: n, remaining: n } },
      eightySixIds: was86 ? s.eightySixIds.filter(x => x !== itemId) : s.eightySixIds,
    }));
    // v5.5.241: persist to stock_levels for cross-device sync.
    // Pass the location from getActiveLocationSync() so we never wait on
    // getLocationId()'s async auth.getUser() call, and log the full response
    // so PostgREST errors are visible (the previous .catch() only caught
    // thrown errors — Supabase returns { data, error } as resolved promises).
    const _loc = getActiveLocationSync();
    // v5.5.971: a rejected stock write used to be console-only — the count sat on
    // screen all service and was gone after refresh. Report + roll the count back.
    // Setting a count also un-86s the item, so the revert has to put the 86 back too —
    // otherwise a refused write leaves the item ORDERABLE on every till with no stock
    // behind it, which is worse than the lost count.
    const restore86 = () => set(s => ({
      eightySixIds: was86 && !s.eightySixIds.includes(itemId) ? [...s.eightySixIds, itemId] : s.eightySixIds,
    }));
    const stockFailed = (err) => {
      reportSave('stock count', err);
      set(s => ({ dailyCounts: { ...s.dailyCounts, [itemId]: prevCount } }));
      restore86();
      get().showToast?.(
        was86
          ? 'Stock count was NOT saved — the item is still 86\'d. Check you\'re signed in, then try again'
          : 'Stock count was NOT saved — check you\'re signed in, then try again',
        'error',
      );
    };
    upsertStockLevel(itemId, n, null, _loc).then(res => {
      if (res?.error) { console.error('[setDailyCount] upsertStockLevel error:', res.error.message, res.error); stockFailed(res.error); }
      else reportSave('stock count', null);
    }).catch(err => { console.error('[setDailyCount] upsertStockLevel threw:', err?.message); stockFailed(err); });
    // Un-86 in DB too if applicable
    if (was86) {
      Promise.resolve(toggle86DB(itemId, true))
        .then(res => {
          reportSave('86 list', res?.error || null);
          // The un-86 was refused but the item already left the 86 list on screen — put it
          // back, or this till sells something every other till still shows as unavailable.
          if (res?.error) { restore86(); get().showToast?.('Could not take the item off the 86 list — it is still marked unavailable', 'error'); }
        })
        .catch(err => {
          reportSave('86 list', err);
          restore86();
          console.warn('[setDailyCount] toggle86DB un-86:', err?.message);
        });
    }
  },
  clearDailyCount: (itemId) => {
    const prevCount = get().dailyCounts?.[itemId];
    set(s => ({
      dailyCounts: { ...s.dailyCounts, [itemId]: undefined },
    }));
    // v5.5.241: remove from stock_levels — pass location directly
    const _loc2 = getActiveLocationSync();
    const clearFailed = (err) => {
      reportSave('stock count clear', err);
      set(s => ({ dailyCounts: { ...s.dailyCounts, [itemId]: prevCount } }));
      get().showToast?.('Stock count was NOT cleared — it will come back on refresh', 'error');
    };
    deleteStockLevel(itemId, _loc2).then(res => {
      if (res?.error) { console.error('[clearDailyCount] deleteStockLevel error:', res.error.message); clearFailed(res.error); }
      else reportSave('stock count clear', null);
    }).catch(err => { console.error('[clearDailyCount] deleteStockLevel threw:', err?.message); clearFailed(err); });
  },
  decrementDailyCount: (itemId, qty = 1) => {
    // v4.6.11: single source of truth for daily-count adjustments.
    // qty > 0: item consumed (remaining goes down, auto-86 when crossing to 0)
    // qty < 0: item returned (remaining goes back up, capped at par — no auto un-86)
    // Propagates to parent menu item if the child's parent also has a count set
    // (supports tracking stock on a variant-parent like "House Wine" when children
    // like "House Wine 175ml" are what actually get ordered).
    if (!itemId || !qty) return;
    const state = get();
    const menuItems = state.menuItems || [];
    const item = menuItems.find(m => m.id === itemId);
    const parentId = (item?.parentId || item?.parent_id) || null;

    const ids = [];
    if (state.dailyCounts[itemId]) ids.push(itemId);
    if (parentId && state.dailyCounts[parentId]) ids.push(parentId);
    if (!ids.length) return;

    // Local optimistic update (instant UI responsiveness)
    set(s => {
      const newCounts = { ...s.dailyCounts };
      const newEightySix = [...s.eightySixIds];
      const soldOutNames = [];

      ids.forEach(id => {
        const cur = newCounts[id];
        if (!cur) return;
        const newRem = Math.max(0, Math.min(cur.par, cur.remaining - qty));
        newCounts[id] = { ...cur, remaining: newRem };

        // Auto-86 on the transition from positive to zero. Repeated decrements at
        // 0 don't re-trigger the toast. Restores (qty<0) never un-86 automatically —
        // that's setDailyCount's job so manual toggle86's aren't clobbered.
        if (cur.remaining > 0 && newRem <= 0) {
          if (!newEightySix.includes(id)) {
            newEightySix.push(id);
            // v5.5.239: auto-86 is now also handled atomically by the
            // decrement_stock RPC, but we keep the local push for instant UI
          }
          soldOutNames.push(menuItems.find(mi => mi.id === id)?.name || id);
        }
      });

      if (soldOutNames.length) {
        setTimeout(() => get().showToast(`${soldOutNames[0]} sold out — auto 86'd`, 'warning'), 0);
      }
      return { dailyCounts: newCounts, eightySixIds: newEightySix };
    });

    // v5.5.241: DB-level atomic decrement — pass location directly.
    const _loc3 = getActiveLocationSync();
    ids.forEach(id => {
      // v5.5.971: no toast on this path — it runs mid-service on every sale — but the
      // saveHealth banner must light up, or stock silently drifts away from the DB.
      if (qty > 0) {
        decrementStockRPC(id, qty, _loc3).then(res => {
          if (res?.error) console.error('[decrementDailyCount] decrement RPC error:', res.error.message);
          reportSave('stock decrement', res?.error || null);
        }).catch(err => { reportSave('stock decrement', err); console.error('[decrementDailyCount] decrement RPC threw:', err?.message); });
      } else {
        restoreStockRPC(id, Math.abs(qty), _loc3).then(res => {
          if (res?.error) console.error('[decrementDailyCount] restore RPC error:', res.error.message);
          reportSave('stock restore', res?.error || null);
        }).catch(err => { reportSave('stock restore', err); console.error('[decrementDailyCount] restore RPC threw:', err?.message); });
      }
    });
  },

  // ── Bar tabs ──────────────────────────────
  tabs: [],
  activeTabId: null,
  openTab: ({ name, seatId=null, tableId=null, preAuth=false, preAuthAmount=50, note='', preAuthPaymentIntentId=null, preAuthStripeAccount=null, preAuthHeldMinor=null, preAuthProcessor=null }) => {
    // v5.5.324: when a real card hold was placed at open, the PaymentIntent +
    // connected-account + held amount ride along on the tab so close can
    // capture it (and void can release it). Null when no reader / hold skipped.
    const tab = { id:`tab-${Date.now()}`, ref:`TAB-${_tabNum++}`, name:name.trim(), seatId, tableId, openedBy:get().staff?.name||'Staff', openedAt:Date.now(), status:'open', preAuth, preAuthAmount, preAuthPaymentIntentId, preAuthStripeAccount, preAuthHeldMinor, preAuthProcessor, rounds:[], note, total:0 };
    set(s=>({ tabs:[tab,...s.tabs], activeTabId:tab.id }));
    // v4.6.26: when a bar tab is linked to a real table, flip that table on
    // the floor plan to 'occupied' so it renders correctly. Only do this if
    // the table is currently 'available' — don't stomp an active dine-in
    // session or a reservation.
    if (tableId) {
      const st = get();
      const tbl = (st.tables||[]).find(t => t.id === tableId);
      if (tbl && tbl.status === 'available') {
        get()._updateTable(tableId, { status: 'occupied' });
      }
    }
    return tab;
  },
  setActiveTab: id => set({ activeTabId:id }),
  addRoundToTab: (tabId, items, note='') => {
    // PRE-AUTH CAP: a card-held tab can only be captured up to the held amount. Block a round that
    // would push the tab over it — otherwise closing/cashing-off errors on the un-capturable overage.
    // (Card holds generally can't be raised, so staff take payment to close + reopen, or take a bigger
    // deposit.) Only enforced for tabs with a real card hold (preAuthPaymentIntentId).
    const _capTab = get().tabs.find(t => t.id === tabId);
    if (_capTab?.preAuthPaymentIntentId) {
      const cap = _capTab.preAuthHeldMinor != null ? _capTab.preAuthHeldMinor / 100 : (_capTab.preAuthAmount || 0);
      const roundSub = (items || []).reduce((s, i) => s + i.price * i.qty, 0);
      if (cap > 0 && (_capTab.total || 0) + roundSub > cap + 0.005) {
        const remaining = Math.max(0, cap - (_capTab.total || 0));
        get().showToast?.(`Card hold is ${money(cap)} — only ${money(remaining)} left on this tab. Take payment to close it (or open a new tab) before adding more.`, 'error');
        return { ok: false, reason: 'preauth_limit', remaining };
      }
    }
    const round = { id:uid(), sentAt:Date.now(), items:items.map(i=>({...i})), subtotal:items.reduce((s,i)=>s+i.price*i.qty,0), note };
    // v4.6.11: bar rounds deplete daily counts too — previously a bar tab could
    // sell an item past its stock with no auto-86 triggered.
    (items || []).forEach(i => {
      const id = i.itemId || i.id;
      if (id) get().decrementDailyCount(id, i.qty || 1);
      // v5.5.189: bar rounds also deplete modifier sub-item counts
      (i.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, (mod.qty || 1) * (i.qty || 1));
      });
    });
    set(s=>({ tabs:s.tabs.map(t=>{ if(t.id!==tabId)return t; const rounds=[...t.rounds,round]; return{...t,rounds,status:'running',total:rounds.reduce((s,r)=>s+r.subtotal,0)}; }) }));
    // v4.6.5 Bug 5: bar tab rounds never hit production centres. Now mirrors sendToKitchen
    // so each round fires KDS tickets + print jobs for every centre its items touch.
    try {
      const state = get();
      const tab = state.tabs.find(t => t.id === tabId) || { name: 'Bar tab' };
      const staffName = state.staff?.name || 'Server';
      const label = `Bar · ${tab.name || tabId}`;
      const getRoutingConfig = () => {
        try {
          const stored = state.printRouting;
          if (stored?.centres?.length) return stored;
          return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
        } catch { return { centres: [], routing: {} }; }
      };
      const routingConfig = getRoutingConfig();
      const centres = routingConfig.centres || [];
      const routing = routingConfig.routing || {};
      const parentMap = (() => {
        try {
          const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
          const cats = snap.menuCategories || state.menuCategories || [];
          const m = {}; cats.forEach(c => { m[c.id] = c.parentId || null; }); return m;
        } catch { return {}; }
      })();
      const catOrAncestor = (catId, set, depth=0) => {
        if (!catId || depth > 5) return false;
        if (set.has(catId)) return true;
        return catOrAncestor(parentMap[catId], set, depth + 1);
      };
      const allMenuItems = state.menuItems || [];
      const centresForItem = (item) => {
        if (!centres.length) return [];
        const mi = allMenuItems.find(i => i.id === (item.itemId || item.id));
        const itemCat = item.cat || item.cats?.[0] || mi?.cat || mi?.cats?.[0] || null;
        const parentCat = (mi?.parentId ? allMenuItems.find(i => i.id === mi.parentId)?.cat : null) || null;
        const matched = [];
        centres.forEach(c => {
          const r = routing[c.id];
          if (!r?.assignedCategories?.length) return;
          if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
          const set = new Set(r.assignedCategories);
          if ((itemCat && catOrAncestor(itemCat, set)) || (parentCat && catOrAncestor(parentCat, set))) matched.push(c.id);
        });
        return matched;
      };
      const byCentre = {};
      items.forEach(it => {
        if (it.voided) return;
        centresForItem(it).forEach(cid => {
          if (!byCentre[cid]) byCentre[cid] = [];
          byCentre[cid].push(it);
        });
      });
      const getCentrePrinter = (cid) => {
        const c = centres.find(x => x.id === cid);
        return c?.printer?.name || c?.name || { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' }[cid] || 'Kitchen';
      };
      const newTickets = Object.entries(byCentre).map(([centreId, centreItems]) => ({
        id: `kds-${Date.now()}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
        table: label, server: staffName, covers: 1, centreId,
        sentAt: Date.now(), minutes: 0,
        firedCourses: [0, 1], allCourses: [1],
        items: centreItems.map(i => ({
          qty: i.qty,
          name: i.kitchenName || i.menu_name || i.menuName || i.name,
          mods: [
            // v4.6.10: no groupLabel prefix on bar-round tickets either.
            // v5.5.965: one pass in line order — instructions were forced last here too.
            ...(i.mods?.map(m => (m._instruction ? m.label : (m.name || m.label))).filter(Boolean) || []),
            ...(i.notes ? [`📝 ${i.notes}`] : []),
            ...(note ? [`📝 ${note}`] : []),
          ],
          course: i.course ?? 1,
          fired: true,
          centreId, uid: i.uid,
        })),
      }));
      if (newTickets.length) {
        set(s => ({ kdsTickets: [...s.kdsTickets, ...newTickets] }));
        newTickets.forEach(t => {
          insertKDSTicket(t);
          if (t.items.length) state.routePrintJob?.({
            centreId: t.centreId,
            printerName: getCentrePrinter(t.centreId),
            tableLabel: t.table,
            server: t.server,
            covers: t.covers,
            course: 1,
            items: t.items,
            type: 'kitchen',
          });
        });
      }
    } catch (e) { console.warn('[addRoundToTab] KDS/print dispatch failed:', e?.message || e); }
    return round;
  },
  updateTabNote: (tabId,note) => set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,note}:t) })),
  updateTabStatus: (tabId,status) => set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,status}:t) })),
  // Raise the card-hold ceiling after a successful Stripe incremental authorization (step-up).
  setTabHold: (tabId, heldMinor) => set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t, preAuthHeldMinor: heldMinor, preAuthAmount: heldMinor/100}:t) })),
  closeTab: tabId => {
    const st = get();
    const closing = st.tabs.find(t => t.id === tabId);
    set(s=>({ tabs:s.tabs.map(t=>t.id===tabId?{...t,status:'closed'}:t), activeTabId:s.activeTabId===tabId?null:s.activeTabId }));
    // v4.6.26: release the floor-plan table if this was a bar tab linked to
    // one, and no other open bar tab is still on it.
    if (closing && closing.tableId) {
      const remaining = get().tabs.some(t => t.tableId === closing.tableId && t.status !== 'closed' && t.id !== tabId);
      if (!remaining) {
        const tbl = (get().tables||[]).find(t => t.id === closing.tableId);
        if (tbl && tbl.status === 'occupied') {
          get()._updateTable(closing.tableId, { status: 'available' });
        }
      }
    }
  },
  voidTabRound: (tabId,roundId) => set(s=>({ tabs:s.tabs.map(t=>{ if(t.id!==tabId)return t; const rounds=t.rounds.filter(r=>r.id!==roundId); return{...t,rounds,total:rounds.reduce((s,r)=>s+r.subtotal,0)}; }) })),
  seedTabs: () => set({ tabs:[
    { id:'t-demo1', ref:'TAB-001', name:'Maria G.', seatId:'B1', tableId:null, openedBy:'Maria', openedAt:Date.now()-22*60000, status:'running', preAuth:false, preAuthAmount:0, note:'Birthday drinks', total:29.8,
      rounds:[
        { id:'r1', sentAt:Date.now()-20*60000, subtotal:17.4, note:'', items:[
          {uid:'ri1',name:'Lager — Pint',price:5.8,qty:2,mods:[],notes:''},
          {uid:'ri2',name:'Sparkling water',price:2.8,qty:1,mods:[],notes:'No ice'},
        ]},
        { id:'r2', sentAt:Date.now()-8*60000, subtotal:12.4, note:'', items:[
          {uid:'ri3',name:'Stout — Pint',price:6.2,qty:1,mods:[],notes:''},
          {uid:'ri4',name:'House white 250ml',price:8.5,qty:1,mods:[],notes:'Extra cold'},
        ]},
      ]},
    { id:'t-demo2', ref:'TAB-002', name:'Table 4 bar', seatId:null, tableId:'t4', openedBy:'Tom', openedAt:Date.now()-45*60000, status:'running', preAuth:false, preAuthAmount:0, note:'', total:35.2,
      rounds:[
        { id:'r3', sentAt:Date.now()-40*60000, subtotal:20.7, note:'', items:[
          {uid:'ri5',name:'Lager — Pint',price:5.8,qty:2,mods:[],notes:''},
          {uid:'ri6',name:'House red 175ml',price:6.5,qty:1,mods:[],notes:''},
          {uid:'ri7',name:'Coke',price:3.5,qty:1,mods:[],notes:''},
        ]},
        { id:'r4', sentAt:Date.now()-15*60000, subtotal:14.5, note:'', items:[
          {uid:'ri8',name:'Stout — Pint',price:6.2,qty:1,mods:[],notes:''},
          {uid:'ri9',name:'House white 250ml',price:8.5,qty:1,mods:[],notes:''},
        ]},
      ]},
  ] }),

  // ── Cash drawers (v4.6.35) ──────────────────────────────────────
  // First-class drawer entities. Each drawer has a printer that ejects it
  // and (optionally) a POS device strictly assigned to it. Persisted in
  // Supabase cash_drawers; hydrated on mount via useSupabaseInit.
  cashDrawers: [],

  loadCashDrawers: async () => {
    if (isMock || !supabase) return;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return;
      const { data } = await supabase
        .from('cash_drawers')
        .select('*')
        .eq('location_id', locId)
        .order('created_at', { ascending: true });
      if (Array.isArray(data)) {
        set({ cashDrawers: data.map(r => ({
          id: r.id, name: r.name,
          printerId: r.printer_id, deviceId: r.device_id,
          status: r.status || 'idle',
          currentFloat: Number(r.current_float) || 0,
          openedAt: r.opened_at, openedByStaffId: r.opened_by_staff_id,
        })) });
      }
    } catch (err) {
      console.warn('[loadCashDrawers] failed:', err?.message || err);
    }
  },

  createCashDrawer: async (drawer) => {
    const locId = getActiveLocationSync() || await getLocationId();
    if (!locId) { get().showToast?.('No location selected', 'error'); return null; }
    const row = {
      id: drawer.id || `drw-${Date.now()}`,
      location_id: locId,
      name: drawer.name,
      printer_id: drawer.printerId || null,
      device_id: drawer.deviceId || null,
      status: 'idle',
      current_float: 0,
    };
    // Optimistic local insert
    set(s => ({ cashDrawers: [...(s.cashDrawers||[]), {
      id: row.id, name: row.name, printerId: row.printer_id, deviceId: row.device_id,
      status: 'idle', currentFloat: 0, openedAt: null, openedByStaffId: null,
    }] }));
    if (!isMock && supabase) {
      try {
        const { error } = await supabase.from('cash_drawers').insert(row);
        reportSave('cash drawer', error);
        if (error) throw error;
        get().showToast?.(`Drawer "${row.name}" created`, 'success');
      } catch (err) {
        reportSave('cash drawer', err);
        console.warn('[createCashDrawer] failed:', err?.message || err);
        // v5.5.971: drop the optimistic row — a drawer that only exists on this
        // screen still gets picked in the cash-up UI and books money nowhere.
        set(s => ({ cashDrawers: (s.cashDrawers||[]).filter(d => d.id !== row.id) }));
        get().showToast?.(`Drawer "${row.name}" was NOT created: ${err?.message || 'unknown error'}`, 'error');
        return null;
      }
    }
    return row.id;
  },

  // v5.5.971: returns true/false. Was console.warn-only — an RLS-refused float or
  // status change left the screen showing a drawer state the DB never accepted, so
  // cash-up compared a phantom float against a real count.
  updateCashDrawer: async (id, patch) => {
    const prev = (get().cashDrawers || []).find(d => d.id === id) || null;
    // Optimistic local update
    set(s => ({ cashDrawers: (s.cashDrawers||[]).map(d => d.id === id ? { ...d, ...patch } : d) }));
    if (isMock || !supabase) return true;
    try {
      const row = {};
      if ('name' in patch)          row.name = patch.name;
      if ('printerId' in patch)     row.printer_id = patch.printerId;
      if ('deviceId' in patch)      row.device_id = patch.deviceId;
      if ('status' in patch)        row.status = patch.status;
      if ('currentFloat' in patch)  row.current_float = patch.currentFloat;
      if ('openedAt' in patch)      row.opened_at = patch.openedAt;
      if ('openedByStaffId' in patch) row.opened_by_staff_id = patch.openedByStaffId;
      row.updated_at = new Date().toISOString();
      // v5.5.279: location_id guard on cash drawer updates
      const locId = getActiveLocationSync() || await getLocationId();
      const { data, error } = await supabase.from('cash_drawers')
        .update(row).eq('id', id).eq('location_id', locId).select();
      if (error) throw error;
      // An UPDATE that matches zero rows is a failed write wearing a success mask
      // (RLS silently filtering, or the drawer belongs to another location).
      if (!data || data.length === 0) throw new Error('no matching drawer row — permission denied or wrong location');
      reportSave('cash drawer', null);
      return true;
    } catch (err) {
      reportSave('cash drawer', err);
      console.warn('[updateCashDrawer] failed:', err?.message || err);
      // Roll back only the keys this call touched, so a concurrent update isn't clobbered.
      if (prev) set(s => ({ cashDrawers: (s.cashDrawers||[]).map(d => {
        if (d.id !== id) return d;
        const restored = { ...d };
        Object.keys(patch || {}).forEach(k => { restored[k] = prev[k]; });
        return restored;
      }) }));
      get().showToast?.(`Drawer not saved: ${err?.message || 'unknown error'}`, 'error');
      return false;
    }
  },

  deleteCashDrawer: async (id) => {
    // Capture position as well as the row — a failed delete must put the drawer
    // back exactly where the operator saw it, not at the end of the list.
    const before = get().cashDrawers || [];
    const idx = before.findIndex(d => d.id === id);
    const removed = idx >= 0 ? before[idx] : null;
    set(s => ({ cashDrawers: (s.cashDrawers||[]).filter(d => d.id !== id) }));
    if (isMock || !supabase) return true;
    try {
      // v5.5.279: location_id guard — never delete across tenants
      const locId = getActiveLocationSync() || await getLocationId();
      const { data, error } = await supabase.from('cash_drawers')
        .delete().eq('id', id).eq('location_id', locId).select();
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('no matching drawer row — permission denied or wrong location');
      reportSave('cash drawer delete', null);
      return true;
    } catch (err) {
      reportSave('cash drawer delete', err);
      console.warn('[deleteCashDrawer] failed:', err?.message || err);
      if (removed) set(s => {
        const list = (s.cashDrawers || []).filter(d => d.id !== id);
        list.splice(Math.min(idx < 0 ? list.length : idx, list.length), 0, removed);
        return { cashDrawers: list };
      });
      get().showToast?.(`Drawer not deleted: ${err?.message || 'unknown error'}`, 'error');
      return false;
    }
  },

  // Find the drawer assigned to the current POS device. Returns null if none.
  // Used by openCashDrawer and cash-sale auto-fire to route to the right drawer.
  // v4.6.38: match against the physical device id (from rpos-device.id uuid)
  // NOT the profile id. Profiles are shared templates; drawers bind strictly
  // to individual terminals.
  myDrawer: () => {
    const { cashDrawers } = get();
    let deviceId = null;
    try {
      const dev = JSON.parse(localStorage.getItem('rpos-device') || '{}');
      deviceId = dev?.id || null;
    } catch { deviceId = null; }
    if (!deviceId) return null;
    return (cashDrawers || []).find(d => d.deviceId === deviceId) || null;
  },

  // ── Drawer sessions (v4.6.40) ───────────────────────────────────
  // A drawer session is one cash-in → cash-out cycle. Every cash sale
  // or movement while the drawer is open carries this sessions id, so
  // at cash-up we can compute the expected cash exactly = opening_float
  // + cash_sales − drops − expenses + adjustments within this session.
  currentDrawerSession: null,

  loadCurrentDrawerSession: async () => {
    if (isMock || !supabase) return null;
    try {
      const drw = get().myDrawer?.();
      if (!drw) { set({ currentDrawerSession: null }); return null; }
      const { data } = await supabase
        .from('drawer_sessions')
        .select('*')
        .eq('drawer_id', drw.id)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      const row = data?.[0] || null;
      set({ currentDrawerSession: row });
      return row;
    } catch (err) {
      console.warn('[loadCurrentDrawerSession] failed:', err?.message || err);
      return null;
    }
  },

  // Open a drawer for trading. Writes drawer_sessions row, updates
  // cash_drawers.status='open'+opening_float, writes float_in movement.
  cashInDrawer: async (drawerId, { openingFloat, denominations = null, notes = '' } = {}) => {
    if (isMock || !supabase) return null;
    if (isTrainingMode()) return null;   // TRAINING MODE: no real drawer_sessions / cash row
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) { get().showToast?.('No location', 'error'); return null; }
      const staff = get().staff;
      const shiftId = get().currentShift?.id || null;
      const now = new Date().toISOString();
      const row = {
        id: `ds-${Date.now()}`,
        drawer_id: drawerId,
        shift_id: shiftId,
        location_id: locId,
        cash_in_at: now,
        cash_in_by_staff_id: staff?.id || null,
        opening_float: Number(openingFloat) || 0,
        denominations,
        status: 'open',
        notes: notes || null,
      };
      const { data, error } = await supabase.from('drawer_sessions').insert(row).select().single();
      if (error) {
        // Duplicate — drawer already has an open session
        if (error.code === '23505') {
          get().showToast?.('Drawer already has an open session', 'error');
          await get().loadCurrentDrawerSession?.();
          return null;
        }
        throw error;
      }
      // Flip the drawer to open
      const drawerOk = await get().updateCashDrawer?.(drawerId, {
        status: 'open',
        currentFloat: Number(openingFloat) || 0,
        openedAt: now,
        openedByStaffId: staff?.id || null,
      });
      // Float-in movement
      const movementId = await get().insertCashMovement?.({
        type: 'float_in',
        amount: Number(openingFloat) || 0,
        drawerId,
        shiftId,
        sessionId: data.id,
        reason: 'Opening float',
        staffId: staff?.id || null,
        staffName: staff?.name || 'Unknown',
      });
      set({ currentDrawerSession: data });
      // v5.5.971: the session row landed, so the drawer IS open — but without the
      // float_in movement the session's expected cash reads £0 and cash-up reports a
      // fictional surplus. Never claim success when either half didn't write.
      if (!movementId || drawerOk === false) {
        get().showToast?.(
          `Drawer opened but the ${!movementId ? 'opening float was NOT recorded' : 'drawer state did not save'} — expected cash will be wrong at cash-up. Check you're signed in`,
          'error',
        );
        return data;
      }
      get().showToast?.(`Drawer opened with ${money(Number(openingFloat) || 0)}`, 'success');
      return data;
    } catch (err) {
      reportSave('drawer session', err);   // v5.5.971
      console.warn('[cashInDrawer] failed:', err?.message || err);
      get().showToast?.(`Cash in failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Calculate expected cash for a drawer's current open session.
  // expected = opening_float + sum(cash_sales) − sum(drops) − sum(expenses) + sum(adjustments)
  computeExpectedCash: async (drawerId) => {
    if (isMock || !supabase) return 0;
    try {
      // v5.5.11: look up the OPEN session for THIS specific drawer.
      // The previous version relied on currentDrawerSession (which is the
      // device-bound drawer's session) — when called from the back office
      // where there's no device-bound drawer, that path returned 0 even when
      // the drawer's actual cash_movements summed to £182.85. Resulting
      // discrepancy: Shift card showed £182.85 (read from drawer.currentFloat
      // which is the running total), Cash up modal showed £0 (read from
      // computeExpectedCash → wrong session). Fix: query session by drawer_id
      // directly, same pattern cashOutDrawer already uses.
      const { data: sessions, error: sessErr } = await supabase
        .from('drawer_sessions')
        .select('id, opening_float')
        .eq('drawer_id', drawerId)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      if (sessErr) {
        console.warn('[computeExpectedCash] drawer_sessions read failed:', sessErr.message);
        return 0;
      }
      const sess = sessions?.[0];
      if (!sess) {
        console.warn('[computeExpectedCash] no open session for drawer', drawerId, '— returning 0');
        return 0;
      }
      const { data: movements, error: movErr } = await supabase
        .from('cash_movements')
        .select('type, amount')
        .eq('session_id', sess.id);
      if (movErr) {
        console.warn('[computeExpectedCash] cash_movements read failed:', movErr.message);
        return Number(sess.opening_float) || 0;
      }
      const SIGN = { float_in: +1, cash_sale: +1, adjustment: +1, downlift_from_safe: +1, cash_drop: -1, drop: -1, expense: -1, uplift_to_safe: -1, drawer_open: 0 };
      // Note: opening_float is already accounted for in cash_movements as a
      // float_in row at session start, so we don't double-count it.
      const net = (movements || []).reduce((s, m) => s + (SIGN[m.type] || 0) * (Number(m.amount) || 0), 0);
      return net;
    } catch (err) {
      console.warn('[computeExpectedCash] failed:', err?.message || err);
      return 0;
    }
  },

  // Cash out a drawer. Closes the session, logs variance, flips drawer to idle,
  // and if all drawers are now idle, auto-closes the shift.
  cashOutDrawer: async (drawerId, { declaredCash, denominations = null, notes = '' } = {}) => {
    if (isMock || !supabase) return null;
    if (isTrainingMode()) return null;   // TRAINING MODE: no real drawer_sessions cash-out write
    try {
      // Find the open session for this drawer (don't trust currentDrawerSession — might be another device's drawer)
      const { data: sessions } = await supabase
        .from('drawer_sessions')
        .select('*')
        .eq('drawer_id', drawerId)
        .in('status', ['open', 'counting'])
        .order('cash_in_at', { ascending: false })
        .limit(1);
      const sess = sessions?.[0];
      if (!sess) {
        get().showToast?.('No open session for this drawer', 'error');
        return null;
      }
      // Compute expected directly from cash_movements for THIS session (reliable)
      const { data: movs } = await supabase
        .from('cash_movements')
        .select('type, amount')
        .eq('session_id', sess.id);
      const SIGN = { float_in: +1, cash_sale: +1, adjustment: +1, downlift_from_safe: +1, cash_drop: -1, drop: -1, expense: -1, uplift_to_safe: -1, drawer_open: 0 };
      const expected = (movs || []).reduce((s, m) => s + (SIGN[m.type] || 0) * (Number(m.amount) || 0), 0);
      const declared = Number(declaredCash) || 0;
      const variance = declared - expected;
      const now = new Date().toISOString();
      const staff = get().staff;

      // 1. Update the session row to closed
      // v5.5.279: location_id guard via drawer_id's parent location
      const drawerLocId = getActiveLocationSync() || await getLocationId();
      const { error: updErr } = await supabase
        .from('drawer_sessions')
        .update({
          cash_out_at: now,
          cash_out_by_staff_id: staff?.id || null,
          declared_cash: declared,
          expected_cash: expected,
          variance,
          denominations,
          status: 'closed',
          notes: [sess.notes, notes].filter(Boolean).join(' · ') || null,
        })
        .eq('id', sess.id)
        .eq('location_id', drawerLocId);
      if (updErr) throw updErr;

      // 2. Log variance as an adjustment movement (always — even £0.00 for audit)
      let varianceLogged = true;
      if (Math.abs(variance) >= 0.01) {
        const movementId = await get().insertCashMovement?.({
          type: 'adjustment',
          amount: Math.abs(variance),
          drawerId,
          sessionId: sess.id,
          reason: variance > 0 ? 'Cash-up variance (drawer over)' : 'Cash-up variance (drawer short)',
          note: `Declared ${money(declared)} vs expected ${money(expected)}`,
          staffId: staff?.id || null,
          staffName: staff?.name || 'Unknown',
        });
        varianceLogged = !!movementId;
      }

      // 3. Flip drawer to idle, zero float
      const drawerOk = await get().updateCashDrawer?.(drawerId, {
        status: 'idle',
        currentFloat: 0,
        openedAt: null,
        openedByStaffId: null,
      });
      set({ currentDrawerSession: null });

      // v5.5.971: the session closed (step 1 is checked above), so the cash-up stands —
      // but an unlogged variance or a drawer left 'open' in the DB has to be said out
      // loud, not reported as a clean close.
      if (!varianceLogged || drawerOk === false) {
        get().showToast?.(
          !varianceLogged
            ? `Drawer closed but the ${money(Math.abs(variance))} variance was NOT logged to the cash ledger — record it manually`
            : 'Drawer closed but its status did not save — it may still show as open on other devices',
          'error',
        );
      } else {
        get().showToast?.(
          Math.abs(variance) < 0.01 ? 'Drawer closed — balanced' : `Drawer closed — variance ${money(Math.abs(variance))} ${variance > 0 ? 'over' : 'short'}`,
          Math.abs(variance) < 0.01 ? 'success' : 'warning',
        );
      }

      // v4.6.49: removed auto-finalise. Shift stays open after all drawers
      // cash up. Manager must manually run Close day from Back Office, which
      // aggregates totals across the full location. Just refresh drawer state.
      await get().loadCashDrawers?.();

      return { expected, declared, variance };
    } catch (err) {
      reportSave('drawer cash-up', err);   // v5.5.971
      console.warn('[cashOutDrawer] failed:', err?.message || err);
      get().showToast?.(`Cash out failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Returns true when the POS should block itself because the assigned drawer
  // needs cashing in. Only POSes with a drawer assigned ever see this block.
  needsCashIn: () => {
    const drw = get().myDrawer?.();
    if (!drw) return false;
    return drw.status === 'idle' || !drw.status;
  },

  // ── Shifts (v4.6.37) ────────────────────────────────────────────
  // The shift is the reporting window: opened by a manager (or auto
  // on first boot of the business day), closed when all drawers are
  // cashed up. Every closed_check and cash_movement written while a
  // shift is open stamps its shift_id. At most one shift is open per
  // location (DB-enforced with a partial unique index).
  currentShift: null,
  shiftHistory: [],

  loadCurrentShift: async () => {
    if (isMock || !supabase) return null;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return null;
      const { data } = await supabase
        .from('shifts')
        .select('*')
        .eq('location_id', locId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1);
      const row = data?.[0] || null;
      if (row) {
        set({ currentShift: {
          id: row.id, locationId: row.location_id,
          openedAt: row.opened_at, openedByStaffId: row.opened_by_staff_id,
          closedAt: row.closed_at, closedByStaffId: row.closed_by_staff_id,
          status: row.status, notes: row.notes, zReport: row.z_report,
        } });
      } else {
        set({ currentShift: null });
      }
      return row;
    } catch (err) {
      console.warn('[loadCurrentShift] failed:', err?.message || err);
      return null;
    }
  },

  loadShiftHistory: async (limit = 30) => {
    if (isMock || !supabase) return;
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return;
      const { data } = await supabase
        .from('shifts')
        .select('*')
        .eq('location_id', locId)
        .order('opened_at', { ascending: false })
        .limit(limit);
      if (Array.isArray(data)) set({ shiftHistory: data });
    } catch (err) {
      console.warn('[loadShiftHistory] failed:', err?.message || err);
    }
  },

  openShift: async (staffId = null) => {
    // If one is already open, just return it (idempotent).
    if (get().currentShift?.status === 'open') return get().currentShift;
    if (isMock || !supabase) return null;
    // TRAINING MODE: open a LOCAL in-memory shift so the POS works normally, but
    // never write a shifts row.
    if (isTrainingMode()) {
      const shift = { id: `shift-training-${Date.now()}`, locationId: getActiveLocationSync() || null, openedAt: new Date().toISOString(), openedByStaffId: staffId || get().staff?.id || null, status: 'open', training: true };
      set({ currentShift: shift });
      return shift;
    }
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) return null;
      const row = {
        id: `shift-${Date.now()}`,
        location_id: locId,
        opened_at: new Date().toISOString(),
        opened_by_staff_id: staffId || get().staff?.id || null,
        status: 'open',
      };
      const { data, error } = await supabase.from('shifts').insert(row).select().single();
      if (error) {
        // Unique constraint means another device beat us — reload and use theirs
        if (error.code === '23505') {
          await get().loadCurrentShift?.();
          return get().currentShift;
        }
        throw error;
      }
      set({ currentShift: {
        id: data.id, locationId: data.location_id,
        openedAt: data.opened_at, openedByStaffId: data.opened_by_staff_id,
        status: 'open',
      } });
      get().showToast?.(`Shift opened`, 'success');
      return get().currentShift;
    } catch (err) {
      // v5.5.971: a failed shift open is silent money damage — every cash movement
      // taken afterwards is written with shift_id null and drops out of the Z report.
      reportSave('shift open', err);
      console.warn('[openShift] failed:', err?.message || err);
      get().showToast?.(`Shift did not open: ${err?.message || 'unknown error'} — cash takings will not be attributed to a shift`, 'error');
      return null;
    }
  },

  // v4.6.43: Location-wide Z-read. Writes the aggregated report to the shifts
  // row and closes the shift. Enforces Manager/Admin role at the call site —
  // the EOD page checks staff.role before calling this, and closeShift also
  // enforces the check below as a second guard.
  finaliseShift: async ({ zReport, notes = '' } = {}) => {
    const current = get().currentShift;
    if (!current || current.status !== 'open') {
      get().showToast?.('No open shift to finalise', 'error');
      return null;
    }
    // Defence in depth: block if any drawer is still non-idle
    const stillOpen = (get().cashDrawers || []).find(d => d.status && d.status !== 'idle');
    if (stillOpen) {
      get().showToast?.(`Can't finalise — ${stillOpen.name} is still ${stillOpen.status}`, 'error');
      return null;
    }
    // Role check — Manager/Admin only
    const { staff } = get();
    const isAdmin = staff?.role === 'Manager' || staff?.role === 'Admin';
    const hasEOD  = Array.isArray(staff?.permissions) && staff.permissions.includes('eod');
    // Back office is already auth-gated via Supabase Auth, so if staff is empty
    // that means this was called from the back office (where the page itself
    // is behind Supabase Auth). Allow that.
    const fromBackOffice = !staff?.id;
    if (!isAdmin && !hasEOD && !fromBackOffice) {
      get().showToast?.('Manager/Admin required to close a shift', 'error');
      return null;
    }
    // closeShift persists z_report on the shifts row
    return await get().closeShift?.({ auto: false, notes, zReport });
  },

  closeShift: async ({ auto = false, notes = '', zReport = null } = {}) => {
    const current = get().currentShift;
    if (!current || current.status !== 'open') {
      get().showToast?.('No open shift to close', 'error');
      return null;
    }
    // Permission gate — manual close requires admin/manager role, cashup/eod
    // perm, OR back-office auth (empty staff = user signed in via Supabase
    // Auth as the business owner, not a POS PIN login).
    if (!auto) {
      const { staff } = get();
      const role = staff?.role;
      const hasPerm = Array.isArray(staff?.permissions) && (staff.permissions.includes('cashup') || staff.permissions.includes('eod'));
      const fromBackOffice = !staff?.id; // v4.6.46: allow when called from BO
      if (role !== 'Manager' && role !== 'Admin' && !hasPerm && !fromBackOffice) {
        get().showToast?.('Only manager/admin can close a shift', 'error');
        return null;
      }
      // Block close if any drawer is still in open/counting state
      const openDrawer = (get().cashDrawers || []).find(d => d.status && d.status !== 'idle');
      if (openDrawer) {
        get().showToast?.(`Cannot close shift — ${openDrawer.name} is still ${openDrawer.status}`, 'error');
        return null;
      }
    }
    if (isMock || !supabase) return null;
    // TRAINING MODE: the open shift is local-only — clear it without a shifts write.
    if (isTrainingMode()) { set({ currentShift: null }); return true; }
    try {
      const patch = {
        status: auto ? 'auto_closed' : 'closed',
        closed_at: new Date().toISOString(),
        closed_by_staff_id: get().staff?.id || null,
        notes: notes || null,
        z_report: zReport || null,
      };
      // v5.5.279: location_id guard on shift close
      const shiftLocId = getActiveLocationSync() || await getLocationId();
      const { error } = await supabase.from('shifts').update(patch).eq('id', current.id).eq('location_id', shiftLocId);
      if (error) throw error;
      set({ currentShift: null });
      await get().loadShiftHistory?.();
      get().showToast?.(auto ? 'Shift auto-closed at business day start' : 'Shift closed', 'success');
      return true;
    } catch (err) {
      reportSave('shift close', err);   // v5.5.971
      console.warn('[closeShift] failed:', err?.message || err);
      get().showToast?.(`Shift close failed: ${err?.message}`, 'error');
      return null;
    }
  },

  // Auto-open/close logic — run on app mount from useSupabaseInit.
  // If no shift is open: open one with opened_at = max(now, businessDayStart).
  // If the current shift's opened_at is older than today's businessDayStart,
  // auto-close the old one and open a fresh one.
  reconcileShiftOnMount: async () => {
    if (isMock) return;
    try {
      await get().loadCurrentShift?.();
      const current = get().currentShift;
      // v5.5.11: use the timezone-aware getBusinessDayStart() helper instead of
      // device-local setHours(). The previous version computed "today's 6am" in
      // the device's local timezone — wrong if the device is in a different
      // timezone than the location. Combined with v5.5.11's fix to
      // getLocationConfig (which previously pulled the wrong location's config
      // in multi-location setups), shift boundaries are now consistently the
      // location's configured business_day_start in the location's timezone.
      const { getLocationConfig: getCfg, getBusinessDayStart } = await import('../lib/locationTime');
      const cfg = await getCfg(); // resolves current location internally
      const businessDayStartMs = getBusinessDayStart(cfg).getTime();

      if (current) {
        const openedMs = new Date(current.openedAt).getTime();
        if (openedMs < businessDayStartMs) {
          // v4.6.45: shift has crossed the business-day boundary. We close the
          // shift itself (so reports roll over) but LEAVE drawers in whatever
          // state they were in — no fabricated close events, no null-variance
          // rows. A POS with a still-open drawer will refuse to start new cash
          // trading until a manager cashes it up from the back office. Open
          // orders carry over untouched.
          await get().loadCashDrawers?.();
          const stillOpen = (get().cashDrawers || []).filter(d => d.status && d.status !== 'idle');
          if (stillOpen.length > 0) {
            console.warn(`[reconcileShiftOnMount] shift auto-closed with ${stillOpen.length} drawer(s) still open — they need manual cash-up before new trading`);
          }
          await get().closeShift?.({ auto: true, notes: stillOpen.length > 0 ? `Auto-closed at business day boundary — ${stillOpen.length} drawer(s) still open, need manual cash-up` : 'Auto-closed at business day boundary' });
          await get().openShift?.();
        }
      } else {
        // No open shift — open one automatically so cash sales can happen
        await get().openShift?.();
      }
    } catch (err) {
      console.warn('[reconcileShiftOnMount] failed:', err?.message || err);
    }
  },

  // ── Petty cash + cash drawer (v4.6.30) ────────
  pettyCashEntries: [],

  // Append a petty cash log entry. Shape:
  //   { id, timestamp, type, amount, reason?, note?, staff?, ref? }
  // type is one of:
  //   'cash_sale'       — auto-logged by recordClosedCheck etc when method==='cash'
  //   'drawer_open'     — manual drawer pulse from POS (no money change)
  //   'float'           — cash float added at start of shift
  //   'drop'            — cash removed to safe / deposit
  //   'expense'         — cash paid out for supplies etc
  //   'adjustment'      — manual reconciliation tweak
  //
  // ⚠ IN-MEMORY ONLY. This writes to the local pettyCashEntries array and NOTHING
  // else — no cash_movements row, so nothing it records reaches drawer variance, EOD
  // close or the Z report. The Back Office petty cash page called it directly for a
  // long time and every float / drop / paid-out / adjustment entered there vanished on
  // refresh. Money-moving callers must use recordCashEntry (or openCashDrawer, which
  // wraps it); this stays public only because recordCashEntry itself calls it.
  addPettyCashEntry: (entry) => {
    const full = {
      id: `pc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      timestamp: Date.now(),
      type: 'drawer_open',
      amount: 0,
      ...entry,
    };
    set(s => ({ pettyCashEntries: [full, ...(s.pettyCashEntries || [])] }));
    return full;
  },

  // Running balance = sum of signed amounts. Positive for sales/floats,
  // negative for drops/expenses.
  getPettyCashBalance: () => {
    const SIGN = { cash_sale: +1, float: +1, adjustment: +1, drop: -1, expense: -1, drawer_open: 0 };
    return (get().pettyCashEntries || []).reduce((s, e) => s + (SIGN[e.type] ?? 0) * (Number(e.amount) || 0), 0);
  },

  // ── The one way money enters the cash ledger (v5.5.977) ───────────────
  // Local pettyCashEntries row + the cash_movements row that drawer variance, EOD
  // close and the Z report are all computed from + the drawer float move. Every cash
  // entry goes through here.
  //
  // Extracted from openCashDrawer, which is now this plus the POS-only bits it owns:
  // the 'openDrawer' permission gate and the physical printer pulse. The Back Office
  // petty cash page calls this directly — it has no POS staff object to gate on and
  // no drawer in front of the operator to pulse. Before the extraction it called
  // addPettyCashEntry on its own, so every manual float / drop / paid-out / adjustment
  // lived in an in-memory array and NOTHING reached cash_movements.
  //
  // Returns { ok, entry, drawer }. ok === false means the cash_movements row did NOT
  // land: an error toast has already been shown, entry is null and the drawer float
  // was deliberately left alone. Callers MUST NOT report success on ok === false.
  recordCashEntry: async ({ type = 'drawer_open', amount = 0, reason = '', note = '', ref = null, drawerId = null } = {}) => {
    // TRAINING MODE: no ledger entry, no cash_movements row, no float move — keeps
    // the cash ledger + EOD reconciliation clean. Not a failure, so ok stays true.
    if (isTrainingMode()) return { ok: true, entry: null, drawer: null, skipped: true };
    const { staff } = get();
    // cash_movements has ONE vocabulary and every reader keys off it: float_in,
    // cash_sale, adjustment, downlift_from_safe, cash_drop, drop, expense,
    // uplift_to_safe, drawer_open (see reports/CashDrawer.jsx + EODClose.jsx). The Back
    // Office petty cash UI has always called a pay-in 'float' in its own local labels,
    // and a row typed 'float' would land in the table and then be counted by nothing —
    // present in the data, absent from variance, EOD and the Z report. Normalise for
    // the DB row; the local pettyCashEntries row keeps the caller's own type so its UI
    // labels and running balance still resolve.
    const dbType = ({ float: 'float_in' })[type] || type;
    // Use ONLY the drawer the caller named — no myDrawer() fallback. myDrawer() reads
    // the paired terminal out of localStorage, and the Back Office runs on the SAME
    // origin as the till, so a fallback here would silently bind an office entry (a
    // safe drop, say) to that terminal's drawer and move its float. openCashDrawer
    // resolves myDrawer() itself and passes the id in.
    const resolvedDrawer = (drawerId
      ? (get().cashDrawers || []).find(d => d.id === drawerId)
      : null) || null;
    const resolvedDrawerId = resolvedDrawer?.id || null;
    // Readers key movements off session_id and DROP rows that have none (see
    // reports/CashDrawer.jsx), and EODClose.jsx additionally fetches by shift_id —
    // insertCashMovement defaults both from THIS device's state, which is empty in the
    // Back Office. Take them from the target drawer's own open session instead.
    let sessionId = null;
    let sessionShiftId = null;
    if (resolvedDrawerId) {
      const cur = get().currentDrawerSession;
      if (cur?.drawer_id === resolvedDrawerId) {
        sessionId = cur.id;
        sessionShiftId = cur.shift_id || null;
      } else if (!isMock && supabase) {
        const { data: sessions } = await supabase
          .from('drawer_sessions')
          .select('id, shift_id')
          .eq('drawer_id', resolvedDrawerId)
          .in('status', ['open', 'counting'])
          .order('cash_in_at', { ascending: false })
          .limit(1);
        sessionId = sessions?.[0]?.id || null;
        sessionShiftId = sessions?.[0]?.shift_id || null;
      }
    }
    // Mirror to cash_movements — AWAITED and CHECKED (v5.5.971). This row is what
    // drawer variance, EOD close and the Z report are computed from; losing it
    // silently is the difference between a balanced till and an unexplained short.
    const movementId = await get().insertCashMovement?.({
      type: dbType, amount,
      drawerId: resolvedDrawerId,
      sessionId, shiftId: sessionShiftId,
      reason, note, ref,
      staffId: staff?.id || null,
      staffName: staff?.name || 'Unknown',
    });
    // insertCashMovement also returns null in mock mode (training already returned above),
    // where no row is expected — only complain when a row really should have landed.
    const movementLost = !isMock && !!supabase && !movementId;
    if (movementLost) {
      get().showToast?.(
        amount > 0
          ? `${money(Number(amount) || 0)} was NOT recorded in the cash ledger — the drawer will not balance. Check you're signed in, then re-enter it`
          : 'Drawer event was NOT recorded in the cash ledger — check you\'re signed in',
        'error',
      );
      // Float deliberately untouched — moving it without its ledger row just
      // manufactures a variance. No local row either: the UI keeps the modal open and
      // asks for a re-entry, so an up-front row would leave a phantom entry (and a
      // wrong running balance) behind every retry.
      return { ok: false, entry: null, drawer: resolvedDrawer };
    }
    // Legacy pettyCashEntries for backwards-compat UI — added only now the movement
    // has landed. Keeps the caller's own type so its labels and running balance resolve.
    const entry = get().addPettyCashEntry({
      type, amount, reason, ref, note,
      staff: staff?.name || 'Unknown',
      staffId: staff?.id || null,
      drawerId: resolvedDrawerId,
    });
    // Update drawer's current_float locally + in DB.
    if (resolvedDrawerId && dbType !== 'drawer_open') {
      const SIGN = { cash_sale: +1, float_in: +1, adjustment: +1, drop: -1, cash_drop: -1, expense: -1, uplift_to_safe: -1, downlift_from_safe: +1 };
      const delta = (SIGN[dbType] || 0) * (Number(amount) || 0);
      if (delta !== 0) {
        // Re-read the float HERE, not from the resolvedDrawer captured at function entry:
        // there is now an awaited cash_movements insert in between, and a concurrent sale
        // on the same drawer during that round-trip would be overwritten by a stale base.
        const current = (get().cashDrawers || []).find(d => d.id === resolvedDrawerId)?.currentFloat
          ?? resolvedDrawer.currentFloat ?? 0;
        await get().updateCashDrawer?.(resolvedDrawerId, { currentFloat: current + delta });
      }
    }
    return { ok: true, entry, drawer: resolvedDrawer };
  },

  // Pulse the cash drawer via the printer (if a cash-drawer-attached printer
  // is configured) AND log to the petty cash ledger. Swallow print failures —
  // the drawer pulse is best-effort and should never block a payment flow.
  // v5.5.971: async so the cash_movements mirror can be AWAITED and checked. The pulse
  // still fires synchronously, so callers that don't await (the cash-sale auto-fire
  // paths) see the drawer open exactly as before; the local ledger entry now appears
  // once the movement lands rather than up front.
  // v5.5.977: the ledger half now lives in recordCashEntry (shared with Back Office
  // petty cash). Return value here is unchanged.
  openCashDrawer: async ({ reason = 'Manual open', amount = 0, type = 'drawer_open', ref = null, note = '', force = false, drawerId = null } = {}) => {
    // TRAINING MODE: don't pulse the physical drawer or write a petty_cash / cash
    // movement row — keeps the cash ledger + EOD reconciliation clean.
    if (isTrainingMode()) return;
    // v4.6.32: permission gate. 'force' is passed by the automatic cash-sale
    // firing path — no permission check needed there (the sale itself was
    // already authorised). Manual opens from the POS must have the 'openDrawer'
    // staff permission.
    // v4.6.36: drawer-aware routing. If drawerId is provided (or myDrawer()
    // resolves one) the pulse fires at that drawer's printer, and the
    // movement row carries drawer_id + shift_id.
    const { staff } = get();
    if (!force) {
      const allowed = Array.isArray(staff?.permissions) && staff.permissions.includes('openDrawer');
      if (!allowed) {
        get().showToast?.('No permission — drawer open requires manager override', 'error');
        return null;
      }
    }
    // Resolve the drawer HERE — this is the POS, so the device-bound drawer is the
    // right default. recordCashEntry never guesses one; it gets the id from us.
    const resolvedDrawer = (drawerId
      ? (get().cashDrawers || []).find(d => d.id === drawerId)
      : get().myDrawer?.()) || null;
    try {
      // printService.openCashDrawer accepts printerId as its first arg.
      // If we have the drawer's printer, use it; else fall back to legacy
      // behaviour (search for cashDrawerAttached flag).
      const pulsePromise = printService?.openCashDrawer?.(resolvedDrawer?.printerId || null);
      pulsePromise?.catch?.(err => {
        console.warn('[openCashDrawer] pulse failed:', err?.message || err);
        get().showToast?.(`Drawer pulse failed: ${err?.message || 'no printer'}`, 'error');
      });
    } catch (err) { console.warn('[openCashDrawer] pulse threw:', err); }
    const res = await get().recordCashEntry({ type, amount, reason, note, ref, drawerId: resolvedDrawer?.id || null });
    // v4.6.39: visible feedback for manual opens. Auto-fire on cash sale
    // skips the toast (the sale already renders a 'paid' toast).
    // v5.5.971: moved BELOW the awaited write and suppressed when it failed — a green
    // toast next to a rejected ledger row is exactly the lie this sweep is removing.
    if (type === 'drawer_open' && !force && res?.ok) {
      const _drawerName = res.drawer?.name;
      get().showToast?.(_drawerName ? `${_drawerName} opened` : 'Drawer opened', 'success');
    }
    return res?.entry ?? null;
  },

  // v4.6.36: persist a movement row to Supabase cash_movements. Dual-writes here:
  // Zustand (via addPettyCashEntry above which still populates pettyCashEntries)
  // and Supabase (this function).
  //
  // v5.5.971: RETURNS THE ROW ID ONLY IF THE ROW LANDED. It used to return row.id
  // after a console.warn even when the insert was rejected, so petty cash, cash
  // drops, paid-outs and cash sales were all counted as booked while the DB held
  // nothing — drawer variance, EOD close and the Z report then disagreed with the
  // physical cash and nobody could see why. null now means NOT SAVED; callers must
  // say so. (null is also returned in mock/training mode, where nothing is expected
  // to persist — callers guard on isMock/isTrainingMode before complaining.)
  insertCashMovement: async ({ type, amount, drawerId = null, shiftId = null, sessionId = null, fromDrawerId = null, toDrawerId = null, reason = '', note = '', ref = null, staffId = null, staffName = '' }) => {
    if (isMock || !supabase) return null;
    if (isTrainingMode()) return null;   // TRAINING MODE: no real cash_movements row
    // v4.6.39: if no shiftId was passed, default to the currently open shift.
    // v4.6.40: also default session_id to the currentDrawerSession when the caller
    // didn't specify. This is what links every cash-sale to the session it occurred in.
    // v5.5.977: only inherit currentDrawerSession when the row belongs to THIS device's
    // drawer (or to no drawer at all). A Back Office row against another drawer that
    // borrowed this session would be counted against the wrong till at cash-up.
    const _curSession = get().currentDrawerSession;
    const resolvedShiftId = shiftId || get().currentShift?.id || null;
    // A row with NO drawer must NOT borrow this device's session either. Back Office
    // petty cash sends drawerId:null on the default 'All' filter, and ?mode=office runs
    // on the same origin as the till — so inheriting here would bucket an office cash
    // drop into that till's drawer session and manufacture a shortage at cash-up.
    const resolvedSessionId = sessionId
      || (drawerId && drawerId === _curSession?.drawer_id ? _curSession?.id || null : null);
    try {
      const locId = getActiveLocationSync() || await getLocationId();
      if (!locId) {
        reportSave('cash movement', new Error('no location resolved — cash movement not saved'));
        return null;
      }
      const row = {
        id: `mov-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        location_id: locId,
        timestamp: new Date().toISOString(),
        type, amount: Number(amount) || 0,
        drawer_id: drawerId,
        shift_id: resolvedShiftId,
        from_drawer_id: fromDrawerId,
        to_drawer_id: toDrawerId,
        reason, note, ref,
        staff_id: staffId,
        staff_name: staffName,
        session_id: resolvedSessionId,
      };
      const { error } = await supabase.from('cash_movements').insert(row);
      reportSave('cash movement', error);
      if (error) {
        console.warn('[insertCashMovement] DB error:', error.message);
        return null;
      }
      return row.id;
    } catch (err) {
      reportSave('cash movement', err);
      console.warn('[insertCashMovement] failed:', err?.message || err);
      return null;
    }
  },

  // ── Closed check history ──────────────────
  closedChecks: isMock ? [
    { id:'cc1', ref:'#1042', tableId:'t1', tableLabel:'T1', server:'Sarah', covers:2, orderType:'dine-in', customer:null,
      items:[{uid:'cc1i1',name:'Carbonara pasta',price:14.5,qty:2,mods:[],notes:'',allergens:[]},{uid:'cc1i2',name:'House red wine — 250ml',price:10.5,qty:2,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:50, service:6.25, tip:7.50, total:63.75, method:'card',
      closedAt:Date.now()-25*60000, status:'paid', refunds:[] },
    { id:'cc2', ref:'#1041', tableId:'t3', tableLabel:'T3', server:'Tom', covers:4, orderType:'dine-in', customer:null,
      items:[{uid:'cc2i1',name:'Ribeye steak 8oz',price:32,qty:2,mods:[{label:'Cooking: Medium rare',price:0}],notes:'',allergens:[]},{uid:'cc2i2',name:'Chicken supreme',price:22,qty:1,mods:[],notes:'',allergens:[]},{uid:'cc2i3',name:'Tiramisu',price:8.5,qty:2,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:103, service:12.88, tip:15, total:130.88, method:'card',
      closedAt:Date.now()-62*60000, status:'partial_refund',
      refunds:[{id:'r1',timestamp:Date.now()-30*60000,manager:'Alex',managerId:'s1',reason:'Quality issue',isFullRefund:false,items:[{uid:'cc2i3',name:'Tiramisu',price:8.5,qty:2,refundQty:1}],amount:8.5}] },
    { id:'cc3', ref:'#1040', tableId:null, tableLabel:null, server:'Alex', covers:1, orderType:'collection',
      customer:{name:'James Wilson',phone:'07700 900123',collectionTime:'6:30 PM'},
      items:[{uid:'cc3i1',name:'Pepperoni pizza',price:14,qty:1,mods:[],notes:'Extra cheese',allergens:[]},{uid:'cc3i2',name:'Garlic bread',price:4.5,qty:1,mods:[],notes:'',allergens:[]}],
      discounts:[], subtotal:18.5, service:0, tip:0, total:18.5, method:'card',
      closedAt:Date.now()-90*60000, status:'paid', refunds:[] },
  ] : [],

  // v5.5.163 — Challenge 21 (UK alcohol ID-check) state + actions
  //   `challenge21Config` is a snapshot of the platform.locations columns,
  //   refreshed on demand from loadChallenge21Config().
  //   `challenge21Prompt` is the trigger state — when .open=true the POS
  //   surface renders Challenge21Modal.
  challenge21Config: null,
  challenge21Prompt: { open: false, triggerCount: 0 },

  loadChallenge21Config: async () => {
    if (isMock || !platformSupabase) return;
    try {
      const opsId = getActiveLocationSync() || await getLocationId();
      if (!opsId || opsId === 'loc-demo') return;
      const { data, error } = await platformSupabase.from('locations')
        .select('id, ops_location_id, challenge_21_enabled, challenge_21_alcohol_category_ids, challenge_21_trigger_every, challenge_21_counter')
        .eq('ops_location_id', opsId).maybeSingle();
      if (error) {
        if (!/column .* does not exist/i.test(error.message)) console.warn('[challenge21] config load:', error.message);
        return;
      }
      if (!data) return;
      set({
        challenge21Config: {
          locationId:        data.id,
          opsLocationId:     data.ops_location_id || opsId,
          enabled:           !!data.challenge_21_enabled,
          alcoholCategoryIds: Array.isArray(data.challenge_21_alcohol_category_ids) ? data.challenge_21_alcohol_category_ids : [],
          triggerEvery:      Number(data.challenge_21_trigger_every) || 10,
          counter:           Number(data.challenge_21_counter) || 0,
        },
      });
    } catch (e) { console.warn('[challenge21] config load failed:', e?.message); }
  },

  // Called from every recordClosedCheck path. Checks for alcohol-flagged
  // items in the closed record, and if found asks the server to increment the
  // counter and decide whether the ID prompt is due.
  //
  // v5.5.972: the increment used to be a direct platformSupabase UPDATE from the
  // till. That needed anon UPDATE on platform.locations — the same grant that let
  // any holder of the bundled anon key rewrite every column of every venue — and
  // it failed SILENTLY: an RLS-blocked PostgREST UPDATE resolves with 0 rows
  // rather than throwing, so the catch never fired and the licensing prompt
  // simply stopped appearing. It now goes through the challenge21-counter edge
  // function (service_role), the server owns the prompt decision, and a failure
  // raises the save-health banner AND a POS toast. Never let this one go quiet
  // again — a dead Challenge 21 counter is a licensing failure.
  triggerChallenge21Check: async (record) => {
    try {
      if (isMock || !platformSupabase) return;
      if (isTrainingMode()) return;   // TRAINING MODE: don't log to the alcohol audit counter

      let cfg = get().challenge21Config;
      if (!cfg) { await get().loadChallenge21Config(); cfg = get().challenge21Config; }
      if (!cfg?.enabled) return;
      if (!cfg.alcoholCategoryIds?.length) return;
      const items = record?.items || [];
      if (!items.length) return;

      const flagged = new Set(cfg.alcoholCategoryIds);
      const hasAlcohol = items.some(i => {
        if (!i || i.voided) return false;
        if (i.cat && flagged.has(i.cat)) return true;
        if (Array.isArray(i.cats) && i.cats.some(c => flagged.has(c))) return true;
        if (i.parentCat && flagged.has(i.parentCat)) return true;
        return false;
      });
      if (!hasAlcohol) return;

      // The server increments atomically and returns the authoritative counter, so
      // two tills closing alcohol checks at the same moment can no longer lose one
      // (the old read-modify-write wrote the same `next` twice).
      const { data, error } = await bumpChallenge21(cfg.opsLocationId);
      // `ok:false` with no error is the 0-rows case — treat it as a failure, same
      // discipline as the Back Office writers.
      const failure = error || (data?.ok ? null : new Error(data?.reason || data?.error || 'counter bump matched no location'));
      reportSave('Challenge 21 counter', failure);
      if (failure) {
        get().showToast('Challenge ID counter NOT recorded — tell a manager', 'error');
        return;
      }

      const next = Number(data.counter) || 0;
      set({ challenge21Config: { ...cfg, counter: next } });

      // should_prompt is the SERVER's decision against the stored threshold, not
      // local arithmetic against a possibly-stale cfg.triggerEvery. Two tills
      // crossing the threshold together may both prompt — over-prompting is the
      // right way to fail on an age-verification control.
      if (data.should_prompt) {
        set({
          challenge21Prompt: {
            open: true,
            triggerCount: next,
            locationId: cfg.locationId,
            opsLocationId: cfg.opsLocationId,
          },
        });
      }
    } catch (e) {
      // A throw here (no auth session, network down) is still a counter that
      // didn't record — surface it rather than logging it into the void.
      reportSave('Challenge 21 counter', e);
      get().showToast('Challenge ID counter NOT recorded — tell a manager', 'error');
    }
  },

  dismissChallenge21Prompt: (resetCounter = true) => {
    const cfg = get().challenge21Config;
    set({ challenge21Prompt: { open: false, triggerCount: 0 } });
    if (resetCounter && cfg) set({ challenge21Config: { ...cfg, counter: 0 } });
  },

  // Build the closed_check record for a table session. Its only effect is consuming
  // one local order ref; it writes no state. Shared by recordClosedCheck (mints a
  // chk-<ts> id) and closeApprovedTerminalJob (passes idOverride = the terminal job's
  // pre-minted closed_check_id), so both paths produce one identical record shape.
  // v5.5.902: paymentInfo.closedCheckId is CheckoutModal's pre-minted id — the same id
  // the gift-card debit was keyed to, so the refund reversal can find the ledger row.
  buildCloseRecord: (session, table, paymentInfo = {}, { idOverride } = {}) => {
    const { staff, taxRates } = get();

    // Calculate tax breakdown at point of close
    let taxBreakdown = null;
    if (taxRates?.length) {
      try { taxBreakdown = calculateOrderTax(session.items.filter(i=>!i.voided), taxRates, 'dine-in'); } catch {}
    }

    const ref = getNextOrderRefLocal();
    // v5.5.279: stamp locationId on in-memory record so the cross-location
    // merge filter in BOReports can exclude checks from other locations.
    // v5.5.311: fall back to the durable rpos-active-location tag if the sync
    // resolver returns null — a null locationId on the cached check passes the
    // "exclude other locations" filter for EVERY location → report bleed.
    let recLocId = getActiveLocationSync();
    if (!recLocId) { try { recLocId = localStorage.getItem('rpos-active-location') || null; } catch {} }
    return {
      id: idOverride || paymentInfo.closedCheckId || `chk-${Date.now()}`,
      ref,
      tableId: table.id,
      tableLabel: table.label,
      locationId: recLocId,
      server:     session.server || staff?.name || 'Staff',
      staffId:    staff?.id || null,                          // v4.6.19
      covers:     session.covers || 1,
      orderType:  'dine-in',
      items:      session.items.filter(i => !i.voided).map(i => ({ ...i })),
      // Persist applied auto-discounts (re-evaluated at close, location-local) alongside any
      // manual discounts + promo, in the SAME shape — so EOD/sales/tax reports + receipts pick
      // them up unchanged. The charged total already reflects them via getPOSTotals → paymentInfo.grand.
      discounts:  [...(session.discounts || []),
                   ...evaluateAutoDiscounts(session.items.filter(i=>!i.voided), get().discountRules, 'pos', buildScheduleCtx(get().locationConfig?.timezone)).map(toAppliedDiscount),
                   ...promoDiscountEntry(paymentInfo.promoRedemption)],
      subtotal:   session.subtotal || 0,
      // v5.5.851: service comes from the REAL pricing engine, never a hardcoded rate.
      // The old `subtotal * 0.125` booked a phantom 12.5% service on EVERY dine-in
      // close — including venues/orders with no service charge at all (live repro: a
      // £2.85 walk-through sale grew ~36p of service in history that was never
      // charged). computeCheckTotals -> resolveServiceCharge is the same maths the
      // checkout screen showed the operator, honouring the device profile config,
      // covers threshold and the waived flag. paymentInfo.service (if a caller
      // supplies the figure it actually charged) wins outright.
      service:    paymentInfo.service != null ? Number(paymentInfo.service) : (() => {
        try {
          return computeCheckTotals({
            items: session.items.filter(i => !i.voided),
            checkDiscounts: session.discounts || [],
            covers: session.covers || 1,
            serviceChargeWaived: session.serviceChargeWaived || false,
            orderType: 'dine-in',
            deviceConfig: get().deviceConfig,
            discountRules: get().discountRules,
            timezone: get().locationConfig?.timezone,
          }).service || 0;
        } catch { return 0; }   // fail toward NO phantom fee, never toward one
      })(),
      tip:        paymentInfo.tip || 0,
      total:      paymentInfo.grand || session.total || 0,
      taxAmount:  taxBreakdown?.totalTax != null ? taxBreakdown.totalTax : null,  // v4.6.19
      method:     paymentInfo.method || 'card',
      giftCard:   giftRecordFrom(paymentInfo),                   // v5.5.217 refund reversal; v5.5.902 also carries split legs
      stripePaymentIntentId: paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null,  // v5.5.301: for card refunds
      processor:  paymentInfo.processor || 'stripe',             // which processor took the payment (refund routes by this)
      paymentIntents: attachCaptureToIntents(attachCardToIntents(derivePaymentIntents(paymentInfo), paymentInfo.cardReceipt), paymentInfo.capture),  // v5.5.323 legs + v5.5.719 card block + v5.7.5 tip-on-receipt capture window
      cardReceipt: paymentInfo.cardReceipt || null,              // v5.5.719: card-scheme receipt block (brand/last4/auth/AID/CVM) for the printed receipt
      loyaltyRedemption: paymentInfo.loyaltyRedemption || null,  // v5.5.315: link redeem→check for refund restore
      // v5.7.21 — booking prepay/deposit credit consumed by this check. The
      // durable copy is the tagged legs inside payment_intents (jsonb); this
      // field is the in-memory summary { bookingId, appliedMinor, legs }.
      bookingPayment: paymentInfo.bookingPayment || null,
      closedAt:   Date.now(),
      seatedAt:   session.seatedAt || null,   // Tables Ready: seat→close turn time feeds the waitlist estimator's learning loop
      status:     'paid',
      refunds:    [],
      taxBreakdown,
    };
  },

  recordClosedCheck: (tableId, paymentInfo = {}) => {
    const { tables } = get();
    const table = tables.find(t => t.id === tableId);
    const session = table?.session;
    if (!session) return;
    const record = get().buildCloseRecord(session, table, paymentInfo);
    set(s => ({ closedChecks: capClosedChecks([record, ...s.closedChecks]) }));
    insertClosedCheck(record);
    depleteForSale(record);   // v5.5.565: deplete recipe ingredients from the stock ledger (theoretical COGS); fire-and-forget no-op if no recipe
    if (paymentInfo.promoRedemption) get().redeemPromoCode?.(paymentInfo.promoRedemption, record, session.customer);
    if (paymentInfo.loyaltyRedemption?.pending_commit) get().redeemLoyaltyAtCommit?.(paymentInfo.loyaltyRedemption, record, session.customer);
    // v5.5.163: Challenge 21 — increment alcohol counter; fire prompt at threshold.
    get().triggerChallenge21Check?.(record);
    // v4.6.65: dine-in customer attribution. Reads session.customer (attached
    // manually via the Add customer button on the order panel — no order-type
    // switch required).
    if (session.customer?.phone) {
      get().attributeOrderToCustomer({
        customer: session.customer, orderRecord: record,
      }).catch(err => console.warn('[recordClosedCheck customer]', err?.message || err));
    }
    // v4.6.30: fire cash drawer + log petty cash entry for cash sales.
    if (record.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(record.total) || 0,
        reason: `Cash sale · ${record.tableLabel || record.ref || ''}`.trim(),
        ref: record.ref,
        force: true,
      });
    }
    get().maybeAutoSignout('pay');   // v5.5.731 per-device sign-out-on-payment
    return record;
  },

  // v5.5.846 — close a table that was PAID ON THE PAX terminal (source='pax_table_pay').
  // The terminal charges the card but never closes the table; this is the POS half the
  // server always expected. Driven by TerminalJobReconciler over the terminal-job-status
  // edge fn (the POS has no direct read on terminal_jobs).
  //
  // SINGLE CLOSER, no double-write: record.id === the job's pre-minted closed_check_id,
  // written through upsertClosedCheck (INSERT ... ON CONFLICT DO NOTHING). Exactly one
  // caller's insert lands (created:true) and owns the non-idempotent effects (stock,
  // loyalty); every other device/tab/retry no-ops. The floor-clear + tombstone are
  // idempotent and safe to run everywhere.
  closeApprovedTerminalJob: async (job) => {
    if (isTrainingMode()) return;                                  // training tills never write money
    const d = job.check_draft || {};
    const tableId = d.tableId || null;
    // v5.5.862: tableId is no longer required — a Mode-3 COUNTER sale (walk-in /
    // takeaway) has none, and those are exactly the jobs that used to park in
    // 'approved' forever. closed_check_id stays mandatory: it is the single-closer
    // election key.
    if (!job.closed_check_id) return;

    // Fail closed, INDEPENDENT of the edge fn: only ever close a job the card actually
    // APPROVED, for a real charged amount. Without this, a stale (pre-846) edge fn under
    // deploy skew could return a still-pending job (charge_minor null) → we'd book a £0
    // sale and yank a live mid-payment table off the floor. The money-writer must enforce
    // its own name, not trust a remote filter.
    if (job.status !== 'approved') return;
    if (!(Number(job.charge_minor) > 0)) return;
    // v5.6.68 — a PARTIAL pay-at-table split leg never books a check or clears
    // the table; the FINAL leg (draft.priorLegs) books the whole occupation.
    if (d.partial === true) return;

    // Reader split legs taken before this final one. Each is an approved
    // terminal_jobs row snapshotted into the final leg's draft by the RPC —
    // settled before this leg could exist, so their money is final here.
    const priorLegs = Array.isArray(d.priorLegs)
      ? d.priorLegs.filter(l => l && Number(l.chargeMinor) > 0) : [];
    const priorChargeMinor = priorLegs.reduce((s, l) => s + Number(l.chargeMinor), 0);
    const priorTipMinor = priorLegs.reduce((s, l) => s + (Number(l.tipMinor) || 0), 0);
    // Final leg FIRST: attachCardToIntents stamps the job's own card block on
    // intents[0], which must be this leg's, not a prior leg's.
    // The final leg keeps its slot even with a null transaction_id (an approved
    // settle can carry no pspReference): dropping it would promote a PRIOR leg
    // to intents[0], where attachCardToIntents stamps THIS leg's card — a later
    // refund would then reverse the wrong transaction. A null id is honest; a
    // mislabelled one is not. Priors without an id are still dropped (nothing to
    // refund by), and their card blocks ride along for per-leg receipts.
    const legIntents = priorLegs.length ? [
      { id: job.transaction_id || null, amountMinor: Number(job.charge_minor) },
      ...priorLegs.filter(l => l.transactionId)
        .map(l => ({ id: l.transactionId, amountMinor: Number(l.chargeMinor), card: l.card || null })),
    ] : null;

    const { tables, closedChecks } = get();
    if (closedChecks.some(c => c.id === job.closed_check_id)) return;   // already closed on this device
    const table = tableId ? tables.find(t => t.id === tableId) : null;
    if (table?.session && isSessionClosed(tableId, table.session)) return;

    // Is the party live at this table NOW the SAME occupation the card paid for? The draft
    // froze the paying occupation's identity (sessionId + seatedAt); a re-seat mints a fresh
    // id + seatedAt, so a mismatch means a DIFFERENT party is seated — and must never be
    // closed, dropped, or attributed by this job (that would destroy their live unpaid order,
    // breaching "tables MUST never be lost").
    //
    // v5.5.862 — seatedAt is now REQUIRED for a match, not optional. Session ids are
    // ORD-<counter> and the counter resets on reload, so id-alone can collide with a
    // DIFFERENT party (the same recurrence that false-tripped the paid-table guard).
    // Table-Pay drafts always carry seatedAt (the RPC writes it), so this changes
    // nothing for them; a draft WITHOUT seatedAt (older Mode-3) simply takes the
    // headless path below and leaves any live table untouched — safe by construction.
    const liveIsPayingOccupation = !!table?.session
      && String(table.session.id) === String(d.sessionId)
      && d.seatedAt != null
      && Number(table.session.seatedAt) === Number(d.seatedAt);

    // ── amount drift → NEVER withhold the close (v5.5.866) ─────────────────────
    // The card CAPTURED job.charge_minor and the table MUST close — you can never book a
    // number different from what you actually took. If the live bill drifted from the frozen
    // due (a scheduled price/discount/service-charge rule crossing a time boundary between
    // freeze and reconcile, a second till re-pricing the shared session, or items edited on
    // the table after payment started), we STILL close: booking EXACTLY the charged amount via
    // the frozen-draft (headless) path — never a live session total that differs from the
    // capture — and we surface the delta as a NON-BLOCKING advisory for a manager.
    //
    // The old code called flagJobStale here and RETURNED, leaving the table SEATED with the
    // money already taken. flagJobStale set the blocking needs_human that then hid the job from
    // the reconciler's filter FOREVER — the precise "paid but stuck open, sale stranded"
    // failure. acknowledged_total_minor is still honoured (a manager who already reconciled a
    // mismatch pinned that exact figure), it just no longer gates the close.
    const acknowledged = job.acknowledged_total_minor != null
      && Number(job.live_total_minor) === Number(job.acknowledged_total_minor);
    // v5.6.68 — drift compares the live bill against due + the split legs
    // already taken (a final split leg's due is only the REMAINDER).
    const paidBeforeMinor = Number(d.paidBeforeMinor) || 0;
    const driftMinor = (!acknowledged && job.live_total_minor != null)
      ? (Number(job.live_total_minor) - (Number(job.due_minor) + paidBeforeMinor)) : 0;
    const hasDrift = Number.isFinite(driftMinor) && driftMinor !== 0;

    // ── card block from the job (brand/last4/auth for the receipt) ─────────────
    const c = job.card || {};
    const cardReceipt = (job.card || job.auth_code) ? {
      brand: c.brand || c.scheme || null,
      last4: c.last4 || c.last_4 || null,
      auth:  job.auth_code || null,
      aid:   c.aid || null,
      cvm:   c.cvm || null,
      entryMode: c.entry_mode || c.entryMode || null,
    } : null;

    const termPay = {
      // v5.6.68 — reader splits: the final leg books the WHOLE occupation as one
      // 'split' check (full items, every card leg a payment intent), mirroring
      // the POS SplitModal's single-check model so reports/refunds treat both
      // the same.
      method: priorLegs.length ? 'split' : 'card',
      processor: job.processor || 'ryft',
      grand: ((job.charge_minor ?? 0) + priorChargeMinor) / 100,   // every leg's base + tip
      tip:   ((job.tip_minor ?? 0) + priorTipMinor) / 100,
      stripePaymentIntentId: job.transaction_id || null,
      paymentIntents: legIntents || undefined,
      cardReceipt,
      // v5.5.902: the gift card the POS debited BEFORE dispatching this job (the job's
      // due was already net of it). Recording it here is what makes a refund of a
      // reconciler-closed check restore the balance — this path booked null before, so
      // the money came off the card with nothing on the check to reverse it by.
      giftCard: d.giftCard || null,
    };

    // Rich path ONLY when the live occupation IS the one that paid → full-fidelity record
    // (fresh tax, customer, ref) off THAT session. Otherwise (no live session, or a
    // DIFFERENT party re-seated here) build headless from the frozen draft — never off a
    // stranger's session.
    let record;
    if (liveIsPayingOccupation && !hasDrift) {
      record = get().buildCloseRecord(table.session, table, termPay, { idOverride: job.closed_check_id });
    } else {
      // Headless whenever there is drift (even for the paying occupation): book the FROZEN
      // draft so the itemisation is internally consistent with the charged amount, rather than
      // a live session whose total no longer matches what the card took.
      const items = Array.isArray(d.items) ? d.items.filter(i => !i?.voided).map(i => ({ ...i })) : [];
      const subtotal = (d.subtotalMinor ?? 0) / 100;
      record = {
        id: job.closed_check_id,
        ref: getNextOrderRefLocal(),
        tableId, tableLabel: d.tableLabel || tableId,
        locationId: d.locationId || null,
        server: d.server || 'Staff', staffId: d.staffId || null,
        covers: d.covers || 1,
        // v5.5.862: honour the draft's own order type — a counter sale is not
        // 'dine-in'. Table-Pay drafts say 'dine-in'; Mode-3 drafts carry the till's.
        orderType: d.orderType || (tableId ? 'dine-in' : 'takeaway'),
        items, discounts: Array.isArray(d.discounts) ? d.discounts : [],
        // v5.5.851: the frozen draft carries the POS's OWN stamped totals — the delta
        // between total and subtotal IS whatever service was genuinely on the bill
        // (zero when none was). Never a guessed rate (the old `subtotal * 0.125`
        // invented a fee the customer was never charged).
        subtotal, service: Math.max(0, ((d.totalMinor ?? 0) - (d.subtotalMinor ?? 0))) / 100,
        tip: ((job.tip_minor ?? 0) + priorTipMinor) / 100,
        total: ((job.charge_minor ?? 0) + priorChargeMinor) / 100,   // v5.6.68 — every split leg
        taxAmount: null,
        method: priorLegs.length ? 'split' : 'card',
        giftCard: d.giftCard || null,   // v5.5.902 — see termPay above
        stripePaymentIntentId: job.transaction_id || null,
        processor: job.processor || 'ryft',
        paymentIntents: legIntents, cardReceipt,
        loyaltyRedemption: null,
        closedAt: Date.now(),
        seatedAt: d.seatedAt ? Number(d.seatedAt) : null,
        status: 'paid', refunds: [],
        taxBreakdown: null,
      };
    }
    // Tag with the job's REAL source so reports distinguish Table Pay from a POS
    // send-to-terminal (both card-on-PAX, different flows).
    record.source = d.source || 'pax_table_pay';

    // ── v5.7.5 TIP ON PRINTED RECEIPT: the reconciler's leg stamp ──────────────
    // A manual-capture sale whose modal died before booking closes HERE - and the
    // check must still show its open tip window, or the auth silently rides to
    // the deadline sweep with staff none the wiser. The job's REAL capture_mode
    // gates the fetch (fetchJobCapture refuses anything but 'manual'): a job row
    // without capture_mode simply gets no chip - never a hardcoded 'manual'
    // that would mint phantom DEMO-CAP chips on ordinary simulated sales.
    // Best-effort by design: a missed stamp is healed by the server's own leg
    // updates (webhook/tip_capture write the flag by psp match).
    try {
      if (get().tipOnReceipt?.enabled && d.source === 'pos_send_to_terminal' && !priorLegs.length) {
        const cap = await fetchJobCapture({
          id: job.id,
          capture_mode: job.capture_mode,
          simulated: job.simulated === true,
          charge_minor: job.charge_minor,
        });
        if (cap) record.paymentIntents = attachCaptureToIntents(record.paymentIntents, cap);
      }
    } catch (e) { console.warn('[closeApprovedTerminalJob] capture stamp skipped:', e?.message || e); }

    // ── v5.7.21: booking prepay/deposit credit the checkout applied ────────────
    // CheckoutModal froze it into the draft (like giftCard): the terminal's due
    // was already net of this credit, so the reconciler-closed check must carry
    // the same tender legs the modal-closed one would — appended AFTER the card
    // legs (slot 0 stays the till's own card leg; these have id:null so
    // cardLegsOf can never route a refund at them).
    if (Array.isArray(d.bookingPayment?.legs) && d.bookingPayment.legs.length) {
      record.bookingPayment = d.bookingPayment;
      record.paymentIntents = [
        ...(record.paymentIntents || []),
        ...d.bookingPayment.legs.map(l => ({ id: null, amountMinor: Number(l.amountMinor) || 0, method: l.method })),
      ];
    }

    // ── ELECT THE SINGLE CLOSER — the closed_checks PK does the arbitration ────
    const { ok, created } = await upsertClosedCheck(record);

    // ── v5.5.944: a FAILED upsert must leave this device able to retry ─────────
    // The old order prepended the local tombstone and dropped the floor slot even when
    // ok:false. That local tombstone then tripped the "already closed on this device"
    // guard above on every subsequent tick — so the v5.5.851 promise ("job left
    // approved for retry") was a lie on the one till that had already tried, which is
    // usually the ONLY awake till. Live case (29 Jul, B2 £57.55 on the A50): sale in
    // the till's History, closed_checks row nowhere, job stuck 'approved' with zero
    // reconcile attempts, and the local-only floor drop set off the session
    // delete/resurrect tug-of-war that put B2 back on the floor. On failure: touch
    // NOTHING local, flag it once where a human can see it, and let the next tick retry.
    if (!ok) {
      console.warn('[closeApprovedTerminalJob] check write did not land for', job.closed_check_id, '— job left approved for retry');
      if (!_closeFailFlagged.has(job.id)) {
        _closeFailFlagged.add(job.id);
        logActivity(record.locationId || d.locationId || null, {
          kind: 'system', severity: 'action',
          title: 'Card taken — sale not yet recorded',
          body: `${d.tableLabel || tableId || 'Counter'}: £${((job.charge_minor ?? 0) / 100).toFixed(2)} captured on the terminal but the sale record has not saved yet. Retrying automatically — if this persists, check the till's connection.`,
          refType: 'terminal_job', refId: job.id,
        }).catch(() => {});
      }
      return;
    }

    // Idempotent on every caller: prepend the tombstone.
    set(s => ({ closedChecks: s.closedChecks.some(c => c.id === record.id) ? s.closedChecks : capClosedChecks([record, ...s.closedChecks]) }));
    // Drop the floor slot ONLY if it is empty or still held by the paying occupation —
    // a table re-seated by a NEW party keeps its live order untouched. (Counter sales
    // have no floor slot at all.)
    if (tableId && (!table?.session || liveIsPayingOccupation)) get()._dropTableFromFloor(tableId);

    // Non-idempotent effects fire for EXACTLY the elected closer.
    if (created) {
      depleteForSale(record);
      get().triggerChallenge21Check?.(record);
      // v5.7.21 — stamp the booking's captured rows applied_to_check (server-side
      // idempotent: only un-applied captured rows update, so a retry is a 0-count
      // no-op). Best-effort, never blocks the close.
      if (record.bookingPayment?.bookingId && supabase && !isMock) {
        supabase.rpc('apply_booking_payment', {
          p_booking_id: record.bookingPayment.bookingId,
          p_closed_check_id: record.id,
        }).then(({ error }) => {
          if (error) console.warn('[closeApprovedTerminalJob] apply_booking_payment:', error.message);
        }).catch(() => {});
      }
      // Attribute loyalty only to the occupation that actually paid — never a re-seated party.
      if (liveIsPayingOccupation && table?.session?.customer?.phone) {
        get().attributeOrderToCustomer({ customer: table.session.customer, orderRecord: record }).catch(() => {});
      }
    }
    // v5.5.851: ONLY when the check row provably landed server-side. The 846 version
    // marked the job reconciled unconditionally — so a failed/offline-queued upsert
    // (ok:false) pulled the job out of the retry queue with the sale recorded NOWHERE
    // except this device's localStorage safety net (live case: a £2.85 Table-Pay sale
    // vanished from history). ok:false now leaves the job 'approved': the next tick —
    // on any till — retries the idempotent upsert until it lands, then marks done.
    // v5.5.866 — delete the paid occupation's active_sessions row SERVER-SIDE now, so the table
    // closes on EVERY device immediately rather than lingering until an awake device's 10s
    // ghost-sweep fires (the A50 runs no sweep; the table then re-hydrated on the floor). Same
    // occupation gate as the floor drop; the RPC itself also refuses anything but the exact paid
    // occupation (session id + seatedAt) with a booked closed_check. SessionReconciler stays the backstop.
    // (v5.5.944: the ok:false branch returns above, so everything from here runs only
    // once the closed_check row provably landed server-side.)
    if (tableId && (!table?.session || liveIsPayingOccupation)) {
      closeTerminalSession({
        locationId: record.locationId || d.locationId || null,
        tableId,
        sessionId: d.sessionId,
        seatedAt: d.seatedAt,
        closedCheckId: record.id,
      }).catch(() => { /* best-effort — ghost-sweep backstop remains */ });
    }
    if (hasDrift) {
      // NON-BLOCKING advisory (v5.5.866): the sale IS booked at the charged amount; a manager
      // reviews the delta from the activity feed. This replaces the old flagJobStale-and-strand.
      logActivity(record.locationId || d.locationId || null, {
        kind: 'system', severity: 'action',
        title: 'Table Pay — bill differed from amount charged',
        body: `${d.tableLabel || tableId || 'Counter'}: charged £${((job.charge_minor ?? 0) / 100).toFixed(2)}, `
          + `live bill £${(Number(job.live_total_minor) / 100).toFixed(2)} `
          + `(${driftMinor > 0 ? '+' : '−'}£${Math.abs(driftMinor / 100).toFixed(2)}). `
          + `Booked at the charged amount — review.`,
        refType: 'closed_check', refId: record.id,
      }).catch(() => {});
    }
    await markJobReconciled(job.id).catch(() => {});   // housekeeping — insert-first, so a crash here just retries
    // v5.6.68 — the split legs this close consumed retire with it. CAS'd RPC
    // (approved → reconciled, needs_human=false only), so repeats are harmless
    // and a parked leg stays visible in Unresolved payments.
    for (const l of priorLegs) {
      if (l.jobId) await markJobReconciled(l.jobId).catch(() => {});
    }
    // v5.5.862: the sale is durably recorded — release this device's payment-
    // reference handle for the check. A stale handle here is what produced
    // "payment reference has already been used" on the NEXT sale sharing the key.
    if (job.check_key) { try { forgetJob(job.check_key); } catch { /* best-effort */ } }
  },

  /**
   * v5.5.903 — put a terminal job's DISPATCH-TIME gift-card debit back on the card.
   *
   * The PAX / send-to-terminal path debits the gift card as the job is dispatched rather
   * than at close, because the check can be closed from any till by TerminalJobReconciler
   * without the checkout modal (v5.5.902). The cost of that is this: a job that never
   * completes has already taken the balance, and with no check written there is nothing
   * for refundCheck to reverse. This is the undo.
   *
   * CALL ONLY WITH A JOB PROVEN DEAD — a server-confirmed cancel, or a settled
   * declined/cancelled/expired status. A live job may still be paid, and the reconciler
   * would then close it with this exact leg on the check.
   *
   * @param {string} jobId
   * @param {string[]} claimedKeys idempotency keys the check being recorded instead already
   *        claims — those legs are accounted for and must NOT be reversed.
   * @param {string} reason        stamped on the gift-card ledger row.
   */
  _reverseTerminalJobGift: async (jobId, claimedKeys = [], reason) => {
    if (!jobId || !supabase) return;
    if (isTrainingMode()) return;   // TRAINING MODE: nothing real was ever debited
    try {
      // The job row is the record of what was debited — check_draft.giftCard is written
      // at dispatch precisely so a device without the modal can still read (and now
      // reverse) it. The POS has no direct SELECT on terminal_jobs; fetchJob is fenced.
      const job = await fetchJob(jobId).catch(() => null);
      const leg = job?.check_draft?.giftCard || null;
      // No key = the commit failed = nothing was debited (giftCardCheckRecord nulls it),
      // so there is nothing to restore and a reversal would 404.
      if (!leg?.card_id || !leg?.idempotency_key) return;
      if (claimedKeys.includes(leg.idempotency_key)) return;
      const token = await ensureAuthToken();
      if (!token) { console.warn('[reverseTerminalJobGift] skipped — no auth token'); return; }
      const r = await reverseGiftCard(leg, {
        functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`,
        token,
        locationId: getActiveLocationSync(),
        reason: reason || 'Card machine payment cancelled',
        staffId: get().staff?.id || null,
      });
      if (r.ok && !r.skipped) {
        console.info('[reverseTerminalJobGift] gift card reversed:', r.status, 'restored:', r.restored);
        get().showToast?.('Gift card balance restored — the card machine payment was cancelled.', 'info');
      } else if (!r.ok) {
        console.warn('[reverseTerminalJobGift] gift reversal failed:', r.error);
        get().showToast?.('Could not restore a gift card from the cancelled card-machine payment — check the balance in Back Office.', 'error');
      }
    } catch (e) {
      console.warn('[reverseTerminalJobGift] gift reversal failed:', e?.message || e);
    }
  },

  // Redeem a held promo code / loyalty reward against a recorded check — atomic + race-safe
  // server-side, bound to the check id. Never blocks the sale (the callers don't await), but
  // these no longer FORGET the outcome: lib/commitRedemptions awaits the call, checks
  // transport AND payload, and parks a failure in the durable queue so the deduction is retried.
  // Both used to console.warn only, so a 401/500 left the reward unconsumed and re-redeemable.
  redeemLoyaltyAtCommit: async (loy, record, customer) => {
    if (!loy?.pending_commit || !supabase || !record?.id) return;
    if (!loy.stampProgramId && !loy.reward_id) return;
    if (isTrainingMode()) return;   // TRAINING MODE: never consume real points/stamps
    const { staff } = get();
    let locId = getActiveLocationSync(); if (!locId) { try { locId = localStorage.getItem('rpos-active-location') || null; } catch {} }
    const token = await ensureAuthToken().catch(() => null);
    const r = await commitRedemption({
      kind: 'loyalty',
      customerId: loy.customer_id || customer?.customerId || customer?.id || null,
      locationId: locId,
      stampProgramId: loy.stampProgramId || null,
      rewardId: loy.reward_id || null,
      channel: 'pos',
      closedCheckId: record.id,
      staffId: staff?.id || null,
    }, { functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`, token });
    // Queued failures retry themselves; a refusal never will, so say what didn't happen.
    if (!r.ok && !r.queued) {
      get().showToast?.(`Reward discount given but NOT deducted (${r.error}) — check the customer's balance in Back Office.`, 'error');
    }
    return r;
  },

  redeemPromoCode: async (promo, record, customer) => {
    if (!promo?.code || !supabase || !record?.id) return;
    if (isTrainingMode()) return;   // TRAINING MODE: don't consume a one-time / limited promo code
    const { staff } = get();
    let locId = getActiveLocationSync(); if (!locId) { try { locId = localStorage.getItem('rpos-active-location') || null; } catch {} }
    const token = await ensureAuthToken().catch(() => null);
    const r = await commitRedemption({
      kind: 'promo',
      code: promo.code,
      locationId: locId,
      customerId: customer?.customerId || customer?.id || null,
      staffId: staff?.id || null,
      basketValue: record.subtotal || 0,
      channel: 'pos',
      closedCheckId: record.id,
    }, { functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`, token });
    if (!r.ok && !r.queued) {
      get().showToast?.(`Promo code ${promo.code} was applied but NOT recorded (${r.error}) — it can still be used again.`, 'error');
    }
    return r;
  },

  // Direct record insertion — used by bar tabs and other ad-hoc payment flows
  recordWalkInClosedCheck: (record) => {
    const { staff } = get();
    const fullRecord = {
      id: `chk-${Date.now()}`,
      closedAt: Date.now(),
      status: 'paid',
      refunds: [],
      locationId: getActiveLocationSync() || (() => { try { return localStorage.getItem('rpos-active-location') || null; } catch { return null; } })(),  // v5.5.279/311: stamp locationId (durable-tag fallback) for cross-location filter
      staffId: record.staffId || staff?.id || null,   // v4.6.19
      ...record,
    };
    set(s => ({ closedChecks: capClosedChecks([fullRecord, ...s.closedChecks]) }));
    insertClosedCheck(fullRecord).catch(()=>{});
    depleteForSale(fullRecord);   // v5.5.565: recipe → stock ledger depletion (fire-and-forget)
    // v5.5.163: Challenge 21 — alcohol counter + prompt
    get().triggerChallenge21Check?.(fullRecord);
    // v4.6.30: cash drawer auto-fire on cash payment
    // v4.6.62: attribute bar-tab orders to customer DB if customer was set on tab
    if (fullRecord.customer?.phone) {
      get().attributeOrderToCustomer({
        customer: fullRecord.customer, orderRecord: fullRecord,
      }).catch(err => console.warn('[recordWalkInClosedCheck customer]', err?.message || err));
    }
    if (fullRecord.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(fullRecord.total) || 0,
        reason: `Cash sale · ${fullRecord.tableLabel || fullRecord.ref || 'Bar tab'}`.trim(),
        ref: fullRecord.ref,
        force: true,
      });
    }
    return fullRecord;
  },

  recordWalkInClosed: (walkInOrder, orderType, customer, paymentInfo = {}) => {
    if (!walkInOrder?.items?.length) return;
    // v5.5.853: a channel (HubRise) order paid at the till books via the SAME money
    // builder as the prepaid "collected" path (lib/channelMoney) — from the QUEUE row's
    // decoded figures, never from the payment cart (see OrdersHub.openOrder: that cart
    // is a display/charge copy with folded mods + negative already-paid lines). This is
    // the only way subtotal/discounts/delivery/VAT/total come out identical whichever
    // path closes the order. Also pushes 'collected' to HubRise, which the old generic
    // path never did (channel showed the order stuck forever after a till payment).
    if (walkInOrder._channelRef) {
      const o = get().orderQueue.find(q => q.ref === walkInOrder._channelRef);
      if (o) {
        const { staff, menuItems, taxRates } = get();
        const f = buildChannelCloseFields(o, { menuItems: menuItems || [], taxRates: taxRates || [] });
        const record = {
          id: `chk-hr-${o.ref}`,            // deterministic — same id as the prepaid booking path
          ref: o.ref,
          tableId: null,
          tableLabel: `${o.customer?.channel || 'HubRise'} ${o.customer?.collectionCode || o.ref}`,
          locationId: getActiveLocationSync() || null,
          server: staff?.name || o.customer?.channel || 'HubRise',
          staffId: staff?.id || null,
          covers: 1,
          orderType: o._raw?.type || o.type || 'delivery',
          // Payment story on the check: the channel legs + the balance taken at the till.
          customer: {
            ...(o.customer || {}),
            ...(f.deliveryFee > 0 ? { delivery_fee: f.deliveryFee } : {}),
            payments: [...f.payments, { name: `POS ${paymentInfo.method || 'card'}`, ref: null, amount: f.due }],
            paidAmount: f.total, due: 0, paid: true,
          },
          items: f.items,
          discounts: f.discounts,
          subtotal: f.subtotal,
          service: f.service,
          tip: f.tip,
          total: f.total,
          taxAmount: f.taxAmount,
          taxBreakdown: f.taxBreakdown,
          method: paymentInfo.method || 'card',
          giftCard: giftRecordFrom(paymentInfo),
          stripePaymentIntentId: paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null,
          processor: paymentInfo.processor || 'stripe',
          paymentIntents: attachCardToIntents(derivePaymentIntents(paymentInfo), paymentInfo.cardReceipt),
          cardReceipt: paymentInfo.cardReceipt || null,
          drawerId: get().myDrawer?.()?.id || null,
          shiftId: get().currentShift?.id || null,
          closedAt: Date.now(),
          status: 'paid',
          refunds: [],
          source: 'hubrise',
        };
        set(s => ({ closedChecks: capClosedChecks([record, ...s.closedChecks]) }));
        get().removeFromQueue(o.ref);      // local + DB delete
        insertClosedCheck(record);          // training/mock gated at the leaf
        if (record.method === 'cash') {
          // Drawer opens for the money actually taken at the till (the balance), not
          // the channel's headline total.
          get().openCashDrawer({
            type: 'cash_sale', amount: f.due,
            reason: `Cash sale · ${record.tableLabel}`.trim(), ref: record.ref, force: true,
          });
        }
        if (!isTrainingMode()) {
          hubrisePushStatus(record.locationId, o.ref, 'collected').catch(() => {});
        }
        get().maybeAutoSignout('pay');
        return record;
      }
      // Queue row already gone (another till closed it) — fall through to the generic
      // path would double-book; just clear the cart state and stop.
      return null;
    }
    // v5.5.792: PAYING MUST GUARANTEE PRODUCTION. Counter/walk-up staff often take
    // payment without ever tapping Send — the check used to close paid with NO KDS
    // ticket and no kitchen print. If any line was never fired (never sent, or
    // sent-but-held course), fire them ALL now in one combined send (course holds
    // ignored — the customer is paying). Already sent+fired lines are excluded, so
    // a normal Send → Pay flow doesn't double-fire. Only runs when the caller is
    // closing the live store walkInOrder (POS + MPOS both do); after the send we
    // re-read it so the record picks up the queue ref + sent flags the send stamped.
    if (walkInOrder === get().walkInOrder &&
        walkInOrder.items.some(i => !i.voided && (i.status === 'pending' || (i.status === 'sent' && !i.fired)))) {
      get().sendToKitchen({ fireAll: true, tableId: null });
      walkInOrder = get().walkInOrder || walkInOrder;
    }
    const { staff, taxRates } = get();
    const subtotal = walkInOrder.items.reduce((s, i) => s + i.price * i.qty, 0);
    // v4.6.19 — compute tax at close so tax_amount can be stored with the row
    let taxBreakdown = null;
    if (taxRates?.length) {
      try { taxBreakdown = calculateOrderTax(walkInOrder.items.filter(i=>!i.voided), taxRates, orderType); } catch {}
    }
    // If the walk-in was reopened from orderQueue (OrdersHub openOrder) it already
    // has a ref (e.g. '#6720'). Reuse it so the closed check matches what the user
    // sees and so we can remove the stale queue entry below. Only generate a new
    // random ref for genuinely-new walk-ins.
    const existingRef = walkInOrder.ref || null;
    const record = {
      // v5.5.902: adopt CheckoutModal's pre-minted id (see buildCloseRecord).
      id: paymentInfo.closedCheckId || `chk-${Date.now()}`,
      ref: existingRef || getNextOrderRefLocal(),
      tableId: null,
      tableLabel: null,
      locationId: getActiveLocationSync() || (() => { try { return localStorage.getItem('rpos-active-location') || null; } catch { return null; } })(),  // v5.5.279/311: stamp locationId (durable-tag fallback) for cross-location filter
      server: staff?.name || 'Staff',
      staffId: staff?.id || null,                                              // v4.6.19
      covers: 1,
      orderType,
      customer,
      items: walkInOrder.items.filter(i => !i.voided).map(i => ({ ...i })),
      discounts: [...(walkInOrder.discounts || []),
                  ...evaluateAutoDiscounts(walkInOrder.items.filter(i=>!i.voided), get().discountRules, 'pos', buildScheduleCtx(get().locationConfig?.timezone)).map(toAppliedDiscount),
                  ...promoDiscountEntry(paymentInfo.promoRedemption)],
      subtotal,
      service: 0,
      tip: paymentInfo.tip || 0,
      total: paymentInfo.grand || subtotal,
      taxAmount: taxBreakdown?.totalTax != null ? taxBreakdown.totalTax : null, // v4.6.19
      taxBreakdown,                                                                  // v5.5.341: store full breakdown so receipts/reports show VAT lines (walk-in/MPOS)
      method: paymentInfo.method || 'card',
      giftCard: giftRecordFrom(paymentInfo),                                         // v5.5.217 / v5.5.902
      stripePaymentIntentId: paymentInfo.stripePaymentIntentId || paymentInfo.paymentIntentId || null,              // v5.5.301
      processor: paymentInfo.processor || 'stripe',                                  // refund routes by this
      paymentIntents: attachCaptureToIntents(attachCardToIntents(derivePaymentIntents(paymentInfo), paymentInfo.cardReceipt), paymentInfo.capture),  // v5.5.323 legs + v5.5.719 card block + v5.7.5 tip-on-receipt (counter sales open windows too)
      cardReceipt: paymentInfo.cardReceipt || null,                                  // v5.5.719: card-scheme receipt block
      loyaltyRedemption: paymentInfo.loyaltyRedemption || null,                      // v5.5.315
      drawerId: get().myDrawer?.()?.id || null,                                   // v4.6.37
      shiftId:  get().currentShift?.id || null,                                   // v4.6.37
      closedAt: Date.now(),
      status: 'paid',
      refunds: [],
    };
    // v5.5.646: delivery surcharge — stamp the customer-facing fee onto the record
    // (mirrors catering's customer.delivery_fee) so receipts/reports show it. The
    // grand total already includes it (getPOSTotals folds deliveryFee).
    const _dq = get().deliveryQuote;
    if (orderType === 'delivery' && _dq?.available) {
      record.customer = { ...(customer || {}), delivery_fee: (_dq.customerFeeMinor || 0) / 100, delivery_mode: _dq.mode || 'self' };
      record.deliveryFee = (_dq.customerFeeMinor || 0) / 100;
    }
    // Single set: append to closedChecks AND, if this came from the queue, drop
    // the stale entry so the order stops showing as open. Previously only the
    // closedCheck was written — queue entry persisted, so 'cash off' left the
    // order visible in Orders and re-cashing produced duplicate closed checks.
    set(s => ({
      closedChecks: capClosedChecks([record, ...s.closedChecks]),
      orderQueue: existingRef ? s.orderQueue.filter(o => o.ref !== existingRef) : s.orderQueue,
    }));
    // v4.6.30: cash drawer auto-fire on cash payment
    // v4.6.62: attribute to customer DB (fire-and-forget)
    if (customer?.phone) {
      get().attributeOrderToCustomer({
        customer, orderRecord: record,
      }).catch(err => console.warn('[recordWalkInClosed customer]', err?.message || err));
    }
    if (record.method === 'cash') {
      // v4.6.32: force=true — cash sale itself is the authorisation.
      get().openCashDrawer({
        type: 'cash_sale',
        amount: Number(record.total) || 0,
        reason: `Cash sale · ${customer?.name || record.ref || orderType}`.trim(),
        ref: record.ref,
        force: true,
      });
    }
    insertClosedCheck(record);
    depleteForSale(record);   // v5.5.565: recipe → stock ledger depletion (fire-and-forget)
    // v5.5.646: log delivery quote + surcharge (margin reporting) + clear the held quote.
    // v5.5.647: also dispatch the courier (edge fn routes by venue dispatch_backend).
    // Both skipped in training (no real surcharge row, no real courier).
    if (orderType === 'delivery' && _dq?.available && !isTrainingMode()) {
      recordDeliverySurcharge({ opsLocationId: record.locationId, orderRef: record.ref, quote: _dq }).catch(() => {});
      // Only dispatch a courier in 'uber' mode. Self-delivery just fires to the POS/kitchen.
      if (_dq.dispatchable) {
        dispatchDelivery({ opsLocationId: record.locationId, order: record, quote: _dq })
          .then((res) => { if (res?.trackingUrl) sendDeliveryTrackingSMS({ opsLocationId: record.locationId, phone: record.customer?.phone, trackingUrl: res.trackingUrl, ref: record.ref }); })
          .catch(() => {});
      }
      set({ deliveryQuote: null });
    } else if (orderType === 'delivery') {
      set({ deliveryQuote: null });
    }
    if (paymentInfo.promoRedemption) get().redeemPromoCode?.(paymentInfo.promoRedemption, record, customer);
    if (paymentInfo.loyaltyRedemption?.pending_commit) get().redeemLoyaltyAtCommit?.(paymentInfo.loyaltyRedemption, record, customer);
    // v5.5.163: Challenge 21 — alcohol counter + prompt
    get().triggerChallenge21Check?.(record);
    get().maybeAutoSignout('pay');   // v5.5.731 per-device sign-out-on-payment (walk-in path)
    return record;
  },

  // ══ REFUND ═══════════════════════════════════════════════════════════════
  //
  // v5.6.79 (#107 + #108) — this used to be BOOKKEEPING ONLY, and it lied twice.
  //
  //   1. The amount came from ITEMS ALONE and full-vs-partial was decided against
  //      `subtotal`, so a "full" refund never returned the tip or the service
  //      charge. The customer kept paying a gratuity on a meal they did not have.
  //   2. Nothing was ever reversed on ADYEN: the router was
  //      `processor === 'ryft' ? ryft : stripe`, so an Adyen check aimed at Stripe
  //      and landed nowhere — while the screen said "processed".
  //
  // It is now ASYNC and returns a verdict. Callers must await it and report what
  // it says, not what they hoped: `{ ok, amount, cardStatus, legs, message }`.
  //
  // WHAT IS DELIBERATELY UNCHANGED: the local ledger mutation still happens first
  // and immediately. The refund is an operator decision and it is recorded whether
  // or not the processor plays ball; what changed is that a failed reversal is now
  // recorded AS failed, surfaced, and left retryable (`retryRefundReversal`)
  // instead of being swallowed by a fire-and-forget console warning.
  // ── v5.7.5 TIP ON PRINTED RECEIPT - apply the written tip (or close with none) ──
  // Calls adyen-modify action 'tip_capture' (same fetch discipline as
  // cardReversal.js: plain fetch, read the body, and NEVER trust HTTP 200 alone -
  // adyen-modify hands definitive Adyen refusals back as 200 { ok:false }).
  //
  // THE SERVER OWNS THE MONEY. It updates closed_checks (tip, total, leg) inside
  // the action; this store action only MIRRORS the confirmed outcome onto the
  // in-memory copy so History repaints without a reload. It must never bump
  // figures the server did not confirm.
  //
  // tipMinor 0 = "close with no tip" (plain capture at the auth amount).
  tipCapture: async (checkId, { reference, tipMinor }) => {
    if (isTrainingMode()) return { ok: false, error: 'Training mode. No live payment to adjust.' };
    if (!reference) return { ok: false, error: 'This payment has no capture reference on record.' };
    const tm = Math.round(Number(tipMinor));
    if (!Number.isFinite(tm) || tm < 0) return { ok: false, error: 'Enter a tip of zero or more.' };
    const locationId = getActiveLocationSync();
    if (!locationId || locationId === 'loc-demo') return { ok: false, error: 'No location resolved.' };
    const token = await ensureAuthToken().catch(() => null);
    if (!token) return { ok: false, error: 'Not authenticated.' };
    let res, j = {};
    try {
      res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-modify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'tip_capture', location_id: locationId, reference, tip_minor: tm }),
      });
      j = await res.json().catch(() => ({}));
    } catch (e) {
      // A network failure is NOT proof nothing happened - say that, don't guess.
      return { ok: false, error: `Could not reach the payment service: ${e?.message || e}. Check History again before retrying.` };
    }
    if (!res.ok || j.ok === false) {
      return {
        ok: false,
        status: j.status || null,
        error: j.error || `tip capture failed (HTTP ${res.status})`,
        detail: j.detail || null,
      };
    }
    // Confirmed - mirror the server's own closed-check update in memory. The
    // server already wrote tip/total/leg to closed_checks; re-applying the same
    // delta to the LOCAL copy is a mirror, not a second write.
    const legStatus = j.status || 'capturing';
    set(s => ({
      closedChecks: s.closedChecks.map(c => {
        if (c.id !== checkId) return c;
        const legs = Array.isArray(c.paymentIntents) ? c.paymentIntents : [];
        let matched = false;
        const nextLegs = legs.map(leg => {
          if (matched || !leg) return leg;
          const hit = (leg.captureId && (leg.captureId === j.capture_id || leg.captureId === reference))
            || (leg.capturePsp && (leg.capturePsp === j.psp_reference || leg.capturePsp === reference))
            || (legs.length === 1 && leg.capture);
          if (!hit) return leg;
          matched = true;
          const out = { ...leg, capture: legStatus, captureId: leg.captureId || j.capture_id || undefined };
          if (tm > 0 && Number.isFinite(Number(leg.amountMinor))) out.amountMinor = Number(leg.amountMinor) + tm;
          delete out.tipError;
          return out;
        });
        return {
          ...c,
          ...(tm > 0 ? {
            tip: +(((Number(c.tip) || 0) + tm / 100)).toFixed(2),
            total: +(((Number(c.total) || 0) + tm / 100)).toFixed(2),
          } : {}),
          ...(matched ? { paymentIntents: nextLegs } : {}),
        };
      }),
    }));
    return { ok: true, status: legStatus, mode: j.mode || null, capture_id: j.capture_id || null, final_minor: j.final_minor ?? null, note: j.note || null };
  },

  // ── v5.7.8 History capture-window self-heal ────────────────────────────────
  // A check that closed through the background reconciler can hold a live
  // terminal_captures row (the tip window) whose leg stamping never reached the
  // closed check: the card leg sits bare ({id, card, amountMinor}, no capture
  // flag), so History shows no Tip pending chip and no Add tip button. When the
  // operator opens such a check, ask adyen-modify 'capture_status' (read only)
  // for the check's capture rows and re-stamp the in-memory legs so the existing
  // TipWindowCard UI lights up. Silent on every failure - this is a repaint aid,
  // never a money path. Fires at most once per check per session.
  hydrateCaptureStatus: async (checkId) => {
    if (isMock || !checkId || _captureStatusChecked.has(checkId)) return;
    const chk = get().closedChecks.find(c => c.id === checkId);
    if (!chk) return;
    const legs = Array.isArray(chk.paymentIntents) ? chk.paymentIntents : [];
    // Same processor resolution the refund path uses (cardLegsOf): the leg's own
    // processor, else the check's. Only an Adyen-looking card leg WITHOUT a
    // capture flag needs healing - a stamped leg already renders its window.
    const fallbackProcessor = String(chk.processor || '').toLowerCase();
    const isAdyenLeg = (l) => String(l?.processor || fallbackProcessor).toLowerCase() === 'adyen';
    if (!legs.some(l => l && !l.capture && isAdyenLeg(l))) return;
    _captureStatusChecked.add(checkId);
    const locationId = getActiveLocationSync();
    if (!locationId || locationId === 'loc-demo') return;
    const token = await ensureAuthToken().catch(() => null);
    if (!token) return;
    let j = {};
    try {
      // Same fetch discipline as tipCapture / cardReversal.js: plain fetch, read
      // the body, never trust HTTP 200 alone.
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-modify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'capture_status', location_id: locationId, closed_check_id: checkId }),
      });
      j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok !== true) return;
    } catch { return; }
    const rows = Array.isArray(j.captures) ? j.captures : [];
    if (!rows.length) return;
    set(s => ({
      closedChecks: s.closedChecks.map(c => {
        if (c.id !== checkId) return c;
        const cur = Array.isArray(c.paymentIntents) ? c.paymentIntents : [];
        if (!cur.length) return c;
        let next = cur;
        for (const row of rows) {
          // terminal_captures.status uses the leg vocabulary verbatim
          // (pending/adjusting/capturing/captured/failed/expired/cancelled);
          // anything unrecognised is skipped rather than guessed at.
          if (!row || !CAPTURE_LEG_STATES.includes(row.status)) continue;
          // Match the row to its leg by capture ids first, then the leg id
          // against the pspReference; a bare reconciler leg matches the first
          // un-stamped Adyen leg (the incident shape: one leg, one row).
          let idx = next.findIndex(l => l && ((l.captureId && l.captureId === row.id)
            || (l.capturePsp && row.psp_reference && l.capturePsp === row.psp_reference)
            || (row.psp_reference && l.id === row.psp_reference)));
          if (idx < 0) idx = next.findIndex(l => l && !l.capture && isAdyenLeg(l));
          if (idx < 0) continue;
          next = next.map((l, i) => i !== idx ? l : {
            ...l,
            capture: row.status,
            captureId: row.id,
            ...(row.psp_reference ? { capturePsp: row.psp_reference } : {}),
            ...(row.deadline_at ? { captureDeadline: row.deadline_at } : {}),
            ...(Number.isFinite(Number(row.auth_minor)) ? { captureAuthMinor: Number(row.auth_minor) } : {}),
            ...(row.status === 'failed' && row.error ? { tipError: String(row.error) } : {}),
          });
        }
        return next === cur ? c : { ...c, paymentIntents: next };
      }),
    }));
  },

  refundCheck: async (checkId, opts = {}) => {
    const {
      items: refundItems = [], isFullRefund, manager, reason, tenderMethod,
      tipAmount = null, serviceAmount = null, legRefunds = null,
    } = opts;
    const chkBefore = get().closedChecks.find(c => c.id === checkId);
    if (!chkBefore) {
      console.warn('[refundCheck] no such check', checkId);
      return { ok: false, amount: 0, cardStatus: 'none', legs: [], message: 'Check not found' };
    }

    // THE STORE COMPUTES THE MONEY, NOT THE CALLER. `opts.amount` used to decide
    // it, and the three refund screens each derived it differently (two from
    // subtotal, MPOS from total). One breakdown, one set of clamps, three callers.
    const bd = refundBreakdown(chkBefore, {
      items: refundItems, isFullRefund,
      tipOverride: tipAmount, serviceOverride: serviceAmount,
    });
    const amount = bd.amount;
    if (!(amount > 0)) {
      return { ok: false, amount: 0, cardStatus: 'none', legs: [], message: 'Nothing left to refund on this check' };
    }

    const refundId = `ref-${Date.now()}`;
    // The tax that came back with these items, pro-rata on the check's own stored
    // tax. Recorded so VAT reporting CAN net a refund off (today it cannot — a
    // refund entry carried no tax portion at all, which is why `tax_amount` stayed
    // overstated after every refund).
    const taxRefunded = (chkBefore.taxAmount != null && Number(chkBefore.total) > 0)
      ? r2(Number(chkBefore.taxAmount) * (amount / Number(chkBefore.total)))
      : null;

    let nextRefunds = null;
    let nextStatus = null;
    set(s => ({
      closedChecks: s.closedChecks.map(chk => {
        if (chk.id !== checkId) return chk;
        const refund = {
          id: refundId,
          timestamp: Date.now(),
          manager: manager?.name || 'Staff',
          managerId: manager?.id || null,
          reason,
          isFullRefund: !!isFullRefund,
          tenderMethod: tenderMethod || 'card',
          items: refundItems,
          amount,
          // v5.6.79 — the three-way split. Legacy entries have no tipAmount /
          // serviceAmount and are read as items-only, which is exactly what they
          // were, so old checks still total up honestly.
          tipAmount: bd.tip,
          serviceAmount: bd.service,
          taxAmount: taxRefunded,
          // Filled in below once the processor has actually answered.
          cardStatus: 'pending',
          legs: [],
        };
        const allRefunds = [...(chk.refunds || []), refund];
        const totalRefunded = allRefunds.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        // v5.6.79 — against TOTAL, not subtotal. A tip-inclusive refund could
        // exceed `subtotal` on a partial and prematurely flip the check to
        // 'refunded', which hard-blocks every later refund.
        const status = totalRefunded >= (Number(chk.total) || 0) - 0.005 ? 'refunded' : 'partial_refund';
        nextRefunds = allRefunds;
        nextStatus = status;
        return { ...chk, refunds: allRefunds, status };
      }),
    }));
    // TRAINING MODE: the refund shows in-memory but NOTHING external fires — no
    // closed_checks update, no card reversal, no gift/loyalty refund.
    if (isTrainingMode()) {
      return { ok: true, amount, cardStatus: 'none', legs: [], training: true, message: `Training refund of ${money(amount)} recorded` };
    }
    // Persist to Supabase so other POS devices at the location see this refund
    // via the realtime UPDATE listener (lib/realtime.js). Not awaited — the local
    // mutation already happened so UX stays snappy — but the outcome IS read.
    //
    // This intermediate write is deliberate on a money path: it lands the refund
    // as `cardStatus:'pending'` BEFORE the processor is called, so a till that
    // dies mid-reversal leaves a visible unresolved refund rather than nothing at
    // all. The awaited write further down replaces it with the real outcome.
    //
    // ⚠️ This used to be `.catch(err => …)`. updateClosedCheckRefunds catches its
    // own errors and RESOLVES with { ok, error } — it never rejects — so that
    // handler was DEAD CODE and a failed persist logged absolutely nothing.
    if (nextRefunds && nextStatus) {
      updateClosedCheckRefunds(checkId, nextRefunds, nextStatus).then(({ ok: pOk, error: pErr }) => {
        if (!pOk) console.warn('[refundCheck] persist failed:', pErr?.message || pErr);
      });
    }
    // v5.5.217: Gift card balance reversal — restore the debited amount back
    // to the card. Fire-and-forget (same pattern as updateClosedCheckRefunds):
    // the local refund mutation already happened so UX stays responsive.
    // The edge function is idempotent (refund:{original_key}) — safe to retry.
    const check = get().closedChecks.find(c => c.id === checkId);
    // v5.5.565: reverse recipe-ingredient depletion for refunded items (RETURN
    // movements). Keyed by the new refund id so repeated partial refunds each post.
    reverseForSale(check, refundItems, nextRefunds?.[nextRefunds.length - 1]?.id);
    // v5.5.311: gift-reverse-redeem restores the FULL original gift redemption.
    // Only run it on a FULL refund — on a partial refund it would credit the
    // whole gift balance back regardless of the (smaller) refund amount, badly
    // over-refunding. Partial refunds of gift-paid checks need a dedicated
    // amount-aware flow (flagged for follow-up); for now they don't auto-reverse
    // the gift card.
    //
    // v5.5.902: reverse EVERY gift card that paid toward the check, not just one. A split
    // check can carry a leg per portion (giftLegs unwraps both shapes). A leg with a null
    // idempotency_key is one whose commit FAILED — nothing was debited, so there is nothing
    // to restore and reversing would 404 against a transaction that never existed.
    const legsToReverse = isFullRefund
      ? giftLegs(check).filter(g => g?.card_id && g.idempotency_key)
      : [];
    if (legsToReverse.length) {
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[refundCheck] gift reversal skipped — no auth token'); return; }
          for (const leg of legsToReverse) {
            // v5.5.903: one request shape, shared with the PAX cancel path — this used to
            // be the only gift-reverse-redeem caller, and a second hand-rolled copy is
            // exactly how two callers drift apart. reverseGiftCard NEVER throws, so one
            // bad leg still cannot strand the others.
            const r = await reverseGiftCard(leg, {
              functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`,
              token,
              locationId: getActiveLocationSync(),
              reason: `POS refund: ${reason || 'refund'}`,
              staffId: manager?.id || null,
            });
            if (r.ok) console.info('[refundCheck] gift card reversed:', r.status || 'ok', 'restored:', r.restored);
            else console.warn('[refundCheck] gift reversal failed for leg:', r.error);
          }
        } catch (e) {
          console.warn('[refundCheck] gift reversal failed:', e?.message || e);
        }
      })();
    }
    // v5.5.218: Loyalty points reversal — clawback earned points and restore
    // redeemed points. Fire-and-forget, same pattern as gift card reversal.
    // The edge function is idempotent via refund:{closed_check_id}.
    if (check?.customer?.phone || check?.customer_id || check?.loyalty) {
      (async () => {
        try {
          const token = await ensureAuthToken();
          if (!token) { console.warn('[refundCheck] loyalty reversal skipped — no auth token'); return; }
          // Resolve customer_id: check may have it directly, or we find it from loyalty data
          const customerId = check.customer_id || check.loyalty?.customer_id || null;
          if (!customerId) {
            console.warn('[refundCheck] loyalty reversal skipped — no customer_id on check');
            return;
          }
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-refund`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({
                customer_id: customerId,
                location_id: getActiveLocationSync(),
                // v5.5.311: must match the unique id used at earn time (chk-<ts>)
                // so loyalty-refund finds the right earn rows. Was check.ref
                // which cycles R1–R99 and could reverse the WRONG order's points.
                closed_check_id: check.id || check.ref,
                reason: reason || 'refund',
                staff_id: manager?.id || null,
              }),
            }
          );
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            console.info('[refundCheck] loyalty reversed:', j.status, 'points:', j.points_reversed);
          } else if (res.status !== 404) {
            // 404 = no loyalty transactions for this check — not an error
            console.warn('[refundCheck] loyalty reversal HTTP', res.status, j.error || '');
          }
        } catch (e) {
          console.warn('[refundCheck] loyalty reversal failed:', e?.message || e);
        }
      })();
    }
    // ── CARD REVERSAL — actually give the money back (v5.6.79, #107) ──────────
    //
    // Every card leg, routed by ITS OWN processor. Three things changed here:
    //
    //   1. ROUTING. It was `processor === 'ryft' ? ryft : stripe`, so an ADYEN
    //      check aimed at Stripe and landed nowhere. A leg now carries its own
    //      processor (inheriting the check's), and an UNKNOWN processor fails
    //      loudly instead of defaulting into the wrong one.
    //   2. AWAITED. This was fire-and-forget behind a success toast, so a refusal
    //      only ever reached the console. The caller now gets the verdict.
    //   3. CAPPED PER LEG. A leg is never asked for more than it captured (minus
    //      what earlier refunds already took off it), so one card can't be
    //      refunded with another card's money — and a full refund of a part-gift
    //      -paid check no longer asks the card for the gift's share.
    const legs = cardLegsOf(check);
    // ⚠️ A CASH PAYOUT MUST NOT ALSO REVERSE THE CARD.
    //
    // The refund screen offers "Cash payout" — money handed back from the drawer.
    // Reversing the card as well would refund the customer TWICE, once in notes
    // and once to their account. The old code never made this distinction; it got
    // away with it on Adyen only because the reversal silently did nothing. Now
    // that reversals actually work on all three processors, the gate is load-
    // bearing rather than theoretical.
    const cashPayout = tenderMethod === 'cash';
    const alreadyByLeg = legRefundedMinor(chkBefore);   // BEFORE this refund's own entry
    const cardCapMinor = legs.reduce(
      (s, l) => s + (l.amountMinor == null ? Infinity : Math.max(0, l.amountMinor - (alreadyByLeg[l.id] || 0))),
      0,
    );
    // Only the card's share goes to the card. The rest of a refund (a gift-card
    // or loyalty-funded portion) is reversed by the paths above, which own it.
    const wantMinor = toMinorAmt(amount);
    const cardTargetMinor = Number.isFinite(cardCapMinor) ? Math.min(wantMinor, cardCapMinor) : wantMinor;
    const { allocations } = cashPayout
      ? { allocations: [] }
      : allocateToLegs(legs, cardTargetMinor, legRefunds, alreadyByLeg);

    let legOutcomes = [];
    if (allocations.length) {
      const token = await ensureAuthToken();
      const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
      const locationId = getActiveLocationSync();
      for (const leg of allocations) {
        // Sequential on purpose: these are money calls against one check, and a
        // burst of parallel refunds is how you discover a processor's rate limit
        // in the worst possible place.
        const verdict = await reverseCardLeg({
          processor: leg.processor,
          legId: leg.id,
          amountMinor: leg.refundMinor,
          locationId,
          checkId: check.ref || check.id,
          refundId,
          staffId: manager?.id || null,
          currency: 'GBP',
          functionsUrl,
          token,
        });
        legOutcomes.push({
          id: leg.id,
          processor: leg.processor,
          amountMinor: leg.refundMinor,
          brand: leg.brand || null,
          last4: leg.last4 || null,
          status: verdict.status,
          ref: verdict.ref || null,
          error: verdict.error || null,
          at: Date.now(),
        });
      }
    }

    const cardStatus = rollUpLegStatus(legOutcomes);

    // ── Write the outcome back onto the refund entry ──────────────────────────
    // Which leg, how much, the processor's reference, and whether it actually
    // worked. A failed reversal is recorded AS failed — never as a completed
    // refund — and stays retryable.
    let persistRefunds = null;
    set(s => ({
      closedChecks: s.closedChecks.map(chk => {
        if (chk.id !== checkId) return chk;
        const updated = (chk.refunds || []).map(r =>
          r.id === refundId ? { ...r, cardStatus, legs: legOutcomes } : r);
        persistRefunds = updated;
        return { ...chk, refunds: updated };
      }),
    }));
    if (persistRefunds) {
      const { ok: persisted, error: persistErr } = await updateClosedCheckRefunds(checkId, persistRefunds, nextStatus);
      // supabase-js RESOLVES with { error } — destructure and log it. A `.then(ok, err)`
      // handler here would be DEAD CODE and a failing write would say nothing at all.
      if (!persisted) console.warn('[refundCheck] outcome persist failed:', persistErr?.message || persistErr);
    }

    // ── Tell the truth ────────────────────────────────────────────────────────
    const cardInMethod = String(check?.method || '').includes('card') || String(check?.method || '') === 'split';
    let ok = true;
    let message;
    if (cashPayout) {
      // Deliberately no card reversal — see the gate above.
      message = `Refund of ${money(amount)} handed back in cash`;
    } else if (!legs.length) {
      // Paid by card but nothing to refund against: legacy checks predating the
      // column, or a simulated/no-reader payment. Never claim it was processed.
      ok = !cardInMethod;
      message = cardInMethod
        ? `Refund of ${money(amount)} recorded — issue the card refund manually (no linked card payment found)`
        : `Refund of ${money(amount)} recorded via ${tenderMethod || 'cash'}`;
    } else if (cardStatus === 'failed') {
      ok = false;
      message = `Refund of ${money(amount)} recorded but the card reversal FAILED — no money has been returned. Retry it from the refund history.`;
    } else if (cardStatus === 'partial') {
      ok = false;
      const bad = legOutcomes.filter(l => l.status === 'failed').length;
      message = `Refund of ${money(amount)} recorded but ${bad} of ${legOutcomes.length} cards were NOT reversed. Retry those from the refund history.`;
    } else if (cardStatus === 'accepted') {
      message = `Refund of ${money(amount)} accepted by the card processor — it settles shortly.`;
    } else {
      message = `Refund of ${money(amount)} returned to the card`;
    }
    get().showToast(message, ok ? 'success' : 'error');
    return { ok, amount, cardStatus, legs: legOutcomes, refundId, message };
  },

  /**
   * Retry the card legs of an ALREADY RECORDED refund whose reversal failed.
   *
   * A failed reversal must never look like a completed refund, and it must never
   * force the operator to record a SECOND refund to get the money out — that
   * would double the bookkeeping for one decision. So the ledger entry stays as
   * it is and only the failed legs are re-attempted.
   *
   * Safe to press twice: the idempotency key is derived from the refund id and
   * the leg id, so a leg that actually succeeded the first time (and whose answer
   * we lost) replays its original outcome instead of moving money again.
   */
  retryRefundReversal: async (checkId, refundId) => {
    const check = get().closedChecks.find(c => c.id === checkId);
    const refund = (check?.refunds || []).find(r => r.id === refundId);
    if (!check || !refund) return { ok: false, message: 'Refund not found' };
    if (isTrainingMode()) return { ok: false, message: 'Training mode — nothing to reverse' };

    const todo = retryableLegs(refund);
    if (!todo.length) return { ok: false, message: 'Nothing to retry on this refund' };

    const token = await ensureAuthToken();
    const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
    const locationId = getActiveLocationSync();
    const results = new Map();
    for (const leg of todo) {
      const verdict = await reverseCardLeg({
        processor: leg.processor,
        legId: leg.id,
        amountMinor: leg.amountMinor,
        locationId,
        checkId: check.ref || check.id,
        refundId,
        staffId: refund.managerId || null,
        currency: 'GBP',
        functionsUrl,
        token,
      });
      results.set(leg.id, verdict);
    }

    let mergedLegs = [];
    let persistRefunds = null;
    set(s => ({
      closedChecks: s.closedChecks.map(chk => {
        if (chk.id !== checkId) return chk;
        const updated = (chk.refunds || []).map(r => {
          if (r.id !== refundId) return r;
          mergedLegs = (r.legs || []).map(l => {
            const v = results.get(l.id);
            return v ? { ...l, status: v.status, ref: v.ref || l.ref, error: v.error || null, at: Date.now() } : l;
          });
          return { ...r, legs: mergedLegs, cardStatus: rollUpLegStatus(mergedLegs) };
        });
        persistRefunds = updated;
        return { ...chk, refunds: updated };
      }),
    }));
    const cardStatus = rollUpLegStatus(mergedLegs);
    if (persistRefunds) {
      const { ok: persisted, error: persistErr } = await updateClosedCheckRefunds(checkId, persistRefunds, check.status);
      if (!persisted) console.warn('[retryRefundReversal] persist failed:', persistErr?.message || persistErr);
    }
    const ok = cardStatus === 'succeeded' || cardStatus === 'accepted';
    const message = ok
      ? (cardStatus === 'accepted' ? 'Card reversal accepted by the processor' : 'Card reversal completed')
      : 'Card reversal failed again — no money has moved. Refund this card in the processor dashboard.';
    get().showToast(message, ok ? 'success' : 'error');
    return { ok, cardStatus, legs: mergedLegs, message };
  },

  // ── Void log ──────────────────────────────
  voidLog: [],

  voidItem: (tableId, itemUid, { manager, reason }) => {
    const { tables, voidLog, showToast } = get();
    const table = tables.find(t => t.id === tableId);
    const item  = table?.session?.items?.find(i => i.uid === itemUid);
    if (!item) return;

    // v4.6.11: restore daily count — the voided item is not being consumed.
    if (item.itemId && !item.voided) {
      get().decrementDailyCount(item.itemId, -(item.qty || 1));
      // v5.5.189: restore modifier sub-item counts too
      (item.mods || []).forEach(mod => {
        if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (item.qty || 1)));
      });
    }

    // Mark item as voided (keep visible with strikethrough)
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = t.session.items.map(i => i.uid === itemUid ? { ...i, status:'voided', voided:true } : i);
        const subtotal = items.filter(i=>!i.voided).reduce((s,i)=>s+i.price*i.qty,0);
        return { ...t, session:{ ...t.session, items, subtotal, total:subtotal*1.125 } };
      }),
      voidLog: [{
        id:`void-${Date.now()}`, timestamp:Date.now(), type:'item',
        tableId, tableLabel:table.label,
        items:[{ name:item.name, price:item.price, qty:item.qty }],
        totalValue: item.price * item.qty,
        reason, manager: manager.name, managerId: manager.id,
      }, ...s.voidLog],
    }));
    showToast(`${item.name} voided — ${reason}`, 'warning');
  },

  voidCheck: (tableId, { manager, reason }) => {
    const { tables, showToast } = get();
    const table  = tables.find(t => t.id === tableId);
    const session = table?.session;
    if (!session) return;

    // v4.6.11: restore daily count for every non-voided item before we void the check.
    (session.items || []).forEach(i => {
      if (i.itemId && !i.voided) {
        get().decrementDailyCount(i.itemId, -(i.qty || 1));
        // v5.5.189: restore modifier sub-item counts too
        (i.mods || []).forEach(mod => {
          if (mod.itemId) get().decrementDailyCount(mod.itemId, -((mod.qty || 1) * (i.qty || 1)));
        });
      }
    });

    const totalValue = session.items.reduce((s,i) => s+i.price*i.qty, 0);
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const items = t.session.items.map(i => ({ ...i, status:'voided', voided:true }));
        return { ...t, status:'available', session:null };
      }),
      voidLog: [{
        id:`void-${Date.now()}`, timestamp:Date.now(), type:'check',
        tableId, tableLabel:table.label,
        items: session.items.map(i => ({ name:i.name, price:i.price, qty:i.qty })),
        totalValue, reason, manager:manager.name, managerId:manager.id,
      }, ...s.voidLog],
      activeTableId: s.activeTableId === tableId ? null : s.activeTableId,
    }));
    showToast(`Check voided by ${manager.name} — ${reason}`, 'error');
  },

  // ── Discounts ──────────────────────────────
  // Check-level discounts stored on the session
  addCheckDiscount: (tableId, discount) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const discounts = [...(t.session.discounts||[]), discount];
        return { ...t, session:{ ...t.session, discounts } };
      }),
    }));
  },

  removeCheckDiscount: (tableId, discountId) => {
    set(s => ({
      tables: s.tables.map(t => {
        if (t.id !== tableId || !t.session) return t;
        const discounts = (t.session.discounts||[]).filter(d => d.id !== discountId);
        return { ...t, session:{ ...t.session, discounts } };
      }),
    }));
  },

  addWalkInDiscount: (discount) => set(s => ({
    walkInOrder: { ...s.walkInOrder, discounts:[...(s.walkInOrder?.discounts||[]), discount] },
  })),

  removeWalkInDiscount: (discountId) => set(s => ({
    walkInOrder: { ...s.walkInOrder, discounts:(s.walkInOrder?.discounts||[]).filter(d=>d.id!==discountId) },
  })),

  // Item-level discount
  addItemDiscount: (tableId, itemUid, discount) => {
    if (tableId) {
      set(s => ({ tables:s.tables.map(t => {
        if (t.id!==tableId||!t.session) return t;
        const items = t.session.items.map(i => i.uid===itemUid ? {...i, discount} : i);
        const subtotal = items.filter(i=>!i.voided).reduce((s,i)=>s+(i.discount?i.price*(1-i.discount.value/100)*i.qty:i.price*i.qty),0);
        return {...t, session:{...t.session, items, subtotal, total:subtotal*1.125}};
      })}));
    } else {
      set(s => ({ walkInOrder:{ ...s.walkInOrder, items:(s.walkInOrder?.items||[]).map(i=>i.uid===itemUid?{...i,discount}:i) } }));
    }
  },

  removeItemDiscount: (tableId, itemUid) => {
    if (tableId) {
      set(s => ({ tables:s.tables.map(t => {
        if(t.id!==tableId||!t.session) return t;
        const items=t.session.items.map(i=>i.uid===itemUid?{...i,discount:null}:i);
        return {...t,session:{...t.session,items}};
      })}));
    } else {
      set(s=>({walkInOrder:{...s.walkInOrder,items:(s.walkInOrder?.items||[]).map(i=>i.uid===itemUid?{...i,discount:null}:i)}}));
    }
  },

  // ── KDS ───────────────────────────────────
  kdsTickets: isMock ? INITIAL_KDS : [],
  bumpTicket: id => {
    set(s => ({ kdsTickets: s.kdsTickets.filter(t => t.id !== id) }));
    import('../lib/db.js').then(({ bumpKDSTicket }) => bumpKDSTicket(id));
  },

  // ── Print job routing ─────────────────────────────────────────────────────
  // Dispatches a kitchen/bar/pass ticket to the printer assigned to the centre.
  // Retries 3x with exponential backoff on transient failures.
  // When fully offline (navigator.onLine === false AND no native bridge), the
  // job is persisted to Supabase print_jobs as 'pending' via _submitJob → the
  // existing OfflineQueue + Node agent pick it up when connectivity returns.
  printJobs: [],
  routePrintJob: async (job) => {
    // TRAINING MODE: no real kitchen tickets / fire markers / transfer dockets — and
    // no print_jobs row. Suppresses physical prints so the kitchen isn't confused.
    if (isTrainingMode()) return;
    // job shape: { centreId, printerName, tableLabel, items, type, server, covers, course }
    //
    // v4.3.0 — DURABLE-FIRST dispatch.
    // printService._submitJob inserts a print_jobs row before attempting any
    // dispatch. That row is the durable source of truth. This function just
    // does ONE immediate attempt; the master-side PrintRetrier handles retries.
    const jobId = `pj-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const basePrintJob = { ...job, id: jobId, sentAt: Date.now() };

    // Look up the printer configured for this centre
    const routingConfig = (() => {
      try {
        const stored = useStore.getState().printRouting;
        if (stored?.centres?.length) return stored;
        return JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres: [], routing: {} };
      } catch { return { centres: [], routing: {} }; }
    })();

    const centre = routingConfig.centres?.find(c => c.id === job.centreId);
    const printerId = centre?.printer?.id || null;

    // No printer mapped → still creates KDS ticket, warns staff
    if (!printerId) {
      set(s => ({ printJobs: [{ ...basePrintJob, status: 'no-printer' }, ...s.printJobs.slice(0, 49)] }));
      get().showToast(`No printer mapped for ${centre?.name || job.centreId} — ticket shown on KDS only`, 'warn');
      return;
    }

    // v4.6.8: Fire-marker jobs take a dedicated idempotency key and a different
    // ticket builder — otherwise treated identically by the rest of this function
    // (status tracking, retries, health updates, error handling all reuse the same path).
    const isFireMarker = job.type === 'fire-marker';
    // v4.6.28: transfer-notice — kitchen alert fired when a table moves/combines.
    const isTransferNotice = job.type === 'transfer-notice';
    const idempotencyKey = isFireMarker
      ? `fire-${job.tableLabel || 'walkin'}-${job.centreId}-${job.course || 0}-${basePrintJob.sentAt}`
      : isTransferNotice
        ? `transfer-${job.fromTable || '?'}-${job.tableLabel || '?'}-${job.centreId}-${basePrintJob.sentAt}`
        : `kitchen-${job.tableLabel || 'walkin'}-${job.centreId}-${job.course || 0}-${basePrintJob.sentAt}`;

    // Local UI job marker — reflects Supabase-side state via realtime subs
    set(s => ({ printJobs: [{ ...basePrintJob, status: 'sending', printerId, attempts: 0 }, ...s.printJobs.slice(0, 49)] }));

    try {
      // v4.6.7: strip allergen mod lines from printed docket unless the centre
      // has opted in via printAllergens=true. KDS still shows the full mods list
      // (see createKdsTickets) so kitchen staff retain the safety info on-screen.
      // Allergen lines are stamped with a leading '⚠' in createKdsTickets; filter on that.
      const printItems = centre?.printAllergens
        ? (job.items || [])
        : (job.items || []).map(it => ({
            ...it,
            mods: Array.isArray(it.mods) ? it.mods.filter(m => {
              const text = typeof m === 'string' ? m : (m?.label || '');
              return !text.startsWith('⚠');
            }) : it.mods,
          }));

      // Coffee-shop "sticker" mode: when this centre is set to split each item onto its own
      // ticket, dispatch one kitchen ticket per item UNIT (qty-expanded), each labelled
      // "ITEM X OF Y" with a unique idempotency key. Skips the single combined ticket below.
      if (!isFireMarker && !isTransferNotice && centre?.splitPerItem) {
        const units = [];
        printItems.forEach(it => { const q = Math.max(1, Math.round(it.qty || 1)); for (let n = 0; n < q; n++) units.push({ ...it, qty: 1 }); });
        const total = units.length || 1;
        let allOk = true; let lastJobId = null;
        for (let i = 0; i < units.length; i++) {
          const r = await printService.printKitchenTicket({
            table: job.tableLabel || '', server: job.server || '', covers: job.covers || 0,
            course: job.course || null, centreName: centre?.name || job.printerName || 'Kitchen',
            items: [units[i]], sentAt: basePrintJob.sentAt, delivery: job.delivery || null,
            itemLabel: `ITEM ${i + 1} OF ${total}`,
          }, printerId, { idempotencyKey: `${idempotencyKey}-i${i}` });
          if (!r?.ok) allOk = false; else lastJobId = r.jobId;
        }
        set(s => ({ printJobs: s.printJobs.map(pj => pj.id === jobId ? { ...pj, status: allOk ? 'printed' : 'retry-pending', supabaseJobId: lastJobId, splitCount: total } : pj) }));
        if (allOk) printService.recordPrinterHealth(printerId, 'online');
        return;
      }

      const result = isFireMarker
        ? await printService.printFireCourseTicket({
            table: job.tableLabel || '',
            courseNum: job.course,
            centreName: centre?.name || job.printerName || 'Kitchen',
            sentAt: basePrintJob.sentAt,
          }, printerId, { idempotencyKey })
        : isTransferNotice
        ? await printService.printTransferNoticeTicket({
            fromTable: job.fromTable || '',
            toTable:   job.tableLabel || '',
            centreName: centre?.name || job.printerName || 'Kitchen',
            items: printItems,
            server: job.server,
            sentAt: basePrintJob.sentAt,
          }, printerId, { idempotencyKey })
        : await printService.printKitchenTicket({
            table: job.tableLabel || '',
            server: job.server || '',
            covers: job.covers || 0,
            course: job.course || null,
            centreName: centre?.name || job.printerName || 'Kitchen',
            items: printItems,
            sentAt: basePrintJob.sentAt,
            delivery: job.delivery || null,   // HubRise/delivery context block (null for all other tickets)
          }, printerId, { idempotencyKey });

      // Any outcome here is "first attempt done". PrintRetrier handles persistent retries.
      if (result?.ok) {
        set(s => ({
          printJobs: s.printJobs.map(pj =>
            pj.id === jobId ? { ...pj, status: result.transport === 'queued' ? 'queued' : 'printed', transport: result.transport, supabaseJobId: result.jobId } : pj
          ),
        }));
        if (result.transport !== 'queued') printService.recordPrinterHealth(printerId, 'online');
      } else {
        // Native bridge failed — durable row is in place, PrintRetrier will pick it up.
        // Update local UI to show pending retry instead of hard failure.
        set(s => ({
          printJobs: s.printJobs.map(pj =>
            pj.id === jobId ? { ...pj, status: 'retry-pending', error: result.error, supabaseJobId: result.jobId, attempts: 1 } : pj
          ),
        }));
        // Don't toast yet — retrier may still succeed. Only toast on permanent failure (handled elsewhere).
      }
    } catch (err) {
      // Shouldn't normally happen — _submitJob catches its own errors
      set(s => ({
        printJobs: s.printJobs.map(pj =>
          pj.id === jobId ? { ...pj, status: 'failed', error: err.message } : pj
        ),
      }));
      printService.recordPrinterHealth(printerId, 'offline', err.message);
      get().showToast(`Print failed: ${err.message}. Check the status drawer.`, 'error');
    }
  },

  // v5.5.57: route kiosk-originated orders through production centres.
  // Buckets items by centre using the same routing config the POS uses,
  // creates per-centre kds_tickets, and calls routePrintJob per centre.
  // Idempotent via a conditional UPDATE on kitchen_routed_at — only the
  // first claimer (typically master POS) does the work.
  routeKioskOrderPrints: async (order) => {
    if (!order?.ref || !Array.isArray(order.items) || !order.items.length) return;
    if (!supabase) return;
    // v5.5.131: surface routing diagnostics as on-screen toasts on the master
    // device — DevTools isn't accessible on Sunmi/Android-APK installs.
    const showToast = useStore.getState().showToast;
    // NB: named srcUpper, NOT srcLabel. A second `const srcLabel` is declared later INSIDE the
    // try block (SRC_LABEL[...]); reusing the name here put the "Routing …" toast below in that
    // inner const's temporal dead zone → a silent ReferenceError AFTER the kitchen_routed_at
    // claim but BEFORE the KDS/print writes, so channel orders claimed-but-never-printed (v5.5.861
    // regression, fixed v5.5.867). Keep these two names distinct.
    const srcUpper = order.source ? order.source.toUpperCase() : 'ORDER';
    // v5.5.861: console entry log stays here, but the on-screen "Routing …" toast moved
    // BELOW the dedup/staleness/claim guards — it used to fire on every backfill pass
    // (every Back Office refresh re-toasted the same held/already-printed order, reading
    // as a repeated new-order notification).
    console.log('[routeKioskOrderPrints] ENTRY', order.ref, 'source:', order.source,
      'items:', order.items.map(i => ({
        id: i.id || i.itemId, name: i.name, cat: i.cat, cats: i.cats,
        parentId: i.parentId || i.parent_id,
      })));
    try {
      // v5.5.126: scheduled-order deferral. order_queue.sent_at is the
      // kitchen-fire moment (collection_time − online_collection_lead_min).
      // For ASAP orders sent_at ≈ now and we route immediately. For a
      // scheduled order whose sent_at is in the future we set a timer to
      // re-call ourselves at that moment. We DON'T claim the row yet —
      // claiming gates against duplicate routing once the timer fires;
      // claiming early would block other devices from picking it up if
      // this device disconnects before the timer pops.
      const sentAtMs = order.sentAt || Date.now();
      const waitMs = sentAtMs - Date.now();
      if (waitMs > 60_000) {
        // Cap at 24h so a scheduled-for-tomorrow order doesn't keep a
        // setTimeout pinned forever. Master-boot backfill picks it up
        // closer to the time. setTimeout's max safe delay is ~24.8 days.
        const cappedWait = Math.min(waitMs, 24 * 60 * 60_000);
        console.log('[routeKioskOrderPrints] deferring', order.ref,
          'until', new Date(sentAtMs).toISOString(),
          `(in ${Math.round(cappedWait/60000)} min)`);
        setTimeout(() => useStore.getState().routeKioskOrderPrints?.(order), cappedWait);
        return;
      }
      // STALENESS BACKSTOP — universal guard for every routing path (catering release, master
      // backfill, late realtime event). A device offline for a long time can find a backlog of
      // overdue orders; never auto-dump them into the live kitchen. If the fire moment passed more
      // than STALE_ORDER_FLOOR_MS ago, skip routing WITHOUT claiming the row — it keeps
      // kitchen_routed_at NULL and stays in the Orders Hub for staff to release manually. Nothing
      // is lost. (order.sentAt defaults to now() for ASAP rows with no sent_at, so they're never
      // mistaken for stale.)
      if (!order.manualRelease && Date.now() - sentAtMs > STALE_ORDER_FLOOR_MS) {
        console.warn('[routeKioskOrderPrints] HELD stale order', order.ref, 'fire moment',
          new Date(sentAtMs).toISOString(), `(${Math.round((Date.now() - sentAtMs) / 60000)} min ago)`);
        const lastToast = useStore._staleHeldToastAt || 0;
        if (Date.now() - lastToast > 60_000) {
          useStore._staleHeldToastAt = Date.now();
          showToast?.('Some overdue orders were held — release them manually in Orders', 'info', 6000);
        }
        return;
      }
      // v5.5.138/143: atomic claim with graceful fallback when the
      // kitchen_routed_at column is missing on the venue's DB (migration
      // v5.5.57 not applied). When the column exists, IS NULL → NOW gives
      // us cross-device dedup. When missing, in-memory _routedRefs Set
      // gives best-effort same-device dedup so the same realtime event
      // doesn't produce duplicate KDS tickets if it fires twice locally.
      const COL_MISSING = (err) => err?.message?.includes('kitchen_routed_at')
        && err?.message?.includes('schema cache');
      // v5.5.860: DURABLE per-device dedup. The in-memory _routedRefs fallback dies on
      // every page refresh — live repro tonight: a claim error on one device left
      // kitchen_routed_at NULL, so EVERY Back-Office refresh re-ran the master backfill
      // and printed the same channel order again. This device never re-prints a ref it
      // already dispatched, claim or no claim (localStorage, bounded, offline-cache
      // category — cross-device dedup is still the DB claim).
      const ROUTED_LS = 'rpos-routed-refs';
      const routedBefore = (ref) => { try { return JSON.parse(localStorage.getItem(ROUTED_LS) || '[]').includes(ref); } catch { return false; } };
      const markRouted = (ref) => { try { const a = JSON.parse(localStorage.getItem(ROUTED_LS) || '[]'); if (!a.includes(ref)) { a.push(ref); while (a.length > 300) a.shift(); localStorage.setItem(ROUTED_LS, JSON.stringify(a)); } } catch {} };
      if (!order.force && routedBefore(order.ref)) {
        console.log('[routeKioskOrderPrints] already printed on this device — skipping', order.ref);
        return;
      }
      // v5.5.279: CRITICAL — add location_id guard. `ref` is a short sequential
      // number (#1042) that WILL collide across locations; without this guard,
      // routing at Location A could claim Location B's order_queue row.
      const locId = getActiveLocationSync() || await getLocationId();
      const r = await supabase
        .from('order_queue')
        .update({ kitchen_routed_at: new Date().toISOString() })
        .eq('ref', order.ref)
        .eq('location_id', locId)
        .is('kitchen_routed_at', null)
        .select('ref');
      if (r.error && COL_MISSING(r.error)) {
        console.warn('[routeKioskOrderPrints] kitchen_routed_at column missing — proceeding without idempotency claim. Run: alter table order_queue add column kitchen_routed_at timestamptz;');
        // v5.5.159: surface a loud, visible toast — silent console warnings
        // were missed for weeks while every venue with N master devices
        // got N duplicate kitchen tickets per round. The ONE-LINE SQL fix
        // is right there in the toast.
        try {
          if (!useStore._colWarningShown) {
            useStore._colWarningShown = true;
            useStore.getState().showToast?.(
              '⚠ Duplicate prints risk: order_queue.kitchen_routed_at column missing. Run: alter table order_queue add column if not exists kitchen_routed_at timestamptz; (one-time, on Supabase SQL editor)',
              'error', 15000
            );
          }
        } catch {}
        if (!useStore._routedRefs) useStore._routedRefs = new Set();
        if (useStore._routedRefs.has(order.ref)) return;
        useStore._routedRefs.add(order.ref);
        markRouted(order.ref);   // v5.5.860: survives refresh — the in-memory set doesn't
      } else {
        if (r.error) { console.warn('[routeKioskOrderPrints] claim failed', r.error); return; }
        if (!r.data?.length) return; // Another device already routed
        markRouted(order.ref);   // v5.5.860: claim won — remember locally too, so a later claim-reset can never re-print here
      }
      // v5.5.861: we are now COMMITTED to printing this order on this device — this is
      // the only point the operator-facing toast belongs (skipped/held/claimed-elsewhere
      // passes above stay silent instead of re-notifying on every boot).
      showToast?.(`Routing ${srcUpper} ${order.ref}…`, 'info');

      // Routing config + cat parent map (mirror getCentresForItem from sendToKitchen).
      // v5.5.868: load the routing config FRESH from the DB. The device that routes a channel
      // order is the MASTER, which is not necessarily a POS till that has printRouting loaded in
      // memory — and even a loaded copy can be STALE (config edited after that device booted, as
      // happened here: routing saved at 19:04:08, order at 19:04:11, master never reloaded). A
      // stale/empty copy matches no centre → nothing prints. The print_routing table is the source
      // of truth; fall back to the in-memory / localStorage copy only if the fetch fails.
      let routingConfig = null;
      try {
        const { data: prCfg } = await supabase
          .from('print_routing').select('centres, routing').eq('location_id', locId).maybeSingle();
        if (prCfg?.centres?.length) routingConfig = { centres: prCfg.centres, routing: prCfg.routing || {} };
      } catch (e) { console.warn('[routeKioskOrderPrints] print_routing DB fetch failed:', e?.message || e); }
      if (!routingConfig?.centres?.length) {
        routingConfig = useStore.getState().printRouting;
        if (!routingConfig?.centres?.length) {
          try { routingConfig = JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; }
          catch { routingConfig = { centres:[], routing:{} }; }
        }
      }
      let parentMap = {};
      try {
        const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
        const cats = snap.menuCategories || useStore.getState().menuCategories || [];
        cats.forEach(c => { parentMap[c.id] = c.parentId || null; });
      } catch {}
      const allMenuItems = useStore.getState().menuItems || [];
      const catOrAncestorMatches = (catId, set, depth = 0) => {
        if (!catId || depth > 5) return false;
        if (set.has(catId)) return true;
        const p = parentMap[catId];
        return p ? catOrAncestorMatches(p, set, depth + 1) : false;
      };
      const centresForItem = (item) => {
        const { centres, routing } = routingConfig;
        if (!centres?.length || !routing) return [];
        const menuItem = allMenuItems.find(i => i.id === (item.itemId || item.id));
        const itemCat = item.cat || item.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;
        const parentId = item.parentId || menuItem?.parentId || null;
        const parentMenuItem = parentId ? allMenuItems.find(i => i.id === parentId) : null;
        const parentCat = parentMenuItem?.cat || parentMenuItem?.cats?.[0] || null;
        const matched = [];
        centres.forEach(centre => {
          const r = routing[centre.id];
          if (!r?.assignedCategories?.length) return;
          if (r.excludedItems?.includes(item.id) || r.excludedItems?.includes(item.itemId)) return;
          const set = new Set(r.assignedCategories);
          if ((itemCat && catOrAncestorMatches(itemCat, set)) || (parentCat && catOrAncestorMatches(parentCat, set))) {
            matched.push(centre.id);
          }
        });
        return matched;
      };

      // Bucket items by centre
      const byCentre = {};
      order.items.forEach(item => {
        centresForItem(item).forEach(cid => {
          if (!byCentre[cid]) byCentre[cid] = [];
          byCentre[cid].push(item);
        });
      });

      // v5.5.850 (supersedes v5.5.555's whole-order-only fallback): PER-ITEM fallback — any
      // item that matched no centre (e.g. a HubRise sku_ref that isn't in our catalog) still
      // prints at a default centre (first with a printer, else first centre) instead of
      // silently dropping off a MIXED order's tickets (HubRise rule: handle unknown items
      // gracefully). Identity check is safe — same object refs from order.items.
      const unrouted = order.items.filter(it => !Object.values(byCentre).some(arr => arr.includes(it)));
      if (unrouted.length && routingConfig.centres?.length) {
        const fb = routingConfig.centres.find(c => c.printer?.id) || routingConfig.centres[0];
        if (fb) byCentre[fb.id] = [...(byCentre[fb.id] || []), ...unrouted];
      }

      // v5.5.126: source-correct labels so the kitchen ticket / KDS card says
      // "Online OL-XXX" or "QR T5" instead of always "Kiosk". Falls back to
      // the previous "Kiosk" wording when source is unknown.
      const SRC_LABEL = { kiosk: 'Kiosk', online: 'Online', qr: 'QR', hubrise: 'HubRise', catering: 'Catering' };
      const srcLabel = SRC_LABEL[order.source] || 'Kiosk';
      const tableLabel = order.source === 'qr' && order.tableLabel
        ? `Table ${order.tableLabel}`
        : `${srcLabel} ${order.ref}`;
      const serverName = order.customer?.name || `${srcLabel} ${order.ref}`;

      // v5.5.850: operator signal for unknown channel refs — the item still prints (per-item
      // fallback above) but the master till is told the published catalog is out of sync.
      if (order.source === 'hubrise') {
        const unknown = order.items.filter(i => !allMenuItems.find(m => m.id === (i.itemId || i.id)));
        if (unknown.length) {
          showToast?.(`⚠ ${srcLabel} ${order.ref}: ${unknown.length} item(s) not in our menu (${unknown.map(i => i.name).join(', ')}) — sent to default centre. Re-push the HubRise catalog.`, 'warning');
        }
      }
      const sentAt = order.sentAt || Date.now();

      // Delivery / collection context printed on each centre's kitchen ticket.
      // v5.5.657: build this for ALL delivery/collection orders (online, kiosk, QR,
      // catering, HubRise) — previously only HubRise, so online/catering delivery
      // tickets printed with no customer, address, or fee. Address is passed as the
      // {line1,postcode,...} object the kitchen-ticket builder expects.
      const _svcType = order.customer?.serviceType || order.type;
      const _isDeliveryish = _svcType === 'delivery' || _svcType === 'collection' || order.source === 'hubrise';
      const deliveryBlock = _isDeliveryish ? {
        channel: order.customer?.channel || (order.source && order.source !== 'hubrise' ? srcLabel : null),
        serviceType: _svcType,
        paid: order.customer?.paid != null ? order.customer.paid : (order.source !== 'hubrise'),  // online/kiosk/catering are pre-paid
        // v5.5.850: partial channel payments — printed as PART-PAID £x / COLLECT £y (printer.js)
        paidAmount: order.customer?.paidAmount ?? null,
        due: order.customer?.due ?? null,
        collectionCode: order.customer?.collectionCode || null,
        name: order.customer?.name,
        phone: order.customer?.phone,
        address: order.customer?.address,
        notes: order.customer?.notes,
        deliveryFee: order.customer?.delivery_fee != null ? Number(order.customer.delivery_fee) : null,
        // v5.5.847: channel charges (delivery/bag/service fees) + order-level discounts,
        // decoded off the HubRise order — printed on the ticket so the packer sees the
        // same breakdown the customer saw. Absent for non-channel orders.
        charges:   Array.isArray(order.customer?.charges)   && order.customer.charges.length   ? order.customer.charges   : null,
        discounts: Array.isArray(order.customer?.discounts) && order.customer.discounts.length ? order.customer.discounts : null,
        expected: order.isASAP ? 'ASAP' : (() => {
          const ct = order.collectionTime; if (!ct) return null;
          const d = new Date(ct);
          return isNaN(d.getTime()) ? String(ct) : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        })(),
      } : null;

      // Per-centre KDS tickets. v5.5.132: status MUST be 'pending' — that's
      // what the KDS surface filters on (OtherSurfaces.jsx:420 — `status
      // IN (pending, held)`). We were writing 'fired' and KDS never showed
      // anything. Bumped via the existing bumpKDSTicket() flow → 'bumped'.
      // Same shape insertKDSTicket builds for the dine-in / walk-in path.
      const ticketLocationId = useStore.getState().locationConfig?.id
        || getActiveLocationSync()
        || (await getLocationId().catch(() => null));
      const tickets = Object.entries(byCentre).map(([centreId, items]) => ({
        id: `kds-${sentAt}-${centreId}-${Math.random().toString(36).slice(2,6)}`,
        location_id: ticketLocationId,
        centre_id: centreId,
        course: 1,
        all_courses: [1],
        fired_courses: [1],
        items: items.map(i => ({
          qty: i.qty,
          name: i.kitchenName || i.name,
          mods: Array.isArray(i.mods) ? i.mods.map(m => m?.name || m?.label || m).filter(Boolean) : [],
          course: 1, fired: true, status: 'sent', centreId,
        })),
        status: 'pending',                                                   // ← was 'fired'
        sent_at: new Date(sentAt).toISOString(),
        table_id: null,
        table_label: tableLabel,
        server: serverName,
        covers: 1,
      }));
      if (tickets.length) {
        const { error: kdsErr } = await supabase.from('kds_tickets').insert(tickets);
        // v5.5.971: a rejected ticket insert means the kitchen never sees the order.
        reportSave('kitchen ticket', kdsErr);
        if (kdsErr) {
          console.warn('[routeKioskOrderPrints] kds insert', kdsErr);
          useStore.getState().showToast?.(`${order.ref} did NOT reach the kitchen screen — ${kdsErr.message}`, 'error');
        }
      }
      // v5.5.128: log routing outcome so silent failures (no centres / no
      // matching cats / printer not mapped) surface clearly in DevTools.
      console.log('[routeKioskOrderPrints]', order.ref, 'centres matched:', Object.keys(byCentre).length, 'items routed:', Object.values(byCentre).flat().length);

      // Print jobs per centre
      const getCentrePrinter = (centreId) => {
        const c = routingConfig.centres?.find(c => c.id === centreId);
        return c?.printer?.name || c?.name || 'Kitchen';
      };
      Object.entries(byCentre).forEach(([centreId, items]) => {
        if (!items.length) return;
        // v5.5.129: log per-centre so we can see exactly where the path
        // breaks down — centre matched but no printer? Centre matched and
        // printer mapped? Surfaces the root cause when "didn't print".
        const centre = routingConfig.centres?.find(c => c.id === centreId);
        const printerId = centre?.printer?.id || null;
        console.log('[routeKioskOrderPrints]', order.ref, 'centre:', centre?.name || centreId,
          'printer:', printerId ? `${centre.printer.name} (${printerId})` : 'NONE — KDS only, no paper',
          'items:', items.length);
        get().routePrintJob({
          centreId,
          printerName: getCentrePrinter(centreId),
          tableLabel,
          server: serverName,
          covers: 1,
          course: 1,
          items: items.map(i => ({
            qty: i.qty,
            kitchenName: i.kitchenName,
            name: i.name,
            mods: i.mods,
          })),
          type: 'kitchen',
          delivery: deliveryBlock,
        });
      });

      console.log('[routeKioskOrderPrints] routed', order.ref, 'to', Object.keys(byCentre).length, 'centres');
      // v5.5.129: when zero centres matched, log WHY so the operator can
      // see what's mis-configured (no centres at all? no cats on items?
      // routing config not loaded yet?). One of these is almost always
      // the cause when "didn't print".
      if (Object.keys(byCentre).length === 0) {
        const dump = {
          centres: routingConfig.centres?.length || 0,
          routingKeys: Object.keys(routingConfig.routing || {}).length,
          allCats: order.items?.map(i => i.cat || i.cats?.[0] || null),
        };
        console.warn('[routeKioskOrderPrints] NOTHING ROUTED for', order.ref, '— diagnostic dump:', dump);
        // v5.5.131: on-screen diagnostic toast for Sunmi (no DevTools).
        // Tells the operator EXACTLY which side is broken.
        let reason;
        if (!dump.centres) reason = 'no production centres configured';
        else if (!dump.routingKeys) reason = 'centres exist but no category routing rules';
        else if (dump.allCats?.every(c => !c)) reason = 'order items have no `cat` field — try refreshing customer browser';
        else reason = `item cats (${dump.allCats?.join(', ')}) don\'t match any centre`;
        showToast?.(`⚠ ${srcLabel} ${order.ref} did not print: ${reason}`, 'error');
      } else {
        const centreNames = Object.keys(byCentre).map(cid =>
          routingConfig.centres?.find(c => c.id === cid)?.name || cid
        );
        // Also report which (if any) centres lack a printer mapping.
        const noPrinter = centreNames.filter((_, idx) => {
          const cid = Object.keys(byCentre)[idx];
          const c = routingConfig.centres?.find(c => c.id === cid);
          return !c?.printer?.id;
        });
        if (noPrinter.length) {
          showToast?.(`⚠ ${srcLabel} ${order.ref} routed to ${centreNames.join(', ')} — but ${noPrinter.join(', ')} has no printer mapped (KDS only)`, 'warning');
        } else {
          showToast?.(`✓ ${srcLabel} ${order.ref} routed → ${centreNames.join(', ')}`, 'success');
        }
      }

      // v5.5.128: AFTER prints have fired (or we tried — the print path is
      // durable so the row was at minimum queued), flip status from
      // 'received' → 'prep' so the customer's tracker and the operator's
      // queue both reflect "kitchen has it". Conditional on the row still
      // being 'received' so we never clobber an operator who's already
      // advanced it. Skipped entirely if zero centres matched — in that
      // case nothing was routed, the order genuinely is still just queued.
      if (Object.keys(byCentre).length > 0) {
        try {
          // v5.5.279: location_id guard — refs collide across locations
          await supabase.from('order_queue')
            .update({ status: 'prep' })
            .eq('ref', order.ref)
            .eq('location_id', locId)
            .eq('status', 'received');
        } catch (e) {
          console.warn('[routeKioskOrderPrints] status→prep update failed:', e?.message);
        }
      }
    } catch (e) {
      console.warn('[routeKioskOrderPrints] failed:', e?.message);
    }
  },

  // Print a customer/dispatch receipt for a HubRise delivery order — order number +
  // channel + customer/address details + itemised totals + PAID. Triggered on Accept
  // (or auto-accept) when the venue's "auto-print receipt" setting is on.
  // opts.manual = a person asked for this print; the age gate below is skipped.
  printHubriseReceipt: async (order, opts = {}) => {
    try {
      if (!order) return;
      // Automatic path only. A stale order reaching this function means a screen was
      // opened/re-read, not that a customer is waiting at the counter.
      if (!opts.manual && tooOldToAutoPrint(order, 'hubrise')) return;
      const c = order.customer || {};
      const items = (order.items || []).map(i => ({ ...i, voided: false }));
      const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 1) * ((Number(it.price) || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)), 0);
      const total = Number(order.total) || 0;
      const a = c.address || {};
      const addr = [a.line1, a.line2, [a.city, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean);
      const check = {
        ref: c.collectionCode || order.ref,
        server: c.channel || 'HubRise',
        orderType: c.serviceType === 'delivery' ? 'Delivery' : c.serviceType === 'collection' ? 'Collection' : 'Order',
        method: c.paid ? 'card' : null,
        delivery: {
          channel: c.channel, serviceType: c.serviceType, paid: !!c.paid,
          paidAmount: c.paidAmount ?? null, due: c.due ?? null,   // v5.5.850 partial payments
          name: c.name, phone: c.phone, address: addr, notes: c.notes,
          expected: order.isASAP ? 'ASAP' : (order.collectionTime ? new Date(order.collectionTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null),
        },
      };
      const totals = { subtotal, service: Math.max(0, +(total - subtotal).toFixed(2)), tip: 0, grand: total };
      // v5.5.867: print on the device handling this order — its own receipt printer — falling
      // back to the venue default if it has none (was venue-default-only). If nothing is set
      // anywhere it prints nothing and warns rather than guessing.
      const result = await printService.printReceipt({ check, items, totals }, null);
      if (!result?.ok) get().showToast?.(`Receipt not printed: ${result?.error || 'no receipt printer set'}`, 'error');
    } catch (e) { console.warn('[hubrise] receipt print failed:', e?.message); }
  },

  // v5.5.670: on-request customer-receipt reprint for ANY queue order (online / kiosk / QR /
  // catering / HubRise / walk-in). Same builder as printHubriseReceipt but source-neutral and
  // training-gated. Used by the Orders Hub "Print receipt" button so staff can print on demand
  // even when the order profile is set to not auto-print.
  reprintOrderReceipt: async (order) => {
    if (isTrainingMode()) { get().showToast?.('Training mode — receipt not printed.', 'info'); return { ok: true, transport: 'training' }; }
    try {
      if (!order) return { ok: false, error: 'no order' };
      const c = order.customer || {};
      const items = (order.items || []).map(i => ({ ...i, voided: false }));
      const subtotal = items.reduce((s, it) => s + (Number(it.qty) || 1) * ((Number(it.price) || 0) + (it.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)), 0);
      const total = Number(order.total) || subtotal;
      const a = c.address || {};
      const addr = typeof a === 'string' ? [a] : [a.line1, a.line2, [a.city, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean);
      const SRC = { online: 'Online', kiosk: 'Kiosk', qr: 'QR', catering: 'Catering', hubrise: c.channel || 'HubRise' };
      const svcType = c.serviceType || order.type;
      const deliveryFee = c.delivery_fee != null ? Number(c.delivery_fee) : 0;
      const tip = Number(c.tip) || 0;
      const check = {
        ref: c.collectionCode || order.ref,
        server: c.channel || SRC[order.source] || 'Order',
        orderType: svcType === 'delivery' ? 'Delivery' : svcType === 'collection' ? 'Collection' : 'Order',
        method: (c.paid || order.paid) ? (order.paymentMethod || 'card') : null,
        deliveryFee: deliveryFee || 0,   // so the receipt builder prints a Delivery line (printer.js)
        delivery: (svcType === 'delivery' || svcType === 'collection' || c.delivery_fee != null) ? {
          channel: c.channel || SRC[order.source] || null, serviceType: svcType, paid: !!(c.paid || order.paid),
          paidAmount: c.paidAmount ?? null, due: c.due ?? null,   // v5.5.850 partial payments
          name: c.name, phone: c.phone, address: addr, notes: c.notes, deliveryFee: deliveryFee || 0,
          expected: order.isASAP ? 'ASAP' : (order.collectionTime ? new Date(order.collectionTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null),
        } : null,
      };
      // service = whatever's left after subtotal + delivery + tip (keeps a catering tip out of the
      // service line). Pennies-safe + never negative.
      const totals = { subtotal, service: Math.max(0, +((total - subtotal - deliveryFee - tip).toFixed(2))), delivery: deliveryFee || 0, tip, grand: total };
      // v5.5.867: print to THIS till's own receipt printer — the device the operator pressed
      // "Print receipt" on — falling back to the venue default only if this till has none. No
      // separate venue-default is required: a till connected to a printer just prints.
      const result = await printService.printReceipt({ check, items, totals }, null);
      get().showToast?.(result?.ok ? 'Receipt sent to printer' : `Receipt print failed${result?.error ? ': ' + result.error : ''}`, result?.ok ? 'success' : 'error');
      return result || { ok: false };
    } catch (e) {
      get().showToast?.(`Receipt print failed: ${e?.message || e}`, 'error');
      return { ok: false, error: String(e?.message || e) };
    }
  },

  // Print a customer receipt (called from close-check flow, ReceiptModal, etc.)
  // Safe to call even if no receipt printer is configured — falls back to browser print.
  printCustomerReceipt: async ({ location, check, items, totals }, printerId = null) => {
    // TRAINING MODE: don't print a physical customer receipt.
    if (isTrainingMode()) return { ok: true, transport: 'training' };
    try {
      const result = await printService.printReceipt({ location, check, items, totals }, printerId);
      if (result?.ok && result.transport !== 'browser' && printerId) {
        printService.recordPrinterHealth(printerId, 'online');
      }
      return result;
    } catch (err) {
      get().showToast(`Receipt print failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  },

  // v4.6.34: legacy openCashDrawer removed — it was overriding the permission-
  // gated + petty-cash-logging version defined earlier in the object. Two
  // actions with the same key collapse to the last declared one in JS object
  // literals, which is what caused 'No printer with cash drawer configured'
  // even when the flag was correctly set.

  // Manually reprint a failed or pending print_jobs row (called from StatusDrawer)
  // Uses the job's stored payload rather than rebuilding — exact reprint.
  reprintJob: async (supabaseRow) => {
    try {
      if (!supabase) throw new Error('No Supabase connection');
      // Reset the job to pending so the agent / native path picks it up again
      // v5.5.279: location_id guard on print job reprint
      const locId = getActiveLocationSync() || await getLocationId();
      const { error } = await supabase
        .from('print_jobs')
        .update({ status: 'pending', error: null, attempts: 0 })
        .eq('id', supabaseRow.id)
        .eq('location_id', locId);
      if (error) throw error;
      get().showToast('Job requeued for printing', 'info');
      return { ok: true };
    } catch (err) {
      get().showToast(`Reprint failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  },

  // ── Shift ─────────────────────────────────
  // Shift stats — computed live from closed checks
  get shift() {
    const allChecks = useStore.getState().closedChecks;
    const config    = useStore.getState().locationConfig;
    const seed = SHIFT;

    // Use business day start from location config, fallback to midnight
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const checks = allChecks.filter(c => c.closedAt && new Date(c.closedAt) >= sod);

    if (!checks.length) return isMock ? seed : {
      name: 'Current shift', opened: new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
      covers: 0, sales: 0, avgCheck: 0, cashSales: 0, cardSales: 0, tips: 0, voids: 0, voidValue: 0,
    };
    const revenue  = checks.reduce((s,c) => s + c.total, 0);
    const covers   = checks.reduce((s,c) => s + (c.covers || 1), 0);
    const tips     = checks.reduce((s,c) => s + (c.tip || 0), 0);
    const voids    = checks.reduce((s,c) => s + c.voids?.length || 0, 0);
    const card     = checks.filter(c => c.method !== 'cash').reduce((s,c) => s + c.total, 0);
    const cash     = checks.filter(c => c.method === 'cash').reduce((s,c) => s + c.total, 0);
    return {
      name: isMock ? seed.name : 'Current shift',
      opened: isMock ? seed.opened : new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }),
      covers, sales: revenue, avgCheck: covers > 0 ? revenue / covers : 0,
      cashSales: cash, cardSales: card, tips, voids, voidValue: 0,
    };
  },

  // ── Toast ─────────────────────────────────
  toast: null,
  theme: localStorage.getItem('rpos-theme') || 'dark',
  setTheme: (t) => {
    localStorage.setItem('rpos-theme', t);
    document.documentElement.setAttribute('data-theme', t);
    set({ theme: t });
  },
  showToast: (msg,type='info') => { set({ toast:{ msg,type,key:Date.now() } }); setTimeout(()=>set({toast:null}),2800); },

  // ── Change due (v5.5.943) ─────────────────
  // A cash sale's change used to flash past on the tender screen and die with the
  // modal. This holds it for the full-screen ChangeDueOverlay (App.jsx), which stays
  // up until staff tap — no timer, counting change out of a drawer takes as long as
  // it takes. Global (not POSSurface) state because a table cash-off immediately
  // switches surface to the floor plan.
  changeDue: null,
  showChangeDue: (amount) => {
    const a = Math.round(Number(amount) * 100) / 100;
    if (a >= 0.01) set({ changeDue: { amount: a, key: Date.now() } });
  },
  clearChangeDue: () => set({ changeDue: null }),

  // ── Order alert (big top-of-screen banner for new customer orders) ─────
  // Set by realtime.js when a new kiosk / online / QR order arrives.
  // Shape: { source: 'kiosk'|'online'|'qr', who: 'name or table label', ref, total, key }
  // Stays on screen until the operator dismisses it (× button or swipe up).
  // No auto-dismiss — missing a new-order alert because you blinked is worse
  // than a slightly cluttered screen.
  orderAlert: null,
  showOrderAlert: (alert) => {
    set({ orderAlert: { ...alert, key: Date.now() } });
  },
  dismissOrderAlert: () => set({ orderAlert: null }),

  // v5.5.561: Accept / Reject an incoming order by ref, from anywhere (the new-order
  // popup or the Orders Hub). Looks the order up in the live queue so callers only
  // need the ref. Mirrors OrdersHub's acceptHubrise/rejectHubrise so the logic lives
  // in one place.
  //   Accept → print + KDS tickets + flip to 'prep'; HubRise orders also confirm a
  //            prep time back to the channel (+ optional dispatch receipt).
  //   Reject → tell the channel (HubRise) and drop the order from the queue.
  // v5.5.849: shared accept body (find-order + print + status flip + toast) for both the
  // plain Accept and Accept-with-delay paths. delayMinutes only applies to HubRise orders:
  // it rides to the edge fn as { delay_minutes }, which then sends
  // confirmed_time = now + delay in store-local time. Plain accept (delayMinutes null)
  // sends NO confirmed_time — per HubRise's sign-off review, a plain accept implicitly
  // confirms the requested/ASAP time; a confirmed time is ONLY for a kitchen delay.
  _acceptOrderCore: (ref, delayMinutes) => {
    const o = (get().orderQueue || []).find(x => x.ref === ref);
    if (!o) return;
    const locId = getActiveLocationSync();
    get().routeKioskOrderPrints?.({
      ref: o.ref, source: o.source || 'hubrise',
      items: o.items || [],
      customer: o.customer || null,
      collectionTime: o.collectionTime || null,
      isASAP: !!o.isASAP,
      sentAt: Date.now(),
    });
    if (o.source === 'hubrise') {
      // manual: staff pressed Accept. Accepting a channel order placed days ahead is a
      // deliberate act, so its receipt is not subject to the auto-print age gate.
      if (isHubriseAutoReceipt(locId)) get().printHubriseReceipt?.(o, { manual: true });
      get().updateQueueStatus(o.ref, 'prep');
      hubrisePushStatus(locId, o.ref, 'accept', delayMinutes ? { delay_minutes: delayMinutes } : {}).catch(() => {});
      // v5.5.854: a FULLY-PAID channel order is revenue the moment the venue accepts
      // it — book it now so sales/order reports see it immediately, not only after
      // someone remembers to tap "collected". Unpaid/part-paid orders book when the
      // balance is taken (recordWalkInClosed intercept). A later channel cancellation
      // voids the booked check server-side (hubrise-ingest).
      if (o.customer?.paid) get().bookChannelSale(o);
    } else {
      get().updateQueueStatus(o.ref, 'prep');
    }
    const who = o.customer?.channel || o.customer?.name || 'order';
    get().showToast?.(
      delayMinutes
        ? `Accepted ${who} ${o.ref} — kitchen running +${delayMinutes}m (channel notified)`
        : `Accepted ${who} ${o.ref}`,
      'success',
    );
  },
  acceptOrderByRef: (ref) => get()._acceptOrderCore(ref, null),
  // Accept but tell the channel the kitchen is running behind by <minutes>.
  acceptOrderByRefWithDelay: (ref, minutes) => get()._acceptOrderCore(ref, Number(minutes) || null),

  // v5.5.854: book a channel (HubRise) sale into closed_checks — THE single writer for
  // prepaid channel revenue. Idempotent: the deterministic id means a duplicate insert
  // just errors and is swallowed, so accept-time booking and the 'collected' safety-net
  // call can never double-book. Money fields come from lib/channelMoney (the same
  // builder the till balance-collection path uses). Gated: training tills and mock mode
  // book nothing.
  bookChannelSale: async (o) => {
    if (!o || o.source !== 'hubrise' || !supabase || isTrainingMode()) return;
    try {
      const locId = getActiveLocationSync();
      const { menuItems = [], taxRates = [] } = get();
      const f = buildChannelCloseFields(o, { menuItems, taxRates });
      const { error } = await supabase.from('closed_checks').insert({
        id: `chk-hr-${o.ref}`, ref: o.ref, location_id: locId,
        server: o.customer?.channel || 'HubRise', staff_id: null, covers: 1,
        order_type: o._raw?.type || o.type || 'delivery',
        customer: { ...(o.customer || {}), ...(f.deliveryFee > 0 ? { delivery_fee: f.deliveryFee } : {}) },
        items: f.items,
        discounts: f.discounts, subtotal: f.subtotal,
        service: f.service, tip: f.tip,
        tax_amount: f.taxAmount, tax_breakdown: f.taxBreakdown, total: f.total,
        method: f.channelPaid ? 'card' : 'cash',
        closed_at: new Date().toISOString(), status: 'paid', refunds: [], table_id: null,
        table_label: `${o.customer?.channel || 'HubRise'} ${o.customer?.collectionCode || o.ref}`,
        source: 'hubrise',
      });
      // v5.5.971: PostgREST RESOLVES with { error }, so the old bare try/catch caught
      // nothing at all — a duplicate AND an RLS refusal looked identical (silence), and
      // an unbooked channel sale is revenue missing from every report. Only 23505
      // (deterministic id already booked) is the expected, harmless outcome.
      if (error && error.code !== '23505') {
        reportSave('channel sale', error);
        get().showToast?.(`Channel order ${o.ref} was NOT booked to sales — ${error.message}`, 'error');
      } else if (!error) {
        reportSave('channel sale', null);
      }
    } catch (err) {
      reportSave('channel sale', err);
      console.warn('[bookChannelSale] failed:', err?.message || err);
    }
  },
  rejectOrderByRef: (ref) => {
    const o = (get().orderQueue || []).find(x => x.ref === ref);
    if (!o) return;
    const locId = getActiveLocationSync();
    if (o.source === 'hubrise') {
      hubrisePushStatus(locId, o.ref, 'reject', { reason: 'Rejected by store' }).catch(() => {});
    }
    get().removeFromQueue(o.ref);
    get().showToast?.(`Rejected ${o.ref}`, 'info');
  },

  // ── Allergen pending ──────────────────────
  pendingItem: null,
  setPendingItem: item => set({ pendingItem:item }),
  clearPendingItem: () => set({ pendingItem:null }),
}));
// NOTE: these are appended but the store is defined above — we patch via the create callback

// Mock-mode-only debug handle so local preview sessions can drive store state the
// mock DB can't reach (e.g. bind a cash drawer to test the cash flow). Never set
// on a real till: isMock is false everywhere Supabase keys exist.
if (typeof window !== 'undefined' && isMock) window.__rposStore = useStore;
