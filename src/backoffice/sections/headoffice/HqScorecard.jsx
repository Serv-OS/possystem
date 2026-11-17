// src/backoffice/sections/headoffice/HqScorecard.jsx
//
// Head office, Scorecard: "Where the sites stand". Every site ranked by prime cost (food and
// labour together against net sales). Sales and labour come from the tills through the Owner
// snapshot (one call for every site); cash, morale, hires, turnover, the projected dayparts and
// any typed sales come from Daily numbers. The arithmetic is src/lib/hq/primeCost.js, pure and
// tested; this file only reads, merges and draws.
//
// The snapshot keys each venue by ops_location_id (supabase/functions/_shared/ownerSnapshot.js,
// the `locations` array), and we match on the site's name as a fallback.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { fetchSnapshot, fetchDailyNumbers, latestBySite, fetchRatings, fetchProjects } from '../../../lib/hq/data.js';
import { siteRow, rankSites, portfolio, PRIME_COST_TARGET } from '../../../lib/hq/primeCost.js';
import { OPEN_PROJECT_STATUSES } from '../../../lib/hq/departments.js';
import {
  page, card, mono, accBtn, btn, th, td, toneColor, bigMoney, exactMoney, pct, num, signedPct, NA, addDays,
  PageHead, SectionHead, StatTile, Chip, AbsentCard, AmberLine, LoadingLine, EmptyCard, TabRow, hqHandoff,
} from './hqUi';

const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];
const DAYS_BACK = 14;

/** The snapshot venue for a site: by ops_location_id (or id), else by name. */
export function venueForSite(venues, site) {
  const list = venues || [];
  const byId = list.find((v) => v && (v.ops_location_id === site.id || v.id === site.id || v.location_id === site.id));
  if (byId) return byId;
  const name = String(site.name || '').trim().toLowerCase();
  return name ? list.find((v) => String(v?.name || '').trim().toLowerCase() === name) || null : null;
}

/** For This week / This month the venue's period totals stand where its today block stands. */
export function venueForPeriod(venue, period) {
  if (!venue || period === 'today' || !venue.period_totals) return venue;
  return { ...venue, today: { ...venue.today, net_sales: venue.period_totals.net_sales, labour: venue.period_totals.labour } };
}

/** The site rows, ranked, with the review card's real rating where the venue runs one. */
export function buildRows({ sites, venues, dailyRows, ratings, period, currency = null }) {
  const latest = latestBySite(dailyRows || []);
  return rankSites((sites || []).map((s) => {
    const venue = venueForPeriod(venueForSite(venues, s), period);
    const row = siteRow({ id: s.id, name: s.name, venue, typed: latest.get(s.id) || null });
    // A site the snapshot did not answer for has no currency of its own: the active venue's, never a bare dollar.
    if (!row.currency) row.currency = currency || null;
    const r = ratings?.[s.id];
    if (r && r.count) { row.rating = r.avg; row.reviews = r.count; row.from = { ...row.from, rating: 'reviews' }; }
    return row;
  }));
}

