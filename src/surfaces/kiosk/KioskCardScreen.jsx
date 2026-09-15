/**
 * KioskCardScreen: README 7 card payment, drawn for KioskApp's ScreenPay (look="v2").
 *
 * CARD PATH RULE (owner, non negotiable). This file is only the LOOK of the card screen.
 * ScreenPay keeps every piece of the card path: the reader start on mount, polling, cancel,
 * the Ryft terminal job and the call to submitOrder. It passes its own state (cardState,
 * cardError, total, submitting, submitError) and its own handlers, and this file decides
 * what the customer sees (lib/kioskPay.js) and which handler a button calls:
 *   Try again  ScreenPay's own retry, offered ONLY after a settled decline
 *   Back       ScreenPay's own back (cancels the reader action), after a decline or when covered
 *   Cancel     ScreenPay's own cancel, once the reader is waiting for a tap (the reader or job
 *              is known, so the cancel reaches it), after a decline, or when covered. Never
 *              while the reader is getting ready: a cancel then could leave a live charge.
 *   Place order  onPaid, when codes cover the whole order
 * When a charge might exist (an error, or a charge that went through but the order did not
 * save) there is no Try again and no Back: the customer is asked to fetch a member of staff
 * and is shown a reference, and the tills get an urgent alert (F12).
 *
 * v2 props from KioskFlowV2:
 *   onPhase(report)  told the phase on every change ({ phase, cause, raw, total }), and null
 *                    when the screen closes. KioskFlowV2 pauses the idle timer from it and
 *                    works out the staff incident.
 *   incident         { reference, at, cause } once staff are needed, else null
 *   kioskTz          the venue time zone for the incident time
 *   onNewOrder       resetSession('staff')
 */
import { useEffect, useRef, useState } from 'react';
import { t, tf } from '../../lib/i18n';
import { money } from '../../lib/currency';
import { kioskCardPhase, kioskCardCopy, nextReachedReader, kioskIncidentTime } from '../../lib/kioskPay';
import { KioskBackButton, KioskCancelPill } from './KioskChrome';
import { CardIcon, TickIcon, WarningIcon } from './KioskIcons';

