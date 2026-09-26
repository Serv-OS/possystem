// src/lib/menuBoardRotate.test.js
//
// A menu board on a TV hung portrait.
//
// Peter, 21 Sep 2026: "on the orders ready screen its working when you set to
// portrait and then use these settings. But on the menu board its not and it
// doesnt have these settings to force it."
//
// The Serv OS Menu TV app always runs landscape, so a portrait design has to be
// DRAWN sideways. The order screens have had that setting since v5.8.56; the
// menu boards had the portrait layout but nothing to turn the picture. Same
// rule now: ONE stageSize, used by both, so two TVs side by side cannot
// disagree. It rides in the layout jsonb the board already has, so there is no
// schema change and a board saved before today behaves exactly as it did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stageSize } from './orderScreen/orderScreenLayout.js';

const SURFACE = readFileSync(new URL('../surfaces/MenuBoardSurface.jsx', import.meta.url), 'utf8');
const BUILDER = readFileSync(new URL('../backoffice/sections/MenuBoards.jsx', import.meta.url), 'utf8');

test('a portrait board on a landscape TV swaps its sides and spins', () => {
  const right = stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 90 });
  assert.deepEqual([right.w, right.h], [1080, 1920], 'the menu is drawn tall');
  assert.match(right.transform, /rotate\(90deg\)/);
  const left = stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 270 });
  assert.match(left.transform, /rotate\(270deg\)/);
  // and everything else is left exactly alone
  assert.equal(stageSize({ vw: 1920, vh: 1080, orientation: 'portrait', rotate: 0 }).rotate, 0);
  assert.equal(stageSize({ vw: 1920, vh: 1080, orientation: 'landscape', rotate: 90 }).rotate, 0,
    'a landscape design is never turned');
  assert.equal(stageSize({ vw: 1080, vh: 1920, orientation: 'portrait', rotate: 90 }).rotate, 0,
    'a TV that is already portrait does not need turning');
});

test('the board uses the order screens rule, not one of its own', () => {
  assert.match(SURFACE, /import \{ stageSize \} from '\.\.\/lib\/orderScreen\/orderScreenLayout'/);
  assert.match(SURFACE, /const rotate = Number\(data\.board\?\.layout\?\.rotate\) \|\| 0;/,
    'it rides in the layout jsonb: no schema change, and an old board is unaffected');
  assert.match(SURFACE, /stageSize\(\{ vw: viewport\.vw, vh: viewport\.vh, orientation, rotate \}\)/);
});

test('the whole board turns, and the fit is measured on the turned stage', () => {
  // every screen the TV can show sits inside the stage: the menu, the marketing
  // media and the "menu coming soon" splash
  assert.equal((SURFACE.match(/<div style=\{stageStyle\}>/g) || []).length, 3);
  assert.match(SURFACE, /const stageStyle = stage\.rotate/);
  assert.match(SURFACE, /width: stage\.w, height: stage\.h,/);
  // the background stays full screen behind it, so a turned board shows no bare corners
  assert.match(SURFACE, /position: 'fixed', inset: 0, overflow: 'hidden',/);
  // the auto-fit binary search must re-run when the stage changes shape, or the
  // menu is sized to the screen it is no longer drawn on
  assert.match(SURFACE, /const fitKey = \[fitTick, stage\.w, stage\.h, orientation, page, pages\.length\]\.join\('\|'\);/   /* v5.9.71: the fit re-runs per page too; v5.9.76: as the body's fitKey */);
  assert.match(SURFACE, /setViewport\(\{ vw: window\.innerWidth \|\| 0, vh: window\.innerHeight \|\| 0 \}\);/);
});

test('the builder offers it only for a portrait board, in the same words as the order screens', () => {
  assert.match(BUILDER, /If the TV shows the picture sideways/);
  assert.match(BUILDER, /\['0', 'Do not turn'\], \['90', 'Turn right'\], \['270', 'Turn left'\]/);
  assert.match(BUILDER, /board\.orientation === 'portrait' && \(/, 'hidden on a landscape board');
  assert.match(BUILDER, /The Serv OS Menu TV app always runs landscape/);
  // switching back to landscape clears the turn, so a board cannot keep a
  // setting that no longer applies
  assert.match(BUILDER, /if \(v !== 'portrait'\) setLayout\(\{ rotate: 0 \}\);/);
});
