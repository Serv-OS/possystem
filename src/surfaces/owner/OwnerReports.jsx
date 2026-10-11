// src/surfaces/owner/OwnerReports.jsx: the seven reports on the Owner app's venue screen.
//
// 5 Oct 2026: tap a venue card and get its reports; tap the group card for the same seven
// across all sites. Each is one small card of bars and lists, sized for a phone and drawn in
// plain HTML with one SVG line (no chart library). Every figure is the function's own
// (owner-snapshot's detail call); the bar lengths and the words are src/lib/ownerDetail.js.
//   1 Sales by hour        bars per hour, the comparison as a faint line
//   1b Sales mix           8 Oct 2026: item sales by sales group (Food, Drinks, Other sales), each
//                          group's share, "was 59% · +3 pts" against the comparison, and the top
//                          three categories inside each group. Hidden for a function without it.
//   2 Week by day          Mon to Sun, this week against last week
//   3 Payment mix          card, cash, gift card; loyalty and promo credit apart
//   4 Order types and channels
//   5 Discounts, voids and refunds
//   6 Top items            by quantity, by sales, by category
//   7 Labour against sales hidden when the period has no timesheets

import { useState } from 'react';
import {
  hourChart, hoursLineWords, weekChart, shareRows, paymentMix, orderTypeLabel, channelLabel, labourView,
} from '../../lib/ownerDetail';
import { detailRows, noteFor } from '../../lib/ownerMix';
import { ReportCard, Empty, BarLine, Tabs } from './ui';
import { money, smallCaps, linkBtn } from './style';

const FAINT = 'var(--t3)';

export default function OwnerReports({ detail, period, range, currency }) {
  const m = (n, dp = 0) => money(n, currency, dp);
  return (
    <>
      <HoursCard hours={detail.hours} period={period} range={range} m={m} />
      <SalesMixCard mix={detail.mix} period={period} m={m} />
      <WeekCard week={detail.week} m={m} />
      <PaymentsCard payments={detail.payments} m={m} />
      <MixCard types={detail.order_types} channels={detail.channels} m={m} />
      <ExceptionsCard ex={detail.exceptions} m={m} />
      <ItemsCard items={detail.items} m={m} />
      <LabourCard labour={detail.labour} m={m} />
    </>
  );
}

