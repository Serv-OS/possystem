// src/lib/customerImportScreen.js
//
// The parts of the admin portal's Import customers screen that are just rules,
// pulled out of the JSX so node:test can run them. No React, no DOM, no fetch,
// no clock read the caller cannot override.
//
// The screen is SERVOS STAFF ONLY and lives in the admin portal (?mode=admin,
// src/admin/sections/AdminCustomerImport.jsx). Venue owners and managers never
// see it. The edge function refuses anybody else too, because hiding a screen
// is not security.
//
// The reading of the file itself is NOT here. That lives in
// src/lib/customerImport.js and is mirrored for the edge function in
// supabase/functions/_shared/customerImport.ts, so the screen and the thing
// that writes the rows always agree about what the file said.
//
// ============================================================================
//  WHAT THE IMPORT BUTTON IS GUARDING
// ============================================================================
//
//  * The COMPANY. The operator picks the company first and a venue of it, and
//    the confirm step shows the company's name large, so nobody imports Coffee
//    Boy into the wrong brand. The edge function checks the venue is in the
//    company that was picked.
//  * The server's word on who is new. The preview asks the edge function, which
//    runs the same matching the import will, and the tiles and the table both
//    read that one answer. Until it has answered, the button stays off.
//  * Stamps have to land on a stamp card programme. We never invent one.
//  * Consent is a tick the operator makes, once, before anything is written.
//
// Every message in here is read out loud by somebody who is not technical.
// Short words, no jargon, and never a number without saying what it counts.

import { TEMPLATE_COLUMNS, toCsv, verdictsByRow } from './customerImport.js';

/** How many rows go to the server in one import request. */
export const CHUNK_SIZE = 200;

/** How many rows go to the server in one preview request (it writes nothing). */
export const PREVIEW_CHUNK_SIZE = 500;

/** How many rows the preview table shows. */
export const PREVIEW_ROWS = 20;

/** More rows than this in one file and we ask them to split it. */
export const MAX_ROWS = 20000;

/** Bigger than this and we do not even read it. 5 MB is a very long list. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The name of the file behind the Download template button. */
export const TEMPLATE_FILE_NAME = 'customer-import-template.csv';

// ── plain counting ──────────────────────────────────────────────────────────

/** '1 customer' / '4 customers'. Never a bare number on the screen. */
export function count(n, one, many) {
  const v = Number.isFinite(n) ? n : 0;
  return v + ' ' + (v === 1 ? one : (many || one + 's'));
}

// ── when the Import button may be pressed ───────────────────────────────────

/**
 * Why the Import button is off, in plain words, or null when it may be pressed.
 *
 * state:
 *   company       the company picked, and its venue, and the server has said who they are
 *   fileRead      true once a file has been read
 *   previewed     true once the server has said who is new and who is known
 *   ready         how many rows we would write
 *   withStamps    how many of those rows carry stamps or unused rewards
 *   programmes    the stamp card programmes this company has
 *   programId     the one the operator picked
 *   consentGiven  the tick box
 *   busy          an import is already running
 *   alreadyRan    this file has been sent already
 *   demo          this browser has no database behind it (local dev)
 *   batchTable    what the server said about import_batches (false = missing)
 */
export function importBlockReason(state) {
  const s = state || {};
  if (s.busy) return 'Importing. Please wait.';
  if (s.demo) return 'This is a demo screen. Nothing can be imported here.';
  // No record, no import. The server refuses too; this says it before anybody
  // spends ten minutes checking a file.
  if (s.batchTable === false) return BATCH_TABLE_MISSING;
  // A second press on the same file would send it all over again. People are
  // safe from that, stamps are not, so the button goes off when a run finishes.
  if (s.alreadyRan) return 'This file has gone in. Pick another file to import more.';
  if (!s.company) return 'Pick the company first.';
  if (!s.fileRead) return 'Pick a file first.';
  if (!s.previewed) return 'Wait for the check to finish.';
  const ready = Number(s.ready) || 0;
  if (ready < 1) return 'Nothing in this file we can import. Fix the problems and pick it again.';

  const withStamps = Number(s.withStamps) || 0;
  const programmes = Array.isArray(s.programmes) ? s.programmes : [];
  if (withStamps > 0 && programmes.length === 0) {
    return 'Make a stamp card in Loyalty first, then come back. Stamps are waiting for ' + count(withStamps, 'person', 'people') + '.';
  }
  if (withStamps > 0 && !s.programId) return 'Pick which stamp card the stamps go on.';

  if (!s.consentGiven) return 'Tick the box to say these people opted in.';
  return null;
}

