import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';  // v5.5.326: multi-currency

/**
 * Petty Cash ledger (v4.6.31).
 * Shows every drawer event: cash_sale auto-logged from payments, plus
 * manual entries (float, drop, expense, adjustment, drawer_open).
 * Running balance = signed sum: +cash_sale, +float, +adjustment, -drop,
 * -expense, 0 for drawer_open.
 */

const TYPE_META = {
  cash_sale:   { label: 'Cash sale',        sign: +1, color: 'var(--grn)', icon: '💵' },
  float:       { label: 'Float added',      sign: +1, color: 'var(--grn)', icon: '📥' },
  adjustment:  { label: 'Adjustment',       sign: +1, color: 'var(--acc)', icon: '⚖️' },
  drop:        { label: 'Cash drop',        sign: -1, color: 'var(--amb,#e8a020)', icon: '📤' },
  expense:     { label: 'Expense paid out', sign: -1, color: 'var(--red)', icon: '🧾' },
  drawer_open: { label: 'Drawer opened',    sign:  0, color: 'var(--t4)', icon: '🔓' },
};

const MANUAL_TYPES = ['float', 'drop', 'expense', 'adjustment'];

const fmtMoney = (n) => (n < 0 ? '−' : '') + money(Math.abs(Number(n) || 0));

const fmtTime = (ts) => new Date(ts).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

