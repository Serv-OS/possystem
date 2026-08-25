// src/surfaces/bookings/FloorScreen.jsx
//
// Floor — live from POS (README §2). The store's floor plan drawn to scale,
// coloured by what the table is doing RIGHT NOW (POS session / active booking /
// upcoming booking / free), a dashed join outline around multi-table parties,
// and a right panel that seats walk-ins through the same optimiser the Book
// flow uses (next quarter hour, top candidate highlighted on the plan).

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { toMin, toHM } from '../../lib/bookings/optimiser.js';
import {
  mono, tintBg, tintBd, rulesOf, displayStatus, useNowMin, money,
  sessionTotal, bookingName, todayISO, isLive, useNarrowStand,
} from './bits.jsx';

// The POS's exact table colours (TablesSurface.jsx STATUS map) — one visual
// language across till and host stand.
const POS_FREE = '#22c55e';
const POS_SEATED = '#60a5fa';
const POS_OCCUPIED = '#e8a020';
const POS_RESERVED = '#a855f7';

const PAD = 10;

// Does this string actually fit the bubble? MEASURED with the real font rather
// than guessed from a characters-times-em constant, which was wrong often enough
// to leave "Open tab" and "6 se..." sliced on the plan. Cached per string+size.
const textWidth = (() => {
  let ctx = null;
  let fams = null;
  const cache = new Map();
  return (text, size, weight, family = 'body') => {
    const key = `${family}|${weight}|${size}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (!ctx && typeof document !== 'undefined') {
      ctx = document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(document.body);
      // The third line is MONOSPACE, which is far wider than the body face at the
      // same size. Measuring it with the body font is what left "6 seats" sliced.
      fams = { body: cs.fontFamily || 'sans-serif', mono: cs.getPropertyValue('--font-mono') || 'monospace' };
    }
    if (!ctx) return String(text).length * size * 0.62; // no canvas: conservative guess
    ctx.font = `${weight} ${size}px ${fams[family] || fams.body}`;
    const w = ctx.measureText(String(text)).width;
    cache.set(key, w);
    return w;
  };
})();

// onPickBooking: parent (Service view) selects the tile's booking for its
// inspector. showWalkIn: the Service view hides the walk-in panel while its
// inspector occupies the right edge. Standalone use keeps both defaults.
export default function FloorScreen({ onPickBooking = null, showWalkIn = true }) {
  const tables = useStore((s) => s.tables) || [];
  const bookings = useStore((s) => s.bookings) || [];
  const packages = useStore((s) => s.packages) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const rules = rulesOf(bookingRules);
  const isToday = !bookingsDate || bookingsDate === todayISO();
  const nowMin = useNowMin();
  const statusNow = isToday ? nowMin : null;

  const narrow = useNarrowStand();
  // Portrait on an iPad leaves about 300px beside the two panels, which is not a
  // floor plan, it is a postage stamp. Below this width the walk-in panel moves
  // UNDER the plan so the plan gets the full width of the stand.
  const stacked = useNarrowStand(950);
  const [walk, setWalk] = useState(2);
  const [seating, setSeating] = useState(false);
  const [msg, setMsg] = useState('');
  // Walk-ins are still guests: taking a name and a mobile means the party shows by
  // name on the floor and in the tabs list, and the number is there to chase them
  // if they wander off with the table (Peter, 25 Aug). Both stay OPTIONAL, because
  // a queue at the door will not wait for typing.
  const [walkName, setWalkName] = useState('');
  const [walkPhone, setWalkPhone] = useState('');

  const floorTables = useMemo(() => tables.filter((t) => !t.parentId), [tables]);

  // ── scale-to-fit ────────────────────────────────────────────────────────────
  const wrapRef = useRef(null);
  const [wrapSize, setWrapSize] = useState({ w: 900, h: 440 });
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth, h = el.clientHeight;
      // Screens stay mounted and hide with display:none, and a hidden pane measures
      // 0x0. Storing that would recompute the fit at minimum scale, so switching to
      // another tab and back would paint the plan tiny before it snapped back.
      // The equality bailout stops every no-op observer fire re-rendering every tile.
      if (w > 0 && h > 0) setWrapSize((p) => (p.w === w && p.h === h ? p : { w, h }));
    };
    measure(); // in a LAYOUT effect, so the seeded size above is never painted
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bounds = useMemo(() => {
    let mx = 1, my = 1;
    for (const t of floorTables) { mx = Math.max(mx, (t.x || 0) + (t.w || 60)); my = Math.max(my, (t.y || 0) + (t.h || 60)); }
    return { mx, my };
  }, [floorTables]);
  // Fit MUST fit. The old floor of 0.5 meant a wide floor plan needing 0.48 was
  // forced to 0.5 and silently ran off the right edge of the pane, hiding whole
  // tables on an 11 inch iPad while the button still claimed "Fit" (Peter, 25 Aug:
  // bar tables B5..B9 were simply not on screen). MIN_SCALE is a legibility floor
  // only, and the manual zoom-out floor matches it so the two agree.
  const MIN_SCALE = 0.28;
  const fitScale = Math.max(
    MIN_SCALE,
    Math.min((wrapSize.w - PAD * 2) / bounds.mx, (wrapSize.h - PAD * 2 - 18) / bounds.my),
  );
  // Zoom controls MATCH THE POS floor plan (v4.6.57 system): auto-fit until
  // the user zooms, − / + step 0.1, Fit snaps back to auto.
  const [zoom, setZoom] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const scale = autoFit ? fitScale : zoom;
  const zoomOut = () => { setAutoFit(false); setZoom(+Math.max(MIN_SCALE, (autoFit ? fitScale : zoom) - 0.1).toFixed(2)); };
  const zoomIn = () => { setAutoFit(false); setZoom(+Math.min(1.6, (autoFit ? fitScale : zoom) + 0.1).toFixed(2)); };

  // ── what each table is doing right now ──────────────────────────────────────
  const activeNow = useMemo(() => bookings.filter((b) => {
    if (!isLive(b)) return false;
    // A SEATED party is active until someone marks them departed. The turn band is
    // an estimate of how long they will stay, never evidence that they left, so
    // keying on it made a dining table quietly stop being its booking the moment
    // the estimate elapsed: it lost its guest name and stopped opening the booking
    // when tapped, while the party was still sitting there with an open tab.
    if (b.status === 'dining') return true;
    if (!Number.isFinite(statusNow)) return false;
    const s = toMin(b.startTime);
    return statusNow >= s - 15 && statusNow < s + (b.turnMinutes || 90);
  }), [bookings, statusNow]);

  const nextFor = (tableId) => bookings
    .filter((b) => isLive(b) && b.status === 'confirmed' && (b.tables || []).includes(tableId)
      && (!Number.isFinite(statusNow) || toMin(b.startTime) > statusNow))
    .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0] || null;

  // How many bookings still to COME on this table today (Peter, 13 Aug: a
  // walk-in should go on a table with nothing left tonight — no chip = clear).
  const upcomingCount = (tableId) => bookings.filter((b) =>
    isLive(b) && b.status !== 'dining' && (b.tables || []).includes(tableId)
    && (!Number.isFinite(statusNow) || toMin(b.startTime) > statusNow)).length;

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
    const { createBooking } = useStore.getState();
    const name = walkName.trim();
    const phone = walkPhone.trim();
    // Create as CONFIRMED, then seat through seatBooking, the same door every
    // other booking goes through. Writing status:'dining' straight into the row
    // skipped all of it: no POS tab ever opened for a walk-in (so nothing could
    // be rung in against the table), no guard against seating onto a table that
    // already had a live check, and no guest or server on the session.
    const res = createBooking ? await createBooking({
      covers: walk, time: nextQ, tables: sug.set, primaryTableId: sug.set[0],
      source: 'walk_in', status: 'confirmed',
      customer: (name || phone) ? { name: name || 'Walk-in', phone: phone || null } : null,
    }) : { ok: false, error: 'Bookings store not wired' };
    if (res.ok) {
      const seat = useStore.getState().seatBooking;
      const seated = seat ? await seat(res.booking.id) : null;
      if (seated && seated.ok === false) {
        // seatBooking already toasts the reason; the booking stays on the diary
        // as confirmed so the host can move it or cash the old tab off.
        setMsg(seated.error === 'table_open'
          ? `${sug.label} still has an open tab, booking held on the diary`
          : 'Could not open the tab, booking held on the diary');
      } else {
        setMsg(`Seated ${name || 'walk-in'} on ${sug.label}`);
      }
      setWalkName(''); setWalkPhone('');
    }
    else setMsg(res.error || 'Could not seat the party');
    setSeating(false);
  };

  const openTabs = floorTables.filter((t) => t.session);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: stacked ? 'column' : 'row' }}>
      {/* ── canvas ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>Floor — live from POS</span>
          <span style={{ flex: 1 }} />
          {/* The legend wraps onto a second row on a portrait stand and shoves the
              zoom controls down with it. The plan itself matters more than its key. */}
          {!stacked && (
            <>
              <Legend col={POS_FREE} label="Free" />
              <Legend col={POS_SEATED} label="Seated" />
              <Legend col={POS_OCCUPIED} label="Occupied" />
              <Legend col={POS_RESERVED} label="Booked" />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)' }}>
                <span style={{ width: 14, height: 8, border: `1.5px dashed ${tintBd('var(--acc)', 55)}`, borderRadius: 3 }} /> Joined
              </span>
            </>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
            <button onClick={zoomOut} title="Zoom out"
              style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>−</button>
            <span style={{ fontSize: 11, color: 'var(--t3)', minWidth: 38, textAlign: 'center', ...mono }}>{Math.round(scale * 100)}%</span>
            <button onClick={zoomIn} title="Zoom in"
              style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+</button>
            <button onClick={() => { setAutoFit(true); setZoom(1); }} title="Auto-fit to viewport"
              style={{ height: 24, padding: '0 8px', borderRadius: 6, border: 'none', background: autoFit ? 'var(--acc-d)' : 'var(--bg3)', color: autoFit ? 'var(--acc)' : 'var(--t2)', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '.07em' }}>Fit</button>
          </span>
        </div>
        <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, overflow: 'auto', display: 'flex' }}>
          {/* margin:auto centres the plan in a pane that is usually taller than the
              plan, and (unlike flex centring) still scrolls to the true top-left
              when the plan is the bigger one. */}
          <div style={{ position: 'relative', width: bounds.mx * scale + PAD * 2, height: bounds.my * scale + PAD * 2, margin: 'auto', flexShrink: 0 }}>
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
            // Session colours MATCH THE POS (TablesSurface STATUS map): a check
            // with items = Occupied orange, seated-nothing-ordered = light blue.
            // Same table, same colour, till or host stand (Peter, 13 Aug).
            // A JOINED party has ONE check, on the primary table, so the member
            // tables carry no session of their own. Colouring a member by the
            // absence of a session painted it the same green as an empty table,
            // which is the one thing it is not: ten people are sitting at it
            // (Peter, 25 Aug). A member borrows the party's colour instead.
            const partySession = t.session || (active
              ? floorTables.find((x) => x.id === active.primaryTableId)?.session
              : null) || null;
            const sessCol = partySession
              ? ((partySession.items || []).filter((i) => !i.voided).length ? POS_OCCUPIED : POS_SEATED)
              : null;
            const col = active
              ? (st === 'late' ? 'var(--red)' : st === 'due' ? 'var(--orn)' : (sessCol || 'var(--acc)'))
              : sessCol
              || (next ? POS_RESERVED : POS_FREE);
            const hot = sugSet.has(t.id);
            // Type is sized FROM the bubble, and the line count is derived from the
            // height the type actually needs, so nothing is ever sliced in half at
            // any zoom. Round tables get a narrower text box: a circle's usable
            // width at the top and bottom of the stack is far less than its box.
            const rw = (t.w || 60) * scale, rh = (t.h || 60) * scale;
            const round = t.shape === 'rd';
            const infoSize = Math.min(10, Math.max(7, Math.round(rh * 0.22)));
            const inner = rh - 8;
            const textW = round ? '74%' : '92%';
            // border-box: the 2px border on each side is INSIDE rw, and the text
            // line's maxWidth percentage applies to that shrunken content box.
            const textPx = Math.max(0, (rw - 4) * (round ? 0.74 : 0.92) - 1);
            // The table's own name always shows, so shrink it until it fits rather
            // than letting it ellipsis into something unreadable at low zoom.
            const label = String(t.label || t.id);
            let labelSize = Math.min(13, Math.max(6, Math.round(rh * 0.30)));
            while (labelSize > 6 && textWidth(label, labelSize, 800) > textPx) labelSize -= 1;
            const labelH = labelSize * 1.15;
            const infoH = infoSize * 1.3;
            const lines = inner >= labelH + infoH * 2 ? 3 : inner >= labelH + infoH ? 2 : 1;
            // A bar stool at fit scale is about 34px across, where "6 seats" turns
            // into "6 se...". Try shorter wordings first, and if none of them fit,
            // render NO line at all: an ellipsised unit reads as broken, while the
            // colour and the table name still carry the state on their own.
            const fits = (s, family) => textWidth(s, infoSize, 600, family) <= textPx;
            const pick = (...cands) => cands.find((c) => fits(c, 'body')) || null;
            const pickMono = (...cands) => cands.find((c) => fits(c, 'mono')) || null;
            const covers = (n) => pickMono(`${n} cvr`, `${n}`);

            const firstWord = (s) => String(s || '').split(' ')[0];
            const isFree = !active && !t.session && !next;
            const line2 = active ? pick(bookingName(active), firstWord(bookingName(active)))
              : t.session ? (t.session.server
                  ? pick(t.session.server, firstWord(t.session.server))
                  : pick('Open tab', 'Tab'))
              : next ? pick(String(next.startTime || '').slice(0, 5))
              : pick('free');
            const line3 = active ? pickMono(
                `${active.covers} cvr · ${String(active.startTime || '').slice(0, 5)}`,
                `${active.covers} cvr`, `${active.covers}`)
              : t.session ? covers(t.session.covers || '—')
              : next ? pickMono(bookingName(next), firstWord(bookingName(next)))
              : pickMono(`${t.maxCovers || 0} seats`, `${t.maxCovers || 0}`);
            // In 2-line mode a free table is better served by its seat count than by
            // the word "free", which the colour already says.
            const slot2 = lines === 2 && isFree ? line3 : line2;
            const later = upcomingCount(t.id);
            // seatBooking stamps the booking id onto the session it opens, so a
            // table with a tab can always find its way back to its booking even if
            // the booking has fallen out of activeNow for any reason.
            const seatedBookingId = t.session?.booking?.bookingId || null;
            const fromSession = seatedBookingId
              ? bookings.find((bk) => bk.id === seatedBookingId) || null
              : null;
            const pickTarget = active || fromSession || next || null;
            return (
              <div key={t.id}
                onClick={onPickBooking && pickTarget ? () => onPickBooking(pickTarget.id) : undefined}
                title={later > 0 ? `${later} booking${later === 1 ? '' : 's'} still to come on ${t.label || t.id} today` : undefined}
                style={{
                position: 'absolute',
                left: PAD + (t.x || 0) * scale, top: PAD + (t.y || 0) * scale,
                width: rw, height: rh,
                borderRadius: t.shape === 'rd' ? '50%' : 12,
                border: `2px solid ${hot ? 'var(--acc)' : tintBd(col, 45)}`,
                background: hot ? tintBg('var(--acc)', 18) : tintBg(col),
                boxShadow: hot ? `0 0 0 4px ${tintBg('var(--acc)', 15)}` : 'none',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                overflow: 'visible', textAlign: 'center',
                // NOT "all": left/top/width/height are all scale-driven, so every
                // zoom press animated 30 boxes and any scale correction crawled for
                // 140ms instead of snapping. Only the status colours should move.
                transition: 'background 140ms cubic-bezier(.2,.8,.3,1), border-color 140ms cubic-bezier(.2,.8,.3,1), box-shadow 140ms cubic-bezier(.2,.8,.3,1)',
                cursor: onPickBooking && pickTarget ? 'pointer' : 'default',
              }}>
                {later > 0 && (
                  <span style={{
                    position: 'absolute', top: -7, right: -7, minWidth: 17, height: 17, padding: '0 4px',
                    borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 9.5, fontWeight: 800, ...mono,
                    background: 'var(--uv)', color: 'var(--bg)', border: '1.5px solid var(--bg1)', zIndex: 2,
                  }}>{later}</span>
                )}
                <div style={{ fontSize: labelSize, fontWeight: 800, color: col, lineHeight: 1.15, maxWidth: textW, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                {lines >= 2 && slot2 && (
                  <div style={{ fontSize: infoSize, fontWeight: 600, color: 'var(--t2)', lineHeight: 1.3, maxWidth: textW, whiteSpace: 'nowrap' }}>{slot2}</div>
                )}
                {lines >= 3 && line3 && (
                  <div style={{ fontSize: infoSize, color: 'var(--t3)', lineHeight: 1.3, maxWidth: textW, whiteSpace: 'nowrap', ...mono }}>{line3}</div>
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* ── right panel ── */}
      {showWalkIn && (
      <div style={stacked
        ? { flexShrink: 0, maxHeight: '38%', background: 'var(--bg1)', borderTop: '1px solid var(--bdr)', overflowY: 'auto', padding: 12 }
        : { width: narrow ? 262 : 330, flexShrink: 0, background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', overflowY: 'auto', padding: narrow ? 12 : 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }}>Seat a walk-in</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
            <button key={n} onClick={() => setWalk(n)} style={{
              width: 36, height: 34, borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, ...mono,
              background: walk === n ? tintBg('var(--acc)') : 'var(--inset, var(--bg3))',
              border: `1.5px solid ${walk === n ? tintBd('var(--acc)') : 'var(--bdr)'}`,
              color: walk === n ? 'var(--acc)' : 'var(--t2)',
              transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
            }}>{n}</button>
          ))}
        </div>

        {/* Optional guest capture. Blank is fine and seats exactly as before. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          <input
            className="input" value={walkName} onChange={(e) => setWalkName(e.target.value)}
            placeholder="Name (optional)" autoComplete="off"
            style={{ width: '100%', height: 36, boxSizing: 'border-box', fontSize: 12.5 }} />
          <input
            className="input" value={walkPhone} onChange={(e) => setWalkPhone(e.target.value)}
            placeholder="Mobile (optional)" type="tel" inputMode="tel" autoComplete="off"
            style={{ width: '100%', height: 36, boxSizing: 'border-box', fontSize: 12.5, ...mono }} />
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
      )}
    </div>
  );
}

const Legend = ({ col, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--t3)' }}>
    <span style={{ width: 8, height: 8, borderRadius: 999, background: col }} /> {label}
  </span>
);
