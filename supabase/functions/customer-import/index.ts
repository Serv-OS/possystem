// supabase/functions/customer-import/index.ts
//
// Bring a loyalty customer list in from another system. Peter, 17 Sep 2026:
// "next week we start importing customer data for loyalty from other platforms,
// moving stamp cards and auto creating their accounts."
//
// Two actions, and only one of them writes.
//
//   preview  { action:'preview', ops_location_id, rows, today?, program_id? }
//            Says who is new, who we already have, who we refuse to touch, and
//            what the stamps would come to. Touches NOTHING.
//
//   import   { action:'import', ops_location_id, rows, batch_id, filename,
//              today, program_id, consent_text, privacy_version?, chunk_index }
//            Writes one slice. Up to 500 rows a call, so a 20,000 row file is
//            40 calls and the screen can show a bar. Every call answers with the
//            batch id, this chunk's numbers under `chunk`, and the running file
//            totals under `totals`.
//
// THOSE KEY NAMES ARE THE CONTRACT. The screen builds this body in exactly one
// place, src/lib/customerImportScreen.js importRequestBody, and
// src/lib/customerImportWiring.test.js holds what it posts against what this
// file reads, key for key, plus the function NAME against this directory. The
// first version of the screen posted to `customers-import` with `location_id`
// and `batch_key`, and every import 404ed while the screen said it was simply
// "not live yet".
//
// Where things land:
//   Ops       customers, customer_consents, stamp_transactions, import_batches
//   Platform  customer_loyalty, customer_stamp_cards
//
// All three Coffee Boy sites share one Ops org and one platform company
// (cd97f0f0-4807-4e45-801e-56114b22128a, confirmed live), so a customer
// imported once is a member at every site and there is nothing per site to do.
// An imported customer needs no password and no invite: they sign in to loyalty
// with their phone and a one time code (loyalty-otp). Their phone is the key.
//
// THE SIX RULES, all of them somebody's account:
//   1. Match on PHONE first, then email, under EVERY shape that phone could
//      already be on file in: what the app's own rule produces, the E.164 form
//      the first version of this importer wrote, and phone_raw. (org_id, phone)
//      is unique and the phone is the loyalty login.
//   2. Fill blanks only. An import never overwrites a name, email, phone,
//      birthday or note that is already there.
//   3. Never clear a yes. marketing_opt_in is only ever set true. A no in the
//      file is written to the customer_consents ledger, which marketing-send
//      reads FIRST, so the no stops the email without erasing the earlier yes.
//   4. AND NEVER UNDO A NO, which is rule 3's mirror. Somebody who unsubscribed
//      here after the file was exported is NOT re-consented by it: the flag is
//      left alone, the consent row is dated with the file's own opt in date so
//      it cannot jump their withdrawal, and the operator is told which rows.
//   5. Never double a stamp. Stamps are claimed by a UNIQUE idempotency key in
//      Ops stamp_transactions, and a customer who already carries any import
//      earn row for that programme is skipped, whatever batch it came from. We
//      SAY how many we skipped, so a corrected second export is not silently
//      thrown away.
//   6. Nothing off the wire is trusted to have been checked. Every posted row
//      is stripped back to the raw template cells before validateRows sees it.
//
// The decisions live in _shared/customerImportPlan.ts and the file reading in
// _shared/customerImport.ts, both pure and both under test. This file only
// talks to the two databases.
//
// Auth is the marketing-admin / wifi-admin shape: a staff bearer token with a
// user_locations row for the posted location, or super_admin, or the service
// role. org_id and company_id are resolved server side from the location and
// are never taken from the browser.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateRows, rawRowsOnly, problemRowNumbers } from '../_shared/customerImport.ts';
import type { ImportRow } from '../_shared/customerImport.ts';
import {
  MAX_ROWS_PER_CALL, READ_CHUNK, WRITE_CHUNK,
  batchTag, stampKey, STAMP_KEY_PREFIX,
  chunk, indexExisting, lookupKeys, decideRows, planCounts, needsProgramme,
  programmeCheck, buildInsert, buildPatch, groupPatches, buildConsent, consentIsNew,
  consentDecision, stampPlan, stampsOwed, stampsSkipped, alreadyStampedLine, emptyProgress,
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

// The customer columns the matcher needs, and no more. No import ever reads a
// column it is not going to compare against.
const CUSTOMER_COLS = 'id, name, first_name, last_name, phone, phone_raw, email, birthday, notes, source, sources, marketing_opt_in, marketing_opt_in_at';

// ── auth (marketing-admin/index.ts:26, same function in marketing-segments and
//    marketing-campaigns) ──────────────────────────────────────────────────────
async function authed(req: Request, opsLocationId: string): Promise<{ ok: boolean; userId: string | null }> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, userId: null };
  if (token === SERVICE_ROLE) return { ok: true, userId: null };
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return { ok: false, userId: null };
  const { data: ul } = await opsAdmin.from('user_locations')
    .select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return { ok: true, userId: user.id };
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  // Known gap: the admin portal trusts user_profiles.role, and migration
  // 20260915c adds the guard that stops an owner login re inserting itself as
  // super_admin. Same trust as every other admin function here.
  return { ok: prof?.role === 'super_admin', userId: user.id };
}

