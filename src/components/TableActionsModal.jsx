import { useState } from 'react';
import { useStore } from '../store';
import { sortTables } from '../lib/sortTables';

/**
 * Modal opened from the POS header when on a table.
 * Lets you edit covers or transfer / combine this table's order onto
 * another table. v4.6.28 adds the combine case (destination has its own
 * session) with a visual differentiator and a "Combine with" button.
 */
export default function TableActionsModal({ table, onClose }) {
  const { tables, updateCovers, transferTable, showToast } = useStore();
  const [tab, setTab]         = useState('covers');
  const [covers, setCovers]   = useState(table.session?.covers || 2);
  const [transferTo, setTransferTo] = useState(null);

  // v4.6.28: destinations = available (transfer) + occupied (combine).
  // Hide children (child table splits are handled elsewhere) and the
  // current table itself. Section match keeps it relevant.
  // v5.5.13: destination table picker is now natural-sorted by section +
  // label so transfer / combine flows match operator's mental model.
  const destinationTables = sortTables(tables.filter(t =>
    t.id !== table.id &&
    !t.parentId &&
    (t.status === 'available' || t.status === 'occupied')
  ));
  const isCombine = transferTo?.status === 'occupied';

  const handleSaveCovers = () => {
    updateCovers(table.id, covers);
    showToast(`${table.label} updated to ${covers} covers`, 'success');
    onClose();
  };

  const handleTransfer = () => {
    if (!transferTo) return;
    transferTable(table.id, transferTo.id);
    onClose();
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20,
        width:'100%', maxWidth:480, maxHeight:'88vh',
        display:'flex', flexDirection:'column', boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>
        {/* Header */}
        <div style={{ padding:'14px 18px 10px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>{table.label}</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              {table.session?.covers} covers · {table.session?.server} · {table.section}
            </div>
          </div>
          <button onClick={onClose} style={{ width:30, height:30, borderRadius:8, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', borderBottom:'1px solid var(--bdr)' }}>
          {[['covers','Edit covers'],['transfer','Move / Combine']].map(([t,l])=>(
            <button key={t} onClick={()=>setTab(t)} style={{
              flex:1, padding:'10px', cursor:'pointer', fontFamily:'inherit', border:'none',
              borderBottom:`2.5px solid ${tab===t?'var(--acc)':'transparent'}`,
              background:'transparent', color:tab===t?'var(--acc)':'var(--t3)',
              fontSize:12, fontWeight:tab===t?800:500, transition:'all .12s',
            }}>{l}</button>
          ))}
        </div>

        <div style={{ padding:'18px 20px' }}>

          {/* Edit covers */}
          {tab==='covers' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16 }}>
                How many guests are at this table. Affects service charge calculation and reporting.
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:20, marginBottom:24 }}>
                <button onClick={()=>setCovers(c=>Math.max(1,c-1))} style={{ width:48, height:48, borderRadius:12, border:'1.5px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:24, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:300 }}>−</button>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:42, fontWeight:800, color:'var(--t1)', lineHeight:1, fontFamily:'var(--font-mono)' }}>{covers}</div>
                  <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }}>guests · {table.maxCovers} max</div>
                </div>
                <button onClick={()=>setCovers(c=>Math.min(table.maxCovers,c+1))} style={{ width:48, height:48, borderRadius:12, border:'1.5px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:24, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:300 }}>+</button>
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
                <button className="btn btn-acc" style={{ flex:2, height:44 }}
                  disabled={covers === table.session?.covers}
                  onClick={handleSaveCovers}>
                  Update to {covers} covers
                </button>
              </div>
            </>
          )}

          {/* Move / Combine */}
          {tab==='transfer' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16 }}>
                Move this order to another table. <b>Empty tables</b> (green) transfer the order;
                {' '}<b>occupied tables</b> (amber) combine the orders onto that check.
                A kitchen notice is fired for any items already sent, so the kitchen sees the new location.
              </div>
              {destinationTables.length === 0 ? (
                <div style={{ textAlign:'center', padding:'24px 0', color:'var(--t3)' }}>
                  <div style={{ fontSize:28, marginBottom:8, opacity:.4 }}>–</div>
                  <div style={{ fontSize:13, fontWeight:600 }}>No other tables</div>
                  <div style={{ fontSize:12, marginTop:4 }}>There are no other tables in this section to move or combine with</div>
                </div>
              ) : (
                <>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(80px,1fr))', gap:8, marginBottom:20 }}>
                    {destinationTables.map(t => {
                      const occupied = t.status === 'occupied';
                      const selected = transferTo?.id === t.id;
                      // green = transfer target, amber = combine target, grey = not selected
                      const accent = occupied ? 'var(--amb,#e8a020)' : 'var(--grn)';
                      const bg = selected ? (occupied ? 'rgba(232,160,32,.16)' : 'var(--grn-d)') : 'var(--bg3)';
                      const border = selected ? accent : 'var(--bdr)';
                      return (
                        <button key={t.id} onClick={()=>setTransferTo(transferTo?.id===t.id?null:t)} style={{
                          padding:'10px 8px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                          background: bg,
                          border: `2px solid ${border}`,
                          display:'flex', flexDirection:'column', alignItems:'center', gap:3,
                          transition:'all .12s',
                        }}>
                          <div style={{ fontSize:16, fontWeight:800, color: selected ? accent : 'var(--t1)' }}>{t.label}</div>
                          <div style={{ fontSize:9, color: occupied ? accent : 'var(--t4)', fontWeight: occupied ? 700 : 400 }}>
                            {occupied ? 'occupied' : `${t.maxCovers} max`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
                    <button
                      className={isCombine ? 'btn btn-amb' : 'btn btn-grn'}
                      style={{ flex:2, height:44 }}
                      disabled={!transferTo}
                      onClick={handleTransfer}>
                      {!transferTo
                        ? 'Select a table'
                        : isCombine
                          ? `Combine with ${transferTo.label} →`
                          : `Transfer to ${transferTo.label} →`}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
