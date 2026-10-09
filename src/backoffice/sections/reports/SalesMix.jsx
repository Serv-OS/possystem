// The "Sales mix" report (8 Oct 2026). Peter: "the ability to report on bigger categories like
// say what is Food/drink/other split ... in hospitality a valued piece of data". Each sales
// group's share of item sales for the period: a KPI tile per group, the share over time, the
// groups table (each opens to its categories), the split by service period, and in multi site
// mode a matrix by site. A "Set up groups" panel gives the signed in site's top level
// categories their group; it opens by itself once when more than half of item sales have none.
//
// THE MATHS is in supabase/functions/_shared/salesMix.js (shared with the owner app's function)
// and the view shaping in src/lib/salesMixView.js; this file draws. Groups are resolved through
// _salesMixData (the site's categories plus its Xero mapping), so this report, the Business
// summary strip, the Z report and the owner app always agree on where an item sits (D2).
//
// THE BASIS (D3): till price times qty before check discounts and refunds, as Product mix, so
// the groups add up to Product mix's items and categories and to the Z report's Gross sales.
//
// WHO MAY SET UP GROUPS (8 Oct 2026, review): the panel writes menu categories, so it carries the
// Menu section's lock (lib/boSections.js, canOpen('menu')). A Reports only login (Peter's
// franchisee: "he cannot mess with menus") reads the report, the strip and the slip, but never
// sees the Set up groups button, the callout's button, or the panel opening by itself.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { CompareChip, ExportBtn, EmptyState } from './_charts';
import { KpiBand, Callout, PrimaryBtn, ReportTable, Signed, Tag, BarCell } from './reportKit';
import { toCsv, downloadCsv } from './_csv';
import { reportClock } from './_filters';
import { isSplit } from '../../../lib/reportSplit.js';
import { useParts, exportSites } from './_siteSplit';
import { SplitHeader, Blocks, GroupChange, SiteMatrix } from './SiteSplit';
import { useOneSiteMix, usePartResolvers } from './_salesMixData';
import { ShareChart, ShareLegend } from './SalesMixChart';
import SalesMixSetup from './SalesMixSetup';
import { OTHER_GROUP } from '../../../../supabase/functions/_shared/accountingGroups.js';
import {
  BASIS_NOTE, BANDS_NOTE, mixView, mixFromChecks, mixSeriesLines, shareSeries, daypartSplit,
  reconcile, setupRows, mixRollup, nameAcross,
} from '../../../../supabase/functions/_shared/salesMix.js';
import {
  kpiTiles, groupTableRows, groupTotals, allGroupKeys, reconcileWords, calloutFor, mappingHasOverrides,
  shouldAutoOpen, seenKey, isOneDay, toneVar, csvDate, groupsCsvRows, GROUPS_CSV_COLUMNS, categoriesCsvRows,
  CATEGORIES_CSV_COLUMNS, groupsBySiteCsvRows, GROUPS_BY_SITE_CSV_COLUMNS, mergeSeries, siteMatrixRows,
  needsSetupNames, joinNames, compareUsable, negativeNote,
} from '../../../lib/salesMixView.js';

