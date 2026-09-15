/**
 * KioskOrderBar: README 2 order bar, shown over the menu while the basket has items.
 * Left opens the basket sheet; right goes straight to review and pay (one tap).
 */
import { t, tn } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { ArrowRightIcon } from './KioskIcons';

export default function KioskOrderBar({ cartItemCount, subtotal, onOpenBasket, onReview }) {
  return (
    <div style={{
      position: 'absolute', left: 24, right: 24, bottom: 24, background: 'var(--k2Ink)', borderRadius: 30,
      padding: '20px 20px 20px 34px', display: 'flex', alignItems: 'center', gap: 20,
      boxShadow: '0 18px 40px rgba(0,0,0,.3)', zIndex: 10,
    }}>
      <button
        type="button"
        onClick={onOpenBasket}
        style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', padding: 0 }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--k2InkOnDark)', letterSpacing: '0.04em' }}>{t('k2.orderBar.caption')}</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: '#FFFFFF', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          {`${tn('k2.items', cartItemCount)} · ${money(subtotal)}`}
        </div>
      </button>
      <button
        type="button"
        onClick={onReview}
        style={{
          border: 0, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', borderRadius: 22, padding: '26px 40px', boxShadow: 'var(--k2PrimaryOnInkEdge)',
          fontSize: 28, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, flex: 'none',
        }}
      >
        <span>{t('k2.orderBar.review')}</span>
        <ArrowRightIcon size={30} />
      </button>
    </div>
  );
}
