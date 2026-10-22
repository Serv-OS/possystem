// src/surfaces/manager/ManagerTransfers.jsx
//
// MULTI SITE STOCK Drop 3 (contract 3.4, map 4.23): transfers on the phone. Opened from the Kitchen tab.
//   * Waiting to be received here: each transfer with its lines, the lot and use by from the batch
//     ('Lot B12 · use by 24 Oct'), what arrived typed per line (as sent unless changed), Receive
//     (manager-approve transfer.receive: the 'in' leg books the stock), or Dispute with a note
//     (transfer.dispute: paperwork, no stock moves). A central kitchen order is received here, never
//     as a delivery.
//   * Send to another site of the company (transfer.send: the 'out' leg; stock is in transit until the
//     other site receives it), or Request from one (transfer.request: the other site fulfils it in
//     Back Office).
//   * Requested of this site: listed; fulfilled in Back Office, Transfers.
// A manager PIN unlocks the sheet (checked by the server on every call). The PIN gate and the sheet
// frame are exported for the other Drop 3 sheets.

import { useEffect, useMemo, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { receiveLines, pickedLines, typedBase } from '../../lib/manager/kitchen';
import { lotWords } from '../../lib/stock/kitchenRules';
import { TRANSFER_REASONS } from '../../lib/stock/transferRules';
import { Header, SectionTitle, mono } from './ui';
import { useLayout } from './useLayout';

// eslint-disable-next-line react-refresh/only-export-components
export const box = { width: '100%', padding: '11px 12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--inset, transparent)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
// eslint-disable-next-line react-refresh/only-export-components
export const btn = (tone = 'var(--t1)', on = true) => ({ padding: '11px 16px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: on ? 'pointer' : 'default', color: on ? tone : 'var(--t4)', fontWeight: 800, fontSize: 14, fontFamily: 'inherit', background: 'transparent' });
// eslint-disable-next-line react-refresh/only-export-components
export const card = { padding: 14, borderRadius: 14, border: '1px solid var(--bdr)', marginTop: 10 };
const REASONS = TRANSFER_REASONS;

/** The sheet frame: the title, a Close button and the body. */
export function SheetFrame({ title, sub, onClose, children }) {
  const L = useLayout();
  return (
    <div style={L.s.page2}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}><Header title={title} sub={sub} /></div>
        <button type="button" onClick={onClose} className="sv-glass" style={btn('var(--t2)')}>Close</button>
      </div>
      <div style={L.s.span}>{children}</div>
    </div>
  );
}

/** The manager PIN gate: the PIN is kept for the sheet and proven by the server on every call. */
export function PinGate({ onPin, words = 'Manager PIN to open this' }) {
  const [entry, setEntry] = useState('');
  const go = () => { if (entry.length >= 4) onPin(entry); };
  return (
    <div className="sv-glass" style={card}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 8 }}>{words}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={entry} type="password" inputMode="numeric" placeholder="PIN" aria-label="PIN"
          onChange={(e) => setEntry(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          style={{ ...box, width: 140, letterSpacing: '0.3em', fontFamily: 'var(--font-mono)' }} />
        <button type="button" onClick={go} className="sv-glass" style={btn('var(--t1)', entry.length >= 4)}>Unlock</button>
      </div>
    </div>
  );
}

const isPinErr = (m) => /pin|not allowed|approve/i.test(String(m || ''));

export default function ManagerTransfers({ ctx, onClose }) {
  const { snap, loc, refreshSnap } = ctx;
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('in');           // 'in' | 'send' | 'request'
  const [open, setOpen] = useState(null);           // transfer id being received
  const [typed, setTyped] = useState({});           // line id -> what arrived
  const [dispute, setDispute] = useState(null);     // { id, note }
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState({});         // item id (or company item id) -> qty
  const [site, setSite] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [lastIn, setLastIn] = useState(null);       // { id, reference } received just now (Dispute is offered on it)
  const [note, setNote] = useState('');
  const t = snap?.kitchen?.transfers || { sites: [], incoming: [], requested: [] };
  const incoming = t.incoming || [];
  const sites = t.sites || [];

  const call = (action, target, extra) => managerApprove(loc, pin, action, target, extra);
  const fail = (r, fallback) => { const m = r?.error || fallback; if (isPinErr(m)) setPin(''); setErr(m); };

  useEffect(() => {
    if (!pin || mode === 'in' || items) return undefined;
    let live = true;
    call('stock.items', 'items', { offset: 0 }).then((r) => { if (live) { if (r?.ok) setItems(r.items || []); else fail(r, 'Could not read the items'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, mode, items]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items || []).filter((i) => (mode !== 'request' || i.company_ref) && (!q || String(i.name || '').toLowerCase().includes(q))).slice(0, 60);
  }, [items, search, mode]);

  const receive = async (tr) => {
    setBusy(true); setErr(''); setMsg('');
    const r = await call('transfer.receive', tr.id, { lines: receiveLines(tr, typed) });
    setBusy(false);
    if (r?.ok) { setMsg(`Received ${tr.reference || 'the transfer'}. Stock is in.`); setLastIn({ id: tr.id, reference: tr.reference || '' }); setOpen(null); setTyped({}); refreshSnap?.(); } else fail(r, 'Could not receive it');
  };
  const sendDispute = async () => {
    if (!dispute?.note?.trim()) { setErr('Say what is wrong.'); return; }
    setBusy(true); setErr('');
    const r = await call('transfer.dispute', dispute.id, { note: dispute.note.trim() });
    setBusy(false);
    if (r?.ok) { setMsg('Dispute sent to the other site.'); setDispute(null); setLastIn(null); refreshSnap?.(); } else fail(r, 'Could not send the dispute');
  };
  const sendOrRequest = async () => {
    if (!site) { setErr(mode === 'send' ? 'Pick the venue to send to.' : 'Pick the venue to ask.'); return; }
    const lines = pickedLines(picked, mode === 'request' ? 'company_item_id' : 'inventory_item_id');
    if (!lines.length) { setErr('Add at least one line with a quantity.'); return; }
    setBusy(true); setErr(''); setMsg('');
    const r = mode === 'send'
      ? await call('transfer.send', null, { to_location_id: site, lines, reason, note: note || null })
      : await call('transfer.request', null, { from_location_id: site, lines, reason, note: note || null });
    setBusy(false);
    const name = sites.find((s) => s.id === site)?.name || 'the other site';
    if (r?.ok) {
      const refused = Array.isArray(r.refused) && r.refused.length ? ` Left out: ${r.refused.map((x) => x?.words || x?.error || x).join(' ')}` : '';
      setMsg(mode === 'send' ? `Sent ${r.reference || ''} to ${name}. It is in transit until they receive it.` : `Request sent to ${name}.${refused}`);
      setPicked({}); setNote(''); refreshSnap?.();
    } else fail(r, 'It did not go');
  };

  if (!pin) return <SheetFrame title="Transfers" sub="Receive, send or request stock" onClose={onClose}><PinGate onPin={setPin} /></SheetFrame>;

  return (
    <SheetFrame title="Transfers" sub="Receive, send or request stock" onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {[['in', `To receive (${incoming.length})`], ['send', 'Send'], ['request', 'Request from another venue']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => { setMode(k); setErr(''); setMsg(''); setPicked({}); }} className="sv-glass"
            style={{ ...btn(mode === k ? 'var(--acc)' : 'var(--t2)'), border: mode === k ? '1px solid var(--acc)' : '1px solid var(--bdr)' }}>{label}</button>
        ))}
      </div>
      {msg && <div style={{ marginTop: 10, color: 'var(--grn)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}
      {err && <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontWeight: 700, fontSize: 13 }}>{err}</div>}

      {mode === 'in' && (
        <>
          {incoming.length === 0 && <div className="sv-glass" style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>Nothing waiting to be received.</div>}
          {incoming.map((tr) => (
            <div key={tr.id} className="sv-glass" style={card}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>{tr.reference || 'Transfer'} from {tr.fromName || 'another site'}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{tr.kind === 'central_kitchen' ? 'Central kitchen · ' : ''}In transit · {tr.lines.length} line{tr.lines.length === 1 ? '' : 's'}</div>
              {open === tr.id ? (
                <>
                  {tr.lines.map((l) => (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{l.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>sent {l.qtyBase} {l.unit}{lotWords({ lot_code: l.lotCode, use_by_at: l.useByAt }) ? ` · ${lotWords({ lot_code: l.lotCode, use_by_at: l.useByAt })}` : ''}</div>
                      </div>
                      <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${l.name} arrived`} value={typed[l.id] ?? l.qtyBase}
                        onChange={(e) => setTyped((m) => ({ ...m, [l.id]: e.target.value }))} style={{ ...box, width: 90, textAlign: 'right' }} />
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button type="button" onClick={() => setOpen(null)} className="sv-glass" style={btn('var(--t2)')}>Back</button>
                    <button type="button" disabled={busy} onClick={() => receive(tr)} className="sv-glass" style={{ ...btn('var(--grn)', !busy), flex: 1 }}>{busy ? 'Saving…' : 'Receive'}</button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={() => { setOpen(tr.id); setTyped({}); }} className="sv-glass" style={btn('var(--grn)')}>Receive</button>
                </div>
              )}
            </div>
          ))}
          {(t.requested || []).length > 0 && (
            <>
              <SectionTitle right={`${t.requested.length}`}>Requested of this site</SectionTitle>
              {t.requested.map((r) => (
                <div key={r.id} className="sv-glass" style={card}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Requested by {r.toName || 'another site'}{r.reference ? ` · ${r.reference}` : ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)' }}>{[r.reason, r.note].filter(Boolean).join(' · ') || 'No reason given'}. Fulfil it in Back Office, Transfers.</div>
                </div>
              ))}
            </>
          )}
          {lastIn && <DisputeBox last={lastIn} dispute={dispute} setDispute={setDispute} onSend={sendDispute} busy={busy} />}
        </>
      )}

      {(mode === 'send' || mode === 'request') && (
        <div className="sv-glass" style={card}>
          <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>{mode === 'send' ? 'Send to' : 'Ask'}
            <select value={site} onChange={(e) => setSite(e.target.value)} style={{ ...box, marginTop: 6 }} aria-label={mode === 'send' ? 'Send to' : 'Ask'}>
              <option value="">Pick a site</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Reason
            <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...box, marginTop: 6 }} aria-label="Reason">
              {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="Note (optional)" aria-label="Note" style={{ ...box, marginTop: 10 }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items" aria-label="Search items" style={{ ...box, marginTop: 10 }} />
          {!items && <div style={{ color: 'var(--t3)', fontSize: 12, marginTop: 8 }}>Loading items…</div>}
          {shown.map((i) => {
            const key = mode === 'request' ? i.company_ref : i.id;
            return (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{i.name} <span style={{ color: 'var(--t3)', fontSize: 11 }}>{i.base_unit}</span></div>
                <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${i.name} amount`} value={picked[key] ?? ''}
                  onChange={(e) => setPicked((m) => ({ ...m, [key]: e.target.value }))} style={{ ...box, width: 90, textAlign: 'right' }} />
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>{Object.values(picked).filter((v) => (typedBase(v) || 0) > 0).length} line(s) · amounts in each item's own unit</div>
          <button type="button" disabled={busy} onClick={sendOrRequest} className="sv-glass" style={{ ...btn('var(--grn)', !busy), width: '100%', marginTop: 12 }}>
            {busy ? 'Sending…' : mode === 'send' ? 'Send' : 'Send request'}
          </button>
        </div>
      )}
    </SheetFrame>
  );
}

// Dispute the transfer just received: a note, then transfer.dispute (paperwork, no stock moves).
function DisputeBox({ last, dispute, setDispute, onSend, busy }) {
  if (!dispute) {
    return (
      <div className="sv-glass" style={card}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Something wrong with {last.reference || 'that transfer'}?</div>
        <button type="button" onClick={() => setDispute({ id: last.id, note: '' })} className="sv-glass" style={{ ...btn('var(--orn)'), marginTop: 8 }}>Dispute</button>
      </div>
    );
  }
  return (
    <div className="sv-glass" style={card}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>What is wrong?</div>
      <textarea value={dispute.note} onChange={(e) => setDispute({ ...dispute, note: e.target.value.slice(0, 300) })} aria-label="What is wrong?" style={{ ...box, minHeight: 70, marginTop: 8 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => setDispute(null)} className="sv-glass" style={btn('var(--t2)')}>Cancel</button>
        <button type="button" disabled={busy} onClick={onSend} className="sv-glass" style={{ ...btn('var(--orn)', !busy), flex: 1 }}>Send dispute</button>
      </div>
    </div>
  );
}
