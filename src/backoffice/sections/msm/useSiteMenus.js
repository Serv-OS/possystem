// src/backoffice/sections/msm/useSiteMenus.js
//
// MULTI SITE MENU (5.12.118): every menu at every site of the group menu, read once for the whole
// screen. Menu details shows them, and the Products tab says when a site has a menu the group menu
// does not manage yet (Peter, 27 Nov 2026: "it needs to find the menus").
//
// Returns a Map by menu id; undefined while reading; null when the read failed.
// stamp: anything that should make it read again (a publish, opening Menu details).

import { useEffect, useMemo, useState } from 'react';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';

export function useSiteMenus(client, live, stamp = '') {
  const ids = useMemo(() => (live?.sites || []).map((s) => s.location_id).filter(Boolean), [live]);
  const key = `${ids.join('|')}#${stamp}`;
  const [read, setRead] = useState({ key: '', menus: null });
  useEffect(() => {
    let on = true;
    if (!client || !ids.length) return undefined;
    readAllRows(() => client.from('menus').select('*').in('location_id', ids).order('sort_order').order('id')).then((r) => {
      if (on) setRead({ key, menus: r.rows ? new Map(r.rows.map((m) => [m.id, m])) : null });
    });
    return () => { on = false; };
  }, [client, ids, key]);
  if (!ids.length) return EMPTY;
  // While it reads again it keeps showing the last good read of the same sites.
  if (read.key === key) return read.menus;
  return read.key.split('#')[0] === ids.join('|') && read.menus ? read.menus : undefined;
}

const EMPTY = new Map();

// Which found menus a person has already waved away on the Products tab (this browser only).
const seenKey = (menuId) => `msm.foundMenus.seen.${menuId || ''}`;
export function readSeenMenus(menuId) {
  try { const v = JSON.parse(window.localStorage.getItem(seenKey(menuId)) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
export function saveSeenMenus(menuId, ids) {
  try { window.localStorage.setItem(seenKey(menuId), JSON.stringify([...new Set(ids)].slice(-200))); } catch { /* private window: it just shows again */ }
}