export default function HqScorecard({ hq, go }) {
  const [period, setPeriod] = useState('today');
  const [state, setState] = useState({ key: null, absent: false, error: null, snapMessage: null, venues: [], daily: [], ratings: {}, projects: [] });

  const ids = useMemo(() => hq.sites.map((s) => s.id), [hq.sites]);
  // What is asked for; the screen is loading until the state carries this key.
  const key = `${period}|${ids.join(',')}|${hq.today}|${hq.orgId || ''}`;

  useEffect(() => {
    let live = true;
    Promise.all([
      fetchSnapshot(period),
      fetchDailyNumbers(ids, addDays(hq.today, -DAYS_BACK), hq.today),
      fetchRatings(ids, 7),
      fetchProjects(hq.orgId),
    ]).then(([snap, daily, ratings, projects]) => {
      if (!live) return;
      if (daily.absent || projects.absent) { setState((s) => ({ ...s, key, absent: true })); return; }
      setState({
        key, absent: false,
        error: daily.error ? daily.message : (projects.error ? projects.message : null),
        snapMessage: snap.error ? snap.message : null,
        venues: snap.data?.venues || [],
        daily: daily.data || [],
        ratings: ratings.data || {},
        projects: projects.data || [],
      });
    });
    return () => { live = false; };
  }, [period, ids, hq.today, hq.orgId, key]);
  const loading = state.key !== key;

  const rows = useMemo(() => buildRows({ sites: hq.sites, venues: state.venues, dailyRows: state.daily, ratings: state.ratings, period, currency: hq.currency }), [hq.sites, hq.currency, state.venues, state.daily, state.ratings, period]);
  const group = useMemo(() => portfolio(rows), [rows]);
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  const currency = currencies.length === 1 ? currencies[0] : hq.currency;
  const openProjects = state.projects.filter((p) => OPEN_PROJECT_STATUSES.includes(p.status)).length;
  const periodWord = PERIODS.find((p) => p[0] === period)?.[1] || 'Today';

  const right = (
    <>
      <TabRow tabs={PERIODS} value={period} onChange={setPeriod} />
      <button type="button" style={accBtn} onClick={() => { hqHandoff.numbersTab = 'log'; go('hq-numbers'); }}>Log today's numbers</button>
      <button type="button" style={btn} onClick={() => { hqHandoff.numbersTab = 'import'; go('hq-numbers'); }}>Import a CSV</button>
    </>
  );

  if (state.absent) {
    return (
      <div style={page}>
        <PageHead title="Where the sites stand" sub="Ranked by prime cost, food and labour together. Sales from the tills, the rest from Daily numbers." />
        <AbsentCard message={state.error || 'Ask ServOS to run migration 20261130a.'} />
      </div>
    );
  }

  return (
    <div style={page}>
      <PageHead title="Where the sites stand" sub="Ranked by prime cost, food and labour together. Sales from the tills, the rest from Daily numbers." right={right} />
      {loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{state.error}</AmberLine>
      <AmberLine>{state.snapMessage}</AmberLine>
      {!hq.sites.length && !loading && <EmptyCard title="No sites yet" body="The hub ranks the sites this login can manage. None were found." />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <StatTile label={`Net sales, ${periodWord.toLowerCase()}`} value={bigMoney(group.netToday, currency)} note={`${rows.filter((r) => r.net !== null).length} of ${rows.length} sites reporting`} icon="money" />
        <StatTile label="Portfolio prime cost" value={pct(group.prime)} tone={group.prime === null ? null : (group.prime < PRIME_COST_TARGET ? 'grn' : 'orn')} note={`Target under ${PRIME_COST_TARGET}%`} icon="target" />
        <StatTile label="Leadership morale" value={group.morale === null ? NA : `${group.morale} / 10`} note={group.morale === null ? 'Not logged yet' : 'Average of the sites'} icon="users" />
        <StatTile label="Open hires" value={num(group.hires)} note="Still needed, every site" icon="user" />
        <StatTile label="Guest rating" value={group.rating === null ? NA : Number(group.rating).toFixed(1)} note={group.reviews ? `${num(group.reviews)} reviews` : 'No reviews counted'} icon="star" />
        <StatTile label="Cash on hand" value={bigMoney(group.cash, currency)} note="Sites combined" icon="wallet" />
      </div>

      <SectionHead title="Prime cost ladder" sub={`Lowest prime cost first. ${periodWord} on the tills.`} />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={th}>#</th><th style={th}>Site</th><th style={{ ...th, minWidth: 170 }}>Prime cost</th><th style={th}>Net sales</th>
              <th style={th}>vs last period</th><th style={th}>Morale</th><th style={th}>Hires</th><th style={th}>Rating</th><th style={th}>Cash on hand</th><th style={th}>Turnover</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <LadderRow key={r.id} r={r} />)}
            {!rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={10}>No sites to rank.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--grn)" />Under target</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--orn)" />Over target</span>
        <span>Prime cost target {PRIME_COST_TARGET}%, COGS + labour against net sales.</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Typed />a figure typed into Daily numbers</span>
      </div>

      <SectionHead title="Projected sales by daypart" sub="Lunch, dinner and late night as the site projected them in Daily numbers." />
      <Dayparts rows={rows} currency={currency} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 22 }}>
        <StatTile label="Turnover (average)" value={pct(group.turnover, 0)} note="Across the sites that logged it" icon="repeat" />
        <StatTile label="Open hires" value={num(group.hires)} note={group.leader ? `Leader on prime cost: ${group.leader.name}` : 'No site has a full prime cost yet'} icon="user" />
        <StatTile label="Internal projects in flight" value={num(openProjects)} note="Planning, in progress, at risk or blocked" icon="clipboard" />
      </div>
    </div>
  );
}

function Dot({ color }) {
  return <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />;
}

/** The tiny tag beside a figure that came from a typed row, not the till. */
function Typed() {
  return <span style={{ ...mono, fontSize: 9, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--t4)', border: '1px solid var(--bdr)', borderRadius: 4, padding: '0 4px' }}>typed</span>;
}

function Cell({ value, typed, children }) {
  const empty = value === NA || value === null || value === undefined;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: empty ? 'var(--t4)' : undefined }}>
      {children ?? value}
      {typed && !empty && <Typed />}
    </span>
  );
}

