// src/surfaces/catering/CateringSurface.jsx
//
// Customer-facing catering ordering site (Module 1, step 2). Reuses the online-ordering engine's
// item sheet + cart, with catering rules layered on: an EVENT DATE + TIME picker (not ASAP), lead-time
// (min/max days) + closed-date/hours gating, a per-day capacity gate, and an order minimum. Settings
// come from the catering_public_settings RPC (anon-safe; only returns when the site is enabled). Menus
// are read directly (anon, like the online site). Handoff → CateringCheckout for placement.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';
import OnlineItemSheet from '../online/OnlineItemSheet';
import OnlineCart from '../online/OnlineCart';
import CateringCheckout from './CateringCheckout';

const FONT = '-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif';
// Customer surfaces must be their OWN scroll container — the operator app sets body{overflow:hidden},
// so a normal-flow div won't scroll. (Same pattern as OnlineSurface's ScrollShell.)
const shell = (theme) => ({ position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', background: theme?.bg || '#f5f5f5', color: theme?.fg || '#0f172a', fontFamily: FONT });
const fullCenter = { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24, background: '#f5f5f5', color: '#0f172a', fontFamily: FONT };
const center = { maxWidth: 980, margin: '0 auto', padding: '0 16px' };
const money = (n, cur) => `${({ gbp: '£', usd: '$', eur: '€' }[cur] || '£')}${Number(n || 0).toFixed(2)}`;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const addDays = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isLightBackground = (hex) => { if (!hex) return true; const c = String(hex).replace('#', ''); const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c; if (n.length !== 6) return true; const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16); return (0.299 * r + 0.587 * g + 0.114 * b) > 128; };

export default function CateringSurface({ location }) {
  const opsId = location.ops_location_id || location.id;
  const [boot, setBoot] = useState({ loading: true, error: null });
  const [cfg, setCfg] = useState(null);
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [eightySix, setEightySix] = useState([]);
  const [instGroupDefs, setInstGroupDefs] = useState([]);
  const [cart, setCart] = useState([]);
  const [openItem, setOpenItem] = useState(null);
  const [showCart, setShowCart] = useState(false);
  const [fulfilment, setFulfilment] = useState(null);   // 'collection' | 'delivery'
  const [eventDate, setEventDate] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [dayLoad, setDayLoad] = useState(null);          // { count, value }
  const [nextDate, setNextDate] = useState(null);        // suggested next free date when the chosen one is full
  const [checkout, setCheckout] = useState(false);
  const [branding, setBranding] = useState(null);
  const [notice, setNotice] = useState('');     // why checkout is blocked (shown on the event card)
  const eventRef = useRef(null);

  const cur = cfg?.currency || (location.currency || 'gbp').toLowerCase();
  // Branding = the venue's online_branding (BO → Online ordering), falling back to receipt_branding.
  // Field names match OnlineSurface exactly (accent_color / background / foreground / logo_url / hero_url).
  const theme = useMemo(() => {
    const accent = branding?.accent_color || '#e8a020';
    const bg = branding?.background || '#ffffff';
    const fg = branding?.foreground || '#1a1a1a';
    // A primary colour that's ALWAYS readable with white text — a venue's accent can be very light
    // (e.g. pale cream), which makes white-on-accent invisible. Prefer accent, fall back to fg, then slate.
    const brand = !isLightBackground(accent) ? accent : (!isLightBackground(fg) ? fg : '#0f172a');
    return { accent, bg, fg, brand, logo: branding?.logo_url || null, hero: branding?.hero_url || null, name: location.name || 'Catering', isLight: isLightBackground(bg) };
  }, [branding, location.name]);

  useEffect(() => {
    (async () => {
      try {
        await ensureAuthToken();
        const { data: settings } = await supabase.rpc('catering_public_settings', { p_location: opsId });
        if (!settings) { setBoot({ loading: false, error: 'unavailable' }); return; }
        setCfg(settings);
        setFulfilment(settings.takeout_enabled ? 'collection' : settings.delivery_enabled ? 'delivery' : null);
        // Categories shown = those linked to the chosen menus; items + tax read directly (anon).
        const menuIds = settings.menu_ids || [];
        const [{ data: linkRows }, { data: itemRows }, { data: catRows }, { data: taxRows }, { data: e86 }, { data: pushRow }, { data: brandRow }] = await Promise.all([
          menuIds.length ? supabase.from('menu_category_links').select('category_id').in('menu_id', menuIds) : Promise.resolve({ data: [] }),
          supabase.from('menu_items').select('*').eq('location_id', opsId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*').eq('location_id', opsId).order('sort_order'),
          supabase.from('tax_rates').select('id, name, rate, type, active').eq('location_id', opsId),
          supabase.from('eighty_six').select('item_id').eq('location_id', opsId),
          supabase.from('config_pushes').select('snapshot').eq('location_id', opsId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
          supabase.from('locations').select('receipt_branding').eq('id', opsId).maybeSingle(),
        ]);
        const allow = new Set((linkRows || []).map((l) => l.category_id));
        setCats((catRows || []).filter((c) => allow.size === 0 || allow.has(c.id)));
        setItems(itemRows || []);
        setTaxRates(taxRows || []);
        setEightySix((e86 || []).map((r) => r.item_id));
        setInstGroupDefs(pushRow?.snapshot?.instructionGroupDefs || []);
        setBranding(location.online_branding || brandRow?.receipt_branding || null);
        setBoot({ loading: false, error: null });
      } catch (e) { setBoot({ loading: false, error: e?.message || 'failed' }); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capacity look-up for the chosen date (count of catering orders / their value).
  useEffect(() => {
    if (!eventDate || !cfg) { setDayLoad(null); return; }
    let live = true;
    (async () => {
      const { data } = await supabase.from('order_queue').select('total, status').eq('location_id', opsId).eq('source', 'catering').eq('event_date', eventDate);
      if (!live) return;
      const rows = (data || []).filter((r) => r.status !== 'cancelled');
      setDayLoad({ count: rows.length, value: rows.reduce((s, r) => s + Number(r.total || 0), 0) });
    })();
    return () => { live = false; };
  }, [eventDate, cfg, opsId]);

  const subtotal = useMemo(() => cart.reduce((s, l) => s + (l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (l.qty || 1), 0), [cart]);

  const itemsForCat = (catId) => items.filter((i) => (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId))) && !i.parent_id);
  const limitFor = (id) => (cfg?.item_limits || {})[id] || {};
  const is86 = (id) => eightySix.includes(id) || limitFor(id).max === 0;   // max 0 = operator-hidden (86)
  const addToCart = (item, mods, qty, notes = '') => {
    const lim = limitFor(item.id);
    let q = qty;
    if (lim.min) q = Math.max(q, lim.min);                                  // bump up to the per-item minimum
    if (lim.max != null) {
      const existing = cart.filter((l) => l.itemId === item.id).reduce((s, l) => s + (l.qty || 1), 0);
      const room = lim.max - existing;
      if (room <= 0) { alert(`You've reached the maximum (${lim.max}) for ${item.menu_name || item.name}.`); return; }
      q = Math.min(q, room);
    }
    const price = Number(item.pricing?.base ?? item.price ?? 0);
    setCart((c) => [...c, { uid: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, itemId: item.id, name: item.menu_name || item.name, kitchenName: item.kitchen_name || null, cat: item.cat || null, cats: Array.isArray(item.cats) ? item.cats : null, parentId: item.parent_id || null, taxRateId: item.tax_rate_id || null, taxOverrides: item.tax_overrides || {}, price, qty: q, mods, notes }]);
  };

  // Date gating
  const minDays = Number(cfg?.lead_time_min_days ?? 0);
  const maxDays = Number(cfg?.lead_time_max_days ?? 60);
  const dateMin = iso(addDays(minDays));
  const dateMax = iso(addDays(maxDays));
  const dateClosed = (dStr) => {
    if (!dStr) return false;
    if ((cfg?.closures || []).includes(dStr)) return true;
    const dow = DOW[new Date(dStr + 'T00:00:00').getDay()];
    const h = (cfg?.hours || {})[dow];
    return h?.closed === true;
  };
  const capLimit = eventDate ? (cfg?.capacity_overrides?.[eventDate] ?? cfg?.capacity_per_day) : null;
  const atCapacity = useMemo(() => {
    if (!dayLoad || capLimit == null || capLimit === '') return false;
    if (cfg.capacity_mode === 'value') return dayLoad.value >= Number(capLimit) / 100;
    return dayLoad.count >= Number(capLimit);
  }, [dayLoad, capLimit, cfg]);

  // When the chosen date is full, scan forward (within range, skipping closed dates) for the next free day.
  useEffect(() => {
    if (!atCapacity || !eventDate || !cfg) { setNextDate(null); return; }
    let live = true;
    (async () => {
      const start = new Date(eventDate + 'T00:00:00'); const end = new Date(dateMax + 'T00:00:00');
      let found = null;
      for (let i = 1; i <= 21 && !found; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        if (d > end) break;
        const ds = iso(d);
        if (dateClosed(ds)) continue;
        const lim = cfg.capacity_overrides?.[ds] ?? cfg.capacity_per_day;
        if (lim == null || lim === '') { found = ds; break; }
        const { data } = await supabase.from('order_queue').select('total, status').eq('location_id', opsId).eq('source', 'catering').eq('event_date', ds);
        const rows = (data || []).filter((r) => r.status !== 'cancelled');
        const used = cfg.capacity_mode === 'value' ? rows.reduce((s, r) => s + Number(r.total || 0), 0) : rows.length;
        const cap = cfg.capacity_mode === 'value' ? Number(lim) / 100 : Number(lim);
        if (used < cap) found = ds;
      }
      if (live) setNextDate(found);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atCapacity, eventDate, cfg, opsId]);

  const minOrder = (cfg?.order_minimum_minor ?? 0) / 100;
  const belowMin = subtotal < minOrder;
  const dateProblem = !eventDate ? 'Pick an event date' : dateClosed(eventDate) ? 'We’re closed on that date — pick another' : atCapacity ? 'That date is fully booked — please choose another' : !eventTime ? 'Pick an event time' : null;
  const canCheckout = cart.length > 0 && !dateProblem && !belowMin && fulfilment;

  // Try to go to checkout; if blocked, say WHY and scroll to the event card (don't silently close).
  const goCheckout = () => {
    if (cart.length === 0) return;
    const reason = !fulfilment ? 'Choose collection or delivery.'
      : !eventDate ? 'Please pick an event date.'
      : dateClosed(eventDate) ? 'We’re closed on that date — please pick another.'
      : atCapacity ? 'That date is fully booked — please choose another date.'
      : !eventTime ? 'Please pick an event time.'
      : belowMin ? `Your order is below the ${money(minOrder, cur)} minimum — add a little more.`
      : null;
    setShowCart(false);
    if (reason) { setNotice(reason); try { eventRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {} return; }
    setNotice(''); setCheckout(true);
  };
  useEffect(() => { if (canCheckout && notice) setNotice(''); }, [canCheckout, notice]);

  if (boot.loading) return <div style={fullCenter}>Loading…</div>;
  if (boot.error === 'unavailable') return <div style={fullCenter}><div><div style={{ fontSize: 40 }}>🍽️</div><h2>Catering isn’t available right now</h2><div style={{ color: '#64748b' }}>Please contact {location.name} directly.</div></div></div>;
  if (boot.error) return <div style={fullCenter}>Couldn’t load catering. Please try again.</div>;

  if (checkout) return (
    <CateringCheckout
      location={location} cfg={cfg} cart={cart} taxRates={taxRates} theme={theme} cur={cur}
      fulfilment={fulfilment} eventDate={eventDate} eventTime={eventTime} subtotal={subtotal}
      onBack={() => setCheckout(false)}
    />
  );

  return (
    <div style={shell(theme)}>
      <div style={{ position: 'relative', height: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', color: '#fff',
        background: theme.hero ? `linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.8) 100%), url(${theme.hero}) center/cover no-repeat` : `linear-gradient(160deg, ${theme.brand} 0%, rgba(0,0,0,0.5) 100%)` }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 50, background: `linear-gradient(180deg, transparent, ${theme.bg})`, pointerEvents: 'none' }} />
        <div style={{ ...center, position: 'relative', display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 18 }}>
          {theme.logo
            ? <img src={theme.logo} alt={theme.name} style={{ width: 72, height: 72, borderRadius: 16, objectFit: 'cover', border: '3px solid #fff', boxShadow: '0 8px 24px rgba(0,0,0,0.35)', flexShrink: 0, background: '#fff' }} />
            : <div style={{ width: 72, height: 72, borderRadius: 16, background: theme.brand, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 900, border: '3px solid #fff', flexShrink: 0 }}>{(theme.name || 'C')[0]}</div>}
          <div style={{ minWidth: 0, textShadow: '0 2px 10px rgba(0,0,0,0.55)' }}>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{theme.name}</div>
            <div style={{ fontSize: 14, fontWeight: 700, opacity: 0.95 }}>Catering{cfg.banner_message ? ` · ${cfg.banner_message}` : ''}</div>
          </div>
        </div>
      </div>

      <div style={{ ...center, paddingTop: 16, paddingBottom: 120 }}>
        {/* Event details */}
        <div ref={eventRef} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 16, marginBottom: 16, scrollMarginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Your event</div>
          {notice && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '8px 12px', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{notice}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={lbl}>Event date</label><input type="date" min={dateMin} max={dateMax} value={eventDate} onChange={(e) => setEventDate(e.target.value)} style={inp} /></div>
            <div><label style={lbl}>Event time</label><input type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)} style={inp} /></div>
          </div>
          {(cfg.takeout_enabled && cfg.delivery_enabled) && (
            <div style={{ marginTop: 12 }}><label style={lbl}>How would you like it?</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['collection', 'delivery'].map((f) => <button key={f} onClick={() => setFulfilment(f)} style={{ ...pill, ...(fulfilment === f ? { background: theme.brand, color: '#fff', borderColor: theme.brand } : {}) }}>{f === 'collection' ? 'Collection' : 'Delivery'}</button>)}
              </div>
            </div>
          )}
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
            Orders {minDays > 0 ? `at least ${minDays} day${minDays === 1 ? '' : 's'} ahead` : 'for upcoming dates'}{maxDays ? `, up to ${maxDays} days out` : ''}. Minimum order {money(minOrder, cur)}.
            {eventDate && dateProblem && <span style={{ color: '#dc2626', fontWeight: 700 }}> · {dateProblem}</span>}
          </div>
          {atCapacity && nextDate && <button onClick={() => setEventDate(nextDate)} style={{ ...pill, marginTop: 8, fontSize: 12.5, borderColor: theme.brand, color: theme.brand }}>Next available: {new Date(nextDate + 'T00:00:00').toLocaleDateString('en-GB')} — use this date</button>}
        </div>

        {/* Menu */}
        {cats.length === 0 && <div style={{ color: '#64748b' }}>No catering menu items yet.</div>}
        {cats.map((cat) => {
          const ci = itemsForCat(cat.id);
          if (!ci.length) return null;
          return (
            <section key={cat.id} style={{ marginBottom: 22 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, margin: '0 0 10px' }}>{cat.label || cat.name}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
                {ci.map((item) => {
                  const sold = is86(item.id);
                  const lim = limitFor(item.id);
                  const limText = [lim.min ? `min ${lim.min}` : '', lim.max ? `max ${lim.max}` : ''].filter(Boolean).join(' · ');
                  return (
                    <button key={item.id} disabled={sold} onClick={() => setOpenItem(item)} style={{ textAlign: 'left', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', cursor: sold ? 'default' : 'pointer', opacity: sold ? 0.55 : 1 }}>
                      {item.image && <div style={{ width: '100%', height: 150, backgroundImage: `url(${item.image})`, backgroundSize: 'cover', backgroundPosition: 'center', filter: sold ? 'grayscale(1)' : 'none' }} />}
                      <div style={{ padding: 14 }}>
                        <div style={{ fontWeight: 700 }}>{item.menu_name || item.name}</div>
                        {item.description && <div style={{ fontSize: 12.5, color: '#64748b', marginTop: 3 }}>{item.description}</div>}
                        <div style={{ marginTop: 8, fontWeight: 800, color: theme.brand }}>{sold ? 'Sold out' : money(Number(item.pricing?.base ?? item.price ?? 0), cur)}{!sold && limText && <span style={{ fontSize: 11.5, fontWeight: 600, color: '#94a3b8', marginLeft: 8 }}>{limText}</span>}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* Basket bar */}
      {cart.length > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: '#fff', borderTop: '1px solid #e2e8f0', padding: '12px 0' }}>
          <div style={{ ...center, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <button onClick={() => setShowCart(true)} style={{ ...pill }}>View basket ({cart.reduce((n, l) => n + (l.qty || 1), 0)}) · {money(subtotal, cur)}</button>
            <button onClick={goCheckout} style={{ ...btnPrimary(theme), opacity: canCheckout ? 1 : 0.85 }}>
              {belowMin ? `Min ${money(minOrder, cur)}` : dateProblem ? 'Set event details' : 'Proceed to checkout'}
            </button>
          </div>
        </div>
      )}

      {openItem && (
        <OnlineItemSheet item={openItem} theme={theme} allItems={items} instGroupDefs={instGroupDefs} eightySixIds={eightySix}
          onClose={() => setOpenItem(null)} onAdd={(it, mods, qty, notes) => { addToCart(it, mods, qty, notes); setOpenItem(null); }} />
      )}
      {showCart && (
        <OnlineCart cart={cart} theme={theme} orderType={fulfilment || 'collection'} taxRates={taxRates}
          onClose={() => setShowCart(false)} onRemove={(uid) => setCart((c) => c.filter((l) => l.uid !== uid))}
          onUpdateQty={(uid, q) => setCart((c) => c.map((l) => (l.uid === uid ? { ...l, qty: Math.max(1, q) } : l)))}
          onCheckout={goCheckout} />
      )}
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 5 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit' };
const pill = { padding: '9px 14px', borderRadius: 99, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', color: '#0f172a' };
const btnPrimary = (theme) => ({ padding: '11px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: theme.brand, color: '#fff' });
