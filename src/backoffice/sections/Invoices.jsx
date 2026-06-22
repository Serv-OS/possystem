/**
 * Invoices — scan a supplier invoice / delivery note, review, and post to stock.
 * Slice 7. Snap/upload → Claude vision extracts lines → match to stock items →
 * confirm → posts PURCHASE_RECEIPT + updates cost. Always human-reviewed before posting.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { formatRateLabel, purchaseNet } from '../../lib/tax';
import { convert } from '../../lib/stock/conversion';
import { fetchSuppliers, fetchInventoryItems } from '../../lib/stock/data';
import { scanInvoice, postInvoice, fetchInvoices } from '../../lib/stock/purchasing';

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

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: s }, { data: it }, { data: h }] = await Promise.all([fetchSuppliers(loc), fetchInventoryItems(loc), fetchInvoices(loc)]);
    setSuppliers(s || []); setItems(it || []); setHistory(h || []);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
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
    return { newCost, flag };
  };

  const post = async () => {
    const matched = review.lines.filter(l => l.matchedItemId && Number(l.qty) > 0);
    if (!matched.length) { showToast?.('Match at least one line to a stock item', 'error'); return; }
    setPosting(true);
    // Store the VAT computed from the (reviewed) lines, net of any inc-VAT entries.
    const net = review.lines.reduce((s, l) => s + netLineOf(l), 0);
    const vat = review.lines.reduce((s, l) => s + netLineOf(l) * lineRateDec(l), 0);
    const { error } = await postInvoice({
      ...review.header,
      subtotal: Math.round(net * 100) / 100, tax: Math.round(vat * 100) / 100, total: Math.round((net + vat) * 100) / 100,
      flags: undefined,
    }, review.lines.map(l => ({ ...l, flags: lineInfo(l).flag ? [lineInfo(l).flag] : [] })), locId);
    setPosting(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(`Posted invoice — ${matched.length} line${matched.length === 1 ? '' : 's'} received`, 'success');
    setReview(null); await reload();
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 4px', color: 'var(--t1)' }}>Supplier invoices</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18 }}>Snap or upload an invoice / delivery note — it’s read automatically, you check it, then it updates stock and costs.</div>

      {!review && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 10, background: 'var(--acc)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: scanning ? 'default' : 'pointer', opacity: scanning ? 0.6 : 1 }}>
          {scanning ? 'Scanning…' : '📷 Scan / upload invoice'}
          <input type="file" accept="image/*,application/pdf" capture="environment" onChange={onFile} disabled={scanning} style={{ display: 'none' }} />
        </label>
      )}

      {review && (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 24, maxWidth: 1000 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>Review invoice {review.header.ocrConfidence != null && <span style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 400 }}>· {review.header.ocrConfidence}% confidence</span>}</div>
            <button onClick={() => setReview(null)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 13 }}>Discard</button>
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

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr style={{ color: 'var(--t3)', textAlign: 'left' }}>
              {['On invoice', 'Match to stock item', 'Qty', 'Unit', 'Line total', 'VAT', 'New unit cost (ex VAT)', ''].map(h => <th key={h} style={{ padding: '6px 6px', borderBottom: '1px solid var(--bdr)', fontWeight: 600 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {review.lines.map((l, i) => {
                const info = lineInfo(l);
                return (
                  <tr key={i}>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}><input value={l.description} onChange={e => updLine(i, 'description', e.target.value)} style={{ ...field, width: 200 }} /></td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}>
                      <select value={l.matchedItemId} onChange={e => { const it = itemById(e.target.value); updLine(i, 'matchedItemId', e.target.value); if (it && (!l.unit)) updLine(i, 'unit', it.baseUnit); updLine(i, 'purchaseTaxRateId', it?.purchaseTaxRateId || ''); }} style={{ ...field, width: 200, color: l.matchedItemId ? 'var(--t1)' : 'var(--red, #ef4444)' }}>
                        <option value="">— unmatched —</option>
                        {items.filter(it => !it.archivedAt).map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}><input type="number" min="0" step="any" value={l.qty} onChange={e => updLine(i, 'qty', e.target.value)} style={{ ...field, width: 64 }} /></td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}><input value={l.unit} onChange={e => updLine(i, 'unit', e.target.value)} style={{ ...field, width: 64 }} /></td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}><input type="number" min="0" step="any" value={l.lineTotal ?? ''} onChange={e => updLine(i, 'lineTotal', e.target.value === '' ? null : Number(e.target.value))} placeholder={money(Number(l.qty) * Number(l.unitPrice))} style={{ ...field, width: 84 }} /></td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)', whiteSpace: 'nowrap' }}>
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
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)', whiteSpace: 'nowrap' }}>
                      {info.newCost == null ? '—' : currencySymbol() + info.newCost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}
                      {info.flag && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: info.flag.startsWith('↑') || info.flag === 'NEW' ? 'var(--red, #ef4444)' : info.flag.startsWith('↓') ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{info.flag === 'NEW' ? 'new item' : info.flag === 'UNIT?' ? 'unit?' : info.flag}</span>}
                    </td>
                    <td style={{ padding: '5px 6px', borderBottom: '1px solid var(--bg2)' }}><button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 15 }}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

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
                  {read != null && <span style={{ fontSize: 11, color: mismatch ? 'var(--amb,#e8a020)' : 'var(--t3)', marginLeft: 10 }}>{mismatch ? `⚠ read total ${money(read)} — check VAT/lines` : `✓ matches read total`}</span>}
                </div>
                <button onClick={post} disabled={posting} style={{ padding: '10px 22px', borderRadius: 8, background: 'var(--grn, #16a34a)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: posting ? 0.6 : 1 }}>{posting ? 'Posting…' : 'Post to stock'}</button>
              </div>
            );
          })()}
        </div>
      )}

      {/* History */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', margin: '8px 0 10px' }}>Posted invoices</div>
      {history.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No invoices posted yet.</div>}
      {history.length > 0 && (
        <table style={{ width: '100%', maxWidth: 760, borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ color: 'var(--t3)', textAlign: 'left' }}>{['Date', 'Supplier', 'Invoice #', 'Total', 'Status'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {history.map(inv => (
              <tr key={inv.id} style={{ color: 'var(--t1)' }}>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{inv.invoiceDate || (inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '')}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{suppliers.find(s => s.id === inv.supplierId)?.name || '—'}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{inv.invoiceNumber || '—'}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{inv.total != null ? money(inv.total) : '—'}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--grn, #16a34a)' }}>{inv.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