// A missing table answers 42P01 from Postgres, PGRST205 from PostgREST's schema
// cache. The importer works before the migration is applied: the people, their
// consent, their membership and their stamps all still land, and only the
// "recent imports" list is missing.
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

// ── existing customers for one slice ────────────────────────────────────────
async function readExisting(orgId: string, rows: ImportRow[]): Promise<ExistingCustomer[]> {
  const { phones, emails } = lookupKeys(rows);
  const found = new Map<string, ExistingCustomer>();

  const take = (list: unknown): void => {
    const arr = (Array.isArray(list) ? list : []) as ExistingCustomer[];
    for (let i = 0; i < arr.length; i++) if (arr[i]?.id) found.set(arr[i].id, arr[i]);
  };

  // Both columns, because the same person's number can be on file as what the
  // app's own rule produced (01614960000), as the E.164 form the first version
  // of this importer wrote (+441614960000), or as whatever they typed, which is
  // what phone_raw holds. lookupKeys hands over all of those shapes. Reading
  // only customers.phone in one shape is how the importer made a SECOND
  // customer out of somebody the till already had, with the stamps on the row
  // nobody can find.
  for (const slice of chunk(phones, READ_CHUNK)) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).in('phone', slice).is('deleted_at', null);
    take(data);
    const { data: rawData } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).in('phone_raw', slice).is('deleted_at', null);
    take(rawData);
  }
  // Emails are compared exactly. The unique index is on lower(email) and the
  // rules file lowercases every email it reads, and there is not one mixed case
  // email in the live table. If one ever turns up, the insert below trips the
  // unique index and falls back to a match and an update, so nobody is split in
  // two either way.
  for (const slice of chunk(emails, READ_CHUNK)) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).in('email', slice).is('deleted_at', null);
    take(data);
  }

  return Array.from(found.values());
}

