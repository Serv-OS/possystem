// v4.6.22: Location compare — multi-location performance across every site
// the authenticated user has access to via the user_locations junction.
//
// The report does its OWN data fetch (independent of the main BOReports flow
// which is scoped to a single active location). This is because:
//   - Reports elsewhere continue to show just the current location
//   - Compare needs the full portfolio, always, without forcing the user to
//     flip through a location picker
//
// Structure:
//   1. Portfolio tiles across all locations combined
//   2. Exception alerts strip — flags any location whose void / refund /
//      discount / tip % rates are 2x+ the portfolio MEDIAN and above an
//      absolute floor (avoids spurious alerts at low volume)
//   3. Per-location table with a compare-to-group column showing % off median
//
// Medians are used (not means) so one outlier doesn't pull the reference point
// away from where "typical" really is.
//
// v5.10.3: every venue is read over the SAME business days (range.fromDay..toDay, or the
// same service's wall clock times) on ITS OWN clock: its timezone and business day start
// (getVenueClock + _filters venueRange). Until then the active venue's window was used
// for every venue, so a Utah venue's "Yesterday" was London's 06:30 to 06:29.
//
// 5 Oct 2026 (Peter: "make every report we have multi site when sites are connected
// together"): this is now the ALL SITES OVERVIEW.
//   - The sites are the report scope's (src/lib/reportScope.js): the same company as the
//     signed in site AND readable. Until now it was every user_locations row, so a login
//     with sites in two companies had them added into one "portfolio".
//   - Currencies are never added together: one block of totals per currency.
//   - Each site gets its percent against the comparison (the one percent rule,
//     src/lib/reportCompare.js), cut on ITS OWN clock, and the group percent is like for
//     like: only sites that have both sides count, "(5 of 6 sites, 1 new)".
//   - The comparison is read after this period, on what is left of the same row budget. If
//     it does not fit or does not load, this period still shows and the percent says so.

import { useEffect, useMemo, useState } from 'react';
import { fetchClosedChecksMultiRange } from '../../../lib/db';
import { loadingText, TOO_LONG_TEXT, isTooManyRows, rowBudget, CHECK_ROWS_ON_SCREEN } from '../../../lib/pagedRead';
import { getVenueClock } from '../../../lib/locationTime';
import { compareRange, compareChip, notLoaded } from '../../../lib/reportCompare.js';
import { groupCompare, groupCompareWords, MIXED_COMPARE_TEXT } from '../../../lib/reportScope.js';
import { money } from '../../../lib/currency';
import { StatTile, ExportBtn, EmptyState, CompareChip } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { venueRange } from './_filters';

const COLS = '40px 1.8fr 70px 70px 110px 80px 70px 70px 70px 90px 110px';

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function rollupByLocation(checks, locations) {
  const map = {};
  locations.forEach(l => { map[l.id] = {
    locationId: l.id, name: l.name || l.id, role: l.role, currency: l.currency || null,
    checks: 0, voidCount: 0, refundCount: 0, discountCount: 0,
    revenue: 0, tips: 0, covers: 0,
  };});

  checks.forEach(c => {
    const loc = map[c.locationId];
    if (!loc) return;
    if (c.status === 'voided') { loc.voidCount += 1; return; }
    loc.checks    += 1;
    loc.revenue   += c.total || 0;
    loc.tips      += c.tip   || 0;
    loc.covers    += c.covers || 1;
    loc.refundCount   += (c.refunds   || []).length;
    loc.discountCount += (c.discounts || []).length;
  });

  return Object.values(map).map(r => {
    const totalEvents = r.checks + r.voidCount;
    return {
      ...r,
      avgCheck: r.checks ? r.revenue / r.checks : 0,
      avgCover: r.covers ? r.revenue / r.covers : 0,
      tipPct:   r.revenue ? (r.tips / r.revenue) * 100 : 0,
      voidPct:  totalEvents ? (r.voidCount / totalEvents) * 100 : 0,
      refundPct:r.checks ? (r.refundCount / r.checks) * 100 : 0,
      discPct:  totalEvents ? (r.discountCount / totalEvents) * 100 : 0,
    };
  });
}

