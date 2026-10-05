// The Sites control on the reports shell (Peter, 5 Oct 2026: "make every report we have
// multi site when sites are connected together, and you can filter them down to just one
// site"). It sits next to the period filter. "All sites", or tick one or several. It starts
// on the site you are signed in to and the shell remembers the last choice.
//
// Hidden when the login has one site: nothing to choose, nothing to explain.
// The rules (who is connected, what is ticked) are in src/lib/reportScope.js; this only draws.

import { useEffect, useRef, useState } from 'react';
import { sitesLabel } from '../../../lib/reportScope.js';

const btnSt = { padding:'6px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, cursor:'pointer', fontFamily:'inherit', display:'inline-flex', alignItems:'center', gap:6 };
const rowSt = { display:'flex', alignItems:'center', gap:8, padding:'7px 10px', fontSize:12, color:'var(--t1)', cursor:'pointer', borderRadius:6 };

export default function SitesControl({ scope, onToggle, onAll, onOnlyHome, disabled = false }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!scope?.hasChoice) return null;
  const ticked = new Set(scope.tickedIds);
  return (
    <div ref={box} style={{ position:'relative' }}>
      <button type="button" disabled={disabled} onClick={() => setOpen(o => !o)} aria-haspopup="true" aria-expanded={open}
        title={disabled ? 'This report always shows every site' : 'Choose which sites the reports show'}
        style={{ ...btnSt, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'default' : 'pointer' }}>
        <span style={{ color:'var(--t4)' }}>Sites</span>
        <strong style={{ color:'var(--t1)', fontWeight:700 }}>{disabled ? `All sites (${scope.sites.length})` : sitesLabel(scope)}</strong>
        <span style={{ color:'var(--t4)', fontSize:10 }}>▾</span>
      </button>
      {open && !disabled && (
        <div role="menu" style={{ position:'absolute', top:'calc(100% + 4px)', left:0, zIndex:30, minWidth:240, maxHeight:340, overflow:'auto', padding:6, background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, boxShadow:'0 8px 24px rgba(0,0,0,.25)' }}>
          <label style={{ ...rowSt, fontWeight:700, borderBottom:'1px solid var(--bdr)', borderRadius:0, marginBottom:4 }}>
            <input type="checkbox" checked={scope.allTicked} onChange={() => (scope.allTicked ? onOnlyHome() : onAll())}/>
            All sites
            <span style={{ marginLeft:'auto', color:'var(--t4)', fontWeight:400 }}>{scope.tickedIds.length} of {scope.sites.length}</span>
          </label>
          {scope.sites.map(s => (
            <label key={s.id} style={rowSt}>
              <input type="checkbox" checked={ticked.has(s.id)} onChange={() => onToggle(s.id)}/>
              <span>{s.name}</span>
              {s.isHome && <span style={{ marginLeft:'auto', fontSize:10, color:'var(--t4)' }}>signed in</span>}
            </label>
          ))}
          <div style={{ padding:'6px 10px 4px', fontSize:10, color:'var(--t4)', lineHeight:1.5 }}>
            Each site is read on its own clock and business day. Refunds and receipts stay with the site you are signed in to.
          </div>
        </div>
      )}
    </div>
  );
}

// The small note under the filters when a report is not showing exactly what is ticked:
// "This report shows one site at a time. Showing Leeds." with a chooser when there is one.
export function SiteNote({ note, choices = [], value, onPick }) {
  if (!note) return null;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', margin:'-8px 0 16px', padding:'8px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:12, color:'var(--t3)' }}>
      <span>{note}</span>
      {choices.length > 1 && (
        <select value={value || ''} onChange={e => onPick(e.target.value)} aria-label="Site to show"
          style={{ padding:'4px 8px', borderRadius:6, background:'var(--bg1)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, fontFamily:'inherit', cursor:'pointer' }}>
          {choices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}
