/**
 * KioskReviewScreen: README 5 Review and pay, the one checkout screen. Every row is optional.
 *
 *   notices (a removed code or reward, a gift card that failed at commit)
 *   1 order card        line rows with steppers, Add more
 *   2 where card        eat in with the table, or take away, with Change
 *   3 tip card          when the venue asks for tips (tipping_config.kiosk)
 *   4 points row        when loyalty is on (no code to earn, decision 5)
 *   5 reward row        when loyalty is on and a number is added (text code to spend, decision 7)
 *   6 text row          when the text switch is on and the order is take away (decision 9)
 *   7 code card         gift card and promo code in one box (decision 6)
 *   8 allergen check    when the profile asks for it and the basket has allergens (decision 12)
 *   9 alcohol row       information only; staff see CHECK ID (decision 16)
 *  10 totals card
 *   sticky Pay button   blocked with a reason when kioskPayBlock says so
 *
 * REVIEW AND PAY NEVER STARTS THE CARD READER. Pay only moves to the card screen, where
 * the reader starts (the ScreenPay trap).
 */
import { t, tf, tn } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { kioskLineRoom } from '../../lib/kioskLine';
import { kioskChargeTotal } from '../../lib/kioskCheckout';
import { KioskBackButton, KioskCancelPill, KioskCheckBox, KioskPillButton } from './KioskChrome';
import { ArrowRightIcon, WarningIcon } from './KioskIcons';
import KioskLineRow from './KioskLineRow';
import KioskTipCard from './KioskTipCard';
import { KioskPointsRow, KioskRewardRow, KioskTextRow } from './KioskLoyaltyRows';
import KioskCodeCard from './KioskCodeCard';
import KioskTotalsCard from './KioskTotalsCard';

// Every card in the scroll column keeps its natural height (flex none). Without it a card
// with a set minHeight shrinks to that height once the column overflows.
const CARD = { background: '#FFFFFF', borderRadius: 26, flex: 'none' };

