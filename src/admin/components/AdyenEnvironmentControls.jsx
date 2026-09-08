// src/admin/components/AdyenEnvironmentControls.jsx
//
// ServOS admin portal (?mode=admin): the per venue Adyen ENVIRONMENT controls
// and the one time STORE setup, extracted from the venue Back Office panel
// (src/backoffice/sections/AdyenTerminals.jsx) on 8 Sep 2026.
//
// OWNER RULE (8 Sep 2026): a venue must not move itself between test cards
// and live, create its Adyen store or request its card schemes. Those are
// ServOS internal actions, so they render HERE, in the admin portal, and the
// adyen-terminal-admin fn refuses set_environment, ensure_store and
// ensure_payment_methods for anyone but a platform super_admin (the caller's
// user_profiles.role, the same lookup adyen-onboard fences on). The venue's
// Back Office shows the state only.
//
// Renders three things:
//   1. Region (8 Sep 2026): UK or US, the Adyen account the venue is on. The
//      UK and US live accounts are different accounts (keys, Checkout host,
//      Terminal API host, Drop-in environment), so the select sits ABOVE the
//      environment switch and is disabled while the venue is live or already
//      holds a store or readers (the fn's regionLocked). It calls set_region;
//      until the platform migration 20260908_PLATFORM_adyen_region_uk.sql
//      runs the fn refuses 'UK' with a message naming it, shown as is.
//   2. Environment: the state, the switch, the typed LIVE confirm when going
//      live (only offered while the server reports THIS region's live secret
//      set as configured), one confirm going back to test, and the
//      reprovision flow: the fn answers 409 + needs_reprovision while the
//      venue's store or readers were set up on the current environment, and
//      the flip is retried with reprovision: true after a confirm.
//   3. Store: while the venue has no Adyen store, the Create store box with
//      the address and phone prefilled from the venue (on live the fn
//      refuses a placeholder). Once the store exists, the card scheme review
//      status and a "Request card schemes again" repair button.
//
// Props:
//   opsLocationId       ops locations.id (null when the platform row has no
//                       mapping; the fn resolves either id)
//   platformLocationId  platform locations.id
//   venueName           for the confirms and notices
//   callAdmin(action, payload) → the fn's JSON. MUST throw on a non-2xx
//                       answer with err.status and err.data set: the
//                       reprovision flow reads err.data.needs_reprovision.
//   onChanged()         optional, fired after the environment or the store
//                       changed so the host can refresh its own pills.

import { useEffect, useState, useCallback } from 'react';

const S = {
  block: { marginTop: 14, padding: '14px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)' },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' },
  desc: { fontSize: 12, color: 'var(--t3)', margin: '6px 0 0', lineHeight: 1.5 },
  input: { boxSizing: 'border-box', height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { boxSizing: 'border-box', minHeight: 34, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', borderColor: 'var(--acc)', color: '#0b0c10' },
  btnLive: { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' },
  err: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--red-b, var(--red))' },
  ok: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--grn-b, var(--grn))' },
  warn: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--orn-b, var(--bdr2))' },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  pill: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, display: 'inline-block', letterSpacing: '.06em' },
  switchTrack: { position: 'relative', width: 46, height: 26, borderRadius: 999, border: '1px solid var(--bdr2)', padding: 0, background: 'var(--bg3, var(--bdr2))', transition: 'background .15s', flexShrink: 0 },
  switchKnob: { position: 'absolute', top: 2, left: 2, width: 20, height: 20, borderRadius: 999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.35)', transition: 'transform .15s' },
};

// The environment switch. Off = test cards, on = live, real money. It only
// draws the state: the click handler decides whether a confirm box opens.
function EnvSwitch({ on, disabled, title, onToggle }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} title={title} onClick={onToggle}
      style={{
        ...S.switchTrack,
        background: on ? 'var(--red)' : 'var(--bg3, var(--bdr2))',
        borderColor: on ? 'var(--red)' : 'var(--bdr2)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}>
      <span style={{ ...S.switchKnob, transform: on ? 'translateX(20px)' : 'translateX(0)' }} />
    </button>
  );
}

