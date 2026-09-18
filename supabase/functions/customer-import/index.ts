// supabase/functions/customer-import/index.ts
//
// Bring a loyalty customer list in from another system. Peter, 17 Sep 2026:
// "next week we start importing customer data for loyalty from other platforms,
// moving stamp cards and auto creating their accounts."
//
// SERVOS STAFF ONLY. Peter, 18 Sep 2026: "I dont want customer able to mess
// something up so can we hide it or make it so only internal to servos can
// access it?" and "we could have it on the admin portal". The screen lives in
// the admin portal (?mode=admin, src/admin/sections/AdminCustomerImport.jsx),
// and hiding a screen is not security, so EVERY action here, preview included,
// refuses anybody who is not ServOS staff. See staffVerdict in
// _shared/customerImportPlan.ts: the service role, or a super_admin whose
// email is EXACTLY one of SERVOS_IMPORT_STAFF_EMAILS. With that variable unset
// the import is switched off for everybody but the service role. A
// user_locations row for the venue, which is what a venue owner has, is not
// enough, and neither is an email on a ServOS domain (create-user lets a venue
// owner make a confirmed login for any address).
//
// Three actions, and only one of them writes.
//
//   context  { action:'context', ops_location_id, org_id }
//            The company the operator picked, in words: its name, the venue,
//            the country its phones are read as, its stamp cards. Touches
//            NOTHING.
//
//   preview  { action:'preview', ops_location_id, org_id, rows, today?, program_id? }
//            Says who is new, who we already have, who we refuse to touch, and
//            what the stamps would come to. Touches NOTHING.
//
//   import   { action:'import', ops_location_id, org_id, rows, batch_id,
//              filename, today, program_id, consent_text, privacy_version?,
//              chunk_index }
//            Writes one slice. Up to 500 rows a call. Every call answers with
//            the batch id, this chunk's numbers under `chunk`, and the running
//            file totals under `totals`. REFUSED, before anything is written,
//            until the import_batches migration has been run: no record, no
//            import. context says so (batch_table false) and preview still runs.
//
// THOSE KEY NAMES ARE THE CONTRACT. The screen builds these bodies in exactly
// one place, src/lib/customerImportScreen.js, and
// src/lib/customerImportWiring.test.js holds what it posts against what this
// file reads, key for key.
//
// org_id is sent by the screen as the company the operator PICKED, and it must
// be the org of the venue. It is a check, never a source: the org and the
// platform company are always resolved here from the venue. That stops Coffee
// Boy's file going into another brand because somebody picked the wrong venue.
//
// Where things land:
//   Ops       customers, customer_consents, stamp_transactions, import_batches
//   Platform  customer_loyalty, customer_stamp_cards
//
// THE RULES, all of them somebody's account:
//   1. Match on PHONE first, then email, under every shape that phone could
//      already be on file in (see lookupKeys). The phone is the loyalty login.
//   2. Fill blanks only. An import never overwrites what is there.
//   3. A file may only ever ADD a yes. marketing_opt_in is only ever set true,
//      and a no in the file writes NOTHING (no consent row, no flag).
//   4. Never undo a no. Somebody who switched marketing off here (the flag, a
//      consent row, or a suppression) is not re-consented by a file, and nor
//      is somebody simply not opted in here.
//   8. Erased people stay erased. A row that is somebody deleted here is left
//      out and named. Never un-deleted, never a twin.
//   5. Never double a stamp. A customer who already carries any import earn row
//      for the programme is skipped, whatever batch it came from, and we say so.
//   6. Nothing off the wire is trusted. Every posted row is stripped back to the
//      raw template cells before validateRows sees it.
//   7. Two rows, one customer: the first row wins and the second is named.
//      Postgres refuses a bulk upsert that touches one row twice (21000).
//
// The decisions live in _shared/customerImportPlan.ts and the file reading in
// _shared/customerImport.ts, both pure and both under test. This file only
// talks to the two databases.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateRows, rawRowsOnly, problemRowNumbers, countryFromVenue } from '../_shared/customerImport.ts';
import type { ImportRow, CountryRead } from '../_shared/customerImport.ts';
import {
  MAX_ROWS_PER_CALL, READ_CHUNK, WRITE_CHUNK,
  batchTag, stampKey, STAMP_KEY_PREFIX,
  chunk, indexExisting, lookupKeys, decideRows, planCounts, needsProgramme,
  programmeCheck, buildInsert, buildPatch, groupPatches, buildConsent, consentIsNew,
  consentDecision, stampPlan, stampsOwed, stampsSkipped, alreadyStampedLine,
  emptyProgress, skipRow, failRow, runNote, chunkAnswer, staffVerdict, isBatchId, batchRecord, sameAsReason,
  withheldLines, deletedLine, emailIlikeFilter, EMAIL_READ_CHUNK, parseStaffEmails, STAFF_EMAILS_ENV, IMPORT_SWITCHED_OFF, batchTableGate, patchChanges,
} from '../_shared/customerImportPlan.ts';
import type { Decision, ExistingCustomer, Progress } from '../_shared/customerImportPlan.ts';
import { generateMemberCode, generateReferralCode, getOrCreateConfig } from '../_shared/loyalty-utils.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// The ServOS staff who may import, by EXACT email, comma separated. Unset or
// empty switches the import off for everybody but the service role.
const STAFF_EMAILS = parseStaffEmails(Deno.env.get(STAFF_EMAILS_ENV) ?? '');

