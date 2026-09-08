// MTablesList — every table at this location, with a list view AND a floor
// plan view (toggled by a segmented control in the header). The list is the
// default for one-handed servers, but the floor plan view is faster for
// experienced staff who think in terms of physical layout. The choice is
// persisted to localStorage so it sticks across sessions.

import { useState, useMemo, useEffect } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';
import MFloorPlan from './MFloorPlan';

const VIEW_KEY = 'mpos-tables-view'; // 'list' | 'floor'

export default function MTablesList({ onPickTable }) {
  const { staff, tables = [], deviceConfig } = useStore();
  const [filter, setFilter] = useState('all'); // all | available | open | bill_req | mine
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'floor' ? 'floor' : 'list'; }
    catch { return 'list'; }
  });
  const myName = staff?.name?.toLowerCase();
  const restrictedSection = deviceConfig?.assignedSection || null;

  // Persist view choice
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
  }, [view]);

  const filtered = useMemo(() => {
    let list = tables;
    // Profile-level section restriction (e.g. "Patio servers see only patio tables")
    if (restrictedSection) list = list.filter(t => t.section === restrictedSection);
    if (filter === 'available') list = list.filter(t => t.status === 'available');
    if (filter === 'open')      list = list.filter(t => t.status !== 'available' && t.session && t.status !== 'bill');
    if (filter === 'bill_req')  list = list.filter(t => t.status === 'bill');
    if (filter === 'mine') list = list.filter(t => t.session && (t.session.server || '').toLowerCase() === myName);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        String(t.label || '').toLowerCase().includes(q) ||
        String(t.section || '').toLowerCase().includes(q) ||
        String(t.session?.server || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [tables, filter, search, restrictedSection, myName]);

  // Sort: bill-req first (urgent), then occupied (mine first), then available
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const rank = (t) => {
      if (t.status === 'bill') return 0;
      if (t.session) {
        const isMine = (t.session.server || '').toLowerCase() === myName;
        return isMine ? 1 : 2;
      }
      return 3;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a.label).localeCompare(String(b.label), undefined, { numeric:true });
  }), [filtered, myName]);

  // Group by section for visual grouping
  const groups = useMemo(() => {
    const map = {};
    sorted.forEach(t => {
      const section = t.section || 'Main';
      if (!map[section]) map[section] = [];
      map[section].push(t);
    });
    return Object.entries(map);
  }, [sorted]);

  // Header counts
  const counts = useMemo(() => ({
    available: tables.filter(t => t.status === 'available').length,
    open: tables.filter(t => t.session && t.status !== 'bill').length,
    bill: tables.filter(t => t.status === 'bill').length,
    mine: tables.filter(t => t.session && (t.session.server || '').toLowerCase() === myName).length,
  }), [tables, myName]);

  // Floor plan view bypasses the filter chips / search and renders the canvas
  // directly. The toggle lives in the title bar so switching is one tap.
  if (view === 'floor') {
    return (
      <div style={{ ...Sx.scroller, display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'14px 14px 8px', flexShrink:0 }}>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:10, display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ flex:1 }}>Tables</span>
            <ViewToggle view={view} onChange={setView} />
          </div>
        </div>
        <MFloorPlan onPickTable={onPickTable} />
      </div>
    );
  }

  return (
    <div style={Sx.scroller}>
      <div style={{ padding:'14px 14px 8px', position:'sticky', top:0, background:'var(--bg)', zIndex:2 }}>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:10, display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}>
          <span style={{ flex:1, display:'flex', alignItems:'baseline', gap:10 }}>
            <span>Tables</span>
            {restrictedSection && (
              <span style={{ ...Sx.pill, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>
                {restrictedSection} only
              </span>
            )}
          </span>
          <ViewToggle view={view} onChange={setView} />
        </div>

        {/* Filter chips */}
        <div style={{ display:'flex', gap:6, overflowX:'auto', WebkitOverflowScrolling:'touch', paddingBottom:6 }}>
          {[
            { id:'all',       label:'All',       n:tables.length },
            { id:'mine',      label:'Mine',      n:counts.mine },
            { id:'bill_req',  label:'Bill req',  n:counts.bill, urgent:true },
            { id:'open',      label:'Open',      n:counts.open },
            { id:'available', label:'Available', n:counts.available },
          ].map(f => {
            const active = filter === f.id;
            return (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                padding:'7px 12px', borderRadius:99,
                border:`1.5px solid ${active ? (f.urgent ? 'var(--red)' : 'var(--acc)') : 'var(--bdr2)'}`,
                background: active ? (f.urgent ? 'var(--red-d)' : 'var(--acc-d)') : 'var(--bg2)',
                color: active ? (f.urgent ? 'var(--red)' : 'var(--acc)') : 'var(--t3)',
                fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', fontFamily:'inherit', flexShrink:0,
                display:'flex', alignItems:'center', gap:6,
              }}>
                {f.label}
                {f.n > 0 && <span style={{ fontSize:10, padding:'1px 6px', borderRadius:99, background: active ? 'rgba(0,0,0,.18)' : 'var(--bg3)', color:'inherit', fontWeight:800 }}>{f.n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Optional search */}
      <div style={{ padding:'0 14px 8px' }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search tables…"
          style={{
            width:'100%', padding:'9px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
            background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
          }}/>
      </div>

      {sorted.length === 0 && (
        <div style={Sx.emptyBlock}>
          <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🪑</div>
          <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>No tables match</div>
          <div style={{ fontSize:12 }}>Try a different filter or clear your search.</div>
        </div>
      )}

      {/* Grouped by section */}
      <div style={{ padding:'0 14px 32px' }}>
        {groups.map(([sectionName, sectionTables]) => (
          <div key={sectionName} style={{ marginBottom:14 }}>
            <div style={{ ...Sx.sectionH, padding:'14px 4px 6px' }}>
              <span>{sectionName}</span>
              <span style={{ fontSize:11, color:'var(--t4)', fontWeight:700 }}>{sectionTables.length}</span>
            </div>
            {sectionTables.map(t => <TableRow key={t.id} table={t} myName={myName} onClick={() => onPickTable?.(t)} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function TableRow({ table, myName, onClick }) {
  const isAvail = table.status === 'available';
  const isBill = table.status === 'bill';
  const session = table.session;
  const isMine = session && (session.server || '').toLowerCase() === myName;
  const pill = STATUS_PILL[isBill ? 'bill_req' : isAvail ? 'available' : 'occupied'];
  return (
    <div onClick={onClick} style={{
      ...Sx.cardRow,
      borderColor: isBill ? 'var(--red-b)' : isMine ? 'var(--acc-b)' : 'var(--bdr)',
      background: isBill ? 'var(--red-d)' : isMine ? 'var(--acc-d)' : 'var(--bg2)',
    }}>
      <div style={{
        width:44, height:44, borderRadius:10, flexShrink:0,
        background: isAvail ? 'var(--bg3)' : isBill ? 'var(--red)' : 'var(--acc)',
        color: isAvail ? 'var(--t3)' : '#0b0c10',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:14, fontWeight:800,
      }}>
        {table.label}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:2 }}>
          <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)' }}>Table {table.label}</span>
          <span style={{ ...Sx.pill, background:pill.bg, color:pill.fg, border:`1px solid ${pill.border}` }}>{pill.label}</span>
        </div>
        {session ? (
          <div style={{ fontSize:11, color:'var(--t3)', display:'flex', gap:10, flexWrap:'wrap' }}>
            {session.covers && <span>🧑 {session.covers}</span>}
            {session.server && <span>👤 {isMine ? 'You' : session.server}</span>}
            <span>⏱ {elapsed(session.seatedAt || session.createdAt)}</span>
          </div>
        ) : (
          <div style={{ fontSize:11, color:'var(--t4)' }}>Tap to seat guests</div>
        )}
      </div>
      {session && (
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:14, fontWeight:800, color: isBill ? 'var(--red)' : 'var(--acc)', fontFamily:'var(--font-mono)' }}>
            {money(session.total)}
          </div>
          <div style={{ fontSize:10, color:'var(--t4)' }}>
            {(session.items || []).length} item{(session.items || []).length === 1 ? '' : 's'}
          </div>
        </div>
      )}
    </div>
  );
}

// ── View toggle (segmented control) ──────────────────────────────────────────
function ViewToggle({ view, onChange }) {
  const Btn = ({ id, icon, label }) => {
    const active = view === id;
    return (
      <button onClick={() => onChange(id)} style={{
        flex:1, padding:'7px 10px', border:'none', cursor:'pointer', fontFamily:'inherit',
        background: active ? 'var(--bg1)' : 'transparent',
        color: active ? 'var(--t1)' : 'var(--t4)',
        fontSize:11, fontWeight:800, borderRadius:8,
        display:'flex', alignItems:'center', justifyContent:'center', gap:5,
        transition:'all .12s',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,.2)' : 'none',
      }}>
        <span style={{ fontSize:13 }}>{icon}</span>
        <span>{label}</span>
      </button>
    );
  };
  return (
    <div style={{
      display:'inline-flex', padding:3, borderRadius:10,
      background:'var(--bg3)', border:'1px solid var(--bdr)',
    }}>
      <Btn id="list"  icon="≡" label="List" />
      <Btn id="floor" icon="⬚" label="Floor" />
    </div>
  );
}
