/**
 * KioskOtpSheet: spend a reward (decision 7: spending needs the text code; earning does not).
 *
 *   send    : "We'll text a 6 digit code to •••• •••123" and a button
 *   code    : the keypad for the 6 digits, and a link to send a new code
 *   rewards : the rewards this customer can use, each with Use
 *
 * PRIVACY (README, non negotiable): the verify reply carries the customer's name, email and
 * balance. None of it is shown here or anywhere on the kiosk. Only reward names show.
 * A reward the tap check refuses is shown disabled with the reason, so points are never spent
 * for nothing or for part of a reward (lib/kioskCheckout.js stageKioskReward, which calls
 * lib/kioskLoyaltyReward.js kioskRewardTapCheck, the same check today's kiosk uses).
 */
import { useState } from 'react';
import { t, tf, tn } from '../../lib/i18n';
import { kioskRewardsFromVerify, stageKioskReward } from '../../lib/kioskCheckout';
import { translateEnglish, useMenuText } from '../../lib/menuText';
import { KioskBottomSheet, KioskSheetHead } from './KioskChrome';
import { StarIcon } from './KioskIcons';
import KioskKeypad from './KioskKeypad';

const formatCode = (d) => (d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d);

export default function KioskOtpSheet({
  api, phoneE164, masked, companyId, locationId, verifiedLoyalty, onVerified,
  rewardCtx, onUse, onClose,
}) {
  useMenuText();   // item names in the customer's language
  const [step, setStep] = useState(verifiedLoyalty ? 'rewards' : 'send');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await api.sendOtp({ phone: phoneE164, companyId, locationId });
      if (r?.ok) { setCode(''); setStep('code'); } else setErrorKey(r?.errorKey || 'k2.otp.failed');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (digits) => {
    if (busy || digits.length !== 6) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await api.verifyOtp({ phone: phoneE164, companyId, code: digits });
      if (r?.data) {
        const data = r.data;
        onVerified({
          customer: data.customer,
          // The points and stamp card switches can sit at the top of the reply (as ScreenLoyalty reads them).
          loyalty: {
            ...(data.loyalty || {}),
            points_enabled: data.loyalty?.points_enabled ?? data.points_enabled,
            stamps_enabled: data.loyalty?.stamps_enabled ?? data.stamps_enabled,
          },
          stampCards: data.stamp_cards || [],
          giftCards: [],
        });
        setStep('rewards');
      } else {
        setErrorKey(r?.errorKey || 'k2.otp.wrong');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  const customerId = verifiedLoyalty?.customer?.id || rewardCtx?.customerId || null;
  const rewards = step === 'rewards' ? kioskRewardsFromVerify({ loyalty: verifiedLoyalty?.loyalty }) : [];

  let title = t('k2.otp.title');
  let sub = tf('k2.otp.sub', { masked });
  if (step === 'rewards') { title = t('k2.otp.rewardsTitle'); sub = null; }

  return (
    <KioskBottomSheet label={title} onClose={onClose}>
      <KioskSheetHead title={title} sub={sub} onClose={onClose} />

      {errorKey ? (
        <div role="alert" style={{ fontSize: 21, fontWeight: 600, color: 'var(--k2Danger)', background: 'var(--k2DangerFill)', borderRadius: 18, padding: '18px 22px' }}>
          {t(errorKey)}
        </div>
      ) : null}

      {step === 'send' ? (
        <button
          type="button"
          onClick={send}
          disabled={busy}
          style={{
            border: 0, height: 112, borderRadius: 26, fontSize: 30, fontWeight: 800, cursor: busy ? 'default' : 'pointer',
            background: busy ? 'var(--k2Disabled)' : 'var(--k2Primary)', color: busy ? 'var(--k2InkOnDark)' : 'var(--k2OnPrimary)',
          }}
        >{t('k2.otp.send')}</button>
      ) : null}

      {step === 'code' ? (
        <>
          <KioskKeypad
            value={code}
            onChange={setCode}
            maxLength={6}
            placeholder={t('k2.otp.codePlaceholder')}
            placeholderMono
            format={formatCode}
            confirmLabel={t('k2.otp.verify')}
            canConfirm={!busy && code.length === 6}
            onConfirm={verify}
          />
          <button
            type="button"
            onClick={send}
            disabled={busy}
            style={{ border: 0, background: 'transparent', padding: '14px 8px', fontSize: 23, fontWeight: 700, color: 'var(--k2PrimaryInk)', textDecoration: 'underline', cursor: 'pointer', minHeight: 64 }}
          >{t('k2.otp.resend')}</button>
        </>
      ) : null}

      {step === 'rewards' ? (
        rewards.length === 0 ? (
          <div style={{ fontSize: 24, color: 'var(--k2InkMuted)', padding: '12px 0' }}>{t('k2.reward.none')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {rewards.map(reward => {
              const staged = stageKioskReward(reward, { ...rewardCtx, customerId });
              const note = staged.ok ? null
                : staged.reason === 'needsItem' && staged.items?.length
                  ? tf('k2.reward.needsItem', { items: staged.items.map(translateEnglish).join(', ') })
                  : staged.reason === 'giftFirst'
                    ? t('k2.reward.giftFirst')
                    : t('k2.reward.cannotUse');
              return (
                <div key={reward.id} style={{ display: 'flex', alignItems: 'center', gap: 18, border: '2px solid var(--k2Hairline)', borderRadius: 22, padding: '20px 22px' }}>
                  <span style={{ flex: 'none', display: 'grid' }}><StarIcon size={32} /></span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 25, fontWeight: 700, color: 'var(--k2Ink)', overflowWrap: 'anywhere' }}>{reward.label}</span>
                    <span style={{ fontSize: 19, color: 'var(--k2InkSubtle)' }}>
                      {reward.stamp ? t('k2.reward.stamp') : tn('k2.reward.points', Number(reward.pointsCost) || 0)}
                    </span>
                    {note ? <span style={{ fontSize: 19, color: 'var(--k2WarnInk)', fontWeight: 600 }}>{note}</span> : null}
                  </span>
                  <button
                    type="button"
                    disabled={!staged.ok}
                    onClick={() => { if (staged.ok) onUse(staged.staged); }}
                    style={{
                      border: 0, borderRadius: 999, padding: '0 34px', height: 72, fontSize: 24, fontWeight: 800, flex: 'none',
                      background: staged.ok ? 'var(--k2Primary)' : 'var(--k2Disabled)', color: staged.ok ? 'var(--k2OnPrimary)' : 'var(--k2InkOnDark)',
                      cursor: staged.ok ? 'pointer' : 'default',
                    }}
                  >{t('k2.reward.use')}</button>
                </div>
              );
            })}
          </div>
        )
      ) : null}
    </KioskBottomSheet>
  );
}
