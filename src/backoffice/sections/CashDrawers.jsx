import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import DrawerCashModal from '../../components/DrawerCashModal';
import { money } from '../../lib/currency';

/**
 * Cash Drawers registry (v4.6.35).
 *
 * First-class drawer entity. Each drawer has:
 *   - a name (e.g. "Bar", "Counter 1")
 *   - a printer that physically ejects it (ESC p pulse)
 *   - (optionally) a POS device assigned — strict 1:1, so only that device
 *     can ring cash into the drawer
 *
 * Legacy "cashDrawerAttached" flag on printers is the pre-4.6.35 mechanism.
 * We leave it alone so restaurants who haven't migrated still work; on first
 * use of v4.6.35, a synthetic Drawer 1 is created bound to the flagged printer.
 */
const EMPTY = { id: '', name: '', printerId: '', deviceId: '' };

const STATUS_META = {
  idle:     { label: 'Idle',     color: 'var(--t3)',      bg: 'var(--bg3)' },
  open:     { label: 'Open',     color: 'var(--grn)',     bg: 'var(--grn-d)' },
  counting: { label: 'Counting', color: 'var(--amb,#e8a020)', bg: 'rgba(232,160,32,.12)' },
};

export default function CashDrawers() {
  const cashDrawers  = useStore(s => s.cashDrawers) || [];
  // v4.6.38: printers live in localStorage ('rpos-printers'), updated by the
  // back-office PrinterRegistry. Listen for 'rpos-printers-updated' + 'storage'
  // so the dropdown refreshes when a printer is added from another screen.
  const [printers, setPrinters] = useState(() => {
    try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; }
  });
  // v4.6.38: devices fetched from Supabase — drawers bind to an actual physical
  // terminal (device.id uuid), not to a profile template. Profiles are shared
  // across terminals, so binding to profile would not be strict 1:1.
  const [devices, setDevices] = useState([]);
  useEffect(() => {
    const reloadPrinters = () => {
      try { setPrinters(JSON.parse(localStorage.getItem('rpos-printers') || '[]')); } catch {}
    };
    window.addEventListener('rpos-printers-updated', reloadPrinters);
    window.addEventListener('storage', reloadPrinters);
    return () => {
      window.removeEventListener('rpos-printers-updated', reloadPrinters);
      window.removeEventListener('storage', reloadPrinters);
    };
  }, []);
  useEffect(() => {
    (async () => {
      if (isMock || !supabase) return;
      try {
        const locId = await getLocationId();
        if (!locId) return;
        const { data } = await supabase
          .from('devices')
          .select('id, name, profile_id, type, last_seen, status')
          .eq('location_id', locId)
          .eq('status', 'active')
          .order('last_seen', { ascending: false });
        if (Array.isArray(data)) setDevices(data);
      } catch (err) {
        console.warn('[CashDrawers] devices load failed:', err?.message || err);
      }
    })();
  }, []);
  const createCashDrawer = useStore(s => s.createCashDrawer);
  const cashInDrawer = useStore(s => s.cashInDrawer);
  const cashOutDrawer = useStore(s => s.cashOutDrawer);
  const computeExpectedCash = useStore(s => s.computeExpectedCash);
  const staff = useStore(s => s.staff);
  const updateCashDrawer = useStore(s => s.updateCashDrawer);
  const deleteCashDrawer = useStore(s => s.deleteCashDrawer);
  const loadCashDrawers  = useStore(s => s.loadCashDrawers);

  const [selId, setSelId]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [isNew, setIsNew]   = useState(false);
  // v4.6.40: cash-in / cash-out modal state
  const [cashActionDrawer, setCashActionDrawer] = useState(null); // { drawer, mode, expected }


  useEffect(() => {
    loadCashDrawers?.();
  }, [loadCashDrawers]);

  const sel = useMemo(() => cashDrawers.find(d => d.id === selId) || null, [cashDrawers, selId]);

  const startNew = () => {
    setForm({ ...EMPTY, id: `drw-${Date.now()}`, name: `Drawer ${cashDrawers.length + 1}` });
    setSelId(null);
    setIsNew(true);
  };

  const startEdit = (d) => {
    setForm({ id: d.id, name: d.name, printerId: d.printerId || '', deviceId: d.deviceId || '' });
    setSelId(d.id);
    setIsNew(false);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    if (isNew) {
      await createCashDrawer?.({ ...form, name: form.name.trim() });
    } else {
      await updateCashDrawer?.(form.id, { name: form.name.trim(), printerId: form.printerId || null, deviceId: form.deviceId || null });
    }
    setSelId(form.id);
    setIsNew(false);
    loadCashDrawers?.();
  };

  const handleDelete = async () => {
    if (!sel) return;
    if (!confirm(`Delete drawer "${sel.name}"? This doesn't delete movement history, but unassigns the drawer from any device or printer.`)) return;
    await deleteCashDrawer?.(sel.id);
    setSelId(null);
    setIsNew(false);
    loadCashDrawers?.();
  };

  // Which devices are already taken by another drawer so we can disable them in the dropdown
  const takenDevices = new Set(cashDrawers.filter(d => d.id !== form.id && d.deviceId).map(d => d.deviceId));

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      {/* Left: list of drawers */}
      <div style={{ width:320, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', flexShrink:0, background:'var(--bg1)' }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Cash drawers</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{cashDrawers.length} configured</div>
          </div>
          <button onClick={startNew}
            style={{ padding:'7px 12px', borderRadius:8, background:'var(--acc)', border:'none', color:'#fff', fontWeight:700, fontFamily:'inherit', cursor:'pointer', fontSize:12 }}>
            + Add
          </button>
        </div>
        <div style={{ flex:1, overflowY:'auto' }}>
          {cashDrawers.length === 0 && !isNew && (
            <div style={{ padding:'28px 20px', textAlign:'center', color:'var(--t4)' }}>
              <div style={{ fontSize:30, marginBottom:8, opacity:.35 }}>💰</div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t3)' }}>No drawers yet</div>
              <div style={{ fontSize:11, marginTop:4, lineHeight:1.4 }}>Click + Add to define your first cash drawer, then bind it to a printer and a POS device.</div>
            </div>
          )}
          {cashDrawers.map(d => {
            const active = selId === d.id;
            const status = STATUS_META[d.status || 'idle'];
            const printer = printers.find(p => p.id === d.printerId);
            return (
              <div key={d.id} onClick={() => startEdit(d)}
                style={{
                  padding:'12px 16px', borderBottom:'1px solid var(--bdr)', cursor:'pointer',
                  background: active ? 'var(--acc-d)' : 'transparent',
                  borderLeft: active ? '3px solid var(--acc)' : '3px solid transparent',
                }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{d.name}</div>
                  <div style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:6, background:status.bg, color:status.color }}>{status.label}</div>
                </div>
                <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.4 }}>
                  {printer ? `🖨  ${printer.name}` : '⚠ no printer'}
                  {d.deviceId ? ` · 📟 ${d.deviceId.slice(0, 12)}` : ' · unassigned'}
                </div>
                {Number(d.currentFloat) !== 0 && (
                  <div style={{ fontSize:11, color:'var(--t4)', marginTop:3, fontFamily:'var(--font-mono)' }}>Float: {money(Number(d.currentFloat || 0))}</div>
                )}
                {/* v4.6.40: inline cash in/out actions */}
                <div style={{ display:'flex', gap:6, marginTop:8 }}>
                  {(!d.status || d.status === 'idle') ? (
                    <button onClick={(e) => { e.stopPropagation(); setCashActionDrawer({ drawer: d, mode: 'in', expected: 0 }); }}
                      style={{ flex:1, padding:'6px 8px', borderRadius:6, border:'1px solid var(--grn-b)', background:'var(--grn-d)', color:'var(--grn)', fontFamily:'inherit', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                      Cash in
                    </button>
                  ) : (
                    <button onClick={async (e) => {
                      e.stopPropagation();
                      // v4.6.41: back office is already auth-gated by Supabase Auth as
                      // the business owner. The staff object is the POS PIN-login user,
                      // which is empty in office mode. Skip the POS permission check
                      // here — it's enforced on the POS side of this same modal.
                      const exp = typeof computeExpectedCash === 'function' ? await computeExpectedCash(d.id) : 0;
                      setCashActionDrawer({ drawer: d, mode: 'out', expected: exp });
                    }}
                      style={{ flex:1, padding:'6px 8px', borderRadius:6, border:'1px solid var(--red-b)', background:'var(--red-d)', color:'var(--red)', fontFamily:'inherit', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                      Cash up
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: edit panel */}
      <div style={{ flex:1, overflowY:'auto', padding:'22px 28px' }}>
        {(!sel && !isNew) ? (
          <div style={{ textAlign:'center', padding:'80px 20px', color:'var(--t4)' }}>
            <div style={{ fontSize:46, marginBottom:10, opacity:.25 }}>💰</div>
            <div style={{ fontSize:15, fontWeight:700, color:'var(--t3)' }}>Select a drawer to edit</div>
            <div style={{ fontSize:12, marginTop:4 }}>Or click + Add to create a new one.</div>
          </div>
        ) : (
          <div style={{ maxWidth: 560 }}>
            <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>
              {isNew ? 'New cash drawer' : sel?.name}
            </div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:20 }}>
              {isNew ? 'Give this drawer a name, then bind it to a printer that ejects it and (optionally) a POS device that will manage it.'
                     : 'Change assignments or rename. History and current float are preserved.'}
            </div>

            {/* Name */}
            <Field label="Drawer name" hint="Shown on the POS header button and in reports. Keep it short — Bar, Counter, Upstairs.">
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Bar drawer"
                style={inputStyle}/>
            </Field>

            {/* Printer */}
            <Field label="Printer (ejects this drawer)" hint="The printer with the physical drawer cable. The ESC p pulse will fire at this printer for every cash sale on this drawer.">
              <select value={form.printerId} onChange={e => setForm(f => ({ ...f, printerId: e.target.value }))}
                style={inputStyle}>
                <option value="">— Select printer —</option>
                {printers.map(p => (
                  <option key={p.id} value={p.id}>{p.name} {p.roles?.includes('receipt') ? '(receipt)' : ''}</option>
                ))}
              </select>
            </Field>

            {/* Device */}
            <Field label="POS terminal (manages this drawer)" hint="Strict — only this physical terminal (matched by its paired device ID) can ring cash into this drawer. Each device can only own one drawer.">
              <select value={form.deviceId} onChange={e => setForm(f => ({ ...f, deviceId: e.target.value }))}
                style={inputStyle}>
                <option value="">— Unassigned (any device) —</option>
                {devices.length === 0 && (
                  <option disabled value="">— No paired devices found —</option>
                )}
                {devices.map(d => {
                  const taken = takenDevices.has(d.id);
                  const lastSeen = d.last_seen ? new Date(d.last_seen).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) : '—';
                  return (
                    <option key={d.id} value={d.id} disabled={taken}>
                      {d.name || d.id.slice(0, 8)} (last seen {lastSeen}){taken ? ' · already assigned' : ''}
                    </option>
                  );
                })}
              </select>
            </Field>

            {/* Current state (read-only) */}
            {!isNew && sel && (
              <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10, padding:'12px 14px', marginBottom:20 }}>
                <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>Current state</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, fontSize:12 }}>
                  <div>
                    <div style={{ color:'var(--t4)' }}>Status</div>
                    <div style={{ color:'var(--t1)', fontWeight:700, marginTop:2 }}>{(STATUS_META[sel.status] || STATUS_META.idle).label}</div>
                  </div>
                  <div>
                    <div style={{ color:'var(--t4)' }}>Float</div>
                    <div style={{ color:'var(--t1)', fontWeight:700, marginTop:2, fontFamily:'var(--font-mono)' }}>{money(Number(sel.currentFloat || 0))}</div>
                  </div>
                  {sel.openedAt && (
                    <div style={{ gridColumn:'1 / -1' }}>
                      <div style={{ color:'var(--t4)' }}>Opened</div>
                      <div style={{ color:'var(--t1)', marginTop:2 }}>{new Date(sel.openedAt).toLocaleString('en-GB')}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ display:'flex', gap:8, marginTop:8 }}>
              {!isNew && (
                <button onClick={handleDelete}
                  style={{ padding:'10px 14px', borderRadius:8, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontWeight:700, fontFamily:'inherit', cursor:'pointer', fontSize:13 }}>
                  Delete
                </button>
              )}
              <div style={{ flex:1 }}/>
              <button onClick={() => { setSelId(null); setIsNew(false); }}
                style={{ padding:'10px 16px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontWeight:600, fontFamily:'inherit', cursor:'pointer', fontSize:13 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={!form.name.trim()}
                style={{
                  padding:'10px 18px', borderRadius:8, border:'none',
                  background: form.name.trim() ? 'var(--acc)' : 'var(--bg4)',
                  color: form.name.trim() ? '#fff' : 'var(--t4)',
                  fontWeight:700, fontFamily:'inherit', cursor: form.name.trim() ? 'pointer' : 'not-allowed', fontSize:13,
                }}>
                {isNew ? 'Create drawer' : 'Save changes'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* v4.6.40: Cash in / Cash out modal, shared component */}
      {cashActionDrawer && (
        <DrawerCashModal
          mode={cashActionDrawer.mode}
          drawer={cashActionDrawer.drawer}
          expectedCash={cashActionDrawer.expected}
          onClose={() => setCashActionDrawer(null)}
          onComplete={async ({ amount, denominations, notes }) => {
            if (cashActionDrawer.mode === 'in') {
              await cashInDrawer?.(cashActionDrawer.drawer.id, { openingFloat: amount, denominations });
            } else {
              await cashOutDrawer?.(cashActionDrawer.drawer.id, { declaredCash: amount, denominations, notes });
            }
            setCashActionDrawer(null);
            useStore.getState().loadCashDrawers?.();
          }}
        />
      )}
    </div>
  );
}

const inputStyle = {
  width:'100%', padding:'9px 12px', borderRadius:8,
  border:'1.5px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)',
  fontFamily:'inherit', fontSize:14,
};

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom:16 }}>
      <label style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', display:'block', marginBottom:6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize:11, color:'var(--t4)', marginTop:5, lineHeight:1.45 }}>{hint}</div>}
    </div>
  );
}
