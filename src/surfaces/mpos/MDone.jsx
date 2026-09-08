// MDone — terminal screen of the order flow. Shows total / tip / change /
// receipt status and a big "Take next order" CTA to reset and go back to home.

import { Sx, money } from './MShellStyles';

export default function MDone({ check, deliveredVia, onNewOrder }) {
  const total = Number(check?.total) || 0;
  const tip = Number(check?.tip) || 0;
  return (
    <div style={Sx.shell}>
      <div style={Sx.scroller}>
        <div style={{ padding:'48px 16px 16px', textAlign:'center' }}>
          <div style={{
            width:104, height:104, borderRadius:'50%',
            background:'var(--grn-d)', border:'3px solid var(--grn)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:60, color:'var(--grn)', margin:'0 auto 22px',
          }}>✓</div>
          <div style={{ fontSize:26, fontWeight:800, color:'var(--grn)', marginBottom:8 }}>Order paid</div>
          {check?.ref && (
            <div style={{ fontSize:13, color:'var(--t3)', fontFamily:'var(--font-mono)', marginBottom:6 }}>
              Ref {check.ref}
            </div>
          )}
          <div style={{ fontSize:30, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', marginTop:14 }}>
            {money(total)}
          </div>
          {tip > 0 && (
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }}>incl. {money(tip)} tip</div>
          )}
        </div>

        <div style={{ padding:'8px 16px 16px', textAlign:'center' }}>
          <div style={{ display:'inline-block', padding:'10px 16px', borderRadius:99, background:'var(--bg2)', border:'1px solid var(--bdr)', fontSize:12, color:'var(--t3)' }}>
            {deliveredVia === 'printed'  && '🧾 Receipt sent to counter printer'}
            {deliveredVia === 'skipped'  && '∅ No receipt'}
            {typeof deliveredVia === 'string' && deliveredVia.startsWith('email')
              && `✉️ Receipt emailed to ${deliveredVia.replace(/^email\s·\s/, '')}`}
            {!deliveredVia && '🍽 Kitchen has been notified'}
          </div>
        </div>
      </div>

      <div style={Sx.bottom}>
        <button onClick={onNewOrder} style={Sx.btnPrim}>Take next order</button>
      </div>
    </div>
  );
}
