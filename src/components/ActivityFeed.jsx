// src/components/ActivityFeed.jsx — the POS activity feed bell + slide-over panel.
// One operational timeline: orders coming in, manager nudges / things needing action, menu & price
// changes, ops/compliance. Reads activity_events + subscribes via postgres_changes (same realtime as
// KDS). Self-contained: resolves the location itself, reads the PIN'd staff for ack attribution. The
// cross-surface toast/chime for action items is handled in lib/realtime.js; this is the timeline UI.
import { useState, useEffect } from 'react';
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
const agoOf = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

export default function ActivityFeed() {
  const [loc, setLoc] = useState(getActiveLocationSync());
  const [events, setEvents] = useState([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => { try { return Number(localStorage.getItem('rpos-activity-seen') || 0); } catch { return 0; } });
  const operator = useStore(s => s.staff?.name || null);

  // resolve the real location once
  useEffect(() => {
    let live = true;
    (async () => { const l = loc || getActiveLocationSync() || await getLocationId().catch(() => null); if (live && l && l !== loc) setLoc(l); })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // load recent + live updates
  useEffect(() => {
    if (!loc || !supabase) return;
    let live = true;
    fetchRecentActivity(loc).then(e => { if (live) setEvents(e); });
    const ch = supabase.channel(`activity-feed:${loc}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_events', filter: `location_id=eq.${loc}` },
        ({ new: r }) => setEvents(prev => [eventFromRow(r), ...prev.filter(x => x.id !== r.id)].slice(0, 80)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activity_events', filter: `location_id=eq.${loc}` },
        ({ new: r }) => setEvents(prev => prev.map(x => x.id === r.id ? eventFromRow(r) : x)))
      .subscribe();
    return () => { live = false; try { supabase.removeChannel(ch); } catch { /* noop */ } };
  }, [loc]);

  const unread = events.filter(e => new Date(e.createdAt).getTime() > seen).length;
  const actionOpen = events.filter(e => (e.severity === 'action' || e.severity === 'urgent') && !e.ackedAt).length;
  const badge = actionOpen || unread;

  const openPanel = () => { setOpen(true); const now = Date.now(); setSeen(now); try { localStorage.setItem('rpos-activity-seen', String(now)); } catch { /* noop */ } };
  const ack = async (e) => { setEvents(prev => prev.map(x => x.id === e.id ? { ...x, ackedAt: new Date().toISOString() } : x)); await ackActivity(e.id, operator); };

  return (
    <>
      <button onClick={() => (open ? setOpen(false) : openPanel())} title="Activity feed" style={{ position: 'relative', width: 34, height: 32, borderRadius: 11, border: '1px solid var(--inset-border)', background: 'var(--inset)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: badge ? 'var(--acc)' : 'var(--t3)', flexShrink: 0, fontFamily: 'inherit' }}>
        <Icon name="bell" size={16} />
        {badge > 0 && (
          <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 999, background: actionOpen ? 'var(--red)' : 'var(--signal,#15C26A)', color: '#06130C', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)' }}>{badge > 99 ? '99+' : badge}</span>
        )}
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 200, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px, 92vw)', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 30px rgba(0,0,0,.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--bdr)' }}>
              <Icon name="bell" size={18} style={{ color: 'var(--acc)' }} />
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', flex: 1 }}>Activity</div>
              <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', fontSize: 22, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
              {events.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>Nothing yet. Orders, nudges and changes will appear here.</div>}
              {events.map(e => {
                const k = KIND[e.kind] || KIND.system;
                const action = (e.severity === 'action' || e.severity === 'urgent') && !e.ackedAt;
                return (
                  <div key={e.id} style={{ display: 'flex', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--bg2)', background: action ? 'var(--red-d, rgba(255,90,74,.06))' : 'transparent' }}>
                    <div style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--bg3)', color: e.severity === 'urgent' ? 'var(--red)' : k.tone }}><Icon name={k.icon} size={16} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{e.title}</div>
                      {e.body && <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 1 }}>{e.body}</div>}
                      <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>{agoOf(e.createdAt)}{e.actorName ? ` · ${e.actorName}` : ''}{e.ackedAt ? ' · done' : ''}</div>
                    </div>
                    {action && <button onClick={() => ack(e)} style={{ alignSelf: 'center', padding: '6px 12px', borderRadius: 999, border: '1px solid var(--grn-b, rgba(21,194,106,.3))', background: 'none', cursor: 'pointer', color: 'var(--acc)', fontWeight: 800, fontSize: 12, fontFamily: 'inherit', flexShrink: 0 }}>Done</button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
