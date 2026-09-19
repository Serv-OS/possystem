// src/components/secondStep/AuthenticatorSetup.jsx
//
// Set up an authenticator app: scan the QR code (or type the secret), then type the code
// the app shows. Used at sign in (the compulsory backup) and on the Sign in security page
// (a new phone). docs/SECOND_STEP.md.

import { useEffect, useRef, useState } from 'react';
import { Stack, Note, PrimaryButton, CodeInput, MonoLabel, LinkButton } from './AuthUi';
import { tokens } from './authTokens';
import { explainError, formatSecret, isCodeComplete } from '../../lib/secondStep/rules';

export default function AuthenticatorSetup({ client, tone = 'dark', onDone, compact = false }) {
  const t = tokens(tone);
  const [started, setStarted] = useState(null); // { factorId, secret, uri, qr }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const startedOnce = useRef(false);

  const start = async () => {
    setErr(''); setBusy(true);
    try { setStarted(await client.startAuthenticatorApp()); setCode(''); }
    catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (startedOnce.current) return;
    startedOnce.current = true;
    start();
    // start once on mount; the button below restarts it
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async (value) => {
    const c = value ?? code;
    if (!started || !isCodeComplete(c) || busy) return;
    setErr(''); setBusy(true);
    try {
      await client.verifyCode(started.factorId, c);
      onDone?.();
    } catch (e) {
      setErr(explainError(e));
      setCode('');
    } finally { setBusy(false); }
  };

  const copySecret = async () => {
    try { await navigator.clipboard.writeText(started?.secret || ''); setCopied(true); } catch { setShowSecret(true); }
  };

  return (
    <Stack gap={16}>
      {!compact && (
        <ol style={{ margin: 0, paddingLeft: 20, color: t.sub, fontSize: 15, lineHeight: 1.7 }}>
          <li>Install an <strong style={{ color: t.text }}>authenticator app</strong> on your phone: Google Authenticator, Microsoft Authenticator or 1Password.</li>
          <li>In the app, tap <strong style={{ color: t.text }}>add</strong> and <strong style={{ color: t.text }}>scan</strong> this code.</li>
          <li>Type the <strong style={{ color: t.text }}>6 digit code</strong> the app shows.</li>
        </ol>
      )}

      {!started && !err && <Note tone={tone}>Getting your code ready…</Note>}

      {started && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ background: t.qrBg, padding: 10, borderRadius: 14, lineHeight: 0 }}>
            {started.qr
              ? <img src={started.qr} alt="QR code for your authenticator app" width={176} height={176} data-testid="second-step-qr" />
              : <div style={{ width: 176, height: 176 }} />}
          </div>
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <MonoLabel tone={tone} style={{ marginBottom: 6 }}>Cannot scan?</MonoLabel>
            <div style={{ fontSize: 14, color: t.sub, lineHeight: 1.55 }}>Type this key into the app instead (time based).</div>
            {showSecret || copied ? (
              <div data-testid="second-step-secret" style={{
                marginTop: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: t.text,
                wordBreak: 'normal', overflowWrap: 'break-word', letterSpacing: '0.04em', lineHeight: 1.6, userSelect: 'all',
              }}>{formatSecret(started.secret)}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {!showSecret && <LinkButton tone={tone} onClick={() => setShowSecret(true)} testId="second-step-show-secret">Show the key</LinkButton>}
              <LinkButton tone={tone} onClick={copySecret}>{copied ? 'Copied' : 'Copy the key'}</LinkButton>
            </div>
          </div>
        </div>
      )}

      {started && (
        <CodeInput tone={tone} value={code} onChange={setCode} onDone={(v) => check(v)} autoFocus={!compact} />
      )}
      <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
      {started ? (
        <PrimaryButton tone={tone} busy={busy} disabled={!isCodeComplete(code)} onClick={() => check()} testId="second-step-code-submit">
          Check code
        </PrimaryButton>
      ) : (
        err && <PrimaryButton tone={tone} busy={busy} onClick={start}>Try again</PrimaryButton>
      )}
    </Stack>
  );
}