export default function PettyCash() {
  const entries = useStore(s => s.pettyCashEntries) || [];
  const staff = useStore(s => s.staff);
  // v4.6.36: per-drawer view
  const cashDrawers = useStore(s => s.cashDrawers) || [];
  // v4.6.32: gate the action buttons on the openDrawer permission so servers
  // without permission don't see live buttons they can't use. The store
  // also enforces this (see openCashDrawer).
  const canOpenDrawer = Array.isArray(staff?.permissions) && staff.permissions.includes('openDrawer');
  const addEntry = useStore(s => s.addPettyCashEntry);
  const openDrawer = useStore(s => s.openCashDrawer);

  const [showAdd, setShowAdd] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [filterDate, setFilterDate] = useState('today'); // today | 7d | all
  const [filterDrawer, setFilterDrawer] = useState('all'); // v4.6.36

  const filtered = useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
    return (entries || []).filter(e => {
      if (filterType !== 'all' && e.type !== filterType) return false;
      if (filterDate === 'today' && e.timestamp < startOfToday.getTime()) return false;
      if (filterDate === '7d'    && (now - e.timestamp) > 7 * dayMs) return false;
      // v4.6.36: per-drawer filter. Entries with no drawerId match 'all' only.
      if (filterDrawer !== 'all' && e.drawerId !== filterDrawer) return false;
      return true;
    });
  }, [entries, filterType, filterDate, filterDrawer]);

  const balance = useMemo(() =>
    filtered.reduce((s, e) => s + (TYPE_META[e.type]?.sign ?? 0) * (Number(e.amount) || 0), 0),
    [filtered]
  );
  const drawerCount = filtered.filter(e => ['cash_sale','drawer_open'].includes(e.type)).length;

  const handleManualPulse = () => {
    openDrawer({ type: 'drawer_open', amount: 0, reason: 'Manual open from Petty Cash', note: '' });
  };

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100 }}>

      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>Petty cash</div>
          <div style={{ fontSize:13, color:'var(--t3)', marginTop:4 }}>
            Running ledger of cash drawer events and manual entries. Auto-captures every cash payment.
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={handleManualPulse}
            disabled={!canOpenDrawer}
            title={canOpenDrawer ? 'Pulse the cash drawer now' : 'Open-drawer permission required'}
            style={{ padding:'10px 18px', borderRadius:10, background:'var(--bg3)', border:'1.5px solid var(--bdr2)', color: canOpenDrawer ? 'var(--t1)' : 'var(--t4)', fontWeight:700, fontFamily:'inherit', cursor: canOpenDrawer ? 'pointer' : 'not-allowed', fontSize:13, opacity: canOpenDrawer ? 1 : 0.5 }}>
            🔓 Open drawer
          </button>
          <button onClick={() => setShowAdd(true)}
            style={{ padding:'10px 18px', borderRadius:10, background:'var(--acc)', border:'none', color:'#fff', fontWeight:700, fontFamily:'inherit', cursor:'pointer', fontSize:13 }}>
            + Add entry
          </button>
        </div>
      </div>

      {/* Summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12, marginBottom:18 }}>
        <SummaryCard label="Running balance" value={fmtMoney(balance)} color={balance >= 0 ? 'var(--grn)' : 'var(--red)'} />
        <SummaryCard label="Entries in view" value={filtered.length} />
        <SummaryCard label="Drawer opens" value={drawerCount} />
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        <FilterGroup
          label="Date"
          options={[['today','Today'],['7d','Last 7 days'],['all','All time']]}
          value={filterDate}
          onChange={setFilterDate}
        />
        {cashDrawers.length > 0 && (
          <FilterGroup
            label="Drawer"
            options={[['all','All'],...cashDrawers.map(d => [d.id, d.name])]}
            value={filterDrawer}
            onChange={setFilterDrawer}
          />
        )}
        <FilterGroup
          label="Type"
          options={[['all','All'],...Object.entries(TYPE_META).map(([id, meta]) => [id, meta.label])]}
          value={filterType}
          onChange={setFilterType}
        />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div style={{ textAlign:'center', padding:'48px 20px', color:'var(--t4)', background:'var(--bg1)', border:'1px dashed var(--bdr2)', borderRadius:12 }}>
          <div style={{ fontSize:36, marginBottom:8 }}>💰</div>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--t3)' }}>No entries in this view</div>
          <div style={{ fontSize:12, marginTop:4 }}>Take a cash payment or add a manual entry to populate the ledger.</div>
        </div>
      ) : (
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
          {filtered.map((e, idx) => {
            const meta = TYPE_META[e.type] || { label: e.type, sign: 0, color: 'var(--t3)', icon: '•' };
            const signed = meta.sign * (Number(e.amount) || 0);
            return (
              <div key={e.id}
                style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px', borderBottom: idx < filtered.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                <div style={{ width:36, height:36, borderRadius:8, background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                  {meta.icon}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', display:'flex', gap:10, alignItems:'baseline' }}>
                    <span>{meta.label}</span>
                    {e.drawerId && (() => {
                      const _d = cashDrawers.find(d => d.id === e.drawerId);
                      return _d ? <span style={{ fontSize:11, fontWeight:600, color:'var(--acc)', background:'var(--acc-d)', padding:'1px 7px', borderRadius:5 }}>{_d.name}</span> : null;
                    })()}
                    {e.ref && <span style={{ fontSize:11, fontWeight:500, color:'var(--t4)' }}>· {e.ref}</span>}
                  </div>
                  <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                    {e.reason || '—'}
                  </div>
                  <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
                    {fmtTime(e.timestamp)} · {e.staff || 'System'}
                    {e.note ? ' · ' + e.note : ''}
                  </div>
                </div>
                <div style={{ fontSize:15, fontWeight:800, color: meta.sign === 0 ? 'var(--t4)' : meta.color, flexShrink:0, fontFamily:'var(--font-mono)' }}>
                  {meta.sign === 0 ? '—' : (signed >= 0 ? '+' : '') + fmtMoney(signed)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && <AddEntryModal onClose={() => setShowAdd(false)} onSave={(entry) => { addEntry({ ...entry, staff: staff?.name || 'Unknown', staffId: staff?.id || null }); setShowAdd(false); }} />}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, color = 'var(--t1)' }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
      <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:700, marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:800, color, fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

function FilterGroup({ label, options, value, onChange }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', marginRight:4 }}>{label}</div>
      {options.map(([id, lbl]) => (
        <button key={id} onClick={() => onChange(id)}
          style={{
            padding:'5px 10px', fontSize:12, borderRadius:6, fontFamily:'inherit', cursor:'pointer', fontWeight:600,
            background: value === id ? 'var(--acc-d)' : 'var(--bg3)',
            border: `1px solid ${value === id ? 'var(--acc)' : 'var(--bdr)'}`,
            color: value === id ? 'var(--acc)' : 'var(--t3)',
          }}>
          {lbl}
        </button>
      ))}
    </div>
  );
}

function AddEntryModal({ onClose, onSave }) {
  const [type, setType] = useState('float');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const meta = TYPE_META[type] || TYPE_META.float;
  const valid = Number(amount) > 0 && reason.trim().length > 0;

  const handleSubmit = () => {
    if (!valid) return;
    onSave({
      type, amount: Number(amount),
      reason: reason.trim(), note: note.trim(),
    });
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20,
        width:'100%', maxWidth:460, padding:'20px 22px', boxShadow:'var(--sh3)',
      }}>
        <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Add petty cash entry</div>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:18 }}>Logs to the ledger. Does not pulse the drawer.</div>

        <div style={{ marginBottom:14 }}>
          <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>Type</label>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:6 }}>
            {MANUAL_TYPES.map(id => {
              const m = TYPE_META[id];
              const on = type === id;
              return (
                <button key={id} onClick={() => setType(id)}
                  style={{
                    padding:'10px 12px', borderRadius:8, fontFamily:'inherit', cursor:'pointer', fontSize:13, fontWeight:700,
                    background: on ? 'var(--bg3)' : 'var(--bg2)',
                    border: `1.5px solid ${on ? m.color : 'var(--bdr)'}`,
                    color: on ? m.color : 'var(--t3)',
                    display:'flex', alignItems:'center', gap:8, justifyContent:'flex-start',
                  }}>
                  <span style={{ fontSize:16 }}>{m.icon}</span> {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'120px 1fr', gap:10, marginBottom:14 }}>
          <div>
            <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>Amount</label>
            <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"
              style={{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1.5px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'var(--font-mono)', fontSize:15, fontWeight:700 }} />
          </div>
          <div>
            <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>Reason *</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Opening float, Bank drop, Milk run"
              style={{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1.5px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', fontSize:14 }} />
          </div>
        </div>

        <div style={{ marginBottom:18 }}>
          <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>Note (optional)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Anything else to record"
            style={{ width:'100%', padding:'9px 12px', borderRadius:8, border:'1.5px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit', fontSize:13 }} />
        </div>

        <div style={{ display:'flex', gap:8 }}>
          <button onClick={onClose} style={{ flex:1, padding:'10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontFamily:'inherit', cursor:'pointer', fontWeight:600 }}>Cancel</button>
          <button onClick={handleSubmit} disabled={!valid}
            style={{
              flex:2, padding:'10px', borderRadius:8, border:'none',
              background: valid ? meta.color : 'var(--bg4)',
              color: valid ? '#fff' : 'var(--t4)',
              fontFamily:'inherit', cursor: valid ? 'pointer' : 'not-allowed', fontWeight:700,
              opacity: valid ? 1 : 0.6,
            }}>
            Add {meta.label.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  );
}