/** The blocking line while migration 20260918_OPS_customer_import_batches.sql has not been run. */
export const BATCH_TABLE_MISSING = 'Run the import_batches migration first.';

/** The line under the stamp card picker when the company has no programmes. */
export function noProgrammeLine(withStamps) {
  const n = Number(withStamps) || 0;
  if (n < 1) return 'No stamp cards here yet. This file has no stamps in it, so that is fine.';
  return 'Stamps are waiting for ' + count(n, 'person', 'people') + ' in this file. Make a stamp card in Loyalty first, then come back and import.';
}

/** Where the country came from, in words. The Ops currency is said to be a
 *  guess, because it defaults to GBP. */
export function countrySourceWords(source) {
  switch (String(source || '')) {
    case 'country': return 'the venue\'s country';
    case 'platform_country': return 'the company\'s country';
    case 'platform_currency': return 'the company\'s currency';
    case 'currency': return 'the venue\'s currency';
    case 'ops_currency': return 'the till\'s currency, which may only be the default. Check it';
    default: return '';
  }
}

/** The line that says how phones and dates in the file are being read. */
export function countryLine(country, source) {
  const c = String(country || '').toUpperCase();
  const from = countrySourceWords(source);
  if (c === 'GB') {
    return 'Phones and dates are read as United Kingdom (from ' + (from || 'the venue') + '). A phone that lost its 0 gets it back, and 05/09/1984 is 5 September.';
  }
  if (c) {
    return 'Phones and dates are read as ' + c + (from ? ' (from ' + from + ')' : '') + '. No 0 is put on any phone, and no country code is added.';
  }
  return 'We do not know this venue\'s country, so no 0 is put on any phone and a date like 05/09/1984 is refused. Set the venue\'s currency or country first.';
}

// ── the confirm ─────────────────────────────────────────────────────────────

/**
 * What the operator reads on the confirm step, one line each, under the
 * company name. It says the numbers and it says it cannot be undone.
 */
export function confirmLines(summary) {
  const s = summary || {};
  const made = Number(s.newCustomers) || 0;
  const known = Number(s.alreadyKnown) || 0;
  const lines = [];
  lines.push('This will add ' + count(made, 'new customer') + '.');
  if (known > 0) lines.push('It will also fill in blanks on ' + count(known, 'customer') + ' they already have. It never overwrites what is there.');
  const stamps = Number(s.stampsTotal) || 0;
  const rewards = Number(s.rewardsTotal) || 0;
  if (stamps > 0 || rewards > 0) lines.push('Stamps going on: ' + count(stamps, 'stamp') + ' and ' + count(rewards, 'free item') + '.');
  lines.push('It cannot be undone from this screen.');
  return lines;
}

/** The confirm as one block of text, with the company named first. */
export function confirmMessage(summary, companyName) {
  const name = String(companyName || '').trim();
  const lines = (name ? ['Import into ' + name + '.'] : []).concat(confirmLines(summary));
  lines.push('Import now?');
  return lines.join('\n\n');
}

// ── the preview ─────────────────────────────────────────────────────────────

/**
 * Every row number that has something wrong with it, and the plain words for
 * it. Errors and in file duplicates both land here. Several problems on one
 * row are joined into one line.
 */
