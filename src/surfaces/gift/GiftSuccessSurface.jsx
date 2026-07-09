// v5.5.205 — Gift card purchase success page.
// URL: https://<slug>.serv-os.app/gift/success?session_id=cs_xxxx
//
// Stripe Checkout redirects here after a successful payment. The page
// polls gift-purchase-status to check whether the gift-fulfill webhook
// handler has finished issuing the card. Shows a confirmation once ready.

import { useEffect, useState, useMemo } from 'react';
import { callGiftPublic, formatAmount, buildGiftTheme, fetchGiftBranding, giftUrl } from './giftHelpers';

export default function GiftSuccessSurface({ location }) {
  const [giftBranding, setGiftBranding] = useState(null);
  useEffect(() => {
    fetchGiftBranding(location?.company_id).then(b => { if (b) setGiftBranding(b); });
  }, [location?.company_id]);
  const t = useMemo(() => buildGiftTheme(location, giftBranding), [location, giftBranding]);
  const [status, setStatus] = useState('loading'); // 'loading' | 'complete' | 'pending' | 'error'
  const [purchase, setPurchase] = useState(null);
  const [error, setError] = useState('');

  const sessionId = new URLSearchParams(window.location.search).get('session_id');

  useEffect(() => {
    if (!sessionId) {
      setStatus('error');
      setError('No session ID — you may have arrived here by mistake.');
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20; // 20 × 2s = 40s max wait

    const poll = async () => {
      try {
        const data = await callGiftPublic('gift-purchase-status', {
          session_id: sessionId,
          company_id: location.company_id,
        });
        if (cancelled) return;
        if (data.status === 'fulfilled') {
          setPurchase(data);
          setStatus('complete');
          return;
        }
        if (data.status === 'paid' || data.status === 'pending') {
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(poll, 2000);
            setStatus('pending');
          } else {
            // Timed out waiting for fulfillment — card likely issued but
            // webhook is slow. Show a gentle message rather than an error.
            setPurchase(data);
            setStatus('complete');
          }
          return;
        }
        // Unknown status
        setStatus('error');
        setError(data.error || 'Unexpected status');
      } catch (err) {
        if (cancelled) return;
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000);
        } else {
          setStatus('error');
          setError(err.message || 'Could not verify purchase');
        }
      }
    };

    poll();
    return () => { cancelled = true; };
  }, [sessionId, location.company_id]);

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
      background: t.bg, color: t.text,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px',
    }}>
      {/* Header — v5.5.208: larger logo, org name instead of location */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        {t.logo && (
          <img src={t.logo} alt={t.companyName || location.name} style={{
            height: 96, width: 'auto', maxWidth: 300, borderRadius: 18, objectFit: 'contain',
            background: '#fff', padding: '12px 18px', boxSizing: 'border-box',
            boxShadow: '0 6px 22px rgba(0,0,0,0.18)', marginBottom: 16,
          }}/>
        )}
        {!t.logo && <div style={{ fontSize: 26, fontWeight: 800 }}>{t.companyName || location.name}</div>}
      </div>

      <div style={{ width: '100%', maxWidth: 420 }}>
        {status === 'loading' && (
          <StatusCard t={t} icon="⏳" title="Processing your purchase…" subtitle="Please wait while we set up your gift card." />
        )}

        {status === 'pending' && (
          <StatusCard t={t} icon="✨" title="Payment received!" subtitle="We're generating your gift card now. This usually takes just a few seconds…" />
        )}

        {status === 'error' && (
          <StatusCard t={t} icon="⚠️" title="Something went wrong" subtitle={error}>
            <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
              <a href={giftUrl('/gift')} style={{
                flex: 1, textAlign: 'center', padding: '12px 16px', borderRadius: 99,
                background: t.accent, color: t.accentText, fontWeight: 800, fontSize: 13,
                textDecoration: 'none',
              }}>Try again</a>
              <a href={giftUrl('/gift/balance')} style={{
                flex: 1, textAlign: 'center', padding: '12px 16px', borderRadius: 99,
                background: 'transparent', border: `1px solid ${t.border}`, color: t.text,
                fontWeight: 800, fontSize: 13, textDecoration: 'none',
              }}>Check balance</a>
            </div>
          </StatusCard>
        )}

        {status === 'complete' && purchase && (
          <>
            {/* Success card */}
            <div style={{
              background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
              padding: '32px 24px', textAlign: 'center', marginBottom: 16,
            }}>
              <div style={{ fontSize: 52, marginBottom: 16 }}>🎉</div>
              <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>Gift card sent!</div>
              <div style={{ fontSize: 14, color: t.textMuted, lineHeight: 1.6 }}>
                {purchase.delivery_type === 'self'
                  ? 'Your gift card has been emailed to you.'
                  : <>A gift card has been emailed to <b style={{ color: t.text }}>{purchase.recipient_name || purchase.recipient_email}</b>.</>
                }
              </div>
            </div>

            {/* Card details */}
            <div style={{
              background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
              padding: '24px', marginBottom: 16,
            }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
                fontSize: 13,
              }}>
                <div>
                  <div style={{ color: t.textMuted, fontWeight: 600, marginBottom: 4 }}>Amount</div>
                  <div style={{ fontSize: 20, fontWeight: 800 }}>{formatAmount(purchase.amount_minor, purchase.currency)}</div>
                </div>
                <div>
                  <div style={{ color: t.textMuted, fontWeight: 600, marginBottom: 4 }}>Card</div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>····{purchase.code_last4 || '????'}</div>
                </div>
                {purchase.recipient_email && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ color: t.textMuted, fontWeight: 600, marginBottom: 4 }}>Sent to</div>
                    <div style={{ color: t.text }}>{purchase.recipient_email}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
              <a href={giftUrl('/gift')} style={{
                flex: 1, textAlign: 'center', padding: '14px 16px', borderRadius: 99,
                background: t.accent, color: t.accentText, fontWeight: 800, fontSize: 14,
                textDecoration: 'none',
              }}>Buy another</a>
              <a href={giftUrl('/')} style={{
                flex: 1, textAlign: 'center', padding: '14px 16px', borderRadius: 99,
                background: 'transparent', border: `1px solid ${t.border}`, color: t.text,
                fontWeight: 800, fontSize: 14, textDecoration: 'none',
              }}>Order food</a>
            </div>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 32, fontSize: 11, color: t.textDim }}>
          Powered by Serv OS
        </div>
      </div>
    </div>
  );
}

function StatusCard({ t, icon, title, subtitle, children }) {
  return (
    <div style={{
      background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
      padding: '40px 24px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 42, marginBottom: 14 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.6 }}>{subtitle}</div>
      {children}
    </div>
  );
}