const NONE = Object.freeze([]);
const cardSt = { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:16, marginBottom:14 };
const capsSt = { fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' };
const noteSt = { fontSize:11.5, color:'var(--t4)', lineHeight:1.5 };
const greySt = { fontSize:11, color:'var(--t4)' };
// A warning sentence in readable text (var(--t2)) with an amber edge: amber text on the light
// theme's white is 2:1, far too faint for a line a manager must read (8 Oct 2026, review).
const warnLineSt = { fontSize:11, color:'var(--t2)', borderLeft:'3px solid var(--amber, #F5A623)', paddingLeft:8 };
const NO_MENU_ACCESS = 'Groups are set in Menu. Ask the owner.';
const linkBtn = { background:'none', border:'none', padding:0, color:'var(--t3)', textDecoration:'underline', cursor:'pointer', fontFamily:'inherit', fontSize:12 };
const centreSt = { textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 };
const numSt = { fontVariantNumeric:'tabular-nums' };

// The panel is remembered as seen per site for the browser session; a browser that refuses
// storage just shows it again next time.
const readSeen = (siteId) => { try { return !siteId || sessionStorage.getItem(seenKey(siteId)) != null; } catch { return false; } };
const writeSeen = (siteId) => { try { if (siteId) sessionStorage.setItem(seenKey(siteId), '1'); } catch { /* storage refused */ } };

// Money through the fmt the shell hands in (the home currency, one other site's, or the
// block's), never the home currency alone.
function Amt({ v, fmt, bold }) {
  return <span style={{ ...numSt, fontWeight: bold ? 700 : 500, color: Number(v) < 0 ? 'var(--red)' : 'var(--t1)' }}>{fmt(v || 0)}</span>;
}

export default function SalesMix(props) {
  return isSplit(props.sites) ? <SalesMixSites {...props}/> : <SalesMixOne {...props}/>;
}

// ── one site ──────────────────────────────────────────────────────────────────

function SalesMixOne({ checks, prevChecks = NONE, fmt, fmtN, locationConfig, compare, range, sites, scope, canOpen }) {
  const one = useOneSiteMix({ sites, scope });
  const { resolver, categories, mapping } = one;
  const mix = useMemo(() => mixFromChecks(checks, resolver), [checks, resolver]);
  // No comparison at all when the previous period did not load (the chips say "Not loaded"; the
  // points and the CSV's previous cells must say nothing, not 0).
  const hasCmp = compareUsable(compare);
  const cmpMix = useMemo(() => (hasCmp ? mixFromChecks(prevChecks, resolver) : null), [hasCmp, prevChecks, resolver]);
  // Every category of every group, so the table can open each group fully and the CSV has them all.
  const view = useMemo(() => mixView(mix, cmpMix, resolver, { topCats: Infinity }), [mix, cmpMix, resolver]);
  const clock = useMemo(() => reportClock(locationConfig), [locationConfig]);
  const shifts = locationConfig?.shifts || NONE;
  // A boolean, never null: a week with one trading day is still drawn by day (8 Oct 2026, review).
  const oneDay = isOneDay(range);
  const series = useMemo(() => mixSeriesLines(checks, resolver, clock, { hourly: oneDay }), [checks, resolver, clock, oneDay]);
  const share = useMemo(() => shareSeries(series), [series]);
  const dayparts = useMemo(() => daypartSplit(checks, resolver, clock, shifts), [checks, resolver, clock, shifts]);
  const recon = useMemo(() => reconcile(checks, view.total), [checks, view.total]);
  const setup = useMemo(() => setupRows(categories, mapping || {}, mix, resolver), [categories, mapping, mix, resolver]);

  // The signed in site AND a login that may open Menu: the panel edits menu categories.
  const canSetup = one.isHome && (!canOpen || canOpen('menu'));
  const [expanded, setExpanded] = useState(() => new Set());
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissedFor, setDismissedFor] = useState(null);
  const seen = useMemo(() => readSeen(one.siteId), [one.siteId]);
  const wantAuto = canSetup && dismissedFor !== one.siteId
    && shouldAutoOpen({ isHome: one.isHome, menuLoading: one.menuLoading, hasCategories: categories.length > 0, view, seen });
  const panelOpen = canSetup && (manualOpen || wantAuto);
  const openPanel = () => setManualOpen(true);
  const closePanel = () => { writeSeen(one.siteId); setManualOpen(false); setDismissedFor(one.siteId); };

  const csvOpts = { from: range?.fromDay || '', to: range?.toDay || '', currency: scope?.currencyOf?.(one.siteId) || locationConfig?.currency || '' };
  const exportGroups = () => downloadCsv(`sales-mix-groups-${csvDate()}.csv`, toCsv(groupsCsvRows(view, csvOpts), GROUPS_CSV_COLUMNS));
  const exportCategories = () => downloadCsv(`sales-mix-categories-${csvDate()}.csv`, toCsv(categoriesCsvRows(view, csvOpts), CATEGORIES_CSV_COLUMNS));

  if (one.menuLoading) return <div style={centreSt}>Loading this site's menu…</div>;

  const site = one.siteName || 'This site';
  const callout = calloutFor(view, { isHome: one.isHome, siteName: site });
  const change = (t) => <CompareChip vs={compare} values={[t.money, t.cmp_money || 0]} noun="item sales" short/>;

  return (
    <div>
      {one.menuFailed && <div style={{ ...warnLineSt, marginBottom:10 }}>{site}: the menu could not be read, so every sale shows as Other sales.</div>}

      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:12, flexWrap:'wrap' }}>
        <div>
          <div style={{ fontSize:12, color:'var(--t3)' }}>Each group's share of item sales.</div>
          {mappingHasOverrides(mapping) && <div style={greySt}>Some groups are set in Xero step 3. Those win.</div>}
          {one.mappingFailed && <div style={greySt}>Xero groups could not be read for {site}. Groups come from the menu categories alone.</div>}
        </div>
        <div style={{ flex:1 }}/>
        <ExportBtn label="Export groups" onClick={exportGroups}/>
        <ExportBtn label="Export by category" onClick={exportCategories}/>
        {canSetup
          ? <PrimaryBtn onClick={openPanel}>Set up groups</PrimaryBtn>
          : one.isHome
            ? <span style={greySt}>{NO_MENU_ACCESS}</span>
            : <span style={greySt}>Groups are set at each site. Sign in at {site} to change them.</span>}
      </div>

      {view.total === 0 ? (
        <EmptyState icon="📊" message="No item sales in this period. Try widening the date range."/>
      ) : (
        <>
          {callout && <MixCallout callout={callout} onOpen={canSetup ? openPanel : null}/>}
          <KpiBand items={kpiItems(view, { fmt, fmtN, change })}/>
          <Footnote view={view}/>
          <ChartCard series={series} share={share} view={view} fmt={fmt}/>
          <GroupsCard view={view} expanded={expanded} setExpanded={setExpanded} fmt={fmt} fmtN={fmtN} compare={compare} recon={recon}/>
          <DaypartCard dayparts={dayparts} view={view} fmt={fmt}/>
        </>
      )}

      {canSetup && (
        <SalesMixSetup open={panelOpen} onClose={closePanel} siteName={one.siteName} categories={categories}
          mapping={mapping || {}} setup={setup} fmt={fmt} auto={wantAuto && !manualOpen}/>
      )}
    </div>
  );
}

