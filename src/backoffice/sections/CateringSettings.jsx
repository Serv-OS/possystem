// src/backoffice/sections/CateringSettings.jsx
//
// Catering Online Ordering (Module 1) — the single settings page (Channels → Catering ordering).
// One catering_site_settings row per location, read/written directly under RLS (the BO user has
// location access). NO baked-in defaults (owner decision): the operator completes setup, and the
// catering site stays OFF until the required fields are filled. Money shown in major units, stored
// in integer minor units. Multi-currency (£/$/€) per location.

import { useEffect, useState } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../lib/supabase';
import { CUSTOMER_ROOT, customerUrl } from '../../lib/env';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 760 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: 'var(--t2)', cursor: 'pointer' },
  warn: { background: 'var(--bg2)', border: '1px solid var(--amber, #d98a00)', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: 'var(--t2)', marginBottom: 12 },
};
const CCY = { gbp: '£', usd: '$', eur: '€' };
const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

const BLANK = (locId) => ({
  location_id: locId, enabled: false, currency: 'gbp', slug: '', banner_message: '',
  hours: {}, closures: [], lead_time_min_days: '', lead_time_max_days: '', prep_time_minutes: '',
  order_minimum: '', tips_enabled: false, tip_default_pct: '',
  takeout_enabled: false, takeout_dining_option: 'collection',
  delivery_enabled: false, delivery_dining_option: 'delivery', delivery_radius_miles: '', delivery_fee: '', delivery_fee_per_mile: '',
  menu_ids: [], item_limits: {}, allow_tax_exempt: false, allow_promo: false, allow_pay_later: false,
  capacity_mode: 'count', capacity_per_day: '', capacity_overrides: {},
});

const major = (v) => (v == null ? '' : String(v / 100));
function fromRow(r) {
  return {
    location_id: r.location_id, enabled: r.enabled, currency: r.currency || 'gbp', slug: r.slug || '', banner_message: r.banner_message || '',
    hours: r.hours || {}, closures: r.closures || [],
    lead_time_min_days: r.lead_time_min_days ?? '', lead_time_max_days: r.lead_time_max_days ?? '', prep_time_minutes: r.prep_time_minutes ?? '',
    order_minimum: major(r.order_minimum_minor), tips_enabled: r.tips_enabled, tip_default_pct: r.tip_default_pct ?? '',
    takeout_enabled: r.takeout_enabled, takeout_dining_option: r.takeout_dining_option || 'collection',
    delivery_enabled: r.delivery_enabled, delivery_dining_option: r.delivery_dining_option || 'delivery',
    delivery_radius_miles: r.delivery_radius_miles ?? '', delivery_fee: major(r.delivery_fee_minor), delivery_fee_per_mile: major(r.delivery_fee_per_mile_minor),
    menu_ids: r.menu_ids || [], item_limits: r.item_limits || {}, allow_tax_exempt: r.allow_tax_exempt, allow_promo: r.allow_promo, allow_pay_later: r.allow_pay_later,
    capacity_mode: r.capacity_mode || 'count', capacity_per_day: r.capacity_mode === 'value' ? major(r.capacity_per_day) : (r.capacity_per_day ?? ''), capacity_overrides: r.capacity_overrides || {},
  };
}
const num = (v) => (v === '' || v == null ? null : Number(v));
const minor = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));
function toRow(s) {
  return {
    location_id: s.location_id, enabled: !!s.enabled, currency: s.currency || 'gbp', slug: s.slug || null, banner_message: s.banner_message || null,
    hours: s.hours && Object.keys(s.hours).length ? s.hours : null, closures: s.closures && s.closures.length ? s.closures : null,
    lead_time_min_days: num(s.lead_time_min_days), lead_time_max_days: num(s.lead_time_max_days), prep_time_minutes: num(s.prep_time_minutes), kitchen_fire_time: null,
    order_minimum_minor: minor(s.order_minimum), tips_enabled: !!s.tips_enabled, tip_default_pct: num(s.tip_default_pct),
    takeout_enabled: !!s.takeout_enabled, takeout_dining_option: s.takeout_dining_option || null,
    delivery_enabled: !!s.delivery_enabled, delivery_dining_option: s.delivery_dining_option || null,
    delivery_radius_miles: num(s.delivery_radius_miles), delivery_fee_minor: minor(s.delivery_fee), delivery_fee_per_mile_minor: minor(s.delivery_fee_per_mile),
    menu_ids: s.menu_ids && s.menu_ids.length ? s.menu_ids : null, item_limits: s.item_limits && Object.keys(s.item_limits).length ? s.item_limits : null,
    allow_tax_exempt: !!s.allow_tax_exempt, allow_promo: !!s.allow_promo, allow_pay_later: !!s.allow_pay_later,
    capacity_mode: s.capacity_mode || null, capacity_per_day: s.capacity_mode === 'value' ? minor(s.capacity_per_day) : num(s.capacity_per_day),
    capacity_overrides: s.capacity_overrides && Object.keys(s.capacity_overrides).length ? s.capacity_overrides : null,
    updated_at: new Date().toISOString(),
  };
}

