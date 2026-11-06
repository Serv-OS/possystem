// src/backoffice/sections/marketing/WebsiteReport.jsx (6 Nov 2026, 5.12.67)
//
// Peter: "website reporting as a whole ... website traffic reports". Customers, Website report:
// what the venue's own website (the ServOS website builder site) saw over the window. One call to
// marketing-report (action website) runs website_report on the Ops database: visits and visitors
// per day (the venue's own days), top pages, where people came from, the utm sources, and the
// visits that came from a campaign or automation link (the tracked email redirect's sv_m token, or
// a utm_campaign naming one). The page view ping is switched on and off per site in Website
// builder, Overview, "Count visits". No cookie is set, so no banner is needed.
// 5.12.68: a company with more than one website gets a site picker (host) and a "By site" table;
// website_report takes the host and always lists every site.

import { useEffect, useState } from 'react';
import { supabase, getActiveLocationSync } from '../../../lib/supabase';
import { useMarketingSites } from './useMarketingSites';
import { MarketingSitesBar } from './MarketingSites';
import { dateNumeric } from '../../../lib/venueDates';

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 18 },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 18, marginBottom: 16, maxWidth: 920 },
  h2: { fontSize: 15.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 12px' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10, marginBottom: 16, maxWidth: 920 },
  kpi: { border: '1px solid var(--bdr)', borderRadius: 12, background: 'var(--bg1)', padding: 14 },
  kpiV: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', letterSpacing: '-.01em' },
  kpiL: { fontSize: 11.5, color: 'var(--t3)', marginTop: 2, fontWeight: 600 },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em', padding: '6px 8px', borderBottom: '1px solid var(--bdr)' },
  td: { fontSize: 13, color: 'var(--t1)', padding: '8px', borderBottom: '1px solid var(--bdr2)' },
  tdr: { fontSize: 13, color: 'var(--t2)', padding: '8px', borderBottom: '1px solid var(--bdr2)', textAlign: 'right', fontFamily: 'var(--font-mono,monospace)' },
  seg: { display: 'inline-flex', border: '1px solid var(--bdr2)', borderRadius: 8, overflow: 'hidden' },
  segBtn: (on) => ({ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: 'none', background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t2)' }),
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, maxWidth: 920 },
};

