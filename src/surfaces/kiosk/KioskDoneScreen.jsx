/**
 * KioskDoneScreen: README 8 done screen (decisions 8, 9 and 16).
 *
 *   tick circle, ORDER NUMBER and the short order number (the same number the order screens
 *   call, db.js shortOrderRef)
 *   the message for eat in with a table, eat in with no table, take away with the ready
 *   text, or take away without it (lib/kioskFlow.js kioskDoneModel)
 *   "Points will be added" with the masked number, never "added": points are earned after
 *   this screen shows
 *   the ID reminder when the order has alcohol
 *   "Done, start a new order" and a 20 second countdown, then back to tap to start
 *
 * No receipt line and no wait time (decisions). The countdown is this screen's own interval,
 * cleared when it closes, so it can never reset the next customer's order (F2).
 */
import { useEffect, useRef, useState } from 'react';
import { t, tf } from '../../lib/i18n';
import { shortOrderRef } from '../../lib/db';
import { KIOSK_DONE_COUNTDOWN, nextCountdown } from '../../lib/kioskFlow';
import { StarIcon, TickIcon, WarningIcon } from './KioskIcons';

export default function KioskDoneScreen({ orderNumber, model, onDone, onCountdownEnd }) {
  const [left, setLeft] = useState(KIOSK_DONE_COUNTDOWN);
  useEffect(() => {
    const timer = setInterval(() => setLeft(n => nextCountdown(n)), 1000);
    return () => clearInterval(timer);
  }, []);

  // Reset once when the countdown reaches 0, or once when Done is tapped.
  const resetRef = useRef(false);
  useEffect(() => {
    if (left > 0 || resetRef.current) return;
    resetRef.current = true;
    if (onCountdownEnd) onCountdownEnd();
  }, [left, onCountdownEnd]);
  const done = () => {
    if (resetRef.current) return;
    resetRef.current = true;
    if (onDone) onDone();
  };

  const number = shortOrderRef(orderNumber) || '';

  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 40, padding: 56, textAlign: 'center', background: 'var(--k2Ground)', animation: 'kfade .3s ease',
    }}>
      <div aria-hidden="true" style={{ width: 180, height: 180, borderRadius: 999, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <TickIcon size={96} />
      </div>

      <div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.2em', color: 'var(--k2InkSubtle)' }}>{t('k2.done.orderNumber')}</div>
        <div style={{ fontSize: 180, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1, color: 'var(--k2Ink)', fontVariantNumeric: 'tabular-nums' }}>{number}</div>
      </div>

      <div role="status" style={{ fontSize: 30, color: 'var(--k2InkBody)', maxWidth: 760, lineHeight: 1.35 }}>
        {tf(model.messageKey, model.messageVars)}
      </div>

      {model.pointsKey ? (
        <div style={{ background: '#FFFFFF', borderRadius: 22, padding: '22px 32px', fontSize: 24, fontWeight: 700, color: 'var(--k2Ink)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <StarIcon size={30} />
          <span>{tf(model.pointsKey, model.pointsVars)}</span>
        </div>
      ) : null}

      {model.showAlcohol ? (
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--k2WarnInk)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <WarningIcon size={30} />
          <span>{t('k2.done.alcohol')}</span>
        </div>
      ) : null}

      <button
        type="button"
        onClick={done}
        style={{ border: 0, background: 'var(--k2Ink)', color: '#FFFFFF', borderRadius: 26, padding: '28px 52px', fontSize: 26, fontWeight: 700, minHeight: 84, cursor: 'pointer' }}
      >{t('k2.done.newOrder')}</button>

      <div style={{ fontSize: 20, color: 'var(--k2InkSubtle)' }}>{tf('k2.done.resets', { n: left })}</div>
    </div>
  );
}
