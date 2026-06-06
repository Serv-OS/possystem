import { useState, useEffect } from 'react';

// Returns true when the viewport is smaller than typical desktop
// Sunmi D3 Pro: 1920x1080 physical, DPR ~1.5-2 → logical ~960-1280px wide
// Sunmi T2: 1366x768 physical, DPR 1 → logical 1366px wide
// v5.5.360: lowered to 1280×760 so normal laptops/monitors get the FULL
// (ServOS reference-size) layout instead of the cramped compact one. The
// reference design is ~1480×920; the old 1600/950 threshold forced almost
// every screen into compact, making the POS read small. Genuinely small
// Sunmi screens (<1280 wide / <760 tall) still get compact so they fit.
export function useCompact() {
  const check = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return w < 1280 || h < 760;
  };
  const [compact, setCompact] = useState(check);
  useEffect(() => {
    const handler = () => setCompact(check());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return compact;
}