export default function KioskCardScreen({
  cardState, cardError = null, total = 0, submitting = false, submitError = null,
  onRetry, onBack, onCancel, onPlaceOrder,
  onPhase = null, incident = null, kioskTz = null, onNewOrder = null,
}) {
  // Whether this attempt reached the reader ('collecting'), tracked while rendering from the
  // previous card state (React's "adjust state when a prop changes" pattern).
  const [reach, setReach] = useState(() => ({ state: cardState, reached: nextReachedReader(false, cardState) }));
  let reachedReader = reach.reached;
  if (reach.state !== cardState) {
    reachedReader = nextReachedReader(reach.reached, cardState);
    setReach({ state: cardState, reached: reachedReader });
  }

  const { phase, cause } = kioskCardPhase({ cardState, total, submitting, submitError, reachedReader });
  const copy = kioskCardCopy(phase, cause);
  const raw = String(submitError || cardError || '');

  // Report the phase (idle pause, staff incident). null when the screen closes.
  useEffect(() => {
    if (onPhase) onPhase({ phase, cause, raw, total });
  }, [onPhase, phase, cause, raw, total]);
  useEffect(() => () => { if (onPhase) onPhase(null); }, [onPhase]);

  // One action per phase: a second tap before the screen redraws must never start a second
  // charge (Try again) or a second order (Place order). Cleared when the phase changes.
  const actedRef = useRef(false);
  useEffect(() => { actedRef.current = false; }, [phase, cardState]);
  const once = (fn) => () => {
    if (actedRef.current || typeof fn !== 'function') return;
    actedRef.current = true;
    fn();
  };

  const handlers = {
    retry: once(onRetry),
    back: once(onBack),
    placeOrder: once(onPlaceOrder),
    newOrder: once(onNewOrder),
  };

  const [showDetails, setShowDetails] = useState(false);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', padding: 56, background: 'var(--k2Ground)', animation: 'kfade .25s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 64 }}>
        {copy.showBack ? <KioskBackButton deep onClick={handlers.back} /> : <div style={{ width: 64, height: 64 }} aria-hidden="true" />}
        {copy.showCancel ? <KioskCancelPill onClick={once(onCancel)} /> : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 52, textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '0.2em', color: 'var(--k2InkSubtle)' }}>{t('k2.card.amountDue')}</div>
          <div style={{ fontSize: 128, fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1, color: 'var(--k2Ink)', fontVariantNumeric: 'tabular-nums' }}>
            {money(Math.max(0, Number(total) || 0))}
          </div>
        </div>

        <CardVisual visual={copy.visual} tone={phase === 'askStaff' ? 'warn' : 'danger'} />

        <div role="status" aria-live="polite" style={{ maxWidth: 760 }}>
          <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1.1, color: 'var(--k2Ink)' }}>{t(copy.titleKey)}</div>
          {/* balance: no line left holding one word ("too."). The max width gives older WebViews
              without text-wrap a shorter first line too. */}
          <div style={{ fontSize: 24, lineHeight: 1.35, color: 'var(--k2InkSubtle)', marginTop: 12, marginInline: 'auto', maxWidth: 660, textWrap: 'balance' }}>{t(copy.subKey)}</div>
        </div>

        {phase === 'askStaff' && incident ? (
          <div style={{ background: '#FFFFFF', borderRadius: 26, padding: 28, width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '0.04em', color: 'var(--k2Ink)' }}>{tf('k2.card.reference', { ref: incident.reference })}</div>
            <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--k2InkBody)' }}>
              {money(Math.max(0, Number(incident.total ?? total) || 0))}
              {kioskIncidentTime(incident.at, kioskTz) ? ` · ${kioskIncidentTime(incident.at, kioskTz)}` : ''}
            </div>
            {raw ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowDetails(v => !v)}
                  aria-expanded={showDetails}
                  style={{ border: 0, background: 'transparent', color: 'var(--k2InkMuted)', fontSize: 19, fontWeight: 600, textDecoration: 'underline', padding: '14px 12px', minHeight: 64, cursor: 'pointer' }}
                >{t('k2.card.staffDetails')}</button>
                {showDetails ? (
                  <div style={{ fontSize: 19, lineHeight: 1.35, color: 'var(--k2InkMuted)', overflowWrap: 'anywhere', textAlign: 'left', width: '100%' }}>{raw}</div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {copy.actions.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 'none' }}>
          {copy.actions.map(a => (
            <button
              key={a.id}
              type="button"
              onClick={handlers[a.id]}
              style={a.kind === 'primary' ? {
                border: 0, height: 112, borderRadius: 26, fontSize: 32, fontWeight: 800,
                background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', cursor: 'pointer',
              } : {
                border: '2px solid var(--k2Hairline)', height: 112, borderRadius: 26, fontSize: 28, fontWeight: 700,
                background: '#FFFFFF', color: 'var(--k2Ink)', cursor: 'pointer',
              }}
            >{t(a.labelKey)}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The picture in the middle (README 7 reader target, 340 by 340): the card in a white circle,
 * with the two kpulse rings while waiting for a tap; a tick while saving; a warning after a
 * decline or when staff are needed; a tick in the tint when codes cover the order.
 */
function CardVisual({ visual, tone }) {
  const box = { position: 'relative', width: 340, height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' };
  const circle = { width: 230, height: 230, borderRadius: 999, background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px rgba(0,0,0,.08)', position: 'relative' };
  const ring = { position: 'absolute', inset: 0, borderRadius: 999, border: '3px solid var(--k2PrimaryLine)' };

  if (visual === 'readerPulse' || visual === 'reader') {
    return (
      <div style={box} aria-hidden="true">
        {visual === 'readerPulse' ? (
          <>
            <div style={{ ...ring, animation: 'kpulse 1.8s ease-out infinite' }} />
            <div style={{ ...ring, animation: 'kpulse 1.8s ease-out .9s infinite' }} />
          </>
        ) : (
          <div style={{ ...ring, opacity: 0.25 }} />
        )}
        <div style={{ ...circle, color: 'var(--k2PrimaryInk)' }}><CardIcon size={120} /></div>
      </div>
    );
  }
  if (visual === 'tick') {
    return (
      <div style={box} aria-hidden="true">
        <div style={{ width: 180, height: 180, borderRadius: 999, background: 'var(--k2Primary)', color: 'var(--k2OnPrimary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <TickIcon size={96} />
        </div>
      </div>
    );
  }
  if (visual === 'covered') {
    return (
      <div style={box} aria-hidden="true">
        <div style={{ ...circle, background: 'var(--k2PrimaryTint)', color: 'var(--k2PrimaryInk)' }}><TickIcon size={110} /></div>
      </div>
    );
  }
  const warn = tone === 'warn';
  return (
    <div style={box} aria-hidden="true">
      <div style={{ ...circle, background: warn ? 'var(--k2WarnFill)' : 'var(--k2DangerFill)', color: warn ? 'var(--k2WarnInk)' : 'var(--k2Danger)' }}>
        <WarningIcon size={110} />
      </div>
    </div>
  );
}
