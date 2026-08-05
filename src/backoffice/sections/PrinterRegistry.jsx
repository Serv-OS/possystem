import { useState, useEffect } from 'react';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { useStore } from '../../store';
import { reportSave } from '../../lib/saveHealth';
import { printService } from '../../lib/printer';

const MODELS = [
  // ── Sunmi ──────────────────────────────────────────────────────────────────
  { id:'sunmi-nt311',     label:'Sunmi NT311',              icon:'🖨', desc:'80mm cloud printer — WiFi/LAN', brand:'Sunmi' },
  { id:'sunmi-nt310',     label:'Sunmi NT310',              icon:'🖨', desc:'58mm cloud printer — WiFi/LAN', brand:'Sunmi' },
  // ── Epson TM series ────────────────────────────────────────────────────────
  { id:'epson-tm-t88',    label:'Epson TM-T88V / VI / VII', icon:'🖨', desc:'80mm LAN — industry standard',   brand:'Epson' },
  { id:'epson-tm-t20',    label:'Epson TM-T20 II / III',    icon:'🖨', desc:'80mm LAN — budget option',       brand:'Epson' },
  { id:'epson-tm-m30',    label:'Epson TM-m30 / m30II',     icon:'🖨', desc:'80mm LAN — compact/tablet',      brand:'Epson' },
  { id:'epson-tm-t82',    label:'Epson TM-T82 III',         icon:'🖨', desc:'80mm LAN — entry level',          brand:'Epson' },
  { id:'epson-tm-t70',    label:'Epson TM-T70 II',          icon:'🖨', desc:'80mm LAN — under-counter',        brand:'Epson' },
  // ── Star TSP / mC-Print ────────────────────────────────────────────────────
  { id:'star-tsp143',     label:'Star TSP143III LAN',       icon:'🖨', desc:'80mm LAN — popular modern',       brand:'Star' },
  { id:'star-tsp100',     label:'Star TSP100 ECO / futurePRNT', icon:'🖨', desc:'80mm LAN — very common',      brand:'Star' },
  { id:'star-tsp654',     label:'Star TSP654II LAN',        icon:'🖨', desc:'80mm LAN — kitchen workhorse',    brand:'Star' },
  { id:'star-tsp700',     label:'Star TSP700II LAN',        icon:'🖨', desc:'80mm LAN — two-colour capable',   brand:'Star' },
  { id:'star-tsp800',     label:'Star TSP800II LAN',        icon:'🖨', desc:'112mm LAN — wider labels',        brand:'Star' },
  { id:'star-mcprint3',   label:'Star mC-Print3',           icon:'🖨', desc:'80mm LAN — newest Star',          brand:'Star' },
  { id:'star-mcprint2',   label:'Star mC-Print2',           icon:'🖨', desc:'58mm LAN',                         brand:'Star' },
  // ── Bixolon ────────────────────────────────────────────────────────────────
  { id:'bixolon-srp350',  label:'Bixolon SRP-350III',       icon:'🖨', desc:'80mm LAN',                         brand:'Bixolon' },
  { id:'bixolon-srpq300', label:'Bixolon SRP-Q300',         icon:'🖨', desc:'80mm LAN — compact',               brand:'Bixolon' },
  // ── Citizen ────────────────────────────────────────────────────────────────
  { id:'citizen-cts310',  label:'Citizen CT-S310II',        icon:'🖨', desc:'80mm LAN',                         brand:'Citizen' },
  { id:'citizen-cte351',  label:'Citizen CT-E351',          icon:'🖨', desc:'80mm LAN',                         brand:'Citizen' },
  // ── Budget / generic ──────────────────────────────────────────────────────
  { id:'xprinter-xp80',   label:'Xprinter XP-T80 / N160II', icon:'🖨', desc:'80mm LAN — budget ESC/POS',        brand:'Xprinter' },
  { id:'generic',         label:'Other / Generic ESC/POS',  icon:'🖨', desc:'Any ESC/POS printer on TCP 9100',  brand:'Generic' },
];