function LadderRow({ r }) {
  const tone = r.tone ? toneColor(r.tone) : 'var(--t4)';
  const barW = r.prime === null ? 0 : Math.min(100, (r.prime / 100) * 100);
  const vs = r.momPct;
  const vsColor = vs === null ? 'var(--t4)' : vs >= 0 ? 'var(--grn)' : 'var(--red)';
  return (
    <tr>
      <td style={{ ...td, ...mono, color: 'var(--t3)', width: 36 }}>{r.rank === null ? NA : r.rank}</td>
      <td style={td}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...mono, fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '2px 5px' }}>{r.code || NA}</span>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
        </div>
      </td>
      <td style={td}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mono" style={{ ...mono, fontWeight: 700, color: tone, minWidth: 52 }}>{pct(r.prime)}</span>
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg3)', overflow: 'hidden', minWidth: 60 }}>
            <div style={{ width: `${barW}%`, height: '100%', background: tone }} />
          </div>
          {(r.from.cogs === 'typed' || r.from.labour === 'typed') && <Typed />}
        </div>
      </td>
      <td style={{ ...td, ...mono }}><Cell value={exactMoney(r.net, r.currency)} typed={r.from.net === 'typed'} /></td>
      <td style={{ ...td, ...mono, color: vsColor }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {vs !== null && <Icon name={vs >= 0 ? 'arrowUp' : 'arrowDown'} size={12} />}
          {signedPct(vs)}
        </span>
      </td>
      <td style={td}>
        <Cell value={r.morale === null ? NA : `${r.morale}`} typed={r.morale !== null}>
          <span className="mono" style={mono}>{r.morale === null ? NA : r.morale}</span>
          {r.moraleWord && <Chip tone={r.moraleWord === 'Strong' ? 'grn' : r.moraleWord === 'Steady' ? 'acc' : 'orn'}>{r.moraleWord}</Chip>}
        </Cell>
      </td>
      <td style={{ ...td, ...mono }}><Cell value={num(r.hires)} typed={r.hires !== null} /></td>
      <td style={{ ...td, ...mono }}>
        <Cell value={r.rating === null ? NA : Number(r.rating).toFixed(1)} typed={r.rating !== null && r.from.rating !== 'reviews'}>
          {r.rating === null ? NA : `${Number(r.rating).toFixed(1)}`}{r.rating !== null && r.reviews !== null && <span style={{ color: 'var(--t4)', fontSize: 11 }}> ({num(r.reviews)})</span>}
        </Cell>
      </td>
      <td style={{ ...td, ...mono }}><Cell value={exactMoney(r.cash, r.currency)} typed={r.cash !== null} /></td>
      <td style={{ ...td, ...mono }}><Cell value={pct(r.turnoverPct, 0)} typed={r.turnoverPct !== null} /></td>
    </tr>
  );
}

const PART_COLORS = { lunch: 'var(--acc)', dinner: 'var(--grn)', late: 'var(--orn)' };
const PART_WORDS = { lunch: 'Lunch', dinner: 'Dinner', late: 'Late night' };

function Dayparts({ rows, currency }) {
  const totals = rows.map((r) => (r.projected.lunch || 0) + (r.projected.dinner || 0) + (r.projected.late || 0));
  const max = Math.max(0, ...totals);
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--t3)', marginBottom: 12 }}>
        {Object.keys(PART_WORDS).map((k) => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color={PART_COLORS[k]} />{PART_WORDS[k]}</span>)}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((r, i) => {
          const total = totals[i];
          const has = ['lunch', 'dinner', 'late'].some((k) => r.projected[k] !== null);
          return (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
              {has && max > 0 ? (
                <div style={{ display: 'flex', height: 18, borderRadius: 5, overflow: 'hidden', background: 'var(--bg3)', width: '100%' }}>
                  {['lunch', 'dinner', 'late'].map((k) => {
                    const v = r.projected[k] || 0;
                    return v > 0 ? <div key={k} title={`${PART_WORDS[k]} ${exactMoney(v, r.currency || currency)}`} style={{ width: `${(v / max) * 100}%`, background: PART_COLORS[k] }} /> : null;
                  })}
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--t4)' }}>No projection logged</div>}
              <div className="mono" style={{ ...mono, fontSize: 13, textAlign: 'right', color: has ? 'var(--t1)' : 'var(--t4)' }}>{has ? exactMoney(total, r.currency || currency) : NA}</div>
            </div>
          );
        })}
        {!rows.length && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No sites yet.</div>}
      </div>
    </div>
  );
}
