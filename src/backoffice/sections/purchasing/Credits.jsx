// purchasing/Credits.jsx: Purchasing > Credits (multi site stock Drop 3, v5.11.96, contract 3.2 and
// 4.2). An overcharge or a short delivery makes a credit request (emailed to the supplier through
// po-send's credit_request action); credit notes are matched to the request. Tabs Asked, Received and
// Written off; 100 a page (stock_credits_page).
// 5.12.73 (7 Nov 2026): each credit note shows its Xero mark (In Xero, Failed, Sending) from the sync
// log and a Send to Xero button at a connected site; the 15 minute job sends new ones by itself when
// the site's switch is on (Back Office, Xero, Connection).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { useSiteSymbolOf } from '../stock/useSiteCurrency';
import { stockApi } from '../../../lib/stock/stockApi';
import { listSites } from '../../../lib/stock/supplierListRules';
import { fnErrorText } from '../../../lib/stock/purchasing';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { creditPill, creditReasonWords, CREDIT_TABS } from '../../../lib/stock/purchasingWords';
import { PageHead, TabBar, TableWrap, Th, Td, Pill, Btn, ShowMore, ErrorLine, EmptyLine, useConfirm, ui } from '../stock/stockUi';
import { usePaged } from './usePaged';
import CreditRequestModal from './CreditRequestModal';
import CreditNoteModal from './CreditNoteModal';
import { xeroDocuments, xeroPushCreditNote, xeroDocState } from '../../../lib/xero';

export default function Credits({ orgCtx = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  // 5.12.57: each credit in its own site's currency, not the signed in venue's.
  const symbolOf = useSiteSymbolOf();
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
  // 5.12.73: the Xero mark of every credit note on the page, per site (a site may not be connected).
  const [xeroDocs, setXeroDocs] = useState({});       // noteId -> 'busy' | { link } | { error }
  const [xeroSites, setXeroSites] = useState({});     // locationId -> connected
  useEffect(() => {
    let alive = true;
    const bySite = {};
    for (const r of p.rows || []) for (const n of r.notes || []) (bySite[r.location_id] ||= []).push(n.id);
    const sites = Object.keys(bySite);
    if (!sites.length) return undefined;
    Promise.all(sites.map(async (loc) => {
      const d = await xeroDocuments(loc, 'credit_note', bySite[loc]).catch(() => null);
      return [loc, d];
    })).then((pairs) => {
      if (!alive) return;
      const conn = {}; let marks = {};
      for (const [loc, d] of pairs) { conn[loc] = !!d?.connected; if (d?.docs) marks = { ...marks, ...xeroDocState(d.docs) }; }
      setXeroSites(conn); setXeroDocs((cur) => ({ ...marks, ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v === 'busy')) }));
    });
    return () => { alive = false; };
  }, [p.rows]);
  const sendNote = async (r, n) => {
    setXeroDocs((d) => ({ ...d, [n.id]: 'busy' }));
    try {
      const res = await xeroPushCreditNote(r.location_id, n.id);
      setXeroDocs((d) => ({ ...d, [n.id]: { link: res.link || null } }));
      showToast?.(res.already ? 'Already in Xero' : 'Sent to Xero', 'success');
    } catch (e) {
      setXeroDocs((d) => ({ ...d, [n.id]: { error: e.message } }));
      showToast?.(e.message || 'Could not send to Xero', 'error');
    }
  };
  const noteMark = (r, n) => {
    if (!xeroSites[r.location_id]) return null;
    const st = xeroDocs[n.id];
    if (st === 'busy') return <span style={ui.sub}>Sending to Xero</span>;
    if (st && st.link) return <a href={st.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 700, color: 'var(--acc)', textDecoration: 'none' }}>In Xero</a>;
    if (st && !st.link && !st.error) return <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--grn)' }}>In Xero</span>;
    return (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {st && st.error ? <span style={{ fontSize: 12, color: 'var(--red, #c0392b)' }} title={st.error}>Failed</span> : null}
        <Btn small onClick={() => sendNote(r, n)}>{st && st.error ? 'Retry Xero' : 'Send to Xero'}</Btn>
      </span>
    );
  };

  const email = async (r) => {
    setBusy(r.id);
    const { data, error } = supabase ? await supabase.functions.invoke('po-send', { body: { action: 'credit_request', request_id: r.id, location_id: r.location_id } }) : { data: null, error: new Error('No database') };
    setBusy(null);
    if (!error && data?.ok) { showToast?.(`Emailed to ${r.supplier_name || 'the supplier'}.`, 'success'); p.reload(); return; }
    showToast?.(await fnErrorText(data, error, 'the email could not be sent'), 'error');
  };
  const setStatus = async (r, status) => {
    if (status === 'written_off' && !(await confirm({ title: 'Write off this credit?', words: `${moneyWords(r.amount, symbolOf(r.location_id))} from ${r.supplier_name || 'the supplier'} will not be chased any more.`, yes: 'Write off', danger: true }))) return;
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
                  <Td num>{moneyWords(r.amount, symbolOf(r.location_id))}</Td>
                  <Td num grey>
                    {credited ? moneyWords(credited, symbolOf(r.location_id)) : ''}
                    {(r.notes || []).map((n) => {
                      const mark = noteMark(r, n);
                      return mark ? <div key={n.id} style={{ ...ui.sub, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 4 }}><span>{n.number ? `Note ${n.number}` : 'Credit note'}</span>{mark}</div> : null;
                    })}
                  </Td>
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
