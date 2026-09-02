// v5.5.155 — QR open-tab resume screen.
//
// First thing a returning QR customer sees when localStorage has a tab
// stashed for this slug+table AND the DB confirms the tab is still open
// (status != 'collected', customer.tab_open === true). They can:
//   • 🍽 Add more — drops them back into the menu with `existingTab`
//     context so the next checkout adds a NEW order_queue row tied to
//     the same payment_intent (= a new kitchen ticket, no new pre-auth)
//   • 🔒 Close & pay — captures the held pre-auth via /api/stripe-capture,
//     marks every round on this tab as collected, writes one closed_check
//     covering the lot, clears the localStorage stash
//
// Design ethos: super low friction. The customer is sat at a table, has
// already paid card auth — we trust the device + table match enough for
// silent resume. Higher-friction layers (tracker URL, phone fallback)
// kick in only when localStorage is missing.

import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { clearStashedTab } from '../../lib/qrTabStorage';
import { money } from '../../lib/currency';
import { ryftTab } from '../../lib/payments/ryft';

export default function TabResumeScreen({
  slug, tableId, tableLabel,
  tab, rounds, runningTotal, theme,
  onAddMore, onClosed, onAbandon,
}) {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  const handleClose = async () => {
    if (closing) return;
    if (!confirm(`Close your tab and charge ${money(runningTotal)} to your card?`)) return;
    // Route by processor (the stash carries it). Ryft holds are addressed by
    // payment_session_id; ryft-tab resolves the merchant account from
    // location_id. Default missing processor → stripe (pre-dual-processor tabs).
    const isRyft = (tab.processor === 'ryft') || (!tab.stripe_account && !!tab.payment_session_id);
    const ryftSession      = tab.payment_session_id || tab.payment_intent_id;
    const ryftCustomerId   = tab.ryft_customer_id || rounds?.[0]?.customer?.ryft_customer_id || null;
    const ryftStoredCardId = tab.ryft_payment_method_id || rounds?.[0]?.customer?.ryft_payment_method_id || null;
    const locId            = rounds?.[0]?.location_id || null;
    setClosing(true); setError('');
    try {
      // Capture the bill, clamped to the hold. Both paths yield the same shape:
      // { captured, captured_amount(minor), shortfall(minor), currency, amount }.
      let data;
      if (isRyft) {
        const r = await ryftTab('capture', { location_id: locId, payment_session_id: ryftSession, amount_minor: Math.round(runningTotal * 100) });
        const cap = Number(r.captured_amount || 0);
        // Real hold currency (echoed by capture) so an overage MIT matches it.
        data = { captured: !!r.success, captured_amount: cap, shortfall: Number(r.shortfall || 0), currency: (r.currency || 'gbp').toLowerCase(), amount: cap };
      } else {
        const res = await fetch('/api/stripe-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: tab.payment_intent_id,
            stripeAccount:   tab.stripe_account,
            amountToCapture: Math.round(runningTotal * 100),
          }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Capture failed');
      }
      if (!data.captured) throw new Error(data?.error || 'Capture failed');

      // Charge any shortfall off-session on the card saved at tab open.
      const shortfallMinor = Number(data.shortfall || 0);
      const paymentMethodId = rounds?.[0]?.customer?.payment_method_id || null;
      const hasSavedCard = isRyft ? (!!ryftCustomerId && !!ryftStoredCardId) : !!paymentMethodId;
      if (shortfallMinor > 0 && !hasSavedCard) {
        setError(`We charged ${money((data.amount / 100))} (the held amount). The remaining ${money((shortfallMinor / 100))} needs to be settled with staff.`);
      } else if (shortfallMinor > 0 && isRyft) {
        try {
          const ov = await ryftTab('overage', {
            location_id: locId,
            previous_session_id: ryftSession,
            customer_id: ryftCustomerId,
            stored_card_id: ryftStoredCardId,
            amount_minor: shortfallMinor,
            currency: data.currency || 'gbp',
          });
          if (!ov.charged) {
            console.warn('[TabResume] ryft overage not approved:', ov?.error || ov?.detail);
            setError(`We charged ${money((data.amount / 100))} to your card. The remaining ${money((shortfallMinor / 100))} could not be captured automatically — please ask staff to settle the balance.`);
          }
        } catch (e) {
          console.warn('[TabResume] ryft overage failed:', e?.message);
          setError(`We charged ${money((data.amount / 100))} to your card. The remaining ${money((shortfallMinor / 100))} could not be captured automatically — please ask staff to settle the balance.`);
        }
      } else if (shortfallMinor > 0) {
        try {
          const ovRes = await fetch('/api/stripe-charge-overage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stripeAccount: tab.stripe_account,
              paymentMethodId,
              amount: shortfallMinor,
              currency: data.currency || 'gbp',
              description: `QR tab overage · self-close · ${tab.payment_intent_id}`,
              metadata: {
                source: 'qr_overage',
                parent_payment_intent: tab.payment_intent_id,
                table_label: String(tab.table_label || tableLabel || ''),
              },
            }),
          });
          const ov = await ovRes.json();
          if (!ovRes.ok || !ov.ok) {
            console.warn('[TabResume] overage failed:', ov?.error);
            setError(`We charged ${money((data.amount / 100))} to your card. The remaining ${money((shortfallMinor / 100))} could not be captured automatically — please ask staff to settle the balance.`);
          }
        } catch (e) {
          console.warn('[TabResume] overage failed:', e?.message);
        }
      }

      // Mark every round on this tab as collected so they leave the
      // operator's open-orders pane. Use the same payment_intent_id as
      // the join key — that's what links rounds to one tab.
      try {
        const refs = (rounds || []).map(r => r.ref).filter(Boolean);
        if (refs.length) {
          // v5.5.988: fenced on the venue. Refs are not globally unique — the queue's key is
          // (location_id, ref) — so ref alone would mark another venue's live orders collected.
          // locId comes off the rounds themselves, so it is always this tab's venue.
          await supabase.from('order_queue')
            .update({ status: 'collected' })
            .eq('location_id', locId)
            .in('ref', refs);
        }
      } catch (e) { console.warn('[TabResume] mark-collected:', e?.message); }

      // Aggregate items across all rounds for the closed_check.
      const allItems = (rounds || []).flatMap(r => r.items || []);
      const tabTip = +(rounds || []).reduce((t, r) => t + (Number(r?.customer?.tip) || 0), 0).toFixed(2);
      try {
        await supabase.from('closed_checks').insert({
          id: `chk-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
          ref: tab.tab_ref,
          location_id: rounds?.[0]?.location_id || null,
          server: 'QR',
          covers: 1,
          order_type: 'dine-in',
          customer: { ...(rounds?.[0]?.customer || {}), tab_closed_at: new Date().toISOString() },
          items: allItems.map(i => ({ ...i, voided: false })),
          discounts: [],
          // v5.8.9: runningTotal includes each round's tip (customer.tip). Book it as a tip.
          subtotal: +(runningTotal - tabTip).toFixed(2),
          service: 0, tip: tabTip, tax_amount: null,
          total: runningTotal,
          method: 'card',
          // Refund routing (refundCheck reads top-level processor + payment_intents).
          processor: isRyft ? 'ryft' : 'stripe',
          stripe_payment_intent_id: isRyft ? null : tab.payment_intent_id,
          payment_intents: [{ id: isRyft ? ryftSession : tab.payment_intent_id, amountMinor: Math.round(runningTotal * 100) }],
          closed_at: new Date().toISOString(),
          status: 'paid',
          refunds: [],
          table_id: null,
          table_label: tab.table_label ? `Table ${tab.table_label}` : (tableLabel ? `Table ${tableLabel}` : null),
          source: 'qr',
        });
      } catch (e) { console.warn('[TabResume] closed_checks insert:', e?.message); }

      clearStashedTab(slug, tableId);
      onClosed?.({ amount: runningTotal });
    } catch (e) {
      console.error('[TabResume] close failed:', e);
      setError(e?.message || 'Could not close the tab — please ask staff to help.');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div style={{
      minHeight: '100%', background: theme.bg, color: theme.fg,
      display: 'flex', flexDirection: 'column', padding: '40px 22px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
    }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>👋</div>
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-0.025em' }}>Welcome back!</div>
        <div style={{ fontSize: 14, color: muted, marginTop: 8 }}>
          Your tab at Table <b style={{ color: theme.fg }}>{tab.table_label || tableLabel || tableId}</b> is still open.
        </div>

        {/* v5.5.716: shareable table code — others at the table enter this to add to the tab */}
        {tab.tab_join_code && (
          <div style={{ marginTop: 16, padding: '12px 16px', background: inputBg, border: `1px dashed ${cardBdr}`, borderRadius: 14 }}>
            <span style={{ fontSize: 12.5, color: muted }}>Table code </span>
            <b style={{ fontSize: 20, letterSpacing: '0.18em', fontFamily: 'var(--font-mono, monospace)', color: theme.fg }}>{tab.tab_join_code}</b>
            <div style={{ fontSize: 11.5, color: muted, marginTop: 3 }}>Share it so others at your table can add to this tab</div>
          </div>
        )}

        {/* Running total + rounds */}
        <div style={{
          marginTop: 24, padding: '20px 22px',
          background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 16,
          textAlign: 'left',
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: muted, marginBottom: 10 }}>
            Running total
          </div>
          <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: '-0.02em', marginBottom: 14 }}>
            {money(runningTotal)}
          </div>
          {(rounds || []).length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                {rounds.length} round{rounds.length === 1 ? '' : 's'} so far
              </div>
              {rounds.map((r, i) => (
                <div key={r.ref || i} style={{ padding: '6px 0', borderTop: i === 0 ? `1px solid ${cardBdr}` : 'none', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ flex: 1, minWidth: 0, color: muted }}>
                    {(r.items || []).reduce((s, it) => s + (it.qty || 1), 0)} item{((r.items || []).length === 1) ? '' : 's'}
                    {r.items?.[0] && <> · {r.items[0].name}{r.items.length > 1 ? ` +${r.items.length - 1} more` : ''}</>}
                  </span>
                  <span style={{ fontWeight: 700 }}>{money(Number(r.total || 0))}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {error && <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: '#ef444415', border: '1px solid #ef444455', color: '#b91c1c', fontSize: 13 }}>{error}</div>}

        {/* Actions */}
        <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={onAddMore} disabled={closing} className="op-btn-primary" style={{
            padding: '18px 22px', borderRadius: 14,
            background: theme.accent, color: contrastFg(theme.accent),
            border: 'none', fontSize: 16, fontWeight: 800, cursor: closing ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', opacity: closing ? 0.5 : 1,
          }}>
            🍽 Add more to this tab
          </button>
          <button onClick={handleClose} disabled={closing} className="op-btn" style={{
            padding: '16px 22px', borderRadius: 14,
            background: 'transparent', color: theme.fg,
            border: `1.5px solid ${cardBdr}`,
            fontSize: 15, fontWeight: 700, cursor: closing ? 'wait' : 'pointer', fontFamily: 'inherit',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>{closing ? 'Charging your card…' : '🔒 Close & pay'}</span>
            <span>{money(runningTotal)}</span>
          </button>
          {onAbandon && (
            <button onClick={onAbandon} disabled={closing} style={{
              marginTop: 6, padding: '10px', background: 'transparent',
              border: 'none', color: muted, fontSize: 12, cursor: closing ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', textDecoration: 'underline',
            }}>Not me — start fresh</button>
          )}
        </div>

        <div style={{ marginTop: 30, fontSize: 11, color: muted, lineHeight: 1.5 }}>
          🔒 We held {money(Number(tab.pre_auth_amount || 0))} on your card when you opened this tab. Closing it captures the actual bill — anything held but unspent is released.
        </div>
      </div>
    </div>
  );
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}
