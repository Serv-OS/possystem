// ManagerKitchen — live stock to order: items below par / reorder, grouped by supplier (one PO each).
// Read-only (greenfield stock: inventory_items + par_levels, via manager-snapshot). The pure decisions
// live in src/lib/manager/kitchen.js. Raising a PO + recording batch cooks (prep_schedule) are WRITES
// → next slice. This is NOT the live KDS ticket rail — that stays as-is.
import { belowPar, bySupplier } from '../../lib/manager/kitchen';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

export default function ManagerKitchen({ ctx }) {
  const { snap, snapErr: err } = ctx;

  const items = snap?.kitchen?.items || [];
  const short = belowPar(items);
  const groups = bySupplier(items);
  const supplierNames = Object.keys(groups).sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));

  return (
    <div>
      <Header title="Kitchen" sub="Stock to order" />
      {!snap && !err && <div style={{ color: 'var(--t3)', padding: 16, ...mono }}>Loading…</div>}
      {err && <div className="sv-glass" style={{ padding: 16, marginTop: 12, color: 'var(--t3)', fontSize: 13 }}>Couldn’t load stock ({err}).</div>}

      {snap && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <Stat label="To order" value={short.length} tone={short.length ? 'var(--red)' : 'var(--grn)'} />
            <Stat label="Suppliers" value={supplierNames.length} />
          </div>

          {short.length === 0 && (
            <div className="sv-glass" style={{ padding: 20, marginTop: 12, textAlign: 'center' }}>
              <Icon name="check" size={24} style={{ color: 'var(--grn)' }} />
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>Everything’s at par</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>No tracked item is below par or its reorder point.</div>
            </div>
          )}

          {supplierNames.map((sup) => (
            <div key={sup}>
              <SectionTitle right={`${groups[sup].length} item${groups[sup].length === 1 ? '' : 's'}`}>{sup}</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups[sup].map((i) => (
                  <div key={i.itemId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: i.belowReorder ? '1px solid var(--red-b)' : '1px solid var(--bdr)' }}>
                    <Icon name="inventory" size={16} style={{ color: i.belowReorder ? 'var(--red)' : 'var(--t3)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{i.name}</div>
                      <div style={{ fontSize: 11, color: i.belowReorder ? 'var(--red)' : 'var(--t3)', ...mono }}>
                        {i.onHand} on hand · par {i.par ?? '—'}{i.belowReorder ? ' · below reorder' : ''}
                      </div>
                    </div>
                    {i.shortfall > 0 && <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--orn)', ...mono }}>+{i.shortfall}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="sv-glass" style={{ padding: 16, marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Raise PO + batch cooks — next</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
              Sending a purchase order per supplier and ticking off today’s batch cooks land next — they write to stock and prep records, so they go through the secure write path.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
