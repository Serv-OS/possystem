// src/admin/components/AdyenEnvironmentControls.jsx
//
// ServOS admin portal (?mode=admin): the per venue Adyen REGION and
// ENVIRONMENT controls, extracted from the venue Back Office panel
// (src/backoffice/sections/AdyenTerminals.jsx) on 8 Sep 2026 and made
// compact the same day (one line: region select, environment switch).
//
// OWNER RULE (8 Sep 2026): a venue must not move itself between test cards
// and live, create its Adyen store or request its card schemes. Those are
// ServOS internal actions, so they render HERE, in the admin portal, and the
// adyen-terminal-admin fn refuses set_environment, set_region, ensure_store
// and ensure_payment_methods for anyone but a platform super_admin (the
// caller's user_profiles.role, the same lookup adyen-onboard fences on). The
// venue's Back Office shows the state only.
//
// Renders, in one compact block:
//   1. Region: UK or US, the Adyen account the venue is on. The UK and US
//      live accounts are different accounts (keys, Checkout host, Terminal
//      API host, Drop-in environment). The select is disabled while the
//      venue is live or already holds a store or readers (the fn's
//      regionLocked). It calls set_region; until the platform migration
//      20260908_PLATFORM_adyen_region_uk.sql runs the fn refuses 'UK' with a
//      message naming it, shown as is.
//   2. Environment: the state and the switch on the same line, the typed
//      LIVE confirm when going live (only offered while the server reports
//      THIS region's live secret set as configured), one confirm going back
//      to test, and the reprovision flow: the fn answers 409 +
//      needs_reprovision while the venue's store or readers were set up on
//      the current environment, and the flip is retried with reprovision:
//      true after a confirm.
//   3. Readers: how many card readers the venue has on this account (the
//      fn's cheap `environment` answer, no Adyen call) and what is set up.
//   4. Web origins and Apple Pay: one button that runs register_origins and
//      register_apple_pay_domains and lists what was added, what was there
//      already and what Adyen refused. The fn also runs both when a venue
//      is switched to live and the answer lands in the same list.
//   5. Store: the mapped store id and the "Request card schemes again"
//      repair once a store exists. Creating or finding the store is Link to
//      Adyen's job (AdyenLinkPanel, pull by reference), so no create form
//      lives here any more.
//
// Props:
//   opsLocationId       ops locations.id (null when the platform row has no
//                       mapping; the fn resolves either id)
//   platformLocationId  platform locations.id
//   venueName           for the confirms and notices
//   callAdmin(action, payload) => the fn's JSON. MUST throw on a non-2xx
//                       answer with err.status and err.data set: the
//                       reprovision flow reads err.data.needs_reprovision.
//   onChanged()         optional, fired after the environment or the region
//                       changed so the host can refresh its own pills.
//   refreshKey          optional, bump it to make the block re-read the fn
//                       (the host does so after a link).

import { useEffect, useState, useCallback } from 'react';
import { registrationLines } from '../../lib/payments/adyenOrigins';

const S = {
  block: { marginTop: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)' },
  label: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' },
  desc: { fontSize: 12, color: 'var(--t3)', margin: '6px 0 0', lineHeight: 1.5 },
  input: { boxSizing: 'border-box', height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { boxSizing: 'border-box', minHeight: 32, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', borderColor: 'var(--acc)', color: '#0b0c10' },
  btnLive: { background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' },
  err: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--red-d, rgba(255,90,74,.1))', color: 'var(--red)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--red-b, var(--red))' },
  ok: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--grn-d, rgba(21,194,106,.1))', color: 'var(--grn)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--grn-b, var(--grn))' },
  warn: { marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--orn-d, rgba(230,160,60,.12))', color: 'var(--orn, #e8a020)', fontSize: 12, lineHeight: 1.5, border: '1px solid var(--orn-b, var(--bdr2))' },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  pill: { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, display: 'inline-block', letterSpacing: '.06em' },
  cell: { display: 'flex', flexDirection: 'column', gap: 4 },
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

// One registration answer from the fn ({ added, existing, failed, error,
// note }) as a titled list: added in green, already there in plain text,
// each refusal in red with Adyen's status and message.
const LINE_TONES = { ok: 'var(--grn)', info: 'var(--t2)', warn: 'var(--orn, #e8a020)', err: 'var(--red)' };
function RegistrationLines({ title, result }) {
  const lines = registrationLines(result);
  if (!lines.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--t1)' }}>{title}</div>
      <ul style={{ margin: '3px 0 0', paddingLeft: 18 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: LINE_TONES[l.tone] || 'var(--t2)', wordBreak: 'break-word' }}>{l.text}</li>
        ))}
      </ul>
    </div>
  );
}

