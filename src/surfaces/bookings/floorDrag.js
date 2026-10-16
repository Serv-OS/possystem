// src/surfaces/bookings/floorDrag.js
//
// Drag a party onto a table on the floor (16 Oct 2026, v5.11.70 host tools,
// the plan's Later item, reusing the Timeline drag's feel). Two sources:
//   - a booked table on the floor plan  (mode 'move': same time, new table)
//   - a waiting party in the Service list (mode 'seat': move it there and seat it now)
// A finger lifts a party after a press and hold (a quick swipe still scrolls),
// a mouse after a small move. While it is held the table under the pointer
// lights green when free or red with the reason (floorDrop in
// supabase/functions/_shared/bookingHost.js, tested). Letting go over a table
// opens a one tap confirm (FloorDragLayer.jsx). Tables carry
// data-floor-table="<id>", so the drop is found with one hit test.
//
// A tiny external store, not React state: the rail and the floor are separate
// components, both read the same drag, and only one drag can run at a time.
// dragHandlers() is a plain function (not a hook), so a list can spread it on
// every row and every table.

import { useSyncExternalStore } from 'react';

const LONG_PRESS_MS = 350;
const MOVE_PX = 6;

let state = { drag: null, drop: null };
// drag: { booking, mode, x, y, overId }   drop: { booking, mode, tableId, x, y }
const subs = new Set();
const emit = () => { for (const f of subs) f(); };
const set = (patch) => { state = { ...state, ...patch }; emit(); };

export function useFloorDragState() {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => state,
    () => state,
  );
}
export const clearFloorDrop = () => set({ drop: null });

const tableUnder = (x, y) => {
  try {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest('[data-floor-table]') : null;
    return hit ? hit.getAttribute('data-floor-table') : null;
  } catch { return null; }
};

// The one press in progress: { bookingId, booking, mode, pointerId, x0, y0, armed, timer, target, cleanup }
let press = null;
// The click a browser sends after a drag is swallowed once (by booking id, within a second).
let swallow = { id: null, until: 0 };

function stop(dropIt) {
  const d = press;
  press = null;
  if (!d) return;
  if (d.timer) clearTimeout(d.timer);
  d.cleanup?.();
  const cur = state.drag;
  if (!cur) return;
  if (dropIt && cur.overId) set({ drag: null, drop: { booking: cur.booking, mode: cur.mode, tableId: cur.overId, x: cur.x, y: cur.y } });
  else set({ drag: null });
}

function arm(d, x, y) {
  d.armed = true;
  swallow = { id: d.bookingId, until: Date.now() + 60 * 60 * 1000 };
  try { d.target?.setPointerCapture?.(d.pointerId); } catch { /* works without capture */ }
  try { navigator.vibrate?.(10); } catch { /* no haptics */ }
  const onMove = (e) => {
    if (e.pointerId !== d.pointerId || !state.drag) return;
    set({ drag: { ...state.drag, x: e.clientX, y: e.clientY, overId: tableUnder(e.clientX, e.clientY) } });
  };
  const onUp = (e) => {
    if (e.pointerId !== d.pointerId) return;
    swallow = { id: d.bookingId, until: Date.now() + 1000 };
    stop(true);
  };
  const onCancel = (e) => { if (e.pointerId === d.pointerId) stop(false); };
  const noScroll = (e) => { e.preventDefault(); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  document.addEventListener('touchmove', noScroll, { passive: false });
  d.cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('touchmove', noScroll);
  };
  set({ drop: null, drag: { booking: d.booking, mode: d.mode, x, y, overId: tableUnder(x, y) } });
}

// Handlers (and the touch styles) for one drag source. Disabled: an empty object.
export function dragHandlers(booking, mode = 'move', enabled = true) {
  if (!enabled || !booking) return {};
  return {
    onPointerDown: (e) => {
      if (press || state.drag || state.drop) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const d = { bookingId: booking.id, booking, mode, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, armed: false, timer: null, target: e.currentTarget, cleanup: null };
      press = d;
      if (e.pointerType !== 'mouse') {
        d.timer = setTimeout(() => { d.timer = null; if (press === d) arm(d, d.x0, d.y0); }, LONG_PRESS_MS);
      }
    },
    onPointerMove: (e) => {
      const d = press;
      if (!d || d.armed || e.pointerId !== d.pointerId) return;
      if (Math.abs(e.clientX - d.x0) <= MOVE_PX && Math.abs(e.clientY - d.y0) <= MOVE_PX) return;
      if (e.pointerType === 'mouse') arm(d, e.clientX, e.clientY);
      else stop(false); // moved before the hold finished: a swipe, let it scroll
    },
    onPointerUp: (e) => {
      const d = press;
      if (d && !d.armed && e.pointerId === d.pointerId) stop(false); // a tap: the click handler runs
    },
    onClickCapture: (e) => {
      if (swallow.id === booking.id && Date.now() < swallow.until) {
        swallow = { id: null, until: 0 };
        e.stopPropagation();
        e.preventDefault();
      }
    },
    onContextMenu: (e) => e.preventDefault(),
  };
}

export const DRAG_SOURCE_STYLE = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-x pan-y' };
