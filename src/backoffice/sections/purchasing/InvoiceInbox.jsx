// purchasing/InvoiceInbox.jsx: the invoice inbox (multi site stock Drop 3, v5.11.96, contract 3.2 and
// 4.2, decision 12). The address line (or, until the inbound provider exists, Upload only), Upload,
// the list of invoices waiting, "Which site?" to place one by hand, Ignore, Open the file, and Post
// (opens the site's invoice review with the scan).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { placedWords, inboxLine } from '../../../../supabase/functions/_shared/invoiceInbox.js';
import { atWords } from '../../../lib/stock/purchasingWords';
import { Btn, Segmented, TableWrap, Th, Td, ShowMore, ErrorLine, EmptyLine, Notice, ui } from '../stock/stockUi';
import { usePaged } from './usePaged';

const STATUSES = [{ value: 'waiting', label: 'Waiting' }, { value: 'placed', label: 'Placed' }, { value: 'posted', label: 'Posted' }, { value: 'ignored', label: 'Ignored' }];

export default function InvoiceInbox({ orgCtx = null, onPost = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  void orgCtx; // the contract's prop; the inbox needs only the company
  const [status, setStatus] = useState('waiting');
  const [address, setAddress] = useState(undefined);
  const [busy, setBusy] = useState(null);
  const file = useRef(null);
  const editor = sc.canEditCompany('purchasing');
  useEffect(() => {
    let on = true;
    if (!editor || !sc.orgId) return undefined;
    stockApi.inboxAddress(sc.orgId).then((r) => { if (on) setAddress(r.error ? null : (r.data?.address || null)); });
    return () => { on = false; };
  }, [editor, sc.orgId]);
  const fetchPage = useCallback((after) => stockApi.inboxPage({ orgId: sc.orgId, status, after }), [sc.orgId, status]);
  const p = usePaged(fetchPage, `${sc.orgId}|${status}`);
  const upload = async (f) => {
    if (!f) return;
    setBusy('upload');
    const r = await stockApi.inboxUpload(sc.orgId, f);
    setBusy(null);
    if (file.current) file.current.value = '';
    showToast?.(r.error ? r.error.message : `${f.name} is in the inbox.`, r.error ? 'error' : 'success');
    p.reload();
  };
  const place = async (row, siteId) => {
    if (!siteId) return;
    setBusy(row.id);
    const r = await stockApi.inboxPlace(row.id, siteId);
    setBusy(null);
    showToast?.(r.error ? r.error.message : `Placed at ${sc.siteName(siteId)}.`, r.error ? 'error' : 'success');
    p.reload();
  };
  const ignore = async (row) => {
    setBusy(row.id);
    const r = await stockApi.inboxIgnore(row.id);
    setBusy(null);
    if (r.error) showToast?.(r.error.message, 'error');
    p.reload();
  };
  const openFile = async (row) => {
    const r = await stockApi.inboxFileUrl(row.file_path);
    if (r.error || !r.data) { showToast?.(r.error?.message || 'Could not open the file.', 'error'); return; }
    window.open(r.data, '_blank', 'noopener');
  };
  return (
    <div>
      <div style={{ marginBottom: 12 }}><Notice tone="info">{inboxLine((editor && sc.orgId && address) || null)}</Notice></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented value={status} options={STATUSES} onChange={setStatus} small />
        <span style={{ marginLeft: 'auto' }} />
        {editor && <input ref={file} type="file" accept="application/pdf,image/*" style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />}
        {editor && <Btn kind="primary" disabled={busy === 'upload'} onClick={() => file.current?.click()}>{busy === 'upload' ? 'Uploading…' : 'Upload'}</Btn>}
      </div>
      <ErrorLine error={p.error} />
      {p.loading ? <EmptyLine>Loading…</EmptyLine> : !p.rows.length && !p.error ? <EmptyLine>Nothing in the inbox.</EmptyLine> : (
        <TableWrap minWidth={860}>
          <thead><tr><Th>Arrived</Th><Th>From</Th><Th>File</Th><Th>Supplier</Th><Th>Where</Th><Th>Which site?</Th><Th> </Th></tr></thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.id}>
                <Td grey>{atWords(r.created_at, null, { withDate: true })}</Td>
                <Td>{r.from_email || (r.source === 'upload' ? 'Uploaded' : '')}{r.subject ? <div style={ui.sub}>{r.subject}</div> : null}</Td>
                <Td><Btn small kind="link" onClick={() => openFile(r)}>{r.file_name || 'Open the file'}</Btn></Td>
                <Td>{r.supplier_name || ''}{r.account_number ? <div style={ui.sub}>Account {r.account_number}</div> : null}</Td>
                <Td grey>{placedWords(r)}</Td>
                <Td>
                  {(r.status === 'waiting' || r.status === 'placed') && (
                    <select value={r.location_id || ''} disabled={busy === r.id} onChange={(e) => place(r, e.target.value)} style={{ ...ui.input, width: 170 }} aria-label="Which site?">
                      <option value="">Which site?</option>
                      {(sc.sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                </Td>
                <Td right>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    {r.location_id && r.status !== 'posted' && r.status !== 'ignored' && <Btn small kind="primary" onClick={() => onPost?.(r)}>Post</Btn>}
                    {editor && r.status === 'waiting' && <Btn small disabled={busy === r.id} onClick={() => ignore(r)}>Ignore</Btn>}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <ShowMore next={p.next} busy={p.more} onMore={p.showMore} />
    </div>
  );
}
