import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSelectOnFocus, selectOnFocus } from './selectOnFocus.js';

// A tiny fake browser: one focused element at a time, a queue for "later" work,
// and fake inputs that count how often select() was called.
function rig() {
  let active = null;
  const queue = [];
  const props = createSelectOnFocus({
    getActiveElement: () => active,
    defer: (fn) => queue.push(fn),
  });
  const box = (over = {}) => ({ selects: 0, select() { this.selects += 1; }, ...over });
  const ev = (el, over = {}) => {
    const e = { currentTarget: el, button: 0, clientX: 100, clientY: 20, prevented: 0, ...over };
    e.preventDefault = () => { e.prevented += 1; };
    return e;
  };
  return {
    props, box, ev, queue,
    flush: () => queue.splice(0).forEach((fn) => fn()),
    setActive: (el) => { active = el; },
    // What a real browser does for a mouse press on a box that is not focused:
    // mousedown, then focus in the same turn. The turn then ends.
    press(el, over) {
      const down = ev(el, over);
      props.onMouseDown(down);
      active = el;
      props.onFocus(ev(el));
      this.flush();
      return down;
    },
  };
}

test('the shared instance is three plain handlers, safe to spread on an input', () => {
  assert.deepEqual(Object.keys(selectOnFocus).sort(), ['onFocus', 'onMouseDown', 'onMouseUp']);
  for (const k of Object.keys(selectOnFocus)) assert.equal(typeof selectOnFocus[k], 'function');
});

test('Tab into the box selects the whole value', () => {
  const r = rig();
  const el = r.box();
  r.setActive(el);
  r.props.onFocus(r.ev(el));
  assert.equal(el.selects, 1);
});

test('first click into the box selects the whole value, on release', () => {
  const r = rig();
  const el = r.box();
  r.press(el);
  assert.equal(el.selects, 0, 'nothing is selected mid press, the browser is still placing the caret');
  r.props.onMouseUp(r.ev(el));
  assert.equal(el.selects, 1);
  r.flush();
  assert.equal(el.selects, 2, 'selected again after the browser has finished its own caret work');
});

test('the delayed reselect is skipped once the box has lost focus (select() would steal it back)', () => {
  const r = rig();
  const el = r.box();
  r.press(el);
  r.props.onMouseUp(r.ev(el));
  r.setActive(r.box());
  r.flush();
  assert.equal(el.selects, 1);
});

test('second click, with the box already focused, places the caret as normal', () => {
  const r = rig();
  const el = r.box();
  r.press(el);
  r.props.onMouseUp(r.ev(el));
  r.flush();
  const before = el.selects;
  r.props.onMouseDown(r.ev(el, { clientX: 108 }));
  r.props.onMouseUp(r.ev(el, { clientX: 108 }));
  r.flush();
  assert.equal(el.selects, before);
});

test('press and drag keeps the text the user selected', () => {
  const r = rig();
  const el = r.box();
  r.press(el, { clientX: 100, clientY: 20 });
  r.props.onMouseUp(r.ev(el, { clientX: 112, clientY: 20 }));
  r.flush();
  assert.equal(el.selects, 0);

  const el2 = r.box();
  r.press(el2, { clientX: 100, clientY: 20 });
  r.props.onMouseUp(r.ev(el2, { clientX: 100, clientY: 29 }));
  r.flush();
  assert.equal(el2.selects, 0, 'a vertical drag counts too');
});

test('a small wobble of the hand still counts as a click', () => {
  const r = rig();
  const el = r.box();
  r.press(el, { clientX: 100, clientY: 20 });
  r.props.onMouseUp(r.ev(el, { clientX: 103, clientY: 22 }));
  assert.equal(el.selects, 1);
});

test('select() throwing is swallowed everywhere', () => {
  const r = rig();
  const el = r.box({ select() { throw new Error('InvalidStateError'); } });
  r.setActive(el);
  assert.doesNotThrow(() => r.props.onFocus(r.ev(el)));
  r.setActive(null);
  assert.doesNotThrow(() => r.press(el));
  assert.doesNotThrow(() => r.props.onMouseUp(r.ev(el)));
  assert.doesNotThrow(() => r.flush());
});

test('an element with no select() at all is left alone', () => {
  const r = rig();
  const el = {};
  r.setActive(el);
  assert.doesNotThrow(() => r.props.onFocus(r.ev(el)));
  r.setActive(null);
  assert.doesNotThrow(() => { r.press(el); r.props.onMouseUp(r.ev(el)); r.flush(); });
});

test('preventDefault is never called (it can leave the number arrows counting on their own)', () => {
  const r = rig();
  const el = r.box();
  const down = r.press(el);
  const up = r.ev(el);
  r.props.onMouseUp(up);
  r.flush();
  assert.equal(down.prevented, 0);
  assert.equal(up.prevented, 0);
});