// Only network is currently supported end-to-end (Android NetworkPrinter.java + iOS NetworkPrinter.swift).
// Bluetooth and USB require additional native bridges — mark as disabled until built.
const CONN_TYPES = [
  { id:'network',   label:'WiFi / Ethernet', icon:'🌐', placeholder:'192.168.1.100',              enabled:true,  note:'Recommended — works on all supported printers' },
  { id:'bluetooth', label:'Bluetooth',       icon:'🔵', placeholder:'e.g. AA:BB:CC:DD:EE:FF',     enabled:false, note:'Coming soon — native BT bridge not yet built' },
  { id:'usb',       label:'USB',             icon:'🔌', placeholder:'Auto-detected',              enabled:false, note:'Coming soon — requires device-specific driver' },
];

const ROLES = [
  { id:'receipt',    label:'Customer receipts', icon:'🧾' },
  { id:'kitchen',    label:'Kitchen / production', icon:'🍽' },
  { id:'bar',        label:'Bar tickets', icon:'🍸' },
  { id:'label',      label:'Label printer', icon:'🏷' },
  { id:'general',    label:'General purpose', icon:'🖨' },
];

const PAPER = [
  { id:80, label:'80mm' },
  { id:58, label:'58mm' },
];

const EMPTY = { name:'', model:'sunmi-nt311', connectionType:'network', address:'', paperWidth:80, roles:['receipt'], location:'', cashDrawerAttached:false };

function loadPrinters() {
  try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; }
}
async function loadPrintersFromDB() {
  if (isMock || !supabase) return loadPrinters();
  try {
    const locationId = await getLocationId();
    if (!locationId) return loadPrinters();
    const { data } = await supabase.from('printers').select('*').eq('location_id', locationId).order('created_at');
    if (data) {
      const list = data.map(r => ({ id:r.id, name:r.name, model:r.meta?.model||'generic', connectionType:r.connection, address:r.ip, port:r.port||9100, paperWidth:r.paper_width||80, roles:r.meta?.roles||['receipt'], location:r.meta?.location||'', status:r.meta?.status||'unknown', addedAt:r.meta?.addedAt||Date.now(), cashDrawerAttached:!!r.meta?.cashDrawerAttached }));
      localStorage.setItem('rpos-printers', JSON.stringify(list)); // keep local cache for POS
      return list;
    }
  } catch(e) { console.warn('printers load failed', e); }
  return loadPrinters();
}
// Both DB helpers return { error } so the caller can revert the list + its localStorage
// mirror. They used to console.warn and carry on, so a printer could live in this browser's
// cache all week and be missing from every other terminal.
async function savePrinterToDB(printer) {
  if (isMock || !supabase) return { error: null };
  const locationId = await getLocationId().catch(() => null);
  if (!locationId) return { error: new Error('Could not resolve the location for this venue') };
  const { data, error } = await supabase.from('printers').upsert({ id:printer.id, location_id:locationId, name:printer.name, type:'escpos', connection:printer.connectionType, ip:printer.address||null, port:printer.port||9100, paper_width:printer.paperWidth||80, meta:{ model:printer.model, roles:printer.roles, location:printer.location, status:printer.status, addedAt:printer.addedAt, cashDrawerAttached:!!printer.cashDrawerAttached }, updated_at:new Date().toISOString() }).select('id');
  if (error) return { error };
  if (!data || data.length === 0) return { error: new Error('Printer write matched 0 rows — RLS blocked it') };
  return { error: null };
}
async function deletePrinterFromDB(id) {
  if (isMock || !supabase) return { error: null };
  const { data, error } = await supabase.from('printers').delete().eq('id', id).select('id');
  if (error) return { error };
  // A DELETE that RLS filters out reports success with zero rows — which is also what a
  // printer that never reached the DB looks like. Probe before calling it a failure.
  if (!data || data.length === 0) {
    const { data: still } = await supabase.from('printers').select('id').eq('id', id).maybeSingle();
    if (still) return { error: new Error('Printer delete matched 0 rows — RLS blocked it') };
  }
  return { error: null };
}
function savePrinters(list) {
  localStorage.setItem('rpos-printers', JSON.stringify(list));
  window.dispatchEvent(new Event('rpos-printers-updated'));
}

