// src/backoffice/sections/marketing/Campaigns.jsx
//
// Marketing → Campaigns (slice 4): automations (birthday / lapsed) + one-off sends. A campaign targets
// a segment and/or a trigger, optionally attaches an offer (→ each recipient gets a unique single-use
// promo code), and sends via marketing-send (consent/suppression/sandbox enforced there). Automations
// run daily via Vercel Cron → marketing-run; "Run now" forces a test run (never-twice still holds).
// All reads/writes go through the marketing-campaigns edge fn (org-scoped, resolved from the location).

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 820 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: 'var(--font-mono, monospace)', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', minHeight: 64, resize: 'vertical' },
  field: { marginBottom: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  pill: { display: 'inline-block', padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t2)' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--bdr2)' },
};

const STATUS_COLOR = { active: 'var(--grn)', paused: 'var(--amber, #d98a00)', draft: 'var(--t4)', scheduled: 'var(--acc)', archived: 'var(--t4)' };

const BIRTHDAY_PRESET = () => ({
  name: 'Birthday treat', description: 'Send a unique code a week before each customer\'s birthday',
  type: 'automation', channel: 'both', trigger: { type: 'birthday', days_before: 7 }, segment_id: '', offer_id: '',
  subject: 'Happy birthday {{first_name}}! 🎂', from_name: '',
  email_html: '<p>Hi {{first_name}},</p><p>Your birthday treat is here — use <b>{{promo_code}}</b> for {{offer}} on us. See you soon!</p>',
  sms_body: 'Happy birthday {{first_name}}! Your treat: {{promo_code}} ({{offer}}). Reply STOP to opt out.',
  status: 'draft',
});
const BLANK = () => ({ name: '', description: '', type: 'automation', channel: 'email', trigger: { type: 'birthday', days_before: 7 }, segment_id: '', offer_id: '', subject: '', from_name: '', email_html: '', sms_body: '', status: 'draft' });

