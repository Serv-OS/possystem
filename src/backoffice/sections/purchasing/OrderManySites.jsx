// purchasing/OrderManySites.jsx: head office orders for many sites at once (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2, map G14): launch allocations, central cups and beans. Pick company
// items and sites, type an amount per site or one for all; each site's supplier and next delivery are
// shown; Send makes one order per site and supplier in one database call (stock_create_orders_many,
// which runs the same submit rules as the Order pad) and emails each order the database says to send.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { createOrdersManyAndSend } from '../../../lib/stock/purchasing';
import { manyOrdersPlan, padNext, dayWords } from '../../../lib/stock/purchasingRules';
import { manyOrdersWords, submitToast } from '../../../lib/stock/purchasingWords';
import { buildScheduleCtx } from '../../../lib/locationTime';
import { Sheet, Btn, Field, SiteChecklist, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

export default function OrderManySites({ orgCtx = null, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; head office ordering needs only the scope
  const sites = useMemo(() => (sc.sites || []).filter((s) => s.kind !== 'central_kitchen' && !(sc.kitchens || []).includes(s.id)), [sc.sites, sc.kitchens]);
  const [siteIds, setSiteIds] = useState([]);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState([]);
  const [picks, setPicks] = useState([]);          // [{ id, name, detail, qtyBySite }]
  const [contexts, setContexts] = useState({});    // siteId -> order pad context
  const [same, setSame] = useState({});            // item id -> the "same for all" box
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const shownFound = search.trim().length < 2 ? [] : found;

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) return undefined;
    let live = true;
    const t = setTimeout(async () => {
      const r = await stockApi.itemsPage({ orgId: sc.orgId, search: q });
      if (live) { setFound(r.error ? [] : (r.data?.rows || []).slice(0, 20)); setError(r.error || null); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [search, sc.orgId]);

  useEffect(() => {
    const missing = siteIds.filter((id) => !contexts[id]);
    if (!missing.length) return;
    let live = true;
    (async () => {
      const got = {};
      for (const id of missing) { const r = await stockApi.orderPadContext(id); got[id] = r.error ? { suppliers: [], error: r.error } : (r.data || { suppliers: [] }); }
      if (live) setContexts((c) => ({ ...c, ...got }));
    })();
    return () => { live = false; };
  }, [siteIds, contexts]);

  const addItem = async (row) => {
    if (picks.some((p) => p.id === row.id)) return;
    const r = await stockApi.itemDetail(row.id);
    if (r.error) { setError(r.error); return; }
    setPicks((ps) => [...ps, { id: row.id, name: row.name, detail: r.data || {}, qtyBySite: {} }]);
    setSearch('');
  };
  const setQty = (itemId, siteId, v) => setPicks((ps) => ps.map((p) => (p.id === itemId ? { ...p, qtyBySite: { ...p.qtyBySite, [siteId]: v } } : p)));
  const fillAll = (itemId) => setPicks((ps) => ps.map((p) => (p.id === itemId ? { ...p, qtyBySite: Object.fromEntries(siteIds.map((id) => [id, same[itemId] || ''])) } : p)));

  const plan = useMemo(() => manyOrdersPlan(picks.map((p) => ({ detail: p.detail, qtyBySite: Object.fromEntries(Object.entries(p.qtyBySite).filter(([id]) => siteIds.includes(id))) })), contexts, sc.siteName), [picks, contexts, siteIds, sc.siteName]);
  const supplierCount = new Set(plan.orders.map((o) => o.supplier_id)).size;
  const supplierLine = (siteId) => {
    const sups = contexts[siteId]?.suppliers || [];
    const used = new Set(plan.orders.filter((o) => o.location_id === siteId).map((o) => o.supplier_id));
    return sups.filter((s) => used.has(s.supplier_id)).map((s) => {
      const n = padNext(s, buildScheduleCtx(contexts[siteId]?.tz || null), contexts[siteId]?.tz || null);
      return `${s.name}${n ? `, next delivery ${dayWords(n.deliveryYmd)}` : ''}`;
    }).join('; ');
  };

  const send = async () => {
    if (!plan.orders.length) return;
    setBusy(true); setError(null);
    const r = await createOrdersManyAndSend(stockApi, sc.orgId, plan.orders);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    const orders = r.data.orders || [];
    const approvals = orders.filter((o) => o.needs_approval).length;
    const internal = orders.filter((o) => o.internal).length;
    const refused = orders.filter((o) => o.error).length;
    showToast?.(submitToast({ sent: r.data.emailed, approvals, internal, failed: r.data.failed.length + refused }), r.data.failed.length || refused ? 'error' : 'success');
    onClose?.();
  };

  return (
    <Sheet title="Order for many sites" sub="Pick items and sites, type an amount per site or one for all. Send makes one order per site and supplier." onClose={onClose} width={900} dirty={picks.length > 0}
      footer={<>
        <span style={{ fontSize: 13, color: 'var(--t2)' }}>{manyOrdersWords(plan.orders.length, supplierCount)}</span>
        <span style={{ marginLeft: 'auto' }} />
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || !plan.orders.length} onClick={send}>{busy ? 'Sending…' : 'Send'}</Btn>
      </>}>
      <Field label="Sites">
        <SiteChecklist sites={sites} value={siteIds} onChange={setSiteIds} groups={sc.groups || []} />
      </Field>
      <Field label="Add an item">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company items" style={ui.input} aria-label="Search company items" />
        {shownFound.length > 0 && (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, marginTop: 6, maxHeight: 220, overflowY: 'auto' }}>
            {shownFound.map((f) => <button key={f.id} type="button" onClick={() => addItem(f)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', border: 'none', background: 'transparent', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' }}>{f.name}{f.main?.pack_description ? <span style={{ color: 'var(--t3)' }}> · {f.main.pack_description}</span> : null}</button>)}
          </div>
        )}
      </Field>
      <ErrorLine error={error} />
      {!picks.length || !siteIds.length ? <EmptyLine>Pick at least one site and one item.</EmptyLine> : (
        <TableWrap minWidth={240 + siteIds.length * 110}>
          <thead><tr><Th>Item</Th><Th>Same for all</Th>{siteIds.map((id) => <Th key={id} right hint={supplierLine(id)}>{sc.siteName(id)}</Th>)}</tr></thead>
          <tbody>
            {picks.map((p) => (
              <tr key={p.id}>
                <Td strong>{p.name}</Td>
                <Td>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <input inputMode="decimal" value={same[p.id] ?? ''} onChange={(e) => setSame((m) => ({ ...m, [p.id]: e.target.value }))} style={{ ...ui.input, width: 64 }} aria-label={`Same amount for all, ${p.name}`} />
                    <Btn small onClick={() => fillAll(p.id)}>Same amount for all</Btn>
                  </span>
                </Td>
                {siteIds.map((id) => (
                  <Td key={id} right><input inputMode="decimal" value={p.qtyBySite[id] ?? ''} onChange={(e) => setQty(p.id, id, e.target.value)} style={{ ...ui.input, width: 70, textAlign: 'right' }} aria-label={`${p.name} at ${sc.siteName(id)}`} /></Td>
                ))}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {plan.problems.length > 0 && <div style={{ ...ui.err, marginTop: 10 }}>{plan.problems.join(' ')}</div>}
    </Sheet>
  );
}
