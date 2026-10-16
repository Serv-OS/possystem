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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { supabase, isMock } from '../../lib/supabase';
import { toMin, toHM, isTableFree, toOptimiserBooking, sessionsToBlocks } from '../../lib/bookings/optimiser.js';
import { loadBookingPayments, lookupPreorderLinkBase } from '../../lib/bookings/bookingsData.js';
import { undoNoShowStatus, bookingUnpaid, isNeedsRefundRow } from '../../lib/bookings/bookingPayment.js';
import { choiceSummary } from '../../lib/bookings/preorderChoices.js';
import { dropTarget, editedLine, hasGuest, fmtClock, EDIT_REFUSALS, MOVE_NON_BLOCKING } from '../../lib/bookings/editRules.js';
import {
  mono, tintBg, tintBd, rulesOf, displayStatus, statusMeta, StatusBadge, isLive,
  money, initialsOf, bookingName, EmptyNote, Chip, preorderStateFor, courseColor,
} from './bits.jsx';
import { useVenueClock } from './useVenueClock.js';
import { shiftYmd, ymdLabel, epochToVenueMin } from '../../lib/bookings/venueClock.js';
import { seatRefusal, moneyOnFileLine, undoCancelStatus, offPlanBookings, UNDO_CANCEL_MS, CANCEL_REASONS, NO_SHOW_REASONS } from '../../lib/bookings/standRules.js';
import EditBookingSheet from './EditBookingSheet.jsx';