// The basis under the band, and the one extra line when a group's money is below zero.
function Footnote({ view }) {
  const neg = negativeNote(view);
  return (
    <div style={{ ...noteSt, marginTop:-8, marginBottom:14 }}>
      <div>{BASIS_NOTE}</div>
      {neg && <div>{neg}</div>}
    </div>
  );
}

// The tiles of the band: share is the big figure, money under it (D3: share is what matters).
// `change` draws the comparison for a tile (a CompareChip for one site, a GroupChange across sites).
function kpiItems(view, { fmt, fmtN, change }) {
  return kpiTiles(view).map((t) => (t.kind === 'total'
    ? { label: t.label, value: fmt(t.money), sub: <>{fmtN(t.qty)} items on {fmtN(t.checks)} checks {change(t)}</> }
    : {
      label: t.label, value: `${t.share}%`, tone: t.warn ? 'warn' : undefined,
      sub: (
        <>
          <span style={{ color: toneVar(t.tone), fontWeight:700 }}>{fmt(t.money)}</span> {change(t)}
          {t.pts != null && <> · share <Signed v={t.pts} unit="pts"/></>}
        </>
      ),
    }));
}

// onOpen null: the signed in site, but a login that may not open Menu; the words say who can.
function MixCallout({ callout, onOpen }) {
  const { kind, n, siteName } = callout;
  if (kind === 'other') {
    return <Callout>{`${n}% of ${siteName}'s item sales have no group yet. Groups are set at each site in its own Back Office.`}</Callout>;
  }
  if (kind === 'most') {
    return (
      <Callout>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <div style={{ flex:1, minWidth:240 }}>
            <b>Most sales have no group yet.</b> {`${n}% of item sales show as Other sales. `}
            {onOpen ? 'Set up groups takes about two minutes: pick Food, Drinks or another group for each top level category.' : NO_MENU_ACCESS}
          </div>
          {onOpen && <PrimaryBtn onClick={onOpen}>Set up groups</PrimaryBtn>}
        </div>
      </Callout>
    );
  }
  return (
    <Callout>
      {`${n}% of item sales are in categories with no group yet. They show as Other sales.`} {onOpen ? <button onClick={onOpen} style={linkBtn}>Set up groups</button> : NO_MENU_ACCESS}
    </Callout>
  );
}