export function problemsByRow(checked) {
  const out = new Map();
  const add = (rowNumber, message) => {
    if (!rowNumber || !message) return;
    const had = out.get(rowNumber);
    out.set(rowNumber, had ? had + ' ' + message : message);
  };
  const c = checked || {};
  const errors = Array.isArray(c.errors) ? c.errors : [];
  const dups = Array.isArray(c.duplicatesInFile) ? c.duplicatesInFile : [];
  for (let i = 0; i < errors.length; i++) add(errors[i].rowNumber, errors[i].message);
  for (let i = 0; i < dups.length; i++) add(dups[i].rowNumber, dups[i].message);
  return out;
}

/** Row numbers we would skip, whether that is a problem or a repeat. */
export function skippedRowNumbers(checked) {
  return Array.from(problemsByRow(checked).keys()).sort((a, b) => a - b);
}

/** The words for a row that is the same person as an earlier one. The edge
 *  function says exactly this (sameAsReason in customerImportPlan.ts), and
 *  customerImportScreen.test.js holds the two together. */
export function sameAsReason(firstRowNumber) {
  const n = Number(firstRowNumber) || 0;
  return 'Same person as row ' + n + '. We already have them, and row ' + n + ' fills them in, so we left this row out.';
}

/**
 * The server decides one slice at a time, so row 12 in the first slice and row
 * 4,012 in the twentieth can land on one customer without either slice seeing
 * the other. The screen has every verdict, so it runs this over the whole file
 * before it sends anything: the later row is left out with the same words the
 * server would use, and never sent.
 */
export function sameCustomerAcrossFile(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const first = new Map();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v || typeof v !== 'object') continue;
    const n = Number(v.row_number) || 0;
    const id = v.customer_id != null ? String(v.customer_id) : null;
    const item = { row_number: n, verdict: String(v.verdict || ''), reason: String(v.reason || ''), customer_id: id, deleted: v.deleted === true };
    if (id && item.verdict === 'update') {
      const had = first.get(id);
      if (had !== undefined && had !== n) {
        item.verdict = 'blocked';
        item.reason = sameAsReason(had);
        item.same_as = had;
      } else if (had === undefined) first.set(id, n);
    }
    out.push(item);
  }
  return out;
}

/**
 * The run's opening words about people deleted here. The preview already left
 * them out, so the screen never sends them and the server never sees them: the
 * screen has to say it, in the SAME words the server uses (deletedLine in
 * customerImportPlan.ts), by row and by name. Returned as a chunk shaped answer
 * for mergeResult, or null when there are none.
 */
export function deletedBeforeImport(verdicts, checked) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const names = new Map();
  const ready = checked && Array.isArray(checked.ready) ? checked.ready : [];
  for (let i = 0; i < ready.length; i++) if (ready[i] && ready[i].rowNumber) names.set(ready[i].rowNumber, ready[i].name);
  const named = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v || v.deleted !== true) continue;
    const n = Number(v.row_number) || 0;
    named.push('row ' + n + ' (' + (String(names.get(n) || '').trim() || 'no name') + ')');
  }
  if (!named.length) return null;
  return { chunk: { deleted: named.length, notes: ['Left out because they were deleted here: ' + named.join(', ') + '.'] } };
}

/** How many rows the server left out because the person was deleted here. */
export function deletedCount(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  let n = 0;
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].deleted === true) n++;
  return n;
}

/**
 * The first rows of the file, in file order, ready to put in a table.
 *
 * Each one is { rowNumber, name, phone, email, stamps, rewards, status, note }.
 * status is 'new', 'known', 'blocked', 'unchecked' or 'problem', and it comes
 * from the SAME verdicts the tiles count (see summarise), so the table and the
 * tiles can never disagree about who is already in.
 */
