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
//                              sheet's bottom, followed on resize and scroll). The sheet sets its
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
const CANVAS_WIDTH = 1080;   // lib/kioskFlow.js KIOSK_CANVAS_WIDTH (that file stays import free)

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
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          const el = ref.current;
          let next = 0;
          if (el && isTypingIn(el)) {
            const canvas = el.closest('[data-kiosk-canvas]');
            const scale = canvas ? canvas.getBoundingClientRect().width / CANVAS_WIDTH : 1;
            // The bottom the box would have with no lift, so the reading does not chase itself.
            const bottom = el.getBoundingClientRect().bottom + liftRef.current * (scale || 1);
            const top = vv ? vv.offsetTop : 0;
            const height = vv ? vv.height : window.innerHeight;
            next = liftInDesignPx(coveredBelow(bottom, top, height), scale);
          }
          if (next !== liftRef.current) { liftRef.current = next; setLift(next); }
        } catch { /* keep the last lift */ }
      });
    };
    measure();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    document.addEventListener('focusin', measure);
    document.addEventListener('focusout', measure);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      document.removeEventListener('focusin', measure);
      document.removeEventListener('focusout', measure);
    };
  }, [ref]);
  return lift;
}
