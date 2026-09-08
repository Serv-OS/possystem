// src/backoffice/sections/marketing/QuickSend.jsx
//
// Marketing → Quick send (v2 Phase 1): compose an offer and BULK-send it to a segment right now —
// no saved campaign to manage. Pick audience → channel → message (+ optional offer for unique codes)
// → see the live recipient count → Send now (with confirm). Runs through the same engine
// (ephemeral one_off campaign) so consent/suppression/sandbox all apply, and you can download the
// recipient list (with each unique code) as CSV afterwards.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import EmailBuilder from './EmailBuilder';
import { compileEmail, MERGE_TAGS, STARTER_BLOCKS } from '../../../lib/emailCompiler';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 880 },
  label: { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  ta: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 10, padding: '9px 12px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none', minHeight: 64, resize: 'vertical' },
  field: { marginBottom: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 },
  hint: { fontSize: 11.5, color: 'var(--t4)', marginTop: 5, lineHeight: 1.45 },
  btn: { padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  ok: { fontSize: 13, color: 'var(--grn)', fontWeight: 700 },
  err: { fontSize: 12, color: 'var(--red)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  count: { display: 'inline-block', padding: '4px 12px', borderRadius: 99, fontSize: 13, fontWeight: 800, background: 'var(--bg2)', border: '1px solid var(--bdr2)', color: 'var(--t1)' },
};

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function QuickSend() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState([]);
  const [prebuilt, setPrebuilt] = useState([]);
  const [offers, setOffers] = useState([]);
  const [form, setForm] = useState({ name: '', segment_id: '', channel: 'email', offer_id: '', subject: '', email_blocks: STARTER_BLOCKS(), sms_body: '' });
  const [count, setCount] = useState(null);          // audience size
  const [counting, setCounting] = useState(false);
  const [send, setSend] = useState({});              // { busy|err|summary, campaign_id }

  const load = async (id) => {
    const { data } = await supabase.functions.invoke('marketing-campaigns', { body: { action: 'list_campaigns', ops_location_id: id } });
    setSegments(data?.segments || []); setPrebuilt(data?.prebuilt || []); setOffers(data?.offers || []);
  };
  useEffect(() => {
    (async () => { try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await load(id); } catch {} finally { setLoading(false); } })();
  }, []);

  // Live audience count when the segment changes (prebuilt → preview by definition, saved → by id).
  const previewCount = async (segRef) => {
    if (!segRef) { setCount(null); return; }
    setCounting(true); setCount(null);
    try {
      const body = { action: 'preview_segment', ops_location_id: locId };
      if (String(segRef).startsWith('prebuilt:')) { const p = prebuilt.find((x) => `prebuilt:${x.key}` === segRef); if (!p) { setCounting(false); return; } body.definition = p.definition; }
      else body.id = segRef;
      const { data } = await supabase.functions.invoke('marketing-segments', { body });
      setCount(typeof data?.count === 'number' ? data.count : null);
    } catch { setCount(null); } finally { setCounting(false); }
  };
  const pickSegment = (segRef) => { setForm((f) => ({ ...f, segment_id: segRef })); previewCount(segRef); };

  const doSend = async () => {
    if (!form.segment_id) { setSend({ err: 'Pick an audience first.' }); return; }
    if ((form.channel === 'email' || form.channel === 'both') && !form.subject.trim()) { setSend({ err: 'Add an email subject.' }); return; }
    if ((form.channel === 'sms' || form.channel === 'both') && !form.sms_body.trim()) { setSend({ err: 'Add an SMS message.' }); return; }
    if (!window.confirm(`Send now to ${count != null ? count : 'the selected'} customer${count === 1 ? '' : 's'}? Unique codes will be issued (if an offer is attached) and messages sent — this can't be undone.`)) return;
    setSend({ busy: true });
    try {
      const html = compileEmail(form.email_blocks || []);
      const { data, error } = await supabase.functions.invoke('marketing-campaigns', { body: { action: 'blast_send', ops_location_id: locId, blast: {
        name: form.name || 'Quick send', segment_id: form.segment_id, channel: form.channel, offer_id: form.offer_id || null,
        subject: form.subject || null, email_html: html, email_blocks: form.email_blocks || null, sms_body: form.sms_body || null,
      } } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      setSend({ summary: data.summary, campaign_id: data.campaign_id });
    } catch (e) { setSend({ err: e.message || 'Send failed' }); }
  };

  const downloadCsv = async () => {
    try {
      const { data } = await supabase.functions.invoke('marketing-campaigns', { body: { action: 'blast_recipients', ops_location_id: locId, campaign_id: send.campaign_id } });
      const rows = data?.recipients || [];
      const csv = ['customer_id,name,email,phone,promo_code,status', ...rows.map((r) => [r.customer_id, csvCell(r.name), csvCell(r.email), csvCell(r.phone), r.promo_code, r.status].join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `quicksend-${send.campaign_id}.csv`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert(e.message); }
  };

  const segmentOptions = () => (
    <>
      {prebuilt.length > 0 && <optgroup label="Prebuilt audiences">{prebuilt.map((p) => <option key={p.key} value={`prebuilt:${p.key}`}>{p.icon} {p.name}</option>)}</optgroup>}
      {segments.length > 0 && <optgroup label="Your segments">{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
    </>
  );
  const smsLen = (form.sms_body || '').length;
  const smsSeg = smsLen === 0 ? 0 : smsLen <= 160 ? 1 : Math.ceil(smsLen / 153);

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to send.</div>;

  // ---- result screen ----
  if (send.summary) {
    const sm = send.summary;
    return (
      <div>
        <h1 style={S.h1}>Quick send</h1>
        <div style={S.card}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--grn)', marginBottom: 6 }}>✓ Sent</div>
          <div style={{ fontSize: 14, color: 'var(--t1)' }}>{sm.candidates} matched · <b>{sm.sent} sent</b> · {sm.skipped} skipped{sm.failed ? ` · ${sm.failed} failed` : ''}</div>
          <div style={{ ...S.hint, marginTop: 6 }}>Skipped = no consent, suppressed, or unreachable on the chosen channel. Sandbox mode logs instead of delivering until a provider is configured.</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button style={S.ghost} onClick={downloadCsv}>⬇ Download recipients (CSV)</button>
            <button style={S.btn} onClick={() => { setSend({}); setForm({ name: '', segment_id: '', channel: 'email', offer_id: '', subject: '', email_blocks: STARTER_BLOCKS(), sms_body: '' }); setCount(null); }}>New quick send</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 style={S.h1}>Quick send</h1>
      <div style={S.sub}>Blast an offer to a segment right now. Pick the audience, write the message, attach an offer for unique single-use codes, and send. Consent &amp; suppression are always checked.</div>

      <div style={S.card}>
        <div style={S.row3}>
          <div style={S.field}><label style={S.label}>Audience</label>
            <select style={S.input} value={form.segment_id} onChange={(e) => pickSegment(e.target.value)}>
              <option value="">Select…</option>
              {segmentOptions()}
            </select>
          </div>
          <div style={S.field}><label style={S.label}>Channel</label>
            <select style={S.input} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}><option value="email">Email</option><option value="sms">SMS</option><option value="both">Email + SMS</option></select>
          </div>
          <div style={S.field}><label style={S.label}>Attach offer <span style={{ color: 'var(--t4)', fontWeight: 500 }}>opt.</span></label>
            <select style={S.input} value={form.offer_id} onChange={(e) => setForm({ ...form, offer_id: e.target.value })}><option value="">No code</option>{offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </div>
        </div>
        <div style={{ marginTop: 2, marginBottom: 6 }}>
          {form.segment_id
            ? <span style={S.count}>{counting ? 'Counting…' : count != null ? `${count} customer${count === 1 ? '' : 's'} in this audience` : 'Count unavailable'}</span>
            : <span style={{ ...S.hint, marginTop: 0 }}>Pick an audience to see how many it reaches.</span>}
          <span style={{ ...S.hint, marginTop: 0, marginLeft: 8 }}>Not everyone is reachable — those without consent or who unsubscribed are skipped at send.</span>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.field}><label style={S.label}>Internal name <span style={{ color: 'var(--t4)', fontWeight: 500 }}>(for your reports)</span></label><input style={S.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Friday flash offer" /></div>
        {(form.channel === 'email' || form.channel === 'both') && (
          <>
            <div style={S.field}><label style={S.label}>Email subject</label><input style={S.input} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="A little something for you, {{first_name}}" /></div>
            <div style={S.field}><label style={S.label}>Email content</label><EmailBuilder blocks={form.email_blocks} onChange={(b) => setForm({ ...form, email_blocks: b })} locationId={locId} /></div>
          </>
        )}
        {(form.channel === 'sms' || form.channel === 'both') && (
          <div style={S.field}><label style={S.label}>SMS message</label>
            <div style={{ marginBottom: 6 }}>{MERGE_TAGS.map(([t]) => <button key={t} type="button" onClick={() => setForm((f) => ({ ...f, sms_body: (f.sms_body || '') + t }))} style={{ ...S.ghost, padding: '3px 8px', marginRight: 5, fontFamily: 'var(--font-mono,monospace)', fontSize: 11 }}>{t}</button>)}</div>
            <textarea style={S.ta} value={form.sms_body} onChange={(e) => setForm({ ...form, sms_body: e.target.value })} placeholder="Hi {{first_name}}, today only: {{promo_code}}" />
            <div style={S.hint}>{smsLen} chars · {smsSeg} SMS segment{smsSeg === 1 ? '' : 's'} · a “Reply STOP” line is appended automatically.</div>
          </div>
        )}
        <div style={S.hint}>Merge tags: <code>{'{{first_name}}'}</code> <code>{'{{promo_code}}'}</code> (with an offer) <code>{'{{offer}}'}</code>. Unsubscribe / STOP footer added automatically.</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16 }}>
          <button style={S.btn} onClick={doSend} disabled={send.busy || !form.segment_id}>{send.busy ? 'Sending…' : `Send now${count != null ? ` → ${count}` : ''}`}</button>
          {send.err && <span style={S.err}>{send.err}</span>}
        </div>
      </div>
    </div>
  );
}
