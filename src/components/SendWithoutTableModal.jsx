import { useState } from 'react';
import { useStore } from '../store';
import { sortTables } from '../lib/sortTables';
import { money, currencySymbol } from '../lib/currency';

const STATUS = {
  available: { color:'#22c55e', bg:'rgba(34,197,94,.12)',  border:'rgba(34,197,94,.35)' },
  open:      { color:'#3b82f6', bg:'rgba(59,130,246,.12)', border:'rgba(59,130,246,.35)' },
  occupied:  { color:'#e8a020', bg:'rgba(232,160,32,.14)', border:'rgba(232,160,32,.4)'  },
  reserved:  { color:'#a855f7', bg:'rgba(168,85,247,.12)', border:'rgba(168,85,247,.35)' },
};

// ── Sub-modal: merge or split when table has items ────────────────────────────
function MergeOrSplitModal({ table, items, onMerge, onSplit, onBack }) {
  const existingItems = table.session?.items?.filter(i=>!i.voided) || [];
  return (
    <div>
      <div style={{ marginBottom:16, padding:'12px 14px', background:'var(--bg3)', borderRadius:12, border:'1px solid var(--bdr)' }}>
        <div style={{ fontSize:12, fontWeight:700, color:'var(--t2)', marginBottom:8 }}>{table.label} already has an order</div>
        <div style={{ fontSize:11, color:'var(--t3)' }}>
          {existingItems.length} item{existingItems.length!==1?'s':''} · {money((table.session?.subtotal||0))} · {table.session?.covers} covers · {table.session?.server}
        </div>
        {existingItems.slice(0,3).map(i=>(
          <div key={i.uid} style={{ fontSize:11, color:'var(--t4)', marginTop:3 }}>
            {i.qty>1?`${i.qty}× `:''}{i.name}
          </div>
        ))}
        {existingItems.length>3&&<div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>+{existingItems.length-3} more…</div>}
      </div>

      <div style={{ fontSize:12, color:'var(--t3)', marginBottom:14 }}>
        What would you like to do with your {items.length} new item{items.length!==1?'s':''}?
      </div>

      <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
        {/* Merge */}
        <button onClick={onMerge} style={{
          padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit',
          background:'var(--bg3)', border:'1.5px solid var(--bdr)',
          display:'flex', alignItems:'center', gap:14, textAlign:'left',
          transition:'all .12s',
        }}
        onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--grn-b)';e.currentTarget.style.background='var(--grn-d)';}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.background='var(--bg3)';}}>
          <span style={{ fontSize:28 }}>⊕</span>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Merge into {table.label}</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              Add your items to the existing check — one bill for the whole table
            </div>
          </div>
        </button>

        {/* Split */}
        <button onClick={onSplit} style={{
          padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit',
          background:'var(--bg3)', border:'1.5px solid var(--bdr)',
          display:'flex', alignItems:'center', gap:14, textAlign:'left',
          transition:'all .12s',
        }}
        onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.background='var(--acc-d)';}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.background='var(--bg3)';}}>
          <span style={{ fontSize:28 }}>⊗</span>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Create check 2 ({table.label}.2)</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              Your items become a separate check — two bills for one table
            </div>
          </div>
        </button>
      </div>

      <button className="btn btn-ghost btn-full" onClick={onBack}>← Back</button>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function SendWithoutTableModal({ items, onClose, onNameOrder, onSendToKitchen }) {
  const { tables, staff, seatTableWithItems, mergeItemsToTable, splitTableCheck } = useStore();
  const [mode, setMode] = useState('choose');       // choose | table_picker | merge_split | name_order
  const [selectedTable, setSelectedTable] = useState(null);
  const [orderName, setOrderName] = useState('');
  const [section, setSection] = useState('all');

  // v5.5.13: sort by section + natural-order label so T1, T2, T9, T10 render
  // in operator-friendly order. Pre-v5.5.13 the picker showed whatever order
  // the store happened to have — usually load order from Supabase or
  // mutation order. Operators expect alphabetical/numeric sort.
  const activeTables = sortTables(tables.filter(t =>
    (t.status==='open'||t.status==='occupied') && t.session && !t.parentId
  ));
  const availableTables = sortTables(tables.filter(t => t.status==='available' && !t.parentId));
  const filteredTables = sortTables((mode==='table_picker' ? tables.filter(t => !t.parentId) : []).filter(t =>
    section==='all' || t.section === section
  ));

  const sections = ['all', ...new Set(tables.filter(t=>!t.parentId).map(t=>t.section).filter(Boolean))];

  const handleTableSelect = (table) => {
    setSelectedTable(table);
    if (table.status==='open' || table.status==='occupied') {
      setMode('merge_split');
    } else {
      // Available table — seat and add items
      seatTableWithItems(table.id, items, { covers: 2, server: staff?.name || 'Server' });
      onClose();
      onSendToKitchen();
    }
  };

  const handleMerge = () => {
    mergeItemsToTable(selectedTable.id, items);
    onClose();
    onSendToKitchen();
  };

  const handleSplit = () => {
    splitTableCheck(selectedTable.id, items, staff?.name);
    onClose();
    onSendToKitchen();
  };

  const handleNameOrder = () => {
    if (!orderName.trim()) return;
    onNameOrder(orderName.trim());
    onClose();
  };

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:480, maxHeight:'88vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>

        {/* Header */}
        <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)' }}>
              {mode==='choose' ? 'Send order' :
               mode==='table_picker' ? 'Choose a table' :
               mode==='merge_split' ? `Add to ${selectedTable?.label}` :
               'Name this order'}
            </div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              {items.length} item{items.length!==1?'s':''} · dine-in without table
            </div>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {mode !== 'choose' && (
              <button className="btn btn-ghost btn-sm" onClick={()=>setMode('choose')}>← Back</button>
            )}
            <button onClick={onClose} style={{ width:30, height:30, borderRadius:8, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'18px 20px' }}>

          {/* ── Choose mode ── */}
          {mode==='choose' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16 }}>
                This is a dine-in order but no table is assigned. How do you want to proceed?
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {/* Add to table */}
                <button onClick={()=>setMode('table_picker')} style={{
                  padding:'18px 20px', borderRadius:16, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1.5px solid var(--bdr)',
                  display:'flex', alignItems:'center', gap:16, textAlign:'left', transition:'all .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';}}>
                  <span style={{ fontSize:32 }}>🪑</span>
                  <div>
                    <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>Add to a table</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:3 }}>
                      {availableTables.length} available · {activeTables.length} already open
                    </div>
                    <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
                      Can merge with an existing order or create a second check
                    </div>
                  </div>
                </button>

                {/* Name the order */}
                <button onClick={()=>setMode('name_order')} style={{
                  padding:'18px 20px', borderRadius:16, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1.5px solid var(--bdr)',
                  display:'flex', alignItems:'center', gap:16, textAlign:'left', transition:'all .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--grn-b)';}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';}}>
                  <span style={{ fontSize:32 }}>✏️</span>
                  <div>
                    <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>Name the order</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:3 }}>
                      E.g. "Bar stool 3", "Patio party", "Mike's group"
                    </div>
                    <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
                      Sends to kitchen as a named walk-in dine-in
                    </div>
                  </div>
                </button>
              </div>
            </>
          )}

          {/* ── Table picker ── */}
          {mode==='table_picker' && (
            <>
              {/* Section filter */}
              {sections.length > 2 && (
                <div style={{ display:'flex', gap:5, marginBottom:14 }}>
                  {sections.map(s=>(
                    <button key={s} onClick={()=>setSection(s)} style={{
                      padding:'4px 12px', borderRadius:20, cursor:'pointer', fontFamily:'inherit',
                      background:section===s?'var(--acc-d)':'var(--bg3)',
                      border:`1px solid ${section===s?'var(--acc-b)':'var(--bdr)'}`,
                      color:section===s?'var(--acc)':'var(--t3)',
                      fontSize:11, fontWeight:700, textTransform:'capitalize',
                    }}>{s==='all'?'All sections':s}</button>
                  ))}
                </div>
              )}

              {/* Active tables first */}
              {activeTables.filter(t=>section==='all'||t.section===section).length>0&&(
                <>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>
                    Open tables — tap to merge or split
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:8, marginBottom:16 }}>
                    {activeTables.filter(t=>section==='all'||t.section===section).map(table=>{
                      const sm = STATUS[table.status];
                      return (
                        <button key={table.id} onClick={()=>handleTableSelect(table)} style={{
                          padding:'12px 10px', borderRadius:12, cursor:'pointer', fontFamily:'inherit',
                          background:sm.bg, border:`1.5px solid ${sm.border}`,
                          display:'flex', flexDirection:'column', alignItems:'center', gap:4,
                          transition:'all .12s',
                        }}>
                          <div style={{ fontSize:16, fontWeight:800, color:sm.color }}>{table.label}</div>
                          <div style={{ fontSize:10, color:sm.color, opacity:.8 }}>
                            {table.session?.covers} cvr · {table.session?.server?.split(' ')[0]}
                          </div>
                          <div style={{ fontSize:10, color:'var(--t3)' }}>
                            {currencySymbol()}{(table.session?.subtotal||0).toFixed(0)} · {table.session?.items?.filter(i=>!i.voided).length} items
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Available tables */}
              {availableTables.filter(t=>section==='all'||t.section===section).length>0&&(
                <>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>
                    Available tables — tap to seat
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(100px,1fr))', gap:6 }}>
                    {availableTables.filter(t=>section==='all'||t.section===section).map(table=>{
                      const sm = STATUS.available;
                      return (
                        <button key={table.id} onClick={()=>handleTableSelect(table)} style={{
                          padding:'10px 8px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                          background:sm.bg, border:`1.5px solid ${sm.border}`,
                          display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                          transition:'all .12s',
                        }}>
                          <div style={{ fontSize:14, fontWeight:800, color:sm.color }}>{table.label}</div>
                          <div style={{ fontSize:10, color:sm.color, opacity:.7 }}>{table.maxCovers} max</div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Merge or split ── */}
          {mode==='merge_split' && selectedTable && (
            <MergeOrSplitModal
              table={selectedTable}
              items={items}
              onMerge={handleMerge}
              onSplit={handleSplit}
              onBack={()=>setMode('table_picker')}
            />
          )}

          {/* ── Name the order ── */}
          {mode==='name_order' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16 }}>
                Give this order a name so your team can identify it on the KDS and receipt.
              </div>
              <input
                className="input"
                placeholder="e.g. Bar stool 3, Patio table, Mike's group…"
                value={orderName}
                onChange={e=>setOrderName(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&handleNameOrder()}
                autoFocus
                style={{ fontSize:15, marginBottom:16 }}
              />
              {/* Suggestions */}
              <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:20 }}>
                {['Bar stool 1','Bar stool 2','Bar stool 3','Patio','Garden','Counter'].map(s=>(
                  <button key={s} onClick={()=>setOrderName(s)} style={{
                    padding:'4px 10px', borderRadius:20, cursor:'pointer', fontFamily:'inherit',
                    background:orderName===s?'var(--acc-d)':'var(--bg3)',
                    border:`1px solid ${orderName===s?'var(--acc-b)':'var(--bdr)'}`,
                    color:orderName===s?'var(--acc)':'var(--t3)',
                    fontSize:11, fontWeight:600,
                  }}>{s}</button>
                ))}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn-ghost" style={{ flex:1 }} onClick={()=>setMode('choose')}>← Back</button>
                <button className="btn btn-acc" style={{ flex:2, height:46 }}
                  disabled={!orderName.trim()}
                  onClick={handleNameOrder}>
                  Name & send to kitchen →
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
