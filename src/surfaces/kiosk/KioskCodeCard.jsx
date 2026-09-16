/**
 * KioskCodeCard: one box for gift cards and promo codes on Review and pay (decision 6: a
 * proper entry box, always open, not the small link). Both a gift card and a promo can be on
 * one order, each with Remove.
 *
 * Applying only LOOKS UP a gift card and VALIDATES a promo (the same endpoints as today's
 * kiosk). Nothing is debited or redeemed until submitOrder (lib/kioskCheckout.js).
 */
import { useState } from 'react';
import { t, tf, tn } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { kioskPromoLabel } from '../../lib/kioskCheckout';
import { TickIcon } from './KioskIcons';

export default function KioskCodeCard({ giftCardPayment, giftCardCredit, promoApplied, promoCredit, onApply, onRemoveGift, onRemovePromo }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);   // null | { key, vars, tone }

  const bothApplied = !!giftCardPayment && !!promoApplied;
  const canApply = !busy && input.trim().length > 0;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    setStatus({ key: 'k2.code.checking', vars: {}, tone: 'info' });
    try {
      const r = await onApply(input);
      if (r?.gift) {
        setInput('');
        setStatus({ key: 'k2.code.giftAppliedStatus', vars: { last4: r.gift.code_last4 || '' }, tone: 'ok' });
      } else if (r?.promo) {
        setInput('');
        setStatus({ key: 'k2.code.promoAppliedStatus', vars: { code: r.promo.code, amount: money(r.promo.amount) }, tone: 'ok' });
      } else if (r?.errorKey) {
        const vars = { ...(r.vars || {}) };
        if (typeof vars.amount === 'number') vars.amount = money(vars.amount);
        setStatus({ key: r.errorKey, vars, tone: 'danger' });
      } else {
        setStatus(null);
      }
    } catch {
      setStatus({ key: 'k2.code.failed', vars: {}, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // A success line is never shown as well as its applied row: while the code is on the order
  // its row below already says so (with the amount and Remove), and once a basket change takes
  // it off from outside this card the line would be stale. So the box goes back to its help.
  const success = status?.key === 'k2.code.promoAppliedStatus' || status?.key === 'k2.code.giftAppliedStatus';
  const shown = success ? null : status;
  const statusKey = shown?.key || 'k2.code.help';
  const statusColor = shown?.tone === 'danger' ? 'var(--k2Danger)' : 'var(--k2PrimaryInk)';
  // With both codes on there is no box to help with.
  const showStatus = !!shown || !bothApplied;

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 26, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 14, flex: 'none' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--k2Ink)' }}>{t('k2.code.title')}</div>

      {!bothApplied ? (
        <form
          onSubmit={(e) => { e.preventDefault(); apply(); }}
          style={{ display: 'flex', gap: 12 }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            placeholder={t('k2.code.placeholder')}
            aria-label={t('k2.code.title')}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            style={{
              flex: 1, minWidth: 0, border: '2px solid var(--k2Hairline)', borderRadius: 18, padding: 22,
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 24, fontWeight: 600, letterSpacing: '0.08em',
              background: 'var(--k2Sunken)', color: 'var(--k2Ink)', outline: 'none', userSelect: 'text', WebkitUserSelect: 'text',
            }}
          />
          <button
            type="submit"
            disabled={!canApply}
            style={{
              border: 0, borderRadius: 18, padding: '0 36px', fontSize: 24, fontWeight: 700, flex: 'none', minHeight: 64,
              background: canApply ? 'var(--k2Primary)' : 'var(--k2Disabled)', color: canApply ? 'var(--k2OnPrimary)' : 'var(--k2InkOnDark)',
              cursor: canApply ? 'pointer' : 'default',
            }}
          >{t('k2.common.apply')}</button>
        </form>
      ) : null}

      {showStatus ? (
        <div aria-live="polite" style={{ fontSize: 19, color: statusColor, fontWeight: shown?.tone === 'danger' ? 600 : 400 }}>
          {tf(statusKey, shown?.vars || {})}
        </div>
      ) : null}

      {giftCardPayment ? (
        <AppliedChip
          label={tf('k2.code.giftApplied', { last4: giftCardPayment.code_last4 || '' })}
          amount={giftCardCredit}
          onRemove={() => { setStatus(null); onRemoveGift(); }}
        />
      ) : null}
      {promoApplied ? (
        <AppliedChip
          label={tf('k2.code.promoApplied', { label: promoLabelText(promoApplied), code: promoApplied.code })}
          amount={promoCredit}
          onRemove={() => { setStatus(null); onRemovePromo(); }}
        />
      ) : null}
    </div>
  );
}

/** The promo chip label: the server's own English labels in the customer's language (kioskPromoLabel). */
function promoLabelText(promo) {
  const l = kioskPromoLabel(promo);
  if (!l.key) return l.text || '';
  if (l.plural) return tn(l.key, l.vars.n);
  const vars = l.money ? { ...l.vars, [l.money]: money(l.vars[l.money]) } : l.vars;
  return tf(l.key, vars);
}

function AppliedChip({ label, amount, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: '#FFFFFF', border: '2px solid var(--k2Hairline)', borderRadius: 18, padding: '18px 22px', fontSize: 22 }}>
      <span style={{ color: 'var(--k2PrimaryInk)', flex: 'none' }}><TickIcon size={26} /></span>
      <span style={{ flex: 1, minWidth: 0, fontWeight: 700, color: 'var(--k2Ink)', overflowWrap: 'anywhere' }}>{label}</span>
      <span style={{ fontWeight: 800, color: 'var(--k2AccentInk, var(--k2PrimaryInk))', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{`−${money(amount)}`}</span>
      <button
        type="button"
        onClick={onRemove}
        style={{ border: 0, background: 'var(--k2Neutral)', borderRadius: 999, padding: '13px 22px', fontSize: 19, fontWeight: 700, color: 'var(--k2Ink)', cursor: 'pointer', minHeight: 64, flex: 'none' }}
      >{t('k2.common.remove')}</button>
    </div>
  );
}
