import { useState } from 'react';
import { supabase, isMock, LOCATION_ID, enforceTenantFence, ensureAuthToken, getActiveLocationSync } from '../lib/supabase';
import { normalizePairingCode, isMissingRpc, claimRefusalMessage, deviceEntryFromClaim, pairingCodeHint, claimDeviceWithRetry } from '../lib/deviceFence';
import { getPendingCount, reconcilePendingChecks } from '../sync/DataSafe';
import { getQueueSize, replayQueue } from '../sync/OfflineQueue';
import { VERSION } from '../lib/version';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

export default function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Database fence stage 1 (contract A3): ONE server call. claim_device_v2 binds this session
  // to the device with that live code and hands back the venue and a one time device secret.
  // A refused claim NEVER pairs locally (before, a failed claim still paired and left a
  // silently untrusted till).
  // FENCE STAGE 1 FALLBACK: while 20260919a is not run claim_device_v2 does not exist and the
  // old flow below (SELECT by code, UPDATE, best effort claim_device) runs. Delete
  // legacyPair once 20260919b has run.
  const legacyPair = async (clean) => {
    const { data, error: err } = await supabase
      .from('devices')
      .select('*, locations(*)')
      .eq('pairing_code', clean)
      .neq('status', 'removed')  // only block explicitly removed devices
      .single();
    if (err || !data) return { error: 'Pairing code not found. Check the code and try again.' };
    await supabase.from('devices').update({
      status: 'active',
      paired_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      // Fence stage 1, fix round 2: every write of last_seen carries the build, so file A's version
      // check (a device seen in the last 2 hours on an older app stops it) always sees this one.
      app_version: VERSION,
      session_token: null,  // clear session token so old session gets kicked on next check
    }).eq('id', data.id);
    try {
      await ensureAuthToken();
      await supabase.rpc('claim_device', { p_code: clean });
    } catch (e) {
      console.warn('[pair] claim_device failed (non-fatal):', e?.message);
    }
    return {
      claim: {
        device_id: data.id, name: data.name, type: data.type, location_id: data.location_id,
        profile_id: data.profile_id || null, centre_id: data.centre_id || null,
        location: { name: data.locations?.name || 'Unknown', org_id: data.locations?.org_id || null },
      },
      legacyCode: clean,
    };
  };

  // Unsent work (a parked sale, a buffered write) is sent BEFORE the claim, while this till
  // still has its old link. Pairing to ANOTHER venue wipes the old venue's local data (tenant
  // fence), so work that still could not be sent is warned about first (contract A3).
  const unsentWork = async () => {
    let n = 0;
    try { n += getPendingCount(); } catch { /* none */ }
    try { n += await getQueueSize(); } catch { /* unreadable */ }
    return n;
  };

  const handlePair = async () => {
    const typed = code.trim().toUpperCase();
    const clean = normalizePairingCode(code);
    if (!clean) return setError('Enter the pairing code from your back office');
    // Fix round (19 Sep): a mistyped server code (a 0, 1, I or O, or a symbol short) is caught
    // here, before the server answers it "no longer valid" as if it were an old code.
    const hint = pairingCodeHint(code);
    if (hint) return setError(hint);
    setLoading(true); setError('');

    if ((await unsentWork()) > 0) {
      try { await reconcilePendingChecks(); } catch { /* next boot retries */ }
      try { await replayQueue(supabase); } catch { /* next boot retries */ }
    }

    try { await ensureAuthToken(); } catch (e) { console.warn('[pair] no auth session:', e?.message); }
    let claim = null;
    let legacyCode = null;
    // A dropped connection used to end the pairing with the browser's own words
    // ("TypeError: Load failed"). Repeating the claim is safe, so it is tried again.
    const { data: res, error: rpcErr } = await claimDeviceWithRetry({
      rpc: (p_code) => supabase.rpc('claim_device_v2', { p_code }),
      code: clean,
    });
    if (rpcErr && isMissingRpc(rpcErr)) {
      const old = await legacyPair(typed);
      if (old.error) { setLoading(false); return setError(old.error); }
      claim = old.claim; legacyCode = old.legacyCode;
    } else if (rpcErr || !res?.ok) {
      setLoading(false);
      return setError(claimRefusalMessage(res, rpcErr));
    } else {
      claim = res;
    }
    const data = {
      id: claim.device_id, name: claim.name, type: claim.type, location_id: claim.location_id,
      profile_id: claim.profile_id || null, centre_id: claim.centre_id || null,
    };

    // A different venue while this till still holds unsent work: ask first. Cancelling keeps
    // everything on this till (it shows the not linked banner until it is paired back).
    const prevLoc = getActiveLocationSync();
    if (prevLoc && data.location_id && prevLoc !== data.location_id) {
      const left = await unsentWork();
      if (left > 0 && !window.confirm(`This till still holds ${left} unsent item(s) for its old venue. Pairing it to ${claim.location?.name || 'another venue'} removes them from this till. Pair anyway?`)) {
        setLoading(false);
        return setError('Pairing cancelled. The unsent work is still on this till.');
      }
    }

    // v5.5.3: TENANT FENCE at pair-time. If this terminal was previously paired to a
    // different location, every location-scoped localStorage key (rpos-session-backup,
    // rpos-shared-state, rpos-config-snapshot, etc.) holds the OLD location's data.
    // The fence wipes those stale keys BEFORE we write the new pairing, so the next
    // boot reads a clean slate scoped to the new location. Without this, re-pairing a
    // browser that was previously at Loc 1 to Loc 2 would surface Loc 1's open
    // orders / printers / device profiles on the Loc 2 POS.
    enforceTenantFence(data.location_id);

    // Store device identity in localStorage
    const deviceEntry = deviceEntryFromClaim(claim);
    // FENCE STAGE 1 FALLBACK: the old flow keeps the code so boot can re-link with it.
    if (legacyCode) deviceEntry.pairingCode = legacyCode;
    localStorage.setItem('rpos-device', JSON.stringify(deviceEntry));
    // Clear any previous session token so old sessions get kicked
    sessionStorage.removeItem(`rpos-session-${data.id}`);

    // KDS devices get a special config — boot straight to KDS surface, no PIN, no nav
    if (data.type === 'kds') {
      localStorage.setItem('rpos-device-config', JSON.stringify({
        profileId: 'kds', profileName: 'Kitchen Display',
        defaultSurface: 'kds',
        centreId: data.centre_id || null,
        centreName: data.centre_id ? ({pc1:'Hot kitchen',pc2:'Cold section',pc3:'Pizza oven',pc4:'Bar',pc5:'Expo / pass'}[data.centre_id] || data.centre_id) : null,
        enabledOrderTypes: [],
        hiddenFeatures: ['reports','discounts','voids','courses'],
        tableServiceEnabled: false,
        quickScreenEnabled: false,
        autoPrintReceiptOnClose: false,
      }));
    }

    // Apply device profile settings to rpos-device-config
    if (data.profile_id) {
      try {
        const storedProfiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null');
        const DEFAULT_PROFILES = [
          { id:'prof-1', name:'Main counter', defaultSurface:'tables', enabledOrderTypes:['dine-in','takeaway','collection'], assignedSection:null, hiddenFeatures:[], tableServiceEnabled:true, quickScreenEnabled:true },
          { id:'prof-2', name:'Bar terminal', defaultSurface:'bar', enabledOrderTypes:['dine-in'], assignedSection:'bar', hiddenFeatures:['courses','kiosk','reports'], tableServiceEnabled:false, quickScreenEnabled:true },
          { id:'prof-3', name:'Server handheld', defaultSurface:'pos', enabledOrderTypes:['dine-in'], assignedSection:null, hiddenFeatures:['kiosk','reports'], tableServiceEnabled:true, quickScreenEnabled:true },
        ];
        const allProfiles = storedProfiles || DEFAULT_PROFILES;
        const profile = allProfiles.find(p => p.id === data.profile_id);
        if (profile) {
          localStorage.setItem('rpos-device-config', JSON.stringify({
            profileId: profile.id,
            profileName: profile.name,
            defaultSurface: profile.defaultSurface || 'tables',
            enabledOrderTypes: profile.enabledOrderTypes || ['dine-in'],
            assignedSection: profile.assignedSection || null,
            hiddenFeatures: profile.hiddenFeatures || [],
            tableServiceEnabled: profile.tableServiceEnabled !== false,
            quickScreenEnabled: profile.quickScreenEnabled !== false,
            autoPrintReceiptOnClose: true,
            orderNotifications: profile.orderNotifications !== false,
          }));
        }
      } catch(e) { console.warn('Profile apply failed:', e); }
    }

    setLoading(false);
    onPaired(data);
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-base)', fontFamily: 'inherit',
    }}>
      <div style={{
        width: 420, background: 'var(--bg1)', border: '1px solid var(--bdr)',
        borderRadius: 20, padding: '48px 40px', textAlign: 'center',
        boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
      }}>
        {/* Logo */}
        <div style={{ margin: '0 auto 16px', width: 56 }}><ServOSIcon size={56} /></div>

        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 }}>
          Welcome to <ServOSWordmark fontSize={22} />
        </div>
        <div style={{ fontSize: 14, color: 'var(--t3)', marginBottom: 40, lineHeight: 1.5 }}>
          This device hasn't been set up yet.<br />
          Enter the pairing code from your back office to get started.
        </div>

        {/* Code input */}
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && handlePair()}
          placeholder="XXXX-XXXX-XXXX"
          maxLength={20}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          style={{
            width: '100%', padding: '14px 16px', borderRadius: 12,
            border: `2px solid ${error ? '#fca5a5' : 'var(--bdr)'}`,
            background: 'var(--bg)', color: 'var(--t1)',
            fontSize: 24, fontWeight: 700, letterSpacing: '.1em',
            textAlign: 'center', fontFamily: 'monospace',
            outline: 'none', boxSizing: 'border-box',
            marginBottom: 12,
          }}
          autoFocus
        />

        {error && (
          <div style={{
            padding: '10px 14px', borderRadius: 10, background: '#fef2f2',
            border: '1px solid #fecaca', color: '#dc2626', fontSize: 13,
            marginBottom: 16, textAlign: 'left',
          }}>{error}</div>
        )}

        <button
          onClick={handlePair}
          disabled={loading || !code.trim()}
          style={{
            width: '100%', padding: '14px 0', borderRadius: 12,
            background: loading || !code.trim() ? 'var(--t4)' : 'var(--acc)',
            color: '#fff', fontWeight: 700, fontSize: 16,
            border: 'none', cursor: loading || !code.trim() ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {loading ? 'Pairing…' : 'Pair this device →'}
        </button>

        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 16, fontFamily: 'monospace' }}>v{VERSION}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>
          Generate a pairing code in your back office:<br />
          <strong>Back Office → Hardware → Terminals</strong><br />
          Type it with or without the dashes. A code works once, and does not expire while you set up.
        </div>

        {/* Admin bypass link */}
        <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 16 }}>
          Restaurant owner or admin?{' '}
          <button onClick={() => {
            // Mark as "admin mode" so we skip pairing and go to back office
            localStorage.setItem('rpos-device', JSON.stringify({ id: 'admin', name: 'Admin', type: 'admin', locationId: null, adminMode: true }));
            window.location.reload();
          }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--acc)', fontWeight: 700, fontSize: 12, textDecoration: 'underline' }}>
            Access Back Office →
          </button>
        </div>
      </div>
    </div>
  );
}
