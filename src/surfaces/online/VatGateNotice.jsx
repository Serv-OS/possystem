// VatGateNotice.jsx: the plain state a customer page shows while the venue's tax rates are not
// loaded (8 Oct 2026, VAT audit: a QR sale was booked with no VAT because the page had no rates).
// `gate` is ratesGate's answer (lib/customerRates.js): { code: 'loading' | 'failed', message }.
// Nothing renders when the gate is open (null). A failed load offers Try again.

export default function VatGateNotice({ gate, onRetry, theme }) {
  if (!gate) return null;
  const failed = gate.code === 'failed';
  const fg = theme?.fg || '#111';
  return (
    <div role="status" style={{
      marginBottom: 10, padding: '10px 12px', borderRadius: 10,
      background: failed ? '#fee2e2' : '#fef3c7',
      border: `1px solid ${failed ? '#ef4444' : '#f59e0b'}`,
      color: failed ? '#7f1d1d' : '#78350f',
      fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    }}>
      <span>{gate.message}</span>
      {failed && onRetry && (
        <button type="button" onClick={onRetry} style={{
          flex: 'none', padding: '6px 12px', borderRadius: 99, border: `1px solid ${fg}30`,
          background: '#fff', color: '#111', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>Try again</button>
      )}
    </div>
  );
}
