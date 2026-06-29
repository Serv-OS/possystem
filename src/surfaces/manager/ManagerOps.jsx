// ManagerOps — read-only HACCP/ops visibility for the manager. REUSES the ops data layer (the same
// requireToken endpoints the ?mode=ops tablet uses), so it works on the paired device with no new
// backend. Staff still LOG checks on the Ops tablet; here the manager sees the state of play.
import { useEffect, useState } from 'react';
import { fetchTempUnits, fetchMaintenance, fetchExpectedDeliveries, fetchAlerts } from '../../lib/ops/data';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';

export default function ManagerOps({ ctx }) {
  const { loc } = ctx;
  const [s, setS] = useState({ loading: true, units: 0, openMaint: [], deliveries: 0, alerts: [] });
  useEffect(() => {
    let live = true;
    (async () => {
      const [u, m, d, a] = await Promise.all([
        fetchTempUnits(loc).catch(() => ({ data: [] })),
        fetchMaintenance(loc).catch(() => ({ data: [] })),
        fetchExpectedDeliveries(loc).catch(() => ({ data: [] })),
        fetchAlerts(loc, true).catch(() => ({ data: [] })),
      ]);
      if (!live) return;
      const openMaint = (m.data || []).filter((x) => !['resolved', 'cancelled'].includes(x.status));
      const deliveries = (d.data || []).filter((x) => !x.delivery || x.delivery.status === 'pending').length;
      setS({ loading: false, units: (u.data || []).length, openMaint, deliveries, alerts: a.data || [] });
    })();
    return () => { live = false; };
  }, [loc]);

  return (
    <div>
      <Header title="Ops" sub="Temps · opening / closing · deliveries" />
      {s.loading ? <div style={{ color: 'var(--t3)', padding: 16, ...mono }}>Loading…</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
            <Stat label="Temp units" value={s.units} />
            <Stat label="Deliveries to check" value={s.deliveries} tone={s.deliveries ? 'var(--orn)' : 'var(--grn)'} />
            <Stat label="Open maintenance" value={s.openMaint.length} tone={s.openMaint.length ? 'var(--red)' : 'var(--grn)'} />
            <Stat label="Active alerts" value={s.alerts.length} tone={s.alerts.length ? 'var(--red)' : 'var(--grn)'} />
          </div>

          {s.alerts.length > 0 && <>
            <SectionTitle>Alerts</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {s.alerts.slice(0, 6).map((a) => (
                <div key={a.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--red-b)' }}>
                  <Icon name="warn" size={18} style={{ color: 'var(--red)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{a.title || 'Alert'}</div>
                    {a.body && <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{a.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          </>}

          {s.openMaint.length > 0 && <>
            <SectionTitle>Open maintenance</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {s.openMaint.slice(0, 8).map((m) => (
                <div key={m.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14 }}>
                  <Icon name="wrench" size={18} style={{ color: 'var(--orn)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{m.title || 'Maintenance'}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{m.priority || 'normal'} · {m.status}</div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 16, lineHeight: 1.5, ...mono }}>
            Staff log checks on the Ops tablet (?mode=ops). This is your live read of the venue's compliance.
          </div>
        </>
      )}
    </div>
  );
}
