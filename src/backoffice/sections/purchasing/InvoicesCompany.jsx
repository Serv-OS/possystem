// purchasing/InvoicesCompany.jsx: Purchasing > Invoices for a multi site company (multi site stock
// Drop 3, v5.11.96, contract 3.2 and 4.2, mockup INFO invoices). Tabs: Invoices (every site, with the
// 3 way match status, filters, bulk Approve, Send to Xero, Split by site; locked rows greyed), Missing
// invoices (deliveries with no invoice after 7 days), Inbox, and Scan or upload (today's screen for the
// picked site). Kitchen orders never appear: they are transfers.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { normFocus } from '../../../lib/stock/stockAlertLinks';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { xeroPushBill } from '../../../lib/xero';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { matchPill, LOCKED_PILL, MATCH_PILLS } from '../../../lib/stock/purchasingWords';
import { PageHead, TabBar, TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import PickASite from '../stock/PickASite';
import { usePaged } from './usePaged';
import InvoicesSite from './InvoicesSite';
import InvoiceInbox from './InvoiceInbox';
import InvoiceSplit from './InvoiceSplit';

const TABS = [{ id: 'invoices', label: 'Invoices' }, { id: 'missing', label: 'Missing invoices' }, { id: 'inbox', label: 'Inbox' }, { id: 'scan', label: 'Scan or upload' }];

export default function InvoicesCompany({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  // arriving from an alert or another screen: { tab } or { focus: 'inbox' } (peeked here, taken once below)
  const [tab, setTab] = useState(() => { const o = normFocus('invoices', sc.peekOpen?.('invoices')); return o?.tab && TABS.some((t) => t.id === o.tab) ? o.tab : (o?.focus === 'inbox' ? 'inbox' : 'invoices'); });
  useEffect(() => { sc.takeOpen?.('invoices'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [match, setMatch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [splitting, setSplitting] = useState(null);
  const [busy, setBusy] = useState(false);
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const siteKey = sites ? sites.join(',') : 'all';
  const filters = useMemo(() => { const f = {}; if (match) f.match_status = match; if (status) f.status = status; if (from) f.from = from; if (to) f.to = to; return Object.keys(f).length ? f : null; }, [match, status, from, to]);
  const fetchInv = useCallback((after) => stockApi.invoicesPage({ orgId: sc.orgId, sites, filters, after }), [sc.orgId, sites, filters]);
  const inv = usePaged(fetchInv, `${sc.orgId}|${siteKey}|${JSON.stringify(filters)}`);
  const fetchMissing = useCallback((after) => stockApi.missingInvoices({ orgId: sc.orgId, sites, after }), [sc.orgId, sites]);
  const missing = usePaged(fetchMissing, `${sc.orgId}|${siteKey}|missing`);
  const editor = sc.canEditCompany('purchasing');

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const approve = async () => {
    const ids = [...picked].slice(0, 100);
    if (!ids.length) return;
    setBusy(true);
    const r = await stockApi.approveInvoices(ids);
    setBusy(false);
    showToast?.(r.error ? r.error.message : `Approved ${ids.length} invoice${ids.length === 1 ? '' : 's'}.`, r.error ? 'error' : 'success');
    setPicked(new Set()); inv.reload();
  };
  const sendXero = async () => {
    const rows = inv.rows.filter((r) => picked.has(r.id) && !r.locked_at && r.status === 'POSTED');
    if (!rows.length) { showToast?.('Pick posted invoices that are not locked.', 'info'); return; }
    setBusy(true);
    let ok = 0; const bad = [];
    for (const r of rows) { try { await xeroPushBill(r.location_id, r.id); ok++; } catch (e) { bad.push(`${r.invoice_number || 'invoice'}: ${e.message}`); } }
    setBusy(false);
    showToast?.(bad.length ? `${ok} sent to Xero. Not sent: ${bad.join('; ')}` : `${ok} sent to Xero. They are locked now.`, bad.length ? 'error' : 'success');
    setPicked(new Set()); inv.reload();
  };
  const postFromInbox = (row) => { sc.setChoice({ kind: 'site', id: row.location_id }); setTab('scan'); };

  return (
    <div style={ui.page}>
      <PageHead title="Invoices" sub="All sites, with match status: Matched, Price issue, Quantity issue, Both, Approved by hand." />
      <TabBar tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'invoices' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <select value={match} onChange={(e) => setMatch(e.target.value)} style={{ ...ui.input, width: 170 }} aria-label="Match">
              <option value="">Any match</option>
              {Object.entries(MATCH_PILLS).map(([id, pl]) => <option key={id} value={id}>{pl.text}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...ui.input, width: 140 }} aria-label="Status">
              <option value="">Any status</option><option value="REVIEW">Review</option><option value="POSTED">Posted</option><option value="VOID">Void</option>
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...ui.input, width: 150 }} aria-label="From" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...ui.input, width: 150 }} aria-label="To" />
            <span style={{ marginLeft: 'auto' }} />
            <Btn disabled={busy || !picked.size} onClick={approve}>Approve</Btn>
            <Btn disabled={busy || !picked.size} onClick={sendXero}>Send to Xero</Btn>
          </div>
          <ErrorLine error={inv.error} />
          {inv.loading ? <EmptyLine>Loading…</EmptyLine> : !inv.rows.length && !inv.error ? <EmptyLine>No invoices here.</EmptyLine> : (
            <TableWrap minWidth={900}>
              <thead><tr><Th> </Th><Th>Invoice</Th><Th>Site</Th><Th>Supplier</Th><Th>Date</Th><Th right>Total</Th><Th>Match</Th><Th> </Th></tr></thead>
              <tbody>
                {inv.rows.map((r) => {
                  const m = matchPill(r.match_status);
                  const locked = !!r.locked_at;
                  return (
                    <tr key={r.id} style={locked ? { opacity: 0.6 } : undefined}>
                      <Td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Pick invoice ${r.invoice_number || ''}`} /></Td>
                      <Td strong>{r.invoice_number || 'No number'}{r.po_reference ? <div style={ui.sub}>{r.po_reference}</div> : null}</Td>
                      <Td>{r.site_name || sc.siteName(r.location_id)}{Number(r.splits) > 0 ? <div style={ui.sub}>Split across {r.splits} sites</div> : null}</Td>
                      <Td>{r.supplier_name}</Td>
                      <Td grey>{dayWords(String(r.invoice_date || '').slice(0, 10))}</Td>
                      <Td num>{moneyWords(r.total)}</Td>
                      <Td>{m && <Pill tone={m.tone}>{m.text}</Pill>}{locked && <> <Pill tone={LOCKED_PILL.tone}>{LOCKED_PILL.text}</Pill></>}</Td>
                      <Td right>{editor && !locked && <Btn small onClick={() => setSplitting(r)}>Split by site</Btn>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          )}
          <ShowMore next={inv.next} busy={inv.more} onMore={inv.showMore} />
        </>
      )}
      {tab === 'missing' && (
        <>
          <div style={{ ...ui.sub, marginBottom: 10 }}>Deliveries with no invoice after 7 days.</div>
          <ErrorLine error={missing.error} />
          {missing.loading ? <EmptyLine>Loading…</EmptyLine> : !missing.rows.length && !missing.error ? <EmptyLine>Every delivery has its invoice.</EmptyLine> : (
            <TableWrap minWidth={700}>
              <thead><tr><Th>Order</Th><Th>Site</Th><Th>Supplier</Th><Th>Received</Th><Th right>Value</Th></tr></thead>
              <tbody>
                {missing.rows.map((r) => (
                  <tr key={r.po_id || r.id}>
                    <Td strong>{r.reference || 'Order'}</Td>
                    <Td>{r.site_name || sc.siteName(r.location_id)}</Td>
                    <Td>{r.supplier_name}</Td>
                    <Td grey>{dayWords(String(r.received_at || '').slice(0, 10))}</Td>
                    <Td num>{r.subtotal != null ? moneyWords(r.subtotal) : ''}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          <ShowMore next={missing.next} busy={missing.more} onMore={missing.showMore} />
        </>
      )}
      {tab === 'inbox' && <InvoiceInbox orgCtx={orgCtx} onPost={postFromInbox} />}
      {tab === 'scan' && (sc.oneSite?.id ? <InvoicesSite key={sc.oneSite.id} siteId={sc.oneSite.id} /> : <PickASite />)}
      {splitting && <InvoiceSplit invoice={splitting} onDone={() => { setSplitting(null); inv.reload(); }} onClose={() => setSplitting(null)} />}
    </div>
  );
}
