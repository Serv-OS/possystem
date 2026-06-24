// src/surfaces/waitlist/QueueBoard.jsx
//
// The Queue view: a per-band "current quote" strip (1-2 / 3-4 / 5-6 / 7+ with
// the live quote + how many suitable tables are open right now) followed by the
// live queue — active parties sorted by added_at, each a QueueCard.
//
// Quotes come from the pure estimator (perBandStrip) fed by a live "tables view"
// derived from the store's floor (the same mapping the store slice uses), plus the
// active queue. The store keeps each entry's `quoted` fresh via recomputeWaitlistQuotes
// on every floor/queue change; this view just renders.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { perBandStrip, isActive, DEFAULT_BANDS, DEFAULT_QUOTE_RULES } from '../../lib/waitlist/waitlist';
import QueueCard from './QueueCard';

const mono = { fontFamily: 'var(--font-mono)' };

// Map the store's floor → estimator table shape, excluding merged child seats.
// Mirrors store.waitlistTablesView() so the strip matches the per-entry quotes.
function tablesView(tables = []) {
  return tables
    .filter(t => !t.parentId)
    .map(t => ({
      cap: t.maxCovers,
      status: t.status === 'available' ? 'open' : t.status === 'clearing' ? 'clearing' : 'seated',
      section: t.section,
    }));
}

export default function QueueBoard({ loc, operator, onSeat }) {
  const waitlist = useStore(s => s.waitlist) || [];
  const tables = useStore(s => s.tables) || [];
  const cfg = useStore(s => s.waitlistConfig);

  const active = useMemo(
    () => waitlist.filter(e => isActive(e.status)).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)),
    [waitlist],
  );

  const bands = cfg?.bands?.length ? cfg.bands : DEFAULT_BANDS;
  const rules = cfg
    ? { buffer: cfg.buffer ?? 5, roundTo: cfg.roundTo ?? 5, maxQuote: cfg.maxQuote ?? 120, defaultTurn: cfg.defaultTurn ?? 60 }
    : DEFAULT_QUOTE_RULES;

  const tv = useMemo(() => tablesView(tables), [tables]);
  const waitingForEst = useMemo(() => active.map(e => ({ size: e.size, status: e.status, quoted: e.quoted })), [active]);
  const strip = useMemo(
    () => perBandStrip({ tables: tv, waiting: waitingForEst, bands, rules }),
    [tv, waitingForEst, bands, rules],
  );

  return (
    <div>
      {/* per-band quote strip */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${strip.length}, 1fr)`, gap: 10, marginBottom: 16 }}>
        {strip.map(b => (
          <div key={b.label} className="sv-tile" style={{ '--h': 150, padding: '12px 12px', borderRadius: 14, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', ...mono }}>{b.label}</div>
            <div style={{ fontFamily: 'Syne, Space Grotesk, sans-serif', fontSize: 26, fontWeight: 800, color: 'var(--uv)', lineHeight: 1.1, marginTop: 4 }}>
              {b.quote}<span style={{ fontSize: 12, color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>m</span>
            </div>
            <div style={{ fontSize: 10, marginTop: 3, color: b.openTables > 0 ? 'var(--grn)' : 'var(--t4)', ...mono }}>
              {b.openTables > 0 ? `${b.openTables} open` : 'none free'}
            </div>
          </div>
        ))}
      </div>

      {/* the live queue */}
      {active.length === 0 ? (
        <div className="sv-glass" style={{ padding: '34px 20px', textAlign: 'center', borderRadius: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t2)' }}>No one waiting</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 6, ...mono }}>Tap “Add party” to start the queue.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {active.map((e, i) => (
            <div key={e.id} style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: -2, top: 14, fontSize: 10, color: 'var(--t4)', fontWeight: 800, ...mono }}>{i + 1}</span>
              <QueueCard entry={e} onSeat={onSeat} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
