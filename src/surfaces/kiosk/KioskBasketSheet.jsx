/**
 * KioskBasketSheet: README 4 basket sheet over the menu.
 * Keep browsing closes it; Pay goes to review and pay (the card reader never starts here).
 */
import { t, tf, tn } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { kioskLineRoom } from '../../lib/kioskLine';
import { KioskCloseButton } from './KioskChrome';
import { ArrowRightIcon } from './KioskIcons';
import KioskLineRow from './KioskLineRow';

export default function KioskBasketSheet({ cart, cartItemCount, cartItemUsage, dailyCounts, grandTotal, primary, onQty, onClose, onPay }) {
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--k2Scrim)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 30 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tn('k2.itemsInOrder', cartItemCount)}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: '40px 40px 0 0', padding: 40, display: 'flex', flexDirection: 'column', gap: 20,
          maxHeight: 1200, animation: 'kfade .22s ease', minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flex: 'none' }}>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--k2Ink)' }}>{tn('k2.itemsInOrder', cartItemCount)}</div>
          <KioskCloseButton onClick={onClose} />
        </div>
        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
          {cart.map((line, i) => {
            const room = kioskLineRoom(line, dailyCounts, cartItemUsage);
            return (
              <KioskLineRow
                key={line.key}
                line={line}
                size="sheet"
                first={i === 0}
                primary={primary}
                canAdd={room === null || room > 0}
                onLess={() => onQty(line.key, -1)}
                onMore={() => onQty(line.key, 1)}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 14, paddingTop: 8, flex: 'none' }}>
          <button
            type="button"
            onClick={onClose}
            style={{ flex: 1, border: '2px solid var(--k2Hairline)', background: '#FFFFFF', borderRadius: 26, height: 112, fontSize: 28, fontWeight: 700, color: 'var(--k2InkBody)', cursor: 'pointer' }}
          >{t('k2.basket.keepBrowsing')}</button>
          <button
            type="button"
            onClick={onPay}
            style={{
              flex: 1.4, border: 0, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', borderRadius: 26, height: 112,
              fontSize: 30, fontWeight: 800, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
            }}
          >
            <span>{tf('k2.basket.pay', { price: money(grandTotal) })}</span>
            <ArrowRightIcon size={30} />
          </button>
        </div>
      </div>
    </div>
  );
}