function namesAndTones(view) {
  const names = {}, tones = {};
  for (const g of view?.groups || []) { names[g.key] = g.name; tones[g.key] = g.tone; }
  return { names, tones, keys: (view?.groups || []).map((g) => g.key) };
}

function ChartCard({ series, share, view, fmt }) {
  const { names, tones, keys } = namesAndTones(view);
  return (
    <div style={cardSt}>
      <div style={{ ...capsSt, marginBottom:14, display:'flex', justifyContent:'space-between', gap:10, flexWrap:'wrap' }}>
        <span>{series.isHourly ? 'Share by hour' : 'Share by day'}</span>
        <ShareLegend keys={keys} names={names} tones={tones}/>
      </div>
      {series.xKeys.length === 0
        ? <div style={{ textAlign:'center', padding:'32px 0', color:'var(--t4)', fontSize:12 }}>No sales to draw.</div>
        : <ShareChart money={series} share={share} names={names} tones={tones} fmt={fmt}/>}
    </div>
  );
}

function GroupCell({ r, onToggle }) {
  return (
    <button onClick={onToggle} aria-expanded={r.open} aria-label={`${r.open ? 'Hide' : 'Show'} ${r.name} categories`}
      style={{ display:'inline-flex', alignItems:'center', gap:8, background:'none', border:'none', padding:0, cursor:'pointer', fontFamily:'inherit', fontSize:13, color:'var(--t1)' }}>
      <span style={{ color:'var(--t4)', width:10, display:'inline-block' }}>{r.open ? '▾' : '▸'}</span>
      <span style={{ width:8, height:8, borderRadius:2, background: toneVar(r.tone), flexShrink:0 }}/>
      <span style={{ fontWeight:700 }}>{r.name}</span>
      {r.key === OTHER_GROUP && r.unresolved > 0 && <Tag tone="warn" label="no group"/>}
    </button>
  );
}

// Fixed order (money desc, Other sales last), a chevron per group and one toggle for all;
// categories closed by default. A category's share is of the TOTAL (one meaning per column);
// its share of the group is the title.
function GroupsCard({ view, expanded, setExpanded, fmt, fmtN, compare, recon }) {
  const rows = groupTableRows(view, expanded);
  const totals = groupTotals(view);
  const allOpen = view.groups.length > 0 && view.groups.every((g) => expanded.has(g.key));
  const toggle = (key) => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(allGroupKeys(view)));
  const none = <span style={{ color:'var(--t4)' }}>none</span>;
  const columns = [
    { key:'group', label:'Group', render: (r) => (r.kind === 'group'
      ? <GroupCell r={r} onToggle={() => toggle(r.key)}/>
      : <span style={{ paddingLeft:22, color:'var(--t2)', fontWeight:500 }}>{r.label}</span>) },
    { key:'money', label:'Item sales', align:'right', render: (r) => <Amt v={r.money} fmt={fmt} bold={r.kind === 'group'}/> },
    { key:'share', label:'Share', align:'right', width:120, render: (r) => (r.kind === 'group'
      ? <BarCell v={r.share} max={100} text={`${r.share}%`}/>
      : <span title={`${r.shareOfGroup}% of ${r.groupName}`}><BarCell v={r.money} max={view.total} text={`${r.shareOfTotal}%`}/></span>) },
    { key:'qty', label:'Qty', align:'right', render: (r) => fmtN(r.qty) },
    { key:'avg', label:'Avg price', align:'right', render: (r) => { const a = r.kind === 'group' ? r.avg_price : r.avg; return a == null ? none : fmt(a); } },
    { key:'items', label:'Items', align:'right', render: (r) => (r.kind === 'group' ? fmtN(r.items) : '') },
    { key:'change', label:'vs before', align:'right', render: (r) => (r.kind === 'group' ? <CompareChip vs={compare} values={[r.money, r.cmp_money]} noun="item sales" short/> : '') },
  ];
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8 }}>
        <div style={capsSt}>Groups</div>
        <button onClick={toggleAll} style={linkBtn}>{allOpen ? 'Hide categories' : 'Show categories'}</button>
      </div>
      <ReportTable columns={columns} rows={rows} empty="No item sales in this period." totals={{
        group: 'Total', money: fmt(totals.total), share: '100%', qty: fmtN(totals.qty),
        avg: totals.avg == null ? 'none' : fmt(totals.avg), items: fmtN(totals.items), change: '',
      }}/>
      <div style={{ ...noteSt, marginTop:8 }}>{BASIS_NOTE}</div>
      {negativeNote(view) && <div style={noteSt}>{negativeNote(view)}</div>}
      <div style={noteSt}>{reconcileWords(recon, fmt)}</div>
    </div>
  );
}

