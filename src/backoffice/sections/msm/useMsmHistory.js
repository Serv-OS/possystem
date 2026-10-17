// src/backoffice/sections/msm/useMsmHistory.js
//
// MULTI SITE MENU (v5.11.75): the publishes of the group menu (versions with their sites), read
// for the Publish, Timeline and Sites tabs. While anything is scheduled or running it reads again
// every `every` ms, so a set that starts at 05:55 shows Running and then Done without a refresh.
// When a run finishes, onSettled() is called once (the screen then reads the group menu again,
// since a publish changes it).

import { useCallback, useEffect, useRef, useState } from 'react';

const OPEN = new Set(['scheduled', 'running']);
const openIds = (rows) => (rows || []).filter((v) => OPEN.has(v.status)).map((v) => v.id).sort().join('|');

export function useMsmHistory(api, menuId, { every = 20000, onSettled } = {}) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const prevOpen = useRef('');
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);

  const apply = useCallback((r) => {
    if (!r?.rows) { setError('Could not read the publishes. Showing what was read last.'); return null; }
    setError('');
    setRows(r.rows);
    const now = openIds(r.rows);
    // Something that was open has finished: tell the screen once.
    if (prevOpen.current && prevOpen.current.split('|').some((id) => !now.split('|').includes(id))) settled.current?.();
    prevOpen.current = now;
    return r.rows;
  }, []);

  const refresh = useCallback(async () => {
    if (!menuId) return null;
    return apply(await api.history(menuId, { limit: 60 }));
  }, [api, menuId, apply]);

  useEffect(() => {
    let on = true;
    if (!menuId) return undefined;
    api.history(menuId, { limit: 60 }).then((r) => { if (on) apply(r); });
    return () => { on = false; };
  }, [api, menuId, apply]);
  const anyOpen = !!openIds(rows);
  useEffect(() => {
    if (!anyOpen) return undefined;
    const t = setInterval(refresh, every);
    return () => clearInterval(t);
  }, [anyOpen, every, refresh]);

  return { rows, error, refresh };
}
