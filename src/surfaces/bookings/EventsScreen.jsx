// src/surfaces/bookings/EventsScreen.jsx
//
// Events — the packages reference at the host stand (handoff "Events" screen).
// READ-ONLY by design: hosts sell from here (what a package contains, what it
// costs, which payment rule applies, what lands on the POS when the party is
// seated) — the BUILDER lives in Back Office → Channels → Packages & events.
// All data is the store's `packages` (loaded at boot, refreshed on config push
// and by loadBookingsFromDB), so this screen needs no fetch of its own.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { mono, tintBg, tintBd, money, EmptyNote } from './bits.jsx';

const UNIT_LABEL = { per_cover: 'per cover', per_booking: 'per booking', minimum_spend: 'min spend' };
const COURSE_LABEL = { 0: 'Immediate', 1: 'Course 1', 2: 'Course 2', 3: 'Course 3' };
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // ints 0-6, Sunday first (PackageBuilder)

// Mirrors PackageBuilder's payLabel so the host reads the same words the owner wrote.
const payLabel = (p) =>
  p.paymentModel === 'hold' ? 'card hold'
    : p.paymentModel === 'prepay' ? 'prepaid in full'
    : `deposit ${money(p.depositPerCover || 0)}/cover`;

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const daysLabel = (days) => {
  const d = [...new Set(days || [])].filter((n) => n >= 0 && n <= 6).sort((a, b) => a - b);
  if (!d.length || d.length === 7) return null;                        // every day — say nothing
  const contiguous = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  if (contiguous && d.length > 2) return `${DAY_SHORT[d[0]]}–${DAY_SHORT[d[d.length - 1]]}`;
  return d.map((n) => DAY_SHORT[n]).join(', ');
};