// A block that may be dragged on the Timeline: live and not yet seated. A
// seated party's table is the till's business; finished bookings stay put.
const canDragBooking = (b) => isLive(b) && b.status !== 'dining';
const DRAG_THRESHOLD_PX = 6;
const LONG_PRESS_MS = 350; // a finger holds this long before a block lifts
const EDGE_PX = 40;        // within this of the diary's edge, a drag scrolls it
const EDGE_STEP = 12;      // px per frame

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
  // 16 Oct 2026: the venue clock, never the iPad's (audit item 8).
  const clock = useVenueClock();
  const isToday = !bookingsDate || bookingsDate === clock.ymd;
  const nowMin = isToday ? clock.nowMin : null;
  const toVenueMin = useMemo(() => epochToVenueMin(clock.tz), [clock.tz]);

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
    return [...base, ...sessionsToBlocks(tables, visible, rules.turnBands, Number.isFinite(nowMin) ? nowMin : 0, toVenueMin)];
  }, [visible, tables, isToday, nowMin, rules.turnBands, toVenueMin]);

  // ── KPI strip (all computed, never static) ──────────────────────────────────
  const kpi = useMemo(() => {
    const alive = bookings.filter(isLive); // isLive, not isDead: a DEPARTED party is finished
    const coversBooked = alive.reduce((s, b) => s + (b.covers || 0), 0);
    const seated = bookings.filter((b) => b.status === 'dining').reduce((s, b) => s + (b.covers || 0), 0);
    const capacity = rows.reduce((s, t) => s + (t.maxCovers || 0), 0);
    const from = Number.isFinite(nowMin) ? nowMin : startMin;
    const freeNextHour = rows.filter((t) => isTableFree(t.id, from, from + 60, optBookings)).length;
    const atRisk = bookings.filter((b) => ['late', 'due'].includes(displayStatus(b, nowMin, packages))).length;
    // PREPAID IS MONEY, so it comes off the ledger total loadBookings already put
    // on every row (paidPrepayMinor, minor units), never off the package price
    // list. A prepay package with no captured payment is a party that has only
    // PROMISED to pay: its own badge on this screen reads Confirmed, so a green
    // Prepaid figure beside it made the screen contradict itself and the greener
    // number won. null means the ledger is not readable from this device, which
    // is not the same as zero, so that case is flagged rather than counted.
    // No card can be asked for at all unless the venue switched capture on.
    const canTakeCards = !!rules.cardCaptureEnabled;
    const minCovers = rules.cardCaptureMinCovers || 0;
    let held = 0, prepaid = 0, prepaidHidden = false;
    for (const b of alive) {
      const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
      // Ledger first, so the money still counts if the package was deleted.
      const isPrepay = (b.paidPrepayMinor || 0) > 0 || pkg?.paymentModel === 'prepay';
      if (isPrepay) {
        if (b.paidPrepayMinor != null) prepaid += b.paidPrepayMinor / 100;
        else if (!CARD_IMPOSSIBLE_SOURCES.has(b.source || 'host')) prepaidHidden = true;
      } else if (b.status === 'confirmed' && canTakeCards && (b.covers || 0) >= minCovers
                 && !CARD_IMPOSSIBLE_SOURCES.has(b.source || 'host')) {
        // Only an ONLINE booking at a venue with capture ON can carry a card, and
        // even then this is what the rules would ask for, not what the ledger
        // holds. A hold saves a card and takes nothing, so it is COUNTED, never
        // shown as a money figure (10 Sep 2026 review).
        if ((rules.holdPerCover || 0) > 0) held += 1;
      }
    }
    return { coversBooked, seated, capacity, freeNextHour, atRisk, held, prepaid, prepaidHidden };
  }, [bookings, rows, optBookings, nowMin, startMin, packages,
    rules.holdPerCover, rules.cardCaptureEnabled, rules.cardCaptureMinCovers]);

  const selected = bookings.find((b) => b.id === sel) || null;

  // ── Timeline drag (16 Oct 2026) ─────────────────────────────────────────────
  // Peter: "on the timeline I should be able to drag things around, move things
  // the way I want". Pointer events, so a finger on the iPad and a mouse on a
  // laptop behave the same. A press that moves past the threshold becomes a
  // drag: the block dims, a ghost shows the snapped landing (15 minute slots,
  // every member table shifted by the same rows), green when free and red with
  // the other booking's name when not. Letting go asks "Move X to T4 at 18:30?"
  // with Move and Keep. Move goes through editBooking, so the same rules and
  // the same server side table check apply as in the Edit sheet.
  // 16 Oct 2026 review: a finger only picks a block up after a press and hold
  // (LONG_PRESS_MS without moving), so a quick swipe across the blocks still
  // scrolls the diary. A mouse picks up at once. The drag locks to the axis it
  // mostly moves on (dropTarget in editRules.js, tested), the ghost is solid,
  // and near the edge of the diary it scrolls so an off screen row is reachable.
  const editBooking = useStore((s) => s.editBooking);
  const operatorName = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  // { id, pointerId, x0, y0, sl0, st0, lastX, lastY, armed, active, timer, el }
  const dragRef = useRef(null);
  const autoRef = useRef(null);            // the edge scroll animation frame
  const suppressClickRef = useRef(false);  // the click that follows a drop is not a select
  const [drag, setDrag] = useState(null);  // { id, dx, dy } while a drag is live
  const [drop, setDrop] = useState(null);  // the confirm card after a drop
  const othersForDrag = useMemo(() => {
    if (!isToday) return visible;
    return [...visible, ...sessionsToBlocks(tables, visible, rules.turnBands, Number.isFinite(nowMin) ? nowMin : 0, toVenueMin)];
  }, [visible, tables, isToday, nowMin, rules.turnBands, toVenueMin]);
  const labelOf = (id) => rows.find((t) => t.id === id)?.label || String(id).slice(-4);
  const dropTargetFor = useCallback((b, dx, dy) => dropTarget({
    booking: b, dx, dy, slotW, rowH: ROW_H, rows, startMin, endMin, others: othersForDrag, nonBlocking: MOVE_NON_BLOCKING,
  }), [slotW, rows, startMin, endMin, othersForDrag]);
  // The pointer offset, plus however far the diary has scrolled since the press.
  const offsetOf = (d) => {
    const el = wrapRef.current;
    return {
      dx: d.lastX - d.x0 + (el ? el.scrollLeft - d.sl0 : 0),
      dy: d.lastY - d.y0 + (el ? el.scrollTop - d.st0 : 0),
    };
  };
  const endDrag = () => {
    const d = dragRef.current;
    if (d?.timer) clearTimeout(d.timer);
    dragRef.current = null;
    if (autoRef.current) { cancelAnimationFrame(autoRef.current); autoRef.current = null; }
    setDrag(null);
  };
  const edgeScroll = () => {
    const d = dragRef.current, el = wrapRef.current;
    if (!d || !d.active || !el) { autoRef.current = null; return; }
    const r = el.getBoundingClientRect();
    const vx = d.lastX < r.left + EDGE_PX ? -EDGE_STEP : d.lastX > r.right - EDGE_PX ? EDGE_STEP : 0;
    const vy = d.lastY < r.top + EDGE_PX ? -EDGE_STEP : d.lastY > r.bottom - EDGE_PX ? EDGE_STEP : 0;
    if (vx || vy) {
      const sl = el.scrollLeft, st = el.scrollTop;
      el.scrollLeft += vx; el.scrollTop += vy;
      if (el.scrollLeft !== sl || el.scrollTop !== st) setDrag({ id: d.id, ...offsetOf(d) });
    }
    autoRef.current = requestAnimationFrame(edgeScroll);
  };
  // An armed drag must not scroll the page: one non passive touchmove listener.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onMove = (e) => { if (dragRef.current?.armed) e.preventDefault(); };
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => el.removeEventListener('touchmove', onMove);
  }, []);
  useEffect(() => () => {
    if (dragRef.current?.timer) clearTimeout(dragRef.current.timer);
    if (autoRef.current) cancelAnimationFrame(autoRef.current);
  }, []);
  const onBlockPointerDown = (b) => (e) => {
    if (!canDragBooking(b) || drop || dragRef.current) return; // one drag at a time, a second finger is ignored
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = wrapRef.current;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const d = {
      id: b.id, pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
      sl0: el?.scrollLeft || 0, st0: el?.scrollTop || 0, armed: false, active: false, timer: null,
    };
    const arm = () => {
      if (dragRef.current !== d) return;
      d.armed = true;
      try { target.setPointerCapture(pointerId); } catch { /* the drag still works without capture */ }
    };
    dragRef.current = d;
    if (e.pointerType === 'mouse') arm();
    else {
      d.timer = setTimeout(() => {
        d.timer = null;
        arm();
        if (dragRef.current !== d) return;
        try { navigator.vibrate?.(10); } catch { /* no haptics */ }
        setDrag({ id: b.id, dx: 0, dy: 0 }); // picked up: the block dims and the ghost shows
      }, LONG_PRESS_MS);
    }
  };
  const onBlockPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.lastX = e.clientX; d.lastY = e.clientY;
    const mx = Math.abs(e.clientX - d.x0), my = Math.abs(e.clientY - d.y0);
    if (!d.armed) {
      // Moved before the hold finished: a swipe. Let the browser scroll.
      if (mx > DRAG_THRESHOLD_PX || my > DRAG_THRESHOLD_PX) endDrag();
      return;
    }
    if (!d.active && mx < DRAG_THRESHOLD_PX && my < DRAG_THRESHOLD_PX) return;
    if (!d.active) { d.active = true; autoRef.current = requestAnimationFrame(edgeScroll); }
    setDrag({ id: d.id, ...offsetOf(d) });
  };
  const onBlockPointerUp = (b) => (e) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) { if (!d) setDrag(null); return; }
    const wasActive = d.active;
    const off = offsetOf(d);
    endDrag();
    if (!wasActive) return;                // a tap (or a hold with no move): the click handler selects
    suppressClickRef.current = true;
    // The click that follows this pointerup is swallowed above. Should a browser
    // not send one, the flag must not swallow the NEXT tap instead.
    setTimeout(() => { suppressClickRef.current = false; }, 0);
    const t = dropTargetFor(b, off.dx, off.dy);
    if (t.unchanged) return;
    setDrop({ b, ...t, x: e.clientX, y: e.clientY, busy: false, error: null });
  };
  const onBlockPointerCancel = (e) => {
    const d = dragRef.current;
    if (!d || (e?.pointerId !== undefined && d.pointerId !== e.pointerId)) return;
    endDrag();
  };
  // Nothing changes on a refused drop, so its card closes by itself.
  useEffect(() => {
    if (!drop || drop.ok) return undefined;
    const t = setTimeout(() => setDrop((d) => (d && !d.ok ? null : d)), 3500);
    return () => clearTimeout(t);
  }, [drop]);
  const confirmDrop = async () => {
    if (!drop || drop.busy || !drop.ok || !editBooking) return;
    setDrop((d) => ({ ...d, busy: true, error: null }));
    // Only the axis that moved, so a stale copy never puts back the other.
    const movePatch = {};
    if (drop.tablesChanged) { movePatch.tables = drop.tables; movePatch.primaryTableId = drop.tables[0]; }
    if (drop.timeChanged) movePatch.startTime = toHM(drop.startMin);
    const res = await editBooking(drop.b.id, movePatch, { editedBy: operatorName });
    if (res?.ok) { setDrop(null); onSelect(drop.b.id); return; }
    setDrop((d) => (d ? { ...d, busy: false, error: res?.error || 'Booking NOT moved. Try again.' } : d));
  };

  const shiftDay = (delta) => setBookingsDate?.(shiftYmd(bookingsDate || clock.ymd, delta));

  // 16 Oct 2026 (audit item 21): a live booking on a table that is not on the
  // floor plan used to vanish from the Timeline. It gets an Off plan row with
  // Move instead (the inspector opens on the move panel).
  // No floor plan loaded yet (a stand boot: bookings can land first): nothing is off plan yet.
  const offPlan = useMemo(() => (rows.length ? offPlanBookings(visible, rows.map((t) => t.id)) : []), [visible, rows]);
  const [moveFor, setMoveFor] = useState(null);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', background: 'var(--bg1)', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <Kpi label="Covers booked" value={kpi.coversBooked} sub={isToday ? 'today' : ymdLabel(bookingsDate, { long: true })} />
          <Kpi label="Seated now" value={`${kpi.seated} / ${kpi.capacity}`} sub="covers / capacity" />
          <Kpi label="Free tables" value={kpi.freeNextHour} sub="next hour" />
          <Kpi label="At risk" value={kpi.atRisk} sub="late + due" col={kpi.atRisk > 0 ? 'var(--red)' : undefined} />
          <Kpi label="Cards to save" value={kpi.held} sub="online bookings, nothing taken" />
          <Kpi
            label="Prepaid"
            value={kpi.prepaidHidden && !kpi.prepaid ? 'Hidden' : money(kpi.prepaid, 2)}
            sub={kpi.prepaidHidden ? 'captured, some not visible here' : 'captured at booking'}
            col="var(--grn)" last />
        </div>

        {/* day switcher + view toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 0', flexShrink: 0 }}>
          <button className="btn btn-ghost btn-xs" onClick={() => shiftDay(-1)} style={{ ...mono }}>‹</button>
          {/* v5.9.62: the date is a real picker (tap it), and Today brings you back. Peter,
              24 Sep, on the iPad: "you need to be able to click on the date and set a date in
              the future then have a button that says today and it skips back". */}
          <input type="date" value={bookingsDate || clock.ymd} onChange={(e) => { if (e.target.value) setBookingsDate?.(e.target.value); }}
            aria-label="Diary date"
            style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: 8, padding: '3px 8px', fontFamily: 'inherit', ...mono }} />
          {!isToday && <button className="btn btn-ghost btn-xs" onClick={() => setBookingsDate?.(clock.ymd)} style={{ fontWeight: 700 }}>Today</button>}
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
              <EmptyNote title={isToday ? 'No bookings yet today' : `No bookings on ${ymdLabel(bookingsDate, { long: true })}`} sub="Take the first one from the Book tab." />
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
                {offPlan.length > 0 && (
                  <div style={{ height: ROW_H, padding: '6px 10px', boxSizing: 'border-box', background: tintBg('var(--orn)', 10) }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--orn)' }}>Off plan</div>
                    <div style={{ fontSize: 10, color: 'var(--t3)' }}>table not on the floor</div>
                  </div>
                )}
              </div>
              {/* grid */}
              <div style={{
                position: 'relative', width: gridW, height: gridH + (offPlan.length ? ROW_H : 0), flexShrink: 0,
                background: [
                  `repeating-linear-gradient(to right, var(--bdr2) 0 1px, transparent 1px ${slotW * 4}px)`,
                  `repeating-linear-gradient(to right, ${tintBg('var(--t1)', 3)} 0 1px, transparent 1px ${slotW}px)`,
                  `repeating-linear-gradient(to bottom, transparent 0 ${ROW_H}px, ${tintBg('var(--t1)', 2)} ${ROW_H}px ${ROW_H * 2}px)`,
                ].join(', '),
              }}>
                {visible.map((b) => {
                  const st = displayStatus(b, nowMin, packages);
                  const meta = statusMeta(st);
                  const isOff = offPlan.some((x) => x.id === b.id);
                  let idxs = (b.tables || []).map((id) => rowIndex.get(id)).filter((i) => i != null);
                  if (!idxs.length && isOff) idxs = [rows.length]; // the Off plan row
                  if (!idxs.length) return null;
                  const first = Math.min(...idxs), last = Math.max(...idxs);
                  const bs = toMin(b.startTime);
                  const left = ((bs - startMin) / 15) * slotW;
                  const width = ((b.turnMinutes || 90) / 15) * slotW - 3;
                  if (left + width < 0 || left > gridW) return null;
                  const isSel = b.id === sel;
                  const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
                  const draggable = canDragBooking(b) && !isOff;
                  const dragging = drag?.id === b.id;
                  return (
                    <button
                      key={b.id}
                      onClick={() => {
                        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                        if (isOff) { setMoveFor(b.id); onSelect(b.id); return; }
                        onSelect(isSel ? null : b.id);
                      }}
                      onPointerDown={draggable ? onBlockPointerDown(b) : undefined}
                      onPointerMove={draggable ? onBlockPointerMove : undefined}
                      onPointerUp={draggable ? onBlockPointerUp(b) : undefined}
                      onPointerCancel={draggable ? onBlockPointerCancel : undefined}
                      onLostPointerCapture={draggable ? onBlockPointerCancel : undefined}
                      onContextMenu={draggable ? (e) => e.preventDefault() : undefined}
                      title={isOff ? 'This table is not on the floor plan. Tap to move it to a table.' : draggable ? 'Press and hold, then drag to another table or time' : b.status === 'dining' ? 'Seated. Change the table on the till.' : undefined}
                      style={{
                        position: 'absolute', left: Math.max(0, left), width: Math.min(width, gridW - Math.max(0, left)),
                        top: first * ROW_H + 3, height: (last - first + 1) * ROW_H - 6,
                        borderRadius: 9, padding: '5px 8px', textAlign: 'left', overflow: 'hidden',
                        cursor: dragging ? 'grabbing' : draggable ? 'grab' : 'pointer',
                        // a quick swipe scrolls; only a held block drags (see onBlockPointerDown)
                        touchAction: 'pan-x pan-y',
                        userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                        opacity: dragging ? 0.35 : 1,
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
                {/* drag ghost: where the block will land */}
                {drag && (() => {
                  const b = visible.find((x) => x.id === drag.id);
                  if (!b) return null;
                  const t = dropTargetFor(b, drag.dx, drag.dy);
                  const ids = t.tables || b.tables || [];
                  const idxs = ids.map((id) => rowIndex.get(id)).filter((i) => i != null);
                  if (!idxs.length) return null;
                  const first = Math.min(...idxs), last = Math.max(...idxs);
                  const col = t.ok ? 'var(--grn)' : 'var(--red)';
                  const left = ((t.startMin - startMin) / 15) * slotW;
                  const width = ((b.turnMinutes || 90) / 15) * slotW - 3;
                  return (
                    <div aria-hidden="true" style={{
                      position: 'absolute', left: Math.max(0, left), width: Math.min(width, gridW - Math.max(0, left)),
                      top: first * ROW_H + 3, height: (last - first + 1) * ROW_H - 6, pointerEvents: 'none',
                      borderRadius: 9, padding: '5px 8px', overflow: 'hidden', zIndex: 3,
                      // solid underneath the tint, so the booking it sits over does not show through
                      background: `linear-gradient(${tintBg(col, 22)}, ${tintBg(col, 22)}), var(--bg1)`,
                      color: col, border: `2px dashed ${col}`, boxShadow: '0 6px 18px rgba(0,0,0,.35)',
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ids.map(labelOf).join('+')} · {toHM(t.startMin)}
                      </div>
                      <div style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...mono }}>
                        {t.ok ? 'free' : t.reason}
                      </div>
                    </div>
                  );
                })()}
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
          ? <Inspector b={selected} nowMin={nowMin} packages={packages} tables={rows} onClose={() => onSelect(null)} startMoving={moveFor === selected.id} />
          : (
            <div style={{ padding: 18, color: 'var(--t3)', fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t2)', marginBottom: 8 }}>Nothing selected</div>
              Tap a booking block to see the guest, the payment and its POS tab here.
              <button className="btn btn-ghost" onClick={onBook} style={{ marginTop: 16, width: '100%', height: 40 }}>Take a booking</button>
            </div>
          )}
      </div>

      {/* the drop confirm: "Move Oliver Pembroke to T4 at 18:30?" */}
      {drop && (
        <DropConfirm drop={drop} labelOf={labelOf} onKeep={() => setDrop(null)} onMove={confirmDrop} />
      )}
    </div>
  );
}

function DropConfirm({ drop, labelOf, onKeep, onMove }) {
  const W = 320;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(vw - W - 8, (drop.x || 0) - W / 2));
  const top = Math.max(8, Math.min(vh - 220, (drop.y || 0) + 14));
  const fromTables = (drop.b.tables || []).map(labelOf).join(' + ');
  const toTables = (drop.tables || []).map(labelOf).join(' + ');
  const fromAt = toHM(drop.fromMin ?? toMin(drop.b.startTime));
  const toAt = toHM(drop.startMin);
  const name = bookingName(drop.b);
  // 16 Oct 2026 review: the change written as from and to, with a time change
  // called out, so a host who meant a table move sees the time moved too.
  return (
    <div role="dialog" aria-label="Move booking" style={{
      position: 'fixed', left, top, width: W, zIndex: 100002, padding: '12px 14px', borderRadius: 12,
      background: 'var(--bg1)', color: 'var(--t1)', border: `1.5px solid ${drop.ok ? 'var(--acc)' : 'var(--red)'}`,
      boxShadow: '0 14px 40px rgba(0,0,0,.45)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.35 }}>
        {drop.ok ? `Move ${name}?` : `${name} cannot go ${drop.tables ? `to ${toTables} at ${toAt}` : 'there'}.`}
      </div>
      {drop.tables && (
        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, ...mono }}>
          {fromTables} {fromAt} → {toTables} {toAt}
        </div>
      )}
      {drop.ok && drop.timeChanged && (
        <div style={{ marginTop: 4, fontSize: 12.5, fontWeight: 800, color: 'var(--orn)' }}>Time changes {fromAt} → {toAt}</div>
      )}
      {!drop.ok && (
        <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)', fontWeight: 700, lineHeight: 1.4 }}>{drop.reason}</div>
      )}
      {drop.error && (
        <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--red)', fontWeight: 700, lineHeight: 1.4 }}>{drop.error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {drop.ok ? (
          <>
            <button className="btn btn-ghost" onClick={onKeep} disabled={drop.busy} style={{ flex: 1, height: 44 }}>Keep</button>
            <button className="btn btn-acc" onClick={onMove} disabled={drop.busy} style={{ flex: 1, height: 44, fontWeight: 800 }}>
              {drop.busy ? 'Moving…' : 'Move'}
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={onKeep} style={{ flex: 1, height: 44, fontWeight: 700 }}>OK</button>
        )}
      </div>
    </div>
  );
}

