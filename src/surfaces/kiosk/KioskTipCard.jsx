/**
 * KioskTipCard: README 5.3 tip card on Review and pay.
 * No tip plus up to three percentages from the venue tipping settings (tipping_config.kiosk).
 * Amounts are worked out on the goods after automatic offers (lib/tipping.js tipAmount).
 */
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { tipAmount } from '../../lib/tipping';

export default function KioskTipCard({ rule, tipKey, basis, onPick }) {
  const keys = ['0', ...rule.pct.map(String)];
  return (
    <div style={{ background: '#FFFFFF', borderRadius: 26, padding: '26px 28px', flex: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)' }}>{t('k2.tip.title')}</div>
        <div style={{ fontSize: 18, color: 'var(--k2InkSubtle)' }}>{t('k2.tip.sub')}</div>
      </div>
      <div role="radiogroup" aria-label={t('k2.tip.title')} style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, keys.length)}, 1fr)`, gap: 12 }}>
        {keys.map(key => {
          const on = key === tipKey;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(key)}
              style={{
                border: on ? '3px solid var(--k2PrimaryLine)' : '2px solid var(--k2Hairline)',
                background: on ? 'var(--k2PrimaryTint)' : 'var(--k2Sunken)',
                borderRadius: 20, padding: on ? '21px 9px' : '22px 10px', cursor: 'pointer', color: 'var(--k2Ink)',
                display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', minHeight: 64,
              }}
            >
              <span style={{ fontSize: 26, fontWeight: 800 }}>{key === '0' ? t('k2.tip.none') : tf('k2.tip.pct', { pct: key })}</span>
              <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--k2InkSubtle)', fontVariantNumeric: 'tabular-nums' }}>
                {money(key === '0' ? 0 : tipAmount(basis, key))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