const windowLabel = (p) => {
  const from = fmtDate(p.availableFrom), to = fmtDate(p.availableTo);
  const parts = [
    from && to ? `${from} – ${to}` : from ? `from ${from}` : to ? `until ${to}` : null,
    daysLabel(p.availableDays),
    p.availableStart && p.availableEnd ? `${p.availableStart}–${p.availableEnd}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Any service';
};

const capLabel = (p) => {
  const min = p.minCovers || 1, max = p.maxCovers || null;
  const parts = [
    p.maxPerService ? `max ${p.maxPerService} per service` : null,
    min > 1 && max ? `${min}–${max} covers` : min > 1 ? `${min}+ covers` : max ? `up to ${max} covers` : null,
    (p.sections || []).length ? p.sections.join(' + ') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no cap';
};

const label = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--t3)' };

export default function EventsScreen() {
  const packages = useStore((s) => s.packages) || [];
  const [selId, setSelId] = useState(null);

  const sorted = useMemo(
    () => packages.slice().sort((a, b) =>
      (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.name || '').localeCompare(String(b.name || ''))),
    [packages]);
  const sel = sorted.find((p) => p.id === selId) || sorted[0] || null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {/* ── list ── */}
      <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid var(--bdr)', overflowY: 'auto', padding: 18 }}>
        <div style={label}>Packages &amp; events</div>
        <div style={{ fontSize: 11, color: 'var(--t3)', margin: '4px 0 14px', lineHeight: 1.5 }}>
          Sold through the widget and this host stand. Each one carries its own payment rule and its own POS order lines.
        </div>

        {sorted.length === 0 && (
          <EmptyNote title="No packages yet" sub="Build them in Back Office → Channels → Packages & events." />
        )}
        {sorted.map((p) => {
          const isSel = sel && p.id === sel.id;
          return (
            <button
              key={p.id}
              onClick={() => setSelId(p.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '13px 15px', borderRadius: 13,
                cursor: 'pointer', marginBottom: 8, color: 'var(--t1)', fontFamily: 'inherit',
                background: isSel ? tintBg('var(--grn)', 8) : 'var(--bg1)',
                border: `1.5px solid ${isSel ? tintBd('var(--grn)', 55) : 'var(--bdr)'}`,
                transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                {!p.isActive && (
                  <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em', padding: '2px 7px', borderRadius: 20, border: '1px solid var(--bdr2)', flexShrink: 0 }}>Inactive</span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 800, color: 'var(--grn)', flexShrink: 0, ...mono }}>{money(p.price)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 3 }}>
                {UNIT_LABEL[p.priceUnit] || p.priceUnit} · {payLabel(p)}
              </div>
            </button>
          );
        })}

        <div style={{
          marginTop: 6, padding: '12px 14px', borderRadius: 12,
          background: tintBg('var(--orn)', 8), border: `1px solid ${tintBd('var(--orn)')}`,
          fontSize: 11, color: 'var(--orn)', lineHeight: 1.5,
        }}>
          <span style={{ fontWeight: 700 }}>Read-only here.</span>{' '}
          <span style={{ color: 'var(--t2)' }}>
            Packages are built and edited in Back Office → Channels → Packages &amp; events; this host stand sells them.
          </span>
        </div>
      </div>

      {/* ── detail ── */}
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 18 }}>
        {sel ? <PackageDetail p={sel} /> : (
          <div style={{ color: 'var(--t3)', fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>
            Nothing to show yet — once a package is built in the Back Office it appears here with its payment rule and the order lines it lands on the POS.
          </div>
        )}
      </div>
    </div>
  );
}

function PackageDetail({ p }) {
  const lines = (p.lines || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const card = { flex: 1, minWidth: 0, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '11px 13px' };
  const cardLbl = { fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' };
  const cardSub = { fontSize: 10, color: 'var(--t4)', marginTop: 2 };
  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{p.name}</div>
      {p.description && (
        <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 4, lineHeight: 1.5, maxWidth: 620 }}>{p.description}</div>
      )}

      {/* four metric cards */}
      <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px', flexWrap: 'wrap' }}>
        <div style={card}>
          <div style={cardLbl}>Price</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2, ...mono }}>{money(p.price)}</div>
          <div style={cardSub}>{UNIT_LABEL[p.priceUnit] || p.priceUnit}</div>
        </div>
        <div style={card}>
          <div style={cardLbl}>Payment</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>{payLabel(p)}</div>
          <div style={cardSub}>{p.paymentModel === 'prepay' ? 'paid at booking' : 'balance settles on the night'}</div>
        </div>
        <div style={card}>
          <div style={cardLbl}>Availability</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, lineHeight: 1.3 }}>{windowLabel(p)}</div>
          <div style={cardSub}>{capLabel(p)}</div>
        </div>
        <div style={card}>
          <div style={cardLbl}>Turn</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2, ...mono }}>{p.turnMinutes ? `${p.turnMinutes} min` : '—'}</div>
          <div style={cardSub}>{p.turnMinutes ? 'overrides the default' : 'uses the cover band'}</div>
        </div>
      </div>

      {/* what lands on the POS */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={label}>What lands on the POS</div>
        <div style={{ fontSize: 11, color: 'var(--t3)' }}>
          {lines.length} order line{lines.length === 1 ? '' : 's'} · pre-loaded on the tab when the party is seated, course-fired like the catering flow
        </div>
      </div>
      {lines.length ? (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'hidden', background: 'var(--bg2)' }}>
          {lines.map((l, i) => (
            <div key={l.id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderBottom: i === lines.length - 1 ? 'none' : `1px solid ${tintBg('var(--t1)', 5)}` }}>
              <span style={{ width: 22, flexShrink: 0, fontSize: 11, color: 'var(--t4)', ...mono }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {l.displayName || 'Item'}
                {(l.qtyPerCover || 1) !== 1 && <span style={{ color: 'var(--t3)', fontWeight: 400 }}> · {l.qtyPerCover}/cover</span>}
              </span>
              {l.isPreorderChoice && (
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.05em', flexShrink: 0 }}>pre-order</span>
              )}
              <span style={{
                flexShrink: 0, fontSize: 11, fontWeight: 700, color: 'var(--blu)', padding: '3px 9px', borderRadius: 20,
                background: tintBg('var(--blu)', 10), border: `1px solid ${tintBd('var(--blu)', 26)}`,
              }}>{COURSE_LABEL[l.course ?? 0] || `Course ${l.course}`}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: '14px 16px', borderRadius: 14, border: '1px dashed var(--bdr2)', color: 'var(--t3)', fontSize: 12, lineHeight: 1.5 }}>
          No order lines yet — this package books a table but pre-loads nothing on the tab.
        </div>
      )}

      {/* footnotes */}
      <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', padding: '12px 14px', borderRadius: 12, background: tintBg('var(--grn)', 7), border: `1px solid ${tintBd('var(--grn)', 24)}` }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--grn)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Money</div>
          <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.55, marginTop: 5 }}>
            Prepay and deposits post to the check as a tender line, so the closing balance is the difference, not the full amount. Refunds follow the same route back.
          </div>
        </div>
        <div style={{ flex: '1 1 260px', padding: '12px 14px', borderRadius: 12, background: tintBg('var(--blu)', 7), border: `1px solid ${tintBd('var(--blu)', 24)}` }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--blu)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Kitchen</div>
          <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.55, marginTop: 5 }}>
            Lines carry their course so the KDS fires them in order. Pre-orders taken at booking arrive on the ticket against the guest's name.
          </div>
        </div>
      </div>
    </div>
  );
}
