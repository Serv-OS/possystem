// src/lib/dragReorder.test.js
//
// "dragging catcagories around is so buggy you can barly do it FIX it again"
// (Peter, 21 Sep 2026, on Chrome).
//
// Three faults, all in how the drag was wired rather than in where things land.
//
// 1. THE DROP MARKER TOOK UP SPACE. The green insertion line was a real 3px div
//    rendered ABOVE the row you were hovering. Hovering therefore pushed that row
//    and everything under it down about 5px, the row slid out from under the
//    pointer, dragover fired on its neighbour, the marker moved, and the list
//    jittered while you tried to aim. It is now drawn as an inset shadow ON the
//    row: the same green line, occupying no space at all.
//
// 2. A RE-RENDER ON EVERY dragover. That event fires every few milliseconds, and
//    each one called setState with the value it already held.
//
// 3. NO setData, so FIREFOX never started the drag at all (Peter is on Chrome;
//    his staff are not). The spec lets a browser refuse a drag carrying nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { beginDrag, dragOver } from './dragReorder.js';

const MM = readFileSync(new URL('../backoffice/sections/MenuManager.jsx', import.meta.url), 'utf8');
const MB = readFileSync(new URL('../backoffice/sections/MenuBoards.jsx', import.meta.url), 'utf8');

test('a drag carries a payload, because Firefox will not start one without it', () => {
  const calls = [];
  const e = { dataTransfer: { setData: (t, v) => calls.push([t, v]) } };
  beginDrag(e, 'cat-7');
  assert.deepEqual(calls, [['text/plain', 'cat-7']]);
  assert.equal(e.dataTransfer.effectAllowed, 'move');
  // an index is a perfectly good payload, and null must not become "null" by accident
  const e2 = { dataTransfer: { setData: (t, v) => calls.push([t, v]) } };
  beginDrag(e2, 0);
  assert.deepEqual(calls[1], ['text/plain', '0']);
  // never throws: no event, no dataTransfer, or a browser that locks it
  assert.doesNotThrow(() => beginDrag(undefined, 'x'));
  assert.doesNotThrow(() => beginDrag({}, 'x'));
  assert.doesNotThrow(() => beginDrag({ dataTransfer: { setData() { throw new Error('locked'); } } }, 'x'));
});

test('hovering the same row over and over re-renders once, not hundreds of times', () => {
  let sets = 0;
  let prevented = 0;
  const e = { preventDefault: () => { prevented += 1; } };
  // what a real drag does: dozens of dragover events on the row under the pointer
  for (let i = 0; i < 50; i++) dragOver(e, 'cat-3', 'cat-3', () => { sets += 1; });
  assert.equal(sets, 0, 'the value has not changed, so nothing is set');
  assert.equal(prevented, 50, 'but every one still allows the drop');
  dragOver(e, 'cat-4', 'cat-3', () => { sets += 1; });
  assert.equal(sets, 1, 'moving to a different row does set it, once');
});

test('the drop marker never takes up space again', () => {
  // the shape that caused it: a bare 3px bar as its own element in the list
  assert.doesNotMatch(MM, /\{isReorder && <div style=\{\{ height:3/);
  assert.doesNotMatch(MM, /\{isOver && <div style=\{\{ height:3/);
  // drawn on the row instead
  assert.match(MM, /boxShadow: isReorder \? 'inset 0 3px 0 0 var\(--acc\)' : undefined/);
  assert.match(MM, /boxShadow: isOver \? 'inset 0 3px 0 0 var\(--acc\)' : undefined/);
});

test('every drag in the menu manager and the board builder is wired the same way', () => {
  // no handler left setting effectAllowed by hand, which is what they did instead of setData
  assert.doesNotMatch(MM, /e\.dataTransfer\.effectAllowed='move'/);
  assert.doesNotMatch(MB, /dataTransfer\.effectAllowed = 'move'/);
  // and every dragstart goes through the one helper
  const starts = (MM.match(/onDragStart=/g) || []).length;
  const helped = (MM.match(/beginDrag\(/g) || []).length;
  assert.equal(helped, starts, `all ${starts} drags carry a payload`);
  // v5.9.68: the board builder's rows spread one dragProps object (category and text panel rows alike);\n  // the payload still goes through beginDrag, and dragOver through the helper.\n  assert.match(MB, /onDragStart: e => \{ setDragI\(i\); beginDrag\(e, blk\.categoryId \|\| blk\.id \|\| String\(i\)\); \}/);
  assert.match(MB, /onDragOver: e => dragOver\(e, i, overI, setOverI\)/);
});
