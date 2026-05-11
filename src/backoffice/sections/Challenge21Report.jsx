// v5.5.163 — Challenge 21 report: filterable by date range.
//
// Loads from ops.challenge_21_checks. One row per ID check; columns:
//   triggered_at · staff · first name · last initial · ID type · ID number · status
// Default range: last 7 days. Filter inputs at the top; CSV export below.

import { useEffect, useMemo, useState } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';

function isoDateInput(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export default function Challenge21Report({ locationId }) {
  const today  = new Date();
  const aWeek  = new Date(today.getTime() - 6 * 86400000);
  const [from, setFrom] = useState(isoDateInput(aWeek));
  const [to,   setTo]   = useState(isoDateInput(today));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [opsLocationId, setOpsLocationId] = useState(null);

  // v5.5.164: ops location id resolves directly via getLocationId() — same
  // pattern as every other BO section. No need to round-trip through
  // platform.locations.
  useEffect(() => {
    if (isMock) return;
    (async () => {
      const opsId = await getLocationId();
      if (opsId && opsId !== 'loc-demo') setOpsLocationId(opsId);
    })();
  }, []);

  const load = async () => {
    if (!opsLocationId || !supabase) return;
    setLoading(true); setError('');
    try {
      const fromTs = new Date(`${from}T00:00:00.000Z`).toISOString();
      const toTs   = new Date(`${to}T23:59:59.999Z`).toISOString();
      const { data, error: qErr } = await supabase
        .from('challenge_21_checks')
        .select('*')
        .eq('location_id', opsLocationId)
        .gte('triggered_at', fromTs)
        .lte('triggered_at', toTs)
        .order('triggered_at', { ascending: false });
      if (qErr) {
        if (/relation .* does not exist/i.test(qErr.message)) {
          setError('DB migration missing — run the Challenge 21 SQL to create the challenge_21_checks table.');
        } else {
          setError(qErr.message);
        }
        return;
      }
      setRows(data || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (opsLocationId) load(); /* eslint-disable-next-line */ }, [opsLocationId, from, to]);

  const stats = useMemo(() => {
    const completed = rows.filter(r => !r.cancelled);
    return {
      total: rows.length,
      completed: completed.length,
      cancelled: rows.length - completed.length,
    };
  }, [rows]);

  const exportCsv = () => {
    const headers = ['triggered_at', 'staff_name', 'first_name', 'last_initial', 'id_type', 'id_number', 'status', 'trigger_count'];
    const lines = [headers.join(',')];
    rows.forEach(r => {
      lines.push([
        new Date(r.triggered_at).toISOString(),
        csv(r.staff_name),
        csv(r.customer_first_name),
        csv(r.customer_last_name_initial),
        csv(r.id_type),
        csv(r.id_document_number),
        r.cancelled ? 'cancelled' : 'completed',
        r.trigger_count ?? '',
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `challenge-21_${from}_to_${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ marginTop: 24 }}>
      {/* Filters */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
        padding: 16, borderRadius: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)',
        marginBottom: 14,
      }}>
        <Field label="From">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle}/>
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle}/>
        </Field>
        <button onClick={load} disabled={loading} style={{
          padding: '10px 18px', borderRadius: 8, background: 'var(--acc)',
          color: '#0b0c10', border: 'none', fontWeight: 700, fontSize: 13,
          cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit',
        }}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button onClick={exportCsv} disabled={!rows.length} style={{
          padding: '10px 18px', borderRadius: 8,
          background: rows.length ? 'var(--bg3)' : 'var(--bg2)',
          color: rows.length ? 'var(--t1)' : 'var(--t4)',
          border: '1px solid var(--bdr2)', fontWeight: 700, fontSize: 13,
          cursor: rows.length ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
          marginLeft: 'auto',
        }}>⬇ Export CSV</button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <Stat label="Total checks" value={stats.total} colour="var(--acc)"/>
        <Stat label="Completed" value={stats.completed} colour="#22c55e"/>
        <Stat label="Cancelled" value={stats.cancelled} colour="#ef4444"/>
      </div>

      {error && (
        <div style={{
          padding: '12px 14px', borderRadius: 10, marginBottom: 14,
          background: '#fef2f2', border: '1px solid #fca5a5',
          color: '#991b1b', fontSize: 13,
        }}>{error}</div>
      )}

      {/* Table */}
      <div style={{
        borderRadius: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '160px 1fr 1fr 1fr 1fr 100px',
          padding: '12px 16px', fontSize: 11, fontWeight: 800,
          textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t4)',
          background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)',
        }}>
          <span>When</span>
          <span>Staff</span>
          <span>Customer</span>
          <span>ID type</span>
          <span>ID number</span>
          <span style={{ textAlign:'right' }}>Status</span>
        </div>
        {rows.length === 0 && !loading && (
          <div style={{ padding: '32px 16px', textAlign:'center', color:'var(--t4)', fontSize: 13 }}>
            No Challenge 21 checks recorded in this range.
          </div>
        )}
        {rows.map(r => (
          <div key={r.id} style={{
            display: 'grid', gridTemplateColumns: '160px 1fr 1fr 1fr 1fr 100px',
            padding: '12px 16px', fontSize: 13, color:'var(--t1)',
            borderBottom: '1px solid var(--bdr)', alignItems:'center',
          }}>
            <span style={{ fontFamily:'var(--font-mono)', fontSize: 11, color:'var(--t3)' }}>
              {new Date(r.triggered_at).toLocaleString('en-GB', { dateStyle:'short', timeStyle:'short' })}
            </span>
            <span>{r.staff_name || '—'}</span>
            <span style={{ fontWeight: 600 }}>{r.customer_first_name || '—'} {r.customer_last_name_initial || ''}{r.customer_last_name_initial ? '.' : ''}</span>
            <span style={{ fontSize: 12, color:'var(--t2)' }}>{r.id_type || '—'}</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize: 12, color:'var(--t2)' }}>{r.id_document_number || '—'}</span>
            <span style={{ textAlign:'right' }}>
              {r.cancelled ? (
                <span style={{ fontSize: 10, fontWeight: 800, padding:'3px 8px', borderRadius: 6,
                  background:'#fee2e2', color:'#991b1b' }}>CANCELLED</span>
              ) : (
                <span style={{ fontSize: 10, fontWeight: 800, padding:'3px 8px', borderRadius: 6,
                  background:'#dcfce7', color:'#14532d' }}>✓ LOGGED</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function csv(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function Field({ label, children }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</span>
      {children}
    </div>
  );
}

function Stat({ label, value, colour }) {
  return (
    <div style={{
      flex: 1, padding: 14, borderRadius: 12,
      background: 'var(--bg1)', border: '1px solid var(--bdr)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color: colour, marginTop: 4, fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

const inputStyle = {
  padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--bdr2)', background: 'var(--bg2)',
  color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit',
};
