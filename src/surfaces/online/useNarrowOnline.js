// src/surfaces/online/useNarrowOnline.js
//
// True under 640px: the online page's phone layout (header block stacks, search becomes an icon).
// Same seam as bookings' useNarrowStand. Its own file so OnlineHeaderBlock.jsx exports only components.
import { useCallback, useSyncExternalStore } from 'react';

export const NARROW_PX = 640;

export function useNarrowOnline(breakpoint = NARROW_PX) {
  const q = `(max-width: ${breakpoint}px)`;
  const subscribe = useCallback((cb) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mq = window.matchMedia(q);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  }, [q]);
  const read = useCallback(
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false),
    [q],
  );
  return useSyncExternalStore(subscribe, read, () => false);
}
