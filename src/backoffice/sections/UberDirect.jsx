// src/backoffice/sections/UberDirect.jsx
//
// Back Office → Channels → "Delivery". Per-venue config for address-based delivery quoting +
// surcharging with the Stuart courier network (UK). Each LOCATION connects its OWN Stuart
// account (one Stuart account per venue, not one platform account for the whole system) — the
// "Connect this venue to Stuart" card below. Settings here drive delivery identically across
// POS, online and catering.
//
// Note: the stored delivery_mode value 'uber' is the generic "courier-dispatched" flag (kept
// for back-compat); the only courier backend offered is Stuart. Uber Direct + the HubRise
// Bridge are no longer offered (Uber Direct is gated in the UK); their edge-fn code is parked.
//
// Creds (the venue's Stuart Client ID/Secret) are stored service-role-only and NEVER returned
// to the browser — this screen only ever learns whether Stuart is `connected`.

import { useEffect, useState } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { getVenueUberConfig, setVenueUberConfig, setStuartCreds, testStuart, disconnectStuart } from '../../lib/delivery/deliveryConfig';
import { computeSurcharge } from '../../lib/delivery/surcharge';
import { money } from '../../lib/currency';
import MoneyField from '../../components/MoneyField';
import AddressAutocomplete from '../../components/AddressAutocomplete';

const S = {
  wrap: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 },
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 },
  h1: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  btn: { padding: '10px 18px', borderRadius: 9, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '10px 16px', borderRadius: 9, background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr2)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  col: { flex: '1 1 160px', minWidth: 140 },
  note: (err) => ({ fontSize: 12.5, padding: '9px 12px', borderRadius: 9, marginTop: 8, background: err ? '#ef444418' : '#22c55e18', color: err ? '#ef4444' : '#16a34a' }),
  toggle: (on) => ({ width: 44, height: 24, borderRadius: 12, background: on ? 'var(--grn, #22c55e)' : 'var(--bdr2)', position: 'relative', cursor: 'pointer', transition: 'background .2s', flexShrink: 0 }),
  knob: (on) => ({ position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }),
  infoNote: { fontSize: 12, color: 'var(--t4)', background: 'var(--bg3)', borderRadius: 9, padding: '9px 12px', lineHeight: 1.5 },
  linkA: { color: 'var(--acc)', fontWeight: 700, textDecoration: 'none' },
};

const DEFAULT = {
  enabled: false, delivery_mode: 'self', radius_miles: 3, dispatch_backend: 'stuart', env: 'sandbox',
  sms_tracking: true, flat_fee_minor: null, fallback_fee_minor: null, stuart_connected: false,
  pickup_address: { line1: '', city: '', postcode: '', country: 'GB', lat: null, lng: null },
  pickup_contact: { name: '', phone: '' },
  surcharge_policy: { mode: 'pass_through', markupPct: 0, markupFixedMinor: 0, subsidiseMinor: 0, subsidisePct: 0, flatMinor: 0, capMinor: null, freeOverMinor: null, minOrderMinor: null },
};

