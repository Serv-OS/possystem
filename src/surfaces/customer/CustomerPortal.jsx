// v5.5.221 — Customer-facing loyalty portal.
// URL: https://<slug>.serv-os.app/account
//
// Flow:
//   1. Phone number entry → OTP code sent via SMS
//   2. 6-digit code verification → session token returned
//   3. Dashboard: points balance, tier, rewards, transactions, gift cards, profile
//
// Auth: HMAC session tokens (no Supabase auth for customers). Token stored in
// localStorage with a 24h TTL so the customer stays signed in across tabs/visits.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { buildGiftTheme, fetchGiftBranding, formatAmount } from '../gift/giftHelpers';
import { firstNameOf } from '../../lib/customerInitials';
import { readProfileReply, customerAfterSave, isSignInAgain } from '../../lib/portalProfileReply';
import { portalLoyaltyView } from '../../lib/portalLoyaltyView';

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
  if (!res.ok) {
    // The code travels with the error (27 Sep 2026): 'sign_in_again' means the session's profile
    // is gone (joined into another one, or deleted), so the portal signs in again, no alert.
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = data?.code || null;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── Session storage helpers (localStorage + 24h TTL) ────────────────────
const SESSION_KEY = 'rpos-loyalty-session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
function storeSession(token, companyId) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, companyId, at: Date.now() })); } catch { /* no storage (private window): signed in for this visit only */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Expire after 24h
    if (parsed.at && (Date.now() - parsed.at) > SESSION_TTL_MS) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* no storage: nothing to clear */ }
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
  const [screen, setScreen] = useState(isRegisterUrl ? 'register_form' : 'login');
  // login | otp | register_form | register_otp | register | dashboard
  const [phone, setPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Registration pre-fill data (collected before OTP)
  const [regData, setRegData] = useState(null);

  // A plain words note after a profile save (27 Sep 2026): the account was joined with the
  // member's imported one, or the email stayed off it and why.
  const [notice, setNotice] = useState('');

  // Dashboard data
  const [customer, setCustomer] = useState(null);
  const [loyalty, setLoyalty] = useState(null);
  const [giftCards, setGiftCards] = useState([]);
  const [stampCards, setStampCards] = useState([]);

  // Wallet pass availability
  const [walletAvail, setWalletAvail] = useState({ apple: false, google: false });
  const [walletLoading, setWalletLoading] = useState(false);
  useEffect(() => {
    fetch(`${OPS_URL}/functions/v1/wallet-pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPS_ANON}`, 'apikey': OPS_ANON },
      body: JSON.stringify({ action: 'check' }),
    })
      .then(r => r.json()).then(j => { if (j.apple || j.google) setWalletAvail(j); })
      .catch(() => {});
  }, []);

  const addToWallet = useCallback(async (type) => {
    if (!token) return;
    setWalletLoading(true);
    try {
      const locId = location.ops_location_id || location.id;
      const res = await fetch(`${OPS_URL}/functions/v1/wallet-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPS_ANON}`, 'apikey': OPS_ANON },
        body: JSON.stringify({ action: type, token, location_id: locId }),
      });
      if (type === 'apple') {
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Failed'); }
        const blob = new Blob([await res.arrayBuffer()], { type: 'application/vnd.apple.pkpass' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // On iOS, omit download attr so Safari opens Wallet dialog; elsewhere set filename
        if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) a.download = 'loyalty.pkpass';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Failed');
        if (j.url) window.open(j.url, '_blank');
      }
    } catch (e) {
      console.warn('[wallet]', e?.message || e);
    } finally {
      setWalletLoading(false);
    }
  }, [token, location]);

  // Dashboard tab
  const [tab, setTab] = useState('home'); // home | rewards | history | stamps | cards | profile

  // Try to resume session on mount
  useEffect(() => {
    const saved = loadSession();
    if (saved?.token && saved?.companyId === location?.company_id) {
      setToken(saved.token);
      refreshData(saved.token);
    }
  }, [location?.company_id]);

  // When the account was last read, so coming back to the page reads it again at most once a minute.
  const lastReadRef = useRef(0);
  // Goes up on every sign out: a read still on its way for the member who signed out is dropped
  // (it would otherwise put their account back on screen after "Not you? Sign out").
  const sessionEpochRef = useRef(0);

  // quiet (21 Oct 2026): a read in the background, when the member comes back to the page. A
  // failed one keeps what is on screen (a phone waking up with no signal is not a sign out); only a
  // session the server refuses (401) signs out.
  const refreshData = useCallback(async (tkn, opts = {}) => {
    lastReadRef.current = Date.now();
    const epoch = sessionEpochRef.current;
    try {
      const data = await callPortal({
        action: 'refresh',
        token: tkn || token,
      });
      if (epoch !== sessionEpochRef.current) return;
      if (data.customer) setCustomer(data.customer);
      // Since 21 Oct 2026 refresh answers in exactly the shape a sign in does (loyalty-otp
      // memberAccount): loyalty is null when the company has turned loyalty off.
      if ('loyalty' in data) setLoyalty(data.loyalty ?? null);
      if (data.gift_cards) setGiftCards(data.gift_cards);
      if (data.stamp_cards) setStampCards(data.stamp_cards);
      setScreen('dashboard');
    } catch (e) {
      if (epoch !== sessionEpochRef.current) return;
      if (opts.quiet && e?.status !== 401) return;
      // Token expired, or its profile is gone: back to login
      clearSession();
      setToken(null);
      setCustomer(null);
      setLoyalty(null);
      setGiftCards([]);
      setStampCards([]);
      setScreen('login');
      if (opts.quiet && e?.code === 'sign_in_again') setError(e.message || '');
    }
  }, [token, location?.company_id]);

  // An open tab never shows old stamps for long (21 Oct 2026): the portal used to read the
  // account only when it opened. Coming back to the page (it shows again, or gets focus) reads it
  // again, at most once a minute.
  useEffect(() => {
    if (screen !== 'dashboard' || !token) return undefined;
    const onBack = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - lastReadRef.current < 60 * 1000) return;
      refreshData(token, { quiet: true });
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, [screen, token, refreshData]);

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
        location_id: location.ops_location_id || location.id,
      });
      setScreen('otp');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── A profile save's reply (27 Sep 2026) ─────────────────────────────
  // The email the member saved was on their imported profile: loyalty-otp joined the two and
  // sent a fresh session for the joined account. Take it now, so the member sees their stamps
  // and points straight away. Returns readProfileReply's answer for the caller. The Profile tab
  // shows a refusal under its own Save button (showRefusal false), the sign up screens up here.
  const applyProfileReply = (data, showRefusal = true) => {
    const reply = readProfileReply(data);
    if (reply.joined) {
      setToken(reply.session.token);
      storeSession(reply.session.token, location.company_id);
      setCustomer(reply.session.customer);
      setLoyalty(reply.session.loyalty);
      setGiftCards(reply.session.giftCards);
      setStampCards(reply.session.stampCards);
      setTab('home');
    }
    if (reply.joined || showRefusal) setNotice(reply.notice);
    return reply;
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
        lastReadRef.current = Date.now();
        setToken(data.token);
        storeSession(data.token, location.company_id);
        setCustomer(data.customer);
        setLoyalty(data.loyalty);
        setGiftCards(data.gift_cards || []);
        setStampCards(data.stamp_cards || []);

        // If this verification came from the registration flow,
        // save the pre-collected profile data now
        if (screen === 'register_otp' && regData) {
          try {
            const saved = await callPortal({
              action: 'update_profile',
              token: data.token,
              phone: phone.replace(/\s+/g, ''),
              company_id: location.company_id,
              location_id: location.ops_location_id || location.id,
              name: regData.name,
              email: regData.email || null,
              birthday: regData.birthday || null,
              marketing_opt_in: regData.marketingOptIn,
            });
            const reply = applyProfileReply(saved);
            if (!reply.joined) {
              setCustomer(c => customerAfterSave(c, { name: regData.name, email: regData.email }, reply));
            }
            setRegData(null);
          } catch (profileErr) {
            console.warn('[Portal] Profile save after reg:', profileErr?.message);
          }
          setScreen('dashboard');
        } else if (!data.customer?.name) {
          // Existing sign-in flow: if customer has no name, show
          // the signup form before the dashboard so they complete their profile.
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
    sessionEpochRef.current += 1;
    clearSession();
    setToken(null);
    setCustomer(null);
    setLoyalty(null);
    setGiftCards([]);
    setStampCards([]);
    setPhone('');
    setOtpCode('');
    setRegData(null);
    setTab('home');
    setNotice('');
    setScreen(isRegisterUrl ? 'register_form' : 'login');
  };

  // The session's profile is gone (joined into another one the phone could not follow, or
  // deleted): back to sign in, with the reason on the sign in screen.
  const signInAgain = (message) => {
    logout();
    setError(message || '');
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
      {/* v5.5.897: optional hero banner — Appearance → Loyalty portal → "Show hero banner" */}
      {t.showHero && t.hero && (
        <div style={{
          width: 'calc(100% + 40px)', margin: '-40px -20px 24px', height: 150,
          backgroundImage: `url(${t.hero})`, backgroundSize: 'cover', backgroundPosition: 'center',
        }}/>
      )}
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 28, flexShrink: 0 }}>
        {t.logo && (
          <img src={t.logo} alt={t.companyName || location.name} style={{
            height: 76, width: 'auto', maxWidth: 260, borderRadius: 16, objectFit: 'contain',
            background: '#fff', padding: '10px 14px', boxSizing: 'border-box',
            boxShadow: '0 4px 18px rgba(0,0,0,0.15)', marginBottom: 14,
          }}/>
        )}
        {/* v5.5.750: the logo carries the brand — only show the name when there's no logo. */}
        {!t.logo && <div style={{ fontSize: 24, fontWeight: 800 }}>{t.companyName || location.name}</div>}
        {screen === 'login' && (
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
            Sign in to your loyalty account
          </div>
        )}
        {screen === 'register_form' && (
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
            Join our loyalty programme
          </div>
        )}
        {(screen === 'register' || screen === 'register_otp') && (
          <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
            Complete your registration
          </div>
        )}
      </div>

      <div style={{ width: '100%', maxWidth: 440, flexShrink: 0 }}>
        {screen === 'login' && (
          <LoginScreen
            t={t} phone={phone} setPhone={setPhone}
            loading={loading} error={error} onSubmit={sendOtp}
            isRegister={false}
          />
        )}
        {screen === 'register_form' && (
          <RegisterFormScreen
            t={t} location={location}
            loading={loading} error={error}
            onSubmit={(data) => {
              setRegData(data);
              setPhone(data.phone);
              // Send OTP to verify the phone
              (async () => {
                setError('');
                setLoading(true);
                try {
                  await callPortal({
                    action: 'send',
                    phone: data.phone.replace(/\s+/g, ''),
                    company_id: location.company_id,
                    location_id: location.ops_location_id || location.id,
                  });
                  setOtpCode('');
                  setScreen('register_otp');
                } catch (e) {
                  setError(e.message);
                } finally {
                  setLoading(false);
                }
              })();
            }}
          />
        )}
        {screen === 'register' && (
          <RegisterScreen
            t={t} location={location} token={token} customer={customer}
            loyalty={loyalty}
            onComplete={(typed, saved) => {
              const reply = applyProfileReply(saved);
              if (!reply.joined) setCustomer(c => customerAfterSave(c, typed, reply));
              setScreen('dashboard');
            }}
            onSignInAgain={signInAgain}
          />
        )}
        {(screen === 'otp' || screen === 'register_otp') && (
          <OtpScreen
            t={t} phone={phone} otpCode={otpCode} setOtpCode={setOtpCode}
            loading={loading} error={error} onVerify={verifyOtp}
            onResend={sendOtp}
            onBack={() => {
              setOtpCode(''); setError('');
              setScreen(screen === 'register_otp' ? 'register_form' : 'login');
            }}
          />
        )}
        {screen === 'dashboard' && notice && (
          <NoticeCard t={t} text={notice} onClose={() => setNotice('')} />
        )}
        {screen === 'dashboard' && (
          <Dashboard
            t={t} location={location} customer={customer} loyalty={loyalty}
            giftCards={giftCards} stampCards={stampCards} tab={tab} setTab={setTab}
            onRefresh={() => refreshData(token)} onLogout={logout}
            token={token}
            walletAvail={walletAvail} walletLoading={walletLoading} addToWallet={addToWallet}
            onProfileReply={applyProfileReply} onSignInAgain={signInAgain}
          />
        )}
      </div>

      {/* Footer */}
      <div style={{ fontSize: 11, color: t.textDim, marginTop: 40, textAlign: 'center', flexShrink: 0 }}>
        Powered by Serv OS
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════
function LoginScreen({ t, phone, setPhone, loading, error, onSubmit }) {
  return (
    <Card t={t}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Welcome</div>
      <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
        Enter your mobile number to see your loyalty rewards and gift cards.
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
        {loading ? 'Sending code…' : 'Send verification code'}
      </button>

      {/* Link to registration */}
      <div style={{ fontSize: 13, color: t.textMuted, marginTop: 16, textAlign: 'center' }}>
        New here?{' '}
        <a href={`${window.location.pathname.replace(/\/$/, '')}/register`}
          style={{ color: t.accent, fontWeight: 600, textDecoration: 'none' }}>
          Join our loyalty programme
        </a>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTER FORM SCREEN — collect details BEFORE OTP verification
// ═══════════════════════════════════════════════════════════════════════════
function RegisterFormScreen({ t, loading, error, onSubmit }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [localError, setLocalError] = useState('');

  const handleSubmit = () => {
    setLocalError('');
    if (!firstName.trim()) { setLocalError('Please enter your first name'); return; }
    if (!lastName.trim()) { setLocalError('Please enter your last name'); return; }
    const cleanPhone = phone.replace(/\s+/g, '');
    if (cleanPhone.length < 10) { setLocalError('Please enter a valid mobile number'); return; }
    onSubmit({
      name: `${firstName.trim()} ${lastName.trim()}`,
      email: email.trim() || null,
      phone: cleanPhone,
      birthday: birthday || null,
      marketingOptIn,
    });
  };

  return (
    <Card t={t}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Create your account</div>
      <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
        Fill in your details to join our loyalty programme and start collecting rewards.
      </div>

      {/* First name + Last name side by side */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <FieldLabel t={t}>First name *</FieldLabel>
          <input
            type="text" value={firstName}
            onChange={e => setFirstName(e.target.value)}
            placeholder="First name" autoFocus
            style={inputStyle(t)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <FieldLabel t={t}>Last name *</FieldLabel>
          <input
            type="text" value={lastName}
            onChange={e => setLastName(e.target.value)}
            placeholder="Last name"
            style={inputStyle(t)}
          />
        </div>
      </div>

      <FieldLabel t={t} style={{ marginTop: 16 }}>Email</FieldLabel>
      <input
        type="email" value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="you@example.com"
        style={inputStyle(t)}
      />
      <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
        For receipts, order updates, and reward notifications
      </div>

      <FieldLabel t={t} style={{ marginTop: 16 }}>Mobile number *</FieldLabel>
      <input
        type="tel" inputMode="tel" value={phone}
        onChange={e => setPhone(e.target.value)}
        placeholder="07931 123456"
        style={inputStyle(t)}
      />
      <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
        We'll send a verification code to confirm your number
      </div>

      <FieldLabel t={t} style={{ marginTop: 16 }}>Date of birth</FieldLabel>
      <input
        type="date" value={birthday}
        onChange={e => setBirthday(e.target.value)}
        style={{ ...inputStyle(t), colorScheme: t.isDark ? 'dark' : 'light' /* v5.5.897: real flag, not a bg sniff */ }}
      />
      <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
        We'll send you a birthday treat!
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

      {(localError || error) && (
        <div style={{ fontSize: 12, color: t.error, marginTop: 12 }}>{localError || error}</div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading}
        style={{
          width: '100%', marginTop: 22, padding: '15px',
          borderRadius: 99, border: 'none',
          background: t.accent, color: t.accentText,
          fontSize: 15, fontWeight: 700,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? 'Sending code…' : 'Continue — verify your number'}
      </button>

      <div style={{ fontSize: 11, color: t.textDim, marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
        By joining, you agree to collect rewards with us. You can opt out at any time from your profile.
      </div>

      {/* Link to sign-in */}
      <div style={{ fontSize: 13, color: t.textMuted, marginTop: 16, textAlign: 'center' }}>
        Already a member?{' '}
        <a href={window.location.pathname.replace('/register', '')}
          style={{ color: t.accent, fontWeight: 600, textDecoration: 'none' }}>
          Sign in
        </a>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTER SCREEN — first-time signup after OTP verification
// ═══════════════════════════════════════════════════════════════════════════
function RegisterScreen({ t, location, token, customer, loyalty, onComplete, onSignInAgain }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState(customer?.email || '');
  const [birthday, setBirthday] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const valid = firstName.trim().length >= 1 && lastName.trim().length >= 1;
  const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();

  const submit = async () => {
    if (!firstName.trim()) { setError('Please enter your first name'); return; }
    if (!lastName.trim()) { setError('Please enter your last name'); return; }
    setSaving(true);
    setError('');
    try {
      const saved = await callPortal({
        action: 'update_profile',
        token,
        phone: customer?.phone || '_',
        company_id: location.company_id,
        location_id: location.ops_location_id || location.id,
        name: fullName,
        email: email.trim() || null,
        birthday: birthday || null,
        marketing_opt_in: marketingOptIn,
      });
      onComplete({ name: fullName, email: email.trim() || null }, saved);
    } catch (e) {
      if (isSignInAgain(e) && onSignInAgain) { onSignInAgain(e.message); return; }
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const pointsEnabled = loyalty?.points_enabled !== false;
  const welcomePoints = loyalty?.points_balance || 0;

  return (
    <>
      {/* Welcome hero */}
      {pointsEnabled && welcomePoints > 0 && (
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

        {/* First name + Last name side by side */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FieldLabel t={t}>First name *</FieldLabel>
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="First name"
              autoFocus
              style={inputStyle(t)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <FieldLabel t={t}>Last name *</FieldLabel>
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Last name"
              style={inputStyle(t)}
            />
          </div>
        </div>

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

        {/* Phone — pre-filled from OTP, read-only */}
        <FieldLabel t={t} style={{ marginTop: 16 }}>Phone</FieldLabel>
        <input
          type="tel"
          value={customer?.phone || ''}
          readOnly
          style={{ ...inputStyle(t), opacity: 0.6, cursor: 'not-allowed' }}
        />
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
          Verified via SMS — cannot be changed
        </div>

        <FieldLabel t={t} style={{ marginTop: 16 }}>Date of birth</FieldLabel>
        <input
          type="date"
          value={birthday}
          onChange={e => setBirthday(e.target.value)}
          style={{ ...inputStyle(t), colorScheme: t.isDark ? 'dark' : 'light' /* v5.5.897: real flag, not a bg sniff */ }}
        />
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
          We'll send you a birthday treat!
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
          By joining, you agree to collect rewards with us. You can opt out at any time from your profile.
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
function Dashboard({ t, location, customer, loyalty, giftCards, stampCards, tab, setTab, onRefresh, onLogout, token, walletAvail, walletLoading, addToWallet, onProfileReply, onSignInAgain }) {
  // 21 Oct 2026: ONE view of what the company runs, stamps, points or both (portalLoyaltyView).
  // Before, a missing flag counted as ON, so a stamps only company showed "0 loyalty points" after
  // a sign in. A flag the server did not send is now read from the data, never taken as points.
  const view = useMemo(() => portalLoyaltyView({ loyalty, stampCards, customer }), [loyalty, stampCards, customer]);
  const pointsEnabled = view.showPoints;
  const tabs = [
    { id: 'home', label: 'Home', icon: '🏠' },
    // Earned stamp-card rewards must surface even on a stamps-only venue (the Rewards tab used
    // to be points-gated, so a completed card's free item was invisible: the original bug).
    ...(view.tabs.rewards ? [{ id: 'rewards', label: 'Rewards', icon: '🎁' }] : []),
    ...(view.tabs.stamps ? [{ id: 'stamps', label: 'Stamps', icon: '☕' }] : []),
    ...(view.tabs.history ? [{ id: 'history', label: 'History', icon: '📋' }] : []),
    { id: 'cards', label: 'Gift Cards', icon: '💳' },
    { id: 'profile', label: 'Profile', icon: '👤' },
  ];
  // A tab the company does not run (points off) is never shown, even if it was open before.
  const activeTab = tabs.some(tb => tb.id === tab) ? tab : 'home';

  return (
    <>
      {/* What this company runs, big and plain: stamps, points or both */}
      {loyalty && activeTab === 'home' && (
        <LoyaltyHero t={t} view={view} loyalty={loyalty} customer={customer} onLogout={onLogout} />
      )}

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20, overflowX: 'auto',
        padding: '2px 0',
      }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            flex: 1, minWidth: 0, padding: '10px 6px', borderRadius: t.radius - 4,
            border: `1px solid ${activeTab === tb.id ? t.accent : t.border}`,
            background: activeTab === tb.id ? t.accent : 'transparent',
            color: activeTab === tb.id ? t.accentText : t.textMuted,
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            whiteSpace: 'nowrap',
          }}>
            <span style={{ fontSize: 16 }}>{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>

      {activeTab === 'home' && <HomeTab t={t} view={view} loyalty={loyalty} giftCards={giftCards} setTab={setTab} walletAvail={walletAvail} walletLoading={walletLoading} addToWallet={addToWallet} />}
      {activeTab === 'rewards' && <RewardsTab t={t} loyalty={loyalty} pointsEnabled={pointsEnabled} stampRewards={view.stampRewards} />}
      {activeTab === 'stamps' && <StampCardsTab t={t} cards={view.cards} />}
      {activeTab === 'history' && <HistoryTab t={t} loyalty={loyalty} />}
      {activeTab === 'cards' && <GiftCardsTab t={t} giftCards={giftCards} />}
      {/* Keyed on the profile: after a join the form starts again from the joined account's details. */}
      {activeTab === 'profile' && <ProfileTab key={customer?.id || 'me'} t={t} customer={customer} loyalty={loyalty} token={token} location={location} onRefresh={onRefresh} onLogout={onLogout} pointsEnabled={pointsEnabled} onProfileReply={onProfileReply} onSignInAgain={onSignInAgain} />}
    </>
  );
}

// ── Loyalty hero (21 Oct 2026) ───────────────────────────────────────────
// The top of the home page says, big and plain, what this company's loyalty is (stamps, points or
// both) with the member's stamps or points under it. It used to be a points block for everyone,
// so a stamps only company showed "0 loyalty points" (Peter, Coffee Boy). The member code and the
// end of the phone show for every member, so a member on a second account can see it and staff
// can find the same account in Back Office.
function LoyaltyHero({ t, view, loyalty, customer, onLogout }) {
  const first = firstNameOf(customer?.name);
  return (
    <div style={{
      background: `linear-gradient(135deg, ${t.accent}, ${t.accentHover})`,
      borderRadius: t.radius + 4, padding: '24px 18px', marginBottom: 20,
      color: t.accentText, textAlign: 'center',
    }}>
      {first && (
        <div style={{ fontSize: 16, fontWeight: 700, opacity: 0.9 }}>
          Welcome back, {first}
        </div>
      )}
      {view.collects && (
        <div style={{
          display: 'inline-block', marginTop: 10, padding: '7px 16px', borderRadius: 99,
          background: 'rgba(255,255,255,0.22)', border: `1px solid ${t.accentText}40`,
          fontSize: 15, fontWeight: 800,
        }}>
          You collect: {view.collects}
        </div>
      )}

      {view.showPoints && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 48, fontWeight: 900, lineHeight: 1 }}>
            {view.points.toLocaleString()}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.85, marginTop: 4 }}>
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
        </div>
      )}

      {view.showStamps && view.main && (
        <HeroStampCard t={t} card={view.main} compact={view.showPoints} />
      )}

      {view.mode === 'none' && (
        <div style={{ marginTop: 14, fontSize: 14, fontWeight: 600, opacity: 0.9 }}>
          There are no stamps or points to collect right now.
        </div>
      )}

      {view.identityLine && (
        <div style={{ fontSize: 12, marginTop: 16, opacity: 0.8, letterSpacing: '0.02em' }}>
          {view.identityLine}
        </div>
      )}
      <button onClick={onLogout} style={{
        background: 'none', border: 'none', color: 'inherit', opacity: 0.8,
        textDecoration: 'underline', fontSize: 12, marginTop: 4, cursor: 'pointer', padding: 4,
      }}>
        Not you? Sign out
      </button>
    </div>
  );
}

// The main stamp card inside the hero: the stamps as big dots, "4 of 10 stamps", what is left to
// go, and any reward ready to use. compact when points show above it.
function HeroStampCard({ t, card, compact = false }) {
  return (
    <div style={{
      marginTop: 16, padding: compact ? '12px 12px 14px' : '16px 12px 18px',
      borderRadius: t.radius, background: 'rgba(255,255,255,0.14)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{card.icon} {card.name}</div>
      <StampDots t={t} dots={card.dots} icon={card.icon} onAccent size={compact ? 26 : 32} />
      <div style={{ fontSize: compact ? 22 : 30, fontWeight: 900, marginTop: 12, lineHeight: 1.1 }}>
        {card.countText}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6, opacity: 0.92 }}>
        {card.toGoText}
      </div>
      {card.ready > 0 ? (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 12,
          background: '#ffffff', color: '#16191c', fontSize: 15, fontWeight: 800,
        }}>
          🎁 {card.readyText}. Ask at the till to use it.
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, opacity: 0.85 }}>
          {card.readyText}
        </div>
      )}
      {card.finished > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          {card.summaryText}
        </div>
      )}
    </div>
  );
}

// One dot per stamp, filled ones show the card's icon. onAccent: drawn on the hero's colour.
function StampDots({ t, dots, icon, onAccent = false, size = 30 }) {
  const filled = dots.filter(Boolean).length;
  return (
    <div role="img" aria-label={`${filled} of ${dots.length} stamps`} style={{
      display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 12,
    }}>
      {dots.map((on, i) => (
        <div key={i} style={{
          width: size, height: size, borderRadius: '50%', boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(size * 0.5), lineHeight: 1,
          background: on ? (onAccent ? '#ffffff' : `${t.accent}22`) : 'transparent',
          border: on
            ? `2px solid ${onAccent ? t.accentText : t.accent}`
            : `2px dashed ${onAccent ? `${t.accentText}80` : `${t.textMuted}60`}`,
        }}>
          {on ? icon : ''}
        </div>
      ))}
    </div>
  );
}

// ── Home Tab ─────────────────────────────────────────────────────────────
function HomeTab({ t, view, loyalty, giftCards, setTab, walletAvail, walletLoading, addToWallet }) {
  const giftActive = giftCards?.length || 0;
  const totalBalance = giftCards.reduce((s, c) => s + (c.balance || 0), 0);

  // Platform detection for showing relevant wallet button
  const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isAndroid = typeof navigator !== 'undefined' && /Android/.test(navigator.userAgent);
  const showApple = walletAvail.apple && (isIOS || (!isIOS && !isAndroid));
  const showGoogle = walletAvail.google && (isAndroid || (!isIOS && !isAndroid));

  // Tiles follow what the company runs (21 Oct 2026): no points tiles when points are off. Visits
  // is every visit at the company's sites, the same number Back Office shows.
  const rewardsTab = view.tabs.rewards ? 'rewards' : (view.tabs.stamps ? 'stamps' : null);
  const tiles = [];
  if (view.showPoints) tiles.push({ key: 'earned', label: 'Points earned', value: view.pointsEarned.toLocaleString(), icon: '📈' });
  if (loyalty && view.mode !== 'none') tiles.push({ key: 'ready', label: 'Rewards ready', value: view.rewardsReady, icon: '🎁', onClick: rewardsTab ? () => setTab(rewardsTab) : undefined });
  if (view.visits != null) tiles.push({ key: 'visits', label: 'Visits', value: view.visits, icon: '🏪' });
  tiles.push({ key: 'gift', label: 'Gift cards', value: giftActive, icon: '💳', onClick: () => setTab('cards') });
  const pointsRewards = view.showPoints ? (loyalty?.rewards_available || []) : [];

  return (
    <>
      {/* Add to Wallet */}
      {(showApple || showGoogle) && loyalty?.member_code && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          {showApple && (
            <button onClick={() => addToWallet('apple')} disabled={walletLoading}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '13px 16px', borderRadius: t.radius,
                background: '#000', color: '#fff', border: 'none',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'inherit', opacity: walletLoading ? 0.5 : 1,
              }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="1" y="3" width="18" height="14" rx="2.5" stroke="#fff" strokeWidth="1.3"/>
                <rect x="1" y="6" width="18" height="3" fill="#fff" opacity=".2"/>
                <circle cx="15" cy="13" r="1.5" fill="#fff" opacity=".5"/>
              </svg>
              Add to Apple Wallet
            </button>
          )}
          {showGoogle && (
            <button onClick={() => addToWallet('google')} disabled={walletLoading}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '13px 16px', borderRadius: t.radius,
                background: '#000', color: '#fff', border: 'none',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'inherit', opacity: walletLoading ? 0.5 : 1,
              }}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 1.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zm3.3 5.4L8.7 12l-2.4-2.4.9-.9 1.5 1.5 2.7-3.3.9.9z" fill="#fff"/>
              </svg>
              Add to Google Wallet
            </button>
          )}
        </div>
      )}

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: tiles.length === 3 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10, marginBottom: 16 }}>
        {tiles.map(tl => <StatCard key={tl.key} t={t} label={tl.label} value={tl.value} icon={tl.icon} onClick={tl.onClick} />)}
      </div>

      {/* Rewards ready to use: free items from finished stamp cards, and points rewards when points are on */}
      {view.rewardsReady > 0 && (
        <Card t={t} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Ready to use</div>
            {rewardsTab && (
              <button onClick={() => setTab(rewardsTab)} style={{ background:'none', border:'none', color: t.accent, fontSize: 12, fontWeight: 600, cursor:'pointer', padding: 0 }}>
                View all →
              </button>
            )}
          </div>
          {view.stampRewards.map(sr => (
            <div key={`s-${sr.program_id}`} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              borderTop: `1px solid ${t.border}`,
            }}>
              <span style={{ fontSize: 22 }}>🎟️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{sr.name}{sr.available > 1 ? ` ×${sr.available}` : ''}</div>
                <div style={{ fontSize: 12, color: t.textMuted }}>From a finished stamp card. Ask at the till to use it.</div>
              </div>
            </div>
          ))}
          {pointsRewards.slice(0, 3).map(r => (
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

      {/* Every other stamp card the company runs (the main one is in the header), at 0 stamps too */}
      {view.otherCards.length > 0 && (
        <Card t={t} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>More stamp cards</div>
            <button onClick={() => setTab('stamps')} style={{ background:'none', border:'none', color: t.accent, fontSize: 12, fontWeight: 600, cursor:'pointer', padding: 0 }}>
              View all →
            </button>
          </div>
          {view.otherCards.map(sc => (
            <div key={sc.id} style={{ padding: '12px 0 4px', borderTop: `1px solid ${t.border}`, marginTop: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{sc.icon} {sc.name}</div>
              <StampDots t={t} dots={sc.dots} icon={sc.icon} size={24} />
              <div style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>{sc.countText}</div>
              <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>{sc.toGoText}</div>
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
function RewardsTab({ t, loyalty, pointsEnabled = true, stampRewards: stampRewardsIn = null }) {
  if (!loyalty) return <Card t={t}><EmptyState icon="🎁" text="Loyalty not available yet" /></Card>;

  // Points rewards only when the company runs points (21 Oct 2026).
  const available = pointsEnabled ? (loyalty.rewards_available || []) : [];
  const all = pointsEnabled ? (loyalty.all_rewards || []) : [];
  const locked = all.filter(r => !available.find(a => a.id === r.id));
  const stampRewards = stampRewardsIn || loyalty.stamp_rewards || [];

  return (
    <>
      {stampRewards.length > 0 && (
        <>
          <SectionTitle t={t}>Earned rewards</SectionTitle>
          {stampRewards.map(sr => (
            <Card key={sr.program_id} t={t} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 26 }}>🎟️</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>
                    {sr.name}{sr.available > 1 ? ` ×${sr.available}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>
                    From a finished stamp card. Ask at the till to use it.
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </>
      )}

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

      {all.length === 0 && stampRewards.length === 0 && (
        <Card t={t}><EmptyState icon="🎁" text={pointsEnabled ? 'No rewards set up yet. Keep earning points!' : 'No rewards ready yet.'} /></Card>
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

// ── Stamp Cards Tab ─────────────────────────────────────────────────────
// cards: portalLoyaltyView's cards, in plain words (stamps, what is left, rewards ready and used).
function StampCardsTab({ t, cards }) {
  if (!cards || cards.length === 0) {
    return (
      <Card t={t}>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>☕</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No stamp cards</div>
          <div style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.5 }}>
            No stamp card programs are available right now. Check back soon!
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {cards.map(sc => (
        <StampCardVisual key={sc.id} t={t} card={sc} />
      ))}
    </div>
  );
}

function StampCardVisual({ t, card }) {
  const { icon, name, description, need, dots } = card;
  const cols = Math.min(need + 1, 6);

  return (
    <div style={{
      background: `linear-gradient(135deg, ${t.accent}18, ${t.accent}08)`,
      borderRadius: t.radius, padding: 18, border: `1px solid ${t.accent}30`,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 26 }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{name}</div>
          {description && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>{description}</div>}
        </div>
      </div>

      {/* Stamp grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6, marginBottom: 12,
      }}>
        {dots.map((filled, i) => (
          <div key={i} style={{
            aspectRatio: '1', borderRadius: t.radius - 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: filled ? `${t.accent}22` : `${t.textMuted}10`,
            border: filled ? `2px solid ${t.accent}` : `2px dashed ${t.textMuted}30`,
            fontSize: filled ? 16 : 11, fontWeight: 700,
            color: filled ? t.accent : `${t.textMuted}60`,
          }}>
            {filled ? icon : i + 1}
          </div>
        ))}
        {/* Reward slot */}
        <div style={{
          aspectRatio: '1', borderRadius: t.radius - 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${t.accent}10`, border: `2px solid ${t.accent}50`,
          flexDirection: 'column',
        }}>
          <span style={{ fontSize: 16 }}>🎁</span>
        </div>
      </div>

      {/* Progress in plain words (21 Oct 2026): the count big, then what is left */}
      <div style={{ fontSize: 20, fontWeight: 900 }}>{card.countText}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.textMuted, marginTop: 2 }}>{card.toGoText}</div>

      {/* Rewards: ready now, and (when a card was ever finished) how many cards and how many used.
          A bare "1x completed" read as a free drink still owed when it was already used. */}
      <div style={{
        marginTop: 10, padding: '8px 12px', borderRadius: t.radius - 4,
        background: card.ready > 0 ? `${t.accent}22` : `${t.accent}08`,
        border: card.ready > 0 ? `2px solid ${t.accent}` : `1px dashed ${t.accent}30`,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 14 }}>🎁</span>
        <span style={{ fontSize: 13, fontWeight: card.ready > 0 ? 800 : 600 }}>{card.readyText}</span>
      </div>
      {card.finished > 0 && (
        <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8 }}>
          {card.summaryText}
        </div>
      )}
    </div>
  );
}

// ── Gift Cards Tab ───────────────────────────────────────────────────────
function GiftCardsTab({ t, giftCards }) {
  const [copiedId, setCopiedId] = useState(null);

  const copyCode = (gc) => {
    const code = gc.code || gc.last4 || '';
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(gc.id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(() => {});
  };

  if (!giftCards || giftCards.length === 0) {
    return <Card t={t}><EmptyState icon="💳" text="No active gift cards linked to your account" /></Card>;
  }

  return (
    <>
      {giftCards.map((gc, i) => (
        <Card key={gc.id || i} t={t} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: gc.code ? 12 : 0 }}>
            <div>
              <div style={{ fontSize: 11, color: t.textMuted, fontWeight: 600, letterSpacing: '0.04em' }}>
                GIFT CARD
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

          {/* Full gift card code — visible for customer to use */}
          {gc.code && (
            <div
              onClick={() => copyCode(gc)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px', borderRadius: t.radius - 4,
                background: `${t.text}08`, border: `1px dashed ${t.border}`,
                cursor: 'pointer', userSelect: 'all',
              }}
            >
              <div>
                <div style={{ fontSize: 10, color: t.textDim, fontWeight: 600, letterSpacing: '0.04em', marginBottom: 4 }}>
                  CARD CODE
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: 'monospace', letterSpacing: '0.12em' }}>
                  {gc.code}
                </div>
              </div>
              <div style={{
                fontSize: 11, fontWeight: 700, padding: '6px 12px', borderRadius: 99,
                background: copiedId === gc.id ? `${t.accent}20` : `${t.text}10`,
                color: copiedId === gc.id ? t.accent : t.textMuted,
                transition: 'all 0.2s',
              }}>
                {copiedId === gc.id ? 'Copied!' : 'Copy'}
              </div>
            </div>
          )}
          {/* Fallback: show last 4 if no full code */}
          {!gc.code && gc.last4 && (
            <div style={{
              padding: '10px 14px', borderRadius: t.radius - 4,
              background: `${t.text}08`, marginTop: 0,
              fontSize: 13, color: t.textMuted, fontFamily: 'monospace',
            }}>
              Card ending ····{gc.last4}
            </div>
          )}
        </Card>
      ))}
    </>
  );
}

// ── Profile Tab ──────────────────────────────────────────────────────────
function ProfileTab({ t, customer, loyalty, token, location, onRefresh, onLogout, pointsEnabled = true, onProfileReply, onSignInAgain }) {
  // Split stored name into first/last for editing
  const nameParts = (customer?.name || '').split(' ');
  const [firstName, setFirstName] = useState(nameParts[0] || '');
  const [lastName, setLastName] = useState(nameParts.slice(1).join(' ') || '');
  const [email, setEmail] = useState(customer?.email || '');
  const [birthday, setBirthday] = useState(customer?.birthday || '');
  const [marketingOptIn, setMarketingOptIn] = useState(customer?.marketing_opt_in || false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [emailNote, setEmailNote] = useState('');

  const saveProfile = async () => {
    setSaving(true);
    setSaved(false);
    setEmailNote('');
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      const reply = await callPortal({
        action: 'update_profile',
        token,
        phone: customer?.phone || '_',
        company_id: location.company_id,
        location_id: location.ops_location_id || location.id,
        name: fullName,
        email: email.trim(),
        birthday: birthday || null,
        marketing_opt_in: marketingOptIn,
      });
      // Joined with the member's imported account: the parent takes the new session and shows
      // the joined account (this form remounts on it). Otherwise say why an email stayed off.
      const r = onProfileReply ? onProfileReply(reply, false) : readProfileReply(reply);
      if (r.joined) return;
      if (!r.emailSaved) setEmailNote(r.notice);
      setSaved(true);
      onRefresh();
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      if (isSignInAgain(e) && onSignInAgain) { onSignInAgain(e.message); return; }
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card t={t} style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Your details</div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FieldLabel t={t}>First name</FieldLabel>
            <input
              type="text"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              placeholder="First name"
              style={inputStyle(t)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <FieldLabel t={t}>Last name</FieldLabel>
            <input
              type="text"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              placeholder="Last name"
              style={inputStyle(t)}
            />
          </div>
        </div>

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
          Verified via SMS — cannot be changed
        </div>

        <FieldLabel t={t} style={{ marginTop: 14 }}>Date of birth</FieldLabel>
        <input
          type="date"
          value={birthday}
          onChange={e => setBirthday(e.target.value)}
          style={{ ...inputStyle(t), colorScheme: t.isDark ? 'dark' : 'light' /* v5.5.897: real flag, not a bg sniff */ }}
        />

        {/* Marketing opt-in */}
        <div
          onClick={() => setMarketingOptIn(!marketingOptIn)}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 16,
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          <div style={{
            width: 20, height: 20, borderRadius: 5, flexShrink: 0, marginTop: 1,
            border: `2px solid ${marketingOptIn ? t.accent : t.border}`,
            background: marketingOptIn ? t.accent : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.2s',
          }}>
            {marketingOptIn && <span style={{ color: t.accentText, fontSize: 12, fontWeight: 700 }}>✓</span>}
          </div>
          <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>
            Receive offers, rewards, and news
          </div>
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
        {emailNote && (
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 10, lineHeight: 1.5 }}>{emailNote}</div>
        )}
      </Card>

      {/* Membership info */}
      {loyalty && (
        <Card t={t} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Membership</div>
          <InfoRow t={t} label="Member code" value={loyalty.member_code} />
          <InfoRow t={t} label="Joined" value={loyalty.enrolled_at ? new Date(loyalty.enrolled_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'} />
          {pointsEnabled && <InfoRow t={t} label="Points balance" value={(loyalty.points_balance || 0).toLocaleString()} />}
          {pointsEnabled && <InfoRow t={t} label="Total earned" value={(loyalty.points_earned_total || 0).toLocaleString()} />}
          {pointsEnabled && <InfoRow t={t} label="Total redeemed" value={(loyalty.points_redeemed_total || 0).toLocaleString()} />}
          {pointsEnabled && loyalty.tier && <InfoRow t={t} label="Tier" value={`${loyalty.tier.icon || '⭐'} ${loyalty.tier.name}`} />}
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

// A note after a profile save (27 Sep 2026): the account was joined with the member's imported
// one, or why an email stayed off it. Dismissed with the cross.
function NoticeCard({ t, text, onClose }) {
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16,
      background: t.card, border: `1px solid ${t.accent}`, borderRadius: t.radius,
      padding: '14px 16px', fontSize: 13, lineHeight: 1.5, color: t.text,
    }}>
      <div style={{ flex: 1 }}>{text}</div>
      <button onClick={onClose} aria-label="Close" style={{
        border: 'none', background: 'transparent', color: t.textMuted,
        fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: 2,
      }}>×</button>
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
