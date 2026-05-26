// v5.5.112 — Phase 3a (UI overhaul): branded online ordering surface.
// Customer-facing menu browse + cart. Visual reference: DoorDash / Uber Eats.
//
// Layout:
//   • Tall hero banner with overlay logo + restaurant name + status pill
//   • Sticky category nav strip below hero
//   • Two-column item cards on desktop (image right, name+desc+price left),
//     single-column on mobile
//   • Floating "View basket" CTA on mobile, sidebar cart on wider screens
//
// Cross-DB: menu loaded from OPS via location.ops_location_id (same pattern
// as KioskApp.useKioskMenu). Branding from location.online_branding (set
// in BO → Online ordering) with fallback to ops receipt_branding.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { isItemEightySixed } from '../../lib/itemAvailability';
import { getStashedTab, clearStashedTab } from '../../lib/qrTabStorage';
import OnlineCart from './OnlineCart';
import OnlineCheckout from './OnlineCheckout';
import OnlineItemSheet from './OnlineItemSheet';
import OrderTracker from './OrderTracker';
import QrCheckout from '../qr/QrCheckout';
import TabResumeScreen from '../qr/TabResumeScreen';

const FALLBACK_ACCENT = '#e8a020';
const FALLBACK_BG     = '#ffffff';
const FALLBACK_FG     = '#1a1a1a';