export function previewRows(checked, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : PREVIEW_ROWS;
  const byRow = verdictsByRow(o.verdicts);
  const raw = Array.isArray(o.raw) ? o.raw : [];
  const rawByRow = new Map();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r && r.rowNumber) rawByRow.set(r.rowNumber, r);
  }
  const problems = problemsByRow(checked);
  const list = [];

  const ready = checked && Array.isArray(checked.ready) ? checked.ready : [];
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i];
    const v = byRow ? byRow.get(r.rowNumber) : null;
    const verdict = v ? v.verdict : '';
    const status = verdict === 'update' ? 'known' : verdict === 'new' ? 'new' : verdict === 'blocked' ? 'blocked' : 'unchecked';
    const notes = [];
    if (verdict === 'blocked' && v.reason) notes.push(v.reason);
    for (let j = 0; j < (r.warnings || []).length; j++) notes.push(r.warnings[j].message);
    list.push({
      rowNumber: r.rowNumber,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || '',
      stamps: r.stamps || 0,
      rewards: r.rewardsUnused || 0,
      status,
      note: notes.join(' '),
    });
  }

  problems.forEach((message, rowNumber) => {
    const src = rawByRow.get(rowNumber) || {};
    const first = String(src.first_name || '').trim();
    const last = String(src.last_name || '').trim();
    list.push({
      rowNumber,
      name: String(src.name || '').trim() || (first + ' ' + last).trim(),
      phone: String(src.phone || '').trim(),
      email: String(src.email || '').trim(),
      stamps: 0,
      rewards: 0,
      status: 'problem',
      note: message,
    });
  });

  list.sort((a, b) => a.rowNumber - b.rowNumber);
  return limit > 0 ? list.slice(0, limit) : list;
}

/** Row numbers the server refused in the preview, with its words. */
export function blockedByRow(verdicts) {
  const out = new Map();
  const byRow = verdictsByRow(verdicts);
  if (!byRow) return out;
  byRow.forEach((v, n) => { if (v.verdict === 'blocked') out.set(n, v.reason || 'We left this row out.'); });
  return out;
}

// ── the file of rows to fix ─────────────────────────────────────────────────

/**
 * The rows that did not go in, back as a CSV the operator can fix and load
 * again. Same columns as the template plus one 'problem' column on the end, so
 * the fixed file drops straight back into this screen.
 */
export function failedCsv(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const header = TEMPLATE_COLUMNS.concat(['problem']);
  const rows = [header];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] || {};
    const src = e.row && typeof e.row === 'object' ? e.row : {};
    const cells = [];
    for (let c = 0; c < TEMPLATE_COLUMNS.length; c++) {
      const v = src[TEMPLATE_COLUMNS[c]];
      cells.push(v == null ? '' : String(v));
    }
    cells.push(e.problem == null ? '' : String(e.problem));
    rows.push(cells);
  }
  return toCsv(rows);
}

/** 'customer-import-problems-2026-09-17.csv'. */
export function failedFileName(today) {
  const d = today ? String(today) : '';
  const day = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return 'customer-import-problems-' + day + '.csv';
}

// ── sending it ──────────────────────────────────────────────────────────────

/** The rows split into the batches we post, so the screen can show progress. */
export function chunkRows(rows, size) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : CHUNK_SIZE;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** The function's name for this import. It is the DIRECTORY under
 *  supabase/functions, and nothing else. */
export const IMPORT_FUNCTION = 'customer-import';

/**
 * A batch id: a uuid, because import_batches.id is one and the edge function
 * refuses anything else. `rand` is for tests; the browser's own crypto is used
 * when there is one.
 */
