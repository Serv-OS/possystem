// src/surfaces/bookings/FloorScreen.jsx
//
// Floor — live from POS (README §2). The store's floor plan drawn to scale,
// coloured by what the table is doing RIGHT NOW (POS session / active booking /
// upcoming booking / free), a dashed join outline around multi-table parties,
// and a right panel that seats walk-ins through the same optimiser the Book
// flow uses (next quarter hour, top candidate highlighted on the plan).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { toMin, toHM } from '../../lib/bookings/optimiser.js';
import {
  mono, tintBg, tintBd, rulesOf, displayStatus, useNowMin, money,
  sessionTotal, bookingName, todayISO, isLive,
} from './bits.jsx';

const PAD = 10;

export default function FloorScreen() {
  const tables = useStore((s) => s.tables) || [];
  const bookings = useStore((s) => s.bookings) || [];
  const packages = useStore((s) => s.packages) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const rules = rulesOf(bookingRules);
  const isToday = !bookingsDate || bookingsDate === todayISO();
  const nowMin = useNowMin();
  const statusNow = isToday ? nowMin : null;

  const [walk, setWalk] = useState(2);
  const [seating, setSeating] = useState(false);
  const [msg, setMsg] = useState('');

  const floorTables = useMemo(() => tables.filter((t) => !t.parentId), [tables]);

  // ── scale-to-fit ────────────────────────────────────────────────────────────
  const wrapRef = useRef(null);
  const [wrapSize, setWrapSize] = useState({ w: 900, h: 440 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWrapSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bounds = useMemo(() => {
    let mx = 1, my = 1;
    for (const t of floorTables) { mx = Math.max(mx, (t.x || 0) + (t.w || 60)); my = Math.max(my, (t.y || 0) + (t.h || 60)); }
    return { mx, my };
  }, [floorTables]);
  const scale = Math.max(0.5, Math.min((wrapSize.w - PAD * 2) / bounds.mx, (wrapSize.h - PAD * 2 - 18) / bounds.my));

  // ── what each table is doing right now ──────────────────────────────────────
  const activeNow = useMemo(() => bookings.filter((b) => {
    if (!isLive(b) || !Number.isFinite(statusNow)) return false;
    const s = toMin(b.startTime);
    return statusNow >= s - 15 && statusNow < s + (b.turnMinutes || 90);
  }), [bookings, statusNow]);

  const nextFor = (tableId) => bookings
    .filter((b) => isLive(b) && b.status === 'confirmed' && (b.tables || []).includes(tableId)
      && (!Number.isFinite(statusNow) || toMin(b.startTime) > statusNow))
    .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0] || null;

  // ── walk-in suggestion at the next quarter hour ─────────────────────────────
  const nextQ = toHM(Math.ceil((nowMin + 1) / 15) * 15);
  const suggest = useStore((s) => s.suggestBookingTables);
  const sug = useMemo(() => {
    if (!suggest) return null;
    return (suggest({ party: walk, time: nextQ, limit: 1 }) || [])[0] || null;
  }, [suggest, walk, nextQ, bookings, tables, bookingRules]);
  const sugSet = new Set(sug?.set || []);

  const seatWalkIn = async () => {
    if (!sug || seating) return;
    setSeating(true); setMsg('');
    const { createBooking, updateBooking } = useStore.getState();
    const res = createBooking ? await createBooking({
      covers: walk, time: nextQ, tables: sug.set, primaryTableId: sug.set[0],
      source: 'walk_in', status: 'dining', customer: null,
    }) : { ok: false, error: 'Bookings store not wired' };
    if (res.ok) { await updateBooking?.(res.booking.id, { seatedAt: Date.now() }); setMsg(`Seated on ${sug.label}`); }
    else setMsg(res.error || 'Could not seat the party');
    setSeating(false);
  };

  const openTabs = floorTables.filter((t) => t.session);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {/* ── canvas ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>Floor — live from POS</span>
          <span style={{ flex: 1 }} />
          <Legend col="var(--grn)" label="Free" />
          <Legend col="var(--acc)" label="Dining" />
          <Legend col="var(--uv)" label="Booked" />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)' }}>
            <span style={{ width: 14, height: 8, border: `1.5px dashed ${tintBd('var(--acc)', 55)}`, borderRadius: 3 }} /> Joined
          </span>
        </div>
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: PAD, overflow: 'hidden' }}>
          {floorTables.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--t3)', fontSize: 13 }}>
              No floor plan yet — build one in Back Office → Floor plan.
            </div>
          )}
          {/* join outlines for active multi-table bookings */}
          {activeNow.filter((b) => (b.tables || []).length > 1).map((b) => {
            const members = (b.tables || []).map((id) => floorTables.find((t) => t.id === id)).filter(Boolean);
            if (members.length < 2) return null;
            const x1 = Math.min(...members.map((t) => t.x || 0)) * scale;
            const y1 = Math.min(...members.map((t) => t.y || 0)) * scale;
            const x2 = Math.max(...members.map((t) => (t.x || 0) + (t.w || 60))) * scale;
            const y2 = Math.max(...members.map((t) => (t.y || 0) + (t.h || 60))) * scale;
            return (
              <div key={`join-${b.id}`} style={{
                position: 'absolute', pointerEvents: 'none', borderRadius: 16,
                left: PAD + x1 - 7, top: PAD + y1 - 7, width: x2 - x1 + 14, height: y2 - y1 + 14,
                border: `1.5px dashed ${tintBd('var(--acc)', 55)}`,
              }} />
            );
          })}
          {floorTables.map((t) => {
            const active = activeNow.find((b) => (b.tables || []).includes(t.id));
            const st = active ? displayStatus(active, statusNow, packages) : null;
            const next = !active && !t.session ? nextFor(t.id) : null;
            const col = active
              ? (st === 'late' ? 'var(--red)' : st === 'due' ? 'var(--orn)' : 'var(--acc)')
              : t.session ? 'var(--acc)'
              : next ? 'var(--uv)'
              : 'var(--grn)';
            const hot = sugSet.has(t.id);
            const line2 = active ? bookingName(active)
              : t.session ? (t.session.server || 'Open tab')
              : next ? String(next.startTime || '').slice(0, 5)
              : 'free';
            const line3 = active ? `${active.covers} cvr · ${String(active.startTime || '').slice(0, 5)}`
              : t.session ? `${t.session.covers || '—'} cvr`
              : next ? bookingName(next)
              : `${t.maxCovers || 0} seats`;
            return (
              <div key={t.id} style={{
                position: 'absolute',
                left: PAD + (t.x || 0) * scale, top: PAD + (t.y || 0) * scale,
                width: (t.w || 60) * scale, height: (t.h || 60) * scale,
                borderRadius: t.shape === 'rd' ? '50%' : 12,
                border: `2px solid ${hot ? 'var(--acc)' : tintBd(col, 45)}`,
                background: hot ? tintBg('var(--acc)', 18) : tintBg(col),
                boxShadow: hot ? `0 0 0 4px ${tintBg('var(--acc)', 15)}` : 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', textAlign: 'center', transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: col, lineHeight: 1.1 }}>{t.label || t.id}</div>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--t2)', maxWidth: '92%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line2}</div>
                <div style={{ fontSize: 9, color: 'var(--t3)', maxWidth: '92%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...mono }}>{line3}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── right panel ── */}
      <div style={{ width: 330, flexShrink: 0, background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', overflowY: 'auto', padding: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }}>Seat a walk-in</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} onClick={() => setWalk(n)} style={{
              width: 36, height: 34, borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, ...mono,
              background: walk === n ? tintBg('var(--acc)') : 'var(--inset, var(--bg3))',
              border: `1.5px solid ${walk === n ? tintBd('var(--acc)') : 'var(--bdr)'}`,
              color: walk === n ? 'var(--acc)' : 'var(--t2)',
              transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
            }}>{n}</button>
          ))}
        </div>

        {sug ? (
          <div style={{ background: tintBg('var(--acc)'), border: `1px solid ${tintBd('var(--acc)')}`, borderRadius: 13, padding: '14px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--acc)', letterSpacing: '-0.02em' }}>{sug.label}</div>
            <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 2, ...mono }}>seats {sug.cap} · party of {walk} · {nextQ}</div>
            {sug.reasons?.[0] && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.45 }}>{sug.reasons[0]}</div>}
            <button className="btn btn-acc" onClick={seatWalkIn} disabled={seating} style={{ width: '100%', height: 38, marginTop: 12, fontWeight: 800 }}>
              {seating ? 'Seating…' : 'Seat walk-in'}
            </button>
          </div>
        ) : (
          <div style={{ padding: '14px 14px', borderRadius: 13, border: '1px dashed var(--bdr2)', color: 'var(--t3)', fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
            {(rules.joinGroups || []).length === 0
              ? 'No join groups authored yet — author join groups in Back Office → Floor plan to get suggestions here.'
              : `No table fits a party of ${walk} at ${nextQ} — check the diary for the next free window.`}
          </div>
        )}
        {msg && <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 12, ...mono }}>{msg}</div>}

        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '6px 0 9px' }}>Open tabs on POS</div>
        {openTabs.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)' }}>No open tabs right now.</div>}
        {openTabs.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--bg2)', marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t.label || t.id}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{t.session?.covers || '—'} covers{t.session?.server ? ` · ${t.session.server}` : ''}</div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--acc)', ...mono }}>{money(sessionTotal(t.session), 2)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Legend = ({ col, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)' }}>
    <span style={{ width: 8, height: 8, borderRadius: 999, background: col }} /> {label}
  </span>
);
