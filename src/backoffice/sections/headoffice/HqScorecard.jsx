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
//
// Slice 2 (20261201a): the colours come from the company's targets (src/lib/hq/targets.js, a site
// override wins), cash comes from the safe ledger where a site uses it (src/lib/hq/safeLedger.js,
// else the typed figure with its tag), and a Checks column counts the Operations module's missed
// checklists, temperature windows and urgent repairs (src/lib/hq/opsStats.js). When those tables
// are not there yet the scorecard still works: one amber line, the old figures.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { fetchSnapshot, fetchDailyNumbers, latestBySite, fetchRatings, fetchProjects, fetchTargets, fetchCashForSites, fetchOpsRows, fetchSiteDays, NOT_SET_UP_2 } from '../../../lib/hq/data.js';
import { forecastParts, WHOLE_DAY_KEY } from '../../../lib/hq/systemDay.js';
import { siteRow, rankSites, portfolio } from '../../../lib/hq/primeCost.js';
import { OPEN_PROJECT_STATUSES } from '../../../lib/hq/departments.js';
import { resolveTargets, ragOf, bandWords } from '../../../lib/hq/targets.js';
import { cashSummary } from '../../../lib/hq/safeLedger.js';
import { opsSiteStats, checksWords, checksPct, dateRange } from '../../../lib/hq/opsStats.js';
import { weekStartIso } from '../../../lib/hq/checkinWeek.js';
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

/** The site rows, ranked, with the review card's real rating where the venue runs one, coloured by the company's targets. */
export function buildRows({ sites, venues, dailyRows, ratings, period, currency = null, targets = [], siteDays = null, currencyOf = null }) {
  const latest = latestBySite(dailyRows || []);
  return rankSites((sites || []).map((s) => {
    const snapVenue = venueForSite(venues, s);
    const venue = venueForPeriod(snapVenue, period);
    const row = siteRow({ id: s.id, name: s.name, venue, typed: latest.get(s.id) || null });
    // A site the snapshot did not answer for has no currency of its own: its own from the platform
    // (slice 4), else the active venue's, never a bare dollar.
    if (!row.currency) row.currency = (typeof currencyOf === 'function' && currencyOf(s.id)) || currency || null;
    // Slice 4: the dayparts come from today's logged day when there is one; otherwise today's sales
    // forecast split by its saved hours (Whole day without them); otherwise the last logged day.
    const sd = siteDays?.[s.id] || null;
    const loggedToday = !!(row.typedOn && sd?.today && row.typedOn === sd.today && row.parts.length);
    // A saved day's parts are 'logged' (or 'csv') whatever split the form used; 'forecast' here means
    // today's forecast standing in, so the words under the site never call a saved day a forecast.
    row.partsFrom = row.parts.length ? (row.from.projected === 'csv' ? 'csv' : 'logged') : null;
    row.partsOn = row.parts.length ? row.typedOn : null;
    if (!loggedToday) {
      const fp = forecastParts(snapVenue?.today?.forecast, sd?.hours, sd?.shifts);
      if (fp.length) { row.parts = fp; row.partsFrom = 'forecast'; row.partsOn = sd?.today || null; }
    }
    const r = ratings?.[s.id];
    if (r && r.count) { row.rating = r.avg; row.reviews = r.count; row.from = { ...row.from, rating: 'reviews' }; }
    // The colour is the band's (site override, else company, else the built in default), never a fixed 60.
    const band = resolveTargets(targets, s.id);
    row.band = band;
    row.tone = ragOf('prime_cost_pct', row.prime, band.prime_cost_pct);
    row.labourTone = ragOf('labour_pct', row.labourPct, band.labour_pct);
    row.cogsTone = ragOf('cogs_pct', row.cogsPct, band.cogs_pct);
    return row;
  }));
}

