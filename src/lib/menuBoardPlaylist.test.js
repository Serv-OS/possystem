// Playlist boards (lib/menuBoardPlaylist.js): one screen plays several boards in turn. Peter, 14 Oct 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isPlaylist, normalisePlaylist, itemHoldMs, nextIndex, playableChildren, playlistSequence, clampItemSeconds, transitionOf,
  addPlaylistItem, movePlaylistItem, removePlaylistItem, setPlaylistItem, newPlaylistItem,
  DEFAULT_ITEM_SECONDS, MIN_ITEM_SECONDS, MAX_ITEM_SECONDS, MAX_ITEMS, TRANSITIONS, TRANSITION_MS, PRELOAD_MS,
} from './menuBoardPlaylist.js';

const venue = 'loc-1';
const menuA = { id: 'a', mode: 'menu', location_id: venue };
const menuB = { id: 'b', mode: 'menu', location_id: venue };
const mkt = { id: 'm', mode: 'marketing', location_id: venue, marketing: { slides: [{ url: 'https://x/1.jpg', seconds: 5 }, { url: 'https://x/2.jpg', seconds: 7 }] } };
const otherVenue = { id: 'o', mode: 'menu', location_id: 'loc-2' };
const pl = { id: 'pl', mode: 'playlist', location_id: venue, layout: { items: [{ id: 'i1', boardId: 'a' }] } };
const boards = [menuA, menuB, mkt, otherVenue, pl];

test('constants and the mode check', () => {
  assert.deepEqual([DEFAULT_ITEM_SECONDS, MIN_ITEM_SECONDS, MAX_ITEM_SECONDS, MAX_ITEMS, TRANSITION_MS, PRELOAD_MS], [20, 3, 600, 12, 700, 1500]);
  assert.deepEqual(TRANSITIONS.map(([v]) => v), ['fade', 'slide', 'cut']);
  assert.equal(isPlaylist(pl), true);
  assert.equal(isPlaylist(menuA), false);
  assert.equal(isPlaylist(null), false);
});

test('normalise: missing, playlist and self items are dropped, seconds clamped, items capped', () => {
  const p = normalisePlaylist({
    items: [
      { id: 'i1', boardId: 'a', seconds: 10 },
      { id: 'i2', boardId: 'gone' },            // no such board
      { id: 'i3', boardId: 'pl' },              // the playlist itself
      { id: 'i4', boardId: 'm', seconds: 1 },   // under the minimum
      { boardId: 'b', seconds: 9999 },          // over the maximum, no id
      { id: 'i6', boardId: '' },
      null,
    ],
    seconds: 45, transition: 'slide',
  }, { boards, selfId: 'pl' });
  assert.deepEqual(p.items, [
    { id: 'i1', boardId: 'a', seconds: 10 },
    { id: 'i4', boardId: 'm', seconds: MIN_ITEM_SECONDS },
    { id: 'p-4', boardId: 'b', seconds: MAX_ITEM_SECONDS },
  ]);
  // two items with one id (a hand edited layout) never share it: the TV keys its layers on it
  assert.deepEqual(normalisePlaylist({ items: [{ id: 'd', boardId: 'a' }, { id: 'd', boardId: 'b' }, { id: 'p-2', boardId: 'a' }] }, { boards }).items.map((it) => it.id), ['d', 'd-1', 'p-2']);
  assert.equal(p.seconds, 45);
  assert.equal(p.transition, 'slide');
  // another playlist among the boards is never an item
  const pl2 = { id: 'pl2', mode: 'playlist', location_id: venue };
  assert.deepEqual(normalisePlaylist({ items: [{ id: 'x', boardId: 'pl2' }] }, { boards: [...boards, pl2], selfId: 'pl' }).items, []);
  // defaults when the layout says nothing, or nonsense
  const d = normalisePlaylist({ items: 'nope', seconds: -4, transition: 'spin' }, { boards });
  assert.deepEqual(d, { items: [], seconds: DEFAULT_ITEM_SECONDS, transition: 'fade' });
  assert.deepEqual(normalisePlaylist(null).items, []);
  // blank seconds on an item mean "use the default"
  assert.equal(normalisePlaylist({ items: [{ id: 'i', boardId: 'a', seconds: '' }] }, { boards }).items[0].seconds, null);
  // twelve at most
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, boardId: i % 2 ? 'a' : 'b' }));
  assert.equal(normalisePlaylist({ items: many }, { boards }).items.length, MAX_ITEMS);
  assert.equal(clampItemSeconds(0), null);
  assert.equal(clampItemSeconds('12'), 12);
  assert.equal(transitionOf('cut'), 'cut');
  assert.equal(transitionOf(undefined), 'fade');
});

