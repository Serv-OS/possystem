// Booking payments: Back Office → Reports → Booking payments (16 Oct 2026, bookings audit
// section 3 item 10).
//
// Every booking_payments row of the ticked sites paid in the period: prepay and deposits taken
// online, cards saved for a hold, no show and late cancel charges, refunds. With the guest, the
// table and the booking, the card ending, whether the money has been applied to a check, and what
// is owed back. Self fetching like BookingsReport (it reads its own data, never the shell's
// checks). Multi site: each site read over its own range on its own clock, a Site column when
// more than one is ticked, money never added across currencies. Reads page past the 1,000 row cap
// (lib/bookings/bookingMoneyData.js).

import { useEffect, useMemo, useState } from 'react';
import { getLocationId } from '../../../lib/supabase';
import { moneyMinor } from '../../../lib/currency';
import { faultText } from '../../../lib/pagedRead';
import { loadBookingPaymentsRange, loadBookingsByIds, loadTableLabels } from '../../../lib/bookings/bookingMoneyData.js';
import { paymentLines, paymentTotals, filterLines, KIND_NAMES } from '../../../lib/bookings/bookingReports.js';
import { NO_SHOW_KIND } from '../../../lib/bookings/noShowCharge.js';
import { withSiteColumn } from '../../../lib/reportSplit.js';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { bookingSites, siteDayOf, siteTimeOf, isoBounds } from './_bookingSites.js';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'taken', label: 'Money taken' },
  { id: 'not_on_check', label: 'Not on a check' },
  { id: 'owed', label: 'Owed back' },
  { id: 'failed', label: 'Failed' },
  { id: 'pending', label: 'Waiting' },
  { id: 'refunded', label: 'Refunded' },
];
const KIND_FILTERS = ['all', 'prepay', 'deposit', 'hold', NO_SHOW_KIND, 'refund'];
const SHOW_ROWS = 300;

const STATUS_COL = {
  Taken: 'var(--grn)', 'Card saved': 'var(--acc)', 'Owed back': 'var(--red)', Failed: 'var(--red)',
  Waiting: 'var(--amb,#e8a020)', Refunded: 'var(--t3)', Cancelled: 'var(--t4)', Authorised: 'var(--grn)',
};