// The customer columns the matcher needs, and no more. deleted_at is read so a
// person deleted here is recognised and left out, never made again.
const CUSTOMER_COLS = 'id, name, first_name, last_name, phone, phone_raw, email, birthday, notes, source, sources, marketing_opt_in, marketing_opt_in_at, deleted_at';

// ── auth: ServOS staff only, for EVERY action ──────────────────────────────
async function staffAuth(req: Request): Promise<{ ok: boolean; userId: string | null; reason: string }> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, userId: null, reason: 'Sign in first.' };
  if (SERVICE_ROLE && token === SERVICE_ROLE) return { ok: true, userId: null, reason: '' };
  // Nobody on the list: say so before looking anybody up.
  if (!STAFF_EMAILS.length) return { ok: false, userId: null, reason: IMPORT_SWITCHED_OFF };
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return { ok: false, userId: null, reason: 'Sign in first.' };
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  const verdict = staffVerdict({ user, role: prof?.role, allowlist: STAFF_EMAILS });
  return { ok: verdict.ok, userId: String(user.id), reason: verdict.reason };
}

// A missing table answers 42P01 from Postgres, PGRST205 from PostgREST's schema
// cache. The importer works before the batch migration is applied.
function tableMissing(err: unknown): boolean {
  const e = (err || {}) as { code?: string; message?: string };
  const code = String(e.code ?? '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  return /relation .*import_batches.* does not exist|could not find the table/i.test(String(e.message ?? ''));
}

function isDuplicate(err: unknown): boolean {
  const e = (err || {}) as { code?: string; message?: string };
  return String(e.code ?? '') === '23505' || /duplicate key value/i.test(String(e.message ?? ''));
}

// ── the venue's country. countryFromVenue decides the order: Ops
//    locations.country, then Platform locations.country, then the PLATFORM
//    currency, and only last the Ops currency, which defaults to 'GBP' and so
//    would read a US venue nobody updated in Ops as GB. A column that does not
//    exist is an error (42703) and simply says nothing. The source is sent to
//    the screen, which says in words where the country came from. ─────────────
async function venueCountry(opsLocationId: string, platformCurrency: unknown): Promise<CountryRead> {
  let country: unknown = null;
  let platformCountry: unknown = null;
  let opsCurrency: unknown = null;
  const byCountry = await opsAdmin.from('locations').select('country').eq('id', opsLocationId).maybeSingle();
  if (!byCountry.error) country = (byCountry.data as Record<string, unknown> | null)?.country ?? null;
  const byPlatformCountry = await platformAdmin.from('locations').select('country').eq('ops_location_id', opsLocationId).maybeSingle();
  if (!byPlatformCountry.error) platformCountry = (byPlatformCountry.data as Record<string, unknown> | null)?.country ?? null;
  const byCurrency = await opsAdmin.from('locations').select('currency').eq('id', opsLocationId).maybeSingle();
  if (!byCurrency.error) opsCurrency = (byCurrency.data as Record<string, unknown> | null)?.currency ?? null;
  return countryFromVenue({ country, platformCountry, platformCurrency, opsCurrency });
}

// ── existing customers for one slice ────────────────────────────────────────
//
// DELETED PEOPLE ARE READ TOO. Back Office deletes by stamping deleted_at and
// keeps the phone and the email, and both unique indexes skip deleted rows. If
// this read skipped them as well, a person deleted here but still in a stale
// export would be inserted again as a brand new customer. decideRows sees
// deleted_at and leaves the row out by name. Never un-deleted, never a twin.
async function readExisting(orgId: string, rows: ImportRow[]): Promise<ExistingCustomer[]> {
  const { phones, raws, emails } = lookupKeys(rows);
  const found = new Map<string, ExistingCustomer>();
  const take = (list: unknown): void => {
    const arr = (Array.isArray(list) ? list : []) as ExistingCustomer[];
    for (let i = 0; i < arr.length; i++) if (arr[i]?.id) found.set(arr[i].id, arr[i]);
  };

  // customers.phone, under every shape the app, or an older run of this
  // importer, could have stored this number in.
  for (const slice of chunk(phones, READ_CHUNK)) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).in('phone', slice);
    take(data);
  }
  // customers.phone_raw is TEXT AS TYPED ('0161 496 0000'). It is asked for
  // the cell exactly as the file wrote it, and for the ways a person would
  // type the same number. See lookupKeys. Back Office saves an edited phone
  // here and nowhere else, which is why this arm is worth having.
  for (const slice of chunk(raws, READ_CHUNK)) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).in('phone_raw', slice);
    take(data);
  }
  // Emails are read WHATEVER CASE they were stored in (see emailIlikeFilter).
  // A deleted Jane@Example.com must be found by jane@example.com, because the
  // unique index on lower(email) skips deleted rows and would let a twin in.
  for (const slice of chunk(emails, EMAIL_READ_CHUNK)) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).or(emailIlikeFilter(slice));
    take(data);
  }
  return Array.from(found.values());
}

