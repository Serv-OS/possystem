// src/surfaces/bookings/DiaryScreen.jsx
//
// The service diary — README §1. A row per table, a column per 15 minutes
// across the service window, absolutely-positioned booking blocks (row-spanning
// for joined tables), the now-line, a computed KPI strip on top and a 330px
// inspector on the right. Clicking a block selects it (3px accent ring) and
// populates the inspector. All reads come from the store; writes go through
// updateBooking / cancelBooking (seatBooking when the store grows one).
//
// The timeline is FLUID: a ResizeObserver (same pattern as FloorScreen)
// measures the scroll container and the slot width is derived so the grid
// fills 100% of the available width — floored at MIN_SLOT_W with overflow-x
// as the narrow-screen fallback. Every x-coordinate (header cells, background
// gradients, block left/width, now-line) derives from that one slotW.
//
// A [Timeline | List] toggle (persisted in localStorage — a UI preference,
// not data) adds a time-sorted list view; rows drive the same `sel` state so
// the inspector works identically from either view.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { supabase, isMock } from '../../lib/supabase';
import { toMin, toHM, isTableFree, toOptimiserBooking, sessionsToBlocks } from '../../lib/bookings/optimiser.js';
import { loadBookingPayments, lookupPreorderLinkBase } from '../../lib/bookings/bookingsData.js';
import {
  mono, tintBg, tintBd, rulesOf, displayStatus, statusMeta, StatusBadge, isLive,
  useNowMin, money, initialsOf, bookingName, todayISO, EmptyNote, Chip, preorderStateFor, courseColor,
} from './bits.jsx';

// Nothing created AT THE STAND can hold a card: BookScreen's payment buttons are
// display only, and createBooking stores no payment fields. So for these sources
// an empty ledger means "no card", not "cannot see it from here".
const CARD_IMPOSSIBLE_SOURCES = new Set(['walk_in', 'host']);

const MIN_SLOT_W = 24;   // narrowest a 15-min column may go before overflow-x kicks in
const GUTTER = 104;      // row-label column (border-box, divider included)
const WRAP_CHROME = 30;  // scroll-container padding (14×2) + timeline card border (1×2)
const ROW_H = 44;
const VIEW_KEY = 'rpos-bookings-diary-view';

const sortTables = (tables) =>
  (tables || [])
    .filter((t) => !t.parentId)
    .slice()
    .sort((a, b) =>
      String(a.section || '').localeCompare(String(b.section || '')) ||
      String(a.label || a.id).localeCompare(String(b.label || b.id), undefined, { numeric: true }));

