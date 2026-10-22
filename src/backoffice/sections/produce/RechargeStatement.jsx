// src/backoffice/sections/produce/RechargeStatement.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7 F13, decision 6, contract 3.4 and 4.4): the monthly recharge
// statement for company editors. For the month (venue days): what each site paid the central kitchen,
// and stock moved between sites that are different legal companies (different Xero organisations),
// at the price the receiving site paid (stock_recharge_statement). 'Send to Xero as drafts' makes, per
// row, a draft sales invoice in the sending site's Xero (xero-sales recharge_invoice) and a draft bill
// in the receiving site's Xero (xero-bills recharge_bill); both record what they posted
// (stock_recharge_record), so a row sent shows its Xero ids and is never sent twice. Drafts only: the
// accountant approves them in Xero. A site with no Xero organisation says 'No Xero company set'.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { fnErrorText } from '../../../lib/stock/purchasing';
import { monthChoices, rechargeState, rechargeToSend, shortDay } from '../../../lib/stock/kitchenRules';
import { money } from '../../../lib/currency';
import { Btn, Pill, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const todayYmd = () => new Date().toISOString().slice(0, 10);

export default function RechargeStatement({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const orgId = sc.orgId || orgCtx?.orgId || null;
  const months = useMemo(() => monthChoices(todayYmd(), 12), []);
  const [month, setMonth] = useState(months[1]?.value || months[0]?.value || '');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!orgId || !month) return undefined;
    let live = true;
    stockApi.rechargeStatement(orgId, month).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setRows([]); return; }
      setError(null);
      setRows(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
    });
    return () => { live = false; };
  }, [orgId, month, reloads]);

  const sendAll = async () => {
    if (!supabase) return;
    const list = rechargeToSend(rows);
    if (!list.length) { showToast?.('Nothing to send for this month.', 'info'); return; }
    setBusy(true);
    const problems = [];
    for (const r of list) {
      const body = { orgId, month, fromLocationId: r.from_location_id, toLocationId: r.to_location_id };
      if (!r.posted?.xero_invoice_id) {
        const { data, error: e } = await supabase.functions.invoke('xero-sales', { body: { action: 'recharge_invoice', ...body } });
        if (e || data?.error) problems.push(`${r.from_name}: ${await fnErrorText(data, e, 'the invoice did not send')}`);
      }
      if (!r.posted?.xero_bill_id) {
        const { data, error: e } = await supabase.functions.invoke('xero-bills', { body: { action: 'recharge_bill', ...body } });
        if (e || data?.error) problems.push(`${r.to_name}: ${await fnErrorText(data, e, 'the bill did not send')}`);
      }
    }
    setBusy(false);
    showToast?.(problems.length ? problems.join(' ') : `Sent ${list.length} recharge${list.length === 1 ? '' : 's'} to Xero as drafts.`, problems.length ? 'error' : 'success');
    setReloads((n) => n + 1);
  };

  return (
    <div>
      <div style={{ ...ui.row, flexWrap: 'wrap', marginBottom: 12 }}>
        <b style={{ color: 'var(--t1)' }}>Monthly recharge statement</b>
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" style={{ ...ui.input, width: 'auto' }}>
          {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <Btn kind="primary" disabled={busy || !rows || !rechargeToSend(rows).length} onClick={sendAll}>{busy ? 'Sending…' : 'Send to Xero as drafts'}</Btn>
      </div>
      <ErrorLine error={error} />
      {rows === null && !error && <div style={{ padding: 16, color: 'var(--t3)' }}>Loading…</div>}
      {rows && rows.length === 0 && !error && <EmptyLine>No kitchen orders or transfers between companies this month.</EmptyLine>}
      {rows && rows.length > 0 && (
        <TableWrap minWidth={720}>
          <thead><tr><Th>From</Th><Th>To</Th><Th right>Lines</Th><Th right>Amount</Th><Th>Xero</Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const state = rechargeState(r);
              return (
                <tr key={`${r.from_location_id}:${r.to_location_id}`}>
                  <Td>{r.from_name}<div style={ui.sub}>{r.from_tenant ? (r.from_tenant_name || '') : 'No Xero company set'}</div></Td>
                  <Td>{r.to_name}<div style={ui.sub}>{r.to_tenant ? (r.to_tenant_name || '') : 'No Xero company set'}</div></Td>
                  <Td num>{Number(r.lines) || 0}</Td>
                  <Td num strong>{money(r.amount)}</Td>
                  <Td>
                    {state === 'sent' && <Pill tone="good">Sent to Xero {shortDay(r.posted.posted_at)}</Pill>}
                    {state === 'part' && <Pill tone="warn">Half sent</Pill>}
                    {state === 'no_xero' && <Pill tone="neutral">No Xero company set</Pill>}
                    {state === 'ready' && <Pill tone="blue">Ready</Pill>}
                    {r.posted?.xero_invoice_id && <div style={ui.sub}>Invoice {String(r.posted.xero_invoice_id).slice(0, 8)}</div>}
                    {r.posted?.xero_bill_id && <div style={ui.sub}>Bill {String(r.posted.xero_bill_id).slice(0, 8)}</div>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
