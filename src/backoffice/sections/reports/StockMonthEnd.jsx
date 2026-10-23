// src/backoffice/sections/reports/StockMonthEnd.jsx
//
// MULTI SITE STOCK, Drop 4b (v5.11.100, design 5.23): Month end pack. Per site and per legal company
// (the Xero organisation each venue is connected to), read from the locked month's snapshot: opening
// and closing stock, the movement, purchases, transfers and recharges, waste, goods received not
// invoiced, credits still outstanding, stock in transit, and closing stock by category. Each legal
// company has its closing stock journal box: it goes to Xero as a DRAFT only when a person presses
// Send (never by itself), only once the month is locked at every site of that company, and Xero keeps
// it as a draft until the accountant posts it. Figures are stock_report_month_end's; the journal
// is the xero-stock-journal edge function's.

import { useEffect, useState } from 'react';
import { StockReportFrame, SiteTotalsTable, DrillTable, StockLoading, StockError, useStockReport } from './_stockKit';
import { TabBar, Btn, Pill, EmptyLine, Notice, useConfirm } from '../stock/stockUi';
import { useExportFlow } from './ExportStatus';
import { useStockScope } from '../../StockScope';
import { col, withSites, siteNameOf, toggleSort, sortLoaded, notesOf, whenWords, monthOf, monthWords, recentMonths, initialPick } from '../../../lib/stock/reportView.js';
import { money } from '../../../lib/currency';

const TITLE = 'Month end pack';
const SUB = 'For the accountant, per legal company, from the locked month: closing stock, purchases, transfers and recharges, waste, goods received not invoiced and credits still outstanding.';

const TOTALS = [
  col('_locked', 'Month locked'), col('opening_value', 'Opening stock', 'money'), col('closing_value', 'Closing stock', 'money'), col('movement', 'Movement', 'money'),
  col('purchases', 'Purchases', 'money'), col('transfers_in', 'Transfers in', 'money'), col('transfers_out', 'Transfers out', 'money'),
  col('recharges_in', 'Recharges in', 'money'), col('recharges_out', 'Recharges out', 'money'), col('waste_value', 'Waste', 'money'),
  col('grni', 'Received, not invoiced', 'money', { hint: 'at delivery value' }), col('credits_outstanding', 'Credits outstanding', 'money'),
  col('in_transit', 'In transit', 'money'), col('legal_company', 'Legal company'),
];
const LEGAL_COLS = [
  col('legal_company', 'Legal company'), col('_sites', 'Sites'), col('_locked', 'Locked'), col('opening_value', 'Opening stock', 'money'),
  col('closing_value', 'Closing stock', 'money'), col('internal_margin', 'Kitchen margin taken out', 'money'), col('movement', 'Movement', 'money'),
  col('purchases', 'Purchases', 'money'), col('waste_value', 'Waste', 'money'), col('grni', 'Received, not invoiced', 'money'),
  col('credits_outstanding', 'Credits outstanding', 'money'), col('recharges_in', 'Recharges in', 'money'), col('recharges_out', 'Recharges out', 'money'),
  col('_journal', 'Closing stock journal'),
];
const CATEGORY_COLS = [col('site', 'Site'), col('name', 'Category'), col('closing_value', 'Closing stock', 'money')];
const TABS = [{ id: 'site', label: 'By site' }, { id: 'legal', label: 'By legal company' }, { id: 'category', label: 'By category' }];
const SORT_KEYS = { _locked: 'locked', _sites: 'legal_company', _journal: 'legal_company' };
const DRAFT_LINE = 'Closing stock journals go to Xero as a draft. Nothing is posted until your accountant posts it in Xero.';
const JOURNAL_WORDS = {
  not_locked: 'Lock the month at every site first.',
  not_connected: 'Connect this legal company to Xero first.',
  needs_reconnect: 'Reconnect Xero to allow stock journals.',
  ready: 'Ready to send to Xero as a draft.',
  sent: 'Sent to Xero as a draft.',
  sending: 'This journal is already being sent.',
};
const isMonthStart = (v) => typeof v === 'string' && /^\d{4}-\d{2}-01$/.test(v);

