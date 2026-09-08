// src/backoffice/sections/review/ReviewDashboard.jsx
//
// Reviews — overview dashboard. Reads review_feedback + review_requests directly
// (RLS scopes both to the user's locations) and aggregates everything client-side:
// a KPI row, a 1–5 star distribution, a source breakdown, the latest reviews feed,
// and a small "ask funnel" from review_requests. Read-only — no writes here.
//
// Compliance note: the venue's threshold is internal triage only. We never hide
// the public review path from a guest and never auto-post their review, so this
// screen presents every review plainly and makes no claim about suppressing them.

import { useEffect, useState, useMemo } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';

const SOURCE_LABEL = { google: 'Google', tripadvisor: 'TripAdvisor', facebook: 'Facebook', thefork: 'TheFork', trustpilot: 'Trustpilot', booking: 'Booking.com', yelp: 'Yelp', opentable: 'OpenTable', ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat' };
const STATUS_LABEL = { new: 'Needs reply', drafted: 'Drafted', sent: 'Replied', posted: 'Posted', dismissed: 'Dismissed', resolved: 'Resolved' };
const SUPPRESS_LABEL = { recent_ask: 'Asked recently', frequency_cap: 'Frequency cap', no_consent: 'No consent', outside_window: 'Outside send window', no_contact: 'No contact details', duplicate: 'Duplicate', opted_out: 'Opted out' };

const S = {
  wrap:    { padding: 0 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18, maxWidth: 720, lineHeight: 1.5 },
  toolbar: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 },
  tab:     (on) => ({ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: on ? 'var(--acc)' : 'var(--bg1)', color: on ? '#0b0c10' : 'var(--t2)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }),
  kpiRow:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 },
  kpi:     { padding: 16, border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)' },
  kpiVal:  { fontSize: 26, fontWeight: 800, color: 'var(--t1)', letterSpacing: '-.02em', lineHeight: 1.1 },
  kpiLbl:  { fontSize: 12, color: 'var(--t3)', marginTop: 4, fontWeight: 600 },
  kpiSub:  { fontSize: 11.5, color: 'var(--t4)', marginTop: 2 },
  grid:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 },
  card:    { padding: 16, border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)' },
  cardH:   { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  barRow:  { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  barKey:  { fontSize: 12, color: 'var(--t2)', width: 30, fontWeight: 700, flexShrink: 0 },
  barTrack:{ flex: 1, height: 10, background: 'var(--bg2)', borderRadius: 99, overflow: 'hidden', border: '1px solid var(--bdr)' },
  barFill: (w, c) => ({ width: `${w}%`, height: '100%', background: c, borderRadius: 99, transition: 'width .3s' }),
  barNum:  { fontSize: 12, color: 'var(--t3)', width: 56, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  feedRow: { display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--bdr)' },
  stars:   (r) => ({ color: r >= 3 ? '#e0b748' : '#b06a3c', fontSize: 14, letterSpacing: 1, flexShrink: 0 }),
  pill:    { fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'var(--bg3)', color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, border: '1px solid var(--bdr)', whiteSpace: 'nowrap' },
  snippet: { fontSize: 13, color: 'var(--t2)', lineHeight: 1.5, marginTop: 4 },
  funnel:  { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 },
  funCell: { padding: 14, border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg2)', textAlign: 'center' },
  funVal:  { fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' },
  funLbl:  { fontSize: 11.5, color: 'var(--t3)', marginTop: 3, fontWeight: 600 },
  err:     { fontSize: 12, color: 'var(--red)', marginTop: 6 },
  empty:   { textAlign: 'center', padding: '40px 20px', color: 'var(--t4)', fontSize: 13.5 },
  emptyBig:{ textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
};

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

const statusColor = (st) => st === 'new' ? 'var(--red)' : st === 'drafted' ? '#b06a3c' : 'var(--grn)';
const sourceName = (fb) => fb.origin === 'synced' ? (SOURCE_LABEL[fb.source_platform] || fb.source_platform || 'Platform') : 'Review card';

export default function ReviewDashboard() {
  const [feedback, setFeedback] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoc, setHasLoc] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const id = await getActiveLocationSync();
      setHasLoc(!!id);
      if (!supabase || !id) { setFeedback([]); setRequests([]); setLoading(false); return; }
      const [fbRes, rqRes] = await Promise.all([
        supabase.from('review_feedback')
          .select('id, rating, comment, customer_name, is_public, origin, source_platform, status, created_at')
          .eq('location_id', id).order('created_at', { ascending: false }).limit(1000),
        supabase.from('review_requests')
          .select('id, customer_name, customer_phone, channel, status, suppressed_reason, source_kind, created_at, sent_at')
          .eq('location_id', id).order('created_at', { ascending: false }).limit(1000),
      ]);
      if (fbRes.error) throw fbRes.error;
      if (rqRes.error) throw rqRes.error;
      setFeedback(fbRes.data || []);
      setRequests(rqRes.data || []);
    } catch (e) { setError(e.message || 'Could not load reviews'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const kpis = useMemo(() => {
    const total = feedback.length;
    const rated = feedback.filter(f => Number.isFinite(f.rating) && f.rating > 0);
    const avg = rated.length ? rated.reduce((a, f) => a + f.rating, 0) / rated.length : 0;
    const pub = feedback.filter(f => f.is_public).length;
    const priv = total - pub;
    const pubPct = total ? Math.round((pub / total) * 100) : 0;
    const needsReply = feedback.filter(f => f.status === 'new' || f.status === 'drafted').length;
    return { total, avg, pub, priv, pubPct, privPct: total ? 100 - pubPct : 0, needsReply };
  }, [feedback]);

  const dist = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0]; // index 0 = 1★ … index 4 = 5★
    let max = 0;
    feedback.forEach(f => { const r = Math.round(f.rating); if (r >= 1 && r <= 5) { buckets[r - 1]++; max = Math.max(max, buckets[r - 1]); } });
    return { buckets, max };
  }, [feedback]);

  const sources = useMemo(() => {
    const map = new Map();
    feedback.forEach(f => { const k = sourceName(f); map.set(k, (map.get(k) || 0) + 1); });
    const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows.reduce((m, [, n]) => Math.max(m, n), 0);
    return { rows, max };
  }, [feedback]);

  const recent = useMemo(() => feedback.slice(0, 10), [feedback]);

  const funnel = useMemo(() => {
    let sent = 0, suppressed = 0, failed = 0;
    const reasons = new Map();
    requests.forEach(r => {
      const st = r.status;
      if (st === 'sent' || st === 'delivered' || st === 'clicked' || st === 'completed') sent++;
      else if (st === 'suppressed' || st === 'skipped') {
        suppressed++;
        const reason = r.suppressed_reason || 'unknown';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      } else if (st === 'failed' || st === 'error' || st === 'bounced') failed++;
    });
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
    return { sent, suppressed, failed, total: requests.length, topReason: top ? top[0] : null, topReasonN: top ? top[1] : 0 };
  }, [requests]);

  if (loading) {
    return (
      <div style={S.wrap}>
        <h1 style={S.h1}>Reviews overview</h1>
        <div style={S.emptyBig}>Loading…</div>
      </div>
    );
  }

  const noData = feedback.length === 0 && requests.length === 0;

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>Reviews overview</h1>
      <div style={S.sub}>How your venue is doing across your review card and connected platforms — ratings, sources, the latest reviews, and how your review asks are landing.</div>

      <div style={S.toolbar}>
        <button style={{ ...S.tab(false), marginLeft: 'auto' }} onClick={load}>↻ Refresh</button>
      </div>

      {error && <div style={S.err}>{error}</div>}
      {!hasLoc && <div style={S.empty}>No active location selected — choose a location to see its reviews.</div>}

      {hasLoc && noData ? (
        <div style={S.emptyBig}>No reviews yet. As guests leave feedback on your review card or your connected platforms, they’ll show up here.</div>
      ) : hasLoc && (
        <>
          {/* KPI row */}
          <div style={S.kpiRow}>
            <div style={S.kpi}>
              <div style={S.kpiVal}>{kpis.total ? kpis.avg.toFixed(1) : '—'} <span style={{ fontSize: 16, color: '#e0b748' }}>★</span></div>
              <div style={S.kpiLbl}>Average rating</div>
              <div style={S.kpiSub}>{kpis.total ? `across ${kpis.total} review${kpis.total === 1 ? '' : 's'}` : 'no ratings yet'}</div>
            </div>
            <div style={S.kpi}>
              <div style={S.kpiVal}>{kpis.total}</div>
              <div style={S.kpiLbl}>Total reviews</div>
              <div style={S.kpiSub}>card + platforms</div>
            </div>
            <div style={S.kpi}>
              <div style={S.kpiVal}>{kpis.pubPct}<span style={{ fontSize: 15 }}>%</span> <span style={{ fontSize: 14, color: 'var(--t4)', fontWeight: 700 }}>/ {kpis.privPct}%</span></div>
              <div style={S.kpiLbl}>Public / private</div>
              <div style={S.kpiSub}>{kpis.pub} public · {kpis.priv} private</div>
            </div>
            <div style={S.kpi}>
              <div style={{ ...S.kpiVal, color: kpis.needsReply ? 'var(--red)' : 'var(--grn)' }}>{kpis.needsReply}</div>
              <div style={S.kpiLbl}>Needs reply</div>
              <div style={S.kpiSub}>new or drafted</div>
            </div>
          </div>

          {/* Distribution + Sources */}
          <div style={S.grid}>
            <div style={S.card}>
              <h3 style={S.cardH}>Rating distribution</h3>
              {kpis.total === 0 ? <div style={S.empty}>No ratings yet.</div> : [5, 4, 3, 2, 1].map(star => {
                const n = dist.buckets[star - 1];
                const pct = kpis.total ? Math.round((n / kpis.total) * 100) : 0;
                const w = dist.max ? (n / dist.max) * 100 : 0;
                return (
                  <div key={star} style={S.barRow}>
                    <span style={S.barKey}>{star}★</span>
                    <div style={S.barTrack}><div style={S.barFill(w, star >= 3 ? '#e0b748' : '#b06a3c')} /></div>
                    <span style={S.barNum}>{n} · {pct}%</span>
                  </div>
                );
              })}
            </div>

            <div style={S.card}>
              <h3 style={S.cardH}>By source</h3>
              {sources.rows.length === 0 ? <div style={S.empty}>No sources yet.</div> : sources.rows.map(([name, n]) => {
                const pct = kpis.total ? Math.round((n / kpis.total) * 100) : 0;
                const w = sources.max ? (n / sources.max) * 100 : 0;
                return (
                  <div key={name} style={S.barRow}>
                    <span style={{ ...S.barKey, width: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    <div style={S.barTrack}><div style={S.barFill(w, 'var(--acc)')} /></div>
                    <span style={S.barNum}>{n} · {pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent feed */}
          <div style={{ ...S.card, marginBottom: 16 }}>
            <h3 style={S.cardH}>Recent reviews</h3>
            {recent.length === 0 ? <div style={S.empty}>No reviews yet.</div> : recent.map((fb, i) => (
              <div key={fb.id} style={{ ...S.feedRow, borderBottom: i === recent.length - 1 ? 'none' : S.feedRow.borderBottom }}>
                <span style={S.stars(fb.rating)}>{'★'.repeat(Math.max(0, Math.min(5, Math.round(fb.rating))))}{'☆'.repeat(5 - Math.max(0, Math.min(5, Math.round(fb.rating))))}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13.5, color: 'var(--t1)' }}>{fb.customer_name || 'Guest'}</strong>
                    <span style={S.pill}>{sourceName(fb)}</span>
                    <span style={{ ...S.pill, background: 'transparent', color: statusColor(fb.status), borderColor: statusColor(fb.status) }}>{STATUS_LABEL[fb.status] || fb.status}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--t4)', marginLeft: 'auto' }}>{relTime(fb.created_at)}</span>
                  </div>
                  {fb.comment
                    ? <div style={S.snippet}>{fb.comment.length > 180 ? fb.comment.slice(0, 180).trimEnd() + '…' : fb.comment}</div>
                    : <div style={{ ...S.snippet, color: 'var(--t4)', fontStyle: 'italic' }}>No written comment</div>}
                </div>
              </div>
            ))}
          </div>

          {/* Ask funnel */}
          <div style={S.card}>
            <h3 style={S.cardH}>Ask funnel</h3>
            {funnel.total === 0 ? (
              <div style={S.empty}>No review asks sent yet. Turn on review asks in Settings to start inviting guests.</div>
            ) : (
              <>
                <div style={S.funnel}>
                  <div style={S.funCell}><div style={{ ...S.funVal, color: 'var(--grn)' }}>{funnel.sent}</div><div style={S.funLbl}>Sent</div></div>
                  <div style={S.funCell}><div style={{ ...S.funVal, color: '#b06a3c' }}>{funnel.suppressed}</div><div style={S.funLbl}>Suppressed</div></div>
                  <div style={S.funCell}><div style={{ ...S.funVal, color: funnel.failed ? 'var(--red)' : 'var(--t3)' }}>{funnel.failed}</div><div style={S.funLbl}>Failed</div></div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 12 }}>
                  {funnel.total} ask{funnel.total === 1 ? '' : 's'} considered.
                  {funnel.topReason && <> Most common suppression: <strong style={{ color: 'var(--t2)' }}>{SUPPRESS_LABEL[funnel.topReason] || funnel.topReason}</strong> ({funnel.topReasonN}).</>}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
