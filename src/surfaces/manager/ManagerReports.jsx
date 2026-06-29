// ManagerReports — today's takings (ex-VAT) + the live floor with the tested stalled rule.
// Single venue (multi-site stays in Back Office). Read-only for supervisors.
// Reads the shared snapshot from ctx (ManagerSurface polls once for every tab).
import { useState } from 'react';
import { classifyFloor } from '../../lib/manager/floor';
import { money } from '../../lib/currency';
import { Header, Hero, Stat, SectionTitle, mono } from './ui';

export default function ManagerReports({ ctx }) {
  const { flags, snap, snapErr: err } = ctx;
  const [nudged, setNudged] = useState({});

  const m = snap?.money;
  const floor = snap ? classifyFloor(snap.floor) : null;
  const cur = (v) => money(Number(v) || 0, m?.currency);

  return (
    <div>
      <Header title="Reports" sub={flags.reports_readonly ? "Today · view only" : "Today's takings + floor"} />
      {!snap && !err && <div style={{ color: 'var(--t3)', padding: 16, ...mono }}>Loading…</div>}
      {err && <div className="sv-glass" style={{ padding: 16, marginTop: 12, color: 'var(--t3)', fontSize: 13 }}>Couldn’t load takings ({err}). Pull again shortly.</div>}

      {m && (
        <>
          <div style={{ marginTop: 12 }}>
            <Hero label="Net sales today (ex-VAT)" value={cur(m.net)}
              sub={m.forecastPct != null ? `${m.forecastPct}% of ${cur(m.forecast)} forecast` : `${m.orders} orders`} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <Stat label="Orders" value={m.orders} />
            <Stat label="Avg check" value={cur(m.avgCheck)} />
            <Stat label="Tips" value={cur(m.tips)} />
            <Stat label="Labour %" value={m.labourPct != null ? `${m.labourPct}%` : '—'}
              tone={m.labourPct != null && m.labourTargetPct != null && m.labourPct > m.labourTargetPct * 100 ? 'var(--red)' : 'var(--t1)'} />
          </div>
        </>
      )}

      {floor && (
        <>
          <SectionTitle right={`${floor.dining.length + floor.held.length + floor.seated_no_order.length + floor.stalled.length} open`}>Live floor</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Stat label="Dining" value={floor.dining.length} tone="var(--grn)" />
            <Stat label="Seated · no order" value={floor.seated_no_order.length} tone={floor.seated_no_order.length ? 'var(--orn)' : 'var(--t1)'} />
            <Stat label="Held / bill" value={floor.held.length} />
            <Stat label="Stalled" value={floor.stalled.length} tone={floor.stalled.length ? 'var(--red)' : 'var(--grn)'} />
          </div>

          {floor.stalled.length > 0 && (
            <>
              <SectionTitle>Stalled · act now</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {floor.stalled.map((s) => (
                  <div key={s.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--red-b)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{s.label}{s.covers ? ` · ${s.covers} covers` : ''}</div>
                      <div style={{ fontSize: 11, color: 'var(--red)', ...mono }}>waiting {s.waitMins}m{s.server ? ` · ${s.server}` : ''}</div>
                    </div>
                    {!flags.reports_readonly && (
                      <button onClick={() => setNudged((n) => ({ ...n, [s.id]: true }))} disabled={!!nudged[s.id]} className="sv-glass"
                        style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--bdr)', cursor: nudged[s.id] ? 'default' : 'pointer', color: nudged[s.id] ? 'var(--grn)' : 'var(--acc)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit' }}>
                        {nudged[s.id] ? '✓ Nudged' : 'Nudge'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 16, lineHeight: 1.5, ...mono }}>
        Net sales are ex-VAT. This venue only — multi-site reporting lives in Back Office.
      </div>
    </div>
  );
}