export function newBatchId(rand) {
  try {
    if (!rand && typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* older browser, fall through */ }
  const r = typeof rand === 'function' ? rand : Math.random;
  const hex = [];
  for (let i = 0; i < 32; i++) hex.push(Math.floor(r() * 16) & 15);
  hex[12] = 4;
  hex[16] = (hex[16] & 3) | 8;
  const s = hex.map((h) => h.toString(16)).join('');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}

/** The body for 'who am I importing into'. Reads nothing from a file. */
export function contextRequestBody(args) {
  const a = args || {};
  return {
    action: 'context',
    ops_location_id: String(a.opsLocationId || ''),
    org_id: String(a.orgId || ''),
  };
}

/** The body for the preview: the rows, the day and the stamp card. Writes nothing. */
export function previewRequestBody(args) {
  const a = args || {};
  return {
    action: 'preview',
    ops_location_id: String(a.opsLocationId || ''),
    org_id: String(a.orgId || ''),
    rows: Array.isArray(a.rows) ? a.rows : [],
    today: String(a.today || ''),
    program_id: a.programId || null,
  };
}

/**
 * The body we post to import one slice, exactly the keys index.ts reads.
 * customerImportWiring.test.js holds this against the function key for key.
 */
export function importRequestBody(args) {
  const a = args || {};
  return {
    action: 'import',
    ops_location_id: String(a.opsLocationId || ''),
    org_id: String(a.orgId || ''),
    rows: Array.isArray(a.rows) ? a.rows : [],
    batch_id: String(a.batchId || ''),
    filename: String(a.filename || ''),
    today: String(a.today || ''),
    program_id: a.programId || null,
    consent_text: String(a.consentText || ''),
    privacy_version: a.privacyVersion || null,
    chunk_index: Number(a.chunkIndex) || 0,
  };
}

function rowList(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || typeof f !== 'object') continue;
    const n = Number(f.row_number != null ? f.row_number : f.rowNumber) || 0;
    const reason = String(f.reason || f.message || '');
    out.push({ rowNumber: n, reason, text: n ? 'Row ' + n + ': ' + reason : reason });
  }
  return out;
}

/**
 * The rows that did not go in, out of one chunk's answer: every one with a row
 * number the Download the rows to fix button can find again.
 *
 * ONLY rows. A line about the whole run ('Loyalty is switched off for this
 * company') is a note, never a failed row: counting those as rows is how a run
 * reported people as failed who had gone in fine, and never showed the words.
 * An older answer that put both in one `errors` list is split here: a line
 * that starts 'Row N:' is a row, anything else is a note (see notesFromChunk).
 */
export function failedFromChunk(chunk) {
  const c = chunk || {};
  const out = rowList(c.failed);
  const lines = Array.isArray(c.errors) ? c.errors : [];
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i] == null ? '' : lines[i]);
    const m = text.match(/^Row (\d+): ?(.*)$/);
    if (m) out.push({ rowNumber: Number(m[1]), reason: m[2], text });
  }
  return out;
}

/** Rows the server left out on purpose, by row. */
export function skippedFromChunk(chunk) {
  return rowList((chunk || {}).skipped_rows);
}

