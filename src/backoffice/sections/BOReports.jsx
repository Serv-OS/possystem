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

import { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { fetchClosedChecksRange, fetchKDSTicketsRange } from '../../lib/db';
import { loadingText, TOO_LONG_TEXT, rowBudget, CHECK_ROWS_ON_SCREEN } from '../../lib/pagedRead';
import { buildPeriods, getPeriodRange, periodLabel, applyFilters, uniqueServers, uniqueOrderTypes, uniqueSources, SOURCE_LABEL, dayOfCheck, reportClock } from './reports/_filters';
import {
  buildReportScope, connectedSites, sitesForView, siteRange, itemCapLine, figuresFrom, totalsByCurrency, totalsWords,
  choiceKey, readSiteChoice, writeSiteChoice, resolveTicked, toggleTicked, choiceFor,
} from '../../lib/reportScope.js';
import { loadScopeRows, loadScopeDaySums, tagRows } from '../../lib/reportScopeLoad.js';
import { fetchReportScopeData, probeDaySums } from '../../lib/reportSites.js';
import { loadReportDaySums } from '../../lib/reportDaySums.js';
import SitesControl, { SiteNote } from './reports/SitesControl';
import { getLocationConfig } from '../../lib/locationTime';
import { compareRange, compareMoves, prevTopUp, notLoaded, COMPARE_STEP_MS } from '../../lib/reportCompare.js';
import Catalog, { CATEGORIES, REPORT_INDEX } from './reports/Catalog';
import SalesSummary from './reports/SalesSummary';
import Exceptions   from './reports/Exceptions';
import Payments     from './reports/Payments';
import Daypart      from './reports/Daypart';
import Shifts       from './reports/Shifts';
import ProductMix   from './reports/ProductMix';
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
import Transactions  from './Transactions';
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

// 5 Oct 2026: which fault, if any, blanks this report. The reports below read their own data
// (their own loaders, not the shell's closed checks), so a period too long for the shell does
// not take them down; Kitchen performance stands on the ticket read, and (6 Oct 2026 review)
// on the checks read when THAT is what stopped everything: the tickets are halted with the
// checks, so an empty ticket list then is not "no kitchen tickets", it is the same fault.
const OWN_DATA_VIEWS = new Set(['payroll', 'daily_trading', 'bookings', 'location_compare', 'cash_drawer', 'open']);
function faultFor(view, loadFault, kdsFault) {
  if (OWN_DATA_VIEWS.has(view) || view.startsWith('loyalty_')) return null;
  if (view === 'kds_perf') return kdsFault || loadFault || null;
  return loadFault || null;
}

export default function BOReports({ setSection } = {}) {
  const { tables, taxRates, closedChecks: storeChecks } = useStore();

  const [view, setView]               = useState('catalog'); // 'catalog' or a report id
  const [period, setPeriod]           = useState('today');
  const [customRange, setCustomRange] = useState({ from: null, to: null });
  const [homeConfig, setHomeConfig] = useState(null);  // v4.6.24: the signed in site's config
  const [serverFilter, setServerFilter]       = useState('all');
  const [orderTypeFilter, setOrderTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter]       = useState('all'); // v5.5.140: pos / kiosk / online / qr

  // Opening a catalog tile: most reports render in-shell (setView), but some tiles
  // point at full Back Office sections that live in their own group (e.g. Inventory
  // reports, Marketing report). Those carry a `section` and navigate there instead —
  // single source of truth, nothing duplicated or embedded.
  const openReport = (r) => {
    if (r && typeof r === 'object' && r.section) {
      if (setSection) setSection(r.section);
      return;
    }
    setView(typeof r === 'string' ? r : r?.id);
  };

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

  // builtAt = the moment this range (and the comparison inside it) was worked out.
  const range = useMemo(() => {
    const builtAt = Date.now();
    return { ...getPeriodRange(period, customRange, locationConfig, builtAt), builtAt };
  }, [period, customRange, locationConfig]);

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
  // change alone (same sites, same way) does not read again, as before.
  const loadKey = `${homeId || ''}|${shellSites.map(s => s.id).join(',')}|${capLine ? 'cap' : figures}|${wantTickets ? 'k' : ''}`;

  useEffect(() => {
    prevSeq.current += 1; prevHeld.current = null;
    setDaySums(null);
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
            setDaySums(sums); nothing(); setPrevLoaded(!!sums.previous); setLoadingRange(false); return;
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
  const allChecks = useMemo(() => {
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
  const allPrev   = prevChecks  || [];
  // What the chips are handed: the live comparison, or one marked "did not load".
  const shownCompare = useMemo(() => (compare ? (prevLoaded ? compare : notLoaded(compare)) : null), [compare, prevLoaded]);
  const trendRange   = useMemo(() => ({ ...range, compare: shownCompare }), [range, shownCompare]);

  const filtered     = useMemo(() => applyFilters(allChecks, { server: serverFilter, orderType: orderTypeFilter, source: sourceFilter }), [allChecks, serverFilter, orderTypeFilter, sourceFilter]);
  const filteredPrev = useMemo(() => applyFilters(allPrev,   { server: serverFilter, orderType: orderTypeFilter, source: sourceFilter }), [allPrev,   serverFilter, orderTypeFilter, sourceFilter]);

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

  const current = REPORT_INDEX[view];
  const categoryForView = current ? CATEGORIES.find(c => c.id === current.category) : null;
  const needsCustomPick = period === 'custom' && (!customRange.from || !customRange.to);

  // Catalog view
  if (view === 'catalog') {
    return (
      <div style={{ flex:1, minHeight:0, display:'flex', overflow:'hidden' }}>
        <Catalog onOpen={openReport} counts={catalogCounts}/>
      </div>
    );
  }

  // Detail view (filter row + the selected report)
  return (
    <div style={{ padding:'20px 24px', maxWidth:1100, flex:1, overflow:'auto', minHeight:0, width:'100%', boxSizing:'border-box' }}>
      {/* Breadcrumb + back */}
      <button onClick={() => setView('catalog')} style={{
        border:'none', background:'transparent', cursor:'pointer', fontFamily:'inherit',
        color:'var(--t3)', fontSize:12, padding:0, marginBottom:10,
      }}>← Back to reports</button>
      <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:12 }}>
        <div>
          <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:700, display:'flex', alignItems:'center', gap:6 }}>
            {categoryForView && <><span>{categoryForView.icon}</span><span>{categoryForView.label}</span><span style={{ color:'var(--t4)' }}>/</span></>}
            <span>{current?.label || view}</span>
          </div>
          <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', marginTop:2, letterSpacing:'-.01em' }}>
            {buildPeriods(locationConfig).find(p => p.id === period)?.label}
            <span style={{ color:'var(--t4)', fontWeight:400, fontSize:14, marginLeft:10 }}>{periodLabel(period, customRange, range)}</span>
          </div>
          <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, visibility: (viewSites.mode === 'all' && scope?.hasChoice) || daySums || capLine ? 'hidden' : 'visible' }}>
            {filtered.length} checks · {moneyTotals && (moneyTotals.length > 1 || moneyTotals.some(t => !t.currency))
              ? totalsWords(moneyTotals, scope, money)
              : fmt(totalRevenue)} revenue
            {(serverFilter !== 'all' || orderTypeFilter !== 'all' || sourceFilter !== 'all') && (
              <span style={{ color:'var(--acc)', marginLeft:6 }}>· filtered</span>
            )}
          </div>
        </div>
      </div>

      {/* Filter row */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ display:'flex', gap:4, background:'var(--bg3)', padding:3, borderRadius:10, flexWrap:'wrap' }}>
          {buildPeriods(locationConfig).map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)} style={{
              padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', border:'none',
              background: period === p.id ? 'var(--bg1)' : 'transparent',
              color:      period === p.id ? 'var(--t1)'  : 'var(--t3)',
              fontSize:12, fontWeight: period === p.id ? 700 : 400,
              boxShadow:  period === p.id ? '0 1px 3px rgba(0,0,0,.15)' : 'none',
            }}>{p.label}</button>
          ))}
        </div>
        {/* 5 Oct 2026: which sites. Hidden for a login with one site. */}
        <SitesControl scope={scope} disabled={viewSites.mode === 'all'}
          onToggle={(id) => pickSites(toggleTicked(scope.tickedIds, id, scope.sites))}
          onAll={() => pickSites(scope.sites.map(s => s.id))}
          onOnlyHome={() => pickSites([scope.homeId])}/>
        {period === 'custom' && (
          <>
            <input type="date" value={customRange.from || ''} onChange={e => setCustomRange(r => ({ ...r, from: e.target.value }))} style={inputSt}/>
            <span style={{ color:'var(--t4)' }}>→</span>
            <input type="date" value={customRange.to   || ''} onChange={e => setCustomRange(r => ({ ...r, to:   e.target.value }))} style={inputSt}/>
          </>
        )}
        {servers.length > 1 && (
          <select value={serverFilter} onChange={e => setServerFilter(e.target.value)} style={selectSt}>
            <option value="all">All servers</option>
            {servers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {orderTypes.length > 1 && (
          <select value={orderTypeFilter} onChange={e => setOrderTypeFilter(e.target.value)} style={selectSt}>
            <option value="all">All order types</option>
            {orderTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {/* v5.5.140: order source filter — POS / Kiosk / Online / QR.
            Hidden when only one source is present so the filter row stays tidy
            for venues that haven't enabled multi-channel ordering yet. */}
        {sources.length > 1 && (
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectSt}>
            <option value="all">All sources</option>
            {sources.map(s => <option key={s} value={s}>{SOURCE_LABEL[s] || s}</option>)}
          </select>
        )}
      </div>

      <SiteNote note={viewSites.note} choices={viewSites.choices} value={viewSites.sites[0]?.id} onPick={pickOneSite}/>

      {needsCustomPick ? (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)', fontSize:13 }}>
          Pick a start and end date to load the custom range.
        </div>
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
          {view === 'summary'    && <SalesSummary checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'exceptions' && <Exceptions   checks={filtered} fmt={fmt} {...siteProps}/>}
          {view === 'payments'   && <Payments     checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'daypart'    && <Daypart      checks={filtered} fmt={fmt} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'shifts'      && <Shifts       checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'payroll'     && <PayrollReport fmt={fmt} {...siteProps}/>}
          {view === 'items'       && <ProductMix   checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'item_trend'  && <ItemTrend    checks={filtered} fmt={fmt} fmtN={fmtN} range={range} {...siteProps}/>}
          {view === 'daily_trend' && <DailyTrend   checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} range={trendRange} {...siteProps}/>}
          {view === 'daily_trading' && <DailyTrading fromDay={range.fromDay} toDay={range.toDay} fmt={fmt} {...siteProps}/>}
          {view === 'menu_eng'    && <MenuEngineering checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'servers'     && <Servers      checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'tips'        && <Tips         checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'order_types' && <OrderTypes   checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'order_sources' && <OrderSources checks={filtered} prevChecks={filteredPrev} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} compare={shownCompare} {...siteProps}/>}
          {view === 'tables'      && <Tables       checks={filtered} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
          {view === 'bookings'    && <BookingsReport fromDay={range.fromDay} toDay={range.toDay} locationConfig={locationConfig} fmtN={fmtN} {...siteProps}/>}
          {view === 'kds_perf'    && <KDSPerformance kdsTickets={kdsTickets || []} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} {...siteProps}/>}
          {view === 'zreport'     && <ZReport      checks={filtered} periodLabelText={periodLabel(period, customRange, range)} rangeFrom={range.from} rangeTo={range.to} timeZone={range.timeZone} fmt={fmt} fmtN={fmtN} {...siteProps}/>}
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
const tileSt   = { padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12 };
const lblSt    = { fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 };

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