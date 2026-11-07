// src/backoffice/sections/xero/BillsHistory.jsx
//
// Bills and credit notes (5.12.73, 7 Nov 2026): every supplier invoice and credit note this site sent
// to Xero, failed to send, or is sending, over the last 60 days, newest first, with Open in Xero
// links and a Retry button on a failure. Under the Postings tab, below the daily sales. The header
// line says whether the site sends them by itself (the switch on the Connection tab) and since when.
// Retry goes through the same xero-bills call as the Push buttons on Purchasing; nothing here
// posts by itself.
import { useCallback, useEffect, useState } from 'react';
import { xeroBillsHistory, xeroPushBill, xeroPushCreditNote, autoBillsWords } from '../../../lib/xero';
import { money } from '../../../lib/currency';
import { S } from './xeroUi';

const KIND = { bill: 'Bill', credit_note: 'Credit note' };
const STATUS = { ok: ['Sent', 'var(--grn)'], error: ['Failed', 'var(--red, #c0392b)'], sending: ['Sending', 'var(--t3)'] };

function billsHistoryLine(rows = []) {
  const failed = rows.filter((r) => r.status === 'error').length;
  const sent = rows.filter((r) => r.status === 'ok').length;
  if (!rows.length) return 'Nothing sent in the last 60 days.';
  return `${sent} sent${failed ? `, ${failed} failed` : ''} in the last 60 days.`;
}

export default function BillsHistory({ locId, currency }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState({});
  const load = useCallback(async () => {
    if (!locId) return;
    try { setData(await xeroBillsHistory(locId, 60)); setErr(''); } catch (e) { setErr(e.message || 'Could not read the bills'); }
  }, [locId]);
  useEffect(() => { load(); }, [load]);
  const retry = async (r) => {
    const k = `${r.kind}|${r.refId}`;
    setBusy((b) => ({ ...b, [k]: true }));
    try {
      if (r.kind === 'bill') await xeroPushBill(locId, r.refId); else await xeroPushCreditNote(locId, r.refId);
      await load();
    } catch (e) { setErr(e.message || 'Could not send'); await load(); } finally { setBusy((b) => ({ ...b, [k]: false })); }
  };
  const th = { textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--t4)', padding: '8px 10px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' };
  const rows = data?.rows || [];
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Bills and credit notes</div>
      <div style={S.note}>{data ? autoBillsWords(data.autoBills ? data.autoBillsSince : null) : 'Loading…'}</div>
      {data && <div style={{ ...S.note, marginTop: 4 }}>{billsHistoryLine(rows)}</div>}
      {err && <div style={{ ...S.note, color: 'var(--red, #c0392b)', marginTop: 6 }}>{err}</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 10, border: '1px solid var(--bdr)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th style={th}>Date</th><th style={th}>Kind</th><th style={th}>Number</th><th style={th}>Supplier</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Status</th><th style={th}>How</th><th style={th}> </th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const [label, colour] = STATUS[r.status] || ['Unknown', 'var(--t3)'];
                const k = `${r.kind}|${r.refId}`;
                return (
                  <tr key={k}>
                    <td style={S.td}>{r.date || ''}</td>
                    <td style={S.td}>{KIND[r.kind] || r.kind}</td>
                    <td style={S.td}>{r.number || ''}</td>
                    <td style={S.td}>{r.supplier || ''}</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>{r.amount != null ? money(r.amount, currency) : ''}</td>
                    <td style={{ ...S.td, color: colour, fontWeight: 700 }} title={r.error || ''}>{label}{r.status === 'error' && r.error ? <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--t3)', maxWidth: 320 }}>{r.error}</div> : null}</td>
                    <td style={S.td}>{r.auto ? 'By itself' : 'Pushed'}{r.attempts > 1 ? ` (${r.attempts} tries)` : ''}</td>
                    <td style={S.td}>
                      {r.status === 'ok' && r.link ? <a href={r.link} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)', fontWeight: 700, textDecoration: 'none' }}>Open in Xero</a> : null}
                      {r.status === 'error' ? <button type="button" style={S.ghost} disabled={!!busy[k]} onClick={() => retry(r)}>{busy[k] ? 'Sending…' : 'Retry'}</button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
