// src/lib/kioskKeyboard.js
//
// v5.11.108 (28 Oct 2026, a customer on the kiosk: "when inputting details in the text box, the
// keyboard floats over the box itself making it very tricky to see what you have typed"). One
// helper for every box a customer types in on the kiosk:
//
//   ensureKioskViewportMeta()  adds interactive-widget=resizes-content to the viewport meta, so
//                              Android (Chrome 108+ and its WebView) shrinks the page for the
//                              keyboard instead of drawing over it.
//   useKioskKeyboardLift(ref)  for a sheet drawn at the bottom of the new design's canvas: while a
//                              box inside it has focus, how many design px of it the keyboard
//                              covers (window.visualViewport height and offsetTop against the
//                              canvas's bottom, worked out from its unzoomed parent and its
//                              style.zoom, followed on resize and scroll). The sheet sets its
//                              bottom to that, so it shrinks above the keyboard and its Add
//                              button stays on screen. The canvas keeps its full height while a
//                              box is typed in (lib/kioskFlow.js nextViewport), so without this
//                              the keyboard covers the bottom of the sheet on Android and iPad.
//   kioskRevealOnFocus         an onFocus handler: once the keyboard is up (the visual viewport
//                              resizes, or 350 and 700 ms on), the box is scrolled to the middle
//                              of the nearest scrolling box it sits in.
//
// The arithmetic is pure and tested (kioskKeyboard.test.js); the DOM parts never throw.

import { useEffect, useRef, useState } from 'react';

export const KIOSK_VIEWPORT_KEY = 'interactive-widget=resizes-content';

/** The viewport meta content with interactive-widget=resizes-content added once. */
export function withInteractiveWidget(content) {
  const parts = String(content || '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((p) => !/^interactive-widget\s*=/i.test(p));
  if (!parts.some((p) => /^width\s*=/i.test(p))) parts.unshift('width=device-width');
  parts.push(KIOSK_VIEWPORT_KEY);
  return parts.join(', ');
}

/** Screen px of a box (its bottom edge at rectBottom) hidden under the keyboard. */
export function coveredBelow(rectBottom, vvTop, vvHeight) {
  const bottom = Number(rectBottom);
  const visible = Number(vvTop) + Number(vvHeight);
  if (!Number.isFinite(bottom) || !Number.isFinite(visible)) return 0;
  return Math.max(0, Math.round(bottom - visible));
}

/** The same in design px: screen px over the canvas scale (1 when unknown). */
export function liftInDesignPx(coveredScreenPx, scale) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  return Math.max(0, Math.round((Number(coveredScreenPx) || 0) / s));
}

/** How far to scroll a scroller so a box's middle sits at the scroller's middle (scroll px). */
export function centreScrollDelta(boxRect, scrollerRect, pxPerScrollPx = 1) {
  if (!boxRect || !scrollerRect) return 0;
  const boxMid = boxRect.top + boxRect.height / 2;
  const scMid = scrollerRect.top + scrollerRect.height / 2;
  const ratio = Number(pxPerScrollPx) > 0 ? Number(pxPerScrollPx) : 1;
  return Math.round((boxMid - scMid) / ratio);
}

/** Adds the key to the page's viewport meta (creates the meta when there is none). */
export function ensureKioskViewportMeta(doc = typeof document !== 'undefined' ? document : null) {
  try {
    if (!doc) return;
    let meta = doc.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'viewport');
      doc.head.appendChild(meta);
    }
    const next = withInteractiveWidget(meta.getAttribute('content'));
    if (meta.getAttribute('content') !== next) meta.setAttribute('content', next);
  } catch { /* never block the kiosk */ }
}

function isTypingIn(el) {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || !el || !el.contains(a)) return false;
  return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true;
}

