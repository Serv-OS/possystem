// MSentConfirm — brief confirmation shown immediately after Send to Kitchen.
// The desktop POS just dumps you back into the table view; on a phone the
// server is more often moving on (next table, next walk-in) so we give them
// a one-tap "Take next order" CTA. They can also stay on the same table to
// add more items or take payment.
//
// For walk-in orders this screen also doubles as the "post-fire" landing —
// the order is in the kitchen, server can either take payment now or start
// a fresh walk-in.

import { Sx, money } from './MShellStyles';

export default function MSentConfirm({
  ticketCount, totalSent, isWalkIn, isTable, tableLabel,
  onTakeNext, onStayHere, onTakePayment,
}) {
  return (
    <div style={Sx.shell}>
      <div style={Sx.scroller}>
        <div style={{ padding:'48px 16px 16px', textAlign:'center' }}>
          <div style={{
            width:96, height:96, borderRadius:'50%',
            background:'var(--grn-d)', border:'3px solid var(--grn)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:54, color:'var(--grn)', margin:'0 auto 18px',
          }}>✓</div>
          <div style={{ fontSize:24, fontWeight:800, color:'var(--grn)', marginBottom:6 }}>Sent to kitchen</div>
          <div style={{ fontSize:14, color:'var(--t3)', marginBottom:6 }}>
            {ticketCount} item{ticketCount === 1 ? '' : 's'}{tableLabel ? ` · Table ${tableLabel}` : ''}
          </div>
          {totalSent > 0 && (
            <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', marginTop:8 }}>
              {money(totalSent)}
            </div>
          )}
        </div>
      </div>

      <div style={Sx.bottom}>
        <button onClick={onTakeNext} style={Sx.btnPrim}>Take next order</button>
        {isTable && (
          <>
            <button onClick={onTakePayment} style={{ ...Sx.btnGhost, marginTop:8 }}>
              Take payment for Table {tableLabel}
            </button>
            <button onClick={onStayHere} style={{ ...Sx.btnGhost, marginTop:8 }}>
              ← Add more to Table {tableLabel}
            </button>
          </>
        )}
        {isWalkIn && (
          <button onClick={onTakePayment} style={{ ...Sx.btnGhost, marginTop:8 }}>
            Take payment now
          </button>
        )}
      </div>
    </div>
  );
}
