// src/surfaces/bookings/FloorDragLayer.jsx
//
// The floor drag's ghost and its one tap confirm (16 Oct 2026, v5.11.70 host
// tools). Mounted once by FloorScreen. The ghost follows the finger with the
// party's name and the verdict for the table under it: green "free" or red
// with the clash ("T5 is booked for Mia Hart at 19:30"). Letting go over a
// table asks "Move Oliver to T4?" (a booked table) or "Seat Oliver on T4 now?"
// (a waiting party from the Service list, with Move only as the second
// choice). Move goes through editBooking, so the server's table check and the
// venue lock apply exactly as for the Timeline drag; Seat then opens the tab
// through seatBooking, the same door as the Seat now button.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { buildScheduleCtx } from '../../lib/scheduleCtx.js';
import { floorDrop } from '../../../supabase/functions/_shared/bookingHost.js';
import { useFloorDragState, clearFloorDrop } from './floorDrag.js';
import { bookingName } from './bits.jsx';

function verdictFor({ booking, tableId, mode, tables, bookings, tz, bookingsDate }) {
  const table = tables.find((t) => t.id === tableId);
  if (!table) return null;
  const ctx = buildScheduleCtx(tz || undefined);
  const isToday = !bookingsDate || bookingsDate === ctx.ymd;
  const seatMode = mode === 'seat' && isToday;
  return { table, ...floorDrop({ booking, table, others: bookings, nowMin: seatMode ? ctx.nowMinutes : null, mode: seatMode ? 'seat' : 'move' }), seatMode };
}

export default function FloorDragLayer() {
  const { drag, drop } = useFloorDragState();
  const tablesRaw = useStore((s) => s.tables);
  const bookings = useStore((s) => s.bookings) || [];
  const bookingsDate = useStore((s) => s.bookingsDate);
  const tz = useStore((s) => s.locationConfig?.timezone);
  const operator = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const top = useMemo(() => (tablesRaw || []).filter((t) => !t.parentId), [tablesRaw]);
  const live = (drag || drop) ? bookings.find((x) => x.id === (drag || drop).booking.id) || (drag || drop).booking : null;
  const hover = drag && drag.overId ? verdictFor({ booking: live, tableId: drag.overId, mode: drag.mode, tables: top, bookings, tz, bookingsDate }) : null;
  const landing = drop ? verdictFor({ booking: live, tableId: drop.tableId, mode: drop.mode, tables: top, bookings, tz, bookingsDate }) : null;

  // A drop that changes nothing (back on its own table, or off any table) closes by itself.
  useEffect(() => {
    if (!drop) return undefined;
    if (landing && !landing.unchanged) return undefined;
    const t = setTimeout(() => clearFloorDrop(), landing?.unchanged ? 1200 : 0);
    return () => clearTimeout(t);
  }, [drop, landing]);

  const run = async (seat) => {
    if (!drop || !landing?.ok || busy) return;
    setBusy(true); setErr('');
    const st = useStore.getState();
    const moveNeeded = !((live.tables || []).length === 1 && live.tables[0] === landing.table.id);
    if (moveNeeded) {
      const res = await st.editBooking?.(live.id, { tables: [landing.table.id], primaryTableId: landing.table.id }, { editedBy: operator });
      if (!res?.ok) {
        setBusy(false);
        setErr(res?.error || (res?.errors || [])[0] || 'Booking NOT moved. Try again.');
        return;
      }
    }
    if (seat) {
      const res = await useStore.getState().seatBooking?.(live.id);
      if (res && res.ok === false) {
        setBusy(false);
        // Never a raw code on screen.
        const tl = landing.table.label || 'That table';
        const words = {
          table_open: `${tl} still has an open tab on the till.`,
          table_seated_empty: `${tl} is seated with no order yet. Cash it off on the POS, or move this booking.`,
        };
        setErr(res.text || words[res.error] || 'Moved, but the tab did not open. Use Seat now on the booking.');
        return;
      }
    }
    setBusy(false);
    clearFloorDrop();
  };

  const W = 320;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

  return (
    <>
      {drag && live && (
        <div aria-hidden="true" style={{
          position: 'fixed', left: Math.min(vw - 230, drag.x + 16), top: Math.min(vh - 70, drag.y + 16), zIndex: 100004, pointerEvents: 'none',
          minWidth: 160, maxWidth: 260, padding: '8px 11px', borderRadius: 11, boxShadow: '0 10px 28px rgba(0,0,0,.45)',
          background: 'var(--bg1)', border: `2px solid ${hover && !hover.unchanged ? (hover.ok ? 'var(--grn)' : 'var(--red)') : 'var(--acc)'}`, color: 'var(--t1)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{bookingName(live)} · {live.covers} cvr</div>
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, color: hover && !hover.unchanged ? (hover.ok ? 'var(--grn)' : 'var(--red)') : 'var(--t3)' }}>
            {hover?.unchanged ? 'Drag onto another table' : hover ? (hover.ok ? `${hover.table.label || hover.table.id} free${hover.seatMode ? ', seat now' : ''}` : hover.reason) : 'Drag onto a table'}
          </div>
        </div>
      )}
      {drop && live && landing && !landing.unchanged && (
        <div role="dialog" aria-label="Move party" style={{
          position: 'fixed', left: Math.max(8, Math.min(vw - W - 8, (drop.x || 0) - W / 2)), top: Math.max(8, Math.min(vh - 230, (drop.y || 0) + 14)),
          width: W, zIndex: 100004, padding: '12px 14px', borderRadius: 12, background: 'var(--bg1)', color: 'var(--t1)',
          border: `1.5px solid ${landing.ok ? 'var(--acc)' : 'var(--red)'}`, boxShadow: '0 14px 40px rgba(0,0,0,.45)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.35 }}>
            {landing.ok
              ? (landing.seatMode ? `Seat ${bookingName(live)} on ${landing.label} now?` : `Move ${bookingName(live)} to ${landing.label}?`)
              : `${bookingName(live)} cannot go there.`}
          </div>
          {!landing.ok && <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)', fontWeight: 700, lineHeight: 1.4 }}>{landing.reason}</div>}
          {landing.ok && <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t3)' }}>{live.covers} covers · {String(live.startTime || '').slice(0, 5)}{landing.seatMode ? ' · the tab opens on the till' : ', same time'}</div>}
          {err && <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)', fontWeight: 700, lineHeight: 1.4 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {landing.ok ? (
              <>
                <button className="btn btn-ghost" onClick={() => { setErr(''); clearFloorDrop(); }} disabled={busy} style={{ flex: 1, height: 44 }}>Keep</button>
                {landing.seatMode && (
                  <button className="btn btn-ghost" onClick={() => run(false)} disabled={busy} style={{ flex: 1, height: 44, fontWeight: 700 }}>Move only</button>
                )}
                <button className="btn btn-acc" onClick={() => run(landing.seatMode)} disabled={busy} style={{ flex: 1.3, height: 44, fontWeight: 800 }}>
                  {busy ? 'Saving…' : landing.seatMode ? 'Seat now' : 'Move'}
                </button>
              </>
            ) : (
              <button className="btn btn-ghost" onClick={() => { setErr(''); clearFloorDrop(); }} style={{ flex: 1, height: 44, fontWeight: 700 }}>OK</button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
