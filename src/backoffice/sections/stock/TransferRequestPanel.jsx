// src/backoffice/sections/stock/TransferRequestPanel.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map K2): 'Request from another venue'.
// The receiving site picks company items and amounts (in each item's base unit), the site to ask, a
// reason and a note, and sends the request (stock_request_transfer). The other site is told and
// fulfils or refuses it; nothing moves until it sends (the existing out leg). Items the asked site
// does not stock come back as refused lines in the database's words.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { requestTransfer } from '../../../lib/stock/transfers';
import { TRANSFER_REASONS, requestLinesOf } from '../../../lib/stock/transferRules';
import { useStockScope } from '../../StockScope';
import { Sheet, Btn, Field, ui } from './stockUi';
import TransferListsPicker from './TransferListsPicker';

export default function TransferRequestPanel({ siteId, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const others = useMemo(() => (sc.sites || []).filter((s) => s.id !== siteId), [sc.sites, siteId]);
  const [fromId, setFromId] = useState(others[0]?.id || '');
  const [reason, setReason] = useState(TRANSFER_REASONS[0]);
  const [note, setNote] = useState('');
  const [picks, setPicks] = useState([]);      // [{ companyItemId, name, unit, qty }]
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState([]);

  useEffect(() => {
    let live = true;
    const text = q.trim();
    if (!text || !sc.orgId) return () => { live = false; };
    const t = setTimeout(() => {
      stockApi.itemsPage({ orgId: sc.orgId, sites: [siteId], search: text, limit: 20 }).then((r) => { if (live) setHits(r.data?.rows || []); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, sc.orgId, siteId]);

  const add = (row) => {
    setPicks((p) => (p.some((x) => x.companyItemId === row.id) ? p : [...p, { companyItemId: row.id, name: row.name, unit: row.base_unit || '', qty: '' }]));
    setQ(''); setHits([]);
  };
  const fromList = async (list) => {
    const lines = Array.isArray(list?.lines) ? list.lines : [];
    if (list?.to_location_id === siteId && others.some((s) => s.id === list.location_id)) setFromId(list.location_id);
    // names for the list's items (100 ids a read is the database's cap)
    const ids = lines.map((l) => l.company_item_id).filter(Boolean).slice(0, 300);
    const names = {};
    for (let i = 0; i < ids.length; i += 100) {
      const r = await stockApi.itemsPage({ orgId: sc.orgId, filters: { ids: ids.slice(i, i + 100) }, limit: 100 });
      (r.data?.rows || []).forEach((row) => { names[row.id] = row; });
    }
    setPicks(lines.filter((l) => l.company_item_id).map((l) => ({ companyItemId: l.company_item_id, name: names[l.company_item_id]?.name || 'Company item', unit: names[l.company_item_id]?.base_unit || '', qty: String(l.qty_base ?? '') })));
  };

  const { lines, error: lineProblem } = requestLinesOf(picks);
  const send = async () => {
    if (!fromId) { showToast?.('Pick the site to ask.', 'error'); return; }
    if (lineProblem) { showToast?.(lineProblem, 'error'); return; }
    setBusy(true);
    const r = await requestTransfer({ from: fromId, to: siteId, picks, reason, note: note.trim() || null });
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    const no = Array.isArray(r.data?.refused) ? r.data.refused : [];
    setRefused(no);
    showToast?.(`Request sent to ${sc.siteName(fromId) || 'the other site'}.`, 'success');
    if (!no.length) onDone?.(r.data);
  };

  const dirty = picks.length > 0 || note.trim() !== '';
  return (
    <Sheet title="Request from another venue" sub="Ask another site for stock. They send it; it shows here as In transit until you receive it." width={620} onClose={onClose} dirty={dirty && !busy && !refused.length}
      footer={<>
        <span style={{ marginRight: 'auto', fontSize: 12.5, color: 'var(--t3)' }}>{lines.length} item{lines.length === 1 ? '' : 's'}</span>
        <Btn onClick={onClose} disabled={busy}>{refused.length ? 'Close' : 'Cancel'}</Btn>
        {!refused.length && <Btn kind="primary" onClick={send} disabled={busy || !!lineProblem || !fromId}>{busy ? 'Sending...' : 'Send request'}</Btn>}
      </>}>
      {refused.length > 0 && (
        <div style={{ ...ui.err, marginBottom: 12 }}>
          Sent, but these were left out: {refused.map((x) => (typeof x === 'string' ? x : x?.error || x?.words || x?.name || 'an item')).join('; ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field label="Ask" style={{ flex: '1 1 200px' }}>
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} style={ui.input}>
            {!others.length && <option value="">No other site</option>}
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Reason" style={{ flex: '1 1 180px' }}>
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={ui.input}>
            {TRANSFER_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} style={ui.input} placeholder="For the weekend" /></Field>
      <div style={{ marginBottom: 12 }}>
        <TransferListsPicker siteId={siteId} onPick={fromList}
          onSave={() => ({ to_location_id: null, lines: lines })} />
      </div>
      <Field label="Items">
        <div style={{ position: 'relative' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company items..." style={ui.input} />
          {hits.length > 0 && q.trim() && (
            <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
              {hits.map((h) => <div key={h.id} onClick={() => add(h)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>{h.name}{h.base_unit ? <span style={{ color: 'var(--t3)' }}> · {h.base_unit}</span> : null}</div>)}
            </div>
          )}
        </div>
      </Field>
      {picks.map((p) => (
        <div key={p.companyItemId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
          <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
          <input type="number" min="0" step="any" inputMode="decimal" value={p.qty} aria-label={`Amount: ${p.name}`}
            onChange={(e) => setPicks((list) => list.map((x) => (x.companyItemId === p.companyItemId ? { ...x, qty: e.target.value } : x)))}
            style={{ ...ui.input, width: 100, textAlign: 'right' }} />
          <span style={{ fontSize: 12, color: 'var(--t3)', minWidth: 28 }}>{p.unit}</span>
          <Btn small kind="link" onClick={() => setPicks((list) => list.filter((x) => x.companyItemId !== p.companyItemId))}>Remove</Btn>
        </div>
      ))}
    </Sheet>
  );
}