/** The lines about the whole run. Every one is shown, none is counted. */
export function notesFromChunk(chunk) {
  const c = chunk || {};
  const out = [];
  const add = (t) => { const s = String(t == null ? '' : t).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  const notes = Array.isArray(c.notes) ? c.notes : [];
  for (let i = 0; i < notes.length; i++) add(notes[i]);
  const lines = Array.isArray(c.errors) ? c.errors : [];
  for (let i = 0; i < lines.length; i++) if (!/^Row \d+:/.test(String(lines[i] || ''))) add(lines[i]);
  return out;
}

/**
 * Add one chunk's answer to what we have so far.
 *
 * The writer puts this chunk's numbers under `chunk` and the running file
 * totals under `totals`.
 */
export function mergeResult(sofar, next) {
  const a = sofar || {};
  const b = next || {};
  const c = b.chunk && typeof b.chunk === 'object' ? b.chunk : b;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const failed = (Array.isArray(a.failed) ? a.failed : []).concat(failedFromChunk(c));
  const skippedRows = (Array.isArray(a.skippedRows) ? a.skippedRows : []).concat(skippedFromChunk(c));
  const notes = (Array.isArray(a.notes) ? a.notes : []).slice();
  const more = notesFromChunk(c);
  for (let i = 0; i < more.length; i++) if (notes.indexOf(more[i]) < 0) notes.push(more[i]);
  return {
    created: num(a.created) + num(c.created),
    updated: num(a.updated) + num(c.updated),
    skipped: num(a.skipped) + num(c.skipped),
    stamped: num(a.stamped) + num(c.stamped),
    enrolled: num(a.enrolled) + num(c.enrolled),
    alreadyStamped: num(a.alreadyStamped) + num(c.already_stamped) + num(c.alreadyStamped),
    upToDate: num(a.upToDate) + num(c.up_to_date) + num(c.upToDate),
    deleted: num(a.deleted) + num(c.deleted),
    consentWithheld: num(a.consentWithheld) + num(c.consent_withheld) + num(c.consentWithheld),
    failed,
    skippedRows,
    notes,
    batchId: b.batch_id || b.batchId || a.batchId || null,
  };
}

/** 'Sent 200 of 412.' */
export function progressText(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  return 'Sent ' + d + ' of ' + t + '.';
}

/** 0 to 100, safe when there is nothing to do. */
export function progressPercent(done, total) {
  const t = Number(total) || 0;
  if (t < 1) return 0;
  const d = Math.max(0, Math.min(t, Number(done) || 0));
  return Math.round((d / t) * 100);
}

// ── when the server is not there ────────────────────────────────────────────

/**
 * One plain line for a request that did not work, so the screen can say it and
 * carry on.
 */
export function importErrorMessage(status, body) {
  const code = Number(status) || 0;
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  if (code === 404 || /not\s*found/i.test(text || '')) {
    return 'The import is not live on this site yet, so nothing was sent. Nothing has changed.';
  }
  if (code === 401 || code === 403) {
    // The server's own words when it has them: "Import is switched off: no
    // staff emails configured" is something to fix, not a sign in problem.
    const why = body && typeof body === 'object' && typeof body.error === 'string' ? body.error.trim() : '';
    return 'You are not allowed to import here. ' + (why ? why + ' ' : '') + 'Only named ServOS staff can import.';
  }
  if (code === 409 && body && typeof body === 'object' && typeof body.error === 'string') return 'It stopped: ' + body.error;
  if (code === 413) return 'That was too much in one go. Split the file and try again.';
  if (code === 429) return 'The server asked us to slow down. Wait a minute and try again.';
  if (code >= 500) {
    // The server's own words when it has them ("We could not check who is already
    // on file, so nothing was written"), so the operator is not left to retry blind.
    const why = body && typeof body === 'object' && typeof body.error === 'string' ? body.error.trim() : '';
    return why ? 'It stopped: ' + why + ' Nothing more was sent.' : 'The server had a problem. Nothing more was sent. Try again in a minute.';
  }
  const plain = (body && typeof body === 'object' && typeof body.error === 'string') ? body.error : '';
  return plain ? 'It stopped: ' + plain : 'It stopped and we do not know why. Nothing more was sent.';
}

/** The line shown after a run. Skipped (left out on purpose) and did not go in
 *  (a write that failed) are different things and are counted apart. */
export function resultLine(result) {
  const r = result || {};
  const bits = [];
  bits.push(count(Number(r.created) || 0, 'customer') + ' added');
  if ((Number(r.updated) || 0) > 0) bits.push(count(Number(r.updated) || 0, 'customer') + ' filled in');
  if ((Number(r.upToDate) || 0) > 0) bits.push(count(Number(r.upToDate) || 0, 'customer') + ' already up to date');
  if ((Number(r.skipped) || 0) > 0) bits.push(count(Number(r.skipped) || 0, 'row') + ' left out');
  const failed = Array.isArray(r.failed) ? r.failed.length : 0;
  if (failed > 0) bits.push(count(failed, 'row') + ' did not go in');
  return bits.join(', ') + '.';
}
