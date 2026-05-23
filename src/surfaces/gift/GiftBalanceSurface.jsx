// v5.5.196 — Customer-facing gift card balance check.
// URL: https://<slug>.serv-os.app/gift/balance
//
// Simple form: enter the 16-char gift card code, see the current balance.
// No auth required — calls gift-balance-public edge function which
// verifies the code via HMAC lookup + argon2id hash, returning only
// safe-to-display fields (balance, last4, status, expiry).

import { useState, useRef, useMemo } from 'react';
import { callGiftPublic, formatAmount, buildGiftTheme } from './giftHelpers';

export default function GiftBalanceSurface({ location }) {
  const t = useMemo(() => buildGiftTheme(location), [location]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { balance_minor, code_last4, status, expires_at, currency }
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const handleCheck = async (e) => {
    e?.preventDefault();
    const clean = code.replace(/[\s-]/g, '').toUpperCase();
    if (clean.length < 10) { setError('Please enter your full gift card code'); return; }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await callGiftPublic('gift-balance-public', {
        code: clean,
        company_id: location.company_id,
      });
      setResult(data);
    } catch (err) {
      setError(err.message || 'Could not check balance');
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = (s) => {
    if (s === 'active') return { text: 'Active', color: t.success };
    if (s === 'redeemed') return { text: 'Fully redeemed', color: t.textMuted };
    if (s === 'voided') return { text: 'Voided', color: t.error };
    if (s === 'expired') return { text: 'Expired', color: t.error };
    return { text: s, color: t.textMuted };
  };

  return (
    <div style={{
      minHeight: '100vh', background: t.bg, color: t.text,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        {t.logo && (
          <img src={t.logo} alt={location.name} style={{
            width: 72, height: 72, borderRadius: 14, objectFit: 'cover',
            marginBottom: 12,
          }}/>
        )}
        <div style={{ fontSize: 24, fontWeight: 800 }}>{location.name}</div>
        <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>
          Gift Card Balance
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: 420 }}>
        {/* Card-shaped container */}
        <div style={{
          background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
          padding: '32px 24px', marginBottom: 16,
        }}>
          <div style={{
            fontSize: 36, textAlign: 'center', marginBottom: 20,
          }}>🎁</div>

          <div style={{
            fontSize: 15, fontWeight: 700, marginBottom: 16, textAlign: 'center',
          }}>
            Check your gift card balance
          </div>

          <form onSubmit={handleCheck}>
            <label style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, display: 'block', marginBottom: 6 }}>
              Gift card code
            </label>
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxLength={19}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 10,
                border: `1px solid ${t.border}`, background: t.bg, color: t.text,
                fontSize: 16, fontFamily: 'monospace', letterSpacing: '0.08em',
                textAlign: 'center', boxSizing: 'border-box',
                outline: 'none',
              }}
              onFocus={e => e.target.style.borderColor = t.accent}
              onBlur={e => e.target.style.borderColor = t.border}
            />

            {error && (
              <div style={{ color: t.error, fontSize: 13, marginTop: 10, textAlign: 'center' }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || code.replace(/[\s-]/g, '').length < 4}
              style={{
                width: '100%', marginTop: 16, padding: '14px 0', borderRadius: 99,
                background: loading ? t.textDim : t.accent, color: '#0b0c10',
                border: 'none', fontWeight: 800, fontSize: 15, cursor: loading ? 'wait' : 'pointer',
                opacity: (loading || code.replace(/[\s-]/g, '').length < 4) ? 0.5 : 1,
              }}
            >
              {loading ? 'Checking…' : 'Check Balance'}
            </button>
          </form>
        </div>

        {/* Result card */}
        {result && (
          <div style={{
            background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
            padding: '28px 24px', animation: 'fadeIn 0.3s ease',
          }}>
            <div style={{ textAlign: 'center' }}>
              {/* Balance */}
              <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                Current Balance
              </div>
              <div style={{
                fontSize: 42, fontWeight: 800,
                color: result.status === 'active' ? t.text : t.textMuted,
              }}>
                {formatAmount(result.balance_minor, result.currency)}
              </div>

              {/* Status badge */}
              <div style={{ marginTop: 12, marginBottom: 20 }}>
                {(() => {
                  const s = statusLabel(result.status);
                  return (
                    <span style={{
                      display: 'inline-block', padding: '4px 12px', borderRadius: 20,
                      fontSize: 12, fontWeight: 700, color: s.color,
                      background: s.color + '18', border: `1px solid ${s.color}30`,
                    }}>{s.text}</span>
                  );
                })()}
              </div>

              {/* Details */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
                padding: '16px 0', borderTop: `1px solid ${t.border}`,
                fontSize: 12, color: t.textMuted,
              }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>Card</div>
                  <div style={{ color: t.text, fontFamily: 'monospace' }}>
                    ····{result.code_last4}
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>Expires</div>
                  <div style={{ color: t.text }}>
                    {result.expires_at
                      ? new Date(result.expires_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                      : 'No expiry'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Navigation links */}
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <a
            href={`${window.location.origin}/gift`}
            style={{ color: t.accent, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
          >
            Buy a gift card →
          </a>
        </div>

        <div style={{ textAlign: 'center', marginTop: 32, fontSize: 11, color: t.textDim }}>
          Powered by serv-os.app
        </div>
      </div>
    </div>
  );
}
