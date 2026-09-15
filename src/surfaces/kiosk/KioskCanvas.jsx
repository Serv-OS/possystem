/**
 * KioskCanvas: the 1080 design px wide box every new kiosk design screen draws in.
 *
 * The README is a fixed 1080 by 1920 portrait layout. Screens use its px values as they
 * are, and this box scales them to the real screen with CSS zoom (kioskCanvasSize in
 * lib/kioskFlow.js). If a device ever draws blurry or misplaces taps under zoom, the
 * fallback is transform: scale() on a fixed size box.
 *
 * Rules for everything inside:
 *   - no vw, vh or clamp values (they read the real screen, not the canvas)
 *   - no position: fixed (overlays are position: absolute inside the canvas)
 *   - sizes are the README px values
 */
import { useEffect, useState } from 'react';
import { kioskCanvasSize, nextViewport } from '../../lib/kioskFlow';

function readViewport() {
  if (typeof window === 'undefined') return nextViewport(null, 0, 0);
  return nextViewport(null, window.innerWidth, window.innerHeight);
}

function isTyping() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
}

export default function KioskCanvas({ children }) {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const onResize = () => setViewport(prev => nextViewport(prev, window.innerWidth, window.innerHeight, isTyping()));
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const { scale, width, height } = kioskCanvasSize(viewport);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div
        data-kiosk-canvas=""
        style={{
          position: 'relative',
          width,
          height,
          zoom: scale,
          flex: 'none',
          overflow: 'hidden',
          background: 'var(--k2Ground)',
          color: 'var(--k2Ink)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}
