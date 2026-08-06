/**
* KioskApp — v5.1
*
* The full customer-facing kiosk experience. 8 screens + tip + table-number flow.
*
* Driven by:
*   - device + device_profile (kiosk_brand_*, kiosk_table_mode, kiosk_tip_presets, etc.)
*   - active menu (resolved from device_profile.menu_id, or schedule resolver)
*   - menu_items, menu_categories, menu_category_links
*
* Persists to:
*   - closed_checks (with source='kiosk', kiosk_id, customer_name, customer_phone, tip_amount, kiosk_table_number)
*   - kds_tickets (so the kitchen sees the order immediately)
*
* Idle timeout: 60s no input → 'still there?' overlay 10s countdown → reset to attract
*
* Layout: portrait. Designed for 27" touchscreen tablets in portrait orientation.
* Responsive: scales by viewport width; min target sizes 60x60px for touch.
*/

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase, platformSupabase, getLocationId, ensureAuthToken } from '../lib/supabase';
import { useStore } from '../store';
import { decrementStockRPC, fetchActiveDiscountRules, shortOrderRef } from '../lib/db';
import { logOrderActivity } from '../lib/activity';
import { evaluateAutoDiscounts, toAppliedDiscount } from '../lib/discountEngine';
import { buildScheduleCtx } from '../lib/locationTime';
import { depleteForSaleServer } from '../lib/stock/deplete';
import KioskProductModal from './KioskProductModal';
import { t, setLang, useKioskLang, LANGUAGES, getLanguageMeta } from '../lib/i18n';
import { displayName, kitchenOverride, receiptOverride } from '../lib/itemDisplay';
import { fetchCustomerByPhone } from '../lib/customerLookup';
import { fetchKioskTables, groupKioskTables } from '../lib/kioskTables';
import { stageGiftCard, commitGiftCard, giftCardCheckRecord } from '../lib/giftCommit';
import { commitRedemption } from '../lib/commitRedemptions';
import { money, stripeCurrency } from '../lib/currency';
import { getLocationProcessor } from '../lib/payments/processor';
import { findPaxTerminal, dispatchTerminalJob, pollTerminalJob, cancelTerminalJob, buildCheckKey } from '../lib/payments/terminalJobs';
// networkReader import removed — kiosk payment now uses server-side edge function directly
// v5.5.871: card payment is processor-aware — Stripe reader (edge fn) OR Ryft PAX
// terminal (the same "send to terminal" job path the POS/Table-Pay use).

// ── OTP portal caller (mirrors CustomerPortal.callPortal) ───────────────────
const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
async function callLoyaltyOtp(body) {
  const res = await fetch(`${OPS_URL}/functions/v1/loyalty-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPS_ANON}`, 'apikey': OPS_ANON },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ============================================================
// HOOKS
// ============================================================

// Loads the kiosk's device row + its device_profile row.
function useKioskProfile(kioskId) {
  const [device, setDevice] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!kioskId) { setLoading(false); return; }
      try {
        const { data: dev, error: e1 } = await supabase
          .from('devices').select('*').eq('id', kioskId).maybeSingle();
        if (e1) throw e1;
        if (!alive) return;
        setDevice(dev);
        if (dev?.profile_id) {
          const { data: prof, error: e2 } = await supabase
            .from('device_profiles').select('*').eq('id', dev.profile_id).maybeSingle();
          if (e2) throw e2;
          if (alive) setProfile(prof);
        }
      } catch (e) {
        if (alive) setError(e?.message || 'Failed to load kiosk profile');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [kioskId]);

  return { device, profile, loading, error };
}

// Loads menu data scoped to this location. Returns items, categories, links, menus.
// Uses the active-menu resolver (matching POS) so timed menus work.
function useKioskMenu(profile, locationId) {
  const [data, setData] = useState({ items: [], categories: [], menus: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  // 60-second tick for active-menu re-resolution (timed menus auto-switch)
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!locationId) { setLoading(false); return; }
      try {
        // v5.5.235: menu_category_links has no location_id column — filter via
        // the loaded menus' ids (which are already location-scoped). Previously
        // this was an unfiltered select('*') returning links from ALL locations.
        const [iRes, cRes, mRes, pRes] = await Promise.all([
          supabase.from('menu_items').select('*').eq('location_id', locationId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*').eq('location_id', locationId).order('sort_order'),
          supabase.from('menus').select('*').eq('location_id', locationId).eq('is_active', true),
          // v5.5.953: instruction-group DEFINITIONS (cooking preference etc.) have no DB
          // table — they ride the config-push snapshot. Online reads it, the POS applies
          // it, but the kiosk never loaded it, so KioskProductModal's def lookup fell back
          // to the seed defaults and every REAL cooking preference was silently skipped
          // ('[kiosk] instruction group not found'). Same read OnlineSurface uses.
          supabase.from('config_pushes').select('snapshot->instructionGroupDefs')
            .eq('location_id', locationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]);
        // Fetch links only for this location's menus
        const menuIds = (mRes.data || []).map(m => m.id);
        const lRes = menuIds.length
          ? await supabase.from('menu_category_links').select('*').in('menu_id', menuIds)
          : { data: [] };
        if (!alive) return;
        // Apply real instruction defs into the store so KioskProductModal's existing
        // useStore(s => s.instructionGroupDefs) lookup resolves them. Keep the seed
        // defaults when no push exists yet (mock/dev).
        const instDefs = pRes?.data?.instructionGroupDefs;
        if (Array.isArray(instDefs) && instDefs.length) {
          useStore.setState({ instructionGroupDefs: instDefs });
        }
        setData({
          items: iRes.data || [],
          categories: cRes.data || [],
          menus: mRes.data || [],
          links: lRes.data || [],
        });
      } catch (e) {
        if (alive) setError(e?.message || 'Failed to load menu');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [locationId]);

  // Resolve active menu — same logic as POSSurface v4.6.5
  const activeMenuId = useMemo(() => {
    const now = new Date();
    const day = now.getDay() || 7;
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
        return time >= fromMin || time <= toMin;
      }
      return true;
    };
    const allMenus = data.menus;
    const activeNow = allMenus.filter(isActive);
    const preferred = profile?.menu_id;
    if (preferred && activeNow.some(m => m.id === preferred)) return preferred;
    if (activeNow.length > 0) return activeNow.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0].id;
    const def = allMenus.find(m => m.is_default);
    if (def) return def.id;
    if (preferred) return preferred;
    return null;
  }, [data.menus, profile?.menu_id, tick]);

  return { ...data, activeMenuId, loading, error };
}

// ============================================================
// PRICING
// ============================================================

// Same resolver shape as store.getItemPrice. menu+channel → menu.all → channel → base.
function resolvePrice(item, orderType, menuId) {
  const p = item?.pricing;
  if (!p) return item?.price || 0;
  const KEY_MAP = { 'dine-in': 'dineIn', dineIn: 'dineIn', takeaway: 'takeaway', collection: 'collection', delivery: 'delivery' };
  const key = KEY_MAP[orderType] || 'dineIn';
  if (menuId && p.menus && p.menus[menuId]) {
    const tier = p.menus[menuId];
    if (tier[key] !== null && tier[key] !== undefined) return tier[key];
    if (tier.all !== null && tier.all !== undefined) return tier.all;
  }
  return (p[key] !== null && p[key] !== undefined) ? p[key] : (p.base || 0);
}

// v5.5.35: customer-facing display name lives in a shared util so the
// modal can use it too. See src/lib/itemDisplay.js for the precedence
// rationale (menuName / menu_name / name).

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