/** Per site: the safe summary and the Operations figures for today and this week, from the slice 2 reads. */
export function buildExtras({ sites, cash, ops, today }) {
  const out = {};
  for (const s of sites || []) {
    const clock = cash?.clocks?.[s.id] || ops?.clocks?.[s.id] || null;
    const bizToday = clock?.today || today;
    const cal = clock?.calendarToday || today;   // Operations stores run_date on the calendar day
    const bySite = (rows) => (rows || []).filter((r) => r?.location_id === s.id);
    const opsArgs = ops ? { checklists: bySite(ops.checklists), runs: bySite(ops.runs), schedules: bySite(ops.schedules), readings: bySite(ops.readings), maintenance: bySite(ops.maintenance), today: cal, nowMin: clock?.nowMin } : null;
    out[s.id] = {
      cash: cash ? cashSummary({ movements: bySite(cash.movements), counts: bySite(cash.counts), deposits: bySite(cash.deposits), today: bizToday }) : null,
      // Does the Operations module hold anything for this site? Without a row, "0 missed" would read as all done.
      hasRows: !!opsArgs && (opsArgs.checklists.length + opsArgs.schedules.length + opsArgs.readings.length + opsArgs.maintenance.length) > 0,
      today: opsArgs ? opsSiteStats({ ...opsArgs, dates: [cal] }) : null,
      week: opsArgs ? opsSiteStats({ ...opsArgs, dates: dateRange(weekStartIso(cal), cal) }) : null,
    };
  }
  return out;
}

const addBucket = (a, b) => { a.due += b?.due || 0; a.done += b?.done || 0; a.missed += b?.missed || 0; a.open += b?.open || 0; };

/** The portfolio's slice 2 tiles: cash in the safes, in transit, today's checks and the week's failed temps. */
export function portfolioExtras(extras) {
  const t = { safes: 0, safeSites: 0, transit: 0, worstDays: null, failed: 0, critical: 0, checks: null, checksDone: 0, checksRequired: 0, hasOps: false };
  const all = { due: 0, done: 0, missed: 0, open: 0 }; const win = { due: 0, done: 0, missed: 0, open: 0 };
  for (const x of Object.values(extras || {})) {
    if (x?.cash?.used) {
      t.safes += x.cash.balance || 0; t.safeSites += 1;
      if (x.cash.unbankedDays !== null && (t.worstDays === null || x.cash.unbankedDays > t.worstDays)) t.worstDays = x.cash.unbankedDays;
    }
    if (x?.cash) t.transit += x.cash.inTransit || 0;
    if (x?.week) { t.failed += x.week.temps.failed.count; t.critical += x.week.temps.failed.critical; }
    if (x?.today) { if (x.hasRows) t.hasOps = true; addBucket(all, x.today.checklists.all); addBucket(win, x.today.temps.windows); }
  }
  t.checks = checksPct(all, win);
  t.checksDone = all.done + win.done;
  t.checksRequired = all.done + all.missed + win.done + win.missed;
  return t;
}