export default function UberDirect() {
  const [locId] = useState(() => getActiveLocationSync());
  const [form, setForm] = useState(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    (async () => {
      if (!locId) { setLoading(false); return; }
      const r = await getVenueUberConfig(locId);
      if (r?.config && Object.keys(r.config).length) {
        setForm({ ...DEFAULT, ...r.config, pickup_address: { ...DEFAULT.pickup_address, ...(r.config.pickup_address || {}) }, pickup_contact: { ...DEFAULT.pickup_contact, ...(r.config.pickup_contact || {}) }, surcharge_policy: { ...DEFAULT.surcharge_policy, ...(r.config.surcharge_policy || {}) } });
        setStu((s) => ({ ...s, env: r.config.env || 'sandbox' }));
      }
      setLoading(false);
    })();
  }, [locId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAddr = (k, v) => setForm((f) => ({ ...f, pickup_address: { ...f.pickup_address, [k]: v } }));
  const setContact = (k, v) => setForm((f) => ({ ...f, pickup_contact: { ...f.pickup_contact, [k]: v } }));
  const setPolicy = (k, v) => setForm((f) => ({ ...f, surcharge_policy: { ...f.surcharge_policy, [k]: v } }));

  const isCourier = form.delivery_mode === 'uber';

  // ── Connect this venue's OWN Stuart account ────────────────────────────────
  const [stu, setStu] = useState({ clientId: '', clientSecret: '', env: 'sandbox', busy: false, msg: null });
  const connectStuart = async () => {
    if (!stu.clientId.trim() || !stu.clientSecret.trim()) { setStu((s) => ({ ...s, msg: { err: true, t: 'Enter both the Client ID and Client Secret from your Stuart account.' } })); return; }
    setStu((s) => ({ ...s, busy: true, msg: null }));
    const r = await setStuartCreds(locId, { clientId: stu.clientId.trim(), clientSecret: stu.clientSecret.trim(), env: stu.env });
    if (r?.ok) {
      setForm((f) => ({ ...f, stuart_connected: true, dispatch_backend: 'stuart', env: stu.env }));
      setStu((s) => ({ ...s, busy: false, clientSecret: '', msg: { err: false, t: `Connected to Stuart (${stu.env === 'prod' ? 'production' : 'sandbox'}) ✓` } }));
    } else {
      setStu((s) => ({ ...s, busy: false, msg: { err: true, t: r?.error || 'Could not connect to Stuart.' } }));
    }
  };
  const testStuartConn = async () => {
    setStu((s) => ({ ...s, busy: true, msg: null }));
    const r = await testStuart(locId);
    setStu((s) => ({ ...s, busy: false, msg: r?.ok ? { err: false, t: `Stuart connection OK (${r.env === 'prod' ? 'production' : 'sandbox'})${r.platform ? ' — using the shared ServOS test account' : ''}.` } : { err: true, t: r?.error || 'Stuart connection failed.' } }));
  };
  const disconnectStuartConn = async () => {
    setStu((s) => ({ ...s, busy: true, msg: null }));
    const r = await disconnectStuart(locId);
    if (r?.ok) { setForm((f) => ({ ...f, stuart_connected: false })); setStu((s) => ({ ...s, busy: false, msg: { err: false, t: 'Disconnected.' } })); }
    else setStu((s) => ({ ...s, busy: false, msg: { err: true, t: r?.error || 'Could not disconnect.' } }));
  };

  const save = async () => {
    setSaving(true); setMsg(null);
    // Courier mode is always the Stuart backend now (Uber Direct / HubRise Bridge are retired).
    const payload = { ...form, dispatch_backend: isCourier ? 'stuart' : form.dispatch_backend };
    delete payload.stuart_connected; // read-only, computed server-side
    const r = await setVenueUberConfig(locId, payload);
    setSaving(false);
    setMsg(r?.error ? { err: true, t: r.error } : { err: false, t: 'Saved' });
  };

  // Live preview: what a £4.80 courier cost becomes for the customer under the current policy.
  const SAMPLE = 480;
  const preview = computeSurcharge({ uberFeeMinor: SAMPLE, policy: form.surcharge_policy, orderSubtotalMinor: 3000 });
  const p = form.surcharge_policy;
  const dashHost = stu.env === 'prod' ? 'dashboard.stuart.com' : 'dashboard.sandbox.stuart.com';

  if (loading) return <div style={{ color: 'var(--t3)', padding: 24 }}>Loading…</div>;
  if (!locId) return <div style={{ color: 'var(--t3)', padding: 24 }}>Select a location first.</div>;

  return (
    <div style={S.wrap}>
      <div>
        <h1 style={S.h1}>Delivery</h1>
        <p style={S.sub}>Quote the delivery fee from the customer's address at order time, surcharge it under your policy, and dispatch a Stuart courier with live tracking. Used identically across POS, online and catering.</p>
      </div>

      {/* How delivery works with Stuart — per-location account model. */}
      {isCourier && (
      <div style={{ ...S.card, borderColor: '#1D9E75', background: 'rgba(29,158,117,0.06)' }}>
        <h2 style={S.h2}>How delivery works with Stuart</h2>
        <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 10px' }}>
          Deliveries are carried out by <b>Stuart</b> couriers. Each venue uses its <b>own Stuart account</b>, so the courier costs are billed directly to this location. You connect this venue's Stuart account once (below), then set your pickup address, radius and pricing.
        </p>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--t2)', lineHeight: 1.7 }}>
          <li><b>Create a Stuart account</b> for this venue and grab its API keys (Client ID + Secret) — see the <b>Connect this venue to Stuart</b> card below.</li>
          <li><b>Connect it</b> below (we verify the keys before saving).</li>
          <li>Set your <b>pickup address</b>, <b>radius</b> and <b>delivery pricing</b>.</li>
          <li>Turn delivery <b>on</b> — at order time we fetch Stuart's live price + ETA, add your charge, and dispatch a courier with live tracking.</li>
        </ol>
        <p style={{ fontSize: 12, color: 'var(--t4)', margin: '10px 0 0' }}>
          Stuart operates in major UK cities. If a customer's address is outside Stuart's coverage, they're shown that delivery isn't available (and can choose collection).
        </p>
      </div>
      )}

      {/* Enable */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 800, color: 'var(--t1)', fontSize: 14 }}>Enable delivery</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Off = delivery orders won't be quoted/surcharged here.</div>
          </div>
          <div style={S.toggle(form.enabled)} onClick={() => set('enabled', !form.enabled)}><div style={S.knob(form.enabled)} /></div>
        </div>
      </div>

      {/* Fulfilment mode — the headline choice: self-delivery vs a Stuart courier */}
      <div style={S.card}>
        <h2 style={S.h2}>How are deliveries fulfilled?</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['self', '🚶 I deliver it myself', 'The order just fires to your POS / kitchen. You arrange the delivery. No courier dispatch, no account needed.'],
            ['uber', '🚗 Stuart courier', "A Stuart courier is dispatched automatically with a live price + ETA and a tracking link. Connect this venue's Stuart account below."],
          ].map(([val, title, desc]) => (
            <div key={val} onClick={() => set('delivery_mode', val)} style={{
              flex: '1 1 240px', cursor: 'pointer', borderRadius: 12, padding: '14px 16px',
              border: `2px solid ${form.delivery_mode === val ? 'var(--acc)' : 'var(--bdr)'}`,
              background: form.delivery_mode === val ? 'var(--acc-d, rgba(232,160,32,.08))' : 'var(--bg3)',
            }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{title}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
        <div style={{ ...S.row, marginTop: 14 }}>
          <div style={S.col}>
            <label style={S.label}>{isCourier ? 'Your delivery charge (£) — fallback if the live Stuart quote fails' : 'Your delivery charge (£)'}</label>
            <MoneyField style={S.input} valueMinor={form.flat_fee_minor} onMinor={(m) => set('flat_fee_minor', m)} placeholder="0.00 = free" />
          </div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 10 }}>This same setting drives delivery on the POS, online ordering and catering — set it once here.{isCourier ? ' With a live Stuart quote that price is used instead, priced under your policy below, with this as the fallback.' : ''}</div>
      </div>

      {/* Connect this venue to Stuart — per-location credentials */}
      {isCourier && (
      <div style={{ ...S.card, borderColor: form.stuart_connected ? '#16a34a66' : 'var(--acc)' }}>
        <h2 style={S.h2}>{form.stuart_connected ? '✓ This venue is connected to Stuart' : 'Connect this venue to Stuart'}</h2>
        {form.stuart_connected ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55 }}>
              This venue has its own Stuart account connected ({form.env === 'prod' ? 'production' : 'sandbox'}) — couriers dispatch automatically with live pricing + tracking. The keys are stored securely on the server and aren't shown here.
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button style={S.btnGhost} disabled={stu.busy} onClick={testStuartConn}>{stu.busy ? '…' : 'Test connection'}</button>
              <button style={{ ...S.btnGhost, color: '#ef4444' }} disabled={stu.busy} onClick={disconnectStuartConn}>Disconnect</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 12px' }}>
              Each location uses its <b>own</b> Stuart account. Create one for this venue, then paste its API keys here — we verify them before saving and never display the secret again.
            </p>
            <ol style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.7 }}>
              <li>Sign up / log in at{' '}
                <a style={S.linkA} href={`https://${dashHost}`} target="_blank" rel="noreferrer">{dashHost} ↗</a>{' '}
                ({stu.env === 'prod' ? 'live account' : 'free sandbox — no card needed to test'}).</li>
              <li>Go to <b>Settings → API access</b> and create an <b>API client</b> to get a <b>Client ID</b> and <b>Client Secret</b>.</li>
              <li>Paste them below and choose the matching environment.</li>
            </ol>
            <div style={S.row}>
              <div style={S.col}>
                <label style={S.label}>Environment</label>
                <select style={S.input} value={stu.env} onChange={(e) => setStu((s) => ({ ...s, env: e.target.value }))}>
                  <option value="sandbox">Sandbox (testing)</option>
                  <option value="prod">Production (live)</option>
                </select>
              </div>
            </div>
            <div style={{ ...S.row, marginTop: 10 }}>
              <div style={S.col}><label style={S.label}>Stuart Client ID</label><input style={S.input} value={stu.clientId} onChange={(e) => setStu((s) => ({ ...s, clientId: e.target.value }))} placeholder="from Stuart → Settings → API access" autoComplete="off" /></div>
              <div style={S.col}><label style={S.label}>Stuart Client Secret</label><input style={S.input} type="password" value={stu.clientSecret} onChange={(e) => setStu((s) => ({ ...s, clientSecret: e.target.value }))} placeholder="paste secret" autoComplete="off" /></div>
            </div>
            <button style={{ ...S.btn, marginTop: 12 }} disabled={stu.busy} onClick={connectStuart}>{stu.busy ? 'Connecting…' : 'Connect Stuart account'}</button>
          </>
        )}
        {stu.msg && <div style={S.note(stu.msg.err)}>{stu.msg.t}</div>}
      </div>
      )}

      {/* Warn if courier mode is on but nothing can actually price/dispatch a delivery. */}
      {isCourier && !form.stuart_connected && form.flat_fee_minor == null && (
        <div style={S.note(true)}>⚠ Delivery is set to use a Stuart courier, but this venue isn't connected to Stuart yet and no fallback delivery charge is set — connect Stuart above (or set a delivery charge) before turning delivery on.</div>
      )}

      {/* Pickup */}
      <div style={S.card}>
        <h2 style={S.h2}>Pickup (your venue)</h2>
        <div style={S.row}>
          <div style={S.col}>
            <label style={S.label}>Address line 1</label>
            <AddressAutocomplete
              value={form.pickup_address.line1 || ''} inputStyle={S.input}
              placeholder="Start typing the venue address…"
              onChangeText={(v) => setAddr('line1', v)}
              onSelect={(a) => setForm((f) => ({ ...f, pickup_address: {
                ...f.pickup_address,
                line1: a.line1 || f.pickup_address.line1,
                city: a.city || f.pickup_address.city,
                postcode: a.postcode || f.pickup_address.postcode,
                lat: a.lat ?? f.pickup_address.lat,
                lng: a.lng ?? f.pickup_address.lng,
              } }))} />
          </div>
          <div style={S.col}><label style={S.label}>City</label><input style={S.input} value={form.pickup_address.city || ''} onChange={(e) => setAddr('city', e.target.value)} /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 8 }}>Pick your address from the suggestions so the courier gets exact coordinates — this matches how customers enter their delivery address (no mismatch).</div>
        <div style={{ ...S.row, marginTop: 10 }}>
          <div style={S.col}><label style={S.label}>Postcode</label><input style={S.input} value={form.pickup_address.postcode || ''} onChange={(e) => setAddr('postcode', e.target.value)} /></div>
          <div style={S.col}><label style={S.label}>Latitude (optional)</label><input style={S.input} value={form.pickup_address.lat ?? ''} onChange={(e) => setAddr('lat', e.target.value === '' ? null : Number(e.target.value))} /></div>
          <div style={S.col}><label style={S.label}>Longitude (optional)</label><input style={S.input} value={form.pickup_address.lng ?? ''} onChange={(e) => setAddr('lng', e.target.value === '' ? null : Number(e.target.value))} /></div>
        </div>
        <div style={{ ...S.row, marginTop: 10 }}>
          <div style={S.col}><label style={S.label}>Contact name</label><input style={S.input} value={form.pickup_contact.name || ''} onChange={(e) => setContact('name', e.target.value)} /></div>
          <div style={S.col}><label style={S.label}>Contact phone</label><input style={S.input} value={form.pickup_contact.phone || ''} onChange={(e) => setContact('phone', e.target.value)} /></div>
        </div>
        <div style={{ ...S.row, marginTop: 10 }}>
          <div style={S.col}><label style={S.label}>Delivery radius (miles)</label><input type="number" step="0.5" style={S.input} value={form.radius_miles} onChange={(e) => set('radius_miles', Number(e.target.value))} /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 10 }}>Tip: set the venue lat/long for exact-door radius checks. Otherwise the customer's postcode is geocoded for free (no Google fees).</div>
      </div>

      {/* Delivery rules — apply in EVERY mode (self-delivery + Stuart courier) */}
      <div style={S.card}>
        <h2 style={S.h2}>Delivery rules</h2>
        <div style={S.row}>
          <div style={S.col}><label style={S.label}>Minimum order for delivery (£, blank = none)</label><MoneyField style={S.input} valueMinor={p.minOrderMinor} onMinor={(m) => setPolicy('minOrderMinor', m)} placeholder="none" /></div>
          <div style={S.col}><label style={S.label}>Free delivery over (£, blank = none)</label><MoneyField style={S.input} valueMinor={p.freeOverMinor} onMinor={(m) => setPolicy('freeOverMinor', m)} placeholder="none" /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 10 }}>Orders below the minimum can't choose delivery — the customer is shown how much more to spend. "Free delivery over" waives the fee on big baskets. Both apply on POS, online and catering.</div>
      </div>

      {/* Live courier pricing — ONLY for the Stuart courier mode (live quote). Self-delivery uses
          the flat delivery charge above as-is. */}
      {isCourier && (
      <div style={S.card}>
        <h2 style={S.h2}>Live courier pricing</h2>
        <p style={{ fontSize: 12.5, color: 'var(--t3)', margin: '0 0 12px', lineHeight: 1.5 }}>How Stuart's live courier cost becomes the customer's fee. Self-delivery uses your flat delivery charge above.</p>
        <div style={S.row}>
          <div style={S.col}>
            <label style={S.label}>Mode</label>
            <select style={S.input} value={p.mode} onChange={(e) => setPolicy('mode', e.target.value)}>
              <option value="pass_through">Pass-through (charge the courier's fee)</option>
              <option value="markup">Mark-up (+ on the courier's fee)</option>
              <option value="subsidise">Subsidise (absorb part)</option>
              <option value="flat">Flat fee</option>
            </select>
          </div>
          {p.mode === 'markup' && <>
            <div style={S.col}><label style={S.label}>Mark-up %</label><input type="number" style={S.input} value={p.markupPct || 0} onChange={(e) => setPolicy('markupPct', Number(e.target.value))} /></div>
            <div style={S.col}><label style={S.label}>Mark-up fixed (£)</label><MoneyField style={S.input} valueMinor={p.markupFixedMinor} onMinor={(m) => setPolicy('markupFixedMinor', m || 0)} /></div>
          </>}
          {p.mode === 'subsidise' && <>
            <div style={S.col}><label style={S.label}>Absorb fixed (£)</label><MoneyField style={S.input} valueMinor={p.subsidiseMinor} onMinor={(m) => setPolicy('subsidiseMinor', m || 0)} /></div>
            <div style={S.col}><label style={S.label}>Absorb %</label><input type="number" style={S.input} value={p.subsidisePct || 0} onChange={(e) => setPolicy('subsidisePct', Number(e.target.value))} /></div>
          </>}
          {p.mode === 'flat' && <div style={S.col}><label style={S.label}>Flat fee (£)</label><MoneyField style={S.input} valueMinor={p.flatMinor} onMinor={(m) => setPolicy('flatMinor', m || 0)} /></div>}
        </div>
        <div style={{ ...S.row, marginTop: 10 }}>
          <div style={S.col}><label style={S.label}>Cap customer fee (£, blank = none)</label><MoneyField style={S.input} valueMinor={p.capMinor} onMinor={(m) => setPolicy('capMinor', m)} placeholder="none" /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 12, background: '#22c55e14', color: 'var(--t2)' }}>
          Preview: a <b>{money(SAMPLE / 100)}</b> courier cost → customer pays <b>{preview.freeDelivery ? 'Free' : money(preview.customerFeeMinor / 100)}</b>
          {' '}(your margin {money(preview.marginMinor / 100)}). The live fee always comes from Stuart at order time.
        </div>
      </div>
      )}

      {/* Fallback + tracking — only for the Stuart courier mode */}
      {isCourier && (
      <div style={S.card}>
        <h2 style={S.h2}>Fallback & tracking</h2>
        <div style={S.row}>
          <div style={S.col}><label style={S.label}>Fallback fee if Stuart is unavailable (£, blank = block)</label><MoneyField style={S.input} valueMinor={form.fallback_fee_minor} onMinor={(m) => set('fallback_fee_minor', m)} placeholder="block" /></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--t2)' }}>Text the customer a tracking link</div>
          <div style={S.toggle(form.sms_tracking)} onClick={() => set('sms_tracking', !form.sms_tracking)}><div style={S.knob(form.sms_tracking)} /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 12 }}>If Stuart can't return a live price (rare), this fallback fee is used so the order can still go through. Leave blank to block delivery instead.</div>
      </div>
      )}

      <div>
        <button style={S.btn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        {msg && <div style={S.note(msg.err)}>{msg.t}</div>}
      </div>
    </div>
  );
}
