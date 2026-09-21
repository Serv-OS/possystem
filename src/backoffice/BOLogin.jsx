import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/secondStep/rules';
import { noteWeakPassword, clearWeakPasswordNote, createSecondStepClient } from '../lib/secondStep/client';
import { signInPlan, wrongHostMessage, passkeyPrompt, explainPasskeyError } from '../lib/secondStep/passkeyRules';
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
/**
 * PASSKEY SIGN IN (20 Sep 2026): the big button. The password is the fallback, for a device
 * with no fingerprint or face, for our own apps, and for anybody who has not set one up yet.
 * A passkey only works on app.serv-os.app (lib/secondStep/passkeyRules.js says why).
 */
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
  // Why they are looking at this screen, when the Back Office signed itself out
  // after sitting untouched (21 Sep 2026). Read ONCE and cleared, so it never
  // greets somebody who simply signed out.
  const [idleNote] = useState(() => {
    try {
      const n = sessionStorage.getItem('rpos-bo-idle-note');
      if (n) sessionStorage.removeItem('rpos-bo-idle-note');
      return n || '';
    } catch { return ''; }
  });
  const [info, setInfo] = useState('');
  const [showPass, setShowPass] = useState(false);
  // PASSKEY SIGN IN (20 Sep 2026). The screen asks the device what it can do, then offers the
  // passkey first and keeps the password underneath. Nothing here decides who gets in: the auth
  // server does, and the database fence proves the passkey from the session itself.
  const [pk, setPk] = useState({ ready: false, canUse: false, primary: 'password' });
  const [pkBusy, setPkBusy] = useState(false);
  const stepClient = createSecondStepClient(supabase, { allowLocalhost: !!import.meta.env?.DEV });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const can = await stepClient.canUsePasskey();
        const plan = signInPlan({
          hostname: window.location.hostname,
          supported: !!can.usable,
          allowLocalhost: !!import.meta.env?.DEV,
        });
        if (alive) setPk({ ready: true, canUse: plan.canUsePasskey, primary: plan.primary });
      } catch { if (alive) setPk({ ready: true, canUse: false, primary: 'password' }); }
    })();
    return () => { alive = false; };
    // once per mount: the device does not change under us
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePasskey = async () => {
    if (pkBusy) return;
    setPkBusy(true); setError(''); setInfo('');
    try {
      const { user } = await stepClient.signInWithPasskey();
      onLogin(user);
    } catch (e) {
      setError(explainPasskeyError(e));
    } finally { setPkBusy(false); }
  };

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
          <Heading
            tone={tone}
            title="Sign in"
            sub={pk.canUse
              ? `Sign in to the ${area} with ${passkeyPrompt(navigator.userAgent)}. No password to remember, and nobody can use it but you.`
              : `Sign in to the ${area}. After your password you will set up, or use, your second step.`}
          />
          {pk.canUse && (
            <>
              <PrimaryButton tone={tone} busy={pkBusy} onClick={handlePasskey} testId="bo-passkey">
                Sign in with a passkey
              </PrimaryButton>
              <div style={{ textAlign: 'center', fontSize: 13, color: t.sub, margin: '2px 0 6px' }}>or use your password</div>
            </>
          )}
          {pk.ready && pk.primary === 'wrong_host' && (
            <Note tone={tone} kind="warn" testId="bo-passkey-host">{wrongHostMessage(window.location.hostname)}</Note>
          )}
          <TextInput tone={tone} label="Email address" type="email" value={email} onChange={setEmail}
            placeholder="you@restaurant.com" autoComplete="username" autoFocus testId="bo-email" />
          <TextInput tone={tone} label="Password" type={showPass ? 'text' : 'password'} value={password} onChange={setPassword}
            placeholder="Your password" autoComplete="current-password" testId="bo-password" />
          {showToggle}
          {idleNote && !error && <Note tone={tone} kind="info" testId="bo-login-idle">{idleNote}</Note>}
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
