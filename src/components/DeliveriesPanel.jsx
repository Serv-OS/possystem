// src/components/DeliveriesPanel.jsx
//
// POS right-panel "Deliveries" tab — a live courier board for front-of-house staff, next to
// History. Lists recent dispatched courier deliveries with live Stuart status (the edge fn polls
// Stuart server-side on each list call), courier name, ETA and a tracking link. Reads via the
// uber-direct edge fn (list_deliveries → requireToken, so the anonymous POS device can call it).

import { useEffect, useState, useCallback } from 'react';
import { getActiveLocationSync } from '../lib/supabase';
import { listDeliveries } from '../lib/delivery/deliveryConfig';

const STATUS = {
  dispatching: ['Finding courier…', '#f59e0b'], pending: ['Finding courier…', '#f59e0b'],
  pickup: ['Heading to venue', '#3b82f6'], dropoff: ['Out for delivery', '#3b82f6'],
  delivered: ['Delivered', '#22c55e'], canceled: ['Canceled', '#888780'],
  returned: ['Returned', '#ef4444'], failed: ['Dispatch failed', '#ef4444'],
};
const fmt = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };

export default function DeliveriesPanel() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const loc = getActiveLocationSync();
    if (!loc) { setRows([]); return; }
    const r = await listDeliveries(loc, 40);
    if (r?.ok) { setRows(r.deliveries || []); setErr(null); }
    else { setErr(r?.error || 'Could not load deliveries'); setRows((p) => p || []); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)' }}>Deliveries (live)</div>
        <button onClick={load} style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--t3)', background: 'transparent', border: '1px solid var(--glass-border)', borderRadius: 8, padding: '4px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>↻ Refresh</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
      {rows == null ? (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: 16, textAlign: 'center' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: 24, textAlign: 'center' }}>No courier deliveries yet.</div>
      ) : rows.map((d) => {
        const [label, color] = STATUS[d.status] || ['—', '#888780'];
        const eta = fmt(d.eta);
        return (
          <div key={d.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--glass-border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{d.order_ref || '—'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>
                {d.courier_name ? `👤 ${d.courier_name}` : 'Courier'}{eta ? ` · ETA ${eta}` : ''}
              </div>
              {d.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--acc)', textDecoration: 'none' }}>Track ↗</a>}
            </div>
            <span style={{ fontSize: 10.5, fontWeight: 800, padding: '3px 9px', borderRadius: 12, background: `${color}22`, color, whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
