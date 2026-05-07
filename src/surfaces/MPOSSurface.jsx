// src/surfaces/MPOSSurface.jsx
//
// v5.5.59: Phase 1A of MPOS — phone-shaped POS for servers and runners.
// Reuses the same Zustand store, sync layer, payment edge functions, and
// realtime channels as the desktop POS. The only thing different is the UI:
// portrait layout, thumb-zone bottom bar, single-column flows.
//
// Phase 1A scope (this file):
//   • Walk-in / takeaway / counter orders only (no table service yet)
//   • Cash payments fully working
//   • Card via Stripe REST (network reader assigned to this device's pos id)
//   • Simulated-card fallback when no reader is assigned (dev / pre-Tap-to-Pay)
//   • Digital receipt only — no printer dispatch from the phone in this phase
//
// Phase 1B will add native iOS / Android shells with Stripe Tap to Pay so
// the phone itself becomes the card reader. This file is unchanged in 1B —
// the bridge is wired into the store's checkout flow, not the UI.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import PINScreen from './PINScreen';
import { calculateOrderTax } from '../lib/tax';
import { resolvePlatformLocationId, getAssignedNetworkReader } from '../lib/networkReader';
import { getActiveLocationSync, supabase } from '../lib/supabase';

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  shell:    { display:'flex', flexDirection:'column', height:'100vh', width:'100vw', maxWidth:540, margin:'0 auto', background:'var(--bg)', color:'var(--t1)', overflow:'hidden', fontFamily:'inherit', WebkitTapHighlightColor:'transparent' },
  header:   { padding:'10px 14px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:10, flexShrink:0 },
  hTitle:   { flex:1, fontSize:14, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  hSub:     { fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700 },
  iconBtn:  { width:38, height:38, borderRadius:10, border:'1px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t2)', fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 },
  body:     { flex:1, overflow:'hidden', display:'flex', flexDirection:'column', minHeight:0 },
  scroller: { flex:1, overflowY:'auto', WebkitOverflowScrolling:'touch' },
  bottom:   { padding:'10px 12px calc(10px + env(safe-area-inset-bottom)) 12px', borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 },
  btnPrim:  { width:'100%', padding:'14px 16px', borderRadius:12, border:'none', background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800, fontFamily:'inherit', cursor:'pointer', minHeight:52 },
  btnGhost: { width:'100%', padding:'12px 16px', borderRadius:12, border:'1px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t2)', fontSize:14, fontWeight:700, fontFamily:'inherit', cursor:'pointer', minHeight:48 },
  btnRed:   { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  catChip:  (active) => ({ padding:'8px 14px', borderRadius:99, border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`, background:active ? 'var(--acc-d)' : 'var(--bg2)', color:active ? 'var(--acc)' : 'var(--t2)', fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', flexShrink:0 }),
  itemCard: { padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)', marginBottom:8, display:'flex', gap:10, alignItems:'center', cursor:'pointer', minHeight:64 },
  pill:     { fontSize:10, padding:'2px 8px', borderRadius:99, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' },
  cartBar:  { padding:'10px 12px', background:'var(--acc)', color:'#0b0c10', borderRadius:14, display:'flex', alignItems:'center', gap:10, cursor:'pointer', boxShadow:'var(--sh)' },
};

const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;

// ── Top-level entry ────────────────────────────────────────────────────────────
export default function MPOSSurface() {
  const { staff } = useStore();

  // Swap the PWA manifest to the portrait MPOS variant + tighten viewport for
  // edge-to-edge layouts on phones with notches/home indicators.
  useEffect(() => {
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const prevHref = manifestLink?.getAttribute('href');
    if (manifestLink) manifestLink.setAttribute('href', '/mpos-manifest.json');
    const viewport = document.querySelector('meta[name="viewport"]');
    const prevViewport = viewport?.getAttribute('content');
    if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no');
    return () => {
      if (manifestLink && prevHref) manifestLink.setAttribute('href', prevHref);
      if (viewport && prevViewport) viewport.setAttribute('content', prevViewport);
    };
  }, []);

  // PIN gate — server identifies themselves before taking orders
  if (!staff) return <PINScreen />;
  return <MPOSContent />;
}

// ── Main flow ──────────────────────────────────────────────────────────────────
function MPOSContent() {
  const { staff, logout, walkInOrder, menuCategories, menuItems, eightySixIds, setOrderType, orderType } = useStore();
  const [screen, setScreen] = useState('menu'); // menu | cart | tender | done
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null); // for ItemDetail modal
  const [doneRef, setDoneRef] = useState(null);

  // Default to takeaway for MPOS — no table by default
  useEffect(() => {
    if (orderType === 'dine-in') setOrderType('takeaway');
  }, [orderType, setOrderType]);

  const cartCount = (walkInOrder?.items || []).reduce((s, i) => s + (i.qty || 0), 0);
  const cartSubtotal = (walkInOrder?.items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);

  const goMenu = () => setScreen('menu');
  const goCart = () => cartCount > 0 && setScreen('cart');
  const goTender = () => cartCount > 0 && setScreen('tender');
  const onPaid = (ref) => { setDoneRef(ref); setScreen('done'); };
  const newOrder = () => {
    useStore.setState({ walkInOrder: null, customer: null });
    setDoneRef(null);
    setScreen('menu');
  };

  // ── Header ───────────────────────────────────────────────────────────────
  const Header = ({ title, sub, onBack }) => (
    <div style={S.header}>
      {onBack ? (
        <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
      ) : (
        <div style={{ ...S.iconBtn, background:staff?.color || 'var(--acc)', color:'#0b0c10', fontSize:13, fontWeight:800 }}>
          {staff?.initials || '?'}
        </div>
      )}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={S.hTitle}>{title}</div>
        {sub && <div style={S.hSub}>{sub}</div>}
      </div>
      {!onBack && (
        <button style={S.iconBtn} onClick={() => { if (confirm('End shift / sign out?')) logout(); }} aria-label="Sign out">⏻</button>
      )}
    </div>
  );

  // ── Sticky cart bar ──────────────────────────────────────────────────────
  const CartBar = ({ onClick, label = 'View cart' }) => cartCount > 0 ? (
    <div style={S.cartBar} onClick={onClick}>
      <span style={{ background:'#0b0c10', color:'var(--acc)', borderRadius:99, padding:'2px 8px', fontWeight:800, fontSize:12 }}>{cartCount}</span>
      <span style={{ flex:1, fontWeight:800, fontSize:14 }}>{label}</span>
      <span style={{ fontWeight:800, fontSize:14, fontFamily:'var(--font-mono)' }}>{money(cartSubtotal)}</span>
      <span style={{ fontSize:18, fontWeight:800 }}>›</span>
    </div>
  ) : null;

  // ── Screen: MENU ─────────────────────────────────────────────────────────
  if (screen === 'menu') {
    const visibleCategories = (menuCategories || []).filter(c => !c.parentId && c.visible !== false);
    const activeCatId = selectedCategoryId || visibleCategories[0]?.id;
    const itemsForCat = (menuItems || []).filter(i =>
      !i.hidden && !eightySixIds.includes(i.id) &&
      (i.cat === activeCatId || (Array.isArray(i.cats) && i.cats.includes(activeCatId)))
    );
    return (
      <div style={S.shell}>
        <Header title="New order" sub={`${(orderType || 'takeaway').toUpperCase()} · ${staff?.name || ''}`} />

        {/* Order type quick switch */}
        <div style={{ display:'flex', gap:6, padding:'8px 12px 4px', flexShrink:0 }}>
          {['takeaway','collection','delivery'].map(t => (
            <button key={t} onClick={() => setOrderType(t)} style={{
              flex:1, padding:'8px 4px', borderRadius:9, border:`1.5px solid ${orderType === t ? 'var(--acc)' : 'var(--bdr2)'}`,
              background: orderType === t ? 'var(--acc-d)' : 'var(--bg2)',
              color: orderType === t ? 'var(--acc)' : 'var(--t3)',
              fontSize:11, fontWeight:800, textTransform:'uppercase', letterSpacing:'.06em', cursor:'pointer',
            }}>{t}</button>
          ))}
        </div>

        {/* Category chips */}
        <div style={{ padding:'8px 12px', display:'flex', gap:6, overflowX:'auto', flexShrink:0, WebkitOverflowScrolling:'touch' }}>
          {visibleCategories.length === 0 && <div style={{ fontSize:12, color:'var(--t4)' }}>No menu loaded.</div>}
          {visibleCategories.map(c => (
            <button key={c.id} style={S.catChip(c.id === activeCatId)} onClick={() => setSelectedCategoryId(c.id)}>
              {c.name}
            </button>
          ))}
        </div>

        {/* Items */}
        <div style={S.scroller}>
          <div style={{ padding:'8px 12px 100px' }}>
            {itemsForCat.length === 0 && (
              <div style={{ textAlign:'center', padding:'48px 12px', color:'var(--t4)', fontSize:13 }}>
                {visibleCategories.length === 0 ? 'Menu not loaded yet.' : 'No items in this category.'}
              </div>
            )}
            {itemsForCat.map(item => (
              <ItemRow key={item.id} item={item} onTap={() => setSelectedItem(item)} />
            ))}
          </div>
        </div>

        {/* Sticky cart bar */}
        <div style={S.bottom}>
          <CartBar onClick={goCart} label="Review cart" />
          {cartCount === 0 && (
            <div style={{ textAlign:'center', fontSize:11, color:'var(--t4)', padding:'8px 0' }}>
              Tap an item to add to cart
            </div>
          )}
        </div>

        {selectedItem && (
          <ItemDetailSheet item={selectedItem} onClose={() => setSelectedItem(null)} />
        )}
      </div>
    );
  }

  // ── Screen: CART ─────────────────────────────────────────────────────────
  if (screen === 'cart') {
    return <CartReview cartItems={walkInOrder?.items || []} subtotal={cartSubtotal} onBack={goMenu} onCheckout={goTender} />;
  }

  // ── Screen: TENDER ───────────────────────────────────────────────────────
  if (screen === 'tender') {
    return <Tender subtotal={cartSubtotal} onBack={() => setScreen('cart')} onPaid={onPaid} />;
  }

  // ── Screen: DONE ─────────────────────────────────────────────────────────
  if (screen === 'done') {
    return <Done orderRef={doneRef} onNewOrder={newOrder} />;
  }

  return null;
}

// ── Item row in menu list ─────────────────────────────────────────────────────
function ItemRow({ item, onTap }) {
  const price = item?.pricing?.base ?? item?.price ?? 0;
  return (
    <div style={S.itemCard} onClick={onTap}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {item.name}
        </div>
        {item.description && (
          <div style={{ fontSize:11, color:'var(--t4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {item.description}
          </div>
        )}
      </div>
      <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', flexShrink:0 }}>
        {money(price)}
      </div>
      <div style={{ ...S.iconBtn, background:'var(--acc)', color:'#0b0c10', fontSize:18, fontWeight:800, width:36, height:36 }}>+</div>
    </div>
  );
}

// ── Item detail sheet (qty + add to cart) ─────────────────────────────────────
function ItemDetailSheet({ item, onClose }) {
  const { addItem } = useStore();
  const [qty, setQty] = useState(1);
  const price = item?.pricing?.base ?? item?.price ?? 0;
  const onAdd = () => {
    addItem(item, [], null, { qty });
    onClose();
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:50, display:'flex', alignItems:'flex-end' }} onClick={onClose}>
      <div style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'18px 16px calc(18px + env(safe-area-inset-bottom)) 16px', boxShadow:'0 -8px 30px rgba(0,0,0,.4)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>{item.name}</div>
        {item.description && (
          <div style={{ fontSize:12, color:'var(--t3)', marginBottom:14, lineHeight:1.4 }}>{item.description}</div>
        )}
        <div style={{ fontSize:24, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', marginBottom:16 }}>
          {money(price * qty)}
        </div>

        {/* Qty stepper */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:18, marginBottom:18 }}>
          <button onClick={() => setQty(q => Math.max(1, q-1))} style={{ ...S.iconBtn, width:48, height:48, fontSize:22, fontWeight:800 }}>−</button>
          <div style={{ fontSize:32, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', minWidth:48, textAlign:'center' }}>{qty}</div>
          <button onClick={() => setQty(q => Math.min(99, q+1))} style={{ ...S.iconBtn, width:48, height:48, fontSize:22, fontWeight:800 }}>+</button>
        </div>

        <button onClick={onAdd} style={S.btnPrim}>Add to cart · {money(price * qty)}</button>
        <button onClick={onClose} style={{ ...S.btnGhost, marginTop:8 }}>Cancel</button>
      </div>
    </div>
  );
}

// ── Cart review ──────────────────────────────────────────────────────────────
function CartReview({ cartItems, subtotal, onBack, onCheckout }) {
  const { removeWalkInItem, updateWalkInItemQty } = useStore();
  const updateQty = (uid, delta) => {
    const item = cartItems.find(i => i.uid === uid);
    if (!item) return;
    const next = item.qty + delta;
    if (next <= 0) removeWalkInItem?.(uid);
    else updateWalkInItemQty?.(uid, next);
  };
  // Fallback: if those store actions don't exist, mutate directly
  const safeUpdate = (uid, delta) => {
    if (typeof updateWalkInItemQty === 'function') return updateQty(uid, delta);
    useStore.setState(s => {
      const items = (s.walkInOrder?.items || []).map(i => i.uid === uid ? { ...i, qty: Math.max(0, i.qty + delta) } : i).filter(i => i.qty > 0);
      const sub = items.reduce((a, i) => a + i.price * i.qty, 0);
      return { walkInOrder: { ...(s.walkInOrder || {}), items, subtotal: sub, total: sub } };
    });
  };
  return (
    <div style={S.shell}>
      <div style={S.header}>
        <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
        <div style={{ flex:1 }}>
          <div style={S.hTitle}>Review order</div>
          <div style={S.hSub}>{cartItems.length} item{cartItems.length === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div style={S.scroller}>
        <div style={{ padding:'12px' }}>
          {cartItems.length === 0 ? (
            <div style={{ textAlign:'center', padding:'48px 12px', color:'var(--t4)', fontSize:13 }}>Cart is empty.</div>
          ) : cartItems.map(it => (
            <div key={it.uid} style={{ ...S.itemCard, cursor:'default' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>{it.name}</div>
                <div style={{ fontSize:11, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{money(it.price)} ea</div>
              </div>
              <button onClick={() => safeUpdate(it.uid, -1)} style={{ ...S.iconBtn, width:34, height:34, fontSize:16 }}>−</button>
              <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', minWidth:24, textAlign:'center', fontFamily:'var(--font-mono)' }}>{it.qty}</div>
              <button onClick={() => safeUpdate(it.uid, +1)} style={{ ...S.iconBtn, width:34, height:34, fontSize:16, background:'var(--acc-d)', color:'var(--acc)', borderColor:'var(--acc-b)' }}>+</button>
            </div>
          ))}
        </div>
      </div>
      <div style={S.bottom}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10, padding:'0 4px' }}>
          <span style={{ fontSize:14, color:'var(--t3)', fontWeight:700 }}>Subtotal</span>
          <span style={{ fontSize:22, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--t1)' }}>{money(subtotal)}</span>
        </div>
        <button onClick={onCheckout} disabled={cartItems.length === 0} style={{ ...S.btnPrim, opacity: cartItems.length === 0 ? .5 : 1 }}>
          Checkout · {money(subtotal)}
        </button>
        <button onClick={onBack} style={{ ...S.btnGhost, marginTop:8 }}>Add more items</button>
      </div>
    </div>
  );
}

// ── Tender ────────────────────────────────────────────────────────────────────
function Tender({ subtotal, onBack, onPaid }) {
  const { walkInOrder, orderType, customer, recordWalkInClosed, taxRates } = useStore();
  const [method, setMethod] = useState(null); // null | 'cash' | 'card'
  const [cashEntered, setCashEntered] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  // Tax calculation reuses the same util as the desktop POS
  const taxResult = useMemo(() => {
    try { return calculateOrderTax(walkInOrder?.items || [], { taxRates: taxRates || [] }); }
    catch { return { taxAmount: 0, total: subtotal }; }
  }, [walkInOrder, subtotal, taxRates]);

  const grand = taxResult?.total ?? subtotal;
  const tax = taxResult?.taxAmount ?? 0;

  const finalisePaid = useCallback(async (paymentInfo) => {
    setBusy(true); setErrorMsg(null);
    try {
      // recordWalkInClosed signature: (walkInOrder, orderType, customer, paymentInfo)
      const rec = recordWalkInClosed?.(walkInOrder, orderType || 'takeaway', customer, paymentInfo);
      onPaid(rec?.ref || walkInOrder?.id || 'PAID');
    } catch (e) {
      setErrorMsg(e?.message || 'Failed to close check');
      setBusy(false);
    }
  }, [walkInOrder, orderType, customer, recordWalkInClosed, onPaid]);

  const onCashSubmit = () => {
    const tendered = parseFloat(cashEntered) || 0;
    if (tendered < grand) { setErrorMsg('Tendered amount is less than total'); return; }
    finalisePaid({ method:'cash', tendered, change: tendered - grand });
  };

  // Method picker
  if (!method) {
    return (
      <div style={S.shell}>
        <div style={S.header}>
          <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={S.hTitle}>Take payment</div>
            <div style={S.hSub}>{money(grand)} due</div>
          </div>
        </div>
        <div style={S.scroller}>
          <div style={{ padding:'24px 16px' }}>
            <div style={{ textAlign:'center', marginBottom:24 }}>
              <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6, fontWeight:700 }}>Total due</div>
              <div style={{ fontSize:48, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{money(grand)}</div>
              {tax > 0 && <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>incl. {money(tax)} tax</div>}
            </div>
            <button onClick={() => setMethod('card')} style={{ ...S.btnPrim, marginBottom:10, fontSize:16, padding:'18px 16px', minHeight:60 }}>
              📱 &nbsp; Card · Tap to Pay
            </button>
            <button onClick={() => setMethod('cash')} style={{ ...S.btnGhost, fontSize:15, padding:'16px', minHeight:56 }}>
              💷 &nbsp; Cash
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Cash flow
  if (method === 'cash') {
    const tendered = parseFloat(cashEntered) || 0;
    const change = Math.max(0, tendered - grand);
    const ok = tendered >= grand;
    const press = (k) => {
      if (k === '⌫') { setCashEntered(p => p.slice(0, -1)); return; }
      if (k === '.' && cashEntered.includes('.')) return;
      if (cashEntered.includes('.') && cashEntered.split('.')[1]?.length >= 2) return;
      if (cashEntered.length >= 7) return;
      setCashEntered(p => p + k);
    };
    return (
      <div style={S.shell}>
        <div style={S.header}>
          <button style={S.iconBtn} onClick={() => setMethod(null)} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={S.hTitle}>Cash payment</div>
            <div style={S.hSub}>{money(grand)} due</div>
          </div>
        </div>
        <div style={S.scroller}>
          <div style={{ padding:'14px 16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
              <div>
                <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase' }}>Due</div>
                <div style={{ fontSize:24, fontWeight:800, fontFamily:'var(--font-mono)' }}>{money(grand)}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', color: ok ? 'var(--grn)' : cashEntered ? 'var(--red)' : 'var(--t4)' }}>
                  {ok ? 'Change' : 'Short'}
                </div>
                <div style={{ fontSize:24, fontWeight:800, fontFamily:'var(--font-mono)', color: ok ? 'var(--grn)' : cashEntered ? 'var(--red)' : 'var(--t4)' }}>
                  {ok ? money(change) : cashEntered ? money(grand - tendered) : '—'}
                </div>
              </div>
            </div>
            <div style={{ padding:'16px', borderRadius:14, border:`2px solid ${ok ? 'var(--grn-b)' : cashEntered ? 'var(--acc-b)' : 'var(--bdr2)'}`, background:'var(--bg2)', marginBottom:12, textAlign:'center' }}>
              <div style={{ fontSize:11, color:'var(--t4)', marginBottom:2, textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700 }}>Tendered</div>
              <div style={{ fontSize:32, fontWeight:800, fontFamily:'var(--font-mono)', color: ok ? 'var(--grn)' : 'var(--t1)' }}>
                {cashEntered ? `£${tendered.toFixed(2)}` : '£—'}
              </div>
            </div>

            {/* Quick cash */}
            <div style={{ display:'flex', gap:6, marginBottom:10 }}>
              {[Math.ceil(grand), Math.ceil(grand/5)*5, Math.ceil(grand/10)*10, Math.ceil(grand/20)*20]
                .filter((v, i, a) => v >= grand && a.indexOf(v) === i)
                .slice(0, 4)
                .map(a => (
                  <button key={a} onClick={() => setCashEntered(String(a))} style={{ flex:1, padding:'10px 0', borderRadius:10, border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t2)', fontSize:13, fontWeight:700, fontFamily:'inherit', cursor:'pointer' }}>
                    £{a}
                  </button>
                ))}
            </div>

            {/* Number pad */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6 }}>
              {['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => (
                <button key={k} onClick={() => press(k)} style={{ padding:'18px 0', borderRadius:12, border:'1px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)', fontSize:22, fontWeight:700, fontFamily:'var(--font-mono)', cursor:'pointer', minHeight:54 }}>
                  {k}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={S.bottom}>
          {errorMsg && <div style={{ padding:8, marginBottom:8, borderRadius:8, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{errorMsg}</div>}
          <button onClick={onCashSubmit} disabled={!ok || busy} style={{ ...S.btnPrim, opacity: ok && !busy ? 1 : .5 }}>
            {busy ? 'Closing…' : `Confirm payment · ${money(grand)}`}
          </button>
        </div>
      </div>
    );
  }

  // Card flow — Phase 1A: detect network reader, simulate if absent
  if (method === 'card') {
    return <CardTender grand={grand} onBack={() => setMethod(null)} onPaid={(info) => finalisePaid({ method:'card', ...info })} busy={busy} setBusy={setBusy} errorMsg={errorMsg} setErrorMsg={setErrorMsg} />;
  }

  return null;
}

// ── Card tender ────────────────────────────────────────────────────────────────
// Phase 1A: when a network reader is assigned, push to it via REST. Otherwise
// fall back to a clearly-labelled simulated approval (dev / pre-Tap-to-Pay).
// Phase 1B will replace the simulated branch with a Stripe Tap to Pay native call.
function CardTender({ grand, onBack, onPaid, busy, setBusy, errorMsg, setErrorMsg }) {
  const [networkReader, setNetworkReader] = useState(null);
  const [platformLocId, setPlatformLocId] = useState(null);
  const [phase, setPhase] = useState('checking'); // checking | rest_running | sim | error | done

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ops = getActiveLocationSync();
        if (!ops) { setPhase('sim'); return; }
        const platformId = await resolvePlatformLocationId(ops);
        if (cancelled) return;
        setPlatformLocId(platformId);
        const assigned = await getAssignedNetworkReader();
        if (cancelled) return;
        setNetworkReader(assigned);
        setPhase(assigned ? 'rest_running' : 'sim');
      } catch (e) {
        if (!cancelled) { setErrorMsg(e?.message || String(e)); setPhase('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [setErrorMsg]);

  // REST flow against assigned reader
  useEffect(() => {
    if (phase !== 'rest_running' || !networkReader || !platformLocId) return;
    let abort = false;
    (async () => {
      try {
        const opsDeviceId = (() => { try { return localStorage.getItem('rpos-device') || ''; } catch { return ''; } })();
        const { data: session } = await supabase.auth.getSession();
        const token = session?.session?.access_token;
        const { walkInOrder } = useStore.getState();
        const lineItems = (walkInOrder?.items || [])
          .filter(it => it && it.price != null)
          .map(it => ({ description: String(it.name).slice(0, 60), amount: Math.round(it.price * 100), quantity: Math.max(1, it.qty) }));
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-process-payment-on-reader`, {
          method:'POST',
          headers:{ 'content-type':'application/json', authorization:`Bearer ${token}` },
          body: JSON.stringify({ pos_device_id: opsDeviceId, amount_minor: Math.round(grand * 100), currency:'gbp', line_items: lineItems }),
        });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
        // Poll
        const piId = j.payment_intent_id;
        const start = Date.now();
        while (!abort && Date.now() - start < 5*60*1000) {
          await new Promise(r => setTimeout(r, 1500));
          if (abort) return;
          const { data: s2 } = await supabase.auth.getSession();
          const tok2 = s2?.session?.access_token;
          const pr = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-poll-reader-action`, {
            method:'POST',
            headers:{ 'content-type':'application/json', authorization:`Bearer ${tok2}` },
            body: JSON.stringify({ payment_intent_id: piId, reader_id: j.reader_id, location_id: platformLocId }),
          });
          const pj = await pr.json();
          if (!pr.ok) continue;
          if (pj.is_terminal_state) {
            if (pj.is_success) { onPaid({ paymentIntentId: piId, amount: pj.amount, applicationFee: pj.application_fee_amount }); return; }
            throw new Error(pj.last_payment_error || `Payment ${pj.payment_intent_status}`);
          }
        }
        if (!abort) throw new Error('Timed out waiting for customer');
      } catch (e) {
        if (!abort) { setErrorMsg(e?.message || String(e)); setPhase('error'); }
      }
    })();
    return () => { abort = true; };
  }, [phase, networkReader, platformLocId, grand, onPaid, setErrorMsg]);

  if (phase === 'checking') {
    return <CardWaiting grand={grand} title="Connecting…" sub="Looking for assigned reader" onBack={onBack} cancellable />;
  }
  if (phase === 'rest_running') {
    return <CardWaiting grand={grand} title="Customer paying on reader" sub={networkReader?.label || 'Reader'} onBack={onBack} cancellable />;
  }
  if (phase === 'sim') {
    return (
      <div style={S.shell}>
        <div style={S.header}>
          <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={S.hTitle}>Card payment</div>
            <div style={S.hSub}>{money(grand)} · simulated</div>
          </div>
        </div>
        <div style={{ ...S.scroller, padding:'24px 16px', textAlign:'center' }}>
          <div style={{ fontSize:54, marginBottom:8 }}>📱</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Tap to Pay not yet enabled</div>
          <div style={{ fontSize:13, color:'var(--t3)', lineHeight:1.5, marginBottom:16, maxWidth:360, margin:'0 auto 16px' }}>
            Phase 1B will enable Stripe Tap to Pay on this device. For now you can simulate a successful card payment to test the rest of the flow, or assign a network reader to this device in Back office → Card readers.
          </div>
          <div style={{ fontSize:36, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--t1)', marginBottom:24 }}>{money(grand)}</div>
        </div>
        <div style={S.bottom}>
          {errorMsg && <div style={{ padding:8, marginBottom:8, borderRadius:8, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{errorMsg}</div>}
          <button onClick={() => onPaid({ paymentIntentId:`sim_${Date.now()}`, simulated:true })} disabled={busy} style={S.btnPrim}>
            ✓ Simulate approved
          </button>
          <button onClick={onBack} style={{ ...S.btnGhost, marginTop:8 }}>← Back</button>
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div style={S.shell}>
        <div style={S.header}>
          <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
          <div style={S.hTitle}>Card payment failed</div>
        </div>
        <div style={{ ...S.scroller, padding:'24px 16px', textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:8 }}>⚠️</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--red)', marginBottom:6 }}>Payment failed</div>
          <div style={{ fontSize:13, color:'var(--t3)', maxWidth:380, margin:'0 auto', lineHeight:1.5 }}>{errorMsg || 'Unknown error'}</div>
        </div>
        <div style={S.bottom}>
          <button onClick={onBack} style={S.btnGhost}>← Back to tender</button>
        </div>
      </div>
    );
  }
  return null;
}

function CardWaiting({ grand, title, sub, onBack }) {
  return (
    <div style={S.shell}>
      <div style={S.header}>
        <button style={S.iconBtn} onClick={onBack} aria-label="Back">←</button>
        <div style={{ flex:1 }}>
          <div style={S.hTitle}>Card payment</div>
          <div style={S.hSub}>{money(grand)}</div>
        </div>
      </div>
      <div style={{ ...S.scroller, padding:'48px 16px', textAlign:'center' }}>
        <div style={{ fontSize:54, marginBottom:14 }}>📲</div>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>{title}</div>
        <div style={{ fontSize:13, color:'var(--t3)', marginBottom:24 }}>{sub}</div>
        <div style={{ fontSize:36, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--acc)' }}>{money(grand)}</div>
      </div>
      <div style={S.bottom}>
        <button onClick={onBack} style={{ ...S.btnGhost, ...S.btnRed }}>✕ Cancel payment</button>
      </div>
    </div>
  );
}

// ── Done screen ────────────────────────────────────────────────────────────────
function Done({ orderRef, onNewOrder }) {
  return (
    <div style={S.shell}>
      <div style={{ ...S.scroller, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center', padding:'24px' }}>
        <div style={{ width:96, height:96, borderRadius:'50%', background:'var(--grn-d)', border:'3px solid var(--grn)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:54, color:'var(--grn)', marginBottom:20 }}>✓</div>
        <div style={{ fontSize:24, fontWeight:800, color:'var(--grn)', marginBottom:6 }}>Order paid</div>
        {orderRef && <div style={{ fontSize:14, color:'var(--t3)', fontFamily:'var(--font-mono)', marginBottom:12 }}>Ref {orderRef}</div>}
        <div style={{ fontSize:13, color:'var(--t3)', marginBottom:32 }}>Kitchen has been notified.</div>
      </div>
      <div style={S.bottom}>
        <button onClick={onNewOrder} style={S.btnPrim}>Take next order</button>
      </div>
    </div>
  );
}