// One customer, re read after a unique violation, so a row that raced (or an
// email stored in different case) becomes an update instead of a lost person.
async function reReadOne(orgId: string, row: ImportRow): Promise<ExistingCustomer | null> {
  if (row.phone) {
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).eq('phone', row.phone).is('deleted_at', null).maybeSingle();
    if (data) return data as ExistingCustomer;
  }
  if (row.phoneE164 && row.phoneE164 !== row.phone) {
    // The shape the first version of this importer wrote. Finding that row is
    // the difference between an update and a duplicate person.
    const { data } = await opsAdmin.from('customers').select(CUSTOMER_COLS)
      .eq('org_id', orgId).eq('phone', row.phoneE164).is('deleted_at', null).maybeSingle();
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
  const opsLocationId = String(body?.ops_location_id ?? '').trim();
  if (!action) return json({ error: 'action required' }, 400);
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);
  if (action !== 'preview' && action !== 'import') return json({ error: 'unknown action' }, 400);

  const auth = await authed(req, opsLocationId);
  if (!auth.ok) return json({ error: 'no access to this location' }, 403);

  // org_id and company_id come from the location, never from the browser.
  const { data: loc } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  const orgId = loc?.org_id ?? null;
  if (!orgId) return json({ error: 'That venue is not set up yet (no org).' }, 400);

  const { data: platformLoc } = await platformAdmin.from('locations')
    .select('company_id').eq('ops_location_id', opsLocationId).maybeSingle();
  const companyId = platformLoc?.company_id ?? null;
  if (!companyId) {
    return json({ error: 'That venue is not linked to a company yet. Re-provision it in Company Admin.' }, 400);
  }

  const rawRows = Array.isArray(body?.rows) ? (body.rows as unknown[]) : [];
  if (rawRows.length > MAX_ROWS_PER_CALL) {
    return json({ error: `Send up to ${MAX_ROWS_PER_CALL} rows at a time.`, max_rows: MAX_ROWS_PER_CALL }, 400);
  }

  // The venue's own day, passed in by the screen, so a date in the file is read
  // against the venue clock and not the server's.
  const today = body?.today ? String(body.today) : null;
  // EVERY row is stripped back to the raw cells of the template before it is
  // read. normaliseRow hands an already normalised row straight back, which is
  // what makes validateRows safe to run twice, and it is also a hole: any
  // signed in Back Office user of this venue could POST
  // { problems: [], phoneRaw: null, stamps: 100000, marketingOptIn: true } and
  // walk past validateRows, which is the ONLY guard this function has. Nothing
  // off the wire is trusted to have been checked already.
  const posted = rawRowsOnly(rawRows);
  const checked = validateRows(posted, { today });
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
  const decisions = decideRows(ready, indexExisting(existing));
  const counts = planCounts(decisions);

  // ── preview: nothing is written ───────────────────────────────────────────
  if (action === 'preview') {
    let batchTable = true;
    const { error: probe } = await opsAdmin.from('import_batches').select('id').limit(1);
    if (probe && tableMissing(probe)) batchTable = false;

    return json({
      ok: true,
      org_id: orgId,
      company_id: companyId,
      counts,
      programme: programVerdict,
      stamps_need_programme: needsProgramme(ready) && !programId,
      programme_name: program?.name ?? null,
      stamps_required: program?.stamps_required ?? null,
      verdicts: decisions.map((d) => ({ row_number: d.rowNumber, verdict: d.verdict, reason: d.reason, matched_on: d.matchedOn })),
      errors: checked.errors.map((e) => e.text),
      duplicates: checked.duplicatesInFile.map((d) => d.text),
      warnings: checked.warnings.map((w) => w.text),
      batch_table: batchTable,
      max_rows: MAX_ROWS_PER_CALL,
    });
  }

  // ── import: the only writing path ─────────────────────────────────────────

  // Nothing at all is written when the stamp card is wrong or missing. Coffee
  // Boy has a loyalty config and zero stamp card programmes today, so this is
  // the first thing a real file will hit, and inventing a programme would be
  // inventing what a free coffee costs.
  if (!programVerdict.ok) return json({ error: programVerdict.message, code: 'programme' }, 400);

  const consentText = String(body?.consent_text ?? '').trim();
  const anyAnswer = ready.some((r) => r.marketingOptIn != null);
  if (anyAnswer && !consentText) {
    return json({ error: 'Say where these people opted in before we write anything.', code: 'consent_text' }, 400);
  }
  const privacyVersion = body?.privacy_version ? String(body.privacy_version) : null;

  const now = new Date().toISOString();
  const batchId = String(body?.batch_id ?? '').trim() || crypto.randomUUID();
  const ctx = { orgId, batchId, now };
  const progress: Progress = emptyProgress();
  progress.rows = rawRows.length;
  // ROWS, not problems. validateRows pushes one entry per problem, so one row
  // with a bad date AND a negative stamp count used to report as 2 skipped and
  // the numbers never added up to the file.
  progress.skipped = problemRowNumbers(checked).length + checked.duplicatesInFile.length;
  for (const e of checked.errors) progress.errors.push(e.text);
  for (const d of checked.duplicatesInFile) progress.errors.push(d.text);

  // ── the batch row. Feature detected: without the migration everything else
  //    still works and only the list of past imports is missing. ─────────────
  let batchTable = true;
  if (!body?.batch_id) {
    const { error } = await opsAdmin.from('import_batches').insert({
      id: batchId,
      org_id: orgId,
      company_id: companyId,
      program_id: programId || null,
      filename: String(body?.filename ?? '').slice(0, 200) || null,
      row_count: 0,
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      created_by: auth.userId,
      notes: consentText ? consentText.slice(0, 500) : null,
    });
    if (error) {
      if (!tableMissing(error)) return json({ error: `Could not start the import: ${error.message}` }, 500);
      batchTable = false;
    }
  }

  // ── 0. who has already said stop ──────────────────────────────────────────
  //
  // A marketing_suppressions row is an unsubscribe click or a STOP text. It is
  // keyed by ADDRESS, not by customer id, so it still catches somebody whose
  // customer row is newer than their withdrawal, and it has to be read BEFORE
  // the first insert: a new row written with marketing_opt_in true is the same
  // wrong as an updated one. An older project may not have the table, which
  // must not stop an import.
  const suppressedAddresses = new Set<string>();
  const addressSet = new Set<string>();
  for (const r of ready) {
    for (const a of [r.email, r.phone, r.phoneE164, r.phoneLocal]) if (a) addressSet.add(String(a));
  }
  for (const slice of chunk(Array.from(addressSet), READ_CHUNK)) {
    const { data, error } = await opsAdmin.from('marketing_suppressions')
      .select('address').eq('org_id', orgId).in('address', slice);
    if (error) {
      if (!tableMissing(error)) progress.errors.push('We could not check who has unsubscribed: ' + error.message);
      break;
    }
    for (const s of (Array.isArray(data) ? data : []) as Array<{ address: string }>) suppressedAddresses.add(String(s.address));
  }
  const hasStopped = (d: Decision): boolean => {
    for (const a of [d.row.email, d.row.phone, d.row.phoneE164, d.row.phoneLocal]) {
      if (a && suppressedAddresses.has(String(a))) return true;
    }
    return false;
  };

  // ── 1. new people ─────────────────────────────────────────────────────────
  const newOnes = decisions.filter((d) => d.verdict === 'new');
  const blocked = decisions.filter((d) => d.verdict === 'blocked');
  for (const d of blocked) {
    progress.skipped++;
    progress.errors.push('Row ' + d.rowNumber + ': ' + d.reason);
  }

  // A decision that starts as new can end up an update, when the insert trips a
  // unique index. Those move into this list and are patched like any other.
  const asUpdate: Array<{ decision: Decision; existing: ExistingCustomer }> = [];

  for (const slice of chunk(newOnes, WRITE_CHUNK)) {
    const payload = slice.map((d) => buildInsert(d.row, ctx, { allowOptIn: !hasStopped(d) }));
    const { data, error } = await opsAdmin.from('customers').insert(payload).select('id, phone, email');
    if (!error) {
      // Each new id is matched back to its person by that person's OWN phone or
      // email, never by position in the answer. A row landing on the wrong id
      // would put one customer's stamps on another customer's card.
      const idByPhone = new Map<string, string>();
      const idByEmail = new Map<string, string>();
      for (const r of (Array.isArray(data) ? data : []) as Array<{ id: string; phone: string | null; email: string | null }>) {
        if (r.phone) idByPhone.set(String(r.phone), String(r.id));
        if (r.email) idByEmail.set(String(r.email).toLowerCase(), String(r.id));
      }
      for (const d of slice) {
        let id = (d.row.phone ? idByPhone.get(d.row.phone) : null) || (d.row.email ? idByEmail.get(d.row.email) : null) || null;
        // The write landed, so we never insert again. We read them back instead.
        if (!id) id = (await reReadOne(orgId, d.row))?.id ?? null;
        if (id) { d.customerId = String(id); progress.created++; continue; }
        progress.skipped++;
        progress.errors.push('Row ' + d.rowNumber + ': we added this person but could not read them back, so they have no card yet.');
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
      progress.skipped++;
      progress.errors.push('Row ' + d.rowNumber + ': we could not add this person. ' + String(oneErr?.message ?? 'Unknown problem.'));
    }
  }

  // Everybody this slice touched, new and old alike.
  const touched = decisions.filter((d) => d.verdict !== 'blocked' && d.customerId);
  const touchedIds = Array.from(new Set(touched.map((d) => String(d.customerId))));

  // ── 2. what these people have already said about marketing ───────────────
  //
  // Read BEFORE anything is patched. "Never clear a yes" only ever had half a
  // rule: nothing stopped a stale third party export RESTORING consent for
  // somebody who has unsubscribed here since it was written. marketing-send
  // takes the NEWEST customer_consents row, so a yes dated now beat their
  // withdrawal and the emails started again. See consentDecision.
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
  const withheldRows: number[] = [];
  for (const d of touched) {
    const verdict = consentDecision(d.row, {
      priorConsents: priorByCustomer.get(String(d.customerId)) ?? [],
      suppressed: hasStopped(d),
      now,
    });
    consentOf.set(d, verdict);
    if (verdict && verdict.withheld) withheldRows.push(d.rowNumber);
  }
  progress.consentWithheld = withheldRows.length;
  if (withheldRows.length) {
    const who = withheldRows.length === 1 ? '1 person' : withheldRows.length + ' people';
    progress.notes.push('We left marketing switched OFF for ' + who + ' who opted out here after this file was exported. Rows: ' + withheldRows.join(', ') + '.');
  }

  // ── 3. people we already have: blanks only ────────────────────────────────
  const byId = new Map<string, ExistingCustomer>();
  for (const c of existing) byId.set(c.id, c);

  const patches: Record<string, unknown>[] = [];
  for (const d of decisions) {
    if (d.verdict !== 'update' || !d.customerId) continue;
    const was = byId.get(d.customerId) ?? asUpdate.find((u) => u.decision === d)?.existing ?? null;
    if (!was) continue;
    const verdict = consentOf.get(d);
    const patch = buildPatch(d.row, was, ctx, { allowOptIn: !verdict || verdict.setFlag });
    // COUNTED ONLY WHEN THERE IS SOMETHING TO DO. A match whose patch came back
    // null is a person we looked at and left exactly as they were, and calling
    // that "filled in" told the operator we had changed rows we had not.
    if (!patch) continue;
    patches.push(patch);
    progress.updated++;
  }

  for (const group of groupPatches(patches)) {
    for (const slice of chunk(group, WRITE_CHUNK)) {
      // Every patch carries `name` (see buildPatch), because an upsert on
      // conflict id is still an INSERT to Postgres and ExecConstraints runs on
      // the proposed tuple BEFORE the conflict is resolved: a patch without a
      // name raised 23502 on EVERY group and this silently fell through to one
      // request per customer for the whole file. If it still refuses, the
      // reason is said out loud and only then do we go row by row.
      const { error } = await opsAdmin.from('customers').upsert(slice, { onConflict: 'id' });
      if (!error) continue;
      progress.errors.push('We had to update ' + slice.length + ' of these people one at a time: ' + String(error.message ?? 'unknown problem') + '.');
      for (const one of slice) {
        const id = String(one.id);
        const { id: _drop, org_id: _org, ...fields } = one as Record<string, unknown> & { id: unknown; org_id: unknown };
        const { error: oneErr } = await opsAdmin.from('customers').update(fields).eq('id', id).eq('org_id', orgId);
        if (oneErr) progress.errors.push('We could not update one of the people we already had: ' + oneErr.message);
      }
    }
  }

  // ── consent, a yes AND a no ───────────────────────────────────────────────
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
        // The FILE's own opt in date, never now, so a yes out of a stale export
        // can never jump the queue in front of a later withdrawal.
        createdAt: verdict.createdAt,
      });
      if (consent && consentIsNew(consent, priorAll)) rows.push(consent);
    }
    for (const slice of chunk(rows, WRITE_CHUNK)) {
      const { error } = await opsAdmin.from('customer_consents').insert(slice);
      if (error) progress.errors.push('We could not write the opt in record for some of these people: ' + error.message);
    }
  }

  // ── 4. loyalty membership on the platform ─────────────────────────────────
  // ensureMembership is the idempotent per customer path and is right for one
  // sign up; twenty thousand of them is twenty thousand round trips, so this
  // reads in bulk and writes in bulk, using the SAME member code generator so a
  // card imported tonight looks exactly like one made at the till.
  if (touchedIds.length) {
    const config = await getOrCreateConfig(companyId);
    // An import is not a new sign up: nobody joining by spreadsheet should be
    // handed a joining bonus they never earned. Coffee Boy's is 0 anyway.
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
        // member_code and referral_code are both UNIQUE. A collision is one in
        // a billion per row, and the answer is simply fresh codes.
        if (!isDuplicate(error)) { progress.errors.push('We could not set up loyalty for some of these people: ' + error.message); landed = true; break; }
      }
      if (!landed) progress.errors.push('We could not set up loyalty for ' + slice.length + ' people. Run the import again and it will pick them up.');
    }
    if (config && config.enabled === false) {
      progress.errors.push('Loyalty is switched off for this company, so nobody can use their card yet. Turn it on in Loyalty.');
    }
  }

  // ── 5. stamps ─────────────────────────────────────────────────────────────
  if (programId && program) {
    const required = Number(program.stamps_required) || 1;

    // Anybody an import has EVER stamped for this programme, from any batch.
    // Prefix and not this batch's key on purpose: uploading the same file again
    // under a fresh batch id is the obvious human mistake, and it is the one
    // that would hand out free coffee twice.
    const stamped = new Set<string>();
    for (const slice of chunk(touchedIds, READ_CHUNK)) {
      const { data } = await opsAdmin.from('stamp_transactions')
        .select('customer_id').eq('program_id', programId).eq('type', 'earn')
        .like('idempotency_key', STAMP_KEY_PREFIX + '%').in('customer_id', slice);
      for (const t of (Array.isArray(data) ? data : []) as Array<{ customer_id: string }>) stamped.add(String(t.customer_id));
    }

    // The guard above stays. What was missing was saying so: a second,
    // CORRECTED export is the other obvious human move, and silently dropping
    // every stamp for everybody already imported, then reporting success, left
    // the operator believing their fix had landed.
    const leftAlone = stampsSkipped(decisions, stamped);
    progress.alreadyStamped = leftAlone.length;
    const line = alreadyStampedLine(leftAlone.length);
    if (line) progress.notes.push(line);

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
        // customer is short and we say so out loud, which is recoverable. The
        // other order loses the claim and a re run doubles the balance, which is
        // free coffee we cannot take back.
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
          // stamp_transactions.idempotency_key is a PARTIAL unique index, which
          // an upsert cannot name, so a refused slice is retried one at a time
          // and a row that is already claimed is simply left alone.
          for (let i = 0; i < ledger.length; i++) {
            const { error: oneErr } = await opsAdmin.from('stamp_transactions').insert(ledger[i]);
            if (!oneErr) { claimed.add(String(ledger[i].customer_id)); continue; }
            if (!isDuplicate(oneErr)) {
              progress.errors.push('Row ' + slice[i].rowNumber + ': we could not record the stamps. ' + oneErr.message);
            }
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
          progress.errors.push('We recorded the stamps but could not put them on ' + payload.length + ' cards: ' + cardErr.message);
        } else {
          progress.stamped += payload.length;
        }
      }
    }
  }

  // ── 6. the batch row, so this run can be found again ──────────────────────
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
    }
  }

  return json({
    ok: true,
    batch_id: batchId,
    batch_tag: batchTag(batchId),
    batch_table: batchTable,
    chunk_index: Number(body?.chunk_index) || 0,
    chunk: {
      rows: progress.rows,
      created: progress.created,
      updated: progress.updated,
      skipped: progress.skipped,
      stamped: progress.stamped,
      enrolled: progress.enrolled,
      already_stamped: progress.alreadyStamped,
      consent_withheld: progress.consentWithheld,
      errors: progress.errors,
      notes: progress.notes,
    },
    totals,
    counts,
  });
});
