// v5.5.108 — Online ordering cart sheet.
// Slide-up bottom sheet that shows the customer their full cart, lets them
// adjust quantities or remove lines, and continues to checkout.
// Phase 4 will replace the placeholder onCheckout with the real
// customer-details + Stripe flow.

export default function OnlineCart({ cart, theme, orderType, onClose, onRemove, onUpdateQty, onCheckout }) {
  const subtotal = cart.reduce((s, l) => {
    const lineUnit = l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
    return s + lineUnit * (l.qty || 1);
  }, 0);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 30,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 540,
        maxHeight: '90vh', overflowY: 'auto',
        background: theme.bg, color: theme.fg,
        borderRadius: '16px 16px 0 0',
        borderTop: `1px solid ${theme.fg}20`,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Drag handle + close */}
        <div style={{ padding: '10px 0 4px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: `${theme.fg}30` }}/>
        </div>

        <div style={{ padding: '14px 18px 8px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Your order</div>
          <div style={{ fontSize: 12, opacity: 0.6 }}>{orderType === 'collection' ? 'Collection' : 'Delivery'}</div>
        </div>

        {/* Lines */}
        <div style={{ padding: '0 18px', flex: 1 }}>
          {cart.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', opacity: 0.6, fontSize: 13 }}>
              Your cart is empty.
            </div>
          )}
          {cart.map(line => {
            const unit = line.price + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
            const lineTotal = unit * (line.qty || 1);
            return (
              <div key={line.uid} style={{
                padding: '12px 0', borderBottom: `1px solid ${theme.fg}10`,
                display: 'flex', gap: 10,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{line.name}</div>
                  {(line.mods || []).length > 0 && (
                    <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, lineHeight: 1.5 }}>
                      {(line.mods || []).map((m, i) => (
                        <div key={i}>· {m.name || m.label}{m.price > 0 ? ` (+£${Number(m.price).toFixed(2)})` : ''}</div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <button onClick={() => onUpdateQty(line.uid, (line.qty || 1) - 1)}
                      style={qtyBtn(theme, line.qty <= 1)}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 16, textAlign: 'center' }}>{line.qty || 1}</span>
                    <button onClick={() => onUpdateQty(line.uid, (line.qty || 1) + 1)} style={qtyBtn(theme)}>+</button>
                    <button onClick={() => onRemove(line.uid)}
                      style={{ marginLeft: 'auto', background: 'transparent', color: `${theme.fg}80`, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Remove
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono, monospace)' }}>
                  £{lineTotal.toFixed(2)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Totals */}
        {cart.length > 0 && (
          <div style={{
            padding: '14px 18px', borderTop: `1px solid ${theme.fg}15`, flexShrink: 0,
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Subtotal</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: theme.accent }}>£{subtotal.toFixed(2)}</div>
          </div>
        )}

        {/* CTAs */}
        <div style={{
          padding: '0 18px calc(12px + env(safe-area-inset-bottom)) 18px',
          flexShrink: 0, display: 'flex', gap: 10,
        }}>
          <button onClick={onClose} style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'transparent', color: theme.fg, border: `1px solid ${theme.fg}30`,
            fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}>Add more</button>
          <button onClick={onCheckout} disabled={cart.length === 0} style={{
            flex: 1, padding: '14px 18px', borderRadius: 12,
            background: cart.length ? theme.accent : `${theme.fg}20`,
            color: cart.length ? '#0b0c10' : `${theme.fg}60`,
            border: 'none', fontSize: 14, fontWeight: 800, cursor: cart.length ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
          }}>Checkout · £{subtotal.toFixed(2)}</button>
        </div>
      </div>
    </div>
  );
}

function qtyBtn(theme, disabled) {
  return {
    width: 32, height: 32, borderRadius: '50%',
    background: `${theme.fg}15`, color: theme.fg, border: 'none',
    fontSize: 16, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', opacity: disabled ? 0.4 : 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
