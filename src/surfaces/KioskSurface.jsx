/**
* KioskSurface — v5.1
*
* Top-level kiosk surface, rendered when ?mode=kiosk.
* Handles the pairing handshake then hands off to KioskApp.
*
* Pairing flow:
*   1. Operator created a kiosk in BO -> got a pairing code (e.g. 'BAKER-3225')
*   2. Operator types code on this screen
*   3. We look up devices row WHERE pairing_code = code AND type = 'kiosk'
*   4. If found: generate a session_token, set paired_at = now, clear pairing_code
*   5. Store kiosk id + session token in localStorage so reload stays paired
*/

import { useState, useEffect, useCallback } from 'react';
import { supabase, ensureAuthToken } from '../lib/supabase';
import KioskApp from './KioskApp';
import { getLocationConfig } from '../lib/locationTime';
import { isOpenNow, nextOpensAt, formatHoursPreview } from '../lib/openingHours';

const LS_KIOSK_ID = 'rpos-kiosk-id';
const LS_KIOSK_TOKEN = 'rpos-kiosk-token';

export default function KioskSurface() {
  const [paired, setPaired] = useState(() => !!localStorage.getItem(LS_KIOSK_ID));
  const [kiosk, setKiosk] = useState(null);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const loadPaired = useCallback(async () => {
    const id = localStorage.getItem(LS_KIOSK_ID);
    if (!id) return;
    const { data, error } = await supabase
      .from('devices').select('*').eq('id', id).eq('type', 'kiosk').maybeSingle();
    if (error || !data) {
      console.warn('[KioskSurface] paired kiosk not found, clearing local pairing', error);
      localStorage.removeItem(LS_KIOSK_ID);
      localStorage.removeItem(LS_KIOSK_TOKEN);
      setPaired(false);
      return;
    }
    setKiosk(data);
    await supabase.from('devices').update({ last_seen: new Date().toISOString() }).eq('id', id);
  }, []);

  useEffect(() => { if (paired) loadPaired(); }, [paired, loadPaired]);

  const tryPair = async () => {
    setError(null);
    const codeNorm = code.trim().toUpperCase();
    if (!codeNorm) { setError('Enter the pairing code'); return; }
    setWorking(true);
    try {
      const { data, error } = await supabase
        .from('devices').select('*')
        .eq('pairing_code', codeNorm)
        .eq('type', 'kiosk')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        setError('Invalid code. Check the back office for the correct code.');
        return;
      }

      // v5.5.871: bind this kiosk's anonymous auth session to its devices row
      // server-side (devices.device_uid = auth.uid()), the SAME identity the POS
      // gets from claim_device. Without it the kiosk can't use the Ryft PAX
      // "send to terminal" path — terminal_targets_for_pos and terminal-job-create
      // both fence on devices.device_uid = auth.uid(). Run it BEFORE the update
      // below clears pairing_code (claim_device matches on the code). Best-effort:
      // Stripe-reader kiosks never needed it, so a failure here must not block
      // pairing — only Ryft card payments depend on it.
      try {
        await ensureAuthToken();
        await supabase.rpc('claim_device', { p_code: codeNorm });
      } catch (e) {
        console.warn('[KioskSurface] claim_device (device_uid stamp) failed — Ryft terminal payments will be unavailable until re-pair:', e?.message);
      }

      const token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + '.' + Date.now();
      const { error: e2 } = await supabase
        .from('devices').update({
          paired_at: new Date().toISOString(),
          pairing_code: null,
          session_token: token,
          last_seen: new Date().toISOString(),
          status: 'online',
        }).eq('id', data.id);
      if (e2) throw e2;
      localStorage.setItem(LS_KIOSK_ID, data.id);
      localStorage.setItem(LS_KIOSK_TOKEN, token);
      setKiosk(Object.assign({}, data, { paired_at: new Date().toISOString(), session_token: token }));
      setPaired(true);
    } catch (e) {
      console.error('[KioskSurface] pairing failed', e);
      setError(e?.message || 'Pairing failed');
    } finally {
      setWorking(false);
    }
  };

  const unpair = () => {
    if (!confirm('Unpair this kiosk?')) return;
    localStorage.removeItem(LS_KIOSK_ID);
    localStorage.removeItem(LS_KIOSK_TOKEN);
    setPaired(false);
    setKiosk(null);
    setCode('');
  };

  // ─── Paired → check opening hours, then render the full ordering app ───
  if (paired && kiosk) {
    return <KioskHoursGate kiosk={kiosk} onUnpair={unpair}/>;
  }

  // ─── Pairing-code entry ───
  return (
    <div style={pageStyle()}>
      <div style={{ textAlign: 'center', maxWidth: 480, padding: '0 24px', width: '100%' }}>
        <div style={{ fontSize: 64, marginBottom: 12 }}>🖥️</div>
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 6 }}>Pair this kiosk</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', marginBottom: 28 }}>
          Generate a pairing code in Back Office → Channels → Kiosks
        </div>
        <input
          autoFocus
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') tryPair(); }}
          placeholder="BAKER-3225"
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.06)',
            border: '2px solid rgba(255,255,255,0.15)',
            borderRadius: 14,
            padding: '20px 22px',
            fontSize: 28,
            fontWeight: 700,
            color: '#fff',
            fontFamily: 'ui-monospace, monospace',
            letterSpacing: '0.06em',
            textAlign: 'center',
            outline: 'none',
            marginBottom: 14,
          }}
        />
        {error && (
          <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5', padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 14 }}>{error}</div>
        )}
        <button onClick={tryPair} disabled={working || !code.trim()}
          style={{
            width: '100%',
            background: '#f97316', color: '#fff', border: 0,
            padding: '18px',
            borderRadius: 14,
            fontSize: 17, fontWeight: 800,
            cursor: working ? 'wait' : 'pointer',
            opacity: working || !code.trim() ? 0.5 : 1,
            fontFamily: 'inherit',
            boxShadow: '0 8px 30px rgba(249,115,22,0.35)',
          }}>
          {working ? 'Pairing…' : 'Pair'}
        </button>
        <div style={{ marginTop: 24, fontSize: 11.5, color: 'rgba(255,255,255,0.4)' }}>Serv OS · Kiosk</div>
      </div>
    </div>
  );
}