/** One legal company's closing stock journal: the status, a preview, the two accounts and Send. */
function JournalBox({ row, orgId, from, to, api, onSent }) {
  const scope = useStockScope();
  const [confirm, dialog] = useConfirm();
  const [preview, setPreview] = useState(null);
  const [accounts, setAccounts] = useState({ stockAccount: '', movementAccount: '' });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const j = row.journal || {};
  const status = sent ? 'sent' : (preview?.status && preview.status !== 'ready' ? preview.status : (row.status || j.status)) || 'not_locked';
  // the server's amount for this legal company (every site of it), the same the send uses
  const serverAmount = row.amount ?? row.movement;
  const cur = row.currency;
  const missing = (row.sites || []).filter((s) => s && s.locked === false).map((s) => s.site).filter(Boolean);
  const canCall = typeof api?.monthEndJournal === 'function';
  const body = { orgId, from, to, tenantId: row.tenant_id };

  const look = async () => {
    setBusy('preview'); setError(null);
    const res = await api.monthEndJournal('preview', body);
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    const d = res.data || {};
    setPreview(d);
    const pick = (k) => (d.last && d.last[k]) || (d.suggested && d.suggested[k]) || '';
    setAccounts({ stockAccount: pick('stockAccount'), movementAccount: pick('movementAccount') });
  };
  const send = async () => {
    if (!accounts.stockAccount || !accounts.movementAccount) { setError(new Error('Pick the stock account and the stock movement account.')); return; }
    const amount = preview?.amount ?? serverAmount;
    const ok = await confirm({
      title: `Send the closing stock journal for ${row.legal_company || 'this company'}?`,
      words: `${money(amount || 0, cur)} for ${monthWords(from)} goes to Xero as a DRAFT manual journal. Nothing is posted until your accountant posts it in Xero.`,
      yes: 'Send as a draft',
    });
    if (!ok) return;
    setBusy('send'); setError(null);
    const res = await api.monthEndJournal('send', { ...body, ...accounts });
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    if (res.data && res.data.ok === false) { setError(new Error(res.data.error || JOURNAL_WORDS[res.data.status] || 'Not sent.')); return; }
    setSent(res.data || { status: 'sent' });
    onSent?.();
  };
  const accountList = Array.isArray(preview?.accounts) ? preview.accounts : [];
  const select = (key, label) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--t3)' }}>
      {label}
      <select value={accounts[key]} onChange={(e) => setAccounts((a) => ({ ...a, [key]: e.target.value }))} aria-label={label}
        style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, minWidth: 240 }}>
        <option value="">Choose an account</option>
        {accountList.map((a) => <option key={a.code} value={a.code}>{`${a.code} ${a.name}`}</option>)}
      </select>
    </label>
  );

  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 16, display: 'grid', gap: 10 }} data-testid="stock-journal-box">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>{row.legal_company || 'Not connected to Xero'}</b>
        <Pill tone={status === 'sent' ? 'good' : status === 'ready' ? 'neutral' : 'warn'}>{status === 'sent' ? 'Draft in Xero' : status === 'ready' ? 'Ready' : 'Not yet'}</Pill>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>Closing stock journal, {monthWords(from)}: movement {money(serverAmount || 0, cur)}{Array.isArray(row.sites) ? `, ${row.sites.length} ${row.sites.length === 1 ? 'site' : 'sites'}` : ''}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t2)' }}>{(status === j.status && j.words) || JOURNAL_WORDS[status] || ''}</div>
      {status === 'not_locked' && missing.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Not locked yet: {missing.join(', ')}. Lock it in Inventory, Counts (head office).</div>
      )}
      {status === 'needs_reconnect' && (
        <div><Btn small kind="soft" onClick={() => scope?.go?.('xero')}>Open Xero settings to reconnect</Btn></div>
      )}
      {status === 'sent' && (
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>
          {(sent?.xero_journal_id || j.xero_journal_id) ? `Xero draft ${sent?.xero_journal_id || j.xero_journal_id}. ` : ''}
          {j.sent_at && !sent ? `Sent ${whenWords(j.sent_at)}${j.sent_by_name ? ` by ${j.sent_by_name}` : ''}. ` : ''}
          Post it in Xero when your accountant has checked it.
        </div>
      )}
      {status === 'ready' && canCall && (
        <>
          {!preview && <div><Btn small kind="soft" disabled={busy === 'preview'} onClick={look}>{busy === 'preview' ? 'Reading Xero…' : 'Preview the journal'}</Btn></div>}
          {preview && preview.status === 'ready' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>{preview.narration || ''}{preview.amount != null ? `: ${money(preview.amount, cur)}` : ''}</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {select('stockAccount', 'Stock account (balance sheet)')}
                {select('movementAccount', 'Stock movement account (cost of sales)')}
              </div>
              <div><Btn small disabled={busy === 'send'} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send to Xero as a draft'}</Btn></div>
            </div>
          )}
        </>
      )}
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--red)' }}>{error.message || String(error)}</div>}
      {dialog}
    </div>
  );
}

