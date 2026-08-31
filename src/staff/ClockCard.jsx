// src/staff/ClockCard.jsx
//
// Geofenced clock in/out for the staff app (?mode=staff), top of the Shifts tab.
//
// APP ONLY. The card renders nothing in a normal browser. Clocking is exposed
// solely inside the native shell, which is what removes the "open it on a
// laptop and fake the location in devtools" route entirely. `window.RposIOS`
// (and RposLocation) are injected by the shell at document start.
//
// HARD BLOCK. Outside the venue radius the server refuses the punch. This file
// never decides anything: it collects a reading, sends it, and shows whatever
// the server says. A tampered app cannot approve itself.
//
// NO "ALLOW ANYWAY". When a phone cannot get a fix the answer is an in-venue
// device, which by being bolted inside the building already proves presence.
// Adding a skip here would be the loophole that voids the whole feature.

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/ServOSIcons';

const glass = {
  background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
  borderRadius: 16, padding: 16,
};

/** The native location bridge, or null in a plain browser. */
function bridge() {
  return (typeof window !== 'undefined' && window.RposLocation) || null;
}
function inNativeApp() {
  return !!(typeof window !== 'undefined' && (window.RposIOS || window.RposAndroid));
}

/** One reading from the native bridge. Never throws; returns {error} instead. */
async function readLocation() {
  const b = bridge();
  if (!b?.get) return { error: 'unavailable' };
  try {
    return await b.get();
  } catch (e) {
    return { error: e?.message || 'unavailable' };
  }
}

const SINCE = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export default function ClockCard({ call, venueFallbackName }) {
  const [state, setState]   = useState(null);   // server clock_status
  const [busy, setBusy]     = useState(null);   // which punch is running
  const [msg, setMsg]       = useState(null);   // { tone, text }
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await call({ action: 'clock_status' });
      if (r?.ok) setState(r);
    } catch { /* the card just stays quiet rather than blocking the tab */ }
    finally { setLoaded(true); }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);

  // Not in the app: say why, and point at the tablet. Never offer a web clock.
  if (!inNativeApp()) {
    return (
      <div className="sv-glass" style={{ ...glass, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Icon name="clock" size={18} />
        <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55 }}>
          <b style={{ color: 'var(--t1)' }}>Clocking in works in the ServOS Staff app.</b>
          <div style={{ marginTop: 3 }}>
            Open the app on your phone, or clock in on a device at the venue.
          </div>
        </div>
      </div>
    );
  }

  if (!loaded) return null;

  const punch = async (kind) => {
    setBusy(kind); setMsg(null);
    try {
      // Only clocking IN is fenced, so only clocking in pays the wait for a fix.
      let fix = null;
      if (kind === 'in' && state?.location_required) {
        const r = await readLocation();
        if (r?.error) {
          const why = {
            denied:  'Location is turned off for this app. Turn it on in Settings, or clock in on a device at the venue.',
            off:     'Location services are off on this phone. Turn them on, or clock in on a device at the venue.',
            restricted: 'This phone does not allow location. Please clock in on a device at the venue.',
            timeout: 'Could not get your location. Move outside if you can, or clock in on a device at the venue.',
          }[r.error] || 'Could not check your location. Please clock in on a device at the venue.';
          setMsg({ tone: 'warn', text: why });
          setBusy(null);
          return;
        }
        fix = r;
      }
      // punch_id makes a retry on a flaky connection safe: the database rejects
      // the duplicate rather than opening a second shift.
      const punchId = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
      const res = await call({
        action: 'clock_punch', kind, fix, punch_id: punchId,
        platform: window.RposIOS ? 'ios' : 'android',
        app_version: window.RposIOS?.version || null,
      });
      if (res?.refused) { setMsg({ tone: 'warn', text: res.reason || 'That was refused.' }); }
      else if (res?.error) { setMsg({ tone: 'bad', text: res.error }); }
      else {
        setMsg({ tone: 'ok', text: {
          in: 'Clocked in. Have a good shift.',
          out: 'Clocked out. Thanks.',
          break_start: 'Break started.',
          break_end: 'Back on shift.',
        }[kind] });
        await refresh();
      }
    } catch (e) {
      setMsg({ tone: 'bad', text: e?.message || 'Something went wrong. Try again.' });
    } finally { setBusy(null); }
  };

  const onShift = !!state?.on_shift;
  const onBreak = !!state?.on_break;
  const venue = state?.venue_name || venueFallbackName || 'your venue';

  const btn = (bg, fg = '#08130C') => ({
    flex: 1, padding: '15px 16px', borderRadius: 13, border: 'none',
    background: bg, color: fg, fontSize: 15, fontWeight: 800,
    fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.65 : 1,
  });

  return (
    <div className="sv-glass" style={{ ...glass, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon name="clock" size={17} />
        <div style={{ fontSize: 14.5, fontWeight: 800 }}>
          {onShift ? (onBreak ? 'On a break' : 'On shift') : 'Not clocked in'}
        </div>
        {onShift && (
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>
            since {SINCE(onBreak ? state.break_since : state.since)}
          </div>
        )}
      </div>

      {state?.location_required && !onShift && (
        <div style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
          You can clock in when you are at {venue}.
        </div>
      )}

      {msg && (
        <div style={{
          fontSize: 12.5, lineHeight: 1.5, padding: '10px 12px', borderRadius: 11,
          background: msg.tone === 'ok' ? 'rgba(21,194,106,.14)'
                    : msg.tone === 'warn' ? 'rgba(232,160,32,.14)' : 'rgba(229,72,77,.14)',
          color: msg.tone === 'ok' ? 'var(--grn, #15C26A)'
               : msg.tone === 'warn' ? 'var(--amber, #E8A020)' : 'var(--red, #E5484D)',
        }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', gap: 9 }}>
        {!onShift && (
          <button style={btn('var(--grn, #15C26A)')} disabled={!!busy} onClick={() => punch('in')}>
            {busy === 'in' ? 'Checking…' : 'Clock in'}
          </button>
        )}
        {onShift && !onBreak && (
          <>
            <button style={btn('var(--glass-bg)', 'var(--t1)')} disabled={!!busy} onClick={() => punch('break_start')}>
              {busy === 'break_start' ? '…' : 'Take a break'}
            </button>
            <button style={btn('var(--grn, #15C26A)')} disabled={!!busy} onClick={() => punch('out')}>
              {busy === 'out' ? '…' : 'Clock out'}
            </button>
          </>
        )}
        {onShift && onBreak && (
          <button style={btn('var(--grn, #15C26A)')} disabled={!!busy} onClick={() => punch('break_end')}>
            {busy === 'break_end' ? '…' : 'End break'}
          </button>
        )}
      </div>
    </div>
  );
}
