// v5.5.108 — Phase 3a: Online ordering surface.
// Customer-facing menu browse + cart for remote (collection/delivery) orders.
// Mounts when CustomerBoot resolves a slug → location with online_enabled
// AND the location is currently within opening hours.
//
// Architecture:
//   • menu loaded from OPS DB via location.ops_location_id (cross-DB)
//   • branding loaded from ops locations.receipt_branding (same row)
//   • cart held in local component state (no central store — this surface
//     stands alone, doesn't share the operator store)
//   • checkout flow (customer details + Stripe) lives in Phase 4
//
// Mobile-first single-column layout. Branded header. Sticky cart bar at the
// bottom showing item count + total + "View cart" tap target.

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import OnlineCart from './OnlineCart';
import OnlineItemSheet from './OnlineItemSheet';

const FALLBACK_ACCENT = '#e8a020';
const FALLBACK_BG     = '#0e0e10';
const FALLBACK_FG     = '#ffffff';

export default function OnlineSurface({ location }) {
  const opsLocationId = location.ops_location_id || location.id; // legacy rows
  const [items, setItems]           = useState([]);
  const [categories, setCategories] = useState([]);
  const [branding, setBranding]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [activeCat, setActiveCat]   = useState(null);
  const [cart, setCart]             = useState([]); // [{ uid, itemId, name, price, qty, mods: [] }]
  const [openItem, setOpenItem]     = useState(null);
  const [showCart, setShowCart]     = useState(false);
  const [orderType, setOrderType]   = useState('collection'); // collection | delivery

  // ── Load menu + branding from ops DB ────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!opsLocationId || !supabase) { setLoading(false); return; }
      try {
        const [iRes, cRes, lRes] = await Promise.all([
          supabase.from('menu_items')
            .select('id, name, menu_name, description, pricing, cat, cats, parent_id, type, allergens, image, sort_order, sold_alone, archived, assigned_modifier_groups')
            .eq('location_id', opsLocationId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories')
            .select('id, label, name, sort_order, parent_id')
            .eq('location_id', opsLocationId).order('sort_order'),
          supabase.from('locations')
            .select('receipt_branding')
            .eq('id', opsLocationId).maybeSingle(),
        ]);
        if (!alive) return;
        setItems(iRes.data || []);
        setCategories(cRes.data || []);
        setBranding(lRes.data?.receipt_branding || null);
        setActiveCat((cRes.data || []).find(c => !c.parent_id)?.id || null);
      } catch (e) {
        console.warn('[OnlineSurface] load failed:', e?.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [opsLocationId]);

  // ── Theme — branding overrides fallback ──────────────────────────────────
  const theme = useMemo(() => ({
    accent: branding?.accent_color || FALLBACK_ACCENT,
    bg:     branding?.background    || FALLBACK_BG,
    fg:     branding?.foreground    || FALLBACK_FG,
    logo:   branding?.logo_url      || null,
    hero:   branding?.hero_url      || null,
    name:   location.name           || 'Restaurant',
  }), [branding, location.name]);

  // ── Visible top-level categories + items grouped by cat ──────────────────
  const topCategories = useMemo(
    () => (categories || []).filter(c => !c.parent_id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    [categories]
  );

  const itemsForCat = (catId) => (items || []).filter(i =>
    !i.parent_id && !i.archived && i.sold_alone !== false &&
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))
  );

  // ── Cart math ────────────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, l) => s + (l.qty || 1), 0);
  const cartTotal = cart.reduce((s, l) => s + (l.price * (l.qty || 1)) + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0) * (l.qty || 1), 0);

  const addToCart = (item, mods = [], qty = 1) => {
    const price = Number(item.pricing?.base ?? item.price ?? 0);
    setCart(c => [...c, {
      uid: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      itemId: item.id,
      name: item.menu_name || item.name,
      price,
      qty,
      mods,
    }]);
    setOpenItem(null);
  };
  const removeFromCart = (uid) => setCart(c => c.filter(l => l.uid !== uid));
  const updateQty = (uid, qty) => setCart(c => c.map(l => l.uid === uid ? { ...l, qty: Math.max(1, qty) } : l));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh',
      background: theme.bg,
      color: theme.fg,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      paddingBottom: cart.length > 0 ? 80 : 0,
    }}>
      {/* Branded header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: theme.bg, borderBottom: `1px solid ${theme.fg}15`,
        padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {theme.logo
          ? <img src={theme.logo} alt={theme.name} style={{ height: 36, width: 36, borderRadius: 8, objectFit: 'cover' }}/>
          : <div style={{ height: 36, width: 36, borderRadius: 8, background: theme.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, color: '#0b0c10' }}>
              {theme.name[0]}
            </div>
        }
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{theme.name}</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>Order online · {orderType === 'collection' ? 'Collection' : 'Delivery'}</div>
        </div>
        <select value={orderType} onChange={e => setOrderType(e.target.value)}
          style={{ background: theme.bg, color: theme.fg, border: `1px solid ${theme.fg}30`, borderRadius: 8, padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }}>
          <option value="collection">Collection</option>
          <option value="delivery">Delivery</option>
        </select>
      </header>

      {theme.hero && (
        <div style={{
          height: 160, background: `url(${theme.hero}) center/cover no-repeat`,
        }}/>
      )}

      {loading && <div style={{ padding: 60, textAlign: 'center', opacity: 0.6 }}>Loading menu…</div>}

      {!loading && items.length === 0 && (
        <div style={{ padding: 60, textAlign: 'center', opacity: 0.6 }}>No menu items available right now.</div>
      )}

      {!loading && items.length > 0 && (
        <>
          {/* Category chips */}
          <div style={{
            position: 'sticky', top: 65, zIndex: 5, background: theme.bg,
            padding: '10px 14px', overflowX: 'auto', whiteSpace: 'nowrap',
            borderBottom: `1px solid ${theme.fg}10`, WebkitOverflowScrolling: 'touch',
          }}>
            {topCategories.map(c => {
              const active = c.id === activeCat;
              const hasItems = itemsForCat(c.id).length > 0;
              if (!hasItems) return null;
              return (
                <button key={c.id} onClick={() => {
                  setActiveCat(c.id);
                  document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                  style={{
                    display: 'inline-block', padding: '8px 14px', marginRight: 6, borderRadius: 99,
                    background: active ? theme.accent : 'transparent',
                    color: active ? '#0b0c10' : theme.fg,
                    border: active ? 'none' : `1px solid ${theme.fg}30`,
                    fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                  {c.label || c.name}
                </button>
              );
            })}
          </div>

          {/* Sections */}
          <div style={{ padding: '0 14px 24px' }}>
            {topCategories.map(cat => {
              const catItems = itemsForCat(cat.id);
              if (!catItems.length) return null;
              return (
                <section key={cat.id} id={`cat-${cat.id}`} style={{ paddingTop: 18 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 10px' }}>{cat.label || cat.name}</h2>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {catItems.map(item => <ItemRow key={item.id} item={item} theme={theme} onPick={() => setOpenItem(item)}/>)}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {/* Sticky cart bar */}
      {cart.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 20,
          padding: '12px 14px calc(12px + env(safe-area-inset-bottom)) 14px',
          background: theme.bg, borderTop: `1px solid ${theme.fg}15`,
        }}>
          <button onClick={() => setShowCart(true)} style={{
            width: '100%', padding: '14px 16px', borderRadius: 12,
            background: theme.accent, color: '#0b0c10', border: 'none',
            fontSize: 14, fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{cartCount} item{cartCount === 1 ? '' : 's'} · View cart</span>
            <span>£{cartTotal.toFixed(2)}</span>
          </button>
        </div>
      )}

      {openItem && (
        <OnlineItemSheet
          item={openItem}
          theme={theme}
          allItems={items}
          orderType={orderType}
          onClose={() => setOpenItem(null)}
          onAdd={(item, mods, qty) => addToCart(item, mods, qty)}
        />
      )}

      {showCart && (
        <OnlineCart
          cart={cart}
          theme={theme}
          orderType={orderType}
          onClose={() => setShowCart(false)}
          onRemove={removeFromCart}
          onUpdateQty={updateQty}
          onCheckout={() => {
            // Phase 4: navigate to customer-details + Stripe step.
            alert('Checkout coming next — Phase 4 builds the customer-details form + Stripe payment.');
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function ItemRow({ item, theme, onPick }) {
  const price = Number(item.pricing?.base ?? item.price ?? 0);
  return (
    <button onClick={onPick} style={{
      width: '100%', display: 'flex', gap: 12, alignItems: 'center',
      padding: 12, borderRadius: 12,
      background: `${theme.fg}08`, border: `1px solid ${theme.fg}15`,
      color: theme.fg, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{item.menu_name || item.name}</div>
        {item.description && (
          <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {item.description}
          </div>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, color: theme.accent, marginTop: 6 }}>£{price.toFixed(2)}</div>
      </div>
      {item.image && (
        <img src={item.image} alt={item.name}
          style={{ width: 72, height: 72, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}/>
      )}
    </button>
  );
}