test('hold: own seconds win, a marketing board plays its slides once, else the default', () => {
  assert.equal(itemHoldMs({ seconds: 8 }, mkt, 20), 8000, 'own seconds beat the slides');
  assert.equal(itemHoldMs({ seconds: null }, menuA, 25), 25000, 'the default');
  assert.equal(itemHoldMs({}, menuA), DEFAULT_ITEM_SECONDS * 1000, 'no default given');
  assert.equal(itemHoldMs({}, menuA, 0), DEFAULT_ITEM_SECONDS * 1000, 'a bad default');
  assert.equal(itemHoldMs({}, mkt, 20), 12000, 'the slides, 5 + 7');
  assert.equal(itemHoldMs({}, mkt, 20, { leadMs: PRELOAD_MS }), 12000 - PRELOAD_MS, 'the slideshow started while the board was drawn underneath (cut)');
  assert.equal(itemHoldMs({}, mkt, 20, { leadMs: PRELOAD_MS + 2 * TRANSITION_MS }), 12000 - PRELOAD_MS - 2 * TRANSITION_MS, 'fade: drawn underneath, faded in, and the fade out ends with the last slide');
  const long = { mode: 'marketing', marketing: { slides: Array.from({ length: 5 }, (_, i) => ({ url: `https://x/${i}.jpg`, seconds: 600 })) } };
  assert.equal(itemHoldMs({}, long, 20), MAX_ITEM_SECONDS * 1000, 'capped');
  const tiny = { mode: 'marketing', marketing: { slides: [{ url: 'https://x/a.jpg', seconds: 2 }] } };
  assert.equal(itemHoldMs({}, tiny, 20, { leadMs: PRELOAD_MS }), MIN_ITEM_SECONDS * 1000, 'never under the minimum');
  const legacy = { mode: 'marketing', marketing: { mediaUrl: 'https://x/old.jpg', seconds: 30 } };
  assert.equal(itemHoldMs({}, legacy, 20), 30000, 'a board saved before slides plays its single media');
  assert.equal(itemHoldMs({}, { mode: 'marketing', marketing: {} }, 20), 20000, 'no slides at all: the default');
  assert.equal(itemHoldMs({ seconds: 1 }, menuA, 20), MIN_ITEM_SECONDS * 1000, 'own seconds are clamped too');
});

test('next index wraps', () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 0);
  assert.equal(nextIndex(0, 0), 0);
  assert.equal(nextIndex(undefined, 2), 1);
});

test('playable children: the same venue only, never a playlist', () => {
  assert.deepEqual(playableChildren(boards, venue).map((b) => b.id), ['a', 'b', 'm']);
  assert.deepEqual(playableChildren(boards, null).map((b) => b.id), ['a', 'b', 'm', 'o'], 'no venue known: only playlists are dropped');
  assert.deepEqual(playableChildren(null, venue), []);
  assert.deepEqual(playableChildren([null, { mode: 'menu' }], venue), [], 'a board needs an id');
});

test('sequence: items in order with their boards, another venue skipped', () => {
  const s = playlistSequence({ items: [{ id: 'i1', boardId: 'm' }, { id: 'i2', boardId: 'o' }, { id: 'i3', boardId: 'a', seconds: 4 }], transition: 'cut' }, boards, { selfId: 'pl', locationId: venue });
  assert.deepEqual(s.entries.map((e) => [e.item.id, e.board.id]), [['i1', 'm'], ['i3', 'a']]);
  assert.equal(s.transition, 'cut');
  assert.equal(s.seconds, DEFAULT_ITEM_SECONDS);
  assert.deepEqual(playlistSequence(null, [], {}).entries, []);
});

test('edits are pure, keep the cap and never drop the row being edited', () => {
  const one = addPlaylistItem([], 'a');
  assert.equal(one.length, 1);
  assert.equal(one[0].boardId, 'a');
  assert.equal(one[0].seconds, null);
  assert.deepEqual(addPlaylistItem(one, ''), one, 'no board, nothing added');
  const two = addPlaylistItem(one, 'b');
  assert.deepEqual(movePlaylistItem(two, 1, -1).map((x) => x.boardId), ['b', 'a']);
  assert.deepEqual(movePlaylistItem(two, 0, -1).map((x) => x.boardId), ['a', 'b'], 'cannot move above the top');
  assert.deepEqual(movePlaylistItem(two, 1, 1).map((x) => x.boardId), ['a', 'b'], 'cannot move below the bottom');
  assert.equal(removePlaylistItem(two, two[0].id)[0].boardId, 'b');
  assert.equal(setPlaylistItem(two, two[1].id, { seconds: 12 })[1].seconds, 12);
  assert.equal(setPlaylistItem(two, two[1].id, { boardId: 'gone' })[1].boardId, 'gone', 'raw edits keep whatever the operator picked');
  const full = Array.from({ length: MAX_ITEMS }, () => newPlaylistItem('a'));
  assert.equal(addPlaylistItem(full, 'b').length, MAX_ITEMS);
  assert.notEqual(newPlaylistItem('a').id, newPlaylistItem('a').id);
});

test('pins: the TV plays a playlist through PlaylistPlayer and draws one board through BoardView; the builder offers the mode', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const tv = read('../surfaces/MenuBoardSurface.jsx');
  assert.match(tv, /isPlaylist\(data\.board\)/);
  assert.match(tv, /<PlaylistPlayer key=\{data\.board\.id\}/);
  assert.match(tv, /function BoardView\(\{ data, board \}\)/);
  assert.match(tv, /Playlist is empty/);
  const bo = read('../backoffice/sections/MenuBoards.jsx');
  assert.match(bo, /\['playlist', 'Playlist'\]/);
  assert.match(bo, /boards in turn/);
  assert.match(bo, /\+ Add board/);
  assert.match(bo, /Each board looks as it does on its own card\./);
});