export default function DiaryScreen({ sel, onSelect, onBook }) {
  const bookings = useStore((s) => s.bookings) || [];
  const tables = useStore((s) => s.tables) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const packages = useStore((s) => s.packages) || [];
  const bookingsDate = useStore((s) => s.bookingsDate);
  const setBookingsDate = useStore((s) => s.setBookingsDate);

  const rules = rulesOf(bookingRules);
  const isToday = !bookingsDate || bookingsDate === todayISO();
  const tick = useNowMin();
  const nowMin = isToday ? tick : null;

  const rows = useMemo(() => sortTables(tables), [tables]);
  const rowIndex = useMemo(() => new Map(rows.map((t, i) => [t.id, i])), [rows]);
  const startMin = toMin(rules.serviceStart);
  const endMin = toMin(rules.serviceEnd);
  const slots = Math.max(1, Math.round((endMin - startMin) / 15));

  // ── fluid slot width (FloorScreen's ResizeObserver pattern) ─────────────────
  // The screen stays mounted behind display:none panes, where clientWidth reads
  // 0 — ignore those so switching screens never collapses the grid.
  const wrapRef = useRef(null);
  const [wrapW, setWrapW] = useState(920);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (el.clientWidth > 0) setWrapW(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const slotW = Math.max(MIN_SLOT_W, Math.floor((wrapW - WRAP_CHROME - GUTTER) / slots));
  const gridW = slots * slotW;
  const gridH = rows.length * ROW_H;

  // ── timeline | list (persisted UI preference) ───────────────────────────────
  const [view, setViewState] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'timeline'; } catch { return 'timeline'; }
  });
  const setView = (v) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode — session-only */ }
  };

  const visible = useMemo(() => bookings.filter((b) => b.status !== 'cancelled'), [bookings]);
  const listRows = useMemo(
    () => visible.slice().sort((a, b) => toMin(a.startTime) - toMin(b.startTime) || bookingName(a).localeCompare(bookingName(b))),
    [visible]);
  const optBookings = useMemo(() => {
    const base = visible.map(toOptimiserBooking).filter(Boolean);
    // Open POS tabs block their tables like dining bookings — today only.
    if (!isToday) return base;
    return [...base, ...sessionsToBlocks(tables, visible, rules.turnBands, Number.isFinite(nowMin) ? nowMin : 0)];
  }, [visible, tables, isToday, nowMin, rules.turnBands]);

  // ── KPI strip (all computed, never static) ──────────────────────────────────
  const kpi = useMemo(() => {
    const alive = bookings.filter(isLive); // isLive, not isDead: a DEPARTED party is finished
    const coversBooked = alive.reduce((s, b) => s + (b.covers || 0), 0);
    const seated = bookings.filter((b) => b.status === 'dining').reduce((s, b) => s + (b.covers || 0), 0);
    const capacity = rows.reduce((s, t) => s + (t.maxCovers || 0), 0);
    const from = Number.isFinite(nowMin) ? nowMin : startMin;
    const freeNextHour = rows.filter((t) => isTableFree(t.id, from, from + 60, optBookings)).length;
    const atRisk = bookings.filter((b) => ['late', 'due'].includes(displayStatus(b, nowMin, packages))).length;
    let held = 0, prepaid = 0;
    for (const b of alive) {
      const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
      if (pkg?.paymentModel === 'prepay') {
        prepaid += String(pkg.priceUnit || '').includes('cover') ? (pkg.price || 0) * (b.covers || 0) : (pkg.price || 0);
      } else if (b.status === 'confirmed' && !CARD_IMPOSSIBLE_SOURCES.has(b.source || 'host')) {
        // Only an ONLINE booking can carry a card, and even then this is what the
        // rules would ask for, not what the ledger holds. Labelled as expected.
        held += (rules.holdPerCover || 0) * (b.covers || 0);
      }
    }
    return { coversBooked, seated, capacity, freeNextHour, atRisk, held, prepaid };
  }, [bookings, rows, optBookings, nowMin, startMin, packages, rules.holdPerCover]);

  const selected = bookings.find((b) => b.id === sel) || null;

  const shiftDay = (delta) => {
    const base = bookingsDate || todayISO();
    const d = new Date(`${base}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setBookingsDate?.(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', background: 'var(--bg1)', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <Kpi label="Covers booked" value={kpi.coversBooked} sub="today" />
          <Kpi label="Seated now" value={`${kpi.seated} / ${kpi.capacity}`} sub="covers / capacity" />
          <Kpi label="Free tables" value={kpi.freeNextHour} sub="next hour" />
          <Kpi label="At risk" value={kpi.atRisk} sub="late + due" col={kpi.atRisk > 0 ? 'var(--red)' : undefined} />
          <Kpi label="Holds expected" value={money(kpi.held)} sub="online bookings" />
          <Kpi label="Prepaid" value={money(kpi.prepaid)} sub="packages" col="var(--grn)" last />
        </div>

        {/* day switcher + view toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 0', flexShrink: 0 }}>
          <button className="btn btn-ghost btn-xs" onClick={() => shiftDay(-1)} style={{ ...mono }}>‹</button>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', ...mono }}>{bookingsDate || todayISO()}{isToday ? ' · today' : ''}</span>
          <button className="btn btn-ghost btn-xs" onClick={() => shiftDay(1)} style={{ ...mono }}>›</button>
          <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
            <Chip active={view === 'timeline'} onClick={() => setView('timeline')} style={viewChip}>Timeline</Chip>
            <Chip active={view === 'list'} onClick={() => setView('list')} style={viewChip}>List</Chip>
          </div>
        </div>

        {/* timeline / list — one measured scroll container for both views */}
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
          {visible.length === 0 && (
            <div style={{ marginBottom: 14 }}>
              <EmptyNote title="No bookings yet today" sub="Take the first one from the Book tab." />
            </div>
          )}
          {view === 'list' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {listRows.map((b) => {
                const st = displayStatus(b, nowMin, packages);
                const dead = st === 'no_show';
                const isSel = b.id === sel;
                const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
                const labels = (b.tables || []).map((id) => rows.find((t) => t.id === id)?.label || String(id).slice(-4)).join(' + ');
                return (
                  <button
                    key={b.id}
                    onClick={() => onSelect(isSel ? null : b.id)}
                    style={{
                      display: 'grid', alignItems: 'center', columnGap: 14, width: '100%', padding: '11px 16px',
                      gridTemplateColumns: '58px minmax(150px, 1fr) 62px 100px 104px 64px minmax(220px, 340px) 20px',
                      borderRadius: 11, textAlign: 'left', cursor: 'pointer',
                      background: 'var(--bg1)', opacity: dead ? 0.65 : 1,
                      border: `1.5px solid ${isSel ? 'var(--acc)' : 'var(--bdr)'}`,
                      boxShadow: isSel ? `0 0 0 3px ${tintBg('var(--acc)')}` : 'none',
                      transition: 'box-shadow 140ms cubic-bezier(.2,.8,.3,1)',
                    }}
                  >
                    <span style={{ fontSize: 14.5, fontWeight: 800, color: dead ? 'var(--t4)' : 'var(--t1)', ...mono }}>
                      {String(b.startTime || '').slice(0, 5)}
                    </span>
                    <span style={{ minWidth: 0, fontSize: 14, fontWeight: 700, color: dead ? 'var(--t4)' : 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {bookingName(b)}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--t3)', ...mono }}>{b.covers} cvr</span>
                    <span style={{ fontSize: 14.5, fontWeight: 800, color: dead ? 'var(--t4)' : 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...mono }}>
                      {labels || '—'}
                    </span>
                    <StatusBadge st={st} />
                    <span style={{ fontSize: 11, color: 'var(--t4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {b.source || 'host'}
                    </span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, overflow: 'hidden' }} title={pkg ? pkg.name : undefined}>
                      {pkg && (
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: tintBg('var(--grn)'), border: `1px solid ${tintBd('var(--grn)')}`, color: 'var(--grn)', whiteSpace: 'nowrap' }}>
                          {pkg.name}
                        </span>
                      )}
                      {(() => {
                        const po = preorderStateFor(b, packages);
                        if (!po || po.state === 'complete') return null;
                        return (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: tintBg('var(--orn)'), border: `1px solid ${tintBd('var(--orn)')}`, color: 'var(--orn)', whiteSpace: 'nowrap' }}>
                            pre-orders {po.have}/{po.needed}
                          </span>
                        );
                      })()}
                    </span>
                    <span style={{ textAlign: 'center', fontSize: 12, color: 'var(--orn)' }} title={b.note || undefined}>
                      {b.note ? '✎' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', width: 'fit-content', overflow: 'hidden' }}>
            {/* header row */}
            <div style={{ display: 'flex' }}>
              <div style={{ width: GUTTER, flexShrink: 0, borderRight: '1px solid var(--bdr)', background: 'var(--bg2)' }} />
              <div style={{ display: 'flex', height: 26, background: 'var(--bg2)' }}>
                {Array.from({ length: slots }, (_, i) => {
                  const m = startMin + i * 15;
                  return (
                    <div key={i} style={{
                      width: slotW, flexShrink: 0, display: 'grid', placeItems: 'center',
                      borderLeft: m % 60 === 0 ? '1px solid var(--bdr2)' : `1px solid ${tintBg('var(--t1)', 3)}`,
                      fontSize: 10, fontWeight: 700, color: 'var(--t4)', ...mono,
                    }}>{m % 30 === 0 ? toHM(m) : ''}</div>
                  );
                })}
              </div>
            </div>
            {/* body */}
            <div style={{ display: 'flex' }}>
              {/* row labels */}
              <div style={{ width: GUTTER, flexShrink: 0, borderRight: '1px solid var(--bdr)' }}>
                {rows.map((t, i) => (
                  <div key={t.id} style={{
                    height: ROW_H, padding: '6px 10px', boxSizing: 'border-box',
                    background: i % 2 ? tintBg('var(--t1)', 2) : 'transparent',
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>{t.label || t.id}</div>
                    <div style={{ fontSize: 10, color: 'var(--t4)', ...mono }}>{t.maxCovers || 0} covers</div>
                  </div>
                ))}
              </div>
              {/* grid */}
              <div style={{
                position: 'relative', width: gridW, height: gridH, flexShrink: 0,
                background: [
                  `repeating-linear-gradient(to right, var(--bdr2) 0 1px, transparent 1px ${slotW * 4}px)`,
                  `repeating-linear-gradient(to right, ${tintBg('var(--t1)', 3)} 0 1px, transparent 1px ${slotW}px)`,
                  `repeating-linear-gradient(to bottom, transparent 0 ${ROW_H}px, ${tintBg('var(--t1)', 2)} ${ROW_H}px ${ROW_H * 2}px)`,
                ].join(', '),
              }}>
                {visible.map((b) => {
                  const st = displayStatus(b, nowMin, packages);
                  const meta = statusMeta(st);
                  const idxs = (b.tables || []).map((id) => rowIndex.get(id)).filter((i) => i != null);
                  if (!idxs.length) return null;
                  const first = Math.min(...idxs), last = Math.max(...idxs);
                  const bs = toMin(b.startTime);
                  const left = ((bs - startMin) / 15) * slotW;
                  const width = ((b.turnMinutes || 90) / 15) * slotW - 3;
                  if (left + width < 0 || left > gridW) return null;
                  const isSel = b.id === sel;
                  const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
                  return (
                    <button
                      key={b.id}
                      onClick={() => onSelect(isSel ? null : b.id)}
                      style={{
                        position: 'absolute', left: Math.max(0, left), width: Math.min(width, gridW - Math.max(0, left)),
                        top: first * ROW_H + 3, height: (last - first + 1) * ROW_H - 6,
                        borderRadius: 9, padding: '5px 8px', textAlign: 'left', overflow: 'hidden', cursor: 'pointer',
                        background: tintBg(meta.col), color: meta.col,
                        border: `1.5px solid ${isSel ? meta.col : tintBd(meta.col)}`,
                        boxShadow: isSel ? `0 0 0 3px ${tintBg('var(--acc)')}` : 'none',
                        transition: 'box-shadow 140ms cubic-bezier(.2,.8,.3,1)',
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bookingName(b)}</div>
                      <div style={{ fontSize: 10, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...mono }}>
                        {/* v5.7.23 - the table's NAME, never its raw id (t-1783614852190
                            told the operator nothing). Fallback: the id's last 4 chars. */}
                        {b.covers} cvr · {String(b.startTime || '').slice(0, 5)} · {(b.tables || []).map((id) => rows.find((t) => t.id === id)?.label || String(id).slice(-4)).join('+')}
                      </div>
                      {pkg && <div style={{ fontSize: 9, color: 'var(--grn)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pkg.name}</div>}
                    </button>
                  );
                })}
                {/* now line */}
                {Number.isFinite(nowMin) && nowMin >= startMin && nowMin <= endMin && (
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0, width: 2, pointerEvents: 'none',
                    left: ((nowMin - startMin) / 15) * slotW,
                    background: 'var(--acc)', boxShadow: '0 0 10px var(--acc-b)',
                  }} />
                )}
              </div>
            </div>
          </div>
          )}
        </div>
      </div>

      {/* inspector */}
      <div style={{ width: 330, flexShrink: 0, background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', overflowY: 'auto' }}>
        {selected
          ? <Inspector b={selected} nowMin={nowMin} packages={packages} tables={rows} onClose={() => onSelect(null)} />
          : (
            <div style={{ padding: 18, color: 'var(--t3)', fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t2)', marginBottom: 8 }}>Nothing selected</div>
              Tap a booking block to see the guest, payment and POS handover here.
              <button className="btn btn-ghost" onClick={onBook} style={{ marginTop: 16, width: '100%', height: 40 }}>Take a booking</button>
            </div>
          )}
      </div>
    </div>
  );
}

const viewChip = { height: 30, minWidth: 0, padding: '0 12px', fontSize: 11, borderRadius: 9 };

function Kpi({ label, value, sub, col, last }) {
  return (
    <div style={{ padding: '10px 14px', borderRight: last ? 'none' : `1px solid ${tintBg('var(--t1)', 7)}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: col || 'var(--t1)', marginTop: 2, ...mono }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--t4)' }}>{sub}</div>
    </div>
  );
}

