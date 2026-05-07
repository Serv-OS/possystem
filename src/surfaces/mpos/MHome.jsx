// MHome — landing tab. Shows "Take order" CTA, my open tables, recent orders.

import { useStore } from '../../store';
import { Sx, money, elapsed, STATUS_PILL } from './MShellStyles';

export default function MHome({ onTakeOrder, onSeeOrders, onSeeTables }) {
  const { staff, tables = [], closedChecks = [], orderQueue = [] } = useStore();
  const myName = staff?.name?.toLowerCase();

  // My open tables — occupied tables this server seated (or all if no seater info)
  const myTables = tables.filter(t =>
    t.status !== 'available' && t.session &&
    (!myName || (t.session.server || '').toLowerCase() === myName)
  );

  // Recent paid (last 5)
  const recentClosed = [...closedChecks]
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 5);

  // Active queue orders (received / prep / ready) — handy quick glance
  const liveQueue = orderQueue.filter(o => !['collected', 'paid'].includes(o.status));

  return (
    <div style={Sx.scroller}>
      {/* Header / greeting */}
      <div style={{ padding:'18px 16px 8px' }}>
        <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700, marginBottom:2 }}>
          Hi {staff?.name?.split(' ')[0] || ''}
        </div>
        <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>
          What are you taking?
        </div>
      </div>

      {/* Big primary CTA */}
      <div style={{ padding:'12px 14px 4px' }}>
        <button onClick={onTakeOrder} style={{
          width:'100%', padding:'18px 16px', borderRadius:14, border:'none',
          background:'var(--acc)', color:'#0b0c10', fontSize:17, fontWeight:800, fontFamily:'inherit',
          cursor:'pointer', minHeight:64, display:'flex', alignItems:'center', justifyContent:'center', gap:10,
          boxShadow:'0 4px 14px rgba(0,0,0,.18)',
        }}>
          <span style={{ fontSize:24 }}>+</span>
          <span>Take a new order</span>
        </button>
      </div>

      {/* Quick stats row */}
      <div style={{ padding:'14px 14px 4px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        <button onClick={onSeeTables} style={{
          padding:'14px 12px', borderRadius:12, border:'1px solid var(--bdr)', background:'var(--bg2)',
          cursor:'pointer', fontFamily:'inherit', textAlign:'left',
        }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700 }}>My tables</div>
          <div style={{ fontSize:24, fontWeight:800, color:'var(--t1)', marginTop:2 }}>{myTables.length}</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{tables.filter(t => t.status === 'available').length} available</div>
        </button>
        <button onClick={onSeeOrders} style={{
          padding:'14px 12px', borderRadius:12, border:'1px solid var(--bdr)', background:'var(--bg2)',
          cursor:'pointer', fontFamily:'inherit', textAlign:'left',
        }}>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700 }}>Live queue</div>
          <div style={{ fontSize:24, fontWeight:800, color:'var(--t1)', marginTop:2 }}>{liveQueue.length}</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>{liveQueue.filter(o => o.status === 'ready').length} ready</div>
        </button>
      </div>

      {/* My open tables list */}
      {myTables.length > 0 && (
        <>
          <div style={Sx.sectionH}>
            <span>My open tables</span>
            <button onClick={onSeeTables} style={{ fontSize:11, color:'var(--acc)', background:'transparent', border:'none', cursor:'pointer', fontFamily:'inherit', fontWeight:700 }}>
              See all ›
            </button>
          </div>
          <div style={{ padding:'0 14px' }}>
            {myTables.slice(0, 5).map(t => (
              <div key={t.id} style={Sx.cardRow}>
                <div style={{ width:36, height:36, borderRadius:9, background:'var(--acc-d)', color:'var(--acc)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:13, flexShrink:0 }}>
                  {t.label}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Table {t.label}</div>
                  <div style={{ fontSize:11, color:'var(--t3)' }}>
                    {t.session?.covers ? `${t.session.covers} cover${t.session.covers === 1 ? '' : 's'} · ` : ''}
                    {elapsed(t.session?.seatedAt || t.session?.createdAt)}
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(t.session?.total)}</div>
                  <div style={{ fontSize:10, color:'var(--t4)' }}>{(t.session?.items || []).length} item{(t.session?.items || []).length === 1 ? '' : 's'}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Recently paid — for quick reprint / refund access */}
      <div style={Sx.sectionH}>
        <span>Recently paid</span>
        <button onClick={onSeeOrders} style={{ fontSize:11, color:'var(--acc)', background:'transparent', border:'none', cursor:'pointer', fontFamily:'inherit', fontWeight:700 }}>
          All orders ›
        </button>
      </div>
      <div style={{ padding:'0 14px 32px' }}>
        {recentClosed.length === 0 ? (
          <div style={{ ...Sx.card, textAlign:'center', color:'var(--t4)', fontSize:12 }}>
            No closed orders yet.
          </div>
        ) : recentClosed.map(c => {
          const pill = STATUS_PILL[c.status] || STATUS_PILL.paid;
          return (
            <div key={c.id} style={Sx.cardRow}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', display:'flex', gap:8, alignItems:'baseline' }}>
                  <span>{c.ref || c.id?.slice(0, 6)}</span>
                  <span style={{ ...Sx.pill, background:pill.bg, color:pill.fg, border:`1px solid ${pill.border}` }}>{pill.label}</span>
                </div>
                <div style={{ fontSize:11, color:'var(--t3)' }}>
                  {(c.items || []).length} item{(c.items || []).length === 1 ? '' : 's'} · {elapsed(c.closedAt)} ago
                </div>
              </div>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                {money(c.total)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
