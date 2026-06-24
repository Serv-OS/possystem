// src/surfaces/waitlist/SeatModal.jsx
//
// Seat modal — opened from a queue card's "Seat" / "Seat now" action for a specific
// waiting party. Lists the OPEN tables that fit the party (best-fit first: smallest
// spare seats, section preference honoured), grouped by section. Picking a table seats
// the party there via store.seatWaitlistParty(id, tableId) — which seats the floor
// table, records quote accuracy (quoted vs actual), and recomputes the rest of the
// queue. A "seat without assigning a table" fallback marks them seated with no table.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { bandFor } from '../../lib/waitlist/waitlist';
import { Icon } from '../../components/ServOSIcons';

const mono = { fontFamily: 'var(--font-mono)' };
const isFree = (t) => t.status === 'available';

export default function SeatModal({ entry, operator, onClose }) {
  const tables = (useStore(s => s.tables) || []).filter(t => !t.parentId);
  const seatParty = useStore(s => s.seatWaitlistParty);

  // open tables that fit, best-fit ordered, section pref first
  const fits = useMemo(() => {
    const cap = tables.filter(t => isFree(t) && t.maxCovers >= entry.size);
    return cap.sort((a, b) => {
      const aPref = entry.sectionPref ? (a.section === entry.sectionPref ? 0 : 1) : 0;
      const bPref = entry.sectionPref ? (b.section === entry.sectionPref ? 0 : 1) : 0;
      if (aPref !== bPref) return aPref - bPref;
      return (a.maxCovers - entry.size) - (b.maxCovers - entry.size);
    });
  }, [tables, entry.size, entry.sectionPref]);

  const seat = async (tableId) => { onClose?.(); await seatParty?.(entry.id, tableId); };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(8,9,12,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="sv-glass" style={{ width: '100%', maxWidth: 520, borderRadius: '22px 22px 0 0', padding: '20px 18px 26px', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'var(--inset)', flexShrink: 0 }}>
            <span style={{ fontFamily: 'Syne, Space Grotesk, sans-serif', fontSize: 20, fontWeight: 800, color: 'var(--grn)' }}>{entry.size}</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 800 }}>Seat {entry.name || 'Guest'}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
              party of {entry.size} · band {bandFor(entry.size).label}{entry.sectionPref ? ` · prefers ${entry.sectionPref}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="sv-glass" style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--t1)', border: '1px solid var(--bdr)' }}><Icon name="close" size={17} /></button>
        </div>

        <div style={{ fontSize: 10.5, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8, ...mono }}>
          {fits.length ? `${fits.length} open table${fits.length > 1 ? 's' : ''} fit` : 'No open table fits'}
        </div>

        {fits.length === 0 ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', color: 'var(--t3)', fontSize: 12.5, ...mono }}>
            Nothing free right now. You can still seat them without a table.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fits.map((t, i) => (
              <button key={t.id} onClick={() => seat(t.id)} className="sv-tile" style={{ '--h': 150, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderRadius: 13, cursor: 'pointer', color: 'var(--t1)', textAlign: 'left', fontFamily: 'inherit' }}>
                <div style={{ width: 42, height: 42, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--grn-d)', color: 'var(--grn)', flexShrink: 0 }}><Icon name="dinein" size={20} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800 }}>{t.label}{i === 0 ? <span style={{ fontSize: 9.5, color: 'var(--grn)', marginLeft: 8, fontWeight: 700, ...mono }}>BEST FIT</span> : null}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--t3)', ...mono }}>{t.maxCovers} seats · {t.section || 'main'} · {t.maxCovers - entry.size} spare</div>
                </div>
                <Icon name="chevron" size={18} style={{ color: 'var(--t3)' }} />
              </button>
            ))}
          </div>
        )}

        <button onClick={() => seat(null)} className="btn btn-ghost" style={{ width: '100%', padding: 14, marginTop: 14, fontSize: 14, fontWeight: 700, borderRadius: 13 }}>
          Seat without assigning a table
        </button>
      </div>
    </div>
  );
}
