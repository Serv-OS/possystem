// src/components/DeliveriesPanel.jsx
//
// POS right-panel "Deliveries" tab — a live courier board for front-of-house, next to History.
// Each row: status + the expected→actual time flow (pickup + delivery) + a lateness badge + a
// left accent bar. Tap a row to reveal a scannable QR for the live map (the Sunmi WebView swallows
// links). Live orders sort to the top, completed/canceled fall to the bottom. Status is polled
// server-side (list_deliveries → requireToken, so the anon POS can read it); 20s refresh.

import { useEffect, useState, useCallback } from 'react';
import { getActiveLocationSync } from '../lib/supabase';
import { listDeliveries } from '../lib/delivery/deliveryConfig';
import { statusLabel, statusColor, statusIcon } from '../lib/delivery/status';
import { courierPhase, courierLegs, courierLateness } from '../lib/delivery/courierTimes';
import CourierTrackingQR from './CourierTrackingQR';

const TERMINAL = new Set(['delivered', 'canceled', 'returned', 'failed']);
const legBit = (leg) => leg.kind === 'actual' ? `✓${leg.time}` : leg.kind === 'expected' ? `~${leg.time}` : '–';

export default function DeliveriesPanel() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

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

  // Live (in-flight) first, terminal last; newest first within each group.
  const sorted = (rows || []).slice().sort((a, b) => {
    const at = TERMINAL.has(a.status) ? 1 : 0, bt = TERMINAL.has(b.status) ? 1 : 0;
    if (at !== bt) return at - bt;
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)' }}>Deliveries (live)</div>
        <button onClick={load} style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--t3)', background: 'transparent', border: '1px solid var(--glass-border, var(--bdr))', borderRadius: 8, padding: '4px 9px', cursor: 'pointer', fontFamily: 'inherit' }}>↻ Refresh</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
      {rows == null ? (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: 16, textAlign: 'center' }}>Loading…</div>
      ) : sorted.length === 0 ? (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: 24, textAlign: 'center' }}>No courier deliveries yet.</div>
      ) : sorted.map((d) => {
        const color = statusColor(d.status);
        const phase = courierPhase(d);
        const legs = courierLegs(d);
        const late = courierLateness(d);
        const terminal = TERMINAL.has(d.status);
        const showLate = late.known && !late.onTime && phase !== 'done';
        const open = openId === d.id;
        return (
          <div key={d.id} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--glass-border, var(--bdr))', opacity: terminal && phase !== 'done' ? 0.72 : 1 }}>
            <div style={{ width: 3, borderRadius: 2, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => d.tracking_url && setOpenId(open ? null : d.id)}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{d.order_ref || '—'}</span>
                {d.tracking_url && <span style={{ fontSize: 11, color: 'var(--acc)' }}>{open ? '▲ map' : '▦ map'}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 12, background: `${color}22`, color, whiteSpace: 'nowrap' }}>{statusIcon(d.status)} {statusLabel(d.status)}</span>
              </div>
              {phase === 'awaiting_courier' ? (
                <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 3 }}>Finding a courier…{d.courier_name ? ` · ${d.courier_name}` : ''}</div>
              ) : !terminal || phase === 'done' ? (
                <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span>Pick {legBit(legs.pickup)}</span>
                  <span>· Drop {legBit(legs.dropoff)}</span>
                  {d.courier_name && <span>· {d.courier_name}</span>}
                  {showLate && <span style={{ color: '#ef4444', fontWeight: 700 }}>· {late.lateMins}m late</span>}
                </div>
              ) : null}
              {open && d.tracking_url && (
                <CourierTrackingQR trackingUrl={d.tracking_url} courierName={d.courier_name} courierPhone={d.courier_phone} muted="var(--t3)" fg="var(--t1)" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