const PROVISIONED_LABELS = {
  store_id: 'store', legal_entity_id: 'legal entity', account_holder_id: 'account holder', balance_account_id: 'balance account',
  split_profile_id: 'split configuration', transfer_instrument_id: 'bank account', business_line_id: 'business line',
};

export default function AdyenEnvironmentControls({ opsLocationId, platformLocationId, venueName, callAdmin, onChanged, refreshKey = 0 }) {
  // The fn's 'environment' answer { environment, region, liveConfigured,
  // liveRegionsConfigured, testConfigured, liveMissing, canSetEnvironment,
  // canSetRegion, regionLocked, regionLockReason, provisioned, readers }.
  // Names only, never secret values. liveConfigured and liveMissing are
  // for THIS venue's region.
  const [envInfo, setEnvInfo] = useState(null);
  const [envErr, setEnvErr] = useState('');
  const [envBusy, setEnvBusy] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState(false);   // the "type LIVE" box is open
  const [liveTyped, setLiveTyped] = useState('');
  // The fn's 'status' answer (venue, merchant, storeId, scopeOk, scopeError).
  // It talks to Adyen, so it fails closed on a live venue without live keys;
  // statusErr keeps that visible next to the switch.
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  // Result of the last ensure_payment_methods: what was requested, what
  // Adyen refused, and whether live review applies.
  const [pmResult, setPmResult] = useState(null);
  // The last register_origins / register_apple_pay_domains answers (from the
  // button, or from set_environment's web_origins / apple_pay_domains when
  // the venue was just switched to live).
  const [domainsBusy, setDomainsBusy] = useState(false);
  const [domainsResult, setDomainsResult] = useState(null);

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
    } catch (e) {
      setStatus(null);
      setStatusErr(e?.message || String(e));
    }
  }, [callAdmin]);
  useEffect(() => { load(); }, [load, opsLocationId, platformLocationId, refreshKey]);

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
  const readers = Number(envInfo?.readers) || 0;
  const provisioned = Array.isArray(envInfo?.provisioned) ? envInfo.provisioned : [];

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
      // A move to live registers the web origins and Apple Pay domains by
      // itself; show what happened in the same list the button fills.
      if (r.web_origins || r.apple_pay_domains) setDomainsResult({ origins: r.web_origins || null, applePay: r.apple_pay_domains || null });
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

  // Repair a store whose card schemes were refused or never requested (a
  // store with none refuses every payment routed through it).
  const requestSchemes = async () => {
    setBusy('pm'); setErr(''); setNotice('');
    try {
      const r = await callAdmin('ensure_payment_methods', {});
      if (r.error === 'scope_missing') throw new Error(status?.scopeError || 'API key missing Management role');
      if (r.error && !r.requested) throw new Error(r.error);
      setPmResult({ requested: r?.requested || [], errors: r?.errors || [], live: isLive });
      setNotice('Card schemes requested on the store.');
    } catch (e) { setErr(e?.message || String(e)); }
    setBusy('');
  };

  // Put the ServOS hosts on the venue's API credential and the venue's
  // storefront on the merchant's Apple Pay method. Two calls, each caught on
  // its own so a refused one never hides the other's lines. The fn answers
  // 200 with ok false and the detail on an Adyen refusal; a thrown answer
  // (403 for a venue role, 500 for a live venue without keys) becomes the
  // error line of that half.
  const registerDomains = async () => {
    setDomainsBusy(true); setErr(''); setNotice('');
    const run = async (action) => {
      try { return await callAdmin(action, {}); }
      catch (e) { return { ok: false, error: e?.data?.error || e?.message || String(e) }; }
    };
    const origins = await run('register_origins');
    const applePay = await run('register_apple_pay_domains');
    setDomainsResult({ origins, applePay });
    setDomainsBusy(false);
  };

  if (!envInfo) {
    return (
      <div style={S.block}>
        <div style={S.label}>Environment (ServOS admin only)</div>
        <div style={{ ...S.desc, marginTop: 4 }}>{envErr ? `Could not read the venue's environment: ${envErr}` : 'Reading the venue\'s environment…'}</div>
      </div>
    );
  }

  const setupWords = provisioned.map((k) => PROVISIONED_LABELS[k] || k);

  return (
    <div>
      {/* ── region select and environment switch, one line ── */}
      <div style={{ ...S.block, border: `1px solid ${isLive ? 'var(--red-b, var(--red))' : 'var(--bdr2)'}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <div style={S.cell}>
            <span style={S.label}>Region</span>
            {canSetRegion ? (
              <select
                style={{ ...S.input, minWidth: 110, opacity: regionLocked || regionBusy ? 0.6 : 1, cursor: regionLocked ? 'not-allowed' : 'pointer' }}
                value={region}
                disabled={regionLocked || regionBusy || envBusy}
                title={regionLocked ? regionLockReason : 'Move the venue between the UK and US Adyen accounts'}
                onChange={(e) => setRegion(e.target.value)}>
                <option value="UK">UK</option>
                <option value="US">US</option>
              </select>
            ) : (
              <span style={{ ...S.pill, background: 'var(--bg3, var(--bdr2))', color: 'var(--t1)', border: '1px solid var(--bdr2)', height: 32, lineHeight: '26px', boxSizing: 'border-box' }}
                title={regionKnown ? 'Only a ServOS super admin can change this.' : 'The server has not been updated for regions yet.'}>
                {region}
              </span>
            )}
          </div>
          <div style={S.cell}>
            <span style={S.label}>Environment</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 32 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: isLive ? 'var(--red)' : 'var(--t1)' }}>
                {isLive ? 'LIVE, real money' : 'Test cards'}
              </span>
              {canSetEnv ? (
                <EnvSwitch
                  on={isLive}
                  disabled={envBusy || regionBusy || (!isLive && !envInfo.liveConfigured)}
                  title={isLive ? 'Switch back to test cards' : envInfo.liveConfigured ? `Switch to live payments on the ${region} account` : `Live keys for the ${region} account are not set on the server yet`}
                  onToggle={onEnvToggle}
                />
              ) : (
                <span style={{ fontSize: 11, color: 'var(--t3)' }}>Only a ServOS super admin can change this.</span>
              )}
            </div>
          </div>
          <div style={S.cell}>
            <span style={S.label}>Readers</span>
            <div style={{ fontSize: 13, minHeight: 32, display: 'flex', alignItems: 'center', color: readers ? 'var(--t1)' : 'var(--t3)' }}
              title="Card readers paired at this venue on this Adyen account (payment_devices, not retired)">
              {readers ? `${readers} card reader${readers === 1 ? '' : 's'}` : 'No card readers'}
            </div>
          </div>
          <div style={{ ...S.cell, flex: '1 1 200px', minWidth: 0 }}>
            <span style={S.label}>Set up on this account</span>
            <div style={{ fontSize: 12, minHeight: 32, display: 'flex', alignItems: 'center', color: setupWords.length ? 'var(--t2)' : 'var(--t3)' }}>
              {setupWords.length ? setupWords.join(', ') : 'nothing yet'}
            </div>
          </div>
        </div>

        <div style={{ ...S.desc, marginTop: 6 }}>
          {isLive
            ? `Every card taken at ${name} is charged for real on the ${region} account: tills, online, table pay and bookings. Refunds and disputes are real too.`
            : `Card payments at ${name} go to the Adyen test system. Only test cards work. Nobody is charged.`}
          {liveRegions && <> Live keys are set on the server for: <span style={S.mono}>{liveRegions.length ? liveRegions.join(', ') : 'none'}</span>.</>}
        </div>

        {canSetRegion && regionLocked && !isLive && (
          <div style={{ ...S.desc, marginTop: 6 }}>{regionLockReason}</div>
        )}
        {envInfo.storedRegion && envInfo.storedRegion !== region && (
          <div style={{ ...S.desc, marginTop: 6, color: 'var(--orn, #e8a020)' }}>
            The database still stores the old code <span style={S.mono}>{envInfo.storedRegion}</span> for this venue (read as {region}).
            It becomes {region} once the platform migration <span style={S.mono}>20260908_PLATFORM_adyen_region_uk.sql</span> is run.
          </div>
        )}
        {canSetEnv && !isLive && !envInfo.liveConfigured && (
          <div style={{ ...S.desc, marginTop: 6, color: 'var(--orn, #e8a020)' }}>
            <b>Live keys for the {region} account are not fully set on the server yet</b>
            {Array.isArray(envInfo.liveMissing) && envInfo.liveMissing.length > 0 && (
              <> (missing: <span style={S.mono}>{envInfo.liveMissing.join(', ')}</span>)</>
            )}. The switch unlocks once they are in place.
            {liveRegions && liveRegions.length > 0 && !liveRegions.includes(region) && (
              <> Live keys are set for {liveRegions.join(', ')}; if this venue belongs there, change its region.</>
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

        {/* ── store and card schemes: one line each ── */}
        {statusErr && <div style={S.err}>Could not reach Adyen for this venue: {statusErr}</div>}
        {status?.ok && !status.scopeOk && <div style={S.err}>{status.scopeError}</div>}
        {status?.ok && status.scopeOk && !status.storeId && (
          <div style={{ ...S.desc, marginTop: 10 }}>
            <b style={{ color: 'var(--t2)' }}>No payments store mapped yet.</b> Link to Adyen (above) finds the venue&rsquo;s store by its reference, or creates it with that reference.
          </div>
        )}
        {status?.ok && status.storeId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <div style={{ flex: '1 1 240px', minWidth: 0, fontSize: 12.5 }}>
              <b style={{ color: 'var(--t2)' }}>Store</b> <span style={S.mono}>{status.storeId}</span>
              <span style={{ color: 'var(--t3)' }}> on {status.merchant}. {isLive ? 'Adyen reviews the card schemes on live before the store can take cards.' : 'Card schemes are approved straight away on test.'}</span>
            </div>
            <button style={S.btn} disabled={!!busy} title="Ask Adyen for the card schemes on this venue's store again (a store with none refuses every payment)"
              onClick={requestSchemes}>
              {busy === 'pm' ? 'Requesting…' : 'Request card schemes again'}
            </button>
          </div>
        )}
        {pmResult && (
          <div style={pmResult.errors.length ? S.warn : S.ok}>
            {pmResult.requested.length ? `Card schemes requested: ${pmResult.requested.join(', ')}.` : 'No card schemes were requested.'}
            {pmResult.live ? ' Adyen must approve them before this store can take cards.' : ''}
            {pmResult.errors.length ? ` Refused: ${pmResult.errors.join('; ')}. Fix the cause, then use "Request card schemes again".` : ''}
          </div>
        )}

        {/* ── web origins and Apple Pay: one line and a button ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0, fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--t2)' }}>Web origins and Apple Pay.</b> Puts the ServOS hosts and the <span style={S.mono}>*.serv-os.app</span> wildcards on the {region} {isLive ? 'live' : 'test'} API credential
            and {name}&rsquo;s storefront addresses on the merchant&rsquo;s Apple Pay method. Safe to run again; runs by itself on a switch to live and on a link.
          </div>
          {canSetEnv ? (
            <button style={{ ...S.btn, opacity: domainsBusy || envBusy ? 0.6 : 1 }}
              disabled={domainsBusy || envBusy || regionBusy}
              title="Register the ServOS web origins on this venue's API credential and its storefront domains for Apple Pay"
              onClick={registerDomains}>
              {domainsBusy ? 'Registering…' : 'Register origins and Apple Pay'}
            </button>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--t3)' }}>Only a ServOS super admin can run this.</span>
          )}
        </div>
        {domainsResult && (
          <>
            <RegistrationLines
              title={['Web origins', domainsResult.origins?.region ? `on the ${[domainsResult.origins.region, domainsResult.origins.environment].filter(Boolean).join(' ')} credential` : ''].filter(Boolean).join(' ')}
              result={domainsResult.origins}
            />
            <RegistrationLines
              title={['Apple Pay domains', domainsResult.applePay?.merchant ? `on ${domainsResult.applePay.merchant}` : ''].filter(Boolean).join(' ')}
              result={domainsResult.applePay}
            />
          </>
        )}

        {err && <div style={S.err}>{err}</div>}
        {notice && <div style={S.ok}>{notice}</div>}
      </div>
    </div>
  );
}
