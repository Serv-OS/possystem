// src/backoffice/sections/CustomerImport.jsx
//
// Back Office, Customers group: "Import customers".
//
// Bring a customer list out of another system, with their stamps, and make
// every one of them a member at every site this company runs. Coffee Boy is
// the first one: three shops, one company, so a person imported once is a
// member at all three with nothing per shop to do.
//
// WHAT THIS FILE IS AND IS NOT
//   * It reads the file and shows what is in it. Nothing is written until the
//     operator presses Import and answers the confirm.
//   * It decides nothing about the file itself. Every rule about what a phone
//     is, what a date means and which rows we can use lives in
//     src/lib/customerImport.js, and the edge function that writes the rows
//     runs the same rules from supabase/functions/_shared/customerImport.ts.
//     That is the whole point: the preview and the write can never disagree.
//   * The rows we post are the RAW cells from the file, not our reading of
//     them. The server reads them again with the same rules and is the one
//     that decides. A screen must never be the authority on what gets written.
//
// IT MUST NOT CRASH WHEN THE BACK END IS NOT THERE YET
// The writer (`customers-import`) and its batch table land separately. Until
// they do, this screen still opens, still hands out the template, still reads
// a file and still shows the preview, and an Import press comes back with one
// plain line saying it is not live yet and nothing has changed. Every load is
// wrapped, so a missing table or a refused read leaves a line on the screen
// and the rest of Back Office working.
//
// Peter is dyslexic and not technical. Short words, one idea a line, and never
// a bare number without saying what it counts.

import { useEffect, useMemo, useState } from 'react';
import { supabase, platformSupabase, isMock, getLocationId, getActiveLocationSync } from '../../lib/supabase';
import { ymdInTz } from '../../lib/locationTime';
import {
  readCsv,
  validateRows,
  summarise,
  templateCsv,
  buildExistingKeys,
} from '../../lib/customerImport';
import {
  CHUNK_SIZE,
  PREVIEW_ROWS,
  MAX_ROWS,
  MAX_FILE_BYTES,
  TEMPLATE_FILE_NAME,
  count,
  importBlockReason,
  noProgrammeLine,
  confirmMessage,
  previewRows,
  problemsByRow,
  failedCsv,
  failedFileName,
  chunkRows,
  mergeResult,
  progressText,
  progressPercent,
  importErrorMessage,
  resultLine,
  importRequestBody,
  IMPORT_FUNCTION,
} from '../../lib/customerImportScreen';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  page:    { padding: '32px 40px', maxWidth: 1080 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 28, maxWidth: 720, lineHeight: 1.5 },
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
    new:     { text: 'New',        bg: 'var(--grn-d)', color: 'var(--grn)' },
    known:   { text: 'Already in', bg: 'var(--bg3)',   color: 'var(--t2)' },
    problem: { text: 'Problem',    bg: 'var(--red-d)', color: 'var(--red)' },
  };
  const c = map[status] || map.known;
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

function newBatchKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* older browser, fall through */ }
  return 'imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ── the screen ──────────────────────────────────────────────────────────────