// Live money state from the booking_payments ledger. From migration 20260824
// paired host stands read it too (the "paired device read" policy), so this is
// the same truth in both places. A stand on a pre-migration DB still gets []
// and falls back to neutral copy — an empty read is "not visible here", never
// "unpaid".
function useBookingPayments(bookingId) {
  const [state, setState] = useState({ id: null, rows: null });
  useEffect(() => {
    let alive = true;
    loadBookingPayments(bookingId).then((rows) => { if (alive) setState({ id: bookingId, rows }); });
    return () => { alive = false; };
  }, [bookingId]);
  return state.id === bookingId ? state.rows : null; // null = not read yet
}

function PaymentState({ b, prepaid, rows }) {
  let line = null;
  if (rows && rows.length) {
    const captured = rows.find((r) => r.status === 'captured' && r.kind !== 'refund');
    const held = rows.find((r) => r.status === 'authorised' && r.kind === 'hold');
    const refunded = rows.find((r) => r.status === 'refunded' || r.kind === 'refund');
    const failed = rows.find((r) => r.status === 'failed');
    const card = (r) => (r?.card_brand || r?.card_last4) ? ` (${[r.card_brand, r.card_last4 ? `···${r.card_last4}` : null].filter(Boolean).join(' ')})` : '';
    if (refunded) line = { txt: `Refund on file${card(refunded)}`, col: 'var(--orn)' };
    else if (captured) {
      const kind = captured.kind === 'prepay' ? 'prepaid' : captured.kind === 'deposit' ? 'deposit paid' : 'paid';
      const applied = captured.applied_to_check
        ? ' · applied to the check' : ' · comes off the bill at close';
      // 2dp: money() defaults to whole pounds, which would print a real £48.50
      // capture as £49. Never round a figure that was actually charged.
      line = { txt: `✓ ${money(captured.amount, 2)} ${kind} by card${card(captured)}${applied}`, col: 'var(--grn)' };
    }
    else if (held) line = { txt: `✓ Card held${card(held)} — charged only on no-show`, col: 'var(--grn)' };
    else if (failed) line = { txt: 'Card payment FAILED — take payment at the venue', col: 'var(--red)' };
    else line = { txt: 'Card payment pending — confirmation arrives automatically', col: 'var(--t3)' };
  } else if (b.status === 'pending_payment') {
    line = { txt: 'Awaiting card payment. The guest has 20 minutes to pay before the booking expires and the table frees itself.', col: 'var(--orn)' };
  } else if (b.status === 'expired') {
    line = { txt: 'Expired unpaid. The table was freed automatically, the guest must rebook.', col: 'var(--t4)' };
  } else if (prepaid) {
    line = { txt: 'No captured payment visible for this prepay booking yet. Check Back Office before treating it as paid.', col: 'var(--orn)' };
  } else if (CARD_IMPOSSIBLE_SOURCES.has(b.source || 'host')) {
    line = { txt: 'Taken at the venue, so no card is on file. Payment happens on the POS tab.', col: 'var(--t4)' };
  } else if (rows) {
    line = { txt: 'No card on file for this booking.', col: 'var(--t4)' };
  } else {
    line = { txt: 'Checking for a card on file…', col: 'var(--t4)' };
  }
  return <div style={{ fontSize: 10.5, marginTop: 5, lineHeight: 1.45, color: line.col }}>{line.txt}</div>;
}

