import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

// v5.5.343: self-service password reset for back-office + admin users.
//   - "Forgot password?" → sends a Supabase reset email (resetPasswordForEmail).
//   - Clicking the email link returns here; the app detects PASSWORD_RECOVERY
//     and renders this component with recovery=true → set-a-new-password form.
export default function BOLogin({ onLogin, recovery = false, onResetDone }) {
  const [mode, setMode] = useState('login'); // 'login' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showPass, setShowPass] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message); setLoading(false); }
    else onLogin(data.user);
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email address first'); return; }
    setLoading(true); setError(''); setInfo('');
    const redirectTo = window.location.href.split('#')[0];
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setLoading(false);
    if (err && /rate|limit|seconds/i.test(err.message)) {
      setError('Too many requests — wait a moment and try again.');
      return;
    }
    if (err) console.warn('[BOLogin] resetPasswordForEmail:', err.message);
    // Neutral message either way — never reveal whether an account exists.
    setInfo(`If an account exists for ${email.trim()}, a password-reset link is on its way. Check your inbox (and spam).`);
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (newPass.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (newPass !== confirmPass) { setError('Passwords do not match'); return; }
    setLoading(true); setError(''); setInfo('');
    const { error: err } = await supabase.auth.updateUser({ password: newPass });
    setLoading(false);
    if (err) { setError(err.message); return; }
    setInfo('Password updated ✓ — signing you out so you can log in with your new password…');
    setTimeout(() => { supabase.auth.signOut().finally(() => { onResetDone ? onResetDone() : window.location.reload(); }); }, 1600);
  };

  const inputStyle = {
    width: '100%', padding: '13px 16px', borderRadius: 10,
    border: '1.5px solid #2d3148', background: '#1a1d27', color: '#f1f5f9',
    fontSize: 15, outline: 'none', boxSizing: 'border-box', transition: 'border-color .15s',
  };
  const onFocus = e => e.target.style.borderColor = '#6366f1';
  const onBlur  = e => e.target.style.borderColor = '#2d3148';
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 };
  const btnStyle = (disabled) => ({
    width: '100%', padding: '14px', borderRadius: 10, border: 'none',
    background: disabled ? '#1e2235' : 'linear-gradient(135deg, #6366f1, #4f46e5)',
    color: disabled ? '#475569' : '#fff', fontWeight: 700, fontSize: 15,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: 4,
    boxShadow: !disabled ? '0 4px 20px rgba(99,102,241,0.3)' : 'none', transition: 'all .2s',
  });
  const linkStyle = { background: 'none', border: 'none', color: '#6366f1', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 0 };
  const ErrorBox = () => error ? (
    <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171', fontSize: 13 }}>{error}</div>
  ) : null;
  const InfoBox = () => info ? (
    <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#4ade80', fontSize: 13, lineHeight: 1.5 }}>{info}</div>
  ) : null;

  // ── Right-panel content by mode ────────────────────────────────────────────
  let heading, sub, body;

  if (recovery) {
    heading = 'Set a new password';
    sub = 'Choose a new password for your account.';
    body = (
      <form onSubmit={handleReset} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>New password</label>
          <div style={{ position: 'relative' }}>
            <input type={showPass ? 'text' : 'password'} value={newPass} onChange={e => setNewPass(e.target.value)}
              placeholder="At least 8 characters" required autoFocus
              style={{ ...inputStyle, paddingRight: 48 }} onFocus={onFocus} onBlur={onBlur} />
            <button type="button" onClick={() => setShowPass(p => !p)}
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 16, padding: 0 }}>
              {showPass ? '🙈' : '👁'}
            </button>
          </div>
        </div>
        <div>
          <label style={labelStyle}>Confirm new password</label>
          <input type={showPass ? 'text' : 'password'} value={confirmPass} onChange={e => setConfirmPass(e.target.value)}
            placeholder="Re-enter password" required style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
        </div>
        <ErrorBox />
        <InfoBox />
        <button type="submit" disabled={loading || !newPass || !confirmPass} style={btnStyle(loading || !newPass || !confirmPass)}>
          {loading ? 'Updating…' : 'Update password →'}
        </button>
      </form>
    );
  } else if (mode === 'forgot') {
    heading = 'Reset your password';
    sub = "Enter your email and we'll send you a reset link.";
    body = (
      <form onSubmit={handleForgot} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Email address</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@restaurant.com" required autoFocus style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
        </div>
        <ErrorBox />
        <InfoBox />
        <button type="submit" disabled={loading || !email} style={btnStyle(loading || !email)}>
          {loading ? 'Sending…' : 'Send reset link →'}
        </button>
        <button type="button" onClick={() => { setMode('login'); setError(''); setInfo(''); }} style={{ ...linkStyle, alignSelf: 'center', marginTop: 4 }}>
          ← Back to sign in
        </button>
      </form>
    );
  } else {
    heading = 'Sign in';
    sub = 'Enter your credentials to access the back office';
    body = (
      <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Email address</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@restaurant.com" required autoFocus style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label style={labelStyle}>Password</label>
            <button type="button" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }} style={{ ...linkStyle, marginBottom: 8 }}>
              Forgot password?
            </button>
          </div>
          <div style={{ position: 'relative' }}>
            <input type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required style={{ ...inputStyle, paddingRight: 48 }} onFocus={onFocus} onBlur={onBlur} />
            <button type="button" onClick={() => setShowPass(p => !p)}
              style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 16, padding: 0 }}>
              {showPass ? '🙈' : '👁'}
            </button>
          </div>
        </div>
        <ErrorBox />
        <button type="submit" disabled={loading || !email || !password} style={btnStyle(loading || !email || !password)}>
          {loading ? 'Signing in…' : 'Sign in →'}
        </button>
      </form>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: '#0f1117', fontFamily: 'inherit' }}>
      {/* Left panel — branding */}
      <div style={{
        width: 420, flexShrink: 0,
        background: 'linear-gradient(160deg, #1a1d2e 0%, #12141e 100%)',
        borderRight: '1px solid #2d3148', display: 'flex', flexDirection: 'column', padding: '48px 40px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'auto' }}>
          <ServOSIcon size={44} />
          <div>
            <ServOSWordmark fontSize={20} color="#f1f5f9" />
            <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>Back Office</div>
          </div>
        </div>

        <div style={{ marginBottom: 'auto', paddingTop: 80 }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: '#f1f5f9', lineHeight: 1.2, marginBottom: 16 }}>
            Manage your venue from anywhere
          </div>
          <div style={{ fontSize: 15, color: '#64748b', lineHeight: 1.7 }}>
            Menus, staff, floor plans, reports and device management — all in one place.
          </div>
          <div style={{ marginTop: 48, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {['📋 Menu builder & pricing', '👥 Staff & access control', '📱 Device pairing', '📊 Reports & end of day'].map(f => (
              <div key={f} style={{ fontSize: 14, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>

        <button onClick={() => { localStorage.removeItem('rpos-device-mode'); window.location.href = '/'; }}
          style={{ background: 'none', border: '1px solid #2d3148', borderRadius: 8, padding: '8px 14px', color: '#475569', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          ← Change device mode
        </button>
        <div style={{ marginTop: 12, fontSize: 11, color: '#334155', fontFamily: 'monospace' }}>v{VERSION}</div>
      </div>

      {/* Right panel — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ marginBottom: 40 }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#f1f5f9', marginBottom: 8 }}>{heading}</div>
            <div style={{ fontSize: 14, color: '#64748b' }}>{sub}</div>
          </div>
          {body}
          {!recovery && mode === 'login' && (
            <div style={{ marginTop: 32, padding: '16px', borderRadius: 10, background: '#1a1d27', border: '1px solid #2d3148', fontSize: 13, color: '#64748b' }}>
              <strong style={{ color: '#94a3b8' }}>Staff?</strong> Staff log in on the POS terminal using their 4-digit PIN — not this screen.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