function Bars({ days }) {
  const max = Math.max(1, ...days.map((d) => Number(d.visits) || 0));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, padding: '4px 0' }}>
      {days.map((d) => {
        const v = Number(d.visits) || 0, c = Number(d.from_campaigns) || 0;
        return (
          <div key={d.day} title={`${dateNumeric(d.day)}: ${v} visits, ${d.visitors} visitors, ${c} from campaigns`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 4 }}>
            <div style={{ height: `${Math.round((v / max) * 100)}%`, background: 'var(--bdr2)', borderRadius: '3px 3px 0 0', position: 'relative', minHeight: v ? 2 : 0 }}>
              {c > 0 && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.round((c / v) * 100)}%`, background: 'var(--acc)', borderRadius: '3px 3px 0 0' }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Table({ rows, first, keyOf, cols }) {
  if (!rows.length) return <div style={{ fontSize: 13, color: 'var(--t4)' }}>Nothing in this window.</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th style={S.th}>{first}</th>{cols.map((c) => <th key={c[0]} style={{ ...S.th, textAlign: 'right' }}>{c[0]}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={keyOf(r)}><td style={{ ...S.td, wordBreak: 'break-all' }}>{keyOf(r)}</td>{cols.map((c) => <td key={c[0]} style={S.tdr}>{r[c[1]]}</td>)}</tr>)}</tbody>
    </table>
  );
}

export default function WebsiteReport() {
  const [locId, setLocId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState('');        // '' = every site
  const [sites, setSites] = useState([]);      // every site of the company, from the last report
  const [venues, setVenues] = useState([]);    // 5.12.69: the organisation's venues (marketing-segments, venues)
  // 5.12.69: the Sites control: one venue picks the website tied to it (web_pages.location_id), when there is one.
  const scope = useMarketingSites(locId, venues);

  const load = async (id, d, h = host) => {
    setBusy(true); setErr('');
    try {
      const { data, error } = await supabase.functions.invoke('marketing-report', { body: { action: 'website', ops_location_id: id, days: d, ...(h ? { host: h } : {}) } });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      setReport(data?.report || null);
      if (Array.isArray(data?.report?.sites)) setSites(data.report.sites.filter((s) => s && s.host));
    } catch (e) { setErr(e.message || 'The report could not be read.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    (async () => {
      try { const id = await getActiveLocationSync(); setLocId(id); if (!supabase || !id) { setLoading(false); return; } await load(id, days); }
      catch { /* the empty state shows */ } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!locId || !supabase) return;
    supabase.functions.invoke('marketing-segments', { body: { action: 'venues', ops_location_id: locId } })
      .then(({ data }) => setVenues(Array.isArray(data?.venues) ? data.venues : []))
      .catch(() => setVenues([]));
  }, [locId]);
  // The venue picked in the Sites control: its website, or every site when no website is tied to it.
  const tied = scope.siteId ? sites.find((s) => String(s.location_id || '').toLowerCase() === scope.siteId) : null;
  useEffect(() => {
    if (!scope.ready || !locId) return;
    const want = tied ? tied.host : '';
    if (want !== host) pickSite(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.siteId, scope.ready, tied?.host]);
  const setRange = (d) => { setDays(d); if (locId) load(locId, d); };
  function pickSite(h) { setHost(h); if (locId) load(locId, days, h); }
  const siteLabel = (s) => (s.name && s.name !== s.host ? `${s.name} (${s.host})` : s.host);

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to see the website report.</div>;
  const r = report || {};
  const daysRows = Array.isArray(r.days) ? r.days : [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 920 }}>
        <h1 style={S.h1}>Website report</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {sites.length > 1 && (
            <select style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t1)', fontFamily: 'inherit' }} value={host} onChange={(e) => pickSite(e.target.value)} aria-label="Which site">
              <option value="">All sites</option>
              {sites.map((s) => <option key={`${s.host}|${s.location_id || ''}`} value={s.host}>{siteLabel(s)}</option>)}
            </select>
          )}
          <div style={S.seg}>{[7, 30, 90].map((d) => <button key={d} style={S.segBtn(days === d)} onClick={() => setRange(d)}>{d}d</button>)}</div>
        </div>
      </div>
      <div style={S.sub}>Visits to {host ? `${host}` : (sites.length > 1 ? 'all your websites' : 'your website')} over the last {days} days: which pages, where people came from, and the visits that followed a link in a campaign email.{busy ? ' · refreshing…' : ''}</div>
      <MarketingSitesBar scope={scope} what="visits" note={false} onSite="Shows the website tied to {site}, or every site when none is." />
      {scope.siteId && !tied && <div style={{ fontSize: 12.5, color: 'var(--t3)', margin: '-8px 0 14px' }}>No website is tied to {scope.siteName}, so every site is shown. Pages belong to a venue in Website builder.</div>}
      {err && <div style={{ ...S.card, color: 'var(--red)', fontSize: 13 }}>{err}</div>}

      <div style={S.kpis}>
        <div style={S.kpi}><div style={S.kpiV}>{r.visits || 0}</div><div style={S.kpiL}>Visits</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{r.visitors || 0}</div><div style={S.kpiL}>Visitors (daily unique)</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{r.from_campaigns || 0}</div><div style={S.kpiL}>From campaign links</div></div>
        <div style={S.kpi}><div style={S.kpiV}>{r.visits ? Math.round(((r.from_campaigns || 0) / r.visits) * 100) : 0}%</div><div style={S.kpiL}>Share from campaigns</div></div>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Visits per day</h2>
        {daysRows.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t4)' }}>No visits recorded yet. Turn on "Count visits" in Website builder, Overview, and publish the site.</div> : (
          <>
            <Bars days={daysRows} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t4)' }}><span>{dateNumeric(daysRows[0].day)}</span><span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--acc)', borderRadius: 2, verticalAlign: 'middle', marginRight: 4 }} />from campaigns</span><span>{dateNumeric(daysRows[daysRows.length - 1].day)}</span></div>
          </>
        )}
      </div>

      <div style={S.two}>
        {sites.length > 1 && (
          <div style={S.card}><h2 style={S.h2}>By site</h2>
            <Table rows={sites.map((s) => ({ ...s, label: `${siteLabel(s)}${s.location_id ? '' : ' (no venue)'}` }))} first="Site" keyOf={(x) => x.label} cols={[['Visits', 'visits'], ['Visitors', 'visitors'], ['From campaigns', 'from_campaigns']]} />
            <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 8 }}>Every site of the company over the window, whichever site is picked above.</div>
          </div>
        )}
        <div style={S.card}><h2 style={S.h2}>Top pages</h2><Table rows={r.pages || []} first="Page" keyOf={(x) => x.path} cols={[['Visits', 'visits'], ['Visitors', 'visitors']]} /></div>
        <div style={S.card}><h2 style={S.h2}>Where they came from</h2><Table rows={r.referrers || []} first="Site" keyOf={(x) => x.referrer} cols={[['Visits', 'visits'], ['Visitors', 'visitors']]} /></div>
        <div style={S.card}><h2 style={S.h2}>Campaign links</h2><Table rows={r.campaigns || []} first="Campaign" keyOf={(x) => x.name} cols={[['Visits', 'visits'], ['Visitors', 'visitors']]} />
          <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 8 }}>A visit counts for a campaign when it followed a tracked link from that campaign's email (or a utm_campaign naming it).</div></div>
        <div style={S.card}><h2 style={S.h2}>Sources (utm)</h2><Table rows={(r.sources || []).map((x) => ({ ...x, label: x.medium ? `${x.source} / ${x.medium}` : x.source }))} first="Source" keyOf={(x) => x.label} cols={[['Visits', 'visits'], ['Visitors', 'visitors']]} /></div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--t4)', maxWidth: 920 }}>Days are your venue's own days. A visitor is one person for one day (a daily hash; nothing is stored on their device, so no cookie banner). Drafts and the editor are never counted.</div>
    </div>
  );
}
