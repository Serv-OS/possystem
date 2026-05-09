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
import OnlineCheckout from './OnlineCheckout';
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
  const [instGroupDefs, setInstGroupDefs] = useState([]); // from config_pushes snapshot — there's no instruction_groups DB table
  const [loading, setLoading]       = useState(true);
  const [openItem, setOpenItem]     = useState(null);
  const [showCart, setShowCart]     = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [confirmation, setConfirmation] = useState(null); // { id, when, type }
  const [orderType, setOrderType]   = useState(null); // null until welcome screen picks
  const [showLoyalty, setShowLoyalty] = useState(false);
  const [loyalty, setLoyalty]       = useState(null); // { phone, verified }
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
        const [iRes, cRes, lRes, mRes, pRes] = await Promise.allSettled([
          supabase.from('menu_items').select('*')
            .eq('location_id', opsLocationId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*')
            .eq('location_id', opsLocationId).order('sort_order'),
          supabase.from('locations').select('receipt_branding')
            .eq('id', opsLocationId).maybeSingle(),
          onlineMenuId
            ? supabase.from('menu_category_links').select('category_id').eq('menu_id', onlineMenuId)
            : Promise.resolve({ data: null }),
          // Latest config push for this location — carries instructionGroupDefs
          // since there's no instruction_groups table.
          supabase.from('config_pushes').select('snapshot')
            .eq('location_id', opsLocationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
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

  // Welcome step — first thing customers see
  if (!orderType) {
    return (
      <ScrollShell theme={theme}>
        <Welcome
          theme={theme}
          orderTypes={allOrderTypes}
          loyalty={loyalty}
          onPickType={setOrderType}
          onLoyalty={() => setShowLoyalty(true)}/>
        {showLoyalty && (
          <LoyaltyModal theme={theme} cardBdr={cardBdr} muted={muted}
            onClose={() => setShowLoyalty(false)}
            onVerified={(phone) => { setLoyalty({ phone, verified: true }); setShowLoyalty(false); }}/>
        )}
      </ScrollShell>
    );
  }

  return (
    <ScrollShell theme={theme} extraBottomPad={cart.length > 0 ? 96 : 0}>
      {/* HERO with overlay logo */}
      <Hero theme={theme} muted={muted}
        leadMin={Number(location.online_collection_lead_min) || 0}/>

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

          {/* Order-type pill (changeable) */}
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
          <button onClick={() => setShowLoyalty(true)} className="op-btn" style={{
            padding: '6px 12px', borderRadius: 99,
            background: loyalty?.verified ? `${theme.accent}18` : 'transparent',
            color: theme.fg, border: `1px solid ${cardBdr}`,
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
          }}>
            {loyalty?.verified ? `✦ ${loyalty.phone}` : '✦ Sign in'}
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
                {catItems.map(item => (
                  <ItemCard key={item.id} item={item} theme={theme}
                    cardBg={cardBg} cardBdr={cardBdr} muted={muted}
                    variantInfo={variantInfo(item)}
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
            setShowCart(false);
            setShowCheckout(true);
          }}
        />
      )}

      {showCheckout && (
        <OnlineCheckout
          cart={cart} theme={theme} location={location}
          orderType={orderType} loyalty={loyalty}
          onClose={() => setShowCheckout(false)}
          onPlaced={(info) => {
            setShowCheckout(false);
            setCart([]);
            setConfirmation(info);
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
          onClose={() => setShowLoyalty(false)}
          onVerified={(phone) => { setLoyalty({ phone, verified: true }); setShowLoyalty(false); }}/>
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
        <button onClick={onLoyalty} style={{
          marginTop: 24, padding: '12px 20px', borderRadius: 99,
          background: 'rgba(255,255,255,0.18)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.5)',
          fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          backdropFilter: 'saturate(180%) blur(8px)',
        }}>
          {loyalty?.verified ? `✦ Signed in as ${loyalty.phone}` : '✦ Sign in for loyalty rewards'}
        </button>

        <div style={{ marginTop: 32, fontSize: 11, opacity: 0.75, textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}>
          Powered by serv-os.app
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
// Loyalty modal — phone capture + SMS-code verification (UI scaffold only;
// real Twilio / Supabase phone-OTP wiring lands in a follow-up commit).
function LoyaltyModal({ theme, cardBdr, muted, onClose, onVerified }) {
  const [step, setStep] = useState('phone'); // phone | code
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');

  const sendCode = async () => {
    if (!/^\+?[0-9 ]{7,}$/.test(phone)) { setErr('Enter a valid phone number.'); return; }
    setErr(''); setWorking(true);
    // TODO: real SMS provider wiring (Twilio / Supabase phone OTP). For now
    // the scaffold "sends" instantly so the UI flow is testable end-to-end.
    await new Promise(r => setTimeout(r, 600));
    setWorking(false);
    setStep('code');
  };
  const verify = async () => {
    if (code.replace(/\D/g, '').length < 4) { setErr('Enter the 6-digit code.'); return; }
    setErr(''); setWorking(true);
    await new Promise(r => setTimeout(r, 400));
    setWorking(false);
    onVerified(phone);
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
              <button onClick={() => setStep('phone')} style={{
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
        </div>
      </div>
    </div>
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
function Hero({ theme, muted, leadMin }) {
  // Tall hero. Background image OR brand-colour gradient. Logo + name overlaid.
  // Stronger gradient + heavier text-shadows for legibility against any photo.
  const heroBg = theme.hero
    ? `linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.85) 100%), url(${theme.hero}) center/cover no-repeat`
    : `linear-gradient(135deg, ${theme.accent}, ${shade(theme.accent, -25)})`;
  const leadLabel = leadMin > 0
    ? `${leadMin < 60 ? `${leadMin} min` : `${Math.round(leadMin/60)} h`} prep time`
    : null;
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
                border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                flexShrink: 0,
              }}/>
            : <div style={{
                width: 84, height: 84, borderRadius: 18,
                background: theme.accent, color: contrastFg(theme.accent),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 38, fontWeight: 900, border: '3px solid #fff',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)', flexShrink: 0,
              }}>{theme.name[0]}</div>
          }
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-0.025em', lineHeight: 1.1,
              textShadow: '0 2px 12px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5)',
            }}>{theme.name}</div>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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

function ItemCard({ item, theme, cardBg, cardBdr, muted, onPick, variantInfo }) {
  const ownPrice = Number(item.pricing?.base ?? item.price ?? 0);
  const isVariantParent = !!variantInfo?.kids?.length;
  // Variant parents have base price 0; show "from £X" using cheapest child.
  const displayPrice = isVariantParent ? (variantInfo.fromPrice || 0) : ownPrice;
  const allergens = item.allergens || [];
  return (
    <button onClick={onPick} className="op-btn" style={{
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
