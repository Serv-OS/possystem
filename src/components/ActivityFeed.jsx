// src/components/ActivityFeed.jsx — the POS activity feed bell + slide-over panel.
// One operational timeline: orders coming in, manager nudges / things needing action, menu & price
// changes, ops/compliance. Reads activity_events + subscribes via postgres_changes (same realtime as
// KDS). The panel is rendered through a PORTAL to document.body so it can't get trapped behind the
// staff-shell's transformed glass panels. Dismiss (Done / ✕) marks an item read for every till; the
// cross-surface toast/chime for action items is handled in lib/realtime.js.
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { supabase, getActiveLocationSync, getLocationId } from '../lib/supabase';
import { fetchRecentActivity, ackActivity, eventFromRow } from '../lib/activity';
import { Icon } from './ServOSIcons';
import { useStore } from '../store';

const KIND = {
  order:  { icon: 'orders',    tone: 'var(--acc)' },
  nudge:  { icon: 'bell',      tone: 'var(--orn,#f97316)' },
  menu:   { icon: 'edit',      tone: 'var(--uv,#7C5CFF)' },
  stock:  { icon: 'inventory', tone: 'var(--orn,#f97316)' },
  ops:    { icon: 'thermo',    tone: 'var(--red)' },
  system: { icon: 'sparkle',   tone: 'var(--t3)' },
};
const KIND_LABEL = { order: 'Orders', nudge: 'Nudges', menu: 'Menu', stock: 'Stock', ops: 'Ops', system: 'System' };

// A filter chip in the panel header.
function Chip({ label, active, tone, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
      fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap',
      border: `1px solid ${active ? (tone || 'var(--acc)') : 'var(--bdr)'}`,
      background: active ? 'var(--bg3)' : 'transparent',
      color: active ? (tone || 'var(--t1)') : 'var(--t3)',
    }}>{label}</button>
  );
}
const agoOf = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

export default function ActivityFeed() {
  const [loc, setLoc] = useState(() => { const l = getActiveLocationSync(); return (l && l !== 'loc-demo') ? l : null; });
  const [events, setEvents] = useState([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(null);   // null = all kinds; else a KIND key
  const operator = useStore(s => s.staff?.name || null);

  // Resolve the real location, retrying until it's ready (mirrors App.jsx's boot loop).
  useEffect(() => {
    if (loc) return undefined;
    let live = true;
    const tryResolve = async () => {
      let l = getActiveLocationSync();
      if (!l || l === 'loc-demo') l = await getLocationId().catch(() => null);
      if (live && l && l !== 'loc-demo') setLoc(l);
    };
    tryResolve();
    const t = setInterval(tryResolve, 3000);
    return () => { live = false; clearInterval(t); };
  }, [loc]);

  // load recent + live updates
  useEffect(() => {
    if (!loc || !supabase) return undefined;
    let live = true;
    fetchRecentActivity(loc).then(e => { if (live) setEvents(e); });
    const ch = supabase.channel(`activity-feed:${loc}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_events', filter: `location_id=eq.${loc}` },
        ({ new: r }) => setEvents(prev => [eventFromRow(r), ...prev.filter(x => x.id !== r.id)].slice(0, 120)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activity_events', filter: `location_id=eq.${loc}` },
        ({ new: r }) => setEvents(prev => prev.map(x => x.id === r.id ? eventFromRow(r) : x)))
      .subscribe();
    return () => { live = false; try { supabase.removeChannel(ch); } catch { /* noop */ } };
  }, [loc]);

  const live = events.filter(e => !e.ackedAt);                              // un-dismissed = the inbox
  const actionOpen = live.filter(e => e.severity === 'action' || e.severity === 'urgent').length;
  const badge = live.length;
  // Per-kind filter: chips over the present kinds; `shown` is the filtered list.
  const kindCounts = live.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
  const activeKinds = Object.keys(KIND).filter(k => kindCounts[k]);
  const shown = filter && kindCounts[filter] ? live.filter(e => e.kind === filter) : live;

  const dismiss = async (e) => { setEvents(prev => prev.map(x => x.id === e.id ? { ...x, ackedAt: new Date().toISOString() } : x)); await ackActivity(e.id, operator); };
  const clearAll = async () => {
    const toClear = live.slice();
    setEvents(prev => prev.map(x => x.ackedAt ? x : { ...x, ackedAt: new Date().toISOString() }));
    for (const e of toClear) { await ackActivity(e.id, operator); }
  };

  const panel = !open ? null : createPortal(
    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.38)', zIndex: 6000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px, 92vw)', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 30px rgba(0,0,0,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--bdr)' }}>
          <Icon name="bell" size={18} style={{ color: 'var(--acc)' }} />
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', flex: 1 }}>Activity</div>
          {live.length > 0 && <button onClick={clearAll} style={{ background: 'none', border: '1px solid var(--bdr)', borderRadius: 999, padding: '5px 12px', cursor: 'pointer', color: 'var(--t2)', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>Mark all read</button>}
          <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        {live.length > 0 && activeKinds.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '10px 16px 4px', borderBottom: '1px solid var(--bg2)' }}>
            <Chip label={`All ${live.length}`} active={!filter || !kindCounts[filter]} onClick={() => setFilter(null)} />
            {activeKinds.map(k => (
              <Chip key={k} label={`${KIND_LABEL[k] || k} ${kindCounts[k]}`} active={filter === k} tone={KIND[k].tone} onClick={() => setFilter(f => (f === k ? null : k))} />
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          {live.length === 0 && <div style={{ padding: 28, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>All clear. Orders, nudges and changes will appear here.</div>}
          {shown.map(e => {
            const k = KIND[e.kind] || KIND.system;
            const action = e.severity === 'action' || e.severity === 'urgent';
            return (
              <div key={e.id} style={{ display: 'flex', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--bg2)', background: action ? 'var(--red-d, rgba(255,90,74,.06))' : 'transparent' }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--bg3)', color: e.severity === 'urgent' ? 'var(--red)' : k.tone }}><Icon name={k.icon} size={16} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{e.title}</div>
                  {e.body && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 1 }}>{e.body}</div>}
                  <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>{agoOf(e.createdAt)}{e.actorName ? ` · ${e.actorName}` : ''}</div>
                </div>
                <button onClick={() => dismiss(e)} title="Dismiss" style={{ alignSelf: 'center', padding: action ? '6px 12px' : '4px 8px', borderRadius: 999, border: action ? '1px solid var(--grn-b, rgba(21,194,106,.3))' : '1px solid var(--bdr)', background: 'none', cursor: 'pointer', color: action ? 'var(--acc)' : 'var(--t3)', fontWeight: 800, fontSize: action ? 12 : 14, fontFamily: 'inherit', flexShrink: 0, lineHeight: 1 }}>{action ? 'Done' : '✕'}</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <button onClick={() => setOpen(o => !o)} title="Activity feed" style={{ position: 'relative', width: 34, height: 32, borderRadius: 11, border: '1px solid var(--inset-border)', background: 'var(--inset)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: badge ? 'var(--acc)' : 'var(--t3)', flexShrink: 0, fontFamily: 'inherit' }}>
        <Icon name="bell" size={16} />
        {badge > 0 && (
          <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: actionOpen ? 'var(--red)' : 'var(--signal,#15C26A)', color: '#06130C', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)' }}>{badge > 99 ? '99+' : badge}</span>
        )}
      </button>
      {panel}
    </>
  );
}
