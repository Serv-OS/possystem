import { useState } from 'react';
import { supabase, isMock, LOCATION_ID, enforceTenantFence, ensureAuthToken } from '../lib/supabase';
import { VERSION } from '../lib/version';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';

export default function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handlePair = async () => {
    const clean = code.trim().toUpperCase();
    if (!clean) return setError('Enter the pairing code from your back office');
    setLoading(true); setError('');

    // Look up the code in Supabase — allow re-pairing even if already active
    const { data, error: err } = await supabase
      .from('devices')
      .select('*, locations(*)')
      .eq('pairing_code', clean)
      .neq('status', 'removed')  // only block explicitly removed devices
      .single();

    if (err || !data) {
      setLoading(false);
      return setError('Pairing code not found. Check the code and try again.');
    }

    // Mark device as active (re-pairing kicks any existing session via session_token realtime)
    await supabase.from('devices').update({
      status: 'active',
      paired_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      session_token: null,  // clear session token so old session gets kicked on next check
    }).eq('id', data.id);

    // v5.5.757 — POS-core RLS cutover, Stage 1: securely bind this device's anonymous
    // session to the paired location server-side (devices.device_uid = auth.uid()), so a
    // future RLS pass can scope it via pos_can_access(). The RPC takes device_uid from the
    // JWT, never client input. Best-effort — pairing must NEVER fail on it.
    try {
      await ensureAuthToken();
      await supabase.rpc('claim_device', { p_code: clean });
    } catch (e) {
      console.warn('[pair] claim_device failed (non-fatal):', e?.message);
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
    const deviceEntry = {
      id: data.id,
      name: data.name,
      type: data.type,
      locationId: data.location_id,
      locationName: data.locations?.name || 'Unknown',
      orgId: data.locations?.org_id,
      profileId: data.profile_id || null,
      pairingCode: clean,   // v5.5.758: persisted so boot can re-establish the RLS device link
      pairedAt: new Date().toISOString(),
    };
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
          placeholder="e.g. DONUT-4821"
          maxLength={12}
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
          <strong>Back Office → Hardware → Terminals</strong>
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