export default function OnlineSurface({ location, mode = 'online', tableId = null, tableLabel = null }) {
  // v5.5.145: same surface drives both /?surface=online (collection/delivery)
  // and /?surface=qr&t=T5 (table-side). Mode flips a few small pieces:
  // welcome screen, sticky header chip, hero pills, checkout component,
  // default order type. Everything else (menu / cart / item sheet / cart /
  // OrderTracker / 86 awareness) is identical.
  const isQr = mode === 'qr';
  const opsLocationId = location.ops_location_id || location.id;
  const onlineMenuId  = location.online_menu_id || null;

  const [items, setItems]           = useState([]);
  const [categories, setCategories] = useState([]);
  const [eightySixIds, setEightySixIds] = useState([]); // v5.5.141: live 86 list from DB
  const [stockLevels, setStockLevels]   = useState({}); // v5.5.239: live stock counts from DB
  const [taxRates, setTaxRates]     = useState([]); // v5.5.154: UK VAT for cart breakdown
  // v5.5.155: tab-resume state. resumeTab/rounds/total populated when an
  // open-tab is found in localStorage AND verified live in DB.
  // existingTab stays set after the customer taps "Add more" — QrCheckout
  // uses it to add a new round to the same payment_intent instead of
  // creating a fresh pre-auth.
  const [resumeTab, setResumeTab]     = useState(null);
  const [resumeRounds, setResumeRounds] = useState([]);
  const [resumeChecked, setResumeChecked] = useState(false);
  const [existingTab, setExistingTab] = useState(null);
  // v5.5.159: ANY open tab at this tableId — surfaced on the start
  // screen as "Settle the bill" so a customer (or anyone) can close
  // the tab even when the original phone isn't around.
  const [tableTabs, setTableTabs]     = useState([]);
  const [pickedTableTab, setPickedTableTab] = useState(null);
  const [branding, setBranding]     = useState(null);
  const [instGroupDefs, setInstGroupDefs] = useState([]); // from config_pushes snapshot — there's no instruction_groups DB table
  const [loading, setLoading]       = useState(true);
  const [openItem, setOpenItem]     = useState(null);
  const [showCart, setShowCart]     = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [confirmation, setConfirmation] = useState(null); // { id, when, type }
  const [trackerRef, setTrackerRef] = useState(null); // shows OrderTracker for this ref
  const [paymentNotice, setPaymentNotice] = useState(''); // 'cancel' | 'verify_failed' | ''
  // v5.5.145: QR mode skips the welcome/order-type picker — table-side is
  // always dine-in. Online mode keeps the existing welcome flow.
  const [orderType, setOrderType]   = useState(isQr ? 'dine-in' : null);
  const [showLoyalty, setShowLoyalty] = useState(false);
  const [loyalty, setLoyalty]       = useState(null); // { phone, verified, customer?, loyalty?, giftCards?, stampCards?, token? }
  const [cart, setCart]             = useState([]);
  const [activeAllergens, setActiveAllergens] = useState([]); // user-picked filters
  const [showAllergyPicker, setShowAllergyPicker] = useState(false);
  const allOrderTypes = useMemo(() => {
    const arr = [{ id: 'collection', label: 'Collection', icon: '🥡', desc: 'Pick up at the venue' }];
    if (location.online_delivery_enabled) arr.push({ id: 'delivery', label: 'Delivery', icon: '🚴', desc: 'Brought to your door' });
    return arr;
  }, [location.online_delivery_enabled]);

  // Once we've loaded menu data, work out the allergen vocabulary
  const knownAllergens = useMemo(() => {
    const set = new Set();
    (items || []).forEach(i => (i.allergens || []).forEach(a => a && set.add(a)));
    return [...set].sort();
  }, [items]);

  // ── v5.5.155: QR open-tab resume via localStorage ───────────────────────
  // On mount, if QR mode + a tab is stashed for this slug+table, fetch all
  // open rounds keyed by the stashed payment_intent_id. If still open in
  // the DB, render the TabResumeScreen; otherwise clear the stale stash.
  useEffect(() => {
    if (!isQr || !location.online_slug || !tableId || !supabase) {
      setResumeChecked(true);
      return;
    }
    let alive = true;
    (async () => {
      // v5.5.159: also list ANY open tab at this tableId (not just the
      // localStorage match). Lets the start screen offer "Settle bill".
      try {
        const { data: anyTabs } = await supabase
          .from('order_queue')
          .select('ref, status, items, total, customer, location_id, created_at')
          .eq('location_id', opsLocationId)
          .eq('source', 'qr')
          .neq('status', 'collected')
          .filter('customer->>tableId', 'eq', String(tableId))
          .filter('customer->>tab_open', 'eq', 'true');
        if (alive && Array.isArray(anyTabs) && anyTabs.length) {
          // Pool by payment_intent_id (one card per tab even if multiple rounds)
          const byPi = {};
          anyTabs.forEach(r => {
            const pi = r.customer?.payment_intent_id;
            if (!pi) return;
            if (!byPi[pi]) byPi[pi] = {
              payment_intent_id: pi,
              stripe_account: r.customer?.stripe_account || null,
              tab_ref: r.customer?.tab_ref || r.ref,
              table_label: r.customer?.tableLabel || tableLabel || tableId,
              pre_auth_amount: Number(r.customer?.pre_auth_amount || 0),
              opened_at: r.customer?.tab_opened_at || r.created_at,
              rounds: [],
              total: 0,
            };
            byPi[pi].rounds.push(r);
            byPi[pi].total += Number(r.total || 0);
          });
          setTableTabs(Object.values(byPi));
        }
      } catch (e) { /* swallow — non-blocking */ }

      const stashed = getStashedTab(location.online_slug, tableId);
      if (!stashed?.payment_intent_id) { if (alive) setResumeChecked(true); return; }
      try {
        // All rounds for this tab share customer.payment_intent_id. Use a
        // jsonb @> filter to find them. status != 'collected' = still open.
        const { data, error } = await supabase
          .from('order_queue')
          .select('ref, status, items, total, customer, location_id')
          .eq('location_id', opsLocationId)
          .eq('source', 'qr')
          .neq('status', 'collected')
          .filter('customer->>payment_intent_id', 'eq', stashed.payment_intent_id);
        if (!alive) return;
        if (error || !data?.length) {
          // Tab no longer open — clear the stale stash
          clearStashedTab(location.online_slug, tableId);
        } else {
          setResumeTab(stashed);
          setResumeRounds(data);
        }
      } catch (e) { console.warn('[OnlineSurface] resume check failed:', e?.message); }
      finally { if (alive) setResumeChecked(true); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isQr, location.online_slug, tableId, opsLocationId]);

  // ── Track-an-existing-order via shareable URL ────────────────────────────
  // Customers can return any time via ?track=OL-ABC12&p=1234 (last-4 digits
  // of the phone they used to place the order). On match we render the
  // OrderTracker; on mismatch we ignore the params so the page renders
  // normally — the URL is shareable but a wrong p doesn't error in front
  // of the customer.
  useEffect(() => {
    const url = new URL(window.location.href);
    const trackRef = url.searchParams.get('track');
    const p4       = url.searchParams.get('p');
    if (!trackRef || !p4 || !supabase) return;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('order_queue').select('ref, customer')
          .eq('ref', trackRef).maybeSingle();
        if (error || !data) return;
        const phone = String(data.customer?.phone || '').replace(/\D/g, '');
        const last4 = phone.slice(-4);
        if (last4 && last4 === String(p4).replace(/\D/g, '').slice(-4)) {
          setTrackerRef(trackRef);
        }
      } catch (e) { console.warn('[OnlineSurface] track lookup failed:', e?.message); }
    })();
  }, []);

  // ── Load menu + branding from OPS DB ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      console.log('[OnlineSurface] load start', { opsLocationId, onlineMenuId });
      if (!opsLocationId || !supabase) { setLoading(false); return; }
      try {
        // Each query independent — wrap in Promise.allSettled so a single
        // failure (e.g. missing instruction_groups table) doesn't kill
        // the whole load. Instruction defs come from the config_pushes
        // snapshot since there's no dedicated DB table for them.
        const [iRes, cRes, lRes, mRes, pRes, eRes, tRes, sRes] = await Promise.allSettled([
          supabase.from('menu_items').select('*')
            .eq('location_id', opsLocationId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*')
            .eq('location_id', opsLocationId).order('sort_order'),
          supabase.from('locations').select('receipt_branding')
            .eq('id', opsLocationId).maybeSingle(),
          onlineMenuId
            ? supabase.from('menu_category_links').select('category_id').eq('menu_id', onlineMenuId)
            : Promise.resolve({ data: null }),
          supabase.from('config_pushes').select('snapshot')
            .eq('location_id', opsLocationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
          // v5.5.141: live 86 list — manual operator 86s + auto-86s when
          // dailyCounts.remaining hits 0 both land in this table.
          supabase.from('eighty_six').select('item_id').eq('location_id', opsLocationId),
          // v5.5.154: tax rates — UK VAT must show on every customer-
          // facing total for compliance. Selecting the columns calculateOrderTax needs.
          supabase.from('tax_rates').select('id, name, rate, type, active').eq('location_id', opsLocationId),
          // v5.5.239: stock levels for remaining-count display + availability check
          supabase.from('stock_levels').select('item_id, par, remaining').eq('location_id', opsLocationId),
        ]);
        if (!alive) return;
        const itemsData      = iRes.value?.data || [];
        const categoriesData = cRes.value?.data || [];
        const linksData      = mRes.value?.data || null;
        const brandingData   = lRes.value?.data?.receipt_branding || null;
        const snap           = pRes.value?.data?.snapshot || null;

        let cats = categoriesData;
        if (linksData) {
          const linked = new Set(linksData.map(l => l.category_id));
          cats = cats.filter(c => linked.has(c.id) || (c.parent_id && linked.has(c.parent_id)));
        }
        console.log('[OnlineSurface] fetch results', {
          items: itemsData.length, categories: cats.length,
          configPushFound: !!snap, instructionGroupDefs: snap?.instructionGroupDefs?.length || 0,
          itemsErr: iRes.reason?.message || iRes.value?.error?.message,
          catsErr:  cRes.reason?.message || cRes.value?.error?.message,
          linksErr: mRes.reason?.message || mRes.value?.error?.message,
        });
        setItems(itemsData);
        setCategories(cats);
        setBranding(location.online_branding || brandingData);
        setInstGroupDefs(Array.isArray(snap?.instructionGroupDefs) ? snap.instructionGroupDefs : []);
        setEightySixIds((eRes.value?.data || []).map(r => r.item_id));
        // v5.5.154: only keep active rates; calculateOrderTax also filters
        // but doing it once here keeps the cart breakdown loop tight.
        setTaxRates((tRes.value?.data || []).filter(r => r.active !== false));
        // v5.5.239: stock levels — build { itemId: { par, remaining } } map
        const stockData = sRes.value?.data || [];
        if (stockData.length) {
          const counts = {};
          stockData.forEach(r => { counts[r.item_id] = { par: r.par, remaining: r.remaining }; });
          setStockLevels(counts);
        }
      } catch (e) {
        console.warn('[OnlineSurface] load failed:', e?.message, e);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    // v5.5.141: subscribe to eighty_six realtime so the customer's menu
    // page reflects 86s in real time (operator 86s an item mid-browse →
    // it greys out instantly without a refresh). Same channel pattern the
    // operator-side realtime.js uses, scoped to this location.
    let e86chan = null;
    if (supabase && opsLocationId) {
      e86chan = supabase.channel(`online-86:${opsLocationId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'eighty_six',
          filter: `location_id=eq.${opsLocationId}`,
        }, (payload) => {
          if (!alive) return;
          const id = payload.new?.item_id || payload.old?.item_id;
          if (!id) return;
          if (payload.eventType === 'INSERT') {
            setEightySixIds(prev => prev.includes(id) ? prev : [...prev, id]);
          } else if (payload.eventType === 'DELETE') {
            setEightySixIds(prev => prev.filter(x => x !== id));
          }
        }).subscribe();
    }

    // v5.5.239: subscribe to stock_levels realtime so counts update live
    let stockChan = null;
    if (supabase && opsLocationId) {
      stockChan = supabase.channel(`online-stock:${opsLocationId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'stock_levels',
          filter: `location_id=eq.${opsLocationId}`,
        }, (payload) => {
          if (!alive) return;
          const row = payload.new || payload.old;
          const itemId = row?.item_id;
          if (!itemId) return;
          if (payload.eventType === 'DELETE') {
            setStockLevels(prev => { const n = { ...prev }; delete n[itemId]; return n; });
          } else {
            setStockLevels(prev => ({
              ...prev, [itemId]: { par: payload.new.par, remaining: payload.new.remaining },
            }));
          }
        }).subscribe();
    }

    return () => {
      alive = false;
      if (e86chan && supabase) supabase.removeChannel(e86chan);
      if (stockChan && supabase) supabase.removeChannel(stockChan);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsLocationId, onlineMenuId]);

  const theme = useMemo(() => ({
    accent: branding?.accent_color || FALLBACK_ACCENT,
    bg:     branding?.background    || FALLBACK_BG,
    fg:     branding?.foreground    || FALLBACK_FG,
    logo:   branding?.logo_url      || null,
    hero:   branding?.hero_url      || null,
    name:   location.name           || 'Restaurant',
    isLight: isLightBackground(branding?.background || FALLBACK_BG),
  }), [branding, location.name]);

  const topCategories = useMemo(
    () => (categories || []).filter(c => !c.parent_id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    [categories]
  );

  // Children index — used to detect variant parents and show "from £X"
  // (cheapest child) instead of the parent's £0 base price.
  const childrenByParent = useMemo(() => {
    const map = {};
    (items || []).forEach(i => {
      if (i.parent_id) {
        if (!map[i.parent_id]) map[i.parent_id] = [];
        map[i.parent_id].push(i);
      }
    });
    return map;
  }, [items]);

  const variantInfo = (item) => {
    const kids = childrenByParent[item.id];
    if (!kids?.length) return null;
    const prices = kids
      .map(k => Number(k.pricing?.base ?? k.price ?? 0))
      .filter(p => p > 0);
    return { kids, fromPrice: prices.length ? Math.min(...prices) : 0 };
  };

  const itemsForCat = (catId) => (items || []).filter(i => {
    if (i.parent_id || i.archived || i.sold_alone === false) return false;
    if (!(i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))) return false;
    if (activeAllergens.length && (i.allergens || []).some(a => activeAllergens.includes(a))) return false;
    return true;
  });

  // ── Cart math ────────────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, l) => s + (l.qty || 1), 0);
  const cartTotal = cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0);

  const addToCart = (item, mods, qty) => {
    const price = Number(item.pricing?.base ?? item.price ?? 0);
    // v5.5.128: snapshot category info on the cart line so production
    // routing on the operator side can bucket the item to the right
    // kitchen station regardless of whether the master device's local
    // menu cache has the row. cat / cats / parentId / kitchenName are
    // exactly the fields routeKioskOrderPrints.centresForItem reads.
    setCart(c => [...c, {
      uid: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      itemId: item.id,
      name: item.menu_name || item.name,
      kitchenName: item.kitchen_name || item.kitchenName || null,
      cat: item.cat || null,
      cats: Array.isArray(item.cats) ? item.cats : null,
      parentId: item.parent_id || item.parentId || null,
      // v5.5.154: snapshot tax info so the cart + checkout VAT breakdown
      // works without re-fetching menu_items for each line.
      taxRateId: item.tax_rate_id || item.taxRateId || null,
      taxOverrides: item.tax_overrides || item.taxOverrides || {},
      price, qty, mods,
    }]);
    setOpenItem(null);
  };
  const removeFromCart = (uid) => setCart(c => c.filter(l => l.uid !== uid));
  const updateQty = (uid, qty) => setCart(c => c.map(l => l.uid === uid ? { ...l, qty: Math.max(1, qty) } : l));

  const muted    = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBg   = theme.isLight ? '#fafafa' : '#16161a';
  const cardBdr  = theme.isLight ? '#ececef' : '#2a2a30';
  const headerBg = theme.isLight ? 'rgba(255,255,255,0.95)' : 'rgba(14,14,16,0.95)';

  // v5.5.147: QR confirm-table gate. Per-location qr_table_mode controls
  // whether the customer is forced through this screen:
  //   'fixed'   — skip entirely; QR scan locks the table
  //   'confirm' — show "You're at Table T5? Yes / Change" once
  //   'free'    — no table id in URL; customer types one before menu
  // State: tableConfirmed=true once the gate is passed; the chosen
  // tableLabel becomes the working table for the rest of the flow.
  const qrTableMode = location.qr_table_mode || 'confirm';
  const needsConfirm = isQr && (qrTableMode === 'confirm' || qrTableMode === 'free' || !tableId);
  const [tableConfirmed, setTableConfirmed] = useState(!needsConfirm);
  const [confirmedTable, setConfirmedTable] = useState(tableLabel || tableId || '');
  const effectiveTableLabel = tableConfirmed ? (confirmedTable || tableLabel || tableId) : null;

  if (isQr && !tableConfirmed) {
    return (
      <ScrollShell theme={theme}>
        <ConfirmTableScreen
          theme={theme} cardBdr={theme.isLight ? '#ececef' : '#2a2a30'} muted={theme.isLight ? '#6b6b70' : '#a0a0a8'}
          locationName={location.name}
          presetLabel={tableLabel || tableId || ''}
          mode={qrTableMode}
          openTabs={tableTabs}
          onSettleTab={(tab) => {
            // v5.5.159: jump straight to TabResumeScreen for the picked tab.
            setPickedTableTab(tab);
            setResumeTab({
              payment_intent_id: tab.payment_intent_id,
              stripe_account: tab.stripe_account,
              tab_ref: tab.tab_ref,
              table_label: tab.table_label,
              pre_auth_amount: tab.pre_auth_amount,
            });
            setResumeRounds(tab.rounds || []);
            setResumeChecked(true);
            setTableConfirmed(true);
          }}
          onConfirm={(label) => { setConfirmedTable(label); setTableConfirmed(true); }}/>
      </ScrollShell>
    );
  }

  // v5.5.155: QR tab-resume gate. Renders before the menu / cart so a
  // returning customer's tab is the FIRST thing they see. existingTab is
  // null until they tap Add more — until then the resume screen is the
  // only thing on screen. After Add more, the menu loads and a small
  // "Adding to Table 4.1 · £23.50 so far" badge surfaces in the header
  // (built next).
  if (isQr && resumeChecked && resumeTab && !existingTab) {
    const runningTotal = (resumeRounds || []).reduce((s, r) => s + Number(r.total || 0), 0);
    return (
      <ScrollShell theme={theme}>
        <TabResumeScreen
          slug={location.online_slug}
          tableId={tableId}
          tableLabel={effectiveTableLabel}
          tab={resumeTab}
          rounds={resumeRounds}
          runningTotal={runningTotal}
          theme={theme}
          onAddMore={() => setExistingTab({ ...resumeTab, runningTotal, rounds: resumeRounds })}
          onClosed={() => {
            setResumeTab(null); setResumeRounds([]); setExistingTab(null);
            setTrackerRef(resumeTab.tab_ref); // jump to live tracker
          }}
          onAbandon={() => {
            clearStashedTab(location.online_slug, tableId);
            setResumeTab(null); setResumeRounds([]);
          }}/>
      </ScrollShell>
    );
  }

  // If we're tracking a paid order, that's the only thing on screen.
  if (trackerRef) {
    return (
      <OrderTracker orderRef={trackerRef} locationId={opsLocationId} theme={theme}
        onClose={() => { setTrackerRef(null); if (!isQr) setOrderType(null); }}/>
    );
  }

  // Welcome step — first thing customers see
  if (!orderType) {
    return (
      <ScrollShell theme={theme}>
        {paymentNotice === 'cancel' && (
          <div style={{
            position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 70,
            padding: '12px 18px', borderRadius: 12, background: '#fef3c7',
            border: '1px solid #f59e0b', color: '#78350f', fontSize: 13, fontWeight: 700,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}>Payment cancelled — your order wasn't placed.</div>
        )}
        {paymentNotice === 'verify_failed' && (
          <div style={{
            position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 70,
            padding: '12px 18px', borderRadius: 12, background: '#fee2e2',
            border: '1px solid #ef4444', color: '#7f1d1d', fontSize: 13, fontWeight: 700,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}>Couldn't confirm payment. If you were charged, contact the venue with your order ref.</div>
        )}
        <Welcome
          theme={theme}
          orderTypes={allOrderTypes}
          loyalty={loyalty}
          onPickType={setOrderType}
          onLoyalty={() => setShowLoyalty(true)}/>
        {showLoyalty && (
          <LoyaltyModal theme={theme} cardBdr={cardBdr} muted={muted}
            companyId={location.company_id}
            onClose={() => setShowLoyalty(false)}
            onVerified={(phone, data) => { setLoyalty({ phone, verified: true, ...data }); setShowLoyalty(false); }}/>
        )}
      </ScrollShell>
    );
  }

  return (
    <ScrollShell theme={theme} extraBottomPad={cart.length > 0 ? 96 : 0}>
      {/* HERO with overlay logo */}
      <Hero theme={theme} muted={muted}
        leadMin={Number(location.online_collection_lead_min) || 0}
        tableLabel={isQr ? effectiveTableLabel : null}/>

      {/* Sticky header — order-type pill + allergy filter + loyalty + categories */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 8,
        background: headerBg, backdropFilter: 'saturate(180%) blur(12px)',
        WebkitBackdropFilter: 'saturate(180%) blur(12px)',
        borderBottom: `1px solid ${cardBdr}`,
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '12px 20px 0',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          {theme.logo && (
            <img src={theme.logo} alt={theme.name}
              style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}/>
          )}
          <div style={{ fontSize: 15, fontWeight: 800, flexShrink: 0, marginRight: 'auto' }}>{theme.name}</div>

          {/* v5.5.145: QR mode shows a static "Table T5" chip; online mode
              keeps the changeable order-type pill. */}
          {isQr ? (
            <span style={{
              padding: '6px 12px', borderRadius: 99,
              background: `${theme.accent}18`, color: theme.fg,
              border: `1px solid ${theme.accent}55`,
              fontSize: 12, fontWeight: 800, fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span>📱</span>
              <span>Table {effectiveTableLabel || '?'}</span>
            </span>
          ) : (
            <button onClick={() => setOrderType(null)} className="op-btn" style={{
              padding: '6px 12px', borderRadius: 99,
              background: `${theme.accent}18`, color: theme.fg,
              border: `1px solid ${theme.accent}55`,
              fontSize: 12, fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span>{orderType === 'collection' ? '🥡' : '🚴'}</span>
              <span>{orderType === 'collection' ? 'Collection' : 'Delivery'}</span>
              <span style={{ opacity: 0.5, fontSize: 11 }}>↓</span>
            </button>
          )}

          {/* Allergy filter — only shown when there are allergens to filter */}
          {knownAllergens.length > 0 && (
            <button onClick={() => setShowAllergyPicker(true)} className="op-btn" style={{
              padding: '6px 12px', borderRadius: 99,
              background: activeAllergens.length ? '#ef444420' : 'transparent',
              color: activeAllergens.length ? '#ef4444' : theme.fg,
              border: `1px solid ${activeAllergens.length ? '#ef4444' : cardBdr}`,
              fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span>⚠️</span>
              <span>{activeAllergens.length ? `${activeAllergens.length} allergy filter${activeAllergens.length === 1 ? '' : 's'}` : 'Allergies'}</span>
            </button>
          )}

          {/* Loyalty / sign-in */}
          <button onClick={() => { if (!loyalty?.verified) setShowLoyalty(true); }} className="op-btn" style={{
            padding: '6px 12px', borderRadius: 99,
            background: loyalty?.verified ? `${theme.accent}18` : 'transparent',
            color: loyalty?.verified ? theme.accent : theme.fg,
            border: `1px solid ${loyalty?.verified ? theme.accent + '44' : cardBdr}`,
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: loyalty?.verified ? 'default' : 'pointer',
          }}>
            {loyalty?.verified
              ? `✦ ${loyalty.customer?.name?.split(' ')[0] || loyalty.phone}${loyalty.loyalty?.points_balance ? ` · ${loyalty.loyalty.points_balance} pts` : ''}`
              : '✦ Sign in for rewards'}
          </button>
        </div>

        {/* Category chips */}
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '6px 20px 10px',
          overflowX: 'auto', whiteSpace: 'nowrap',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none', msOverflowStyle: 'none',
        }}>
          {topCategories.map(c => {
            if (itemsForCat(c.id).length === 0) return null;
            return (
              <button key={c.id} className="op-btn" onClick={() => {
                document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }} style={{
                display: 'inline-block', padding: '7px 13px', marginRight: 6,
                borderRadius: 99,
                background: 'transparent', color: theme.fg,
                border: `1.5px solid ${cardBdr}`,
                fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              }}>{c.label || c.name}</button>
            );
          })}
        </div>
      </div>

      {/* Allergy banner — visible across pages while a filter is active */}
      {activeAllergens.length > 0 && (
        <div style={{
          maxWidth: 1100, margin: '0 auto', padding: '12px 20px 0',
        }}>
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            background: '#ef444415', border: '1px solid #ef444455',
            fontSize: 12, color: '#b91c1c', fontWeight: 600, lineHeight: 1.5,
          }}>
            ⚠ Showing items free from <b>{activeAllergens.join(', ')}</b>. Items containing those allergens are hidden from the menu. Always confirm with the venue if you have a severe allergy.
          </div>
        </div>
      )}

      {/* MENU body */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 40px' }}>
        {loading && <div style={{ padding: 80, textAlign: 'center', color: muted }}>Loading menu…</div>}

        {!loading && items.length === 0 && (
          <div style={{ padding: 60, textAlign: 'center', color: muted }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Menu is empty right now.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Check back later or contact the venue directly.</div>
          </div>
        )}

        {!loading && items.length > 0 && topCategories.map(cat => {
          const catItems = itemsForCat(cat.id);
          if (!catItems.length) return null;
          return (
            <section key={cat.id} id={`cat-${cat.id}`} style={{ marginBottom: 36, scrollMarginTop: 80 }}>
              <h2 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 14px',
                letterSpacing: '-0.02em',
              }}>{cat.label || cat.name}</h2>
              <div style={{ display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                gap: 14,
              }}>
                {catItems.map(item => {
                  // v5.5.141: variant parent is sold-out only when ALL of its
                  // children are 86'd. Single-variant 86 still leaves the
                  // parent tappable so the customer can pick a sibling size.
                  const vinfo = variantInfo(item);
                  const itemSoldOut = isItemEightySixed(item, eightySixIds);
                  const variantsAllSoldOut = vinfo?.kids?.length
                    ? vinfo.kids.every(k => isItemEightySixed(k, eightySixIds))
                    : false;
                  const is86 = itemSoldOut || variantsAllSoldOut;
                  const stock = stockLevels[item.id] || null;
                  return (
                    <ItemCard key={item.id} item={item} theme={theme}
                      cardBg={cardBg} cardBdr={cardBdr} muted={muted}
                      variantInfo={vinfo}
                      is86={is86}
                      stock={stock}
                      onPick={() => is86 ? null : setOpenItem(item)}/>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* Floating cart CTA */}
      {cart.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 20,
          padding: '14px 16px calc(14px + env(safe-area-inset-bottom)) 16px',
          background: headerBg, backdropFilter: 'saturate(180%) blur(12px)',
          WebkitBackdropFilter: 'saturate(180%) blur(12px)',
          borderTop: `1px solid ${cardBdr}`,
          display: 'flex', justifyContent: 'center',
        }}>
          <button onClick={() => setShowCart(true)} className="op-btn-primary" style={{
            width: '100%', maxWidth: 540,
            padding: '16px 22px', borderRadius: 14,
            background: theme.accent, color: contrastFg(theme.accent),
            border: 'none', fontSize: 16, fontWeight: 800, fontFamily: 'inherit',
            cursor: 'pointer', boxShadow: '0 10px 24px rgba(0,0,0,0.15)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{cartCount} item{cartCount === 1 ? '' : 's'} · View basket</span>
            <span>£{cartTotal.toFixed(2)}</span>
          </button>
        </div>
      )}

      {openItem && (
        <OnlineItemSheet
          item={openItem} theme={theme} allItems={items} orderType={orderType}
          instGroupDefs={instGroupDefs}
          eightySixIds={eightySixIds}
          onClose={() => setOpenItem(null)}
          onAdd={(item, mods, qty) => addToCart(item, mods, qty)}
        />
      )}

      {showCart && (
        <OnlineCart
          cart={cart} theme={theme} orderType={orderType}
          taxRates={taxRates}
          onClose={() => setShowCart(false)}
          onRemove={removeFromCart} onUpdateQty={updateQty}
          onCheckout={() => {
            setShowCart(false);
            setShowCheckout(true);
          }}
        />
      )}

      {showCheckout && !isQr && (
        <OnlineCheckout
          cart={cart} theme={theme} location={location}
          orderType={orderType} loyalty={loyalty}
          taxRates={taxRates}
          onClose={() => setShowCheckout(false)}
          onOpenLoyalty={() => { setShowCheckout(false); setShowLoyalty(true); }}
          onLoyaltyVerified={(ph, data) => { setLoyalty({ phone: ph, verified: true, ...data }); }}
          onPlaced={(info) => {
            setShowCheckout(false);
            setCart([]);
            setTrackerRef(info.ref); // → live OrderTracker
          }}/>
      )}
      {showCheckout && isQr && (
        <QrCheckout
          cart={cart} theme={theme} location={location}
          tableId={tableId} tableLabel={effectiveTableLabel}
          taxRates={taxRates}
          existingTab={existingTab}
          loyalty={loyalty}
          onClose={() => setShowCheckout(false)}
          onPlaced={(info) => {
            setShowCheckout(false);
            setCart([]);
            setTrackerRef(info.ref);
          }}/>
      )}

      {confirmation && (
        <ConfirmationModal
          theme={theme} cardBdr={cardBdr} muted={muted}
          info={confirmation}
          onClose={() => setConfirmation(null)}/>
      )}

      {showAllergyPicker && (
        <AllergyPickerModal
          theme={theme} cardBdr={cardBdr}
          all={knownAllergens}
          active={activeAllergens}
          onClose={() => setShowAllergyPicker(false)}
          onSave={(next) => { setActiveAllergens(next); setShowAllergyPicker(false); }}/>
      )}

      {showLoyalty && (
        <LoyaltyModal theme={theme} cardBdr={cardBdr} muted={muted}
          companyId={location.company_id}
          onClose={() => setShowLoyalty(false)}
          onVerified={(phone, data) => { setLoyalty({ phone, verified: true, ...data }); setShowLoyalty(false); }}/>
      )}
    </ScrollShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScrollShell — wraps the surface in its own scroll container so we don't
// inherit the operator app's body { overflow: hidden } from globals.css.
function ScrollShell({ theme, extraBottomPad = 0, children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
      background: theme.bg, color: theme.fg,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      paddingBottom: extraBottomPad,
    }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome — first thing the customer sees. They pick collection vs delivery
// before menu loads. Loyalty entry sits below the order-type buttons.
function Welcome({ theme, orderTypes, loyalty, onPickType, onLoyalty }) {
  const heroBg = theme.hero
    ? `linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.65) 100%), url(${theme.hero}) center/cover no-repeat`
    : `linear-gradient(135deg, ${theme.accent}, ${shade(theme.accent, -25)})`;
  return (
    <div style={{
      minHeight: '100%', background: heroBg, color: '#fff',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '40px 20px', textAlign: 'center',
    }}>
      <div style={{ maxWidth: 480, width: '100%' }}>
        {theme.logo
          ? <img src={theme.logo} alt={theme.name} style={{
              width: 100, height: 100, borderRadius: 22, objectFit: 'cover',
              border: '4px solid #fff', boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
              margin: '0 auto 18px',
            }}/>
          : <div style={{
              width: 100, height: 100, borderRadius: 22,
              background: theme.accent, color: contrastFg(theme.accent),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 44, fontWeight: 900, border: '4px solid #fff',
              boxShadow: '0 8px 28px rgba(0,0,0,0.4)', margin: '0 auto 18px',
            }}>{theme.name[0]}</div>
        }
        <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.025em',
          textShadow: '0 2px 8px rgba(0,0,0,0.5)', marginBottom: 4,
        }}>{theme.name}</div>
        <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.95,
          textShadow: '0 1px 4px rgba(0,0,0,0.4)', marginBottom: 32,
        }}>How would you like to order?</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {orderTypes.map(t => (
            <button key={t.id} className="op-btn-primary" onClick={() => onPickType(t.id)} style={{
              padding: '20px 22px', borderRadius: 16,
              background: 'rgba(255,255,255,0.95)', color: '#1a1a1a',
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left',
              boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
              transition: 'transform .12s ease',
            }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = ''; }}>
              <div style={{ fontSize: 28 }}>{t.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 800 }}>{t.label}</div>
                <div style={{ fontSize: 12, color: '#6b6b70', marginTop: 2 }}>{t.desc}</div>
              </div>
              <div style={{ fontSize: 22, color: '#9a9aa1' }}>→</div>
            </button>
          ))}
        </div>

        {/* Loyalty entry */}
        <button onClick={() => { if (!loyalty?.verified) onLoyalty(); }} style={{
          marginTop: 24, padding: loyalty?.verified ? '14px 24px' : '12px 20px', borderRadius: loyalty?.verified ? 16 : 99,
          background: loyalty?.verified ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.18)',
          color: loyalty?.verified ? '#1a1a1a' : '#fff',
          border: loyalty?.verified ? 'none' : '1px solid rgba(255,255,255,0.5)',
          fontSize: 13, fontWeight: 700, cursor: loyalty?.verified ? 'default' : 'pointer', fontFamily: 'inherit',
          backdropFilter: loyalty?.verified ? 'none' : 'saturate(180%) blur(8px)',
          boxShadow: loyalty?.verified ? '0 4px 14px rgba(0,0,0,0.18)' : 'none',
          textAlign: 'center',
        }}>
          {loyalty?.verified
            ? <>
                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 2 }}>
                  ✦ Welcome{loyalty.customer?.name ? `, ${loyalty.customer.name.split(' ')[0]}` : ''}!
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b6b70' }}>
                  {loyalty.loyalty?.points_balance ? `${loyalty.loyalty.points_balance} points` : 'Earning points on this order'}
                </div>
              </>
            : '✦ Sign in for loyalty rewards'}
        </button>

        <div style={{ marginTop: 32, fontSize: 11, opacity: 0.75, textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Allergy picker — minimal modal that lets the customer toggle which
// allergens to filter out. Mirrors the kiosk's allergen flow.
function AllergyPickerModal({ theme, cardBdr, all, active, onClose, onSave }) {
  const [picked, setPicked] = useState(active);
  const togglePick = (a) => setPicked(p => p.includes(a) ? p.filter(x => x !== a) : [...p, a]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '14px 0 6px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>
        <div style={{ padding: '12px 22px 6px' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>Allergy filter</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, lineHeight: 1.55 }}>
            We'll hide items containing any of the allergens you pick. <b>Always confirm with the venue</b> if you have a severe allergy — accidental cross-contamination is possible.
          </div>
        </div>
        <div style={{ padding: '12px 22px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {all.length === 0 ? (
            <div style={{ fontSize: 13, opacity: 0.6, padding: 12 }}>No allergen tags on this menu yet.</div>
          ) : all.map(a => {
            const on = picked.includes(a);
            return (
              <button key={a} onClick={() => togglePick(a)} style={{
                padding: '9px 14px', borderRadius: 99, fontFamily: 'inherit', cursor: 'pointer',
                background: on ? '#ef4444' : 'transparent',
                color: on ? '#fff' : theme.fg,
                border: `1.5px solid ${on ? '#ef4444' : cardBdr}`,
                fontSize: 13, fontWeight: 700,
                textTransform: 'capitalize',
              }}>{on ? '✓ ' : ''}{a}</button>
            );
          })}
        </div>
        <div style={{ padding: '16px 22px calc(14px + env(safe-area-inset-bottom)) 22px', display: 'flex', gap: 10 }}>
          <button onClick={() => onSave([])} style={{
            padding: '12px 18px', borderRadius: 12,
            background: 'transparent', color: theme.fg, border: `1.5px solid ${cardBdr}`,
            fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>Clear all</button>
          <button onClick={() => onSave(picked)} style={{
            flex: 1, padding: '12px 18px', borderRadius: 12,
            background: theme.accent, color: contrastFg(theme.accent),
            border: 'none', fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
          }}>Apply{picked.length ? ` (${picked.length})` : ''}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Loyalty modal — phone capture + SMS OTP verification via loyalty-otp edge function.
function LoyaltyModal({ theme, cardBdr, muted, companyId, onClose, onVerified }) {
  const [step, setStep] = useState('phone'); // phone | code | done
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  const [loyaltyData, setLoyaltyData] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const otpUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-otp`;

  const sendCode = async () => {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.length < 10) { setErr('Enter a valid UK mobile number.'); return; }
    if (!companyId) { setErr('Unable to resolve venue. Please try again.'); return; }
    setErr(''); setWorking(true);
    try {
      const res = await fetch(otpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', phone: cleaned, company_id: companyId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setStep('code');
    } catch (e) {
      setErr(e?.message || 'Failed to send code. Please try again.');
    } finally {
      setWorking(false);
    }
  };

  const verify = async () => {
    const cleaned = code.replace(/\D/g, '');
    if (cleaned.length < 6) { setErr('Enter the 6-digit code from your text message.'); return; }
    setErr(''); setWorking(true);
    try {
      const res = await fetch(otpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', phone: phone.replace(/[^\d+]/g, ''), company_id: companyId, code: cleaned }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Invalid code. Please try again.');
      if (j.verified) {
        setLoyaltyData(j);
        setStep('done');
        // Brief delay so user sees the success state before modal closes
        timerRef.current = setTimeout(() => {
          onVerified(phone.replace(/[^\d+]/g, ''), {
            customer: j.customer,
            loyalty: j.loyalty,
            giftCards: j.gift_cards,
            stampCards: j.stamp_cards,
            token: j.token,
          });
        }, 800);
      } else {
        throw new Error('Verification failed. Check the code and try again.');
      }
    } catch (e) {
      setErr(e?.message || 'Verification failed.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460,
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0', boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
      }}>
        <div style={{ padding: '14px 0 6px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>
        <div style={{ padding: '12px 24px 24px' }}>
          {step === 'done' ? (
            <>
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✦</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: theme.accent, marginBottom: 6 }}>
                  Welcome{loyaltyData?.customer?.name ? `, ${loyaltyData.customer.name.split(' ')[0]}` : ''}!
                </div>
                {loyaltyData?.loyalty?.points_balance > 0 && (
                  <div style={{ fontSize: 14, fontWeight: 700, color: theme.fg }}>
                    {loyaltyData.loyalty.points_balance} points available
                  </div>
                )}
                <div style={{ fontSize: 13, color: muted, marginTop: 8 }}>
                  You'll earn points on this order automatically.
                </div>
                {/* Wallet buttons */}
                {loyaltyData?.loyalty?.member_code && (
                  <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <WalletButton type="apple" theme={theme} cardBdr={cardBdr}
                      token={loyaltyData.token} companyId={companyId}/>
                    <WalletButton type="google" theme={theme} cardBdr={cardBdr}
                      token={loyaltyData.token} companyId={companyId}/>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 4 }}>
                ✦ Loyalty rewards
              </div>
              <div style={{ fontSize: 13, color: muted, lineHeight: 1.55, marginBottom: 20 }}>
                Sign in with your phone to earn points on every order. We'll text you a code to confirm it's you. No spam — ever.
              </div>

              {step === 'phone' && (
                <>
                  <label style={{ fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                    Mobile number
                  </label>
                  <input type="tel" inputMode="tel"
                    placeholder="07700 900000"
                    value={phone}
                    onChange={e => { setPhone(e.target.value); setErr(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') sendCode(); }}
                    style={inputStyle(theme, cardBdr)}/>
                  {err && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{err}</div>}
                  <button onClick={sendCode} disabled={working} style={{
                    marginTop: 16, width: '100%', padding: '14px 18px', borderRadius: 12,
                    background: theme.accent, color: contrastFg(theme.accent),
                    border: 'none', fontSize: 15, fontWeight: 800, cursor: 'pointer',
                    fontFamily: 'inherit', opacity: working ? 0.6 : 1,
                  }}>
                    {working ? 'Sending…' : 'Send code'}
                  </button>
                </>
              )}

              {step === 'code' && (
                <>
                  <label style={{ fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                    Code sent to {phone}
                  </label>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={6}
                    value={code}
                    onChange={e => { setCode(e.target.value); setErr(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') verify(); }}
                    autoFocus
                    style={{ ...inputStyle(theme, cardBdr), textAlign: 'center', fontSize: 22, letterSpacing: '0.4em', fontWeight: 800 }}/>
                  {err && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{err}</div>}
                  <button onClick={verify} disabled={working} style={{
                    marginTop: 16, width: '100%', padding: '14px 18px', borderRadius: 12,
                    background: theme.accent, color: contrastFg(theme.accent),
                    border: 'none', fontSize: 15, fontWeight: 800, cursor: 'pointer',
                    fontFamily: 'inherit', opacity: working ? 0.6 : 1,
                  }}>
                    {working ? 'Verifying…' : 'Verify & continue'}
                  </button>
                  <button onClick={() => { setStep('phone'); setErr(''); }} style={{
                    marginTop: 10, width: '100%', padding: '10px', background: 'transparent',
                    border: 'none', color: muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                    textDecoration: 'underline',
                  }}>← Use a different number</button>
                </>
              )}

              <div style={{ marginTop: 18, fontSize: 10, color: muted, lineHeight: 1.5 }}>
                By continuing you agree to receive a one-time text message at the number above.
                Standard rates may apply.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WalletButton — "Add to Apple Wallet" / "Add to Google Wallet" buttons.
// Calls the wallet-pass edge function to generate a .pkpass or Google save URL.
function WalletButton({ type, theme, cardBdr, token, companyId }) {
  const [busy, setBusy] = useState(false);
  const walletUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wallet-pass`;
  const isApple = type === 'apple';

  const handleClick = async () => {
    setBusy(true);
    try {
      const res = await fetch(walletUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: isApple ? 'apple' : 'google',
          token,
          company_id: companyId,
        }),
      });
      if (isApple) {
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'loyalty.pkpass'; a.click();
        URL.revokeObjectURL(url);
      } else {
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
        if (j.url) window.open(j.url, '_blank');
      }
    } catch (e) {
      console.warn(`[WalletButton] ${type} failed:`, e?.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button onClick={handleClick} disabled={busy} style={{
      padding: '8px 16px', borderRadius: 8,
      background: isApple ? '#000' : '#fff',
      color: isApple ? '#fff' : '#000',
      border: `1px solid ${isApple ? '#000' : cardBdr}`,
      fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
      fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      {isApple ? '🍎 Add to Apple Wallet' : '📱 Add to Google Wallet'}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmationModal — shown after a successful order. The kitchen receives
// the ticket at sent_at (collection time minus leadMin) — we just confirm
// to the customer.
function ConfirmationModal({ theme, cardBdr, muted, info, onClose }) {
  const whenLabel = info?.when
    ? new Date(info.when).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : 'as soon as possible';
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460,
        background: theme.bg, color: theme.fg,
        borderRadius: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        padding: 32, textAlign: 'center',
      }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 8 }}>
          Order placed!
        </div>
        <div style={{ fontSize: 14, color: muted, lineHeight: 1.55, marginBottom: 20 }}>
          {info?.type === 'delivery' ? 'Delivery' : 'Collection'} {info?.when ? 'scheduled for' : ''}
          {' '}<b style={{ color: theme.fg }}>{whenLabel}</b>.
          {' '}You'll receive a confirmation shortly.
        </div>
        {info?.id && (
          <div style={{
            padding: '10px 14px', borderRadius: 10,
            background: `${theme.accent}15`, border: `1px solid ${cardBdr}`,
            fontSize: 12, fontWeight: 700, marginBottom: 18,
          }}>
            Order ref: <span style={{ fontFamily: 'monospace', letterSpacing: '0.05em' }}>{info.id}</span>
          </div>
        )}
        <button onClick={onClose} style={{
          width: '100%', padding: '14px 18px', borderRadius: 12,
          background: theme.accent, color: contrastFg(theme.accent),
          border: 'none', fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
        }}>Done</button>
      </div>
    </div>
  );
}

function inputStyle(theme, cardBdr) {
  return {
    width: '100%', padding: '14px 16px', borderRadius: 12,
    background: theme.isLight ? '#f5f5f7' : '#1f1f24',
    color: theme.fg, border: `1.5px solid ${cardBdr}`,
    fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
function Hero({ theme, muted, leadMin, tableLabel }) {
  // Tall hero. Background image OR brand-colour gradient. Logo + name overlaid.
  // Stronger gradient + heavier text-shadows for legibility against any photo.
  // v5.5.146: tableLabel renders a prominent "TABLE T5" badge stacked under
  // the venue name when present. Wait-time + open pills sit inline alongside
  // each other on a single row, so the eye reads top→down: brand → table → state.
  const heroBg = theme.hero
    ? `linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.85) 100%), url(${theme.hero}) center/cover no-repeat`
    : `linear-gradient(135deg, ${theme.accent}, ${shade(theme.accent, -25)})`;
  const leadLabel = leadMin > 0
    ? `${leadMin < 60 ? `${leadMin} min` : `${Math.round(leadMin/60)} h`} ${tableLabel ? 'wait' : 'prep time'}`
    : null;
  return (
    <div style={{
      position: 'relative',
      height: tableLabel ? 320 : 280, background: heroBg, backgroundSize: 'cover',
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      padding: '28px 24px',
      color: '#fff',
    }}>
      {/* Soft fade to page bg at the bottom */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: 60,
        background: `linear-gradient(180deg, transparent, ${theme.bg})`,
        pointerEvents: 'none',
      }}/>
      <div style={{ position: 'relative', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {theme.logo
            ? <img src={theme.logo} alt={theme.name} style={{
                width: tableLabel ? 70 : 84, height: tableLabel ? 70 : 84,
                borderRadius: 18, objectFit: 'cover',
                border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                flexShrink: 0,
              }}/>
            : <div style={{
                width: tableLabel ? 70 : 84, height: tableLabel ? 70 : 84,
                borderRadius: 18,
                background: theme.accent, color: contrastFg(theme.accent),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 38, fontWeight: 900, border: '3px solid #fff',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)', flexShrink: 0,
              }}>{theme.name[0]}</div>
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: tableLabel ? 22 : 34,
              fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1,
              opacity: tableLabel ? 0.92 : 1,
              textShadow: '0 2px 12px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5)',
            }}>{theme.name}</div>

            {/* v5.5.146: prominent table number — only when QR mode passed it. */}
            {tableLabel && (
              <div style={{
                marginTop: 6, fontSize: 38, fontWeight: 900,
                letterSpacing: '-0.025em', lineHeight: 1, color: '#fff',
                textShadow: '0 2px 14px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.5)',
              }}>
                <span style={{ fontSize: 14, opacity: 0.7, fontWeight: 700, letterSpacing: '0.12em', display: 'block', textTransform: 'uppercase', marginBottom: 2 }}>
                  Table
                </span>
                {tableLabel}
              </div>
            )}

            {/* Status pills — single inline row. */}
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 99,
                background: 'rgba(34,197,94,0.95)', color: '#fff',
                fontSize: 12, fontWeight: 800, letterSpacing: '0.02em',
              }}>● Open now</span>
              {leadLabel && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', borderRadius: 99,
                  background: 'rgba(0,0,0,0.55)', color: '#fff',
                  fontSize: 12, fontWeight: 700,
                  border: '1px solid rgba(255,255,255,0.2)',
                  backdropFilter: 'saturate(180%) blur(8px)',
                  WebkitBackdropFilter: 'saturate(180%) blur(8px)',
                }}>⏱ {leadLabel}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemCard({ item, theme, cardBg, cardBdr, muted, onPick, variantInfo, is86 = false, stock = null }) {
  const ownPrice = Number(item.pricing?.base ?? item.price ?? 0);
  const isVariantParent = !!variantInfo?.kids?.length;
  // Variant parents have base price 0; show "from £X" using cheapest child.
  const displayPrice = isVariantParent ? (variantInfo.fromPrice || 0) : ownPrice;
  const allergens = item.allergens || [];
  return (
    <button onClick={is86 ? undefined : onPick} disabled={is86}
      className={is86 ? undefined : 'op-btn'}
      style={{
        display: 'flex', alignItems: 'stretch',
        width: '100%', textAlign: 'left',
        padding: 0, borderRadius: 14, overflow: 'hidden',
        background: cardBg, border: `1px solid ${cardBdr}`,
        color: theme.fg, fontFamily: 'inherit',
        cursor: is86 ? 'not-allowed' : 'pointer',
        opacity: is86 ? 0.55 : 1,
        filter: is86 ? 'grayscale(0.6)' : undefined,
        transition: 'transform .15s ease, box-shadow .15s ease',
        WebkitTapHighlightColor: 'transparent',
        position: 'relative',
      }}
      onMouseEnter={e => { if (!is86) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)'; } }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
    >
      {/* v5.5.141: clear OUT-OF-STOCK badge top-right when 86'd. */}
      {is86 && (
        <div style={{
          position: 'absolute', top: 10, right: 10, zIndex: 2,
          padding: '4px 10px', borderRadius: 99,
          background: '#1a1a1ad9', color: '#fff',
          fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
          textTransform: 'uppercase',
          backdropFilter: 'blur(4px)',
        }}>Out of stock</div>
      )}
      {/* v5.5.239: low-stock badge when tracked and remaining ≤ 40% of par */}
      {!is86 && stock && stock.remaining > 0 && stock.remaining / stock.par <= 0.4 && (
        <div style={{
          position: 'absolute', top: 10, right: 10, zIndex: 2,
          padding: '4px 10px', borderRadius: 99,
          background: '#f59e0bd9', color: '#fff',
          fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
          backdropFilter: 'blur(4px)',
        }}>Only {stock.remaining} left</div>
      )}
      <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3, textDecoration: is86 ? 'line-through' : undefined }}>
          {item.menu_name || item.name}
        </div>
        {item.description && (
          <div style={{ fontSize: 12, color: muted, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {item.description}
          </div>
        )}
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 800 }}>
            {isVariantParent && displayPrice > 0
              ? <><span style={{ fontSize: 11, opacity: 0.7, marginRight: 4 }}>from</span>£{displayPrice.toFixed(2)}</>
              : isVariantParent
                ? <span style={{ fontSize: 12, opacity: 0.7 }}>Various sizes</span>
                : <>£{displayPrice.toFixed(2)}</>}
          </div>
          {isVariantParent && (
            <span style={{
              padding: '2px 8px', borderRadius: 99,
              background: `${theme.accent}25`, color: theme.fg,
              fontSize: 10, fontWeight: 700,
            }}>SIZES</span>
          )}
          {allergens.length > 0 && (
            <span title={`Contains: ${allergens.join(', ')}`} style={{
              padding: '2px 8px', borderRadius: 99,
              background: '#fde6e6', color: '#991b1b',
              fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
              textTransform: 'capitalize',
            }}>⚠ {allergens.length === 1 ? allergens[0] : `${allergens.length} allergens`}</span>
          )}
        </div>
      </div>
      {item.image && (
        <div style={{
          width: 130, flexShrink: 0,
          backgroundImage: `url(${item.image})`,
          backgroundSize: 'cover', backgroundPosition: 'center',
        }}/>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// v5.5.147: ConfirmTableScreen — first thing a QR customer sees in confirm /
// free-type table modes. Pre-fills with the QR-encoded table id when present;
// "Change" or empty preset switches to a numeric input. Locked table mode
// skips this entirely (set tableConfirmed=true on mount).
function ConfirmTableScreen({ theme, cardBdr, muted, locationName, presetLabel, mode, onConfirm, openTabs = [], onSettleTab }) {
  const [editing, setEditing] = useState(mode === 'free' || !presetLabel);
  const [value, setValue] = useState(presetLabel || '');
  const heroBg = theme.hero
    ? `linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.85) 100%), url(${theme.hero}) center/cover no-repeat`
    : `linear-gradient(135deg, ${theme.accent}, ${shade(theme.accent, -25)})`;
  return (
    <div style={{
      minHeight: '100%', background: heroBg, color: '#fff',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '40px 20px', textAlign: 'center',
    }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        {theme.logo && (
          <img src={theme.logo} alt={locationName} style={{
            width: 88, height: 88, borderRadius: 20, objectFit: 'cover',
            border: '3px solid #fff', boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
            margin: '0 auto 18px',
          }}/>
        )}
        <div style={{ fontSize: 14, fontWeight: 700, opacity: 0.9, textShadow: '0 1px 4px rgba(0,0,0,0.4)' }}>
          Welcome to {locationName}
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-0.02em', marginTop: 8, marginBottom: 24,
          textShadow: '0 2px 12px rgba(0,0,0,0.6)',
        }}>
          {editing ? "What's your table number?" : "You're at"}
        </div>

        {!editing && (
          <>
            <div style={{
              fontSize: 76, fontWeight: 900, letterSpacing: '-0.03em',
              padding: '24px 24px',
              background: 'rgba(255,255,255,0.15)', borderRadius: 20,
              border: '2px solid rgba(255,255,255,0.4)',
              backdropFilter: 'saturate(180%) blur(12px)',
              WebkitBackdropFilter: 'saturate(180%) blur(12px)',
              marginBottom: 18,
            }}>
              Table {presetLabel}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => onConfirm(presetLabel)} className="op-btn-primary" style={{
                padding: '18px 22px', borderRadius: 14,
                background: 'rgba(255,255,255,0.95)', color: '#1a1a1a',
                border: 'none', fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
              }}>✓ Yes, that's me — start ordering</button>
              <button onClick={() => { setEditing(true); setValue(''); }} className="op-btn" style={{
                padding: '14px 22px', borderRadius: 14,
                background: 'rgba(255,255,255,0.18)', color: '#fff',
                border: '1px solid rgba(255,255,255,0.4)',
                fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              }}>Wrong table — change</button>
              {/* v5.5.159: settle-from-start. If any tab is open at this
                  table (e.g. left open by an earlier guest), surface a
                  "Settle the bill" entry so anyone at the table can pay. */}
              {openTabs.length > 0 && onSettleTab && (
                <div style={{ marginTop: 18, padding: 14, background:'rgba(0,0,0,0.35)', borderRadius:14, border:'1px solid rgba(255,255,255,0.25)' }}>
                  <div style={{ fontSize:12, fontWeight:800, opacity:0.95, marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>
                    💳 Open bill{openTabs.length > 1 ? 's' : ''} at this table
                  </div>
                  {openTabs.map(t => (
                    <button key={t.payment_intent_id} onClick={() => onSettleTab(t)}
                      style={{
                        width:'100%', padding:'12px 14px', marginBottom:6, borderRadius:10,
                        background:'rgba(255,255,255,0.95)', color:'#1a1a1a', border:'none',
                        fontSize:14, fontWeight:800, cursor:'pointer', fontFamily:'inherit',
                        display:'flex', justifyContent:'space-between', alignItems:'center',
                      }}>
                      <span>Table {t.table_label} · {t.rounds.length} round{t.rounds.length===1?'':'s'}</span>
                      <span>£{t.total.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {editing && (
          <>
            <input type="text" inputMode="numeric" autoFocus
              value={value} onChange={e => setValue(e.target.value)}
              placeholder="e.g. 5"
              style={{
                width: '100%', padding: '22px 18px', borderRadius: 16,
                background: 'rgba(255,255,255,0.95)', color: '#1a1a1a',
                border: 'none', fontSize: 36, fontWeight: 900, fontFamily: 'inherit',
                outline: 'none', boxSizing: 'border-box', textAlign: 'center', letterSpacing: '0.02em',
                boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
              }}/>
            <button onClick={() => value.trim() && onConfirm(value.trim())}
              disabled={!value.trim()} className={value.trim() ? 'op-btn-primary' : undefined}
              style={{
                marginTop: 14, width: '100%', padding: '18px 22px', borderRadius: 14,
                background: value.trim() ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)',
                color: value.trim() ? '#1a1a1a' : '#888',
                border: 'none', fontSize: 16, fontWeight: 800,
                cursor: value.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
              }}>
              ✓ Confirm — start ordering
            </button>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 14, textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
              Look at your table number — it's usually on a small card or sign on the table.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── colour utils ─────────────────────────────────────────────────────────────
function isLightBackground(hex) {
  if (!hex) return true;
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return true;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  // Standard luminance check
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
}
function contrastFg(bgHex) {
  return isLightBackground(bgHex) ? '#0b0c10' : '#ffffff';
}
function shade(hex, percent) {
  if (!hex) return '#000';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  const r = Math.max(0, Math.min(255, parseInt(n.slice(0, 2), 16) + percent));
  const g = Math.max(0, Math.min(255, parseInt(n.slice(2, 4), 16) + percent));
  const b = Math.max(0, Math.min(255, parseInt(n.slice(4, 6), 16) + percent));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}