// ── 1. Sales by hour ─────────────────────────────────────────────────────────
function HoursCard({ hours, period, range, m }) {
  const [open, setOpen] = useState(false);
  const c = hourChart(hours);
  const n = c.rows.length;
  // Every hour is labelled when they fit; otherwise every second or third.
  const step = n <= 9 ? 1 : n <= 16 ? 2 : 3;
  const line = hoursLineWords(period, range);
  return (
    <ReportCard title="Sales by hour" note={c.peak ? `Busiest hour ${c.peak.label}, ${m(c.peak.net)}` : null}>
      {!n ? <Empty>No sales in these hours yet.</Empty> : (
        <>
          <div style={{ position: 'relative', height: 120, display: 'flex', alignItems: 'flex-end' }}>
            {c.rows.map((r) => (
              <div key={r.hour} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', padding: '0 1px', boxSizing: 'border-box' }}>
                <div style={{ width: '100%', height: `${r.h * 100}%`, minHeight: r.net > 0 ? 2 : 0, background: 'var(--acc)', borderRadius: '3px 3px 0 0' }} />
              </div>
            ))}
            {c.hasCmp && (
              <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <polyline points={c.rows.map((r, i) => `${i + 0.5},${100 - r.ch * 100}`).join(' ')}
                  fill="none" stroke={FAINT} strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </div>
          <div style={{ display: 'flex', borderTop: '1px solid var(--bdr)', paddingTop: 4 }}>
            {c.rows.map((r, i) => (
              <div key={r.hour} style={{ flex: 1, textAlign: 'center', fontSize: 9.5, color: 'var(--t4)', whiteSpace: 'nowrap', overflow: 'visible' }}>{i % step === 0 ? r.label : ''}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--t3)' }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--acc)', marginRight: 5 }} />This period</span>
            {c.hasCmp && <span><span style={{ display: 'inline-block', width: 14, borderTop: `2px dashed ${FAINT}`, marginRight: 5, verticalAlign: 'middle' }} />{line[0].toUpperCase() + line.slice(1)}</span>}
          </div>
          <button style={linkBtn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide the figures' : 'Show the figures'}</button>
          {open && (
            <div style={{ marginTop: 8 }}>
              {c.rows.map((r) => (
                <div key={r.hour} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '3px 0', color: 'var(--t2)' }}>
                  <span>{r.label} <span style={{ color: 'var(--t4)' }}>· {r.orders} order{r.orders === 1 ? '' : 's'}</span></span>
                  <span style={{ flexShrink: 0 }}>{m(r.net)}{c.hasCmp && <span style={{ color: 'var(--t4)' }}> · then {m(r.cmp)}</span>}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ReportCard>
  );
}

// ── 1b. Sales mix ────────────────────────────────────────────────────────────
// 8 Oct 2026, Peter: "what is Food/drink/other split ... in hospitality a valued piece of data".
// Second on the screen, right after Sales by hour (the build's D4a). The shares, the points and
// the order are the function's (src/lib/ownerMix.js only sizes the bars and finds the words). A
// function from before the mix sends no detail.mix, and the card is not drawn at all.
function SalesMixCard({ mix, period, m }) {
  const [open, setOpen] = useState(false);
  if (!mix) return null;
  const v = detailRows(mix);
  if (v.empty) return <ReportCard title="Sales mix"><Empty>No item sales in this period.</Empty></ReportCard>;
  if (v.allOther) {
    return <ReportCard title="Sales mix"><Empty>No sales groups set yet. Set them in Back Office, Reports, Sales mix. Until then every item is in Other sales.</Empty></ReportCard>;
  }
  return (
    <ReportCard title="Sales mix" note={noteFor(period, mix.cmp_total != null)}>
      {v.rows.map((r) => (
        <div key={r.key}>
          <BarLine label={r.name} value={m(r.money)} sub={`${r.share}%`} w={r.w} color={r.color} />
          {r.wasText && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: -6, marginBottom: 10 }}>{r.wasText}</div>}
          {open && (
            <div style={{ marginTop: -4, marginBottom: 10, paddingLeft: 12 }}>
              {(r.categories.length ? r.categories : [{ id: null, label: 'No category', money: null }]).map((c) => (
                <div key={c.id ?? c.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '2px 0', color: 'var(--t3)' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  <span style={{ flexShrink: 0 }}>{c.money == null ? '' : m(c.money)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <button style={linkBtn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide categories' : 'Show categories'}</button>
      {v.footer && <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 8 }}>{v.footer}</div>}
    </ReportCard>
  );
}

// ── 2. Week by day ───────────────────────────────────────────────────────────
function WeekCard({ week, m }) {
  const c = weekChart(week);
  return (
    <ReportCard title="Week by day" note="This week against last week. Last week is whole days.">
      {!(c.max > 0) ? <Empty>No sales this week or last.</Empty> : c.rows.map((r) => (
        <div key={r.dow} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
          <div style={{ width: 30, fontSize: 12, fontWeight: 700, color: 'var(--t3)', flexShrink: 0 }}>{r.dow}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ height: 7, background: 'var(--bg3)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.round(r.w * 100)}%`, background: 'var(--acc)', borderRadius: 99 }} />
            </div>
            <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 99, overflow: 'hidden', marginTop: 3 }}>
              <div style={{ height: '100%', width: `${Math.round(r.lw * 100)}%`, background: FAINT, borderRadius: 99 }} />
            </div>
          </div>
          <div style={{ width: 86, textAlign: 'right', flexShrink: 0, lineHeight: 1.25 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{r.net == null ? '-' : m(r.net)}</div>
            <div style={{ fontSize: 11, color: 'var(--t4)' }}>{m(r.last)}</div>
          </div>
        </div>
      ))}
    </ReportCard>
  );
}

// ── 3. Payment mix ───────────────────────────────────────────────────────────
function PaymentsCard({ payments, m }) {
  const mix = paymentMix(payments);
  return (
    <ReportCard title="Payment mix" note="What each kind took for goods, tax in, tips out.">
      {!mix.money.length && !mix.credits.length ? <Empty>No payments in this period.</Empty> : (
        <>
          {mix.money.map((p) => <BarLine key={p.kind} label={p.label} value={m(p.amount, 2)} sub={`${p.share}%`} w={p.w} />)}
          {mix.credits.length > 0 && (
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 8, marginTop: 4 }}>
              <div style={{ ...smallCaps, marginBottom: 4 }}>Credits, not takings</div>
              {mix.credits.map((p) => <Row key={p.kind} left={p.label} right={m(p.amount, 2)} />)}
            </div>
          )}
        </>
      )}
    </ReportCard>
  );
}

// ── 4. Order types and channels ──────────────────────────────────────────────
function MixCard({ types, channels, m }) {
  const t = shareRows(types, 'net'), ch = shareRows(channels, 'net');
  return (
    <ReportCard title="Order types and channels" note="Net sales.">
      {!t.length && !ch.length ? <Empty>No sales in this period.</Empty> : (
        <>
          <div style={{ ...smallCaps, marginBottom: 6 }}>Order types</div>
          {t.map((r) => <BarLine key={r.type} label={orderTypeLabel(r.type)} value={m(r.net)} sub={`${r.share}%`} w={r.w} />)}
          <div style={{ ...smallCaps, margin: '12px 0 6px' }}>Where the order came from</div>
          {ch.map((r) => <BarLine key={r.channel} label={channelLabel(r.channel)} value={m(r.net)} sub={`${r.share}%`} w={r.w} />)}
        </>
      )}
    </ReportCard>
  );
}

// ── 5. Discounts, voids and refunds ──────────────────────────────────────────
function ExceptionsCard({ ex, m }) {
  const parts = [
    { key: 'discounts', label: 'Discounts', e: ex?.discounts },
    { key: 'voids', label: 'Voids', e: ex?.voids },
    { key: 'refunds', label: 'Refunds', e: ex?.refunds },
  ];
  return (
    <ReportCard title="Discounts, voids and refunds">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
        {parts.map((p) => (
          <div key={p.key} style={{ background: 'var(--bg2)', borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.15 }}>{m(p.e?.amount, 2)}</div>
            <div style={{ ...smallCaps, fontSize: 9.5, marginTop: 2 }}>{p.e?.count || 0} {p.label}</div>
          </div>
        ))}
      </div>
      {parts.map((p) => <ExceptionLists key={p.key} label={p.label} e={p.e} m={m} />)}
    </ReportCard>
  );
}

function ExceptionLists({ label, e, m }) {
  if (!e || !(e.count > 0)) return null;
  // The function sends no void reasons (the till keeps them in its own log): it says so
  // with `reasons: null`, and so does this card. Never a made up reason.
  if (e.reasons == null) {
    return <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 12 }}>{label}: the reason and the manager are kept on the till, not here yet.</div>;
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ ...smallCaps, marginBottom: 4 }}>{label}: top reasons</div>
      {e.reasons.length ? e.reasons.map((r) => <Row key={r.reason} left={r.reason} mid={`${r.count}×`} right={m(r.amount, 2)} />) : <Empty>No reason recorded.</Empty>}
      {e.approved_by?.length > 0 && (
        <>
          <div style={{ ...smallCaps, margin: '8px 0 4px' }}>{label}: approved by</div>
          {e.approved_by.map((r) => <Row key={r.name} left={r.name} mid={`${r.count}×`} right={m(r.amount, 2)} />)}
        </>
      )}
    </div>
  );
}

// ── 6. Top items ─────────────────────────────────────────────────────────────
const ITEM_TABS = [{ id: 'qty', label: 'By quantity' }, { id: 'rev', label: 'By sales' }, { id: 'cat', label: 'By category' }];
const SHORT_LIST = 10;

function ItemsCard({ items, m }) {
  const [by, setBy] = useState('qty');
  const [all, setAll] = useState(false);
  const list = by === 'cat' ? (items?.categories || []) : by === 'rev' ? (items?.by_rev || []) : (items?.by_qty || []);
  const shown = all ? list : list.slice(0, SHORT_LIST);
  const any = (items?.by_qty?.length || 0) > 0;
  return (
    <ReportCard title="Top items" note="Sales include paid extras.">
      {!any ? <Empty>No items sold in this period.</Empty> : (
        <>
          <Tabs options={ITEM_TABS} value={by} onChange={(id) => { setBy(id); setAll(false); }} label="Sort items" />
          {shown.map((it, i) => (
            <div key={`${by}-${it.name}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '4px 0', color: 'var(--t2)' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--t4)', display: 'inline-block', width: 22 }}>{i + 1}</span>
                {it.name}
                {by !== 'cat' && it.category && <span style={{ color: 'var(--t4)' }}> · {it.category}</span>}
              </span>
              <span style={{ flexShrink: 0 }}>
                {by === 'qty' ? <><b>{it.qty}×</b> <span style={{ color: 'var(--t4)' }}>{m(it.rev)}</span></> : <><b>{m(it.rev)}</b> <span style={{ color: 'var(--t4)' }}>{it.qty}×</span></>}
              </span>
            </div>
          ))}
          {list.length > SHORT_LIST && (
            <button style={linkBtn} onClick={() => setAll((a) => !a)} aria-expanded={all}>{all ? `Show the top ${SHORT_LIST}` : `Show all ${list.length}`}</button>
          )}
        </>
      )}
    </ReportCard>
  );
}

// ── 7. Labour against sales ──────────────────────────────────────────────────
function LabourCard({ labour, m }) {
  const v = labourView(labour);
  // No timesheets in the period: the function sends null and the card is not drawn at all.
  if (!v) return null;
  const tone = v.over ? 'var(--red)' : v.target != null ? 'var(--grn)' : 'var(--t1)';
  return (
    <ReportCard title="Labour against sales" note="Approved and paid timesheets against net sales.">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-.02em', color: tone }}>{v.pct == null ? '-' : `${v.pct}%`}</span>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>{v.target != null ? `of sales · target ${v.target}%` : 'of sales'}</span>
      </div>
      {v.pct != null && (
        <div style={{ position: 'relative', height: 8, background: 'var(--bg3)', borderRadius: 99, marginTop: 8 }}>
          <div style={{ height: '100%', width: `${Math.round(v.w * 100)}%`, background: tone, borderRadius: 99 }} />
          {v.tw != null && <div title="Target" style={{ position: 'absolute', top: -3, bottom: -3, left: `calc(${Math.round(v.tw * 100)}% - 1px)`, width: 2, background: 'var(--t2)' }} />}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 14 }}>
        <Tile label="Labour cost" value={m(v.cost)} />
        <Tile label="Hours" value={v.hours} />
        <Tile label="Shifts" value={v.shifts} />
      </div>
    </ReportCard>
  );
}

const Tile = ({ label, value }) => (
  <div style={{ background: 'var(--bg2)', borderRadius: 10, padding: '8px 10px' }}>
    <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.15 }}>{value}</div>
    <div style={{ ...smallCaps, fontSize: 9.5, marginTop: 2 }}>{label}</div>
  </div>
);

const Row = ({ left, mid, right }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '3px 0', color: 'var(--t2)' }}>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span>
    <span style={{ flexShrink: 0 }}>{mid && <span style={{ color: 'var(--t4)', marginRight: 8 }}>{mid}</span>}{right}</span>
  </div>
);
