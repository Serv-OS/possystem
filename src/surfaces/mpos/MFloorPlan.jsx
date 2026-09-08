// MFloorPlan — phone-friendly floor plan view. Reuses the same x/y/w/h/shape
// coordinates the desktop POS uses (TablesSurface) so what the BO designs in
// the FloorPlanBuilder shows up identically here. Auto-scales the canvas to
// fit the phone width; pan-scroll if the floor is taller than the viewport.
//
// Tapping a table calls the same onPickTable callback as the list view so
// downstream wiring (covers picker / table view) is identical.

import { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

const STATUS_COLOR = {
  available: { fg:'#22c55e', bg:'rgba(34,197,94,.14)',  border:'rgba(34,197,94,.45)' },
  open:      { fg:'#3b82f6', bg:'rgba(59,130,246,.16)', border:'rgba(59,130,246,.5)' },
  occupied:  { fg:'var(--acc)', bg:'rgba(212,136,28,.16)', border:'rgba(212,136,28,.55)' },
  bill:      { fg:'#ef4444', bg:'rgba(239,68,68,.16)',  border:'rgba(239,68,68,.55)' },
  reserved:  { fg:'#a855f7', bg:'rgba(168,85,247,.14)', border:'rgba(168,85,247,.45)' },
  default:   { fg:'var(--t3)', bg:'var(--bg3)',         border:'var(--bdr)' },
};

export default function MFloorPlan({ section, onPickTable }) {
  const { tables = [], deviceConfig, staff } = useStore();
  const myName = staff?.name?.toLowerCase();
  const restrictedSection = deviceConfig?.assignedSection || null;
  const sections = useMemo(() => {
    const s = new Set();
    tables.forEach(t => { if (t.section) s.add(t.section); });
    return Array.from(s);
  }, [tables]);
  // Internal section state so the tabs are interactive. Default to the prop /
  // profile restriction / first available section so the canvas never shows
  // every section's tables jumbled together.
  const [picked, setPicked] = useState(null);
  const activeSection = picked || section || restrictedSection || sections[0] || null;

  // If sections list arrives async, snap to first one once available.
  useEffect(() => {
    if (!picked && !section && !restrictedSection && sections.length > 0) {
      setPicked(sections[0]);
    }
  }, [sections, picked, section, restrictedSection]);

  // Filter to active section. If we have any sections defined at all, ALWAYS
  // require a match — never fall back to "show all" which would render two
  // floor plans on top of each other.
  const visible = useMemo(() => {
    if (sections.length === 0) return tables; // no sections defined — show all
    if (!activeSection) return [];
    return tables.filter(t => t.section === activeSection);
  }, [tables, activeSection, sections.length]);

  // Compute the bounding box of the floor so we can scale to phone width
  const { canvasW, canvasH, minX, minY } = useMemo(() => {
    if (!visible.length) return { canvasW:400, canvasH:300, minX:0, minY:0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    visible.forEach(t => {
      const x = Number(t.x) || 0;
      const y = Number(t.y) || 0;
      const w = Number(t.w) || 60;
      const h = Number(t.h) || 60;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    });
    // Pad by 16px on every side so tables aren't flush against the edge
    return {
      canvasW: Math.max(400, (maxX - minX) + 32),
      canvasH: Math.max(300, (maxY - minY) + 32),
      minX: minX - 16,
      minY: minY - 16,
    };
  }, [visible]);

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', minHeight:0 }}>
      {/* Section tabs (only when there's more than one section) */}
      {sections.length > 1 && !restrictedSection && (
        <div style={{ padding:'4px 12px 8px', display:'flex', gap:6, overflowX:'auto', flexShrink:0, WebkitOverflowScrolling:'touch' }}>
          {sections.map(s => {
            const active = s === activeSection;
            return (
              <button key={s} onClick={() => setPicked(s)} style={{
                padding:'7px 14px', borderRadius:99,
                border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
                background: active ? 'var(--acc-d)' : 'var(--bg2)',
                color: active ? 'var(--acc)' : 'var(--t3)',
                fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', fontFamily:'inherit', flexShrink:0,
                textTransform:'capitalize',
              }}>{s}</button>
            );
          })}
        </div>
      )}

      {/* Canvas — auto-scales to fit width. Container holds an absolutely-
          positioned plane sized to the floor's bounding box. We use a CSS
          transform scale to fit the viewport, preserving pixel-perfect
          relative table positions. */}
      <div style={{ flex:1, overflow:'auto', WebkitOverflowScrolling:'touch', padding:'8px 0' }}>
        <FloorCanvas
          tables={visible} canvasW={canvasW} canvasH={canvasH} minX={minX} minY={minY}
          myName={myName}
          onPickTable={onPickTable}
        />
      </div>

      {/* Legend */}
      <div style={{
        padding:'10px 12px calc(10px + env(safe-area-inset-bottom)) 12px',
        borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0,
        display:'flex', flexWrap:'wrap', gap:10, justifyContent:'center',
      }}>
        <Legend color="#22c55e" label="Available"/>
        <Legend color="#3b82f6" label="Open"/>
        <Legend color="var(--acc)" label="Occupied"/>
        <Legend color="#ef4444" label="Bill req"/>
        <Legend color="#a855f7" label="Reserved"/>
      </div>
    </div>
  );
}

function FloorCanvas({ tables, canvasW, canvasH, minX, minY, myName, onPickTable }) {
  // Auto-fit scale (so the floor fills the phone width on first render),
  // multiplied by user-controlled pinch zoom. Pan kicks in when zoomed past
  // 1.0 so the user can drag the canvas around to reach off-screen tables.
  const VIEWPORT_PADDING = 8;
  const targetWidth = typeof window !== 'undefined'
    ? Math.min(540, window.innerWidth) - VIEWPORT_PADDING * 2
    : 380;
  const fitScale = Math.min(1, targetWidth / canvasW);

  const [userScale, setUserScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const wrapRef = useRef(null);
  const gesture = useRef(null);
  // Suppress the table tap that fires at the END of a pinch / pan
  const movedRef = useRef(false);

  // Touch handlers. We attach via useEffect with { passive: false } because
  // preventDefault on a passive listener is a no-op — and we need it to stop
  // iOS from page-zooming the whole app while the user is pinching the floor.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onStart = (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        gesture.current = {
          type: 'pinch',
          startDist: Math.hypot(dx, dy),
          startScale: userScale,
        };
        movedRef.current = true;
      } else if (e.touches.length === 1 && userScale > 1.02) {
        gesture.current = {
          type: 'pan',
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startPan: { ...pan },
        };
      }
    };

    const onMove = (e) => {
      if (!gesture.current) return;
      if (gesture.current.type === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const ratio = dist / gesture.current.startDist;
        const next = Math.max(0.6, Math.min(4, gesture.current.startScale * ratio));
        setUserScale(next);
      } else if (gesture.current.type === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        const dx = e.touches[0].clientX - gesture.current.startX;
        const dy = e.touches[0].clientY - gesture.current.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true;
        setPan({ x: gesture.current.startPan.x + dx, y: gesture.current.startPan.y + dy });
      }
    };

    const onEnd = (e) => {
      if (e.touches.length === 0) {
        gesture.current = null;
        // Reset the moved flag on a short delay so the upcoming click event
        // (synthesised after touchend) sees it and suppresses the tap if a
        // gesture happened. iOS click delay is ~300ms; we use 350.
        setTimeout(() => { movedRef.current = false; }, 350);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove',  onMove,  { passive: false });
    el.addEventListener('touchend',   onEnd,   { passive: true });
    el.addEventListener('touchcancel', onEnd,  { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove',  onMove);
      el.removeEventListener('touchend',   onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [userScale, pan]);

  const resetZoom = () => { setUserScale(1); setPan({ x: 0, y: 0 }); };
  const totalScale = fitScale * userScale;
  // Visible area height grows with zoom so tables off the bottom can be reached
  const scaledH = canvasH * totalScale;

  // Suppress the tap that follows a pinch/pan
  const handleTablePick = (t) => {
    if (movedRef.current) return;
    onPickTable?.(t);
  };

  return (
    <div
      ref={wrapRef}
      style={{
        position:'relative',
        width: targetWidth,
        height: scaledH,
        margin:'0 auto',
        overflow:'hidden',
        touchAction:'none',
      }}
    >
      <div style={{
        position:'absolute', top:0, left:0,
        width: canvasW, height: canvasH,
        transformOrigin:'top left',
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${totalScale})`,
        background:'rgba(255,255,255,0.02)',
        borderRadius: 12,
        willChange: 'transform',
      }}>
        {tables.map(t => <TableTile key={t.id} table={t} minX={minX} minY={minY} myName={myName} onTap={() => handleTablePick(t)} />)}
      </div>

      {/* Zoom controls — quick +/- and reset, for users who don't want to pinch */}
      <div style={{
        position:'absolute', right:8, bottom:8, display:'flex', gap:6,
        background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:99, padding:3,
        boxShadow:'0 2px 8px rgba(0,0,0,.25)',
      }}>
        <ZoomBtn onClick={() => setUserScale(s => Math.max(0.6, s - 0.25))} label="−" />
        <ZoomBtn onClick={resetZoom} label={`${Math.round(userScale * 100)}%`} wide />
        <ZoomBtn onClick={() => setUserScale(s => Math.min(4, s + 0.25))} label="+" />
      </div>
    </div>
  );
}

function ZoomBtn({ onClick, label, wide }) {
  return (
    <button
      onClick={onClick}
      style={{
        minWidth: wide ? 52 : 32, height: 32, borderRadius: 99,
        border:'none', background:'transparent', color:'var(--t1)',
        fontSize:13, fontWeight:800, cursor:'pointer', fontFamily:'inherit',
        WebkitTapHighlightColor:'transparent',
      }}
    >{label}</button>
  );
}

function TableTile({ table, minX, minY, myName, onTap }) {
  const status = table.status === 'bill' ? 'bill' :
                 table.session ? (table.status === 'open' ? 'open' : 'occupied') :
                 (table.status || 'available');
  const colour = STATUS_COLOR[status] || STATUS_COLOR.default;
  const x = (Number(table.x) || 0) - minX;
  const y = (Number(table.y) || 0) - minY;
  const w = Number(table.w) || 60;
  const h = Number(table.h) || 60;
  const isRound = table.shape === 'rd' || table.shape === 'round';
  const isMine = table.session && (table.session.server || '').toLowerCase() === myName;
  const total = table.session?.total || 0;
  const elapsedStr = table.session?.seatedAt ? elapsed(table.session.seatedAt) : null;

  return (
    <button onClick={onTap} style={{
      position:'absolute', left:x, top:y, width:w, height:h,
      background: colour.bg, border:`2px solid ${isMine ? 'var(--acc)' : colour.border}`,
      borderRadius: isRound ? '50%' : 10,
      cursor:'pointer', fontFamily:'inherit',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
      padding:6, textAlign:'center', overflow:'hidden',
      boxShadow: isMine ? '0 0 0 1px var(--acc-b) inset' : 'none',
    }}>
      <div style={{ fontSize:14, fontWeight:800, color: colour.fg, lineHeight:1 }}>{table.label}</div>
      {table.session ? (
        <>
          <div style={{ fontSize:9, color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{money(total)}</div>
          {elapsedStr && <div style={{ fontSize:9, color:'var(--t4)' }}>{elapsedStr}</div>}
        </>
      ) : (
        <div style={{ fontSize:9, color:'var(--t4)' }}>{table.covers || ''}</div>
      )}
    </button>
  );
}

function Legend({ color, label }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, color:'var(--t3)', fontWeight:700 }}>
      <span style={{ width:10, height:10, borderRadius:3, background:color, display:'inline-block' }}/>
      {label}
    </span>
  );
}