// ── Send / Copy the guest's pre-order link (v5.7.21, link-first) ─────────────
// Send → booking-reminders {action:'send_link'} (mints the token if missing)
// and the toast tells the HONEST per-channel outcome — every skip has its
// reason. Copy builds the same link locally from the booking's minted token +
// the venue slug; no messages fire.
const SEND_REASONS = {
  no_email_on_booking: 'no email on the booking',
  no_phone_on_booking: 'no phone on the booking',
  throttled_sent_under_60s_ago: 'already sent under a minute ago',
  email_provider_unreachable: 'email service unreachable',
  'send-sms_unreachable': 'SMS service unreachable',
};
const prettyReason = (r) => SEND_REASONS[r]
  || (String(r || '').startsWith('email_provider_not_configured') ? 'email sending not set up'
    : String(r || '').replace(/_/g, ' ') || 'unknown reason');

function PreorderLinkActions({ b }) {
  const showToast = useStore((s) => s.showToast);
  const [sending, setSending] = useState(false);
  // Cache: the send response's link (authoritative), else built from token+slug.
  const linkRef = useRef({ forId: null, link: null });

  const sendLink = async () => {
    if (sending) return;
    if (isMock || !supabase) { showToast?.('Not connected, cannot send the link here.', 'error'); return; }
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('booking-reminders', {
        body: { action: 'send_link', booking_id: b.id },
      });
      if (error || !data) { showToast?.(`Link NOT sent: ${error?.message || 'no reply'}`, 'error'); return; }
      if (data.link) linkRef.current = { forId: b.id, link: data.link };
      if (!data.ok) {
        showToast?.(`Link NOT sent: ${prettyReason(data.reason || data.error)}`, 'error');
        return;
      }
      const part = (ch, r) => (r?.sent ? `${ch} sent` : `${ch} not sent (${prettyReason(r?.reason)})`);
      const both = data.email?.sent && data.sms?.sent;
      showToast?.(
        `Pre-order link: ${part('email', data.email)} · ${part('SMS', data.sms)}`,
        both ? 'success' : (data.email?.sent || data.sms?.sent) ? 'info' : 'error',
      );
    } finally { setSending(false); }
  };

  const copyLink = async () => {
    let link = linkRef.current.forId === b.id ? linkRef.current.link : null;
    if (!link) {
      if (!b.preorderToken) {
        showToast?.('No link minted yet. Press Send pre-order link first.', 'error');
        return;
      }
      const base = await lookupPreorderLinkBase(b.locationId);
      if (!base) {
        showToast?.('No venue slug set (Back Office → Location settings), cannot build the link.', 'error');
        return;
      }
      link = `${base}/book?preorder=${b.preorderToken}`;
      linkRef.current = { forId: b.id, link };
    }
    try {
      await navigator.clipboard.writeText(link);
      showToast?.('Pre-order link copied.', 'success');
    } catch {
      showToast?.(`Could not copy. The link is ${link}`, 'info');
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button className="btn btn-ghost" onClick={sendLink} disabled={sending}
        style={{ flex: 1, height: 34, fontSize: 11.5, fontWeight: 700 }}>
        {sending ? 'Sending…' : 'Send pre-order link'}
      </button>
      <button className="btn btn-ghost" onClick={copyLink}
        style={{ flex: 1, height: 34, fontSize: 11.5, fontWeight: 700 }}>
        Copy link
      </button>
    </div>
  );
}

