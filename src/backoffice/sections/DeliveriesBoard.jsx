// src/backoffice/sections/DeliveriesBoard.jsx
//
// Back Office → Channels → "Deliveries (live)". Staff board of dispatched courier deliveries
// for the venue: live status, courier, tracking link, ETA, with a cancel action.
// Reads via the uber-direct edge fn (deliveries is service-role-only). 20s poll; status is
// fed live by the stuart-webhook (legacy rows: uber-webhook / HubRise order sync).

import { useEffect, useState, useCallback } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { listDeliveries, cancelDelivery, deliveryReport, getDeliveryDetail } from '../../lib/delivery/deliveryConfig';
import { statusLabel, isTerminalStatus } from '../../lib/delivery/status';
import { money } from '../../lib/currency';

const fmtAddr = (a) => !a ? '' : (typeof a === 'string' ? a : [a.line1, a.line2, a.city, a.postcode].filter(Boolean).join(', '));
const fmtTime = (t) => { if (!t) return '—'; const d = new Date(t); return isNaN(d.getTime()) ? String(t) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); };

const S = {
  wrap: { maxWidth: 900 },
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden' },
  row: { display: 'grid', gridTemplateColumns: '90px 1fr 1fr 90px 120px', gap: 10, alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid var(--bdr)', fontSize: 13 },
  head: { fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' },
  pill: (s) => ({ display: 'inline-block', padding: '3px 9px', borderRadius: 99, fontSize: 11, fontWeight: 800,
    background: s === 'delivered' ? '#22c55e22' : s === 'canceled' || s === 'returned' ? '#ef444422' : '#e8a02022',
    color: s === 'delivered' ? '#16a34a' : s === 'canceled' || s === 'returned' ? '#ef4444' : '#b45309' }),
  link: { color: 'var(--acc)', fontWeight: 700, textDecoration: 'none' },
  btn: { padding: '5px 10px', borderRadius: 8, border: '1px solid #ef444455', background: 'transparent', color: '#ef4444', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  empty: { color: 'var(--t3)', fontSize: 14, padding: 28, textAlign: 'center' },
};

export default function DeliveriesBoard() {
  const [locId] = useState(() => getActiveLocationSync());
  const [rows, setRows] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [sel, setSel] = useState(null);        // selected courier_deliveries row
  const [detail, setDetail] = useState(null);  // 'loading' | { order, quote, surcharge, events } | { error:true }

  const load = useCallback(async () => {
    if (!locId) return;
    const [r, rep] = await Promise.all([listDeliveries(locId, 50), deliveryReport(locId)]);
    if (r?.deliveries) setRows(r.deliveries);
    else if (!rows) setRows([]);
    if (rep?.report) setReport(rep.report);
  }, [locId, rows]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const onCancel = async (id) => {
    setBusy(id);
    await cancelDelivery(locId, id);
    await load();
    setBusy(null);
    setSel(null);
  };

  const openDetail = useCallback(async (d) => {
    setSel(d); setDetail('loading');
    const r = await getDeliveryDetail(locId, { id: d.id, orderRef: d.order_ref });
    setDetail(r?.ok ? r : { error: true });
  }, [locId]);

  if (!locId) return <div style={S.empty}>Select a location first.</div>;
  if (rows === null) return <div style={S.empty}>Loading…</div>;

  return (
    <div style={S.wrap}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: '0 0 4px' }}>Deliveries (live)</h1>
      <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 16px' }}>Couriers dispatched for delivery orders. Status updates live from the courier.</p>
      {report && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          {[
            ['Deliveries (30d)', String(report.count)],
            ['Charged to customers', money((report.customerTotalMinor || 0) / 100)],
            ['Actual courier cost', report.actualCostMinor ? money(report.actualCostMinor / 100) : '—'],
            ['Margin', report.actualMarginMinor != null ? money(report.actualMarginMinor / 100) : money((report.quotedMarginMinor || 0) / 100) + ' (est.)'],
          ].map(([k, v]) => (
            <div key={k} style={{ flex: '1 1 150px', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)', marginTop: 4 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div style={S.card}>
        <div style={{ ...S.row, ...S.head }}>
          <div>Order</div><div>Status</div><div>Courier</div><div>ETA</div><div></div>
        </div>
        {rows.length === 0 ? (
          <div style={S.empty}>No deliveries yet.</div>
        ) : rows.map((d) => (
          <div key={d.id} style={{ ...S.row, cursor: 'pointer' }} onClick={() => openDetail(d)}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg3)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
            <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{d.order_ref || '—'}</div>
            <div>
              <span style={S.pill(d.status)}>{statusLabel(d.status)}</span>
              {d.tracking_url ? <a style={{ ...S.link, marginLeft: 8, fontSize: 12 }} href={d.tracking_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Track ↗</a> : null}
            </div>
            <div style={{ color: 'var(--t2)' }}>{d.courier_name || '—'}</div>
            <div style={{ color: 'var(--t3)' }}>{d.eta ? new Date(d.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
            <div style={{ textAlign: 'right' }}>
              {!isTerminalStatus(d.status) && <button style={S.btn} disabled={busy === d.id} onClick={(e) => { e.stopPropagation(); onCancel(d.id); }}>{busy === d.id ? '…' : 'Cancel'}</button>}
            </div>
          </div>
        ))}
      </div>

      {sel && (
        <div onClick={(e) => { if (e.target === e.currentTarget) { setSel(null); setDetail(null); } }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 9999, padding: 16 }}>
          <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '86vh', overflowY: 'auto', padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)', flex: 1 }}>{sel.order_ref || 'Delivery'}</div>
              <span style={S.pill(sel.status)}>{statusLabel(sel.status)}</span>
              <button onClick={() => { setSel(null); setDetail(null); }} style={{ background: 'transparent', border: 0, fontSize: 22, color: 'var(--t3)', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>

            <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6, marginBottom: 12 }}>
              <div><b>Fulfilment:</b> {sel.dispatch_backend === 'stuart' ? 'Stuart courier' : sel.dispatch_backend === 'hubrise_bridge' ? 'Courier (HubRise — legacy)' : 'Courier (API — legacy)'}</div>
              {sel.courier_name && <div><b>Courier:</b> {sel.courier_name}{sel.courier_phone ? ` · ${sel.courier_phone}` : ''}</div>}
              {sel.eta && <div><b>ETA:</b> {fmtTime(sel.eta)}</div>}
              {sel.tracking_url && <div><a style={S.link} href={sel.tracking_url} target="_blank" rel="noreferrer">Track courier ↗</a></div>}
              <div style={{ color: 'var(--t3)' }}>Dispatched {fmtTime(sel.created_at)}</div>
            </div>

            {detail === 'loading' && <div style={{ color: 'var(--t3)', fontSize: 13, padding: '8px 0' }}>Loading order…</div>}
            {detail && detail !== 'loading' && detail.error && <div style={{ color: '#ef4444', fontSize: 13 }}>Couldn't load the order detail.</div>}
            {detail && detail !== 'loading' && !detail.error && (
              <>
                {detail.order?.customer && (
                  <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, borderTop: '1px solid var(--bdr)', paddingTop: 12, marginBottom: 12 }}>
                    {detail.order.customer.name && <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{detail.order.customer.name}</div>}
                    {detail.order.customer.phone && <div>{detail.order.customer.phone}</div>}
                    {detail.order.customer.address && <div>{fmtAddr(detail.order.customer.address)}</div>}
                  </div>
                )}
                {Array.isArray(detail.order?.items) && detail.order.items.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 12, marginBottom: 12 }}>
                    {detail.order.items.map((it, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--t2)', marginBottom: 3 }}>
                        <span><span style={{ color: 'var(--t3)' }}>{it.qty || 1}× </span>{it.name}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 12, marginBottom: 12, fontSize: 13 }}>
                  {detail.order?.total != null && <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t1)', fontWeight: 700 }}><span>Order total</span><span>{money(Number(detail.order.total))}</span></div>}
                  {detail.surcharge && <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t3)', marginTop: 4 }}><span>Delivery charged</span><span>{money((detail.surcharge.customer_fee_minor || 0) / 100)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t3)' }}><span>Your delivery cost</span><span>{money((detail.surcharge.true_cost_minor || 0) / 100)}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t3)' }}><span>Margin</span><span>{money((detail.surcharge.margin_minor || 0) / 100)}</span></div>
                  </>}
                </div>
                {Array.isArray(detail.events) && detail.events.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 12, marginBottom: 12 }}>
                    <div style={{ ...S.head, marginBottom: 8 }}>Status timeline</div>
                    {detail.events.map((ev, i) => (
                      <div key={ev.event_id || i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', marginBottom: 3 }}>
                        <span>{statusLabel(ev.status)}</span>
                        <span>{fmtTime(ev.received_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {!isTerminalStatus(sel.status) && (
              <button style={{ ...S.btn, width: '100%', padding: 11, marginTop: 4 }} disabled={busy === sel.id} onClick={() => onCancel(sel.id)}>{busy === sel.id ? 'Cancelling…' : 'Cancel delivery'}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
