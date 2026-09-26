// v5.9.71: slideshows on a menu board (lib/menuBoardSlides.js): Marketing mode plays slides,
// an image panel rotates inside the menu. Peter, 26 Sep 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normaliseSlides, marketingSlides, slideHoldMs, nextSlideIndex, slideType, slideTypeOfFile, ratioCss,
  newImageBlock, isImageBlock, addSlides, moveSlide, removeSlide, setSlideSeconds, DEFAULT_SLIDE_SECONDS, MAX_SLIDES, VIDEO_SAFETY_MS,
} from './menuBoardSlides.js';

test('slides normalise: urls, types by name, seconds capped, videos play through, twenty at most', () => {
  const s = normaliseSlides(['https://x/a.jpg', { url: 'https://x/b.mp4' }, { id: 'k', url: 'https://x/c.png', seconds: 5000 }, { url: '' }, null]);
  assert.deepEqual(s.map(x => [x.id, x.type, x.seconds]), [['s-0', 'image', 8], ['s-1', 'video', 0], ['k', 'image', 600]]);
  assert.equal(normaliseSlides([{ url: 'https://x/v.MOV', type: 'image' }])[0].type, 'image', 'a saved type wins');
  assert.equal(slideType(null, 'clip.webm?x=1'), 'video');
  assert.equal(slideTypeOfFile({ type: 'video/mp4', name: 'a' }), 'video');
  assert.equal(slideTypeOfFile({ type: '', name: 'a.jpg' }), 'image');
  assert.equal(normaliseSlides(Array.from({ length: 30 }, (_, i) => `https://x/${i}.jpg`)).length, MAX_SLIDES);
  assert.equal(normaliseSlides(['https://x/a.jpg'], { seconds: 15 })[0].seconds, 15);
});

test('marketing: slides first, else the single media a board saved before, else nothing', () => {
  assert.deepEqual(marketingSlides({ slides: [{ url: 'https://x/a.jpg' }], mediaUrl: 'https://x/old.mp4', mediaType: 'video' }).map(s => s.url), ['https://x/a.jpg']);
  const legacy = marketingSlides({ mediaUrl: 'https://x/old.mp4', mediaType: 'video', seconds: 20 });
  assert.deepEqual(legacy.map(s => [s.id, s.type, s.seconds]), [['legacy', 'video', 0]]);
  assert.deepEqual(marketingSlides({ slides: [], mediaUrl: '' }), []);
  assert.deepEqual(marketingSlides(null), []);
});

test('hold times and the next index', () => {
  assert.equal(slideHoldMs({ type: 'image', seconds: 8 }), 8000);
  assert.equal(slideHoldMs({ type: 'image', seconds: 0 }, 12), 12000);
  assert.equal(slideHoldMs({ type: 'video', seconds: 0 }), VIDEO_SAFETY_MS);
  assert.equal(slideHoldMs({ type: 'video', seconds: 30 }), 30000);
  assert.equal(nextSlideIndex(2, 3), 0);
  assert.equal(nextSlideIndex(0, 0), 0);
});

test('slide list edits are pure and keep the cap', () => {
  const a = addSlides([], [{ url: 'https://x/1.jpg', type: 'image' }, { url: 'https://x/2.mp4', type: 'video' }]);
  assert.deepEqual(a.map(s => [s.type, s.seconds]), [['image', DEFAULT_SLIDE_SECONDS], ['video', 0]]);
  const moved = moveSlide(a, 1, -1);
  assert.deepEqual(moved.map(s => s.type), ['video', 'image']);
  assert.deepEqual(moveSlide(a, 0, -1).map(s => s.type), ['image', 'video'], 'cannot move above the top');
  assert.equal(removeSlide(a, a[0].id).length, 1);
  assert.equal(setSlideSeconds(a, a[0].id, 12)[0].seconds, 12);
  assert.equal(setSlideSeconds(a, a[0].id, -3)[0].seconds, DEFAULT_SLIDE_SECONDS);
  assert.equal(addSlides(Array.from({ length: MAX_SLIDES }, (_, i) => `https://x/${i}.jpg`), ['https://x/more.jpg']).length, MAX_SLIDES);
});

test('image block shape and ratio css', () => {
  const b = newImageBlock();
  assert.equal(isImageBlock(b), true);
  assert.deepEqual([b.type, b.fit, b.ratio, b.seconds, b.slides], ['image', 'cover', '16:9', DEFAULT_SLIDE_SECONDS, []]);
  assert.equal(ratioCss('4:3'), '4 / 3');
  assert.equal(ratioCss('nope'), '16 / 9');
});

test('pins: the TV and the preview play the same Slideshow; the builder offers image panels and page breaks', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const tv = read('../surfaces/MenuBoardSurface.jsx');
  assert.match(tv, /<Slideshow slides=\{slides\} fit=\{m\.fit \|\| 'cover'\} transition=\{m\.transition \|\| 'fade'\} \/>/);
  assert.match(tv, /boardPages\(allSections\)/);
  const bo = read('../backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /\+ Image panel/);
  assert.match(bo, /\+ Page break/);
  assert.match(bo, /<SlideList slides=\{mktSlides\}/);
  assert.match(bo, /<Slideshow slides=\{slides\}/);
  const parts = read('../surfaces/menuboard/BoardParts.jsx');
  assert.match(parts, /export function Slideshow/);
  assert.match(parts, /if \(sec\.type === 'image'\)/);
});