// 16 Oct 2026 (audit item 17): Cancel and No-show ask first, take a reason,
// and say plainly when money is on file, because nothing refunds it by itself.
// 16 Oct 2026 (review): the sheet promises the 30 second Undo only when the Undo bar will be
// offered (canUndo, from undoCancelStatus), and never shows a money check that has failed as one
// still running.
function ConfirmSheet({ kind, name, reason, onReason, moneyLine, canUndo = false, busy, onBack, onConfirm }) {
  const isCancel = kind === 'cancel';
  const reasons = isCancel ? CANCEL_REASONS : NO_SHOW_REASONS;
  return (
    <div onClick={busy ? undefined : onBack} style={{ position: 'fixed', inset: 0, zIndex: 100002, background: 'rgba(8,9,12,0.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div role="dialog" aria-label={isCancel ? 'Cancel booking' : 'Mark no-show'} onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 380, padding: '16px 18px', borderRadius: 14, background: 'var(--bg1)', color: 'var(--t1)', border: `1.5px solid ${isCancel ? 'var(--bdr2)' : 'var(--red)'}`, boxShadow: '0 14px 40px rgba(0,0,0,.45)' }}>
        <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.35 }}>
          {isCancel ? `Cancel ${name}?` : `Mark ${name} as a no-show?`}
        </div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.45 }}>
          {isCancel
            ? (canUndo ? 'The table is freed straight away. You can undo for 30 seconds.' : 'The table is freed straight away. This cannot be undone here. The guest would need to book again.')
            : 'The table is freed and the guest\'s no-show count goes up by one.'}
        </div>
        {moneyLine && (
          <div role="status" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 9, background: tintBg('var(--orn)', 10), border: `1px solid ${tintBd('var(--orn)')}`, color: 'var(--orn)', fontSize: 13.5, fontWeight: 700, lineHeight: 1.4 }}>
            {moneyLine}
          </div>
        )}
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Reason</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {reasons.map((r) => <Chip key={r} active={reason === r} onClick={() => onReason(r)} style={{ height: 34, fontSize: 12, fontFamily: 'inherit' }}>{r}</Chip>)}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onBack} disabled={busy} style={{ flex: 1, height: 44 }}>Keep booking</button>
          <button className="btn btn-red" onClick={onConfirm} disabled={busy} style={{ flex: 1, height: 44, fontWeight: 800 }}>
            {busy ? 'Saving…' : isCancel ? 'Cancel booking' : 'Mark no-show'}
          </button>
        </div>
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
// [rows, failed]: rows null = not read yet, or the read failed (failed true).
function useBookingPayments(bookingId) {
  const [state, setState] = useState({ id: null, rows: null, failed: false });
  useEffect(() => {
    let alive = true;
    loadBookingPayments(bookingId).then((rows) => { if (alive) setState({ id: bookingId, rows, failed: rows === null }); });
    return () => { alive = false; };
  }, [bookingId]);
  return state.id === bookingId ? [state.rows, state.failed] : [null, false];
}

