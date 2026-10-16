// Bookings report — Back Office → Reports → Order reports → Bookings.
//
// Self-fetching module (same pattern as CashDrawer / LoyaltyReport): the hub
// passes the period's venue business days (fromDay/toDay), this module resolves the location itself and
// loads camelCase booking rows via loadBookingsRange (table-absent-safe — a
// venue without migration 20260811b just sees the empty state).
//
// Content: KPI band (bookings / covers / no-show / cancellation / widget share /
// package attach) → covers-by-day bars → status breakdown → by-source table →
// peak-times bar list → bookings table (≤200 rows, newest first) + CSV export.
//
// 16 Oct 2026 (bookings audit section 3 item 10): multi site (every ticked site read over its
// own range, a Site column in the table and the CSV), covers by service, money from bookings
// (prepay, deposits and no show charges actually taken, from booking_payments; a saved card is
// counted, never added as money), lead sources with their no show rate and money, and rates that
// leave out bookings that never were (expired unpaid, still paying). The sums are pure and tested
// in lib/bookings/bookingReports.js.

import { useEffect, useState, useMemo } from 'react';
import { useStore } from '../../../store';
import { getLocationId } from '../../../lib/supabase';
import { loadBookingsRange } from '../../../lib/bookings/bookingsData';
import { loadPaymentsForBookings, loadTableLabels } from '../../../lib/bookings/bookingMoneyData.js';
import { bookingsReport, moneyByBooking, serviceFor } from '../../../lib/bookings/bookingReports.js';
import { withSiteColumn } from '../../../lib/reportSplit.js';
import { moneyMinor } from '../../../lib/currency';
import { faultText } from '../../../lib/pagedRead';
import { StatTile, ExportBtn, EmptyState, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { reportClock, dayOfCheck, rangeDays, weekdayOf } from './_filters';
import { bookingSites } from './_bookingSites.js';

const STATUS_META = {
  confirmed: { label:'Confirmed', bg:'var(--acc-d)',                 color:'var(--acc)' },
  prepaid:   { label:'Prepaid',   bg:'var(--grn-d)',                 color:'var(--grn)' },
  due:       { label:'Due',       bg:'var(--bg3)',                   color:'var(--t3)' },
  late:      { label:'Late',      bg:'rgba(232,160,32,.12)',         color:'var(--amb,#e8a020)' },
  dining:    { label:'Dining',    bg:'var(--grn-d)',                 color:'var(--grn)' },
  departed:  { label:'Departed',  bg:'var(--bg3)',                   color:'var(--t3)' },
  cancelled: { label:'Cancelled', bg:'var(--red-d)',                 color:'var(--red)' },
  no_show:   { label:'No-show',   bg:'var(--red-d)',                 color:'var(--red)' },
  // 16 Oct 2026: never a real booking (the guest never paid, or is still paying).
  expired:         { label:'Unpaid, expired',  bg:'var(--bg3)',           color:'var(--t4)' },
  pending_payment: { label:'Awaiting payment', bg:'rgba(232,160,32,.12)', color:'var(--amb,#e8a020)' },
};

const SOURCE_LABELS = {
  host:    '🧑‍💼 Host stand',
  phone:   '📞 Phone',
  widget:  '🌐 Web widget',
  walk_in: '🚶 Walk-in',
  events:  '🎉 Events',
  pos:     '🧾 POS',
  online:  '🌐 Web widget',
  email:   '✉️ Email',
  social:  '📣 Social',
  other:   'Other',
};


const fmtDateShort = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
};

