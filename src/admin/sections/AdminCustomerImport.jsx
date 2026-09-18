// src/admin/sections/AdminCustomerImport.jsx
//
// Admin portal (?mode=admin), ServOS staff only: "Import customers".
//
// Peter, 18 Sep 2026: "I dont want customer able to mess something up so can
// we hide it or make it so only internal to servos can access it? We will then
// edit the sheet so its accurate then upload" and "we could have it on the
// admin portal". So this screen lives HERE and nowhere in Back Office. The
// admin portal only opens for super_admin, and the edge function it calls
// (customer-import) refuses anybody who is not ServOS staff as well, because
// hiding a screen is not security.
//
// Bring a customer list out of another system, with their stamps, and make
// every one of them a member at every site the company runs. Coffee Boy is the
// first one: about 8,000 members off 5Loyalty.
//
// THE ORDER ON SCREEN IS THE SAFETY:
//   1. Pick the COMPANY, and a venue of it. The venue says which org, platform
//      company and country the file belongs to. Nothing else works until the
//      server has said, in words, who that company is.
//   2. Get the template.
//   3. Pick the file. It is read with the SAME rules the server uses, for that
//      company's country, and then the server itself says who is new, who is
//      already there and who it will not touch. The tiles and the table read
//      that one answer. Nothing is written.
//   4. The stamp card, 5. the consent tick,
//   6. a confirm step with the COMPANY NAME LARGE, so nobody imports Coffee
//      Boy into the wrong brand, and only then the import.
//
// The rows we post are the RAW cells from the file (see rowsToSend), not our
// reading of them. The server reads them again and is the one that decides.
//
// Peter is dyslexic and not technical. Short words, one idea a line, and never
// a bare number without saying what it counts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { isMock } from '../../lib/supabase';
import { ymdInTz } from '../../lib/locationTime';
import {
  readCsv,
  validateRows,
  summarise,
  templateCsv,
  rowsToSend,
  verdictsByRow,
} from '../../lib/customerImport';
import {
  CHUNK_SIZE,
  PREVIEW_CHUNK_SIZE,
  PREVIEW_ROWS,
  MAX_ROWS,
  MAX_FILE_BYTES,
  TEMPLATE_FILE_NAME,
  count,
  importBlockReason,
  noProgrammeLine,
  countryLine,
  confirmLines,
  previewRows,
  problemsByRow,
  blockedByRow,
  sameCustomerAcrossFile,
  failedCsv,
  failedFileName,
  chunkRows,
  mergeResult,
  progressText,
  progressPercent,
  importErrorMessage,
  resultLine,
  newBatchId,
  contextRequestBody,
  previewRequestBody,
  importRequestBody,
  IMPORT_FUNCTION,
  BATCH_TABLE_MISSING,
  deletedCount,
  deletedBeforeImport,
} from '../../lib/customerImportScreen';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 24, maxWidth: 720, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  step:    { fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 6 },
  body:    { fontSize: 13, color: 'var(--t3)', lineHeight: 1.6, maxWidth: 720 },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn:     { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnOff:  { background: 'var(--bg2)', color: 'var(--t4)', border: '1px solid var(--bdr2)', cursor: 'not-allowed' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  warnBox: { padding: 12, background: 'var(--acc-d)', color: 'var(--acc)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--acc-b)' },
  okBox:   { padding: 12, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--grn-b, var(--grn))' },
  th:      { textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.05em' },
  td:      { padding: '7px 8px', fontSize: 12, color: 'var(--t2)', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 },
};

// ── little bits of screen ───────────────────────────────────────────────────

function Tile({ n, label, tone }) {
  const color = tone === 'bad' ? 'var(--red)' : tone === 'good' ? 'var(--grn)' : 'var(--t1)';
  return (
    <div style={{ flex: '1 1 130px', minWidth: 130, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1.1 }}>{n}</div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 4, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    new:       { text: 'New',         bg: 'var(--grn-d)', color: 'var(--grn)' },
    known:     { text: 'Already in',  bg: 'var(--bg3)',   color: 'var(--t2)' },
    blocked:   { text: 'Left out',    bg: 'var(--red-d)', color: 'var(--red)' },
    unchecked: { text: 'Not checked', bg: 'var(--bg3)',   color: 'var(--t3)' },
    problem:   { text: 'Problem',     bg: 'var(--red-d)', color: 'var(--red)' },
  };
  const c = map[status] || map.unchecked;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: c.bg, color: c.color, textTransform: 'uppercase', letterSpacing: '.05em' }}>
      {c.text}
    </span>
  );
}

