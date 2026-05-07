// MCoversPicker — full-screen cover-count picker, shown when an empty table
// is tapped before the session opens. Big +/− buttons + quick chips for
// 1–8 covers (covers most cases in two taps).

import { useState } from 'react';
import { useStore } from '../../store';
import { Sx } from './MShellStyles';

export default function MCoversPicker({ table, onSeated, onCancel }) {
  const { staff, seatTable } = useStore();
  const [covers, setCovers] = useState(2);

  const seat = () => {
    seatTable(table.id, { covers, server: staff?.name || 'Staff' });
    onSeated?.();
  };

  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onCancel} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Seat Table {table?.label}</div>
          {table?.section && <div style={Sx.hSub}>{table.section}</div>}
        </div>
      </div>

      <div style={Sx.scroller}>
        <div style={{ padding:'40px 16px 24px', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700, marginBottom:8 }}>
            How many guests?
          </div>

          {/* Stepper */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:24, marginBottom:30 }}>
            <button onClick={() => setCovers(c => Math.max(1, c - 1))} style={{ ...Sx.iconBtn, width:64, height:64, fontSize:32, fontWeight:800 }}>−</button>
            <div style={{ width:120 }}>
              <div style={{ fontSize:80, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', lineHeight:1, letterSpacing:'-.02em' }}>{covers}</div>
              <div style={{ fontSize:13, color:'var(--t3)', marginTop:4 }}>cover{covers === 1 ? '' : 's'}</div>
            </div>
            <button onClick={() => setCovers(c => Math.min(99, c + 1))} style={{ ...Sx.iconBtn, width:64, height:64, fontSize:32, fontWeight:800, background:'var(--acc-d)', color:'var(--acc)', borderColor:'var(--acc-b)' }}>+</button>
          </div>

          {/* Quick chips */}
          <div style={{ display:'flex', justifyContent:'center', gap:6, flexWrap:'wrap', padding:'0 12px', marginBottom:14 }}>
            {[1,2,3,4,5,6,7,8].map(n => (
              <button key={n} onClick={() => setCovers(n)} style={{
                width:42, height:42, borderRadius:'50%',
                border:`1.5px solid ${covers === n ? 'var(--acc)' : 'var(--bdr2)'}`,
                background: covers === n ? 'var(--acc-d)' : 'var(--bg2)',
                color: covers === n ? 'var(--acc)' : 'var(--t2)',
                fontSize:14, fontWeight:800, fontFamily:'var(--font-mono)', cursor:'pointer',
              }}>{n}</button>
            ))}
          </div>

          <div style={{ fontSize:11, color:'var(--t4)' }}>You can change this later from the table.</div>
        </div>
      </div>

      <div style={Sx.bottom}>
        <button onClick={seat} style={Sx.btnPrim}>Open Table {table?.label} for {covers} guest{covers === 1 ? '' : 's'}</button>
        <button onClick={onCancel} style={{ ...Sx.btnGhost, marginTop:8 }}>Cancel</button>
      </div>
    </div>
  );
}