// `rules` was dropped from the props in v5.7.48: the only thing it fed was the
// invented card hold, and money now comes from the booking_payments ledger.
export function Inspector({ b, nowMin, packages, tables, onClose }) {
  const updateBooking = useStore((s) => s.updateBooking);
  const cancelBooking = useStore((s) => s.cancelBooking);
  const [moving, setMoving] = useState(false);
  // Render-adjustment (not an effect — the repo lint forbids sync setState in
  // effects): selecting a different booking closes the move panel.
  const [movingFor, setMovingFor] = useState(b.id);
  if (movingFor !== b.id) { setMovingFor(b.id); setMoving(false); }
  const st = displayStatus(b, nowMin, packages);
  const start = toMin(b.startTime);
  const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
  const labels = (b.tables || []).map((id) => tables.find((t) => t.id === id)?.label || String(id).slice(-4));
  const section = tables.find((t) => t.id === (b.tables || [])[0])?.section;
  const sec = { padding: '14px 18px', borderBottom: '1px solid var(--bdr)' };
  const cardStyle = { background: 'var(--bg3)', borderRadius: 10, padding: '8px 10px', flex: 1 };
  const prepaid = pkg?.paymentModel === 'prepay';
  // MONEY COMES FROM THE LEDGER, NEVER FROM THE RULES. This used to be
  // rules.holdPerCover x covers, and since rulesOf() falls back to £20 per cover
  // for a venue with no saved rules, every walk-in claimed "Card held" over an
  // invented figure (Peter, 25 Aug). A hold is real only if a row says so.
  const payRows = useBookingPayments(b.id);
  const capturedRow = (payRows || []).find((r) => r.status === 'captured' && r.kind !== 'refund');
  const heldRow = (payRows || []).find((r) => r.status === 'authorised' && r.kind === 'hold');
  const onFile = capturedRow || heldRow || null;

  const seatNow = () => {
    const seat = useStore.getState().seatBooking;
    if (typeof seat === 'function') seat(b.id);
    else updateBooking?.(b.id, { status: 'dining', seatedAt: Date.now() });
  };

  // Only steps that SAY something. This used to print four lines whatever the
  // booking was, so a seated walk-in read "Via walk_in", "No card taken", "No
  // package attached" and one useful line, which is why it looked like developer
  // notes rather than anything a host needs mid-service (Peter, 25 Aug).
  const sourceLabel = { walk_in: 'Walk-in', host: 'Taken by the team', online: 'Booked online', widget: 'Booked online' }[b.source] || 'Taken by the team';
  const steps = [
    { t: 'Booked', d: `${sourceLabel} · ${b.covers} covers · table held ${b.turnMinutes || 90} min${b.pacingOverrideBy ? ` · pacing override by ${b.pacingOverrideBy}` : ''}` },
    ...(prepaid || onFile ? [{
      t: 'Payment',
      d: prepaid ? `${pkg?.name || 'Package'} prepaid at booking, posts to the check as tender when the tab closes`
        : capturedRow ? `${money(capturedRow.amount, 2)} already paid, comes off the bill at close`
        : `${money(heldRow.amount, 2)} held on the card, charged only on a no-show`,
    }] : []),
    ...(pkg ? [{ t: 'Package', d: `${pkg.name}, lines queue to the POS carrying their courses` }] : []),
    {
      t: 'On the POS',
      d: b.status === 'dining' ? `Seated, tab open on ${labels.join(' + ')}`
        : `On seat, a tab opens on ${labels[0] || 'the table'}${b.customer?.name ? ' with the guest attached' : ''}`,
    },
  ];

  return (
    <div>
      <div style={sec}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em' }}>{bookingName(b)}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2, ...mono }}>
              {b.covers} cvr · {String(b.startTime || '').slice(0, 5)}–{toHM(start + (b.turnMinutes || 90))}
            </div>
          </div>
          <StatusBadge st={st} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 15, padding: 0 }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 9, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Table</div>
            <div style={{ fontSize: 13, fontWeight: 800, ...mono }}>{labels.join(' + ') || '—'}</div>
            <div style={{ fontSize: 10, color: 'var(--t3)' }}>{section || ''}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 9, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Turn</div>
            <div style={{ fontSize: 13, fontWeight: 800, ...mono }}>{b.turnMinutes || 90} min</div>
            <div style={{ fontSize: 10, color: 'var(--t3)' }}>{pkg?.turnMinutes ? 'package' : 'cover band'}</div>
          </div>
        </div>
        {b.note && (
          <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: 8, background: tintBg('var(--orn)', 8), color: 'var(--orn)', fontSize: 11, lineHeight: 1.4 }}>{b.note}</div>
        )}
      </div>

      {b.customer && (
        <div style={sec}>
          {/* Not always "from CRM": a walk-in's name and number are typed at the
              door, so the plain label is the one that is true in every case. */}
          <SecLabel>Guest</SecLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 999, display: 'grid', placeItems: 'center', background: tintBg('var(--uv)'), border: `1px solid ${tintBd('var(--uv)')}`, color: 'var(--uv)', fontSize: 13, fontWeight: 800 }}>
              {initialsOf(b.customer.name)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{b.customer.name || 'Guest'}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{b.customer.phone || 'no phone on file'}</div>
            </div>
          </div>
        </div>
      )}

      {pkg && (
        <div style={sec}>
          <SecLabel>Package</SecLabel>
          <div style={{ fontSize: 13.5, fontWeight: 800 }}>{pkg.name}</div>
          {(() => {
            const po = preorderStateFor(b, packages);
            if (!po) return <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>No menu choices needed — preset lines load on seating.</div>;
            if (po.state === 'complete') return <div style={{ fontSize: 11.5, color: 'var(--grn)', marginTop: 4, fontWeight: 700 }}>✓ Pre-orders in — {po.have} choices for {b.covers} guests</div>;
            return (
              <div style={{ marginTop: 6, padding: '7px 10px', borderRadius: 8, background: tintBg('var(--orn)', 10), border: `1px solid ${tintBd('var(--orn)')}`, color: 'var(--orn)', fontSize: 11.5, lineHeight: 1.45, fontWeight: 700 }}>
                Pre-orders outstanding — {po.have} of {po.needed} choices in. Take them below or the guest can use their link.
              </div>
            );
          })()}
          {/* v5.7.21 link-first: every requires_preorder booking has (or can
              mint) a guest link — send it or copy it from here, even when
              choices came in at booking (the link lets guests amend). */}
          {pkg.requiresPreorder && isLive(b) && b.status !== 'dining' && (
            <PreorderLinkActions b={b} />
          )}
        </div>
      )}

      <div style={sec}>
        <SecLabel>Payment</SecLabel>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--t2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {capturedRow ? `${pkg?.name || 'Paid'} · ${capturedRow.kind === 'prepay' ? 'prepaid' : capturedRow.kind === 'deposit' ? 'deposit' : 'paid'}`
              : heldRow ? 'Card held, no charge'
              : 'Nothing on file'}
          </span>
          {/* No figure at all when nothing is on file. A green number beside
              "Nothing on file" is exactly how the invented hold read as real. */}
          {onFile && (
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--grn)', ...mono, flexShrink: 0 }}>
              {money(onFile.amount, 2)}
            </span>
          )}
        </div>
        <PaymentState b={b} prepaid={prepaid} rows={payRows} />
      </div>

      <div style={sec}>
        <SecLabel>This booking</SecLabel>
        {steps.map((s2) => (
          <div key={s2.t} style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--blu)', marginTop: 5, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{s2.t}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.45 }}>{s2.d}</div>
            </div>
          </div>
        ))}
      </div>

      {pkg && (pkg.lines || []).some((l) => l.isPreorderChoice) && isLive(b) && b.status !== 'dining' && (
        <PreordersPanel b={b} pkg={pkg} />
      )}

      {moving && <MovePanel b={b} onDone={() => setMoving(false)} />}

      <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {isLive(b) && b.status !== 'dining' && (
          <button className="btn btn-acc" onClick={seatNow} style={{ height: 44, fontWeight: 800 }}>Seat now — open POS tab</button>
        )}
        {b.status === 'dining' && (
          <button className="btn btn-ghost" onClick={() => updateBooking?.(b.id, { status: 'departed', departedAt: Date.now() })} style={{ height: 44 }}>Mark departed</button>
        )}
        {/* Three across a 262px panel on a narrow stand: minWidth 0 and tighter
            padding, or .btn's nowrap pushes the labels through the borders. */}
        {isLive(b) && b.status !== 'dining' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setMoving((m) => !m)} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>{moving ? 'Close' : 'Move'}</button>
            <button className="btn btn-red" onClick={() => updateBooking?.(b.id, { status: 'no_show' })} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>No-show</button>
            <button className="btn btn-ghost" onClick={() => cancelBooking?.(b.id)} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Per-seat pre-orders (Phase 4) ─────────────────────────────────────────────
