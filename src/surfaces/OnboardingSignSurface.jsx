// src/surfaces/OnboardingSignSurface.jsx
//
// Public candidate-facing contract signing page (route: /sign/<token>). The
// candidate is not logged in — the unguessable token IS the access. All reads
// and the signature write go through the workforce-onboarding edge function
// (service-role); nothing sensitive is exposed to the client beyond a
// short-lived signed URL to view the contract.

import { useState, useEffect } from 'react';
import { supabase, isMock } from '../lib/supabase';
import { Icon } from '../components/ServOSIcons';

export default function OnboardingSignSurface({ token }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null); // signature object when signed

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-skin', 'servos');
    el.setAttribute('data-theme', localStorage.getItem('rpos-theme') || 'light');
  }, []);

  useEffect(() => {
    (async () => {
      if (isMock || !supabase) { setErr('Signing is only available on the live system.'); setLoading(false); return; }
      try {
        const { data, error } = await supabase.functions.invoke('workforce-onboarding', { body: { action: 'sign.get', token } });
        if (error) throw new Error('We couldn’t open this signing link.');
        if (data?.error) { setErr(data.error); }
        else { setInfo(data); if (data.signed) setDone(data.signature || { name: '' }); }
      } catch (e) { setErr(e.message || 'Something went wrong.'); }
      finally { setLoading(false); }
    })();
  }, [token]);

  const sign = async () => {
    if (name.trim().length < 2 || !agree) return;
    setSubmitting(true); setErr('');
    try {
      const { data, error } = await supabase.functions.invoke('workforce-onboarding', { body: { action: 'sign.submit', token, name: name.trim() } });
      if (error) throw new Error('Could not record your signature — please try again.');
      if (data?.error) { setErr(data.error); }
      else setDone(data.signature || { name: name.trim(), signedAt: new Date().toISOString() });
    } catch (e) { setErr(e.message || 'Something went wrong.'); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 540, background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 20, padding: 28 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--t3)', padding: 30 }}>Loading…</div>
        ) : err && !info ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--inset)', color: 'var(--t3)' }}><Icon name="warn" size={26} /></div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{err}</div>
            <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8 }}>If you think this is a mistake, ask your manager to resend the link.</div>
          </div>
        ) : done ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', margin: '0 auto 18px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--grn-d)', border: '1px solid var(--grn-b)', color: 'var(--grn)' }}><Icon name="check" size={34} stroke={2} /></div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Contract signed</div>
            <div style={{ fontSize: 13.5, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>Thank you{done.name ? `, ${String(done.name).split(' ')[0]}` : ''}. Your signed contract has been recorded{done.signedAt ? ` on ${new Date(done.signedAt).toLocaleString('en-GB')}` : ''}. Your manager has been notified — welcome aboard!</div>
            {info?.contractUrl && <a href={info.contractUrl} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ marginTop: 18, display: 'inline-flex' }}><Icon name="tag" size={14} /> View your contract</a>}
          </div>
        ) : (
          <>
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--acc)' }}>{info.businessName}</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>Hi {String(info.staffName || '').split(' ')[0] || 'there'}, please sign your contract</h1>
            <div style={{ fontSize: 13.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.6 }}>
              Review your employment contract{info.position ? ` for the ${info.position} role` : ''}, then sign below by typing your full name. This is your legal electronic signature.
            </div>

            {info.contractUrl ? (
              <a href={info.contractUrl} target="_blank" rel="noreferrer" className="btn btn-ghost" style={{ marginTop: 16, display: 'inline-flex', width: '100%', justifyContent: 'center' }}>
                <Icon name="tag" size={15} /> Open the contract to read
              </a>
            ) : (
              <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)', fontSize: 12.5, color: 'var(--t3)' }}>The contract document isn’t attached yet — please ask your manager.</div>
            )}

            <div style={{ marginTop: 20 }}>
              <label className="mono" style={{ display: 'block', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 }}>Full legal name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Jordan Taylor Lee" style={{ width: '100%', background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '12px 14px', height: 48, fontSize: 16, color: 'var(--t1)', fontFamily: 'inherit', outline: 'none' }} />
            </div>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, fontSize: 13, color: 'var(--t2)', cursor: 'pointer', lineHeight: 1.5 }}>
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I confirm I have read and agree to the contract, and that typing my name above is my legal electronic signature.</span>
            </label>

            {err && <div style={{ marginTop: 12, color: 'var(--red)', fontSize: 13, fontWeight: 600 }}>{err}</div>}

            <button className="btn btn-acc" disabled={submitting || name.trim().length < 2 || !agree} onClick={sign} style={{ width: '100%', height: 50, marginTop: 18, fontSize: 16, fontWeight: 700 }}>
              {submitting ? 'Signing…' : 'Agree & sign'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
