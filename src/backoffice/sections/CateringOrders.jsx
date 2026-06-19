// src/backoffice/sections/CateringOrders.jsx
//
// Back office → Channels → "Catering orders". The kitchen-planning view of all catering pre-orders
// (order_queue rows tagged source='catering'), grouped by event date with filters. Big scheduled
// orders are easy to miss in the live hub, so this gives the team forward visibility. Read-only over
// order_queue (RLS allows the BO user). The release-to-hub / fire-to-kitchen lifecycle is separate.

import { useEffect, useMemo, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 16 },
  seg: (on) => ({ padding: '7px 13px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
  card: { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', marginBottom: 10, overflow: 'hidden' },
  row: { display: 'grid', gridTemplateColumns: '120px 1fr 100px 90px 110px', gap: 12, alignItems: 'center', padding: '12px 14px', cursor: 'pointer' },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  kpi: { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', padding: '12px 14px' },
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 14 },
  dayHdr: { fontSize: 13, fontWeight: 800, color: 'var(--t1)', margin: '18px 0 8px', display: 'flex', alignItems: 'center', gap: 10 },
};
const money = (n, cur) => `${({ gbp: '£', usd: '$', eur: '€' }[cur] || '£')}${Number(n || 0).toFixed(2)}`;
const todayISO = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); } catch { return iso; } };
const statusLabel = (o) => o.status === 'cancelled' ? 'Cancelled' : o.status === 'prep' || o.kitchen_routed_at ? 'In kitchen' : o.status === 'done' ? 'Completed' : 'Scheduled';

const RANGES = [['upcoming', 'Upcoming'], ['today', 'Today'], ['week', 'Next 7 days'], ['past', 'Past'], ['all', 'All']];

