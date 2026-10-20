// src/surfaces/manager/ManagerStock.jsx
//
// Count by area and log waste on a phone (v5.11.82, multi site stock Drop 0: Phase 1b re landed,
// plan 4.23). Opened from the Kitchen tab.
//   * Count: pick an area (or the whole venue), scan a barcode or search, type the figure in the
//     item's count pack. Each figure is saved as you go with the time it was typed, kept on the phone
//     first, so a dropped signal loses nothing (lib/manager/stockPhone.js). Only one send runs at a
//     time (the in flight guard in flushEntries), so the 5 second send and Approve never send the
//     same figures twice. Approve is ONE call with a manager PIN (manager-approve
//     stock.count_approve, approve_stock_count in the database). Any staff PIN opens the sheet.
//   * Waste: pick an item, the amount, a reason, PIN. Stock comes off at once.
// The camera scan uses the browser's BarcodeDetector where the phone has it; a Bluetooth or USB
// scanner types into the search box and works everywhere.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { queueEntry, pendingEntries, flushEntries, findByCode, toBaseQty, qtyWords, phoneStockNotReady } from '../../lib/manager/stockPhone';
import { Header, SectionTitle, mono } from './ui';
import { useLayout } from './useLayout';

const REASONS = ['Out of date', 'Damaged', 'Spilt or dropped', 'Quality', 'Other'];
const box = { width: '100%', padding: '11px 12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--inset, transparent)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
const btn = (tone = 'var(--t1)') => ({ padding: '11px 16px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: tone, fontWeight: 800, fontSize: 14, fontFamily: 'inherit', background: 'transparent' });
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export default function ManagerStock({ ctx, onClose }) {
  const { loc } = ctx;
  const L = useLayout();
  const [pin, setPin] = useState('');
  const [pinEntry, setPinEntry] = useState('');
  const [mode, setMode] = useState(null);          // null | 'count' | 'waste'
  const [areas, setAreas] = useState(null);
  const [count, setCount] = useState(null);        // { id, name }
  const [items, setItems] = useState([]);
  const [typed, setTyped] = useState({});          // itemId -> text
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [approvePin, setApprovePin] = useState('');
  const [wasteItem, setWasteItem] = useState(null);
  const [waste, setWaste] = useState({ qty: '', inPacks: true, reason: REASONS[0], note: '' });
  const call = useCallback((action, target, extra) => managerApprove(loc, pin, action, target, extra), [loc, pin]);

  useEffect(() => {
    if (!pin || areas) return undefined;
    let live = true;
    call('stock.areas', 'areas').then((r) => {
      if (!live) return;
      if (r?.ok) setAreas(r);
      else setErr(phoneStockNotReady(r?.error) ? 'Counting on the phone is not ready at this venue yet: the server update for it is still to come.' : (r?.error || 'Could not read the areas'));
    });
    return () => { live = false; };
  }, [pin, areas, call]);

  // Saved as you go: whatever waits on the phone is sent every few seconds while the sheet is open.
  // flushEntries runs one send per count at a time; a call while one is running waits for that one.
  const flush = useCallback(async () => {
    if (!count) return;
    const r = await flushEntries(count.id, async (batch, sentAt) => {
      const res = await call('stock.count_save', count.id, { entries: batch, sent_at: sentAt });
      return res?.ok ? { ok: true } : { ok: false, error: res?.error || 'not saved' };
    });
    setPending(pendingEntries(count.id).length);
    if (r.error) setErr(`Saved on the phone, sending when the signal is back (${r.error}).`); else setErr('');
  }, [count, call]);
  useEffect(() => {
    if (!count) return undefined;
    const t = setInterval(flush, 5000);
    return () => clearInterval(t);
  }, [count, flush]);

  const openSheet = async (areaId) => {
    setBusy(true); setErr('');
    const o = await call('stock.count_open', areaId || 'all');
    if (!o?.ok) { setBusy(false); setErr(o?.error || 'Could not start the count'); return; }
    const all = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const s = await call('stock.count_sheet', o.count.id, { offset });
      if (!s?.ok) { setBusy(false); setErr(s?.error || 'Could not read the sheet'); return; }
      all.push(...(s.items || []));
      if (!s.more) break;
    }
    setBusy(false);
    setCount(o.count); setItems(all); setTyped({}); setPending(pendingEntries(o.count.id).length);
    setMsg(o.reused ? 'Carrying on with this morning\'s count of this area.' : '');
  };

  // waste: every item of the venue (no count is opened)
  const loadItems = async () => {
    if (items.length) return;
    setBusy(true); setErr('');
    const all = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const s = await call('stock.items', 'items', { offset });
      if (!s?.ok) { setErr(s?.error || 'Could not read the items'); break; }
      all.push(...(s.items || []));
      if (!s.more) break;
    }
    setBusy(false); setItems(all);
  };

  const enter = (item, text) => {
    setTyped((m) => ({ ...m, [item.id]: text }));
    const base = toBaseQty(text, item, true);
    if (base == null) return;
    setPending(queueEntry(count.id, { item_id: item.id, qty_base: base }));
  };
  const onCode = (code) => {
    const hit = findByCode(items, code);
    if (hit) { setSearch(hit.name); setMsg(`Found ${hit.name}`); } else setSearch(code);
  };
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hit = findByCode(items, search);
    if (hit) return [hit];
    return q ? items.filter((i) => i.name.toLowerCase().includes(q) || (i.sku || '').toLowerCase() === q) : items;
  }, [items, search]);
  const counted = items.filter((i) => typed[i.id] != null && typed[i.id] !== '' || i.counted_qty != null).length;

  const approve = async () => {
    if (approvePin.length < 4) { setErr('Enter a manager PIN'); return; }
    setBusy(true);
    await flush();
    // a figure typed while the last send was in flight goes now
    if (pendingEntries(count.id).length) await flush();
    if (pendingEntries(count.id).length) { setBusy(false); setErr('Some figures are still on the phone: wait for the signal, then approve.'); return; }
    const r = await managerApprove(loc, approvePin, 'stock.count_approve', count.id);
    setBusy(false);
    if (!r?.ok) {
      if (r?.code === 'needs_cost' || r?.needs_cost) { setErr(`Counted here for the first time with no cost: ${(r.needs_cost || []).map((n) => n.name).join(', ')}. Approve it in Back Office, where you can type a cost.`); return; }
      setErr(r?.error || 'Not approved'); return;
    }
    setMsg(`Approved${r.duplicate ? ' already' : ''}. ${r.total != null ? `${r.total} line${r.total === 1 ? '' : 's'} reconciled` : ''}${r.opening ? `, ${r.opening} opening stock` : ''}.`);
    setCount(null); setItems([]); setApprovePin(''); setAreas(null);
  };

  const logWaste = async () => {
    const base = toBaseQty(waste.qty, wasteItem, waste.inPacks);
    if (!base) { setErr('Type how much was wasted'); return; }
    setBusy(true);
    const r = await call('stock.waste', wasteItem.id, { id: newId(), qty: Number(waste.qty), unit: waste.inPacks && wasteItem.count_pack ? wasteItem.count_pack.name : wasteItem.base_unit, qty_base: base, reason: waste.reason, note: waste.note || null });
    setBusy(false);
    if (!r?.ok) { setErr(r?.error || 'Not recorded'); return; }
    setMsg(`${qtyWords(base, wasteItem)} of ${wasteItem.name} logged as waste.`);
    setWasteItem(null); setWaste({ qty: '', inPacks: true, reason: REASONS[0], note: '' });
  };

  if (!pin) {
    return (
      <div style={L.s.page2}>
        <Header title="Stock" sub="Count · waste" />
        <div className="sv-glass" style={{ padding: 16, marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 10 }}>Enter your PIN to count or log waste here.</div>
          <input value={pinEntry} type="password" inputMode="numeric" placeholder="PIN" onChange={(e) => setPinEntry(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={(e) => { if (e.key === 'Enter' && pinEntry.length >= 4) setPin(pinEntry); }} style={{ ...box, width: 150, letterSpacing: '0.3em', ...mono }} />
          <button onClick={() => pinEntry.length >= 4 && setPin(pinEntry)} style={{ ...btn(), marginLeft: 8 }}>Unlock</button>
          <button onClick={onClose} style={{ ...btn('var(--t3)'), marginLeft: 8 }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div style={L.s.page2}>
      <Header title="Stock" sub={count ? count.name : mode === 'waste' ? 'Log waste' : 'Count · waste'} />
      {msg && <div className="sv-glass" style={{ padding: 12, marginTop: 10, fontSize: 13, color: 'var(--grn)' }}>{msg}</div>}
      {err && <div className="sv-glass" style={{ padding: 12, marginTop: 10, fontSize: 13, color: 'var(--red)' }}>{err}</div>}

      {!mode && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button onClick={() => setMode('count')} className="sv-glass" style={{ ...btn(), textAlign: 'left', padding: 18 }}>Count by area<div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 500 }}>Scan or search, saved as you go, approve with a manager PIN</div></button>
          <button onClick={() => { setMode('waste'); loadItems(); }} className="sv-glass" style={{ ...btn(), textAlign: 'left', padding: 18 }}>Log waste<div style={{ fontSize: 12, color: 'var(--t3)', fontWeight: 500 }}>Stock comes off at once</div></button>
          <button onClick={onClose} style={btn('var(--t3)')}>Back to Kitchen</button>
        </div>
      )}

      {mode === 'count' && !count && (
        <>
          <SectionTitle>Pick an area</SectionTitle>
          {!areas && <div style={{ color: 'var(--t3)', ...mono }}>Loading…</div>}
          <div style={{ display: 'grid', gap: 8 }}>
            {(areas?.areas || []).map((a) => <button key={a.id} disabled={busy} onClick={() => openSheet(a.id)} className="sv-glass" style={{ ...btn(), textAlign: 'left' }}>{a.name}</button>)}
            <button disabled={busy} onClick={() => openSheet(null)} className="sv-glass" style={{ ...btn(), textAlign: 'left' }}>The whole venue</button>
            <button onClick={() => setMode(null)} style={btn('var(--t3)')}>Back</button>
          </div>
        </>
      )}

      {mode === 'count' && count && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onCode(e.currentTarget.value); }}
              placeholder="Scan a barcode or search" style={box} autoFocus />
            <CameraScan onCode={onCode} />
          </div>
          <SectionTitle right={`${counted}/${items.length} counted${pending ? ` · ${pending} on the phone` : ''}`}>Count</SectionTitle>
          <div style={{ display: 'grid', gap: 8 }}>
            {shown.slice(0, 300).map((i) => (
              <div key={i.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{i.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{i.count_pack ? `in ${i.count_pack.name} (${i.count_pack.qty} ${i.base_unit})` : `in ${i.base_unit}`}{i.counted_qty != null && typed[i.id] == null ? ` · counted ${qtyWords(i.counted_qty, i)}` : ''}</div>
                </div>
                <input type="number" inputMode="decimal" min="0" step="any" value={typed[i.id] ?? ''} onChange={(e) => enter(i, e.target.value)}
                  style={{ ...box, width: 90, textAlign: 'right', fontWeight: 700, ...mono }} />
              </div>
            ))}
            {shown.length > 300 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Search to find the rest ({shown.length - 300} more).</div>}
          </div>
          <SectionTitle>Approve</SectionTitle>
          <div className="sv-glass" style={{ padding: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={approvePin} type="password" inputMode="numeric" placeholder="Manager PIN" onChange={(e) => setApprovePin(e.target.value.replace(/\D/g, '').slice(0, 8))} style={{ ...box, width: 160, ...mono }} />
            <button disabled={busy} onClick={approve} style={{ ...btn('var(--grn)'), borderColor: 'var(--grn-b, var(--bdr))' }}>{busy ? 'Approving…' : 'Approve the count'}</button>
            <button onClick={() => { flush(); setCount(null); setMode(null); }} style={btn('var(--t3)')}>Finish later</button>
          </div>
        </>
      )}

      {mode === 'waste' && (
        <>
          {!wasteItem && (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Scan or search the stock item" style={box} />
                <CameraScan onCode={onCode} />
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {(search.trim() ? shown : []).slice(0, 30).map((i) => <button key={i.id} onClick={() => setWasteItem(i)} className="sv-glass" style={{ ...btn(), textAlign: 'left' }}>{i.name} <span style={{ color: 'var(--t3)', fontWeight: 500 }}>{i.base_unit}</span></button>)}
                {busy && <div style={{ color: 'var(--t3)', ...mono }}>Loading…</div>}
                <button onClick={() => { setMode(null); setSearch(''); }} style={btn('var(--t3)')}>Back</button>
              </div>
            </>
          )}
          {wasteItem && (
            <div className="sv-glass" style={{ padding: 14, marginTop: 12, display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{wasteItem.name}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="number" inputMode="decimal" min="0" step="any" value={waste.qty} onChange={(e) => setWaste((w) => ({ ...w, qty: e.target.value }))} placeholder="How much" style={{ ...box, width: 120, ...mono }} />
                {wasteItem.count_pack
                  ? <select value={waste.inPacks ? 'pack' : 'base'} onChange={(e) => setWaste((w) => ({ ...w, inPacks: e.target.value === 'pack' }))} style={{ ...box, width: 'auto' }}><option value="pack">{wasteItem.count_pack.name}</option><option value="base">{wasteItem.base_unit}</option></select>
                  : <span style={{ color: 'var(--t3)' }}>{wasteItem.base_unit}</span>}
              </div>
              <select value={waste.reason} onChange={(e) => setWaste((w) => ({ ...w, reason: e.target.value }))} style={box}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              <input value={waste.note} onChange={(e) => setWaste((w) => ({ ...w, note: e.target.value }))} placeholder="Note (optional)" style={box} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={busy} onClick={logWaste} style={btn('var(--red)')}>{busy ? 'Saving…' : 'Log waste'}</button>
                <button onClick={() => setWasteItem(null)} style={btn('var(--t3)')}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The phone camera as a barcode reader, where the browser has BarcodeDetector. */
function CameraScan({ onCode }) {
  const [on, setOn] = useState(false);
  const video = useRef(null);
  // the newest onCode, read by the scan loop: the camera is not restarted each time the screen
  // above it renders (it renders every few seconds while figures are sent)
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);
  const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    if (!on) return undefined;
    let stream = null; let live = true; let timer = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!live) return;
        video.current.srcObject = stream; await video.current.play();
        const det = new window.BarcodeDetector();
        const tick = async () => {
          if (!live) return;
          try { const codes = await det.detect(video.current); if (codes[0]?.rawValue) { onCodeRef.current?.(codes[0].rawValue); setOn(false); return; } } catch { /* next frame */ }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch { setOn(false); }
    })();
    return () => { live = false; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, [on]);
  if (!supported) return null;
  return (
    <>
      <button onClick={() => setOn((x) => !x)} style={btn()}>{on ? 'Stop' : 'Scan'}</button>
      {on && <video ref={video} playsInline muted style={{ position: 'fixed', left: 16, right: 16, bottom: 90, maxHeight: '40vh', borderRadius: 14, zIndex: 50, background: '#000' }} />}
    </>
  );
}