export default function KioskReviewScreen({
  engine, checkout, primary, submitNoticeKey,
  onBack, onCancel, onAddMore, onChangeWhere, onQty,
  onOpenPhone, onOpenOtp, onOpenAllergenSummary, onPay,
}) {
  const {
    cart, cartItemCount, cartItemUsage, dailyCounts, orderType, tableNumber, loyaltyEnabled, companyId,
    discountedSubtotal, loyaltyRedemption, loyaltyCredit, giftCardPayment, giftCardCredit,
    promoApplied, promoCredit, grandTotal, customerPhone,
  } = engine;

  const table = typeof tableNumber === 'string' ? tableNumber.trim() : '';
  const whereText = orderType === 'dineIn'
    ? (table ? tf('k2.review.whereEatInTable', { table }) : t('k2.review.whereEatInAnywhere'))
    : t('k2.review.whereTakeaway');
  const showTextRow = checkout.smsEnabled && checkout.textAllowed;
  const showRewardRow = loyaltyEnabled && !!customerPhone && !!checkout.phoneE164 && !!companyId;
  const covered = kioskChargeTotal(grandTotal) <= 0;
  const blockKey = checkout.payBlock;
  const payEnabled = cartItemCount > 0 && !blockKey;
  // Blocked: the reason pill and the disabled button sit in their own bar under the scroll
  // area, so the pill never covers a card (the totals most of all). Payable: the README
  // floating button over the scroll area, which keeps 260px bottom padding to clear it.
  const blocked = cartItemCount > 0 && !!blockKey;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0, animation: 'kfade .25s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '26px 28px', background: '#FFFFFF', borderBottom: '1px solid rgba(0,0,0,.07)', flex: 'none' }}>
        <KioskBackButton onClick={onBack} />
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--k2Ink)', flex: 1, minWidth: 0 }}>{t('k2.review.title')}</div>
        <KioskCancelPill onClick={onCancel} />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `26px 28px ${blocked ? 26 : 260}px`, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {submitNoticeKey ? <Notice tone="danger" text={t(submitNoticeKey)} /> : null}
        {checkout.notices.map(n => <Notice key={n.id} tone={n.tone} text={tf(n.key, n.vars)} />)}

        {/* 1. Order */}
        <div style={{ ...CARD, padding: '26px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 6 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)' }}>{tn('k2.itemsInOrder', cartItemCount)}</div>
            <KioskPillButton onClick={onAddMore}>{t('k2.review.addMore')}</KioskPillButton>
          </div>
          {cart.map((line, i) => {
            const room = kioskLineRoom(line, dailyCounts, cartItemUsage);
            return (
              <KioskLineRow
                key={line.key}
                line={line}
                size="card"
                first={i === 0}
                primary={primary}
                canAdd={room === null || room > 0}
                onLess={() => onQty(line.key, -1)}
                onMore={() => onQty(line.key, 1)}
              />
            );
          })}
        </div>

        {/* 2. Where */}
        <div style={{ ...CARD, padding: '24px 28px', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, color: 'var(--k2InkSubtle)' }}>{t('k2.review.where')}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)', overflowWrap: 'anywhere' }}>{whereText}</div>
          </div>
          <KioskPillButton onClick={onChangeWhere}>{t('k2.common.change')}</KioskPillButton>
        </div>

        {/* 3. Tip */}
        {checkout.tipRule?.on ? (
          <KioskTipCard rule={checkout.tipRule} tipKey={checkout.tipKey} basis={discountedSubtotal} onPick={checkout.setTipKey} />
        ) : null}

        {/* 4 and 5. Points and rewards */}
        {loyaltyEnabled ? <KioskPointsRow masked={checkout.masked} onOpen={() => onOpenPhone('points')} /> : null}
        {showRewardRow ? (
          <KioskRewardRow
            redemption={loyaltyRedemption}
            credit={loyaltyCredit}
            onOpen={onOpenOtp}
            onRemove={checkout.removeReward}
          />
        ) : null}

        {/* 6. Text me when it's ready */}
        {showTextRow ? (
          <KioskTextRow
            masked={checkout.masked}
            on={checkout.smsOn}
            onToggle={checkout.toggleSms}
            onAddNumber={() => onOpenPhone('sms')}
          />
        ) : null}

        {/* 7. Gift card or promo code */}
        <KioskCodeCard
          giftCardPayment={giftCardPayment}
          giftCardCredit={giftCardCredit}
          promoApplied={promoApplied}
          promoCredit={promoCredit}
          onApply={checkout.applyCode}
          onRemoveGift={checkout.removeGift}
          onRemovePromo={checkout.removePromo}
        />

        {/* 8. Allergen check */}
        {checkout.allergenAckRequired ? (
          <div style={{ ...CARD, padding: '20px 28px', display: 'flex', alignItems: 'center', gap: 18 }}>
            <button
              type="button"
              role="checkbox"
              aria-checked={checkout.allergenAck}
              onClick={checkout.toggleAck}
              style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 18, border: 0, background: 'transparent', padding: '4px 0', textAlign: 'left', cursor: 'pointer', minHeight: 64 }}
            >
              <KioskCheckBox checked={checkout.allergenAck} />
              <span style={{ fontSize: 25, fontWeight: 700, color: 'var(--k2Ink)' }}>{t('k2.allergenAck.title')}</span>
            </button>
            <button
              type="button"
              onClick={onOpenAllergenSummary}
              style={{ border: 0, background: 'transparent', fontSize: 21, fontWeight: 700, color: 'var(--k2PrimaryInk)', textDecoration: 'underline', cursor: 'pointer', padding: '14px 8px', minHeight: 64, flex: 'none' }}
            >{t('k2.allergenAck.see')}</button>
          </div>
        ) : null}

        {/* 9. Alcohol */}
        {checkout.hasAlcohol ? (
          <div style={{ ...CARD, background: 'var(--k2WarnFill)', border: '2px solid var(--k2WarnBorder)', padding: '22px 28px', display: 'flex', alignItems: 'center', gap: 16, fontSize: 22, fontWeight: 600, color: 'var(--k2WarnInk)' }}>
            <span style={{ flex: 'none' }}><IdIcon /></span>
            <span>{t(orderType === 'dineIn' ? 'k2.alcohol.eatIn' : 'k2.alcohol.takeaway')}</span>
          </div>
        ) : null}

        {/* 10. Totals */}
        <KioskTotalsCard rows={checkout.totalsRows} />
      </div>

      {/* Sticky pay button. It only moves to the card screen. */}
      {cartItemCount > 0 ? (
        <div style={blocked
          ? { position: 'relative', flex: 'none', display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 24px 24px', borderTop: '1px solid rgba(0,0,0,.07)', background: 'var(--k2Ground)' }
          : { position: 'absolute', left: 24, right: 24, bottom: 24, display: 'flex', flexDirection: 'column', gap: 12, zIndex: 10 }}
        >
          {blockKey ? (
            <div role="status" style={{ alignSelf: 'center', maxWidth: '100%', textWrap: 'balance', background: '#FFFFFF', borderRadius: 999, padding: '12px 24px', fontSize: 21, fontWeight: 600, color: 'var(--k2Danger)', textAlign: 'center', boxShadow: '0 6px 18px rgba(0,0,0,.06)' }}>
              {t(blockKey)}
            </div>
          ) : null}
          <button
            type="button"
            disabled={!payEnabled}
            onClick={() => { if (payEnabled) onPay(); }}
            style={{
              width: '100%', border: 0, height: 132, borderRadius: 30, fontSize: 36, fontWeight: 800,
              background: payEnabled ? 'var(--k2Primary)' : 'var(--k2Disabled)', color: payEnabled ? 'var(--k2OnPrimary)' : 'var(--k2InkOnDark)',
              boxShadow: payEnabled ? '0 18px 40px rgba(0,0,0,.22)' : 'none', cursor: payEnabled ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
            }}
          >
            <span>{covered ? t('k2.pay.placeOrder') : tf('k2.pay.button', { price: money(grandTotal) })}</span>
            <ArrowRightIcon size={36} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Notice({ tone, text }) {
  const danger = tone === 'danger';
  return (
    <div role="status" style={{
      flex: 'none', display: 'flex', alignItems: 'center', gap: 14, borderRadius: 26, padding: '20px 26px', fontSize: 21, fontWeight: 600,
      background: danger ? 'var(--k2DangerFill)' : 'var(--k2PrimaryTint)', color: danger ? 'var(--k2Danger)' : 'var(--k2PrimaryInk)',
    }}>
      <span style={{ flex: 'none' }}><WarningIcon size={26} /></span>
      <span>{text}</span>
    </div>
  );
}

// An ID card line icon for the alcohol row.
function IdIcon() {
  return (
    <svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <circle cx="8.5" cy="11" r="2.2" />
      <path d="M5.2 16.2c.7-1.4 1.9-2.1 3.3-2.1s2.6.7 3.3 2.1M14.5 10h4M14.5 13.5h3" />
    </svg>
  );
}
