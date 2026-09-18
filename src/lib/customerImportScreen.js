// src/lib/customerImportScreen.js
//
// The parts of the Import customers screen that are just rules, pulled out of
// the JSX so node:test can run them. No React, no DOM, no fetch, no clock read
// the caller cannot override.
//
// The reading of the file itself is NOT here. That lives in
// src/lib/customerImport.js and is mirrored for the edge function in
// supabase/functions/_shared/customerImport.ts, so the screen and the thing
// that writes the rows always agree about what the file said. This file only
// decides what the screen shows and when the Import button may be pressed.
//
// ============================================================================
//  WHAT THE IMPORT BUTTON IS GUARDING
// ============================================================================
//
//  * Stamps have to land on a stamp card programme. Coffee Boy has ZERO
//    programmes today (checked live, 17 Sep 2026), so a file full of stamps
//    would have nowhere to put them. We never invent a programme, and we never
//    quietly drop the stamps: the button stays off and the screen says, in
//    plain words, to make a stamp card first.
//  * A file with NO stamps in it does not need a programme, so we do not block
//    that one. Nobody's stamps can be lost by importing people who have none.
//  * Consent is a tick the operator makes, once, before anything is written.
//    The people are coming from another marketing system where they opted in,
//    and the tick is what puts that in writing on every row.
//
// Every message in here is read out loud by somebody who is not technical.
// Short words, no jargon, and never a number without saying what it counts.

import { TEMPLATE_COLUMNS, toCsv, buildExistingKeys } from './customerImport.js';

/** How many rows go to the server in one request. */
export const CHUNK_SIZE = 200;

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
 *   fileRead      true once a file has been read
 *   ready         how many rows we would write
 *   withStamps    how many of those rows carry stamps or unused rewards
 *   programmes    the stamp card programmes this company has
 *   programId     the one the operator picked
 *   consentGiven  the tick box
 *   busy          an import is already running
 *   alreadyRan    this file has been sent already
 *   demo          this browser has no database behind it (local dev)
 */