// fromDay/toDay are the venue business days of the period (getPeriodRange), never the
// range's instants read on the browser's clock (v5.10.2). locationConfig gives the venue's
// clock for the chart's "today" (v5.11.1).
// 16 Oct 2026: sites (the shell's ticked sites, each with its own range) makes it multi site;
// without them the signed in site is read over fromDay..toDay, as before.
export default function BookingsReport({ fromDay, toDay, locationConfig, range = null, sites = [], fmtN = (n) => (n || 0).toLocaleString() }) {
  const floorTables = useStore(s => s.tables) || [];
  const packages = useStore(s => s.packages) || [];
  const [homeId, setHomeId] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!sites?.length) getLocationId().then((id) => { if (alive) setHomeId(id || null); }).catch(() => {});
    return () => { alive = false; };
  }, [sites?.length]);
  const fallbackRange = useMemo(() => (range || (fromDay && toDay ? { fromDay, toDay } : null)), [range, fromDay, toDay]);
  const readSites = useMemo(() => {
    const list = bookingSites({ sites, homeId, range: fallbackRange });
    // One site read over the shell's days (fromDay..toDay): the days are what this report keys on.
    return list.map((s) => ({ ...s, range: { ...s.range, fromDay: s.range?.fromDay || fromDay, toDay: s.range?.toDay || toDay } }));
  }, [sites, homeId, fallbackRange, fromDay, toDay]);
  const siteKey = readSites.map((s) => `${s.id}:${s.range.fromDay}:${s.range.toDay}`).join('|');
  const multi = readSites.length > 1;

  // { key, bookings, payments, labels, fault }: an older period's answer never paints over a newer one.
  // payments null = the ledger could not be read (money then says so, never 0).
  const [state, setState] = useState({ key: null, bookings: null, payments: null, labels: new Map(), fault: null });
  useEffect(() => {
    if (!readSites.length) return undefined;
    let alive = true;
    (async () => {
      const all = [];
      let payments = [];
      const labels = new Map();
      let fault = null;
      for (const site of readSites) {
        const { data, error, tooMany } = await loadBookingsRange(site.id, site.range.fromDay, site.range.toDay);
        if (error) { fault = tooMany ? 'too_long' : 'failed'; break; }
        const rows = (data || []).map((b) => ({ ...b, siteId: site.id, siteName: site.name, siteCurrency: site.currency || null, siteShifts: site.shifts || null }));
        all.push(...rows);
        const [pay, lab] = await Promise.all([loadPaymentsForBookings(rows.map((b) => b.id)), loadTableLabels(site.id)]);
        if (pay.error) { console.warn('[BookingsReport] payments read failed, money not shown:', pay.error.message || pay.error); payments = null; }
        else if (payments) payments.push(...(pay.data || []));
        for (const [k, v] of lab) labels.set(`${site.id}|${k}`, v);
      }
      if (!alive) return;
      setState({ key: siteKey, bookings: fault ? [] : all, payments: fault ? [] : payments, labels, fault });
    })().catch((err) => {
      console.warn('[BookingsReport] load failed:', err?.message || err);
      if (alive) setState({ key: siteKey, bookings: [], payments: [], labels: new Map(), fault: 'failed' });
    });
    return () => { alive = false; };
  // siteKey names everything the read depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  const ready = state.key === siteKey && state.bookings !== null;
  const loading = !readSites.length || !ready;
  const fault = ready ? state.fault : null;
  const rows = useMemo(() => (ready ? state.bookings : []), [ready, state.bookings]);
  const payments = ready ? state.payments : null;

  const tableLabel = (b, id) => state.labels.get(`${b.siteId}|${id}`) || floorTables.find(t => t.id === id)?.label || id;
  const shiftsOf = (b) => b.siteShifts || locationConfig?.shifts || [];
  const pkgName = (b) => (b.packageId ? (packages.find(p => p.id === b.packageId)?.name || 'yes') : '');

  // ── the sums (lib/bookings/bookingReports.js, tested) ─────────────────────
  // Services are each site's own; a multi site report groups them by name.
  const report = useMemo(() => {
    const bySite = new Map();
    for (const b of rows) {
      const arr = bySite.get(b.siteId) || [];
      arr.push(b);
      bySite.set(b.siteId, arr);
    }
    const combined = bookingsReport({ bookings: rows, payments, shifts: [] });
    const svc = new Map();
    for (const list of bySite.values()) {
      const part = bookingsReport({ bookings: list, payments, shifts: shiftsOf(list[0] || {}) });
      for (const r of part.byService) {
        const t = svc.get(r.service) || { ...r, bookings: 0, covers: 0, seatedCovers: 0, noShows: 0, cancelled: 0 };
        t.bookings += r.bookings; t.covers += r.covers; t.seatedCovers += r.seatedCovers; t.noShows += r.noShows; t.cancelled += r.cancelled;
        t.firstMin = Math.min(t.firstMin, r.firstMin);
        svc.set(r.service, t);
      }
    }
    const perSite = readSites.map((site) => ({ site, ...bookingsReport({ bookings: bySite.get(site.id) || [], payments, shifts: site.shifts || locationConfig?.shifts || [] }) }));
    return { ...combined, byService: [...svc.values()].sort((a, b) => a.firstMin - b.firstMin), perSite };
  // shiftsOf reads locationConfig, named in the deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, payments, readSites, locationConfig]);
  const kpis = report.kpis;
  const paidByBooking = useMemo(() => (Array.isArray(payments) ? moneyByBooking(payments) : {}), [payments]);
  const paidText = (b) => {
    const m = paidByBooking[b.id];
    if (!m) return '';
    return Object.entries(m).map(([cur, v]) => ((v.prepay + v.deposit + v.noShow) / 100).toFixed(2) + (Object.keys(m).length > 1 ? ` ${cur}` : '')).join(' + ');
  };
  const withPackage = rows.filter(b => b.packageId && b.status !== 'cancelled' && b.status !== 'expired' && b.status !== 'pending_payment').length;
  const liveCount = rows.filter(b => !['cancelled', 'expired', 'pending_payment'].includes(b.status)).length;
  const packageRate = liveCount ? (withPackage / liveCount) * 100 : 0;

  // ── Covers by day ─────────────────────────────────────────────────────────
  const fromISO = readSites[0]?.range?.fromDay || fromDay;
  const toISO = readSites[0]?.range?.toDay || toDay;
  const days = useMemo(() => rangeDays({ fromDay: fromISO, toDay: toISO }), [fromISO, toISO]);

  const coversByDay = useMemo(() => {
    const map = Object.fromEntries(days.map(k => [k, 0]));
    rows.forEach(b => {
      if (['cancelled', 'expired', 'pending_payment'].includes(b.status)) return;
      if (map[b.date] !== undefined) map[b.date] += Number(b.covers) || 0;
    });
    return days.map(k => map[k]);
  }, [rows, days]);

  // ── Peak times (count per hour of startTime) ──────────────────────────────
  const peakHours = useMemo(() => {
    const map = {};
    rows.forEach(b => {
      if (['cancelled', 'expired', 'pending_payment'].includes(b.status)) return;
      const h = parseInt(String(b.startTime || '').slice(0, 2), 10);
      if (!Number.isFinite(h)) return;
      map[h] = (map[h] || 0) + 1;
    });
    return Object.entries(map)
      .map(([h, n]) => ({ hour: Number(h), n }))
      .sort((a, b) => a.hour - b.hour);
  }, [rows]);

  // ── Bookings table (≤200 rows, newest first) ──────────────────────────────
  const sorted = useMemo(() =>
    [...rows].sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
  , [rows]);
  const tableRows = sorted.slice(0, 200);

  // ── CSV export (full range, not truncated) ────────────────────────────────
  // 16 Oct 2026: the columns a manager rings guests and reconciles deposits from (audit).
  const onExport = () => {
    const cols = [
      { label:'Date',    key:'date' },
      { label:'Time',    key:'startTime' },
      { label:'Service', key: b => serviceFor(b.startTime, shiftsOf(b)) },
      { label:'Name',    key: b => b.customer?.name || '' },
      { label:'Phone',   key: b => b.customer?.phone || '' },
      { label:'Email',   key: b => b.customer?.email || '' },
      { label:'Covers',  key:'covers' },
      { label:'Tables',  key: b => (b.tables || []).map(id => tableLabel(b, id)).join(' + ') },
      { label:'Status',  key: b => STATUS_META[b.status]?.label || b.status },
      { label:'Source',  key: b => (SOURCE_LABELS[b.source] || b.source || '').replace(/^\S+\s/, '') },
      { label:'Package', key: b => pkgName(b) },
      { label:'Paid',    key: b => paidText(b) },
      { label:'Note',    key: b => b.note || '' },
      { label:'Cancel reason', key: b => b.cancelReason || '' },
      { label:'Created by', key: b => b.createdBy || '' },
    ];
    downloadCsv(`bookings-${fromISO}-to-${toISO}.csv`, toCsv(sorted, multi ? withSiteColumn(cols) : cols));
  };

  if (loading) {
    return <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--t4)' }}>Loading bookings…</div>;
  }
  if (fault) {
    return <EmptyState icon="⚠" message={faultText(fault)}/>;
  }
  if (rows.length === 0) {
    return <EmptyState icon="📅" message="No bookings in this range. Bookings taken at the host stand, by phone or through the web widget will appear here."/>;
  }

  const maxSourceBookings = Math.max(1, ...report.bySource.map(r => r.bookings));
  const maxHour = Math.max(1, ...peakHours.map(r => r.n));
  const currencies = Object.keys(report.money);
  const cardSt = { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, marginBottom:14 };
  const capSt = { fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' };
  const headSt = { display:'grid', padding:'7px 16px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8 };
  const numSt = { textAlign:'right', fontFamily:'var(--font-mono)', color:'var(--t2)' };
  const moneyLine = (m) => {
    const parts = Object.entries(m || {}).filter(([, v]) => v.total > 0).map(([cur, v]) => moneyMinor(v.total, cur));
    return parts.length ? parts.join(' + ') : '-';
  };

  return (
    <div>
      <div style={{ display:'flex', flexWrap:'wrap', justifyContent:'space-between', alignItems:'flex-start', gap:12, marginBottom:12 }}>
        <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.6 }}>
          {multi && <><strong style={{ color:'var(--t1)' }}>{readSites.length} sites</strong>, each read over its own days. </>}
          {kpis.unpaidExpired + kpis.awaitingPayment > 0 && <>Rates leave out bookings that never were: {fmtN(kpis.unpaidExpired)} unpaid and expired, {fmtN(kpis.awaitingPayment)} still paying.</>}
        </div>
        <ExportBtn onClick={onExport}/>
      </div>

      {/* KPI row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:10, marginBottom:18 }}>
        <StatTile label="Total bookings" value={fmtN(kpis.bookings)}/>
        <StatTile label="Covers" value={fmtN(kpis.covers)} sub={`${kpis.avgParty.toFixed(1)} avg party · ${fmtN(kpis.seatedCovers)} seated`}/>
        <StatTile label="No-show rate" value={`${kpis.noShowRate.toFixed(1)}%`}
          sub={`${fmtN(kpis.noShows)} no-show${kpis.noShows === 1 ? '' : 's'} · ${fmtN(kpis.noShowCovers)} covers`}
          color={kpis.noShows > 0 ? 'var(--red)' : 'var(--grn)'}/>
        <StatTile label="Cancellation rate" value={`${kpis.cancelRate.toFixed(1)}%`}
          sub={`${fmtN(kpis.cancelled)} cancelled`}
          color={kpis.cancelled > 0 ? 'var(--amb,#e8a020)' : 'var(--grn)'}/>
        <StatTile label="Widget share" value={`${kpis.onlineShare.toFixed(1)}%`} sub="booked online" color="var(--acc)"/>
        <StatTile label="Package attach" value={`${packageRate.toFixed(1)}%`}
          sub={`${fmtN(withPackage)} with a package`} color="var(--acc)"/>
      </div>

      {/* Money from bookings: what was actually TAKEN, per currency */}
      <div style={{ ...cardSt, padding:'14px 16px' }}>
        <div style={{ ...capSt, marginBottom:10 }}>Money from bookings</div>
        {!report.moneyKnown ? (
          <div style={{ fontSize:12, color:'var(--t3)' }}>The booking payments could not be read, so no money is shown. Try again in a moment.</div>
        ) : !currencies.length ? (
          <div style={{ fontSize:12, color:'var(--t3)' }}>No money was taken with these bookings.{report.cardsSaved ? ` ${fmtN(report.cardsSaved)} card${report.cardsSaved === 1 ? ' was' : 's were'} saved for a hold (nothing taken).` : ''}</div>
        ) : currencies.map((cur) => {
          const m = report.money[cur];
          return (
            <div key={cur} style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10, marginBottom: currencies.length > 1 ? 10 : 0 }}>
              <StatTile label={`Taken${currencies.length > 1 ? ` (${cur})` : ''}`} value={moneyMinor(m.total, cur)} color="var(--grn)"/>
              <StatTile label="Prepaid" value={moneyMinor(m.prepay, cur)}/>
              <StatTile label="Deposits" value={moneyMinor(m.deposit, cur)}/>
              <StatTile label="No show and late cancel" value={moneyMinor(m.noShow, cur)}/>
              <StatTile label="Cards saved" value={fmtN(report.cardsSaved || 0)} sub="nothing taken"/>
            </div>
          );
        })}
      </div>

      {/* Per site, when several are ticked */}
      {multi && (
        <div style={{ ...cardSt, overflow:'auto' }}>
          <div style={{ ...capSt, padding:'14px 16px 8px' }}>By site</div>
          <div style={{ ...headSt, gridTemplateColumns:'1.4fr 80px 80px 90px 90px 1fr', minWidth:620 }}>
            <span>Site</span><span style={{ textAlign:'right' }}>Bookings</span><span style={{ textAlign:'right' }}>Covers</span>
            <span style={{ textAlign:'right' }}>No-shows</span><span style={{ textAlign:'right' }}>Cancelled</span><span style={{ textAlign:'right' }}>Taken</span>
          </div>
          {report.perSite.map((p) => (
            <div key={p.site.id} style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 80px 90px 90px 1fr', padding:'9px 16px', borderBottom:'1px solid var(--bdr)', fontSize:12, gap:8, minWidth:620 }}>
              <span style={{ fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.site.name}</span>
              <span style={numSt}>{fmtN(p.kpis.bookings)}</span>
              <span style={numSt}>{fmtN(p.kpis.covers)}</span>
              <span style={numSt}>{fmtN(p.kpis.noShows)} <span style={{ color:'var(--t4)' }}>{p.kpis.noShowRate.toFixed(0)}%</span></span>
              <span style={numSt}>{fmtN(p.kpis.cancelled)}</span>
              <span style={numSt}>{p.moneyKnown ? moneyLine(p.money) : '-'}</span>
            </div>
          ))}
        </div>
      )}

      {/* Covers by day */}
      <div style={{ ...cardSt, padding:'16px' }}>
        <div style={{ ...capSt, marginBottom:12 }}>Covers by day</div>
        <DayBars days={days} values={coversByDay} todayKey={dayOfCheck(Date.now(), reportClock(locationConfig))}/>
      </div>

      {/* Covers by service */}
      <div style={{ ...cardSt, overflow:'auto' }}>
        <div style={{ ...capSt, padding:'14px 16px 8px' }}>Covers by service</div>
        <div style={{ ...headSt, gridTemplateColumns:'1.4fr 80px 80px 80px 80px 80px', minWidth:520 }}>
          <span>Service</span><span style={{ textAlign:'right' }}>Bookings</span><span style={{ textAlign:'right' }}>Covers</span>
          <span style={{ textAlign:'right' }}>Seated</span><span style={{ textAlign:'right' }}>No-shows</span><span style={{ textAlign:'right' }}>Cancelled</span>
        </div>
        {report.byService.map((r, i) => (
          <div key={r.service} style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 80px 80px 80px 80px', minWidth:520, padding:'9px 16px', borderBottom: i === report.byService.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, gap:8, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
            <span style={{ color:'var(--t1)', fontWeight:600 }}>{r.service}</span>
            <span style={numSt}>{fmtN(r.bookings)}</span>
            <span style={{ ...numSt, fontWeight:700, color:'var(--t1)' }}>{fmtN(r.covers)}</span>
            <span style={numSt}>{fmtN(r.seatedCovers)}</span>
            <span style={{ ...numSt, color: r.noShows ? 'var(--red)' : 'var(--t3)' }}>{fmtN(r.noShows)}</span>
            <span style={numSt}>{fmtN(r.cancelled)}</span>
          </div>
        ))}
        {!locationConfig?.shifts?.length && !multi && (
          <div style={{ padding:'8px 16px', fontSize:11, color:'var(--t4)' }}>No service periods are set for this venue, so bookings are grouped as breakfast (before 11:00), lunch (to 16:00) and dinner.</div>
        )}
      </div>

      {/* Status breakdown (compact) */}
      <div style={{ ...cardSt, padding:'14px 16px' }}>
        <div style={{ ...capSt, marginBottom:10 }}>By status</div>
        <div style={{ display:'flex', gap:22, flexWrap:'wrap' }}>
          {report.byStatus.map(s => (
            <div key={s.id}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{s.label}</div>
              <div style={{ fontSize:17, fontWeight:800, color: s.n > 0 ? (STATUS_META[s.id]?.color || 'var(--t2)') : 'var(--t4)', fontFamily:'var(--font-mono)', marginTop:2 }}>{fmtN(s.n)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Lead sources + peak times, side by side */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:14, marginBottom:14 }}>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
          <div style={{ ...capSt, padding:'14px 16px 8px' }}>Lead sources</div>
          <div style={{ ...headSt, gridTemplateColumns:'1.3fr 70px 66px 76px 1fr', minWidth:420 }}>
            <span>Source</span>
            <span style={{ textAlign:'right' }}>Bookings</span>
            <span style={{ textAlign:'right' }}>Covers</span>
            <span style={{ textAlign:'right' }}>No-show</span>
            <span style={{ textAlign:'right' }}>Taken</span>
          </div>
          {report.bySource.map((r, i) => (
            <div key={r.source} style={{ display:'grid', gridTemplateColumns:'1.3fr 70px 66px 76px 1fr', padding:'9px 16px', borderBottom: i === report.bySource.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, minWidth:420, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{SOURCE_LABELS[r.source] || r.name}</span>
              <span style={{ ...numSt, color: r.bookings === maxSourceBookings ? 'var(--acc)' : 'var(--t2)', fontWeight:700 }}>{fmtN(r.bookings)}</span>
              <span style={numSt}>{fmtN(r.covers)}</span>
              <span style={{ ...numSt, color: r.noShows ? 'var(--red)' : 'var(--t3)' }}>{r.noShowRate.toFixed(1)}%</span>
              <span style={numSt}>{report.moneyKnown ? moneyLine(r.money) : '-'}</span>
            </div>
          ))}
        </div>

        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ ...capSt, marginBottom:12 }}>Peak times</div>
          {peakHours.length === 0 ? (
            <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No timed bookings.</div>
          ) : peakHours.map(r => (
            <BarRow key={r.hour} label={`${String(r.hour).padStart(2, '0')}:00`} value={r.n} max={maxHour}
              format={(v) => `${fmtN(v)} booking${v === 1 ? '' : 's'}`}/>
          ))}
        </div>
      </div>

      {/* Bookings table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={{ ...headSt, gridTemplateColumns: tableCols(multi), padding:'9px 14px', minWidth: multi ? 880 : 760 }}>
          {multi && <span>Site</span>}
          <span>Date</span>
          <span>Time</span>
          <span>Name</span>
          <span style={{ textAlign:'right' }}>Covers</span>
          <span>Table(s)</span>
          <span>Status</span>
          <span>Source</span>
          <span>Package</span>
        </div>
        {tableRows.map((b, i) => {
          const st = STATUS_META[b.status] || { label: b.status, bg:'var(--bg3)', color:'var(--t3)' };
          return (
            <div key={`${b.siteId}:${b.id || i}`} style={{ display:'grid', gridTemplateColumns: tableCols(multi), padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, minWidth: multi ? 880 : 760, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              {multi && <span style={{ color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.siteName}</span>}
              <span style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmtDateShort(b.date)}</span>
              <span style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{b.startTime}</span>
              <span style={{ color:'var(--t1)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.customer?.name || '-'}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{b.covers}</span>
              <span style={{ color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(b.tables || []).map(id => tableLabel(b, id)).join(' + ') || '-'}</span>
              <span>
                <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:5, background:st.bg, color:st.color, textTransform:'uppercase', letterSpacing:'.05em', whiteSpace:'nowrap' }}>{st.label}</span>
              </span>
              <span style={{ color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{SOURCE_LABELS[b.source] || b.source}</span>
              <span style={{ color: b.packageId ? 'var(--grn)' : 'var(--t4)', fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.packageId ? pkgName(b) : '-'}</span>
            </div>
          );
        })}
      </div>
      {rows.length > 200 && (
        <div style={{ marginTop:10, padding:'8px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)' }}>
          Showing the 200 most recent of {fmtN(rows.length)} bookings. Export CSV for the full range.
        </div>
      )}
    </div>
  );
}

const tableCols = (multi) => `${multi ? '110px ' : ''}110px 60px 1.4fr 60px 100px 110px 120px 110px`;

// ── Covers-by-day plain-div bar chart (HourBar idiom, day-keyed) ─────────────
// todayKey is the venue's business day now, the day the Today period shows (v5.11.1: was
// the browser's date, a day ahead of London every evening in Tokyo). Days are 'YYYY-MM-DD'
// and are labelled from the date itself, never a clock.
function DayBars({ days, values, todayKey }) {
  const max = Math.max(1, ...values);
  const accentIdx = days.includes(todayKey) ? days.indexOf(todayKey) : days.length - 1;
  const many = days.length > 21;
  // Sparse x labels for long ranges — first / quarter points / last.
  const labelIdx = new Set(days.length <= 14
    ? days.map((_, i) => i)
    : [0, Math.floor((days.length - 1) / 4), Math.floor((days.length - 1) / 2), Math.floor(3 * (days.length - 1) / 4), days.length - 1]);
  const BAR_H = 118; // px height of the tallest bar
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap: many ? 2 : 4 }}>
      {days.map((k, i) => {
        const val = values[i];
        const barPx = Math.max(Math.round((val / max) * BAR_H), val > 0 ? 4 : 2);
        const isAccent = i === accentIdx;
        const dm = `${Number(k.slice(8, 10))}/${Number(k.slice(5, 7))}`;
        const short = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][weekdayOf(k)]} ${dm}`;
        return (
          <div key={k} title={`${short}: ${val} covers`} style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', alignItems:'center', gap:3, minWidth:0 }}>
            <div style={{ fontSize:9, color:'var(--t4)', fontFamily:'var(--font-mono)', whiteSpace:'nowrap' }}>
              {!many && val > 0 ? val : ''}
            </div>
            <div style={{
              width:'100%',
              background: isAccent ? 'var(--acc)' : val > 0 ? 'var(--acc-d)' : 'var(--bg3)',
              borderRadius:'3px 3px 0 0',
              transition:'height .3s',
              height: barPx,
              border: isAccent ? '1px solid var(--acc-b)' : '1px solid var(--bdr)',
              boxSizing:'border-box',
            }}/>
            <div style={{ fontSize:8, color: isAccent ? 'var(--acc)' : 'var(--t4)', fontWeight: isAccent ? 700 : 400, whiteSpace:'nowrap' }}>
              {labelIdx.has(i) ? (days.length <= 7 ? short : dm) : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