export default function BookingPaymentsReport({ range = null, sites = [], fmtN = (n) => (n || 0).toLocaleString() }) {
  const [homeId, setHomeId] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!sites?.length) getLocationId().then((id) => { if (alive) setHomeId(id || null); }).catch(() => {});
    return () => { alive = false; };
  }, [sites?.length]);
  const readSites = useMemo(() => bookingSites({ sites, homeId, range }), [sites, homeId, range]);
  const siteKey = readSites.map((s) => `${s.id}:${s.range?.fromDay}:${s.range?.toDay}:${isoBounds(s)?.from}`).join('|');

  // { key, lines, fault } so an answer for an older period never paints over a newer one.
  const [state, setState] = useState({ key: null, lines: null, fault: null });
  useEffect(() => {
    if (!readSites.length) return undefined;
    let alive = true;
    (async () => {
      const all = [];
      let fault = null;
      for (const site of readSites) {
        const b = isoBounds(site);
        if (!b) continue;
        const res = await loadBookingPaymentsRange(site.id, b.from, b.to);
        if (res.error) { fault = res.tooMany ? 'too_long' : 'failed'; break; }
        const rows = res.data || [];
        const [{ data: byId, error: bErr }, labels] = await Promise.all([
          loadBookingsByIds(rows.map((r) => r.booking_id)),
          loadTableLabels(site.id),
        ]);
        if (bErr) console.warn('[BookingPayments] bookings read failed, guests not shown:', bErr.message || bErr);
        const lines = paymentLines({
          payments: rows.map((r) => ({ ...r, siteId: site.id, siteName: site.name })),
          bookingsById: byId,
          tableLabel: (id) => labels.get(id) || String(id || '').slice(-4),
          dayOf: siteDayOf(site),
        });
        const timeOf = siteTimeOf(site);
        for (const l of lines) all.push({ ...l, time: timeOf(l.at), currency: l.currency || site.currency || 'GBP' });
      }
      if (!alive) return;
      all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      setState({ key: siteKey, lines: fault ? [] : all, fault });
    })().catch((e) => {
      console.warn('[BookingPayments] load failed:', e?.message || e);
      if (alive) setState({ key: siteKey, lines: [], fault: 'failed' });
    });
    return () => { alive = false; };
  // siteKey names everything the read depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const ready = state.key === siteKey && state.lines !== null;
  const lines = useMemo(() => (ready ? state.lines : []), [ready, state.lines]);
  const shown = useMemo(() => filterLines(lines, { status, kind }), [lines, status, kind]);
  const totals = useMemo(() => paymentTotals(lines), [lines]);
  const multi = readSites.length > 1;

  const onExport = () => {
    const cols = [
      { label: 'Paid day', key: 'day' },
      { label: 'Paid time', key: 'time' },
      { label: 'Status', key: 'statusName' },
      { label: 'Kind', key: 'kindName' },
      { label: 'Guest', key: 'guest' },
      { label: 'Phone', key: 'phone' },
      { label: 'Table', key: 'table' },
      { label: 'Booking date', key: 'bookingDate' },
      { label: 'Booking time', key: 'bookingTime' },
      { label: 'Booking status', key: 'bookingStatus' },
      { label: 'Covers', key: 'covers' },
      { label: 'Card ending', key: 'cardEnding' },
      { label: 'Currency', key: 'currency' },
      { label: 'Amount', key: (l) => (l.amountMinor / 100).toFixed(2) },
      { label: 'Hold amount (not taken)', key: (l) => (l.holdMinor ? (l.holdMinor / 100).toFixed(2) : '') },
      { label: 'Applied to check', key: (l) => (l.appliedToCheck ? 'yes' : 'no') },
      { label: 'Check id', key: (l) => l.appliedCheckId || '' },
      { label: 'Owed back', key: (l) => (l.owedBackMinor ? (l.owedBackMinor / 100).toFixed(2) : '') },
      { label: 'Note', key: 'note' },
      { label: 'Booking id', key: 'bookingId' },
    ];
    const from = readSites[0]?.range?.fromDay || 'from';
    const to = readSites[0]?.range?.toDay || 'to';
    downloadCsv(`booking-payments-${from}-to-${to}.csv`, toCsv(shown, multi ? withSiteColumn(cols) : cols));
  };

  if (!readSites.length || !ready) {
    return <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--t4)' }}>Loading booking payments…</div>;
  }
  if (state.fault) return <EmptyState icon="⚠" message={faultText(state.fault)} />;
  if (!lines.length) {
    return <EmptyState icon="💳" message="No booking payments in this period. Money taken with online bookings, saved cards and no show charges appear here." />;
  }

  const currencies = Object.keys(totals);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 640 }}>
          Every payment taken with a booking in this period, on each site&apos;s own clock. A saved card is not money: its hold amount is shown apart and never added in.
          {multi && <div><strong style={{ color: 'var(--t1)' }}>{readSites.length} sites</strong>; money is never added across currencies.</div>}
        </div>
        <ExportBtn onClick={onExport} />
      </div>

      {currencies.map((cur) => {
        const t = totals[cur];
        return (
          <div key={cur} style={{ marginBottom: 14 }}>
            {currencies.length > 1 && <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', marginBottom: 8 }}>{cur}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <StatTile label="Money taken" value={moneyMinor(t.taken, cur)} sub={`${moneyMinor(t.prepay, cur)} prepaid · ${moneyMinor(t.deposit, cur)} deposits`} color="var(--grn)" />
              <StatTile label="No show charges" value={moneyMinor(t.noShow, cur)} sub="charged to saved cards" color={t.noShow > 0 ? 'var(--grn)' : 'var(--t1)'} />
              <StatTile label="Not on a check yet" value={fmtN(t.notOnCheck)} sub="money taken, not used on a bill" color={t.notOnCheck > 0 ? 'var(--amb,#e8a020)' : 'var(--t1)'} />
              <StatTile label="Owed back" value={moneyMinor(t.owedBack, cur)} sub="to refund to guests" color={t.owedBack > 0 ? 'var(--red)' : 'var(--t1)'} />
              <StatTile label="Cards saved" value={fmtN(t.cardsSaved)} sub="nothing taken" color="var(--acc)" />
              <StatTile label="Failed" value={fmtN(t.failed)} sub={`${moneyMinor(t.refunded, cur)} refunded`} color={t.failed > 0 ? 'var(--red)' : 'var(--t1)'} />
            </div>
          </div>
        );
      })}

      {multi && <SiteTable lines={lines} sites={readSites} />}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0 10px' }}>
        {STATUS_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setStatus(f.id)} style={chip(status === f.id)}>{f.label}</button>
        ))}
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"
          style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 12 }}>
          {KIND_FILTERS.map((k) => <option key={k} value={k}>{k === 'all' ? 'Every kind' : KIND_NAMES[k]}</option>)}
        </select>
      </div>

      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'auto' }}>
        <div style={{ ...gridRow(multi), ...headSt }}>
          {multi && <span>Site</span>}
          <span>Paid</span><span>Status</span><span>Kind</span><span>Guest</span><span>Table</span><span>Booking</span>
          <span>Card</span><span style={{ textAlign: 'right' }}>Amount</span><span>On a check</span><span style={{ textAlign: 'right' }}>Owed back</span>
        </div>
        {shown.slice(0, SHOW_ROWS).map((l, i) => (
          <div key={`${l.siteId}:${l.id}`} title={l.note || undefined} style={{ ...gridRow(multi), ...rowSt, background: i % 2 ? 'var(--bg2)' : 'transparent' }}>
            {multi && <span style={cut}>{l.siteName}</span>}
            <span style={{ ...mono, color: 'var(--t2)' }}>{l.day.slice(5)} {l.time}</span>
            <span><span style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 5, background: 'var(--bg3)', color: STATUS_COL[l.statusName] || 'var(--t3)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{l.statusName}</span></span>
            <span style={{ ...cut, color: 'var(--t2)' }}>{l.kindName}</span>
            <span style={{ ...cut, color: 'var(--t1)', fontWeight: 600 }}>{l.guest || '-'}</span>
            <span style={{ ...cut, color: 'var(--t3)' }}>{l.table || '-'}</span>
            <span style={{ ...mono, color: 'var(--t3)' }}>{l.bookingDate ? `${l.bookingDate.slice(5)} ${l.bookingTime}` : '-'}</span>
            <span style={{ ...mono, color: 'var(--t3)' }}>{l.cardEnding ? `···${l.cardEnding}` : '-'}</span>
            <span style={{ ...mono, textAlign: 'right', color: l.taken ? 'var(--grn)' : 'var(--t3)', fontWeight: 700 }}>
              {l.kind === 'hold' ? <span style={{ color: 'var(--t4)', fontWeight: 400 }}>{l.holdMinor ? `hold ${moneyMinor(l.holdMinor, l.currency)}` : '-'}</span> : moneyMinor(l.amountMinor, l.currency)}
            </span>
            <span style={{ color: l.appliedToCheck ? 'var(--grn)' : l.taken ? 'var(--amb,#e8a020)' : 'var(--t4)', fontWeight: 700 }}>{l.appliedToCheck ? 'Yes' : l.taken ? 'Not yet' : '-'}</span>
            <span style={{ ...mono, textAlign: 'right', color: l.owedBackMinor ? 'var(--red)' : 'var(--t4)', fontWeight: l.owedBackMinor ? 700 : 400 }}>{l.owedBackMinor ? moneyMinor(l.owedBackMinor, l.currency) : '-'}</span>
          </div>
        ))}
        {!shown.length && <div style={{ padding: 16, fontSize: 12, color: 'var(--t4)' }}>Nothing matches these filters.</div>}
      </div>
      {shown.length > SHOW_ROWS && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--bg3)', border: '1px dashed var(--bdr)', borderRadius: 8, fontSize: 11, color: 'var(--t4)' }}>
          Showing the {SHOW_ROWS} most recent of {fmtN(shown.length)} payments. Export CSV for all of them.
        </div>
      )}
    </div>
  );
}

