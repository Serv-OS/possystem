import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { supabase, isMock } from '../lib/supabase';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

export default function PINScreen() {
  const { login, staffMembers } = useStore();
  const [loadedStaff, setLoadedStaff] = useState(null); // null = still loading
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Load staff from Supabase using the paired device's locationId
  useEffect(() => {
    if (isMock) { setLoadedStaff(staffMembers); return; }
    (async () => {
      try {
        const paired = JSON.parse(localStorage.getItem('rpos-device') || 'null');
        const locationId = paired?.locationId;
        if (!locationId) { setLoadedStaff(staffMembers); return; }
        const { data } = await supabase
          .from('staff_members')
          .select('*')
          .eq('location_id', locationId)
          .eq('active', true);
        if (data?.length) {
          const mapped = data.map(r => ({
            id: r.id, name: r.name, role: r.role, pin: r.pin,
            color: r.color || '#3b82f6',
            initials: r.initials || r.name.slice(0, 2).toUpperCase(),
            permissions: Array.isArray(r.permissions) ? r.permissions : [],
            active: r.active,
          }));
          useStore.setState({ staffMembers: mapped });
          setLoadedStaff(mapped);
        } else {
          setLoadedStaff(staffMembers);
        }
      } catch (e) {
        setLoadedStaff(staffMembers);
      }
    })();
  }, []);

  const staff = loadedStaff ?? staffMembers ?? [];

  // ─── PIN-only login: match PIN against all active staff ─────────────────
  const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  const tap = (k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setErrorMsg(''); return; }
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    setErrorMsg('');
    if (next.length === 4) {
      setTimeout(() => {
        // Look up which staff member has this PIN
        const match = staff.find(s => s.pin && s.pin === next);
        if (match) {
          login(match);
        } else {
          setShake(true);
          setErrorMsg('PIN not recognised');
          setPin('');
          setTimeout(() => setShake(false), 600);
        }
      }, 100);
    }
  };

  // Count staff with PINs vs without
  const staffWithPin = staff.filter(s => s.pin);
  const staffNoPin = staff.filter(s => !s.pin);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '100vh', gap: 28,
      background: 'var(--bg)',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ margin: '0 auto 14px', width: 56 }}><ServOSIcon size={56} /></div>
        <ServOSWordmark fontSize={24} />
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6 }}>
          {loadedStaff === null
            ? 'Loading staff…'
            : staff.length
              ? 'Enter your PIN to clock in'
              : 'No staff configured — go to Back Office → Staff'}
        </div>
      </div>

      {/* ─── PIN numpad (always visible when staff exist) ─────────────── */}
      {staff.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          {/* PIN dots */}
          <div style={{ display: 'flex', gap: 12 }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{
                width: 16, height: 16, borderRadius: '50%',
                border: `2px solid ${shake ? 'var(--red)' : i < pin.length ? 'var(--acc)' : 'var(--bdr3)'}`,
                background: i < pin.length ? (shake ? 'var(--red)' : 'var(--acc)') : 'transparent',
                transition: 'all .12s',
              }} />
            ))}
          </div>

          {/* Error message */}
          {errorMsg && (
            <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600, minHeight: 18 }}>{errorMsg}</div>
          )}

          {/* Numpad */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 10 }}>
            {KEYS.map((k, i) => (
              <button key={i} onClick={() => k && tap(k)} style={{
                height: 56, borderRadius: 14, fontFamily: 'inherit',
                background: k === '⌫' ? 'transparent' : 'var(--bg3)',
                border: `1px solid ${k === '⌫' ? 'transparent' : 'var(--bdr)'}`,
                fontSize: k === '⌫' ? 22 : 24, fontWeight: 500,
                color: 'var(--t1)', cursor: k ? 'pointer' : 'default',
                visibility: k === '' ? 'hidden' : 'visible',
                transition: 'all .1s',
              }}>{k}</button>
            ))}
          </div>

          {/* Staff without PINs — show small link to log in without PIN */}
          {staffNoPin.length > 0 && (
            <NoPinFallback staff={staffNoPin} login={login} />
          )}
        </div>
      )}

      {/* No staff configured — show helpful message */}
      {staff.length === 0 && loadedStaff !== null && (
        <div style={{ textAlign: 'center' }}>
          {!isMock ? (
            <div style={{ maxWidth: 320 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>No staff members set up yet</div>
              <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20, lineHeight: 1.6 }}>
                Go to <strong>Back Office → Staff & Access</strong> and add your staff members with PINs. They'll appear here automatically.
              </div>
              <button onClick={() => { localStorage.setItem('rpos-device-mode', 'backoffice'); window.location.reload(); }}
                style={{ padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--acc)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 700, marginBottom: 8, display: 'block', width: '100%' }}>
                Go to Back Office →
              </button>
            </div>
          ) : (
            <button onClick={() => login({ id: 'demo', name: 'Demo User', role: 'Manager', color: '#e8a020', initials: 'DU', pin: '', permissions: ['void', 'discount', 'refund', 'cashup', 'reports', 'eod', 'menu86', 'staff'] })}
              style={{ padding: '10px 24px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--acc)', border: 'none', color: '#0b0c10', fontSize: 14, fontWeight: 700 }}>
              Enter as Demo (no staff set up)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Fallback for staff without PINs ────────────────────────────────────────
// Small collapsible section at bottom: "Staff without PINs" — tap name to enter.
// Encourages setting PINs but doesn't block login for unconfigured accounts.
function NoPinFallback({ staff, login }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 4, textAlign: 'center' }}>
      <button onClick={() => setOpen(!open)} style={{
        fontSize: 11, color: 'var(--t4)', background: 'none', border: 'none',
        cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
      }}>
        {open ? 'Hide' : `${staff.length} staff without PIN — tap to login`}
      </button>
      {open && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 10, maxWidth: 360 }}>
          {staff.map(s => (
            <button key={s.id} onClick={() => login(s)} style={{
              padding: '8px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              background: 'var(--bg3)', border: '1px solid var(--bdr)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: (s.color || '#3b82f6') + '22',
                border: `2px solid ${(s.color || '#3b82f6')}55`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 800, color: s.color || '#3b82f6',
              }}>
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