export default function HqScorecard({ hq, go }) {
  const [period, setPeriod] = useState('today');
  const [state, setState] = useState({ key: null, absent: false, error: null, snapMessage: null, slice2Message: null, venues: [], daily: [], ratings: {}, projects: [], targets: [], cash: null, ops: null });

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
      fetchTargets(hq.orgId),
      fetchCashForSites(ids),
      fetchOpsRows(ids, weekStartIso(hq.today), hq.today),
      fetchSiteDays(ids),
    ]).then(([snap, daily, ratings, projects, targets, cash, ops, siteDays]) => {
      if (!live) return;
      if (daily.absent || projects.absent) { setState((s) => ({ ...s, key, absent: true })); return; }
      // Slice 2 tables missing is not the end of the scorecard: one amber line and the old figures.
      const slice2Absent = !!(targets.absent || cash.absent);
      setState({
        key, absent: false,
        error: daily.error ? daily.message : (projects.error ? projects.message : null),
        snapMessage: snap.error ? snap.message : null,
        slice2Message: slice2Absent ? NOT_SET_UP_2 : (targets.error ? targets.message : (cash.error ? cash.message : null)),
        venues: snap.data?.venues || [],
        daily: daily.data || [],
        ratings: ratings.data || {},
        projects: projects.data || [],
        targets: slice2Absent ? [] : (targets.data || []),
        cash: slice2Absent ? null : (cash.data || null),
        ops: ops.data || null,
        siteDays: siteDays?.data || null,
        siteDaysMessage: siteDays?.error ? siteDays.message : null,
      });
    });
    return () => { live = false; };
  }, [period, ids, hq.today, hq.orgId, key]);
  const loading = state.key !== key;

  const rows = useMemo(() => buildRows({ sites: hq.sites, venues: state.venues, dailyRows: state.daily, ratings: state.ratings, period, currency: hq.currency, targets: state.targets, siteDays: state.siteDays, currencyOf: hq.currencyOf }), [hq.sites, hq.currency, hq.currencyOf, state.siteDays, state.venues, state.daily, state.ratings, state.targets, period]);
  const group = useMemo(() => portfolio(rows), [rows]);
  const extras = useMemo(() => buildExtras({ sites: hq.sites, cash: state.cash, ops: state.ops, today: hq.today }), [hq.sites, state.cash, state.ops, hq.today]);
  const more = useMemo(() => portfolioExtras(extras), [extras]);
  const companyBand = useMemo(() => resolveTargets(state.targets, null), [state.targets]);
  const primeWords = bandWords('prime_cost_pct', companyBand.prime_cost_pct, (n) => `${n}%`);
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
      <AmberLine>{state.slice2Message}</AmberLine>
      {!hq.sites.length && !loading && <EmptyCard title="No sites yet" body="The hub ranks the sites this login can manage. None were found." />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <StatTile label={`Net sales, ${periodWord.toLowerCase()}`} value={bigMoney(group.netToday, currency)} note={`${rows.filter((r) => r.net !== null).length} of ${rows.length} sites reporting`} icon="money" />
        <StatTile label="Portfolio prime cost" value={pct(group.prime)} tone={ragOf('prime_cost_pct', group.prime, companyBand.prime_cost_pct)} note={primeWords ? `Green ${primeWords.grn}` : 'No target set'} icon="target" />
        <StatTile label="Leadership morale" value={group.morale === null ? NA : `${group.morale} / 10`} note={group.morale === null ? 'Not logged yet' : 'Average of the sites'} icon="users" />
        <StatTile label="Open hires" value={num(group.hires)} note="Still needed, every site" icon="user" />
        <StatTile label="Guest rating" value={group.rating === null ? NA : Number(group.rating).toFixed(1)} note={group.reviews ? `${num(group.reviews)} reviews` : 'No reviews counted'} icon="star" />
        <StatTile label="Cash in safes" value={more.safeSites ? bigMoney(more.safes, currency) : (group.cash !== null ? bigMoney(group.cash, currency) : NA)}
          note={more.safeSites ? `${more.safeSites} of ${rows.length} sites on the safe ledger` : (group.cash !== null ? 'Typed figures, no safe ledger yet' : 'No safe ledger yet')} icon="lock" />
        <StatTile label="Waiting to bank" value={bigMoney(more.transit, currency)} tone={ragOf('unbanked_days', more.worstDays, companyBand.unbanked_days)}
          note={more.worstDays === null ? 'Prepared or banked, not yet confirmed' : `Worst site: ${more.worstDays} day${more.worstDays === 1 ? '' : 's'} unbanked`} icon="bank" />
        <StatTile label="Checks today" value={more.checks === null ? NA : pct(more.checks, 0)} tone={ragOf('checks_pct', more.checks, companyBand.checks_pct)}
          note={more.hasOps ? `${num(more.checksDone)} of ${num(more.checksRequired)} required so far, every site` : 'No Operations schedules found'} icon="checkSquare" />
        <StatTile label="Failed temps this week" value={more.hasOps ? num(more.failed) : NA} tone={!more.hasOps ? null : (more.critical ? 'red' : (more.failed ? 'orn' : 'grn'))}
          note={more.hasOps ? `${num(more.critical)} critical` : 'No temperature readings found'} icon="warn" />
      </div>

      <SectionHead title="Prime cost ladder" sub={`Lowest prime cost first. ${periodWord} on the tills.`} />
      <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={th}>#</th><th style={th}>Site</th><th style={{ ...th, minWidth: 170 }}>Prime cost</th><th style={th}>Net sales</th>
              <th style={th}>vs last period</th><th style={th}>Checks</th><th style={th}>Morale</th><th style={th}>Hires</th><th style={th}>Rating</th><th style={th}>Cash</th><th style={th}>Turnover</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <LadderRow key={r.id} r={r} x={extras[r.id]} />)}
            {!rows.length && <tr><td style={{ ...td, color: 'var(--t3)' }} colSpan={11}>No sites to rank.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 12, color: 'var(--t3)', marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--grn)" />Green {primeWords?.grn || NA}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--orn)" />Amber {primeWords?.orn || NA}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--red)" />Red {primeWords?.red || NA}</span>
        <span>Prime cost is COGS + labour against net sales. Bands come from Targets; a site's own band wins.</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Typed />a figure typed into Daily numbers</span>
      </div>

      <SectionHead title="Projected sales by service period" sub="Today's logged day when there is one; otherwise today's sales forecast across each site's own service periods (Location settings), split by the hours saved against it, or the whole day without them." />
      <AmberLine>{state.siteDaysMessage}</AmberLine>
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