function pageStyle() {
  return {
    position: 'fixed', inset: 0,
    background: 'linear-gradient(180deg, #0a0a0c 0%, #1a1a1f 100%)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  };
}

// ── Opening hours gate ───────────────────────────────────────────────────────
// Sits between successful pairing and the ordering UI. Loads the location's
// opening_hours, then either renders the kiosk app (open) or a "We're closed"
// screen (closed) that re-checks every minute and auto-flips to the kiosk
// the moment the next window opens.
function KioskHoursGate({ kiosk, onUnpair }) {
  const [config, setConfig]   = useState(null);
  const [tick, setTick]       = useState(0);

  useEffect(() => {
    let cancelled = false;
    getLocationConfig().then(c => { if (!cancelled) setConfig(c); }).catch(() => {});
    // Re-check status every 30s so the closed screen flips to open without
    // a manual refresh, and the opening_hours stays fresh if changed in BO.
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!config) return null; // brief flash while config loads — KioskApp loads its own data anyway

  // No opening_hours set yet (location hasn't configured them) → fail-open
  // so we don't lock operators out by default. Once they set hours, this
  // path stops triggering.
  const hoursSet = config.opening_hours
    && config.opening_hours.weekly
    && Object.values(config.opening_hours.weekly).some(arr => Array.isArray(arr) && arr.length > 0);
  if (!hoursSet) return <KioskApp kioskId={kiosk.id} onUnpair={onUnpair}/>;

  const status = isOpenNow(config.opening_hours, config.timezone);
  if (status.open) return <KioskApp kioskId={kiosk.id} onUnpair={onUnpair}/>;

  // Closed — show a friendly screen with next-open time
  void tick; // re-render trigger
  const next = nextOpensAt(config.opening_hours, config.timezone);
  const fmt = next
    ? new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday:'long', hour:'numeric', minute:'2-digit', hour12:true }).format(next)
    : null;
  return (
    <div style={pageStyle()}>
      <div style={{ textAlign:'center', maxWidth:520, padding:'0 24px' }}>
        <div style={{ fontSize:80, marginBottom:18 }}>🌙</div>
        <div style={{ fontSize:28, fontWeight:800, letterSpacing:'-0.02em', marginBottom:8 }}>We're closed</div>
        <div style={{ fontSize:15, color:'#aaa', marginBottom:18 }}>
          {fmt ? <>Opens <b style={{ color:'#fff' }}>{fmt}</b></> : 'Please come back later.'}
        </div>
        <div style={{ fontSize:12, color:'#666', marginTop:24 }}>
          {formatHoursPreview(config.opening_hours)}
        </div>
        <div style={{ fontSize:10, color:'#444', marginTop:36 }}>
          Kiosk auto-opens at the next service window. No need to refresh.
        </div>
      </div>
    </div>
  );
}
