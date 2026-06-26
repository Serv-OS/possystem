// src/backoffice/sections/UberDirect.jsx
//
// Back Office → Channels → "Delivery (Uber Direct)". Per-venue config for address-based
// delivery quoting + surcharging: enable, pickup address, radius, surcharge policy (with a
// live preview), dispatch backend, fallback fee, SMS tracking. Creds (client id/secret +
// webhook signing key) live in the edge-fn env, NOT here — this screen talks to the
// uber-direct edge fn (service role), mirroring the HubRise screen.

import { useEffect, useState } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { getVenueUberConfig, setVenueUberConfig, onboardVenueOrg, inviteVenueOrgMember } from '../../lib/delivery/deliveryConfig';
import { computeSurcharge } from '../../lib/delivery/surcharge';
import { money } from '../../lib/currency';
import MoneyField from '../../components/MoneyField';

const S = {
  wrap: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 },
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 },
  h1: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  btn: { padding: '10px 18px', borderRadius: 9, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  col: { flex: '1 1 160px', minWidth: 140 },
  note: (err) => ({ fontSize: 12.5, padding: '9px 12px', borderRadius: 9, marginTop: 8, background: err ? '#ef444418' : '#22c55e18', color: err ? '#ef4444' : '#16a34a' }),
  toggle: (on) => ({ width: 44, height: 24, borderRadius: 12, background: on ? 'var(--grn, #22c55e)' : 'var(--bdr2)', position: 'relative', cursor: 'pointer', transition: 'background .2s', flexShrink: 0 }),
  knob: (on) => ({ position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .2s' }),
  infoNote: { fontSize: 12, color: 'var(--t4)', background: 'var(--bg3)', borderRadius: 9, padding: '9px 12px', lineHeight: 1.5 },
  linkA: { color: 'var(--acc)', fontWeight: 700, textDecoration: 'none' },
};

// £ <-> minor helpers for the money fields (stored as minor units in the policy).
const toMinor = (pounds) => (pounds === '' || pounds == null ? null : Math.round(Number(pounds) * 100));
const toPounds = (minor) => (minor == null ? '' : (Number(minor) / 100).toString());

const DEFAULT = {
  enabled: false, delivery_mode: 'self', radius_miles: 3, dispatch_backend: 'stuart', env: 'sandbox',
  sms_tracking: true, flat_fee_minor: null, fallback_fee_minor: null,
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
      }
      setLoading(false);
    })();
  }, [locId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAddr = (k, v) => setForm((f) => ({ ...f, pickup_address: { ...f.pickup_address, [k]: v } }));
  const setContact = (k, v) => setForm((f) => ({ ...f, pickup_contact: { ...f.pickup_contact, [k]: v } }));
  const setPolicy = (k, v) => setForm((f) => ({ ...f, surcharge_policy: { ...f.surcharge_policy, [k]: v } }));

  // Platform onboarding (Organizations API): ServOS creates this venue's Uber Direct sub-org
  // under our root account; the merchant never copies API keys.
  const [onb, setOnb] = useState({ name: '', email: '', busy: false, msg: null });
  const connected = !!form.uber_customer_id;
  const connectVenue = async () => {
    setOnb((o) => ({ ...o, busy: true, msg: null }));
    const r = await onboardVenueOrg(locId, { name: onb.name || form.pickup_contact?.name || undefined, email: onb.email || undefined });
    if (r?.ok) {
      setForm((f) => ({ ...f, uber_customer_id: r.customer_id, delivery_mode: 'uber', dispatch_backend: 'uber_api' }));
      setOnb((o) => ({ ...o, busy: false, msg: { err: false, t: r.already ? 'This venue is already connected.' : `Connected ✓ — customer ID ${r.customer_id}${r.invited ? ' · invite emailed' : ''}` } }));
    } else {
      setOnb((o) => ({ ...o, busy: false, msg: { err: true, t: r?.error || r?.reason || 'Could not connect to Uber Direct.' } }));
    }
  };
  const resendInvite = async () => {
    if (!onb.email) { setOnb((o) => ({ ...o, msg: { err: true, t: 'Enter the manager email to invite.' } })); return; }
    setOnb((o) => ({ ...o, busy: true, msg: null }));
    const r = await inviteVenueOrgMember(locId, onb.email);
    setOnb((o) => ({ ...o, busy: false, msg: r?.ok ? { err: false, t: 'Invite emailed.' } : { err: true, t: r?.error || 'Could not send invite.' } }));
  };

  const save = async () => {
    // HubRise Bridge has no live quote — a delivery charge MUST be set (0 = free is fine,
    // blank is not), otherwise every delivery would silently charge £0.
    if (form.enabled && form.delivery_mode === 'uber' && form.dispatch_backend === 'hubrise_bridge' && form.flat_fee_minor == null) {
      setMsg({ err: true, t: 'Set your delivery charge first — HubRise Bridge has no live price, so deliveries would be £0 until you set it (enter 0 for genuinely free delivery).' });
      return;
    }
    setSaving(true); setMsg(null);
    const r = await setVenueUberConfig(locId, form);
    setSaving(false);
    setMsg(r?.error ? { err: true, t: r.error } : { err: false, t: 'Saved' });
  };

  // Live preview: what a £4.80 Uber cost becomes for the customer under the current policy.
  const SAMPLE = 480;
  const preview = computeSurcharge({ uberFeeMinor: SAMPLE, policy: form.surcharge_policy, orderSubtotalMinor: 3000 });
  const p = form.surcharge_policy;

  if (loading) return <div style={{ color: 'var(--t3)', padding: 24 }}>Loading…</div>;
  if (!locId) return <div style={{ color: 'var(--t3)', padding: 24 }}>Select a location first.</div>;

  return (
    <div style={S.wrap}>
      <div>
        <h1 style={S.h1}>Delivery</h1>
        <p style={S.sub}>Quote the delivery fee from the customer's address at order time, surcharge it under your policy, and dispatch a courier (Stuart in the UK, or Uber Direct). Used identically across POS, online and catering.</p>
      </div>

      {/* Before you start — Uber/HubRise account setup. Not shown for Stuart (platform-managed). */}
      {form.delivery_mode === 'uber' && form.dispatch_backend !== 'stuart' && (
      <div style={{ ...S.card, borderColor: '#B45309', background: 'rgba(180,83,9,0.06)' }}>
        <h2 style={S.h2}>Before you start — set up your own Uber Direct + HubRise accounts</h2>
        <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 12px' }}>
          Couriers are provided by <b>Uber Direct</b> and dispatched via <b>HubRise</b>. You set these up
          directly with each provider — they are <b>outside ServOS's billing and control</b>: Uber Direct
          charges your venue per delivery under your own Uber contract, and HubRise's Uber Direct Bridge is free.
          ServOS only quotes the fee, surcharges your order, and hands the order over.
        </p>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--t2)', lineHeight: 1.7 }}>
          <li><b>Create an Uber Direct account</b> (merchant contract — Uber bills you for deliveries):{' '}
            <a style={S.linkA} href="https://www.uber.com/gb/en/deliver/direct/" target="_blank" rel="noreferrer">uber.com/deliver/direct ↗</a></li>
          <li><b>Create a HubRise account</b>:{' '}
            <a style={S.linkA} href="https://www.hubrise.com/" target="_blank" rel="noreferrer">hubrise.com ↗</a></li>
          <li><b>Enable the free Uber Direct Bridge</b> app inside HubRise, and connect it to your Uber Direct account:{' '}
            <a style={S.linkA} href="https://www.hubrise.com/apps/uber-direct" target="_blank" rel="noreferrer">hubrise.com/apps/uber-direct ↗</a></li>
          <li><b>Connect this venue to HubRise</b> in ServOS: Back Office → Channels → <b>3rd Party orders</b>.</li>
          <li>Come back here, turn delivery on, set your pickup address, radius and the delivery fee below.</li>
        </ol>
        <p style={{ fontSize: 12, color: 'var(--t4)', margin: '12px 0 0' }}>
          Note: the HubRise Bridge dispatches the courier and Uber bills you directly. ServOS does not resell,
          mark up, or take payment for the Uber/HubRise services — those accounts and any charges are between
          your venue and Uber/HubRise.
        </p>
      </div>
      )}

      {/* How Stuart works — shown when the Stuart courier backend is selected. No merchant signup. */}
      {form.delivery_mode === 'uber' && form.dispatch_backend === 'stuart' && (
      <div style={{ ...S.card, borderColor: '#1D9E75', background: 'rgba(29,158,117,0.06)' }}>
        <h2 style={S.h2}>How delivery works with Stuart</h2>
        <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 10px' }}>
          Deliveries are carried out by <b>Stuart</b> couriers through ServOS — <b>there's no account for you to create and no API keys to enter</b>. You only set three things below: your <b>pickup address</b>, your <b>delivery radius</b>, and your <b>delivery charge / pricing</b>.
        </p>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--t2)', lineHeight: 1.7 }}>
          <li>Set your <b>pickup address</b> (where the courier collects) and your <b>radius</b>.</li>
          <li>Set how you charge for delivery under <b>Delivery rules</b> + <b>Live courier pricing</b> below.</li>
          <li>Turn delivery <b>on</b> — that's it. At order time we fetch Stuart's live price + ETA, add your charge, and dispatch a courier with live tracking.</li>
        </ol>
        <p style={{ fontSize: 12, color: 'var(--t4)', margin: '10px 0 0' }}>
          Stuart operates in major UK cities. If a customer's address is outside Stuart's coverage, they're shown that delivery isn't available (and can choose collection). Stuart's courier charges are billed through the ServOS platform account.
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

      {/* Fulfilment mode — the headline choice: self-delivery vs Uber Direct courier */}
      <div style={S.card}>
        <h2 style={S.h2}>How are deliveries fulfilled?</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['self', '🚶 I deliver it myself', 'The order just fires to your POS / kitchen. You arrange the delivery. No courier dispatch, no account needed.'],
            ['uber', '🚗 Courier (Stuart / Uber)', 'A courier is dispatched automatically with a live price + ETA and a tracking link. Choose the provider (Stuart, Uber Direct, or HubRise) under “Dispatch backend” below.'],
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
            <label style={S.label}>{
              form.delivery_mode === 'self' ? 'Your delivery charge (£)'
              : form.dispatch_backend === 'hubrise_bridge' ? 'Your delivery charge (£) — HubRise Bridge has no live price, so this is charged on every delivery'
              : 'Your delivery charge (£) — fallback if the live courier quote fails'
            }</label>
            <MoneyField style={S.input} valueMinor={form.flat_fee_minor} onMinor={(m) => set('flat_fee_minor', m)} placeholder="0.00 = free" />
          </div>
        </div>
        {form.delivery_mode === 'uber' && form.dispatch_backend === 'hubrise_bridge' && form.flat_fee_minor == null && (
          <div style={S.note(true)}>⚠ HubRise Bridge can't fetch a live delivery price — set your delivery charge above (enter <b>0</b> only if delivery is genuinely free). Until this is set, delivery is charged at £0.</div>
        )}
        <div style={{ ...S.infoNote, marginTop: 10 }}>This same setting drives delivery on the POS, online ordering and catering — set it once here.{form.delivery_mode === 'uber' && (form.dispatch_backend === 'uber_api' || form.dispatch_backend === 'stuart') ? ' With a live courier quote (Uber Direct API / Stuart) that price is used instead, priced under your policy below, with this as the fallback.' : ''}</div>
      </div>

      {/* Pickup */}
      <div style={S.card}>
        <h2 style={S.h2}>Pickup (your venue)</h2>
        <div style={S.row}>
          <div style={S.col}><label style={S.label}>Address line 1</label><input style={S.input} value={form.pickup_address.line1 || ''} onChange={(e) => setAddr('line1', e.target.value)} /></div>
          <div style={S.col}><label style={S.label}>City</label><input style={S.input} value={form.pickup_address.city || ''} onChange={(e) => setAddr('city', e.target.value)} /></div>
        </div>
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

      {/* Delivery rules — apply in EVERY mode (self, HubRise Bridge, Uber API) */}
      <div style={S.card}>
        <h2 style={S.h2}>Delivery rules</h2>
        <div style={S.row}>
          <div style={S.col}><label style={S.label}>Minimum order for delivery (£, blank = none)</label><MoneyField style={S.input} valueMinor={p.minOrderMinor} onMinor={(m) => setPolicy('minOrderMinor', m)} placeholder="none" /></div>
          <div style={S.col}><label style={S.label}>Free delivery over (£, blank = none)</label><MoneyField style={S.input} valueMinor={p.freeOverMinor} onMinor={(m) => setPolicy('freeOverMinor', m)} placeholder="none" /></div>
        </div>
        <div style={{ ...S.infoNote, marginTop: 10 }}>Orders below the minimum can't choose delivery — the customer is shown how much more to spend. "Free delivery over" waives the fee on big baskets. Both apply on POS, online and catering.</div>
      </div>

      {/* Live courier pricing — ONLY when quoting Uber live (Uber Direct API). On self-delivery
          and HubRise Bridge there is no live courier cost, so the flat delivery charge above is
          exactly what the customer pays. */}
      {form.delivery_mode === 'uber' && (form.dispatch_backend === 'uber_api' || form.dispatch_backend === 'stuart') && (
      <div style={S.card}>
        <h2 style={S.h2}>Live courier pricing</h2>
        <p style={{ fontSize: 12.5, color: 'var(--t3)', margin: '0 0 12px', lineHeight: 1.5 }}>How the courier's live cost becomes the customer's fee. This applies to a live courier quote (Stuart or the Uber Direct API) — HubRise Bridge and self-delivery use your flat delivery charge above.</p>
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
          {' '}(your margin {money(preview.marginMinor / 100)}). The live fee always comes from the courier at order time.
        </div>
      </div>
      )}

      {/* Dispatch + fallback + tracking — only for the Uber Direct courier mode */}
      {form.delivery_mode === 'uber' && (
      <div style={S.card}>
        <h2 style={S.h2}>Dispatch & fallback</h2>
        <div style={S.row}>
          <div style={S.col}>
            <label style={S.label}>Dispatch backend</label>
            <select style={S.input} value={form.dispatch_backend} onChange={(e) => set('dispatch_backend', e.target.value)}>
              <option value="stuart">Stuart courier (UK) — self-serve, live quotes</option>
              <option value="uber_api">Uber Direct API</option>
              <option value="hubrise_bridge">HubRise Bridge</option>
            </select>
          </div>
          {(form.dispatch_backend === 'uber_api' || form.dispatch_backend === 'stuart') && <>
          <div style={S.col}>
            <label style={S.label}>Environment</label>
            <select style={S.input} value={form.env} onChange={(e) => set('env', e.target.value)}>
              <option value="sandbox">Sandbox</option>
              <option value="prod">Production</option>
            </select>
          </div>
          <div style={S.col}><label style={S.label}>Fallback fee if the courier is down (£, blank = block)</label><MoneyField style={S.input} valueMinor={form.fallback_fee_minor} onMinor={(m) => set('fallback_fee_minor', m)} placeholder="block" /></div>
          </>}
        </div>
        {form.dispatch_backend === 'stuart' && (
          <div style={{ ...S.infoNote, marginTop: 10 }}>Stuart couriers are dispatched on your platform Stuart account — <b>no per-venue setup or API keys</b>. Live price + ETA are fetched at order time and priced under your policy above. (UK coverage.)</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--t2)' }}>Text the customer a tracking link</div>
          <div style={S.toggle(form.sms_tracking)} onClick={() => set('sms_tracking', !form.sms_tracking)}><div style={S.knob(form.sms_tracking)} /></div>
        </div>
        {form.dispatch_backend === 'uber_api' && <div style={{ ...S.infoNote, marginTop: 12 }}>No API keys to enter here — ServOS connects this venue to Uber Direct for you (below). The platform credentials live securely on the server.</div>}
      </div>
      )}

      {/* Connect this venue to Uber Direct — platform onboarding via the Organizations API.
          Only for the Uber Direct API courier path; ServOS creates the venue's sub-org. */}
      {form.delivery_mode === 'uber' && form.dispatch_backend === 'uber_api' && (
      <div style={{ ...S.card, borderColor: connected ? '#16a34a66' : 'var(--acc)' }}>
        <h2 style={S.h2}>{connected ? '✓ Connected to Uber Direct' : 'Connect this venue to Uber Direct'}</h2>
        {connected ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55 }}>
              This venue has an Uber Direct account — couriers dispatch automatically with live tracking. Customer ID <code style={{ color: 'var(--acc)' }}>{form.uber_customer_id}</code>.
            </div>
            <div style={{ ...S.row, marginTop: 12 }}>
              <div style={S.col}><label style={S.label}>Manager email — to manage billing in Uber</label><input style={S.input} value={onb.email} onChange={(e) => setOnb((o) => ({ ...o, email: e.target.value }))} placeholder="manager@venue.com" /></div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}><button style={{ ...S.btn, background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr2)' }} disabled={onb.busy} onClick={resendInvite}>{onb.busy ? '…' : 'Send invite'}</button></div>
            </div>
            <div style={{ ...S.infoNote, marginTop: 10 }}>The venue must add a card in Uber Direct (via the invite) before going live in production; sandbox needs no card.</div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.55, margin: '0 0 12px' }}>
              ServOS sets up this venue's Uber Direct account under our platform — <b>no API keys to copy</b>. Check the <b>pickup address</b> above is correct first, then connect. To go live in production the venue adds billing in Uber (we'll email an invite); sandbox needs no card.
            </p>
            <div style={S.row}>
              <div style={S.col}><label style={S.label}>Venue / business name</label><input style={S.input} value={onb.name} onChange={(e) => setOnb((o) => ({ ...o, name: e.target.value }))} placeholder={form.pickup_contact?.name || 'Your venue name'} /></div>
              <div style={S.col}><label style={S.label}>Manager email (optional — sends an invite)</label><input style={S.input} value={onb.email} onChange={(e) => setOnb((o) => ({ ...o, email: e.target.value }))} placeholder="manager@venue.com" /></div>
            </div>
            <button style={{ ...S.btn, marginTop: 12 }} disabled={onb.busy} onClick={connectVenue}>{onb.busy ? 'Connecting…' : 'Create Uber Direct account for this venue'}</button>
          </>
        )}
        {onb.msg && <div style={S.note(onb.msg.err)}>{onb.msg.t}</div>}
      </div>
      )}

      <div>
        <button style={S.btn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        {msg && <div style={S.note(msg.err)}>{msg.t}</div>}
      </div>
    </div>
  );
}