// Money over its share, the cell of the daypart table.
function Stack({ money, share, bold }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2 }}>
      <span style={{ ...numSt, fontWeight: bold ? 700 : 500, color:'var(--t1)' }}>{money}</span>
      <span style={{ fontSize:11, color:'var(--t4)' }}>{share}%</span>
    </div>
  );
}

// Rows are the service periods (locationConfig.shifts) or the four time of day bands;
// columns are the groups; each cell is money plus that group's share of the period.
function DaypartCard({ dayparts, view, fmt }) {
  const { names } = namesAndTones(view);
  const groupOf = (key) => view.groups.find((g) => g.key === key);
  const columns = [
    { key:'period', label:'Period', render: (r) => (
      <>
        <div style={{ fontWeight:700, color:'var(--t1)' }}>{r.name}</div>
        {r.sub && <div style={{ fontSize:11, color:'var(--t4)' }}>{r.sub}</div>}
      </>
    ) },
    ...dayparts.keys.map((k) => ({ key: k, label: names[k] || k, align:'right', render: (r) => <Stack money={fmt(r.groups[k] || 0)} share={r.shares[k] ?? 0}/> })),
    { key:'total', label:'Total', align:'right', render: (r) => <Stack money={fmt(r.total)} share={r.share} bold/> },
  ];
  const totals = { period: 'Total', total: fmt(view.total) };
  for (const k of dayparts.keys) { const g = groupOf(k); totals[k] = <Stack money={fmt(g?.money || 0)} share={g?.share ?? 0} bold/>; }
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:8, gap:10, flexWrap:'wrap' }}>
        <div style={capsSt}>{dayparts.mode === 'shifts' ? 'By service period' : 'By time of day'}</div>
        <div style={greySt}>{dayparts.mode === 'shifts' ? 'Configured in Location settings' : BANDS_NOTE}</div>
      </div>
      <ReportTable columns={columns} rows={dayparts.rows} totals={totals} empty="No item sales in this period."/>
    </div>
  );
}

// ── several sites ─────────────────────────────────────────────────────────────
// Each site's lines are resolved against ITS OWN categories and mapping (one resolver per
// part); the sites are joined by GROUP KEY only (copies of a shared category differ in id and
// label). Per currency block: the band, the share chart, item sales by site and share by site.
// The service period table and the categories are one site's: pick one site for them.

