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
import { supabase, ensureAuthToken, linkDevice, sendDeviceHeartbeat, KIOSK_SECRET_KEY } from '../lib/supabase';
import { normalizePairingCode, isMissingRpc, claimRefusalMessage, classifyDeviceRead } from '../lib/deviceFence';
import { checkDeviceLink } from '../lib/deviceLink';
import DeviceLinkBanner from '../components/DeviceLinkBanner';
import KioskApp from './KioskApp';
import { getLocationConfig } from '../lib/locationTime';
import { isOpenNow, nextOpensAt, formatHoursPreview } from '../lib/openingHours';
import KioskV2Preview from './kiosk/preview/KioskV2Preview';

const LS_KIOSK_ID = 'rpos-kiosk-id';
const LS_KIOSK_TOKEN = 'rpos-kiosk-token';

// DEV only: /?mode=kiosk&kioskPreview=1 shows the new kiosk design on sample data, with no
// pairing and no database. In a production build import.meta.env.DEV is false, so this is
// false and the preview is left out of the bundle.
const PREVIEW = import.meta.env.DEV && new URLSearchParams(window.location.search).has('kioskPreview');

export default function KioskSurface() {
  return PREVIEW ? <KioskV2Preview /> : <KioskSurfaceInner />;
}

function KioskSurfaceInner() {
  const [paired, setPaired] = useState(() => !!localStorage.getItem(LS_KIOSK_ID));
  const [kiosk, setKiosk] = useState(null);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  // Database fence stage 1 (contract A4, gap B3): a read error or a missing row is UNKNOWN,
  // never "unpaired". The local pairing is cleared only when the read succeeded and the row
  // says status removed. Otherwise the kiosk keeps its pairing and the not linked banner
  // shows (components/DeviceLinkBanner.jsx) until it is linked again.
  const loadPaired = useCallback(async () => {
    const id = localStorage.getItem(LS_KIOSK_ID);
    if (!id) return;
    // Re-link first (secret, or collect one if bound without). FENCE STAGE 1 FALLBACK: before
    // 20260919a this answers "legacy" and does nothing, which is today's behaviour.
    try { await linkDevice({ allowLegacy: true }); } catch { /* keep the pairing */ }
    const { data, error } = await supabase
      .from('devices').select('*').eq('id', id).eq('type', 'kiosk').maybeSingle();
    const read = classifyDeviceRead({ error, row: data });
    if (read === 'removed') {
      console.warn('[KioskSurface] this kiosk was removed in Back Office, clearing local pairing');
      localStorage.removeItem(LS_KIOSK_ID);
      localStorage.removeItem(LS_KIOSK_TOKEN);
      localStorage.removeItem(KIOSK_SECRET_KEY);
      setPaired(false);
      return;
    }
    if (read !== 'present') {
      // FENCE STAGE 1 FALLBACK: before 20260919a the devices table is readable by all, so a
      // successful read with no row is a deleted kiosk (today's behaviour). After it, only
      // the server's answer to the re-link decides; the kiosk keeps its pairing.
      const probe = await supabase.rpc('device_status');
      if (!error && !data && probe.error && isMissingRpc(probe.error)) {
        localStorage.removeItem(LS_KIOSK_ID);
        localStorage.removeItem(LS_KIOSK_TOKEN);
        setPaired(false);
        return;
      }
      console.warn('[KioskSurface] could not read this kiosk, keeping the pairing', error?.message || 'no row');
      checkDeviceLink();
      // Keep running on the last known row so the kiosk still opens.
      try {
        const cached = JSON.parse(localStorage.getItem('rpos-kiosk-row') || 'null');
        if (cached && cached.id === id) setKiosk(cached);
      } catch { /* none */ }
      return;
    }
    setKiosk(data);
    try { localStorage.setItem('rpos-kiosk-row', JSON.stringify(data)); } catch { /* quota */ }
    // FENCE STAGE 1 FALLBACK: the heartbeat function reports last_seen once 20260919a is in;
    // before that the old direct write keeps Network Status alive.
    const hb = await sendDeviceHeartbeat();
    if (hb && hb.unsupported) await supabase.from('devices').update({ last_seen: new Date().toISOString() }).eq('id', id);
  }, []);

  useEffect(() => { if (paired) loadPaired(); }, [paired, loadPaired]);

  // FENCE STAGE 1 FALLBACK: today's pairing (SELECT by code, best effort claim_device, then the
  // UPDATE that clears the code). Used only while claim_device_v2 does not exist.
  const legacyKioskPair = async (codeNorm) => {
    const { data, error } = await supabase
      .from('devices').select('*')
      .eq('pairing_code', codeNorm)
      .eq('type', 'kiosk')
      .maybeSingle();
    if (error) throw error;
    if (!data) return { error: 'Invalid code. Check the back office for the correct code.' };
    try {
      await ensureAuthToken();
      await supabase.rpc('claim_device', { p_code: codeNorm });
    } catch (e) {
      console.warn('[KioskSurface] claim_device (device_uid stamp) failed: Ryft terminal payments will be unavailable until re-pair:', e?.message);
    }
    return { row: data, clearCode: true };
  };

  const tryPair = async () => {
    setError(null);
    const codeNorm = code.trim().toUpperCase();
    if (!normalizePairingCode(codeNorm)) { setError('Enter the pairing code'); return; }
    setWorking(true);
    try {
      // Database fence stage 1 (contract A4): claim_device_v2 binds this kiosk's session to its
      // devices row, clears the code on the server and hands back a one time device secret.
      // v5.5.871: the kiosk needs devices.device_uid = auth.uid() for Ryft "send to terminal".
      try { await ensureAuthToken(); } catch (e) { console.warn('[KioskSurface] no auth session:', e?.message); }
      let row = null;
      let clearCode = false;
      const { data: res, error: rpcErr } = await supabase.rpc('claim_device_v2', { p_code: normalizePairingCode(codeNorm) });
      if (rpcErr && isMissingRpc(rpcErr)) {
        const old = await legacyKioskPair(codeNorm);
        if (old.error) { setError(old.error); return; }
        row = old.row; clearCode = old.clearCode;
      } else if (rpcErr || !res?.ok) {
        setError(claimRefusalMessage(res, rpcErr));
        return;
      } else if (res.type !== 'kiosk') {
        setError('That code is for a till, not a kiosk. Use the code from Back Office, Channels, Kiosks.');
        return;
      } else {
        if (res.device_secret) localStorage.setItem(KIOSK_SECRET_KEY, res.device_secret);
        const { data: full } = await supabase.from('devices').select('*').eq('id', res.device_id).maybeSingle();
        row = full || { id: res.device_id, name: res.name, type: res.type, location_id: res.location_id, profile_id: res.profile_id, status: res.status };
      }

      const token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + '.' + Date.now();
      // session_token, last_seen and status stay a direct write (the bound kiosk may write its
      // own row). The pairing code is only cleared here on the old path: the server already
      // cleared it on the new one.
      const patch = {
        paired_at: new Date().toISOString(),
        session_token: token,
        last_seen: new Date().toISOString(),
        status: 'online',
      };
      if (clearCode) patch.pairing_code = null;
      const { error: e2 } = await supabase.from('devices').update(patch).eq('id', row.id);
      if (e2) {
        if (clearCode) throw e2;
        console.warn('[KioskSurface] session token write refused (kiosk is paired):', e2.message);
      }
      localStorage.setItem(LS_KIOSK_ID, row.id);
      localStorage.setItem(LS_KIOSK_TOKEN, token);
      const paired = Object.assign({}, row, { paired_at: new Date().toISOString(), session_token: token });
      try { localStorage.setItem('rpos-kiosk-row', JSON.stringify(paired)); } catch { /* quota */ }
      setKiosk(paired);
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
    localStorage.removeItem(KIOSK_SECRET_KEY);
    setPaired(false);
    setKiosk(null);
    setCode('');
  };

  // ─── Paired → check opening hours, then render the full ordering app ───
  if (paired && kiosk) {
    return <><DeviceLinkBanner /><KioskHoursGate kiosk={kiosk} onUnpair={unpair}/></>;
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
          placeholder="XXXX-XXXX-XXXX"
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
