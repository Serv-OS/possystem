import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { MENU_ITEMS as SEED_ITEMS } from '../../data/seed';
import { isMock } from '../../lib/supabase';
import { money } from '../../lib/currency';

const STATUS_LEVELS = [
  { id:'ok',       label:'In stock',   color:'var(--grn)', bg:'var(--grn-d)', border:'var(--grn-b)', threshold:0.4 },
  { id:'low',      label:'Running low', color:'var(--acc)', bg:'var(--acc-d)', border:'var(--acc-b)', threshold:0.15 },
  { id:'critical', label:'Critical',    color:'var(--red)', bg:'var(--red-d)', border:'var(--red-b)', threshold:0 },
  { id:'out',      label:'Out of stock',color:'var(--t4)',  bg:'var(--bg3)',   border:'var(--bdr)',   threshold:-1 },
];

function getStatus(count) {
  if (!count) return STATUS_LEVELS[0];
  if (count.remaining <= 0) return STATUS_LEVELS[3];
  // v5.5.316: guard par=0 → ratio would be Infinity/NaN and break the status bar
  const ratio = count.par > 0 ? count.remaining / count.par : 1;
  if (ratio <= 0.15) return STATUS_LEVELS[2];
  if (ratio <= 0.4)  return STATUS_LEVELS[1];
  return STATUS_LEVELS[0];
}