// Alert threshold tables — each metric: which way is BAD, min floor to
// avoid noise on low volume, and a phrasing template.
const METRICS = [
  { key:'voidPct',   label:'void rate',     direction:'high', floor:2.0, template:x => `${x.toFixed(1)}% void rate` },
  { key:'refundPct', label:'refund rate',   direction:'high', floor:1.5, template:x => `${x.toFixed(1)}% refund rate` },
  { key:'discPct',   label:'discount rate', direction:'high', floor:5.0, template:x => `${x.toFixed(1)}% discount rate` },
  { key:'tipPct',    label:'tip rate',      direction:'low',  floor:0.0, template:x => `${x.toFixed(1)}% tip rate` },
];

function computeAlerts(rows) {
  if (rows.length < 2) return [];  // need at least 2 sites to compare
  const alerts = [];
  METRICS.forEach(m => {
    const values = rows.map(r => r[m.key]);
    const med    = median(values);
    rows.forEach(r => {
      const v = r[m.key];
      if (m.direction === 'high') {
        if (med > 0 && v > med * 2 && v >= m.floor) {
          alerts.push({ location: r.name, metric: m.label, kind:'high', value: v, template: m.template(v), baseline: med });
        }
      } else {
        // direction = low — alert when it's significantly LESS than median
        if (med > 0 && v < med / 2 && med >= 5) {
          alerts.push({ location: r.name, metric: m.label, kind:'low', value: v, template: m.template(v), baseline: med });
        }
      }
    });
  });
  return alerts;
}

