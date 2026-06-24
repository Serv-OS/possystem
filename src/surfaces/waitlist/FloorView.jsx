// src/surfaces/waitlist/FloorView.jsx
//
// The Floor view: every table grouped by section, colour-coded by status, with the
// "seat the best-fit party" flow inverted from the queue side. Tap an OPEN table →
// a sheet of waiting parties that fit it (best-fit first: smallest spare seats,
// honouring a section preference) → seat one straight into that table.
//
// Reads the floor + queue from the store; seats via store.seatWaitlistParty(id, tableId)
// (which calls seatTable + records quote accuracy + recomputes quotes). Child seats
// of a merged table (parentId set) are excluded so a merge shows as one table.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { isActive, bandFor } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';

const mono = { fontFamily: 'var(--font-mono)' };

const TABLE_STATE = {
  available: { dot: 'var(--grn)', label: 'Open', col: 'var(--grn)' },
  open:      { dot: 'var(--orn)', label: 'Seated', col: 'var(--orn)' },     // store "open" = an active dine-in session
  occupied:  { dot: 'var(--orn)', label: 'Seated', col: 'var(--orn)' },
  clearing:  { dot: 'var(--amber, var(--orn))', label: 'Clearing', col: 'var(--amber, var(--orn))' },
  reserved:  { dot: 'var(--uv)', label: 'Reserved', col: 'var(--uv)' },
  sent:      { dot: 'var(--orn)', label: 'Seated', col: 'var(--orn)' },
};
const isFree = (t) => t.status === 'available';

export default function FloorView({ loc, onSeatEntry }) {
  const tables = (useStore(s => s.tables) || []).filter(t => !t.parentId);
  const waitlist = useStore(s => s.waitlist) || [];
  const seatParty = useStore(s => s.seatWaitlistParty);
  const [pickFor, setPickFor] = useState(null); // a free table awaiting a party choice

  const active = useMemo(
    () => waitlist.filter(e => isActive(e.status)).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)),
    [waitlist],
  );

  // sections in stable order
  const sections = useMemo(() => {
    const order = []; const seen = new Set();
    tables.forEach(t => { const s = t.section || 'main'; if (!seen.has(s)) { seen.add(s); order.push(s); } });
    return order;
  }, [tables]);

  const openCount = tables.filter(isFree).length;

  // best-fit waiting parties for a given table: must fit (cap >= size), section pref
  // honoured if set, then smallest spare seats first, then longest-waiting.
  const candidatesFor = (t) => active
    .filter(e => t.maxCovers >= e.size && (!e.sectionPref || e.sectionPref === t.section))
    .sort((a, b) => (t.maxCovers - a.size) - (t.maxCovers - b.size) || (a.addedAt || 0) - (b.addedAt || 0));

  const seat = async (entry, table) => {
    setPickFor(null);
    await seatParty?.(entry.id, table.id);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 11, color: 'var(--t3)', ...mono }}>
        <span style={{ color: 'var(--grn)', fontWeight: 700 }}>{openCount} open</span> · {tables.length} tables · tap an open table to seat the next fit
      </div>

      {sections.map(sec => {
        const secTables = tables.filter(t => (t.section || 'main') === sec);
        return (
          <div key={sec} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8, ...mono }}>{sec}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))', gap: 10 }}>
              {secTables.map(t => {
                const meta = TABLE_STATE[t.status] || TABLE_STATE.occupied;
                const free = isFree(t);
                const fits = free ? candidatesFor(t).length : 0;
                return (
                  <button
                    key={t.id}
                    onClick={() => free && setPickFor(t)}
                    disabled={!free}
                    className="sv-tile"
                    style={{ '--h': free ? 150 : 30, position: 'relative', padding: 14, borderRadius: 14, textAlign: 'left', cursor: free ? 'pointer' : 'default', opacity: free ? 1 : 0.62, color: 'var(--t1)', fontFamily: 'inherit', minHeight: 92 }}
                  >
                    <span style={{ position: 'absolute', top: 11, right: 11, width: 9, height: 9, borderRadius: 999, background: meta.dot, boxShadow: `0 0 8px ${meta.dot}` }} />
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{t.label}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--t3)', marginTop: 2, ...mono }}>{t.maxCovers} seats</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: meta.col, marginTop: 10, ...mono }}>
                      {free ? (fits ? `Seat next (${fits})` : 'Open') : meta.label}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {pickFor && (
        <SeatPicker
          table={pickFor}
          candidates={candidatesFor(pickFor)}
          onPick={(e) => seat(e, pickFor)}
          onClose={() => setPickFor(null)}
        />
      )}
    </div>
  );
}

// Sheet of waiting parties that fit the chosen table; best-fit ordered.
function SeatPicker({ table, candidates, onPick, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(8,9,12,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="sv-glass" style={{ width: '100%', maxWidth: 520, borderRadius: '22px 22px 0 0', padding: '20px 18px 26px', maxHeight: '78vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 800 }}>Seat at {table.label}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{table.maxCovers} seats · {table.section || 'main'}</div>
          </div>
          <button onClick={onClose} className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)' }}><Icon name="close" size={17} /></button>
        </div>
        {candidates.length === 0 ? (
          <div style={{ padding: '22px 8px', textAlign: 'center', color: 'var(--t3)', fontSize: 13, ...mono }}>No waiting party fits this table.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {candidates.map((e, i) => {
              const returning = !!e.customerId || !!e.returning;
              return (
                <button key={e.id} onClick={() => onPick(e)} className="sv-tile" style={{ '--h': returning ? 280 : 150, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 13, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--inset)', flexShrink: 0 }}>
                    <span style={{ fontFamily: 'Syne, Space Grotesk, sans-serif', fontSize: 18, fontWeight: 800, color: returning ? 'var(--uv)' : 'var(--grn)' }}>{e.size}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 800 }}>{e.name || 'Guest'}{i === 0 ? <span style={{ fontSize: 9.5, color: 'var(--grn)', marginLeft: 8, fontWeight: 700, ...mono }}>BEST FIT</span> : null}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--t3)', ...mono }}>band {bandFor(e.size).label} · {table.maxCovers - e.size} spare</div>
                  </div>
                  <Icon name="dinein" size={18} style={{ color: 'var(--grn)' }} />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
