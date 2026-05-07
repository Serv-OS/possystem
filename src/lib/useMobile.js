import { useState, useEffect } from 'react';

// True when the viewport is phone-sized — the threshold for switching to MPOS
// portrait layouts. iPhone SE: 375pt, iPhone 16 Pro: 402pt, Pixel 8: 412pt,
// Sunmi V2s Plus: 720x1280 / DPR 2 → logical ~360pt. Anything under 540 is
// "phone", 540-900 is tablet portrait, above is desktop/landscape.
export function useMobile() {
  const check = () => typeof window !== 'undefined' && window.innerWidth < 540;
  const [mobile, setMobile] = useState(check);
  useEffect(() => {
    const handler = () => setMobile(check());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return mobile;
}
