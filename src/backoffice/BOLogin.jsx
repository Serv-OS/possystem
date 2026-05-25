import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

export default function BOLogin({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message); setLoading(false); }
    else onLogin(data.user);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      background: '#0f1117',
      fontFamily: 'inherit',
    }}>
      {/* Left panel — branding */}
      <div style={{
        width: 420, flexShrink: 0,
        background: 'linear-gradient(160deg, #1a1d2e 0%, #12141e 100%)',
        borderRight: '1px solid #2d3148',
        display: 'flex', flexDirection: 'column',
        padding: '48px 40px',
      }}>
        {/* Logo */}
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

        {/* Mode switcher */}
        <button
          onClick={() => { localStorage.removeItem('rpos-device-mode'); window.location.href = '/'; }}
          style={{ background: 'none', border: '1px solid #2d3148', borderRadius: 8, padding: '8px 14px', color: '#475569', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          ← Change device mode
        </button>

        <div style={{ marginTop: 12, fontSize: 11, color: '#334155', fontFamily: 'monospace' }}>v{VERSION}</div>
      </div>

      {/* Right panel — login form */}
      <div style={{
        flex: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 40,
      }}>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ marginBottom: 40 }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#f1f5f9', marginBottom: 8 }}>
              Sign in
            </div>
            <div style={{ fontSize: 14, color: '#64748b' }}>
              Enter your credentials to access the back office
            </div>
          </div>

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Email */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@restaurant.com"
                required
                autoFocus
                style={{
                  width: '100%', padding: '13px 16px', borderRadius: 10,
                  border: '1.5px solid #2d3148',
                  background: '#1a1d27', color: '#f1f5f9',
                  fontSize: 15, outline: 'none', boxSizing: 'border-box',
                  transition: 'border-color .15s',
                }}
                onFocus={e => e.target.style.borderColor = '#6366f1'}
                onBlur={e => e.target.style.borderColor = '#2d3148'}
              />
            </div>

            {/* Password */}
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={{
                    width: '100%', padding: '13px 48px 13px 16px', borderRadius: 10,
                    border: '1.5px solid #2d3148',
                    background: '#1a1d27', color: '#f1f5f9',
                    fontSize: 15, outline: 'none', boxSizing: 'border-box',
                    transition: 'border-color .15s',
                  }}
                  onFocus={e => e.target.style.borderColor = '#6366f1'}
                  onBlur={e => e.target.style.borderColor = '#2d3148'}
                />
                <button type="button" onClick={() => setShowPass(p => !p)}
                  style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 16, padding: 0 }}>
                  {showPass ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            {/* Remember me */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 18, height: 18, borderRadius: 5, border: '1.5px solid #6366f1',
                background: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}>
                <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>
              </div>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>Keep me logged in</span>
            </div>

            {/* Error */}
            {error && (
              <div style={{
                padding: '12px 16px', borderRadius: 10,
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
                color: '#f87171', fontSize: 13,
              }}>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !email || !password}
              style={{
                width: '100%', padding: '14px',
                borderRadius: 10, border: 'none',
                background: loading || !email || !password
                  ? '#1e2235'
                  : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                color: loading || !email || !password ? '#475569' : '#fff',
                fontWeight: 700, fontSize: 15, cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', marginTop: 4,
                boxShadow: !loading && email && password ? '0 4px 20px rgba(99,102,241,0.3)' : 'none',
                transition: 'all .2s',
              }}
            >
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>

          <div style={{ marginTop: 32, padding: '16px', borderRadius: 10, background: '#1a1d27', border: '1px solid #2d3148', fontSize: 13, color: '#64748b' }}>
            <strong style={{ color: '#94a3b8' }}>Staff?</strong> Staff log in on the POS terminal using their 4-digit PIN — not this screen.
          </div>
        </div>
      </div>
    </div>
  );
}
