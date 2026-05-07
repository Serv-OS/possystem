// MOrderDetail — view a closed check. Reprint receipt (existing print path),
// resend email receipt, and a manager-PIN-gated refund flow. Refund options:
// full refund OR partial (pick items + qty). Routes through the same
// store.refundCheck the desktop POS uses so the audit log is consistent.

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { sendEmailReceipt } from '../../lib/sendReceipt';
import { getActiveLocationSync } from '../../lib/supabase';
import { Sx, money } from './MShellStyles';
import MManagerPin, { getCachedManagerAuth } from './MManagerPin';

export default function MOrderDetail({ check, onBack }) {
  const { closedChecks = [], refundCheck, printCustomerReceipt, locationConfig, showToast } = useStore();
  // Read live record so refunds applied during this session reflect immediately
  const live = closedChecks.find(c => c.id === check?.id) || check;

  const [view, setView] = useState('main'); // main | refund-pick | resend-email
  const [refundQtys, setRefundQtys] = useState({}); // uid -> qty to refund
  const [reason, setReason] = useState('');
  const [pendingApproval, setPendingApproval] = useState(null); // { items, isFullRefund, amount, reason, tenderMethod }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [emailTo, setEmailTo] = useState(typeof live?.customer === 'object' ? live.customer?.email || '' : '');

  const items = useMemo(() => (live.items || []).filter(i => !i.voided), [live]);
  const refundedAmount = (live.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const remaining = (Number(live.total) || 0) - refundedAmount;

  // ── Reprint receipt (existing print path) ──────────────────────────────
  const reprint = async () => {
    setBusy(true); setError(null);
    try {
      await printCustomerReceipt?.({
        location: locationConfig, check: live,
        items: live.items, totals: { subtotal: live.subtotal, tip: live.tip, total: live.total },
      });
      showToast?.('Receipt sent to printer', 'success');
    } catch (e) {
      setError(e?.message || 'Print failed');
    } finally { setBusy(false); }
  };

  // ── Resend email receipt ───────────────────────────────────────────────
  const sendEmail = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo.trim())) {
      setError('Please enter a valid email');
      return;
    }
    setBusy(true); setError(null);
    const result = await sendEmailReceipt({
      to: emailTo.trim(),
      locationId: getActiveLocationSync(),
      check: live,
      locationLabel: locationConfig?.name || locationConfig?.label || 'Restaurant',
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Could not send email');
      return;
    }
    showToast?.('Receipt emailed', 'success');
    setView('main');
  };

  // ── Refund flow ─────────────────────────────────────────────────────────
  const setQty = (uid, qty) => setRefundQtys(prev => ({ ...prev, [uid]: qty }));
  const totalToRefund = useMemo(() => {
    return items.reduce((s, it) => s + ((refundQtys[it.uid] || 0) * (it.price || 0)), 0);
  }, [items, refundQtys]);
  const allRefundCount = items.reduce((s, it) => s + (it.qty || 0), 0);
  const pickedCount = Object.values(refundQtys).reduce((s, q) => s + q, 0);

  const startFullRefund = () => {
    const refundItems = items.map(it => ({
      uid: it.uid, name: it.name, price: it.price, qty: it.qty, refundQty: it.qty,
    }));
    proposeRefund({
      items: refundItems,
      isFullRefund: true,
      amount: remaining,
      reason: reason.trim() || 'Full refund',
      tenderMethod: live.method || 'card',
    });
  };

  const startPartialRefund = () => {
    const refundItems = items
      .filter(it => (refundQtys[it.uid] || 0) > 0)
      .map(it => ({
        uid: it.uid, name: it.name, price: it.price, qty: it.qty,
        refundQty: refundQtys[it.uid],
      }));
    if (!refundItems.length) { setError('Pick at least one item to refund'); return; }
    proposeRefund({
      items: refundItems,
      isFullRefund: false,
      amount: totalToRefund,
      reason: reason.trim() || 'Partial refund',
      tenderMethod: live.method || 'card',
    });
  };

  const proposeRefund = (refund) => {
    // Manager-PIN gate. 90-second grace skips the prompt for follow-up refunds.
    const cached = getCachedManagerAuth();
    if (cached) { commitRefund(refund, cached); return; }
    setPendingApproval(refund);
  };

  const commitRefund = (refund, manager) => {
    refundCheck(live.id, { ...refund, manager });
    setRefundQtys({}); setReason(''); setView('main');
    showToast?.(`Refund of ${money(refund.amount)} processed`, 'success');
  };

  // ── Render ──────────────────────────────────────────────────────────────
  if (view === 'resend-email') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={() => setView('main')} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Email receipt</div>
            <div style={Sx.hSub}>Ref {live.ref || live.id?.slice(0,6)}</div>
          </div>
        </div>
        <div style={Sx.scroller}>
          <div style={{ padding:'18px 16px' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>Customer email</div>
            <input
              value={emailTo} onChange={(e) => setEmailTo(e.target.value)} type="email"
              placeholder="customer@example.com"
              autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              style={{
                width:'100%', padding:'14px 14px', borderRadius:12, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:16, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
              }}/>
            {error && <div style={{ marginTop:12, padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{error}</div>}
          </div>
        </div>
        <div style={Sx.bottom}>
          <button onClick={sendEmail} disabled={busy || !emailTo.trim()} style={{ ...Sx.btnPrim, opacity: busy || !emailTo.trim() ? .6 : 1 }}>
            {busy ? 'Sending…' : 'Send receipt'}
          </button>
          <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:8 }}>Cancel</button>
        </div>
      </div>
    );
  }

  if (view === 'refund-pick') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={() => setView('main')} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Refund items</div>
            <div style={Sx.hSub}>Pick which to refund · Ref {live.ref || ''}</div>
          </div>
        </div>
        <div style={Sx.scroller}>
          <div style={{ padding:'10px 12px' }}>
            {items.map(it => {
              const max = it.qty || 0;
              const q = refundQtys[it.uid] || 0;
              return (
                <div key={it.uid} style={{ padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)', marginBottom:8 }}>
                  <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                    <span style={{ flex:1, fontSize:13, fontWeight:700, color:'var(--t1)' }}>{it.name}</span>
                    <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>
                      {money(it.price)} × {it.qty}
                    </span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:10 }}>
                    <span style={{ fontSize:11, color:'var(--t4)', fontWeight:700 }}>Refund qty</span>
                    <div style={{ flex:1 }}/>
                    <button onClick={() => setQty(it.uid, Math.max(0, q - 1))} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16 }}>−</button>
                    <div style={{ fontSize:14, fontWeight:800, color: q > 0 ? 'var(--red)' : 'var(--t1)', minWidth:26, textAlign:'center', fontFamily:'var(--font-mono)' }}>{q}</div>
                    <button onClick={() => setQty(it.uid, Math.min(max, q + 1))} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16, background:'var(--red-d)', color:'var(--red)', borderColor:'var(--red-b)' }}>+</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding:'4px 14px 14px' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Refund reason</div>
            <textarea
              value={reason} onChange={(e) => setReason(e.target.value.slice(0, 240))}
              placeholder="e.g. wrong item, customer unhappy, kitchen error"
              style={{
                width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
                minHeight:54, resize:'vertical',
              }}/>
            {error && <div style={{ marginTop:8, padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{error}</div>}
          </div>
        </div>

        <div style={Sx.bottom}>
          <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 4px 10px', fontSize:13, fontWeight:700 }}>
            <span style={{ color:'var(--t3)' }}>Refund total</span>
            <span style={{ color:'var(--red)', fontFamily:'var(--font-mono)' }}>{money(totalToRefund)}</span>
          </div>
          <button
            onClick={startPartialRefund} disabled={pickedCount === 0}
            style={{ ...Sx.btnPrim, background:'var(--red)', color:'#fff', opacity: pickedCount === 0 ? .5 : 1 }}>
            Refund {pickedCount} item{pickedCount === 1 ? '' : 's'} · {money(totalToRefund)}
          </button>
          <button onClick={() => setView('main')} style={{ ...Sx.btnGhost, marginTop:8 }}>Cancel</button>
        </div>

        {pendingApproval && (
          <MManagerPin
            reason={`Approve refund of ${money(pendingApproval.amount)} — ${pendingApproval.reason}`}
            onApprove={(manager) => {
              const r = pendingApproval; setPendingApproval(null);
              commitRefund(r, manager);
            }}
            onCancel={() => setPendingApproval(null)}
          />
        )}
      </div>
    );
  }

  // Main view
  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>Order {live.ref || live.id?.slice(0,6)}</div>
          <div style={Sx.hSub}>
            {live.tableLabel ? `${live.tableLabel} · ` : ''}
            {live.server || ''}
            {live.closedAt ? ` · ${new Date(live.closedAt).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' })}` : ''}
          </div>
        </div>
      </div>

      <div style={Sx.scroller}>
        {/* Total summary */}
        <div style={{ margin:'14px 14px 8px', padding:'14px 16px', background:'var(--bg2)', borderRadius:14, border:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:6 }}>
            <span>Subtotal</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(live.subtotal)}</span>
          </div>
          {live.taxAmount > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:6 }}>
              <span>Tax</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(live.taxAmount)}</span>
            </div>
          )}
          {live.tip > 0 && (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:6 }}>
              <span>Tip</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(live.tip)}</span>
            </div>
          )}
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:8, paddingTop:8, borderTop:'1px solid var(--bdr)', fontSize:16, fontWeight:800 }}>
            <span>Total</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(live.total)}</span>
          </div>
          {refundedAmount > 0 && (
            <div style={{ marginTop:8, padding:'8px 10px', borderRadius:8, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>
              {money(refundedAmount)} refunded · {money(remaining)} remaining
            </div>
          )}
          <div style={{ marginTop:6, fontSize:11, color:'var(--t4)', textAlign:'right', textTransform:'capitalize' }}>
            Paid by {live.method || 'card'}
          </div>
        </div>

        {/* Items */}
        <div style={{ padding:'4px 14px' }}>
          {items.map(it => (
            <div key={it.uid} style={{ padding:'10px 12px', background:'var(--bg2)', borderRadius:11, border:'1px solid var(--bdr)', marginBottom:6, display:'flex', gap:10, alignItems:'flex-start' }}>
              <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:22, paddingTop:1 }}>
                {it.qty}×
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{it.name}</div>
                {(it.mods || []).length > 0 && (
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>+ {it.mods.map(m => m?.name || m?.label || m).filter(Boolean).join(' · ')}</div>
                )}
                {it.notes && (
                  <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>📝 {it.notes}</div>
                )}
              </div>
              <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                {money((it.price || 0) * (it.qty || 0))}
              </div>
            </div>
          ))}
        </div>

        {/* Refunds log */}
        {(live.refunds || []).length > 0 && (
          <div style={{ padding:'14px 14px 8px' }}>
            <div style={{ fontSize:11, fontWeight:800, color:'var(--red)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>Refunds</div>
            {live.refunds.map(r => (
              <div key={r.id} style={{ padding:'10px 12px', borderRadius:11, background:'var(--red-d)', border:'1px solid var(--red-b)', marginBottom:6 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                  <span style={{ fontSize:13, fontWeight:700, color:'var(--red)' }}>
                    {r.isFullRefund ? 'Full refund' : `${r.items?.length || 0} items`}
                  </span>
                  <span style={{ fontSize:13, fontWeight:800, color:'var(--red)', fontFamily:'var(--font-mono)' }}>
                    −{money(r.amount)}
                  </span>
                </div>
                <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                  {r.reason} · approved by {r.manager}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ height:24 }}/>
      </div>

      {/* Bottom action bar */}
      <div style={Sx.bottom}>
        {error && (
          <div style={{ padding:10, marginBottom:8, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>{error}</div>
        )}
        <div style={{ display:'flex', gap:8, marginBottom:8 }}>
          <button onClick={reprint} disabled={busy} style={{ ...Sx.btnGhost, flex:1 }}>
            🧾 Reprint
          </button>
          <button onClick={() => setView('resend-email')} style={{ ...Sx.btnGhost, flex:1 }}>
            ✉️ Email
          </button>
        </div>
        {remaining > 0 && (
          <>
            <button
              onClick={() => setView('refund-pick')}
              style={{ ...Sx.btnGhost, color:'var(--red)', borderColor:'var(--red-b)', marginBottom:8 }}>
              Refund items…
            </button>
            <button
              onClick={() => {
                setReason('Full refund — customer request');
                startFullRefund();
              }}
              style={{ ...Sx.btnPrim, background:'var(--red)', color:'#fff' }}>
              Refund whole order · {money(remaining)}
            </button>
          </>
        )}
        {remaining <= 0 && refundedAmount > 0 && (
          <div style={{ padding:10, borderRadius:10, background:'var(--bg3)', color:'var(--t3)', fontSize:12, textAlign:'center' }}>
            Order fully refunded
          </div>
        )}
      </div>

      {pendingApproval && (
        <MManagerPin
          reason={`Approve refund of ${money(pendingApproval.amount)} — ${pendingApproval.reason}`}
          onApprove={(manager) => {
            const r = pendingApproval; setPendingApproval(null);
            commitRefund(r, manager);
          }}
          onCancel={() => setPendingApproval(null)}
        />
      )}
    </div>
  );
}