function SalesMixSites(props) {
  const { fmtN, range, canOpen } = props;
  const { parts, blocks } = useParts(props);
  const pr = usePartResolvers(parts);
  const storeCategories = useStore((s) => s.menuCategories) || NONE;
  const homePart = parts.find((p) => p.site?.isHome) || null;
  const canSetup = !!homePart && (!canOpen || canOpen('menu'));
  const oneDay = isOneDay(range);
  const [panel, setPanel] = useState(false);

  const views = useMemo(() => {
    const out = {};
    for (const p of parts) {
      const r = pr.resolvers[p.id];
      // A part whose comparison did not load has no comparison (GroupChange says so on the tile).
      if (r) out[p.id] = mixView(mixFromChecks(p.rows, r), compareUsable(p.compare) ? mixFromChecks(p.prevRows, r) : null, r, { topCats: Infinity });
    }
    return out;
  }, [parts, pr.resolvers]);
  // Names: the signed in site's resolver first, then the parts in order (0.9 of the build spec).
  const resolversOrdered = useMemo(() => {
    const list = homePart ? [homePart, ...parts.filter((p) => p !== homePart)] : parts;
    return list.map((p) => pr.resolvers[p.id]).filter(Boolean);
  }, [parts, homePart, pr.resolvers]);
  const blockViews = useMemo(() => {
    const nameOf = (key) => nameAcross(resolversOrdered, key);
    const out = {};
    for (const b of blocks) out[b.key] = mixRollup(b.parts.map((p) => views[p.id]), { nameOf });
    return out;
  }, [blocks, views, resolversOrdered]);
  const seriesOf = useMemo(() => {
    const out = {};
    for (const b of blocks) {
      const s = mergeSeries(b.parts.map((p) => (pr.resolvers[p.id] ? mixSeriesLines(p.rows, pr.resolvers[p.id], p.clock, { hourly: oneDay }) : null)));
      out[b.key] = { series: s, share: shareSeries(s) };
    }
    return out;
  }, [blocks, pr.resolvers, oneDay]);
  const homeResolver = homePart ? pr.resolvers[homePart.id] : null;
  const homeMix = useMemo(() => (homePart && homeResolver ? mixFromChecks(homePart.rows, homeResolver) : null), [homePart, homeResolver]);
  const homeSetup = useMemo(() => (
    homePart && homeResolver ? setupRows(storeCategories, pr.mappings[homePart.id] || {}, homeMix, homeResolver) : null
  ), [homePart, homeResolver, storeCategories, pr.mappings, homeMix]);

  const exportBySite = () => exportSites('sales-mix-groups', parts.flatMap((p) => groupsBySiteCsvRows(p, views[p.id])), GROUPS_BY_SITE_CSV_COLUMNS);

  if (pr.menusLoading) return <div style={centreSt}>Loading each site's menu…</div>;

  const nameOfPart = (id) => parts.find((p) => p.id === id)?.name || id;
  const unsetNames = needsSetupNames(parts, (p) => views[p.id]);

  return (
    <div>
      <SplitHeader parts={parts} chips={false} onExport={exportBySite}>
        {pr.menusFailed.map((id) => <div key={`m${id}`} style={warnLineSt}>{nameOfPart(id)}: the menu could not be read, so its sales show as Other sales.</div>)}
        {unsetNames.length > 0 && <div style={{ color:'var(--t4)' }}>{joinNames(unsetNames)} have no sales groups set yet. Set them at each site.</div>}
        {pr.mappingsFailed.map((id) => <div key={`x${id}`} style={{ color:'var(--t4)' }}>Xero groups could not be read for {nameOfPart(id)}. Groups come from the menu categories alone.</div>)}
      </SplitHeader>
      {canSetup && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
          <PrimaryBtn onClick={() => setPanel(true)}>Set up groups at {homePart.name}</PrimaryBtn>
        </div>
      )}

      <Blocks blocks={blocks}>{(b) => {
        const bv = blockViews[b.key];
        if (!bv || bv.total === 0) return <EmptyState icon="📊" message="No item sales in this period. Try widening the date range."/>;
        const matrix = siteMatrixRows(bv, b.parts.map((p) => ({ id: p.id, view: views[p.id] })));
        const at = (p, key) => (views[p.id]?.groups || []).find((g) => g.key === key);
        const change = (t) => (
          <GroupChange block={b} pairs={b.parts.map((p) => (t.kind === 'total'
            ? { current: views[p.id]?.total || 0, previous: views[p.id]?.cmp_total || 0 }
            : { current: at(p, t.key)?.money || 0, previous: at(p, t.key)?.cmp_money || 0 }))}/>
        );
        const s = seriesOf[b.key];
        return (
          <>
            <KpiBand items={kpiItems(bv, { fmt: b.fmt, fmtN, change })}/>
            <Footnote view={bv}/>
            <ChartCard series={s.series} share={s.share} view={bv} fmt={b.fmt}/>
            <SiteMatrix block={b} title="Item sales by site" first="Group" fmtN={fmtN} rows={matrix.money}/>
            <SiteMatrix block={b} title="Share by site" first="Group" fmtN={fmtN} rows={matrix.share.map((r) => ({
              key: r.key, label: r.label, bySite: {}, total: 0, kind: 'count',
              render: (p) => `${r.bySite[p.id] ?? 0}%`, totalNode: `${r.total}%`,
            }))}/>
            <div style={{ ...noteSt, marginBottom:14 }}>Pick one site for the service period table and the categories.</div>
          </>
        );
      }}</Blocks>

      {canSetup && homeSetup && (
        <SalesMixSetup open={panel} onClose={() => setPanel(false)} siteName={homePart.name} categories={storeCategories}
          mapping={pr.mappings[homePart.id] || {}} setup={homeSetup} fmt={homePart.fmt} auto={false}/>
      )}
    </div>
  );
}