function SiteTable({ lines, sites }) {
  const rows = sites.map((s) => {
    const mine = lines.filter((l) => String(l.siteId) === String(s.id));
    const t = paymentTotals(mine);
    return { site: s, totals: t };
  });
  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'auto', marginBottom: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(4, 110px)', ...headSt, minWidth: 600 }}>
        <span>Site</span><span style={{ textAlign: 'right' }}>Taken</span><span style={{ textAlign: 'right' }}>No show</span><span style={{ textAlign: 'right' }}>Owed back</span><span style={{ textAlign: 'right' }}>Cards saved</span>
      </div>
      {rows.map(({ site, totals }) => {
        const curs = Object.keys(totals);
        const cur = curs[0] || site.currency || 'GBP';
        const t = totals[cur] || { taken: 0, noShow: 0, owedBack: 0, cardsSaved: 0 };
        return (
          <div key={site.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr repeat(4, 110px)', ...rowSt, minWidth: 600 }}>
            <span style={{ ...cut, fontWeight: 700 }}>{site.name}</span>
            <span style={{ ...mono, textAlign: 'right' }}>{moneyMinor(t.taken, cur)}</span>
            <span style={{ ...mono, textAlign: 'right' }}>{moneyMinor(t.noShow, cur)}</span>
            <span style={{ ...mono, textAlign: 'right', color: t.owedBack ? 'var(--red)' : undefined }}>{moneyMinor(t.owedBack, cur)}</span>
            <span style={{ ...mono, textAlign: 'right' }}>{t.cardsSaved}</span>
          </div>
        );
      })}
    </div>
  );
}

const mono = { fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' };
const cut = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const headSt = { padding: '9px 14px', background: 'var(--bg3)', borderBottom: '1px solid var(--bdr)', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.05em', gap: 8 };
const rowSt = { padding: '9px 14px', borderBottom: '1px solid var(--bdr)', fontSize: 12, alignItems: 'center', gap: 8 };
const gridRow = (multi) => ({
  display: 'grid', minWidth: multi ? 1080 : 960,
  gridTemplateColumns: `${multi ? '110px ' : ''}100px 96px 110px 1.3fr 80px 100px 70px 90px 78px 86px`,
});
const chip = (on) => ({
  padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  border: `1px solid ${on ? 'var(--acc-b)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg2)', color: on ? 'var(--acc)' : 'var(--t2)',
});