// Shown when the booking's package has choice lines (is_preorder_choice).
// Each row = one guest's pick: seat, name, dish, note. Saved wholesale; on
// seating they become the tab's lines with "Seat N · Name" riding the notes so
// the KDS ticket and kitchen print show whose plate each course is.
const PO_COURSE_LABEL = { 0: 'On arrival', 1: 'Course 1', 2: 'Course 2', 3: 'Course 3' };
const PO_COURSE_SHORT = { 0: 'Arr', 1: 'C1', 2: 'C2', 3: 'C3' };

function PreordersPanel({ b, pkg }) {
  const loadPreorders = useStore((s) => s.loadPreorders);
  const savePreorders = useStore((s) => s.savePreorders);
  const showToast = useStore((s) => s.showToast);
  const [rowsRes, setRowsRes] = useState(null);   // { forId, rows } — request-keyed load
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const choices = (pkg.lines || []).filter((l) => l.isPreorderChoice);

  useEffect(() => {
    let off = false;
    loadPreorders?.(b.id).then((data) => {
      if (!off) setRowsRes({ forId: b.id, rows: data || [] });
    });
    return () => { off = true; };
  }, [b.id, loadPreorders]);

  // A different booking's load resets the editor (render-adjust, not an effect).
  const [editFor, setEditFor] = useState(null);
  if (rowsRes?.forId === b.id && editFor !== b.id) {
    setEditFor(b.id);
    setRows(rowsRes.rows);
    setOpen(rowsRes.rows.length > 0);
  }

  const patchRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { seat: Math.min((rs.at(-1)?.seat || 0) + 1, b.covers), guestName: '', itemId: choices[0]?.itemId || null, displayName: choices[0]?.displayName || '', course: choices[0]?.course ?? 0, notes: '' }]);

  const save = async () => {
    setSaving(true);
    const res = await savePreorders?.(b.id, rows);
    setSaving(false);
    if (res?.ok) showToast?.(`Pre-orders saved — ${rows.length} choice${rows.length === 1 ? '' : 's'}`, 'success');
  };

  const inp = { background: 'var(--bg3)', border: '1px solid var(--bdr2)', borderRadius: 8, color: 'var(--t1)', padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', height: 32, boxSizing: 'border-box' };

  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SecLabel>Pre-orders — {rows.length ? `${rows.length} taken` : 'none yet'}</SecLabel>
        <button className="btn btn-ghost" onClick={() => setOpen((o) => !o)} style={{ height: 28, fontSize: 11, padding: '0 10px' }}>{open ? 'Hide' : rows.length ? 'Edit' : 'Take pre-orders'}</button>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={r.seat || 1} onChange={(e) => patchRow(i, { seat: Number(e.target.value) })} style={{ ...inp, width: 62 }}>
                {Array.from({ length: b.covers }, (_, s) => <option key={s + 1} value={s + 1}>S{s + 1}</option>)}
              </select>
              <input value={r.guestName} placeholder="Name" onChange={(e) => patchRow(i, { guestName: e.target.value })} style={{ ...inp, flex: '1 1 70px', minWidth: 0 }} />
              <select
                value={`${r.itemId || ''}|${r.displayName}`}
                onChange={(e) => {
                  const c = choices.find((x) => `${x.itemId || ''}|${x.displayName}` === e.target.value);
                  if (c) patchRow(i, { itemId: c.itemId || null, displayName: c.displayName, course: c.course ?? 0 });
                }}
                style={{ ...inp, flex: '2 1 120px', minWidth: 0 }}>
                {choices.map((c) => <option key={`${c.itemId || ''}|${c.displayName}`} value={`${c.itemId || ''}|${c.displayName}`}>{c.displayName} · {PO_COURSE_LABEL[c.course ?? 0] || `Course ${c.course}`}</option>)}
              </select>
              <span title={PO_COURSE_LABEL[r.course ?? 0] || `Course ${r.course}`} style={{
                flexShrink: 0, fontSize: 10, fontWeight: 800, padding: '3px 7px', borderRadius: 999, ...mono,
                color: courseColor(r.course), background: tintBg(courseColor(r.course), 12), border: `1px solid ${tintBd(courseColor(r.course), 30)}`,
              }}>{PO_COURSE_SHORT[r.course ?? 0] || `C${r.course}`}</span>
              <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 14, padding: 2 }}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={addRow} style={{ flex: 1, height: 34, fontSize: 12 }}>+ Add choice</button>
            <button className="btn btn-acc" onClick={save} disabled={saving} style={{ flex: 1, height: 34, fontSize: 12, fontWeight: 800 }}>{saving ? 'Saving…' : 'Save pre-orders'}</button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--t4)', lineHeight: 1.4 }}>On seating, each choice lands on the tab with the guest's name — the kitchen ticket shows whose plate each course is.</div>
        </div>
      )}
    </div>
  );
}