function saveFile(text, fileName) {
  try {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

// The line we store against every person, so a year from now the record says
// where their consent came from in words a person can read.
function consentLine(source) {
  const where = String(source || '').trim();
  return where
    ? 'Imported from ' + where + '. ServOS staff confirmed these people opted in there and the record can be shown.'
    : 'Imported from another system. ServOS staff confirmed these people opted in there and the record can be shown.';
}

/**
 * Post one body to the edge function with the admin's own session. Throws an
 * error carrying { status, body, plain } so the screen can say one plain line.
 */
async function callImportFunction(body) {
  if (isMock) {
    const err = new Error('demo');
    err.plain = 'This is a demo screen. Nothing can be imported here.';
    throw err;
  }
  let token = '';
  try { token = JSON.parse(localStorage.getItem('rpos-auth') || 'null')?.access_token || ''; } catch { token = ''; }
  if (!token) {
    const err = new Error('signed out');
    err.plain = 'You are signed out. Sign in again and start over.';
    throw err;
  }
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${IMPORT_FUNCTION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    const err = new Error('network');
    err.plain = 'We could not reach the server. Check the internet and try again.';
    throw err;
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok || parsed?.error) {
    const err = new Error('import call failed');
    err.status = res.status;
    err.body = parsed;
    err.plain = importErrorMessage(res.status, parsed);
    throw err;
  }
  return parsed || {};
}

// ── the screen ──────────────────────────────────────────────────────────────

export default function AdminCustomerImport({ orgs, sbFetch }) {
  // 1. which company
  const [orgId, setOrgId] = useState('');
  const [venues, setVenues] = useState([]);
  const [venueId, setVenueId] = useState('');
  const [ctx, setCtx] = useState(null);                // what the server says this company is
  const [ctxNote, setCtxNote] = useState('');
  const [ctxLoading, setCtxLoading] = useState(false);
  const [programId, setProgramId] = useState('');

  // 3. the file
  const [fileName, setFileName] = useState('');
  const [head, setHead] = useState(null);
  const [raw, setRaw] = useState([]);
  const [checked, setChecked] = useState(null);
  const [fileNote, setFileNote] = useState('');
  const [verdicts, setVerdicts] = useState(null);      // the server's word on every row
  const [previewing, setPreviewing] = useState(false);
  const [previewNote, setPreviewNote] = useState('');
  // Which preview is the current one. A preview still running for company A
  // must never paint its answer over company B's file: every preview takes a
  // number, anything that resets the file takes a new one, and an answer whose
  // number is no longer current is thrown away.
  const previewSeq = useRef(0);

  // 5. consent
  const [optInSource, setOptInSource] = useState('');
  const [consentGiven, setConsentGiven] = useState(false);

  // 6. the run
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState(null);
  const [runNote, setRunNote] = useState('');
  // One batch id per file, kept across a stop and a Carry on, so the stamps
  // guard recognises the rows already done.
  const [batchId, setBatchId] = useState(null);
  const [doneBatches, setDoneBatches] = useState(0);
  const [finished, setFinished] = useState(false);

  const org = (Array.isArray(orgs) ? orgs : []).find((o) => o.id === orgId) || null;
  const companyName = ctx?.org_name || org?.name || '';

  const resetFile = () => {
    previewSeq.current += 1;
    setFileName(''); setHead(null); setRaw([]); setChecked(null); setFileNote('');
    setVerdicts(null); setPreviewNote(''); setPreviewing(false);
    setConfirming(false); setResult(null); setSent(0); setRunNote('');
    setBatchId(null); setDoneBatches(0); setFinished(false);
  };

  // ── 1. company, then venue, then what the server says about them ─────────
  const pickCompany = async (id) => {
    setOrgId(id); setVenues([]); setVenueId(''); setCtx(null); setCtxNote(''); setProgramId('');
    resetFile();
    if (!id || typeof sbFetch !== 'function') return;
    try {
      const { data } = await sbFetch(`locations?select=id,name,status&org_id=eq.${id}&order=created_at.asc`);
      const list = Array.isArray(data) ? data : [];
      setVenues(list);
      const live = list.filter((l) => l.status !== 'inactive' && l.status !== 'archived');
      if (live.length === 1) setVenueId(live[0].id);
    } catch {
      setCtxNote('We could not load that company\'s venues. Try again in a minute.');
    }
  };

  useEffect(() => {
    let alive = true;
    if (!orgId || !venueId) return () => { alive = false; };
    (async () => {
      setCtxLoading(true); setCtx(null); setCtxNote('');
      try {
        const answer = await callImportFunction(contextRequestBody({ opsLocationId: venueId, orgId }));
        if (!alive) return;
        setCtx(answer);
        const progs = Array.isArray(answer.programmes) ? answer.programmes : [];
        setProgramId(progs.length === 1 ? progs[0].id : '');
      } catch (e) {
        if (alive) setCtxNote(e?.plain || 'We could not check that company. Try again in a minute.');
      } finally {
        if (alive) setCtxLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [orgId, venueId]);

  /** The venue's own day, which is what every date in the file is read against. */
  const venueToday = () => ymdInTz(new Date(), ctx?.timezone || '') || '';
  const readOpts = () => ({ today: venueToday(), country: ctx?.country || '' });

  // ── 2. the template ───────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const ok = saveFile(templateCsv({ bom: true }), TEMPLATE_FILE_NAME);
    if (!ok) setFileNote('We could not save the template. Check your downloads are allowed.');
  };

  // ── 3. read a file, then ask the server about every row ───────────────────
  const pickFile = async (ev) => {
    const file = ev?.target?.files?.[0];
    if (ev?.target) ev.target.value = '';   // so picking the same file twice still fires
    if (!file || !ctx) return;
    resetFile();
    setFileName(file.name || 'the file');

    if (file.size > MAX_FILE_BYTES) { setFileNote('That file is very big. Split it into smaller files and do them one at a time.'); return; }

    let text = '';
    try { text = await file.text(); } catch { setFileNote('We could not read that file. Save it again as CSV and try once more.'); return; }

    const parsed = readCsv(text);
    if (!parsed.found) { setFileNote('We could not find the column names in that file. Use the template and keep the top row.'); return; }
    if (!parsed.hasPhone && !parsed.hasEmail) { setFileNote('That file has no phone column and no email column. We need at least one of them.'); setHead(parsed); return; }
    if (parsed.rows.length > MAX_ROWS) { setFileNote('That file has more than ' + MAX_ROWS + ' rows. Split it and do it in parts.'); return; }
    if (!parsed.rows.length) { setFileNote('That file has column names but nobody in it.'); setHead(parsed); return; }

    // The same rules, the same day and the same country the server uses.
    const checkedNow = validateRows(parsed.rows, readOpts());
    setHead(parsed);
    setRaw(parsed.rows);
    setChecked(checkedNow);

    // The server's word on who is new. It writes nothing. The company and the
    // venue pickers are locked while it runs, and the answer is only used if
    // this is still the current preview (see previewSeq).
    const mine = previewSeq.current + 1;
    previewSeq.current = mine;
    const current = () => previewSeq.current === mine;
    const askVenue = venueId;
    const askOrg = orgId;
    const toAsk = rowsToSend(parsed.rows, checkedNow);
    const parts = chunkRows(toAsk, PREVIEW_CHUNK_SIZE);
    const all = [];
    setPreviewing(true);
    try {
      for (let i = 0; i < parts.length; i++) {
        const answer = await callImportFunction(previewRequestBody({
          opsLocationId: askVenue, orgId: askOrg, rows: parts[i], today: venueToday(), programId: programId || null,
        }));
        if (!current()) return;
        for (const v of (Array.isArray(answer.verdicts) ? answer.verdicts : [])) all.push(v);
      }
      if (current()) setVerdicts(sameCustomerAcrossFile(all));
    } catch (e) {
      if (current()) setPreviewNote(e?.plain || 'We could not check who they already have. Nothing was sent. Pick the file again.');
    } finally {
      if (current()) setPreviewing(false);
    }
  };

  // ── numbers for the preview: tiles AND table read the same verdicts ───────
  const summary = useMemo(() => (checked ? summarise(checked, verdicts) : null), [checked, verdicts]);
  const rowsShown = useMemo(
    () => (checked ? previewRows(checked, { raw, verdicts, limit: PREVIEW_ROWS }) : []),
    [checked, raw, verdicts],
  );
  const leftOut = useMemo(() => {
    const byRow = problemsByRow(checked);
    blockedByRow(verdicts).forEach((why, n) => byRow.set(n, why));
    return byRow;
  }, [checked, verdicts]);

  const programmes = Array.isArray(ctx?.programmes) ? ctx.programmes : [];
  const blockReason = importBlockReason({
    company: !!ctx,
    fileRead: !!checked,
    previewed: !!verdicts && !previewing,
    ready: summary ? summary.ready : 0,
    withStamps: summary ? summary.withStamps : 0,
    programmes,
    programId,
    consentGiven,
    busy,
    alreadyRan: finished,
    demo: isMock,
    batchTable: ctx ? ctx.batch_table : undefined,
  });
  const goneHere = deletedCount(verdicts);

  // ── the rows that did not go in, as a file to fix ─────────────────────────
  const downloadProblems = () => {
    const byRow = new Map(leftOut);
    const lists = [result?.failed, result?.skippedRows];
    for (const list of lists) {
      for (const f of (Array.isArray(list) ? list : [])) if (f?.rowNumber) byRow.set(f.rowNumber, String(f.reason || 'This one did not go in.'));
    }
    const byNumber = new Map();
    for (let i = 0; i < raw.length; i++) if (raw[i]?.rowNumber) byNumber.set(raw[i].rowNumber, raw[i]);
    const entries = [];
    Array.from(byRow.keys()).sort((a, b) => a - b).forEach((n) => entries.push({ row: byNumber.get(n) || {}, problem: byRow.get(n) }));
    if (!entries.length) return;
    saveFile(failedCsv(entries), failedFileName(new Date().toISOString()));
  };

  // ── 6. run it, after the confirm step ─────────────────────────────────────
  const runImport = async () => {
    if (blockReason || !checked || !summary || !verdicts) return;
    setConfirming(false);
    const byRow = verdictsByRow(verdicts);
    const toSend = rowsToSend(raw, checked).filter((r) => (byRow.get(r.rowNumber)?.verdict || '') !== 'blocked');
    if (!toSend.length) return;

    const key = batchId || newBatchId();
    if (!batchId) setBatchId(key);
    const chunks = chunkRows(toSend, CHUNK_SIZE);
    const startAt = Math.min(doneBatches, chunks.length);
    let acc = result || { created: 0, updated: 0, skipped: 0, stamped: 0, alreadyStamped: 0, failed: [], skippedRows: [], notes: [], batchId: null };
    // People deleted here were left out at the preview and are never sent, so
    // the run names them itself, once, at the start.
    if (!result) {
      const gone = deletedBeforeImport(verdicts, checked);
      if (gone) acc = mergeResult(acc, gone);
    }

    setBusy(true); setRunNote('');
    try {
      for (let i = startAt; i < chunks.length; i++) {
        const answer = await callImportFunction(importRequestBody({
          opsLocationId: venueId,
          orgId,
          batchId: key,
          filename: fileName || 'Customer import',
          today: venueToday(),
          chunkIndex: i,
          programId: programId || null,
          consentText: consentLine(optInSource),
          rows: chunks[i],
        }));
        acc = mergeResult(acc, answer);
        setResult(acc);
        setDoneBatches(i + 1);
        setSent(Math.min(toSend.length, (i + 1) * CHUNK_SIZE));
      }
      setFinished(true);
    } catch (e) {
      // Whatever went in stays on screen, and the button comes back as Carry on.
      setRunNote(e?.plain || importErrorMessage(e?.status, e?.body));
    } finally {
      setBusy(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  const done = !!result && !busy;
  const partial = !!result && !busy && !finished;
  const orgList = Array.isArray(orgs) ? orgs : [];

  return (
    <div style={{ maxWidth: 1080 }}>
      <h1 style={S.h1}>Import customers</h1>
      <div style={S.sub}>
        ServOS staff only. Bring a company&apos;s loyalty customers over from another system, with the stamps they have already collected.
        They join once and are members at every site the company runs. They sign in with their phone and a code, so nobody needs a password.
      </div>

      {isMock ? <div style={S.warnBox}>This is a demo screen. Nothing here can be imported.</div> : null}

      {/* 1. the company */}
      <div style={S.card}>
        <div style={S.step}>1. Pick the company</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', maxWidth: 720 }}>
          <div style={{ flex: '1 1 260px' }}>
            <label style={S.label} htmlFor="ci-org">Company</label>
            <select id="ci-org" value={orgId} onChange={(e) => pickCompany(e.target.value)} disabled={busy || previewing} style={S.input}>
              <option value="">Pick one</option>
              {orgList.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <label style={S.label} htmlFor="ci-venue">Venue</label>
            <select id="ci-venue" value={venueId} onChange={(e) => { setVenueId(e.target.value); resetFile(); }} disabled={busy || previewing || !orgId} style={S.input}>
              <option value="">{orgId ? 'Pick one' : 'Pick the company first'}</option>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.status && v.status !== 'active' ? ' (' + v.status + ')' : ''}</option>)}
            </select>
          </div>
        </div>
        <div style={{ ...S.body, marginTop: 8 }}>
          Any venue of the company will do. It tells us the company, and the country its phones and dates are read as.
        </div>
        {ctxLoading ? <div style={{ ...S.body, marginTop: 10 }}>Checking that company.</div> : null}
        {ctxNote ? <div style={{ ...S.errorBox, marginTop: 12, marginBottom: 0 }}>{ctxNote}</div> : null}
        {ctx ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--t1)', lineHeight: 1.2 }}>{companyName || 'This company'}</div>
            <div style={{ ...S.body, marginTop: 4 }}>
              {ctx.company_name && ctx.company_name !== companyName ? <>Loyalty company: {ctx.company_name}. </> : null}
              {ctx.sites > 1 ? count(ctx.sites, 'site') : 'One site'}. Venue picked: {ctx.venue_name || 'this venue'}.
            </div>
            <div style={{ ...S.body, marginTop: 4 }}>{countryLine(ctx.country, ctx.country_source)}</div>
            {ctx.batch_table === false ? (
              <div style={{ ...S.errorBox, marginTop: 12, marginBottom: 0 }}>
                <strong>{BATCH_TABLE_MISSING}</strong> Every import keeps a record of who ran it and what it did, and that record has nowhere to go yet.
                You can still check a file. Nothing can be imported until the migration has been run.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 2. the template */}
      <div style={S.card}>
        <div style={S.step}>2. Get the file ready</div>
        <div style={S.body}>
          Download the template, or use the export, and correct it in a spreadsheet. One person a row.
          <br />Phone is the important one. It is how they sign in and how the till finds them.
          <br /><strong>stamps</strong> is how far along their card is. <strong>rewards_unused</strong> is free items they have earned and not had yet.
          <br />Save it as CSV. If the spreadsheet asks, pick CSV UTF-8.
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={downloadTemplate} style={{ ...S.btn, ...S.btnGhost }}>Download template</button>
        </div>
      </div>

      {/* 3. the file */}
      <div style={S.card}>
        <div style={S.step}>3. Pick the file</div>
        <div style={S.body}>Nothing is saved yet. We show you what is in it first.</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".csv,text/csv" onChange={pickFile} disabled={busy || !ctx}
            style={{ fontSize: 13, color: 'var(--t2)', fontFamily: 'inherit' }} />
          {!ctx ? <span style={{ fontSize: 12, color: 'var(--t3)' }}>Pick the company first.</span> : null}
          {fileName ? <span style={{ fontSize: 12, color: 'var(--t3)' }}>{fileName}</span> : null}
        </div>

        {fileNote ? <div style={{ ...S.errorBox, marginTop: 14, marginBottom: 0 }}>{fileNote}</div> : null}
        {previewing ? <div style={{ ...S.body, marginTop: 12 }}>Checking every row against who {companyName || 'they'} already have. Nothing is written.</div> : null}
        {previewNote ? <div style={{ ...S.errorBox, marginTop: 14, marginBottom: 0 }}>{previewNote}</div> : null}

        {summary ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Tile n={verdicts ? summary.newCustomers : '...'} label="New customers" tone="good" />
              <Tile n={verdicts ? summary.alreadyKnown : '...'} label="Already in" />
              <Tile n={leftOut.size} label="Rows left out" tone={leftOut.size ? 'bad' : undefined} />
              <Tile n={summary.canEmail} label="We can email" />
              <Tile n={summary.withStamps} label="Have stamps" />
            </div>

            <div style={{ ...S.body, marginTop: 12 }}>
              <div>{countryLine(ctx?.country, ctx?.country_source)}</div>
              {head?.delimiter && head.delimiter !== ',' ? <div>This file uses {head.delimiter === ';' ? 'semicolons' : 'tabs'} between columns. That is fine.</div> : null}
              {summary.stampsTotal > 0 || summary.rewardsTotal > 0
                ? <div>Stamps in this file: {count(summary.stampsTotal, 'stamp')} and {count(summary.rewardsTotal, 'free item')} already earned.</div>
                : <div>No stamps in this file.</div>}
              {summary.notSaid > 0 ? <div>Marketing not answered for {count(summary.notSaid, 'person', 'people')}. They go in, and we never email them.</div> : null}
              {summary.optedOut > 0 ? <div>Said no in the old system: {count(summary.optedOut, 'person', 'people')}. They still go in. A no in the file changes nothing here: anybody who already said yes here stays yes.</div> : null}
              {summary.phoneFixed > 0 ? <div>We put the 0 back on the front of {count(summary.phoneFixed, 'phone')}. That is what a spreadsheet does to a phone column.</div> : null}
              {summary.sharedPhone > 0 ? <div>{count(summary.sharedPhone, 'person', 'people')} share a phone with an earlier row. They go in by email only, and the phone stays with the first row. The rows say which. Fix the sheet if the phone belongs to the other one.</div> : null}
              {summary.sharedEmail > 0 ? <div>{count(summary.sharedEmail, 'person', 'people')} share an email with an earlier row. They go in by phone only, and the email stays with the first row.</div> : null}
              {summary.blocked - goneHere > 0 ? <div>{count(summary.blocked - goneHere, 'row')} left out because they are somebody already here (the rows say who).</div> : null}
              {goneHere > 0 ? <div>{count(goneHere, 'row')} left out because they were deleted here. We never bring back somebody who was deleted.</div> : null}
              {summary.duplicates > 0 ? <div>The same person twice in the file: {count(summary.duplicates, 'row')} left out. We keep the first one.</div> : null}
              {head?.ignored?.length ? <div>Columns we did not use on purpose: {head.ignored.join(', ')}. Points are not stamps.</div> : null}
              {head?.unknown?.length ? <div>Columns we do not know, so we left them out: {head.unknown.join(', ')}.</div> : null}
              {head?.duplicates?.length ? <div>The same column twice: {head.duplicates.join(', ')}. We used the first one.</div> : null}
            </div>

            {rowsShown.length ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 8 }}>
                  First {rowsShown.length} of {count(summary.total, 'row')}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                        <th style={S.th}>Row</th>
                        <th style={S.th}>Name</th>
                        <th style={S.th}>Phone</th>
                        <th style={S.th}>Email</th>
                        <th style={S.th}>Stamps</th>
                        <th style={S.th}>Free</th>
                        <th style={S.th}>What happens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rowsShown.map((r) => (
                        <tr key={r.rowNumber}>
                          <td style={{ ...S.td, color: 'var(--t4)' }}>{r.rowNumber}</td>
                          <td style={S.td}>{r.name || '-'}</td>
                          <td style={S.td}>{r.phone || '-'}</td>
                          <td style={S.td}>{r.email || '-'}</td>
                          <td style={S.td}>{r.status === 'problem' ? '' : r.stamps}</td>
                          <td style={S.td}>{r.status === 'problem' ? '' : r.rewards}</td>
                          <td style={{ ...S.td, whiteSpace: 'normal', maxWidth: 320 }}>
                            <StatusPill status={r.status} />
                            {r.note ? <span style={{ marginLeft: 8, color: r.status === 'problem' || r.status === 'blocked' ? 'var(--red)' : 'var(--t3)' }}>{r.note}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {leftOut.size > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <button onClick={downloadProblems} style={{ ...S.btn, ...S.btnGhost }}>Download the rows to fix</button>
                    <span style={{ fontSize: 12, color: 'var(--t3)', marginLeft: 10 }}>
                      {count(leftOut.size, 'row')} will be left out. Fix them and load that file after.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 4. stamps */}
      <div style={S.card}>
        <div style={S.step}>4. Where the stamps go</div>
        {!ctx ? (
          <div style={S.body}>Pick the company first.</div>
        ) : programmes.length === 0 ? (
          <div style={{ ...S.body, color: 'var(--acc)' }}>
            {noProgrammeLine(summary ? summary.withStamps : 0)} Make it in that company&apos;s Back Office, under Loyalty.
          </div>
        ) : (
          <div style={{ maxWidth: 420 }}>
            <label style={S.label} htmlFor="ci-prog">Stamp card</label>
            <select id="ci-prog" value={programId} onChange={(e) => setProgramId(e.target.value)} disabled={busy} style={S.input}>
              <option value="">Pick one</option>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.stamps_required ? ' (' + p.stamps_required + ' stamps)' : ''}
                </option>
              ))}
            </select>
            <div style={{ ...S.body, marginTop: 8 }}>
              Stamps from the file go on this card. Free items they already earned stay theirs to use.
            </div>
          </div>
        )}
      </div>

      {/* 5. consent */}
      <div style={S.card}>
        <div style={S.step}>5. Say they opted in</div>
        <div style={{ maxWidth: 520 }}>
          <label style={S.label} htmlFor="ci-src">Where they opted in</label>
          <input id="ci-src" type="text" value={optInSource} disabled={busy}
            onChange={(e) => setOptInSource(e.target.value)}
            placeholder="Name the old system, for example 5Loyalty"
            style={S.input} />
        </div>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, cursor: busy ? 'default' : 'pointer', maxWidth: 640 }}>
          <input type="checkbox" checked={consentGiven} disabled={busy}
            onChange={(e) => setConsentGiven(e.target.checked)}
            style={{ marginTop: 2, width: 16, height: 16 }} />
          <span style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
            These people opted in on the other system and the venue can show the record.
          </span>
        </label>
        <div style={{ ...S.body, marginTop: 10 }}>
          We keep this on every person the file says yes for. A no in the file writes nothing, so it never switches off anybody who said yes here.
          Anyone who is not opted in here, or has switched marketing off here, stays that way, whatever the file says.
        </div>
      </div>

      {/* 6. confirm and go */}
      <div style={S.card}>
        <div style={S.step}>6. Import</div>
        {blockReason ? <div style={{ ...S.body, color: 'var(--t3)' }}>{blockReason}</div> : null}

        {!confirming ? (
          <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setConfirming(true)} disabled={!!blockReason}
              style={{ ...S.btn, ...(blockReason ? S.btnOff : S.btnPrim) }}>
              {busy ? 'Importing' : (doneBatches > 0 && !finished ? 'Carry on importing' : 'Import customers')}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 14, padding: 18, borderRadius: 12, border: '2px solid var(--acc)', background: 'var(--bg2)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Importing into</div>
            <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--t1)', lineHeight: 1.15, marginTop: 4 }}>{companyName || 'This company'}</div>
            <div style={{ ...S.body, marginTop: 4 }}>From the file {fileName}. {countryLine(ctx?.country, ctx?.country_source)}</div>
            <div style={{ ...S.body, marginTop: 10, color: 'var(--t2)' }}>
              {confirmLines(summary).map((l, i) => <div key={i}>{l}</div>)}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={runImport} disabled={!!blockReason} style={{ ...S.btn, ...(blockReason ? S.btnOff : S.btnPrim) }}>
                Yes, import into {companyName || 'this company'}
              </button>
              <button onClick={() => setConfirming(false)} style={{ ...S.btn, ...S.btnGhost }}>Go back</button>
            </div>
          </div>
        )}

        {busy && summary ? (
          <div style={{ marginTop: 16, maxWidth: 420 }}>
            <div style={{ height: 8, borderRadius: 99, background: 'var(--bg3)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: progressPercent(sent, summary.ready) + '%', background: 'var(--acc)', transition: 'width .2s' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 8 }}>{progressText(sent, summary.ready)}</div>
          </div>
        ) : null}

        {runNote ? <div style={{ ...S.errorBox, marginTop: 14, marginBottom: 0 }}>{runNote}</div> : null}

        {done ? (
          <div style={{ marginTop: 16 }}>
            <div style={S.okBox}>{resultLine(result)}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Tile n={result.created} label="Added" tone="good" />
              <Tile n={result.updated} label="Filled in" />
              {result.upToDate > 0 ? <Tile n={result.upToDate} label="Already up to date" /> : null}
              <Tile n={result.skipped} label="Left out" />
              <Tile n={result.stamped || 0} label="Cards stamped" />
              {result.alreadyStamped > 0 ? <Tile n={result.alreadyStamped} label="Cards left alone" /> : null}
              <Tile n={(result.failed || []).length} label="Did not go in" tone={(result.failed || []).length ? 'bad' : undefined} />
            </div>
            {/* Lines about the whole run. Never counted as rows, always shown. */}
            {(result.notes || []).length ? (
              <div style={{ ...S.warnBox, marginTop: 14, marginBottom: 0 }}>
                {(result.notes || []).map((n, i) => <div key={i}>{n}</div>)}
              </div>
            ) : null}
            {(result.failed || []).length ? (
              <div style={{ ...S.errorBox, marginTop: 14, marginBottom: 0 }}>
                {(result.failed || []).slice(0, 20).map((f, i) => <div key={i}>{f.text || ('Row ' + f.rowNumber + ': ' + f.reason)}</div>)}
                {(result.failed || []).length > 20 ? <div>And {count((result.failed || []).length - 20, 'more row')}. Download the rows to fix to see them all.</div> : null}
              </div>
            ) : null}
            <div style={{ ...S.body, marginTop: 14 }}>
              {partial
                ? 'That part is in and safe. Press Carry on importing to send the rest. It picks up where it stopped, so nobody goes in twice.'
                : <>They are members at every site {companyName || 'the company'} runs. They sign in with their phone and a code, so there is nothing to send them and no password to set.</>}
            </div>
            {(result.failed || []).length || leftOut.size || (result.skippedRows || []).length ? (
              <div style={{ marginTop: 14 }}>
                <button onClick={downloadProblems} style={{ ...S.btn, ...S.btnGhost }}>Download the rows to fix</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
