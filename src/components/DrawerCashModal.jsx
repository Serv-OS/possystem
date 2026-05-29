import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { money } from '../lib/currency';  // v5.5.326: multi-currency

/**
 * DrawerCashModal (v4.6.40)
 *
 * Shared denomination counter used for:
 *   - Cash in (open drawer with opening float)       — mode='in'
 *   - Cash out (close drawer, declare variance)      — mode='out'
 *
 * Renders the same UI for POS and back-office usage. The caller decides
 * whether the modal can be dismissed (locked={true} for the POS sign-in
 * gate which MUST be completed before any other POS action).
 */

const DENOMS = [
  { label: '£50 notes',  value: 50.00 },
  { label: '£20 notes',  value: 20.00 },
  { label: '£10 notes',  value: 10.00 },
  { label: '£5 notes',   value: 5.00  },
  { label: '£2 coins',   value: 2.00  },
  { label: '£1 coins',   value: 1.00  },
  { label: '50p coins',  value: 0.50  },
  { label: '20p coins',  value: 0.20  },
  { label: '10p coins',  value: 0.10  },
  { label: '5p coins',   value: 0.05  },
  { label: '2p coins',   value: 0.02  },
  { label: '1p coins',   value: 0.01  },
];

const fmt = (n) => money(n);
const fmtS = (n) => (n >= 0 ? '+' : '−') + money(Math.abs(n || 0));

