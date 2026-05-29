import { useStore } from '../store';
import { money } from '../lib/currency';

export default function CheckSelectorModal({ parentTable, onSelect, onClose }) {
  const { tables } = useStore();

  const children = tables.filter(t => t.parentId === parentTable.id);
  const allChecks = [parentTable, ...children];

  const totalRevenue = allChecks.reduce((s,t) => s + (t.session?.subtotal||0), 0);

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:420, maxHeight:'80vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>

        {/* Header */}
        <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)' }}>{parentTable.label}</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
            {allChecks.length} checks open · {money(totalRevenue)} total · {parentTable.session?.covers} covers
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'14px 18px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:12 }}>
            Which check would you like to work on?
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {allChecks.map((check, idx) => {
              const session = check.session;
              const itemCount = session?.items?.filter(i=>!i.voided).length || 0;
              const sentCount = session?.items?.filter(i=>i.status==='sent'&&!i.voided).length || 0;
              const pendingCount = session?.items?.filter(i=>i.status==='pending'&&!i.voided).length || 0;

              return (
                <button key={check.id} onClick={()=>onSelect(check.id)} style={{
                  padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1.5px solid var(--bdr)',
                  textAlign:'left', transition:'all .14s', width:'100%',
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.background='var(--acc-d)';}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.background='var(--bg3)';}}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      {/* Check number circle */}
                      <div style={{ width:32, height:32, borderRadius:8, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:800, color:'var(--acc)', flexShrink:0 }}>
                        {idx+1}
                      </div>
                      <div>
                        <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>{check.label}</div>
                        <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>
                          {session?.server} · {session?.covers} covers
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:18, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>
                        {money((session?.subtotal||0))}
                      </div>
                    </div>
                  </div>

                  {/* Items preview */}
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
                    {sentCount>0&&<span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:20, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>✓ {sentCount} sent</span>}
                    {pendingCount>0&&<span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:20, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)' }}>⏳ {pendingCount} pending</span>}
                    {itemCount===0&&<span style={{ fontSize:10, color:'var(--t4)' }}>Empty check</span>}
                  </div>

                  {/* Item list preview */}
                  {session?.items?.filter(i=>!i.voided).slice(0,3).map((item, i) => (
                    <div key={i} style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                      {item.qty>1?`${item.qty}× `:''}{item.name}
                    </div>
                  ))}
                  {itemCount>3&&<div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>+{itemCount-3} more items…</div>}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ padding:'12px 18px', borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
          <button className="btn btn-ghost btn-full" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
