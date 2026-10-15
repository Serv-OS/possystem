// src/lib/menuBoardPlaylist.js
//
// Playlist boards (Peter, 14 Oct 2026: "a screen to be a menu board and a slide show, or multiple
// menus that slide between each other, and the settings around that"). A third board mode,
// 'playlist': a menu_boards row whose layout is an ordered list of OTHER boards of the same venue
// (menu or marketing boards, never another playlist), each with its own seconds, plus a default
// dwell and a transition. A TV is assigned a playlist exactly as it is assigned any board, so
// pairing, publish, realtime and the cache need no change; no migration (mode has no check
// constraint, layout is jsonb).
//   layout = { items: [{ id, boardId, seconds|null }], seconds: 20, transition: 'fade'|'slide'|'cut' }
// The player is surfaces/MenuBoardSurface.jsx PlaylistPlayer; the editor is Back Office, Channels,
// Menu boards. Pure, no React, so node:test can load it (menuBoardPlaylist.test.js).

import { marketingSlides, slideHoldMs } from './menuBoardSlides.js';

export const DEFAULT_ITEM_SECONDS = 20;
export const MIN_ITEM_SECONDS = 3;
export const MAX_ITEM_SECONDS = 600;
export const MAX_ITEMS = 12;
export const TRANSITIONS = Object.freeze([['fade', 'Fade'], ['slide', 'Slide'], ['cut', 'Cut']]);
/** How long a change from one board to the next takes on the TV (fade or slide). */
export const TRANSITION_MS = 700;
/** How long before a change the next board is drawn underneath, so its fit has settled. */
export const PRELOAD_MS = 1500;

const str = (v) => (v == null ? '' : String(v)).trim();

export const isPlaylist = (board) => !!board && board.mode === 'playlist';

/** Seconds inside [MIN, MAX], or null when there are none ("use the default"). */
export function clampItemSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_ITEM_SECONDS, Math.max(MIN_ITEM_SECONDS, n));
}

export const transitionOf = (v) => (TRANSITIONS.some(([k]) => k === v) ? v : 'fade');

/**
 * Clean playlist: { items: [{ id, boardId, seconds|null }], seconds, transition }. An item is
 * dropped when its board is not in `boards`, is a playlist, or is the playlist itself (selfId).
 */
export function normalisePlaylist(layout, { boards = [], selfId = null } = {}) {
  const l = layout && typeof layout === 'object' ? layout : {};
  const byId = new Map((Array.isArray(boards) ? boards : []).filter((b) => b && b.id).map((b) => [b.id, b]));
  const items = [];
  const seen = new Set();   // the TV keys its layers on the item id, so two items never share one
  const raw = Array.isArray(l.items) ? l.items : [];
  for (let idx = 0; idx < raw.length && items.length < MAX_ITEMS; idx++) {
    const it = raw[idx];
    const boardId = str(it?.boardId);
    if (!boardId || boardId === selfId) continue;
    const b = byId.get(boardId);
    if (!b || isPlaylist(b)) continue;
    let id = str(it?.id) || `p-${idx}`;
    if (seen.has(id)) id = `${id}-${idx}`;
    seen.add(id);
    items.push({ id, boardId, seconds: clampItemSeconds(it?.seconds) });
  }
  return { items, seconds: clampItemSeconds(l.seconds) || DEFAULT_ITEM_SECONDS, transition: transitionOf(l.transition) };
}

/** The boards a playlist may play: the same venue only, and never a playlist. */
export function playableChildren(children, locationId) {
  return (Array.isArray(children) ? children : []).filter((b) => b && b.id && !isPlaylist(b) && (!locationId || b.location_id === locationId));
}

/** The playlist in play order: { entries: [{ item, board }], seconds, transition }. */
export function playlistSequence(layout, children, { selfId = null, locationId = null } = {}) {
  const boards = playableChildren(children, locationId);
  const byId = new Map(boards.map((b) => [b.id, b]));
  const p = normalisePlaylist(layout, { boards, selfId });
  return { entries: p.items.map((item) => ({ item, board: byId.get(item.boardId) })), seconds: p.seconds, transition: p.transition };
}

/**
 * ms a board stays on screen. The item's own seconds win. Else a marketing board stays for its
 * slides played through once (leadMs is taken off: the time its slideshow has already been
 * running when the hold starts, because the board is drawn underneath before it is seen, plus
 * the change itself, so the fade out ends as the last slide ends). Else the playlist default.
 * Never under MIN, never over MAX.
 */
export function itemHoldMs(item, childBoard, defaultSeconds = DEFAULT_ITEM_SECONDS, { leadMs = 0 } = {}) {
  const own = clampItemSeconds(item?.seconds);
  if (own) return Math.round(own * 1000);
  if (childBoard && childBoard.mode === 'marketing') {
    const slides = marketingSlides(childBoard.marketing);
    if (slides.length) {
      const total = slides.reduce((n, s) => n + slideHoldMs(s), 0) - (Number(leadMs) || 0);
      return Math.min(MAX_ITEM_SECONDS * 1000, Math.max(MIN_ITEM_SECONDS * 1000, total));
    }
  }
  return Math.round((clampItemSeconds(defaultSeconds) || DEFAULT_ITEM_SECONDS) * 1000);
}

export const nextIndex = (i, n) => (n > 0 ? ((Number(i) || 0) + 1) % n : 0);

// ── playlist edits (Back Office), all pure, on the raw items so a row being edited is never
// dropped under the operator ──────────────────────────────────────────────────────────────
const rawItems = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object') : []);

export function newPlaylistItem(boardId) {
  return { id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, boardId: str(boardId), seconds: null };
}
export function addPlaylistItem(list, boardId) {
  const out = rawItems(list);
  if (!str(boardId) || out.length >= MAX_ITEMS) return out;
  return [...out, newPlaylistItem(boardId)];
}
export function movePlaylistItem(list, index, dir) {
  const out = rawItems(list);
  const j = index + (dir < 0 ? -1 : 1);
  if (index < 0 || index >= out.length || j < 0 || j >= out.length) return out;
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}
export function removePlaylistItem(list, id) {
  return rawItems(list).filter((x) => x.id !== id);
}
export function setPlaylistItem(list, id, patch) {
  return rawItems(list).map((x) => (x.id === id ? { ...x, ...patch } : x));
}