/** The colour for a tone, or the plain text colour when there is none. */
const toneOr = (tone, fallback = 'var(--t1)') => (tone ? toneColor(tone) : fallback);

function LadderRow({ r, x }) {
  const tone = r.tone ? toneColor(r.tone) : 'var(--t4)';
  const band = r.band || {};
  const cash = x?.cash;
  const checks = x?.today;
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
          {(isTyped(r.from.cogs) || isTyped(r.from.labour)) && <Typed />}
        </div>
        <div style={{ display: 'flex', gap: 10, fontSize: 11, marginTop: 3, ...mono }}>
          <span style={{ color: toneOr(r.cogsTone, 'var(--t4)') }}>COGS {pct(r.cogsPct)}</span>
          <span style={{ color: toneOr(r.labourTone, 'var(--t4)') }}>Labour {pct(r.labourPct)}</span>
        </div>
      </td>
      <td style={{ ...td, ...mono }}><Cell value={exactMoney(r.net, r.currency)} typed={isTyped(r.from.net)} /></td>
      <td style={{ ...td, ...mono, color: vsColor }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {vs !== null && <Icon name={vs >= 0 ? 'arrowUp' : 'arrowDown'} size={12} />}
          {signedPct(vs)}
        </span>
      </td>
      <td style={td}>
        {checks ? (
          <div>
            <div className="mono" style={{ ...mono, fontWeight: 700, color: toneOr(ragOf('checks_pct', checks.checksPct, band.checks_pct), 'var(--t4)') }}>{checks.checksPct === null ? NA : pct(checks.checksPct, 0)}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>{checksWords(checks)}</div>
          </div>
        ) : <span style={{ color: 'var(--t4)' }}>{NA}</span>}
      </td>
      <td style={td}>
        <Cell value={r.morale === null ? NA : `${r.morale}`} typed={isTyped(r.from.morale)}>
          <span className="mono" style={mono}>{r.morale === null ? NA : r.morale}</span>
          {r.moraleWord && <Chip tone={r.moraleWord === 'Strong' ? 'grn' : r.moraleWord === 'Steady' ? 'acc' : 'orn'}>{r.moraleWord}</Chip>}
        </Cell>
      </td>
      <td style={{ ...td, ...mono }}><Cell value={num(r.hires)} typed={isTyped(r.from.hires)} /></td>
      <td style={{ ...td, ...mono }}>
        <Cell value={r.rating === null ? NA : Number(r.rating).toFixed(1)} typed={isTyped(r.from.rating)}>
          {r.rating === null ? NA : `${Number(r.rating).toFixed(1)}`}{r.rating !== null && r.reviews !== null && <span style={{ color: 'var(--t4)', fontSize: 11 }}> ({num(r.reviews)})</span>}
        </Cell>
      </td>
      <td style={{ ...td, ...mono }}>
        {cash?.used ? (
          <div>
            <div style={{ fontWeight: 700, color: toneOr(ragOf('cash_held', cash.balance, band.cash_held)) }}>{exactMoney(cash.balance, r.currency)}</div>
            <div style={{ fontSize: 11, color: toneOr(ragOf('unbanked_days', cash.unbankedDays, band.unbanked_days), 'var(--t4)'), whiteSpace: 'nowrap' }}>
              {cash.unbankedDays === null ? 'in the safe' : `${cash.unbankedDays} day${cash.unbankedDays === 1 ? '' : 's'} unbanked`}
            </div>
          </div>
        ) : <Cell value={exactMoney(r.cash, r.currency)} typed={r.cash !== null} />}
      </td>
      <td style={{ ...td, ...mono }}><Cell value={pct(r.turnoverPct, 0)} typed={isTyped(r.from.turnover)} /></td>
    </tr>
  );
}