export default function CateringSettings() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [menus, setMenus] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [menuLinks, setMenuLinks] = useState([]);
  const [venueSlug, setVenueSlug] = useState(null);
  const [s, setS] = useState(null);
  const [save, setSave] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        const [{ data: row }, { data: ms }, { data: mi }] = await Promise.all([
          supabase.from('catering_site_settings').select('*').eq('location_id', id).maybeSingle(),
          supabase.from('menus').select('id, name, is_active').eq('location_id', id).order('name'),
          supabase.from('menu_items').select('id, name, menu_name, cat, cats, parent_id').eq('location_id', id).eq('archived', false).order('sort_order'),
        ]);
        const menuList = (ms || []).filter((m) => m.is_active !== false);
        setMenus(menuList);
        setMenuItems(mi || []);
        // Links scoped to this location's menus (menu_category_links has no location_id column).
        const menuIds = menuList.map((m) => m.id);
        const { data: ml } = menuIds.length ? await supabase.from('menu_category_links').select('menu_id, category_id').in('menu_id', menuIds) : { data: [] };
        setMenuLinks(ml || []);
        // The catering site lives at the venue's existing web slug + /catering — fetch it for the URL/link.
        try { const { data: pl } = await platformSupabase.from('locations').select('online_slug').or(`ops_location_id.eq.${id},id.eq.${id}`).limit(1).maybeSingle(); setVenueSlug(pl?.online_slug || null); } catch { /* slug optional */ }
        setS(row ? fromRow(row) : BLANK(id));
      } catch { /* leave blank */ } finally { setLoading(false); }
    })();
  }, []);

  const set = (patch) => setS((v) => ({ ...v, ...patch }));

  // Required-before-enable (no defaults — operator must complete setup).
  const missing = () => {
    if (!s) return [];
    const m = [];
    if (s.lead_time_min_days === '' || s.lead_time_max_days === '') m.push('lead time (min & max days)');
    if (s.prep_time_minutes === '') m.push('prep time');
    if (s.order_minimum === '') m.push('order minimum');
    if (!s.takeout_enabled && !s.delivery_enabled) m.push('a fulfilment method (takeout or delivery)');
    if (!(s.menu_ids && s.menu_ids.length)) m.push('at least one menu');
    if (s.capacity_per_day === '') m.push('daily capacity');
    return m;
  };

  const saveAll = async () => {
    setSave({ busy: true });
    try {
      const need = missing();
      if (s.enabled && need.length) { setSave({ err: `Complete setup before turning the site on: ${need.join(', ')}.` }); return; }
      const { error } = await supabase.from('catering_site_settings').upsert(toRow(s), { onConflict: 'location_id' });
      if (error) throw error;
      setSave({ done: true }); setTimeout(() => setSave((v) => (v.done ? {} : v)), 2500);
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId || !s) return <div style={S.empty}>Pick a location to set up catering ordering.</div>;

  const cur = CCY[s.currency] || '£';
  const need = missing();
  const toggleMenu = (id) => set({ menu_ids: s.menu_ids.includes(id) ? s.menu_ids.filter((x) => x !== id) : [...s.menu_ids, id] });
  const setHour = (d, patch) => set({ hours: { ...s.hours, [d]: { ...(s.hours[d] || {}), ...patch } } });
  const setItemLimit = (itemId, key, val) => {
    const next = { ...(s.item_limits || {}) };
    const entry = { ...(next[itemId] || {}) };
    if (val === '' || val == null) delete entry[key]; else entry[key] = Number(val);
    if (Object.keys(entry).length) next[itemId] = entry; else delete next[itemId];
    set({ item_limits: next });
  };
  const selectedCatIds = new Set(menuLinks.filter((l) => (s.menu_ids || []).includes(l.menu_id)).map((l) => l.category_id));
  const limitItems = menuItems.filter((it) => !it.parent_id && (selectedCatIds.has(it.cat) || (Array.isArray(it.cats) && it.cats.some((c) => selectedCatIds.has(c)))));

  return (
    <div>
      <h1 style={S.h1}>Catering ordering</h1>
      <div style={S.sub}>One page to run your catering order site — hours, lead time, menus, delivery and daily capacity. Complete the required fields, then switch it on.</div>

      {/* On/off */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={S.toggle}><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Catering site is {s.enabled ? 'ON' : 'OFF'}</label>
          <select style={{ ...S.input, width: 130 }} value={s.currency} onChange={(e) => set({ currency: e.target.value })}>
            <option value="gbp">£ GBP</option><option value="usd">$ USD</option><option value="eur">€ EUR</option>
          </select>
        </div>
        {s.enabled && need.length > 0 && <div style={{ ...S.warn, marginTop: 12 }}>⚠ Setup incomplete — still needed: <b>{need.join(', ')}</b>. The site won’t save as ON until these are filled.</div>}
        <div style={{ ...S.field, marginTop: 12 }}>
          <label style={S.label}>Your catering site</label>
          {venueSlug ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <code style={{ fontSize: 13, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '7px 10px', color: 'var(--t1)' }}>https://{venueSlug}.{CUSTOMER_ROOT}/catering</code>
              <a href={customerUrl(venueSlug, '/catering')} target="_blank" rel="noopener" style={{ ...S.btn, textDecoration: 'none', display: 'inline-block' }}>Open catering site ↗</a>
            </div>
          ) : (
            <div style={S.hint}>Set a public web address (slug) for this venue in <b>Channels → Online ordering</b> first — your catering site is then that address with <code>/catering</code> on the end.</div>
          )}
          <div style={S.hint}>It’s your venue’s web address + <b>/catering</b>. It goes live once you complete setup and switch it on above.</div>
        </div>
        <div style={S.field}><label style={S.label}>Banner message <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label><input style={S.input} value={s.banner_message} onChange={(e) => set({ banner_message: e.target.value })} placeholder="Order 48h ahead for events" /></div>
      </div>

      {/* Hours + closures */}
      <div style={S.card}>
        <h2 style={S.h2}>Catering hours</h2>
        {DAYS.map(([d, lbl]) => {
          const h = s.hours[d] || {};
          return (
            <div key={d} style={{ display: 'grid', gridTemplateColumns: '60px 110px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)' }}>{lbl}</div>
              <label style={S.toggle}><input type="checkbox" checked={!h.closed} onChange={(e) => setHour(d, { closed: !e.target.checked })} /> {h.closed ? 'Closed' : 'Open'}</label>
              <input type="time" style={{ ...S.input, opacity: h.closed ? 0.4 : 1 }} disabled={h.closed} value={h.open || ''} onChange={(e) => setHour(d, { open: e.target.value })} />
              <input type="time" style={{ ...S.input, opacity: h.closed ? 0.4 : 1 }} disabled={h.closed} value={h.close || ''} onChange={(e) => setHour(d, { close: e.target.value })} />
            </div>
          );
        })}
        <div style={{ ...S.field, marginTop: 12 }}>
          <label style={S.label}>Closed dates</label>
          {(s.closures || []).map((d, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input type="date" style={{ ...S.input, maxWidth: 200 }} value={d} onChange={(e) => set({ closures: s.closures.map((x, j) => (j === i ? e.target.value : x)) })} />
              <button style={{ ...S.input, width: 'auto', cursor: 'pointer' }} onClick={() => set({ closures: s.closures.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button style={{ ...S.input, width: 'auto', cursor: 'pointer' }} onClick={() => set({ closures: [...(s.closures || []), ''] })}>+ Add closed date</button>
        </div>
      </div>

      {/* Timing + minimum + tips */}
      <div style={S.card}>
        <h2 style={S.h2}>Ordering rules</h2>
        <div style={S.row3}>
          <div style={S.field}><label style={S.label}>Lead time — min (days)</label><input type="number" min={0} style={S.input} value={s.lead_time_min_days} onChange={(e) => set({ lead_time_min_days: e.target.value })} /></div>
          <div style={S.field}><label style={S.label}>Lead time — max (days)</label><input type="number" min={0} style={S.input} value={s.lead_time_max_days} onChange={(e) => set({ lead_time_max_days: e.target.value })} /></div>
          <div style={S.field}><label style={S.label}>Prep time (minutes)</label><input type="number" min={0} style={S.input} value={s.prep_time_minutes} onChange={(e) => set({ prep_time_minutes: e.target.value })} /><div style={S.hint}>How long the kitchen needs. Each order fires into the kitchen this many minutes before its <strong>own</strong> event time, and counts as that day’s sales. 0 = fires at the event time.</div></div>
        </div>
        <div style={S.row3}>
          <div style={S.field}><label style={S.label}>Order minimum ({cur})</label><input type="number" min={0} step="0.01" style={S.input} value={s.order_minimum} onChange={(e) => set({ order_minimum: e.target.value })} /></div>
          <div style={S.field}><label style={S.label}>Tips</label><label style={{ ...S.toggle, paddingTop: 8 }}><input type="checkbox" checked={s.tips_enabled} onChange={(e) => set({ tips_enabled: e.target.checked })} /> Allow tipping</label></div>
          {s.tips_enabled && <div style={S.field}><label style={S.label}>Default tip %</label><input type="number" min={0} max={100} style={S.input} value={s.tip_default_pct} onChange={(e) => set({ tip_default_pct: e.target.value })} /></div>}
        </div>
      </div>

      {/* Fulfilment */}
      <div style={S.card}>
        <h2 style={S.h2}>Takeout &amp; delivery</h2>
        <label style={{ ...S.toggle, marginBottom: 10 }}><input type="checkbox" checked={s.takeout_enabled} onChange={(e) => set({ takeout_enabled: e.target.checked })} /> Takeout / collection</label>
        {s.takeout_enabled && (
          <div style={{ ...S.field, paddingLeft: 24 }}><label style={S.label}>Order type</label>
            <select style={{ ...S.input, maxWidth: 220 }} value={s.takeout_dining_option} onChange={(e) => set({ takeout_dining_option: e.target.value })}><option value="collection">Collection</option><option value="takeaway">Takeaway</option></select>
          </div>
        )}
        <label style={{ ...S.toggle, margin: '12px 0 10px' }}><input type="checkbox" checked={s.delivery_enabled} onChange={(e) => set({ delivery_enabled: e.target.checked })} /> Delivery</label>
        {s.delivery_enabled && (
          <div style={{ paddingLeft: 24 }}>
            <div style={S.row2}>
              <div style={S.field}><label style={S.label}>Order type</label><select style={S.input} value={s.delivery_dining_option} onChange={(e) => set({ delivery_dining_option: e.target.value })}><option value="delivery">Delivery</option></select></div>
              <div style={S.field}><label style={S.label}>Delivery radius (miles)</label><input type="number" min={0} step="0.5" style={S.input} value={s.delivery_radius_miles} onChange={(e) => set({ delivery_radius_miles: e.target.value })} /></div>
            </div>
            <div style={S.row2}>
              <div style={S.field}><label style={S.label}>Flat delivery fee ({cur})</label><input type="number" min={0} step="0.01" style={S.input} value={s.delivery_fee} onChange={(e) => set({ delivery_fee: e.target.value })} /></div>
              <div style={S.field}><label style={S.label}>Or per-mile fee ({cur})</label><input type="number" min={0} step="0.01" style={S.input} value={s.delivery_fee_per_mile} onChange={(e) => set({ delivery_fee_per_mile: e.target.value })} /></div>
            </div>
            <div style={S.hint}>Set a flat fee or a per-mile fee — leave the other blank.</div>
          </div>
        )}
      </div>

      {/* Menus */}
      <div style={S.card}>
        <h2 style={S.h2}>Menus on the catering site</h2>
        {menus.length === 0 ? <div style={S.hint}>No menus found for this location. Create one in Menu manager first.</div> : menus.map((m) => (
          <label key={m.id} style={{ ...S.toggle, marginBottom: 8 }}><input type="checkbox" checked={s.menu_ids.includes(m.id)} onChange={() => toggleMenu(m.id)} /> {m.name}</label>
        ))}
        <div style={S.hint}>A menu becomes catering-only by adding it here and not to standard online ordering.</div>
      </div>

      {/* Per-item limits */}
      <div style={S.card}>
        <h2 style={S.h2}>Per-item quantity limits <span style={{ fontWeight: 500, color: 'var(--t4)', fontSize: 12 }}>optional</span></h2>
        {(s.menu_ids || []).length === 0 ? <div style={S.hint}>Pick at least one menu above to set item limits.</div>
          : limitItems.length === 0 ? <div style={S.hint}>No items found in the selected menus.</div> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 92px 92px', gap: 10, marginBottom: 4 }}>
                <div style={S.label}>Item</div><div style={{ ...S.label, textAlign: 'right' }}>Min qty</div><div style={{ ...S.label, textAlign: 'right' }}>Max qty</div>
              </div>
              {limitItems.map((it) => {
                const lim = (s.item_limits || {})[it.id] || {};
                return (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1fr 92px 92px', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ fontSize: 13, color: 'var(--t1)' }}>{it.menu_name || it.name}{lim.max === 0 && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 99, padding: '1px 7px' }}>hidden</span>}</div>
                    <input type="number" min={0} style={{ ...S.input, textAlign: 'right' }} value={lim.min ?? ''} onChange={(e) => setItemLimit(it.id, 'min', e.target.value)} />
                    <input type="number" min={0} style={{ ...S.input, textAlign: 'right' }} value={lim.max ?? ''} onChange={(e) => setItemLimit(it.id, 'max', e.target.value)} />
                  </div>
                );
              })}
              <div style={S.hint}>Leave blank for no limit. Set <b>Max to 0</b> to hide an item (86 it) on the catering site.</div>
            </>
          )}
      </div>

      {/* Checkout */}
      <div style={S.card}>
        <h2 style={S.h2}>Checkout options</h2>
        <label style={{ ...S.toggle, marginBottom: 8 }}><input type="checkbox" checked={s.allow_tax_exempt} onChange={(e) => set({ allow_tax_exempt: e.target.checked })} /> Allow tax-exempt / VAT-registered customers (enter a tax/VAT id)</label>
        <label style={{ ...S.toggle, marginBottom: 8 }}><input type="checkbox" checked={s.allow_promo} onChange={(e) => set({ allow_promo: e.target.checked })} /> Allow a promo code (applies to the whole order)</label>
        <label style={S.toggle}><input type="checkbox" checked={s.allow_pay_later} onChange={(e) => set({ allow_pay_later: e.target.checked })} /> Allow “pay later” (order arrives confirmed but unpaid)</label>
      </div>

      {/* Capacity */}
      <div style={S.card}>
        <h2 style={S.h2}>Daily capacity</h2>
        <div style={S.row2}>
          <div style={S.field}><label style={S.label}>Limit by</label><select style={S.input} value={s.capacity_mode} onChange={(e) => set({ capacity_mode: e.target.value })}><option value="count">Number of orders</option><option value="value">Order value ({cur})</option></select></div>
          <div style={S.field}><label style={S.label}>{s.capacity_mode === 'value' ? `Max ${cur} per day` : 'Max orders per day'}</label><input type="number" min={0} step={s.capacity_mode === 'value' ? '0.01' : '1'} style={S.input} value={s.capacity_per_day} onChange={(e) => set({ capacity_per_day: e.target.value })} /></div>
        </div>
        <div style={S.field}>
          <label style={S.label}>Date overrides <span style={{ color: 'var(--t4)', fontWeight: 500 }}>e.g. a busy holiday</span></label>
          {Object.entries(s.capacity_overrides || {}).map(([d, v], i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input type="date" style={{ ...S.input, maxWidth: 180 }} value={d} onChange={(e) => { const o = { ...s.capacity_overrides }; delete o[d]; o[e.target.value] = v; set({ capacity_overrides: o }); }} />
              <input type="number" min={0} style={{ ...S.input, maxWidth: 140 }} value={v} onChange={(e) => set({ capacity_overrides: { ...s.capacity_overrides, [d]: Number(e.target.value) } })} />
              <button style={{ ...S.input, width: 'auto', cursor: 'pointer' }} onClick={() => { const o = { ...s.capacity_overrides }; delete o[d]; set({ capacity_overrides: o }); }}>Remove</button>
            </div>
          ))}
          <button style={{ ...S.input, width: 'auto', cursor: 'pointer' }} onClick={() => set({ capacity_overrides: { ...s.capacity_overrides, '': 0 } })}>+ Add date override</button>
        </div>
        <div style={S.hint}>To 86 an item, set its per-item max to 0 (in the menu picker — coming with the ordering site).</div>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', maxWidth: 760 }}>
        <button style={S.btn} onClick={saveAll} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save catering settings'}</button>
        {save.done && <span style={S.ok}>✓ Saved</span>}
        {save.err && <span style={S.err}>{save.err}</span>}
      </div>
    </div>
  );
}