export default function StockMonthEnd({ orgId, sites, siteById, range, compare, layout, initialOpts, onExport, onShare, api }) {
  const months = recentMonths(range.toDay, 13);
  const thisMonth = monthOf(range.toDay);
  const [monthPick, setMonthPick] = useState(() => {
    const m = initialPick(initialOpts, 'month', null, null);
    return isMonthStart(m) ? m : null;
  });
  const [tab, setTab] = useState(() => initialPick(initialOpts, 'level', TABS.map((tb) => tb.id), 'site'));
  const [sort, setSort] = useState(null);
  const [tick, setTick] = useState(0);

  const month = monthOf(monthPick || (months[0] && months[0].from) || range.toDay) || { from: range.fromDay, to: range.toDay };
  const opts = { level: tab, month: month.from, reload: tick || undefined };
  // The month is the report's own period: the shell's period does not apply here, and there is no
  // compare (a month end is read as it was locked; then stays null).
  const args = { orgId, sites, from: month.from, to: month.to, opts, compare: null };
  const rep = useStockReport(api, 'month_end', args) || {};
  const { meta, totals, rows, next, loading, error, then, thenLoaded, capped, more, moreBusy } = rep;
  const ex = useExportFlow({ api, report: 'month_end', label: TITLE, args, meta, totals, rows, next, onExport });
  const share = () => onShare?.({ level: tab, month: month.from });

  const nameOf = (id) => siteNameOf(meta, siteById, id);
  const shownTotals = (totals || []).map((t) => ({ ...t, _locked: t.location_id == null ? '' : t.locked === true ? 'Locked' : 'Not locked (live)' }));
  const shownRows = withSites(rows, meta, siteById).map((r) => ({
    ...r,
    _sites: Array.isArray(r.sites) ? r.sites.map((s) => s.site || nameOf(s.location_id)).join(', ') : '',
    _locked: r.locked_all === true ? 'Every site' : 'Not every site',
    _journal: r.journal ? (r.journal.words || JOURNAL_WORDS[r.journal.status] || '') : '',
  }));
  const notes = notesOf(meta, [DRAFT_LINE]);
  const options = [...(thisMonth ? [{ ...thisMonth, label: `${monthWords(thisMonth.from)} (not over yet)` }] : []), ...months];
  // By legal company: the journal's own answer (every site of each legal company, whatever sites are
  // picked above), so the header, the confirm and the send count the same sites and the same amount.
  const [legal, setLegal] = useState({ key: null, rows: null, error: null });
  const legalKey = tab === 'legal' && orgId ? `${orgId}|${month.from}|${month.to}|${tick}` : null;
  useEffect(() => {
    if (!legalKey || typeof api?.monthEndLegal !== 'function') return undefined;
    let live = true;
    api.monthEndLegal(orgId, month.from, month.to).then((res) => {
      if (!live) return;
      setLegal({ key: legalKey, rows: res.error ? null : (Array.isArray(res.data?.legal) ? res.data.legal : []), error: res.error || null });
    });
    return () => { live = false; };
  }, [legalKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const serverLegal = legal.key === legalKey ? legal : { rows: null, error: null };
  const legalRows = tab === 'legal'
    ? (serverLegal.rows ? withSites(serverLegal.rows, meta, siteById).map((r) => ({
        ...r,
        _sites: Array.isArray(r.sites) ? r.sites.map((s) => s.site || nameOf(s.location_id)).join(', ') : '',
        _locked: r.locked_all === true ? 'Every site' : 'Not every site',
        _journal: r.journal ? (r.journal.words || JOURNAL_WORDS[r.journal.status] || '') : (r.words || ''),
      })) : [])
    : [];

  return (
    <StockReportFrame title={TITLE} sub={SUB} meta={meta} extraLines={notes} onExport={ex.run} exportLabel={ex.atOnce ? 'Export CSV' : 'Export all rows as a file'} onShare={onShare ? share : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t3)' }}>
          Month
          <select value={month.from} onChange={(e) => { setMonthPick(e.target.value || null); setSort(null); }} aria-label="Month"
            style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }}>
            {options.map((m) => <option key={m.from} value={m.from}>{m.label}</option>)}
          </select>
        </label>
        <TabBar tabs={TABS} value={tab} onChange={(t) => { setTab(t); setSort(null); }} />
      </div>
      <Notice>{DRAFT_LINE}</Notice>

      {error && <StockError error={error} />}
      {loading && !totals && !error && <StockLoading words={`Reading ${monthWords(month.from)} from the locked snapshot`} />}

      {totals && (
        <>
          <div style={{ marginTop: 12 }}>
            <SiteTotalsTable meta={meta} totals={shownTotals} columns={TOTALS} layout={layout} onSite={() => { setTab('category'); setSort(null); }}
              then={then?.totals || null} thenLoaded={thenLoaded} compare={compare} />
          </div>
          {tab === 'legal' && (
            <div style={{ display: 'grid', gap: 12, margin: '14px 0' }}>
              {serverLegal.error && <EmptyLine>{serverLegal.error.message || String(serverLegal.error)}</EmptyLine>}
              {!serverLegal.error && serverLegal.rows && legalRows.length === 0 && <EmptyLine>No legal company in this company.</EmptyLine>}
              {!serverLegal.error && serverLegal.rows && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Each legal company counts every one of its sites, whatever sites are picked above.</div>}
              {legalRows.map((r) => (
                <JournalBox key={r.tenant_id || 'none'} row={r} orgId={orgId} from={month.from} to={month.to} api={api} onSent={() => setTick((n) => n + 1)} />
              ))}
            </div>
          )}
          {tab !== 'site' && (
            <DrillTable columns={tab === 'legal' ? LEGAL_COLS : CATEGORY_COLS} rows={sortLoaded(tab === 'legal' ? legalRows : shownRows, sort, SORT_KEYS)} next={tab === 'legal' ? null : next} onMore={more} busy={moreBusy} capped={capped}
              sort={sort} onSort={(k) => setSort((s) => toggleSort(s, k))} empty="Nothing to show for this month." />
          )}
          {tab === 'site' && <EmptyLine>Pick By legal company for the closing stock journals, or By category for closing stock by category.</EmptyLine>}
        </>
      )}
      {ex.panel}
    </StockReportFrame>
  );
}