test('a press released outside the box does not block a later Tab from selecting', () => {
  const r = rig();
  const el = r.box();
  r.press(el);              // pressed in the box, dragged out, released elsewhere: no onMouseUp
  assert.equal(el.selects, 0);
  r.setActive(r.box());     // Tab away
  r.setActive(el);          // Tab back in
  r.props.onFocus(r.ev(el));
  assert.equal(el.selects, 1);
});

test('a press released outside the box does not turn the next normal click into a select all', () => {
  const r = rig();
  const el = r.box();
  r.press(el);              // no onMouseUp, the box keeps focus
  r.props.onMouseDown(r.ev(el));
  r.props.onMouseUp(r.ev(el));
  r.flush();
  assert.equal(el.selects, 0);
});

test('only the main mouse button arms a select', () => {
  const r = rig();
  const el = r.box();
  r.props.onMouseDown(r.ev(el, { button: 2 }));
  r.setActive(el);
  r.props.onFocus(r.ev(el));
  assert.equal(el.selects, 1, 'focus from a right click selects straight away, there is no release to wait for');
  r.props.onMouseUp(r.ev(el, { button: 2 }));
  r.flush();
  assert.equal(el.selects, 1);
});

test('two boxes are tracked on their own', () => {
  const r = rig();
  const a = r.box();
  const b = r.box();
  r.press(a);
  r.props.onMouseUp(r.ev(b));
  assert.equal(b.selects, 0, 'a release over a box that was never pressed does nothing');
  r.props.onMouseUp(r.ev(a));
  assert.equal(a.selects, 1);
});

test('it never touches the value', () => {
  const r = rig();
  const el = r.box({ value: '0' });
  r.setActive(el);
  r.props.onFocus(r.ev(el));
  r.setActive(null);
  r.press(el);
  r.props.onMouseUp(r.ev(el));
  r.flush();
  assert.equal(el.value, '0');
});

test('the default instance works with no document (node, server render)', () => {
  const el = { selects: 0, select() { this.selects += 1; } };
  assert.doesNotThrow(() => selectOnFocus.onFocus({ currentTarget: el }));
  assert.equal(el.selects, 1);
});

// ── Source guards ────────────────────────────────────────────────────────────
// The price boxes are plain <input type="number"> scattered through big files,
// so a new one is easy to add without the helper. These scans keep them in step.
const readSrc = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const PRICE_BOX_FILES = [
  ['backoffice/sections/MenuManager.jsx', 7],
  ['backoffice/sections/PerMenuPricingTiers.jsx', 1],
  ['backoffice/components/MenuImportModal.jsx', 2],
  ['backoffice/sections/PackageBuilder.jsx', 3],
  ['backoffice/sections/DiscountManager.jsx', 3],
  ['admin/components/RateCardRows.jsx', 2],
  ['admin/sections/AdminBillingManager.jsx', 2],
];

for (const [rel, atLeast] of PRICE_BOX_FILES) {
  test(`${rel}: price boxes spread selectOnFocus`, () => {
    const src = readSrc(rel);
    assert.match(src, /import \{ selectOnFocus \} from '\.\.\/\.\.\/lib\/selectOnFocus';/, 'static import of the helper');
    const spreads = src.split('{...selectOnFocus}').length - 1;
    assert.ok(spreads >= atLeast, `expected at least ${atLeast} price boxes with the helper, found ${spreads}`);
  });
}

test('every penny step number box in the menu price files has the helper', () => {
  for (const rel of ['backoffice/sections/MenuManager.jsx', 'backoffice/sections/PerMenuPricingTiers.jsx', 'backoffice/components/MenuImportModal.jsx', 'admin/components/RateCardRows.jsx']) {
    const src = readSrc(rel);
    let at = src.indexOf('step="0.01"');
    let seen = 0;
    while (at !== -1) {
      seen += 1;
      const tagStart = src.lastIndexOf('<input', at);
      const near = src.slice(tagStart, at + 80);
      assert.ok(near.includes('{...selectOnFocus}'), `${rel}: a step="0.01" box near offset ${at} has no {...selectOnFocus}`);
      at = src.indexOf('step="0.01"', at + 1);
    }
    assert.ok(seen > 0, `${rel}: no price boxes found, the scan is stale`);
  }
});

test('the item base price box no longer forces a 0 back into an emptied box', () => {
  const src = readSrc('backoffice/sections/MenuManager.jsx');
  assert.ok(!src.includes("value={k==='base'?(p.base||0)"), 'base price must be allowed to show empty');
  // What an empty box SAVES is unchanged: base null, price 0.
  assert.ok(src.includes("const fp  = (k,v) => onUpdate({ pricing: { ...p, [k]: v===''?null:parseFloat(v)||0 }, ...(k==='base'?{price:parseFloat(v)||0}:{}) });"),
    'the pricing setter must stay exactly as it was');
});
