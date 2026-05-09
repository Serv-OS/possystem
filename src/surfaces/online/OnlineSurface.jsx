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

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import OnlineCart from './OnlineCart';
import OnlineItemSheet from './OnlineItemSheet';

const FALLBACK_ACCENT = '#e8a020';
const FALLBACK_BG     = '#ffffff';
const FALLBACK_FG     = '#1a1a1a';

export default function OnlineSurface({ location }) {
  const opsLocationId = location.ops_location_id || location.id;
  const onlineMenuId  = location.online_menu_id || null;

  const [items, setItems]           = useState([]);
  const [categories, setCategories] = useState([]);
  const [branding, setBranding]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [openItem, setOpenItem]     = useState(null);
  const [showCart, setShowCart]     = useState(false);
  const [orderType, setOrderType]   = useState('collection');
  const [cart, setCart]             = useState([]);

  // ── Load menu + branding from OPS DB ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      console.log('[OnlineSurface] load start', { opsLocationId, onlineMenuId });
      if (!opsLocationId || !supabase) { setLoading(false); return; }
      try {
        const [iRes, cRes, lRes, mRes] = await Promise.all([
          supabase.from('menu_items').select('*')
            .eq('location_id', opsLocationId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*')
            .eq('location_id', opsLocationId).order('sort_order'),
          supabase.from('locations').select('receipt_branding')
            .eq('id', opsLocationId).maybeSingle(),
          onlineMenuId
            ? supabase.from('menu_category_links').select('category_id').eq('menu_id', onlineMenuId)
            : Promise.resolve({ data: null }),
        ]);
        if (!alive) return;
        let cats = cRes.data || [];
        if (mRes.data) {
          const linked = new Set(mRes.data.map(l => l.category_id));
          cats = cats.filter(c => linked.has(c.id) || (c.parent_id && linked.has(c.parent_id)));
        }
        console.log('[OnlineSurface] fetch results', { items: (iRes.data || []).length, categories: cats.length });
        setItems(iRes.data || []);
        setCategories(cats);
        setBranding(location.online_branding || lRes.data?.receipt_branding || null);
      } catch (e) {
        console.warn('[OnlineSurface] load failed:', e?.message, e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
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

  const itemsForCat = (catId) => (items || []).filter(i =>
    !i.parent_id && !i.archived && i.sold_alone !== false &&
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))
  );

  // ── Cart math ────────────────────────────────────────────────────────────
  const cartCount = cart.reduce((s, l) => s + (l.qty || 1), 0);
  const cartTotal = cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0);

  const addToCart = (item, mods, qty) => {
    const price = Number(item.pricing?.base ?? item.price ?? 0);
    setCart(c => [...c, {
      uid: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      itemId: item.id,
      name: item.menu_name || item.name,
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

  return (
    <div style={{
      minHeight: '100vh', background: theme.bg, color: theme.fg,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      paddingBottom: cart.length > 0 ? 96 : 0,
    }}>
      {/* HERO with overlay logo */}
      <Hero theme={theme} muted={muted}/>

      {/* Sticky category nav */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 8,
        background: headerBg, backdropFilter: 'saturate(180%) blur(12px)',
        WebkitBackdropFilter: 'saturate(180%) blur(12px)',
        borderBottom: `1px solid ${cardBdr}`,
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {/* Mini logo + name (visible after scrolling past hero) */}
          {theme.logo && (
            <img src={theme.logo} alt={theme.name}
              style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}/>
          )}
          <div style={{ fontSize: 15, fontWeight: 800, flexShrink: 0, marginRight: 4 }}>{theme.name}</div>

          {/* Order-type toggle */}
          <select value={orderType} onChange={e => setOrderType(e.target.value)} style={{
            padding: '6px 12px', borderRadius: 99, border: `1px solid ${cardBdr}`,
            background: theme.bg, color: theme.fg, fontSize: 12, fontWeight: 700,
            fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0,
          }}>
            <option value="collection">Collection</option>
            <option value="delivery">Delivery</option>
          </select>

          {/* Category chips */}
          <div style={{ flex: 1, overflowX: 'auto', whiteSpace: 'nowrap',
            WebkitOverflowScrolling: 'touch', padding: '12px 0',
            scrollbarWidth: 'none', msOverflowStyle: 'none',
          }}>
            {topCategories.map(c => {
              if (itemsForCat(c.id).length === 0) return null;
              return (
                <button key={c.id} onClick={() => {
                  document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }} style={{
                  display: 'inline-block', padding: '8px 14px', marginRight: 6,
                  borderRadius: 99,
                  background: 'transparent', color: theme.fg,
                  border: `1.5px solid ${cardBdr}`,
                  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                }}>{c.label || c.name}</button>
              );
            })}
          </div>
        </div>
      </div>

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
                {catItems.map(item => (
                  <ItemCard key={item.id} item={item} theme={theme}
                    cardBg={cardBg} cardBdr={cardBdr} muted={muted}
                    onPick={() => setOpenItem(item)}/>
                ))}
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
          <button onClick={() => setShowCart(true)} style={{
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
          onClose={() => setOpenItem(null)}
          onAdd={(item, mods, qty) => addToCart(item, mods, qty)}
        />
      )}

      {showCart && (
        <OnlineCart
          cart={cart} theme={theme} orderType={orderType}
          onClose={() => setShowCart(false)}
          onRemove={removeFromCart} onUpdateQty={updateQty}
          onCheckout={() => {
            alert('Checkout coming next — Phase 4 builds the customer-details form + Stripe payment.');
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function Hero({ theme, muted }) {
  // Tall hero. Background image OR brand-colour gradient. Logo + name overlaid.
  const heroBg = theme.hero
    ? `linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.55) 100%), url(${theme.hero}) center/cover no-repeat`
    : `linear-gradient(135deg, ${theme.accent}, ${shade(theme.accent, -25)})`;
  return (
    <div style={{
      position: 'relative',
      height: 280, background: heroBg, backgroundSize: 'cover',
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
                width: 84, height: 84, borderRadius: 18, objectFit: 'cover',
                border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                flexShrink: 0,
              }}/>
            : <div style={{
                width: 84, height: 84, borderRadius: 18,
                background: theme.accent, color: contrastFg(theme.accent),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 38, fontWeight: 900, border: '3px solid #fff',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)', flexShrink: 0,
              }}>{theme.name[0]}</div>
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.025em',
              textShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}>{theme.name}</div>
            <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.95, marginTop: 2,
              textShadow: '0 1px 4px rgba(0,0,0,0.4)',
            }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 99,
                background: 'rgba(34,197,94,0.85)', color: '#fff',
                fontSize: 11, fontWeight: 800, letterSpacing: '0.02em',
                marginRight: 8, textShadow: 'none',
              }}>● Open now</span>
              Order online for collection or delivery
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemCard({ item, theme, cardBg, cardBdr, muted, onPick }) {
  const price = Number(item.pricing?.base ?? item.price ?? 0);
  return (
    <button onClick={onPick} style={{
      display: 'flex', alignItems: 'stretch',
      width: '100%', textAlign: 'left',
      padding: 0, borderRadius: 14, overflow: 'hidden',
      background: cardBg, border: `1px solid ${cardBdr}`,
      color: theme.fg, fontFamily: 'inherit', cursor: 'pointer',
      transition: 'transform .15s ease, box-shadow .15s ease',
      WebkitTapHighlightColor: 'transparent',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
    >
      <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>
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
        <div style={{ fontSize: 14, fontWeight: 800, marginTop: 6 }}>£{price.toFixed(2)}</div>
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