// range = getPeriodRange's answer for the active venue; only its days (and, for a
// service, its wall clock times) are used, re-read on each venue's clock.
// scope = the report scope (its sites are the ones compared); period = the period id, for
// the comparison. 6 Oct 2026 (review): WITHOUT a scope nothing is read. It used to fall back
// to every user_locations row, across every company, and the shell handed scope null while
// the scope reads were still in flight: for the four owner logins that hold sites in 2 to 4
// companies the first picture was another company's sales. Connected means same company,
// and that is the scope's to say.
export default function LocationCompare({ range, period, periodLabelText, fmt, fmtN, scope }) {
  const [locations, setLocations] = useState(null);
  const [checks, setChecks]       = useState(null);
  // prev: { revenue: { [siteId]: money }, compare: { [siteId]: compareRange } }, or null
  // while it is not loaded (still reading, did not fit, failed). Null is never "no sales".
  const [prev, setPrev]           = useState(null);
  const scopeSites = scope?.sites?.length ? scope.sites : null;
  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState(null);
  const [progress, setProgress]   = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setProgress(null);
    setPrev(null);
    // 5 Oct 2026: every venue is read in full, in pages (it was the newest 1,000 checks a
    // venue). A read the period has moved on from stops and is dropped.
    let stale = false;
    (async () => {
      try {
        const locs = scopeSites
          ? scopeSites.map(s => ({ id: s.id, name: s.name, role: s.isHome ? 'signed in here' : '', currency: s.currency }))
          : null;   // no scope = no sites: the empty state below, never a guess at "my sites"
        if (stale) return;
        setLocations(locs || []);
        if (!locs?.length) { setChecks([]); setLoading(false); return; }
        if (!range?.fromDay || !range?.toDay) { setChecks([]); setLoading(false); return; }
        const windows = await Promise.all(locs.map(async l => {
          const r = venueRange(range, await getVenueClock(l.id));
          // What this site is compared to, cut at the same time of day on its own clock.
          const service = range.kind === 'service' ? { kind: 'service', shiftName: range.shiftName, serviceStart: range.serviceStart, serviceEnd: range.serviceEnd } : null;
          const compare = compareRange(period || 'custom', { ...r, ...service }, range.builtAt || Date.now());
          return { locationId: l.id, from: r.from, to: r.to, compare };
        }));
        if (stale) return;
        // One row budget for this period and the comparison together.
        const budget = rowBudget(CHECK_ROWS_ON_SCREEN);
        const res = await fetchClosedChecksMultiRange(windows, {
          onProgress: (p) => { if (!stale) setProgress(p); },
          stop: () => stale, budget,
        });
        if (stale) return;
        if (res.error) throw res.error;
        setChecks(res.data || []);
        setLoading(false);
        // The comparison, quietly, after the figures are up. Only its totals are kept.
        const prevWindows = windows.filter(w => w.compare).map(w => ({ locationId: w.locationId, from: w.compare.from, to: w.compare.to }));
        if (prevWindows.length !== windows.length) return;
        try {
          const pres = await fetchClosedChecksMultiRange(prevWindows, { stop: () => stale, budget });
          if (stale || pres.error) return;
          const revenue = Object.fromEntries(windows.map(w => [w.locationId, 0]));
          for (const c of pres.data || []) if (c.status !== 'voided') revenue[c.locationId] += c.total || 0;
          setPrev({ revenue, compare: Object.fromEntries(windows.map(w => [w.locationId, w.compare])) });
        } catch (e) {
          // The comparison alone failed: this period stays up, the percent says not loaded.
          console.error('[LocationCompare] comparison failed', e);
        }
        return;
      } catch (err) {
        if (stale) return;
        console.error('[LocationCompare] fetch failed', err);
        setError(err);
        setChecks([]);
      }
      setLoading(false);
    })();
    return () => { stale = true; };
    // scopeSites follows the scope's site list; the ticks do not change what the overview shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, period, scopeSites?.map(s => s.id).join(',')]);

  const rows = useMemo(() =>
    (checks && locations) ? rollupByLocation(checks, locations).sort((a, b) => b.revenue - a.revenue) : [],
    [checks, locations]
  );

  // One block per currency. Money in two currencies is never one number; a site whose
  // currency nobody knows sits with the Back Office currency only when there is no scope.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const g = map.get(r.currency) || map.set(r.currency, { currency: r.currency, rows: [] }).get(r.currency);
      g.rows.push(r);
    }
    return [...map.values()].map(g => {
      const total = g.rows.reduce((acc, r) => ({
        revenue: acc.revenue + r.revenue, covers: acc.covers + r.covers, checks: acc.checks + r.checks, tips: acc.tips + r.tips,
      }), { revenue: 0, covers: 0, checks: 0, tips: 0 });
      return {
        ...g, portfolio: total, alerts: computeAlerts(g.rows), revenueMedian: median(g.rows.map(r => r.revenue)),
        change: prev ? {
          ...groupCompare(g.rows.map(r => ({ current: r.revenue, previous: prev.revenue[r.locationId] }))),
          // The words only when every site of the block compares to the same thing (each is cut
          // on its own clock); 6 Oct 2026, it was the signed in site's words for every block.
          words: groupCompareWords(g.rows.map(r => prev.compare[r.locationId])),
        } : null,
        fmt: g.currency ? (n) => money(n || 0, g.currency) : fmt,
      };
    });
  }, [rows, prev, fmt]);
  const anyRevenue = rows.some(r => r.revenue !== 0);
  const chipFor = (r) => compareChip(r.revenue, prev?.revenue?.[r.locationId], prev ? prev.compare[r.locationId] : notLoaded(null));

  const onExport = () => {
    const csv = toCsv(rows, [
      { label:'Location',  key:'name' },
      { label:'Currency',  key: r => r.currency || '' },
      { label:'Checks',    key:'checks' },
      { label:'Covers',    key:'covers' },
      { label:'Revenue',   key: r => r.revenue.toFixed(2) },
      { label:'Tips',      key: r => r.tips.toFixed(2) },
      { label:'Avg check', key: r => r.avgCheck.toFixed(2) },
      { label:'Tip %',     key: r => r.tipPct.toFixed(2) },
      { label:'Disc %',    key: r => r.discPct.toFixed(2) },
      { label:'Void %',    key: r => r.voidPct.toFixed(2) },
      { label:'Refund %',  key: r => r.refundPct.toFixed(2) },
      { label:'Change %',  key: r => { const c = chipFor(r); return c.kind === 'pct' ? c.pct.toFixed(1) : c.text; } },
      { label:'Compared to', key: r => prev?.compare?.[r.locationId]?.detail || '' },
    ]);
    downloadCsv(`location-compare-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (loading) {
    return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--t4)', fontSize:12 }}>{progress?.total > 1 ? `${loadingText(progress)} (every location you have access to)` : 'Loading every location you have access to…'}</div>;
  }
  if (error) {
    return <EmptyState icon="⚠" message={isTooManyRows(error) ? TOO_LONG_TEXT : `Could not load locations: ${error.message}`}/>;
  }
  if (!scopeSites) {
    return <EmptyState icon="📍" message="Sites could not be worked out. Choose the report again."/>;
  }
  if (!locations || locations.length === 0) {
    return <EmptyState icon="📍" message="No locations accessible. Check that your user_locations junction has rows for your user."/>;
  }
  if (locations.length === 1) {
    return (
      <div>
        <EmptyState icon="📍" message={`Only one location accessible: ${locations[0].name}. Compare view kicks in once you have more than one site linked via user_locations.`}/>
        <div style={{ marginTop:10, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)' }}>
          ⓘ Add additional sites under Settings → Locations (Wave 7) or directly via the user_locations table in Supabase.
        </div>
      </div>
    );
  }
  if (!anyRevenue) {
    return <EmptyState icon="📍" message={`${locations.length} locations accessible, but no revenue in this period.`}/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:12 }}>
        <div style={{ fontSize:11, color:'var(--t3)' }}>
          Every site, side by side: <strong style={{ color:'var(--t1)' }}>{locations.length}</strong> locations · {periodLabelText || 'today'}
          <div style={{ color:'var(--t4)', marginTop:2 }}>Each location is read over these business days on its own clock (its time zone and day start).</div>
        </div>
        <ExportBtn onClick={onExport}/>
      </div>

      {groups.map(g => (
        <div key={g.currency || 'none'} style={{ marginBottom: groups.length > 1 ? 26 : 0 }}>
          {groups.length > 1 && (
            <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>
              {g.currency || 'Currency not set'} sites <span style={{ fontWeight:400, color:'var(--t4)', fontSize:11 }}>· totals are never added across currencies</span>
            </div>
          )}
      {/* Portfolio tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Portfolio revenue" value={g.fmt(g.portfolio.revenue)} color="var(--acc)" sub={`median site ${g.fmt(g.revenueMedian)}`}/>
        <StatTile label="Total covers"      value={fmtN(g.portfolio.covers)}   sub={`${g.rows.length} sites`}/>
        <StatTile label="Portfolio avg check" value={g.fmt(g.portfolio.checks ? g.portfolio.revenue / g.portfolio.checks : 0)}/>
        <StatTile label="Total tips"        value={g.fmt(g.portfolio.tips)}   sub={g.portfolio.revenue ? `${((g.portfolio.tips/g.portfolio.revenue)*100).toFixed(1)}% of revenue` : null} color="var(--grn)"/>
      </div>

      {/* Exception alerts strip */}
      {g.alerts.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
            <span>⚠</span> Outlier alerts — {g.alerts.length}
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
            {g.alerts.map((a, i) => (
              <div key={i} style={{
                padding:'8px 12px', borderRadius:8,
                background: a.kind === 'high' ? 'var(--red-d)' : 'var(--acc-d)',
                border: `1px solid ${a.kind === 'high' ? 'var(--red)' : 'var(--acc-b)'}55`,
                fontSize:12, color:'var(--t1)',
              }}>
                <strong style={{ color: a.kind === 'high' ? 'var(--red)' : 'var(--acc)' }}>{a.location}</strong>
                <span style={{ color:'var(--t3)' }}> · {a.template}</span>
                <span style={{ fontSize:10, color:'var(--t4)', marginLeft:4 }}>
                  vs median {a.baseline.toFixed(1)}% {a.kind === 'high' ? '(above)' : '(below)'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-location table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={{ display:'grid', gridTemplateColumns:COLS, padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:6, minWidth:1000 }}>
          <span>#</span>
          <span>Location</span>
          <span style={{ textAlign:'right' }}>Checks</span>
          <span style={{ textAlign:'right' }}>Covers</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span style={{ textAlign:'right' }}>Avg chk</span>
          <span style={{ textAlign:'right' }}>Tip %</span>
          <span style={{ textAlign:'right' }}>Void %</span>
          <span style={{ textAlign:'right' }}>Disc %</span>
          <span style={{ textAlign:'right' }}>vs median</span>
          <span style={{ textAlign:'right' }} title={range?.compare?.detail ? `Compared to ${range.compare.detail}` : undefined}>Change</span>
        </div>
        {g.rows.map((r, i) => {
          const delta = g.revenueMedian > 0 ? ((r.revenue - g.revenueMedian) / g.revenueMedian) * 100 : 0;
          const deltaColor = Math.abs(delta) < 10 ? 'var(--t3)' : delta > 0 ? 'var(--grn)' : 'var(--red)';
          const locAlerts = g.alerts.filter(a => a.location === r.name);
          return (
            <div key={r.locationId} style={{ display:'grid', gridTemplateColumns:COLS, padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:6, minWidth:1000, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
              <div>
                <div style={{ color:'var(--t1)', fontWeight:600 }}>{r.name}</div>
                <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>
                  {r.role}
                  {locAlerts.length > 0 && <span style={{ color:'var(--red)', marginLeft:6 }}>· {locAlerts.length} alert{locAlerts.length > 1 ? 's' : ''}</span>}
                </div>
              </div>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.checks}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.covers}</span>
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{g.fmt(r.revenue)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{g.fmt(r.avgCheck)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.tipPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.voidPct > 5 ? 'var(--red)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.voidPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.discPct > 10 ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.discPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: deltaColor, fontFamily:'var(--font-mono)', fontWeight:600 }}>
                {delta > 0 ? '+' : ''}{delta.toFixed(0)}%
              </span>
              <span style={{ textAlign:'right' }}>
                <CompareChip values={[r.revenue, prev?.revenue?.[r.locationId]]} vs={prev ? prev.compare[r.locationId] : notLoaded(null)} short/>
              </span>
            </div>
          );
        })}
      </div>

          {/* The group against its comparison, like for like */}
          <div style={{ marginTop:10, fontSize:12, color:'var(--t3)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <span>All {g.rows.length} sites:</span>
            {!prev ? <span style={{ color:'var(--t4)' }}>comparison not loaded yet</span>
              : g.change.pct == null ? <span style={{ color:'var(--t4)' }}>nothing to compare with {g.change.fresh ? `(${g.change.fresh} new)` : ''}</span>
              : <><CompareChip pct={g.change.pct} vs={g.change.words.vs}/>{g.change.words.mixed && <span style={{ color:'var(--t4)' }}>{MIXED_COMPARE_TEXT}</span>}<span style={{ color:'var(--t4)' }}>· {g.fmt(g.change.previous)} then {g.change.text}</span></>}
          </div>
        </div>
      ))}

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Outlier alerts compare each site against the portfolio MEDIAN, which stays robust when one location has unusual numbers. Alerts only trigger when the metric crosses an absolute floor (e.g. void rate above 2%) so low-volume sites don't generate noise. Medians recompute on every period change.
      </div>
    </div>
  );
}
