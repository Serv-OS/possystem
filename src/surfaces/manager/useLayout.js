// src/surfaces/manager/useLayout.js
//
// The only React part of the Manager layout. ManagerSurface subscribes ONCE to the live
// viewport and provides the result; every screen reads it with useLayout(). The default is
// PHONE, so a host with no provider (any other surface that renders an Ops view) lays out
// exactly as it always has. Same seam as useNarrowStand in bookings/bits.jsx.
import { createContext, useContext, useSyncExternalStore } from 'react';
import { layoutFor, PHONE } from './layout';

export const LayoutContext = createContext(PHONE);

export function useLayout() { return useContext(LayoutContext); }

function subscribe(cb) {
  if (typeof window === 'undefined') return () => {};
  // iOS can fire orientationchange before the new size is readable, so ask once more on
  // the next frame.
  let raf = 0;
  const turned = () => { cb(); raf = requestAnimationFrame(cb); };
  window.addEventListener('resize', cb);
  window.addEventListener('orientationchange', turned);
  return () => {
    window.removeEventListener('resize', cb);
    window.removeEventListener('orientationchange', turned);
    cancelAnimationFrame(raf);
  };
}

// layoutFor hands back the same frozen object for the same band and column counts, so this
// snapshot is stable between the points where the layout really changes.
function getSnapshot() {
  const el = document.documentElement;
  return layoutFor(el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
}

export function useViewportLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => PHONE);
}