// ── Move table (Peter, 12 Aug: "a way to move peoples table manually") ────────
// Suggested combinations come from the optimiser with the booking's OWN
// footprint excluded; the manual grid offers every table, greying ones busy
// for the window. The write is moveBooking → the atomic move_booking RPC, so
// a stale suggestion loses cleanly with a "just taken" toast, never a
// double-book.
function MovePanel({ b, onDone }) {
  const suggest = useStore((s) => s.suggestBookingTables);
  const moveBooking = useStore((s) => s.moveBooking);
  const showToast = useStore((s) => s.showToast);
  const storeTables = useStore((s) => s.tables) || [];
  const dayBookings = useStore((s) => s.bookings) || [];
  const [busyId, setBusyId] = useState(null);

  const time = String(b.startTime || '').slice(0, 5);
  const candidates = useMemo(
    () => (suggest ? suggest({ party: b.covers, time, packageId: b.packageId, skipBookingId: b.id, limit: 3 }) : [])
      .filter((c) => c.set.join('+') !== (b.tables || []).join('+')),
    [suggest, b, time],
  );
  const start = toMin(time), end = start + (b.turnMinutes || 90);
  // The manual grid must also treat open POS tabs as busy (today only) — the
  // store's suggest() already does, so the two can never disagree.
  const bookingRules = useStore((s) => s.bookingRules);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const opt = useMemo(() => {
    const base = dayBookings.map(toOptimiserBooking).filter(Boolean);
    if (bookingsDate && bookingsDate !== todayISO()) return base;
    const now = new Date();
    return [...base, ...sessionsToBlocks(storeTables, dayBookings, rulesOf(bookingRules).turnBands, now.getHours() * 60 + now.getMinutes())];
  }, [dayBookings, storeTables, bookingRules, bookingsDate]);
  const grid = useMemo(
    () => storeTables.filter((t) => !t.parentId).map((t) => ({
      id: t.id, label: t.label || t.id, covers: t.maxCovers || 2,
      free: isTableFree(t.id, start, end, opt, { skipId: b.id }),
      current: (b.tables || []).includes(t.id),
    })),
    [storeTables, opt, start, end, b],
  );

  const doMove = async (tableIds) => {
    setBusyId(tableIds.join('+'));
    const res = await moveBooking?.(b.id, tableIds);
    setBusyId(null);
    if (res?.ok) {
      showToast?.(`Moved to ${tableIds.map((id) => grid.find((g) => g.id === id)?.label || String(id).slice(-4)).join(' + ')}`, 'success');
      onDone?.();
    } else {
      showToast?.(res?.error === 'table_taken' ? 'That table was just taken — pick another' : `Move failed — ${res?.error || 'try again'}`, 'error');
    }
  };

  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)' }}>
      <SecLabel>Move to</SecLabel>
      {candidates.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {candidates.map((c) => (
            <button key={c.id} onClick={() => doMove(c.set)} disabled={busyId === c.id}
              style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: tintBg('var(--acc)', 8), border: `1px solid ${tintBd('var(--acc)')}`, color: 'var(--t1)', opacity: busyId === c.id ? 0.6 : 1 }}>
              <span style={{ fontWeight: 800, fontSize: 13 }}>{c.label}</span>
              <span style={{ color: 'var(--t3)', fontSize: 11, marginLeft: 8, ...mono }}>seats {c.cap}</span>
              <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 2 }}>{c.reasons?.[0]}</div>
            </button>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: 'var(--t4)', marginBottom: 6 }}>All tables — greyed are busy for this window</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {grid.map((t) => (
          <button key={t.id} onClick={() => t.free && !t.current && doMove([t.id])} disabled={!t.free || t.current || busyId === t.id}
            title={t.current ? 'Current table' : t.free ? `Seats ${t.covers}` : 'Busy for this window'}
            style={{
              minWidth: 46, padding: '7px 8px', borderRadius: 9, fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              cursor: t.free && !t.current ? 'pointer' : 'not-allowed',
              background: t.current ? tintBg('var(--acc)') : t.free ? 'var(--bg3)' : 'transparent',
              border: `1px solid ${t.current ? tintBd('var(--acc)') : 'var(--bdr2)'}`,
              color: t.current ? 'var(--acc)' : t.free ? 'var(--t1)' : 'var(--t4)',
              opacity: busyId === t.id ? 0.5 : 1,
            }}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const SecLabel = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }}>{children}</div>
);
