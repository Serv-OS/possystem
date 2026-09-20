import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/secondStep/rules';
import { noteWeakPassword, clearWeakPasswordNote } from '../lib/secondStep/client';
import {
  AuthFrame, Heading, Stack, PrimaryButton, LinkButton, Note, TextInput, MonoLabel,
} from '../components/secondStep/AuthUi';
import { tokens } from '../components/secondStep/authTokens';

// v5.5.343: self-service password reset for back-office + admin users.
//   - "Forgot password?" sends a Supabase reset email (resetPasswordForEmail).
//   - Clicking the email link returns here; the app detects PASSWORD_RECOVERY and renders
//     this component with recovery=true (a set-a-new-password form). Since the second sign in
//     step (docs/SECOND_STEP.md) the app first asks a login that HAS a second step to pass it:
//     a reset link alone must never be enough to take over an account.
// Brand v2 look shared with the second step screens (components/secondStep/AuthUi.jsx).
export default function BOLogin({ onLogin, recovery = false, onResetDone, area = 'Back Office' }) {
  const tone = 'dark';
  const t = tokens(tone);
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
    const { data, error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) { setError(err.message); setLoading(false); return; }
    // Supabase flags a password that is now too short or appears in a known leak. The Back
    // Office asks them to change it once they are through the second step.
    noteWeakPassword(data?.weakPassword);
    onLogin(data.user);
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email address first'); return; }
    setLoading(true); setError(''); setInfo('');
    const redirectTo = window.location.href.split('#')[0];
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setLoading(false);
    if (err && /rate|limit|seconds/i.test(err.message)) {
      setError('Too many requests. Wait a moment and try again.');
      return;
    }
    if (err) console.warn('[BOLogin] resetPasswordForEmail:', err.message);
    // Neutral message either way: never reveal whether an account exists.
    setInfo(`If an account exists for ${email.trim()}, a password reset link is on its way. Check your inbox (and spam).`);
  };

  const handleReset = async (e) => {
    e.preventDefault();
    const problem = passwordProblem(newPass, confirmPass);
    if (problem) { setError(problem); return; }
    setLoading(true); setError(''); setInfo('');
    const { error: err } = await supabase.auth.updateUser({ password: newPass });
    setLoading(false);
    if (err) { setError(err.message); return; }
    clearWeakPasswordNote();
    setInfo('Password updated. Signing you out so you can sign in with your new password…');
    // Global sign out (the default), as before: a new password ends every other session too.
    setTimeout(() => { supabase.auth.signOut().finally(() => { onResetDone ? onResetDone() : window.location.reload(); }); }, 1600);
  };

  const showToggle = (
    <div style={{ textAlign: 'right', marginTop: -6 }}>
      <LinkButton tone={tone} onClick={() => setShowPass((p) => !p)} style={{ fontSize: 13.5 }}>
        {showPass ? 'Hide password' : 'Show password'}
      </LinkButton>
    </div>
  );

  let body;
  if (recovery) {
    body = (
      <form onSubmit={handleReset}>
        <Stack>
          <Heading tone={tone} title="Set a new password" sub={`Choose a new password for your account. At least ${MIN_PASSWORD_LENGTH} characters: a short sentence is easy to remember and hard to guess.`} />
          <TextInput tone={tone} label="New password" type={showPass ? 'text' : 'password'} value={newPass} onChange={setNewPass}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} autoComplete="new-password" autoFocus testId="bo-new-password" />
          <TextInput tone={tone} label="Confirm new password" type={showPass ? 'text' : 'password'} value={confirmPass} onChange={setConfirmPass}
            placeholder="Type it again" autoComplete="new-password" testId="bo-confirm-password" />
          {showToggle}
          <Note tone={tone} kind="error">{error}</Note>
          <Note tone={tone}>{info}</Note>
          <PrimaryButton tone={tone} type="submit" busy={loading} disabled={!newPass || !confirmPass}>Update password</PrimaryButton>
        </Stack>
      </form>
    );
  } else if (mode === 'forgot') {
    body = (
      <form onSubmit={handleForgot}>
        <Stack>
          <Heading tone={tone} title="Reset your password" sub="Enter your email and we will send you a reset link." />
          <TextInput tone={tone} label="Email address" type="email" value={email} onChange={setEmail}
            placeholder="you@restaurant.com" autoComplete="email" autoFocus />
          <Note tone={tone} kind="error">{error}</Note>
          <Note tone={tone}>{info}</Note>
          <PrimaryButton tone={tone} type="submit" busy={loading} disabled={!email}>Send reset link</PrimaryButton>
          <div style={{ textAlign: 'center' }}>
            <LinkButton tone={tone} onClick={() => { setMode('login'); setError(''); setInfo(''); }}>Back to sign in</LinkButton>
          </div>
        </Stack>
      </form>
    );
  } else {
    body = (
      <form onSubmit={handleLogin}>
        <Stack>
          <Heading tone={tone} title="Sign in" sub={`Sign in to the ${area}. After your password you will confirm it is you with Face ID, fingerprint or a code from your phone.`} />
          <TextInput tone={tone} label="Email address" type="email" value={email} onChange={setEmail}
            placeholder="you@restaurant.com" autoComplete="username" autoFocus testId="bo-email" />
          <TextInput tone={tone} label="Password" type={showPass ? 'text' : 'password'} value={password} onChange={setPassword}
            placeholder="Your password" autoComplete="current-password" testId="bo-password" />
          {showToggle}
          <Note tone={tone} kind="error" testId="bo-login-error">{error}</Note>
          <PrimaryButton tone={tone} type="submit" busy={loading} disabled={!email || !password} testId="bo-sign-in">Sign in</PrimaryButton>
          <div style={{ textAlign: 'center' }}>
            <LinkButton tone={tone} onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}>Forgot password?</LinkButton>
          </div>
          <div style={{ marginTop: 10, padding: 14, borderRadius: 12, background: t.panel, border: `1px solid ${t.line}`, fontSize: 14, color: t.sub, lineHeight: 1.55 }}>
            <strong style={{ color: t.text }}>Staff?</strong> Staff sign in on the till with their 4 digit PIN, not on this screen.
          </div>
        </Stack>
      </form>
    );
  }

  const footer = (
    <div>
      <button onClick={() => { localStorage.removeItem('rpos-device-mode'); window.location.href = '/'; }}
        style={{ background: 'none', border: `1px solid ${t.line}`, borderRadius: 10, padding: '9px 14px', color: t.sub, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
        Change device mode
      </button>
      <MonoLabel tone={tone} style={{ marginTop: 14, fontSize: 10.5, textTransform: 'none' }}>v{VERSION}</MonoLabel>
    </div>
  );

  return (
    <AuthFrame tone={tone} area={area} footer={footer}>
      {body}
    </AuthFrame>
  );
}
