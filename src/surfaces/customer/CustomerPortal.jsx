// v5.5.221 — Customer-facing loyalty portal.
// URL: https://<slug>.serv-os.app/account
//
// Flow:
//   1. Phone number entry → OTP code sent via SMS
//   2. 6-digit code verification → session token returned
//   3. Dashboard: points balance, tier, rewards, transactions, gift cards, profile
//
// Auth: HMAC session tokens (no Supabase auth for customers). Token stored in
// sessionStorage, auto-clears on tab close. 24h expiry.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { buildGiftTheme, fetchGiftBranding, formatAmount } from '../gift/giftHelpers';

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function callPortal(body) {
  const res = await fetch(`${OPS_URL}/functions/v1/loyalty-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPS_ANON}`,
      'apikey': OPS_ANON,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ─── Session storage helpers ──────────────────────────────────────────────
const SESSION_KEY = 'rpos-loyalty-session';
function storeSession(token, companyId) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, companyId })); } catch {}
}
function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export default function CustomerPortal({ location }) {
  const [giftBranding, setGiftBranding] = useState(null);
  useEffect(() => {
    fetchGiftBranding(location?.company_id).then(b => { if (b) setGiftBranding(b); });
  }, [location?.company_id]);
  const t = useMemo(() => buildGiftTheme(location, giftBranding), [location, giftBranding]);

  // Detect /account/register URL → signup-focused messaging
  const isRegisterUrl = typeof window !== 'undefined' &&
    window.location.pathname.includes('/account/register');

  // Auth state
  const [screen, setScreen] = useState('login'); // login | otp | register | dashboard
  const [phone, setPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Dashboard data
  const [customer, setCustomer] = useState(null);
  const [loyalty, setLoyalty] = useState(null);
  const [giftCards, setGiftCards] = useState([]);

  // Dashboard tab
  const [tab, setTab] = useState('home'); // home | rewards | history | cards | profile

  // Try to resume session on mount
  useEffect(() => {
    const saved = loadSession();
    if (saved?.token && saved?.companyId === location?.company_id) {
      setToken(saved.token);
      refreshData(saved.token);
    }
  }, [location?.company_id]);

  const refreshData = useCallback(async (tkn) => {
    try {
      const data = await callPortal({
        action: 'refresh',
        token: tkn || token,
        phone: '_',
        company_id: location.company_id,
      });
      if (data.customer) setCustomer(data.customer);
      if (data.loyalty) setLoyalty(data.loyalty);
      if (data.gift_cards) setGiftCards(data.gift_cards);
      setScreen('dashboard');
    } catch (e) {
      // Token expired — back to login
      clearSession();
      setToken(null);
      setScreen('login');
    }
  }, [token, location?.company_id]);

  // ── Send OTP ─────────────────────────────────────────────────────────
  const sendOtp = async () => {
    setError('');
    const clean = phone.replace(/\s+/g, '');
    if (clean.length < 10) {
      setError('Please enter a valid phone number');
      return;
    }
    setLoading(true);
    try {
      await callPortal({
        action: 'send',
        phone: clean,
        company_id: location.company_id,
      });
      setScreen('otp');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Verify OTP ────────────────────────────────────────────────────────
  const verifyOtp = async () => {
    setError('');
    if (otpCode.length !== 6) {
      setError('Enter the 6-digit code');
      return;
    }
    setLoading(true);
    try {
      const data = await callPortal({
        action: 'verify',
        phone: phone.replace(/\s+/g, ''),
        company_id: location.company_id,
        code: otpCode,
      });
      if (data.verified && data.token) {
        setToken(data.token);
        storeSession(data.token, location.company_id);
        setCustomer(data.customer);
        setLoyalty(data.loyalty);
        setGiftCards(data.gift_cards || []);
        // First-time registration: if customer has no name, show the
        // signup form before the dashboard so they complete their profile.
        if (!data.customer?.name) {
          setScreen('register');
        } else {
          setScreen('dashboard');
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Logout ────────────────────────────────────────────────────────────
  const logout = () => {
    clearSession();
    setToken(null);
    setCustomer(null);
    setLoyalty(null);
    setGiftCards([]);
    setPhone('');
    setOtpCode('');
    setTab('home');
    setScreen('login');
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      WebkitOverflowScrolling: 'touch',
      background: t.bg, color: t.text,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '40px 20px 60px',
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        {t.logo && (
          <img src={t.logo} alt={t.companyName || location.name} style={{
            width: 100, height: 100, borderRadius: 20, objectFit: 'cover',
            marginBottom: 14,
          }}/>
        )}
        <div style={{ fontSize: 24, fontWeight: 800 }}>{t.companyName || location.name}</div>
        {screen === 'login' && (
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
            {isRegisterUrl ? 'Join our loyalty programme' : 'Sign in to your loyalty account'}
          </div>
        )}
        {screen === 'register' && (
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
            Complete your registration
          </div>
        )}
      </div>

      <div style={{ width: '100%', maxWidth: 440 }}>
        {screen === 'login' && (
          <LoginScreen
            t={t} phone={phone} setPhone={setPhone}
            loading={loading} error={error} onSubmit={sendOtp}
            isRegister={isRegisterUrl}
          />
        )}
        {screen === 'register' && (
          <RegisterScreen
            t={t} location={location} token={token} customer={customer}
            loyalty={loyalty}
            onComplete={(updatedCustomer) => {
              setCustomer(updatedCustomer);
              setScreen('dashboard');
            }}
          />
        )}
        {screen === 'otp' && (
          <OtpScreen
            t={t} phone={phone} otpCode={otpCode} setOtpCode={setOtpCode}
            loading={loading} error={error} onVerify={verifyOtp}
            onResend={sendOtp} onBack={() => { setScreen('login'); setOtpCode(''); setError(''); }}
          />
        )}
        {screen === 'dashboard' && (
          <Dashboard
            t={t} location={location} customer={customer} loyalty={loyalty}
            giftCards={giftCards} tab={tab} setTab={setTab}
            onRefresh={() => refreshData(token)} onLogout={logout}
            token={token}
          />
        )}
      </div>

      {/* Footer */}
      <div style={{ fontSize: 11, color: t.textDim, marginTop: 40, textAlign: 'center' }}>
        Powered by Serv OS
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════
function LoginScreen({ t, phone, setPhone, loading, error, onSubmit, isRegister }) {
  return (
    <Card t={t}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        {isRegister ? 'Create your account' : 'Welcome'}
      </div>
      <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
        {isRegister
          ? 'Enter your mobile number to sign up and start earning points & rewards.'
          : 'Enter your mobile number to access your loyalty points, rewards, and gift cards.'}
      </div>

      <label style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, marginBottom: 6, display: 'block' }}>
        Mobile number
      </label>
      <input
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={e => setPhone(e.target.value)}
        placeholder="07931 123456"
        onKeyDown={e => e.key === 'Enter' && onSubmit()}
        style={{
          width: '100%', padding: '14px 16px', fontSize: 16,
          borderRadius: t.radius - 4, border: `1px solid ${t.border}`,
          background: t.inputBg, color: t.text, outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      {error && <div style={{ fontSize: 12, color: t.error, marginTop: 8 }}>{error}</div>}

      <button
        onClick={onSubmit}
        disabled={loading}
        style={{
          width: '100%', marginTop: 18, padding: '15px',
          borderRadius: 99, border: 'none',
          background: t.accent, color: t.accentText,
          fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'Sending code…' : isRegister ? 'Sign up' : 'Send verification code'}
      </button>

      {/* Toggle between sign-in / sign-up */}
      <div style={{ fontSize: 13, color: t.textMuted, marginTop: 16, textAlign: 'center' }}>
        {isRegister ? (
          <>Already a member?{' '}
            <a href={window.location.pathname.replace('/register', '')}
              style={{ color: t.accent, fontWeight: 600, textDecoration: 'none' }}>
              Sign in
            </a>
          </>
        ) : (
          <>New here?{' '}
            <a href={`${window.location.pathname.replace(/\/$/, '')}/register`}
              style={{ color: t.accent, fontWeight: 600, textDecoration: 'none' }}>
              Join our loyalty programme
            </a>
          </>
        )}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTER SCREEN — first-time signup after OTP verification
// ═══════════════════════════════════════════════════════════════════════════
function RegisterScreen({ t, location, token, customer, loyalty, onComplete }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [birthday, setBirthday] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const valid = name.trim().length >= 2;

  const submit = async () => {
    if (!valid) { setError('Please enter your name'); return; }
    setSaving(true);
    setError('');
    try {
      await callPortal({
        action: 'update_profile',
        token,
        phone: customer?.phone || '_',
        company_id: location.company_id,
        name: name.trim(),
        email: email.trim() || null,
        birthday: birthday || null,
        marketing_opt_in: marketingOptIn,
      });
      onComplete({
        ...customer,
        name: name.trim(),
        email: email.trim() || customer?.email,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const welcomePoints = loyalty?.points_balance || 0;

  return (
    <>
      {/* Welcome hero */}
      {welcomePoints > 0 && (
        <div style={{
          background: `linear-gradient(135deg, ${t.accent}, ${t.accentHover})`,
          borderRadius: t.radius + 4, padding: '24px 20px', marginBottom: 18,
          color: t.accentText, textAlign: 'center',
        }}>
          <div style={{ fontSize: 36, marginBottom: 6 }}>🎉</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>
            You've earned {welcomePoints} welcome points!
          </div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            Complete your registration to start earning rewards
          </div>
        </div>
      )}

      <Card t={t}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Create your account</div>
        <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
          Tell us a bit about yourself to get the most from your loyalty membership.
        </div>

        <FieldLabel t={t}>Name *</FieldLabel>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your full name"
          autoFocus
          style={inputStyle(t)}
        />

        <FieldLabel t={t} style={{ marginTop: 16 }}>Email</FieldLabel>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={inputStyle(t)}
        />
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
          For receipts, order updates, and reward notifications
        </div>

        <FieldLabel t={t} style={{ marginTop: 16 }}>Date of birth</FieldLabel>
        <input
          type="date"
          value={birthday}
          onChange={e => setBirthday(e.target.value)}
          style={{ ...inputStyle(t), colorScheme: t.bg === '#0e0e10' ? 'dark' : 'light' }}
        />
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
          Optional — we'll send you a birthday treat!
        </div>

        {/* Marketing opt-in */}
        <div
          onClick={() => setMarketingOptIn(!marketingOptIn)}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 18,
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          <div style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0, marginTop: 1,
            border: `2px solid ${marketingOptIn ? t.accent : t.border}`,
            background: marketingOptIn ? t.accent : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s',
          }}>
            {marketingOptIn && <span style={{ color: t.accentText, fontSize: 14, fontWeight: 700 }}>✓</span>}
          </div>
          <div style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
            Keep me updated with exclusive offers, rewards, and news
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: t.error, marginTop: 12 }}>{error}</div>}

        <button
          onClick={submit}
          disabled={saving || !valid}
          style={{
            width: '100%', marginTop: 22, padding: '15px',
            borderRadius: 99, border: 'none',
            background: valid ? t.accent : `${t.text}20`,
            color: valid ? t.accentText : `${t.text}60`,
            fontSize: 15, fontWeight: 700, cursor: saving ? 'wait' : valid ? 'pointer' : 'not-allowed',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Creating account…' : 'Join loyalty programme'}
        </button>

        <div style={{ fontSize: 11, color: t.textDim, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
          By joining, you agree to receive points and rewards. You can opt out at any time from your profile.
        </div>
      </Card>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OTP VERIFICATION SCREEN
// ═══════════════════════════════════════════════════════════════════════════
function OtpScreen({ t, phone, otpCode, setOtpCode, loading, error, onVerify, onResend, onBack }) {
  const inputRefs = useRef([]);
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [resendTimer, setResendTimer] = useState(30);

  useEffect(() => {
    const iv = setInterval(() => setResendTimer(v => v > 0 ? v - 1 : 0), 1000);
    return () => clearInterval(iv);
  }, []);

  const handleDigit = (idx, val) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[idx] = val;
    setDigits(next);
    setOtpCode(next.join(''));
    if (val && idx < 5) inputRefs.current[idx + 1]?.focus();
    // Auto-submit when all 6 entered
    if (val && idx === 5 && next.every(d => d)) {
      setTimeout(() => onVerify(), 100);
    }
  };

  const handleKeyDown = (idx, e) => {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const next = [...digits];
    for (let i = 0; i < 6; i++) next[i] = pasted[i] || '';
    setDigits(next);
    setOtpCode(next.join(''));
    if (pasted.length === 6) {
      inputRefs.current[5]?.focus();
      setTimeout(() => onVerify(), 100);
    } else {
      inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    }
  };

  return (
    <Card t={t}>
      <button
        onClick={onBack}
        style={{
          background: 'none', border: 'none', color: t.textMuted, cursor: 'pointer',
          fontSize: 13, padding: 0, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        ← Back
      </button>

      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Enter your code</div>
      <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
        We sent a 6-digit code to <strong style={{ color: t.text }}>{phone}</strong>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={el => inputRefs.current[i] = el}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={d}
            onChange={e => handleDigit(i, e.target.value)}
            onKeyDown={e => handleKeyDown(i, e)}
            onPaste={i === 0 ? handlePaste : undefined}
            autoFocus={i === 0}
            style={{
              width: 48, height: 56, textAlign: 'center', fontSize: 22, fontWeight: 700,
              borderRadius: t.radius - 4, border: `1px solid ${t.border}`,
              background: t.inputBg, color: t.text, outline: 'none',
              caretColor: t.accent,
            }}
          />
        ))}
      </div>

      {error && <div style={{ fontSize: 12, color: t.error, marginTop: 8, textAlign: 'center' }}>{error}</div>}

      <button
        onClick={onVerify}
        disabled={loading || otpCode.length !== 6}
        style={{
          width: '100%', marginTop: 18, padding: '15px',
          borderRadius: 99, border: 'none',
          background: t.accent, color: t.accentText,
          fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
          opacity: (loading || otpCode.length !== 6) ? 0.5 : 1,
        }}
      >
        {loading ? 'Verifying…' : 'Verify'}
      </button>

      <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: t.textMuted }}>
        {resendTimer > 0
          ? `Resend code in ${resendTimer}s`
          : <button onClick={() => { onResend(); setResendTimer(30); }} style={{ background:'none', border:'none', color: t.accent, cursor:'pointer', fontWeight:600, fontSize: 13, padding: 0 }}>Resend code</button>
        }
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
function Dashboard({ t, location, customer, loyalty, giftCards, tab, setTab, onRefresh, onLogout, token }) {
  const tabs = [
    { id: 'home', label: 'Home', icon: '🏠' },
    { id: 'rewards', label: 'Rewards', icon: '🎁' },
    { id: 'history', label: 'History', icon: '📋' },
    { id: 'cards', label: 'Gift Cards', icon: '💳' },
    { id: 'profile', label: 'Profile', icon: '👤' },
  ];

  return (
    <>
      {/* Points hero */}
      {loyalty && tab === 'home' && (
        <PointsHero t={t} loyalty={loyalty} customer={customer} />
      )}

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20, overflowX: 'auto',
        padding: '2px 0',
      }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            flex: 1, minWidth: 0, padding: '10px 6px', borderRadius: t.radius - 4,
            border: `1px solid ${tab === tb.id ? t.accent : t.border}`,
            background: tab === tb.id ? t.accent : 'transparent',
            color: tab === tb.id ? t.accentText : t.textMuted,
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            whiteSpace: 'nowrap',
          }}>
            <span style={{ fontSize: 16 }}>{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'home' && <HomeTab t={t} loyalty={loyalty} customer={customer} giftCards={giftCards} setTab={setTab} />}
      {tab === 'rewards' && <RewardsTab t={t} loyalty={loyalty} />}
      {tab === 'history' && <HistoryTab t={t} loyalty={loyalty} />}
      {tab === 'cards' && <GiftCardsTab t={t} giftCards={giftCards} />}
      {tab === 'profile' && <ProfileTab t={t} customer={customer} loyalty={loyalty} token={token} location={location} onRefresh={onRefresh} onLogout={onLogout} />}
    </>
  );
}

// ── Points Hero ──────────────────────────────────────────────────────────
function PointsHero({ t, loyalty, customer }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${t.accent}, ${t.accentHover})`,
      borderRadius: t.radius + 4, padding: '28px 24px', marginBottom: 20,
      color: t.accentText, textAlign: 'center',
    }}>
      {customer?.name && (
        <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.85, marginBottom: 4 }}>
          Welcome back, {customer.name.split(' ')[0]}
        </div>
      )}
      <div style={{ fontSize: 48, fontWeight: 900, lineHeight: 1 }}>
        {(loyalty.points_balance || 0).toLocaleString()}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.8, marginTop: 4 }}>
        loyalty points
      </div>
      {loyalty.tier && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 12,
          padding: '5px 14px', borderRadius: 99,
          background: 'rgba(255,255,255,0.2)', fontSize: 12, fontWeight: 700,
        }}>
          {loyalty.tier.icon || '⭐'} {loyalty.tier.name}
          {loyalty.tier.multiplier > 1 && <span style={{ opacity: 0.75 }}> · {loyalty.tier.multiplier}x points</span>}
        </div>
      )}
      {loyalty.member_code && (
        <div style={{ fontSize: 11, marginTop: 12, opacity: 0.6, fontFamily: 'monospace', letterSpacing: '0.05em' }}>
          {loyalty.member_code}
        </div>
      )}
    </div>
  );
}

// ── Home Tab ─────────────────────────────────────────────────────────────
function HomeTab({ t, loyalty, customer, giftCards, setTab }) {
  const rewardsAvail = loyalty?.rewards_available?.length || 0;
  const giftActive = giftCards?.length || 0;
  const totalBalance = giftCards.reduce((s, c) => s + (c.balance || 0), 0);

  return (
    <>
      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <StatCard t={t} label="Total earned" value={(loyalty?.points_earned_total || 0).toLocaleString()} icon="📈" />
        <StatCard t={t} label="Visits" value={loyalty?.visit_count || 0} icon="🏪" />
        <StatCard t={t} label="Rewards ready" value={rewardsAvail} icon="🎁" onClick={() => setTab('rewards')} />
        <StatCard t={t} label="Gift cards" value={giftActive} icon="💳" onClick={() => setTab('cards')} />
      </div>

      {/* Available rewards preview */}
      {rewardsAvail > 0 && (
        <Card t={t} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Ready to redeem</div>
            <button onClick={() => setTab('rewards')} style={{ background:'none', border:'none', color: t.accent, fontSize: 12, fontWeight: 600, cursor:'pointer', padding: 0 }}>
              View all →
            </button>
          </div>
          {loyalty.rewards_available.slice(0, 3).map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              borderTop: `1px solid ${t.border}`,
            }}>
              <span style={{ fontSize: 22 }}>{r.icon || '🎁'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                <div style={{ fontSize: 11, color: t.textMuted }}>{r.points_cost} pts</div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Gift card balance summary */}
      {giftActive > 0 && (
        <Card t={t}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Gift card balance</div>
              <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>
                {giftActive} active card{giftActive !== 1 ? 's' : ''}
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: t.accent }}>
              {formatAmount(totalBalance)}
            </div>
          </div>
        </Card>
      )}

      {/* No loyalty yet */}
      {!loyalty && (
        <Card t={t}>
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>⭐</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Loyalty coming soon</div>
            <div style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
              This venue hasn't enabled their loyalty programme yet. Check back soon!
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

// ── Rewards Tab ──────────────────────────────────────────────────────────
function RewardsTab({ t, loyalty }) {
  if (!loyalty) return <Card t={t}><EmptyState icon="🎁" text="Loyalty not available yet" /></Card>;

  const available = loyalty.rewards_available || [];
  const all = loyalty.all_rewards || [];
  const locked = all.filter(r => !available.find(a => a.id === r.id));

  return (
    <>
      {available.length > 0 && (
        <>
          <SectionTitle t={t}>Ready to redeem</SectionTitle>
          {available.map(r => (
            <RewardCard key={r.id} t={t} reward={r} available balance={loyalty.points_balance} />
          ))}
        </>
      )}

      {locked.length > 0 && (
        <>
          <SectionTitle t={t} style={{ marginTop: available.length > 0 ? 20 : 0 }}>Keep earning</SectionTitle>
          {locked.map(r => (
            <RewardCard key={r.id} t={t} reward={r} balance={loyalty.points_balance} />
          ))}
        </>
      )}

      {all.length === 0 && (
        <Card t={t}><EmptyState icon="🎁" text="No rewards set up yet. Keep earning points!" /></Card>
      )}
    </>
  );
}

function RewardCard({ t, reward, available, balance = 0 }) {
  const ptsNeeded = Math.max(0, reward.points_cost - balance);
  return (
    <Card t={t} style={{ marginBottom: 10, opacity: available ? 1 : 0.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: available ? t.accent : t.border,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, flexShrink: 0,
          color: available ? t.accentText : t.textMuted,
        }}>
          {reward.icon || '🎁'}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{reward.name}</div>
          {reward.description && (
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>{reward.description}</div>
          )}
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: available ? t.accent : t.textMuted }}>
            {available ? `✓ ${reward.points_cost} pts — available now` : `${reward.points_cost} pts — ${ptsNeeded} more to go`}
          </div>
        </div>
      </div>

      {/* Progress bar for locked rewards */}
      {!available && (
        <div style={{
          marginTop: 10, height: 5, borderRadius: 99,
          background: t.border, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 99, background: t.accent,
            width: `${Math.min(100, (balance / reward.points_cost) * 100)}%`,
            transition: 'width 0.3s',
          }} />
        </div>
      )}
    </Card>
  );
}

// ── History Tab ──────────────────────────────────────────────────────────
function HistoryTab({ t, loyalty }) {
  if (!loyalty) return <Card t={t}><EmptyState icon="📋" text="No history yet" /></Card>;

  const txs = loyalty.recent_transactions || [];
  if (txs.length === 0) return <Card t={t}><EmptyState icon="📋" text="No transactions yet. Make a purchase to start earning!" /></Card>;

  return (
    <Card t={t}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Recent activity</div>
      {txs.map((tx, i) => {
        const isEarn = tx.type === 'earn' || tx.type === 'bonus' || tx.type === 'registration_bonus' || tx.type === 'birthday_bonus';
        const label = {
          earn: 'Points earned',
          redeem: 'Reward redeemed',
          bonus: 'Bonus',
          registration_bonus: 'Welcome bonus',
          birthday_bonus: 'Birthday bonus',
          refund: 'Refund reversal',
          expire: 'Points expired',
          manual: 'Manual adjustment',
        }[tx.type] || tx.type;

        const d = new Date(tx.created_at);
        const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 0',
            borderTop: i > 0 ? `1px solid ${t.border}` : 'none',
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 11, color: t.textMuted }}>{dateStr} at {timeStr}</div>
            </div>
            <div style={{
              fontSize: 14, fontWeight: 700,
              color: isEarn ? t.success : t.textMuted,
            }}>
              {isEarn ? '+' : ''}{tx.points}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ── Gift Cards Tab ───────────────────────────────────────────────────────
function GiftCardsTab({ t, giftCards }) {
  if (!giftCards || giftCards.length === 0) {
    return <Card t={t}><EmptyState icon="💳" text="No active gift cards linked to your account" /></Card>;
  }

  return (
    <>
      {giftCards.map((gc, i) => (
        <Card key={gc.id || i} t={t} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 11, color: t.textMuted, fontWeight: 600, letterSpacing: '0.04em' }}>
                GIFT CARD ····{gc.last4}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
                {formatAmount(gc.balance)}
              </div>
              <div style={{ fontSize: 11, color: t.textDim, marginTop: 2 }}>
                Original: {formatAmount(gc.initial)}
                {gc.expires_at && <> · Expires {new Date(gc.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</>}
              </div>
            </div>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: t.accent, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24,
            }}>
              💳
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

// ── Profile Tab ──────────────────────────────────────────────────────────
function ProfileTab({ t, customer, loyalty, token, location, onRefresh, onLogout }) {
  const [name, setName] = useState(customer?.name || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveProfile = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await callPortal({
        action: 'update_profile',
        token,
        phone: customer?.phone || '_',
        company_id: location.company_id,
        name: name.trim(),
        email: email.trim(),
      });
      setSaved(true);
      onRefresh();
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card t={t} style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Your details</div>

        <FieldLabel t={t}>Name</FieldLabel>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          style={inputStyle(t)}
        />

        <FieldLabel t={t} style={{ marginTop: 14 }}>Email</FieldLabel>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={inputStyle(t)}
        />

        <FieldLabel t={t} style={{ marginTop: 14 }}>Phone</FieldLabel>
        <input
          type="tel"
          value={customer?.phone || ''}
          disabled
          style={{ ...inputStyle(t), opacity: 0.5, cursor: 'not-allowed' }}
        />
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
          Phone number cannot be changed
        </div>

        <button
          onClick={saveProfile}
          disabled={saving}
          style={{
            width: '100%', marginTop: 18, padding: '14px',
            borderRadius: 99, border: 'none',
            background: t.accent, color: t.accentText,
            fontSize: 14, fontWeight: 700, cursor: saving ? 'wait' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
        </button>
      </Card>

      {/* Membership info */}
      {loyalty && (
        <Card t={t} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Membership</div>
          <InfoRow t={t} label="Member code" value={loyalty.member_code} />
          <InfoRow t={t} label="Joined" value={loyalty.enrolled_at ? new Date(loyalty.enrolled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'} />
          <InfoRow t={t} label="Points balance" value={(loyalty.points_balance || 0).toLocaleString()} />
          <InfoRow t={t} label="Total earned" value={(loyalty.points_earned_total || 0).toLocaleString()} />
          <InfoRow t={t} label="Total redeemed" value={(loyalty.points_redeemed_total || 0).toLocaleString()} />
          {loyalty.tier && <InfoRow t={t} label="Tier" value={`${loyalty.tier.icon || '⭐'} ${loyalty.tier.name}`} />}
        </Card>
      )}

      {/* Logout */}
      <button
        onClick={onLogout}
        style={{
          width: '100%', padding: '14px',
          borderRadius: 99, border: `1px solid ${t.border}`,
          background: 'transparent', color: t.textMuted,
          fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}
      >
        Sign out
      </button>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function Card({ t, children, style }) {
  return (
    <div style={{
      background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
      padding: '20px', ...style,
    }}>
      {children}
    </div>
  );
}

function StatCard({ t, label, value, icon, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: t.card, border: `1px solid ${t.border}`, borderRadius: t.radius,
        padding: '16px 14px', textAlign: 'center',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function SectionTitle({ t, children, style }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 700, color: t.textMuted,
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginBottom: 10, ...style,
    }}>
      {children}
    </div>
  );
}

function FieldLabel({ t, children, style }) {
  return (
    <label style={{
      fontSize: 12, fontWeight: 600, color: t.textMuted,
      marginBottom: 6, display: 'block', ...style,
    }}>
      {children}
    </label>
  );
}

function InfoRow({ t, label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 0', borderBottom: `1px solid ${t.border}`, fontSize: 13,
    }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>{value}</span>
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 0' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 13, opacity: 0.6, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

function inputStyle(t) {
  return {
    width: '100%', padding: '13px 14px', fontSize: 15,
    borderRadius: t.radius - 4, border: `1px solid ${t.border}`,
    background: t.inputBg, color: t.text, outline: 'none',
    boxSizing: 'border-box',
  };
}