export default function CateringOrders() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [cur, setCur] = useState('gbp');
  const [range, setRange] = useState('upcoming');
  const [paidFilter, setPaidFilter] = useState('all'); // all | paid | unpaid
  const [open, setOpen] = useState(null);

  const load = async (id) => {
    const [{ data }, { data: cfg }] = await Promise.all([
      supabase.from('order_queue').select('*').eq('location_id', id).eq('source', 'catering').order('event_date', { ascending: true }).limit(2000),
      supabase.from('catering_site_settings').select('currency').eq('location_id', id).maybeSingle(),
    ]);
    setOrders(data || []); setCur(cfg?.currency || 'gbp');
  };
  useEffect(() => {
    (async () => { try { const id = await getActiveLocationSync(); setLocId(id); if (supabase && id) await load(id); } catch {} finally { setLoading(false); } })();
  }, []);

  const filtered = useMemo(() => {
    const t = todayISO();
    const wk = (() => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();
    return (orders || []).filter((o) => {
      const d = o.event_date;
      if (range === 'upcoming' && !(d >= t)) return false;
      if (range === 'today' && d !== t) return false;
      if (range === 'week' && !(d >= t && d <= wk)) return false;
      if (range === 'past' && !(d < t)) return false;
      if (paidFilter === 'paid' && !o.paid) return false;
      if (paidFilter === 'unpaid' && o.paid) return false;
      return true;
    }).sort((a, b) => range === 'past' ? String(b.event_date).localeCompare(a.event_date) : String(a.event_date).localeCompare(b.event_date));
  }, [orders, range, paidFilter]);

  // group by event_date
  const groups = useMemo(() => {
    const g = {};
    for (const o of filtered) { (g[o.event_date] = g[o.event_date] || []).push(o); }
    return Object.entries(g);
  }, [filtered]);

  const totalValue = filtered.reduce((s, o) => s + Number(o.total || 0), 0);
  const itemsCount = (o) => (o.items || []).reduce((n, i) => n + (i.qty || 1), 0);

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to see catering orders.</div>;

  return (
    <div>
      <h1 style={S.h1}>Catering orders</h1>
      <div style={S.sub}>Forward view of your catering pre-orders for kitchen planning. Each shows on the live Orders Hub on its event day.</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 16, maxWidth: 620 }}>
        <div style={S.kpi}><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)' }}>{filtered.length}</div><div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 }}>Orders ({range})</div></div>
        <div style={S.kpi}><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)' }}>{money(totalValue, cur)}</div><div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 }}>Total value</div></div>
        <div style={S.kpi}><div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)' }}>{filtered.filter((o) => !o.paid).length}</div><div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 }}>Awaiting payment</div></div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>{RANGES.map(([v, l]) => <button key={v} style={S.seg(range === v)} onClick={() => setRange(v)}>{l}</button>)}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>{[['all', 'All'], ['paid', 'Paid'], ['unpaid', 'Pay later']].map(([v, l]) => <button key={v} style={{ ...S.seg(paidFilter === v), fontSize: 12 }} onClick={() => setPaidFilter(v)}>{l}</button>)}</div>

      {filtered.length === 0 && <div style={S.empty}>No catering orders in this view.</div>}

      {groups.map(([date, list]) => (
        <div key={date}>
          <div style={S.dayHdr}>{fmtDay(date)} <span style={{ ...S.pill }}>{list.length} order{list.length === 1 ? '' : 's'}</span> <span style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 600 }}>· {money(list.reduce((s, o) => s + Number(o.total || 0), 0), cur)}</span></div>
          {list.map((o) => {
            const c = o.customer || {};
            const isOpen = open === o.ref;
            return (
              <div key={o.ref} style={S.card}>
                <div style={S.row} onClick={() => setOpen(isOpen ? null : o.ref)}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--t1)' }}>{o.collection_time || '—'}<div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 600 }}>{o.ref}</div></div>
                  <div style={{ minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'Customer'}</div><div style={{ fontSize: 12, color: 'var(--t3)' }}>{c.fulfilment === 'delivery' ? 'Delivery' : 'Collection'} · {itemsCount(o)} items{c.phone ? ` · ${c.phone}` : ''}</div></div>
                  <div style={{ textAlign: 'right', fontWeight: 800, fontSize: 13.5, color: 'var(--t1)' }}>{money(o.total, cur)}</div>
                  <div style={{ textAlign: 'center' }}><span style={{ ...S.pill, color: o.paid ? 'var(--grn)' : 'var(--amber, #d98a00)', borderColor: o.paid ? 'var(--grn)' : 'var(--amber, #d98a00)' }}>{o.paid ? 'Paid' : 'Pay later'}</span></div>
                  <div style={{ textAlign: 'right' }}><span style={{ ...S.pill }}>{statusLabel(o)}</span></div>
                </div>
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--bdr2)', padding: '12px 14px', background: 'var(--bg2)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12.5, color: 'var(--t2)', marginBottom: 10 }}>
                      <div><b>Contact:</b> {c.name || '—'}{c.email ? ` · ${c.email}` : ''}{c.phone ? ` · ${c.phone}` : ''}</div>
                      <div><b>Fulfilment:</b> {c.fulfilment === 'delivery' ? `Delivery${c.address ? ` — ${c.address.line1}, ${c.address.postcode}` : ''}` : 'Collection'}</div>
                      {c.promo_code && <div><b>Promo:</b> {c.promo_code}{c.promo_discount ? ` (−${money(c.promo_discount, cur)})` : ''}</div>}
                      {c.tax_id && <div><b>Tax/VAT id:</b> {c.tax_id}</div>}
                      {c.notes && <div style={{ gridColumn: '1 / -1' }}><b>Notes:</b> {c.notes}</div>}
                    </div>
                    <div style={{ fontSize: 12.5 }}>
                      {(o.items || []).map((i, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: idx ? '1px solid var(--bdr2)' : 'none', color: 'var(--t1)' }}>
                          <span>{i.qty || 1} × {i.name}{(i.mods || []).length ? ` (${i.mods.map((m) => m.name || m.label).filter(Boolean).join(', ')})` : ''}{i.notes ? ` — ${i.notes}` : ''}</span>
                          <span style={{ fontWeight: 700 }}>{money((Number(i.price || 0) + (i.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (i.qty || 1), cur)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
