// src/backoffice/sections/PaxTerminals.jsx
//
// "Terminals running the ServOS app" — pair a card terminal that runs our own
// app to this location by claim code, see whether it is online, and configure
// what it does. Self-contained and self-gating — it renders nothing until it
// knows there is something to show.
//
// TWO KINDS OF HARDWARE LAND HERE and they behave identically: a PAX terminal
// running :paxpay, and (from v5.6.81) an Adyen Android terminal such as the
// S1F2L running MPOS. Readers that run the MANUFACTURER's own software — AMS1
// and friends — cannot be paired by code and are deliberately filtered out of
// this panel; they are registered by serial in the sibling AdyenTerminals
// panel, which also owns their till binding, modes and tipping. See the
// last_seen_at note on the query in load() for why that is the honest filter.
//
// The terminal shows a code on its own screen; a manager types that code here.
// That is the whole pairing ceremony: the code is a capability you have to be
// physically standing in front of the device to read.
//
// SECURITY NOTE — nothing on this screen writes location_id, and nothing on this
// screen writes terminal_devices directly. terminal_devices has NO INSERT and NO
// UPDATE POLICY at all (every anonymous kiosk/QR/online session in this system
// holds a valid auth.uid(), so a permissive policy on a payments table would be
// unbounded public write access). Both writers are SECURITY DEFINER RPCs that
// validate the manager's access server-side:
//   claim_terminal_device(...)  — pairing; the only writer of location_id
//   set_terminal_settings(...)  — everything on this screen
// A supabase.from('terminal_devices').update(...) here would silently affect 0 rows.

import { useEffect, useState } from 'react';
import { supabase, platformSupabase, getActiveLocationSync } from '../../lib/supabase';