function PaymentState({ b, prepaid, rows }) {
  let line = null;
  if (rows && rows.length) {
    // Money that must go back is checked FIRST (10 Sep 2026 review): before
    // migration 20260910 its status stays captured and only the reason says
    // "NEEDS REFUND", so the captured branch used to show it as paid.
    const refundRow = rows.find(isNeedsRefundRow);
    const captured = rows.find((r) => r.status === 'captured' && r.kind !== 'refund' && !isNeedsRefundRow(r));
    const held = rows.find((r) => r.status === 'authorised' && r.kind === 'hold' && !isNeedsRefundRow(r));
    const refunded = rows.find((r) => r.status === 'refunded' || r.kind === 'refund');
    const failed = rows.find((r) => r.status === 'failed');
    const card = (r) => (r?.card_brand || r?.card_last4) ? ` (${[r.card_brand, r.card_last4 ? `···${r.card_last4}` : null].filter(Boolean).join(' ')})` : '';
    if (refundRow) {
      line = refundRow.kind === 'hold'
        ? { txt: 'Card saved after the booking closed. Nothing was taken.', col: 'var(--t3)' }
        : { txt: `${money(refundRow.amount, 2)} paid online after the booking closed. Refund the guest.`, col: 'var(--red)' };
    }
    else if (refunded) line = { txt: `Refund on file${card(refunded)}`, col: 'var(--orn)' };
    else if (captured) {
      const kind = captured.kind === 'prepay' ? 'prepaid' : captured.kind === 'deposit' ? 'deposit paid' : 'paid';
      const applied = captured.applied_to_check
        ? ' · applied to the check' : ' · shows as paid on the till';
      // 2dp: money() defaults to whole pounds, which would print a real £48.50
      // capture as £49. Never round a figure that was actually charged.
      line = { txt: `✓ ${money(captured.amount, 2)} ${kind} by card${card(captured)}${applied}`, col: 'var(--grn)' };
    }
    else if (held) line = { txt: `✓ Card saved${card(held)}. Nothing was taken.`, col: 'var(--grn)' };
    // 16 Oct 2026 (audit item 22): an expired booking with a stale pending row read
    // "payment pending, confirms by itself" about a booking the sweep had released.
    else if (b.status === 'expired') line = { txt: 'Payment not taken, booking released', col: 'var(--t4)' };
    else if (failed) {
      line = b.status === 'pending_payment'
        ? { txt: 'Card payment failed. The guest can still try again.', col: 'var(--red)' }
        : { txt: 'Card payment failed. Take payment at the venue.', col: 'var(--red)' };
    }
    else line = { txt: 'Card payment pending. It confirms by itself when the bank answers.', col: 'var(--t3)' };
  } else if (b.status === 'pending_payment') {
    line = { txt: 'Awaiting card payment. The guest has 20 minutes to pay before the booking expires and the table frees itself.', col: 'var(--orn)' };
  } else if (b.status === 'expired') {
    line = { txt: 'Payment not taken, booking released. The table is free again; the guest must book again.', col: 'var(--t4)' };
  } else if (prepaid) {
    line = { txt: 'No captured payment visible for this prepay booking yet. Check Back Office before treating it as paid.', col: 'var(--orn)' };
  } else if (CARD_IMPOSSIBLE_SOURCES.has(b.source || 'host')) {
    line = { txt: 'Taken at the venue, so no card is on file. Payment happens on the POS tab.', col: 'var(--t4)' };
  } else if (rows) {
    line = { txt: 'No card on file for this booking.', col: 'var(--t4)' };
  } else {
    line = { txt: 'Checking for a card on file…', col: 'var(--t4)' };
  }
  return <div style={{ fontSize: 15, marginTop: 6, lineHeight: 1.45, color: line.col, fontWeight: line.col === 'var(--red)' ? 700 : 500 }}>{line.txt}</div>;
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
export function Inspector({ b, nowMin, packages, tables, onClose, startMoving = false }) {
  const updateBooking = useStore((s) => s.updateBooking);
  const cancelBooking = useStore((s) => s.cancelBooking);
  const markBookingNoShow = useStore((s) => s.markBookingNoShow);
  const undoCancelBooking = useStore((s) => s.undoCancelBooking);
  const clock = useVenueClock();
  const [moving, setMoving] = useState(!!startMoving);
  // 16 Oct 2026: the Edit sheet (EditBookingSheet.jsx), shared with Back Office.
  const [editing, setEditing] = useState(false);
  // 16 Oct 2026 (audit item 17): Cancel and No-show ask first. 'cancel' | 'no_show' | null.
  const [confirmKind, setConfirmKind] = useState(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Undo cancel for 30 seconds: { id, before, until } and a 1 second clock for the countdown.
  const [undo, setUndo] = useState(null);
  const [undoNow, setUndoNow] = useState(0);
  const [undoMsg, setUndoMsg] = useState('');
  useEffect(() => {
    if (!undo) return undefined;
    const t = setInterval(() => {
      const n = Date.now();
      setUndoNow(n);
      if (n >= undo.until) setUndo(null);
    }, 1000);
    return () => clearInterval(t);
  }, [undo]);
  const operatorName = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  const venueTz = useStore((s) => s.locationConfig?.timezone);
  const edited = editedLine(b, fmtClock(venueTz));
  // Render-adjustment (not an effect — the repo lint forbids sync setState in
  // effects): selecting a different booking closes the move panel.
  const [movingFor, setMovingFor] = useState(b.id);
  if (movingFor !== b.id) { setMovingFor(b.id); setMoving(!!startMoving); setEditing(false); setConfirmKind(null); }
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
  const [payRows, payReadFailed] = useBookingPayments(b.id);
  // Money flagged to go back is never "on file" (isNeedsRefundRow).
  const capturedRow = (payRows || []).find((r) => r.status === 'captured' && r.kind !== 'refund' && !isNeedsRefundRow(r));
  const heldRow = (payRows || []).find((r) => r.status === 'authorised' && r.kind === 'hold' && !isNeedsRefundRow(r));
  const onFile = capturedRow || heldRow || null;
  const [undoErr, setUndoErr] = useState('');
  // 10 Sep 2026 payment gate: pending_payment, or a booking that owed money
  // with no successful payment on the ledger (payRows null = not read yet).
  const unpaid = bookingUnpaid({ booking: b, pkg, payments: payRows });

  // seatBooking REFUSES when any of the booking's tables still has a live POS tab
  // (overwriting one would destroy a real check). It reports that through a toast,
  // which the host stand never rendered, so the button simply looked broken. The
  // toast is fixed separately; this shows the reason at the button as well, because
  // a refusal the operator cannot see is the same as no refusal at all.
  const [seatErr, setSeatErr] = useState('');
  // 16 Oct 2026 (audit item 16): only the venue's today can be seated.
  const otherDayWhy = seatRefusal({ booking: b, today: clock.ymd, nowMin: clock.nowMin });
  // A table missing from the floor plan (audit item 21) and whether the party's
  // table really has a tab open (audit item 22: "tab open" only when true).
  const offPlanHere = tables.length > 0 && (b.tables || []).length > 0 && !(b.tables || []).some((id) => tables.some((t) => t.id === id));
  const primaryHasTab = !!tables.find((t) => t.id === b.primaryTableId)?.session;
  const seatNow = async () => {
    const seat = useStore.getState().seatBooking;
    if (typeof seat !== 'function') {
      updateBooking?.(b.id, { status: 'dining', seatedAt: Date.now() });
      return;
    }
    setSeatErr('');
    const res = await seat(b.id);
    if (res && res.ok === false) {
      setSeatErr(res.text ? res.text : res.error === 'table_open'
        ? 'Still has an open tab. Cash it off on the POS, or move this booking to a free table.'
        : res.error === 'table_seated_empty'
        ? 'Seated with no order yet. Cash it off on the POS or move the booking.'
        : (res.error || 'Could not open the tab for this booking.'));
    }
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
      d: prepaid ? `${pkg?.name || 'Package'} prepaid at booking, shows on the till as paid from seating`
        : capturedRow ? `${money(capturedRow.amount, 2)} already paid, shows on the till as paid from seating`
        : 'Card saved at booking. Nothing was taken.',
    }] : []),
    ...(pkg ? [{ t: 'Package', d: `${pkg.name}, lines queue to the POS carrying their courses` }] : []),
    {
      t: 'On the POS',
      d: b.status === 'dining' ? (primaryHasTab ? `Seated, tab open on ${labels[0] || 'the table'}` : 'Seated')
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
        {edited && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t3)', ...mono }}>{edited}</div>
        )}
      </div>

      {hasGuest(b.customer) && (
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
              {b.customer.allergens?.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700, textTransform: 'capitalize' }}>{b.customer.allergens.join(', ')}</div>
              )}
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
              : heldRow ? 'Card saved, nothing taken'
              : 'Nothing on file'}
          </span>
          {/* A figure only for money actually TAKEN. A hold row stores the rule's
              amount but Adyen was sent 0, so a green £40 beside a saved card read
              as £40 held (10 Sep 2026 review). */}
          {capturedRow && (
            <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--grn)', ...mono, flexShrink: 0 }}>
              {money(capturedRow.amount, 2)}
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
              <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{s2.d}</div>
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
          <>
            {/* 10 Sep 2026 payment gate: seating an unpaid booking stays allowed
                (the party is here), but the host must know the money is not in. */}
            {unpaid && (
              <div role="status" style={{ padding: '9px 11px', borderRadius: 9, background: tintBg('var(--orn)', 10), border: `1px solid ${tintBd('var(--orn)')}`, color: 'var(--orn)', fontSize: 15, fontWeight: 700, lineHeight: 1.4 }}>
                Not paid online, take payment on the till
              </div>
            )}
            {offPlanHere && (
              <div role="status" style={{ padding: '9px 11px', borderRadius: 9, background: tintBg('var(--orn)', 10), border: `1px solid ${tintBd('var(--orn)')}`, color: 'var(--orn)', fontSize: 13, fontWeight: 700, lineHeight: 1.4 }}>
                This booking is on a table that is not on the floor plan. Move it to a table before seating.
              </div>
            )}
            <button className="btn btn-acc" onClick={seatNow} disabled={!!otherDayWhy || offPlanHere}
              style={{ height: 44, fontWeight: 800, opacity: otherDayWhy || offPlanHere ? 0.5 : 1 }}>Seat now, open POS tab</button>
            {otherDayWhy && (
              <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.45, marginTop: -2 }}>{otherDayWhy}</div>
            )}
            {seatErr && (
              <div style={{ fontSize: 11.5, color: 'var(--red)', lineHeight: 1.45, marginTop: -2 }}>{seatErr}</div>
            )}
          </>
        )}
        {b.status === 'dining' && (
          <button className="btn btn-ghost" onClick={() => updateBooking?.(b.id, { status: 'departed', departedAt: Date.now() })} style={{ height: 44 }}>Mark departed</button>
        )}
        {/* A mis-tap on Mark departed or No-show used to be final: those statuses
            fail isLive, so the panel offered no buttons at all and the party was
            gone from the stand with no way back. Returns a seated party to dining.
            Anyone else goes back to confirmed ONLY when nothing was owed or a
            captured or authorised payment is on file; otherwise the booking was
            never paid and returns as expired (10 Sep 2026: No-show then Undo
            used to turn an unpaid booking into a confirmed one). */}
        {['departed', 'no_show'].includes(b.status) && (
          <>
            <button
              className="btn btn-ghost"
              // Waits for the payment ledger (10 Sep 2026 review): an unread
              // ledger used to look like "not paid" and expired a paid booking.
              disabled={!b.seatedAt && payRows === null && !payReadFailed}
              onClick={() => {
                setUndoErr('');
                if (b.seatedAt) { updateBooking?.(b.id, { status: 'dining', departedAt: null }); return; }
                const next = undoNoShowStatus({ booking: b, payments: payRows });
                if (!next) {
                  setUndoErr('Could not check the payment for this booking. Try again in a moment.');
                  return;
                }
                updateBooking?.(b.id, { status: next, departedAt: null });
              }}
              style={{ height: 44 }}
            >
              {b.status === 'departed' ? 'Undo departed' : 'Undo no-show'}
            </button>
            {undoErr && (
              <div role="alert" style={{ fontSize: 15, color: 'var(--red)', lineHeight: 1.45 }}>{undoErr}</div>
            )}
          </>
        )}
        {/* Three across a 262px panel on a narrow stand: minWidth 0 and tighter
            padding, or .btn's nowrap pushes the labels through the borders. */}
        {isLive(b) && b.status !== 'dining' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {/* 16 Oct 2026: Edit opens the full sheet (date, time, covers, guest,
                note, tables). Move stays as the quick table swap. */}
            <button className="btn btn-ghost" onClick={() => setEditing(true)} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12, fontWeight: 700 }}>Edit</button>
            <button className="btn btn-ghost" onClick={() => setMoving((m) => !m)} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>{moving ? 'Close' : offPlanHere ? 'Move to a table' : 'Move'}</button>
          </div>
        )}
        {/* 16 Oct 2026 review: a seated party shows Edit greyed with the reason
            in words, since an iPad never shows a tooltip. */}
        {b.status === 'dining' && (
          <div>
            <button className="btn btn-ghost" disabled style={{ width: '100%', height: 40, fontSize: 12, fontWeight: 700, opacity: 0.5 }}>Edit</button>
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.4 }}>{EDIT_REFUSALS.dining}</div>
          </div>
        )}
        {isLive(b) && b.status !== 'dining' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {/* markBookingNoShow, not a raw status write: it also bumps the guest's
                lifetime no-show count on the CRM record, which is what drives the
                card-hold prompt on their next booking. Not offered while the
                guest is still paying: an unpaid booking is not a no-show. */}
            {b.status !== 'pending_payment' && (
              <button className="btn btn-red" onClick={() => { setConfirmKind('no_show'); setConfirmReason(NO_SHOW_REASONS[0]); }} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>No-show</button>
            )}
            <button className="btn btn-ghost" onClick={() => { setConfirmKind('cancel'); setConfirmReason(CANCEL_REASONS[0]); }} style={{ flex: 1, minWidth: 0, height: 40, padding: '0 10px', fontSize: 12 }}>Cancel</button>
          </div>
        )}
        {/* 16 Oct 2026 (audit item 17): Undo cancel, for 30 seconds after a cancel here. */}
        {b.status === 'cancelled' && undo?.id === b.id && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--bg3)', border: '1px solid var(--bdr2)' }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>Booking cancelled</span>
            <button className="btn btn-ghost" disabled={confirmBusy}
              onClick={async () => {
                setConfirmBusy(true); setUndoMsg('');
                const res = await undoCancelBooking?.(b.id, { before: undo.before, payments: payRows });
                setConfirmBusy(false);
                setUndo(null);
                if (res && res.ok === false) setUndoMsg(res.error);
              }}
              style={{ height: 36, fontWeight: 800 }}>
              {confirmBusy ? 'Putting back…' : `Undo (${Math.max(0, Math.ceil(((undo.until) - (undoNow || undo.at)) / 1000))}s)`}
            </button>
          </div>
        )}
        {undoMsg && b.status === 'cancelled' && (
          <div role="alert" style={{ fontSize: 13, color: 'var(--red)', lineHeight: 1.45 }}>{undoMsg}</div>
        )}
      </div>
      {confirmKind && (
        <ConfirmSheet
          kind={confirmKind}
          name={bookingName(b)}
          reason={confirmReason}
          onReason={setConfirmReason}
          moneyLine={payReadFailed && !Array.isArray(payRows)
            ? 'Could not check for money on this booking. Check Back Office before refunding.'
            : moneyOnFileLine(payRows, (v) => money(v, 2)).line}
          canUndo={!!undoCancelStatus({ before: b.status, booking: b, payments: payRows })}
          busy={confirmBusy}
          onBack={() => setConfirmKind(null)}
          onConfirm={async () => {
            setConfirmBusy(true);
            const before = b.status;
            let res;
            if (confirmKind === 'cancel') {
              res = await cancelBooking?.(b.id, { reason: confirmReason });
              if (res?.ok !== false && undoCancelStatus({ before, booking: b, payments: payRows })) {
                const at = Date.now();
                setUndoNow(at);
                setUndo({ id: b.id, before, at, until: at + UNDO_CANCEL_MS });
              }
            } else {
              res = await (markBookingNoShow ? markBookingNoShow(b.id, { reason: confirmReason }) : updateBooking?.(b.id, { status: 'no_show' }));
            }
            setConfirmBusy(false);
            setConfirmKind(null);
          }}
        />
      )}
      {editing && (
        <EditBookingSheet b={b} editedBy={operatorName} onClose={() => setEditing(false)} />
      )}
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
  const addRow = () => setRows((rs) => [...rs, { seat: Math.min((rs.at(-1)?.seat || 0) + 1, b.covers), guestName: '', itemId: choices[0]?.itemId || null, displayName: choices[0]?.displayName || '', course: choices[0]?.course ?? 0, notes: '', mods: [], variantItemId: null, variantName: null }]);

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
          {rows.map((r, i) => {
            // 10 Sep 2026: the size and options the guest chose online.
            const picked = choiceSummary(r);
            return (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={r.seat || 1} onChange={(e) => patchRow(i, { seat: Number(e.target.value) })} style={{ ...inp, width: 62 }}>
                {Array.from({ length: b.covers }, (_, s) => <option key={s + 1} value={s + 1}>S{s + 1}</option>)}
              </select>
              <input value={r.guestName} placeholder="Name" onChange={(e) => patchRow(i, { guestName: e.target.value })} style={{ ...inp, flex: '1 1 70px', minWidth: 0 }} />
              <select
                value={`${r.itemId || ''}|${r.displayName}`}
                onChange={(e) => {
                  const c = choices.find((x) => `${x.itemId || ''}|${x.displayName}` === e.target.value);
                  // A different dish: the guest's size and options belonged to
                  // the old one, so they clear. Seat or name edits keep them.
                  if (c) patchRow(i, { itemId: c.itemId || null, displayName: c.displayName, course: c.course ?? 0, mods: [], variantItemId: null, variantName: null });
                }}
                style={{ ...inp, flex: '2 1 120px', minWidth: 0 }}>
                {choices.map((c) => <option key={`${c.itemId || ''}|${c.displayName}`} value={`${c.itemId || ''}|${c.displayName}`}>{c.displayName} · {PO_COURSE_LABEL[c.course ?? 0] || `Course ${c.course}`}</option>)}
              </select>
              <span title={PO_COURSE_LABEL[r.course ?? 0] || `Course ${r.course}`} style={{
                flexShrink: 0, fontSize: 10, fontWeight: 800, padding: '3px 7px', borderRadius: 999, ...mono,
                color: courseColor(r.course), background: tintBg(courseColor(r.course), 12), border: `1px solid ${tintBd(courseColor(r.course), 30)}`,
              }}>{PO_COURSE_SHORT[r.course ?? 0] || `C${r.course}`}</span>
              <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 14, padding: 2 }}>×</button>
              {(picked || r.notes) && (
                <div style={{ flexBasis: '100%', paddingLeft: 68, fontSize: 15, lineHeight: 1.4, color: 'var(--t2)' }}>
                  {picked && <div>{picked}</div>}
                  {r.notes && <div style={{ color: 'var(--t3)' }}>Note: {r.notes}</div>}
                </div>
              )}
            </div>
            );
          })}
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
  // 16 Oct 2026: the venue clock (audit item 8), so open tabs block the right window.
  const clock = useVenueClock();
  const opt = useMemo(() => {
    const base = dayBookings.map(toOptimiserBooking).filter(Boolean);
    if (bookingsDate && bookingsDate !== clock.ymd) return base;
    return [...base, ...sessionsToBlocks(storeTables, dayBookings, rulesOf(bookingRules).turnBands, clock.nowMin, epochToVenueMin(clock.tz))];
  }, [dayBookings, storeTables, bookingRules, bookingsDate, clock.ymd, clock.nowMin, clock.tz]);
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
