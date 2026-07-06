import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { supabase, isMock } from '../lib/supabase';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';
import { biometricCaps, biometricIdentify } from '../lib/biometric';
import { nfcAvailable, onNfcTap, normalizeCardId } from '../lib/nfc';
import { resolveSignIn, canOverride } from '../lib/staffAuth';

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

// Append-only sign-in audit (who signed in, how, approved by whom). Best-effort.
function logSignIn(staffId, method, approvedBy) {
  if (isMock || !supabase) return;
  try {
    const paired = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    const location_id = paired?.locationId;
    if (!location_id) return;
    supabase.from('staff_auth_events').insert({
      location_id,
      staff_id: staffId ? String(staffId) : null,
      method,
      device_id: paired?.deviceId || paired?.id || null,
      approved_by: approvedBy ? String(approvedBy) : null,
    }).then(() => {}, () => {});
  } catch { /* best-effort */ }
}

export default function PINScreen() {
  const { login, staffMembers } = useStore();
  const [loadedStaff, setLoadedStaff] = useState(null); // null = still loading
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [caps] = useState(() => biometricCaps());       // fingerprint (gated on the Sunmi SDK)
  const [bioBusy, setBioBusy] = useState(false);
  // Manager override: a manager arms a ONE-OFF PIN sign-in for a card-staff who's lost their card.
  const [overrideBy, setOverrideBy] = useState(null);   // the authorising manager (or null)
  const [showOverride, setShowOverride] = useState(false);

  // Load staff (with their sign-in method) from Supabase using the paired device's locationId.
  useEffect(() => {
    if (isMock) { setLoadedStaff(staffMembers); return; }
    (async () => {
      try {
        const paired = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        const locationId = paired?.locationId;
        if (!locationId) { setLoadedStaff(staffMembers); return; }
        const { data } = await supabase
          .from('staff_members').select('*')
          .eq('location_id', locationId).eq('active', true);
        if (data?.length) {
          const mapped = data.map(r => ({
            id: r.id, name: r.name, role: r.role, pin: r.pin,
            nfcCardId: r.nfc_card_id || null,
            authMethod: r.auth_method || 'pin',
            color: r.color || '#3b82f6',
            initials: r.initials || r.name.slice(0, 2).toUpperCase(),
            permissions: Array.isArray(r.permissions) ? r.permissions : [],
            active: r.active,
          }));
          useStore.setState({ staffMembers: mapped });
          setLoadedStaff(mapped);
        } else { setLoadedStaff(staffMembers); }
      } catch (e) { setLoadedStaff(staffMembers); }
    })();
  }, []);

  const staff = loadedStaff ?? staffMembers ?? [];
  const nfcOn = nfcAvailable();
  // A USB reader can't be detected (it's just a keyboard) — so show the card prompt whenever any staff
  // are set up for cards, not only when a native NFC reader reports in.
  const hasCards = staff.some(s => s.nfcCardId || s.authMethod === 'card');

  const doLogin = (member, method, approvedBy) => { logSignIn(member.id, method, approvedBy); login(member); };
  const fail = (msg) => { setShake(true); setErrorMsg(msg); setPin(''); setTimeout(() => setShake(false), 600); };

  // ─── NFC card sign-in (tap → match → sign in). Paused while the override modal is open. ──
  useEffect(() => {
    if (!loadedStaff || !nfcOn || showOverride) return;
    const stop = onNfcTap((cardId) => {
      const r = resolveSignIn(loadedStaff, { cardId });
      if (r.ok) { doLogin(r.staff, 'card'); return; }
      fail('Card not recognised — try again');
    });
    return stop;
  }, [loadedStaff, nfcOn, showOverride]);

  // ─── USB NFC reader (keyboard-wedge) sign-in. The Sunmi D3 Pro's on-glass NFC is SDK-gated payment
  //     NFC our bridge can't read, so a plug-in USB reader is the reliable staff-card path — it "types"
  //     the card UID as a fast keystroke burst ending in Enter. We buffer the burst (idle-flush too) and
  //     match it like a tap. Works on ANY device with a USB reader; harmless where none is attached. ──
  useEffect(() => {
    if (!loadedStaff || showOverride) return undefined;
    let buf = '', timer = null;
    const flush = () => {
      const raw = buf; buf = '';
      if (timer) { clearTimeout(timer); timer = null; }
      if (raw.length < 4) return;                       // ignore stray single keys
      const r = resolveSignIn(loadedStaff, { cardId: normalizeCardId(raw) });
      if (r.ok) doLogin(r.staff, 'card'); else fail('Card not recognised — try again');
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { if (buf.length >= 4) { e.preventDefault(); flush(); } else { buf = ''; } return; }
      if (e.key && e.key.length === 1 && /[0-9A-Za-z:\-]/.test(e.key)) {
        buf += e.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 200);                  // ~end of the reader's keystroke burst
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (timer) clearTimeout(timer); };
  }, [loadedStaff, showOverride]);

  // ─── PIN entry — enforces per-staff method (a card-staff's PIN is refused, unless overridden) ──
  const tapPin = (k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setErrorMsg(''); return; }
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    setErrorMsg('');
    if (next.length === 4) {
      setTimeout(() => {
        const r = resolveSignIn(staff, { pin: next, allowOverride: !!overrideBy });
        if (r.ok) {
          const approvedBy = r.method === 'override' ? overrideBy?.id : null;
          setOverrideBy(null);
          doLogin(r.staff, r.method, approvedBy);
        } else if (r.reason === 'use_card') {
          fail(`${r.staff?.name || 'This person'} signs in with their card`);
        } else {
          fail('PIN not recognised');
        }
      }, 100);
    }
  };

  // Fingerprint sign-in (1:N identify) — gated on the Sunmi SDK reporting `identify`.
  const scanFingerprint = async () => {
    if (bioBusy) return;
    setBioBusy(true); setErrorMsg('');
    const r = await biometricIdentify().catch(() => ({ ok: false }));
    setBioBusy(false);
    if (r?.ok && r.staffRef) {
      const m = staff.find(s => String(s.id) === String(r.staffRef));
      if (m) { doLogin(m, 'fingerprint'); return; }
      setErrorMsg('Fingerprint isn’t linked to a staff member yet');
    } else if (r?.error !== 'canceled') { setErrorMsg('Fingerprint not recognised — use your PIN'); }
    if (r?.error !== 'canceled') { setShake(true); setTimeout(() => setShake(false), 600); }
  };

  const staffNoPin = staff.filter(s => !s.pin && s.authMethod !== 'card');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 28, background: 'var(--bg)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ margin: '0 auto 14px', width: 56 }}><ServOSIcon size={56} /></div>
        <ServOSWordmark fontSize={24} />
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6 }}>
          {loadedStaff === null ? 'Loading staff…'
            : staff.length ? ((nfcOn || hasCards) ? '💳 Tap your card, or enter your PIN' : 'Enter your PIN to sign in')
            : 'No staff configured — go to Back Office → Staff'}
        </div>
      </div>

      {staff.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          {/* Override banner — armed by a manager */}
          {overrideBy && (
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--acc)', background: 'var(--acc-d, rgba(232,160,32,.12))', border: '1px solid var(--acc)', borderRadius: 10, padding: '8px 12px', textAlign: 'center' }}>
              One-off sign-in allowed by {overrideBy.name} — enter the staff member’s PIN now.
              <button onClick={() => setOverrideBy(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', fontSize: 11 }}>cancel</button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${shake ? 'var(--red)' : i < pin.length ? 'var(--acc)' : 'var(--bdr3)'}`, background: i < pin.length ? (shake ? 'var(--red)' : 'var(--acc)') : 'transparent', transition: 'all .12s' }} />
            ))}
          </div>

          {errorMsg && <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600, minHeight: 18 }}>{errorMsg}</div>}

          {caps.identify && (
            <button onClick={scanFingerprint} disabled={bioBusy} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderRadius: 12, background: bioBusy ? 'var(--bg3)' : 'var(--acc)', color: bioBusy ? 'var(--t2)' : '#0b0c10', border: 'none', fontSize: 14, fontWeight: 800, cursor: bioBusy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
              <span style={{ fontSize: 20 }}>👆</span>{bioBusy ? 'Scanning…' : 'Sign in with fingerprint'}
            </button>
          )}

          <Numpad onKey={tapPin} />

          {/* Manager override + no-PIN fallback */}
          <button onClick={() => { setShowOverride(true); setErrorMsg(''); }} style={{ fontSize: 11, color: 'var(--t4)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
            Can’t sign in? Manager override
          </button>
          {staffNoPin.length > 0 && <NoPinFallback staff={staffNoPin} login={(m) => doLogin(m, 'pin')} />}
        </div>
      )}

      {staff.length === 0 && loadedStaff !== null && (
        <div style={{ textAlign: 'center' }}>
          {!isMock ? (
            <div style={{ maxWidth: 320 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>No staff members set up yet</div>
              <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20, lineHeight: 1.6 }}>Go to <strong>Back Office → Staff & Access</strong> and add your staff members. They'll appear here automatically.</div>
              <button onClick={() => { localStorage.setItem('rpos-device-mode', 'backoffice'); window.location.reload(); }} style={{ padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--acc)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, display: 'block', width: '100%' }}>Go to Back Office →</button>
            </div>
          ) : (
            <button onClick={() => login({ id: 'demo', name: 'Demo User', role: 'Manager', color: '#e8a020', initials: 'DU', pin: '', permissions: ['void', 'discount', 'refund', 'cashup', 'reports', 'eod', 'menu86', 'staff'] })} style={{ padding: '10px 24px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--acc)', border: 'none', color: '#0b0c10', fontSize: 14, fontWeight: 700 }}>Enter as Demo (no staff set up)</button>
          )}
        </div>
      )}

      {showOverride && (
        <OverrideModal staff={staff} nfcOn={nfcOn}
          onClose={() => setShowOverride(false)}
          onArm={(mgr) => { setOverrideBy(mgr); setShowOverride(false); setErrorMsg(''); }} />
      )}
    </div>
  );
}

