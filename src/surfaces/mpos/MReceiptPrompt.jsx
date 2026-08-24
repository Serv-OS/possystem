// MReceiptPrompt — after a successful card payment, the server picks how the
// customer wants their receipt: Email · Print at counter · None.
// Email is the digital-first default (the whole point of MPOS — phones don't
// print). Print routes a print_job to the location's receipt printer via the
// existing PrintOrchestrator. None just skips and goes straight to MDone.

import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { sendEmailReceipt } from '../../lib/sendReceipt';
import { getActiveLocationSync } from '../../lib/supabase';
import { computeOrderTaxUnified } from '../../lib/taxCompute';
import { receiptTargetStatus } from '../../lib/printer';
import { Sx } from './MShellStyles';

export default function MReceiptPrompt({ check, onDone }) {
  const { customer, walkInOrder, locationConfig, printCustomerReceipt } = useStore();
  const [mode, setMode] = useState(null); // null | 'email' | 'print'
  const [email, setEmail] = useState(customer?.email || walkInOrder?.customer?.email || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // v5.5.835: can this handheld actually print? Receipts no longer fall back to
  // "whatever printer the venue has" — an MPOS with no printer assigned prints
  // nothing. Keep the button (it's a wanted feature) but grey it with the reason
  // rather than letting the server tap it and silently lose the receipt.
  const [printable, setPrintable] = useState(receiptTargetStatus);
  useEffect(() => {
    const refresh = () => setPrintable(receiptTargetStatus());
    window.addEventListener('rpos-receipt-target-updated', refresh);
    window.addEventListener('rpos-printers-updated', refresh);
    return () => {
      window.removeEventListener('rpos-receipt-target-updated', refresh);
      window.removeEventListener('rpos-printers-updated', refresh);
    };
  }, []);

  const finish = (note) => onDone?.({ deliveredVia: note });

  const sendEmail = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email');
      return;
    }
    setBusy(true); setError(null);
    const locationId = getActiveLocationSync();
    const result = await sendEmailReceipt({
      to: email.trim(),
      locationId,
      check,
      locationLabel: locationConfig?.name || locationConfig?.label || 'Restaurant',
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Could not send email — try again, or pick another method');
      return;
    }
    finish(`email · ${email.trim()}`);
  };

  const printAtCounter = async () => {
    setBusy(true); setError(null);
    try {
      // Reuses the existing receipt-print path. The job lands in print_jobs and
      // the master POS at the location dispatches it.
      // v5.5.341: include the VAT breakdown so the printed receipt shows the
      // tax lines (was omitted — receipts printed with no VAT). Prefer the
      // breakdown stored on the check; recompute from items as a fallback.
      const taxBreakdown = check.taxBreakdown
        || (() => { try { return computeOrderTaxUnified(check.items || [], useStore.getState().getTaxContext(), check.orderType || 'takeaway'); } catch { return null; } })();
      const result = await printCustomerReceipt?.({
        location: locationConfig,
        check,
        items: check.items,
        totals: { subtotal: check.subtotal, tip: check.tip, total: check.total, taxBreakdown },
      });
      // v5.5.835: printCustomerReceipt returns { ok, error? } — it does NOT throw on a
      // routing failure. This used to call finish('printed') unconditionally, so a
      // receipt that never printed still reported success to the server.
      if (!result?.ok) {
        setError(`${result?.error || 'No printer mapped to this device'} — try email instead.`);
        return;
      }
      finish('printed');
    } catch (e) {
      setError(e?.message || 'Print failed — try email instead');
    } finally {
      setBusy(false);
    }
  };

  // Mode picker
  if (!mode) {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Receipt</div>
            <div style={Sx.hSub}>Payment approved</div>
          </div>
        </div>
        <div style={Sx.scroller}>
          <div style={{ padding:'24px 16px 8px', textAlign:'center' }}>
            <div style={{ width:88, height:88, borderRadius:'50%', background:'var(--grn-d)', border:'3px solid var(--grn)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:48, color:'var(--grn)', margin:'0 auto 16px' }}>✓</div>
            <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>How would you like the receipt?</div>
            <div style={{ fontSize:13, color:'var(--t3)' }}>Email keeps it on the customer's phone — paper if they prefer.</div>
          </div>

          <div style={{ padding:'14px 16px', display:'flex', flexDirection:'column', gap:8 }}>
            <Method icon="✉️" title="Email" desc="Send a digital receipt to the customer's inbox" onClick={() => setMode('email')} />
            <Method icon="🧾" title="Print at counter"
              desc={printable.ok ? "Fire to the location's receipt printer" : printable.reason}
              disabled={!printable.ok}
              onClick={() => setMode('print')} />
            <Method icon="∅"  title="No receipt"      desc="Skip — customer doesn't want one"     onClick={() => finish('skipped')} />
          </div>
        </div>
      </div>
    );
  }

  // Email entry
  if (mode === 'email') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={() => setMode(null)} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Email receipt</div>
            <div style={Sx.hSub}>Customer's inbox</div>
          </div>
        </div>
        <div style={Sx.scroller}>
          <div style={{ padding:'20px 16px' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
              Customer email
            </div>
            <input
              value={email} onChange={(e) => setEmail(e.target.value)} type="email"
              placeholder="customer@example.com"
              autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              style={{
                width:'100%', padding:'14px 14px', borderRadius:12, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:16, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
              }}/>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:8 }}>
              We'll only use this address for this receipt. If the customer also opts in to marketing later, that's a separate consent.
            </div>
            {error && (
              <div style={{ marginTop:12, padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{error}</div>
            )}
          </div>
        </div>
        <div style={Sx.bottom}>
          <button onClick={sendEmail} disabled={busy || !email.trim()} style={{ ...Sx.btnPrim, opacity: busy || !email.trim() ? .6 : 1 }}>
            {busy ? 'Sending…' : 'Send receipt'}
          </button>
          <button onClick={() => finish('skipped')} style={{ ...Sx.btnGhost, marginTop:8 }}>Skip</button>
        </div>
      </div>
    );
  }

  // Print confirmation
  if (mode === 'print') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={() => setMode(null)} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Print receipt</div>
            <div style={Sx.hSub}>Sends to the counter receipt printer</div>
          </div>
        </div>
        <div style={Sx.scroller}>
          <div style={{ padding:'40px 16px', textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:14 }}>🧾</div>
            <div style={{ fontSize:15, color:'var(--t2)', maxWidth:340, margin:'0 auto', lineHeight:1.5 }}>
              The receipt will print at the location's receipt printer. Direct the customer to the counter to collect it.
            </div>
            {error && (
              <div style={{ marginTop:18, padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{error}</div>
            )}
          </div>
        </div>
        <div style={Sx.bottom}>
          <button onClick={printAtCounter} disabled={busy} style={{ ...Sx.btnPrim, opacity: busy ? .6 : 1 }}>
            {busy ? 'Sending…' : 'Print receipt'}
          </button>
          <button onClick={() => finish('skipped')} style={{ ...Sx.btnGhost, marginTop:8 }}>Skip</button>
        </div>
      </div>
    );
  }

  return null;
}

// v5.5.835: `disabled` greys the row and blocks the tap, but the row STAYS VISIBLE —
// an operator needs to see that printing exists and why it isn't available.
function Method({ icon, title, desc, onClick, disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:'14px 14px', borderRadius:14, border:'1px solid var(--bdr)',
      background:'var(--bg2)', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:14, minHeight:72, opacity: disabled ? .5 : 1,
    }}>
      <div style={{ fontSize:30, flexShrink:0, width:48, textAlign:'center' }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>{title}</div>
        <div style={{ fontSize:12, color: disabled ? 'var(--red)' : 'var(--t3)', marginTop:2, lineHeight:1.4 }}>{desc}</div>
      </div>
      <div style={{ fontSize:20, color:'var(--t4)' }}>{disabled ? '' : '›'}</div>
    </button>
  );
}