const PART_COLORS = { lunch: 'var(--acc)', dinner: 'var(--grn)', late: 'var(--orn)' };
const PART_WORDS = { lunch: 'Lunch', dinner: 'Dinner', late: 'Late night' };
/** Only a figure a person typed or pasted wears the tag; one the system filled does not. */
const isTyped = (source) => source === 'typed' || source === 'csv';

/** Each site's own service periods (Location settings), one colour per period in day order. */
const PART_PALETTE = ['var(--acc)', 'var(--orn)', 'var(--t3)', 'var(--grn)', 'var(--red)', 'var(--t2)'];
const partColor = (i, key) => PART_COLORS[key] || PART_PALETTE[i % PART_PALETTE.length];

/** Where a site's dayparts came from, in a few words: the logged day or today's forecast. */
export function partsWords(r) {
  if (!r?.parts?.length) return '';
  if (r.partsFrom === 'forecast') {
    const whole = r.parts.length === 1 && r.parts[0].key === WHOLE_DAY_KEY;
    return whole ? 'Forecast, whole day: no hours saved against it, or no service periods' : 'Forecast, by the hours saved against it';
  }
  if (r.partsFrom === 'csv') return `Pasted for ${r.partsOn || 'a day'}`;
  return `Logged for ${r.partsOn || 'a day'}`;
}

function Dayparts({ rows, currency }) {
  const totals = rows.map((r) => (r.parts || []).reduce((a, p) => a + (p.amount || 0), 0));
  const max = Math.max(0, ...totals);
  return (
    <div style={card}>
      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((r, i) => {
          const total = totals[i];
          const parts = r.parts || [];
          const has = parts.length > 0;
          return (
            <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                {has && <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 2 }}>{partsWords(r)}</div>}
              </div>
              {has && max > 0 ? (
                <div>
                  <div style={{ display: 'flex', height: 18, borderRadius: 5, overflow: 'hidden', background: 'var(--bg3)', width: '100%' }}>
                    {parts.map((p, pi) => (p.amount > 0 ? <div key={p.key} title={`${p.name} ${exactMoney(p.amount, r.currency || currency)}`} style={{ width: `${(p.amount / max) * 100}%`, background: partColor(pi, p.key) }} /> : null))}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--t3)', marginTop: 4 }}>
                    {parts.map((p, pi) => <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Dot color={partColor(pi, p.key)} />{p.name} <span className="mono" style={mono}>{exactMoney(p.amount, r.currency || currency)}</span></span>)}
                  </div>
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--t4)' }}>No forecast for today and no projection logged</div>}
              <div className="mono" style={{ ...mono, fontSize: 13, textAlign: 'right', color: has ? 'var(--t1)' : 'var(--t4)' }}>{has ? exactMoney(total, r.currency || currency) : NA}</div>
            </div>
          );
        })}
        {!rows.length && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No sites yet.</div>}
      </div>
    </div>
  );
}