// ─── Numpad ─────────────────────────────────────────────────────────────────
function Numpad({ onKey }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 10 }}>
      {KEYS.map((k, i) => (
        <button key={i} onClick={() => k && onKey(k)} style={{
          height: 56, borderRadius: 14, fontFamily: 'inherit',
          background: k === '⌫' ? 'transparent' : 'var(--bg3)',
          border: `1px solid ${k === '⌫' ? 'transparent' : 'var(--bdr)'}`,
          fontSize: k === '⌫' ? 22 : 24, fontWeight: 500, color: 'var(--t1)',
          cursor: k ? 'pointer' : 'default', visibility: k === '' ? 'hidden' : 'visible', transition: 'all .1s',
        }}>{k}</button>
      ))}
    </div>
  );
}

// ─── Manager override — a manager authenticates (their own card or PIN) to arm a one-off PIN sign-in
//     for a card-staff who's lost their card. Only managers (canOverride) can arm it. ─────────────
function OverrideModal({ staff, nfcOn, onClose, onArm }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');

  const tryAuth = (input) => {
    const r = resolveSignIn(staff, input);          // a manager may auth by card OR pin
    if (!r.ok) { setErr('Not recognised'); setPin(''); return; }
    if (!canOverride(r.staff)) { setErr(`${r.staff.name} can’t authorise an override`); setPin(''); return; }
    onArm(r.staff);
  };

  // Manager can tap their card to authorise (when a reader is present).
  useEffect(() => {
    if (!nfcOn) return;
    const stop = onNfcTap((cardId) => tryAuth({ cardId }));
    return stop;
  }, [nfcOn]);

  const onKey = (k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setErr(''); return; }
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next); setErr('');
    if (next.length === 4) setTimeout(() => tryAuth({ pin: next }), 80);
  };

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 9999, padding: 16 }}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 24, width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', textAlign: 'center' }}>Manager override</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', textAlign: 'center', lineHeight: 1.5 }}>
          {nfcOn ? 'Manager: tap your card or enter your PIN' : 'Manager: enter your PIN'} to allow a one-off sign-in.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--bdr3)', background: i < pin.length ? 'var(--acc)' : 'transparent' }} />)}
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>{err}</div>}
        <Numpad onKey={onKey} />
        <button onClick={onClose} style={{ fontSize: 12, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Fallback for staff configured without a PIN or a card (legacy) ──────────────────────────────
function NoPinFallback({ staff, login }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4, textAlign: 'center' }}>
      <button onClick={() => setOpen(!open)} style={{ fontSize: 11, color: 'var(--t4)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
        {open ? 'Hide' : `${staff.length} staff without PIN — tap to login`}
      </button>
      {open && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 10, maxWidth: 360 }}>
          {staff.map(s => (
            <button key={s.id} onClick={() => login(s)} style={{ padding: '8px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--bg3)', border: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: (s.color || '#3b82f6') + '22', border: `2px solid ${(s.color || '#3b82f6')}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: s.color || '#3b82f6' }}>
                {(s.initials || s.name.slice(0, 2)).toUpperCase()}
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t1)' }}>{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