export default function KioskApp({ kioskId, onUnpair }) {
  // Profile + menu data
  const { device, profile, loading: profLoading, error: profError } = useKioskProfile(kioskId);
  const [locationId, setLocationId] = useState(null);
  useEffect(() => {
    // v5.5.262: Kiosks don't have rpos-device in localStorage (they use
    // rpos-kiosk-id), so getLocationId() returns null. Resolve from the
    // device row's location_id instead, with getLocationId() as fallback.
    if (device?.location_id) {
      setLocationId(device.location_id);
    } else {
      getLocationId().then(id => { if (id) setLocationId(id); }).catch(() => {});
    }
  }, [device?.location_id]);
  const { items, categories, menus, links, activeMenuId, loading: menuLoading, error: menuError } = useKioskMenu(profile, locationId);

  // v5.5.265: Resolve companyId for OTP + gift card flows
  const [companyId, setCompanyId] = useState(null);
  const [kioskTz, setKioskTz] = useState('Europe/London');
  useEffect(() => {
    if (!locationId || !platformSupabase) return;
    platformSupabase
      .from('locations')
      .select('company_id, timezone')
      .or(`ops_location_id.eq.${locationId},id.eq.${locationId}`)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => { if (data?.company_id) setCompanyId(data.company_id); if (data?.timezone) setKioskTz(data.timezone); })
      .catch(() => {});
  }, [locationId]);

  // Auto-discount rules — fetched live (kiosk runs anonymously, no store.discountRules). Raw DB rows
  // feed the engine directly (it reads snake_case). Channel 'kiosk'; schedule/expiry in location tz.
  const [autoRules, setAutoRules] = useState([]);
  useEffect(() => {
    if (!locationId) return;
    let live = true;
    fetchActiveDiscountRules(locationId)
      .then(({ data }) => { if (live && Array.isArray(data)) setAutoRules(data); })
      .catch(() => {});
    return () => { live = false; };
  }, [locationId]);

  // ─── Cart + flow state ───
  const [screen, setScreen] = useState('attract');
  const [orderType, setOrderType] = useState(null); // 'dineIn' | 'takeaway'
  // v5.4.0: allergen filter
  const [allergenFilter, setAllergenFilter] = useState(new Set());
  const [showAllergenPicker, setShowAllergenPicker] = useState(false);
  const [tableNumber, setTableNumber] = useState('');
  // v5.5.141/142: live 86 list. The dedicated kiosk device path
  // (App.jsx deviceMode === 'kiosk') renders KioskSurface WITHOUT
  // SyncBridge, so the operator-side realtime + initial 86 fetch never
  // run for a public kiosk. We do them here instead so OUT OF STOCK
  // shows the moment the operator 86s an item — and on boot if any items
  // were already 86'd before this kiosk powered on.
  const eightySixIds = useStore(s => s.eightySixIds || []);
  useEffect(() => {
    if (!locationId || !supabase) return;
    let alive = true;
    let chan = null;
    (async () => {
      try {
        const { data } = await supabase.from('eighty_six').select('item_id').eq('location_id', locationId);
        if (!alive) return;
        const ids = (data || []).map(r => r.item_id).filter(Boolean);
        useStore.setState(s => ({
          eightySixIds: [...new Set([...(s.eightySixIds || []), ...ids])],
        }));
      } catch (e) { console.warn('[KioskApp] 86 fetch:', e?.message); }
    })();
    chan = supabase.channel(`kiosk-86:${locationId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'eighty_six',
        filter: `location_id=eq.${locationId}`,
      }, (payload) => {
        const id = payload.new?.item_id || payload.old?.item_id;
        if (!id) return;
        if (payload.eventType === 'INSERT') {
          useStore.setState(s => ({
            eightySixIds: s.eightySixIds.includes(id) ? s.eightySixIds : [...s.eightySixIds, id],
          }));
        } else if (payload.eventType === 'DELETE') {
          useStore.setState(s => ({
            eightySixIds: s.eightySixIds.filter(x => x !== id),
          }));
        }
      }).subscribe();
    return () => {
      alive = false;
      if (chan && supabase) supabase.removeChannel(chan);
    };
  }, [locationId]);

  // v5.5.239: live stock levels so kiosk shows remaining counts and blocks
  // ordering items at zero stock (before the 86 realtime event arrives).
  const dailyCounts = useStore(s => s.dailyCounts || {});
  useEffect(() => {
    if (!locationId || !supabase) return;
    let alive = true;
    let chan = null;
    (async () => {
      try {
        const { data } = await supabase.from('stock_levels').select('item_id, par, remaining').eq('location_id', locationId);
        if (!alive || !data?.length) return;
        const counts = {};
        data.forEach(r => { counts[r.item_id] = { par: r.par, remaining: r.remaining }; });
        useStore.setState(s => ({ dailyCounts: { ...s.dailyCounts, ...counts } }));
      } catch (e) { console.warn('[KioskApp] stock fetch:', e?.message); }
    })();
    chan = supabase.channel(`kiosk-stock:${locationId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'stock_levels',
        filter: `location_id=eq.${locationId}`,
      }, (payload) => {
        if (!alive) return;
        const row = payload.new || payload.old;
        const itemId = row?.item_id;
        if (!itemId) return;
        if (payload.eventType === 'DELETE') {
          useStore.setState(s => {
            const next = { ...s.dailyCounts };
            delete next[itemId];
            return { dailyCounts: next };
          });
        } else {
          useStore.setState(s => ({
            dailyCounts: { ...s.dailyCounts, [itemId]: { par: payload.new.par, remaining: payload.new.remaining } },
          }));
          // v5.5.288: Auto-86 when stock hits zero via realtime update.
          // This is the SECOND independent signal (alongside the eighty_six
          // table subscription) so even if one WebSocket misses an event,
          // the item still becomes unavailable.
          if (payload.new.remaining <= 0) {
            useStore.setState(s => ({
              eightySixIds: s.eightySixIds.includes(itemId)
                ? s.eightySixIds
                : [...s.eightySixIds, itemId],
            }));
          }
        }
      }).subscribe();

    // v5.5.288: Periodic re-fetch of 86 list for resilience against
    // missed WebSocket events (e.g. device wakes from sleep, network
    // reconnect). Runs every 30 seconds — lightweight single-column query.
    const refreshInterval = setInterval(async () => {
      if (!alive) return;
      try {
        const { data } = await supabase
          .from('eighty_six')
          .select('item_id')
          .eq('location_id', locationId);
        if (!alive || !data) return;
        const ids = data.map(r => r.item_id).filter(Boolean);
        useStore.setState(s => {
          // Merge: add any missing IDs from DB, but don't remove local-only
          // ones (they came from stock_levels auto-86 which is also valid).
          const current = s.eightySixIds || [];
          const merged = [...new Set([...current, ...ids])];
          // Only update if something changed to avoid re-renders
          return merged.length !== current.length
            ? { eightySixIds: merged }
            : {};
        });
      } catch (e) {
        console.warn('[KioskApp] 86 periodic refresh:', e?.message);
      }
    }, 30_000);

    return () => {
      alive = false;
      clearInterval(refreshInterval);
      if (chan && supabase) supabase.removeChannel(chan);
    };
  }, [locationId]);

  const [cart, setCart] = useState([]); // [{ key, item, qty, mods, linePrice, lineTotal, name }]
  const [tip, setTip] = useState(0);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  // v5.5.37: kiosk now captures email + marketing opt-in alongside name/phone.
  // Email is optional (for emailed receipts); opt-in defaults to false.
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerMarketingOptIn, setCustomerMarketingOptIn] = useState(false);
  // v5.5.219: Loyalty reward redemption at kiosk checkout
  const [loyaltyRedemption, setLoyaltyRedemption] = useState(null);
  // loyaltyRedemption: { reward_id, reward_name, points_deducted, discount_type, discount_value, idempotency_key, balance_after }
  // v5.5.265: Gift card payment applied at checkout
  // v5.5.901: APPLY-ONLY staging — { card_id, code, code_last4, applied (minor),
  // balance_at_apply, remaining_balance, commit_key, pending_commit }. Nothing is debited
  // until submitOrder fires gift-redeem against checkIdRef.
  const [giftCardPayment, setGiftCardPayment] = useState(null);
  // v5.5.901: the closed-check id is minted ONCE per basket (not per submitOrder call), so a
  // retried submit reuses it — that id is the server-side idempotency scope for the gift-card
  // debit, and a fresh id per attempt would let a retry debit the card twice.
  const checkIdRef = useRef(null);
  // v5.5.887: promo/offer code — validated at entry (no write), REDEEMED in submitOrder once
  // the order exists (promo-redeem is race-safe + idempotent on `${checkId}:${code}` — the
  // check id above, which is stable across retries of the same basket; the order ref is
  // minted fresh inside each submitOrder attempt and so cannot anchor idempotency).
  const [promoApplied, setPromoApplied] = useState(null); // { code, code_id, offer_id, label, amount }
  // giftCardPayment: { card_id, code, applied (minor), remaining_balance }
  // v5.5.265: Verified customer loyalty data (from OTP flow)
  const [verifiedLoyalty, setVerifiedLoyalty] = useState(null);
  // verifiedLoyalty: { customer, loyalty, stampCards, giftCards }
  // Track where to return after early loyalty sign-in (from orderType screen)
  const [loyaltyReturnScreen, setLoyaltyReturnScreen] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [orderNumber, setOrderNumber] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // v5.5.18: kiosk language (i18n). Subscribes via useKioskLang() so any
  // setLang() call from the picker re-renders this component + children.
  const lang = useKioskLang();
  const [showLangPicker, setShowLangPicker] = useState(false);

  // ─── Branding (from profile, fallbacks) ───
  const brandName = profile?.kiosk_brand_name || device?.name || 'Order here';
  const brandColor = profile?.kiosk_brand_color || '#f97316';
  const brandAccent = profile?.kiosk_brand_accent_color || '#fbbf24';
  const brandBg = profile?.kiosk_brand_bg_color || '#0e0e10';
  const brandLogoUrl = profile?.kiosk_brand_logo_url;
  const attractVideoUrl = profile?.kiosk_attract_video_url;
  const banners = Array.isArray(profile?.kiosk_banners) ? profile.kiosk_banners : [];
  const tipPresets = profile?.kiosk_tip_presets || [10, 12.5, 15];
  const tableMode = profile?.kiosk_table_mode || 'either';
  const loyaltyEnabled = profile?.kiosk_loyalty_enabled !== false;
  const idleTimeoutSec = profile?.kiosk_idle_timeout_sec || 60;
  const avgWaitMinutes = profile?.kiosk_avg_wait_minutes || 8;
  const bannerFor = (screen) => banners.find(b => b.screen === screen && b.imageUrl);
  // v5.3.4: theme is dominant. brand_bg_color only takes effect if it visually matches the theme
  // (avoids the bug where saving a dark bg via the picker AND switching to light theme leaves a dark bg).
  const themeMode = profile?.kiosk_theme_mode === 'light' ? 'light' : 'dark';
  const isLight = themeMode === 'light';
  const themeDefaultBg = isLight ? '#fafafa' : '#0e0e10';
  const customBg = profile?.kiosk_brand_bg_color;
  // Decide if the saved bg color is compatible with the chosen theme. If it's not (e.g. dark hex on light theme), fall back to theme default.
  const looksLight = (hex) => {
    if (!hex || !hex.startsWith('#')) return false;
    const n = parseInt(hex.slice(1), 16);
    if (isNaN(n)) return false;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (r * 0.299 + g * 0.587 + b * 0.114) > 180;
  };
  const customMatchesTheme = customBg && (isLight ? looksLight(customBg) : !looksLight(customBg));
  const effectiveBg = customMatchesTheme ? customBg : themeDefaultBg;
  // v5.5.0: fg/fgMuted/surfaceCard removed — these now live in globals.css under
  // [data-kiosk-theme="light|dark"]. Use var(--kFg)/var(--kFgMuted)/var(--kSurface1) etc.
  const labelTapToOrder = profile?.kiosk_label_tap_to_order || 'TAP TO ORDER';
  const labelAddToOrder = profile?.kiosk_label_add_to_order || 'Add to order';
  const labelPlaceOrder = profile?.kiosk_label_place_order || 'Place order';
  // Debug log so we can verify what's loaded
  if (typeof window !== 'undefined' && !window.__kioskLogged) {
    window.__kioskLogged = true;
    console.log('[kiosk] profile loaded', { themeMode, effectiveBg, labelTapToOrder, labelAddToOrder, labelPlaceOrder, brandColor: profile?.kiosk_brand_color });
  }

  // ─── Filtered menu (cats + items belonging to active menu) ───
  const visibleCategories = useMemo(() => {
    const linkedIds = new Set(links.filter(l => l.menu_id === activeMenuId).map(l => l.category_id));
    // v5.3.1: include sub-categories (Coffee under Drinks, etc). Only filter out is_special.
    // v5.5.788: also include a sub-category whose PARENT is linked to the active menu
    // (matches OnlineSurface/POS — the sub follows its parent into the menu).
    const eligible = categories
      .filter(c => !c.is_special)
      .filter(c => !activeMenuId || c.menu_id === activeMenuId || linkedIds.has(c.id) || (c.parent_id && linkedIds.has(c.parent_id)));
    // v5.5.873: order as a TREE, not a flat sort. A sub-category's sort_order is scoped WITHIN its
    // parent (0,1,2…), so a flat global sort scattered subs among the top-level categories and the
    // sidebar stopped matching Back Office (e.g. a sub at sort_order 0 jumped above its parent at 2).
    // Emit each top-level category (by sort_order) IMMEDIATELY followed by its own sub-categories
    // (by their sort_order) — the Back Office / POS tree order.
    const eligibleIds = new Set(eligible.map(c => c.id));
    const byParent = new Map();
    for (const c of eligible) {
      // A sub whose parent isn't eligible/loaded is treated as a root so it never disappears.
      const key = (c.parent_id && eligibleIds.has(c.parent_id)) ? c.parent_id : '__root__';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    }
    byParent.forEach(arr => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
    const out = [];
    const seen = new Set();
    const walk = (key) => {
      for (const c of (byParent.get(key) || [])) {
        if (seen.has(c.id)) continue;   // defensive against a cyclic parent_id
        seen.add(c.id);
        out.push(c);
        walk(c.id);
      }
    };
    walk('__root__');
    return out;
  }, [categories, links, activeMenuId]);

  const visibleItems = useMemo(() => {
    if (!selectedCategoryId) return [];
    return items
      // v5.3.1: hide variant children — kiosk shows parent, modal handles size selection
      .filter(i => !i.parent_id)
      .filter(i => (i.visibility?.kiosk !== false))
      .filter(i => i.cat === selectedCategoryId || (Array.isArray(i.cats) && i.cats.includes(selectedCategoryId)))
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }, [items, selectedCategoryId]);

  // Auto-pick first cat when menu loads
  useEffect(() => {
    if (!selectedCategoryId && visibleCategories.length > 0) {
      setSelectedCategoryId(visibleCategories[0].id);
    }
  }, [visibleCategories, selectedCategoryId]);

  // ─── Cart totals ───
  const subtotal = useMemo(() => cart.reduce((a, l) => a + l.lineTotal, 0), [cart]);
  // Auto-discounts (BOGO / bundle / scheduled). Kiosk cart lines nest the menu row under l.item,
  // so map cat/cats from there; unit price is l.linePrice (item + mods). Applied before tip + before
  // loyalty/gift credit (grandTotal subtracts those next).
  const autoDiscounts = useMemo(() => {
    const items = cart.map((l, i) => ({
      uid: l.key || `l${i}`,
      cat: l.item?.cat || null,
      cats: l.item?.cats || null,
      price: l.linePrice,
      qty: l.qty || 1,
      name: l.name || l.item?.name || 'Item',
    }));
    return evaluateAutoDiscounts(items, autoRules, 'kiosk', buildScheduleCtx(kioskTz)).map(toAppliedDiscount);
  }, [cart, autoRules, kioskTz]);
  const autoDiscountTotal = +autoDiscounts.reduce((s, d) => s + (d.value || 0), 0).toFixed(2);
  const discountedSubtotal = Math.max(0, +(subtotal - autoDiscountTotal).toFixed(2));
  const total = useMemo(() => discountedSubtotal + tip, [discountedSubtotal, tip]);
  const cartItemCount = useMemo(() => cart.reduce((a, l) => a + l.qty, 0), [cart]);

  // v5.5.285: Count total usage of each item (by itemId) across the cart,
  // including both direct item orders and modifier option picks.
  // Used to enforce stock limits in KioskProductModal and ScreenCart.
  const cartItemUsage = useMemo(() => {
    const usage = {};
    for (const line of cart) {
      // Direct item
      if (line.item?.id) {
        usage[line.item.id] = (usage[line.item.id] || 0) + line.qty;
      }
      // Modifier options with itemId
      if (line.modsArray) {
        for (const mod of line.modsArray) {
          if (mod.itemId) {
            usage[mod.itemId] = (usage[mod.itemId] || 0) + line.qty;
          }
        }
      }
    }
    return usage;
  }, [cart]);

  // ─── Idle timer ───
  const lastActivityRef = useRef(Date.now());
  const [idleWarning, setIdleWarning] = useState(false);
  const [warningCountdown, setWarningCountdown] = useState(10);
  const resetIdle = useCallback(() => { lastActivityRef.current = Date.now(); setIdleWarning(false); setWarningCountdown(10); }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      const idle = (Date.now() - lastActivityRef.current) / 1000;
      // Don't show idle warning on attract screen — that's its resting state
      if (screen === 'attract') return;
      if (!idleWarning && idle > idleTimeoutSec) {
        setIdleWarning(true); setWarningCountdown(10);
      } else if (idleWarning) {
        setWarningCountdown(c => {
          if (c <= 1) {
            // Reset session
            resetSession();
            return 10;
          }
          return c - 1;
        });
      }
    }, 1000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, idleWarning, idleTimeoutSec]);

  const resetSession = useCallback(() => {
    setScreen('attract');
    setOrderType(null);
    setTableNumber('');
    setCart([]);
    setTip(0);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerEmail('');
    setCustomerMarketingOptIn(false);
    setSelectedItem(null);
    setSelectedCategoryId(null);
    setLoyaltyRedemption(null);
    setGiftCardPayment(null);
    checkIdRef.current = null;
    setPromoApplied(null);
    setVerifiedLoyalty(null);
    setAllergenFilter(new Set());
    setShowAllergenPicker(false);
    setOrderNumber(null);
    setSubmitError(null);
    setIdleWarning(false);
    setWarningCountdown(10);
    lastActivityRef.current = Date.now();
  }, []);

  // ─── Cart actions ───
  const addToCart = useCallback((item, qty = 1, selectedMods = {}, summaryOverride = null, priceEachOverride = null, modsArrayOverride = null, instructions = '') => {
    // v5.5.285: Stock enforcement — cap qty at remaining stock
    const stock = dailyCounts[item?.id];
    if (stock) {
      const inCart = cartItemUsage[item?.id] || 0;
      const maxAdd = Math.max(0, stock.remaining - inCart);
      if (maxAdd <= 0) return; // fully sold out
      qty = Math.min(qty, maxAdd);
    }
    const linePrice = priceEachOverride ?? resolvePrice(item, orderType, activeMenuId);
    const modSummary = summaryOverride ?? Object.entries(selectedMods)
      .filter(([, v]) => v)
      .map(([k, v]) => Array.isArray(v) ? v.join(', ') : v)
      .join(' · ');
    let modsArray = Array.isArray(modsArrayOverride) ? [...modsArrayOverride] : [];
    // v5.4.0: append instructions as a special mod entry so POS / kitchen sees it
    if (instructions && instructions.trim()) {
      modsArray.push({ label: instructions.trim(), price: 0, groupLabel: 'Note', _instruction: true });
    }
    const key = item.id + ':' + JSON.stringify(selectedMods);
    setCart(prev => {
      const existing = prev.find(l => l.key === key);
      if (existing) {
        return prev.map(l => l.key === key
          ? { ...l, qty: l.qty + qty, lineTotal: (l.qty + qty) * l.linePrice }
          : l
        );
      }
      return [...prev, {
        key,
        item,
        name: displayName(item),
        qty,
        mods: modSummary + ((instructions && instructions.trim()) ? ((modSummary ? ' · ' : '') + 'Note: ' + instructions.trim()) : ''),
        modsArray,
        instructions: instructions || '',
        linePrice,
        lineTotal: qty * linePrice,
      }];
    });
    resetIdle();
  }, [orderType, activeMenuId, resetIdle, dailyCounts, cartItemUsage]);

  const updateCartQty = useCallback((key, delta) => {
    setCart(prev => prev
      .map(l => {
        if (l.key !== key) return l;
        let newQty = Math.max(0, l.qty + delta);
        // v5.5.285: Stock cap on increment
        if (delta > 0 && l.item?.id) {
          const stock = dailyCounts[l.item.id];
          if (stock) newQty = Math.min(newQty, stock.remaining);
        }
        return { ...l, qty: newQty, lineTotal: newQty * l.linePrice };
      })
      .filter(l => l.qty > 0)
    );
    resetIdle();
  }, [resetIdle, dailyCounts]);

  // ─── Order submission ───
  // v5.5.219: Loyalty credit reduces the total paid by card
  const loyaltyCredit = loyaltyRedemption?.discount_value ? loyaltyRedemption.discount_value / 100 : 0;
  const giftCardCredit = giftCardPayment?.applied ? giftCardPayment.applied / 100 : 0;
  // Promo discount (major units, from promo-redeem validate) — capped at what's left to pay.
  const promoCredit = promoApplied
    ? Math.min(promoApplied.amount || 0, Math.max(0, total - loyaltyCredit - giftCardCredit))
    : 0;
  const grandTotal = Math.max(0, total - loyaltyCredit - giftCardCredit - promoCredit);

  // On 'simulate paid' → write closed_checks + kds_tickets row, set orderNumber, advance.
  const submitOrder = useCallback(async (nameOverride, phoneOverride) => {
    if (submitting) return;
    console.log('[kiosk] submitOrder called', { nameOverride, phoneOverride, customerName, customerPhone, loyaltyRedemption: loyaltyRedemption ? 'yes' : 'no' });
    setSubmitting(true);
    setSubmitError(null);
    try {
      // v5.5.901: stable across retries — see checkIdRef.
      if (!checkIdRef.current) {
        checkIdRef.current = (crypto.randomUUID ? crypto.randomUUID() : 'cc-' + Date.now());
      }
      const checkId = checkIdRef.current;
      // v5.5.901: GIFT CARD — debit at COMMIT, like the promo code and loyalty reward below.
      // The apply step only staged the discount, so an abandoned basket / idle timeout /
      // declined card can no longer burn the card's value. Awaited (not fire-and-forget) so
      // the closed_check records what the server ACTUALLY debited, and ordered BEFORE the
      // closed_checks insert per INVARIANTS.md ("gift card redeem before order close").
      // commitGiftCard never throws: the customer has already paid the card leg, so a gift
      // failure must never cost them the order — it is recorded on the check instead.
      let giftCommit = null;
      if (giftCardPayment?.pending_commit) {
        // Gift-covers-everything means NO card leg was charged — so a failed debit must
        // abort the order (otherwise the kiosk gives away free food) and a partial debit is
        // refused outright, leaving the balance intact for the customer to pay by card.
        const giftOnly = grandTotal <= 0.005;
        const gToken = await ensureAuthToken().catch(() => null);
        giftCommit = await commitGiftCard(giftCardPayment, {
          functionsUrl: `${OPS_URL}/functions/v1`,
          token: gToken,
          locationId,
          channel: 'kiosk',
          closedCheckId: checkId,
          allowPartial: !giftOnly,
        });
        if (!giftCommit.ok && giftOnly) {
          console.error('[kiosk] gift-only order aborted — gift commit failed:', giftCommit.error);
          setGiftCardPayment(null);   // frees the amount back up so the reader can take it
          setSubmitError(giftCommit.error === 'Insufficient balance'
            ? 'That gift card no longer has enough balance. Please try another card or pay at the reader.'
            : `Gift card could not be applied: ${giftCommit.error}`);
          setScreen('gift');
          return;
        }
        if (!giftCommit.ok) {
          console.error('[kiosk] gift card commit FAILED — order proceeds, card not debited:', giftCommit.error);
        } else if (giftCommit.shortfall > 0) {
          console.warn('[kiosk] gift card commit partial — uncollected minor:', giftCommit.shortfall);
        }
      }
      // v5.5.8: use the atomic per-location counter instead of (Date.now() % 1000), which
      // collided every ~1 second. `num` is the order's IDENTITY — unique per location and
      // unlimited. The short two-digit form customers read is applied at display time only
      // (shortOrderRef), never here. getNextOrderRef always returns a ref or throws, so the
      // old `|| ('R' + (Date.now() % 99 + 1))` tail was unreachable — and it minted exactly
      // the wrapped, colliding number this counter exists to stop.
      const { getNextOrderRef } = await import('../lib/db');
      const num = await getNextOrderRef(locationId);
      const orderTypeOut = orderType === 'dineIn' ? 'dine-in' : 'takeaway';
      const itemsPayload = cart.map(l => ({
        id: l.item.id,
        name: l.name,
        // Triple-naming: explicit kitchen/receipt names ride into closed_checks
        // + order_queue (null when not set). routeKioskOrderPrints reads
        // kitchenName || name for KDS/tickets; receipt builders read
        // receiptName || name. l.item is a raw Supabase row (snake_case) —
        // the itemDisplay resolvers read both shapes.
        kitchenName: kitchenOverride(l.item),
        receiptName: receiptOverride(l.item),
        qty: l.qty,
        price: l.linePrice,
        // POS expects mods as array of { label, price, groupLabel }
        mods: Array.isArray(l.modsArray) ? l.modsArray : [],
        cat: l.item.cat,
        // KIOSK NEVER HOLDS COURSES. A kiosk order is paid and gone — there is no
        // server to fire course 2, so every line must be produced in one go. Stamped
        // at SOURCE (same three fields online sets, OnlineCheckout.jsx:316-318) so it
        // holds no matter which downstream path picks the order up: routeKioskOrderPrints
        // already forces course 1, but fireScheduledOrder (store/index.js:2165) replays a
        // scheduled order through the normal walk-in sendToKitchen, where
        // computeFiredOnSend honours per-line courses and would hold anything above the
        // lowest occupied course.
        status: 'sent',
        fired: true,
        course: 1,
      }));
      // 1. closed_checks
      const checkRow = {
        id: checkId,
        location_id: locationId,
        ref: num,
        items: itemsPayload,
        discounts: autoDiscounts,
        subtotal: subtotal,
        tip: tip,
        tax: 0,
        total: grandTotal,
        order_type: orderTypeOut,
        status: 'paid',
        payment_method: (loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) ? 'split' : 'card-external',
        method: (loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) ? 'split' : 'card',
        closed_at: new Date().toISOString(),
        source: 'kiosk',
        kiosk_id: kioskId,
        customer: (nameOverride ?? customerName) || null,
        customer_phone: (phoneOverride ?? customerPhone) || null,
        kiosk_table_number: tableNumber || null,
        covers: 1,
        // v5.5.219: Stamp loyalty redemption on check for receipt / refund use
        loyalty: loyaltyRedemption ? {
          reward_id: loyaltyRedemption.reward_id,
          stamp_program_id: loyaltyRedemption.stampProgramId || null,
          reward_name: loyaltyRedemption.reward_name,
          points_deducted: loyaltyRedemption.points_deducted,
          discount_value: loyaltyRedemption.discount_value,
          idempotency_key: loyaltyRedemption.idempotency_key,
        } : null,
        // v5.5.901: `applied` is what the server actually debited (giftCardCheckRecord),
        // so reports never overstate gift-card revenue when a commit came up short.
        gift_card: giftCardPayment ? giftCardCheckRecord(giftCardPayment, giftCommit) : null,
        // v5.5.887: promo/offer code on the check for receipt / refund / reporting use.
        // v5.5.909: SPREAD, not a plain `promo: … : null`. PostgREST validates every KEY in
        // the payload against its schema cache before it looks at any value, so shipping
        // `promo: null` on a venue without the column fails the whole insert — the money is
        // already taken (gift card debited, card charged) and the check never lands. Only
        // send the key when there is actually a promo to record.
        ...(promoApplied ? {
          promo: {
            code: promoApplied.code,
            offer_id: promoApplied.offer_id || null,
            label: promoApplied.label || null,
            discount_value: promoCredit,
          },
        } : {}),
      };
      // v5.5.909 — A PAID ORDER MUST NEVER BE LOST TO A MISSING OPTIONAL COLUMN.
      // By the time we get here the customer's money is GONE: the gift card is debited, the
      // promo is redeemed, the card is charged. If this insert fails the sale exists nowhere
      // — no check, no kitchen ticket, no receipt — and the customer is standing there having
      // paid. A venue whose DB is missing a column we added later (`promo`, v5.5.887) took the
      // whole insert down. PostgREST reports that as PGRST204 and names the column, so strip
      // the ones it does not know and retry rather than dropping the sale. The order is
      // recorded; only the extra detail is lost, and the console says exactly which column to
      // add. Same shape as the kitchen_routed_at graceful fallback in routeKioskOrderPrints.
      let e1 = (await supabase.from('closed_checks').insert(checkRow)).error;
      for (let attempt = 0; e1 && attempt < 4; attempt++) {
        const missing = /Could not find the '([^']+)' column/.exec(e1.message || '')?.[1];
        if (!missing || !(missing in checkRow)) break;
        console.error(`[kiosk] closed_checks has no '${missing}' column — dropping it so the paid `
          + `order still records. FIX THE DB: alter table closed_checks add column if not exists ${missing} jsonb;`);
        delete checkRow[missing];
        e1 = (await supabase.from('closed_checks').insert(checkRow)).error;
      }
      if (e1) throw e1;
      // v5.5.583: deplete recipe ingredients from the stock ledger (server-side, since
      // kiosk runs anonymously). Fire-and-forget — never blocks the order.
      depleteForSaleServer({ id: checkId, items: cart.map(l => ({ itemId: l.item.id, qty: l.qty,
        // v5.5.935: chosen modifier sub-items (the bun) deplete too — options carry itemId
        // when linked (KioskProductModal stamps it), plain instructions don't and are skipped.
        mods: (Array.isArray(l.modsArray) ? l.modsArray : []).filter(m => m && m.itemId).map(m => ({ itemId: m.itemId, qty: m.qty || 1 })) })), orderType: orderTypeOut });
      // 2. v5.5.5: customer attribution — kiosks were missing this path, so a customer
      // who ordered at the kiosk was stamped on the closed_check (customer name + phone)
      // but never made it into the customers table, customer_locations junction, or
      // customer_orders. The same phone at another location (same org) wouldn't dedupe
      // either — the existing customer record stayed un-updated, and no per-location
      // visit row was added. POS close paths (recordClosedCheck, recordWalkInClosedCheck,
      // recordWalkInClosed) already do this; kiosk now matches behaviour.
      const finalName = (nameOverride ?? customerName) || null;
      const finalPhone = (phoneOverride ?? customerPhone) || null;
      if (finalPhone) {
        try {
          const orderRecord = {
            id: checkId,
            ref: num,
            total: grandTotal,
            tip: tip,
            subtotal: subtotal,
            items: itemsPayload,
            method: (loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) ? 'split' : 'card',
            order_type: orderTypeOut,
            location_id: locationId,
            closedAt: Date.now(),
            source: 'kiosk',
          };
          // Fire-and-forget — a CRM blip should never block order completion.
          useStore.getState().attributeOrderToCustomer({
            customer: {
              name: finalName || 'Customer',
              phone: finalPhone,
              email: customerEmail || null,
              marketingOptIn: !!customerMarketingOptIn,
            },
            orderRecord,
          }).catch(err => console.warn('[kiosk] attributeOrderToCustomer failed:', err?.message || err));
        } catch (e) {
          console.warn('[kiosk] customer attribution dispatch failed:', e?.message || e);
        }
      }
      // 3. order_queue — makes kiosk orders visible in POS OrdersHub.
      // The master POS device picks up this row via realtime and creates
      // centre-bucketed kds_tickets + print_jobs in routeKioskOrderPrints.
      // (Previously the kiosk wrote a single un-bucketed kds_ticket which
      // wouldn't show on a centre-filtered KDS — now production centres get
      // proper per-centre tickets.)
      const { error: e3 } = await supabase.from('order_queue').insert({
        ref: num,
        location_id: locationId,
        type: orderTypeOut,
        customer: {
          name: (nameOverride ?? customerName) || null,
          phone: (phoneOverride ?? customerPhone) || null,
        },
        items: itemsPayload,
        total: grandTotal,
        status: 'received',
        staff: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        is_asap: true,
        source: 'kiosk',
        paid: true,
        payment_method: (loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) ? 'split' : 'card-external',
      });
      if (e3) console.warn('[kiosk] order_queue insert failed:', e3);
      else { try { logOrderActivity(locationId, { source: 'kiosk', total: grandTotal, ref: num, customer: { name: (nameOverride ?? customerName) || null } }); } catch { /* feed best-effort */ } }
      // Promo code + loyalty reward redeem at COMMIT, now the order exists. Both go through
      // lib/commitRedemptions: result-checked, and parked in the durable retry queue when the
      // deduction fails. The old calls were bare `fetch().catch()`, and fetch does not reject on
      // 4xx/5xx — a 401 or 500 was invisible, so the discount was given away and the code/stamp
      // stayed spendable.
      //
      // FIRE-AND-FORGET, deliberately: by this point the card is charged and order_queue is
      // written, so nothing here may hold the customer on the paying spinner. Awaiting put up to
      // four unbounded round-trips (token + post, twice) between here and setScreen('done'), and a
      // stall longer than idleTimeoutSec + 10s lets the idle watchdog fire resetSession() and clear
      // checkIdRef mid-flight. commitRedemption reports, parks and never throws, and nothing
      // downstream reads its result.
      //
      // `checkId` is the idempotency anchor, NOT the order ref: the ref is minted fresh on
      // every submitOrder attempt, so a retry of the same basket would carry a different one
      // and redeem twice. checkId is minted once per basket. (v5.5.888 dodged that with a
      // random per-submission key, which stopped the double-redeem but also stopped retries
      // from ever deduping — now they do.)
      if (promoApplied?.code) {
        ensureAuthToken().catch(() => null).then(token => commitRedemption({
          kind: 'promo',
          closedCheckId: checkId,
          locationId,
          customerId: verifiedLoyalty?.customer?.id || null,
          channel: 'kiosk',
          code: promoApplied.code,
          basketValue: subtotal,
        }, { functionsUrl: `${OPS_URL}/functions/v1`, token }))
          .catch(err => console.warn('[kiosk] promo redeem dispatch failed:', err?.message || err));
      }
      // The loyalty-screen tap is apply-only (stages the discount, consumes nothing), so an
      // abandoned/failed payment can never burn points or a stamp card.
      if (loyaltyRedemption?.pending_commit && (loyaltyRedemption.stampProgramId || loyaltyRedemption.reward_id)) {
        ensureAuthToken().catch(() => null).then(token => commitRedemption({
          kind: 'loyalty',
          closedCheckId: checkId,
          locationId,
          customerId: loyaltyRedemption.customer_id || verifiedLoyalty?.customer?.id || null,
          channel: 'kiosk',
          stampProgramId: loyaltyRedemption.stampProgramId || null,
          rewardId: loyaltyRedemption.reward_id || null,
        }, { functionsUrl: `${OPS_URL}/functions/v1`, token }))
          .catch(err => console.warn('[kiosk] loyalty redeem dispatch failed:', err?.message || err));
      }
      // 4. Heartbeat
      await supabase.from('devices').update({ last_seen: new Date().toISOString() }).eq('id', kioskId);
      // 5. v5.5.287: Decrement stock for each item + modifier in the order.
      // Previously kiosk/online orders never decremented stock_levels, so POS
      // and back office showed stale counts after kiosk sales.
      try {
        const currentCounts = useStore.getState().dailyCounts || {};
        for (const line of cart) {
          const itemId = line.item?.id;
          if (itemId && currentCounts[itemId]) {
            decrementStockRPC(itemId, line.qty || 1, locationId)
              .catch(e => console.warn('[kiosk] stock decrement failed:', itemId, e?.message));
          }
          // Modifier sub-items (e.g. "Bueno Donut" inside a "Box of 3")
          if (line.modsArray) {
            for (const mod of line.modsArray) {
              if (mod.itemId && currentCounts[mod.itemId]) {
                decrementStockRPC(mod.itemId, (mod.qty || 1) * (line.qty || 1), locationId)
                  .catch(e => console.warn('[kiosk] mod stock decrement failed:', mod.itemId, e?.message));
              }
            }
          }
        }
      } catch (stockErr) {
        console.warn('[kiosk] stock decrement batch failed:', stockErr?.message);
      }
      setOrderNumber(num);
      setScreen('done');
      // Auto-reset to attract after 30s on done screen
      setTimeout(() => resetSession(), 30000);
    } catch (e) {
      console.error('[kiosk] submit failed', e);
      setSubmitError(e?.message || 'Order submission failed. Please ask staff for help.');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, kioskId, locationId, cart, subtotal, total, grandTotal, loyaltyCredit, giftCardCredit, promoCredit, promoApplied, verifiedLoyalty, loyaltyRedemption, giftCardPayment, tip, orderType, customerName, customerPhone, customerEmail, customerMarketingOptIn, tableNumber, resetSession]);

  // ─── Loading + error gates ───
  if (profLoading || menuLoading) {
    return <div style={pageStyle()}><div style={{ color: 'var(--kFg)', fontSize: 18 }}>Loading…</div></div>;
  }
  if (profError || menuError || !device || !profile) {
    return <div style={pageStyle()}>
      <div style={{ color: 'var(--kFg)', textAlign: 'center', padding: 40, maxWidth: 480 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Kiosk not configured</div>
        <div style={{ fontSize: 14, color: 'var(--kFgMuted)', marginBottom: 24 }}>{profError || menuError || 'Profile not found. Please ask staff.'}</div>
        <button onClick={onUnpair} style={btnGhostLight()}>Unpair</button>
      </div>
    </div>;
  }

  // ─── Render ───
  // v5.5.900: keyboard/input events count as activity too — taps on the on-screen keyboard land
  // on the IME overlay, NOT the React tree, so onPointerDown alone let the idle timer fire while
  // a customer was transcribing a gift-card code (or a phone number on the loyalty step).
  return (
    <div onPointerDown={resetIdle} onKeyDown={resetIdle} onInput={resetIdle} data-kiosk-theme={isLight ? "light" : "dark"} style={kioskShell(brandColor, effectiveBg, brandAccent)}>
      {screen === 'attract' && <ScreenAttract brandName={brandName} brandColor={brandColor} brandAccent={brandAccent} brandLogoUrl={brandLogoUrl} attractVideoUrl={attractVideoUrl} avgWaitMinutes={avgWaitMinutes} banner={bannerFor('attract')} ctaLabel={labelTapToOrder} onStart={() => { resetIdle(); setScreen('orderType'); }} />}
      {screen === 'orderType' && <ScreenOrderType brandColor={brandColor} brandLogoUrl={brandLogoUrl} brandName={brandName} tableMode={tableMode} lang={lang} onOpenLanguagePicker={() => setShowLangPicker(true)} loyaltyEnabled={loyaltyEnabled} customerName={customerName} onLoyaltySignIn={() => { setLoyaltyReturnScreen('orderType'); setScreen('loyalty'); }} onPick={(t) => {
        setOrderType(t);
        if (t === 'dineIn' && (tableMode === 'enter' || tableMode === 'either')) setScreen('tableNumber');
        else setScreen('menu');
      }} onBack={() => setScreen('attract')} onCancel={resetSession} />}
      {screen === 'tableNumber' && <ScreenTableNumber brandColor={brandColor} locationId={locationId} value={tableNumber} onChange={setTableNumber} onContinue={() => setScreen('menu')} onBack={() => setScreen('orderType')} onCancel={resetSession} />}
      {screen === 'menu' && <ScreenMenu brandColor={brandColor} brandAccent={brandAccent} categories={visibleCategories} items={visibleItems} selectedCategoryId={selectedCategoryId} onSelectCategory={setSelectedCategoryId} onSelectItem={(item) => { setSelectedItem(item); setScreen('item'); }} cartItemCount={cartItemCount} subtotal={subtotal} onCart={() => setScreen('cart')} orderType={orderType} activeMenuId={activeMenuId} banner={bannerFor('menu')} allergenFilter={allergenFilter} onShowAllergenPicker={() => setShowAllergenPicker(true)} eightySixIds={eightySixIds} dailyCounts={dailyCounts} onBack={() => setScreen('orderType')} onCancel={resetSession} />}
      {screen === 'item' && selectedItem && (
        <KioskProductModal
          item={selectedItem}
          allItems={items}
          brandColor={brandColor}
          brandAccent={brandAccent}
          addLabel={labelAddToOrder}
          basePrice={resolvePrice(selectedItem, orderType, activeMenuId)}
          dailyCounts={dailyCounts}
          cartItemUsage={cartItemUsage}
          onAdd={({ qty, selections, summary, priceEach, mods, instructions }) => {
            addToCart(selectedItem, qty, selections, summary, priceEach, mods, instructions);
            setScreen('menu');
          }}
          onCancel={() => setScreen('menu')}
        />
      )}
      {screen === 'cart' && <ScreenCart brandColor={brandColor} cart={cart} subtotal={subtotal} cartItemCount={cartItemCount} orderType={orderType} onUpdate={updateCartQty} onAddMore={() => setScreen('menu')} onContinue={() => setScreen('tip')} onShowAllergenPicker={() => setShowAllergenPicker(true)} onBack={() => setScreen('menu')} onCancel={resetSession} dailyCounts={dailyCounts} />}
      {screen === 'tip' && <ScreenTip brandColor={brandColor} subtotal={subtotal} tipPresets={tipPresets} tip={tip} onSetTip={setTip} onContinue={() => { if (loyaltyEnabled) setScreen('loyalty'); else setScreen('gift'); }} onBack={() => setScreen('cart')} onCancel={resetSession} />}
      {/* v5.5.219: loyalty/customer-details BEFORE pay so reward discount adjusts amount due */}
      {screen === 'loyalty' && <ScreenLoyalty brandColor={brandColor} customerName={customerName} customerPhone={customerPhone} customerEmail={customerEmail} marketingOptIn={customerMarketingOptIn} locationId={locationId} companyId={companyId} subtotal={subtotal} cart={cart} loyaltyRedemption={loyaltyRedemption} onLoyaltyRedeem={setLoyaltyRedemption} verifiedLoyalty={verifiedLoyalty} onVerifiedLoyalty={setVerifiedLoyalty} onName={setCustomerName} onPhone={setCustomerPhone} onEmail={setCustomerEmail} onMarketingOptIn={setCustomerMarketingOptIn} onContinue={() => { const ret = loyaltyReturnScreen; setLoyaltyReturnScreen(null); setScreen(ret || 'gift'); }} onSkip={() => { const ret = loyaltyReturnScreen; setLoyaltyReturnScreen(null); setScreen(ret || 'gift'); }} submitting={submitting} placeOrderLabel={labelPlaceOrder} earlySignIn={!!loyaltyReturnScreen} onCancel={resetSession} />}
      {/* v5.5.900: gift card / promo code step BEFORE payment (mirrors online ordering) —
          the old entry lived on the pay screen, which auto-starts the card reader on mount,
          so guests never saw it. */}
      {screen === 'gift' && <ScreenGiftPromo brandColor={brandColor} total={grandTotal} loyaltyCredit={loyaltyCredit} giftCardCredit={giftCardCredit} promoCredit={promoCredit} promoApplied={promoApplied} onPromoApply={setPromoApplied} verifiedLoyalty={verifiedLoyalty} giftCardPayment={giftCardPayment} onGiftCardApply={setGiftCardPayment} locationId={locationId} loyaltyRedemption={loyaltyRedemption} notice={submitError || ''} onContinue={() => { setSubmitError(null); setScreen('pay'); }} onBack={() => { setSubmitError(null); if (loyaltyEnabled) setScreen('loyalty'); else setScreen('tip'); }} onCancel={resetSession} />}
      {screen === 'pay' && <ScreenPay brandColor={brandColor} total={grandTotal} loyaltyCredit={loyaltyCredit} giftCardCredit={giftCardCredit} promoCredit={promoCredit} promoApplied={promoApplied} locationId={locationId} kioskId={kioskId} cart={cart} submitting={submitting} error={submitError} onPaid={() => submitOrder(customerName, customerPhone)} onBack={() => { setSubmitError(null); setScreen('gift'); }} loyaltyRedemption={loyaltyRedemption} onCancel={resetSession} />}
      {screen === 'done' && <ScreenDone brandColor={brandColor} customerName={customerName} customerPhone={customerPhone} orderNumber={orderNumber} orderType={orderType} tableNumber={tableNumber} avgWaitMinutes={avgWaitMinutes} banner={bannerFor('done')} onDone={resetSession} />}

      {/* v5.4.0: Allergen picker overlay */}
      {showAllergenPicker && (
        <AllergenPickerOverlay
          brandColor={brandColor}
          allergens={Array.from(new Set(items.flatMap(i => Array.isArray(i.allergens) ? i.allergens : [])))}
          selected={allergenFilter}
          onChange={setAllergenFilter}
          onClose={() => setShowAllergenPicker(false)}
        />
      )}

      {/* v5.5.18: Language picker overlay */}
      {showLangPicker && (
        <ScreenLanguagePicker
          brandColor={brandColor}
          currentLang={lang}
          onPick={(code) => { setLang(code); setShowLangPicker(false); }}
          onClose={() => setShowLangPicker(false)}
        />
      )}

      {/* Idle warning overlay */}
      {idleWarning && screen !== 'attract' && screen !== 'done' && (
        <div onClick={resetIdle} style={{ position: 'fixed', inset: 0, background: 'var(--kOverlay)', display: 'grid', placeItems: 'center', zIndex: 200, padding: 24 }}>
          <div style={{ background: 'var(--kSurfaceRaised)', border: '2px solid ' + brandColor, borderRadius: 24, padding: '40px 36px', maxWidth: 400, textAlign: 'center', cursor: 'pointer' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>⏰</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--kFg)', marginBottom: 8 }}>Still there?</div>
            <div style={{ fontSize: 14, color: 'var(--kFgMuted)', marginBottom: 24 }}>This order will reset in {warningCountdown}s</div>
            <div style={{ background: brandColor, color: 'var(--kFg)', padding: '14px 28px', borderRadius: 100, fontSize: 16, fontWeight: 700 }}>Tap to continue</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SHARED STYLES
// ============================================================

// v5.5.0: theme vars now live in globals.css under [data-kiosk-theme="light|dark"].
// kioskShell only sets the brand colors (which are per-org, not theme-bound) and
// the background — light/dark fg/surfaces/borders flip via CSS.
function kioskShell(brandColor, brandBg, brandAccent) {
  return {
    position: 'fixed',
    inset: 0,
    background: brandBg || 'var(--kSurfaceShell)',
    color: 'var(--kFg)',
    '--kBrand': brandColor || '#ff7070',
    '--kBrandAccent': brandAccent || brandColor || '#ff7070',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    overflow: 'hidden',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  };
}
function pageStyle() {
  return {
    position: 'fixed', inset: 0,
    background: 'var(--kSurfaceShell)',
    color: 'var(--kFg)',
    display: 'grid',
    placeItems: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  };
}
function btnGhostLight() {
  return { background: 'transparent', border: '1px solid var(--kBorder2)', color: 'var(--kFgMuted)', padding: '10px 22px', borderRadius: 10, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
}

// ============================================================
// SCREEN: ATTRACT
// ============================================================
function ScreenAttract({ brandName, brandColor, brandAccent, brandLogoUrl, attractVideoUrl, avgWaitMinutes, banner, ctaLabel, onStart }) {
  const accentEnd = brandAccent || shade(brandColor, -20);
  const [videoFailed, setVideoFailed] = useState(false);
  const showVideo = attractVideoUrl && !videoFailed;
  const useBannerAsBackground = (!attractVideoUrl || videoFailed) && banner && banner.imageUrl;
  return (
    <div onClick={onStart} style={{ position: 'absolute', inset: 0, cursor: 'pointer', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'linear-gradient(135deg, ' + brandColor + ' 0%, ' + accentEnd + ' 100%)' }}>
      {showVideo ? (
        <video src={attractVideoUrl} autoPlay loop muted playsInline
          onError={(e) => { console.warn('[kiosk] attract video failed to load (browser may not support format — try MP4):', attractVideoUrl, e); setVideoFailed(true); }}
          onLoadedData={() => console.log('[kiosk] attract video loaded')}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : useBannerAsBackground ? (
        <img src={banner.imageUrl} alt={banner.label || brandName} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : null}
      <div style={{ position: 'absolute', inset: 0, background: (attractVideoUrl || useBannerAsBackground) ? 'linear-gradient(180deg, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.6) 100%)' : 'radial-gradient(circle at 70% 30%, var(--kBorder2), transparent 60%)' }} />
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5vw', zIndex: 1 }}>
        {brandLogoUrl ? (
          <img src={brandLogoUrl} alt={brandName} style={{ maxWidth: '50%', maxHeight: '20vh', marginBottom: '3vh', objectFit: 'contain' }} />
        ) : null}
        <div style={{ fontSize: 'clamp(48px, 9vw, 96px)', fontWeight: 900, letterSpacing: '-0.04em', color: '#fff', textAlign: 'center', lineHeight: 1, marginBottom: '2vh', textShadow: '0 4px 30px rgba(0,0,0,0.3)' }}>{brandName}</div>
        {/* v5.4.0: subtitle removed */}
        {avgWaitMinutes ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', background: 'rgba(255,255,255,0.18)', backdropFilter: 'blur(10px)', borderRadius: 100, fontSize: 'clamp(13px, 1.8vw, 18px)', fontWeight: 600, color: '#fff', marginBottom: '6vh' }}>⏱ ~{avgWaitMinutes} min wait</div>
        ) : null}
        <div style={{ background: '#fff', color: shade(brandColor, -30), padding: 'clamp(18px, 3vh, 28px) clamp(40px, 8vw, 100px)', borderRadius: 100, fontSize: 'clamp(20px, 3vw, 28px)', fontWeight: 800, boxShadow: '0 10px 40px rgba(0,0,0,0.25)', animation: 'kioskPulse 2s infinite', letterSpacing: '-0.02em' }}>{ctaLabel || 'TAP TO ORDER'}</div>
      </div>
      <div style={{ position: 'relative', padding: '0 30px 30px', fontSize: 13, color: 'rgba(255,255,255,0.75)', textAlign: 'center', zIndex: 1 }}>Tap anywhere to begin</div>
      <style>{'@keyframes kioskPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }'}</style>
    </div>
  );
}
function shade(hex, percent) {
  // simple hex-shade helper
  if (!hex || !hex.startsWith('#')) return hex;
  const num = parseInt(hex.slice(1), 16);
  let r = (num >> 16) + Math.round(255 * percent / 100);
  let g = ((num >> 8) & 0xff) + Math.round(255 * percent / 100);
  let b = (num & 0xff) + Math.round(255 * percent / 100);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// ============================================================
// SCREEN: ORDER TYPE  (v5.5.18 redesign)
// Light surface, brand logo at top, outline cards with line-art
// SVG icons in brand color, language picker pill at the bottom.
// ============================================================
function ScreenOrderType({ brandColor, brandLogoUrl, brandName, tableMode, lang, onOpenLanguagePicker, onPick, onBack, onCancel, loyaltyEnabled, customerName, onLoyaltySignIn }) {
  const dineInAvailable = tableMode !== 'none';
  const langMeta = getLanguageMeta(lang);
  // Force re-render of t() strings when lang changes (parent already
  // subscribes via useKioskLang, but listing lang in deps for clarity).
  const title = t('orderType.title');
  return (
    <div style={fullScreen()}>
      {/* Top bar: back left, cancel right */}
      <div style={{ padding: '20px 22px 0', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack} aria-label={t('common.back')} style={iconBtn()}>{'←'}</button>
        <CancelOrderBtn onClick={onCancel} />
      </div>

      {/* Logo */}
      <div style={{ padding: '12px 24px 0', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        {brandLogoUrl ? (
          <img
            src={brandLogoUrl}
            alt={brandName || 'Brand logo'}
            style={{ maxWidth: '70%', maxHeight: '14vh', minHeight: 60, objectFit: 'contain' }}
          />
        ) : (
          <div style={{ fontSize: 'clamp(28px, 4.2vw, 44px)', fontWeight: 900, letterSpacing: '-0.02em', color: 'var(--kFg)' }}>
            {brandName || 'Order here'}
          </div>
        )}
      </div>

      {/* Title */}
      <div style={{ padding: '4vh 6vw 3vh', textAlign: 'center', flexShrink: 0 }}>
        <div style={{
          fontSize: 'clamp(30px, 5vw, 48px)',
          fontWeight: 800,
          letterSpacing: '-0.01em',
          color: brandColor,
          lineHeight: 1.15,
        }}>{title}</div>
      </div>

      {/* Cards — horizontally centered via margin:auto on the inner grid
          (deterministic across browsers); vertically centered via flex on parent. */}
      <div style={{ flex: 1, padding: '0 6vw', display: 'flex', alignItems: 'center' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: dineInAvailable ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
          gap: 'clamp(14px, 2.5vw, 24px)',
          width: '100%',
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}>
          {dineInAvailable && (
            <button onClick={() => onPick('dineIn')} style={otOutlineCard(brandColor)} aria-label={t('orderType.eatIn')}>
              <div style={otIconWrap()}>
                <EatInIcon color={brandColor} />
              </div>
              <div style={otCardLabel(brandColor)}>{t('orderType.eatIn')}</div>
            </button>
          )}
          <button onClick={() => onPick('takeaway')} style={otOutlineCard(brandColor)} aria-label={t('orderType.takeaway')}>
            <div style={otIconWrap()}>
              <TakeawayIcon color={brandColor} />
            </div>
            <div style={otCardLabel(brandColor)}>{t('orderType.takeaway')}</div>
          </button>
        </div>
      </div>

      {/* Loyalty sign-in prompt */}
      {loyaltyEnabled && (
        <div style={{ padding: '0 6vw 2vh', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          {customerName ? (
            <div style={{
              padding: 'clamp(12px, 1.6vw, 18px) clamp(20px, 2.6vw, 32px)',
              borderRadius: 16, background: brandColor + '15', border: '1.5px solid ' + brandColor + '44',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 'clamp(18px, 2.2vw, 24px)' }}>✦</span>
              <span style={{ fontSize: 'clamp(14px, 1.7vw, 18px)', fontWeight: 700, color: brandColor }}>
                Welcome back, {customerName}!
              </span>
            </div>
          ) : (
            <button onClick={onLoyaltySignIn} style={{
              padding: 'clamp(14px, 1.8vw, 20px) clamp(24px, 3vw, 40px)',
              borderRadius: 99, background: 'var(--kSurfaceRaised)',
              border: '1.5px solid ' + brandColor + '44',
              cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 10,
              boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
            }}>
              <span style={{ fontSize: 'clamp(18px, 2.2vw, 24px)' }}>⭐</span>
              <span style={{
                fontSize: 'clamp(15px, 1.8vw, 19px)', fontWeight: 800, color: brandColor,
              }}>
                {t('orderType.loyaltySignIn') || 'Sign in for rewards'}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Language pill */}
      <div style={{ padding: '1vh 6vw 4vh', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <button onClick={onOpenLanguagePicker} style={otLanguagePill(brandColor)} aria-label="Choose language">
          <span style={{ fontSize: 22, lineHeight: 1 }}>{langMeta.flag}</span>
          <span style={{ fontSize: 'clamp(15px, 1.8vw, 18px)', fontWeight: 700, color: brandColor }}>
            {langMeta.nativeName}
          </span>
        </button>
      </div>
    </div>
  );
}

// ----- ScreenOrderType styles + icon components -----

function otOutlineCard(brandColor) {
  return {
    background: 'var(--kSurfaceRaised)',
    border: '1.5px solid var(--kBorder3)',
    borderRadius: 28,
    padding: 'clamp(20px, 3vw, 32px)',
    // Grid with fixed rows so icon area and label area align identically
    // across both cards. Row 1 takes all available space and centers the
    // icon; row 2 is auto-sized for the label and sits at a consistent
    // vertical position regardless of icon dimensions.
    display: 'grid',
    gridTemplateRows: '1fr auto',
    rowGap: 'clamp(10px, 1.6vw, 18px)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    aspectRatio: '4/5',
    // v5.5.22: minHeight:28vh REMOVED. On a tall portrait kiosk viewport,
    // 28vh forced cards to be ~480px+ tall. Combined with aspectRatio:4/5
    // that implied each card wanted to be ~386px wide. With grid columns
    // capped at 720/2 = 348px, cards overflowed their cells and the entire
    // row shifted rightward. Letting aspect-ratio derive height from
    // column-determined width eliminates the conflict.
    width: '100%',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    transition: 'transform 0.12s, box-shadow 0.12s, border-color 0.12s',
    color: brandColor,
  };
}

function otIconWrap() {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    width: '100%',
  };
}

function otCardLabel(brandColor) {
  return {
    fontSize: 'clamp(20px, 3.2vw, 30px)',
    fontWeight: 700,
    color: brandColor,
    letterSpacing: '-0.01em',
    textAlign: 'center',
    lineHeight: 1.1,
  };
}

function otLanguagePill(brandColor) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 12,
    background: 'var(--kSurfaceRaised)',
    border: '1.5px solid var(--kBorder2)',
    borderRadius: 100,
    padding: '14px 28px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: brandColor,
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  };
}

function EatInIcon({ color = 'currentColor', size }) {
  // Line-art fork + knife in a 100x100 viewBox.
  // CRITICAL: content is bounded to y=18..y=82 to match TakeawayIcon
  // exactly, so when both render at the same pixel size their visible
  // top + bottom edges line up. Don't change one without the other.
  const dim = size || 'clamp(100px, 24vw, 170px)';
  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: dim, height: dim, display: 'block', flexShrink: 0 }}
      fill="none"
      stroke={color}
      strokeWidth="4.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Fork (left, centered around x=30): tines y=18..38, head y=38..46, handle y=46..82 */}
      <path d="M22 18 V38" />
      <path d="M30 18 V38" />
      <path d="M38 18 V38" />
      <path d="M22 38 H38 Q38 46 30 46 Q22 46 22 38 Z" />
      <path d="M30 46 V82" />
      {/* Knife (right, centered around x=70): blade y=18..48, handle y=48..82 */}
      <path d="M70 18 Q63 30 65 48 L75 48 Q77 30 70 18 Z" />
      <path d="M70 48 V82" />
    </svg>
  );
}

function TakeawayIcon({ color = 'currentColor', size }) {
  // Takeout container with wire handle in a 100x100 viewBox.
  // CRITICAL: content is bounded to y=18..y=82 to match EatInIcon exactly.
  // Wire handle peak sits at y=18, box floor at y=82.
  const dim = size || 'clamp(100px, 24vw, 170px)';
  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: dim, height: dim, display: 'block', flexShrink: 0 }}
      fill="none"
      stroke={color}
      strokeWidth="4.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Wire handle: peak y=18, anchors at y=32 */}
      <path d="M30 32 Q50 18 70 32" strokeWidth="3.5" />
      {/* Top edge of box (where flap folds over): y=32 */}
      <path d="M22 32 H78" />
      {/* Fold-over flap V */}
      <path d="M32 32 L50 40 L68 32" />
      {/* Box body — trapezoid from y=32 to y=82 */}
      <path d="M26 32 L34 82 H66 L74 32" />
      {/* Floor */}
      <path d="M34 82 H66" />
    </svg>
  );
}

// ============================================================
// SCREEN: LANGUAGE PICKER  (v5.5.18)
// ============================================================
function ScreenLanguagePicker({ brandColor, currentLang, onPick, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--kOverlay)', display: 'grid', placeItems: 'center', zIndex: 250, padding: 24 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--kSurfaceRaised)',
          border: '1.5px solid var(--kBorder2)',
          borderRadius: 24,
          padding: 'clamp(20px, 3vw, 32px)',
          width: '100%',
          maxWidth: 520,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ fontSize: 'clamp(20px, 3vw, 26px)', fontWeight: 800, color: brandColor, marginBottom: 18, textAlign: 'center' }}>
          {t('language.choose')}
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {LANGUAGES.map(L => {
            const selected = L.code === currentLang;
            return (
              <button
                key={L.code}
                onClick={() => onPick(L.code)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 18px',
                  background: selected ? brandColor : 'var(--kSurface1)',
                  color: selected ? '#fff' : 'var(--kFg)',
                  border: '1.5px solid ' + (selected ? brandColor : 'var(--kBorder2)'),
                  borderRadius: 14,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 17,
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 26, lineHeight: 1 }}>{L.flag}</span>
                <span style={{ flex: 1 }}>{L.nativeName}</span>
                <span style={{ fontSize: 13, opacity: 0.75 }}>{L.name}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 18,
            width: '100%',
            padding: '14px',
            background: 'transparent',
            color: 'var(--kFgMuted)',
            border: '1.5px solid var(--kBorder2)',
            borderRadius: 14,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {t('language.close')}
        </button>
      </div>
    </div>
  );
}


// ============================================================
// SCREEN: TABLE NUMBER  (v5.5.24 sizing pass)
// Larger keypad and CTAs, content vertically + horizontally
// centered on the full viewport. Back button is absolute-positioned
// so it doesn't displace the centered content column.
// ============================================================
function ScreenTableNumber({ brandColor, value, onChange, onContinue, onBack, onCancel, locationId }) {
  const [val, setVal] = useState(value || '');
  const press = (k) => setVal(v => k === '⌫' ? v.slice(0, -1) : (v.length < 4 ? v + k : v));
  const submit = () => { if (val.trim()) { onChange(val.trim()); onContinue(); } };
  const canSubmit = !!val.trim();

  // v5.5.912 — SHOW THE TABLES THAT ACTUALLY EXIST.
  // The keypad below is digits-only, so at a venue with a bar AND a restaurant a
  // customer at "B5" could only ever type "5" — a label no table has. Staff then had to
  // guess between B5 and T5. The labels themselves are already unambiguous (Back Office
  // refuses duplicates across a location), so the fix is simply to show them.
  //
  // The keypad is KEPT as the fallback, never removed: if the venue has configured no
  // tables, or the list cannot be read, a customer standing at the kiosk must still be
  // able to order. Losing the picker is an inconvenience; losing the order is not.
  const [tableList, setTableList] = useState(null);   // null = still loading
  useEffect(() => {
    let alive = true;
    fetchKioskTables(locationId)
      .then(r => { if (alive) setTableList(r.ok && r.tables.length ? r : { tables: [], sectionLabels: {} }); })
      .catch(() => { if (alive) setTableList({ tables: [], sectionLabels: {} }); });
    return () => { alive = false; };
  }, [locationId]);

  const pickTable = (label) => { onChange(label); onContinue(); };

  if (tableList && tableList.tables.length) {
    const groups = groupKioskTables(tableList.tables, tableList.sectionLabels);
    return (
      <div style={fullScreen()}>
        <button
          onClick={onBack}
          aria-label={t('common.back')}
          style={{ ...iconBtn(), position: 'absolute', top: 20, left: 22, zIndex: 5 }}
        >{'←'}</button>
        <div style={{ position: 'absolute', top: 20, right: 22, zIndex: 5 }}>
          <CancelOrderBtn onClick={onCancel} />
        </div>

        <div style={{
          flex: 1, padding: 'clamp(74px, 9vh, 104px) 6vw clamp(28px, 4vh, 44px)',
          width: '100%', maxWidth: 1100, marginLeft: 'auto', marginRight: 'auto',
          boxSizing: 'border-box', overflowY: 'auto',
        }}>
          <div style={{ paddingBottom: 'clamp(18px, 2.6vh, 30px)', textAlign: 'center' }}>
            <div style={{
              fontSize: 'clamp(34px, 5.4vw, 56px)', fontWeight: 800,
              letterSpacing: '-0.01em', color: brandColor, lineHeight: 1.15,
            }}>{t('tableNumber.title')}</div>
          </div>

          {groups.map((g, gi) => (
            <div key={g.sectionId || gi} style={{ marginBottom: 'clamp(18px, 2.4vh, 28px)' }}>
              {g.label && (
                <div style={{
                  fontSize: 'clamp(16px, 1.9vw, 22px)', fontWeight: 700, color: 'var(--kFgMuted)',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  margin: '0 0 clamp(10px, 1.4vh, 16px) 4px',
                }}>{g.label}</div>
              )}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(120px, 15vw, 180px), 1fr))',
                gap: 'clamp(10px, 1.4vw, 18px)',
              }}>
                {g.tables.map(tb => (
                  <button
                    key={tb.id}
                    onClick={() => pickTable(tb.label)}
                    style={{
                      background: 'var(--kSurfaceRaised)',
                      border: `1.5px solid ${val === tb.label ? brandColor : 'var(--kBorder2)'}`,
                      borderRadius: 20,
                      padding: 'clamp(22px, 2.8vw, 34px) 10px',
                      fontSize: 'clamp(22px, 2.6vw, 32px)',
                      fontWeight: 700,
                      color: 'var(--kFg)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      minHeight: 'clamp(84px, 10vh, 118px)',
                      wordBreak: 'break-word',
                    }}
                  >{tb.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={fullScreen()}>
      {/* Back button: absolute-positioned so it doesn't displace centered content */}
      <button
        onClick={onBack}
        aria-label={t('common.back')}
        style={{ ...iconBtn(), position: 'absolute', top: 20, left: 22, zIndex: 5 }}
      >{'←'}</button>
      <div style={{ position: 'absolute', top: 20, right: 22, zIndex: 5 }}>
        <CancelOrderBtn onClick={onCancel} />
      </div>

      {/* Centered content column. justify-content:center vertically centers
          inside fullScreen (which is position:absolute inset:0). margin auto
          horizontally centers within the 6vw padded viewport. */}
      <div style={{
        flex: 1,
        padding: '0 6vw',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        maxWidth: 820,
        marginLeft: 'auto',
        marginRight: 'auto',
        boxSizing: 'border-box',
      }}>
        {/* Title */}
        <div style={{ paddingBottom: 'clamp(20px, 3vh, 36px)', textAlign: 'center' }}>
          <div style={{
            fontSize: 'clamp(38px, 6.4vw, 64px)',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: brandColor,
            lineHeight: 1.15,
          }}>{t('tableNumber.title')}</div>
        </div>

        {/* Input-field-style display */}
        <div style={{
          background: 'var(--kSurfaceRaised)',
          border: '1.5px solid var(--kBorder2)',
          borderRadius: 22,
          padding: 'clamp(26px, 3.6vw, 40px) 28px',
          textAlign: 'center',
          fontSize: 'clamp(28px, 4vw, 40px)',
          fontWeight: 700,
          color: brandColor,
          letterSpacing: val ? '0.02em' : '-0.01em',
          fontFamily: val ? 'ui-monospace, monospace' : 'inherit',
        }}>
          {val || t('tableNumber.placeholder')}
        </div>

        {/* Keypad: 3x4 grid (1-9, blank-0-blank) */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 'clamp(12px, 1.8vw, 20px)',
          marginTop: 'clamp(18px, 2.6vw, 26px)',
        }}>
          {['1','2','3','4','5','6','7','8','9','','0',''].map((k, i) => (
            k === ''
              ? <div key={i} aria-hidden="true" />
              : <button key={i} onClick={() => press(k)} style={kpadKey()}>{k}</button>
          ))}
        </div>

        {/* Delete (full width below keypad) */}
        <button
          onClick={() => press('⌫')}
          disabled={!val}
          style={{
            background: 'var(--kSurfaceRaised)',
            border: '1.5px solid var(--kBorder2)',
            borderRadius: 22,
            padding: 'clamp(22px, 3vw, 34px)',
            fontSize: 'clamp(20px, 2.6vw, 28px)',
            fontWeight: 600,
            color: 'var(--kFg)',
            cursor: val ? 'pointer' : 'not-allowed',
            opacity: val ? 1 : 0.45,
            fontFamily: 'inherit',
            marginTop: 'clamp(12px, 1.8vw, 20px)',
            width: '100%',
          }}
        >
          {t('tableNumber.delete')}
        </button>

        {/* Continue (full width primary CTA) */}
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            background: brandColor,
            border: 0,
            borderRadius: 22,
            padding: 'clamp(26px, 3.6vw, 40px)',
            fontSize: 'clamp(24px, 3vw, 34px)',
            fontWeight: 700,
            color: '#fff',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.45,
            fontFamily: 'inherit',
            marginTop: 'clamp(20px, 3vw, 32px)',
            width: '100%',
          }}
        >
          {t('tableNumber.continue')}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SCREEN: MENU
// ============================================================
// ============================================================
// SCREEN: MENU  (v5.5.25 redesign)
// Layout pivot: from horizontal-pill categories + 3-col grid +
// top cart pill, to:
//   - LEFT SIDEBAR for categories (always visible, big bold text,
//     active state highlighted with brand-color background)
//   - 2-COL ITEM GRID (taller cards, bigger images, in-card "+ Add"
//     button as the primary affordance)
//   - FLOATING BOTTOM BAR for cart status + checkout CTA, only
//     visible when cart has items (hidden when empty so the menu
//     gets full vertical space)
//   - TOP BAR simplified to back button + allergen icon button
// All customer-facing strings translated via t().
// ============================================================
function ScreenMenu({ brandColor, brandAccent, categories, items, selectedCategoryId, onSelectCategory, onSelectItem, cartItemCount, subtotal, onCart, orderType, activeMenuId, banner, allergenFilter, onShowAllergenPicker, eightySixIds = [], dailyCounts = {}, onBack, onCancel }) {
  const hasCart = cartItemCount > 0;
  const hasAllergenFilter = allergenFilter && allergenFilter.size > 0;
  const itemWord = cartItemCount === 1 ? t('menu.itemSingular') : t('menu.itemPlural');
  return (
    <div style={fullScreen()}>
      {/* TOP BAR — back left, allergen filter center, cancel right */}
      <div style={{
        padding: 'clamp(14px, 2vw, 20px) clamp(16px, 2.4vw, 24px)',
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(12px, 1.6vw, 18px)',
        flexShrink: 0,
        borderBottom: '1px solid var(--kBorder1)',
      }}>
        <button onClick={onBack} aria-label={t('common.back')} style={iconBtnLg()}>{'←'}</button>

        {/* Allergen filter — prominent banner-button. Stretches to fill the
            top bar so it can't be missed. Amber when inactive, brand-active
            (with stronger fill + count badge) when filters are applied. */}
        <button
          onClick={onShowAllergenPicker}
          aria-label={hasAllergenFilter ? t('menu.allergens.editFilter') : t('menu.allergens.tap')}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 'clamp(10px, 1.4vw, 14px)',
            background: 'var(--kAllergen-bg)',
            border: '1.5px solid var(--kAllergen-border)',
            borderRadius: 16,
            padding: 'clamp(12px, 1.6vw, 18px) clamp(14px, 2vw, 22px)',
            color: 'var(--kAllergen-fg)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'left',
            minHeight: 'clamp(48px, 5.4vw, 60px)',
            boxSizing: 'border-box',
          }}
        >
          <span style={{
            flexShrink: 0,
            fontSize: 'clamp(22px, 2.6vw, 28px)',
            lineHeight: 1,
          }}>⚠</span>
          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.25 }}>
            {hasAllergenFilter ? (
              <>
                <div style={{
                  fontSize: 'clamp(11px, 1.3vw, 13px)',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  opacity: 0.8,
                }}>{t('menu.allergens.avoiding')}</div>
                <div style={{
                  fontSize: 'clamp(14px, 1.7vw, 17px)',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>{Array.from(allergenFilter).join(', ')}</div>
              </>
            ) : (
              <>
                <div style={{
                  fontSize: 'clamp(15px, 1.8vw, 18px)',
                  fontWeight: 800,
                  letterSpacing: '-0.01em',
                }}>{t('menu.allergens.haveAllergies')}</div>
                <div style={{
                  fontSize: 'clamp(12px, 1.4vw, 14px)',
                  fontWeight: 600,
                  opacity: 0.85,
                }}>{t('menu.allergens.tapToFilter')}</div>
              </>
            )}
          </span>
          <span style={{
            flexShrink: 0,
            fontSize: 'clamp(14px, 1.6vw, 17px)',
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}>
            {hasAllergenFilter && (
              <span style={{
                background: '#ef4444',
                color: '#fff',
                minWidth: 22,
                height: 22,
                borderRadius: 11,
                fontSize: 12,
                fontWeight: 800,
                display: 'inline-grid',
                placeItems: 'center',
                padding: '0 6px',
              }}>{allergenFilter.size}</span>
            )}
            <span>{hasAllergenFilter ? t('menu.allergens.editFilter') + ' ›' : '›'}</span>
          </span>
        </button>
        <CancelOrderBtn onClick={onCancel} />
      </div>

      {/* BODY — sidebar + items grid */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'clamp(180px, 22vw, 260px) 1fr',
      }}>
        {/* LEFT SIDEBAR — categories */}
        <div style={{
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 'clamp(14px, 2vw, 22px) clamp(10px, 1.4vw, 16px)',
          borderRight: '1px solid var(--kBorder1)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(4px, 0.6vw, 8px)',
          // Pad bottom so last category clears the floating checkout bar
          paddingBottom: hasCart ? 'clamp(120px, 16vw, 180px)' : 'clamp(14px, 2vw, 22px)',
        }}>
          {categories.length === 0 ? (
            <div style={{ padding: 16, fontSize: 14, color: 'var(--kFgMuted)' }}>{t('menu.noCategories')}</div>
          ) : categories.map(c => {
            const active = c.id === selectedCategoryId;
            return (
              <button
                key={c.id}
                onClick={() => onSelectCategory(c.id)}
                style={{
                  padding: 'clamp(14px, 2vw, 20px) clamp(14px, 1.8vw, 22px)',
                  background: active ? brandColor : 'transparent',
                  color: active ? '#fff' : brandColor,
                  borderRadius: 14,
                  fontSize: 'clamp(15px, 1.9vw, 20px)',
                  fontWeight: 700,
                  border: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.2,
                  transition: 'background 0.1s',
                }}
              >{c.label}</button>
            );
          })}
        </div>

        {/* RIGHT — items grid */}
        <div style={{
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: 'clamp(14px, 2vw, 22px)',
          // Pad bottom so last row clears the floating checkout bar
          paddingBottom: hasCart ? 'clamp(120px, 16vw, 180px)' : 'clamp(14px, 2vw, 22px)',
        }}>
          {/* Optional banner */}
          {banner && banner.imageUrl && (
            <div style={{
              width: '100%',
              borderRadius: 16,
              overflow: 'hidden',
              marginBottom: 'clamp(12px, 1.8vw, 18px)',
              aspectRatio: '5/2',
              background: 'var(--kSurface1)',
            }}>
              <img src={banner.imageUrl} alt={banner.label || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          )}

          {/* Allergen banner removed in v5.5.26 — top bar now carries this prominently. */}

          {/* 2-col item grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 'clamp(12px, 1.8vw, 18px)',
            alignContent: 'start',
          }}>
            {items.length === 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: 60, textAlign: 'center', color: 'var(--kFgMuted)', fontSize: 'clamp(14px, 1.7vw, 17px)' }}>{t('menu.empty')}</div>
            ) : items.map(it => {
              // v5.5.141/287: 86 awareness — operator 86, auto-86 from daily
              // count exhaustion, OR stock_levels remaining at zero. The third
              // check is a redundant safety net: if the eighty_six realtime
              // subscription misses an INSERT event on one browser, the stock
              // levels subscription (separate channel) still blocks the item.
              const is86 = eightySixIds.includes(it.id)
                || (it.parent_id && eightySixIds.includes(it.parent_id))
                || (dailyCounts[it.id] && dailyCounts[it.id].remaining <= 0);
              const stock = dailyCounts[it.id] || null;
              return (
                <MenuItemCard
                  key={it.id}
                  item={it}
                  price={resolvePrice(it, orderType, activeMenuId)}
                  brandColor={brandColor}
                  allergenFilter={allergenFilter}
                  is86={is86}
                  stock={stock}
                  onSelect={() => is86 ? null : onSelectItem(it)}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* FLOATING CHECKOUT BAR — only when cart has items */}
      {hasCart && (
        <div
          style={{
            position: 'absolute',
            left: 'clamp(12px, 1.6vw, 20px)',
            right: 'clamp(12px, 1.6vw, 20px)',
            bottom: 'clamp(12px, 1.6vw, 20px)',
            background: 'var(--kSurfaceCheckoutBar)',
            borderRadius: 22,
            padding: 'clamp(14px, 2vw, 22px) clamp(16px, 2.4vw, 26px)',
            display: 'flex',
            alignItems: 'center',
            gap: 'clamp(12px, 2vw, 24px)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.35), 0 4px 12px rgba(0,0,0,0.18)',
            zIndex: 50,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 'clamp(12px, 1.4vw, 14px)',
              color: brandColor,
              fontWeight: 700,
              letterSpacing: '0.02em',
              marginBottom: 4,
            }}>
              {t('menu.currentOrder')}
            </div>
            <div style={{
              fontSize: 'clamp(18px, 2.4vw, 24px)',
              fontWeight: 800,
              color: '#fff',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {cartItemCount} {itemWord} • {money(subtotal)}
            </div>
          </div>
          <button
            onClick={onCart}
            style={{
              background: brandColor,
              color: '#fff',
              border: 0,
              borderRadius: 16,
              padding: 'clamp(14px, 2vw, 22px) clamp(20px, 2.8vw, 32px)',
              fontSize: 'clamp(16px, 2vw, 20px)',
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('menu.goToCheckout')} →
          </button>
        </div>
      )}
    </div>
  );
}

// ----- MenuItemCard (extracted so the grid map stays readable) -----
function MenuItemCard({ item, price, brandColor, allergenFilter, onSelect, is86 = false, stock = null }) {
  const itemAllergens = Array.isArray(item.allergens) ? item.allergens.map(a => String(a).toLowerCase()) : [];
  const flagged = allergenFilter && Array.from(allergenFilter).some(a => itemAllergens.includes(String(a).toLowerCase()));
  return (
    <div
      onClick={is86 ? undefined : onSelect}
      role="button"
      tabIndex={is86 ? -1 : 0}
      onKeyDown={(e) => { if (!is86 && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(); } }}
      style={{
        background: 'var(--kSurfaceRaised)',
        border: '1px solid ' + (flagged ? 'rgba(239,68,68,0.5)' : 'var(--kBorder1)'),
        borderRadius: 20,
        overflow: 'hidden',
        cursor: is86 ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        color: 'var(--kFg)',
        opacity: is86 ? 0.45 : (flagged ? 0.45 : 1),
        filter: is86 ? 'grayscale(0.6)' : undefined,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* v5.5.144: OUT OF STOCK is now positioned over the IMAGE only. When
          the item has no image, it renders inline above the title (in the
          body block below) instead of floating over the product name. */}
      {is86 && item.image && (
        <div style={{
          position: 'absolute', top: 12, left: 12, zIndex: 2,
          background: '#1a1a1a', color: '#fff',
          padding: '5px 12px', borderRadius: 8,
          fontSize: 12, fontWeight: 800, letterSpacing: '0.04em',
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}>OUT OF STOCK</div>
      )}
      {flagged && (
        <div style={{
          position: 'absolute', top: 12, right: 12, zIndex: 2,
          background: '#ef4444', color: '#fff',
          padding: '5px 12px', borderRadius: 8,
          fontSize: 12, fontWeight: 800, letterSpacing: '0.04em',
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}>UNSAFE</div>
      )}
      {/* v5.5.239: low-stock badge */}
      {!is86 && !flagged && stock && stock.remaining > 0 && stock.remaining / stock.par <= 0.4 && (
        <div style={{
          position: 'absolute', top: 12, right: 12, zIndex: 2,
          background: '#f59e0b', color: '#fff',
          padding: '5px 12px', borderRadius: 8,
          fontSize: 12, fontWeight: 800, letterSpacing: '0.04em',
          boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
        }}>Only {stock.remaining} left</div>
      )}

      {/* Image (only render when available — no emoji placeholder) */}
      {item.image && (
        <div style={{
          width: '100%',
          aspectRatio: '4/3',
          flexShrink: 0,
          background: 'var(--kImageBg)',
          overflow: 'hidden',
        }}>
          <img src={item.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      )}

      {/* Body */}
      <div style={{
        padding: 'clamp(14px, 1.8vw, 20px) clamp(14px, 1.8vw, 20px) clamp(14px, 1.8vw, 20px)',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(6px, 1vw, 10px)',
      }}>
        {/* v5.5.144: inline OUT OF STOCK pill for items without an image —
            sits above the title so it can never overlap the product name.
            For items WITH an image the badge floats over the image instead
            (see absolute-positioned variant above). */}
        {is86 && !item.image && (
          <div style={{
            display: 'inline-block', alignSelf: 'flex-start',
            background: '#1a1a1a', color: '#fff',
            padding: '4px 10px', borderRadius: 8,
            fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
          }}>OUT OF STOCK</div>
        )}
        {/* Name + price */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            flex: 1,
            fontSize: 'clamp(17px, 2vw, 22px)',
            fontWeight: 800,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>{displayName(item)}</div>
          <div style={{
            fontSize: 'clamp(17px, 2vw, 22px)',
            fontWeight: 800,
            color: brandColor,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
          }}>{money(Number(price))}</div>
        </div>

        {/* Description */}
        {item.description && (
          <div style={{
            fontSize: 'clamp(13px, 1.5vw, 16px)',
            color: 'var(--kFgMuted)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>{item.description}</div>
        )}

        {/* Add button — visual affordance; same as card-tap */}
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          style={{
            marginTop: 'auto',
            background: brandColor,
            color: '#fff',
            border: 0,
            borderRadius: 100,
            padding: 'clamp(10px, 1.4vw, 14px) clamp(16px, 2vw, 22px)',
            fontSize: 'clamp(14px, 1.7vw, 17px)',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
          }}
        >
          <span style={{
            display: 'inline-grid',
            placeItems: 'center',
            width: 22, height: 22,
            borderRadius: 11,
            border: '1.5px solid #fff',
            fontSize: 14,
            fontWeight: 700,
            lineHeight: 1,
          }}>+</span>
          {t('menu.add')}
        </button>
      </div>
    </div>
  );
}

// Larger circular icon button (top bar)
function iconBtnLg() {
  return {
    width: 'clamp(44px, 5vw, 56px)',
    height: 'clamp(44px, 5vw, 56px)',
    borderRadius: '50%',
    background: 'var(--kSurface2)',
    display: 'grid',
    placeItems: 'center',
    fontSize: 'clamp(18px, 2.2vw, 24px)',
    color: 'var(--kFg)',
    border: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

// ============================================================
// ============================================================
// SCREEN: CART
// ============================================================
// ============================================================
// SCREEN: CART  (v5.5.36 redesign)
// Header: brand-color title left, outlined "View Allergens" right.
// Body: line cards with thumbnail + name + price + stepper + delete.
// Footer: "Items total" card + brand-color totals pill with item-count
// badge + circular back button on the left.
// ============================================================
function ScreenCart({ brandColor, cart, subtotal, cartItemCount, orderType, onUpdate, onAddMore, onContinue, onShowAllergenPicker, onBack, onCancel, dailyCounts = {} }) {
  const isPickup = orderType === 'takeaway';
  const titleKey = isPickup ? 'cart.title.pickup' : 'cart.title.dineIn';
  return (
    <div style={fullScreen()}>
      {/* Header — title left, View Allergens + Cancel right */}
      <div style={{
        padding: 'clamp(20px, 2.6vw, 28px) clamp(20px, 2.6vw, 28px) clamp(14px, 1.8vw, 18px)',
        display: 'flex',
        alignItems: 'center',
        gap: 'clamp(12px, 1.6vw, 18px)',
        flexShrink: 0,
      }}>
        <div style={{
          flex: 1,
          fontSize: 'clamp(22px, 3.2vw, 32px)',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: brandColor,
          minWidth: 0,
        }}>{t(titleKey)}</div>
        <button
          onClick={onShowAllergenPicker}
          style={{
            background: 'transparent',
            border: '1.5px solid ' + brandColor,
            borderRadius: 16,
            padding: 'clamp(14px, 1.8vw, 20px) clamp(20px, 2.6vw, 30px)',
            color: brandColor,
            fontSize: 'clamp(15px, 1.8vw, 19px)',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >{t('cart.viewAllergens')}</button>
        <CancelOrderBtn onClick={onCancel} />
      </div>

      {/* Cart line list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '0 clamp(20px, 2.6vw, 28px)',
      }}>
        {cart.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: 'var(--kFgMuted)', fontSize: 'clamp(15px, 1.8vw, 18px)' }}>
            {t('cart.empty')}
          </div>
        ) : (
          <>
            {cart.map(l => {
              // v5.5.285: Stock cap for cart qty increment
              const stock = dailyCounts[l.item?.id] || null;
              const atStockLimit = stock && l.qty >= stock.remaining;
              return (
                <CartLineCard
                  key={l.key}
                  line={l}
                  brandColor={brandColor}
                  onInc={atStockLimit ? undefined : () => onUpdate(l.key, +1)}
                  onDec={() => onUpdate(l.key, -1)}
                  onRemove={() => onUpdate(l.key, -l.qty)}
                  atStockLimit={atStockLimit}
                />
              );
            })}
            <button
              onClick={onAddMore}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'center',
                padding: 'clamp(16px, 2vw, 20px)',
                marginTop: 'clamp(8px, 1vw, 12px)',
                fontSize: 'clamp(14px, 1.6vw, 16px)',
                color: 'var(--kFgMuted)',
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >{t('cart.addMore')}</button>
          </>
        )}
      </div>

      {/* Footer — Items total card on top, totals pill + back below */}
      <div style={{
        padding: '0 clamp(20px, 2.6vw, 28px) clamp(20px, 2.6vw, 28px)',
        flexShrink: 0,
      }}>
        {/* Items total card */}
        <div style={{
          background: 'var(--kSurfaceRaised)',
          borderRadius: 16,
          padding: 'clamp(18px, 2.2vw, 24px) clamp(20px, 2.6vw, 28px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'clamp(12px, 1.6vw, 16px)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        }}>
          <span style={{
            fontSize: 'clamp(18px, 2.2vw, 22px)',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: 'var(--kFg)',
          }}>{t('cart.itemsTotal')}</span>
          <span style={{
            fontSize: 'clamp(18px, 2.2vw, 22px)',
            fontWeight: 800,
            color: 'var(--kFg)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
          }}>{money(subtotal)}</span>
        </div>

        {/* Totals row — circular back button + brand-fill pill with count badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(10px, 1.4vw, 14px)',
        }}>
          <button
            onClick={onBack}
            aria-label={t('common.back')}
            style={{
              flexShrink: 0,
              width: 'clamp(54px, 6vw, 70px)',
              height: 'clamp(54px, 6vw, 70px)',
              borderRadius: '50%',
              background: 'var(--kSurfaceRaised)',
              border: '1.5px solid var(--kBorder1)',
              color: 'var(--kFg)',
              fontSize: 'clamp(22px, 2.6vw, 28px)',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'grid',
              placeItems: 'center',
            }}
          >‹</button>

          <button
            onClick={onContinue}
            disabled={cart.length === 0}
            style={{
              flex: 1,
              background: cart.length === 0 ? 'var(--kSurface2)' : brandColor,
              color: cart.length === 0 ? 'var(--kFgFaint)' : '#fff',
              border: 0,
              borderRadius: 'clamp(28px, 3.2vw, 38px)',
              padding: 'clamp(16px, 2vw, 22px) clamp(22px, 2.6vw, 30px)',
              cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: 'clamp(12px, 1.6vw, 18px)',
              boxShadow: cart.length === 0 ? 'none' : '0 8px 24px rgba(0,0,0,0.18)',
            }}
          >
            {/* Item count badge — white circle with brand-color number */}
            <span style={{
              flexShrink: 0,
              width: 'clamp(36px, 4vw, 46px)',
              height: 'clamp(36px, 4vw, 46px)',
              borderRadius: '50%',
              background: '#fff',
              color: brandColor,
              display: 'grid',
              placeItems: 'center',
              fontSize: 'clamp(16px, 2vw, 20px)',
              fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
            }}>{cartItemCount}</span>

            <span style={{
              flex: 1,
              textAlign: 'left',
              fontSize: 'clamp(17px, 2.2vw, 22px)',
              fontWeight: 700,
              letterSpacing: '-0.01em',
            }}>{t('cart.totalToPay')}</span>

            <span style={{
              flexShrink: 0,
              fontSize: 'clamp(18px, 2.4vw, 24px)',
              fontWeight: 800,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
            }}>{money(subtotal)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- CartLineCard (extracted) -----
function CartLineCard({ line, brandColor, onInc, onDec, onRemove, atStockLimit }) {
  const img = line.item?.image;
  return (
    <div style={{
      background: 'var(--kSurfaceRaised)',
      borderRadius: 16,
      padding: 'clamp(12px, 1.6vw, 16px)',
      marginBottom: 'clamp(10px, 1.4vw, 14px)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'clamp(12px, 1.6vw, 18px)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
    }}>
      {/* Thumbnail */}
      {img ? (
        <div style={{
          flexShrink: 0,
          width: 'clamp(64px, 7.5vw, 92px)',
          height: 'clamp(64px, 7.5vw, 92px)',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--kImageBg)',
        }}>
          <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      ) : null}

      {/* Body */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'clamp(8px, 1.2vw, 12px)' }}>
        {/* Name + price row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            flex: 1,
            fontSize: 'clamp(15px, 1.9vw, 20px)',
            fontWeight: 800,
            color: 'var(--kFg)',
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minWidth: 0,
          }}>{line.name}</div>
          <div style={{
            fontSize: 'clamp(15px, 1.9vw, 20px)',
            fontWeight: 800,
            color: 'var(--kFg)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
          }}>{money(line.lineTotal)}</div>
        </div>

        {/* Modifier summary */}
        {line.mods && (
          <div style={{
            fontSize: 'clamp(12px, 1.4vw, 14px)',
            color: 'var(--kFgMuted)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>{line.mods}</div>
        )}

        {/* Stepper + delete */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(10px, 1.4vw, 14px)' }}>
          {/* Pill stepper — outlined to match reference */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'clamp(8px, 1vw, 12px)',
            background: 'var(--kSurface1)',
            border: '1.5px solid ' + brandColor,
            borderRadius: 100,
            padding: 'clamp(3px, 0.5vw, 5px)',
          }}>
            <button
              onClick={onDec}
              disabled={line.qty <= 1}
              style={cartStepBtn(brandColor, line.qty > 1, false)}
            >−</button>
            <div style={{
              fontSize: 'clamp(16px, 2vw, 20px)',
              fontWeight: 800,
              minWidth: 'clamp(18px, 2vw, 22px)',
              textAlign: 'center',
              color: 'var(--kFg)',
              fontVariantNumeric: 'tabular-nums',
            }}>{line.qty}</div>
            <button
              onClick={onInc}
              disabled={atStockLimit}
              style={cartStepBtn(brandColor, !atStockLimit, true)}
            >+</button>
          </div>

          {/* Trash icon — circular, outlined */}
          <button
            onClick={onRemove}
            aria-label="Remove"
            style={{
              flexShrink: 0,
              width: 'clamp(40px, 4.4vw, 50px)',
              height: 'clamp(40px, 4.4vw, 50px)',
              borderRadius: '50%',
              background: 'transparent',
              border: '1.5px solid var(--kBorder2)',
              color: 'var(--kFg)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" width="clamp(16, 1.8vw, 20)" height="clamp(16, 1.8vw, 20)" style={{ width: 'clamp(16px, 1.8vw, 20px)', height: 'clamp(16px, 1.8vw, 20px)' }} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6 H21" />
              <path d="M8 6 V4 H16 V6" />
              <path d="M5 6 L6 20 H18 L19 6" />
              <path d="M10 11 V16" />
              <path d="M14 11 V16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// Stepper button — minus is muted background, plus is brand fill (matches reference)
function cartStepBtn(brandColor, enabled, isPlus) {
  return {
    width: 'clamp(36px, 4vw, 44px)',
    height: 'clamp(36px, 4vw, 44px)',
    borderRadius: '50%',
    background: isPlus
      ? (enabled ? brandColor : 'var(--kSurface2)')
      : (enabled ? 'var(--kSurface2)' : 'var(--kSurface1)'),
    color: isPlus ? '#fff' : 'var(--kFg)',
    border: 0,
    fontSize: 'clamp(18px, 2vw, 22px)',
    fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.4,
    fontFamily: 'inherit',
  };
}

// ============================================================
// SCREEN: TIP
// ============================================================
function ScreenTip({ brandColor, subtotal, tipPresets, tip, onSetTip, onContinue, onBack, onCancel }) {
  const [customMode, setCustomMode] = useState(false);
  const [customStr, setCustomStr] = useState(tip > 0 ? tip.toFixed(2) : '');
  const pickPercent = (pct) => { onSetTip(+(subtotal * pct / 100).toFixed(2)); setCustomMode(false); };
  const pickNone = () => { onSetTip(0); setCustomMode(false); setCustomStr(''); };
  const setCustomFromInput = (s) => {
    setCustomStr(s);
    const v = parseFloat(s);
    onSetTip(isNaN(v) ? 0 : v);
  };
  const isPctActive = (pct) => Math.abs(tip - subtotal * pct / 100) < 0.01;
  return (
    <div style={fullScreen()}>
      <ScreenHeader title="Add a tip?" subtitle="Tips go directly to the team. Thank you!" onBack={onBack} onCancel={onCancel} brandColor={brandColor} />
      <div style={{ flex: 1, padding: '4vh 5vw', display: 'flex', flexDirection: 'column', gap: '2vh' }}>
        {tipPresets.map(pct => (
          <button key={pct} onClick={() => pickPercent(pct)} style={{
            ...bigCard(brandColor),
            borderColor: isPctActive(pct) ? brandColor : 'transparent',
            background: isPctActive(pct) ? 'rgba(249,115,22,0.06)' : 'var(--kSurface1)',
          }}>
            <div style={{ fontSize: 'clamp(28px, 5vw, 44px)', fontWeight: 900, color: brandColor, minWidth: '4ch' }}>{pct}%</div>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontSize: 'clamp(13px, 1.7vw, 16px)', color: 'var(--kFgMuted)' }}>Tip amount</div>
              <div style={{ fontSize: 'clamp(20px, 2.8vw, 26px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money((subtotal * pct / 100))}</div>
            </div>
          </button>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <button onClick={pickNone} style={{ ...smallCard(brandColor), borderColor: tip === 0 ? brandColor : 'transparent', background: tip === 0 ? 'rgba(249,115,22,0.06)' : 'var(--kSurface1)' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>No tip</div>
          </button>
          <button onClick={() => setCustomMode(true)} style={{ ...smallCard(brandColor), borderColor: customMode ? brandColor : 'transparent', background: customMode ? 'rgba(249,115,22,0.06)' : 'var(--kSurface1)' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Custom amount</div>
          </button>
        </div>
        {customMode && (
          <div style={{ background: 'var(--kSurface1)', border: '1px solid var(--kSurface2)', borderRadius: 14, padding: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--kFgMuted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Custom tip (£)</div>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 22, color: 'var(--kFgFaint)', fontFamily: 'ui-monospace, monospace' }}>£</span>
              <input type="number" step="0.01" min="0" value={customStr} onChange={e => setCustomFromInput(e.target.value)}
                placeholder="0.00" autoFocus
                style={{ width: '100%', padding: '14px 14px 14px 36px', background: 'var(--kSurface2)', border: '1px solid var(--kBorder1)', borderRadius: 10, color: 'var(--kFg)', fontSize: 22, fontFamily: 'ui-monospace, monospace', fontWeight: 700, outline: 'none' }} />
            </div>
          </div>
        )}
      </div>
      <div style={{ padding: '14px 22px 22px', flexShrink: 0 }}>
        <button onClick={onContinue} style={{ ...primaryCta(brandColor), width: '100%' }}>
          Continue · {money((subtotal + tip))} →
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SCREEN: GIFT CARD / PROMO CODE (v5.5.900)
// Dedicated checkout step BEFORE payment starts — mirrors online ordering's
// gift step. The entry point used to live on the pay screen gated on
// cardState === 'idle', but that screen auto-starts the card reader on mount,
// so guests never saw it. Sits AFTER the loyalty screen because linked gift
// cards ride in on the OTP-verified loyalty payload. ONE field takes a gift
// card OR promo code (gift lookup miss → promo validate fallthrough, same as
// the POS GiftCardEntry).
//
// v5.5.901: gift cards are APPLY-ONLY here, like promo codes and loyalty rewards.
// This screen only LOOKS UP the balance (gift-lookup — read-only) and stages the
// discount; the debit fires at submitOrder. Until now gift-redeem was called with
// `order_id: null` the moment a code was entered, so an abandoned basket, an idle
// timeout or a declined card burned the card's value with no order and no reversal.
// ============================================================
function ScreenGiftPromo({ brandColor, total, loyaltyCredit, giftCardCredit, promoCredit = 0, promoApplied = null, onPromoApply, verifiedLoyalty, giftCardPayment, onGiftCardApply, locationId, loyaltyRedemption, notice = '', onContinue, onBack, onCancel }) {
  const [giftApplying, setGiftApplying] = useState(false);
  // v5.5.901: `notice` carries a commit-time failure back here (a gift-only order whose card
  // came up short at submit) so the guest is told why they're being asked to pay after all.
  const [giftError, setGiftError] = useState(notice);
  const [manualGCCode, setManualGCCode] = useState('');

  // Linked gift cards from OTP-verified loyalty data (one gift card per order)
  const availableGiftCards = verifiedLoyalty?.giftCards?.filter(gc => (gc.balance || 0) > 0) || [];
  const hasGiftCards = availableGiftCards.length > 0 && !giftCardPayment;

  // v5.5.265: Apply a linked gift card to this order.
  // v5.5.901: staging only — the balance rode in on the OTP-verified loyalty payload, so
  // there is nothing to fetch and nothing to debit until the order commits. Both code and
  // card_id are carried through: code_plain is null on some cards, card_id always works.
  const applyGiftCard = (gc) => {
    setGiftError('');
    const amountDueMinor = Math.round(total * 100);
    if (amountDueMinor <= 0) { setGiftError('Nothing left to pay on this order.'); return; }
    onGiftCardApply(stageGiftCard({
      cardId: gc.id,
      code: gc.code || null,
      codeLast4: gc.last4 || null,
      balanceMinor: gc.balance || 0,
      amountDueMinor,
    }));
  };

  // Validate a code as a promo/offer. Returns true when it was applied. Promo codes only
  // VALIDATE here — the redemption is recorded at submitOrder, so an abandoned basket costs
  // the customer nothing (unlike gift cards, which the server debits on apply).
  const tryPromoCode = async (code, token) => {
    if (promoApplied || typeof onPromoApply !== 'function') return false;
    try {
      const pv = await fetch(`${OPS_URL}/functions/v1/promo-redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'validate', code, location_id: locationId,
          // v5.5.888: OTP-verified customer identity — lets customer-locked (personal)
          // codes validate at the kiosk and per-customer limits count correctly.
          customer_id: verifiedLoyalty?.customer?.id || null,
          basket: { subtotal: total },
        }),
      });
      const pj = await pv.json().catch(() => ({}));
      if (pv.ok && pj.valid) {
        onPromoApply({
          code,
          code_id: pj.code_id,
          offer_id: pj.offer?.id || null,
          label: pj.discount?.label || pj.offer?.name || 'Promo code',
          amount: pj.discount?.amount || 0,
        });
        setManualGCCode('');
        return true;
      }
    } catch { /* fall through to the caller's error */ }
    return false;
  };

  // v5.5.281: Apply a gift card by manually entered code (guest checkout)
  // v5.5.290: If the card has insufficient balance for the full order, apply whatever
  // balance IS available and let the customer pay the remainder by card — no error shown,
  // just partial credit. That now falls out of stageGiftCard's min(balance, due).
  // v5.5.900: ONE gift card per order — giftCardPayment holds a single card, so a second
  // one would overwrite the first. The old pay screen enforced this by hiding the field
  // entirely; this step keeps it usable for a PROMO code instead of dead-ending the guest.
  // v5.5.901: gift-lookup (READ-ONLY) replaces the old gift-redeem call. Nothing is debited
  // until submitOrder, so a guest who walks away keeps every penny on their card.
  const redeemManualGiftCard = async () => {
    const code = manualGCCode.trim();
    if (!code) return;
    if (total <= 0) { setGiftError('Nothing left to pay on this order.'); return; }
    setGiftApplying(true);
    setGiftError('');
    try {
      const token = await ensureAuthToken();
      if (!token) throw new Error('Auth unavailable');
      const amountDueMinor = Math.round(total * 100);
      // A gift card is already applied → this code can only be a promo.
      if (giftCardPayment) {
        const ok = await tryPromoCode(code, token);
        if (!ok) setGiftError('Code not recognised. One gift card per order — this can be a promo code.');
        return;
      }
      // Gift codes are exactly 16 chars once separators are stripped (gift-lookup rejects
      // anything else). Shorter input can only be a promo — don't waste a round trip.
      const stripped = code.replace(/[\s-]/g, '').toUpperCase();
      if (stripped.length !== 16) {
        if (await tryPromoCode(code, token)) return;
        throw new Error('Code not recognised');
      }
      const res = await fetch(`${OPS_URL}/functions/v1/gift-lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: stripped, location_id: locationId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) {
        // v5.5.887: not a usable gift card — try the SAME code as a promo/offer code before
        // erroring, so one field handles both (mirrors the POS GiftCardEntry fallthrough).
        if (await tryPromoCode(code, token)) return;
        throw new Error(j.error === 'Card not found' ? 'Code not recognised' : (j.error || `HTTP ${res.status}`));
      }
      if (j.status !== 'active') throw new Error(`Card is ${j.status}`);
      if (!(j.balance > 0)) throw new Error('Card has zero balance');
      // gift-redeem rejects an expired card at commit; catch it here so the guest finds out
      // now rather than after they've paid the reduced amount on the reader.
      if (j.expires_at && new Date(j.expires_at) < new Date()) throw new Error('Card has expired');

      onGiftCardApply(stageGiftCard({
        cardId: j.card_id,
        code: stripped,
        codeLast4: j.code_last4,
        balanceMinor: j.balance,
        amountDueMinor,
      }));
      setManualGCCode('');
    } catch (e) {
      setGiftError(e?.message || 'Could not apply gift card');
    } finally {
      setGiftApplying(false);
    }
  };

  const fullyCovered = total <= 0;

  return (
    <div style={fullScreen()}>
      <ScreenHeader title="Gift card or promo code?" subtitle="Apply a code below, or continue straight to payment" onBack={onBack} onCancel={onCancel} brandColor={brandColor} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '3vh 5vw', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(12px, 2vh, 20px)' }}>

        {/* Applied credits */}
        {(loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) && (
          <div style={{ width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loyaltyCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', borderRadius: 10, background: '#22c55e15', border: '1px solid #22c55e33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>✓ {loyaltyRedemption?.reward_name || 'Loyalty reward'}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: '#22c55e' }}>-{money(loyaltyCredit)}</span>
              </div>
            )}
            {giftCardCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: brandColor + '15', border: '1px solid ' + brandColor + '33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: brandColor }}>
                  ✓ Gift card applied{giftCardPayment?.code_last4 ? ` ···${giftCardPayment.code_last4}` : ''}
                </span>
                {/* v5.5.901: removable now that apply consumes nothing — the card is only
                    debited at submitOrder, so taking it off costs the customer nothing. */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: brandColor }}>-{money(giftCardCredit)}</span>
                  <button onClick={() => { setGiftError(''); onGiftCardApply(null); }}
                    style={{ background: 'none', border: 'none', color: brandColor, fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
                </span>
              </div>
            )}
            {promoCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: '#f59e0b15', border: '1px solid #f59e0b33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>✓ {promoApplied?.label || 'Promo code'} ({promoApplied?.code})</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: '#f59e0b' }}>-{money(promoCredit)}</span>
                  <button onClick={() => onPromoApply && onPromoApply(null)} style={{ background: 'none', border: 'none', color: '#f59e0b', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
                </span>
              </div>
            )}
          </div>
        )}

        {/* Linked gift cards (OTP-signed-in members) */}
        {hasGiftCards && (
          <div style={{ width: '100%', maxWidth: 440 }}>
            <div style={{ fontSize: 'clamp(12px, 1.4vw, 14px)', fontWeight: 700, color: brandColor, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
              Your gift cards
            </div>
            {availableGiftCards.map(gc => (
              <button key={gc.id} onClick={() => applyGiftCard(gc)} disabled={giftApplying}
                style={{
                  width: '100%', padding: 'clamp(12px, 1.6vw, 16px)', borderRadius: 14, marginBottom: 8,
                  border: '1.5px solid ' + brandColor + '44', background: 'var(--kSurfaceRaised)',
                  cursor: giftApplying ? 'wait' : 'pointer', fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 12, opacity: giftApplying ? 0.6 : 1,
                }}>
                <span style={{ fontSize: 22 }}>💳</span>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--kFg)' }}>Gift Card {gc.last4 ? `···${gc.last4}` : ''}</div>
                  <div style={{ fontSize: 12, color: 'var(--kFgMuted)' }}>Balance: {money(((gc.balance || 0) / 100))}</div>
                </div>
                <span style={{ fontSize: 14, fontWeight: 800, color: brandColor }}>{giftApplying ? '...' : 'Apply'}</span>
              </button>
            ))}
          </div>
        )}

        {/* Manual code entry — open on arrival (the whole point of this step).
            Hidden once BOTH a gift card and a promo are applied: nothing left to accept. */}
        {!(giftCardPayment && promoApplied) && total > 0 && (
          <div style={{ width: '100%', maxWidth: 440 }}>
            <div style={{ padding: 16, borderRadius: 14, background: 'var(--kSurfaceRaised)', border: '1.5px solid ' + brandColor + '33' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--kFg)', marginBottom: 10 }}>
                {giftCardPayment ? '🏷️ Enter a promo code' : '🎁 Enter gift card or promo code'}
              </div>
              {giftError && (
                <div style={{ padding: 8, borderRadius: 8, marginBottom: 8, fontSize: 13, color: '#e55', background: '#e5555515', border: '1px solid #e5555533', fontWeight: 600 }}>{giftError}</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={manualGCCode}
                  onChange={e => setManualGCCode(e.target.value.toUpperCase())}
                  placeholder={giftCardPayment ? 'e.g. WELCOME10' : 'e.g. ABCD-1234-EFGH'}
                  style={{
                    flex: 1, padding: '12px 14px', borderRadius: 10, fontSize: 16, fontWeight: 600,
                    fontFamily: 'var(--font-mono, monospace)', letterSpacing: '.05em', textTransform: 'uppercase',
                    border: '1.5px solid var(--kBorder)', background: 'var(--kSurface)', color: 'var(--kFg)',
                    outline: 'none',
                  }}
                  onKeyDown={e => { if (e.key === 'Enter' && manualGCCode.trim()) redeemManualGiftCard(); }}
                />
                <button onClick={redeemManualGiftCard} disabled={giftApplying || !manualGCCode.trim()}
                  style={{
                    padding: '12px 20px', borderRadius: 10, border: 'none',
                    background: manualGCCode.trim() ? brandColor : brandColor + '44',
                    color: '#fff', fontWeight: 800, fontSize: 14, cursor: giftApplying ? 'wait' : 'pointer',
                    fontFamily: 'inherit', opacity: giftApplying ? 0.6 : 1,
                  }}>
                  {giftApplying ? '...' : 'Apply'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Amount remaining */}
        <div style={{ textAlign: 'center', marginTop: 'clamp(4px, 1vh, 10px)' }}>
          <div style={{ fontSize: 13, color: 'var(--kFgMuted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
            {fullyCovered ? 'Nothing left to pay' : 'Left to pay'}
          </div>
          <div style={{ fontSize: 'clamp(32px, 6vw, 48px)', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: fullyCovered ? '#22c55e' : 'var(--kFg)' }}>
            {money(Math.max(0, total))}
          </div>
        </div>
      </div>

      {/* Bottom CTA — disabled while a gift card apply is in flight, otherwise the customer
          can advance to the reader before `total` has dropped and be charged the pre-gift amount. */}
      <div style={{ padding: '14px 22px 22px', flexShrink: 0 }}>
        <button onClick={onContinue} disabled={giftApplying}
          style={{ ...primaryCta(brandColor), width: '100%', opacity: giftApplying ? 0.5 : 1, cursor: giftApplying ? 'wait' : 'pointer' }}>
          {giftApplying ? 'Applying code…' : fullyCovered ? 'Continue →' : `Continue to payment · ${money(total)} →`}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SCREEN: PAY
// ============================================================
function ScreenPay({ brandColor, total, loyaltyCredit, giftCardCredit, promoCredit = 0, promoApplied = null, locationId, kioskId, cart, submitting, error, onPaid, onBack, loyaltyRedemption, onCancel }) {
  const [cardState, setCardState] = useState('idle'); // idle | processing | collecting | success | error | declined
  const [cardError, setCardError] = useState(null);
  const [cardStatusMsg, setCardStatusMsg] = useState('');
  const pollAbortRef = useRef(false);
  const activeReaderRef = useRef(null); // track reader ID for cancel on timeout/unmount
  const activePiRef = useRef(null);     // track PI ID for cancel
  // v5.5.871 — Ryft PAX terminal path
  const activeRyftJobRef = useRef(null);        // live terminal_jobs id, for cancel on abort
  const ryftAbortRef = useRef(null);            // AbortController for pollTerminalJob
  const payNonceRef = useRef(0);                // unique leg per payment attempt (checkKey mutex)
  // v5.5.900: gift card / promo entry moved to its own checkout step (ScreenGiftPromo)
  // BEFORE this screen — it was unreachable here because card payment auto-starts on mount.

  // Cancel active reader action (timeout, unmount, or back navigation).
  // v5.5.871: handles BOTH processors — a Stripe reader action AND a live Ryft PAX
  // terminal job (which cancelTerminalJob voids on the machine + settles).
  const cancelReaderAction = useCallback(async () => {
    // Ryft PAX terminal job
    const ryftJobId = activeRyftJobRef.current;
    if (ryftJobId) {
      activeRyftJobRef.current = null;
      try { ryftAbortRef.current?.abort(); } catch { /* noop */ }
      try {
        const r = await cancelTerminalJob(ryftJobId);
        console.log('[kiosk] cancelled Ryft terminal job:', ryftJobId, r?.status || r?.reason || '');
      } catch (e) { console.warn('[kiosk] cancel Ryft job failed:', e?.message || e); }
    }
    // Stripe reader action
    const readerId = activeReaderRef.current;
    const piId = activePiRef.current;
    if (!readerId) return;
    activeReaderRef.current = null;
    activePiRef.current = null;
    try {
      const token = await ensureAuthToken();
      if (!token) return;
      await fetch(`${OPS_URL}/functions/v1/stripe-cancel-reader-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ reader_id: readerId, location_id: locationId, ...(piId ? { payment_intent_id: piId } : {}) }),
      });
      console.log('[kiosk] cancelled reader action:', readerId);
    } catch (e) {
      console.warn('[kiosk] cancel reader action failed:', e?.message || e);
    }
  }, [locationId]);

  // Cleanup: cancel reader + stop polling on unmount
  useEffect(() => () => {
    pollAbortRef.current = true;
    cancelReaderAction();
  }, []);


  // v5.5.871: Ryft PAX terminal payment — reuses the POS "send to terminal" job
  // path (findPaxTerminal → dispatchTerminalJob → pollTerminalJob) as a pure charge
  // TRANSPORT. The kiosk still books its own order_queue via submitOrder() on
  // success (onPaid), so the job carries a throwaway closed_check_id and a
  // 'kiosk_send_to_terminal' source the POS reconciler deliberately ignores
  // (RECONCILABLE_SOURCES) — NO closed_check is ever created for a kiosk sale.
  const startRyftTerminalPayment = async () => {
    try {
      const { terminal, reason } = await findPaxTerminal({ posDeviceId: kioskId });
      if (!terminal) {
        setCardState('error');
        setCardError(reason
          || 'No card terminal is available. Assign one to this kiosk in Back Office → Kiosks → Settings → Card terminal.');
        return;
      }

      const dueMinor = Math.round(total * 100);           // `total` already includes the kiosk tip
      const nonce = ++payNonceRef.current;
      const checkKey = buildCheckKey({ locationId, tableId: null, sessionId: null, leg: `kiosk-${kioskId}-${nonce}` });
      const closedCheckId = `chk-kiosk-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${nonce}`}`;

      const { job } = await dispatchTerminalJob({
        checkKey,
        targetTerminalId: terminal.id,
        posDeviceId: kioskId,
        tipBasisMinor: dueMinor,
        dueMinor,
        suppressTip: true,        // kiosk collects the tip in its own screen — never re-prompt on the PAX
        closedCheckId,
        checkDraft: { source: 'kiosk_send_to_terminal', locationId },
        currency: (stripeCurrency() || 'gbp').toUpperCase(),
      });

      activeRyftJobRef.current = job.id;
      setCardState('collecting');
      setCardStatusMsg('Follow the prompts on the card machine');

      const controller = new AbortController();
      ryftAbortRef.current = controller;
      const finalJob = await pollTerminalJob(job.id, {
        signal: controller.signal,
        onUpdate: (j) => {
          if (j.status === 'charging' || j.status === 'charging_unsent' || j.status === 'tipping') {
            setCardStatusMsg('Customer is paying on the card machine');
          }
        },
      });
      activeRyftJobRef.current = null;
      ryftAbortRef.current = null;

      if (finalJob?.status === 'approved') {
        setCardState('success');
        setCardStatusMsg('Payment approved');
        setTimeout(() => onPaid(), 800);
      } else if (['declined', 'cancelled', 'expired'].includes(finalJob?.status)) {
        setCardState('declined');
        setCardError(finalJob?.decline_reason || 'Payment was not completed. Please try again.');
      } else {
        // unknown / needs_human — NEVER book an order on an unproven charge.
        setCardState('error');
        setCardError('The payment could not be confirmed. Please ask a member of staff before trying again.');
      }
    } catch (e) {
      activeRyftJobRef.current = null;
      ryftAbortRef.current = null;
      if (e?.name === 'AbortError') return;   // cancelled / unmounted — not a failure
      console.warn('[kiosk] Ryft terminal payment failed:', e?.message || e);
      setCardState('error');
      setCardError(e?.message || 'Payment error');
    }
  };

  // v5.5.268: Server-side card payment via stripe-process-payment-on-reader
  // Same REST flow as POS CheckoutModal — edge fn resolves device → reader → Stripe
  const startCardPayment = async () => {
    if (total <= 0) {
      onPaid();
      return;
    }
    setCardState('processing');
    setCardError(null);
    setCardStatusMsg('Connecting to card reader...');
    pollAbortRef.current = false;

    try {
      if (!kioskId) throw new Error('Kiosk device ID missing — re-pair this kiosk.');
      const token = await ensureAuthToken();
      if (!token) throw new Error('Could not obtain auth token');

      // v5.5.871: route by the venue's payment processor. A Ryft venue takes card
      // payments on a paired PAX terminal (the same "send to terminal" job path the
      // POS/Table-Pay use), NOT a Stripe reader. Stripe venues are unchanged.
      const processor = await getLocationProcessor(locationId);
      if (processor === 'ryft') { await startRyftTerminalPayment(); return; }

      const amountMinor = Math.round(total * 100);
      const lineItems = cart.map(l => ({
        description: (l.name || 'Item').slice(0, 50),
        amount: Math.round((l.linePrice || 0) * 100),
        quantity: l.qty || 1,
      }));

      const res = await fetch(`${OPS_URL}/functions/v1/stripe-process-payment-on-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pos_device_id: kioskId,
          amount_minor: amountMinor,
          currency: stripeCurrency(),
          line_items: lineItems,
          skip_tipping: true, // kiosk collects tip in its own UI — don't prompt again on reader
        }),
      });
      const j = await res.json();
      console.log('[kiosk] stripe-process-payment-on-reader response:', j);
      if (!res.ok || j.error) {
        throw new Error(j.error || `HTTP ${res.status}`);
      }

      // Payment pushed to reader — track for cancel and start polling
      activeReaderRef.current = j.reader_id;
      activePiRef.current = j.payment_intent_id;
      setCardState('collecting');
      setCardStatusMsg('Tap or insert your card on the reader');
      pollPaymentIntent(j.payment_intent_id, j.reader_id);
    } catch (e) {
      console.warn('[kiosk] card payment start failed:', e?.message || e);
      setCardState('error');
      setCardError(e?.message || 'Payment error');
    }
  };

  // Poll Stripe until payment completes or times out
  const pollPaymentIntent = async (piId, readerId) => {
    const start = Date.now();
    const POLL_INTERVAL = 1500;
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    while (!pollAbortRef.current && Date.now() - start < TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      if (pollAbortRef.current) return;
      try {
        const pollToken = await ensureAuthToken();
        const res = await fetch(`${OPS_URL}/functions/v1/stripe-poll-reader-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${pollToken}` },
          body: JSON.stringify({ payment_intent_id: piId, reader_id: readerId }),
        });
        const j = await res.json();
        if (!res.ok) { console.warn('[kiosk] poll error:', j.error); continue; }
        // Update status based on reader action stage
        const ra = j.reader_action;
        if (ra?.type === 'process_payment_intent' && ra?.status === 'in_progress') {
          setCardStatusMsg('Customer is paying on reader');
        }
        if (j.is_terminal_state) {
          // Clear refs — payment is done, no cancel needed
          activeReaderRef.current = null;
          activePiRef.current = null;
          if (j.is_success) {
            setCardState('success');
            setCardStatusMsg('Payment approved');
            setTimeout(() => onPaid(), 800);
          } else {
            setCardState(j.last_payment_error ? 'declined' : 'error');
            setCardError(j.last_payment_error || ra?.failure_message || `Payment ${j.payment_intent_status}`);
          }
          return;
        }
      } catch (e) {
        console.warn('[kiosk] poll iter failed:', e?.message || e);
      }
    }
    if (!pollAbortRef.current) {
      // Timed out — cancel the pending action on the reader so it doesn't stay stuck
      cancelReaderAction();
      setCardState('error');
      setCardError('Timed out - customer did not complete payment within 5 minutes');
    }
  };

  // Auto-start card payment on arrival — gift cards / promo codes were already
  // offered on the preceding ScreenGiftPromo step (v5.5.900), so `total` here is
  // final and there is nothing left to interrupt the reader for.
  useEffect(() => {
    if (cardState === 'idle' && total > 0) {
      startCardPayment();
    }
  }, []);

  const cardDueAmount = total;
  const fullyPaid = total <= 0;

  return (
    <div style={fullScreen()}>
      <ScreenHeader title={fullyPaid ? 'Order fully covered!' : 'Tap or insert your card'} subtitle={fullyPaid ? 'No card payment needed' : 'Use the card reader on the side of the kiosk'} onBack={() => { pollAbortRef.current = true; cancelReaderAction(); onBack(); }} onCancel={() => { pollAbortRef.current = true; cancelReaderAction(); onCancel(); }} brandColor={brandColor} />
      <div style={{ flex: 1, padding: '4vh 5vw', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 'clamp(16px, 2.5vh, 28px)' }}>

        {/* Discounts summary */}
        {(loyaltyCredit > 0 || giftCardCredit > 0 || promoCredit > 0) && (
          <div style={{ width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loyaltyCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', borderRadius: 10, background: '#22c55e15', border: '1px solid #22c55e33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>✓ {loyaltyRedemption?.reward_name || 'Loyalty reward'}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: '#22c55e' }}>-{money(loyaltyCredit)}</span>
              </div>
            )}
            {giftCardCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', borderRadius: 10, background: brandColor + '15', border: '1px solid ' + brandColor + '33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: brandColor }}>✓ Gift card applied</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: brandColor }}>-{money(giftCardCredit)}</span>
              </div>
            )}
            {/* v5.5.900: read-only here — the amount is already committed to the card
                reader. Removing a promo happens on the preceding gift/promo step. */}
            {promoCredit > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: '#f59e0b15', border: '1px solid #f59e0b33' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>✓ {promoApplied?.label || 'Promo code'} ({promoApplied?.code})</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: '#f59e0b' }}>-{money(promoCredit)}</span>
              </div>
            )}
          </div>
        )}

        {/* Amount due */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: 'var(--kFgMuted)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {fullyPaid ? 'Amount covered' : 'Amount due'}
          </div>
          <div style={{ fontSize: 'clamp(52px, 10vw, 90px)', fontWeight: 900, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums', color: fullyPaid ? '#22c55e' : 'var(--kFg)' }}>
            {money(cardDueAmount)}
          </div>
        </div>


        {/* Card payment — connecting to reader */}
        {cardState === 'processing' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 'clamp(48px, 8vw, 72px)', color: brandColor, animation: 'kioskPulse 1.5s infinite' }}>💳</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--kFgMuted)' }}>{cardStatusMsg || 'Connecting to card reader...'}</div>
          </div>
        )}
        <style>{'@keyframes kioskPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(0.95); } }'}</style>

        {/* Card payment — waiting for customer to tap */}
        {cardState === 'collecting' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 'clamp(48px, 8vw, 72px)', color: brandColor, animation: 'kioskPoint 1.5s infinite' }}>→</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--kFgMuted)' }}>{cardStatusMsg || 'Tap or insert your card'}</div>
          </div>
        )}
        <style>{'@keyframes kioskPoint { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(8px); } }'}</style>

        {/* Card payment success */}
        {cardState === 'success' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#22c55e' }}>Payment approved</div>
          </div>
        )}

        {/* Card declined / error */}
        {(cardState === 'error' || cardState === 'declined') && (
          <div style={{ textAlign: 'center', maxWidth: 400 }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>{cardState === 'declined' ? '❌' : '⚠️'}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--kFg)', marginBottom: 8 }}>
              {cardState === 'declined' ? 'Card declined' : 'Payment error'}
            </div>
            <div style={{ fontSize: 14, color: 'var(--kFgMuted)', marginBottom: 20 }}>{cardError}</div>
            <button onClick={() => { setCardState('idle'); setTimeout(startCardPayment, 100); }} style={{ ...primaryCta(brandColor), padding: '14px 32px' }}>
              Try again
            </button>
          </div>
        )}

        {/* Fully paid by loyalty/gift card — no card needed */}
        {fullyPaid && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 12 }}>🎉</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e', marginBottom: 8 }}>Fully covered!</div>
            <div style={{ fontSize: 14, color: 'var(--kFgMuted)' }}>No card payment needed</div>
          </div>
        )}

        {(error) && (
          <div style={{ background: 'var(--kError-bg)', border: '1px solid var(--kError-border)', color: 'var(--kError-fg)', padding: '12px 16px', borderRadius: 10, fontSize: 13, maxWidth: 400, textAlign: 'center' }}>{error}</div>
        )}
      </div>

      {/* Bottom CTA */}
      <div style={{ padding: '14px 22px 22px', flexShrink: 0 }}>
        {fullyPaid && (
          <button disabled={submitting} onClick={onPaid} style={{ ...primaryCta(brandColor), width: '100%', opacity: submitting ? 0.5 : 1 }}>
            {submitting ? 'Placing order…' : 'Place order →'}
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SCREEN: LOYALTY (single-screen name + phone)
// ============================================================
// ============================================================
// SCREEN: CUSTOMER DETAILS + LOYALTY REDEMPTION (v5.5.219)
// Modal-style card centered on screen with brand-color title, name field,
// mobile field with country prefix, divider, optional email field, brand-
// color Continue, opt-in checkbox.
//
// LOYALTY: when a complete phone is typed (debounced ~600ms),
// fetchCustomerByPhone() looks up the customers table for the active org
// + fetches live loyalty data (points, rewards, tier) from loyalty-balance.
// On match: pre-fills name + email, shows "Welcome back" + points balance,
// and lists redeemable rewards. Customer taps a reward → the discount is staged
// locally (apply-only); loyalty-redeem fires at submitOrder once the order exists.
// ============================================================
function ScreenLoyalty({ brandColor, customerName, customerPhone, customerEmail, marketingOptIn, locationId, companyId, subtotal, cart, loyaltyRedemption, onLoyaltyRedeem, verifiedLoyalty, onVerifiedLoyalty, onName, onPhone, onEmail, onMarketingOptIn, onContinue, onSkip, submitting, placeOrderLabel, earlySignIn, onCancel }) {
  // Local field state mirrors props on mount; we lift back to parent on submit.
  const [name, setName] = useState(customerName || '');
  const [phone, setPhone] = useState(customerPhone || '');
  const [email, setEmail] = useState(customerEmail || '');
  const [optIn, setOptIn] = useState(!!marketingOptIn);

  // ── v5.5.266: OTP-verified loyalty flow ─────────────────
  // Customer chooses: sign in for rewards OR continue as guest.
  // Sign-in requires OTP verification via SMS before showing loyalty data.
  const [otpStep, setOtpStep] = useState('choice'); // choice | phone | sending | code | verifying | verified
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState('');
  // customerLookup populated ONLY after OTP verification
  const [customerLookup, setCustomerLookup] = useState(verifiedLoyalty ? {
    knownCustomer: true,
    ...(verifiedLoyalty.customer || {}),
    credit: verifiedLoyalty.loyalty?.points_balance || 0,
    tier: verifiedLoyalty.loyalty?.tier || null,
    rewards: [
      // v5.5.885: earned stamp-card rewards first — a completed card is already paid for.
      ...(verifiedLoyalty.loyalty?.stamp_rewards || []).map(sr => ({
        id: `stamp:${sr.program_id}`, label: sr.name, description: 'Stamp card reward',
        icon: '🎟️', pointsCost: 0, type: sr.reward_type, value: sr.reward_config || {},
        stamp: true, stampProgramId: sr.program_id, available: sr.available,
      })),
      ...(verifiedLoyalty.loyalty?.rewards_available || []).map(r => ({
        id: r.id, label: r.name, description: r.description || '', icon: r.icon || 'gift',
        pointsCost: r.points_cost, type: r.reward_type, value: r.reward_value,
      })),
    ],
    stampCards: verifiedLoyalty.stampCards || [],
    giftCards: verifiedLoyalty.giftCards || [],
    // v5.5.x: independent points / stamp-card toggles. Missing => treat as enabled.
    pointsEnabled: verifiedLoyalty.loyalty?.points_enabled,
    stampsEnabled: verifiedLoyalty.loyalty?.stamps_enabled,
  } : null);
  // v5.5.219: Reward redemption state
  const [redeeming, setRedeeming] = useState(null);
  const [redeemError, setRedeemError] = useState('');

  // If already verified from a previous visit to this screen, skip to verified
  useEffect(() => {
    if (verifiedLoyalty && (otpStep === 'choice' || otpStep === 'phone')) setOtpStep('verified');
  }, [verifiedLoyalty]);

  // Send OTP code
  const sendOtp = async () => {
    const clean = phone.replace(/\s+/g, '');
    if (clean.length < 10) { setOtpError('Please enter a valid phone number'); return; }
    if (!companyId) { setOtpError('Loyalty not configured'); return; }
    setOtpStep('sending');
    setOtpError('');
    try {
      await callLoyaltyOtp({ action: 'send', phone: clean, company_id: companyId, location_id: locationId });
      setOtpStep('code');
    } catch (e) {
      setOtpError(e.message);
      setOtpStep('phone');
    }
  };

  // Verify OTP code
  const verifyOtp = async () => {
    if (otpCode.length !== 6) { setOtpError('Enter the 6-digit code'); return; }
    setOtpStep('verifying');
    setOtpError('');
    try {
      const data = await callLoyaltyOtp({
        action: 'verify',
        phone: phone.replace(/\s+/g, ''),
        company_id: companyId,
        code: otpCode,
      });
      if (data.verified) {
        const lookup = {
          knownCustomer: true,
          customerId: data.customer?.id,
          name: data.customer?.name || '',
          email: data.customer?.email || null,
          marketingOptIn: data.customer?.marketing_opt_in || false,
          credit: data.loyalty?.points_balance || 0,
          tier: data.loyalty?.tier || null,
          rewards: [
            // v5.5.885: earned stamp-card rewards first — a completed card is already paid for.
            ...(data.loyalty?.stamp_rewards || []).map(sr => ({
              id: `stamp:${sr.program_id}`, label: sr.name, description: 'Stamp card reward',
              icon: '🎟️', pointsCost: 0, type: sr.reward_type, value: sr.reward_config || {},
              stamp: true, stampProgramId: sr.program_id, available: sr.available,
            })),
            ...(data.loyalty?.rewards_available || []).map(r => ({
              id: r.id, label: r.name, description: r.description || '', icon: r.icon || 'gift',
              pointsCost: r.points_cost, type: r.reward_type, value: r.reward_value,
            })),
          ],
          stampCards: data.stamp_cards || [],
          giftCards: data.gift_cards || [],
          // v5.5.x: independent points / stamp-card toggles. Read from loyalty
          // payload, falling back to the top-level response. Missing => enabled.
          pointsEnabled: data.loyalty?.points_enabled ?? data.points_enabled,
          stampsEnabled: data.loyalty?.stamps_enabled ?? data.stamps_enabled,
        };
        setCustomerLookup(lookup);
        // Auto-fill fields from verified customer data
        const cleanPhone = phone.replace(/\s+/g, '');
        if (data.customer?.name) {
          setName(prev => prev.trim() ? prev : data.customer.name);
          if (!customerName?.trim()) onName(data.customer.name);
        }
        if (data.customer?.email) {
          setEmail(prev => prev.trim() ? prev : data.customer.email);
          if (!customerEmail?.trim()) onEmail(data.customer.email);
        }
        // Always lift the verified phone to parent
        onPhone(cleanPhone);
        if (data.customer?.marketing_opt_in) {
          setOptIn(true);
          onMarketingOptIn(true);
        }
        // Persist verified data for payment screen (gift cards etc.)
        // v5.5.x: stamp/points toggles folded into the stored loyalty object so
        // they survive a remount of this screen (initial customerLookup reads
        // verifiedLoyalty.loyalty?.points_enabled / .stamps_enabled).
        onVerifiedLoyalty({
          customer: data.customer,
          loyalty: {
            ...(data.loyalty || {}),
            points_enabled: lookup.pointsEnabled,
            stamps_enabled: lookup.stampsEnabled,
          },
          stampCards: data.stamp_cards || [],
          giftCards: data.gift_cards || [],
        });
        setOtpStep('verified');
      }
    } catch (e) {
      setOtpError(e.message);
      setOtpStep('code');
    }
  };

  // v5.5.219: Redeem a loyalty reward
  // v5.5.897: APPLY-ONLY (mirrors POS lib/loyaltyRedeem.js). Tapping a reward now just
  // computes + stages the discount — NOTHING is consumed server-side. The real redemption
  // fires in submitOrder once the order exists, exactly like promo codes — so an abandoned
  // or failed payment can never burn points or a stamp card. Free-item rewards with no
  // eligible item in the cart are BLOCKED with a message (previously the server consumed
  // the reward first, then this handler crashed on the unpassed `cart` — a £0 redemption).
  const redeemReward = (reward) => {
    setRedeeming(reward.id);
    setRedeemError('');
    try {
      const rv = reward.value || {};
      let discountMinor = 0;
      if (reward.type === 'discount_fixed') {
        discountMinor = rv.amount_minor || 0;
      } else if (reward.type === 'discount_percent') {
        discountMinor = Math.round((subtotal || 0) * 100 * (rv.percent || 0) / 100);
      } else if (reward.type === 'free_item') {
        const eligibleIds = new Set((rv.eligible_items || []).map(ei => ei.id));
        const matching = (cart || []).filter(l => eligibleIds.has(l.item?.id));
        if (eligibleIds.size > 0 && matching.length === 0) {
          const names = (rv.eligible_items || []).map(ei => ei.name).filter(Boolean).join(', ');
          throw new Error(names
            ? `Add ${names} to your order first — the reward makes it free.`
            : 'Add the eligible item to your order first.');
        }
        if (matching.length > 0) {
          const cheapest = matching.reduce((a, b) => ((a.linePrice || 0) < (b.linePrice || 0) ? a : b));
          discountMinor = Math.round((cheapest.linePrice || 0) * 100);
        }
      }
      // free_delivery / custom → no automatic line discount.
      // Don't discount more than the subtotal
      discountMinor = Math.min(discountMinor, Math.round((subtotal || 0) * 100));

      onLoyaltyRedeem({
        reward_id: reward.stamp ? null : reward.id,
        stampProgramId: reward.stamp ? (reward.stampProgramId || String(reward.id).replace(/^stamp:/, '')) : null,
        customer_id: customerLookup?.customerId || customerLookup?.id || null,
        reward_name: reward.label,
        points_deducted: reward.stamp ? 0 : (reward.pointsCost || 0),
        discount_type: reward.type,
        discount_value: discountMinor,
        idempotency_key: null,
        balance_after: null,
        pending_commit: true,
      });
    } catch (e) {
      console.warn('[kiosk] loyalty apply failed:', e?.message || e);
      setRedeemError(e?.message || 'Could not redeem reward');
    } finally {
      setRedeeming(null);
    }
  };

  const submit = () => {
    const n = name.trim();
    const p = phone.trim();
    const e = email.trim();
    onName(n);
    onPhone(p);
    onEmail(e);
    onMarketingOptIn(optIn);
    onContinue(n, p);
  };

  const skip = () => {
    onName('');
    onPhone('');
    onEmail('');
    onMarketingOptIn(false);
    onSkip('', '');
  };

  // Guest flow requires phone (for order-ready alerts + loyalty pre-registration)
  const canSubmit = name.trim().length > 0
    && (otpStep !== 'guest' || phone.replace(/\s+/g, '').length >= 10)
    && !submitting;

  // Loyalty greeting — renders when we have a known customer match.
  const showWelcome = !!(customerLookup && customerLookup.knownCustomer);
  const hasRewards = !!(customerLookup && customerLookup.rewards && customerLookup.rewards.length > 0);
  const hasCredit = !!(customerLookup && customerLookup.credit > 0);

  // v5.5.x: independent points / stamp-card programs. A venue can run either,
  // both, or neither. Treat a missing/undefined flag as TRUE (enabled) so older
  // data and unaffected paths still render both halves. Only hide when EXACTLY false.
  const pointsEnabled = customerLookup?.pointsEnabled !== false;
  const stampsEnabled = customerLookup?.stampsEnabled !== false;

  // v5.5.219: Calculate applied loyalty credit for display
  const loyaltyCredit = loyaltyRedemption?.discount_value ? loyaltyRedemption.discount_value / 100 : 0;

  return (
    <div style={{ ...fullScreen(), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4vh 4vw' }}>
      {/* Cancel order — above the modal card */}
      <div style={{ width: '100%', maxWidth: 720, display: 'flex', justifyContent: 'flex-end', marginBottom: 'clamp(8px, 1vw, 12px)', flexShrink: 0 }}>
        <CancelOrderBtn onClick={onCancel} />
      </div>
      {/* Modal-style card */}
      <div style={{
        background: 'var(--kSurfaceRaised)',
        border: '1.5px solid ' + brandColor,
        borderRadius: 28,
        padding: 'clamp(20px, 3vw, 36px) clamp(20px, 3vw, 36px) clamp(24px, 3.4vw, 40px)',
        width: '100%',
        maxWidth: 720,
        maxHeight: '85vh',
        overflowY: 'auto',
        position: 'relative',
        boxShadow: '0 8px 28px rgba(0,0,0,0.06)',
      }}>
        {/* X close (top-right) — hidden on choice screen since "No thanks" is the skip */}
        {otpStep !== 'choice' && (
        <button
          onClick={skip}
          aria-label="Skip"
          style={{
            position: 'absolute',
            top: 'clamp(14px, 2vw, 20px)',
            right: 'clamp(14px, 2vw, 20px)',
            width: 'clamp(40px, 4.6vw, 52px)',
            height: 'clamp(40px, 4.6vw, 52px)',
            borderRadius: '50%',
            background: 'var(--kSurfaceRaised)',
            border: '1px solid var(--kBorder1)',
            color: 'var(--kFg)',
            fontSize: 'clamp(18px, 2.2vw, 24px)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'grid',
            placeItems: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}
        >×</button>
        )}

        {/* ─── v5.5.267: Choice screen — two big tiles ─── */}
        {otpStep === 'choice' && !showWelcome && (<>
          {/* Question */}
          <div style={{
            textAlign: 'center',
            marginTop: 'clamp(24px, 3.4vw, 40px)',
            marginBottom: 'clamp(24px, 3vw, 36px)',
          }}>
            <div style={{ fontSize: 'clamp(36px, 4.4vw, 52px)', marginBottom: 10 }}>⭐</div>
            <div style={{
              fontSize: 'clamp(24px, 3.2vw, 34px)',
              fontWeight: 800,
              letterSpacing: '-0.01em',
              color: 'var(--kFg)',
            }}>
              Do you collect rewards?
            </div>
          </div>

          {/* Two tiles */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(14px, 1.8vw, 20px)', marginBottom: 'clamp(14px, 1.8vw, 18px)' }}>
            {/* Tile 1: Yes, sign me in */}
            <button
              onClick={() => setOtpStep('phone')}
              style={{
                width: '100%',
                padding: 'clamp(22px, 3vw, 34px) clamp(20px, 2.6vw, 28px)',
                borderRadius: 20,
                border: '2.5px solid ' + brandColor,
                background: brandColor + '12',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 'clamp(14px, 1.8vw, 20px)',
                textAlign: 'left',
                transition: 'transform 0.1s, box-shadow 0.1s',
              }}
            >
              <div style={{
                width: 'clamp(52px, 6vw, 68px)',
                height: 'clamp(52px, 6vw, 68px)',
                borderRadius: 16,
                background: brandColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'clamp(24px, 3vw, 32px)',
                flexShrink: 0,
                boxShadow: '0 4px 12px ' + brandColor + '44',
              }}>📲</div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 'clamp(18px, 2.4vw, 24px)',
                  fontWeight: 800,
                  color: 'var(--kFg)',
                  marginBottom: 4,
                }}>Yes, sign me in</div>
                <div style={{
                  fontSize: 'clamp(13px, 1.5vw, 16px)',
                  fontWeight: 600,
                  color: 'var(--kFgMuted)',
                  lineHeight: 1.3,
                }}>Earn points, redeem rewards & use gift cards</div>
              </div>
              <div style={{
                fontSize: 'clamp(20px, 2.6vw, 28px)',
                color: brandColor,
                fontWeight: 800,
                flexShrink: 0,
              }}>›</div>
            </button>

            {/* Tile 2: No thanks, just order — still captures name for pre-registration */}
            <button
              onClick={() => setOtpStep('guest')}
              style={{
                width: '100%',
                padding: 'clamp(22px, 3vw, 34px) clamp(20px, 2.6vw, 28px)',
                borderRadius: 20,
                border: '1.5px solid var(--kBorder2)',
                background: 'var(--kSurface2, #1a1a1e)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 'clamp(14px, 1.8vw, 20px)',
                textAlign: 'left',
                transition: 'transform 0.1s',
              }}
            >
              <div style={{
                width: 'clamp(52px, 6vw, 68px)',
                height: 'clamp(52px, 6vw, 68px)',
                borderRadius: 16,
                background: 'var(--kSurfaceRaised, #252528)',
                border: '1.5px solid var(--kBorder1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 'clamp(24px, 3vw, 32px)',
                flexShrink: 0,
              }}>🍽️</div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 'clamp(18px, 2.4vw, 24px)',
                  fontWeight: 800,
                  color: 'var(--kFg)',
                  marginBottom: 4,
                }}>No thanks, just order</div>
                <div style={{
                  fontSize: 'clamp(13px, 1.5vw, 16px)',
                  fontWeight: 600,
                  color: 'var(--kFgMuted)',
                  lineHeight: 1.3,
                }}>Skip straight to payment</div>
              </div>
              <div style={{
                fontSize: 'clamp(20px, 2.6vw, 28px)',
                color: 'var(--kFgMuted)',
                fontWeight: 800,
                flexShrink: 0,
              }}>›</div>
            </button>
          </div>
        </>)}

        {/* ─── Title for non-choice steps (OTP flow + verified) ─── */}
        {otpStep !== 'choice' && (
        <div style={{
          textAlign: 'center',
          marginTop: 'clamp(20px, 3vw, 32px)',
          marginBottom: 'clamp(6px, 0.8vw, 10px)',
        }}>
          <div style={{ fontSize: 'clamp(28px, 3.6vw, 38px)', marginBottom: 6 }}>
            {showWelcome ? '👋' : otpStep === 'guest' ? '📝' : otpStep === 'code' || otpStep === 'verifying' ? '📱' : '📲'}
          </div>
          <div style={{
            fontSize: 'clamp(22px, 3vw, 30px)',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: brandColor,
          }}>
            {showWelcome
              ? `${t('details.welcome')}${customerLookup?.name ? ', ' + customerLookup.name : ''}!`
              : otpStep === 'guest'
                ? 'Your details'
                : otpStep === 'code' || otpStep === 'verifying'
                  ? 'Enter verification code'
                  : 'Sign in with your mobile'}
          </div>
        </div>
        )}

        {otpStep !== 'choice' && (
        <div style={{
          textAlign: 'center',
          fontSize: 'clamp(14px, 1.6vw, 17px)',
          color: 'var(--kFgMuted)',
          fontWeight: 600,
          lineHeight: 1.4,
          marginBottom: 'clamp(16px, 2vw, 24px)',
          padding: '0 clamp(0px, 2vw, 16px)',
        }}>
          {showWelcome
            ? 'Your loyalty details are shown below'
            : otpStep === 'guest'
              ? 'Enter your details so we can let you know when your order is ready'
              : otpStep === 'code' || otpStep === 'verifying'
                ? `We sent a 6-digit code to your mobile ending ${phone.slice(-4)}`
                : "Enter your number and we'll text you a verification code"}
        </div>
        )}

        {/* ─── OTP Error ─── */}
        {otpError && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 14,
            fontSize: 'clamp(12px, 1.4vw, 14px)', color: '#e55',
            background: '#e5555512', border: '1px solid #e5555530', fontWeight: 600,
          }}>{otpError}</div>
        )}

        {/* ─── Phone entry + Send code (step 1) ─── */}
        {(otpStep === 'phone' || otpStep === 'sending') && !showWelcome && (
          <div style={{ marginBottom: 'clamp(14px, 1.8vw, 18px)' }}>
            <div style={detailsLabelStyle(brandColor)}>{t('details.mobile.label')}</div>
            <div style={{
              display: 'flex', alignItems: 'stretch', background: 'var(--kSurfaceRaised)',
              border: '1px solid var(--kBorder2)', borderRadius: 14, overflow: 'hidden',
            }}>
              <div style={{
                padding: 'clamp(14px, 1.8vw, 18px) clamp(14px, 1.6vw, 20px)',
                borderRight: '1px solid var(--kBorder2)',
                fontSize: 'clamp(15px, 1.8vw, 18px)', fontWeight: 600, color: 'var(--kFg)',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
              }}>
                GB +44 <span style={{ color: 'var(--kFgFaint)', fontSize: 12 }}>▾</span>
              </div>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value.replace(/[^0-9 +]/g, ''))}
                placeholder={t('details.mobile.placeholder')}
                type="tel" inputMode="tel" autoFocus
                style={{
                  flex: 1, padding: 'clamp(14px, 1.8vw, 18px) clamp(14px, 1.6vw, 20px)',
                  background: 'transparent', border: 0, outline: 'none',
                  fontSize: 'clamp(15px, 1.8vw, 18px)', fontFamily: 'ui-monospace, monospace',
                  color: 'var(--kFg)', letterSpacing: '0.02em', minWidth: 0,
                }}
              />
            </div>
            <button
              onClick={sendOtp}
              disabled={otpStep === 'sending' || phone.replace(/\s+/g, '').length < 10}
              style={{
                width: '100%', marginTop: 12, padding: 'clamp(14px, 1.8vw, 18px)',
                borderRadius: 14, border: 'none',
                background: phone.replace(/\s+/g, '').length >= 10 ? brandColor : 'var(--kSurface2)',
                color: phone.replace(/\s+/g, '').length >= 10 ? '#fff' : 'var(--kFgFaint)',
                fontSize: 'clamp(15px, 1.8vw, 18px)', fontWeight: 800,
                cursor: phone.replace(/\s+/g, '').length >= 10 ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit', opacity: otpStep === 'sending' ? 0.6 : 1,
              }}
            >
              {otpStep === 'sending' ? 'Sending code…' : 'Send verification code'}
            </button>
          </div>
        )}

        {/* ─── OTP code entry (step 2) ─── */}
        {(otpStep === 'code' || otpStep === 'verifying') && !showWelcome && (
          <div style={{ marginBottom: 'clamp(14px, 1.8vw, 18px)' }}>
            <div style={detailsLabelStyle(brandColor)}>Verification code</div>
            <input
              value={otpCode}
              onChange={e => setOtpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="000000"
              type="tel" inputMode="numeric" autoFocus
              maxLength={6}
              style={{
                ...detailsInputStyle(),
                textAlign: 'center', fontSize: 'clamp(24px, 3vw, 32px)',
                fontFamily: 'ui-monospace, monospace', letterSpacing: '0.3em',
              }}
            />
            <button
              onClick={verifyOtp}
              disabled={otpStep === 'verifying' || otpCode.length !== 6}
              style={{
                width: '100%', marginTop: 12, padding: 'clamp(14px, 1.8vw, 18px)',
                borderRadius: 14, border: 'none',
                background: otpCode.length === 6 ? brandColor : 'var(--kSurface2)',
                color: otpCode.length === 6 ? '#fff' : 'var(--kFgFaint)',
                fontSize: 'clamp(15px, 1.8vw, 18px)', fontWeight: 800,
                cursor: otpCode.length === 6 ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit', opacity: otpStep === 'verifying' ? 0.6 : 1,
              }}
            >
              {otpStep === 'verifying' ? 'Verifying…' : 'Verify'}
            </button>
            <button
              onClick={() => { setOtpStep('phone'); setOtpCode(''); setOtpError(''); }}
              style={{
                width: '100%', marginTop: 8, padding: '10px',
                borderRadius: 14, border: '1px solid var(--kBorder2)',
                background: 'transparent', color: 'var(--kFgMuted)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Change number
            </button>
          </div>
        )}

        {/* Welcome-back / loyalty block */}
        {showWelcome && (
          <div style={{
            background: brandColor + '15',
            border: '1.5px solid ' + brandColor,
            borderRadius: 16,
            padding: 'clamp(14px, 1.8vw, 20px)',
            marginBottom: 'clamp(20px, 2.6vw, 28px)',
          }}>
            {/* Points balance — show for members when points are enabled */}
            {pointsEnabled && (
            <div style={{
              fontSize: 'clamp(13px, 1.5vw, 16px)',
              fontWeight: 700,
              color: 'var(--kFg)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: 'clamp(18px, 2.2vw, 24px)' }}>⭐</span>
              <span>{customerLookup.credit || 0} loyalty points</span>
              {customerLookup.tier && (
                <span style={{ color: customerLookup.tier.color || brandColor, fontWeight: 800 }}>
                  {customerLookup.tier.icon || ''} {customerLookup.tier.name}
                </span>
              )}
            </div>
            )}

            {/* v5.5.219: Redeemable rewards — customer can tap to redeem */}
            {/* v5.5.885: rewards list shows whenever the member HAS rewards — the old
                pointsEnabled gate hid earned STAMP rewards on stamps-only venues. The rewards
                array already contains only what's redeemable (stamp + affordable points). */}
            {hasRewards && !loyaltyRedemption && (
              <div style={{ marginTop: 12 }}>
                <div style={{
                  fontSize: 'clamp(11px, 1.3vw, 13px)',
                  fontWeight: 700,
                  color: brandColor,
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  marginBottom: 8,
                }}>Redeem a reward</div>
                {redeemError && (
                  <div style={{
                    padding: 8, borderRadius: 8, marginBottom: 8,
                    fontSize: 'clamp(11px, 1.3vw, 13px)',
                    color: '#e55',
                    background: '#e5555515',
                    border: '1px solid #e5555533',
                    fontWeight: 600,
                  }}>{redeemError}</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {customerLookup.rewards.map(r => (
                    <button
                      key={r.id}
                      onClick={() => redeemReward(r)}
                      disabled={!!redeeming}
                      style={{
                        width: '100%',
                        padding: 'clamp(10px, 1.4vw, 14px) clamp(12px, 1.6vw, 16px)',
                        borderRadius: 12,
                        border: '1.5px solid ' + brandColor + '44',
                        background: 'var(--kSurfaceRaised)',
                        cursor: redeeming ? 'wait' : 'pointer',
                        fontFamily: 'inherit',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        opacity: redeeming && redeeming !== r.id ? 0.5 : 1,
                        transition: 'border-color .14s, transform .14s',
                      }}
                    >
                      <div style={{
                        width: 'clamp(32px, 3.6vw, 40px)',
                        height: 'clamp(32px, 3.6vw, 40px)',
                        borderRadius: 8,
                        background: brandColor + '22',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 'clamp(14px, 1.6vw, 18px)',
                        flexShrink: 0,
                      }}>
                        {r.icon || '🎁'}
                      </div>
                      <div style={{ flex: 1, textAlign: 'left' }}>
                        <div style={{ fontSize: 'clamp(13px, 1.5vw, 16px)', fontWeight: 700, color: 'var(--kFg)' }}>{r.label}</div>
                        <div style={{ fontSize: 'clamp(11px, 1.2vw, 13px)', color: 'var(--kFgMuted)', marginTop: 1 }}>
                          {r.stamp ? <span style={{ color: '#22c55e', fontWeight: 700 }}>FREE · stamp card{r.available > 1 ? ` ×${r.available}` : ''}</span> : `${r.pointsCost} points`}
                          {r.type === 'discount_fixed' && r.value?.amount_minor && (
                            <span style={{ color: brandColor, fontWeight: 700, marginLeft: 6 }}>
                              · {String.fromCodePoint(0x00A3)}{(r.value.amount_minor / 100).toFixed(2)} off
                            </span>
                          )}
                          {r.type === 'discount_percent' && r.value?.percent && (
                            <span style={{ color: brandColor, fontWeight: 700, marginLeft: 6 }}>
                              · {r.value.percent}% off
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{
                        fontSize: 'clamp(12px, 1.4vw, 15px)',
                        fontWeight: 800,
                        color: brandColor,
                        flexShrink: 0,
                      }}>
                        {redeeming === r.id ? '...' : 'Redeem'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* v5.5.219: Show applied reward */}
            {pointsEnabled && loyaltyRedemption && (
              <div style={{
                marginTop: 12,
                padding: 'clamp(10px, 1.4vw, 14px)',
                borderRadius: 12,
                background: '#22c55e22',
                border: '1.5px solid #22c55e44',
              }}>
                <div style={{
                  fontSize: 'clamp(14px, 1.6vw, 17px)',
                  fontWeight: 800,
                  color: '#22c55e',
                }}>
                  {String.fromCodePoint(0x2713)} {loyaltyRedemption.reward_name} applied!
                </div>
                <div style={{
                  fontSize: 'clamp(12px, 1.3vw, 14px)',
                  color: 'var(--kFg)',
                  marginTop: 4,
                  fontWeight: 600,
                }}>
                  {loyaltyRedemption.points_deducted} points used
                  {loyaltyCredit > 0 && ` · ${String.fromCodePoint(0x00A3)}${loyaltyCredit.toFixed(2)} off your order`}
                </div>
              </div>
            )}

            {/* v5.5.264: Stamp card progress */}
            {stampsEnabled && customerLookup.stampCards && customerLookup.stampCards.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{
                  fontSize: 'clamp(11px, 1.3vw, 13px)',
                  fontWeight: 700,
                  color: brandColor,
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  marginBottom: 8,
                }}>Stamp cards</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {customerLookup.stampCards.map(sc => {
                    const pct = Math.min(100, Math.round((sc.stamps_collected / sc.stamps_required) * 100));
                    return (
                      <div key={sc.id} style={{
                        padding: 'clamp(10px, 1.4vw, 14px)',
                        borderRadius: 12,
                        background: 'var(--kSurfaceRaised)',
                        border: '1.5px solid ' + brandColor + '33',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 'clamp(16px, 2vw, 22px)' }}>{sc.icon || '☕'}</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 'clamp(13px, 1.5vw, 16px)', fontWeight: 700, color: 'var(--kFg)' }}>{sc.name}</div>
                            <div style={{ fontSize: 'clamp(11px, 1.2vw, 13px)', color: 'var(--kFgMuted)', marginTop: 1 }}>
                              {sc.stamps_collected}/{sc.stamps_required} stamps
                              {sc.stamps_required - sc.stamps_collected > 0 && ` · ${sc.stamps_required - sc.stamps_collected} to go`}
                            </div>
                          </div>
                          {sc.completed_count > 0 && (
                            <span style={{
                              fontSize: 'clamp(10px, 1.1vw, 12px)',
                              fontWeight: 700,
                              color: brandColor,
                              padding: '2px 8px',
                              borderRadius: 12,
                              background: brandColor + '15',
                            }}>{sc.completed_count}x done</span>
                          )}
                        </div>
                        {/* Progress bar */}
                        <div style={{
                          height: 'clamp(6px, 0.8vw, 8px)',
                          borderRadius: 99,
                          background: brandColor + '18',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%',
                            width: pct + '%',
                            borderRadius: 99,
                            background: brandColor,
                            transition: 'width 0.3s ease',
                          }} />
                        </div>
                        {/* Stamp grid (visual dots) */}
                        <div style={{
                          display: 'flex', gap: 'clamp(3px, 0.4vw, 5px)', marginTop: 8,
                          flexWrap: 'wrap',
                        }}>
                          {Array.from({ length: sc.stamps_required }).map((_, i) => (
                            <div key={i} style={{
                              width: 'clamp(20px, 2.6vw, 28px)',
                              height: 'clamp(20px, 2.6vw, 28px)',
                              borderRadius: '50%',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: i < sc.stamps_collected ? brandColor + '22' : 'var(--kSurface2, #1a1a1e)',
                              border: i < sc.stamps_collected
                                ? '2px solid ' + brandColor
                                : '2px dashed var(--kBorder1, #333)',
                              fontSize: 'clamp(10px, 1.2vw, 14px)',
                              color: i < sc.stamps_collected ? brandColor : 'var(--kFgFaint, #555)',
                              fontWeight: 700,
                            }}>
                              {i < sc.stamps_collected ? (sc.icon || '☕') : (i + 1)}
                            </div>
                          ))}
                          {/* Reward slot */}
                          <div style={{
                            width: 'clamp(20px, 2.6vw, 28px)',
                            height: 'clamp(20px, 2.6vw, 28px)',
                            borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: brandColor + '10',
                            border: '2px solid ' + brandColor + '50',
                            fontSize: 'clamp(10px, 1.2vw, 14px)',
                          }}>🎁</div>
                        </div>
                        {/* Reward description */}
                        {sc.reward_description && (
                          <div style={{
                            marginTop: 8,
                            padding: '6px 10px',
                            borderRadius: 8,
                            background: brandColor + '08',
                            border: '1px dashed ' + brandColor + '30',
                            fontSize: 'clamp(11px, 1.2vw, 13px)',
                            fontWeight: 600,
                            color: 'var(--kFgMuted)',
                            display: 'flex', alignItems: 'center', gap: 6,
                          }}>
                            <span>🎁</span> Reward: {sc.reward_description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* v5.5.264: Gift card balances */}
            {customerLookup.giftCards && customerLookup.giftCards.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{
                  fontSize: 'clamp(11px, 1.3vw, 13px)',
                  fontWeight: 700,
                  color: brandColor,
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                  marginBottom: 8,
                }}>Gift cards</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {customerLookup.giftCards.map(gc => (
                    <div key={gc.id} style={{
                      padding: 'clamp(10px, 1.4vw, 14px) clamp(12px, 1.6vw, 16px)',
                      borderRadius: 12,
                      background: 'var(--kSurfaceRaised)',
                      border: '1.5px solid ' + brandColor + '33',
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <div style={{
                        width: 'clamp(32px, 3.6vw, 40px)',
                        height: 'clamp(32px, 3.6vw, 40px)',
                        borderRadius: 8,
                        background: brandColor + '22',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 'clamp(14px, 1.6vw, 18px)',
                        flexShrink: 0,
                      }}>💳</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 'clamp(13px, 1.5vw, 16px)', fontWeight: 700, color: 'var(--kFg)' }}>
                          Gift Card {gc.last4 ? `···${gc.last4}` : ''}
                        </div>
                        <div style={{ fontSize: 'clamp(11px, 1.2vw, 13px)', color: 'var(--kFgMuted)', marginTop: 1 }}>
                          {gc.expires_at ? `Expires ${new Date(gc.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'No expiry'}
                        </div>
                      </div>
                      <div style={{
                        fontSize: 'clamp(15px, 1.8vw, 19px)',
                        fontWeight: 800,
                        color: brandColor,
                        flexShrink: 0,
                      }}>
                        {String.fromCodePoint(0x00A3)}{((gc.balance || 0) / 100).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Name / email / continue — only show after committing to sign-in (not in choice state) */}
        {otpStep !== 'choice' && (<>
        {/* Your name */}
        <div style={{ marginBottom: 'clamp(14px, 1.8vw, 18px)' }}>
          <div style={detailsLabelStyle(brandColor)}>{t('details.name.label')}</div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('details.name.placeholder')}
            style={detailsInputStyle()}
          />
        </div>

        {/* Phone number — required for guest (order-ready alerts + loyalty pre-reg) */}
        {otpStep === 'guest' && (
        <div style={{ marginBottom: 'clamp(14px, 1.8vw, 18px)' }}>
          <div style={detailsLabelStyle(brandColor)}>Your mobile number</div>
          <div style={{
            display: 'flex', alignItems: 'stretch', background: 'var(--kSurfaceRaised)',
            border: '1px solid var(--kBorder2)', borderRadius: 14, overflow: 'hidden',
          }}>
            <div style={{
              padding: 'clamp(14px, 1.8vw, 18px) clamp(14px, 1.6vw, 20px)',
              borderRight: '1px solid var(--kBorder2)',
              fontSize: 'clamp(15px, 1.8vw, 18px)', fontWeight: 600, color: 'var(--kFg)',
              fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            }}>
              GB +44 <span style={{ color: 'var(--kFgFaint)', fontSize: 12 }}>{'▾'}</span>
            </div>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/[^0-9 +]/g, ''))}
              placeholder={t('details.mobile.placeholder')}
              type="tel" inputMode="tel"
              style={{
                flex: 1, padding: 'clamp(14px, 1.8vw, 18px) clamp(14px, 1.6vw, 20px)',
                background: 'transparent', border: 0, outline: 'none',
                fontSize: 'clamp(15px, 1.8vw, 18px)', fontFamily: 'ui-monospace, monospace',
                color: 'var(--kFg)', letterSpacing: '0.02em', minWidth: 0,
              }}
            />
          </div>
          <div style={{
            fontSize: 'clamp(11px, 1.2vw, 13px)', color: 'var(--kFgMuted)',
            marginTop: 6, fontWeight: 500, lineHeight: 1.3,
          }}>
            {"We'll text you when your order is ready"}
          </div>
        </div>
        )}

        {/* Optional divider */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          margin: 'clamp(14px, 1.8vw, 20px) 0',
        }}>
          <div style={{ flex: 1, height: 1, background: brandColor, opacity: 0.4 }} />
          <span style={{
            fontSize: 'clamp(12px, 1.4vw, 15px)',
            fontWeight: 600,
            color: brandColor,
            whiteSpace: 'nowrap',
          }}>{t('details.optional')}</span>
          <div style={{ flex: 1, height: 1, background: brandColor, opacity: 0.4 }} />
        </div>

        {/* Your email */}
        <div style={{ marginBottom: 'clamp(18px, 2.4vw, 24px)' }}>
          <div style={detailsLabelStyle(brandColor)}>{t('details.email.label')}</div>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('details.email.placeholder')}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={detailsInputStyle()}
          />
        </div>

        {/* Continue */}
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            width: '100%',
            background: canSubmit ? brandColor : 'var(--kSurface2)',
            color: canSubmit ? '#fff' : 'var(--kFgFaint)',
            border: 0,
            borderRadius: 18,
            padding: 'clamp(16px, 2.2vw, 22px)',
            fontSize: 'clamp(17px, 2.2vw, 22px)',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.6,
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            boxShadow: canSubmit ? '0 6px 20px rgba(0,0,0,0.12)' : 'none',
            marginBottom: 'clamp(16px, 2vw, 20px)',
          }}
        >
          {submitting ? 'Placing order…' : earlySignIn ? 'Continue to menu →' : t('details.continue')}
          {!submitting && !earlySignIn && <span style={{ fontSize: 14 }}>›</span>}
        </button>

        {/* Marketing opt-in row */}
        <div
          onClick={() => setOptIn(v => !v)}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: 'clamp(8px, 1vw, 12px)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <span style={{
            flexShrink: 0,
            width: 'clamp(26px, 3vw, 32px)',
            height: 'clamp(26px, 3vw, 32px)',
            borderRadius: '50%',
            background: optIn ? brandColor : 'transparent',
            border: '2px solid ' + brandColor,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            fontSize: 'clamp(13px, 1.5vw, 17px)',
            fontWeight: 800,
            transition: 'background 0.12s',
            marginTop: 2,
          }}>
            {optIn ? '✓' : ''}
          </span>
          <span style={{
            flex: 1,
            fontSize: 'clamp(13px, 1.5vw, 16px)',
            color: 'var(--kFg)',
            lineHeight: 1.4,
            fontWeight: 500,
          }}>{t('details.optIn')}</span>
        </div>
        </>)}
      </div>
    </div>
  );
}

function detailsLabelStyle(brandColor) {
  return {
    fontSize: 'clamp(15px, 1.8vw, 19px)',
    fontWeight: 800,
    color: brandColor,
    marginBottom: 'clamp(8px, 1vw, 10px)',
    letterSpacing: '-0.01em',
  };
}

function detailsInputStyle() {
  return {
    width: '100%',
    padding: 'clamp(14px, 1.8vw, 18px) clamp(14px, 1.6vw, 20px)',
    background: 'var(--kSurfaceRaised)',
    border: '1px solid var(--kBorder2)',
    borderRadius: 14,
    color: 'var(--kFg)',
    fontSize: 'clamp(15px, 1.8vw, 18px)',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  };
}

// ============================================================
// SCREEN: DONE (order number reveal)
// ============================================================
function ScreenDone({ brandColor, customerName, customerPhone, orderNumber, orderType, tableNumber, avgWaitMinutes, banner, onDone }) {
  const phoneMasked = customerPhone ? customerPhone.replace(/^(.{3}).+(.{3})$/, '$1*** *** $2') : null;
  // The Done screen uses a fixed celebration-green gradient regardless of kiosk theme,
  // so text must be white-on-dark in both light and dark modes.
  const W = '#fff';
  const Wm = 'rgba(255,255,255,0.72)';
  const Wf = 'rgba(255,255,255,0.42)';
  return (
    <div style={{ ...fullScreen(), background: 'linear-gradient(180deg, #1a4d2e 0%, #0d3520 100%)', color: W }}>
      {banner && banner.imageUrl && (
        <div style={{ width: '100%', maxHeight: '22vh', overflow: 'hidden', flexShrink: 0 }}>
          <img src={banner.imageUrl} alt={banner.label || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '6vw' }}>
        <div style={{ width: 120, height: 120, borderRadius: '50%', background: '#22c55e', display: 'grid', placeItems: 'center', fontSize: 60, color: W, marginBottom: 30, boxShadow: '0 0 80px rgba(34,197,94,0.5)' }}>✓</div>
        <div style={{ fontSize: 'clamp(22px, 3.6vw, 32px)', fontWeight: 700, marginBottom: 4, color: W }}>{customerName ? 'Thank you, ' + customerName + '!' : 'Thank you!'}</div>
        <div style={{ fontSize: 13, color: Wm, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 40, marginBottom: 12 }}>Your order number</div>
        {/* Short display form — must match what prints on the receipt in the customer's hand. */}
        <div style={{ fontSize: 'clamp(120px, 22vw, 220px)', fontWeight: 900, letterSpacing: '-0.05em', lineHeight: 0.9, marginBottom: 20, fontVariantNumeric: 'tabular-nums', color: W }}>{shortOrderRef(orderNumber) || '—'}</div>
        <div style={{ fontSize: 16, color: Wm, maxWidth: 360, lineHeight: 1.5, marginBottom: 8 }}>
          {orderType === 'dineIn' && tableNumber ? 'Your order will be brought to table ' + tableNumber + '.' : 'We will call your number when ready.'}
        </div>
        <div style={{ fontSize: 13, color: Wm, marginBottom: 40 }}>Average wait: {avgWaitMinutes || 8} mins</div>
        {phoneMasked && (
          <div style={{ fontSize: 13, color: Wm, marginBottom: 30 }}>📱 Receipt sent to {phoneMasked}</div>
        )}
        <button onClick={onDone} style={{ background: 'transparent', border: '1px solid ' + Wf, color: Wm, padding: '10px 24px', borderRadius: 100, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Done</button>
      </div>
    </div>
  );
}

// ============================================================
// SHARED SCREEN HEADER
// ============================================================
function ScreenHeader({ title, subtitle, onBack, onCancel, brandColor }) {
  return (
    <div style={{ padding: '24px 22px 16px', flexShrink: 0 }}>
      {/* Top row: back arrow (left) + cancel (right) */}
      {(onBack || onCancel) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          {onBack ? <button onClick={onBack} style={iconBtn()}>{'←'}</button> : <div />}
          {onCancel && (
            <button
              onClick={onCancel}
              style={{
                background: 'none',
                border: '1px solid var(--kBorder2)',
                borderRadius: 'clamp(8px, 1vw, 12px)',
                padding: 'clamp(6px, 0.8vw, 10px) clamp(12px, 1.4vw, 16px)',
                fontSize: 'clamp(12px, 1.3vw, 14px)',
                fontWeight: 600,
                color: 'var(--kFgMuted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              {'✕'} Cancel order
            </button>
          )}
        </div>
      )}
      <div>
        <div style={{ fontSize: 'clamp(28px, 4.8vw, 42px)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: 6 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 'clamp(13px, 1.8vw, 16px)', color: 'var(--kFgMuted)' }}>{subtitle}</div>}
      </div>
    </div>
  );
}

// ============================================================
// ALLERGEN PICKER (v5.4.0)
// ============================================================
function AllergenPickerOverlay({ brandColor, allergens, selected, onChange, onClose }) {
  const COMMON = [
    { key: 'gluten', label: 'Gluten', icon: '🌾' },
    { key: 'dairy', label: 'Dairy', icon: '🥛' },
    { key: 'nuts', label: 'Nuts', icon: '🦜' },
    { key: 'peanuts', label: 'Peanuts', icon: '🥜' },
    { key: 'soy', label: 'Soy', icon: '🌱' },
    { key: 'egg', label: 'Egg', icon: '🥚' },
    { key: 'fish', label: 'Fish', icon: '🐟' },
    { key: 'shellfish', label: 'Shellfish', icon: '🦐' },
    { key: 'sesame', label: 'Sesame', icon: '🪴' },
    { key: 'mustard', label: 'Mustard', icon: '🌶' },
    { key: 'celery', label: 'Celery', icon: '🥬' },
    { key: 'sulphites', label: 'Sulphites', icon: '🍷' },
  ];
  const presentSet = new Set(allergens.map(a => String(a).toLowerCase()));
  const list = [
    ...COMMON.filter(a => presentSet.has(a.key) || presentSet.size === 0),
    ...allergens.filter(a => !COMMON.find(c => c.key === String(a).toLowerCase())).map(a => ({ key: String(a).toLowerCase(), label: String(a), icon: '⚠' })),
  ];
  const finalList = list.length > 0 ? list : COMMON;
  const toggle = (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--kOverlay)', backdropFilter: 'blur(8px)', display: 'grid', placeItems: 'center', padding: 24, zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--kSurfaceRaised)', color: 'var(--kFg)', border: '1px solid var(--kBorder1)', borderRadius: 24, padding: 28, maxWidth: 460, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>Any allergies?</div>
        <div style={{ fontSize: 13, color: 'var(--kFgMuted)', marginBottom: 22 }}>Tap to flag what you can't have. Items containing flagged allergens will be marked.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 22 }}>
          {finalList.map(a => {
            const isSel = selected.has(a.key);
            return (
              <button key={a.key} onClick={() => toggle(a.key)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                background: isSel ? 'rgba(239,68,68,0.15)' : 'var(--kSurface1)',
                border: '2px solid ' + (isSel ? '#ef4444' : 'transparent'),
                borderRadius: 14, cursor: 'pointer', color: 'var(--kFg)', fontFamily: 'inherit', textAlign: 'left',
              }}>
                <span style={{ fontSize: 22 }}>{a.icon}</span>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{a.label}</span>
                {isSel && <span style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>AVOID</span>}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {selected.size > 0 && (
            <button onClick={() => onChange(new Set())} style={{ flex: 1, background: 'var(--kSurface2)', color: 'var(--kFg)', border: 0, padding: '14px', borderRadius: 100, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Clear all</button>
          )}
          <button onClick={onClose} style={{ flex: 2, background: brandColor, color: '#fff', border: 0, padding: '14px', borderRadius: 100, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>{selected.size > 0 ? 'Show me what I can have' : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// STYLE HELPERS
// ============================================================
function fullScreen() { return { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }; }
function iconBtn() { return { width: 44, height: 44, borderRadius: 14, background: 'var(--kSurface2)', display: 'grid', placeItems: 'center', fontSize: 20, color: 'var(--kFg)', border: 0, cursor: 'pointer', fontFamily: 'inherit' }; }
// v5.5.273: Inline cancel-order button for kiosk headers
function CancelOrderBtn({ onClick }) {
  if (!onClick) return null;
  return (
    <button onClick={onClick} style={{
      background: 'none', border: '1px solid var(--kBorder2)',
      borderRadius: 'clamp(8px, 1vw, 12px)',
      padding: 'clamp(6px, 0.8vw, 10px) clamp(12px, 1.4vw, 16px)',
      fontSize: 'clamp(12px, 1.3vw, 14px)', fontWeight: 600,
      color: 'var(--kFgMuted)', cursor: 'pointer', fontFamily: 'inherit',
      display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
    }}>{'✕'} Cancel order</button>
  );
}
function bigCard(brandColor) {
  return {
    background: 'var(--kSurface1)',
    border: '2px solid transparent',
    borderRadius: 22,
    padding: 'clamp(20px, 3vh, 32px)',
    display: 'flex',
    alignItems: 'center',
    gap: 'clamp(16px, 3vw, 24px)',
    cursor: 'pointer',
    color: 'var(--kFg)',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'all 0.15s',
  };
}
function smallCard(brandColor) {
  return {
    background: 'var(--kSurface1)',
    border: '2px solid transparent',
    borderRadius: 14,
    padding: '18px',
    cursor: 'pointer',
    color: 'var(--kFg)',
    fontFamily: 'inherit',
  };
}
function primaryCta(brandColor) {
  return {
    background: brandColor,
    color: '#fff',
    border: 0,
    padding: 'clamp(18px, 2.5vh, 22px) 32px',
    borderRadius: 16,
    fontSize: 'clamp(16px, 2.2vw, 20px)',
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
  };
}
function miniQtyBtn() { return { width: 32, height: 32, borderRadius: '50%', background: 'var(--kSurface1)', color: 'var(--kFg)', border: 0, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }; }
function kpadKey() {
  // v5.5.24: bumped sizes to match the larger overall screen scale.
  // Outlined tile style matches the order-type cards aesthetic.
  return {
    padding: 'clamp(26px, 3.6vw, 42px) 0',
    borderRadius: 20,
    background: 'var(--kSurfaceRaised)',
    color: 'var(--kFg)',
    fontSize: 'clamp(28px, 4vw, 42px)',
    fontWeight: 600,
    border: '1.5px solid var(--kBorder2)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.08s, border-color 0.08s',
  };
}
function fieldLabel() { return { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--kFgMuted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }; }
