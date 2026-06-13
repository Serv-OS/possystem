// src/backoffice/sections/ReviewManager.jsx
//
// Review Manager — back office. Screen 3 (the core): the Approval Queue. Every
// review needing a response (card-origin or synced from a platform) shows here
// with an AI-drafted reply; a human edits / regenerates / approves before it's
// sent or posted. Reads review_feedback directly (RLS scopes to the user's
// locations); drafting is the /api/review-draft Vercel fn; approving sends via
// the review-reply edge fn (which posts back to the platform OR messages the
// guest). Drafts live in component state until approved — the review_* tables
// are service-role-write, so nothing persists until the human commits.

import { useEffect, useMemo, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../lib/supabase';

const SOURCE_LABEL = { google: 'Google', tripadvisor: 'TripAdvisor', facebook: 'Facebook', thefork: 'TheFork', trustpilot: 'Trustpilot', booking: 'Booking.com', yelp: 'Yelp', opentable: 'OpenTable', ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat' };
const TONES = ['Warm', 'Professional', 'Apologetic', 'Brief'];

const S = {
  wrap:   { padding: 0 },
  h1:     { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub:    { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  tabs:   { display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' },
  tab:    (on) => ({ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: on ? 'var(--acc)' : 'var(--bg1)', color: on ? '#0b0c10' : 'var(--t2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }),
  row:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16, border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', marginBottom: 14 },
  stars:  (r) => ({ color: r >= 3 ? '#e0b748' : '#b06a3c', fontSize: 15, letterSpacing: 1 }),
  pill:   { fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)' },
  comment:{ fontSize: 13.5, color: 'var(--t1)', lineHeight: 1.55, marginTop: 8 },
  draft:  { width: '100%', boxSizing: 'border-box', minHeight: 96, border: '1px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', resize: 'vertical', outline: 'none', lineHeight: 1.5 },
  btn:    { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  prim:   { background: 'var(--acc)', color: '#0b0c10' },
  ghost:  { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  err:    { fontSize: 12, color: 'var(--red)', marginTop: 6 },
  empty:  { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
};

async function draftFor(fb, venueName) {
  const res = await fetch('/api/review-draft', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      feedback: { rating: fb.rating, comment: fb.comment, private_detail: fb.private_detail, customer_name: fb.customer_name, is_public: fb.is_public, source_platform: fb.source_platform },
      venue: { name: venueName || undefined },
      kind: fb.is_public ? 'public_reply' : 'private_recovery',
      tone: fb.__tone || undefined,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `Draft failed (${res.status})`);
  return j.draft || '';
}

export default function ReviewManager() {
  const [locId, setLocId] = useState(null);
  const [items, setItems] = useState([]);     // review_feedback rows needing a reply
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');  // all | public | private
  const [drafts, setDrafts] = useState({});   // feedbackId → { text, busy, err, sending, done, tone }
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const id = await getActiveLocationSync();
      setLocId(id);
      if (!supabase || !id) { setItems([]); setLoading(false); return; }
      const { data, error: e } = await supabase.from('review_feedback')
        .select('id, rating, comment, private_detail, customer_name, customer_email, customer_phone, is_public, source_platform, origin, status, created_at')
        .eq('location_id', id).in('status', ['new', 'drafted']).order('created_at', { ascending: false }).limit(200);
      if (e) throw e;
      setItems(data || []);
    } catch (e) { setError(e.message || 'Could not load reviews'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => items.filter(f => filter === 'all' || (filter === 'public' ? f.is_public : !f.is_public)), [items, filter]);
  const counts = useMemo(() => ({ all: items.length, public: items.filter(f => f.is_public).length, private: items.filter(f => !f.is_public).length }), [items]);

  const setDraft = (id, patch) => setDrafts(d => ({ ...d, [id]: { ...(d[id] || {}), ...patch } }));

  const generate = async (fb, tone) => {
    setDraft(fb.id, { busy: true, err: '', tone });
    try {
      const text = await draftFor({ ...fb, __tone: tone }, null);
      setDraft(fb.id, { text, busy: false });
    } catch (e) { setDraft(fb.id, { busy: false, err: e.message }); }
  };

  // Auto-draft each item once when it first appears.
  useEffect(() => {
    shown.forEach(fb => { if (drafts[fb.id] === undefined) { setDraft(fb.id, { busy: true }); generate(fb); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const approve = async (fb) => {
    const d = drafts[fb.id];
    const text = (d?.text || '').trim();
    if (!text) { setDraft(fb.id, { err: 'Nothing to send — generate or write a reply first.' }); return; }
    setDraft(fb.id, { sending: true, err: '' });
    try {
      const { data, error: e } = await supabase.functions.invoke('review-reply', { body: { feedback_id: fb.id, text } });
      if (e) { let b = null; try { b = await e.context?.json?.(); } catch {} throw new Error(b?.error || e.message); }
      if (data?.error) throw new Error(data.error);
      setDraft(fb.id, { sending: false, done: true, doneMsg: data?.message || (data?.mode === 'manual' ? 'Saved — open the platform to post.' : 'Sent.') });
      setTimeout(() => setItems(list => list.filter(x => x.id !== fb.id)), 1200);
    } catch (e) { setDraft(fb.id, { sending: false, err: e.message }); }
  };

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Reviews</h1>
      <div style={S.sub}>Every review needing a reply — from your review card and connected platforms. AI drafts each one; you approve, edit, or regenerate before it’s sent.</div>

      <div style={S.tabs}>
        {[['all', `All (${counts.all})`], ['public', `Public (${counts.public})`], ['private', `Private recovery (${counts.private})`]].map(([k, lbl]) =>
          <button key={k} style={S.tab(filter === k)} onClick={() => setFilter(k)}>{lbl}</button>
        )}
        <button style={{ ...S.tab(false), marginLeft: 'auto' }} onClick={load}>↻ Refresh</button>
      </div>

      {error && <div style={S.err}>{error}</div>}
      {loading ? <div style={S.empty}>Loading…</div>
        : shown.length === 0 ? <div style={S.empty}>🎉 Nothing waiting — every review has been handled.</div>
        : shown.map(fb => {
          const d = drafts[fb.id] || {};
          return (
            <div key={fb.id} style={S.row}>
              {/* Left: the original feedback */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14, color: 'var(--t1)' }}>{fb.customer_name || 'Guest'}</strong>
                  <span style={S.stars(fb.rating)}>{'★'.repeat(fb.rating)}{'☆'.repeat(5 - fb.rating)}</span>
                  <span style={S.pill}>{fb.origin === 'synced' ? (SOURCE_LABEL[fb.source_platform] || fb.source_platform) : 'Review card'}</span>
                  <span style={{ ...S.pill, background: fb.is_public ? 'var(--grn-d,rgba(48,164,108,.14))' : 'var(--amber-d,rgba(176,106,60,.14))', color: fb.is_public ? 'var(--grn,#3f7a55)' : 'var(--amber,#8a542e)' }}>
                    {fb.is_public ? 'Public' : 'Private'}
                  </span>
                </div>
                <div style={S.comment}>{fb.comment || fb.private_detail || <em style={{ color: 'var(--t4)' }}>No written comment</em>}</div>
                {!fb.is_public && (fb.customer_email || fb.customer_phone) && (
                  <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>↩ {fb.customer_email || fb.customer_phone}</div>
                )}
              </div>

              {/* Right: the editable AI draft */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ ...S.pill, background: 'var(--acc-d, rgba(90,81,194,.14))', color: 'var(--acc)' }}>AI draft{d.tone ? ` · ${d.tone}` : ''}</span>
                  <select value={d.tone || ''} onChange={e => generate(fb, e.target.value || undefined)} disabled={d.busy || d.sending}
                    style={{ ...S.ghost, padding: '5px 8px', borderRadius: 8, fontSize: 12 }}>
                    <option value="">Tone…</option>
                    {TONES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {d.done ? (
                  <div style={{ ...S.draft, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--grn,#3f7a55)', fontWeight: 700 }}>✓ {d.doneMsg}</div>
                ) : (
                  <textarea style={S.draft} value={d.busy ? '' : (d.text || '')} placeholder={d.busy ? 'Drafting…' : 'Write a reply…'}
                    onChange={e => setDraft(fb.id, { text: e.target.value })} disabled={d.busy || d.sending} />
                )}
                {d.err && <div style={S.err}>{d.err}</div>}
                {!d.done && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button style={{ ...S.btn, ...S.prim }} onClick={() => approve(fb)} disabled={d.busy || d.sending}>
                      {d.sending ? 'Sending…' : (fb.is_public ? 'Approve & post' : 'Approve & send')}
                    </button>
                    <button style={{ ...S.btn, ...S.ghost }} onClick={() => generate(fb, d.tone)} disabled={d.busy || d.sending}>↻ Regenerate</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}