// One customer, re read after a unique violation, so a row that raced (or an
// email stored in different case) becomes an update instead of a lost person.
async function reReadOne(orgId: string, row: ImportRow): Promise<ExistingCustomer | null> {
  const phones: string[] = [];
  for (const v of [row.phone, row.phoneE164]) if (v && phones.indexOf(v) < 0) phones.push(v);
  for (const p of phones) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).eq('phone', p).is('deleted_at', null).maybeSingle();
    if (data) return data as ExistingCustomer;
  }
  if (row.email) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).ilike('email', row.email).is('deleted_at', null).maybeSingle();
    if (data) return data as ExistingCustomer;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = String(body?.action ?? '').trim();
  if (!action) return json({ error: 'action required' }, 400);
  if (action !== 'context' && action !== 'preview' && action !== 'import') return json({ error: 'unknown action' }, 400);

  // Staff first, before anything about the venue is read or said.
  const auth = await staffAuth(req);
  if (!auth.ok) return json({ error: auth.reason || 'Only ServOS staff can import customers.' }, 403);

  const opsLocationId = String(body?.ops_location_id ?? '').trim();
  const pickedOrg = String(body?.org_id ?? '').trim();
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);
  if (!pickedOrg) return json({ error: 'org_id required' }, 400);

  // org_id and company_id come from the venue, never from the browser. The
  // picked org is only a check that the operator is where they think they are.
  const { data: loc } = await opsAdmin.from('locations').select('org_id, name, timezone').eq('id', opsLocationId).maybeSingle();
  const orgId = loc?.org_id ? String(loc.org_id) : null;
  if (!orgId) return json({ error: 'That venue is not set up yet (no org).' }, 400);
  if (orgId !== pickedOrg) return json({ error: 'That venue is not in the company you picked. Pick the company again.', code: 'wrong_company' }, 409);

  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('company_id, currency').eq('ops_location_id', opsLocationId).maybeSingle();
  const companyId = platformLoc?.company_id ? String(platformLoc.company_id) : null;
  if (!companyId) {
    return json({ error: 'That venue is not linked to a company yet. Re-provision it in Company Admin.' }, 400);
  }
  const country = await venueCountry(opsLocationId, platformLoc?.currency);

  // ── context: who the operator is about to import into ────────────────────
  if (action === 'context') {
    const { data: org } = await opsAdmin.from('organisations').select('name').eq('id', orgId).maybeSingle();
    const { data: company } = await platformAdmin.from('companies').select('name').eq('id', companyId).maybeSingle();
    const { count: sites } = await opsAdmin.from('locations')
      .select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'active');
    const { data: progs } = await platformAdmin.from('stamp_card_programs')
      .select('id, name, stamps_required, reward_description, active')
      .eq('company_id', companyId).eq('active', true).order('created_at', { ascending: true });
    let batchTable = true;
    const { error: probe } = await opsAdmin.from('import_batches').select('id').limit(1);
    if (probe && tableMissing(probe)) batchTable = false;
    return json({
      ok: true,
      org_id: orgId,
      org_name: org?.name ?? null,
      company_id: companyId,
      company_name: company?.name ?? null,
      venue_name: loc?.name ?? null,
      timezone: loc?.timezone ?? null,
      sites: sites ?? 0,
      country: country.country,
      country_source: country.source,
      country_label: country.label,
      programmes: Array.isArray(progs) ? progs : [],
      // False until 20260918_OPS_customer_import_batches.sql has been run. The
      // screen shows one blocking line and the import action refuses.
      batch_table: batchTable,
      batch_table_message: batchTableGate('import', batchTable).message,
      max_rows: MAX_ROWS_PER_CALL,
    });
  }

  const rawRows = Array.isArray(body?.rows) ? (body.rows as unknown[]) : [];
  if (rawRows.length > MAX_ROWS_PER_CALL) {
    return json({ error: `Send up to ${MAX_ROWS_PER_CALL} rows at a time.`, max_rows: MAX_ROWS_PER_CALL }, 400);
  }

  // The venue's own day and the company's country, so a date and a phone in
  // the file are read exactly as the screen read them.
  const today = body?.today ? String(body.today) : null;
  const readOpts = { today, country: country.country };
  // EVERY row is stripped back to the raw cells of the template before it is
  // read. Nothing off the wire is trusted to have been checked already.
  const posted = rawRowsOnly(rawRows);
  const checked = validateRows(posted, readOpts);
  const ready: ImportRow[] = checked.ready;

  // The stamp card this run lands on, if any. It must belong to this company.
  const programId = String(body?.program_id ?? '').trim();
  let program: { id: string; company_id: string; stamps_required: number; name?: string } | null = null;
  if (programId) {
    const { data } = await platformAdmin.from('stamp_card_programs')
      .select('id, company_id, stamps_required, name, active').eq('id', programId).maybeSingle();
    program = (data as typeof program) ?? null;
  }
  const programVerdict = programmeCheck({ rows: ready, programId, program, companyId });

  const existing = await readExisting(orgId, ready);
  const decisions = decideRows(ready, indexExisting(existing, { country: country.country }), { country: country.country });
  const counts = planCounts(decisions);

  // ── preview: nothing is written ───────────────────────────────────────────
  if (action === 'preview') {
    return json({
      ok: true,
      org_id: orgId,
      company_id: companyId,
      country: country.country,
      country_label: country.label,
      counts,
      programme: programVerdict,
      stamps_need_programme: needsProgramme(ready) && !programId,
      programme_name: program?.name ?? null,
      stamps_required: program?.stamps_required ?? null,
      verdicts: decisions.map((d) => ({
        row_number: d.rowNumber,
        verdict: d.verdict,
        reason: d.reason,
        matched_on: d.matchedOn,
        customer_id: d.customerId,
        same_as: d.sameAs ?? null,
        deleted: d.deleted === true,
      })),
      errors: checked.errors.map((e) => e.text),
      duplicates: checked.duplicatesInFile.map((d) => d.text),
      warnings: checked.warnings.map((w) => w.text),
      max_rows: MAX_ROWS_PER_CALL,
    });
  }

  // ── import: the only writing path ─────────────────────────────────────────

  // Nothing at all is written when the stamp card is wrong or missing.
  if (!programVerdict.ok) return json({ error: programVerdict.message, code: 'programme' }, 400);

  const consentText = String(body?.consent_text ?? '').trim();
  // Only a yes is ever written, so only a yes needs to say where it came from.
  const anyYes = ready.some((r) => r.marketingOptIn === true);
  if (anyYes && !consentText) {
    return json({ error: 'Say where these people opted in before we write anything.', code: 'consent_text' }, 400);
  }
  const privacyVersion = body?.privacy_version ? String(body.privacy_version) : null;

  // The screen mints ONE batch id per file and sends it on every chunk.
  const batchId = String(body?.batch_id ?? '').trim();
  if (!isBatchId(batchId)) return json({ error: 'batch_id must be the id the screen made for this file.', code: 'batch_id' }, 400);

  // NO RECORD, NO IMPORT. The batch row is written FIRST, before any person,
  // and a missing import_batches table refuses the whole call.
  {
    const { error } = await opsAdmin.from('import_batches')
      .upsert(batchRecord({ batchId, orgId, companyId, programId: programId || null, filename: body?.filename, userId: auth.userId, consentText }),
        { onConflict: 'id', ignoreDuplicates: true });
    if (error) {
      const gate = batchTableGate('import', !tableMissing(error));
      if (!gate.ok) return json({ error: gate.message, code: 'batch_table' }, 409);
      return json({ error: `Could not start the import: ${error.message}` }, 500);
    }
    // A batch id is a uuid the screen made, and it must be THIS company's.
    const { data: mine } = await opsAdmin.from('import_batches').select('org_id').eq('id', batchId).maybeSingle();
    if (!mine) return json({ error: 'We could not find the record of this import, so nothing was written.', code: 'batch_id' }, 500);
    if (String(mine.org_id) !== orgId) return json({ error: 'That batch belongs to another company.', code: 'batch_id' }, 409);
  }

  const now = new Date().toISOString();
  const ctx = { orgId, batchId, now, country: country.country };
  const progress: Progress = emptyProgress();
  progress.rows = rawRows.length;

  // Rows the rules refused, and rows that are the same person twice in this
  // slice. Counted ONCE per row, however many complaints one row has.
  const complaints = new Map<number, string>();
  for (const e of checked.errors) complaints.set(e.rowNumber, (complaints.get(e.rowNumber) ? complaints.get(e.rowNumber) + ' ' : '') + e.message);
  for (const n of problemRowNumbers(checked)) skipRow(progress, n, complaints.get(n) ?? '');
  for (const d of checked.duplicatesInFile) skipRow(progress, d.rowNumber, d.message);

  // ── 0. who has already said stop ──────────────────────────────────────────
  //
  // A marketing_suppressions row is an unsubscribe click or a STOP text, keyed
  // by ADDRESS. Read BEFORE the first insert. Only addresses this row really
  // has: the phone we write and its E.164 form where readPhone built one. A US
  // row never gets a +44 address invented for it.
  const addressesOf = (r: ImportRow): string[] => {
    const out: string[] = [];
    for (const a of [r.email, r.phone, r.phoneE164]) if (a && out.indexOf(String(a)) < 0) out.push(String(a));
    return out;
  };
  const suppressedAddresses = new Set<string>();
  const addressSet = new Set<string>();
  for (const r of ready) for (const a of addressesOf(r)) addressSet.add(a);
  for (const slice of chunk(Array.from(addressSet), READ_CHUNK)) {
    const { data, error } = await opsAdmin.from('marketing_suppressions')
      .select('address').eq('org_id', orgId).in('address', slice);
    if (error) {
      if (!tableMissing(error)) runNote(progress, 'We could not check who has unsubscribed, so nobody in this part was switched on for marketing: ' + error.message);
      // Fail safe: if we cannot read the list, nobody's yes is acted on.
      for (const a of addressSet) suppressedAddresses.add(a);
      break;
    }
    for (const s of (Array.isArray(data) ? data : []) as Array<{ address: string }>) suppressedAddresses.add(String(s.address));
  }
  const hasStopped = (d: Decision): boolean => addressesOf(d.row).some((a) => suppressedAddresses.has(a));

  // ── 1. new people ─────────────────────────────────────────────────────────
  const newOnes = decisions.filter((d) => d.verdict === 'new');
  for (const d of decisions) if (d.verdict === 'blocked') skipRow(progress, d.rowNumber, d.reason);
  // Deleted here: left out, counted, and named in one line for the run.
  const gone = decisions.filter((d) => d.deleted === true).map((d) => ({ rowNumber: d.rowNumber, name: d.row.name }));
  progress.deleted = gone.length;
  runNote(progress, deletedLine(gone));

  // A decision that starts as new can end up an update, when the insert trips a
  // unique index. Those move into this list and are patched like any other.
  const asUpdate: Array<{ decision: Decision; existing: ExistingCustomer }> = [];

  for (const slice of chunk(newOnes, WRITE_CHUNK)) {
    const payload = slice.map((d) => buildInsert(d.row, ctx, { allowOptIn: !hasStopped(d) }));
    const { data, error } = await opsAdmin.from('customers').insert(payload).select('id, phone, email');
    if (!error) {
      // Each new id is matched back to its person by that person's OWN phone or
      // email, never by position in the answer.
      const idByPhone = new Map<string, string>();
      const idByEmail = new Map<string, string>();
      for (const r of (Array.isArray(data) ? data : []) as Array<{ id: string; phone: string | null; email: string | null }>) {
        if (r.phone) idByPhone.set(String(r.phone), String(r.id));
        if (r.email) idByEmail.set(String(r.email).toLowerCase(), String(r.id));
      }
      for (const d of slice) {
        let id = (d.row.phone ? idByPhone.get(d.row.phone) : null) || (d.row.email ? idByEmail.get(d.row.email) : null) || null;
        if (!id) id = (await reReadOne(orgId, d.row))?.id ?? null;
        if (id) { d.customerId = String(id); progress.created++; continue; }
        failRow(progress, d.rowNumber, 'We added this person but could not read them back, so they have no card yet.');
      }
      continue;
    }
    // One bad row must not lose the other ninety nine, so the slice is retried
    // one at a time and only the row that is actually refused is named.
    for (const d of slice) {
      const { data: one, error: oneErr } = await opsAdmin.from('customers')
        .insert(buildInsert(d.row, ctx, { allowOptIn: !hasStopped(d) })).select('id').maybeSingle();
      if (!oneErr && one?.id) { d.customerId = String(one.id); progress.created++; continue; }
      if (oneErr && isDuplicate(oneErr)) {
        const found = await reReadOne(orgId, d.row);
        if (found) { d.customerId = found.id; d.verdict = 'update'; asUpdate.push({ decision: d, existing: found }); continue; }
      }
      failRow(progress, d.rowNumber, 'We could not add this person. ' + String(oneErr?.message ?? 'Unknown problem.'));
    }
  }

  // A raced insert can land two rows of this slice on one customer. The first
  // row keeps them; the second is named, exactly as decideRows does it.
  {
    const seen = new Map<string, number>();
    for (const d of decisions) {
      if (d.verdict === 'blocked' || !d.customerId) continue;
      const first = seen.get(d.customerId);
      if (first !== undefined && first !== d.rowNumber) {
        d.verdict = 'blocked';
        d.reason = sameAsReason(first);
        d.sameAs = first;
        skipRow(progress, d.rowNumber, d.reason);
        continue;
      }
      seen.set(d.customerId, d.rowNumber);
    }
  }

  // Everybody this slice touched, new and old alike.
  const touched = decisions.filter((d) => d.verdict !== 'blocked' && d.customerId);
  const touchedIds = Array.from(new Set(touched.map((d) => String(d.customerId))));

  const byId = new Map<string, ExistingCustomer>();
  for (const c of existing) byId.set(c.id, c);
  for (const u of asUpdate) byId.set(u.existing.id, u.existing);

  // ── 2. what these people have already said about marketing ───────────────
  //
  // Read BEFORE anything is patched. See consentDecision for the three ways
  // somebody says stop here, including the flag on its own, which is all the
  // Back Office untick and the loyalty portal toggle ever write.
  const priorByCustomer = new Map<string, Record<string, unknown>[]>();
  const priorAll: Record<string, unknown>[] = [];
  for (const slice of chunk(touchedIds, READ_CHUNK)) {
    const { data } = await opsAdmin.from('customer_consents')
      .select('customer_id, consented, consent_text, source, purpose, created_at')
      .in('customer_id', slice);
    for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const id = String(r.customer_id ?? '');
      if (!id) continue;
      const list = priorByCustomer.get(id) ?? [];
      list.push(r);
      priorByCustomer.set(id, list);
      priorAll.push(r);
    }
  }

  const consentOf = new Map<Decision, ReturnType<typeof consentDecision>>();
  const withheld: Array<{ rowNumber: number; name: string; kind: string }> = [];
  for (const d of touched) {
    const was = d.verdict === 'update' ? byId.get(String(d.customerId)) ?? null : null;
    const verdict = consentDecision(d.row, {
      priorConsents: priorByCustomer.get(String(d.customerId)) ?? [],
      suppressed: hasStopped(d),
      currentFlag: was ? (was.marketing_opt_in ?? null) : null,
      currentFlagAt: was ? (was.marketing_opt_in_at ?? null) : null,
      now,
    });
    consentOf.set(d, verdict);
    if (verdict && verdict.withheld) withheld.push({ rowNumber: d.rowNumber, name: d.row.name, kind: verdict.kind });
  }
  progress.consentWithheld = withheld.length;
  for (const line of withheldLines(withheld)) runNote(progress, line);

  // ── 3. people we already have: blanks only ────────────────────────────────
  const patches: Record<string, unknown>[] = [];
  const rowsOfPatch = new Map<string, number[]>();
  for (const d of decisions) {
    if (d.verdict !== 'update' || !d.customerId) continue;
    const was = byId.get(d.customerId) ?? null;
    if (!was) continue;
    const verdict = consentOf.get(d);
    const patch = buildPatch(d.row, was, ctx, { allowOptIn: !verdict || verdict.setFlag });
    // A match with nothing to change is a person we left exactly as they were:
    // already up to date, never "filled in", and not written to at all.
    if (!patch || !patchChanges(patch, was).length) { progress.upToDate++; continue; }
    patches.push(patch);
    const list = rowsOfPatch.get(String(patch.id)) ?? [];
    list.push(d.rowNumber);
    rowsOfPatch.set(String(patch.id), list);
  }

  // groupPatches collapses to ONE patch per customer before it groups, so no
  // bulk write can touch a row twice. UPDATED IS COUNTED WHEN THE WRITE LANDS.
  for (const group of groupPatches(patches)) {
    for (const slice of chunk(group, WRITE_CHUNK)) {
      const { error } = await opsAdmin.from('customers').upsert(slice, { onConflict: 'id' });
      if (!error) { progress.updated += slice.length; continue; }
      runNote(progress, 'We had to fill in ' + slice.length + ' of the people we already had one at a time: ' + String(error.message ?? 'unknown problem') + '.');
      for (const one of slice) {
        const id = String(one.id);
        const { id: _drop, org_id: _org, ...fields } = one as Record<string, unknown> & { id: unknown; org_id: unknown };
        const { error: oneErr } = await opsAdmin.from('customers').update(fields).eq('id', id).eq('org_id', orgId);
        if (!oneErr) { progress.updated++; continue; }
        for (const n of rowsOfPatch.get(id) ?? [0]) failRow(progress, n, 'We could not fill in this person: ' + oneErr.message);
      }
    }
  }

  // ── consent: a yes only. A file's no writes nothing. ─────────────────────
  if (touchedIds.length) {
    const rows: Record<string, unknown>[] = [];
    for (const d of touched) {
      const verdict = consentOf.get(d);
      if (!verdict || !verdict.write) continue;
      const consent = buildConsent(d.row, {
        customerId: String(d.customerId),
        orgId,
        companyId,
        locationId: opsLocationId,
        consentText,
        privacyVersion,
        now,
        createdAt: verdict.createdAt,
      });
      if (consent && consentIsNew(consent, priorAll)) rows.push(consent);
    }
    for (const slice of chunk(rows, WRITE_CHUNK)) {
      const { error } = await opsAdmin.from('customer_consents').insert(slice);
      if (error) runNote(progress, 'We could not write the opt in record for ' + slice.length + ' of these people: ' + error.message);
    }
  }

  // ── 4. loyalty membership on the platform ─────────────────────────────────
  if (touchedIds.length) {
    const config = await getOrCreateConfig(companyId);
    const members = new Set<string>();
    for (const slice of chunk(touchedIds, READ_CHUNK)) {
      const { data } = await platformAdmin.from('customer_loyalty')
        .select('customer_id').eq('company_id', companyId).in('customer_id', slice);
      for (const m of (Array.isArray(data) ? data : []) as Array<{ customer_id: string }>) members.add(String(m.customer_id));
    }
    const missing = touchedIds.filter((id) => !members.has(id));
    for (const slice of chunk(missing, WRITE_CHUNK)) {
      let landed = false;
      for (let attempt = 0; attempt < 3 && !landed; attempt++) {
        const payload = slice.map((customerId) => ({
          customer_id: customerId,
          company_id: companyId,
          member_code: generateMemberCode(),
          referral_code: generateReferralCode(),
          points_balance: 0,
          points_earned_total: 0,
          enrolled_at: now,
        }));
        const { data, error } = await platformAdmin.from('customer_loyalty')
          .upsert(payload, { onConflict: 'customer_id,company_id', ignoreDuplicates: true }).select('customer_id');
        if (!error) { progress.enrolled += Array.isArray(data) ? data.length : 0; landed = true; break; }
        // member_code and referral_code are both UNIQUE. A collision is simply
        // fresh codes.
        if (!isDuplicate(error)) { runNote(progress, 'We could not set up loyalty for ' + slice.length + ' of these people: ' + error.message); landed = true; break; }
      }
      if (!landed) runNote(progress, 'We could not set up loyalty for ' + slice.length + ' people. Run the import again and it will pick them up.');
    }
    if (config && config.enabled === false) {
      runNote(progress, 'Loyalty is switched off for this company, so nobody can use their card yet. Turn it on in Loyalty.');
    }
  }

  // ── 5. stamps ─────────────────────────────────────────────────────────────
  if (programId && program) {
    const required = Number(program.stamps_required) || 1;

    // Anybody an import has EVER stamped for this programme, from any batch.
    const stamped = new Set<string>();
    for (const slice of chunk(touchedIds, READ_CHUNK)) {
      const { data } = await opsAdmin.from('stamp_transactions')
        .select('customer_id').eq('program_id', programId).eq('type', 'earn')
        .like('idempotency_key', STAMP_KEY_PREFIX + '%').in('customer_id', slice);
      for (const t of (Array.isArray(data) ? data : []) as Array<{ customer_id: string }>) stamped.add(String(t.customer_id));
    }

    const leftAlone = stampsSkipped(decisions, stamped);
    progress.alreadyStamped = leftAlone.length;
    runNote(progress, alreadyStampedLine(leftAlone.length));

    const owed = stampsOwed(decisions, stamped);
    if (owed.length) {
      const cards = new Map<string, { stamps_collected: number; completed_count: number }>();
      const owedIds = owed.map((d) => String(d.customerId));
      for (const slice of chunk(owedIds, READ_CHUNK)) {
        const { data } = await platformAdmin.from('customer_stamp_cards')
          .select('customer_id, stamps_collected, completed_count')
          .eq('program_id', programId).eq('company_id', companyId).in('customer_id', slice);
        for (const c of (Array.isArray(data) ? data : []) as Array<{ customer_id: string; stamps_collected: number; completed_count: number }>) {
          cards.set(String(c.customer_id), { stamps_collected: c.stamps_collected, completed_count: c.completed_count });
        }
      }

      for (const slice of chunk(owed, WRITE_CHUNK)) {
        // The ledger row is claimed FIRST. If the card write then fails the
        // customer is short and we say so, which is recoverable. The other order
        // loses the claim and a re run doubles the balance.
        const ledger = slice.map((d) => ({
          customer_id: d.customerId,
          program_id: programId,
          location_id: opsLocationId,
          stamps: Number(d.row.stamps) || 0,
          type: 'earn',
          order_ref: 'import:' + batchId,
          note: 'Imported from another system',
          idempotency_key: stampKey(batchId, d.customerId, programId),
          created_at: now,
        }));
        const claimed = new Set<string>();
        const { data, error } = await opsAdmin.from('stamp_transactions').insert(ledger).select('customer_id');
        if (!error) {
          for (const r of (Array.isArray(data) ? data : []) as Array<{ customer_id: string }>) claimed.add(String(r.customer_id));
        } else {
          // idempotency_key is a PARTIAL unique index, which an upsert cannot
          // name, so a refused slice is retried one at a time.
          for (let i = 0; i < ledger.length; i++) {
            const { error: oneErr } = await opsAdmin.from('stamp_transactions').insert(ledger[i]);
            if (!oneErr) { claimed.add(String(ledger[i].customer_id)); continue; }
            if (!isDuplicate(oneErr)) failRow(progress, slice[i].rowNumber, 'We could not record the stamps. ' + oneErr.message);
          }
        }

        const payload = slice.filter((d) => claimed.has(String(d.customerId))).map((d) => {
          const plan = stampPlan(d.row, cards.get(String(d.customerId)) ?? null, required);
          return {
            customer_id: d.customerId,
            program_id: programId,
            company_id: companyId,
            stamps_collected: plan.stampsCollected,
            completed_count: plan.completedCount,
            last_stamp_at: now,
          };
        });
        if (!payload.length) continue;
        const { error: cardErr } = await platformAdmin.from('customer_stamp_cards')
          .upsert(payload, { onConflict: 'customer_id,program_id,company_id' });
        if (cardErr) {
          for (const d of slice.filter((x) => claimed.has(String(x.customerId)))) {
            failRow(progress, d.rowNumber, 'We recorded the stamps but could not put them on the card: ' + cardErr.message);
          }
        } else {
          progress.stamped += payload.length;
        }
      }
    }
  }

  // ── 6. the batch totals, so this run can be found again ───────────────────
  let batchTable = true;
  let totals = {
    row_count: progress.rows,
    created_count: progress.created,
    updated_count: progress.updated,
    skipped_count: progress.skipped,
  };
  if (batchTable) {
    const { data: batch, error } = await opsAdmin.from('import_batches')
      .select('row_count, created_count, updated_count, skipped_count')
      .eq('id', batchId).eq('org_id', orgId).maybeSingle();
    if (error && tableMissing(error)) {
      batchTable = false;
    } else if (batch) {
      totals = {
        row_count: (batch.row_count ?? 0) + progress.rows,
        created_count: (batch.created_count ?? 0) + progress.created,
        updated_count: (batch.updated_count ?? 0) + progress.updated,
        skipped_count: (batch.skipped_count ?? 0) + progress.skipped,
      };
      const { error: upErr } = await opsAdmin.from('import_batches')
        .update(totals).eq('id', batchId).eq('org_id', orgId);
      if (upErr && tableMissing(upErr)) batchTable = false;
      else if (upErr) runNote(progress, 'We could not update the record of this import: ' + upErr.message);
    } else {
      runNote(progress, 'We could not find the record of this import to add these numbers to.');
    }
  }

  return json({
    ok: true,
    batch_id: batchId,
    batch_tag: batchTag(batchId),
    batch_table: batchTable,
    chunk_index: Number(body?.chunk_index) || 0,
    chunk: chunkAnswer(progress),
    totals,
    counts,
  });
});
