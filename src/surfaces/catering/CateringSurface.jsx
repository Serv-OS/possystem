// src/surfaces/catering/CateringSurface.jsx
//
// Customer-facing catering ordering site (Module 1, step 2). Reuses the online-ordering engine's
// item sheet + cart, with catering rules layered on: an EVENT DATE + TIME picker (not ASAP), lead-time
// (min/max days) + closed-date/hours gating, a per-day capacity gate, and an order minimum. Settings
// come from the catering_public_settings RPC (anon-safe; only returns when the site is enabled). Menus
// are read directly (anon, like the online site). Handoff → CateringCheckout for placement.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';
import { assembleTaxProfiles } from '../../lib/rowMapping';
import { buildLocalTaxCtx } from '../../lib/taxCompute';
import { receiptOverride } from '../../lib/itemDisplay';
import OnlineItemSheet from '../online/OnlineItemSheet';
import OnlineCart from '../online/OnlineCart';
import CateringCheckout from './CateringCheckout';
import MenuHeader from '../menu/MenuHeader';
import { readTheme, deriveVars, FIXED, BODY_FONT, DISPLAY_FONT } from '../menu/menuTheme';

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
  // v5.7.33: tax profiles + lines, delivered dark alongside taxRates - handed to
  // the cart/checkout ready for the profiles cutover, unused by any calculation.
  const [taxProfiles, setTaxProfiles] = useState([]);
  const [taxCatRows, setTaxCatRows] = useState([]);                              // v5.7.34: unfiltered, for the tax cascade
  const [venueDefaultTaxProfileId, setVenueDefaultTaxProfileId] = useState(null); // v5.7.34: locations.default_tax_profile_id
  const [eightySix, setEightySix] = useState([]);
  const [stockLevels, setStockLevels] = useState({});   // v5.6.69: { itemId: { par, remaining } }
  const [instGroupDefs, setInstGroupDefs] = useState([]);
  const [cart, setCart] = useState([]);
  const [openItem, setOpenItem] = useState(null);
  const [showCart, setShowCart] = useState(false);
  const [activeAllergens, setActiveAllergens] = useState([]);   // customer-picked allergens to hide
  const [showAllergyPicker, setShowAllergyPicker] = useState(false);
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
  // Themeable menu (prototype design system): one brand colour drives the palette via CSS vars.
  const mt = useMemo(() => readTheme(branding), [branding]);
  const vars = useMemo(() => deriveVars(mt.brandColor, mt.bodyBg), [mt.brandColor, mt.bodyBg]);
  // `theme` keeps the (unchanged) card/checkout internals working; brand unified to the menu brand colour.
  const theme = useMemo(() => ({ brand: mt.brandColor, bg: '#ffffff', fg: FIXED.ink, accent: mt.brandColor, logo: mt.logoUrl, hero: mt.headerImageUrl, name: location.name || 'Catering', isLight: true }), [mt, location.name]);

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
        const [{ data: linkRows }, { data: itemRows }, { data: catRows }, { data: taxRows }, { data: e86 }, { data: pushRow }, { data: brandRow }, { data: stockRows }, { data: profRows }, { data: lineRows }] = await Promise.all([
          menuIds.length ? supabase.from('menu_category_links').select('category_id').in('menu_id', menuIds) : Promise.resolve({ data: [] }),
          supabase.from('menu_items').select('*').eq('location_id', opsId).eq('archived', false).order('sort_order'),
          supabase.from('menu_categories').select('*').eq('location_id', opsId).order('sort_order'),
          supabase.from('tax_rates').select('id, name, rate, type, active, is_default').eq('location_id', opsId),
          supabase.from('eighty_six').select('item_id').eq('location_id', opsId),
          supabase.from('config_pushes').select('snapshot->instructionGroupDefs').eq('location_id', opsId).order('created_at', { ascending: false }).limit(1).maybeSingle(), // v5.5.891: defs only, not the whole menu snapshot
          // v5.7.34: default_tax_profile_id rides the branding read — the venue
          // default the reviewer flagged missing (cascade step 4 on this surface).
          supabase.from('locations').select('receipt_branding, default_tax_profile_id').eq('id', opsId).maybeSingle(),
          // v5.6.69: stock levels — OnlineItemSheet's numeric option cap (v5.5.872)
          // was INERT on catering because stockLevels was never passed.
          supabase.from('stock_levels').select('item_id, par, remaining').eq('location_id', opsId),
          // v5.7.33: tax profiles + lines (anon SELECT), delivery only - unused by
          // any calculation today. Category/item assignments already ride the raw
          // menu_categories / menu_items select('*') reads above (tax_profile_id).
          supabase.from('tax_profiles').select('*').eq('location_id', opsId).order('sort_order'),
          supabase.from('tax_profile_lines').select('*').eq('location_id', opsId).order('sort_order'),
        ]);
        const allow = new Set((linkRows || []).map((l) => l.category_id));
        // Match the POS rule (v4.7.6): a category is in a chosen menu if that menu is its
        // PRIMARY home (menu_id) OR it's joined via menu_category_links. Links-only checking
        // dropped home-menu categories with no link row (same bug OnlineSurface had, v5.5.786).
        setCats((catRows || []).filter((c) =>
          !menuIds.length || menuIds.includes(c.menu_id) || allow.has(c.id) || (c.parent_id && allow.has(c.parent_id))));
        setItems(itemRows || []);
        setTaxRates(taxRows || []);
        // v5.7.33: both reads must have succeeded - never keep line-less profiles.
        if (Array.isArray(profRows) && Array.isArray(lineRows)) {
          setTaxProfiles(assembleTaxProfiles(profRows, lineRows));
        }
        // v5.7.34: UNFILTERED category rows + the venue default for the seam's
        // cascade (the display `cats` above are menu-filtered).
        setTaxCatRows(catRows || []);
        setVenueDefaultTaxProfileId(brandRow?.default_tax_profile_id ?? null);
        setEightySix((e86 || []).map((r) => r.item_id));
        const counts = {};
        (stockRows || []).forEach((r) => { counts[r.item_id] = { par: r.par, remaining: r.remaining }; });
        setStockLevels(counts);
        setInstGroupDefs(pushRow?.instructionGroupDefs || []); // v5.5.891: row IS { instructionGroupDefs }
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

  // Allergen vocabulary across the catering menu (for the filter chips).
  const knownAllergens = useMemo(() => {
    const set = new Set();
    (items || []).forEach((i) => (i.allergens || []).forEach((a) => a && set.add(a)));
    return [...set].sort();
  }, [items]);

  // Hide items containing any picked allergen (mirrors online/kiosk). Applied everywhere itemsForCat
  // is used — the sticky category nav + the section render — so a fully-filtered category disappears.
  const itemsForCat = (catId) => items.filter((i) =>
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId))) && !i.parent_id &&
    !(activeAllergens.length && (i.allergens || []).some((a) => activeAllergens.includes(a))));
  // v5.5.743: match OnlineSurface exactly — show only TOP-LEVEL categories (no sub-categories) in the
  // nav + sections, sorted by (sort_order||0) with a stable tie-break. Catering was rendering every
  // category (incl. sub-categories like "Steaks") in raw DB order, so a sub surfaced first. Both
  // surfaces now list the same top categories in the same order.
  const topCats = useMemo(
    () => (cats || []).filter((c) => !c.parent_id).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    [cats]
  );
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
    setCart((c) => [...c, { uid: `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, itemId: item.id, name: item.menu_name || item.name, kitchenName: item.kitchen_name || null, receiptName: receiptOverride(item), cat: item.cat || null, cats: Array.isArray(item.cats) ? item.cats : null, parentId: item.parent_id || null, taxRateId: item.tax_rate_id || null, taxOverrides: item.tax_overrides || {}, taxProfileId: item.tax_profile_id ?? null, price, qty: q, mods, notes }]);
  };

  // v5.7.34: the unified seam's tax context — this surface's own fetches
  // (profiles + raw tax_profile_id columns + venue default) in one object.
  const taxCtx = useMemo(() => buildLocalTaxCtx({
    taxProfiles, menuItems: items, menuCategories: taxCatRows,
    venueDefaultProfileId: venueDefaultTaxProfileId, taxRates,
  }), [taxProfiles, items, taxCatRows, venueDefaultTaxProfileId, taxRates]);

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
      location={location} cfg={cfg} cart={cart} taxRates={taxRates} taxCtx={taxCtx} theme={theme} cur={cur}
      fulfilment={fulfilment} eventDate={eventDate} eventTime={eventTime} subtotal={subtotal}
      onBack={() => setCheckout(false)}
    />
  );

  return (
    <div style={{ ...vars, position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', containerType: 'inline-size', background: 'var(--bg)', color: 'var(--ink)', fontFamily: BODY_FONT }}>
      <MenuHeader theme={mt} name={location.name || 'Catering'} pills={[{ label: cfg.banner_message || 'Catering · Pre-order' }]} max={980} />

      {/* Sticky category chooser — scrolls to each menu section */}
      {topCats.filter((c) => itemsForCat(c.id).length).length > 1 && (
        <div style={{ position: 'sticky', top: 0, zIndex: 8, background: theme.bg, borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ ...center, padding: '8px 16px', overflowX: 'auto', whiteSpace: 'nowrap', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {topCats.map((c) => {
              if (!itemsForCat(c.id).length) return null;
              return <button key={c.id} onClick={() => document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{ display: 'inline-block', padding: '7px 13px', marginRight: 6, borderRadius: 99, background: 'transparent', color: theme.brand, border: `1.5px solid ${theme.brand}`, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{c.label || c.name}</button>;
            })}
          </div>
        </div>
      )}

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

        {/* Allergy filter — only when the menu carries allergen tags */}
        {knownAllergens.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => setShowAllergyPicker(true)}
              style={{ ...pill, display: 'inline-flex', alignItems: 'center', gap: 8,
                background: activeAllergens.length ? '#fef2f2' : '#fff',
                color: activeAllergens.length ? '#dc2626' : '#0f172a',
                borderColor: activeAllergens.length ? '#fca5a5' : '#cbd5e1' }}>
              <span aria-hidden>⚠</span>
              {activeAllergens.length ? `${activeAllergens.length} allergy filter${activeAllergens.length === 1 ? '' : 's'}` : 'Allergies'}
            </button>
            {activeAllergens.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '8px 12px', lineHeight: 1.5 }}>
                Showing items free from <b>{activeAllergens.join(', ')}</b>. Items containing those are hidden — always confirm with us for a severe allergy.
              </div>
            )}
          </div>
        )}

        {/* Menu */}
        {topCats.length === 0 && <div style={{ color: '#64748b' }}>No catering menu items yet.</div>}
        {topCats.map((cat) => {
          const ci = itemsForCat(cat.id);
          if (!ci.length) return null;
          return (
            <section key={cat.id} id={`cat-${cat.id}`} style={{ marginBottom: 'clamp(30px,5cqw,48px)', scrollMarginTop: 58 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
                <h2 style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 'clamp(20px,4.4cqw,28px)', margin: 0, letterSpacing: '-.02em', color: 'var(--ink)' }}>{cat.label || cat.name}</h2>
                <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{ci.length} item{ci.length === 1 ? '' : 's'}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(47%, 280px), 1fr))', gap: 12 }}>
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
                        {(item.allergens || []).length > 0 && (
                          <div title={`Contains: ${item.allergens.join(', ')}`} style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: '#b45309' }}>
                            ⚠ {item.allergens.length === 1 ? item.allergens[0] : `${item.allergens.length} allergens`}
                          </div>
                        )}
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
          stockLevels={stockLevels} cart={cart}
          onClose={() => setOpenItem(null)} onAdd={(it, mods, qty, notes) => { addToCart(it, mods, qty, notes); setOpenItem(null); }} />
      )}
      {showCart && (
        <OnlineCart cart={cart} theme={theme} orderType={fulfilment || 'collection'} taxRates={taxRates} taxCtx={taxCtx}
          onClose={() => setShowCart(false)} onRemove={(uid) => setCart((c) => c.filter((l) => l.uid !== uid))}
          onUpdateQty={(uid, q) => setCart((c) => c.map((l) => (l.uid === uid ? { ...l, qty: Math.max(1, q) } : l)))}
          onCheckout={goCheckout} />
      )}
      {showAllergyPicker && (
        <AllergyPicker theme={theme} all={knownAllergens} active={activeAllergens}
          onClose={() => setShowAllergyPicker(false)}
          onSave={(next) => { setActiveAllergens(next); setShowAllergyPicker(false); }} />
      )}
    </div>
  );
}

// Compact allergen picker — hide items containing any picked allergen. Mirrors the online/kiosk flow.
function AllergyPicker({ theme, all, active, onClose, onSave }) {
  const [sel, setSel] = useState(active || []);
  const toggle = (a) => setSel((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]));
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', width: 'min(560px,100%)', borderRadius: '18px 18px 0 0', padding: 20, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: 20 }}>Allergies</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 6, lineHeight: 1.5 }}>
          We’ll hide items containing anything you pick. <b>Always confirm with us</b> for a severe allergy — cross-contamination is possible.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {all.length === 0 && <div style={{ fontSize: 13, color: '#94a3b8' }}>No allergen tags on this menu yet.</div>}
          {all.map((a) => {
            const on = sel.includes(a);
            return (
              <button key={a} onClick={() => toggle(a)} style={{ padding: '9px 14px', borderRadius: 99, cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', textTransform: 'capitalize',
                background: on ? '#fef2f2' : '#fff', color: on ? '#dc2626' : '#334155', border: `1.5px solid ${on ? '#fca5a5' : '#e2e8f0'}` }}>
                {on ? '✓ ' : ''}{a}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          {sel.length > 0 && <button onClick={() => setSel([])} style={{ ...pill, flex: 1 }}>Clear</button>}
          <button onClick={() => onSave(sel)} style={{ ...btnPrimary(theme), flex: 2 }}>{sel.length ? `Hide ${sel.length} allergen${sel.length === 1 ? '' : 's'}` : 'Done'}</button>
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 5 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: 10, padding: '9px 12px', fontSize: 14, fontFamily: 'inherit' };
const pill = { padding: '9px 14px', borderRadius: 99, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', color: '#0f172a' };
const btnPrimary = (theme) => ({ padding: '11px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: theme.brand, color: '#fff' });
