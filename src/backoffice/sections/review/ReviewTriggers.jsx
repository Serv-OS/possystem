// src/backoffice/sections/review/ReviewTriggers.jsx
//
// Review Triggers — back office. The automated ask engine: config + a live
// tester. Loads ask_* settings via the review-admin edge fn (get_config) and
// writes changes back via save_settings (the review_* tables are
// service-role-write, so all config goes through the fn). The tester fires the
// review-request edge fn directly: send_now for a one-off test ask, and scan to
// run the periodic eligibility sweep on demand. "Recent asks" reads
// review_requests directly (RLS scopes it to the user's locations).
//
// Compliance: asks go to EVERY guest (the review threshold is internal triage
// only — it never gates who can leave a public review). Every SMS must carry a
// STOP opt-out and we honour standing marketing opt-outs (PECR).

import { useEffect, useState, useMemo } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const CHANNELS = [['sms', 'SMS'], ['email', 'Email']];

// review_settings ask_* defaults (used when get_config returns settings: null).
const DEFAULTS = {
  ask_enabled: false,
  ask_channel: 'sms',
  ask_delay_minutes: 60,
  ask_delay_collection_minutes: 30,
  ask_window_start: 10,
  ask_window_end: 20,
  ask_frequency_days: 90,
  ask_message: 'Hi {name}, thanks for visiting {venue}! We\'d love a quick review — it really helps us: {link}\n\nReply STOP to opt out.',
};

const SAMPLE = { name: 'Alex', venue: 'The Crown', link: 'rvw.to/abc123' };

const STATUS_TONE = {
  sent: 'var(--grn,#3f7a55)', delivered: 'var(--grn,#3f7a55)',
  suppressed: 'var(--t4)', skipped: 'var(--t4)',
  failed: 'var(--red)', error: 'var(--red)',
  queued: 'var(--t3)', pending: 'var(--t3)',
};