function scrollerOf(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = window.getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Scrolls a box to the middle of the nearest scrolling box it sits in. */
export function revealField(el) {
  try {
    if (!el || !el.isConnected) return;
    const sc = scrollerOf(el);
    if (!sc) { el.scrollIntoView?.({ block: 'center' }); return; }
    const scRect = sc.getBoundingClientRect();
    const ratio = sc.clientHeight > 0 ? scRect.height / sc.clientHeight : 1;
    const delta = centreScrollDelta(el.getBoundingClientRect(), scRect, ratio);
    if (delta) sc.scrollTop += delta;
  } catch { /* never block typing */ }
}

/** Once the keyboard is up, bring the box into view. Returns a cancel function. */
export function revealWhenKeyboardUp(el) {
  if (typeof window === 'undefined' || !el) return () => {};
  const vv = window.visualViewport;
  const timers = [];
  let frame = 0;
  const go = () => {
    if (typeof document !== 'undefined' && document.activeElement !== el) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => revealField(el));
  };
  const stop = () => {
    timers.forEach(clearTimeout);
    cancelAnimationFrame(frame);
    vv?.removeEventListener('resize', go);
    el.removeEventListener('blur', stop);
  };
  vv?.addEventListener('resize', go);
  el.addEventListener('blur', stop);
  timers.push(setTimeout(go, 350), setTimeout(go, 700), setTimeout(stop, 1500));
  return stop;
}

/** onFocus handler for any box a customer types in on the kiosk. */
export function kioskRevealOnFocus(e) {
  revealWhenKeyboardUp(e?.currentTarget || e?.target || null);
}

/** The keyboard is up when the visible part is more than this many px shorter than full height. */
export const KEYBOARD_MIN_PX = 120;

/**
 * Design px to lift a sheet that ends at the bottom of the new design's canvas.
 *   parentTop    : top of the canvas's (unzoomed) parent box, screen px (getBoundingClientRect)
 *   canvasHeight : the canvas's own height in design px (its style.height)
 *   zoom         : the canvas's CSS zoom (its style.zoom)
 *   vvTop, vvHeight : window.visualViewport offsetTop and height
 *   fullHeight   : the tallest visual viewport seen at this width (the screen with no keyboard)
 * The canvas's bottom on screen is worked out from the unzoomed parent, never from the canvas's
 * own getBoundingClientRect: Android WebView before Chrome 128 (the Sunmi kiosks) reports a zoomed
 * box unzoomed. With the visible part back at full height the lift is 0, even while a box keeps focus.
 */
export function canvasKeyboardLift({ parentTop, canvasHeight, zoom, vvTop, vvHeight, fullHeight } = {}) {
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  const full = Number(fullHeight) || 0;
  if (!(full - (Number(vvHeight) || 0) > KEYBOARD_MIN_PX)) return 0;
  const bottom = (Number(parentTop) || 0) + (Number(canvasHeight) || 0) * z;
  return liftInDesignPx(coveredBelow(bottom, vvTop, vvHeight), z);
}

/**
 * Design px the keyboard covers of the box in ref while a box inside it has focus (0 otherwise).
 * The box is inside the new design's canvas ([data-kiosk-canvas], 1080 design px wide).
 */
export function useKioskKeyboardLift(ref) {
  const [lift, setLift] = useState(0);
  const liftRef = useRef(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const vv = window.visualViewport;
    // The tallest visible height seen since the sheet opened (or the screen turned): the screen
    // with no keyboard.
    let fullHeight = 0;
    const onTurn = () => { fullHeight = 0; measure(); };
    const readHeight = () => (vv ? vv.height : window.innerHeight);
    // Worked out at once on every event (a few reads, no frame wait), so a skipped frame can never
    // leave a stale lift, and the full height is always the one from before the keyboard came up.
    const measure = () => {
      try {
        const vvHeight = readHeight();
        if (vvHeight > fullHeight) fullHeight = vvHeight;
        const el = ref.current;
        const vvTop = vv ? vv.offsetTop : 0;
        let next = 0;
        const canvas = el ? el.closest('[data-kiosk-canvas]') : null;
        if (el && canvas && canvas.parentElement && isTypingIn(el)) {
          next = canvasKeyboardLift({
            parentTop: canvas.parentElement.getBoundingClientRect().top,
            canvasHeight: parseFloat(canvas.style.height),
            zoom: parseFloat(canvas.style.zoom) || 1,
            vvTop, vvHeight, fullHeight,
          });
        }
        if (next !== liftRef.current) { liftRef.current = next; setLift(next); }
      } catch { /* keep the last lift */ }
    };
    // focusout fires before the next box takes focus: read again once it has.
    const measureSoon = () => setTimeout(measure, 0);
    measure();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', onTurn);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measureSoon);
    return () => {
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', onTurn);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measureSoon);
    };
  }, [ref]);
  return lift;
}