// Rough split of a free text address ("9a New Street, Huddersfield, HD3 4LN")
// for the store form: the last comma part is the postcode, the one before it
// the town, the rest the street. The operator corrects it before creating.
function splitAddress(text) {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return {
    line1: parts.length >= 3 ? parts.slice(0, -2).join(', ') : parts[0],
    city: parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || ''),
    postal_code: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

const REGION_LABELS = { UK: 'United Kingdom (Adyen EU data centre)', US: 'United States' };

export default function AdyenEnvironmentControls({ opsLocationId, platformLocationId, venueName, callAdmin, onChanged }) {
  // The fn's 'environment' answer { environment, region, liveConfigured,
  // liveRegionsConfigured, testConfigured, liveMissing, canSetEnvironment,
  // canSetRegion, regionLocked, regionLockReason }. Names only, never
  // secret values. liveConfigured and liveMissing are for THIS venue's region.
  const [envInfo, setEnvInfo] = useState(null);
  const [envErr, setEnvErr] = useState('');
  const [envBusy, setEnvBusy] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);   // the "type LIVE" box is open
  const [liveTyped, setLiveTyped] = useState('');
  // The fn's 'status' answer (venue, merchant, storeId, scopeOk, scopeError,
  // venueAddress). It talks to Adyen, so it fails closed on a live venue
  // without live keys; statusErr keeps that visible next to the switch.
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  // Result of the last ensure_store / ensure_payment_methods: what was
  // requested, what Adyen refused, and whether live review applies.
  const [pmResult, setPmResult] = useState(null);
  // The store's address and phone. On live the fn refuses a placeholder.
  const [storeForm, setStoreForm] = useState({ line1: '', city: '', postal_code: '', phone: '' });

  const load = useCallback(async () => {
    // Environment first. It never touches Adyen, so it answers even when the
    // status probe below throws.
    try {
      const env = await callAdmin('environment');
      if (env?.ok) { setEnvInfo(env); setEnvErr(''); }
      else setEnvErr(env?.error || 'could not read the environment');
    } catch (e) {
      setEnvErr(e?.message || String(e));
    }
    try {
      const st = await callAdmin('status');
      setStatus(st);
      setStatusErr('');
      // Prefill the store form from the venue's own address, without
      // clobbering anything already typed.
      const parts = splitAddress(st?.venueAddress);
      if (parts) {
        setStoreForm((f) => ({
          ...f,
          line1: f.line1 || parts.line1,
          city: f.city || parts.city,
          postal_code: f.postal_code || parts.postal_code,
        }));
      }
    } catch (e) {
      setStatus(null);
      setStatusErr(e?.message || String(e));
    }
  }, [callAdmin]);
  useEffect(() => { load(); }, [load, opsLocationId, platformLocationId]);

  const isLive = envInfo?.environment === 'live';
  const name = status?.venue || venueName || 'this venue';
  // The venue's region ('UK' | 'US'). An older fn build sends none: the
  // select then shows UK (the only account before 8 Sep 2026) and stays
  // disabled until the fn is redeployed.
  const region = envInfo?.region === 'US' ? 'US' : 'UK';
  const regionKnown = !!envInfo?.region;
  const liveRegions = Array.isArray(envInfo?.liveRegionsConfigured) ? envInfo.liveRegionsConfigured : null;
  // The fn refuses everyone but a super_admin with 403; the switch is hidden
  // rather than shown dead. Older fn builds do not send the flag, so an
  // absent value keeps the switch visible.
  const canSetEnv = envInfo?.canSetEnvironment !== false;
  const canSetRegion = envInfo?.canSetRegion !== false && regionKnown;
  const regionLocked = envInfo?.regionLocked === true || isLive;
  const regionLockReason = envInfo?.regionLockReason || (isLive ? 'The venue is live. Switch it back to test cards before changing its region.' : '');

  // Move the venue between the UK and US Adyen accounts. Only while nothing
  // at Adyen belongs to it yet (the fn refuses otherwise, 409). The fn also
  // refuses 'UK' until the platform migration runs; its message names it.
  const setRegion = async (next) => {
    if (!next || next === region || regionBusy) return;
    if (!window.confirm(
      `Move ${name} to the ${next} Adyen account?\n\n`
      + `Its live keys, Checkout host and card reader endpoint all follow the region. `
      + `Live keys for ${next} are ${liveRegions ? (liveRegions.includes(next) ? 'set' : 'NOT set yet') : 'unknown'} on the server.`,
    )) return;
    setRegionBusy(true); setErr(''); setNotice('');
    try {
      const r = await callAdmin('set_region', { region: next });
      if (r.ok === false) throw new Error(r.error || 'could not change the region');
      setEnvInfo((prev) => ({ ...(prev || {}), region: r.region, liveConfigured: r.liveConfigured ?? prev?.liveConfigured, liveRegionsConfigured: r.liveRegionsConfigured ?? prev?.liveRegionsConfigured }));
      setNotice(r.unchanged ? `${name} is already on the ${r.region} account.` : `${name} is now on the ${r.region} Adyen account.`);
      if (r.warning) setErr(r.warning);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e?.data?.error || e?.message || String(e));
    }
    setRegionBusy(false);
  };

  // Flip the venue's environment through the fn, then reload so the status
  // probe runs against the new secret set. The fn REFUSES (409 +
  // needs_reprovision) while the venue's store or readers were set up on the
  // current environment: Adyen ids belong to one environment, so the flip
  // must clear them and the store and readers are set up again. That is
  // confirmed here and retried with reprovision: true.
  const setEnvironment = async (next, reprovision = false) => {
    setEnvBusy(true); setErr(''); setNotice('');
    try {
      const r = await callAdmin('set_environment', { environment: next, ...(reprovision ? { reprovision: true } : {}) });
      if (r.ok === false) throw new Error(r.error || 'could not change the environment');
      setEnvInfo((prev) => ({ ...(prev || {}), environment: r.environment, region: r.region ?? prev?.region, liveConfigured: r.liveConfigured ?? prev?.liveConfigured, liveRegionsConfigured: r.liveRegionsConfigured ?? prev?.liveRegionsConfigured }));
      setLiveConfirm(false); setLiveTyped('');
      setPmResult(null);
      setNotice(r.environment === 'live'
        ? `${name} now takes LIVE payments on the ${r.region || region} account. Real cards are charged from now on.`
        : `${name} is back on test cards. Nobody is charged.`);
      if (r.warning) setErr(r.warning);
      await load();
      onChanged?.();
    } catch (e) {
      if (e?.data?.needs_reprovision && !reprovision) {
        setEnvBusy(false);
        if (window.confirm(`${e.data.error || e.message}\n\nSwitch ${name} to ${next} anyway and set up again afterwards?`)) {
          await setEnvironment(next, true);
        }
        return;
      }
      setErr(e?.message || String(e));
    }
    setEnvBusy(false);
  };

  const onEnvToggle = () => {
    if (envBusy || !envInfo || !canSetEnv) return;
    if (isLive) {
      if (!window.confirm(
        `Switch ${name} back to test cards?\n\n`
        + 'Real cards stop working at this venue until you switch live back on. '
        + 'Payments already taken are not affected, but refunding a live payment needs live switched back on first.',
      )) return;
      setEnvironment('test');
      return;
    }
    if (!envInfo.liveConfigured) return;   // switch is disabled anyway (this region's live set is incomplete)
    setLiveConfirm((v) => !v); setLiveTyped('');
  };

  // Turn the fn's scheme answer into one line the operator can act on.
  const describeSchemes = (r, live) => ({
    requested: r?.requested || [],
    errors: r?.errors || [],
    live,
  });

  const createStore = async () => {
    setBusy('store'); setErr(''); setNotice('');
    try {
      const r = await callAdmin('ensure_store', {
        address: { line1: storeForm.line1.trim(), city: storeForm.city.trim(), postal_code: storeForm.postal_code.trim() },
        phone: storeForm.phone.trim(),
      });
      if (r.ok === false) throw new Error(r.error === 'scope_missing' ? (status?.scopeError || 'API key missing Management role') : (r.error || 'store create failed'));
      setPmResult(r.existing ? null : describeSchemes(r.paymentMethods, r.environment === 'live' || isLive));
      setNotice(r.existing ? `This venue already has a store (${r.storeId}).` : `Store created (${r.storeId})${r.reference ? ` with reference ${r.reference}` : ''}.`);
      await load();
      onChanged?.();
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  // Repair a store whose card schemes were refused or never requested (a
  // store with none refuses every payment routed through it).
  const requestSchemes = async () => {
    setBusy('pm'); setErr(''); setNotice('');
    try {
      const r = await callAdmin('ensure_payment_methods', {});
      if (r.error === 'scope_missing') throw new Error(status?.scopeError || 'API key missing Management role');
      if (r.error && !r.requested) throw new Error(r.error);
      setPmResult(describeSchemes(r, isLive));
      setNotice('Card schemes requested on the store.');
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  const storeFormComplete = !!(storeForm.line1.trim() && storeForm.city.trim() && storeForm.postal_code.trim() && storeForm.phone.trim());

  return (
    <div>
      {/* ── region: the Adyen account (UK or US) the venue is on ── */}
      {envInfo && (
        <div style={S.block}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={S.label}>Region (ServOS admin only)</div>
              <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2 }}>
                <span style={{ ...S.pill, background: 'var(--bg3, var(--bdr2))', color: 'var(--t1)', border: '1px solid var(--bdr2)', marginRight: 8 }}>{region}</span>
                {REGION_LABELS[region]}
              </div>
              <div style={{ ...S.desc, marginTop: 4 }}>
                The UK and US live accounts are different Adyen accounts. The region picks the live keys, the Checkout host,
                the card reader endpoint and the Drop-in environment for {name}.
                {liveRegions && <> Live keys are set on the server for: <span style={S.mono}>{liveRegions.length ? liveRegions.join(', ') : 'none'}</span>.</>}
              </div>
            </div>
            {canSetRegion ? (
              <select
                style={{ ...S.input, minWidth: 220, opacity: regionLocked || regionBusy ? 0.6 : 1, cursor: regionLocked ? 'not-allowed' : 'pointer' }}
                value={region}
                disabled={regionLocked || regionBusy || envBusy}
                title={regionLocked ? regionLockReason : 'Move the venue between the UK and US Adyen accounts'}
                onChange={(e) => setRegion(e.target.value)}>
                <option value="UK">UK</option>
                <option value="US">US</option>
              </select>
            ) : (
              <div style={{ ...S.desc, maxWidth: 240 }}>{regionKnown ? 'Only a ServOS super admin can change this.' : 'The server has not been updated for regions yet.'}</div>
            )}
          </div>
          {canSetRegion && regionLocked && (
            <div style={{ ...S.desc, marginTop: 8 }}>{regionLockReason}</div>
          )}
          {envInfo.storedRegion && envInfo.storedRegion !== region && (
            <div style={{ ...S.desc, marginTop: 8, color: 'var(--orn, #e8a020)' }}>
              The database still stores the old code <span style={S.mono}>{envInfo.storedRegion}</span> for this venue (read as {region}).
              It becomes {region} once the platform migration <span style={S.mono}>20260908_PLATFORM_adyen_region_uk.sql</span> is run.
            </div>
          )}
        </div>
      )}

      {/* ── environment: test cards or live, real money ── */}
      {envInfo ? (
        <div style={{ ...S.block, border: `1px solid ${isLive ? 'var(--red-b, var(--red))' : 'var(--bdr2)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={S.label}>Environment (ServOS admin only)</div>
              <div style={{ fontSize: 14, fontWeight: 800, marginTop: 2, color: isLive ? 'var(--red)' : 'var(--t1)' }}>
                {isLive ? 'LIVE, real money' : 'Test cards'}
                {regionKnown && (
                  <span style={{ ...S.pill, marginLeft: 8, verticalAlign: 'middle', background: isLive ? 'var(--red)' : 'var(--bg3, var(--bdr2))', color: isLive ? '#fff' : 'var(--t2)', border: `1px solid ${isLive ? 'var(--red)' : 'var(--bdr2)'}` }}>
                    {isLive ? `LIVE · ${region}` : `TEST · ${region}`}
                  </span>
                )}
              </div>
              <div style={{ ...S.desc, marginTop: 4 }}>
                {isLive
                  ? `Every card taken at ${name} is charged for real on the ${region} account: tills, online, table pay and bookings. Refunds and disputes are real too.`
                  : `Card payments at ${name} go to the Adyen test system. Only test cards work. Nobody is charged.`}
              </div>
            </div>
            {canSetEnv ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: isLive ? 'var(--red)' : 'var(--t3)' }}>{isLive ? 'Live' : 'Test'}</span>
                <EnvSwitch
                  on={isLive}
                  disabled={envBusy || regionBusy || (!isLive && !envInfo.liveConfigured)}
                  title={isLive ? 'Switch back to test cards' : envInfo.liveConfigured ? `Switch to live payments on the ${region} account` : `Live keys for the ${region} account are not set on the server yet`}
                  onToggle={onEnvToggle}
                />
              </div>
            ) : (
              <div style={{ ...S.desc, maxWidth: 240 }}>Only a ServOS super admin can change this.</div>
            )}
          </div>

          {canSetEnv && !isLive && !envInfo.liveConfigured && (
            <div style={{ ...S.desc, marginTop: 10, color: 'var(--orn, #e8a020)' }}>
              <b>Live keys for the {region} account are not fully set on the server yet</b>
              {Array.isArray(envInfo.liveMissing) && envInfo.liveMissing.length > 0 && (
                <> (missing: <span style={S.mono}>{envInfo.liveMissing.join(', ')}</span>)</>
              )}. The switch unlocks once they are in place.
              {liveRegions && liveRegions.length > 0 && !liveRegions.includes(region) && (
                <> Live keys are set for {liveRegions.join(', ')}; if this venue belongs there, change its region above.</>
              )}
            </div>
          )}

          {liveConfirm && !isLive && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', border: '1px solid var(--red-b, var(--red))' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)' }}>Switch {name} to live payments on the {region} account?</div>
              <div style={{ ...S.desc, marginTop: 4, color: 'var(--t2)' }}>
                From the moment you confirm, every card taken there charges the customer for real. Type <b>LIVE</b> to confirm.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  style={{ ...S.input, ...S.mono, width: 140, letterSpacing: '.1em' }}
                  value={liveTyped}
                  onChange={(e) => setLiveTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && liveTyped.trim() === 'LIVE' && !envBusy) setEnvironment('live'); }}
                  placeholder="Type LIVE" autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false}
                />
                <button style={{ ...S.btn, ...S.btnLive }}
                  disabled={envBusy || liveTyped.trim() !== 'LIVE'}
                  onClick={() => setEnvironment('live')}>
                  {envBusy ? 'Switching…' : 'Switch to live'}
                </button>
                <button style={S.btn} disabled={envBusy} onClick={() => { setLiveConfirm(false); setLiveTyped(''); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={S.block}>
          <div style={S.label}>Environment (ServOS admin only)</div>
          <div style={{ ...S.desc, marginTop: 4 }}>{envErr ? `Could not read the venue's environment: ${envErr}` : 'Reading the venue\'s environment…'}</div>
        </div>
      )}

      {/* ── store: the record Adyen keeps for the venue ── */}
      {statusErr && (
        <div style={S.err}>Could not reach Adyen for this venue: {statusErr}</div>
      )}
      {status?.ok && !status.scopeOk && <div style={S.err}>{status.scopeError}</div>}

      {status?.ok && status.scopeOk && !status.storeId && (
        <div style={S.block}>
          <div style={S.label}>Payments store (ServOS admin only)</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>Not registered yet. Create the store for {name}.</div>
          <div style={{ ...S.desc, marginTop: 4 }}>
            Terminals and payments route through a store per physical venue. This creates
            "{name}" as a store on the merchant account ({status.merchant}) and maps it to the venue.
            {isLive ? ' This is the live record Adyen keeps for the venue: check the address and phone number.' : ' On test a placeholder address is accepted.'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginTop: 10 }}>
            {[
              ['line1', 'Street address', '9a New Street'],
              ['city', 'Town or city', 'Huddersfield'],
              ['postal_code', 'Postcode', 'HD3 4LN'],
              ['phone', 'Phone number', '+44 1484 000000'],
            ].map(([key, label, ph]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={S.label}>{label}{isLive ? ' *' : ''}</span>
                <input style={S.input} value={storeForm[key]} placeholder={ph}
                  onChange={(e) => setStoreForm((f) => ({ ...f, [key]: e.target.value }))} />
              </label>
            ))}
          </div>
          <button style={{ ...S.btn, ...S.btnPrim, marginTop: 10, opacity: busy || (isLive && !storeFormComplete) ? 0.6 : 1 }}
            disabled={!!busy || (isLive && !storeFormComplete)}
            onClick={createStore}>
            {busy === 'store' ? 'Creating…' : `Create store for ${name}`}
          </button>
        </div>
      )}

      {status?.ok && status.storeId && (
        <div style={S.block}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={S.label}>Payments store</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>
                Registered: <span style={S.mono}>{status.storeId}</span>
                <span style={{ fontWeight: 400, color: 'var(--t3)' }}> on {status.merchant}</span>
              </div>
              <div style={{ ...S.desc, marginTop: 4 }}>
                A store with no approved card schemes refuses every payment routed through it.
                {isLive ? ' On live Adyen reviews the schemes before the store can take cards; check the Customer Area.' : ' On test they are approved straight away.'}
              </div>
            </div>
            <button style={S.btn} disabled={!!busy} title="Ask Adyen for the card schemes on this venue's store again"
              onClick={requestSchemes}>
              {busy === 'pm' ? 'Requesting…' : 'Request card schemes again'}
            </button>
          </div>
        </div>
      )}

      {pmResult && (
        <div style={pmResult.errors.length ? S.warn : S.ok}>
          {pmResult.requested.length ? `Card schemes requested: ${pmResult.requested.join(', ')}.` : 'No card schemes were requested.'}
          {pmResult.live ? ' Adyen must approve them before this store can take cards.' : ''}
          {pmResult.errors.length ? ` Refused: ${pmResult.errors.join('; ')}. Fix the cause, then use "Request card schemes again".` : ''}
        </div>
      )}

      {err && <div style={S.err}>{err}</div>}
      {notice && <div style={S.ok}>{notice}</div>}
    </div>
  );
}
