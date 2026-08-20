// MenuDiag.jsx - the ?diag=menu stale-till truth panel (v5.7.8).
// Read-only support overlay mounted from App.jsx whenever the URL carries
// diag=menu. Shows, live, every input the menu resolver actually uses so a
// "till stuck on the wrong menu" call can be diagnosed in one screenshot:
// version + service worker state, deviceConfig vs the two raw storage copies,
// the resolved activeMenuId, the menus array in order, category counts per
// menu, menu_category_links counts per menu, and the last config push time.
// Static imports only (CLAUDE.md). It writes NOTHING anywhere.
import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { VERSION } from '../lib/version';
import { fetchMenuCategoryLinks } from '../lib/db';
import { menusWithCategories } from '../lib/menuMembership';

const readJSON = (store, key) => {
  try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; }
};
const show = (v) => (v === undefined || v === null || v === '' ? '(none)' : String(v));

export default function MenuDiag() {
  const deviceConfig = useStore(s => s.deviceConfig);
  const activeMenuId = useStore(s => s.activeMenuId);
  const menus = useStore(s => s.menus);
  const menuCategories = useStore(s => s.menuCategories);
  // v5.7.19 - the STORE's links (what the resolver actually consumes since
  // v5.7.18) plus a live replica of the resolver's decision, so the panel can
  // never again show healthy inputs while the real pick is a mystery.
  const storeLinks = useStore(s => s.categoryLinks);
  const [hidden, setHidden] = useState(false);
  const hasSw = 'serviceWorker' in navigator;
  // Controller is readable synchronously; waiting needs the async registration.
  const [sw, setSw] = useState(() => ({
    controller: hasSw ? !!navigator.serviceWorker.controller : false,
    waiting: hasSw ? null : false,
  }));
  const [links, setLinks] = useState(null);      // null = still loading
  const [tick, setTick] = useState(0);           // re-reads storage + SW every 5s

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!hasSw) return undefined;
    let alive = true;
    const controller = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.getRegistration()
      .then(reg => { if (alive) setSw({ controller, waiting: !!reg?.waiting }); })
      .catch(() => { if (alive) setSw({ controller, waiting: null }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  useEffect(() => {
    let alive = true;
    fetchMenuCategoryLinks()
      .then(r => { if (alive) setLinks(r?.data || []); })
      .catch(() => { if (alive) setLinks([]); });
    return () => { alive = false; };
  }, []);

  if (hidden) return null;

  const sess = readJSON(sessionStorage, 'rpos-terminal-config');
  const local = readJSON(localStorage, 'rpos-device-config');
  const snap = readJSON(localStorage, 'rpos-config-snapshot');

  const catCounts = {};
  (menuCategories || []).forEach(c => {
    const m = show(c?.menuId || c?.menu_id);
    catCounts[m] = (catCounts[m] || 0) + 1;
  });
  const linkCounts = {};
  (links || []).forEach(l => {
    const m = show(l?.menu_id);
    linkCounts[m] = (linkCounts[m] || 0) + 1;
  });

  const S = {
    row: { margin: '1px 0' },
    head: { color: '#7dd3a8', fontWeight: 700, margin: '8px 0 2px' },
    dim: { color: '#8a9490' },
    warn: { color: '#f0b429' },
  };
  const kv = (label, value, warn) => (
    <div style={S.row}><span style={S.dim}>{label}: </span><span style={warn ? S.warn : undefined}>{show(value)}</span></div>
  );

  return (
    <div style={{
      position: 'fixed', top: 8, right: 8, zIndex: 100000, width: 360, maxWidth: '92vw',
      maxHeight: '86vh', overflowY: 'auto', background: '#0c1210', color: '#d7e0dc',
      border: '1px solid #2c3a34', borderRadius: 10, padding: '10px 12px',
      fontFamily: 'DM Mono, Menlo, monospace', fontSize: 10.5, lineHeight: 1.5,
      boxShadow: '0 8px 30px rgba(0,0,0,.6)', textAlign: 'left',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 800, color: '#fff' }}>MENU DIAG</span>
        <button onClick={() => setHidden(true)} aria-label="Close diagnostics" style={{
          background: 'none', border: '1px solid #2c3a34', borderRadius: 6, color: '#d7e0dc',
          fontSize: 12, cursor: 'pointer', padding: '0 7px', lineHeight: '18px',
        }}>✕</button>
      </div>

      <div style={S.head}>APP</div>
      {kv('version', VERSION)}
      {kv('sw controller', sw.controller ? 'yes' : 'NO', !sw.controller)}
      {kv('sw waiting (unapproved update)', sw.waiting === null ? 'checking' : sw.waiting ? 'YES, update parked' : 'no', sw.waiting === true)}

      <div style={S.head}>DEVICE CONFIG (store)</div>
      {kv('profileId', deviceConfig?.profileId)}
      {kv('profileName', deviceConfig?.profileName)}
      {kv('menuId', deviceConfig?.menuId)}
      {kv('defaultSurface', deviceConfig?.defaultSurface)}

      <div style={S.head}>STORAGE (raw, can disagree)</div>
      {kv('session rpos-terminal-config menuId', sess ? show(sess.menuId) : '(missing)', sess && show(sess.menuId) !== show(deviceConfig?.menuId))}
      {kv('session rpos-terminal-config profileId', sess ? show(sess.profileId) : '(missing)')}
      {kv('local rpos-device-config menuId', local ? show(local.menuId) : '(missing)', local && show(local.menuId) !== show(deviceConfig?.menuId))}
      {kv('local rpos-device-config profileId', local ? show(local.profileId) : '(missing)')}
      {kv('snapshot pushedAt', snap?.pushedAt)}

      <div style={S.head}>RESOLVED</div>
      {kv('store activeMenuId', activeMenuId)}

      <div style={S.head}>MENUS ({(menus || []).length}, store order)</div>
      {(menus || []).map(m => (
        <div key={m.id} style={S.row}>
          {show(m.id)} <span style={S.dim}>|</span> {show(m.name)}
          <span style={S.dim}> | active:</span>{String(m.isActive ?? m.is_active ?? true)}
          <span style={S.dim}> | prio:</span>{show(m.priority ?? 0)}
          <span style={S.dim}> | sched:</span>{m.schedule ? JSON.stringify(m.schedule) : 'none'}
        </div>
      ))}
      {!(menus || []).length && <div style={S.warn}>no menus in store</div>}

      <div style={S.head}>CATEGORIES ({(menuCategories || []).length} total, by menuId)</div>
      {Object.entries(catCounts).map(([m, n]) => <div key={m} style={S.row}>{m}: {n}</div>)}
      {!(menuCategories || []).length && <div style={S.warn}>no categories in store</div>}

      <div style={S.head}>RESOLVER REPLICA (live, store inputs, device clock)</div>
      {(() => {
        const now = new Date();
        const day = now.getDay() || 7;
        const time = now.getHours() * 60 + now.getMinutes();
        const schedActive = (m) => {
          if (!m.schedule) return true;
          const sc = m.schedule;
          if (sc.days && Array.isArray(sc.days) && sc.days.length && !sc.days.map(Number).includes(day)) return false;
          if (sc.from && sc.to) {
            const [fh, fm] = String(sc.from).split(':').map(Number);
            const [th, tm] = String(sc.to).split(':').map(Number);
            const a = fh * 60 + fm, b = th * 60 + tm;
            if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
            return a <= b ? (time >= a && time <= b) : (time >= a || time <= b);
          }
          return true;
        };
        const live = (menus || []).filter(m => m.isActive !== false && m.is_active !== false);
        const withCatsSet = menusWithCategories(menuCategories, storeLinks || []);
        const withCats = live.filter(m => withCatsSet.has(m.id));
        const all = withCats.length ? withCats : live;
        const activeNow = all.filter(schedActive);
        const preferred = deviceConfig?.menuId || null;
        const preferredOk = preferred && all.some(m => m.id === preferred);
        let pick = null, path = '';
        if (preferredOk && activeNow.some(m => m.id === preferred)) { pick = preferred; path = 'pinned + in schedule'; }
        else if (preferredOk) { const d = all.find(m => m.isDefault || m.is_default); pick = d ? d.id : preferred; path = d ? 'pinned off-schedule, default wins' : 'pinned off-schedule, pin kept'; }
        else if (activeNow.length) {
          const sorted = activeNow.slice().sort((a, b) => ((b.priority || 0) - (a.priority || 0)) || (((b.isDefault || b.is_default) ? 1 : 0) - (((a.isDefault || a.is_default)) ? 1 : 0)));
          pick = sorted[0].id; path = 'schedule winner';
        } else { const d = all.find(m => m.isDefault || m.is_default); pick = d ? d.id : (all[0]?.id ?? null); path = d ? 'nothing scheduled, default' : 'nothing scheduled, first non-empty'; }
        const name = (id) => (menus || []).find(m => m.id === id)?.name || id || '(none)';
        return <>
          <div style={S.row}>device clock: {now.toTimeString().slice(0, 5)} day {day}</div>
          <div style={S.row}>store categoryLinks: {(storeLinks || []).length}</div>
          {(menus || []).map(m => <div key={m.id} style={S.row}>{m.name}: schedActive {String(schedActive(m))} | hasCats {String(withCatsSet.has(m.id))}</div>)}
          <div style={{ ...S.row, fontWeight: 700 }}>SHOULD SHOW: {name(pick)} ({path})</div>
        </>;
      })()}

      <div style={S.head}>CATEGORY LINKS (menu_category_links, by menu_id)</div>
      {links === null && <div style={S.dim}>loading…</div>}
      {links !== null && !links.length && <div style={S.dim}>none</div>}
      {links !== null && Object.entries(linkCounts).map(([m, n]) => <div key={m} style={S.row}>{m}: {n}</div>)}

      <div style={{ ...S.dim, marginTop: 8 }}>Read only. Nothing here writes anywhere.</div>
    </div>
  );
}