export default function CustomerImport({ setSection }) {
  // where we are
  const [loading, setLoading] = useState(true);
  const [loadNote, setLoadNote] = useState('');       // one plain line when a load did not work
  const [orgId, setOrgId] = useState(null);
  // A date in the file is read against the VENUE clock, not the laptop's, so an
  // opt in date typed today does not come back "in the future" for an operator
  // sitting in another timezone.
  const [timezone, setTimezone] = useState('');
  const [siteCount, setSiteCount] = useState(0);
  const [programmes, setProgrammes] = useState([]);
  const [programId, setProgramId] = useState('');

  // the file
  const [fileName, setFileName] = useState('');
  const [head, setHead] = useState(null);             // what readCsv said about the columns
  const [raw, setRaw] = useState([]);                 // raw rows, as they came out of the file
  const [checked, setChecked] = useState(null);       // validateRows result
  const [existingKeys, setExistingKeys] = useState(null);
  const [matchNote, setMatchNote] = useState('');
  const [fileNote, setFileNote] = useState('');       // one plain line when the file itself is wrong

  // the consent the operator gives once, for the whole file
  const [optInSource, setOptInSource] = useState('');
  const [consentGiven, setConsentGiven] = useState(false);

  // the run
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);
  const [result, setResult] = useState(null);
  const [runNote, setRunNote] = useState('');
  // A run that stops half way must be able to carry on, not start again. The
  // batch key is minted ONCE per file and kept, so the writer can recognise a
  // row it has already done and a second attempt cannot double anybody's
  // stamps. doneBatches is how far we got, so we pick up from there.
  const [batchKey, setBatchKey] = useState(null);
  const [doneBatches, setDoneBatches] = useState(0);
  const [finished, setFinished] = useState(false);

  // ── load what the company already has ─────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      if (isMock || !supabase) { if (alive) setLoading(false); return; }
      try {
        const locId = getActiveLocationSync() || await getLocationId();
        if (!locId || locId === 'loc-demo') { if (alive) setLoading(false); return; }

        const { data: thisLoc } = await supabase.from('locations').select('org_id, timezone').eq('id', locId).maybeSingle();
        if (alive && thisLoc?.timezone) setTimezone(String(thisLoc.timezone));
        if (alive && thisLoc?.org_id) {
          setOrgId(thisLoc.org_id);
          const { count: n } = await supabase
            .from('locations')
            .select('id', { count: 'exact', head: true })
            .eq('org_id', thisLoc.org_id).eq('status', 'active');
          if (alive) setSiteCount(n || 0);
        }

        if (platformSupabase) {
          const { data: platLoc } = await platformSupabase
            .from('locations').select('company_id')
            .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
            .limit(1).maybeSingle();
          if (alive && platLoc?.company_id) {
            const { data: progs } = await platformSupabase
              .from('stamp_card_programs')
              .select('id, name, stamps_required, reward_description, active')
              .eq('company_id', platLoc.company_id)
              .eq('active', true)
              .order('created_at', { ascending: true });
            if (alive) {
              const list = progs || [];
              setProgrammes(list);
              if (list.length === 1) setProgramId(list[0].id);
            }
          }
        }
      } catch (e) {
        console.warn('[CustomerImport] load:', e);
        if (alive) setLoadNote('We could not load your stamp cards. You can still get the template. Try again in a minute.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /** The venue's own day, which is what every date in the file is read against. */
  const venueToday = () => ymdInTz(new Date(), timezone) || '';

  // ── the template ──────────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const ok = saveFile(templateCsv({ bom: true }), TEMPLATE_FILE_NAME);
    if (!ok) setFileNote('We could not save the template. Check your downloads are allowed.');
  };

  // ── read a file ───────────────────────────────────────────────────────────
  const pickFile = async (ev) => {
    const file = ev?.target?.files?.[0];
    if (ev?.target) ev.target.value = '';   // so picking the same file twice still fires
    if (!file) return;

    setFileNote(''); setMatchNote(''); setRunNote('');
    setResult(null); setSent(0);
    setBatchKey(null); setDoneBatches(0); setFinished(false);
    setHead(null); setRaw([]); setChecked(null); setExistingKeys(null);
    setFileName(file.name || 'the file');

    if (file.size > MAX_FILE_BYTES) {
      setFileNote('That file is very big. Split it into smaller files and do them one at a time.');
      return;
    }

    let text = '';
    try {
      text = await file.text();
    } catch {
      setFileNote('We could not read that file. Save it again as CSV and try once more.');
      return;
    }

    const parsed = readCsv(text);
    if (!parsed.found) {
      setFileNote('We could not find the column names in that file. Use the template and keep the top row.');
      return;
    }
    if (!parsed.hasPhone && !parsed.hasEmail) {
      setFileNote('That file has no phone column and no email column. We need at least one of them.');
      setHead(parsed);
      return;
    }
    if (parsed.rows.length > MAX_ROWS) {
      setFileNote('That file has more than ' + MAX_ROWS + ' rows. Split it and do it in parts.');
      return;
    }
    if (!parsed.rows.length) {
      setFileNote('That file has column names but nobody in it.');
      setHead(parsed);
      return;
    }

    // The venue's own day, the same one the writer is given, so the preview and
    // the write can never disagree about what "in the future" means.
    const checkedNow = validateRows(parsed.rows, { today: venueToday() });
    setHead(parsed);
    setRaw(parsed.rows);
    setChecked(checkedNow);

    // Who do we already have? The server decides for real, this is only so the
    // preview can say "already in" instead of promising a new customer.
    if (!orgId && !isMock) {
      setMatchNote('We do not know which venue you are on yet, so everybody shows as new. Give it a moment and pick the file again.');
      setExistingKeys(new Set());
      return;
    }
    try {
      const keys = await lookupExisting(orgId, checkedNow.ready);
      setExistingKeys(keys);
    } catch (e) {
      console.warn('[CustomerImport] match:', e);
      setMatchNote('We could not check who you already have, so everybody shows as new. The import still only adds a person once.');
      setExistingKeys(new Set());
    }
  };

  // ── numbers for the preview ───────────────────────────────────────────────
  const summary = useMemo(
    () => (checked ? summarise(checked, existingKeys) : null),
    [checked, existingKeys],
  );
  const rowsShown = useMemo(
    () => (checked ? previewRows(checked, { raw, existingKeys, limit: PREVIEW_ROWS }) : []),
    [checked, raw, existingKeys],
  );
  const skippedCount = useMemo(
    () => (checked ? problemsByRow(checked).size : 0),
    [checked],
  );

  const blockReason = importBlockReason({
    fileRead: !!checked,
    ready: summary ? summary.ready : 0,
    withStamps: summary ? summary.withStamps : 0,
    programmes,
    programId,
    consentGiven,
    busy,
    alreadyRan: finished,
    demo: isMock || !supabase,
  });

  // ── the rows that did not go in, as a file to fix ─────────────────────────
  const downloadProblems = () => {
    const byRow = problemsByRow(checked);
    const serverFailed = Array.isArray(result?.failed) ? result.failed : [];
    for (let i = 0; i < serverFailed.length; i++) {
      const f = serverFailed[i] || {};
      const n = f.rowNumber || f.row_number;
      if (n) byRow.set(n, String(f.reason || f.message || 'The server could not write this one.'));
    }
    const byNumber = new Map();
    for (let i = 0; i < raw.length; i++) if (raw[i]?.rowNumber) byNumber.set(raw[i].rowNumber, raw[i]);
    const entries = [];
    Array.from(byRow.keys()).sort((a, b) => a - b).forEach((n) => {
      entries.push({ row: byNumber.get(n) || {}, problem: byRow.get(n) });
    });
    if (!entries.length) return;
    saveFile(failedCsv(entries), failedFileName(new Date().toISOString()));
  };

  // ── run it ────────────────────────────────────────────────────────────────
  const runImport = async () => {
    if (blockReason || !checked || !summary) return;
    if (!window.confirm(confirmMessage(summary))) return;

    const byNumber = new Map();
    for (let i = 0; i < raw.length; i++) if (raw[i]?.rowNumber) byNumber.set(raw[i].rowNumber, raw[i]);
    const toSend = [];
    for (let i = 0; i < checked.ready.length; i++) {
      const r = byNumber.get(checked.ready[i].rowNumber);
      if (r) toSend.push(r);
    }
    if (!toSend.length) return;

    const key = batchKey || newBatchKey();
    if (!batchKey) setBatchKey(key);
    const chunks = chunkRows(toSend, CHUNK_SIZE);
    const startAt = Math.min(doneBatches, chunks.length);
    let acc = result || { created: 0, updated: 0, skipped: 0, stamped: 0, alreadyStamped: 0, failed: [], notes: [], batchId: null };

    setBusy(true); setRunNote('');
    try {
      for (let i = startAt; i < chunks.length; i++) {
        const answer = await callImport({
          batchId: key,
          filename: fileName || 'Customer import',
          today: venueToday(),
          chunkIndex: i,
          programId: programId || null,
          consentText: consentLine(optInSource),
          rows: chunks[i],
        });
        acc = mergeResult(acc, answer);
        setResult(acc);
        setDoneBatches(i + 1);
        setSent(Math.min(toSend.length, (i + 1) * CHUNK_SIZE));
      }
      setFinished(true);
    } catch (e) {
      // Whatever went in stays on screen, and the button comes back as Carry on
      // so the rest can go without sending the first part twice.
      setRunNote(e?.plain || importErrorMessage(e?.status, e?.body));
    } finally {
      setBusy(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  const sites = siteCount > 1 ? count(siteCount, 'site') : 'every site';
  const done = !!result && !busy;
  const partial = !!result && !busy && !finished;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Import customers</h1>
      <div style={S.sub}>
        Bring customers over from another system, with the stamps they have already collected.
        They join once and are members at {sites} you run. They sign in with their phone and a code, so nobody needs a password.
      </div>

      {loadNote ? <div style={S.warnBox}>{loadNote}</div> : null}
      {isMock ? <div style={S.warnBox}>This is a demo screen. Nothing here can be imported.</div> : null}

      {/* 1. the file */}
      <div style={S.card}>
        <div style={S.step}>1. Get the file ready</div>
        <div style={S.body}>
          Download the template and put your people in it. One person a row.
          <br />Phone is the important one. It is how they sign in and how the till finds them.
          <br /><strong>stamps</strong> is how far along their card is. <strong>rewards_unused</strong> is free items they have earned and not had yet.
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={downloadTemplate} style={{ ...S.btn, ...S.btnGhost }}>Download template</button>
        </div>
      </div>

      {/* 2. pick it */}
      <div style={S.card}>
        <div style={S.step}>2. Pick your file</div>
        <div style={S.body}>Nothing is saved yet. We show you what is in it first.</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".csv,text/csv" onChange={pickFile} disabled={busy}
            style={{ fontSize: 13, color: 'var(--t2)', fontFamily: 'inherit' }} />
          {fileName ? <span style={{ fontSize: 12, color: 'var(--t3)' }}>{fileName}</span> : null}
        </div>

        {fileNote ? <div style={{ ...S.errorBox, marginTop: 14, marginBottom: 0 }}>{fileNote}</div> : null}

        {summary ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Tile n={summary.newCustomers} label="New customers" tone="good" />
              <Tile n={summary.alreadyKnown} label="You already have" />
              <Tile n={skippedCount} label="Rows with a problem" tone={skippedCount ? 'bad' : undefined} />
              <Tile n={summary.canEmail} label="We can email" />
              <Tile n={summary.withStamps} label="Have stamps" />
            </div>

            <div style={{ ...S.body, marginTop: 12 }}>
              {summary.stampsTotal > 0 || summary.rewardsTotal > 0
                ? <div>Stamps in this file: {count(summary.stampsTotal, 'stamp')} and {count(summary.rewardsTotal, 'free item')} already earned.</div>
                : <div>No stamps in this file.</div>}
              {summary.notSaid > 0
                ? <div>Marketing not answered for {count(summary.notSaid, 'person', 'people')}. They go in, and we never email them.</div>
                : null}
              {summary.optedOut > 0
                ? <div>Said no to marketing: {count(summary.optedOut, 'person', 'people')}. They still go in, and we never email them.</div>
                : null}
              {summary.phoneFixed > 0
                ? <div>We put the 0 back on the front of {count(summary.phoneFixed, 'phone')}. That is what a spreadsheet does to a phone column. We never add a country code: a number from another country has to carry its own + and code.</div>
                : null}
              {summary.duplicates > 0
                ? <div>The same person twice in the file: {count(summary.duplicates, 'row')} left out. We keep the first one.</div>
                : null}
              {head?.ignored?.length
                ? <div>Columns we did not use on purpose: {head.ignored.join(', ')}. Points are not stamps.</div>
                : null}
              {head?.unknown?.length
                ? <div>Columns we do not know, so we left them out: {head.unknown.join(', ')}.</div>
                : null}
              {head?.duplicates?.length
                ? <div>The same column twice: {head.duplicates.join(', ')}. We used the first one.</div>
                : null}
            </div>

            {matchNote ? <div style={{ ...S.warnBox, marginTop: 12, marginBottom: 0 }}>{matchNote}</div> : null}

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
                            {r.note ? <span style={{ marginLeft: 8, color: r.status === 'problem' ? 'var(--red)' : 'var(--t3)' }}>{r.note}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {skippedCount > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <button onClick={downloadProblems} style={{ ...S.btn, ...S.btnGhost }}>
                      Download the rows to fix
                    </button>
                    <span style={{ fontSize: 12, color: 'var(--t3)', marginLeft: 10 }}>
                      {count(skippedCount, 'row')} will be left out. Fix them and load that file after.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 3. stamps */}
      <div style={S.card}>
        <div style={S.step}>3. Where the stamps go</div>
        {loading ? (
          <div style={S.body}>Loading your stamp cards.</div>
        ) : programmes.length === 0 ? (
          <div>
            <div style={{ ...S.body, color: 'var(--acc)' }}>{noProgrammeLine(summary ? summary.withStamps : 0)}</div>
            <div style={{ marginTop: 12 }}>
              <button onClick={() => setSection && setSection('loyalty')} style={{ ...S.btn, ...S.btnGhost }}>
                Open Loyalty
              </button>
            </div>
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

      {/* 4. consent */}
      <div style={S.card}>
        <div style={S.step}>4. Say they opted in</div>
        <div style={{ maxWidth: 520 }}>
          <label style={S.label} htmlFor="ci-src">Where they opted in</label>
          <input id="ci-src" type="text" value={optInSource} disabled={busy}
            onChange={(e) => setOptInSource(e.target.value)}
            placeholder="Name the old system, for example Old loyalty app"
            style={S.input} />
        </div>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, cursor: busy ? 'default' : 'pointer', maxWidth: 640 }}>
          <input type="checkbox" checked={consentGiven} disabled={busy}
            onChange={(e) => setConsentGiven(e.target.checked)}
            style={{ marginTop: 2, width: 16, height: 16 }} />
          <span style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
            These people opted in on the other system and I can show the record.
          </span>
        </label>
        <div style={{ ...S.body, marginTop: 10 }}>
          We keep this on every person we bring in. Anyone whose row says no is still imported, and never emailed.
        </div>
      </div>

      {/* 5. go */}
      <div style={S.card}>
        <div style={S.step}>5. Import</div>
        {blockReason ? <div style={{ ...S.body, color: 'var(--t3)' }}>{blockReason}</div> : null}
        <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={runImport} disabled={!!blockReason}
            style={{ ...S.btn, ...(blockReason ? S.btnOff : S.btnPrim) }}>
            {busy ? 'Importing' : (doneBatches > 0 && !finished ? 'Carry on importing' : 'Import customers')}
          </button>
          {summary && !blockReason ? (
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>
              {count(summary.newCustomers, 'customer')} will be added. It cannot be undone from this screen.
            </span>
          ) : null}
        </div>

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
              <Tile n={result.skipped} label="Skipped" />
              <Tile n={result.stamped || 0} label="Cards stamped" />
              {result.alreadyStamped > 0
                ? <Tile n={result.alreadyStamped} label="Cards left alone" />
                : null}
              <Tile n={(result.failed || []).length} label="Did not go in" tone={(result.failed || []).length ? 'bad' : undefined} />
            </div>
            {/* Things we did NOT do, and why. A run that quietly drops stamps
                for everybody already imported and still says success is how a
                corrected second export gets thrown away without a word. */}
            {(result.notes || []).length ? (
              <div style={{ ...S.warnBox, marginTop: 14, marginBottom: 0 }}>
                {(result.notes || []).map((n, i) => <div key={i}>{n}</div>)}
              </div>
            ) : null}
            <div style={{ ...S.body, marginTop: 14 }}>
              {partial
                ? 'That part is in and safe. Press Carry on importing to send the rest. It picks up where it stopped, so nobody goes in twice.'
                : <>They are members at {sites} you run. They sign in with their phone and a code, so there is nothing to send them and no password to set.</>}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setSection && setSection('customers')} style={{ ...S.btn, ...S.btnGhost }}>
                Open the customer list
              </button>
              {(result.failed || []).length || skippedCount ? (
                <button onClick={downloadProblems} style={{ ...S.btn, ...S.btnGhost }}>
                  Download the rows to fix
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── talking to the server ───────────────────────────────────────────────────

// The line we store against every person, so a year from now the record says
// where their consent came from in words a person can read.
function consentLine(source) {
  const where = String(source || '').trim();
  return where
    ? 'Imported from ' + where + '. The operator confirmed these people opted in there and the record can be shown.'
    : 'Imported from another system. The operator confirmed these people opted in there and the record can be shown.';
}

/**
 * Post one chunk to the writer. Throws an error carrying { status, body, plain }
 * so the screen can say one plain line instead of a stack trace. The function
 * may not be deployed yet: that comes back 404 and reads as "nothing happened".
 */
async function callImport(body) {
  if (isMock || !supabase) {
    const err = new Error('demo');
    err.plain = 'This is a demo screen. Nothing can be imported here.';
    throw err;
  }
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) {
    const err = new Error('signed out');
    err.plain = 'You are signed out. Sign in again and start the import over.';
    throw err;
  }
  const locationId = getActiveLocationSync();
  let res;
  try {
    // IMPORT_FUNCTION is the DIRECTORY under supabase/functions. It used to say
    // customers-import, which is not a function that exists, so every import
    // 404ed and the screen read that back to the operator as "not live on this
    // site yet". customerImportWiring.test.js now holds the name against the
    // real directory.
    res = await fetch(`${FUNCTIONS_URL}/${IMPORT_FUNCTION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(importRequestBody({ ...body, opsLocationId: body?.opsLocationId || locationId })),
    });
  } catch {
    const err = new Error('network');
    err.plain = 'We could not reach the server. Check the internet and try again.';
    throw err;
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  if (!res.ok || parsed?.error) {
    const err = new Error('import failed');
    err.status = res.status;
    err.body = parsed;
    err.plain = importErrorMessage(res.status, parsed);
    throw err;
  }
  return parsed || {};
}

/**
 * Which of these people are already in the database. Only so the preview can
 * say "already in": the import itself matches again on the server, which is
 * the one that decides.
 */
async function lookupExisting(orgId, readyRows) {
  if (!orgId || !supabase || isMock) return new Set();
  const phones = [];
  const emails = [];
  const rows = Array.isArray(readyRows) ? readyRows : [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].phone) phones.push(rows[i].phone);
    if (rows[i].email) emails.push(rows[i].email);
  }
  const found = [];
  const ask = async (column, values) => {
    const parts = chunkRows(values, 100);
    for (let i = 0; i < parts.length; i++) {
      const { data, error } = await supabase
        .from('customers')
        .select('phone, email')
        .eq('org_id', orgId)
        .is('deleted_at', null)
        .in(column, parts[i]);
      if (error) throw error;
      if (data) for (let j = 0; j < data.length; j++) found.push(data[j]);
    }
  };
  if (phones.length) await ask('phone', phones);
  if (emails.length) await ask('email', emails);
  return buildExistingKeys(found);
}
