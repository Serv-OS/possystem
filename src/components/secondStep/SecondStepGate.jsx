// src/components/secondStep/SecondStepGate.jsx
//
// THE SECOND SIGN IN STEP SCREEN (docs/SECOND_STEP.md). Shown after the password on every
// real login surface: Back Office, the admin portal and the Owner app. It cannot be skipped:
// onPassed is only called when the auth server says this sign in is "aal2" (Face ID,
// fingerprint or an authenticator app code), or when Peter's break glass (app_gate false) is on.
//
//   checking   reads the session and the login's second steps
//   challenge  Face ID or fingerprint first where this place supports it, else the 6 digit code
//   prove      no second step yet AND the server wants the email proved first (fix round, 20 Sep
//              2026): a code we email to the address on the account. A password on its own must
//              never be enough to SET a second step up, or a thief with the password of a login
//              nobody uses becomes that person for good. The auth server enforces it too
//              (public.second_step_mfa_hook), so this screen is the way through it, not the lock.
//   setup      no second step yet: authenticator app first (the backup that works everywhere),
//              then Face ID or fingerprint is offered where it works
//   backup     passed with Face ID only: add the authenticator app before going in
//   faceid     offer Face ID or fingerprint after a first set up ("Not now" allowed)
//   ended      the sign in is gone (expired or signed out elsewhere)
//
// mode 'recovery' (password reset link): only a login that HAS a second step passes it
// before choosing a new password; nothing is set up in the middle of a reset.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  gateStep, passesWithoutNetwork, challengePlan, explainError, hasVerified, isCodeComplete,
  sessionProvesSecondStep,
} from '../../lib/secondStep/rules';
import { createSecondStepClient, detectFaceId, rememberedFaceIdFactor } from '../../lib/secondStep/client';
import {
  AuthFrame, Heading, Stack, PrimaryButton, SecondaryButton, LinkButton, Note, CodeInput, FaceIdIcon,
} from './AuthUi';
import { tokens } from './authTokens';
import AuthenticatorSetup from './AuthenticatorSetup';
import { secondStepPlan, suggestPasskeyName, passkeyPrompt, explainPasskeyError } from '../../lib/secondStep/passkeyRules';

const ALLOW_LOCALHOST = !!import.meta.env?.DEV;