export function importBlockReason(state) {
  const s = state || {};
  if (s.busy) return 'Importing. Please wait.';
  if (s.demo) return 'This is a demo screen. Nothing can be imported here.';
  // A second press on the same file would send it all over again. People are
  // safe from that (we fill blanks, we never add the same phone twice), but
  // stamps are not, so the button goes off the moment a run finishes.
  if (s.alreadyRan) return 'This file has gone in. Pick another file to import more.';
  if (!s.fileRead) return 'Pick a file first.';
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

/** The line under the stamp card picker when the company has no programmes. */
export function noProgrammeLine(withStamps) {
  const n = Number(withStamps) || 0;
  if (n < 1) return 'No stamp cards here yet. This file has no stamps in it, so that is fine.';
  return 'Stamps are waiting for ' + count(n, 'person', 'people') + ' in this file. Make a stamp card in Loyalty first, then come back and import.';
}

// ── the confirm ─────────────────────────────────────────────────────────────

/**
 * What the operator reads before anything is written. It says the numbers and
 * it says it cannot be undone from this screen, because it cannot.
 */
export function confirmMessage(summary) {
  const s = summary || {};
  const made = Number(s.newCustomers) || 0;
  const known = Number(s.alreadyKnown) || 0;
  const lines = [];
  lines.push('This will add ' + count(made, 'new customer') + '.');
  if (known > 0) lines.push('It will also fill in blanks on ' + count(known, 'customer') + ' you already have. It never overwrites what is there.');
  const stamps = Number(s.stampsTotal) || 0;
  const rewards = Number(s.rewardsTotal) || 0;
  if (stamps > 0 || rewards > 0) lines.push('Stamps going on: ' + count(stamps, 'stamp') + ' and ' + count(rewards, 'free item') + '.');
  lines.push('It cannot be undone from this screen.');
  lines.push('Import now?');
  return lines.join('\n\n');
}

// ── the preview table ───────────────────────────────────────────────────────

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

/**
 * The first rows of the file, in file order, ready to put in a table.
 *
 * Each one is { rowNumber, name, phone, email, stamps, rewards, status, note }.
 * status is 'new', 'known' or 'problem'. 'known' means we already have that
 * person, so the import fills their blanks instead of adding them twice.
 */
export function previewRows(checked, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : PREVIEW_ROWS;
  const keys = buildExistingKeys(o.existingKeys);
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
    const known = (r.phone && keys.has('p:' + r.phone)) || (r.email && keys.has('e:' + r.email));
    const notes = [];
    for (let j = 0; j < (r.warnings || []).length; j++) notes.push(r.warnings[j].message);
    list.push({
      rowNumber: r.rowNumber,
      name: r.name || '',
      phone: r.phone || r.phoneRaw || '',
      email: r.email || '',
      stamps: r.stamps || 0,
      rewards: r.rewardsUnused || 0,
      status: known ? 'known' : 'new',
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
 *  supabase/functions, and nothing else: a name that does not match is a 404
 *  the screen dresses up as "not live on this site yet". */
export const IMPORT_FUNCTION = 'customer-import';

/**
 * The body we post, exactly the keys index.ts reads and no others.
 *
 * This lived inline in the JSX and drifted from the function on FIVE keys at
 * once: no `action` at all (400 'action required'), `location_id` where the
 * function reads `ops_location_id`, and `batch_key` where it reads `batch_id`,
 * which minted a fresh batch id for every chunk, so a 20,000 row file wrote 100
 * import_batches rows and the "carry on" guard had nothing to recognise. It is
 * a function here so a test can hold it against what index.ts actually reads.
 */
export function importRequestBody(args) {
  const a = args || {};
  return {
    action: 'import',
    ops_location_id: String(a.opsLocationId || ''),
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

/**
 * The rows that did not go in, out of one chunk's answer.
 *
 * The writer reports them as plain lines, 'Row 44: we could not add this
 * person.', because that is what the operator reads. We keep the line AND pull
 * the row number back out of it, so the Download the rows to fix button can
 * find that row in the file again.
 */
export function failedFromChunk(chunk) {
  const c = chunk || {};
  const out = [];
  const lines = Array.isArray(c.errors) ? c.errors : [];
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i] == null ? '' : lines[i]);
    if (!text) continue;
    const m = text.match(/^Row (\d+): ?(.*)$/);
    out.push({ rowNumber: m ? Number(m[1]) : 0, reason: m ? m[2] : text, text });
  }
  return out;
}

/**
 * Add one chunk's answer to what we have so far.
 *
 * The writer puts this chunk's numbers under `chunk` and the running file
 * totals under `totals`. Reading the top level instead found nothing at all, so
 * every count came back 0 and a run that worked perfectly reported "0 customers
 * added" to the operator.
 */
export function mergeResult(sofar, next) {
  const a = sofar || {};
  const b = next || {};
  const c = b.chunk && typeof b.chunk === 'object' ? b.chunk : b;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const failed = (Array.isArray(a.failed) ? a.failed : [])
    .concat(Array.isArray(b.failed) ? b.failed : [])
    .concat(failedFromChunk(c));
  const notes = (Array.isArray(a.notes) ? a.notes : [])
    .concat(Array.isArray(c.notes) ? c.notes.map((n) => String(n)) : []);
  return {
    created: num(a.created) + num(c.created),
    updated: num(a.updated) + num(c.updated),
    skipped: num(a.skipped) + num(c.skipped),
    stamped: num(a.stamped) + num(c.stamped),
    enrolled: num(a.enrolled) + num(c.enrolled),
    alreadyStamped: num(a.alreadyStamped) + num(c.already_stamped) + num(c.alreadyStamped),
    consentWithheld: num(a.consentWithheld) + num(c.consent_withheld) + num(c.consentWithheld),
    failed,
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
 * carry on. The import is new, so the realistic case is that it is not live on
 * this project yet: that is a 404 from the functions host, and it must read as
 * "nothing happened", never as an error the operator caused.
 */
export function importErrorMessage(status, body) {
  const code = Number(status) || 0;
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  if (code === 404 || /not\s*found/i.test(text || '')) {
    return 'The import is not live on this site yet, so nothing was sent. Nothing has changed.';
  }
  if (code === 401 || code === 403) return 'You are not allowed to import here. Sign in again, or ask Peter.';
  if (code === 413) return 'That was too much in one go. Split the file and try again.';
  if (code === 429) return 'The server asked us to slow down. Wait a minute and try again.';
  if (code >= 500) return 'The server had a problem. Nothing more was sent. Try again in a minute.';
  const plain = (body && typeof body === 'object' && typeof body.error === 'string') ? body.error : '';
  return plain ? 'It stopped: ' + plain : 'It stopped and we do not know why. Nothing more was sent.';
}

/** The line shown after a run that worked. */
export function resultLine(result) {
  const r = result || {};
  const bits = [];
  bits.push(count(Number(r.created) || 0, 'customer') + ' added');
  if ((Number(r.updated) || 0) > 0) bits.push(count(Number(r.updated) || 0, 'customer') + ' filled in');
  if ((Number(r.skipped) || 0) > 0) bits.push(count(Number(r.skipped) || 0, 'row') + ' skipped');
  const failed = Array.isArray(r.failed) ? r.failed.length : 0;
  if (failed > 0) bits.push(count(failed, 'row') + ' did not go in');
  return bits.join(', ') + '.';
}
