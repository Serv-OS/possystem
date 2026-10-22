// src/backoffice/sections/produce/KitchenPickSend.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7 F8 and F12, contract 3.4 and 4.4): pick and send for each site's
// order with this central kitchen for one day. Per order: the packs sent per line (as ordered unless
// changed; less is short), then Send: stock_kitchen_pick makes ONE transfer for the order (kind
// central_kitchen, linked to the order) and runs the 'out' leg, so the stock leaves the kitchen at the
// kitchen's cost and is in transit until the site receives it in Transfers (the order closes then;
// it is never received as a delivery). The answer carries the lot and use by of the batch picked and
// the delivery note: 'Print delivery note and labels' opens the browser print dialog for the note and
// prints one label per line through the Drop 2 label route (Label printer role).

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { printLabel } from '../../../lib/labelPrint';
import { batchLabelDoc, labelCols } from '../../../lib/stock/batchLabel';
import { pickLines, shortLines, sentAsOrdered, deliveryNote, labelsOf, q3 } from '../../../lib/stock/kitchenRules';
import { Btn, Notice, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';
import KitchenDeliveryNote from './KitchenDeliveryNote';

export default function KitchenPickSend({ kitchenId, day }) {
  const showToast = useStore((s) => s.showToast);
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState({});          // po id -> { po line id -> packs typed }
  const [busy, setBusy] = useState(null);        // po id sending
  const [notes, setNotes] = useState({});        // po id -> delivery note model (after Send)
  const [printing, setPrinting] = useState(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    stockApi.kitchenOrdersIn(kitchenId, day).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setOrders([]); return; }
      setError(null);
      setOrders(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
    });
    return () => { live = false; };
  }, [kitchenId, day, reloads]);

  const send = async (o) => {
    const { lines, error: bad } = pickLines(o, sent[o.po_id] || {});
    if (bad) { showToast?.(bad, 'error'); return; }
    setBusy(o.po_id);
    const r = await stockApi.kitchenPick(o.po_id, lines);
    setBusy(null);
    if (r.error) { showToast?.(r.error.message || 'It did not send.', 'error'); return; }
    const sentNow = {};
    for (const l of lines) sentNow[l.po_line_id] = l.qty_packs_sent;
    const model = deliveryNote(r.data, { ...o, lines: (o.lines || []).map((l) => ({ ...l, qty_packs_sent: sentNow[l.po_line_id] ?? 0 })) });
    setNotes((m) => ({ ...m, [o.po_id]: model }));
    const short = Array.isArray(r.data?.short_lines) ? r.data.short_lines.length : model.shortCount;
    showToast?.(`Sent ${r.data?.reference || ''} to ${o.site_name || 'the site'}${short ? `, ${short} line${short === 1 ? '' : 's'} short` : ''}. In transit until they receive it.`, 'success');
    setReloads((n) => n + 1);
  };

  const printAll = async (poId) => {
    const note = notes[poId];
    if (!note) return;
    setPrinting(poId);
    // the delivery note: once this note carries its print rule, the browser's dialog shows only it
    await new Promise((res) => setTimeout(res, 60));
    try { window.print(); } catch { /* no print dialog here */ }
    let failed = 0; let firstError = '';
    for (const lab of labelsOf(note)) {
      const res = await printLabel((p, spec) => batchLabelDoc({ name: lab.name, useBy: lab.useBy || null, lot: lab.lot || null, qty: lab.qty, unit: lab.pack || '', madeBy: note.kitchen || null, allergens: lab.allergens }, { cols: labelCols({ ...p, cols: spec?.cols }) }), {
        label: `Delivery label: ${lab.name}`, metadata: { kind: 'central_kitchen', location_id: kitchenId, site: note.site, reference: note.reference },
      });
      if (!res?.ok) { failed++; firstError ||= res?.error || 'The label did not print.'; }
    }
    setPrinting(null);
    if (failed) showToast?.(`${failed} label${failed === 1 ? '' : 's'} did not print. ${firstError}`, 'error');
  };

  if (orders === null) return <div style={{ padding: 16, color: 'var(--t3)' }}>Loading…</div>;
  const toPick = orders.filter((o) => !o.transfer_id && String(o.status || '').toUpperCase() === 'SENT');
  const shownNotes = Object.entries(notes);

  return (
    <div>
      <Notice tone="info">Amounts sent, lot and use by from the batch, delivery note and labels. Stock shows as in transit until the site receives it.</Notice>
      <ErrorLine error={error} />
      {!error && toPick.length === 0 && shownNotes.length === 0 && <EmptyLine>Nothing left to pick for this day.</EmptyLine>}
      {toPick.map((o) => {
        const mine = sent[o.po_id] || sentAsOrdered(o);
        const shorts = shortLines(o, mine);
        return (
          <div key={o.po_id} style={{ ...ui.card, marginBottom: 12 }}>
            <div style={{ ...ui.row, marginBottom: 8, flexWrap: 'wrap' }}>
              <b style={{ color: 'var(--t1)' }}>{o.site_name || 'Site'}</b>
              {o.reference && <span style={ui.sub}>{o.reference}</span>}
            </div>
            <TableWrap minWidth={520}>
              <thead><tr><Th>Item</Th><Th>Pack</Th><Th right>Ordered</Th><Th right>Sent</Th><Th right>Short</Th></tr></thead>
              <tbody>
                {(o.lines || []).map((l) => {
                  const s = shorts.find((x) => x.po_line_id === l.po_line_id);
                  return (
                    <tr key={l.po_line_id}>
                      <Td>{l.name}</Td><Td grey>{l.pack_label || ''}</Td><Td num>{q3(l.qty_packs)}</Td>
                      <Td num>
                        <input type="number" min="0" step="any" value={mine[l.po_line_id] ?? l.qty_packs} aria-label={`${l.name} sent`}
                          onChange={(e) => setSent((m) => ({ ...m, [o.po_id]: { ...mine, [l.po_line_id]: e.target.value } }))} style={{ ...ui.input, width: 80, textAlign: 'right' }} />
                      </Td>
                      <Td num>{s ? <span style={{ color: 'var(--amber, #F5A623)', fontWeight: 700 }}>{s.short}</span> : ''}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
            <div style={{ ...ui.row, marginTop: 10 }}>
              <Btn kind="primary" disabled={busy === o.po_id} onClick={() => send(o)}>{busy === o.po_id ? 'Sending…' : 'Send'}</Btn>
              {shorts.length > 0 && <span style={ui.sub}>{shorts.length} line{shorts.length === 1 ? '' : 's'} short</span>}
            </div>
          </div>
        );
      })}
      {shownNotes.map(([poId, note]) => (
        <div key={poId} style={{ ...ui.card, marginBottom: 12 }}>
          <div style={{ ...ui.row, flexWrap: 'wrap', marginBottom: 8 }}>
            <b style={{ color: 'var(--t1)' }}>Sent: {note.reference} to {note.site}</b>
            <Btn kind="primary" disabled={printing === poId} onClick={() => printAll(poId)}>{printing === poId ? 'Printing…' : 'Print delivery note and labels'}</Btn>
          </div>
          <KitchenDeliveryNote note={note} printing={printing === poId} />
        </div>
      ))}
    </div>
  );
}
