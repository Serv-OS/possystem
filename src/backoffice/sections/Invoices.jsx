/**
 * Invoices — scan a supplier invoice / delivery note, review, and post to stock.
 * Slice 7. Snap/upload → Claude vision extracts lines → match to stock items →
 * confirm → posts PURCHASE_RECEIPT + updates cost. Always human-reviewed before posting.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { supabase, getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { formatRateLabel, purchaseNet } from '../../lib/tax';
import { convert } from '../../lib/stock/conversion';
import { fetchSuppliers, fetchInventoryItems } from '../../lib/stock/data';
import { scanInvoice, postInvoice, fetchInvoices } from '../../lib/stock/purchasing';
import { xeroStatus, xeroPushBill } from '../../lib/xero';
import { PageHeader, ReportTable, useSort, sortRows, SubToolbar, Tag, Money } from './reports/reportKit';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

const guessMatch = (desc, items) => {
  const d = (desc || '').toLowerCase();
  if (!d) return null;
  let best = null, bestScore = 0;
  for (const it of items) {
    const n = it.name.toLowerCase();
    let score = 0;
    if (n === d) score = 100;
    else if (d.includes(n) || n.includes(d)) score = 50 + Math.min(n.length, d.length);
    else { const words = n.split(/\s+/); score = words.filter(w => w.length > 2 && d.includes(w)).length * 10; }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 10 ? best : null;
};

export default function Invoices() {
  const showToast = useStore(s => s.showToast);
  const taxRates = useStore(s => s.taxRates) || [];
  const ratesById = useMemo(() => { const m = {}; taxRates.forEach(r => { m[r.id] = r; }); return m; }, [taxRates]);
  const lineRateDec = useCallback((l) => Number(ratesById[l.purchaseTaxRateId]?.rate || 0), [ratesById]);
  const rawLineOf = (l) => (l.lineTotal != null ? Number(l.lineTotal) : Number(l.qty) * Number(l.unitPrice));
  // NET line total: strip VAT only when the operator flagged the line inc-VAT.
  const netLineOf = useCallback((l) => purchaseNet(rawLineOf(l), l.priceIncludesTax === true, lineRateDec(l)) ?? 0, [lineRateDec]);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [suppliers, setSuppliers] = useState([]);
  const [items, setItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [review, setReview] = useState(null);   // { header, lines }
  const [posting, setPosting] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);   // the scanned file — stored + attached to the Xero bill
  const [xeroOn, setXeroOn] = useState(false);
  const [xeroPush, setXeroPush] = useState({});            // invoiceId -> 'busy' | {link} | {error}
  // Sorting is applied ONLY to the read-only posted-invoice history (real row ids).
  // The review grid below is addressed by array index and must never be reordered.
  const [histSort, onHistSort] = useSort('date', 'desc');

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: s }, { data: it }, { data: h }] = await Promise.all([fetchSuppliers(loc), fetchInventoryItems(loc), fetchInvoices(loc)]);
    setSuppliers(s || []); setItems(it || []); setHistory(h || []);
    if (loc) xeroStatus(loc).then(st => setXeroOn(!!st?.connected)).catch(() => {});
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const pushToXero = async (invId) => {
    setXeroPush(p => ({ ...p, [invId]: 'busy' }));
    try {
      const r = await xeroPushBill(locId, invId);
      setXeroPush(p => ({ ...p, [invId]: { link: r.link || (r.detail && r.detail.link) || null } }));
      showToast?.(r.already ? 'Already in Xero' : 'Sent to Xero', 'success');
    } catch (e) {
      setXeroPush(p => ({ ...p, [invId]: { error: e.message } }));
      showToast?.(e.message || 'Xero push failed', 'error');
    }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setPendingFile(f);
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result).split(',')[1];
      setScanning(true);
      const { data, error } = await scanInvoice(b64, f.type);
      setScanning(false);
      if (error) { showToast?.(error.message, 'error'); return; }
      const sup = suppliers.find(s => (s.name || '').toLowerCase() === (data.supplier_name || '').toLowerCase());
      setReview({
        header: { supplierId: sup?.id || '', supplierName: data.supplier_name, invoiceNumber: data.invoice_number || '', invoiceDate: data.invoice_date || '', subtotal: data.subtotal, tax: data.tax, total: data.total, ocrConfidence: data.confidence != null ? Math.round(Number(data.confidence) * 100) : null, rawJson: data },
        lines: (data.lines || []).map(l => {
          const m = guessMatch(l.description, items);
          return { matchedItemId: m?.id || '', description: l.description || '', qty: Number(l.qty) || 0, unit: l.unit || (m?.baseUnit) || 'each', unitPrice: Number(l.unit_price) || 0, lineTotal: l.line_total != null ? Number(l.line_total) : null, purchaseTaxRateId: m?.purchaseTaxRateId || '', priceIncludesTax: false };
        }),
      });
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  };

  const itemById = useCallback((id) => items.find(i => i.id === id), [items]);
  const updLine = (i, k, v) => setReview(r => ({ ...r, lines: r.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const updHeader = (k, v) => setReview(r => ({ ...r, header: { ...r.header, [k]: v } }));
  const rmLine = (i) => setReview(r => ({ ...r, lines: r.lines.filter((_, j) => j !== i) }));

  // per-line derived unit cost (per base) + price-change flag vs current cost
  const lineInfo = (l) => {
    const it = itemById(l.matchedItemId);
    if (!it) return { newCost: null, flag: l.matchedItemId ? null : 'NEW' };
    let qtyBase;
    try { qtyBase = convert(Number(l.qty), l.unit || it.baseUnit, it.baseUnit, { itemConversions: (it.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })) }); }
    catch { return { newCost: null, flag: 'UNIT?' }; }
    const total = netLineOf(l);   // NET (VAT stripped if the line is inc-VAT)
    const newCost = qtyBase > 0 ? total / qtyBase : null;
    let flag = null;
    if (newCost != null && it.currentCost != null && it.currentCost > 0) {
      const chg = (newCost - it.currentCost) / it.currentCost;
      if (chg > 0.05) flag = `↑ ${(chg * 100).toFixed(0)}%`;
      else if (chg < -0.05) flag = `↓ ${(Math.abs(chg) * 100).toFixed(0)}%`;
    }
    return { newCost, flag, wasCost: it.currentCost > 0 ? Number(it.currentCost) : null };
  };

  const post = async () => {
    const matched = review.lines.filter(l => l.matchedItemId && Number(l.qty) > 0);
    if (!matched.length) { showToast?.('Match at least one line to a stock item', 'error'); return; }
    setPosting(true);
    // Keep the scanned file: upload to the private invoice-scans bucket so it can be
    // re-viewed later and attached to the Xero bill. Best-effort — posting continues.
    let imagePath = null;
    if (pendingFile && supabase && locId) {
      try {
        const ext = (pendingFile.name?.split('.').pop() || (pendingFile.type === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase();
        const path = `${locId}/${crypto.randomUUID()}.${ext}`;
        const up = await supabase.storage.from('invoice-scans').upload(path, pendingFile, { contentType: pendingFile.type || 'image/jpeg' });
        if (!up.error) imagePath = path;
      } catch { /* non-fatal */ }
    }
    // Store the VAT computed from the (reviewed) lines, net of any inc-VAT entries.
    const net = review.lines.reduce((s, l) => s + netLineOf(l), 0);
    const vat = review.lines.reduce((s, l) => s + netLineOf(l) * lineRateDec(l), 0);
    const { error } = await postInvoice({
      ...review.header, imagePath,
      subtotal: Math.round(net * 100) / 100, tax: Math.round(vat * 100) / 100, total: Math.round((net + vat) * 100) / 100,
      flags: undefined,
    }, review.lines.map(l => ({ ...l, flags: lineInfo(l).flag ? [lineInfo(l).flag] : [] })), locId);
    setPosting(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(`Posted invoice — ${matched.length} line${matched.length === 1 ? '' : 's'} received`, 'success');
    setReview(null); setPendingFile(null); await reload();
  };

  const supplierNameOf = useCallback((inv) => suppliers.find(s => s.id === inv.supplierId)?.name || '', [suppliers]);

  // Read-only history — safe to sort (each row carries its own invoice id).
  const historyRows = useMemo(() => sortRows(history, histSort, {
    date: (inv) => inv.invoiceDate || inv.createdAt || '',
    supplier: supplierNameOf,
    number: (inv) => inv.invoiceNumber || '',
    total: (inv) => (inv.total == null ? null : Number(inv.total)),
    status: (inv) => inv.status || '',
  }), [history, histSort, supplierNameOf]);

  const historyCols = useMemo(() => [
    { key: 'date', label: 'Date', sortable: true, render: (inv) => <span style={{ color: 'var(--t3)', whiteSpace: 'nowrap' }}>{inv.invoiceDate || (inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '')}</span> },
    { key: 'supplier', label: 'Supplier', sortable: true, render: (inv) => <span style={{ color: 'var(--t1)' }}>{supplierNameOf(inv) || '—'}</span> },
    { key: 'number', label: 'Invoice #', sortable: true, render: (inv) => inv.invoiceNumber || '—' },
    { key: 'total', label: 'Total', align: 'right', sortable: true, render: (inv) => <Money v={inv.total} /> },
    { key: 'status', label: 'Status', sortable: true, render: (inv) => <Tag label={inv.status} tone={(inv.status || '').toUpperCase() === 'POSTED' ? 'good' : 'neutral'} /> },
    ...(xeroOn ? [{
      key: 'xero', label: 'Xero', render: (inv) => {
        // v5.5.923 — ONLY a POSTED invoice may go to Xero. PO-attached paperwork rows are
        // status REVIEW with a null total; pushing one created an AUTHORISED £0 bill in the
        // venue's accounts AND the sync-log dedupe then blocked the real push forever.
        if ((inv.status || '').toUpperCase() !== 'POSTED') return <span style={{ color: 'var(--t4)', fontSize: 11.5 }} title="Attached paperwork — post the invoice before sending it to Xero">not posted</span>;
        const st = xeroPush[inv.id];
        if (st === 'busy') return <span style={{ color: 'var(--t3)', fontSize: 12 }}>Sending…</span>;
        if (st && st.link) return <a href={st.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}>✓ In Xero ↗</a>;
        if (st && !st.link && !st.error) return <span style={{ color: 'var(--grn)', fontSize: 12, fontWeight: 700 }}>✓ In Xero</span>;
        return <button onClick={() => pushToXero(inv.id)} style={{ padding: '5px 11px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Push to Xero</button>;
      },
    }] : []),
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  ], [supplierNameOf, xeroOn, xeroPush]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <PageHeader
        eyebrow="PURCHASING"
        title="Supplier invoices"
        subtitle="Snap or upload an invoice / delivery note — it’s read automatically, you check it, then it updates stock and costs."
      />

      {!review && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '11px 18px', borderRadius: 12, background: 'var(--acc)', color: '#0b0c10', fontSize: 13.5, fontWeight: 700, cursor: scanning ? 'default' : 'pointer', opacity: scanning ? 0.6 : 1 }}>
          {scanning ? 'Scanning…' : '📷 Scan / upload invoice'}
          <input type="file" accept="image/*,application/pdf" capture="environment" onChange={onFile} disabled={scanning} style={{ display: 'none' }} />
        </label>
      )}

      {review && (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 18, marginBottom: 24, maxWidth: 1000 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--t1)', letterSpacing: '-.2px' }}>Review invoice {review.header.ocrConfidence != null && <span style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 500 }}>· {review.header.ocrConfidence}% confidence</span>}</div>
            <button onClick={() => setReview(null)} style={{ background: 'transparent', border: '1px solid var(--bdr)', borderRadius: 9, padding: '5px 11px', color: 'var(--t3)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>Discard</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div><label style={lbl}>Supplier {review.header.supplierName ? `(read: ${review.header.supplierName})` : ''}</label>
              <select value={review.header.supplierId} onChange={e => updHeader('supplierId', e.target.value)} style={field}>
                <option value="">— match supplier —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Invoice #</label><input value={review.header.invoiceNumber} onChange={e => updHeader('invoiceNumber', e.target.value)} style={field} /></div>
            <div><label style={lbl}>Date</label><input type="date" value={review.header.invoiceDate || ''} onChange={e => updHeader('invoiceDate', e.target.value)} style={field} /></div>
          </div>

          {/* Review grid — rows are addressed by ARRAY INDEX (updLine/rmLine), so this
              table is intentionally never sorted or reordered. Presentation only. */}
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr style={{ textAlign: 'left' }}>
              {['On invoice', 'Match to stock item', 'Qty', 'Unit', 'Line total', 'VAT', 'New unit cost (ex VAT)', ''].map(h => <th key={h} style={{ padding: '10px 10px', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {review.lines.map((l, i) => {
                const info = lineInfo(l);
                return (
                  <tr key={i}>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}><input value={l.description} onChange={e => updLine(i, 'description', e.target.value)} style={{ ...field, width: 200 }} /></td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}>
                      <select value={l.matchedItemId} onChange={e => { const it = itemById(e.target.value); updLine(i, 'matchedItemId', e.target.value); if (it && (!l.unit)) updLine(i, 'unit', it.baseUnit); updLine(i, 'purchaseTaxRateId', it?.purchaseTaxRateId || ''); }} style={{ ...field, width: 200, color: l.matchedItemId ? 'var(--t1)' : 'var(--red)', borderColor: l.matchedItemId ? 'var(--bdr)' : 'var(--red-b)' }}>
                        <option value="">— unmatched —</option>
                        {items.filter(it => !it.archivedAt).map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}><input type="number" min="0" step="any" value={l.qty} onChange={e => updLine(i, 'qty', e.target.value)} style={{ ...field, width: 64 }} /></td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}><input value={l.unit} onChange={e => updLine(i, 'unit', e.target.value)} style={{ ...field, width: 64 }} /></td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}><input type="number" min="0" step="any" value={l.lineTotal ?? ''} onChange={e => updLine(i, 'lineTotal', e.target.value === '' ? null : Number(e.target.value))} placeholder={money(Number(l.qty) * Number(l.unitPrice))} style={{ ...field, width: 84 }} /></td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                      <select value={l.purchaseTaxRateId || ''} onChange={e => updLine(i, 'purchaseTaxRateId', e.target.value)} style={{ ...field, width: 78, display: 'inline-block' }}>
                        <option value="">No VAT</option>
                        {taxRates.filter(r => r.active !== false).map(r => <option key={r.id} value={r.id}>{Math.round(Number(r.rate) * 100)}%</option>)}
                      </select>
                      {lineRateDec(l) > 0 && (
                        <label title="Tick if the line total above already includes VAT" style={{ display: 'inline-flex', gap: 3, alignItems: 'center', fontSize: 10, color: 'var(--t3)', marginLeft: 5, cursor: 'pointer' }}>
                          <input type="checkbox" checked={l.priceIncludesTax === true} onChange={e => updLine(i, 'priceIncludesTax', e.target.checked)} /> inc
                        </label>
                      )}
                    </td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                      {info.newCost == null ? '—' : currencySymbol() + info.newCost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}
                      {info.flag && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: info.flag.startsWith('↑') || info.flag === 'NEW' ? 'var(--red)' : info.flag.startsWith('↓') ? 'var(--grn)' : 'var(--t3)' }}>{info.flag === 'NEW' ? 'new item' : info.flag === 'UNIT?' ? 'unit?' : info.flag}</span>}
                      {info.flag && info.wasCost != null && info.flag !== 'NEW' && info.flag !== 'UNIT?' && <span style={{ marginLeft: 5, fontSize: 10.5, color: 'var(--t4)' }} title="cost before this invoice">was {currencySymbol()}{info.wasCost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}</span>}
                    </td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid var(--bdr)' }}><button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 15 }}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {(() => {
            const net = review.lines.reduce((s, l) => s + netLineOf(l), 0);
            const vat = review.lines.reduce((s, l) => s + netLineOf(l) * lineRateDec(l), 0);
            const gross = net + vat;
            const read = review.header.total;
            const mismatch = read != null && Math.abs(gross - Number(read)) > 0.01;
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, color: 'var(--t1)', marginRight: 'auto' }}>
                  Subtotal (ex VAT): <b>{money(net)}</b> · VAT: <b>{money(vat)}</b> · Total: <b>{money(gross)}</b>
                  {read != null && <span style={{ fontSize: 11, color: mismatch ? 'var(--amber)' : 'var(--t3)', marginLeft: 10 }}>{mismatch ? `⚠ read total ${money(read)} — check VAT/lines` : `✓ matches read total`}</span>}
                </div>
                <button onClick={post} disabled={posting} style={{ padding: '9px 18px', borderRadius: 12, background: 'var(--grn)', color: '#0b0c10', border: 0, fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: posting ? 'default' : 'pointer', opacity: posting ? 0.5 : 1 }}>{posting ? 'Posting…' : 'Post to stock'}</button>
              </div>
            );
          })()}
        </div>
      )}

      {/* History — read-only, real row ids, so sorting is safe here. */}
      <div style={{ maxWidth: 860 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)', letterSpacing: '-.3px', margin: '8px 0 8px' }}>Posted invoices</div>
        <SubToolbar count={`${history.length} invoice${history.length === 1 ? '' : 's'}`} />
        <ReportTable
          columns={historyCols}
          rows={historyRows}
          sort={histSort}
          onSort={onHistSort}
          empty="No invoices posted yet."
        />
      </div>
    </div>
  );
}