export default function SecondStepGate({
  supabase, mode = 'login', tone = 'dark', area = 'Back Office', frame = true, onPassed, onSignOut,
}) {
  const client = useMemo(() => createSecondStepClient(supabase, { allowLocalhost: ALLOW_LOCALHOST }), [supabase]);
  const [phase, setPhase] = useState('checking');
  const [factors, setFactors] = useState([]);
  const [face, setFace] = useState({ usable: false, reason: 'host', label: 'Face ID or fingerprint' });
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState({ sentTo: '', sent: false });
  const [passkeys, setPasskeys] = useState([]);
  const [canPasskey, setCanPasskey] = useState(false);
  const [optional, setOptional] = useState(false);   // the passkey screen after a set up: skippable

  // Fire once, through a ref (never re-run by a parent re-render: the v5.7.12 handoff trap).
  const passed = useRef(false);
  const onPassedRef = useRef(onPassed);
  useEffect(() => { onPassedRef.current = onPassed; }, [onPassed]);
  // upgraded: this gate really moved the session on (a code, a passkey, a new factor). When it
  // is false the gate simply stepped aside, because the session already proved itself or the
  // break glass is off, and the caller must NOT reload: on 20 Sep a password only session plus
  // app_gate = false reloaded, booted the same way, passed again and reloaded for ever, which
  // is the "Checking sign in" flashing Peter saw.
  const pass = useCallback((opts) => {
    if (passed.current) return;
    passed.current = true;
    onPassedRef.current?.({ upgraded: !!(opts && opts.upgraded) });
  }, []);

  const evaluate = useCallback(async ({ justSetUp = false } = {}) => {
    setErr('');
    // The screen says "checking" while this runs, so a second tap cannot re-send the same code
    // and see it refused as used (fix round, 20 Sep 2026).
    if (justSetUp) setPhase('checking');
    try {
      const session = await client.getSession();
      setEmail(session?.user?.email || '');
      if (mode === 'login' && !justSetUp && passesWithoutNetwork(session)) { pass(); return; }
      const [all, faceSupport] = await Promise.all([client.listFactors(), detectFaceId({ allowLocalhost: ALLOW_LOCALHOST })]);
      setFactors(all);
      setFace(faceSupport);
      let step = gateStep({ session, factors: all, mode });
      if (step === 'none') { setPhase('ended'); return; }
      if (step !== 'ok' && !(await client.appGate())) step = 'ok';
      if (step === 'ok') {
        // Just set up, and this device could hold a passkey: offer one, because it is the
        // better version of the Face ID factor we used to offer here (and Supabase refused
        // WebAuthn as an MFA factor on this project). They are already in, so it is optional.
        if (mode === 'login' && justSetUp && faceSupport.usable && !hasVerified(all, 'webauthn')) {
          const can = await client.canUsePasskey();
          if (can.usable) {
            const mine = await client.listPasskeys();
            if (mine.length === 0) { setCanPasskey(true); setPasskeys(mine); setOptional(true); setPhase('passkey'); return; }
          } else {
            setPhase('faceid');
            return;
          }
        }
        pass();
        return;
      }
      setUseCode(false);
      setCode('');
      // A FIRST set up. From 20 Sep 2026 the second step is a PASSKEY: the fingerprint, face or
      // Windows Hello on the device in front of them. The emailed code still comes first (a
      // stolen password must not be able to register the thief's own passkey), and the
      // authenticator app is left as the way through on a device that cannot make one.
      if (step === 'setup') {
        const [p, can, mine] = await Promise.all([
          client.emailProofStatus(), client.canUsePasskey(), client.listPasskeys(),
        ]);
        setProof((was) => ({ ...was, sentTo: p.sentTo || was.sentTo }));
        setCanPasskey(!!can.usable);
        setPasskeys(mine);
        const next = secondStepPlan({
          passkeys: mine, factors: all, canUsePasskey: !!can.usable,
          emailProved: p.proved, needsEmail: p.needs_email,
        });
        if (next === 'ok') { pass({ upgraded: justSetUp }); return; }
        if (next === 'prove_email') { setPhase('prove'); return; }
        if (next === 'register_passkey') { setPhase('passkey'); return; }
        // They already have a passkey and this device can use one: prove it now.
        // The session says "password" until they do, and that is what the
        // database reads (21 Sep 2026).
        if (next === 'use_passkey') { setPhase('use_passkey'); return; }
        setPhase('setup');   // app_code: no passkey maker here
        return;
      }
      setPhase(step);
    } catch (e) {
      setErr(explainError(e));
      setPhase('error');
    }
  }, [client, mode, pass]);

  useEffect(() => { evaluate(); }, [evaluate]);

  const plan = challengePlan({ factors, faceIdUsable: face.usable, preferredFaceIdFactorId: rememberedFaceIdFactor() });

  const doFaceId = async () => {
    if (!plan.faceIdFactorId || busy) return;
    setErr(''); setBusy(true);
    try { await client.useFaceId(plan.faceIdFactorId); await evaluate(); }
    catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };

  const doCode = async (value) => {
    const c = value ?? code;
    if (!isCodeComplete(c) || busy) return;
    setErr(''); setBusy(true);
    try { await client.verifyAnyCode(plan.codeFactorIds, c); await evaluate(); }
    catch (e) { setErr(explainError(e)); setCode(''); }
    finally { setBusy(false); }
  };

  const sendProof = async () => {
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      const r = await client.sendEmailCode();
      setProof({ sentTo: r.sentTo || proof.sentTo, sent: true });
      setCode('');
    } catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };

  const claimProof = async (value) => {
    const c = value ?? code;
    if (!isCodeComplete(c) || busy) return;
    setErr(''); setBusy(true);
    try { await client.claimEmailCode(c); setCode(''); setPhase(canPasskey ? 'passkey' : 'setup'); }
    catch (e) { setErr(explainError(e)); setCode(''); }
    finally { setBusy(false); }
  };

  const addPasskey = async () => {
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      await client.addPasskey({ name: suggestPasskeyName(navigator.userAgent) });
      // THE SESSION STILL SAYS "password". Registering a passkey does not change how this
      // session signed in, and the database reads the session, not the list of passkeys. So
      // sign in with the new passkey straight away: one more touch, and the token carries the
      // proof. If that does not work they are still set up, and their next sign in proves it.
      try {
        if (!sessionProvesSecondStep(await client.getSession())) await client.signInWithPasskey();
      } catch { /* set up either way: the next sign in is the passkey one */ }
      await evaluate({ justSetUp: true });
    } catch (e) { setErr(explainPasskeyError(e)); }
    finally { setBusy(false); }
  };

  // Sign in AGAIN with the passkey they already have, without leaving the page.
  // GoTrue hands back a fresh session whose token carries the proof, which is
  // the only thing the database looks at.
  const usePasskey = async () => {
    if (busy) return;
    setErr(''); setBusy(true);
    try {
      await client.signInWithPasskey();
      if (sessionProvesSecondStep(await client.getSession())) pass({ upgraded: true });
      else await evaluate({ justSetUp: true });
    } catch (e) { setErr(explainPasskeyError(e)); }
    finally { setBusy(false); }
  };

  const addFace = async () => {
    setErr(''); setBusy(true);
    try { await client.addFaceId({ email }); pass({ upgraded: true }); }
    catch (e) { setErr(explainError(e)); }
    finally { setBusy(false); }
  };

  const signOutButton = onSignOut ? (
    <div style={{ textAlign: 'center', marginTop: 6 }}>
      <LinkButton tone={tone} onClick={onSignOut} testId="second-step-sign-out">Sign out</LinkButton>
    </div>
  ) : null;

  let body;
  if (phase === 'checking') {
    body = <Heading tone={tone} title="Checking your sign in…" sub="One moment." />;
  } else if (phase === 'error') {
    body = (
      <Stack>
        <Heading tone={tone} title="We could not check your sign in" />
        <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
        <PrimaryButton tone={tone} onClick={() => { setPhase('checking'); evaluate(); }}>Try again</PrimaryButton>
        {signOutButton}
      </Stack>
    );
  } else if (phase === 'ended') {
    body = (
      <Stack>
        <Heading tone={tone} title="Your sign in has ended" sub="Please sign in again." />
        {onSignOut && <PrimaryButton tone={tone} onClick={onSignOut}>Sign in again</PrimaryButton>}
      </Stack>
    );
  } else if (phase === 'challenge') {
    const faceFirst = plan.primary === 'faceid' && !useCode;
    body = (
      <Stack>
        <Heading
          tone={tone}
          step={mode === 'recovery' ? 'Before you choose a new password' : 'Second step'}
          title={faceFirst ? `Use ${face.label}` : 'Enter your code'}
          sub={faceFirst
            ? 'Your password is right. Now confirm it is really you.'
            : plan.primary === 'faceid_elsewhere'
              ? `Your second step is ${face.label}, which cannot be used here. Sign in on your phone or computer browser at app.serv-os.app, then add an authenticator app in Settings, Sign in security. Or ask your owner or ServOS to reset it.`
              : 'Open your authenticator app and type the 6 digit code for ServOS.'}
        />
        {faceFirst && (
          <>
            <PrimaryButton tone={tone} busy={busy} onClick={doFaceId} testId="second-step-faceid" icon={<FaceIdIcon />}>
              Use {face.label}
            </PrimaryButton>
            <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
            {plan.codeFactorIds.length > 0 && (
              <div style={{ textAlign: 'center' }}>
                <LinkButton tone={tone} onClick={() => { setUseCode(true); setErr(''); }} testId="second-step-use-code">
                  Use a code from your authenticator app instead
                </LinkButton>
              </div>
            )}
          </>
        )}
        {!faceFirst && plan.primary !== 'faceid_elsewhere' && (
          <>
            <CodeInput tone={tone} value={code} onChange={setCode} onDone={(v) => doCode(v)} />
            <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
            <PrimaryButton tone={tone} busy={busy} disabled={!isCodeComplete(code)} onClick={() => doCode()} testId="second-step-code-submit">
              Continue
            </PrimaryButton>
            {plan.faceIdFactorId && (
              <div style={{ textAlign: 'center' }}>
                <LinkButton tone={tone} onClick={() => { setUseCode(false); setErr(''); }}>Use {face.label} instead</LinkButton>
              </div>
            )}
          </>
        )}
        <LostPhoneHint tone={tone} />
        {signOutButton}
      </Stack>
    );
  } else if (phase === 'prove') {
    body = (
      <Stack>
        <Heading
          tone={tone}
          step="New: a second sign in step"
          title="First, we make sure it is you"
          sub={proof.sent
            ? `We sent a 6 digit code to ${proof.sentTo || 'your email address'}. Type it here. It lasts an hour.`
            : 'Your password is right. Before you set up your second step we send a code to your email address, so a stolen password can never set one up.'}
        />
        {!proof.sent && (
          <PrimaryButton tone={tone} busy={busy} onClick={sendProof} testId="second-step-email-code">
            Email me a code
          </PrimaryButton>
        )}
        {proof.sent && (
          <>
            <CodeInput tone={tone} value={code} onChange={setCode} onDone={(v) => claimProof(v)} autoFocus />
            <PrimaryButton tone={tone} busy={busy} disabled={!isCodeComplete(code)} onClick={() => claimProof()} testId="second-step-prove-submit">
              Continue
            </PrimaryButton>
            <div style={{ textAlign: 'center' }}>
              <LinkButton tone={tone} onClick={sendProof} testId="second-step-email-again">Send it again</LinkButton>
            </div>
          </>
        )}
        <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
        <div style={{ fontSize: 13.5, color: tokens(tone).sub, lineHeight: 1.6 }}>
          No email? Ask the owner of your venue, or ServOS, to set you up.
        </div>
        {signOutButton}
      </Stack>
    );
  } else if (phase === 'passkey') {
    const prompt = passkeyPrompt(typeof navigator !== 'undefined' ? navigator.userAgent : '');
    body = (
      <Stack>
        <Heading
          tone={tone}
          step={optional ? 'Done. One last option' : 'New: a second sign in step'}
          title="Set up your passkey"
          sub={optional
            ? `Next time, sign in with ${prompt} on this device instead of typing anything. Your authenticator app stays as the backup.`
            : `From now on you sign in with ${prompt} instead of typing a password. It takes a few seconds, it is safer than any password, and nobody can use it but you on this device.`}
        />
        <PrimaryButton tone={tone} busy={busy} onClick={addPasskey} testId="second-step-add-passkey" icon={<FaceIdIcon />}>
          Set up my passkey
        </PrimaryButton>
        <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
        <div style={{ fontSize: 13.5, color: tokens(tone).sub, lineHeight: 1.6 }}>
          You can add another one later for your phone, or your other laptop. Settings, Sign in security.
        </div>
        {optional
          ? <SecondaryButton tone={tone} onClick={pass} testId="second-step-not-now">Not now</SecondaryButton>
          : signOutButton}
      </Stack>
    );
  } else if (phase === 'use_passkey') {
    const prompt = passkeyPrompt(typeof navigator !== 'undefined' ? navigator.userAgent : '');
    body = (
      <Stack>
        <Heading
          tone={tone}
          step="One touch to finish signing in"
          title="Use your passkey"
          sub={`You signed in with your password, which on its own is not enough to open ${area}. Use ${prompt} to prove it is you.`}
        />
        <PrimaryButton tone={tone} busy={busy} onClick={usePasskey} testId="second-step-use-passkey" icon={<FaceIdIcon />}>
          Continue with my passkey
        </PrimaryButton>
        <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
        <div style={{ fontSize: 13.5, color: tokens(tone).sub, lineHeight: 1.6 }}>
          Your passkey may be on your phone. Your browser will offer it, or show a code to scan.
          Lost the device? Ask your owner, or ServOS, to reset your sign in.
        </div>
        {signOutButton}
      </Stack>
    );
  } else if (phase === 'setup' || phase === 'backup') {
    body = (
      <Stack>
        <Heading
          tone={tone}
          step={phase === 'setup' ? 'New: a second sign in step' : 'One more thing'}
          title={phase === 'setup' ? 'Protect your account' : 'Add your backup'}
          sub={phase === 'setup'
            ? 'This device cannot make a passkey, so use an authenticator app instead. On your phone or laptop you will be offered a passkey, which is quicker and safer.'
            : 'Add an authenticator app as your backup. It works everywhere, including our apps and the tills, and gets you in if your passkey is not available.'}
        />
        <AuthenticatorSetup client={client} tone={tone} onDone={() => evaluate({ justSetUp: true })} />
        {signOutButton}
      </Stack>
    );
  } else if (phase === 'faceid') {
    body = (
      <Stack>
        <Heading
          tone={tone}
          step="Done. One last option"
          title={`Add ${face.label}?`}
          sub={`Next time, sign in with ${face.label} on this device instead of typing a code. Your authenticator app stays as the backup.`}
        />
        <PrimaryButton tone={tone} busy={busy} onClick={addFace} testId="second-step-add-faceid" icon={<FaceIdIcon />}>
          Add {face.label}
        </PrimaryButton>
        <Note tone={tone} kind="error" testId="second-step-error">{err}</Note>
        <SecondaryButton tone={tone} onClick={pass} testId="second-step-not-now">Not now</SecondaryButton>
      </Stack>
    );
  }

  if (!frame) return <div data-testid="second-step-gate" data-phase={phase}>{body}</div>;
  return (
    <div data-testid="second-step-gate" data-phase={phase}>
      <AuthFrame tone={tone} area={area} headline="Your account, locked to you" blurb="A password can be guessed or stolen. Your phone and your face cannot. That is why ServOS asks for both.">
        {body}
      </AuthFrame>
    </div>
  );
}

function LostPhoneHint({ tone }) {
  const t = tokens(tone);
  return (
    <div style={{ fontSize: 13.5, color: t.sub, lineHeight: 1.6, marginTop: 4 }}>
      Lost your phone? Ask the owner of your venue to reset your second step in Back Office. Owners, ask ServOS support.
    </div>
  );
}
