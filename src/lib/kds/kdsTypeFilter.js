// src/lib/kds/kdsTypeFilter.js
//
// The header count pills filter the board by order type. 30 Sep 2026, Coffee Boy: the food screen
// had "Dine-in name" left tapped, so every takeaway and kiosk ticket was hidden for 3 hours and the
// kitchen thought the KDS had missed them. The active pill was only a thin border and the header
// count still counted the hidden tickets. The rules here make a filter impossible to forget:
//   1. a banner whenever the filter is not All, with the hidden count and a big Show all;
//   2. the filter snaps back to All after three minutes with no pill tap;
//   3. it snaps back at once when a ticket of a hidden type arrives (the board chimes too);
//   4. it is never saved: every boot starts on All.
// No React, no Supabase.

import { KDS_TYPES } from './kdsTicket.js';

export const FILTER_SNAP_BACK_MS = 3 * 60 * 1000;

/** The filter after a clock tick: All once three minutes have passed since the last pill tap. */
export function filterAfterIdle({ filter, tappedAt, now }) {
  if (!filter || filter === 'all') return 'all';
  const t = Number(tappedAt);
  if (!Number.isFinite(t)) return 'all';
  return now - t >= FILTER_SNAP_BACK_MS ? 'all' : filter;
}

/** Does this filter hide a ticket of that type? */
export function hiddenByFilter(filter, typeKey) {
  return !!filter && filter !== 'all' && typeKey !== filter;
}

/**
 * New tickets arrived (their type keys). The filter snaps back to All when any of them would be
 * hidden; `snapped` says so, and the caller plays the new ticket chime then.
 */
export function filterAfterArrival({ filter, typeKeys }) {
  const keys = Array.isArray(typeKeys) ? typeKeys : [];
  const snapped = keys.some(k => hiddenByFilter(filter, k));
  return { filter: snapped ? 'all' : (filter || 'all'), snapped };
}

/** How many of these tickets the filter hides. */
export function hiddenCount(views, filter) {
  if (!filter || filter === 'all') return 0;
  return (views || []).filter(v => hiddenByFilter(filter, v?.typeKey)).length;
}

/**
 * The banner words, or null on All: "Showing Dine-in name only. 3 hidden."
 * The legend's dash ("Dine-in — name") is dropped: staff copy carries no dashes as punctuation.
 */
export function filterBanner(filter, hidden) {
  if (!filter || filter === 'all') return null;
  const label = (KDS_TYPES[filter]?.legend || filter).replace(/\s*[\u2013\u2014]\s*/g, ' ');
  const n = Math.max(0, Number(hidden) || 0);
  return `Showing ${label} only. ${n} hidden.`;
}
