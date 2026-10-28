// v5.11.108: the kiosk keyboard helper (lib/kioskKeyboard.js). A customer: "when inputting details
// in the text box, the keyboard floats over the box itself". The arithmetic and the viewport meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withInteractiveWidget, coveredBelow, liftInDesignPx, centreScrollDelta, ensureKioskViewportMeta, KIOSK_VIEWPORT_KEY,
} from './kioskKeyboard.js';

test('the viewport meta gains interactive-widget=resizes-content once, keeping what is there', () => {
  assert.equal(withInteractiveWidget('width=device-width, initial-scale=1.0'), `width=device-width, initial-scale=1.0, ${KIOSK_VIEWPORT_KEY}`);
  assert.equal(withInteractiveWidget(withInteractiveWidget('width=device-width')), `width=device-width, ${KIOSK_VIEWPORT_KEY}`);
  assert.equal(withInteractiveWidget('width=device-width, interactive-widget=overlays-content'), `width=device-width, ${KIOSK_VIEWPORT_KEY}`);
  assert.equal(withInteractiveWidget(''), `width=device-width, ${KIOSK_VIEWPORT_KEY}`);
  assert.equal(withInteractiveWidget(null), `width=device-width, ${KIOSK_VIEWPORT_KEY}`);
});

test('ensureKioskViewportMeta sets the meta, or creates one; it never throws', () => {
  const attrs = { name: 'viewport', content: 'width=device-width, initial-scale=1.0' };
  const meta = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
  ensureKioskViewportMeta({ querySelector: () => meta });
  assert.match(attrs.content, /interactive-widget=resizes-content$/);
  const added = [];
  const made = { a: {}, getAttribute(k) { return this.a[k]; }, setAttribute(k, v) { this.a[k] = v; } };
  ensureKioskViewportMeta({ querySelector: () => null, createElement: () => made, head: { appendChild: (m) => added.push(m) } });
  assert.equal(added.length, 1);
  assert.equal(made.a.name, 'viewport');
  assert.match(made.a.content, /interactive-widget=resizes-content/);
  assert.doesNotThrow(() => ensureKioskViewportMeta({ querySelector: () => { throw new Error('x'); } }));
  assert.doesNotThrow(() => ensureKioskViewportMeta(null));
});

test('the covered part: only what the keyboard hides, in design px at the canvas scale', () => {
  // A 1920 px tall screen, keyboard 700 px: the visible part ends at 1220.
  assert.equal(coveredBelow(1920, 0, 1220), 700);
  assert.equal(coveredBelow(1000, 0, 1220), 0, 'a box above the keyboard is not moved');
  assert.equal(coveredBelow(1920, 100, 1220), 600, 'the visual viewport scrolled down (iPad)');
  assert.equal(coveredBelow(NaN, 0, 100), 0);
  // A 1080 px wide canvas drawn 810 px wide: scale 0.75, 600 screen px is 800 design px.
  assert.equal(liftInDesignPx(600, 0.75), 800);
  assert.equal(liftInDesignPx(600, 0), 600);
  assert.equal(liftInDesignPx(-5, 1), 0);
});

test('centring a box in its scroller', () => {
  assert.equal(centreScrollDelta({ top: 900, height: 100 }, { top: 0, height: 1000 }), 450);
  assert.equal(centreScrollDelta({ top: 450, height: 100 }, { top: 0, height: 1000 }), 0);
  assert.equal(centreScrollDelta({ top: 900, height: 100 }, { top: 0, height: 1000 }, 0.5), 900, 'screen px to scroll px under zoom');
  assert.equal(centreScrollDelta(null, { top: 0, height: 1 }), 0);
});
