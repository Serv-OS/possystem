// src/backoffice/sections/produce/KitchenDeliveryNote.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7 F8, contract 3.4): the delivery note for one central kitchen pick,
// from kitchenRules.deliveryNote (stock_kitchen_pick's answer): the kitchen, the site, the reference,
// every line with ordered, sent, short, lot and use by. On screen it is a card; when the browser prints,
// only this note shows while `printing` is on (the print rule below hides the rest of Back Office).

import { useId } from 'react';
import { dayWords, q3 } from '../../../lib/stock/kitchenRules';
import { ui } from '../stock/stockUi';

const cell = { padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontSize: 13, textAlign: 'left' };

export default function KitchenDeliveryNote({ note, printing = false }) {
  const id = `delivery-note-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!note) return null;
  return (
    <div id={id} className="servos-delivery-note" style={{ ...ui.card, background: 'var(--bg1)' }}>
      {printing && <style>{`@media print { body * { visibility: hidden !important; } #${id}, #${id} * { visibility: visible !important; } #${id} { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none; border: none; color: #000; background: #fff; } }`}</style>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)' }}>{note.title || 'Delivery note'}</div>
          <div style={ui.sub}>From {note.kitchen || 'the central kitchen'} to <b>{note.site || 'the site'}</b></div>
        </div>
        <div style={{ textAlign: 'right', ...ui.sub }}>
          {note.reference && <div>Ref <b>{note.reference}</b></div>}
          {note.day && <div>{dayWords(note.day) || note.day}</div>}
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={cell}>Item</th><th style={cell}>Pack</th><th style={{ ...cell, textAlign: 'right' }}>Ordered</th>
          <th style={{ ...cell, textAlign: 'right' }}>Sent</th><th style={{ ...cell, textAlign: 'right' }}>Short</th><th style={cell}>Lot and use by</th>
        </tr></thead>
        <tbody>
          {(note.rows || []).map((r, i) => (
            <tr key={`${r.name}-${i}`}>
              <td style={cell}>{r.name}</td><td style={cell}>{r.pack}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{q3(r.ordered)}</td><td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{q3(r.sent)}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{r.short > 0 ? q3(r.short) : ''}</td><td style={cell}>{r.lotLine}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...ui.sub, marginTop: 10 }}>
        {note.shortCount ? `${note.shortCount} line${note.shortCount === 1 ? '' : 's'} short. ` : ''}Received by: ____________________
      </div>
    </div>
  );
}
