// src/backoffice/sections/DeliveriesBoard.jsx
//
// Back Office → Channels → "Deliveries (live)". Staff board of Uber Direct / HubRise-Bridge
// deliveries for the venue: live status, courier, tracking link, ETA, with a cancel action.
// Reads via the uber-direct edge fn (deliveries is service-role-only). 20s poll; status is
// fed live by the uber-webhook (Uber API) or the HubRise order sync (Bridge).

import { useEffect, useState, useCallback } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { listDeliveries, cancelDelivery } from '../../lib/delivery/deliveryConfig';
import { statusLabel, isTerminalStatus } from '../../lib/delivery/status';

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
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!locId) return;
    const r = await listDeliveries(locId, 50);
    if (r?.deliveries) setRows(r.deliveries);
    else if (!rows) setRows([]);
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
  };

  if (!locId) return <div style={S.empty}>Select a location first.</div>;
  if (rows === null) return <div style={S.empty}>Loading…</div>;

  return (
    <div style={S.wrap}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: '0 0 4px' }}>Deliveries (live)</h1>
      <p style={{ fontSize: 13, color: 'var(--t3)', margin: '0 0 16px' }}>Couriers dispatched for delivery orders. Status updates live from Uber / HubRise.</p>
      <div style={S.card}>
        <div style={{ ...S.row, ...S.head }}>
          <div>Order</div><div>Status</div><div>Courier</div><div>ETA</div><div></div>
        </div>
        {rows.length === 0 ? (
          <div style={S.empty}>No deliveries yet.</div>
        ) : rows.map((d) => (
          <div key={d.id} style={S.row}>
            <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{d.order_ref || '—'}</div>
            <div>
              <span style={S.pill(d.status)}>{statusLabel(d.status)}</span>
              {d.tracking_url ? <a style={{ ...S.link, marginLeft: 8, fontSize: 12 }} href={d.tracking_url} target="_blank" rel="noreferrer">Track ↗</a> : null}
            </div>
            <div style={{ color: 'var(--t2)' }}>{d.courier_name || (d.dispatch_backend === 'hubrise_bridge' ? 'via HubRise' : '—')}</div>
            <div style={{ color: 'var(--t3)' }}>{d.eta ? new Date(d.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
            <div style={{ textAlign: 'right' }}>
              {!isTerminalStatus(d.status) && <button style={S.btn} disabled={busy === d.id} onClick={() => onCancel(d.id)}>{busy === d.id ? '…' : 'Cancel'}</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
