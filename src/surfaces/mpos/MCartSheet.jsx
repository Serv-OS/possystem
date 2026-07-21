// MCartSheet — full-screen cart review for the active order. Reads items
// from either the active table's session or walkInOrder via the existing
// store helpers. Edit qty / remove pending items, or send to kitchen.
//
// Phase 1B-aware buttons:
//   • "Send to kitchen"  — for any open order, fires sendToKitchen()
//   • "Send & take payment" — for walk-in flows, lands at MTender (1C)
//   • "Done" — for table service after sending, returns to MTableView
//
// Sent items show as locked (status:'sent') — qty/remove blocked. Pending
// items are editable. Manager-PIN-gated voids land in 1D.

import { useMemo, useState, useEffect } from 'react';
import { useStore } from '../../store';
import { calculateOrderTax } from '../../lib/tax';
import { receiptTargetStatus } from '../../lib/printer';
import { Sx, money, STATUS_PILL } from './MShellStyles';
import MItemActions from './MItemActions';
import MOrderActions from './MOrderActions';

export default function MCartSheet({ onClose, onSend, onSendAndPay, onAddMore }) {
  const {
    activeTableId, tables, walkInOrder,
    removeItem, updateItemQty, orderType, setOrderNote,
    printCustomerReceipt, locationConfig, showToast, staff, taxRates = [],
  } = useStore();
  // Print-bill UX is optimistic: tap → haptic + immediate "Sending…" toast →
  // button re-enables after ~800ms (debounce, prevents accidental double-tap)
  // → print runs in background → success replaces toast with "Bill sent ✓",
  // failure replaces it with an error toast. Server doesn't wait staring at
  // a disabled button for 3-5s while Supabase round-trips.
  const [printing, setPrinting] = useState(false);

  // v5.5.835: receipts route to THIS device's assigned printer only — no venue-wide
  // fallback. Keep the Print bill button but grey it with the reason when this
  // handheld has no printer set, rather than firing a job that goes nowhere.
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

  const printBill = () => {
    if (printing) return;
    // Immediate tactile feedback: haptic on Android (silent no-op on iOS),
    // visual press state via the `printing` flag, optimistic toast within
    // the same animation frame. iOS Safari WebKit click latency is ~50-80ms;
    // doing this before any await keeps the perceived response under 100ms.
    try { navigator.vibrate?.(8); } catch {}
    setPrinting(true);
    showToast?.('Sending bill to printer…', 'info');
    // Auto-clear the "printing" flag after 800ms so the button re-enables
    // even if the background print takes longer. The optimistic toast (and
    // any subsequent success / error toast) covers the user-visible state.
    setTimeout(() => setPrinting(false), 800);

    // Build payload + fire print in the background. We don't await — the
    // server has already moved on visually. Errors surface as toasts later.
    (async () => {
      try {
        const liveItems = activeTableId
          ? (tables.find(t => t.id === activeTableId)?.session?.items || []).filter(i => !i.voided)
          : (walkInOrder?.items || []);
        const sub = liveItems.reduce((s, i) => {
          const base = (i.price || 0) * (i.qty || 0);
          return s + (i.discount?.value ? base * (1 - i.discount.value / 100) : base);
        }, 0);
        // v5.5.342: compute VAT so the printed bill shows the tax breakdown.
        const billTax = (() => { try { return calculateOrderTax(liveItems, taxRates, orderType); } catch { return null; } })();
        const checkShape = {
          id: `bill-${Date.now()}`,
          ref: activeTableId
            ? `Table ${tables.find(t => t.id === activeTableId)?.label || ''}`
            : (walkInOrder?.ref || 'Walk-in'),
          server: staff?.name || '',
          items: liveItems,
          subtotal: sub,
          tip: 0,
          total: sub,
          taxAmount: billTax?.totalTax ?? null,
          taxBreakdown: billTax,
          status: 'open',
          method: 'pending',
        };
        // 12s timeout safety — if the print pipeline hangs entirely (e.g.
        // Supabase insert never returns) we surface an error rather than
        // leave the user thinking it printed.
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve({ __timedOut: true }), 12_000));
        const printPromise = Promise.resolve(printCustomerReceipt?.({
          location: locationConfig, check: checkShape,
          items: liveItems,
          totals: { subtotal: sub, service: 0, tip: 0, grand: sub, taxBreakdown: billTax },
        }));
        const result = await Promise.race([printPromise, timeout]);
        if (result?.__timedOut) {
          showToast?.('Print timed out — check the printer / network', 'error');
        } else if (!result?.ok) {
          showToast?.(`Print failed: ${result?.error || 'no printer mapped'}`, 'error');
        } else if (result.transport === 'browser') {
          showToast?.('Bill opened in browser print dialog', 'info');
        } else if (result.transport === 'queued') {
          showToast?.('Bill queued — printing on counter printer', 'success');
        } else {
          showToast?.('Bill sent to printer ✓', 'success');
        }
      } catch (e) {
        showToast?.(`Print failed: ${e?.message || e}`, 'error');
      }
    })();
  };
  // Live order note from whichever store branch holds the active order
  const liveNote = activeTableId
    ? (tables.find(t => t.id === activeTableId)?.session?.orderNote || '')
    : (walkInOrder?.orderNote || '');
  // Item-actions sheet (course / discount / void per line)
  const [actionsItem, setActionsItem] = useState(null);
  // Order-actions sheet (whole-order discount / fire course / transfer / note)
  const [showOrderActions, setShowOrderActions] = useState(false);

  // Read live order data — table session or walk-in
  const sourceData = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return {
        kind:'table', label:`Table ${t?.label || activeTableId}`, sub:`${t?.session?.covers || 0} cover${t?.session?.covers === 1 ? '' : 's'}`,
        items: t?.session?.items || [], total: t?.session?.total || 0,
      };
    }
    const labelMap = {
      'takeaway':'Takeaway', 'collection':'Collection', 'delivery':'Delivery', 'dine-in':'Counter',
    };
    return {
      kind:'walkin', label: labelMap[orderType] || 'New order', sub: walkInOrder?.customer?.name || '',
      items: walkInOrder?.items || [], total: walkInOrder?.total || walkInOrder?.subtotal || 0,
    };
  }, [activeTableId, tables, walkInOrder, orderType]);

  const items = sourceData.items.filter(i => !i.voided);
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  // v5.5.342: surface VAT on the cart (was missing). Inclusive VAT is extracted
  // from the price (shown "incl. VAT"); exclusive is added.
  const taxResult = useMemo(() => { try { return calculateOrderTax(items, taxRates, orderType); } catch { return null; } }, [items, taxRates, orderType]);
  const tax = Number(taxResult?.totalTax) || 0;
  const taxExclusive = !!taxResult?.hasExclusiveTax;
  const cartCount = items.reduce((s, i) => s + (i.qty || 0), 0);
  const sentCount = items.filter(i => i.status === 'sent').length;
  const pendingCount = items.length - sentCount;

  const isWalkIn = sourceData.kind === 'walkin';
  const sendLabel = pendingCount > 0
    ? (isWalkIn ? `Send & take payment · ${money(subtotal)}` : `Send ${pendingCount} item${pendingCount === 1 ? '' : 's'} to kitchen`)
    : 'Take payment';

  const handlePrimary = () => {
    if (pendingCount === 0 && !isWalkIn) {
      // Nothing pending to send; this is the "go to tender" CTA on a fully-sent table
      onSendAndPay?.();
      return;
    }
    if (isWalkIn) {
      onSendAndPay?.();
    } else {
      onSend?.();
    }
  };

  return (
    <div style={Sx.shell}>
      {/* Header */}
      <div style={Sx.header}>
        <button onClick={onClose} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{sourceData.label}</div>
          <div style={Sx.hSub}>{sourceData.sub} · {cartCount} item{cartCount === 1 ? '' : 's'}</div>
        </div>
        {items.length > 0 && (
          <button onClick={() => setShowOrderActions(true)} style={Sx.iconBtn} aria-label="Order actions">⋯</button>
        )}
      </div>

      {/* Items — grouped by course, mirroring how the desktop POS shows
          dine-in checks. Course 0 is "Immediate" (drinks etc), 1 = starters,
          2 = mains, 3+ = later. Within each course, pending items render
          first with a clear "TO SEND" sub-header so the cashier can spot
          what's left to fire. */}
      <div style={Sx.scroller}>
        {items.length === 0 ? (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🧾</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>This order is empty</div>
            <div style={{ fontSize:12 }}>Tap Add items to start.</div>
          </div>
        ) : (
          <CourseGroupedItems
            items={items}
            onRemove={(uid) => removeItem(uid)}
            onInc={(uid) => updateItemQty(uid, +1)}
            onDec={(uid) => updateItemQty(uid, -1)}
            onActions={(it) => setActionsItem(it)}
          />
        )}

        {/* Order note */}
        {items.length > 0 && (
          <div style={{ padding:'8px 12px 4px' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>
              Order note
            </div>
            <textarea
              value={liveNote}
              onChange={(e) => setOrderNote(e.target.value.slice(0, 240))}
              placeholder="e.g. Allergy in party, table near window, ASAP…"
              style={{
                width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)',
                background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
                minHeight:56, resize:'vertical',
              }}/>
            <div style={{ fontSize:10, color:'var(--t4)', textAlign:'right', marginTop:2 }}>{liveNote.length}/240</div>
          </div>
        )}

        {items.length > 0 && (
          <div style={{ padding:'12px 16px 24px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'10px 0 4px', borderTop:'1px solid var(--bdr)' }}>
              <span style={{ fontSize:13, color:'var(--t3)', fontWeight:700 }}>{taxExclusive ? 'Subtotal' : 'Total'}</span>
              <span style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(taxExclusive ? subtotal + tax : subtotal)}</span>
            </div>
            {tax > 0 && (
              <div style={{ display:'flex', justifyContent:'space-between', paddingBottom:6, fontSize:11, color:'var(--t4)' }}>
                <span>{taxExclusive ? `Tax` : `incl. VAT`}</span>
                <span style={{ fontFamily:'var(--font-mono)' }}>{taxExclusive ? `+${money(tax)}` : money(tax)}</span>
              </div>
            )}
            {sentCount > 0 && (
              <div style={{ marginTop:6, fontSize:11, color:'var(--t4)', textAlign:'center' }}>
                {sentCount} item{sentCount === 1 ? '' : 's'} already sent · only pending items can be edited
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div style={Sx.bottom}>
        {items.length > 0 && pendingCount === 0 && !isWalkIn && (
          <div style={{ padding:'8px 0', textAlign:'center', fontSize:12, color:'var(--t3)' }}>
            All items sent — ready to take payment
          </div>
        )}
        <button onClick={handlePrimary} disabled={items.length === 0} style={{ ...Sx.btnPrim, opacity: items.length === 0 ? .4 : 1 }}>
          {sendLabel}
        </button>
        {items.length > 0 && (
          <div style={{ display:'flex', gap:8, marginTop:8 }}>
            <button
              onClick={printBill}
              disabled={printing || !printable.ok}
              title={printable.ok ? undefined : printable.reason}
              style={{
                ...Sx.btnGhost, flex:1,
                opacity: (printing || !printable.ok) ? .55 : 1,
                cursor: printable.ok ? 'pointer' : 'not-allowed',
                transform: printing ? 'scale(0.97)' : 'scale(1)',
                transition: 'transform .12s ease, opacity .12s ease, background .12s ease',
                background: printing ? 'var(--acc-d)' : Sx.btnGhost.background,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {printing ? '⏳ Sending…' : printable.ok ? '🧾 Print bill' : '🧾 No printer set'}
            </button>
            <button onClick={onAddMore} style={{ ...Sx.btnGhost, flex:1 }}>+ Add items</button>
          </div>
        )}
        {items.length === 0 && (
          <button onClick={onAddMore} style={{ ...Sx.btnGhost, marginTop:8 }}>+ Add more items</button>
        )}
      </div>

      {/* Per-item actions sheet (course change, discount, void) */}
      {actionsItem && (
        <MItemActions item={actionsItem} onClose={() => setActionsItem(null)} />
      )}
      {/* Whole-order ⋯ menu */}
      {showOrderActions && (
        <MOrderActions onClose={() => setShowOrderActions(false)} />
      )}
    </div>
  );
}

function CartLine({ item, onRemove, onInc, onDec, onActions }) {
  const sent = item.status === 'sent';
  const baseLine = (item.price || 0) * (item.qty || 0);
  const lineTotal = item.discount?.value
    ? baseLine * (1 - item.discount.value / 100)
    : baseLine;
  const modsList = (item.mods || [])
    .filter(m => !m?._instruction)
    .map(m => m?.name || m?.label || m).filter(Boolean);
  const instructionsList = (item.mods || [])
    .filter(m => m?._instruction)
    .map(m => m?.label || m?.name || m).filter(Boolean);
  return (
    <div onClick={onActions} style={{
      padding:'12px 14px', background:'var(--bg2)', borderRadius:12,
      border:`1px solid ${item.discount ? 'var(--grn-b)' : 'var(--bdr)'}`,
      marginBottom:8, display:'flex', flexDirection:'column', gap:8,
      opacity: sent ? .8 : 1, cursor:'pointer',
    }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:2 }}>
            <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{item.name}</span>
            {sent && <span style={{ ...Sx.pill, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>Sent</span>}
            {item.course != null && item.course > 0 && (
              <span style={{ ...Sx.pill, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>C{item.course}</span>
            )}
          </div>
          {modsList.length > 0 && (
            <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.4 }}>+ {modsList.join(' · ')}</div>
          )}
          {instructionsList.length > 0 && (
            <div style={{ fontSize:11, color:'var(--acc)', marginTop:2, lineHeight:1.4 }}>{instructionsList.join(' · ')}</div>
          )}
          {item.notes && (
            <div style={{ fontSize:11, color:'var(--acc)', marginTop:2, lineHeight:1.4 }}>📝 {item.notes}</div>
          )}
          {item.discount && (
            <div style={{ marginTop:6, display:'inline-block' }}>
              <span style={{ ...Sx.pill, background:'var(--grn-d)', color:'var(--grn)', border:'1px solid var(--grn-b)' }}>
                {item.discount.label || 'Discount'} · −{item.discount.value}%
              </span>
            </div>
          )}
        </div>
        <div style={{ textAlign:'right', flexShrink:0 }}>
          {item.discount ? (
            <>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{money(lineTotal)}</div>
              <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)', textDecoration:'line-through' }}>{money(baseLine)}</div>
            </>
          ) : (
            <>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money(lineTotal)}</div>
              <div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{money(item.price)} ea</div>
            </>
          )}
        </div>
      </div>

      {/* Qty stepper / remove — only on pending items. Buttons stop propagation
          so tapping +/− doesn't also open the actions sheet. */}
      {!sent && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <button onClick={(e) => { e.stopPropagation(); onDec(); }} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16 }}>−</button>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', minWidth:24, textAlign:'center', fontFamily:'var(--font-mono)' }}>{item.qty}</div>
          <button onClick={(e) => { e.stopPropagation(); onInc(); }} style={{ ...Sx.iconBtn, width:34, height:34, fontSize:16, background:'var(--acc-d)', color:'var(--acc)', borderColor:'var(--acc-b)' }}>+</button>
          <div style={{ flex:1 }}/>
          <span style={{ fontSize:11, color:'var(--t4)', fontWeight:700 }}>Tap row for ⋯</span>
        </div>
      )}
      {sent && (
        <div style={{ fontSize:11, color:'var(--t4)', textAlign:'center' }}>Tap row to void or apply discount</div>
      )}
    </div>
  );
}

// ── Course-grouped items ──────────────────────────────────────────────────────
// Mirrors the desktop POS check view: a section per course. Within a course,
// pending lines render before sent lines so the cashier sees what's still to
// fire at a glance. Course 0 = Immediate (drinks fired on send), 1 = starters,
// 2 = mains, 3+ = later courses.
function CourseGroupedItems({ items, onRemove, onInc, onDec, onActions }) {
  // Bucket by course
  const byCourse = items.reduce((acc, it) => {
    const c = it.course ?? 1;
    (acc[c] = acc[c] || []).push(it);
    return acc;
  }, {});
  const courseIds = Object.keys(byCourse).map(Number).sort((a, b) => a - b);

  const courseLabel = (c) =>
    c === 0 ? 'Immediate' :
    c === 1 ? 'Course 1 · Starters' :
    c === 2 ? 'Course 2 · Mains' :
    c === 3 ? 'Course 3 · Desserts' :
    `Course ${c}`;

  const courseAccent = (c) =>
    c === 0 ? '#3b82f6' :
    c === 1 ? '#22c55e' :
    c === 2 ? 'var(--acc)' :
    c === 3 ? '#a855f7' :
    'var(--t3)';

  return (
    <div style={{ padding:'8px 12px' }}>
      {courseIds.map(c => {
        const courseItems = byCourse[c];
        const pending = courseItems.filter(i => i.status !== 'sent');
        const sent    = courseItems.filter(i => i.status === 'sent');
        const courseSubtotal = courseItems.reduce((s, i) => {
          const base = (i.price || 0) * (i.qty || 0);
          return s + (i.discount?.value ? base * (1 - i.discount.value / 100) : base);
        }, 0);
        const accent = courseAccent(c);
        return (
          <div key={c} style={{ marginBottom:14 }}>
            {/* Course header */}
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 4px' }}>
              <span style={{
                fontSize:11, fontWeight:800, color:accent, textTransform:'uppercase', letterSpacing:'.07em',
                padding:'3px 9px', borderRadius:99,
                background:'rgba(255,255,255,0.04)', border:`1px solid ${accent}44`,
              }}>
                {courseLabel(c)}
              </span>
              <span style={{ fontSize:11, fontWeight:700, color:'var(--t4)' }}>
                {courseItems.length} item{courseItems.length === 1 ? '' : 's'}
              </span>
              <span style={{ flex:1, height:1, background:'var(--bdr)' }}/>
              <span style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                {money(courseSubtotal)}
              </span>
            </div>
            {pending.length > 0 && (
              <>
                {sent.length > 0 && (
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.06em', padding:'4px 4px 6px' }}>To send</div>
                )}
                {pending.map(it => (
                  <CartLine
                    key={it.uid} item={it}
                    onRemove={() => onRemove(it.uid)}
                    onInc={() => onInc(it.uid)}
                    onDec={() => onDec(it.uid)}
                    onActions={() => onActions(it)}
                  />
                ))}
              </>
            )}
            {sent.length > 0 && (
              <>
                {pending.length > 0 && (
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', padding:'8px 4px 6px' }}>Already sent</div>
                )}
                {sent.map(it => (
                  <CartLine
                    key={it.uid} item={it}
                    onRemove={() => onRemove(it.uid)}
                    onInc={() => onInc(it.uid)}
                    onDec={() => onDec(it.uid)}
                    onActions={() => onActions(it)}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