export default function Inventory() {
  const { menuItems: storeItems, dailyCounts, setDailyCount, clearDailyCount, eightySixIds, toggle86, showToast, markBOChange , menuCategories } = useStore();
  const MENU_ITEMS = (isMock && (!storeItems || storeItems.length === 0)) ? SEED_ITEMS : (storeItems || []);
  const cats = (menuCategories||[]).filter(c => !c.isSpecial && !c.parentId).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));

  // v5.5.569: variant rows like "Half" are meaningless on their own. Build a
  // parent-qualified label ("Heineken Half") and know which items are variant
  // PARENT containers (they have children) so we can hide them — you count the
  // variants, not the empty container.
  const meta = useMemo(() => {
    const byId = {}; MENU_ITEMS.forEach(i => { byId[String(i.id)] = i; });
    const parents = new Set(MENU_ITEMS.filter(i => i.parentId).map(i => String(i.parentId)));
    const label = (i) => {
      if (!i?.parentId) return i?.name || '';
      const p = byId[String(i.parentId)];
      if (!p) return i.name || '';
      const n = (i.name || '').trim();
      return n.toLowerCase().startsWith((p.name || '').toLowerCase()) ? n : `${p.name} ${n}`.trim();
    };
    return { parents, label };
  }, [MENU_ITEMS]);

  const [catFilter, setCatFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [bulkMode, setBulkMode] = useState(false);

  const itemsWithStatus = useMemo(() => {
    return MENU_ITEMS
      // Hide modifier sub-items (e.g. "half and half") and variant PARENT containers;
      // show the sellable variants themselves with a parent-qualified name.
      .filter(i => !i.archived && i.type !== 'subitem' && !meta.parents.has(String(i.id)))
      .map(i => ({
        ...i,
        displayName: meta.label(i),
        count: dailyCounts[i.id] || null,
        status: getStatus(dailyCounts[i.id]),
        is86: eightySixIds.includes(i.id),
      }))
      .filter(i => {
        if (catFilter !== 'all' && i.cat !== catFilter) return false;
        if (statusFilter === 'tracked' && !i.count) return false;
        if (statusFilter === 'low' && i.status.id !== 'low' && i.status.id !== 'critical') return false;
        if (statusFilter === '86d' && !i.is86) return false;
        if (search && !i.displayName.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [MENU_ITEMS, dailyCounts, eightySixIds, catFilter, statusFilter, search, meta]);

  const summary = useMemo(() => {
    const all = MENU_ITEMS.filter(i => !i.archived);
    return {
      tracked:  all.filter(i => dailyCounts[i.id]).length,
      low:      all.filter(i => { const c = dailyCounts[i.id]; return c && c.remaining / c.par <= 0.4 && c.remaining > 0; }).length,
      critical: all.filter(i => { const c = dailyCounts[i.id]; return c && c.remaining / c.par <= 0.15; }).length,
      e86:      eightySixIds.length,
    };
  }, [MENU_ITEMS, dailyCounts, eightySixIds]);

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* Left panel — filters */}
      <div style={{ width:200, borderRight:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0, overflowY:'auto', padding:'14px 10px' }}>
        {/* Summary pills */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:8, padding:'0 4px' }}>Today</div>
          {[
            { label:`${summary.tracked} tracked`,  color:'var(--t3)', bg:'var(--bg3)' },
            { label:`${summary.low} low stock`,    color:'var(--acc)', bg:'var(--acc-d)', show: summary.low > 0 },
            { label:`${summary.critical} critical`,color:'var(--red)', bg:'var(--red-d)', show: summary.critical > 0 },
            { label:`${summary.e86} 86'd`,          color:'var(--red)', bg:'var(--red-d)', show: summary.e86 > 0 },
          ].filter(s => s.show !== false).map(s => (
            <div key={s.label} style={{ fontSize:11, fontWeight:700, padding:'4px 8px', borderRadius:7, marginBottom:4, background:s.bg, color:s.color }}>{s.label}</div>
          ))}
        </div>

        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:8, padding:'0 4px' }}>Status</div>
        {[['all','All items'], ['tracked','Tracked only'], ['low','Low / critical'], ['86d',"86'd"]].map(([id, label]) => (
          <button key={id} onClick={() => setStatusFilter(id)} style={{ width:'100%', padding:'7px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:statusFilter===id?700:400, border:'none', background:statusFilter===id?'var(--acc-d)':'transparent', color:statusFilter===id?'var(--acc)':'var(--t2)', textAlign:'left', marginBottom:1, borderLeft:`2px solid ${statusFilter===id?'var(--acc)':'transparent'}` }}>{label}</button>
        ))}

        <div style={{ height:1, background:'var(--bdr)', margin:'12px 0' }}/>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:8, padding:'0 4px' }}>Category</div>
        {[{id:'all',label:'All categories'}, ...cats].map(c => (
          <button key={c.id} onClick={() => setCatFilter(c.id)} style={{ width:'100%', padding:'7px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:catFilter===c.id?700:400, border:'none', background:catFilter===c.id?'var(--acc-d)':'transparent', color:catFilter===c.id?'var(--acc)':'var(--t2)', textAlign:'left', marginBottom:1, borderLeft:`2px solid ${catFilter===c.id?'var(--acc)':'transparent'}` }}>{c.label}</button>
        ))}
      </div>

      {/* Main content */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* Toolbar */}
        <div style={{ padding:'10px 18px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', gap:10, alignItems:'center', flexShrink:0 }}>
          <div style={{ position:'relative', flex:1, maxWidth:280 }}>
            <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--t4)', fontSize:13 }}>🔍</span>
            <input style={{ width:'100%', background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:10, padding:'8px 10px 8px 32px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' }}
              placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button onClick={() => {
              // Quick: 86 everything that's out
              const out = MENU_ITEMS.filter(i => { const c = dailyCounts[i.id]; return c && c.remaining <= 0 && !eightySixIds.includes(i.id); });
              out.forEach(i => toggle86(i.id));
              if (out.length) { markBOChange(); showToast(`${out.length} out-of-stock items 86'd`, 'warning'); }
              else showToast('No out-of-stock items to 86', 'info');
            }} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700 }}>
              86 all out-of-stock
            </button>
            <button onClick={() => setEditing('new')} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>
              + Set counts
            </button>
          </div>
        </div>

        {/* Table */}
        <div style={{ flex:1, overflowY:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:'var(--bg2)', position:'sticky', top:0, zIndex:1 }}>
                {['Item','Category','Status','Par / Remaining','86','Actions'].map(h => (
                  <th key={h} style={{ padding:'9px 14px', textAlign:'left', fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', borderBottom:'1px solid var(--bdr)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {itemsWithStatus.map((item, idx) => {
                const st = item.status;
                const count = item.count;
                const pct = count ? Math.min(100, (count.remaining / count.par) * 100) : null;

                return (
                  <tr key={item.id} style={{ borderBottom:'1px solid var(--bdr)', background:idx%2===0?'var(--bg)':'var(--bg1)', opacity:item.is86?.6:1 }}>
                    <td style={{ padding:'10px 14px', maxWidth:200 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>{item.displayName || item.name}</div>
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:1 }}>{money((item.price||0))}</div>
                    </td>
                    <td style={{ padding:'10px 14px', fontSize:11, color:'var(--t3)', textTransform:'capitalize' }}>
                      {(menuCategories||[]).find(c => c.id === item.cat)?.label || item.cat}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      {item.is86 ? (
                        <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:20, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)' }}>86'd</span>
                      ) : count ? (
                        <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:20, background:st.bg, border:`1px solid ${st.border}`, color:st.color }}>{st.label}</span>
                      ) : (
                        <span style={{ fontSize:10, color:'var(--t4)' }}>Not tracked</span>
                      )}
                    </td>
                    <td style={{ padding:'10px 14px', minWidth:160 }}>
                      {count ? (
                        <div>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                            <span style={{ fontSize:13, fontWeight:800, color:st.color, fontFamily:'var(--font-mono)' }}>{count.remaining}</span>
                            <span style={{ fontSize:11, color:'var(--t4)' }}>/ {count.par} par</span>
                          </div>
                          <div style={{ height:4, background:'var(--bg4)', borderRadius:2, overflow:'hidden', width:100 }}>
                            <div style={{ height:'100%', width:`${pct}%`, background:st.color, borderRadius:2, transition:'width .3s' }}/>
                          </div>
                        </div>
                      ) : (
                        <span style={{ fontSize:11, color:'var(--t4)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <button onClick={() => { toggle86(item.id); markBOChange(); showToast(item.is86 ? `${item.displayName || item.name} reinstated` : `${item.displayName || item.name} 86'd`, 'warning'); }} style={{
                        padding:'3px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit',
                        background: item.is86 ? 'var(--grn-d)' : 'var(--red-d)',
                        border:`1px solid ${item.is86 ? 'var(--grn-b)' : 'var(--red-b)'}`,
                        color: item.is86 ? 'var(--grn)' : 'var(--red)', fontSize:11, fontWeight:700,
                      }}>{item.is86 ? 'Reinstate' : '86'}</button>
                    </td>
                    <td style={{ padding:'10px 14px' }}>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => setEditing(item)} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>
                          {count ? 'Update' : 'Set count'}
                        </button>
                        {count && <button onClick={() => { clearDailyCount(item.id); showToast('Count cleared', 'info'); }} style={{ padding:'4px 8px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'transparent', border:'none', color:'var(--t4)', fontSize:11 }}>Clear</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {itemsWithStatus.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign:'center', padding:'60px', color:'var(--t4)' }}>
                  <div style={{ fontSize:28, marginBottom:8, opacity:.3 }}>📦</div>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)' }}>No items match filter</div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding:'7px 18px', borderTop:'1px solid var(--bdr)', fontSize:11, color:'var(--t4)', background:'var(--bg1)', flexShrink:0 }}>
          {itemsWithStatus.length} item{itemsWithStatus.length!==1?'s':''} shown · {summary.tracked} tracked · {summary.e86} 86'd
        </div>
      </div>

      {/* Count editor modal */}
      {editing && editing !== 'new' && (
        <CountModal item={editing} onClose={() => setEditing(null)}/>
      )}
      {editing === 'new' && (
        <BulkCountModal items={MENU_ITEMS.filter(i => !i.archived && i.type !== 'subitem' && !meta.parents.has(String(i.id))).map(i => ({ ...i, displayName: meta.label(i) }))} onClose={() => setEditing(null)}/>
      )}
    </div>
  );
}

function CountModal({ item, onClose }) {
  const { setDailyCount, clearDailyCount, dailyCounts, showToast } = useStore();
  const [val, setVal] = useState('');
  const current = dailyCounts[item.id];
  const press = d => d === '⌫' ? setVal(p=>p.slice(0,-1)) : val.length < 3 && setVal(p=>p+d);

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:320, boxShadow:'var(--sh3)', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:15, fontWeight:800 }}>Set portion count</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ padding:'18px 20px' }}>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--t1)', marginBottom:4 }}>{item.displayName || item.name}</div>
          {current && (
            <div style={{ fontSize:12, color:'var(--t4)', marginBottom:12 }}>Current: {current.remaining}/{current.par} remaining</div>
          )}
          <div style={{ height:52, borderRadius:12, border:'2px solid var(--acc-b)', background:'var(--acc-d)', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:10 }}>
            <span style={{ fontSize:32, fontWeight:800, color:val?'var(--acc)':'var(--t4)', fontFamily:'var(--font-mono)' }}>{val||'—'}</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5, marginBottom:8 }}>
            {[7,8,9,4,5,6,1,2,3,'',0,'⌫'].map((d,i)=>(
              <button key={i} onClick={()=>d!==''&&press(String(d))} style={{ height:40, borderRadius:9, cursor:d===''?'default':'pointer', fontFamily:'inherit', background:d==='⌫'?'var(--red-d)':d===''?'transparent':'var(--bg3)', border:d===''?'none':`1px solid ${d==='⌫'?'var(--red-b)':'var(--bdr)'}`, color:d==='⌫'?'var(--red)':'var(--t1)', fontSize:15, fontWeight:700, opacity:d===''?0:1 }}>{d}</button>
            ))}
          </div>
          <div style={{ display:'flex', gap:5, marginBottom:10 }}>
            {[4,6,8,10,12,16,20,24].map(n=>(
              <button key={n} onClick={()=>setVal(String(n))} style={{ flex:1, height:26, borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:val===String(n)?'var(--acc-d)':'var(--bg3)', border:`1px solid ${val===String(n)?'var(--acc)':'var(--bdr)'}`, color:val===String(n)?'var(--acc)':'var(--t3)', fontSize:10, fontWeight:700 }}>{n}</button>
            ))}
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {current && <button onClick={()=>{clearDailyCount(item.id);showToast('Count cleared','info');onClose();}} style={{ flex:1, height:38, borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700 }}>Clear</button>}
            <button onClick={()=>{if(val){setDailyCount(item.id,parseInt(val));showToast(`${item.displayName || item.name}: ${val} portions set`,'success');onClose();}}} disabled={!val} style={{ flex:2, height:38, borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:val?'var(--acc)':'var(--bg3)', border:'none', color:val?'#0b0c10':'var(--t4)', fontSize:13, fontWeight:800 }}>
              {val?`Set ${val} portions`:'Enter a number'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkCountModal({ items, onClose }) {
  const { setDailyCount, dailyCounts, showToast } = useStore();
  const [counts, setCounts] = useState({});
  const tracked = items.filter(i => dailyCounts[i.id]);
  const untracked = items.filter(i => !dailyCounts[i.id]);

  const applyAll = () => {
    let set = 0;
    Object.entries(counts).forEach(([id, val]) => {
      if (val && parseInt(val) > 0) { setDailyCount(id, parseInt(val)); set++; }
    });
    showToast(`${set} portion count${set!==1?'s':''} set`, 'success');
    onClose();
  };

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:520, maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'var(--sh3)', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div><div style={{ fontSize:15, fontWeight:800 }}>Set portion counts</div><div style={{ fontSize:12, color:'var(--t3)' }}>Bulk update — set today's portion limits</div></div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
          {untracked.slice(0,30).map(item => (
            <div key={item.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
              <span style={{ flex:1, fontSize:13, color:'var(--t1)' }}>{item.displayName || item.name}</span>
              <input type="number" min="0" max="999" placeholder="par" style={{ width:70, background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8, padding:'6px 8px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', textAlign:'center' }}
                value={counts[item.id]||''} onChange={e=>setCounts(c=>({...c,[item.id]:e.target.value}))}/>
            </div>
          ))}
        </div>
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" style={{ flex:2, height:40 }} onClick={applyAll}>Apply counts</button>
        </div>
      </div>
    </div>
  );
}