const S = {
  page: { padding:'32px 40px', maxWidth:900 },
  h1: { fontSize:22, fontWeight:800, marginBottom:4, color:'var(--t1)' },
  sub: { fontSize:13, color:'var(--t3)', marginBottom:32 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:22, marginBottom:14 },
  label: { fontSize:12, fontWeight:600, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.04em' },
  input: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  row: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 },
  btn: { padding:'9px 18px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
};

function statusDot(status) {
  const c = status === 'online' ? 'var(--grn)' : status === 'offline' ? 'var(--red)' : 'var(--t4)';
  return <div style={{ width:8, height:8, borderRadius:'50%', background:c, flexShrink:0 }}/>;
}

function PrinterForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial || EMPTY);
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const model = MODELS.find(m => m.id === form.model) || MODELS[0];
  const conn  = CONN_TYPES.find(c => c.id === form.connectionType) || CONN_TYPES[0];

  const toggleRole = (rid) => {
    f('roles', form.roles?.includes(rid) ? form.roles.filter(r => r !== rid) : [...(form.roles || []), rid]);
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)', marginBottom:18 }}>
        {initial?.id ? 'Edit printer' : 'Add printer'}
      </div>

      <div style={S.row}>
        <div>
          <label style={S.label}>Printer name *</label>
          <input style={S.input} value={form.name} onChange={e=>f('name',e.target.value)} placeholder="e.g. Kitchen Printer, Bar Receipt"/>
        </div>
        <div>
          <label style={S.label}>Location / area</label>
          <input style={S.input} value={form.location} onChange={e=>f('location',e.target.value)} placeholder="e.g. Main kitchen, Bar"/>
        </div>
      </div>

      {/* Model picker — brand then model dropdown (replaces 20-button wall) */}
      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Printer model</label>
        {(() => {
          const brands = [...new Set(MODELS.map(m => m.brand))];
          const currentBrand = model.brand;
          const modelsForBrand = MODELS.filter(m => m.brand === currentBrand);
          const onBrandChange = (newBrand) => {
            // Pick first model in the new brand
            const firstInBrand = MODELS.find(m => m.brand === newBrand);
            if (firstInBrand) f('model', firstInBrand.id);
          };
          const selectStyle = { ...S.input, cursor:'pointer', appearance:'none', WebkitAppearance:'none',
            backgroundImage:`url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23888' d='M6 8L0 0h12z'/%3E%3C/svg%3E")`,
            backgroundRepeat:'no-repeat', backgroundPosition:'right 12px center', paddingRight:32 };
          return (
            <div style={{ display:'grid', gridTemplateColumns:'minmax(140px, 1fr) 2fr', gap:8 }}>
              <select value={currentBrand} onChange={e => onBrandChange(e.target.value)} style={selectStyle}>
                {brands.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={form.model} onChange={e => f('model', e.target.value)} style={selectStyle}>
                {modelsForBrand.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          );
        })()}
        <div style={{ fontSize:11, color:'var(--t3)', marginTop:8 }}>{model.desc}</div>
      </div>

      {/* Connection type */}
      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Connection</label>
        <div style={{ display:'flex', gap:6, marginBottom:10 }}>
          {CONN_TYPES.map(c => {
            const isSelected = form.connectionType === c.id;
            const isDisabled = !c.enabled;
            return (
              <button
                key={c.id}
                onClick={() => !isDisabled && f('connectionType', c.id)}
                disabled={isDisabled}
                title={c.note}
                style={{
                  padding:'7px 14px', borderRadius:8,
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  fontFamily:'inherit', fontSize:12, fontWeight:600,
                  background: isDisabled ? 'var(--bg2)' : (isSelected ? 'var(--acc-d)' : 'var(--bg3)'),
                  border: `1.5px solid ${isSelected ? 'var(--acc)' : 'var(--bdr)'}`,
                  color: isDisabled ? 'var(--t5)' : (isSelected ? 'var(--acc)' : 'var(--t2)'),
                  opacity: isDisabled ? 0.55 : 1,
                  position:'relative',
                }}>
                {c.icon} {c.label}
                {isDisabled && <span style={{ marginLeft:6, fontSize:9, fontWeight:700, color:'var(--t5)', textTransform:'uppercase', letterSpacing:0.5 }}>Soon</span>}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize:11, color:'var(--t4)', marginBottom:6 }}>
          {conn.note}
        </div>

        {form.connectionType !== 'usb' && (
          <div style={{ marginBottom:14 }}>
            <label style={S.label}>{form.connectionType === 'bluetooth' ? 'Bluetooth address' : 'IP address'}</label>
            <input style={S.input} value={form.address} onChange={e=>f('address',e.target.value)} placeholder={conn.placeholder}/>
            {form.connectionType === 'network' && (
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:4 }}>Standard ESC/POS port 9100 is used automatically</div>
            )}
          </div>
        )}
      </div>

      {/* Paper width */}
      <div style={{ marginBottom:14 }}>
        <label style={S.label}>Paper width</label>
        <div style={{ display:'flex', gap:6 }}>
          {PAPER.map(p => (
            <button key={p.id} onClick={() => f('paperWidth', p.id)} style={{
              padding:'7px 16px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:600,
              background: form.paperWidth === p.id ? 'var(--acc-d)' : 'var(--bg3)',
              border: `1.5px solid ${form.paperWidth === p.id ? 'var(--acc)' : 'var(--bdr)'}`,
              color: form.paperWidth === p.id ? 'var(--acc)' : 'var(--t2)',
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* Roles */}
      <div style={{ marginBottom:20 }}>
        <label style={S.label}>Used for</label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {ROLES.map(r => {
            const on = form.roles?.includes(r.id);
            return (
              <button key={r.id} onClick={() => toggleRole(r.id)} style={{
                padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:600,
                background: on ? 'var(--acc-d)' : 'var(--bg3)',
                border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`,
                color: on ? 'var(--acc)' : 'var(--t3)',
              }}>{r.icon} {r.label}</button>
            );
          })}
        </div>
      </div>

      {/* v4.6.30: Cash drawer. When ticked, cash payments that route through
          a printer with this flag will automatically pulse the drawer open. */}
      <div style={{ marginBottom:20 }}>
        <label style={S.label}>Cash drawer</label>
        <label style={{ display:'flex', alignItems:'center', gap:10, cursor:'pointer', padding:'10px 12px', borderRadius:8, background:'var(--bg3)', border:`1.5px solid ${form.cashDrawerAttached?'var(--acc)':'var(--bdr)'}` }}>
          <input type="checkbox" checked={!!form.cashDrawerAttached} onChange={e => f('cashDrawerAttached', e.target.checked)} style={{ width:18, height:18, accentColor:'var(--acc)', cursor:'pointer' }}/>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color: form.cashDrawerAttached ? 'var(--acc)' : 'var(--t2)' }}>Cash drawer is wired to this printer</div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
              Ejects the drawer on every cash payment (ESC p pulse). You can also pulse it manually from the POS.
            </div>
          </div>
        </label>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button onClick={onCancel} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)' }}>Cancel</button>
        <button onClick={() => onSave(form)} disabled={!form.name.trim()} style={{ ...S.btn, background: form.name.trim() ? 'var(--acc)' : 'var(--bg4)', color: form.name.trim() ? '#fff' : 'var(--t4)', opacity: form.name.trim() ? 1 : .5 }}>
          {initial?.id ? 'Save changes' : 'Add printer'}
        </button>
      </div>
    </div>
  );
}

export default function PrinterRegistry() {
  const showToast = useStore(s => s.showToast);
  const [printers, setPrinters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [testing, setTesting] = useState({});
  const [testResult, setTestResult] = useState({});

  useEffect(() => {
    loadPrintersFromDB().then(list => { setPrinters(list); setLoading(false); });
  }, []);

  const persist = (list) => {
    setPrinters(list);
    savePrinters(list); // keep local cache
  };

  const handleSave = async (form) => {
    const printer = form.id
      ? { ...form, port:9100 }
      : { ...form, port:9100, id:`prn-${Date.now()}`, status:'unknown', addedAt:Date.now() };
    const previous = printers;
    const updated = form.id
      ? printers.map(p => p.id === printer.id ? printer : p)
      : [...printers, printer];

    // Applied first so the list feels instant — and rolled back below if the row never
    // landed, because persist() also rewrites the localStorage cache the POS prints from.
    persist(updated);
    setShowForm(false);
    setEditId(null);

    const { error } = await savePrinterToDB(printer);
    reportSave('printer', error);
    if (error) {
      persist(previous);
      showToast?.(`"${printer.name}" was NOT saved — fix the connection and try again`, 'error');
      return;
    }
    showToast?.(`"${printer.name}" saved`, 'success');
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this printer?')) return;
    const printer = printers.find(p => p.id === id);
    const { error } = await deletePrinterFromDB(id);
    reportSave('printer delete', error);
    if (error) {
      showToast?.(`"${printer?.name || 'Printer'}" was NOT removed — it is still registered`, 'error');
      return;
    }
    persist(printers.filter(p => p.id !== id));
    showToast?.(`"${printer?.name || 'Printer'}" removed`, 'info');
  };

  const handleTest = async (printer) => {
    setTesting(t => ({ ...t, [printer.id]: true }));
    setTestResult(r => ({ ...r, [printer.id]: null }));
    try {
      const result = await printService.printTestPage(printer);
      const jobId = result?.jobId;
      if (jobId && printService.watchJob) {
        setTestResult(r => ({ ...r, [printer.id]: 'queued' }));
        await new Promise((resolve) => {
          const unsub = printService.watchJob(jobId, async (updated) => {
            if (updated.status === 'done') {
              await printService.recordPrinterHealth(printer.id, 'online');
              persist(printers.map(p => p.id === printer.id ? { ...p, status:'online', lastSeen:Date.now() } : p));
              setTestResult(r => ({ ...r, [printer.id]: 'online' }));
              unsub(); resolve();
            } else if (updated.status === 'failed') {
              const err = updated.error_message || 'Agent reported failure';
              await printService.recordPrinterHealth(printer.id, 'error', err);
              persist(printers.map(p => p.id === printer.id ? { ...p, status:'offline' } : p));
              setTestResult(r => ({ ...r, [printer.id]: 'agent-failed', error: err }));
              unsub(); resolve();
            }
          });
          setTimeout(() => {
            unsub();
            // Timeout — agent not responding. Don't mark offline yet — job may still be in queue
            setTestResult(r => ({ ...r, [printer.id]: 'timeout' }));
            resolve();
          }, 20000);
        });
      } else {
        setTestResult(r => ({ ...r, [printer.id]: 'queued' }));
      }
    } catch (err) {
      await printService.recordPrinterHealth(printer.id, 'error', err.message);
      persist(printers.map(p => p.id === printer.id ? { ...p, status:'offline' } : p));
      setTestResult(r => ({ ...r, [printer.id]: 'error', error: err.message }));
    }
    setTesting(t => ({ ...t, [printer.id]: false }));
  };

  const editing = editId ? printers.find(p => p.id === editId) : null;

  return (
    <div style={S.page}>
      <div style={S.h1}>Printers</div>
      <div style={S.sub}>Add and manage physical printers — then assign them to production centres and devices</div>
      {loading && <div style={{ color:'var(--t4)', fontSize:13, padding:'20px 0' }}>Loading printers…</div>}

      {/* Printer list */}
      {printers.length === 0 && !showForm && (
        <div style={{ background:'var(--bg1)', border:'1px dashed var(--bdr2)', borderRadius:16, padding:'48px 32px', textAlign:'center', marginBottom:24 }}>
          <div style={{ fontSize:36, marginBottom:12 }}>🖨</div>
          <div style={{ fontSize:15, fontWeight:700, color:'var(--t2)', marginBottom:6 }}>No printers added yet</div>
          <div style={{ fontSize:13, color:'var(--t3)', marginBottom:20, lineHeight:1.7 }}>
            Add your Sunmi NT311 or other ESC/POS printers here.<br/>
            Once added, you can assign them to production centres and devices.
          </div>
          <button onClick={() => setShowForm(true)} style={{ ...S.btn, background:'var(--acc)', color:'#fff', padding:'10px 24px' }}>+ Add first printer</button>
        </div>
      )}

      {printers.map(printer => {
        const model = MODELS.find(m => m.id === printer.model) || MODELS[0];
        const conn  = CONN_TYPES.find(c => c.id === printer.connectionType) || CONN_TYPES[0];
        const isEditing = editId === printer.id;
        const result = testResult[printer.id];

        if (isEditing) {
          return <PrinterForm key={printer.id} initial={printer} onSave={handleSave} onCancel={() => setEditId(null)}/>;
        }

        return (
          <div key={printer.id} style={S.card}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:14 }}>
                <div style={{ width:44, height:44, borderRadius:10, background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, flexShrink:0 }}>🖨</div>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:3 }}>
                    {statusDot(printer.status)}
                    <span style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>{printer.name}</span>
                    {printer.location && <span style={{ fontSize:11, color:'var(--t3)', padding:'2px 8px', borderRadius:20, background:'var(--bg3)', border:'1px solid var(--bdr)' }}>{printer.location}</span>}
                  </div>
                  <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.8 }}>
                    <span>{model.label}</span>
                    <span style={{ margin:'0 6px', opacity:.4 }}>·</span>
                    <span>{conn.icon} {printer.address || 'USB'}{printer.connectionType === 'network' && printer.port !== 9100 ? `:${printer.port}` : ''}</span>
                    <span style={{ margin:'0 6px', opacity:.4 }}>·</span>
                    <span>{printer.paperWidth || 80}mm</span>
                  </div>
                  {printer.roles?.length > 0 && (
                    <div style={{ display:'flex', gap:4, marginTop:5 }}>
                      {printer.roles.map(rid => {
                        const r = ROLES.find(x => x.id === rid);
                        return r ? <span key={rid} style={{ fontSize:10, padding:'2px 7px', borderRadius:20, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)', fontWeight:600 }}>{r.icon} {r.label}</span> : null;
                      })}
                    </div>
                  )}
                  {result && (
                    <div style={{ fontSize:11, marginTop:5, fontWeight:600,
                      color: result === 'online' ? 'var(--grn)' : result === 'queued' ? 'var(--acc)' : result === 'timeout' ? 'var(--acc)' : 'var(--red)' }}>
                      {result === 'online'       && '✓ Printed successfully — printer is online'}
                      {result === 'queued'       && '⏳ Job queued — waiting for print agent…'}
                      {result === 'timeout'      && '⚠ Job queued but no response yet — check the print agent is running on your LAN machine'}
                      {result === 'agent-failed' && `✗ Agent reached printer but failed — ${testResult[printer.id]?.error || 'check printer cable, paper, and power'}`}
                      {result === 'error'        && `✗ Could not queue job — ${testResult[printer.id]?.error || 'check Supabase connection'}`}
                    </div>
                  )}
                  {testing[printer.id] && result === 'queued' && (
                    <div style={{ fontSize:10, color:'var(--t4)', marginTop:3 }}>Waiting for print agent to deliver…</div>
                  )}
                </div>
              </div>

              <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                <button onClick={() => handleTest(printer)} disabled={testing[printer.id] || printer.connectionType === 'usb'} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', fontSize:12 }}>
                  {testing[printer.id] ? (testResult[printer.id] === 'queued' ? '⏳ Waiting…' : '…') : '🖨 Test'}
                </button>
                <button onClick={() => setEditId(printer.id)} style={{ ...S.btn, background:'var(--bg3)', color:'var(--t2)', border:'1px solid var(--bdr)', fontSize:12 }}>Edit</button>
                <button onClick={() => handleDelete(printer.id)} style={{ ...S.btn, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', fontSize:12 }}>Remove</button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Add form */}
      {showForm && !editId && (
        <PrinterForm onSave={handleSave} onCancel={() => setShowForm(false)}/>
      )}

      {/* Add button */}
      {!showForm && !editId && printers.length > 0 && (
        <button onClick={() => setShowForm(true)} style={{ ...S.btn, background:'var(--acc)', color:'#fff', padding:'10px 20px', marginTop:4 }}>+ Add printer</button>
      )}

      {/* Info banner */}
      {printers.length > 0 && (
        <div style={{ marginTop:24, background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 18px', fontSize:12, color:'var(--t3)', lineHeight:1.8 }}>
          <strong style={{ color:'var(--t2)' }}>Next steps:</strong> Go to <strong style={{ color:'var(--t2)' }}>Production printing</strong> to assign these printers to kitchen and bar production centres, or go to <strong style={{ color:'var(--t2)' }}>Devices</strong> to assign a receipt printer to a specific terminal.
        </div>
      )}
    </div>
  );
}

// Helper exported so other sections can read printers
export { loadPrinters, savePrinters };
