/**
 * Import (multi site stock Drop 1): Import CSV, or Import from Nory or MarketMan.
 *
 *  1. Choose the file. It is read here (importMappers.js): a Nory or MarketMan export is told apart
 *     by its headings, and every kind the file holds is found (stock items, suppliers, supplier
 *     items and prices, pars and, from Drop 2, recipes: one ingredient a line, grouped into one
 *     row per recipe).
 *  2. The rows go up in chunks of 2,000 (stock_import_stage) and the database checks each one.
 *  3. The check screen: '<n> new items, <n> price changes, <n> problems' (plus '<n> new recipes,
 *     <n> changed recipes' when the file has recipes), the columns that were not used, every row
 *     with what will happen to it, and the sites new items start at. A recipe is never linked to a
 *     till product on import: Recipe missing offers that with one click.
 *  4. Import: the save queue does it (stock_import_commit); '<done> of <total> rows done'.
 * Nothing is written to a site until Import, and nothing writes an on hand, a cost or the ledger
 * except through the normal cost step.
 *
 * Used by Stock items (Import) and a supplier's Items tab ('Import price list': kind
 * 'supplier_item', and that supplier for every row that names none).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pollJobs } from '../../../../lib/stock/companyData';
import { parseCsv, detectSource, mapFile, stageFile, chunk, missingWords, unusedWords, fileRowOf } from '../../../../lib/stock/importMappers';
import {
  importCountWords, importKey, importKindsWords, importProblems, importProgressWords, stageWithSupplier,
} from '../../../../lib/stock/itemListRules';
import { useStockScope } from '../../../StockScope';
import { Btn, Modal, Segmented, SiteChecklist, Field, Notice, Pill, WindowedList, ErrorLine, ui } from '../stockUi';

const STAGE_ROWS = 2000;
const ACTION = {
  new: ['New', 'good'], change: ['Change', 'blue'], same: ['Same', 'neutral'], skip: ['Skip', 'neutral'], problem: ['Problem', 'bad'],
};
const SOURCES = [{ value: 'csv', label: 'Import CSV' }, { value: 'nory_marketman', label: 'Import from Nory or MarketMan' }];
const rowName = (d) => d?.name || d?.item || d?.supplier_product_name || d?.supplier || '';

export default function ImportModal({ orgId, sites, kind = null, source = null, supplier = null, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [from, setFrom] = useState(source === 'csv' || source === 'nory_marketman' ? source : (source ? 'nory_marketman' : 'csv'));
  const [file, setFile] = useState(null);
  const [step, setStep] = useState('pick');
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [found, setFound] = useState('');
  const [unknown, setUnknown] = useState([]);
  const [readProblems, setReadProblems] = useState([]);
  const [fileCounts, setFileCounts] = useState({});
  const [staged, setStaged] = useState({ done: 0, total: 0 });
  const [jobId, setJobId] = useState(null);
  const [check, setCheck] = useState(null);
  const [checkRows, setCheckRows] = useState([]);
  const [checkNext, setCheckNext] = useState(null);
  const [chosen, setChosen] = useState(() => (sites || []).map((s) => s.id));
  const [queueId, setQueueId] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const committed = useRef(false);
  const jobRef = useRef(null);
  const closed = useRef(false);
  const groups = useMemo(() => (sc.groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] })), [sc.groups]);

  // Closing before Import throws the staged rows away (stock_import_cancel); after Import they run.
  // Closed while the rows are still going up: the next chunk is never sent (start() cancels then).
  // (StrictMode runs this cleanup once on mount in development, so the flag is set back here.)
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (jobRef.current && !committed.current) stockApi.importCancel(jobRef.current);
    };
  }, []);

  useEffect(() => {
    if (queueId == null) return undefined;
    const stop = pollJobs(stockApi, [queueId], (rows) => setJob((rows || [])[0] || null));
    return () => { if (typeof stop === 'function') stop(); };
  }, [queueId]);

  const readCheck = async (id, after = null) => {
    const r = await stockApi.importCheck(id, after);
    if (r.error) { setError(r.error); return false; }
    if (!after) setCheck(r.data?.job || null);
    setCheckRows((rows) => (after ? [...rows, ...(r.data?.rows || [])] : (r.data?.rows || [])));
    setCheckNext(r.data?.next || null);
    return true;
  };

  const fail = (words) => { setBusy(false); setStep('pick'); setError(words instanceof Error ? words : new Error(words)); };

  const start = async () => {
    if (!file) { setError(new Error('Choose the file first.')); return; }
    setBusy(true); setError(null); setNote(''); setFound('');
    let text = '';
    try { text = await file.text(); } catch { fail('That file could not be read. Save it as CSV and try again.'); return; }
    const table = parseCsv(text);
    if (table.length < 2) { fail('That file has no rows under its headings.'); return; }
    let src = 'csv';
    if (from === 'nory_marketman') {
      src = detectSource(table[0]);
      if (src === 'csv') setNote('This file does not look like a Nory or MarketMan export, so it is read as a plain CSV.');
    }
    const wanted = kind ? [importKey(kind)].filter(Boolean) : null;
    const mapped = mapFile(table, { source: src, kinds: wanted });
    const order = (mapped.order || []).filter((k) => mapped.kinds?.[k]);
    const missing = order.flatMap((k) => mapped.kinds[k].missing || []);
    if (!order.length) { fail('Nothing in this file can be imported. It needs at least a Name column.'); return; }
    if (wanted && missing.length) { fail(missingWords(missing)); return; }
    setFound(importKindsWords(order));
    setUnknown(mapped.unknown || []);
    const read = stageFile(mapped, { siteIdByName: sc.sites });
    setReadProblems(read.problems || []);
    setFileCounts(read.counts || {});
    const rows = stageWithSupplier(read.rows, supplier);
    if (!rows.length) { fail('No rows to import were found in that file.'); return; }
    setStep('staging');
    setStaged({ done: 0, total: rows.length });
    let id = null;
    const meta = { org_id: orgId, source: src, file_name: file.name || null, sites: chosen };
    for (const part of chunk(rows, STAGE_ROWS)) {
      const r = await stockApi.importStage(id, part, id ? null : meta);
      const made = r.data?.job_id || id;
      if (closed.current) { if (made) stockApi.importCancel(made); return; }
      if (r.error) { fail(r.error); return; }
      id = made;
      jobRef.current = id;
      setJobId(id);
      setStaged((s) => ({ ...s, done: s.done + part.length }));
    }
    if (closed.current) return;
    const ok = await readCheck(id);
    setBusy(false);
    setStep(ok ? 'check' : 'pick');
  };

  const commit = async () => {
    if (!jobId) return;
    setBusy(true); setError(null);
    const r = await stockApi.importCommit(jobId, chosen);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    committed.current = true;
    setQueueId(r.data?.queue_id ?? null);
    setStep('running');
    try { showToast?.('Import started. It runs in the background.', 'info'); } catch { /* no toast, no harm */ }
  };

  const counts = check?.counts || {};
  const problems = importProblems(counts) || checkRows.filter((r) => r.action === 'problem').length;
  // The file's own count of recipes, for the line under the headline while the database counts actions.
  const recipesInFile = Number(fileCounts?.recipe) || 0;
  const title = supplier ? `Import price list for ${supplier.name}` : 'Import';
  const done = job?.status === 'done';
  const failed = job?.status === 'failed';

  let footer;
  if (step === 'pick') footer = <><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || !file} onClick={start}>{busy ? 'Reading…' : 'Check the file'}</Btn></>;
  else if (step === 'staging') footer = <><span style={ui.sub}>Checking: {staged.done.toLocaleString('en-GB')} of {staged.total.toLocaleString('en-GB')} rows</span><span style={{ flex: 1 }} /></>;
  else if (step === 'check') footer = <><span style={{ flex: 1 }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy || problems > 0 || !chosen.length} onClick={commit}>{busy ? 'Starting…' : 'Import'}</Btn></>;
  else footer = <><span style={{ flex: 1 }} /><Btn kind={done ? 'primary' : 'ghost'} onClick={onClose}>Close</Btn></>;

  return (
    <Modal title={title} onClose={onClose} width={820} dirty={step === 'check' && !busy} dirtyWords="The checked rows are thrown away. Nothing was imported." footer={footer}>
      {error && <div style={{ marginBottom: 10 }}><ErrorLine error={error} /></div>}
      {note && <div style={{ marginBottom: 10 }}><Notice tone="info">{note}</Notice></div>}

      {step === 'pick' && (
        <>
          {!source && <div style={{ marginBottom: 12 }}><Segmented value={from} onChange={setFrom} options={SOURCES} /></div>}
          <Field label="File" hint={from === 'csv'
            ? 'A CSV file with headings in the first row: stock items, suppliers, supplier items and prices, pars, or recipes (one ingredient a line).'
            : 'The export file from Nory or MarketMan, saved as CSV.'}>
            <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(null); }} aria-label="File" />
          </Field>
          <div style={ui.sub}>Nothing changes until you press Import on the next screen. Imported recipes are not linked to a till product: Recipe missing offers that.</div>
        </>
      )}

      {step === 'staging' && <Notice tone="info">Checking every row of {file?.name || 'the file'}. Nothing has been imported.</Notice>}

      {(step === 'check' || step === 'running') && (
        <>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>{importCountWords(counts)}</div>
          {found && <div style={{ ...ui.sub, marginBottom: 4 }}>This file has: {found}.</div>}
          {recipesInFile > 0 && <div style={{ ...ui.sub, marginBottom: 4 }}>{recipesInFile === 1 ? '1 recipe' : `${recipesInFile} recipes`} in the file. Each recipe's lines are checked against your stock items by name or SKU. No till product is linked on import.</div>}
          {unknown.length > 0 && <div style={{ ...ui.sub, marginBottom: 4 }}>{unusedWords(unknown)}</div>}
          {readProblems.length > 0 && (
            <div style={{ ...ui.sub, marginBottom: 4 }}>
              {readProblems.slice(0, 5).map((p, i) => <div key={i}>{p.words}</div>)}
              {readProblems.length > 5 && <div>And {readProblems.length - 5} more values that could not be read (left empty).</div>}
            </div>
          )}
          {problems > 0 && step === 'check' && <div style={{ ...ui.err, marginBottom: 6 }}>Put the problems right in the file, then choose it again.</div>}
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden', margin: '8px 0 10px' }}>
            <WindowedList items={checkRows} rowHeight={34} height={300}
              empty={<div style={{ padding: 12, ...ui.sub }}>No rows.</div>}
              renderRow={(r) => {
                const [label, tone] = ACTION[r.action] || ['', 'neutral'];
                return (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '0 12px', height: 34, borderBottom: '1px solid var(--bdr)', fontSize: 12.5 }}>
                    <span style={{ width: 64, color: 'var(--t4)', fontVariantNumeric: 'tabular-nums' }}>Row {fileRowOf(r.row_no) ?? r.row_no}</span>
                    {label && <Pill tone={tone}>{label}</Pill>}
                    <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{rowName(r.data)}</span>
                    {r.problem && <span style={{ color: r.action === 'problem' ? 'var(--red)' : 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.problem}</span>}
                  </div>
                );
              }} />
          </div>
          {checkNext && step === 'check' && <Btn small onClick={() => readCheck(jobId, checkNext)}>Show more</Btn>}
          {step === 'check' && (
            <Field label="Sites" hint="New items start at the ticked sites, on hand 0. A row that names its own sites keeps them.">
              <SiteChecklist sites={sites || []} value={chosen} onChange={setChosen} groups={groups} />
            </Field>
          )}
          {step === 'running' && (
            failed
              ? <Notice tone="bad">The import did not finish: {String(job.last_error || 'it stopped').replace(/\.\s*$/, '')}.</Notice>
              : <Notice tone={done ? 'good' : 'info'}>{done ? 'Done.' : (importProgressWords(job) || 'Waiting to start')}</Notice>
          )}
          {step === 'running' && !done && !failed && <div style={{ ...ui.sub, marginTop: 6 }}>You can close this. The import keeps going.</div>}
        </>
      )}
    </Modal>
  );
}