export default function Campaigns() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState([]);
  const [segments, setSegments] = useState([]);
  const [offers, setOffers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [save, setSave] = useState({});
  const [runMsg, setRunMsg] = useState({});      // { [id]: summary|busy|err }
  const [runsView, setRunsView] = useState(null); // { campaign, runs, sends }

  const call = (action, extra = {}) => supabase.functions.invoke('marketing-campaigns', { body: { action, ops_location_id: locId, ...extra } })
    .then(({ data, error }) => { if (error) throw new Error(error.message); if (data?.error) throw new Error(data.error); return data; });

  const load = async (id = locId) => {
    const { data } = await supabase.functions.invoke('marketing-campaigns', { body: { action: 'list_campaigns', ops_location_id: id } });
    setCampaigns(data?.campaigns || []); setSegments(data?.segments || []); setOffers(data?.offers || []);
  };

  useEffect(() => {
    (async () => {
      try {
        const id = await getActiveLocationSync(); setLocId(id);
        if (!supabase || !id) { setLoading(false); return; }
        await load(id);
      } catch {} finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveCampaign = async () => {
    if (!editing?.name?.trim()) { setSave({ err: 'Give the campaign a name.' }); return; }
    setSave({ busy: true });
    try {
      const c = editing;
      const campaign = {
        ...(c.id ? { id: c.id } : {}),
        name: c.name.trim(), description: c.description || null, type: c.type, channel: c.channel,
        segment_id: c.segment_id || null, offer_id: c.offer_id || null,
        trigger: c.trigger || {}, subject: c.subject || null, from_name: c.from_name || null,
        email_html: c.email_html || null, sms_body: c.sms_body || null,
        status: c.status || 'draft',
      };
      await call('save_campaign', { campaign });
      setEditing(null); setSave({ done: true }); setTimeout(() => setSave((s) => (s.done ? {} : s)), 2000);
      await load();
    } catch (e) { setSave({ err: e.message || 'Save failed' }); }
  };

  const setStatus = async (c, status) => { try { await call('set_status', { id: c.id, status }); await load(); } catch (e) { alert(e.message); } };
  const del = async (c) => { if (!window.confirm(`Delete campaign "${c.name}"?`)) return; try { await call('delete_campaign', { id: c.id }); await load(); } catch (e) { alert(e.message); } };

  const runNow = async (c) => {
    setRunMsg((s) => ({ ...s, [c.id]: { busy: true } }));
    try { const d = await call('run_now', { id: c.id }); setRunMsg((s) => ({ ...s, [c.id]: { summary: d.summary } })); await load(); }
    catch (e) { setRunMsg((s) => ({ ...s, [c.id]: { err: e.message } })); }
  };
  const viewRuns = async (c) => { try { const d = await call('list_runs', { campaign_id: c.id }); setRunsView({ campaign: c, ...d }); } catch (e) { alert(e.message); } };

  const t = editing?.trigger || {};
  const setTrigger = (patch) => setEditing((e) => ({ ...e, trigger: { ...e.trigger, ...patch } }));

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to manage campaigns.</div>;

  return (
    <div>
      <h1 style={S.h1}>Campaigns</h1>
      <div style={S.sub}>Automations (birthday, win-back) and one-off sends. Attach an offer to give each recipient a unique single-use code. Automations run daily; consent &amp; suppression are always checked at send time.</div>

      {/* List */}
      {!editing && !runsView && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Your campaigns</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.ghost} onClick={() => { setEditing(BIRTHDAY_PRESET()); setSave({}); }}>🎂 Birthday preset</button>
              <button style={S.btn} onClick={() => { setEditing(BLANK()); setSave({}); }}>+ New campaign</button>
            </div>
          </div>
          {campaigns.length === 0 && <div style={{ ...S.hint, padding: '14px 0' }}>No campaigns yet. Start with the Birthday preset.</div>}
          {campaigns.map((c) => {
            const rm = runMsg[c.id] || {};
            return (
              <div key={c.id} style={S.row}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{c.name} <span style={{ ...S.pill, marginLeft: 6, color: STATUS_COLOR[c.status] || 'var(--t2)' }}>{c.status}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
                    {c.type === 'automation' ? `Automation · ${c.trigger?.type || '—'}${c.trigger?.type === 'birthday' ? ` (${c.trigger.days_before ?? 7}d before)` : c.trigger?.type === 'lapsed' ? ` (${c.trigger.days ?? 30}d)` : ''}` : 'One-off'} · {c.channel}{c.offer_id ? ' · offer ✓' : ''}{c.last_run_at ? ` · last run ${new Date(c.last_run_at).toLocaleDateString('en-GB')}` : ''}
                  </div>
                  {rm.summary && <div style={{ ...S.ok, marginTop: 6 }}>Ran: {rm.summary.candidates} matched · {rm.summary.sent} sent · {rm.summary.skipped} skipped{rm.summary.failed ? ` · ${rm.summary.failed} failed` : ''}</div>}
                  {rm.err && <div style={S.err}>{rm.err}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button style={S.ghost} onClick={() => runNow(c)} disabled={rm.busy}>{rm.busy ? 'Running…' : 'Run now'}</button>
                  {c.status !== 'active' && <button style={S.ghost} onClick={() => setStatus(c, 'active')}>Activate</button>}
                  {c.status === 'active' && <button style={S.ghost} onClick={() => setStatus(c, 'paused')}>Pause</button>}
                  <button style={S.ghost} onClick={() => viewRuns(c)}>Runs</button>
                  <button style={S.ghost} onClick={() => { setEditing({ ...BLANK(), ...c, segment_id: c.segment_id || '', offer_id: c.offer_id || '', trigger: c.trigger || { type: 'birthday', days_before: 7 } }); setSave({}); }}>Edit</button>
                </div>
              </div>
            );
          })}
          {save.done && <div style={{ ...S.ok, marginTop: 10 }}>✓ Saved</div>}
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div style={S.card}>
          <h2 style={S.h2}>{editing.id ? 'Edit campaign' : 'New campaign'}</h2>
          <div style={S.field}><label style={S.label}>Name</label><input style={S.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Birthday treat" /></div>
          <div style={S.row3}>
            <div style={S.field}><label style={S.label}>Type</label>
              <select style={S.input} value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                <option value="automation">Automation (recurring trigger)</option>
                <option value="one_off">One-off (send to a segment)</option>
              </select>
            </div>
            <div style={S.field}><label style={S.label}>Channel</label>
              <select style={S.input} value={editing.channel} onChange={(e) => setEditing({ ...editing, channel: e.target.value })}>
                <option value="email">Email</option><option value="sms">SMS</option><option value="both">Email + SMS</option>
              </select>
            </div>
            <div style={S.field}><label style={S.label}>Attach offer <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label>
              <select style={S.input} value={editing.offer_id} onChange={(e) => setEditing({ ...editing, offer_id: e.target.value })}>
                <option value="">No code</option>
                {offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          </div>

          {editing.type === 'automation' ? (
            <div style={S.row3}>
              <div style={S.field}><label style={S.label}>Trigger</label>
                <select style={S.input} value={t.type || 'birthday'} onChange={(e) => setTrigger({ type: e.target.value })}>
                  <option value="birthday">Birthday</option><option value="lapsed">Win-back (lapsed)</option>
                </select>
              </div>
              {(t.type || 'birthday') === 'birthday' && <div style={S.field}><label style={S.label}>Days before birthday</label><input style={S.input} type="number" min={0} max={60} value={t.days_before ?? 7} onChange={(e) => setTrigger({ days_before: Number(e.target.value) })} /></div>}
              {t.type === 'lapsed' && <div style={S.field}><label style={S.label}>Days since last visit</label><input style={S.input} type="number" min={1} value={t.days ?? 30} onChange={(e) => setTrigger({ days: Number(e.target.value) })} /></div>}
              <div style={S.field}><label style={S.label}>{editing.type === 'automation' ? 'Also limit to segment' : 'Audience'} <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label>
                <select style={S.input} value={editing.segment_id} onChange={(e) => setEditing({ ...editing, segment_id: e.target.value })}>
                  <option value="">Everyone matching the trigger</option>
                  {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
          ) : (
            <div style={S.field}><label style={S.label}>Audience (segment)</label>
              <select style={S.input} value={editing.segment_id} onChange={(e) => setEditing({ ...editing, segment_id: e.target.value })}>
                <option value="">Select a segment…</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          {(editing.channel === 'email' || editing.channel === 'both') && (
            <>
              <div style={S.field}><label style={S.label}>Email subject</label><input style={S.input} value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} placeholder="Happy birthday {{first_name}}!" /></div>
              <div style={S.field}><label style={S.label}>Email body (HTML)</label><textarea style={S.ta} value={editing.email_html} onChange={(e) => setEditing({ ...editing, email_html: e.target.value })} /></div>
            </>
          )}
          {(editing.channel === 'sms' || editing.channel === 'both') && (
            <div style={S.field}><label style={S.label}>SMS message</label><textarea style={{ ...S.ta, minHeight: 48 }} value={editing.sms_body} onChange={(e) => setEditing({ ...editing, sms_body: e.target.value })} /></div>
          )}
          <div style={S.hint}>Merge tags: <code>{'{{first_name}}'}</code> <code>{'{{name}}'}</code> <code>{'{{promo_code}}'}</code> (when an offer is attached) <code>{'{{offer}}'}</code>. The unsubscribe link / STOP footer is added automatically.</div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
            <button style={S.btn} onClick={saveCampaign} disabled={save.busy}>{save.busy ? 'Saving…' : (editing.id ? 'Save campaign' : 'Create campaign')}</button>
            <button style={S.ghost} onClick={() => { setEditing(null); setSave({}); }}>Cancel</button>
            {save.err && <span style={S.err}>{save.err}</span>}
          </div>
          <div style={{ ...S.hint, marginTop: 10 }}>Tip: create it as a draft, use <b>Run now</b> to test (nothing is sent twice), then <b>Activate</b> to let it run daily.</div>
        </div>
      )}

      {/* Runs view */}
      {runsView && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>Runs — {runsView.campaign.name}</h2>
            <button style={S.ghost} onClick={() => setRunsView(null)}>← Back</button>
          </div>
          {(runsView.runs || []).length === 0 && <div style={S.hint}>No runs yet. Use “Run now” or activate the campaign.</div>}
          {(runsView.runs || []).map((r) => (
            <div key={r.id} style={{ ...S.row, paddingTop: 8, paddingBottom: 8 }}>
              <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>{new Date(r.run_at).toLocaleString('en-GB')} <span style={{ ...S.pill, marginLeft: 6 }}>{r.status}</span></div>
              <div style={{ fontSize: 12, color: 'var(--t3)' }}>{r.candidates} matched · {r.sent} sent · {r.skipped} skipped{r.failed ? ` · ${r.failed} failed` : ''}</div>
            </div>
          ))}
          {(runsView.sends || []).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 4 }}>Recent sends</div>
              {runsView.sends.slice(0, 20).map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--t3)' }}>· {new Date(s.created_at).toLocaleDateString('en-GB')} — {s.channel} — {s.status}{s.promo_code ? ` — ${s.promo_code}` : ''}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
