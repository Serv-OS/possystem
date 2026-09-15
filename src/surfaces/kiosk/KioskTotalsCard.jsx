/**
 * KioskTotalsCard: README 5.7 totals on Review and pay. The rows come from
 * lib/kioskCheckout.js kioskTotalsRows (items, then offers, tax, tip, reward, promo and gift
 * card only when above zero, then the total).
 */
import { t } from '../../lib/i18n';
import { money } from '../../lib/currency';

export default function KioskTotalsCard({ rows }) {
  const lines = rows.filter(r => r.id !== 'total');
  const total = rows.find(r => r.id === 'total');
  return (
    <div style={{ background: '#FFFFFF', borderRadius: 26, padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 12, flex: 'none' }}>
      {lines.map(r => (
        <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 22, color: r.negative ? 'var(--k2PrimaryInk)' : 'var(--k2InkMuted)' }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{r.label || t(r.labelKey)}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{r.negative ? `−${money(r.amount)}` : money(r.amount)}</span>
        </div>
      ))}
      {total ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, borderTop: '1px solid var(--k2Divider)', paddingTop: 14 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: 'var(--k2Ink)' }}>{t(total.labelKey)}</span>
          <span style={{ fontSize: 40, fontWeight: 800, color: 'var(--k2Ink)', fontVariantNumeric: 'tabular-nums' }}>{money(total.amount)}</span>
        </div>
      ) : null}
    </div>
  );
}
