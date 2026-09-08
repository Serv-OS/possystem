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

import { useEffect, useMemo, useState } from 'react';
import { fetchAccessibleLocations, fetchClosedChecksMultiRange } from '../../../lib/db';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function rollupByLocation(checks, locations) {
  const map = {};
  locations.forEach(l => { map[l.id] = {
    locationId: l.id, name: l.name || l.id, role: l.role,
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

export default function LocationCompare({ rangeFrom, rangeTo, periodLabelText, fmt, fmtN }) {
  const [locations, setLocations] = useState(null);
  const [checks, setChecks]       = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const locRes = await fetchAccessibleLocations();
        const locs   = locRes.data || [];
        setLocations(locs);
        if (!locs.length) { setChecks([]); setLoading(false); return; }
        if (!rangeFrom || !rangeTo) { setChecks([]); setLoading(false); return; }
        const ids = locs.map(l => l.id);
        const res = await fetchClosedChecksMultiRange(ids, rangeFrom, rangeTo, 2000);
        setChecks(res.data || []);
      } catch (err) {
        console.error('[LocationCompare] fetch failed', err);
        setError(err);
        setChecks([]);
      }
      setLoading(false);
    })();
  }, [rangeFrom?.getTime(), rangeTo?.getTime()]);

  const rows = useMemo(() =>
    (checks && locations) ? rollupByLocation(checks, locations).sort((a, b) => b.revenue - a.revenue) : [],
    [checks, locations]
  );

  const portfolio = useMemo(() => rows.reduce((acc, r) => ({
    revenue: acc.revenue + r.revenue,
    covers:  acc.covers  + r.covers,
    checks:  acc.checks  + r.checks,
    tips:    acc.tips    + r.tips,
  }), { revenue: 0, covers: 0, checks: 0, tips: 0 }), [rows]);

  const alerts = useMemo(() => computeAlerts(rows), [rows]);
  const revenueMedian = useMemo(() => median(rows.map(r => r.revenue)), [rows]);

  const onExport = () => {
    const csv = toCsv(rows, [
      { label:'Location',  key:'name' },
      { label:'Role',      key:'role' },
      { label:'Checks',    key:'checks' },
      { label:'Covers',    key:'covers' },
      { label:'Revenue',   key: r => r.revenue.toFixed(2) },
      { label:'Tips',      key: r => r.tips.toFixed(2) },
      { label:'Avg check', key: r => r.avgCheck.toFixed(2) },
      { label:'Tip %',     key: r => r.tipPct.toFixed(2) },
      { label:'Disc %',    key: r => r.discPct.toFixed(2) },
      { label:'Void %',    key: r => r.voidPct.toFixed(2) },
      { label:'Refund %',  key: r => r.refundPct.toFixed(2) },
    ]);
    downloadCsv(`location-compare-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (loading) {
    return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--t4)', fontSize:12 }}>Loading every location you have access to…</div>;
  }
  if (error) {
    return <EmptyState icon="⚠" message={`Could not load locations: ${error.message}. Run the v4.6.22 SQL migration if you haven't yet.`}/>;
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
  if (portfolio.revenue === 0) {
    return <EmptyState icon="📍" message={`${locations.length} locations accessible, but no revenue in this period.`}/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:12 }}>
        <div style={{ fontSize:11, color:'var(--t3)' }}>
          Comparing <strong style={{ color:'var(--t1)' }}>{locations.length}</strong> locations · {periodLabelText || 'today'}
        </div>
        <ExportBtn onClick={onExport}/>
      </div>

      {/* Portfolio tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label="Portfolio revenue" value={fmt(portfolio.revenue)} color="var(--acc)" sub={`median site ${fmt(revenueMedian)}`}/>
        <StatTile label="Total covers"      value={fmtN(portfolio.covers)}   sub={`${rows.length} sites`}/>
        <StatTile label="Portfolio avg check" value={fmt(portfolio.checks ? portfolio.revenue / portfolio.checks : 0)}/>
        <StatTile label="Total tips"        value={fmt(portfolio.tips)}   sub={portfolio.revenue ? `${((portfolio.tips/portfolio.revenue)*100).toFixed(1)}% of revenue` : null} color="var(--grn)"/>
      </div>

      {/* Exception alerts strip */}
      {alerts.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8, display:'flex', alignItems:'center', gap:6 }}>
            <span>⚠</span> Outlier alerts — {alerts.length}
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
            {alerts.map((a, i) => (
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
        <div style={{ display:'grid', gridTemplateColumns:'40px 1.8fr 70px 70px 110px 80px 70px 70px 70px 100px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:6, minWidth:860 }}>
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
        </div>
        {rows.map((r, i) => {
          const delta = revenueMedian > 0 ? ((r.revenue - revenueMedian) / revenueMedian) * 100 : 0;
          const deltaColor = Math.abs(delta) < 10 ? 'var(--t3)' : delta > 0 ? 'var(--grn)' : 'var(--red)';
          const locAlerts = alerts.filter(a => a.location === r.name);
          return (
            <div key={r.locationId} style={{ display:'grid', gridTemplateColumns:'40px 1.8fr 70px 70px 110px 80px 70px 70px 70px 100px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:6, minWidth:860, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
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
              <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.revenue)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(r.avgCheck)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.tipPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.voidPct > 5 ? 'var(--red)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.voidPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: r.discPct > 10 ? 'var(--acc)' : 'var(--t3)', fontFamily:'var(--font-mono)' }}>{r.discPct.toFixed(1)}%</span>
              <span style={{ textAlign:'right', color: deltaColor, fontFamily:'var(--font-mono)', fontWeight:600 }}>
                {delta > 0 ? '+' : ''}{delta.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Outlier alerts compare each site against the portfolio MEDIAN, which stays robust when one location has unusual numbers. Alerts only trigger when the metric crosses an absolute floor (e.g. void rate above 2%) so low-volume sites don't generate noise. Medians recompute on every period change.
      </div>
    </div>
  );
}