export default function DrawerCashModal({
  mode,              // 'in' | 'out'
  drawer,            // drawer object { id, name, currentFloat, printerId }
  expectedCash = 0,  // for 'out' mode — sales + movements since cash-in
  locked = false,    // POS gate — can't cancel
  onClose,
  onComplete,        // called with { amount, denominations, variance }
}) {
  const openCashDrawer = useStore(s => s.openCashDrawer);
  const [counts, setCounts] = useState(Object.fromEntries(DENOMS.map(d => [d.value, 0])));
  const [quickAmount, setQuickAmount] = useState('');
  const [mode2, setMode2] = useState('denoms'); // 'denoms' | 'quick' — allow a flat amount entry
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawerFired, setDrawerFired] = useState(false);

  const total = useMemo(() => {
    if (mode2 === 'quick') return parseFloat(quickAmount) || 0;
    return DENOMS.reduce((s, d) => s + (counts[d.value] || 0) * d.value, 0);
  }, [counts, quickAmount, mode2]);

  const variance = mode === 'out' ? total - expectedCash : null;

  const setCount = (v, n) => setCounts(c => ({ ...c, [v]: Math.max(0, parseInt(n) || 0) }));

  const canSubmit = total >= 0 && !busy && (mode === 'out' || total > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onComplete?.({
        amount: total,
        denominations: mode2 === 'denoms' ? counts : null,
        variance,
        notes,
      });
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'in' ? `Cash in — ${drawer?.name || 'Drawer'}` : `Cash up — ${drawer?.name || 'Drawer'}`;
  const hint = mode === 'in'
    ? 'Count your opening float and enter it below. The drawer will open for service once you confirm.'
    : 'Count every denomination in the drawer. We compare against the expected total and log the variance.';
  const cta = mode === 'in' ? `Open drawer with ${fmt(total)}` : `Close with ${fmt(total)}`;

  return (
    <div className="modal-back" style={{ zIndex: 9999 }} onClick={e => !locked && e.target === e.currentTarget && onClose?.()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20,
        width:'100%', maxWidth:560, maxHeight:'92vh', display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
      }}>
        {/* Header */}
        <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div>
              <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)' }}>{title}</div>
              <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, lineHeight:1.45 }}>{hint}</div>
            </div>
            {locked && (
              <div style={{ fontSize:10, fontWeight:700, padding:'3px 9px', borderRadius:6, background:'var(--red-d)', color:'var(--red)', letterSpacing:'.07em' }}>LOCKED</div>
            )}
          </div>

          {/* Mode switch */}
          <div style={{ display:'flex', gap:6, marginTop:12 }}>
            {[['denoms','Count by denomination'],['quick','Quick total']].map(([m,l])=>(
              <button key={m} onClick={() => setMode2(m)}
                style={{
                  padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                  border: `1px solid ${mode2===m?'var(--acc)':'var(--bdr)'}`,
                  background: mode2===m ? 'var(--acc-d)' : 'var(--bg3)',
                  color: mode2===m ? 'var(--acc)' : 'var(--t3)',
                  fontSize:11, fontWeight:700,
                }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:'auto', padding:'14px 20px' }}>
          {mode2 === 'denoms' ? (
            <div>
              {DENOMS.map(d => {
                const qty = counts[d.value] || 0;
                const subtotal = qty * d.value;
                return (
                  <div key={d.value} style={{ display:'grid', gridTemplateColumns:'1fr 110px 80px', alignItems:'center', gap:10, marginBottom:7 }}>
                    <div style={{ fontSize:13, color:'var(--t2)', fontWeight:500 }}>{d.label}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <button onClick={() => setCount(d.value, qty - 1)}
                        style={{ width:28, height:28, borderRadius:5, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontSize:14, fontFamily:'inherit' }}>−</button>
                      <input type="number" min="0" value={qty || ''} placeholder="0"
                        onChange={e => setCount(d.value, e.target.value)}
                        style={{
                          width:48, padding:'5px 6px', textAlign:'center', fontSize:13, fontFamily:'var(--font-mono)',
                          borderRadius:5, border:'1px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)',
                        }}/>
                      <button onClick={() => setCount(d.value, qty + 1)}
                        style={{ width:28, height:28, borderRadius:5, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontSize:14, fontFamily:'inherit' }}>+</button>
                    </div>
                    <div style={{ fontSize:13, fontWeight:700, textAlign:'right', fontFamily:'var(--font-mono)', color: subtotal > 0 ? 'var(--acc)' : 'var(--t4)' }}>
                      {subtotal > 0 ? fmt(subtotal) : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding:'12px 0 4px' }}>
              <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>
                {mode === 'in' ? 'Opening float' : 'Counted cash'}
              </label>
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', fontWeight:700, fontSize:20, color:'var(--t3)' }}>£</span>
                <input type="number" step="0.01" min="0" value={quickAmount}
                  onChange={e => setQuickAmount(e.target.value)}
                  placeholder="0.00" autoFocus
                  style={{
                    width:'100%', padding:'14px 14px 14px 34px', fontSize:22, fontWeight:800,
                    fontFamily:'var(--font-mono)', borderRadius:10,
                    border:'1.5px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)',
                  }}/>
              </div>
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:8, lineHeight:1.45 }}>
                Enter the full amount in one go. For a proper audit trail, use Count by denomination instead.
              </div>
            </div>
          )}

          {mode === 'out' && (
            <div style={{ marginTop:14 }}>
              <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>Notes (optional)</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. till tape broken, recount needed, etc."
                style={{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', fontSize:13 }}/>
            </div>
          )}
        </div>

        {/* Footer totals + actions */}
        <div style={{ borderTop:'1px solid var(--bdr)', background:'var(--bg2)', padding:'14px 20px' }}>
          {mode === 'out' && (
            <>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:6 }}>
                <span style={{ fontSize:12, color:'var(--t3)' }}>Expected</span>
                <span style={{ fontSize:14, fontWeight:700, fontFamily:'var(--font-mono)', color:'var(--t2)' }}>{fmt(expectedCash)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:6 }}>
                <span style={{ fontSize:12, color:'var(--t3)' }}>Counted</span>
                <span style={{ fontSize:14, fontWeight:700, fontFamily:'var(--font-mono)', color:'var(--t1)' }}>{fmt(total)}</span>
              </div>
              <div style={{
                display:'flex', justifyContent:'space-between', alignItems:'center',
                padding:'7px 10px', borderRadius:8, marginBottom:12,
                background: Math.abs(variance) < 0.01 ? 'var(--grn-d)' : variance > 0 ? 'var(--acc-d)' : 'var(--red-d)',
                border: `1px solid ${Math.abs(variance) < 0.01 ? 'var(--grn-b)' : variance > 0 ? 'var(--acc-b)' : 'var(--red-b)'}`,
              }}>
                <span style={{ fontSize:11, fontWeight:700, color: Math.abs(variance) < 0.01 ? 'var(--grn)' : variance > 0 ? 'var(--acc)' : 'var(--red)' }}>Variance</span>
                <span style={{ fontSize:15, fontWeight:900, fontFamily:'var(--font-mono)', color: Math.abs(variance) < 0.01 ? 'var(--grn)' : variance > 0 ? 'var(--acc)' : 'var(--red)' }}>
                  {Math.abs(variance) < 0.01 ? '✓ Balanced' : fmtS(variance)}
                </span>
              </div>
            </>
          )}
          {mode === 'in' && (
            <>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:12 }}>
                <span style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Opening float</span>
                <span style={{ fontSize:20, fontWeight:900, fontFamily:'var(--font-mono)', color:'var(--acc)' }}>{fmt(total)}</span>
              </div>
              {/* v5.5.190: fire the cash drawer so the manager can place the float */}
              <button
                onClick={() => {
                  openCashDrawer?.({ type: 'drawer_open', reason: 'Cash-in: open drawer for float', amount: 0, force: true });
                  setDrawerFired(true);
                  setTimeout(() => setDrawerFired(false), 3000);
                }}
                style={{
                  width:'100%', padding:'10px 14px', borderRadius:8, marginBottom:10,
                  border: `1.5px solid ${drawerFired ? 'var(--grn-b)' : 'var(--bdr2)'}`,
                  background: drawerFired ? 'var(--grn-d)' : 'var(--bg3)',
                  color: drawerFired ? 'var(--grn)' : 'var(--t2)',
                  fontFamily:'inherit', cursor:'pointer', fontSize:13, fontWeight:700,
                  display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  transition:'all .2s',
                }}>
                <span style={{ fontSize:16 }}>{drawerFired ? '✓' : '💵'}</span>
                {drawerFired ? 'Drawer opened — place your float' : 'Open cash drawer'}
              </button>
            </>
          )}

          <div style={{ display:'flex', gap:8 }}>
            {!locked && (
              <button onClick={onClose} disabled={busy}
                style={{ padding:'11px 16px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontFamily:'inherit', cursor: busy ? 'not-allowed' : 'pointer', fontSize:13, fontWeight:600 }}>
                Cancel
              </button>
            )}
            <button onClick={handleSubmit} disabled={!canSubmit}
              style={{
                flex:1, padding:'11px 16px', borderRadius:8, border:'none',
                background: canSubmit ? (mode === 'in' ? 'var(--grn)' : 'var(--red)') : 'var(--bg4)',
                color: canSubmit ? '#fff' : 'var(--t4)',
                fontFamily:'inherit', cursor: canSubmit ? 'pointer' : 'not-allowed',
                fontSize:14, fontWeight:800,
              }}>
              {busy ? 'Working…' : cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
