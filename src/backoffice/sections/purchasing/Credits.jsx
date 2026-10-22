// purchasing/Credits.jsx: Purchasing > Credits (multi site stock Drop 3, v5.11.96, contract 3.2 and
// 4.2). An overcharge or a short delivery makes a credit request (emailed to the supplier through
// po-send's credit_request action); credit notes are matched to the request. Tabs Asked, Received and
// Written off; 100 a page (stock_credits_page).

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { fnErrorText } from '../../../lib/stock/purchasing';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { creditPill, creditReasonWords, CREDIT_TABS } from '../../../lib/stock/purchasingWords';
import { PageHead, TabBar, TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, useConfirm, ui } from '../stock/stockUi';
import { usePaged } from './usePaged';
import CreditRequestModal from './CreditRequestModal';
import CreditNoteModal from './CreditNoteModal';

export default function Credits({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the list needs only the scope
  const [tab, setTab] = useState('asked');
  const [editing, setEditing] = useState(null);   // a request or {} for new
  const [noting, setNoting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirm, dialog] = useConfirm();
  const sites = useMemo(() => listSites({ isAll: sc.isAll, scopeSites: sc.scopeSites }), [sc.isAll, sc.scopeSites]);
  const fetchPage = useCallback((after) => stockApi.creditsPage({ orgId: sc.orgId, sites, status: tab, after }), [sc.orgId, sites, tab]);
  const p = usePaged(fetchPage, `${sc.orgId}|${sites ? sites.join(',') : 'all'}|${tab}`);
  const editor = sc.canEditCompany('purchasing');

  const email = async (r) => {
    setBusy(r.id);
    const { data, error } = supabase ? await supabase.functions.invoke('po-send', { body: { action: 'credit_request', request_id: r.id, location_id: r.location_id } }) : { data: null, error: new Error('No database') };
    setBusy(null);
    if (!error && data?.ok) { showToast?.(`Emailed to ${r.supplier_name || 'the supplier'}.`, 'success'); p.reload(); return; }
    showToast?.(await fnErrorText(data, error, 'the email could not be sent'), 'error');
  };
  const setStatus = async (r, status) => {
    if (status === 'written_off' && !(await confirm({ title: 'Write off this credit?', words: `${moneyWords(r.amount)} from ${r.supplier_name || 'the supplier'} will not be chased any more.`, yes: 'Write off', danger: true }))) return;
    setBusy(r.id);
    const res = await stockApi.setCreditStatus(r.id, status, r.row_version ?? null);
    setBusy(null);
    if (res.error) { showToast?.(res.error.message, 'error'); return; }
    p.reload();
  };

  return (
    <div style={ui.page}>
      {dialog}
      <PageHead title="Credits" sub="An overcharge or a short delivery makes a credit request (emailed to the supplier). Credit notes are matched to the request.">
        <Btn kind="primary" onClick={() => setEditing({})}>New credit request</Btn>
      </PageHead>
      <TabBar tabs={CREDIT_TABS.map(([id, label]) => ({ id, label }))} value={tab} onChange={setTab} />
      <ErrorLine error={p.error} />
      {p.loading ? <EmptyLine>Loading…</EmptyLine> : !p.rows.length && !p.error ? <EmptyLine>Nothing here.</EmptyLine> : (
        <TableWrap minWidth={900}>
          <thead><tr><Th>Site</Th><Th>Supplier</Th><Th>Reason</Th><Th right>Asked</Th><Th right>Credited</Th><Th>Emailed</Th><Th>Status</Th><Th> </Th></tr></thead>
          <tbody>
            {p.rows.map((r) => {
              const pl = creditPill(r.status);
              const credited = (r.notes || []).reduce((s, n) => s + (Number(n.amount) || 0), 0);
              return (
                <tr key={r.id}>
                  <Td strong>{r.site_name || sc.siteName(r.location_id)}</Td>
                  <Td>{r.supplier_name || ''}</Td>
                  <Td>{creditReasonWords(r.reason)}{(r.lines || []).length ? <div style={ui.sub}>{r.lines.length} line{r.lines.length === 1 ? '' : 's'}</div> : null}</Td>
                  <Td num>{moneyWords(r.amount)}</Td>
                  <Td num grey>{credited ? moneyWords(credited) : ''}</Td>
                  <Td grey>{r.emailed_at ? dayWords(String(r.emailed_at).slice(0, 10)) : 'Not yet'}</Td>
                  <Td><Pill tone={pl.tone}>{pl.text}</Pill></Td>
                  <Td right>
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {r.status === 'asked' && <Btn small disabled={busy === r.id} onClick={() => email(r)}>{r.emailed_at ? 'Email again' : 'Email'}</Btn>}
                      {r.status === 'asked' && <Btn small onClick={() => setNoting(r)}>Add credit note</Btn>}
                      {r.status === 'asked' && <Btn small onClick={() => setEditing(r)}>Change</Btn>}
                      {r.status === 'asked' && editor && <Btn small kind="danger" disabled={busy === r.id} onClick={() => setStatus(r, 'written_off')}>Write off</Btn>}
                      {r.status === 'written_off' && <Btn small disabled={busy === r.id} onClick={() => setStatus(r, 'asked')}>Ask again</Btn>}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <ShowMore next={p.next} busy={p.more} onMore={p.showMore} />
      {editing && <CreditRequestModal request={editing.id ? editing : null} onDone={() => { setEditing(null); p.reload(); }} onClose={() => setEditing(null)} />}
      {noting && <CreditNoteModal request={noting} onDone={() => { setNoting(null); p.reload(); }} onClose={() => setNoting(null)} />}
    </div>
  );
}
