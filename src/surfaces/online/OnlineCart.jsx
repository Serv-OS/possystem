// v5.5.112 — Online ordering cart sheet (UI overhaul).
// v5.5.154 — order-type-aware (dine-in / collection / delivery) + UK VAT
// breakdown for legal compliance on customer-facing surfaces.

import { calculateOrderTax } from '../../lib/tax';
import { money } from '../../lib/currency';

// checkoutDisabledReason (v5.5.802): when set, the Checkout button is disabled and
// the reason shows above the CTAs — used while the venue is closed with no
// order-ahead available (browse-only mode).
export default function OnlineCart({ cart, theme, orderType, taxRates = [], onClose, onRemove, onUpdateQty, onCheckout, checkoutDisabledReason = null }) {
  const subtotal = cart.reduce((s, l) => {
    const unit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + unit * (l.qty || 1);
  }, 0);
  // v5.5.154: VAT breakdown — UK prices are inclusive (price already
  // contains the tax), so we extract for display. Required on every
  // customer-facing total for compliance.
  const taxLineItems = cart.map(l => ({
    price: l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0),
    qty: l.qty || 1,
    taxRateId: l.taxRateId || l.tax_rate_id || null,
    taxOverrides: l.taxOverrides || l.tax_overrides || {},
  }));
  const taxBreakdown = calculateOrderTax(taxLineItems, taxRates, orderType || 'dine-in');

  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 30,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 560,
        maxHeight: '94vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '18px 18px 0 0',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -10px 40px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
      }}>
        {/* Drag handle */}
        <div style={{ padding: '10px 0 6px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 44, height: 5, borderRadius: 3, background: cardBdr }}/>
        </div>

        <div style={{ padding: '10px 22px 12px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>Your basket</div>
          {/* v5.5.154: order-type-aware label. dine-in (QR) is neither
              collection nor delivery — it's eat-in at the table. */}
          <div style={{ fontSize: 12, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {orderType === 'dine-in'    ? 'Dine-in'
              : orderType === 'collection' ? 'Collection'
              : 'Delivery'}
          </div>
        </div>

        <div style={{ padding: '0 22px', flex: 1 }}>
          {cart.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: muted }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🛒</div>
              <div style={{ fontSize: 14 }}>Your basket is empty.</div>
            </div>
          )}
          {cart.map(line => {
            const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
            const lineTotal = unit * (line.qty || 1);
            return (
              <div key={line.uid} style={{
                padding: '14px 0', borderBottom: `1px solid ${cardBdr}`,
                display: 'flex', gap: 14,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{line.name}</div>
                  {(line.mods || []).length > 0 && (
                    <div style={{ fontSize: 12, color: muted, lineHeight: 1.55, marginBottom: 8 }}>
                      {(line.mods || []).map((m, i) => (
                        <div key={i}>· {m.name || m.label}{m.price > 0 ? ` (+${money(Number(m.price))})` : ''}</div>
                      ))}
                    </div>
                  )}
                  {line.notes ? (
                    <div style={{ fontSize: 12, color: muted, fontStyle: 'italic', marginBottom: 8 }}>📝 {line.notes}</div>
                  ) : null}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => onUpdateQty(line.uid, (line.qty || 1) - 1)}
                      style={{ ...qtyBtn, background: inputBg, color: theme.fg, opacity: line.qty <= 1 ? .4 : 1 }}>−</button>
                    <span style={{ fontSize: 14, fontWeight: 800, minWidth: 18, textAlign: 'center' }}>{line.qty || 1}</span>
                    <button onClick={() => onUpdateQty(line.uid, (line.qty || 1) + 1)}
                      style={{ ...qtyBtn, background: inputBg, color: theme.fg }}>+</button>
                    <button onClick={() => onRemove(line.uid)} style={{
                      marginLeft: 'auto', background: 'transparent',
                      color: muted, border: 'none',
                      fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                      textDecoration: 'underline',
                    }}>Remove</button>
                  </div>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, alignSelf: 'flex-start' }}>
                  {money(lineTotal)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Totals */}
        {cart.length > 0 && (
          <div style={{ padding: '16px 22px 0', flexShrink: 0 }}>
            <Row label="Subtotal" value={`${money(subtotal)}`} muted={muted}/>
            {/* v5.5.154: dine-in (QR) gets neither a delivery fee nor a
                collection line — it's eat-in at the table, no fulfilment
                cost. Only show the row for online order types. */}
            {orderType !== 'dine-in' && (
              <Row label={orderType === 'delivery' ? 'Delivery fee' : 'Collection'}
                value={orderType === 'delivery' ? 'Calculated at checkout' : 'Free'}
                muted={muted}/>
            )}
            {/* v5.5.154: UK VAT breakdown — required on every customer-
                facing total for compliance. Prices are inclusive so we
                show "incl VAT" rather than adding on top. */}
            {taxBreakdown.totalTax > 0 && taxBreakdown.breakdown.map((b, i) => (
              <Row key={i}
                label={`incl. ${b.rate.name || `VAT ${(Number(b.rate.rate) * 100).toFixed(0)}%`}`}
                value={`${money(b.tax)}`}
                muted={muted}/>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              padding: '12px 0 6px', borderTop: `1px solid ${cardBdr}`, marginTop: 6,
            }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Total</div>
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.02em' }}>
                {money(subtotal)}
              </div>
            </div>
          </div>
        )}

        {/* Closed / browse-only — checkout blocked with the reason (v5.5.802) */}
        {checkoutDisabledReason && cart.length > 0 && (
          <div style={{
            margin: '0 22px 10px', padding: '10px 14px', borderRadius: 10, flexShrink: 0,
            background: '#fffbeb', border: '1.5px solid #f59e0b', color: '#92400e',
            fontSize: 13, fontWeight: 700, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span>🌙</span><span>{checkoutDisabledReason}</span>
          </div>
        )}

        {/* CTAs */}
        <div style={{
          padding: '12px 22px calc(14px + env(safe-area-inset-bottom)) 22px',
          flexShrink: 0, display: 'flex', gap: 10,
        }}>
          <button onClick={onClose} style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'transparent', color: theme.fg, border: `1.5px solid ${cardBdr}`,
            fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>Add more</button>
          <button onClick={onCheckout} disabled={cart.length === 0 || !!checkoutDisabledReason} style={{
            flex: 1, padding: '14px 18px', borderRadius: 12,
            background: (cart.length && !checkoutDisabledReason) ? theme.accent : `${theme.fg}20`,
            color: (cart.length && !checkoutDisabledReason) ? contrastFg(theme.accent) : `${theme.fg}60`,
            border: 'none', fontSize: 15, fontWeight: 800,
            cursor: (cart.length && !checkoutDisabledReason) ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
          }}>
            Checkout · {money(subtotal)}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <div style={{ fontSize: 13, color: muted }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{value}</div>
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

const qtyBtn = {
  width: 32, height: 32, borderRadius: '50%',
  border: 'none', fontSize: 16, fontWeight: 800,
  cursor: 'pointer', fontFamily: 'inherit',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