const S = {
  wrap:   { padding: 0 },
  h1:     { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub:    { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card:   { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16 },
  cardHd: { fontSize: 15, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  cardSub:{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 },
  grid:   { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 16 },
  field:  { display: 'flex', flexDirection: 'column', gap: 6 },
  label:  { fontSize: 12, fontWeight: 700, color: 'var(--t2)', letterSpacing: '.01em' },
  hint:   { fontSize: 11.5, color: 'var(--t4)', lineHeight: 1.4 },
  input:  { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 11px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  ta:     { width: '100%', boxSizing: 'border-box', minHeight: 92, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', resize: 'vertical', outline: 'none', lineHeight: 1.5 },
  btn:    { padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  prim:   { background: 'var(--acc)', color: '#0b0c10' },
  ghost:  { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  err:    { fontSize: 12.5, color: 'var(--red)', marginTop: 8 },
  ok:     { fontSize: 12.5, color: 'var(--grn,#3f7a55)', fontWeight: 700, marginTop: 8 },
  empty:  { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  th:     { textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 10px', borderBottom: '1px solid var(--bdr)' },
  td:     { fontSize: 13, color: 'var(--t1)', padding: '9px 10px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'top' },
  pill:   { fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  note:   { border: '1px solid var(--bdr)', borderLeft: '3px solid var(--acc)', borderRadius: 12, background: 'var(--bg2)', padding: '12px 14px', fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.55, marginTop: 16 },
  toggle: (on) => ({ width: 44, height: 26, borderRadius: 99, border: '1px solid var(--bdr2)', background: on ? 'var(--acc)' : 'var(--bg3)', position: 'relative', cursor: 'pointer', flex: '0 0 auto', transition: 'background .15s' }),
  knob:   (on) => ({ position: 'absolute', top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: '50%', background: on ? '#0b0c10' : 'var(--t3)', transition: 'left .15s' }),
  preview:{ border: '1px dashed var(--bdr2)', borderRadius: 10, background: 'var(--bg2)', padding: '11px 13px', fontSize: 13, color: 'var(--t1)', lineHeight: 1.55, whiteSpace: 'pre-wrap', marginTop: 8 },
};

function fillTemplate(tpl, vals) {
  return String(tpl || '').replace(/\{(name|venue|link)\}/g, (_, k) => vals[k]);
}
function fmtTime(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}
function hourLabel(h) { return `${String(h).padStart(2, '0')}:00`; }

// Unwrap an edge-function error to its JSON body where possible.
async function fnError(e) {
  let b = null;
  try { b = await e?.context?.json?.(); } catch { /* not json */ }
  return b?.error || e?.message || 'Request failed';
}

export default function ReviewTriggers() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [form, setForm] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [saveErr, setSaveErr] = useState('');

  // Tester state.
  const [testPhone, setTestPhone] = useState('');
  const [testName, setTestName] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [testRes, setTestRes] = useState(null);   // { ok, error, link }
  const [scanBusy, setScanBusy] = useState(false);
  const [scanRes, setScanRes] = useState(null);   // { ok, sent, suppressed, considered, error }

  // Recent asks.
  const [recent, setRecent] = useState([]);

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const loadConfig = async () => {
    setLoading(true); setError('');
    try {
      const id = await getActiveLocationSync();
      setLocId(id);
      if (!supabase || !id) { setLoading(false); return; }   // mock / no location
      const { data, error: e } = await supabase.functions.invoke('review-admin', {
        body: { action: 'get_config', ops_location_id: id },
      });
      if (e) throw new Error(await fnError(e));
      if (data?.error) throw new Error(data.error);
      const s = data?.settings || {};
      // Treat null settings as defaults; fall back per-field so a partial row still works.
      setForm({
        ask_enabled: s.ask_enabled ?? DEFAULTS.ask_enabled,
        ask_channel: s.ask_channel ?? DEFAULTS.ask_channel,
        ask_delay_minutes: s.ask_delay_minutes ?? DEFAULTS.ask_delay_minutes,
        ask_delay_collection_minutes: s.ask_delay_collection_minutes ?? DEFAULTS.ask_delay_collection_minutes,
        ask_window_start: s.ask_window_start ?? DEFAULTS.ask_window_start,
        ask_window_end: s.ask_window_end ?? DEFAULTS.ask_window_end,
        ask_frequency_days: s.ask_frequency_days ?? DEFAULTS.ask_frequency_days,
        ask_message: s.ask_message ?? DEFAULTS.ask_message,
      });
    } catch (e) { setError(e.message || 'Could not load ask settings'); }
    finally { setLoading(false); }
  };

  const loadRecent = async () => {
    try {
      const id = locId || await getActiveLocationSync();
      if (!supabase || !id) { setRecent([]); return; }
      const { data, error: e } = await supabase.from('review_requests')
        .select('id, customer_name, customer_phone, channel, status, suppressed_reason, source_kind, created_at, sent_at')
        .eq('location_id', id).order('created_at', { ascending: false }).limit(20);
      if (e) throw e;
      setRecent(data || []);
    } catch { /* non-fatal — table just renders empty */ }
  };

  useEffect(() => { loadConfig(); }, []);
  useEffect(() => { if (locId) loadRecent(); /* eslint-disable-next-line */ }, [locId]);

  const save = async () => {
    if (!supabase || !locId) return;
    setSaving(true); setSaveErr('');
    try {
      const settings = {
        ask_enabled: !!form.ask_enabled,
        ask_channel: form.ask_channel,
        ask_delay_minutes: Number(form.ask_delay_minutes) || 0,
        ask_delay_collection_minutes: Number(form.ask_delay_collection_minutes) || 0,
        ask_window_start: Number(form.ask_window_start),
        ask_window_end: Number(form.ask_window_end),
        ask_frequency_days: Number(form.ask_frequency_days) || 0,
        ask_message: form.ask_message,
      };
      const { data, error: e } = await supabase.functions.invoke('review-admin', {
        body: { action: 'save_settings', ops_location_id: locId, settings },
      });
      if (e) throw new Error(await fnError(e));
      if (data?.error) throw new Error(data.error);
      setSavedAt(Date.now());
    } catch (e) { setSaveErr(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  const sendTest = async () => {
    const phone = testPhone.trim();
    if (!phone) { setTestRes({ ok: false, error: 'Enter a phone number to test.' }); return; }
    setTestBusy(true); setTestRes(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('review-request', {
        body: { action: 'send_now', ops_location_id: locId, phone, name: testName.trim() || undefined },
      });
      if (e) throw new Error(await fnError(e));
      if (data?.error) { setTestRes({ ok: false, error: data.error, link: data.link }); }
      else { setTestRes({ ok: true, link: data?.link }); }
      loadRecent();
    } catch (e) { setTestRes({ ok: false, error: e.message || 'Send failed' }); }
    finally { setTestBusy(false); }
  };

  const runScan = async () => {
    setScanBusy(true); setScanRes(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('review-request', {
        body: { action: 'scan', ops_location_id: locId },
      });
      if (e) throw new Error(await fnError(e));
      if (data?.error) { setScanRes({ ok: false, error: data.error }); }
      else { setScanRes({ ok: true, sent: data?.sent ?? 0, suppressed: data?.suppressed ?? 0, considered: data?.considered ?? 0 }); }
      loadRecent();
    } catch (e) { setScanRes({ ok: false, error: e.message || 'Scan failed' }); }
    finally { setScanBusy(false); }
  };

  const previewText = useMemo(() => fillTemplate(form.ask_message, SAMPLE), [form.ask_message]);
  const justSaved = savedAt && (Date.now() - savedAt < 4000);

  // ── Guards ───────────────────────────────────────────────────────────────
  if (loading) return <div style={S.wrap}><h1 style={S.h1}>Review asks</h1><div style={S.empty}>Loading…</div></div>;
  if (!supabase || !locId) {
    return (
      <div style={S.wrap}>
        <h1 style={S.h1}>Review asks</h1>
        <div style={S.sub}>Automatically ask guests for a review after they visit.</div>
        <div style={S.empty}>No active location — open a venue in the back office to configure review asks.</div>
      </div>
    );
  }

  const hourOpts = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Review asks</h1>
      <div style={S.sub}>Automatically invite guests to leave a review after they visit — and test it before you switch it on.</div>

      {error && <div style={S.err}>{error}</div>}

      {/* ── Engine config ───────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2 style={S.cardHd}>Automated asks</h2>
            <div style={S.cardSub}>Send an invite a set time after each order, within your chosen window.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: form.ask_enabled ? 'var(--grn,#3f7a55)' : 'var(--t3)' }}>
              {form.ask_enabled ? 'On' : 'Off'}
            </span>
            <div role="switch" aria-checked={!!form.ask_enabled} style={S.toggle(form.ask_enabled)}
                 onClick={() => set({ ask_enabled: !form.ask_enabled })}>
              <div style={S.knob(form.ask_enabled)} />
            </div>
          </div>
        </div>

        <div style={S.grid}>
          <div style={S.field}>
            <label style={S.label}>Channel</label>
            <select style={S.input} value={form.ask_channel} onChange={e => set({ ask_channel: e.target.value })}>
              {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <span style={S.hint}>How the ask is delivered to the guest.</span>
          </div>

          <div style={S.field}>
            <label style={S.label}>Delay after a table closes</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="0" style={{ ...S.input, maxWidth: 110 }} value={form.ask_delay_minutes}
                     onChange={e => set({ ask_delay_minutes: e.target.value })} />
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>minutes</span>
            </div>
            <span style={S.hint}>Time to wait after a dine-in check is closed.</span>
          </div>

          <div style={S.field}>
            <label style={S.label}>Delay after collection / delivery</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="0" style={{ ...S.input, maxWidth: 110 }} value={form.ask_delay_collection_minutes}
                     onChange={e => set({ ask_delay_collection_minutes: e.target.value })} />
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>minutes</span>
            </div>
            <span style={S.hint}>Time to wait after a collection or delivery order.</span>
          </div>

          <div style={S.field}>
            <label style={S.label}>Send window</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select style={{ ...S.input, maxWidth: 100 }} value={form.ask_window_start}
                      onChange={e => set({ ask_window_start: Number(e.target.value) })}>
                {hourOpts(0, 23).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>–</span>
              <select style={{ ...S.input, maxWidth: 100 }} value={form.ask_window_end}
                      onChange={e => set({ ask_window_end: Number(e.target.value) })}>
                {hourOpts(1, 24).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <span style={S.hint}>
              Asks only go out between these hours{Number(form.ask_window_end) <= Number(form.ask_window_start)
                ? <span style={{ color: 'var(--red)' }}> — end must be after start.</span>
                : ` (e.g. ${hourLabel(form.ask_window_start)}–${hourLabel(form.ask_window_end)}).`}
            </span>
          </div>

          <div style={S.field}>
            <label style={S.label}>Don’t re-ask within</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="0" style={{ ...S.input, maxWidth: 110 }} value={form.ask_frequency_days}
                     onChange={e => set({ ask_frequency_days: e.target.value })} />
              <span style={{ fontSize: 13, color: 'var(--t3)' }}>days</span>
            </div>
            <span style={S.hint}>A guest won’t be asked again inside this window.</span>
          </div>
        </div>

        {/* Message template */}
        <div style={{ ...S.field, marginTop: 16 }}>
          <label style={S.label}>Message</label>
          <textarea style={S.ta} value={form.ask_message} onChange={e => set({ ask_message: e.target.value })}
                    placeholder="Hi {name}, thanks for visiting {venue}…" />
          <span style={S.hint}>
            Placeholders: <code style={{ color: 'var(--t2)' }}>{'{name}'}</code>{' '}
            <code style={{ color: 'var(--t2)' }}>{'{venue}'}</code>{' '}
            <code style={{ color: 'var(--t2)' }}>{'{link}'}</code> — swapped in per guest.
            {form.ask_channel === 'sms' && !/stop/i.test(form.ask_message) &&
              <span style={{ color: 'var(--red)' }}> Add a STOP opt-out for SMS (PECR).</span>}
          </span>
          <div style={{ ...S.label, marginTop: 10 }}>Preview</div>
          <div style={S.preview}>{previewText}</div>
        </div>

        {/* Compliance note */}
        <div style={S.note}>
          <strong style={{ color: 'var(--t1)' }}>Sent to every guest, fairly.</strong> Review asks go to all guests with
          contact details — the review threshold is only used internally to triage and emphasise feedback; it never decides
          who gets asked or who can leave a public review. Every SMS must include a <strong>STOP</strong> opt-out, and we
          always honour standing marketing opt-outs and unsubscribes (PECR).
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button style={{ ...S.btn, ...S.prim }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {justSaved && <span style={S.ok}>✓ Saved</span>}
          {saveErr && <span style={S.err}>{saveErr}</span>}
        </div>
      </div>

      {/* ── Test it ─────────────────────────────────────────────────────── */}
      <div style={S.card}>
        <h2 style={S.cardHd}>Test it</h2>
        <div style={S.cardSub}>Fire a single ask to your own phone, or run the eligibility scan on demand.</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginTop: 16, alignItems: 'end' }}>
          <div style={S.field}>
            <label style={S.label}>Phone</label>
            <input style={S.input} value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="07700 900000" />
          </div>
          <div style={S.field}>
            <label style={S.label}>Name <span style={{ color: 'var(--t4)', fontWeight: 400 }}>(optional)</span></label>
            <input style={S.input} value={testName} onChange={e => setTestName(e.target.value)} placeholder="Alex" />
          </div>
          <div>
            <button style={{ ...S.btn, ...S.prim, width: '100%' }} onClick={sendTest} disabled={testBusy}>
              {testBusy ? 'Sending…' : 'Send a test ask'}
            </button>
          </div>
        </div>

        {testRes && (testRes.ok
          ? <div style={S.ok}>✓ Test ask sent.{testRes.link && <span style={{ fontWeight: 400, color: 'var(--t2)' }}> Link: <a href={testRes.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)' }}>{testRes.link}</a></span>}</div>
          : <div style={S.err}>{testRes.error || 'Send failed'}{testRes.link && <span style={{ color: 'var(--t3)' }}> · {testRes.link}</span>}</div>
        )}

        <div style={{ height: 1, background: 'var(--bdr)', margin: '18px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <button style={{ ...S.btn, ...S.ghost }} onClick={runScan} disabled={scanBusy}>
            {scanBusy ? 'Scanning…' : 'Run the ask scan now'}
          </button>
          <span style={S.hint}>Checks recent orders and sends to anyone newly eligible — same job the scheduler runs.</span>
        </div>

        {scanRes && (scanRes.ok
          ? <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <span style={{ ...S.pill, background: 'var(--grn-d,rgba(48,164,108,.14))', color: 'var(--grn,#3f7a55)' }}>Sent {scanRes.sent}</span>
              <span style={S.pill}>Suppressed {scanRes.suppressed}</span>
              <span style={S.pill}>Considered {scanRes.considered}</span>
            </div>
          : <div style={S.err}>{scanRes.error || 'Scan failed'}</div>
        )}
      </div>

      {/* ── Recent asks ─────────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={S.cardHd}>Recent asks</h2>
            <div style={S.cardSub}>The last 20 review invites — sent and suppressed.</div>
          </div>
          <button style={{ ...S.btn, ...S.ghost }} onClick={loadRecent}>↻ Refresh</button>
        </div>

        {recent.length === 0
          ? <div style={S.empty}>No asks yet — send a test or run the scan above.</div>
          : (
            <div style={{ overflowX: 'auto', marginTop: 14 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={S.th}>Time</th>
                    <th style={S.th}>Guest</th>
                    <th style={S.th}>Channel</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Suppressed reason</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={r.id}>
                      <td style={S.td}>{fmtTime(r.sent_at || r.created_at)}</td>
                      <td style={S.td}>{r.customer_name || r.customer_phone || <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                      <td style={S.td}><span style={S.pill}>{r.channel || '—'}</span></td>
                      <td style={{ ...S.td, color: STATUS_TONE[r.status] || 'var(--t1)', fontWeight: 700, textTransform: 'capitalize' }}>
                        {r.status || '—'}
                      </td>
                      <td style={{ ...S.td, color: 'var(--t3)' }}>{r.suppressed_reason || <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
