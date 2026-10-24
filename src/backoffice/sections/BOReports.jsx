// v4.6.16: Back Office Reports shell — catalog landing + report detail views.
//
// Architecture:
//   - On mount, show the Catalog (grid of category cards with report links).
//   - Clicking a report sets view = report id, which renders a detail page with:
//       - Breadcrumb: "Reports / [category] / [report]"  + a "← Back to reports" link
//       - Filter row: period, server, order type, custom range
//       - The report component itself
//   - State: view, period, customRange, serverFilter, orderTypeFilter
//   - Data: rangeChecks (current period), prevChecks (previous period) — fetched on period change.
//
// v5.11.92 (multi site stock Drop 4a, contract 2.3): the same shell is Reports > Stock and GP for a
// multi site company (BackOfficeApp renders it on 'stock-gp' with initialView 'stock_home'). A stock
// view (an id starting stock_) reads nothing from the closed checks: its figures are the database's,
// from the stored day totals, through the report component it mounts (one stock_report_* call each,
// src/lib/stock/reportsData.js). Its sites come from the stock site scope (every open site this login
// reaches by its Stock control level, the site groups, closed sites on request), its period from the
// stock pills (whole business days, between two counts, the company's week start), its compare from
// a second call (previous period or the same days last year), and it lays sites side by side or as
// the company total. Each screen has one Export and one Share, both the report's own (StockReportFrame):
// the share link keeps the report's filters on screen (drill site, tab, toggles), never a figure.

import { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { fetchClosedChecksRange, fetchKDSTicketsRange } from '../../lib/db';
import { loadingText, TOO_LONG_TEXT, rowBudget, CHECK_ROWS_ON_SCREEN } from '../../lib/pagedRead';
import { buildPeriods, buildStockPeriods, STOCK_PERIODS, getPeriodRange, periodLabel, applyFilters, uniqueServers, uniqueOrderTypes, uniqueSources, SOURCE_LABEL, dayOfCheck, reportClock } from './reports/_filters';
import {
  buildReportScope, connectedSites, sitesForView, siteRange, itemCapLine, figuresFrom, totalsByCurrency, totalsWords,
  choiceKey, readSiteChoice, writeSiteChoice, resolveTicked, toggleTicked, choiceFor,
  stockReportScope, stockSitesLabel, tickedGroup,
} from '../../lib/reportScope.js';
import { loadScopeRows, loadScopeDaySums, tagRows } from '../../lib/reportScopeLoad.js';
import { fetchReportScopeData, probeDaySums } from '../../lib/reportSites.js';
import { loadReportDaySums } from '../../lib/reportDaySums.js';
// v5.11.99 (Reports align): demo history is left out of every sales report by the one demo rule.
import { leaveOutDemo, DEMO_NOTE } from '../../../supabase/functions/_shared/demoHistory.js';
import { demoChecksIn } from '../../lib/reportDemo.js';
import SitesControl, { SiteNote } from './reports/SitesControl';
import { getLocationConfig } from '../../lib/locationTime';
import { compareRange, compareMoves, prevTopUp, notLoaded, COMPARE_STEP_MS } from '../../lib/reportCompare.js';
import Catalog, { CATEGORIES, REPORT_INDEX } from './reports/Catalog';
import { SegToggle } from './reports/reportKit';
import { useStockScope } from '../StockScope';
import { stockApi } from '../../lib/stock/stockApi';
import { stockReportsApi } from '../../lib/stock/stockReportsApi';
import { isStockReportId, reportFnOf, EXPORTABLE_REPORTS, STOCK_LATER, LATER_WORDS, writeShareLink, applyShareLink } from '../../lib/stock/reportLink';
import { LaterTile } from './reports/_stockKit';
import SalesSummary from './reports/SalesSummary';
import Exceptions   from './reports/Exceptions';
import Payments     from './reports/Payments';
import Daypart      from './reports/Daypart';
import Shifts       from './reports/Shifts';
import ProductMix   from './reports/ProductMix';
import SalesMix     from './reports/SalesMix';
import ItemTrend    from './reports/ItemTrend';
import DailyTrend   from './reports/DailyTrend';
import DailyTrading from './reports/DailyTrading';
import PayrollReport from './reports/PayrollReport';
import MenuEngineering from './reports/MenuEngineering';
import Servers      from './reports/Servers';
import Tips         from './reports/Tips';
import OrderTypes   from './reports/OrderTypes';
import OrderSources from './reports/OrderSources';
import Tables       from './reports/Tables';
import KDSPerformance from './reports/KDSPerformance';
import ZReport      from './reports/ZReport';
import Tax          from './reports/Tax';
import LocationCompare from './reports/LocationCompare';
import CashDrawer    from './reports/CashDrawer';
import LoyaltyReport from './reports/LoyaltyReport';
import BookingsReport from './reports/BookingsReport';
import BookingPaymentsReport from './reports/BookingPaymentsReport';
import Transactions  from './Transactions';
// v5.11.92 (Drop 4a): the Stock and GP screens (web-dashboard and web-reports own these files).
import StockDashboard from './reports/StockDashboard';
import StockValue from './reports/StockValue';
import StockMovement from './reports/StockMovement';
import StockGap from './reports/StockGap';
import StockCogs from './reports/StockCogs';
import StockProductGP from './reports/StockProductGP';
import StockWaste from './reports/StockWaste';
import StockPurchases from './reports/StockPurchases';
import StockPrices from './reports/StockPrices';
import StockDaysOnHand from './reports/StockDaysOnHand';
import StockPar from './reports/StockPar';
import StockKeyRatios from './reports/StockKeyRatios';
import StockSetupHealth from './reports/StockSetupHealth';
import StockBatches from './reports/StockBatches';
import StockRecipeCost from './reports/StockRecipeCost';
import StockAllergens from './reports/StockAllergens';
// v5.11.100 (Drop 4b): the five purchasing reports.
import StockOffContract from './reports/StockOffContract';
import StockBudget from './reports/StockBudget';
import StockTransfersReport from './reports/StockTransfersReport';
import StockCountCompliance from './reports/StockCountCompliance';
import StockMonthEnd from './reports/StockMonthEnd';
import ExportStatus from './reports/ExportStatus';
import { money } from '../../lib/currency';

// Money in the signed in site's currency (the Back Office currency). A report showing
// ANOTHER site gets a fmt for that site's own currency (see fmt in the component).
const fmtActive = n => `${money((n || 0))}`;
const fmtN = n => (n || 0).toLocaleString();

// The remembered Sites choice lives in the browser; a browser that refuses storage just
// starts on the signed in site every visit.
const browserStore = () => { try { return window.localStorage; } catch { return null; } };
const NO_SCOPE_DATA = { userId: null, locations: [], readableIds: null, clocks: {} };
const NO_SITES = [];
const NO_IDS = [];

// v5.11.92: a Stock and GP view (its id starts stock_). It reads none of the shell's closed checks.
const STOCK_VIEWS = (v) => typeof v === 'string' && v.startsWith('stock_');
const COMPARE_MODES = [{ id: 'prev', label: 'Previous period' }, { id: 'last_year', label: 'Same period last year' }];
const LAYOUTS = [{ id: 'side', label: 'Side by side' }, { id: 'total', label: 'Company total' }];

// 5 Oct 2026: which fault, if any, blanks this report. The reports below read their own data
// (their own loaders, not the shell's closed checks), so a period too long for the shell does
// not take them down; Kitchen performance stands on the ticket read, and (6 Oct 2026 review)
// on the checks read when THAT is what stopped everything: the tickets are halted with the
// checks, so an empty ticket list then is not "no kitchen tickets", it is the same fault.
const OWN_DATA_VIEWS = new Set(['payroll', 'daily_trading', 'bookings', 'booking_payments', 'location_compare', 'cash_drawer', 'open']);
function faultFor(view, loadFault, kdsFault) {
  if (STOCK_VIEWS(view)) return null;
  if (OWN_DATA_VIEWS.has(view) || view.startsWith('loyalty_')) return null;
  if (view === 'kds_perf') return kdsFault || loadFault || null;
  return loadFault || null;
}

// 8 Oct 2026: canOpen is the Back Office section access rule (lib/boSections.js). A tile that
// opens another part of Back Office is left out for a login that is not shown that part.
// v5.11.92: initialView 'stock_home' is Reports > Stock and GP; stockLink is one report to open with
// its filters (a "See the report" link or a share link), applied once after the stock scope is in.
export default function BOReports({ setSection, canOpen, initialView = 'catalog', stockLink = null, onLinkUsed } = {}) {
  const { tables, taxRates, closedChecks: storeChecks, showToast } = useStore();

  const [view, setView]               = useState(initialView); // 'catalog' or a report id
  const [period, setPeriod]           = useState(STOCK_VIEWS(initialView) ? 'this-week' : 'today');
  const [customRange, setCustomRange] = useState({ from: null, to: null });
  const [homeConfig, setHomeConfig] = useState(null);  // v4.6.24: the signed in site's config
  const [serverFilter, setServerFilter]       = useState('all');
  const [orderTypeFilter, setOrderTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter]       = useState('all'); // v5.5.140: pos / kiosk / online / qr
  const isStock = STOCK_VIEWS(view);

  // ── Stock and GP (v5.11.92): the stock site scope, the layout, the compare, the link ──────────
  const stock = useStockScope();
  const stockReady = !!stock.ready && !!stock.multi;
  const [stockTicked, setStockTicked] = useState(null);      // null = follow the top bar picker's choice
  const [stockShowClosed, setStockShowClosed] = useState(false);
  const [compareMode, setCompareMode] = useState('prev');    // 'prev' | 'last_year'
  const [layout, setLayout] = useState('side');              // 'side' | 'total'
  const [stockOpts, setStockOpts] = useState(null);          // a report's own options from a link or a drill
  const [stockWeekStart, setStockWeekStart] = useState(null); // stock_co_settings.week_start (null = Monday)
  const [exportJob, setExportJob] = useState(null);          // { id, report, label, from, to }: a background export being built
  const pickerIds = useMemo(() => (stock.scopeSites || []).map((s) => s.id).filter(Boolean), [stock.scopeSites]);
  const stockScope = useMemo(() => (stockReady ? stockReportScope(stock, stockTicked ?? pickerIds, stockShowClosed) : null),
    [stockReady, stock, stockTicked, pickerIds, stockShowClosed]);
  const stockSites = stockScope ? stockScope.tickedIds : NO_IDS;
  // The company's week start, read once per company when a stock view is on (the pills' "This week").
  useEffect(() => {
    if (!isStock || !stock.orgId) return undefined;
    let live = true;
    stockApi.settings(stock.orgId).then((r) => { if (live) setStockWeekStart(r.data?.settings?.week_start ?? 1); }).catch(() => { if (live) setStockWeekStart(1); });
    return () => { live = false; };
  }, [isStock, stock.orgId]);
  // A stock view only takes a stock period: anything else (a service, last 7 days) becomes this week.
  useEffect(() => {
    if (isStock && !STOCK_PERIODS.some((p) => p.id === period)) setPeriod('this-week');
  }, [isStock, period]);

  // Opening a catalog tile: most reports render in-shell (setView), but some tiles
  // point at full Back Office sections that live in their own group (e.g. Inventory
  // reports, Marketing report). Those carry a `section` and navigate there instead —
  // single source of truth, nothing duplicated or embedded.
  const openReport = (r) => {
    if (r && typeof r === 'object' && r.section) {
      if (setSection) setSection(r.section);
      return;
    }
    const id = typeof r === 'string' ? r : r?.id;
    if (STOCK_VIEWS(id)) setStockOpts(null);
    setView(id);
  };
  // v5.11.92: a stock report opened from the dashboard or another stock report, with its options and,
  // for a league row click, the one site. A tile that waits for a later Drop never opens.
  const openStockView = (id, opts = null, sites = null) => {
    if (!isStockReportId(id) || STOCK_LATER[id]) return;
    setStockOpts(opts && typeof opts === 'object' ? opts : null);
    if (Array.isArray(sites) && sites.length) setStockTicked(sites.map(String));
    setView(id);
  };
  const pickStockSites = (ids) => { setStockTicked(Array.isArray(ids) ? ids.map(String) : null); };

  // v4.6.24: Load location timezone + businessDayStart + service periods so reports
  // can honour real business-day boundaries and service-period grouping.
  // v5.10.2: the ranges are built on the venue's clock from this config, so nothing is
  // fetched until it is here (a failed read falls back to getLocationConfig's defaults).
  useEffect(() => {
    let alive = true;
    getLocationConfig()
      .then(cfg => { if (alive) setHomeConfig(cfg); })
      .catch(() => { if (alive) setHomeConfig({ timezone: 'Europe/London', businessDayStart: '06:00', shifts: [] }); });
    return () => { alive = false; };
  }, []);

  // ── The report scope (Peter, 5 Oct 2026: "make every report we have multi site when sites
  // are connected together, and you can filter them down to just one site"). ──────────────
  // Which sites this login may look at (same company AND readable: src/lib/reportScope.js),
  // which are ticked, and each one's own clock and currency. It starts on the signed in
  // site and remembers the last choice per login and company. A login with one site gets
  // no control and reads exactly as before.
  const [homeId, setHomeId]         = useState(undefined);  // undefined = not resolved yet, null = no site
  const [scopeData, setScopeData]   = useState(null);       // null until the three small reads are back
  const [tickedIds, setTickedIds]   = useState(null);
  const [oneSiteId, setOneSiteId]   = useState(null);       // the site picked in a one site report's note
  const [daySumsOn, setDaySumsOn]   = useState({ available: null, reason: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      let locId = await getLocationId().catch(() => null);
      if (!locId) {
        try {
          const snap = JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}');
          const dev  = JSON.parse(localStorage.getItem('rpos-device') || '{}');
          locId = dev.locationId || snap.locationId || null;
        } catch { /* no stored site: the reports show what this device holds */ }
      }
      // The reports never wait long on this: no answer in 6 seconds = the signed in site
      // alone, exactly as before there was a Sites control.
      const data = (locId && !isMock)
        ? await Promise.race([fetchReportScopeData(locId), new Promise(r => setTimeout(() => r(NO_SCOPE_DATA), 6000))])
        : NO_SCOPE_DATA;
      if (!alive) return;
      const found = connectedSites({ homeId: locId, locations: data.locations, readableIds: data.readableIds });
      const orgId = found.find(l => String(l.id) === String(locId))?.org_id || null;
      setTickedIds(resolveTicked(readSiteChoice(browserStore(), choiceKey(data.userId, orgId)), found, locId));
      setHomeId(locId || null);
      setScopeData(data);
    })();
    return () => { alive = false; };
  }, []);
  const scopeReady = homeId !== undefined && scopeData !== null;
  const scope = useMemo(() => (
    scopeReady && homeId ? buildReportScope({ homeId, ...scopeData, homeConfig, tickedIds }) : null
  ), [scopeReady, homeId, scopeData, homeConfig, tickedIds]);
  // What this report is shown: every ticked site once it is multi site ready, else one site
  // with a note (REPORT_SITE_MODE in reportScope.js is the flag list).
  const viewSites = useMemo(() => sitesForView(view, scope, oneSiteId), [view, scope, oneSiteId]);
  // The site the period is built on: its clock decides "today" and the days in the header.
  const rangeSite = !scope ? null
    : viewSites.mode === 'multi' ? scope.primary
    : viewSites.mode === 'one'   ? viewSites.sites[0]
    : scope.home;
  // The sites whose rows the shell reads. The overview reads its own (every site), so under
  // it the shell holds the signed in site, as it always has.
  const shellSites = useMemo(() => (
    !scope ? NO_SITES : viewSites.mode === 'all' ? [scope.home] : viewSites.sites
  ), [scope, viewSites]);
  // locationConfig = the config of the site on screen. For the signed in site it is the very
  // object getLocationConfig handed back, so one site is built exactly as before the scope.
  const locationConfig = useMemo(() => {
    if (!homeConfig) return null;
    if (!rangeSite || rangeSite.isHome) return homeConfig;
    return { timezone: rangeSite.timezone, businessDayStart: rangeSite.businessDayStart, shifts: rangeSite.shifts, currency: rangeSite.currency };
    // rangeSite is looked up fresh each render; its id is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeConfig, rangeSite?.id, scopeData]);
  const otherCurrency = rangeSite && !rangeSite.isHome ? rangeSite.currency : null;
  const fmt = useMemo(() => (otherCurrency ? (n) => money(n || 0, otherCurrency) : fmtActive), [otherCurrency]);

  const [rangeChecks, setRangeChecks] = useState(null);
  const [prevChecks,  setPrevChecks]  = useState(null);
  const [kdsTickets,  setKdsTickets]  = useState(null);
  const [loadingRange, setLoadingRange] = useState(false);
  // 5 Oct 2026: the period is read in pages of 1,000 (lib/pagedRead.js), so the screen says
  // "Loading 3 of 9" while they arrive. loadFault: 'too_long' when the period holds more rows
  // than one report can read, 'failed' when a page failed. Either way NO totals are shown:
  // until now a failed or cut read showed as a quiet week.
  const [loadProgress, setLoadProgress] = useState(null);
  const [loadFault, setLoadFault] = useState(null);
  const [kdsFault, setKdsFault] = useState(null);
  const [activeLocId, setActiveLocId] = useState(null); // v5.5.278: track resolved location for merge filtering
  // Live sales (the store) belong to the signed in site only. They are merged in, and the
  // comparison moves with the clock, only while the rows on screen are that site alone.
  // Another site, or several, is a picture as of the moment it loaded: both sides of the
  // percent stand still together, so it stays like for like.
  const [liveOn, setLiveOn] = useState(true);
  const [daySums, setDaySums] = useState(null);         // the server day sums, when a report draws from them
  const [sumsDemo, setSumsDemo] = useState(false);      // v5.11.99: the day sums' period held a demo check (left out by the database)

  // builtAt = the moment this range (and the comparison inside it) was worked out.
  const range = useMemo(() => {
    const builtAt = Date.now();
    return { ...getPeriodRange(period, customRange, locationConfig, builtAt), builtAt };
  }, [period, customRange, locationConfig]);
  // v5.11.92: a stock view's range is the same period on the same clock, with the company's week
  // start, and its compare is the second call's days (previous period, or the same days last year).
  const stockRange = useMemo(() => (
    isStock ? getPeriodRange(period, customRange, { ...(locationConfig || {}), weekStart: stockWeekStart ?? 1 }, range.builtAt) : null
  ), [isStock, period, customRange, locationConfig, stockWeekStart, range.builtAt]);
  const stockCompare = useMemo(() => (stockRange ? compareRange(period, stockRange, range.builtAt, { mode: compareMode }) : null), [stockRange, period, compareMode, range.builtAt]);

  // v5.11.29, the one percent rule (Peter, 5 Oct 2026): a comparison cut at "the same time
  // of day" has to MOVE with the clock. The current side grows by itself (live sales are
  // merged in below) but the range above is only rebuilt when the period changes, so a tab
  // opened at noon and left open to close read "+237.8% vs last Monday by 12pm" (the day's
  // 1068.63 against last Monday's 316.34 by noon; like for like was +2.1%). So while the
  // comparison is one that moves, the clock ticks every few minutes (and when the tab comes
  // back into view), the comparison is rebuilt for the new time, and the effect further
  // down fetches the extra minutes of the previous period. The range itself, and every
  // report that does not compare, is left alone: no reload, no Loading flash.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const moves = liveOn && compareMoves(range.compare);
  useEffect(() => {
    if (!moves) return undefined;
    const bump  = () => setNowMs(Date.now());
    const onVis = () => { if (document.visibilityState === 'visible') bump(); };
    const id = setInterval(bump, COMPARE_STEP_MS);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [moves]);
  const compare = useMemo(() => (
    liveOn && range.compare && nowMs > range.builtAt ? compareRange(period, range, nowMs) : range.compare
  ), [period, range, nowMs, liveOn]);

  // Empty and NOT LOADED are different things. A previous period whose query failed (or
  // that has no site to ask) must never read "New", which says the site had no sales then.
  const [prevLoaded, setPrevLoaded] = useState(false);
  const prevHeld = useRef(null);   // { from, to } in ms: the window prevChecks holds
  const prevSeq  = useRef(0);      // a newer load wins over an older one still in flight

  const activeSessions = useMemo(() =>
    Object.fromEntries(tables.filter(t => t.session).map(t => [t.id, t.session]))
  , [tables]);

  // Each site the shell reads, with ITS OWN range: the same business days as instants on
  // that site's clock, and its own comparison. The site the range was built on is read over
  // the range itself (the same object), so one site is asked exactly what it always was.
  const sites = useMemo(() => shellSites.map(s => ({
    ...s, range: s.id === rangeSite?.id ? range : siteRange(period, range, s, range.builtAt),
  })), [shellSites, rangeSite?.id, range, period]);
  // Peter's decision 4: item reports across several sites stop at 7 days; several sites over
  // a long period draw from the server day sums once a report can and the function is there.
  const capLine = itemCapLine(view, shellSites, range);
  const figures = figuresFrom(view, shellSites, range, daySumsOn);
  const wantTickets = shellSites.length <= 1 || view === 'kds_perf';
  // What the read depends on besides the period: which sites, and how they are read. A view
  // change alone (same sites, same way) does not read again, as before. v5.11.92: a stock view
  // reads nothing, and leaving one for a sales report reads again.
  const loadKey = `${homeId || ''}|${shellSites.map(s => s.id).join(',')}|${capLine ? 'cap' : figures}|${wantTickets ? 'k' : ''}|${isStock ? 'stock' : ''}`;

  useEffect(() => {
    prevSeq.current += 1; prevHeld.current = null;
    setDaySums(null); setSumsDemo(false);
    if (isMock) { setRangeChecks([]); setPrevChecks([]); setKdsTickets([]); setPrevLoaded(true); return; }
    if (period === 'custom' && (!customRange.from || !customRange.to)) {
      setRangeChecks([]); setPrevChecks([]); setKdsTickets([]); setPrevLoaded(true); return;
    }
    // Until v5.10.2 this fired on mount with the range built before the config arrived
    // (browser midnight) and never again, so "Today" read the wrong window.
    if (!locationConfig) return;
    // 5 Oct 2026: and not before the scope is in. It says which sites to read (the choice
    // remembered from last time), so reading first would mean reading twice.
    if (!scopeReady) return;
    setLoadingRange(true);
    setLoadProgress(null);
    setLoadFault(null);
    setKdsFault(null);
    // A read can now take a few seconds: when the period changes under it, the old read
    // stops asking for pages and its answer is dropped, never painted over the new one.
    let stale = false;
    const stop = () => stale;
    (async () => {
      try {
        if (!homeId || !sites.length) {
          const localSlice = (storeChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= range.from && new Date(c.closedAt) <= range.to);
          if (stale) return;
          setRangeChecks(localSlice); setPrevChecks([]); setKdsTickets([]);
          setPrevLoaded(false);   // no site to ask, so nothing to compare with: not "New"
          setActiveLocId(null); setLiveOn(true);
          setLoadingRange(false);
          return;
        }
        const homeOnly = sites.length === 1 && sites[0].isHome;
        setActiveLocId(homeOnly ? homeId : null);
        setLiveOn(homeOnly);
        const nothing = () => { setRangeChecks([]); setPrevChecks([]); setKdsTickets([]); };
        // v5.11.92: a Stock and GP view reads no closed checks at all (its component asks the database).
        if (STOCK_VIEWS(view)) { nothing(); setPrevLoaded(false); setLoadingRange(false); return; }
        // The 7 day line shows in place of the report: nothing is read.
        if (capLine) { nothing(); setPrevLoaded(false); setLoadingRange(false); return; }
        if (figures === 'sums') {
          const sums = await loadScopeDaySums({ load: loadReportDaySums, client: supabase, sites, range });
          if (stale) return;
          // Not there after all (or it failed): fall back to the rows, under the row budget.
          if (sums.available) {
            // The sums are every sale of the day: they cannot be cut down to one server,
            // order type or source. So those filters go back to "all" (their dropdowns have
            // no rows to list anyway) and the figures are never a filtered total in disguise.
            setServerFilter('all'); setOrderTypeFilter('all'); setSourceFilter('all');
            setDaySums(sums); nothing(); setPrevLoaded(!!sums.previous); setLoadingRange(false);
            // v5.11.99: the database left any demo check out; say so when the period held one.
            demoChecksIn(supabase, sites.map(s => ({ id: s.id, from: s.range.from, to: s.range.to }))).then(d => { if (!stale) setSumsDemo(d); });
            return;
          }
        }
        // This period, the previous period (the percent chips) and the kitchen tickets are
        // each read in full, for every site in `sites`, sharing 3 requests in flight and ONE
        // row budget between them (src/lib/reportScopeLoad.js keeps the rules: a part read
        // is never shown as a total, a failed site is never a quiet one).
        const res = await loadScopeRows({
          sites: sites.map(s => ({ id: s.id, name: s.name, from: s.range.from, to: s.range.to, prevFrom: s.range.prevFrom, prevTo: s.range.prevTo })),
          fetchChecks: fetchClosedChecksRange, fetchTickets: fetchKDSTicketsRange, wantTickets,
          onProgress: (p) => { if (!stale) setLoadProgress(p); }, stop,
        });
        if (stale) return;
        if (res.fault) {
          console.error('[BOReports] fetch failed', res.error);
          setLoadFault(res.fault);
          nothing();
          setPrevLoaded(false);
        } else {
          if (res.kdsFault) { console.error('[BOReports] kitchen tickets failed', res.error); setKdsFault(res.kdsFault); }
          if (!res.prevLoaded) console.error('[BOReports] previous period not loaded', res.prevSkipped, res.error);
          setRangeChecks(res.checks);
          setPrevChecks (res.prevChecks);
          setKdsTickets (res.kdsTickets);
          setPrevLoaded(res.prevLoaded);
          // Only the signed in site alone is topped up as the clock moves (see liveOn).
          prevHeld.current = (homeOnly && res.prevLoaded) ? (res.prevHeld[homeId] || null) : null;
        }
      } catch (err) {
        if (stale) return;
        console.error('[BOReports] fetch failed', err);
        setLoadFault('failed');
        setRangeChecks([]); setPrevChecks([]); setKdsTickets([]); setPrevLoaded(false);
      }
      setLoadingRange(false);
    })();
    return () => { stale = true; };
    // `sites` follows loadKey and range; storeChecks is read once for the no site fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customRange.from, customRange.to, locationConfig, range, scopeReady, loadKey]);

  // Bring the previous period up to the comparison as it moves on (see `compare` above).
  // Only the extra minutes are read when just the end has moved, and a previous period
  // that failed to load is tried again in full. Quiet: no Loading state.
  // 5 Oct 2026: this read pages like every other one (it asked for 5,000 rows in one
  // request and PostgREST answers 1,000, so a retried month came back cut). It spends from
  // the same row budget as the first load: what this period already holds, plus the
  // previous rows that stay when only the extra minutes are added. Past the budget the too
  // long line shows, as it would have on the first load. A newer read stops this one.
  useEffect(() => {
    if (isMock || loadingRange || loadFault || !activeLocId || !compare) return;
    const need = prevTopUp(prevHeld.current, compare);
    if (!need) return;
    const seq  = ++prevSeq.current;
    const held = { from: compare.from.getTime(), to: compare.to.getTime() };
    const fail = () => { if (seq === prevSeq.current) { prevHeld.current = null; setPrevLoaded(false); } };
    const budget = rowBudget(CHECK_ROWS_ON_SCREEN);
    budget.used = (rangeChecks || []).length + (need.append ? (prevChecks || []).length : 0);
    fetchClosedChecksRange(activeLocId, new Date(need.from), new Date(need.to), { stop: () => seq !== prevSeq.current, budget }).then(res => {
      if (seq !== prevSeq.current) return;
      if (res.tooMany) {
        prevHeld.current = null;
        setLoadFault('too_long');
        setRangeChecks([]); setPrevChecks([]); setKdsTickets([]); setPrevLoaded(false);
        return;
      }
      if (res.error || !Array.isArray(res.data)) { fail(); return; }
      prevHeld.current = held;
      const rows = scope?.home ? tagRows(res.data, scope.home) : res.data;
      setPrevChecks(old => {
        if (!need.append) return rows;
        const ids = new Set((old || []).map(c => c.id));
        return [...rows.filter(c => !ids.has(c.id)), ...(old || [])];
      });
      setPrevLoaded(true);
    }).catch(fail);
    // rangeChecks and prevChecks are read for the budget only: a change in them must not
    // start another read (this effect sets prevChecks itself).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, activeLocId, loadingRange, loadFault]);

  // Merge in any live closed_checks that landed via realtime AFTER the initial
  // range fetch. Without this, a sale completed while the report is open never
  // appears unless the user changes the period chip. Dedup by id; rangeChecks
  // shape wins on conflict (it's the canonical Supabase row).
  // v5.5.279: Filter live store checks by activeLocId to prevent cross-location
  // bleed. When activeLocId is set, ONLY include storeChecks that explicitly
  // match — checks without a locationId are excluded (they're legacy or from
  // another location that didn't stamp them).
  const allChecksRaw = useMemo(() => {
    const base = rangeChecks || [];
    // 5 Oct 2026: only while the signed in site alone is on screen (liveOn). The store holds
    // that one site's sales; merged under another site's report they would be the wrong site's.
    if (!liveOn) return base;
    const live = (storeChecks || []).filter(c =>
      c.closedAt && new Date(c.closedAt) >= range.from && new Date(c.closedAt) <= range.to &&
      (!activeLocId || c.locationId === activeLocId)
    );
    if (!live.length) return base;
    const ids = new Set(base.map(c => c.id));
    const home = scope?.home || null;
    // Tagged like the loaded rows (a copy: the store's own objects are left alone).
    const extras = live.filter(c => !ids.has(c.id)).map(c => (home ? { ...c, siteId: home.id, siteName: home.name } : c));
    if (!extras.length) return base;
    return [...extras, ...base].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  }, [rangeChecks, storeChecks, range.from, range.to, activeLocId, liveOn, scope]);
  // v5.11.99 (Reports align, Peter 22 Oct: "leave demo days out"): the checks the demo files wrote
  // are left out of every sales report here by the one demo rule (_shared/demoHistory.js), the rule
  // Daily trading, Stock and GP, the Owner and Manager apps and Xero use. A real venue has none, so
  // the same array comes back and nothing on its screens changes.
  const demoCur  = useMemo(() => leaveOutDemo(allChecksRaw), [allChecksRaw]);
  const demoPrev = useMemo(() => leaveOutDemo(prevChecks || []), [prevChecks]);
  const allChecks = demoCur.rows;
  const allPrev   = demoPrev.rows;
  const demoNote  = demoCur.left + demoPrev.left > 0 || (!!daySums && sumsDemo);
  // What the chips are handed: the live comparison, or one marked "did not load".
  const shownCompare = useMemo(() => (compare ? (prevLoaded ? compare : notLoaded(compare)) : null), [compare, prevLoaded]);
  const trendRange   = useMemo(() => ({ ...range, compare: shownCompare }), [range, shownCompare]);

  // 16 Oct 2026: one filter object, also handed to the Business summary so the older sales it
  // reads for refunds made in the range are filtered the same way as the range's own checks.
  const reportFilters = useMemo(() => ({ server: serverFilter, orderType: orderTypeFilter, source: sourceFilter }), [serverFilter, orderTypeFilter, sourceFilter]);
  const filtered     = useMemo(() => applyFilters(allChecks, reportFilters), [allChecks, reportFilters]);
  const filteredPrev = useMemo(() => applyFilters(allPrev,   reportFilters), [allPrev,   reportFilters]);

  const servers    = useMemo(() => uniqueServers(allChecks),    [allChecks]);
  const orderTypes = useMemo(() => uniqueOrderTypes(allChecks), [allChecks]);
  const sources    = useMemo(() => uniqueSources(allChecks),    [allChecks]);

  const openOrders = useMemo(() => (
    Object.entries(activeSessions || {})
      .filter(([, s]) => s?.items?.length > 0)
      .map(([tableId, session]) => {
        const table = tables.find(t => t.id === tableId);
        const subtotal = session.items.reduce((s, i) => s + (i.price || 0) * (i.qty || 1), 0);
        return { tableId, tableLabel: table?.label || tableId, covers: session.covers || 1, itemCount: session.items.length, subtotal, openedAt: session.openedAt || null };
      })
      .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0))
  ), [activeSessions, tables]);

  const totalRevenue = useMemo(
    () => filtered.reduce((s, c) => s + (c.total || 0), 0),
    [filtered]
  );

  // Counts shown next to catalog links (e.g. "(3)" on Open orders)
  const catalogCounts = useMemo(() => ({
    open: openOrders.length || null,
  }), [openOrders]);

  // ── The Sites control ──────────────────────────────────────────────────────────────────
  // A new set of sites starts with the filters open: a server or a service from one site
  // means nothing at another.
  const pickSites = (ids) => {
    if (!scope) return;
    setTickedIds(ids); setOneSiteId(null);
    setServerFilter('all'); setOrderTypeFilter('all'); setSourceFilter('all');
    writeSiteChoice(browserStore(), choiceKey(scope.userId, scope.companyId), choiceFor(ids, scope.sites));
  };
  const pickOneSite = (id) => { setOneSiteId(id); setServerFilter('all'); setOrderTypeFilter('all'); setSourceFilter('all'); };
  // "Today's Lunch" belongs to the site it was picked at. On another site's clock and
  // services the period goes back to Today.
  useEffect(() => {
    if (!locationConfig || typeof period !== 'string' || !period.startsWith('service:')) return;
    if (!buildPeriods(locationConfig).some(p => p.id === period)) setPeriod('today');
  }, [locationConfig, period]);
  // Is the day sums function in the database yet? Asked once, and only for a login that has
  // more than one site (nobody else can use it), so a one site login makes no extra request.
  useEffect(() => {
    if (!scope?.hasChoice || !scope.home?.clockKnown || !homeConfig) return undefined;
    let alive = true;
    probeDaySums(scope.home, dayOfCheck(Date.now(), reportClock(homeConfig))).then(r => { if (alive) setDaySumsOn(r); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.hasChoice, scope?.homeId, homeConfig]);
  // What every report is handed on top of its own props (all optional to the report):
  //   scope    the report scope (src/lib/reportScope.js) with daySums.available filled in
  //   sites    the sites whose rows are in `checks`, each with its own `range`
  //   figures  'rows' (checks hold the rows) or 'sums' (checks are empty, read `daySums`)
  //   daySums  the server day sums for this period and its comparison, or null
  const siteProps = useMemo(() => ({
    scope: scope ? { ...scope, daySums: daySumsOn } : null, sites, figures: daySums ? 'sums' : 'rows', daySums,
  }), [scope, daySumsOn, sites, daySums]);
  const moneyTotals = useMemo(() => (
    sites.length > 1 && scope ? totalsByCurrency(filtered, scope) : null
  ), [sites, scope, filtered]);

  // ── Stock and GP: the link, the export, the share (v5.11.92, contract 2.3 and 4) ─────────────
  // A link (a "See the report" button or a share link) is applied once the stock scope is in: the
  // report, its sites (inside this login's scope: applyShareLink), period, compare, layout and options.
  useEffect(() => {
    if (!stockLink || !stockReady) return;
    if (isStockReportId(stockLink.report) && !STOCK_LATER[stockLink.report]) {
      setView(stockLink.report);
      setPeriod(STOCK_PERIODS.some((p) => p.id === stockLink.period) ? stockLink.period : 'this-week');
      setCustomRange(stockLink.custom?.from && stockLink.custom?.to ? { from: stockLink.custom.from, to: stockLink.custom.to } : { from: null, to: null });
      setCompareMode(stockLink.compare === 'last_year' ? 'last_year' : 'prev');
      setLayout(stockLink.layout === 'total' ? 'total' : 'side');
      setStockTicked(applyShareLink(stockLink, stock, stock.homeSite));
      const opts = { ...(stockLink.opts && typeof stockLink.opts === 'object' ? stockLink.opts : {}), ...(stockLink.at ? { at: stockLink.at } : {}) };
      setStockOpts(Object.keys(opts).length ? opts : null);
    }
    onLinkUsed?.();
    // The link is applied once, as it arrives; the scope and the callback are read then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockLink, stockReady]);
  const toast = (words, kind = 'success') => { try { showToast?.(words, kind); } catch { /* a toast never breaks a report */ } };
  // Export all rows as a file: the database builds it in the background (stock_report_export_start),
  // ExportStatus follows it. reportName is the function name ('gap'); the screen may pass its own.
  const startExport = async (reportName = null, args = null) => {
    const fn = reportName || reportFnOf(view);
    if (!fn || !EXPORTABLE_REPORTS.includes(fn)) { toast('That report cannot be exported.', 'error'); return; }
    if (!stockScope || !stockRange) return;
    const callArgs = args || {
      org: stock.orgId, sites: stockScope.tickedIds, from: stockRange.fromDay, to: stockRange.toDay,
      opts: { ...(stockOpts || {}), between_counts: !!stockRange.betweenCounts },
    };
    const r = await stockReportsApi.exportStart(fn, callArgs);
    if (r.error) { toast(r.error.message || 'The export did not start.', 'error'); return; }
    if (r.data?.job_id) { setExportJob({ id: r.data.job_id, report: fn, label: REPORT_INDEX[view]?.label || view, from: callArgs.from, to: callArgs.to }); toast('Building your file. It shows here when it is ready.', 'info'); }
  };
  // A share link keeps the sites (by id), period, compare, layout, the stock value date and the
  // report's options: never a site name, never a figure.
  const shareLink = (opts = null) => {
    if (!stockScope) return;
    const group = tickedGroup(stockScope);
    const sitesPart = stockScope.allTicked ? { kind: 'all' } : group ? { kind: 'group', id: group.id } : { kind: 'sites', ids: stockScope.tickedIds };
    // Only a plain options object is kept: a Share button hands its click event here, never options.
    const plain = !!opts && typeof opts === 'object' && Object.getPrototypeOf(opts) === Object.prototype;
    const o = { ...(stockOpts || {}), ...(plain ? opts : {}) };
    const { at = null, ...rest } = o;
    const link = writeShareLink({ report: view, sites: sitesPart, period, custom: customRange, compare: compareMode, layout, at, opts: rest });
    if (!link) return;
    const url = `${window.location.origin}${window.location.pathname}${link}`;
    const done = () => toast('Link copied. It keeps the sites, period, compare and layout.');
    const failed = () => toast('Could not copy the link. Copy it from the address bar instead.', 'error');
    try { navigator.clipboard.writeText(url).then(done, failed); } catch { failed(); }
  };
  // A report screen runs its own export (useExportFlow: the CSV at once, or its own background job and
  // panel) and then tells the shell what it did ({ report, args, mode: 'now' | 'file', jobId }). The
  // shell starts nothing more for that (no second job); only the header button starts one itself.
  const exportDone = (info) => {
    if (info && typeof info === 'object' && (info.mode === 'now' || info.mode === 'file')) return;
    if (typeof info === 'string') startExport(info);
  };
  const stockProps = useMemo(() => ({
    orgId: stock.orgId,
    sites: stockSites,
    siteById: stock.siteById,
    groups: stockScope ? stockScope.groups : [],
    range: stockRange ? { fromDay: stockRange.fromDay, toDay: stockRange.toDay, betweenCounts: !!stockRange.betweenCounts } : null,
    compare: stockCompare ? { from: stockCompare.fromDay, to: stockCompare.toDay, label: stockCompare.label, detail: stockCompare.detail, nothing: stockCompare.nothing, mode: compareMode } : null,
    layout,
    level: stock.level,
    canFix: stock.level === 'all',
    initialOpts: stockOpts,
    onOpenReport: openStockView,
    onSites: pickStockSites,
    onExport: exportDone,
    onShare: shareLink,
    api: stockReportsApi,
    // the callbacks close over this render's state on purpose: they read the latest filters when pressed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [stock.orgId, stock.siteById, stock.level, stockSites, stockScope, stockRange, stockCompare, compareMode, layout, stockOpts]);

  const current = REPORT_INDEX[view];
  const categoryForView = current ? CATEGORIES.find(c => c.id === current.category) : null;
  const needsCustomPick = period === 'custom' && (!customRange.from || !customRange.to);

  // Catalog view
  if (view === 'catalog') {
    return (
      <div style={{ flex:1, minHeight:0, display:'flex', overflow:'hidden' }}>
        <Catalog onOpen={openReport} counts={catalogCounts} canOpen={canOpen}/>
      </div>
    );
  }

  // v5.11.92: from a stock report, back goes to the dashboard this shell opened on; from the dashboard
  // (or any report opened from the catalog) back goes to the catalog.
  const backView = isStock && view !== 'stock_home' && STOCK_VIEWS(initialView) ? 'stock_home' : 'catalog';
  const periodPills = isStock ? buildStockPeriods(locationConfig) : buildPeriods(locationConfig);
  const shownRange = isStock && stockRange ? stockRange : range;
  const periodWords = isStock && period === 'between-counts' ? 'each site between its last two full counts' : periodLabel(period, customRange, shownRange);
  const stockLater = isStock && STOCK_LATER[view] ? LATER_WORDS[STOCK_LATER[view]] : null;

  // Detail view (filter row + the selected report)
  return (
    <div style={{ padding:'20px 24px', maxWidth: isStock ? 1400 : 1100, flex:1, overflow:'auto', minHeight:0, width:'100%', boxSizing:'border-box' }}>
      {/* Breadcrumb + back */}
      <button onClick={() => setView(backView)} style={{
        border:'none', background:'transparent', cursor:'pointer', fontFamily:'inherit',
        color:'var(--t3)', fontSize:12, padding:0, marginBottom:10,
      }}>{backView === 'stock_home' ? '← Back to the dashboard' : '← Back to reports'}</button>
      <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:700, display:'flex', alignItems:'center', gap:6 }}>
            {categoryForView && <><span>{categoryForView.icon}</span><span>{categoryForView.label}</span><span style={{ color:'var(--t4)' }}>/</span></>}
            <span>{current?.label || view}</span>
          </div>
          <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', marginTop:2, letterSpacing:'-.01em' }}>
            {periodPills.find(p => p.id === period)?.label}
            <span style={{ color:'var(--t4)', fontWeight:400, fontSize:14, marginLeft:10 }}>{periodWords}</span>
          </div>
          {isStock ? (
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }} data-testid="stock-shell-line">
              {stockScope ? stockSitesLabel(stockScope) : 'Sites'} · each venue on its own business day{stockCompare ? ` · compared with ${stockCompare.label.replace(/^vs /, '')}` : ''}
            </div>
          ) : (
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, visibility: (viewSites.mode === 'all' && scope?.hasChoice) || daySums || capLine ? 'hidden' : 'visible' }}>
              {filtered.length} checks · {moneyTotals && (moneyTotals.length > 1 || moneyTotals.some(t => !t.currency))
                ? totalsWords(moneyTotals, scope, money)
                : fmt(totalRevenue)} revenue
              {(serverFilter !== 'all' || orderTypeFilter !== 'all' || sourceFilter !== 'all') && (
                <span style={{ color:'var(--acc)', marginLeft:6 }}>· filtered</span>
              )}
            </div>
          )}
        </div>
        {isStock && (
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <SegToggle value={layout} onChange={setLayout} options={LAYOUTS}/>
          </div>
        )}
      </div>

      {/* Filter row */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ display:'flex', gap:4, background:'var(--bg3)', padding:3, borderRadius:10, flexWrap:'wrap' }}>
          {periodPills.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)} style={{
              padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', border:'none',
              background: period === p.id ? 'var(--bg1)' : 'transparent',
              color:      period === p.id ? 'var(--t1)'  : 'var(--t3)',
              fontSize:12, fontWeight: period === p.id ? 700 : 400,
              boxShadow:  period === p.id ? '0 1px 3px rgba(0,0,0,.15)' : 'none',
            }}>{p.label}</button>
          ))}
        </div>
        {/* 5 Oct 2026: which sites. Hidden for a login with one site. v5.11.92: a stock view's sites
            are the stock scope's, with the site groups and the closed sites on request. */}
        {isStock ? (
          <SitesControl scope={stockScope} groups={stockScope?.groups || []} closedSites={stockScope?.closedSites || []}
            showClosed={stockShowClosed} onShowClosed={setStockShowClosed}
            onGroup={(id) => { const g = (stockScope?.groups || []).find(x => x.id === id); if (g) pickStockSites(g.locationIds); }}
            onToggle={(id) => pickStockSites(toggleTicked(stockScope.tickedIds, id, stockScope.sites))}
            onAll={() => pickStockSites(stockScope.sites.map(s => s.id))}
            onOnlyHome={() => pickStockSites(stockScope.homeId && stockScope.sites.some(s => s.id === stockScope.homeId) ? [stockScope.homeId] : [stockScope.sites[0]?.id].filter(Boolean))}/>
        ) : (
          <SitesControl scope={scope} disabled={viewSites.mode === 'all'}
            onToggle={(id) => pickSites(toggleTicked(scope.tickedIds, id, scope.sites))}
            onAll={() => pickSites(scope.sites.map(s => s.id))}
            onOnlyHome={() => pickSites([scope.homeId])}/>
        )}
        {period === 'custom' && (
          <>
            <input type="date" value={customRange.from || ''} onChange={e => setCustomRange(r => ({ ...r, from: e.target.value }))} style={inputSt}/>
            <span style={{ color:'var(--t4)' }}>→</span>
            <input type="date" value={customRange.to   || ''} onChange={e => setCustomRange(r => ({ ...r, to:   e.target.value }))} style={inputSt}/>
          </>
        )}
        {isStock && (
          <select value={compareMode} onChange={e => setCompareMode(e.target.value)} style={selectSt} aria-label="Compare with">
            {COMPARE_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        {!isStock && servers.length > 1 && (
          <select value={serverFilter} onChange={e => setServerFilter(e.target.value)} style={selectSt}>
            <option value="all">All servers</option>
            {servers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {!isStock && orderTypes.length > 1 && (
          <select value={orderTypeFilter} onChange={e => setOrderTypeFilter(e.target.value)} style={selectSt}>
            <option value="all">All order types</option>
            {orderTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {/* v5.5.140: order source filter — POS / Kiosk / Online / QR.
            Hidden when only one source is present so the filter row stays tidy
            for venues that haven't enabled multi-channel ordering yet. */}
        {!isStock && sources.length > 1 && (
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectSt}>
            <option value="all">All sources</option>
            {sources.map(s => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
          </select>
        )}
      </div>

      {!isStock && <SiteNote note={viewSites.note} choices={viewSites.choices} value={viewSites.sites[0]?.id} onPick={pickOneSite}/>}
      {isStock && exportJob && <ExportStatus api={stockReportsApi} jobId={exportJob.id} label={exportJob.label} report={exportJob.report} from={exportJob.from} to={exportJob.to} onClose={() => setExportJob(null)}/>}

      {needsCustomPick ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>
          Pick a start and end date to load the custom range.
        </div>
      ) : isStock ? (
        !stock.ready || !locationConfig ? (
          <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>Loading…</div>
        ) : !stockReady ? (
          <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t2)', fontSize:14 }}>Stock and GP is for a company with two or more sites. Inventory &gt; Reports has this venue's stock reports.</div>
        ) : stockLater ? (
          <LaterTile words={stockLater} title={current?.label || view}/>
        ) : (
          <>
            {view === 'stock_home' && <StockDashboard {...stockProps}/>}
            {view === 'stock_value' && <StockValue {...stockProps}/>}
            {view === 'stock_movement' && <StockMovement {...stockProps}/>}
            {view === 'stock_gap' && <StockGap {...stockProps}/>}
            {view === 'stock_cogs' && <StockCogs {...stockProps}/>}
            {view === 'stock_product_gp' && <StockProductGP {...stockProps}/>}
            {view === 'stock_waste' && <StockWaste {...stockProps}/>}
            {view === 'stock_purchases' && <StockPurchases {...stockProps}/>}
            {view === 'stock_prices' && <StockPrices {...stockProps}/>}
            {view === 'stock_off_contract' && <StockOffContract {...stockProps}/>}
            {view === 'stock_budget' && <StockBudget {...stockProps}/>}
            {view === 'stock_transfers' && <StockTransfersReport {...stockProps}/>}
            {view === 'stock_count_compliance' && <StockCountCompliance {...stockProps}/>}
            {view === 'stock_days_on_hand' && <StockDaysOnHand {...stockProps}/>}
            {view === 'stock_par' && <StockPar {...stockProps}/>}
            {view === 'stock_key_ratios' && <StockKeyRatios {...stockProps}/>}
            {view === 'stock_setup_health' && <StockSetupHealth {...stockProps}/>}
            {view === 'stock_batches' && <StockBatches {...stockProps}/>}
            {view === 'stock_recipe_cost' && <StockRecipeCost {...stockProps}/>}
            {view === 'stock_allergens' && <StockAllergens {...stockProps}/>}
            {view === 'stock_month_end' && <StockMonthEnd {...stockProps}/>}
          </>
        )
      ) : (loadingRange || !locationConfig || !scopeReady) ? (
        /* 6 Oct 2026 (review): the scope wait is loading too. The read does not start until the
           scope is in (up to its 6 second fallback), and until then the rows are null: without
           this line a report painted "0 checks, no sales in this period" as a finished answer,
           then jumped to the real figures. A stale or unfinished read must never read as a
           quiet period (and the overview must never mount without its scope). */
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>{loadingRange ? loadingText(loadProgress) : 'Loading…'}</div>
      ) : capLine ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t2)', fontSize:14 }}>{capLine}</div>
      ) : faultFor(view, loadFault, kdsFault) ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t2)', fontSize:14 }}>
          {faultFor(view, loadFault, kdsFault) === 'too_long' ? TOO_LONG_TEXT : 'This report could not be loaded. Check the connection and choose the period again.'}
        </div>
      ) : (
        <>
          {demoNote && <div style={{ fontSize:11, color:'var(--t4)', margin:'0 0 8px' }}>{DEMO_NOTE}</div>}
          {view === 'summary'    && <SalesSummary checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} onOpenReport={openReport} rangeFrom={range.from} rangeTo={range.to} locationId={activeLocId} filters={reportFilters} {...siteProps}/>}
          {view === 'sales_mix'  && <SalesMix     checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} range={trendRange} canOpen={canOpen} {...siteProps}/>}
          {view === 'exceptions' && <Exceptions   checks={filtered} fmt={fmt} {...siteProps}/>}
          {view === 'payments'   && <Payments     checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'daypart'    && <Daypart      checks={filtered} fmt={fmt} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'shifts'      && <Shifts       checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'payroll'     && <PayrollReport fmt={fmt} {...siteProps}/>}
          {view === 'items'       && <ProductMix   checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'item_trend'  && <ItemTrend    checks={filtered} fmt={fmt} fmtN={fmtN} range={range} {...siteProps}/>}
          {view === 'daily_trend' && <DailyTrend   checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} range={trendRange} locationId={activeLocId} {...siteProps}/>}
          {view === 'daily_trading' && <DailyTrading fromDay={range.fromDay} toDay={range.toDay} fmt={fmt} {...siteProps}/>}
          {view === 'menu_eng'    && <MenuEngineering checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'servers'     && <Servers      checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'tips'        && <Tips         checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'order_types' && <OrderTypes   checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'order_sources' && <OrderSources checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'tables'      && <Tables       checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'bookings'    && <BookingsReport fromDay={range.fromDay} toDay={range.toDay} range={range} locationConfig={locationConfig} fmtN={fmtN} {...siteProps}/>}
          {view === 'booking_payments' && <BookingPaymentsReport range={range} fmtN={fmtN} {...siteProps}/>}
          {view === 'kds_perf'    && <KDSPerformance kdsTickets={kdsTickets || []} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'zreport'     && <ZReport      checks={filtered} periodLabelText={periodLabel(period, customRange, range)} rangeFrom={range.from} rangeTo={range.to} timeZone={range.timeZone} fmt={fmt} fmtN={fmtN} locationId={activeLocId} filters={reportFilters} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'tax'        && <Tax          checks={filtered} fmt={fmt} fmtN={fmtN} rangeFrom={range.from} rangeTo={range.to} locationId={activeLocId} {...siteProps}/>}
          {view === 'location_compare' && <LocationCompare range={range} period={period} periodLabelText={periodLabel(period, customRange, range)} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'cash_drawer' && <CashDrawer   fromMs={range.from} toMs={range.to} {...siteProps}/>}
          {view === 'transactions' && <Transactions checks={filtered} fmt={fmt} {...siteProps}/>}
          {view === 'open'       && <LegacyOpen   openOrders={openOrders} fmt={fmt} {...siteProps}/>}
          {view.startsWith('loyalty_') && <LoyaltyReport rangeFrom={range.from} rangeTo={range.to} initialTab={view.replace('loyalty_', '')} {...siteProps}/>}
        </>
      )}
    </div>
  );
}

const selectSt = { padding:'6px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, cursor:'pointer', fontFamily:'inherit' };
const inputSt  = { padding:'5px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:12, fontFamily:'inherit' };

function LegacyOpen({ openOrders, fmt }) {
  if (openOrders.length === 0) {
    return (
      <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>
        <div style={{ fontSize:36, marginBottom:10 }}>⬚</div>
        No open orders right now
      </div>
    );
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {openOrders.map(o => (
        <div key={o.tableId} style={{ display:'flex', alignItems:'center', gap:16, padding:'12px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 }}>
          <div style={{ width:40, height:40, borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800, fontSize:13, color:'var(--acc)', flexShrink:0 }}>{o.tableLabel}</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Table {o.tableLabel}</div>
            <div style={{ fontSize:11, color:'var(--t4)' }}>{o.itemCount} item{o.itemCount !== 1 ? 's' : ''} · {o.covers} cover{o.covers !== 1 ? 's' : ''}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{fmt(o.subtotal)}</div>
            <div style={{ fontSize:10, color:'var(--t4)' }}>not yet paid</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop:8, padding:'10px 14px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)', fontSize:12, color:'var(--t4)' }}>
        ⓘ Open orders are excluded from revenue figures until payment is taken.
      </div>
    </div>
  );
}