const S = {
  card:    { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:24, marginBottom:20 },
  h2:      { fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:4 },
  desc:    { fontSize:12, color:'var(--t4)', marginBottom:16, lineHeight:1.6 },
  label:   { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input:   { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  btn:     { padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrim: { background:'var(--acc)', color:'#0b0c10' },
  btnGhost:{ background:'transparent', color:'var(--t2)', border:'1px solid var(--bdr)' },
  btnDan:  { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  err:     { padding:10, background:'var(--red-d)', color:'var(--red)', borderRadius:8, fontSize:12, border:'1px solid var(--red-b)', marginTop:10 },
  ok:      { padding:10, background:'var(--bg2)', color:'var(--grn)', borderRadius:8, fontSize:12, border:'1px solid var(--bdr)', marginTop:10 },
  pill:    { fontSize:11, padding:'2px 8px', borderRadius:99, background:'var(--bg3)', color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.05em', fontWeight:700, border:'1px solid var(--bdr)' },
  mono:    { fontFamily:'var(--font-mono, monospace)' },
  sub:     { fontSize:11, color:'var(--t4)', marginTop:6, lineHeight:1.5 },
  box:     { padding:12, background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, marginBottom:12 },
  fieldset:{ marginTop:18, paddingTop:16, borderTop:'1px solid var(--bdr)' },
  legend:  { fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 },
};

/** Online if we've heard from it in the last two minutes (heartbeat is ~30s). */
function onlineState(lastSeenAt) {
  if (!lastSeenAt) return { online:false, text:'Never seen' };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < 2 * 60_000) return { online:true, text:'Online' };
  const mins = Math.round(age / 60_000);
  if (mins < 60) return { online:false, text:`Last seen ${mins}m ago` };
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return { online:false, text:`Last seen ${hrs}h ago` };
  return { online:false, text:`Last seen ${new Date(lastSeenAt).toLocaleDateString()}` };
}

// v5.5.838: the tip shape written onto terminal_devices.tip_config.
//
// REUSED, NOT REINVENTED. These are the same three controls, the same defaults
// and the same wording as the Stripe reader's tipping block (Card readers →
// "Reader settings"): an on/off, up to five percentage bands, and a custom-amount
// flag. A manager who has configured tipping once should not have to learn a
// second vocabulary for a second bit of hardware.
//
// The RPC normalises whatever we send into BOTH spellings the terminal parses
// ("percentBands"/"enabled" and "tip_percentages"/"tipping_enabled"), so this
// object is the editor's shape, not the wire shape.
const TIP_DEFAULTS = { enabled: true, percentages: [15, 18, 20], allowCustom: true };

/** NULL modes means every mode is on — see the column comment in 20260723. */
function modesOf(t) {
  const m = t?.modes || {};
  return {
    table_pay:    m.table_pay    !== false,
    manual:       m.manual       !== false,
    pos_dispatch: m.pos_dispatch !== false,
  };
}

function tipOf(t) {
  const c = t?.tip_config;
  if (!c || typeof c !== 'object') return { ...TIP_DEFAULTS, enabled: false };
  const pcts = Array.isArray(c.percentBands) ? c.percentBands
             : Array.isArray(c.tip_percentages) ? c.tip_percentages
             : Array.isArray(c.percentages) ? c.percentages
             : TIP_DEFAULTS.percentages;
  return {
    enabled:     c.enabled ?? c.tipping_enabled ?? false,
    percentages: pcts.length ? pcts : TIP_DEFAULTS.percentages,
    allowCustom: c.allowCustom ?? c.allow_custom ?? true,
  };
}

export default function PaxTerminals() {
  const [locationId, setLocationId] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [posDevices, setPosDevices] = useState([]);
  const [venueIdleImage, setVenueIdleImage] = useState(null);   // shared with the Stripe reader idle screen
  // v5.5.839: the PLATFORM DB's own id for this venue (locations.ops_location_id -> id).
  // location_reader_settings lives in the Platform DB and its FK points at THAT id.
  const [platformLocId, setPlatformLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);   // which terminal's settings are expanded

  const load = async () => {
    setError('');
    try {
      const locId = getActiveLocationSync();
      if (!locId || locId === 'loc-demo') { setLoading(false); return; }
      setLocationId(locId);
      // RLS scopes this to the manager's own locations — no filter can widen it.
      //
      // ONLY TERMINALS THAT RUN OUR APP, and last_seen_at is the signal.
      //
      // It is the only candidate that is true from the first instant a device
      // exists: register_terminal_device() stamps last_seen_at = now() on the row
      // it INSERTS, before any heartbeat and before a manager can even type the
      // code (claim_terminal_device refuses a row whose last_seen_at/created_at is
      // over 30 minutes old). So a genuine app terminal is never invisible here,
      // not even seconds after it first showed its code.
      //
      // A cloud-only reader (AMS1) is minted by adyen-terminal-admin's 'assign'
      // action with a SYNTHESIZED device_uid that no physical device can ever
      // authenticate as, so nothing can ever write last_seen_at on it and it stays
      // null for life. It is fully managed in the Adyen panel above.
      //
      // Rejected: app_version — register_terminal_device takes it as an optional
      // argument, so a row can legitimately have none.
      // Rejected: "adyen_terminal_id is null" — an S1F2L running MPOS carries BOTH
      // an Adyen POIID and our app, and that is precisely the device this panel
      // exists to pair. That filter would hide exactly the wrong one.
      const { data, error: e } = await supabase
        .from('terminal_devices')
        .select('id, label, serial_number, status, active, app_version, last_seen_at, claimed_at, bound_pos_device_id, tip_config, modes, idle_screen')
        .eq('location_id', locId)
        .neq('status', 'retired')
        .not('last_seen_at', 'is', null)
        .order('claimed_at', { ascending: false });
      if (e) throw new Error(e.message);
      setTerminals(data || []);

      // The devices this terminal can be assigned to. POS tills AND kiosks
      // (v5.5.884 — a kiosk sends card payments to its assigned PAX via the same
      // terminal-jobs path; set_terminal_settings accepts both types now). KDS
      // and other device types stay excluded — they have no payment flow.
      const { data: devs } = await supabase
        .from('devices')
        .select('id, name, type')
        .eq('location_id', locId)
        .in('type', ['pos', 'kiosk'])
        .order('name');
      setPosDevices(devs || []);

      // v5.5.838: the venue's idle-screen image, shared with the Stripe reader
      // screensaver (Card readers → "Idle screen / screensaver"). It lives on
      // location_reader_settings in the PLATFORM DB; the terminal app can only
      // reach the Ops project, so Back Office mirrors the URL onto the terminal row.
      //
      // v5.5.839: the Platform DB has its OWN location ids — the Ops id is stored
      // there as locations.ops_location_id. Passing the Ops id straight through
      // violated location_reader_settings_location_id_fkey and the save failed.
      // Same ops→platform hop as BackOfficeApp.jsx:1153 and Challenge21.jsx:100.
      if (platformSupabase) {
        const { data: ploc } = await platformSupabase
          .from('locations').select('id').eq('ops_location_id', locId).maybeSingle();
        setPlatformLocId(ploc?.id || null);
        if (ploc?.id) {
          const { data: rs } = await platformSupabase
            .from('location_reader_settings')
            .select('idle_screen_image_url')
            .eq('location_id', ploc.id)
            .maybeSingle();
          setVenueIdleImage(rs?.idle_screen_image_url || null);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  // Heartbeats land every ~30s; refresh the "online" column so it isn't lying.
  // Skip while a settings panel is open — a reload underneath an editor would
  // throw away whatever the manager is halfway through typing.
  useEffect(() => {
    const t = setInterval(() => { if (!openId) load(); }, 30_000);
    return () => clearInterval(t);
  }, [openId]);

  const pair = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: e } = await supabase.rpc('claim_terminal_device', {
        p_claim_code: code.trim(),
        p_location_id: locationId,      // validated server-side against user_locations
        p_label: label.trim() || null,
      });
      if (e) throw new Error(e.message);
      if (!data?.ok) throw new Error('Pairing did not complete — try the code again.');
      setCode(''); setLabel('');
      setNotice('Card terminal paired. It should show this venue within a few seconds.');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // v5.5.840: RETIRE, don't delete. A hard delete failed the moment the terminal
  // had taken a single payment —
  //   "violates foreign key constraint terminal_jobs_target_terminal_id_fkey"
  // — because terminal_jobs.target_terminal_id is NOT NULL and points here.
  // Deleting is the wrong verb anyway: it would orphan the audit trail of real
  // money. retire_terminal_device() sets status='retired', which frees the
  // serial for re-pairing (the unique indexes are partial, WHERE status='paired')
  // and keeps every job row.
  const retire = async (t) => {
    if (!confirm(`Unpair "${t.label || t.serial_number}"? It stops taking payments for this venue and will show a fresh pairing code. Its payment history is kept.`)) return;
    setError('');
    try {
      const { data, error: e } = await supabase.rpc('retire_terminal_device', { p_terminal_id: t.id });
      if (e) throw new Error(e.message);
      if (data && data.ok === false) throw new Error(data.error || 'Could not unpair.');
      setNotice('Terminal unpaired. Its payment history has been kept.');
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  // v5.5.840: the escape hatch. An abandoned payment leaves a job in a live
  // state and the terminal then refuses every new one — "this terminal is
  // already taking a payment" — with no way out but hand-written SQL. That is
  // not something a venue can do mid-service.
  //
  // Releasing a quarantined ('unknown') job is a JUDGEMENT: it means nobody can
  // prove whether a card was charged, and a person is asserting it is safe to
  // move on. The RPC records who and when, so the assertion is auditable.
  const release = async (t) => {
    if (!confirm(
      `Release "${t.label || t.serial_number}"?\n\n` +
      `Use this if the terminal says a payment is already in progress but nothing is happening.\n\n` +
      `If a payment could not be confirmed, releasing it means you are satisfied the customer was NOT charged. ` +
      `Check your card statement first if you are unsure. This is recorded against your name.`
    )) return;
    setError('');
    try {
      const { data, error: e } = await supabase.rpc('release_terminal_jobs', { p_terminal_id: t.id, p_note: null });
      if (e) throw new Error(e.message);
      const n = (data?.expired || 0) + (data?.released || 0);
      setNotice(n ? `Released ${n} stuck payment${n === 1 ? '' : 's'}. The terminal can take payments again.`
                  : 'Nothing was stuck on this terminal.');
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return null;
  if (!locationId) return null;

  return (
    <div style={S.card}>
      <div style={S.h2}>🧾 Terminals running the ServOS app</div>
      <div style={S.desc}>
        Card terminals that run our own app on their own screen. The terminal shows a pairing code,
        type it in below. Once paired it can pull up an open table, take the whole bill and close it,
        and a till can send a payment straight to it.
        <br />
        Readers that run the manufacturer&apos;s own software, such as the Adyen AMS1, have no code to
        type. Add those by serial number under Adyen card terminals above.
      </div>

      {terminals.length > 0 && (
        <div style={{ border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden', marginBottom:16 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1fr auto', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.04em', padding:'9px 14px', background:'var(--bg2)' }}>
            <div>Terminal</div><div>Serial</div><div>Status</div><div></div>
          </div>
          {terminals.map(t => {
            const st = onlineState(t.last_seen_at);
            const till = posDevices.find(d => d.id === t.bound_pos_device_id);
            const m = modesOf(t);
            const modeSummary = [
              m.table_pay ? 'Table Pay' : null,
              m.manual ? 'Manual' : null,
              m.pos_dispatch ? 'Send from POS' : null,
            ].filter(Boolean);
            return (
              <div key={t.id} style={{ borderTop:'1px solid var(--bdr)' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1fr auto', fontSize:13, padding:'10px 14px', alignItems:'center' }}>
                  <div>
                    <div style={{ color:'var(--t1)', fontWeight:600 }}>{t.label || 'Card terminal'}</div>
                    <div style={{ fontSize:11, color:'var(--t4)' }}>
                      {t.app_version ? `App ${t.app_version}` : 'Version unknown'}
                      {' · '}
                      {till ? `Till: ${till.name}` : 'Not assigned to a till'}
                    </div>
                    <div style={{ fontSize:11, color:'var(--t4)' }}>
                      {modeSummary.length ? modeSummary.join(' · ') : 'No payment modes enabled'}
                      {(tipOf(t).enabled ? ' · Tipping on' : ' · Tipping off')}
                    </div>
                  </div>
                  <div style={{ ...S.mono, color:'var(--t2)', fontSize:12 }}>{t.serial_number || '—'}</div>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <span style={{
                      width:8, height:8, borderRadius:'50%', flexShrink:0,
                      background: st.online ? 'var(--grn)' : 'var(--t4)',
                    }} />
                    <span style={{ fontSize:12, color: st.online ? 'var(--grn)' : 'var(--t3)' }}>{st.text}</span>
                  </div>
                  <div style={{ textAlign:'right', display:'flex', gap:6, justifyContent:'flex-end' }}>
                    <button
                      onClick={() => setOpenId(openId === t.id ? null : t.id)}
                      style={{ ...S.btn, ...S.btnGhost, padding:'5px 10px', fontSize:12 }}
                    >
                      {openId === t.id ? 'Close' : 'Settings'}
                    </button>
                    {/* v5.5.840: sits next to Unpair because that is where you go
                        when the terminal is misbehaving. Ghost, not danger — it
                        recovers a stuck terminal, it does not destroy anything. */}
                    <button onClick={() => release(t)}
                            title="Use if the terminal says a payment is already in progress but nothing is happening"
                            style={{ ...S.btn, ...S.btnGhost, padding:'5px 10px', fontSize:12 }}>Release stuck payment</button>
                    <button onClick={() => retire(t)} style={{ ...S.btn, ...S.btnDan, padding:'5px 10px', fontSize:12 }}>Unpair</button>
                  </div>
                </div>
                {openId === t.id && (
                  <TerminalSettings
                    key={`${t.id}:${t.claimed_at}`}
                    terminal={t}
                    posDevices={posDevices}
                    locationId={locationId}
                    platformLocId={platformLocId}
                    venueIdleImage={venueIdleImage}
                    onVenueIdleImage={setVenueIdleImage}
                    onSaved={async () => { await load(); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {terminals.length === 0 && (
        <div style={{ padding:'16px 14px', border:'1px dashed var(--bdr)', borderRadius:10, background:'var(--bg2)', marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:4 }}>
            No terminals running the ServOS app here yet
          </div>
          <div style={{ fontSize:12, color:'var(--t4)', lineHeight:1.6 }}>
            Switch the terminal on and open the app. It shows a pairing code on its own screen. Type
            that code in below and it is bound to this venue.
            <br />
            Setting up an Adyen reader that runs Adyen&apos;s own software? There is no code to type.
            Register it by serial number under Adyen card terminals above.
          </div>
        </div>
      )}

      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10, padding:16 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:12 }}>Pair a terminal</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div>
            <label style={S.label}>Pairing code</label>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter' && code.trim()) pair(); }}
              placeholder="e.g. 4F2A9C81BE"
              maxLength={16}
              style={{ ...S.input, ...S.mono, letterSpacing:'.12em' }}
            />
          </div>
          <div>
            <label style={S.label}>Name it (optional)</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Handheld 1" style={S.input} />
          </div>
        </div>
        <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <button onClick={pair} disabled={busy || !code.trim()} style={{ ...S.btn, ...S.btnPrim }}>
            {busy ? 'Pairing…' : 'Pair terminal'}
          </button>
          <button onClick={load} disabled={busy} style={{ ...S.btn, ...S.btnGhost }}>↻ Refresh</button>
          <span style={{ fontSize:11, color:'var(--t4)' }}>
            Codes expire 30 minutes after the terminal was last online — restart it for a fresh one.
          </span>
        </div>
      </div>

      {notice && <div style={S.ok}>{notice}</div>}
      {error && <div style={S.err}>{error}</div>}
    </div>
  );
}

// ─── Per-terminal settings ────────────────────────────────────────────────────
// v5.5.838. Every save goes through set_terminal_settings, which is a WHOLE
// SETTINGS WRITE — so this editor always sends the complete set, never a patch.
//
// FAILURES ARE LOUD. A silent save is what made "tipping is off" invisible for a
// day: the panel appeared to work, the row never changed. Both the RPC error and
// the "0 rows / no ok" case surface as red text that does not clear itself.
function TerminalSettings({ terminal, posDevices, locationId, platformLocId, venueIdleImage, onVenueIdleImage, onSaved }) {
  const initTip = tipOf(terminal);
  const initModes = modesOf(terminal);

  const [tipEnabled, setTipEnabled] = useState(initTip.enabled);
  const [tipPcts, setTipPcts]       = useState(initTip.percentages);
  const [allowCustom, setAllowCustom] = useState(initTip.allowCustom);
  const [boundTill, setBoundTill]   = useState(terminal.bound_pos_device_id || '');
  const [modes, setModes]           = useState(initModes);
  const [name, setName]             = useState(terminal.label || '');
  const [ssEnabled, setSsEnabled]   = useState(!!terminal.idle_screen?.enabled);
  const [ssImage, setSsImage]       = useState(terminal.idle_screen?.imageUrl || venueIdleImage || null);
  const [ssUploading, setSsUploading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const [ok, setOk]         = useState('');

  const setMode = (k, v) => setModes(m => ({ ...m, [k]: v }));

  // Upload straight to the PUBLIC kiosk-assets bucket, the same pattern
  // KioskSettings and DeviceProfiles use. Public-bucket objects are served from
  // /storage/v1/object/public/… which does NOT consult storage RLS, so the
  // terminal app can fetch the image over plain HTTPS with no session at all.
  const uploadIdleImage = async (file) => {
    setErr(''); setOk(''); setSsUploading(true);
    try {
      const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
      if (!allowed.includes(file.type)) throw new Error(`Unsupported image type: ${file.type}. Use PNG or JPEG.`);
      if (file.size > 2 * 1024 * 1024) throw new Error(`Image too large (${Math.round(file.size / 1024)} KB). Max 2 MB.`);

      const ext = file.type === 'image/png' ? 'png' : 'jpg';
      const path = `terminal-idle/${locationId}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('kiosk-assets')
        .upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type });
      if (upErr) throw new Error(upErr.message);
      const { data: pub } = supabase.storage.from('kiosk-assets').getPublicUrl(path);
      const url = pub?.publicUrl;
      if (!url) throw new Error('Upload succeeded but no public URL came back.');

      // Share it with the venue's existing idle-screen setting so both bits of
      // hardware show one image. idle_screen_image_url is already the
      // human-viewable copy of that feature (Stripe reads idle_screen_file_id,
      // not this), so writing it cannot change what a Stripe reader displays.
      // v5.5.839: MUST be the PLATFORM location id, not the Ops one. The Platform
      // DB keys locations by its own uuid and stores the Ops id as ops_location_id;
      // writing the Ops id here violated location_reader_settings_location_id_fkey.
      // Non-fatal if the venue has no platform row — the image is already uploaded
      // and the terminal reads it from its own Ops row, so don't lose the upload.
      if (platformSupabase && platformLocId) {
        const { error: rsErr } = await platformSupabase
          .from('location_reader_settings')
          .upsert({ location_id: platformLocId, idle_screen_image_url: url }, { onConflict: 'location_id' });
        if (rsErr) setErr(`Image uploaded and will work on this terminal, but sharing it with the Stripe reader failed: ${rsErr.message}`);
      }

      setSsImage(url);
      setSsEnabled(true);
      onVenueIdleImage?.(url);
      setOk('Image uploaded. Tap Save to send it to this terminal.');
    } catch (e) {
      setErr(e?.message || 'Upload failed.');
    } finally {
      setSsUploading(false);
    }
  };

  const save = async () => {
    setSaving(true); setErr(''); setOk('');
    try {
      const cleanPcts = tipPcts
        .map(p => Number(p))
        .filter(p => Number.isFinite(p) && p > 0 && p <= 100)
        .slice(0, 5);
      if (tipEnabled && cleanPcts.length === 0) {
        throw new Error('Tipping is on but no percentages are set. Add at least one, or turn tipping off.');
      }

      const { data, error } = await supabase.rpc('set_terminal_settings', {
        p_terminal_id:         terminal.id,
        p_tip_config:          { enabled: tipEnabled, percentages: cleanPcts, allowCustom },
        p_bound_pos_device_id: boundTill || null,
        p_modes:               modes,
        p_label:               name.trim() || null,
        p_idle_screen:         { enabled: ssEnabled, imageUrl: ssImage || null },
      });
      // Never swallow. An RPC that refuses (no access, wrong venue's till) must
      // land in front of the manager, not in the console.
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error('The terminal settings did not save — nothing was changed.');

      setOk('Saved. The terminal picks this up on its next heartbeat (within a minute).');
      await onSaved?.();
    } catch (e) {
      setErr(e?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const noModes = !modes.table_pay && !modes.manual && !modes.pos_dispatch;

  return (
    <div style={{ padding:'4px 14px 18px', background:'var(--bg2)', borderTop:'1px solid var(--bdr)' }}>

      {/* ── Name ──────────────────────────────────────────────────────── */}
      <div style={S.fieldset}>
        <label style={S.label}>Terminal name</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Handheld 1" style={{ ...S.input, maxWidth:320 }} />
      </div>

      {/* ── Tipping ───────────────────────────────────────────────────────
          Same controls, defaults and wording as the Stripe reader's tipping
          block in Card readers → Reader settings. One vocabulary, two devices. */}
      <div style={S.fieldset}>
        <div style={S.legend}>Tipping</div>
        <div style={{ ...S.sub, marginBottom:12 }}>
          Controls the tip prompt this terminal shows before the customer taps their card.
        </div>

        <div style={S.box}>
          <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
            <input type="checkbox" checked={tipEnabled} onChange={e => setTipEnabled(e.target.checked)} style={{ width:16, height:16 }} />
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Enable tipping prompt on this terminal</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                Customer sees tip percentage buttons before tapping their card. Disable for fast-casual /
                counter service where tipping isn&apos;t appropriate.
              </div>
            </div>
          </label>
        </div>

        {tipEnabled && (
          <div style={{ paddingLeft:26 }}>
            <div style={{ marginBottom:12 }}>
              <label style={S.label}>Tip preset percentages (up to 5)</label>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {tipPcts.map((p, i) => (
                  <input
                    key={i}
                    type="number"
                    value={p}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      setTipPcts(prev => prev.map((x, idx) => idx === i ? (Number.isFinite(v) ? v : 0) : x));
                    }}
                    style={{ ...S.input, width:76, textAlign:'center' }}
                    min={1} max={100} step="0.5"
                  />
                ))}
                {tipPcts.length < 5 && (
                  <button onClick={() => setTipPcts(prev => [...prev, 25])} style={{ ...S.btn, ...S.btnGhost, padding:'4px 10px', fontSize:12 }}>
                    + Add
                  </button>
                )}
                {tipPcts.length > 1 && (
                  <button onClick={() => setTipPcts(prev => prev.slice(0, -1))} style={{ ...S.btn, ...S.btnGhost, padding:'4px 10px', fontSize:12 }}>
                    − Remove last
                  </button>
                )}
              </div>
              <div style={S.sub}>
                The terminal shows these as tap buttons. Common: 10 / 12.5 / 15.
              </div>
            </div>

            <div style={{ marginBottom:4 }}>
              <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                <input type="checkbox" checked={allowCustom} onChange={e => setAllowCustom(e.target.checked)} style={{ width:14, height:14 }} />
                <span style={{ fontSize:12, color:'var(--t1)' }}>Allow customer to enter a custom tip amount</span>
              </label>
            </div>
            <div style={S.sub}>
              A &quot;No tip&quot; option is always shown and is not configurable — a customer must never be
              trapped on the tip screen.
            </div>
          </div>
        )}
      </div>

      {/* ── Assign to a POS till or kiosk ─────────────────────────────── */}
      <div style={S.fieldset}>
        <div style={S.legend}>Assign to a POS till or kiosk</div>
        <div style={{ ...S.sub, marginBottom:10 }}>
          When that device sends a payment from its checkout screen, it goes to this terminal.
        </div>
        <select value={boundTill} onChange={e => setBoundTill(e.target.value)} style={{ ...S.input, maxWidth:360 }}>
          <option value="">— Not assigned —</option>
          {posDevices.map(d => (
            <option key={d.id} value={d.id}>{d.type === 'kiosk' ? `🖥 ${d.name || d.id} (kiosk)` : (d.name || d.id)}</option>
          ))}
        </select>
        {posDevices.length === 0 && (
          <div style={S.sub}>No POS tills or kiosks are registered at this venue yet — add one in Devices first.</div>
        )}
        {!boundTill && posDevices.length > 1 && (
          <div style={S.sub}>
            Leave this unassigned only if there is one card terminal here. With more than one and none
            assigned, a till cannot tell which machine to send to and will say so instead of guessing.
          </div>
        )}
      </div>

      {/* ── Modes ─────────────────────────────────────────────────────── */}
      <div style={S.fieldset}>
        <div style={S.legend}>What this terminal can do</div>
        <div style={{ ...S.sub, marginBottom:10 }}>
          Turn off anything this terminal shouldn&apos;t offer. Buttons that are off are hidden on the
          terminal&apos;s home screen.
        </div>
        {[
          ['table_pay',    'Table Pay',      'Staff pick an open table on the terminal and take the whole bill.'],
          ['manual',       'Manual payment', 'Staff type an amount on the terminal.'],
          ['pos_dispatch', 'Send from POS',  'A till pushes a payment to this terminal from its checkout screen.'],
        ].map(([key, title, help]) => (
          <div key={key} style={S.box}>
            <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
              <input type="checkbox" checked={modes[key]} onChange={e => setMode(key, e.target.checked)} style={{ width:16, height:16 }} />
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{title}</div>
                <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{help}</div>
              </div>
            </label>
          </div>
        ))}
        {noModes && (
          <div style={{ ...S.sub, color:'var(--red)' }}>
            All three are off — this terminal will not be able to take any payment.
          </div>
        )}
      </div>

      {/* ── Idle screen ───────────────────────────────────────────────────
          Reuses the venue's existing idle-screen image, shared with the Stripe
          reader screensaver. The on/off is per terminal. */}
      <div style={S.fieldset}>
        <div style={S.legend}>Idle screen / screensaver</div>
        <div style={{ ...S.sub, marginBottom:10 }}>
          Show a full-screen image on this terminal when it is sitting idle on the home screen. Any touch
          dismisses it. It never appears during a payment. This is the same venue image as the card
          reader idle screen (Card readers → Idle screen) — uploading here replaces it for both.
        </div>

        <div style={S.box}>
          <label style={{ display:'flex', alignItems:'center', gap:10, cursor: ssImage ? 'pointer' : 'not-allowed', opacity: ssImage ? 1 : 0.6 }}>
            <input
              type="checkbox"
              checked={ssEnabled}
              disabled={!ssImage}
              onChange={e => setSsEnabled(e.target.checked)}
              style={{ width:16, height:16 }}
            />
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Show the idle image on this terminal</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                {ssImage
                  ? 'An image is set for this venue. Toggle off to leave this terminal on its normal home screen.'
                  : 'Upload an image below to display when this terminal is idle.'}
              </div>
            </div>
          </label>
        </div>

        <div style={{ display:'flex', gap:16, alignItems:'flex-start', flexWrap:'wrap' }}>
          {ssImage && (
            <div style={{
              width:120, height:180, borderRadius:10, overflow:'hidden',
              border:'2px solid var(--bdr)', background:'var(--bg3)', flexShrink:0,
            }}>
              <img src={ssImage} alt="Idle screen preview" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
            </div>
          )}
          <div style={{ flex:1, minWidth:200 }}>
            <label style={{
              display:'flex', alignItems:'center', justifyContent:'center', gap:8,
              padding:'14px 16px', borderRadius:10, cursor: ssUploading ? 'wait' : 'pointer',
              border:'2px dashed var(--bdr)', background:'var(--bg)',
              color:'var(--t2)', fontSize:13, fontWeight:600, fontFamily:'inherit',
            }}>
              <input
                type="file"
                accept="image/png,image/jpeg"
                style={{ display:'none' }}
                disabled={ssUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadIdleImage(f); e.target.value = ''; }}
              />
              <span style={{ fontSize:18 }}>{ssUploading ? '⏳' : '🖼️'}</span>
              {ssUploading ? 'Uploading…' : ssImage ? 'Replace image' : 'Choose an image'}
            </label>
            <div style={S.sub}>
              PNG or JPEG, max 2 MB. The terminal screen is tall and narrow — a portrait image fills it best.
            </div>
          </div>
        </div>
      </div>

      {/* ── Save ──────────────────────────────────────────────────────── */}
      <div style={{ marginTop:18, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
        <button onClick={save} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <span style={{ fontSize:11, color:'var(--t4)' }}>
          Saves go through a server-side check that the till belongs to this venue.
        </span>
      </div>

      {ok  && <div style={S.ok}>{ok}</div>}
      {err && <div style={S.err}>{err}</div>}
    </div>
  );
}
