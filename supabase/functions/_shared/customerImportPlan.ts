// supabase/functions/_shared/customerImportPlan.ts
//
// What the importer DECIDES, with no database and no clock of its own.
//
// customerImport.ts reads the file (phones, dates, yes or no, duplicates).
// This file is the next step: given the rows it accepted and the people the
// venue already has, it decides who is new, who is an update, who we refuse to
// touch, exactly which columns each update may change, and what a stamp balance
// becomes. index.ts does the talking to Supabase and nothing else.
//
// It is pure on purpose. Every rule below is a rule about somebody's loyalty
// account, so it has to be testable without a database:
//
//   - MATCH ON PHONE FIRST, then email. The phone is the customer's loyalty
//     login (loyalty-otp) and the key every till searches by, and
//     (org_id, phone) is unique. Same order as hubrise-ingest and wifi-capture.
//   - FILL BLANKS ONLY on a match. An import from another system never
//     overwrites a name, email, phone, birthday or note that is already there.
//   - NEVER CLEAR A YES. marketing_opt_in is only ever set to true, never to
//     false. A "no" in the file is recorded in the customer_consents ledger,
//     which is what marketing-send reads first, so the no still stops the email
//     without destroying the record of the earlier yes.
//   - NEVER DOUBLE A STAMP. Stamps are claimed by an idempotency key in Ops
//     stamp_transactions, which is UNIQUE. A customer who already carries ANY
//     import earn row for that programme is skipped, so running the same file
//     twice, or under a new batch id, cannot hand out free coffee twice.
//
// Verified live (read only, 17 Sep 2026) rather than assumed:
//   Ops customers      org_id NOT NULL, name NOT NULL no default, sources
//                      text[] NOT NULL default {}, tags text[] nullable.
//                      UNIQUE (org_id, phone) and UNIQUE (org_id, lower(email)),
//                      both where deleted_at is null.
//   Ops stamp_transactions  UNIQUE idempotency_key where not null; location_id
//                      NOT NULL.
//   Platform customer_loyalty       UNIQUE (customer_id, company_id), UNIQUE
//                      member_code, UNIQUE referral_code.
//   Platform customer_stamp_cards   UNIQUE (customer_id, program_id, company_id).

import { normalisePhoneUk, normaliseEmail, phoneKeys } from './customerImport.ts';
import type { ImportRow } from './customerImport.ts';

// ── sizes ───────────────────────────────────────────────────────────────────

/** Rows one call may carry. The screen sends a 20,000 row file in slices. */
export const MAX_ROWS_PER_CALL = 500;

/** Ids per `.in(...)` read. Keeps the PostgREST URL short. */
export const READ_CHUNK = 100;

/** Rows per write. Small enough that one refused row is a small retry. */
export const WRITE_CHUNK = 100;

// ── shapes ──────────────────────────────────────────────────────────────────

export interface ExistingCustomer {
  id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  phone_raw?: string | null;
  email?: string | null;
  birthday?: string | null;
  notes?: string | null;
  source?: string | null;
  sources?: string[] | null;
  marketing_opt_in?: boolean | null;
  marketing_opt_in_at?: string | null;
}

export interface ExistingIndex {
  byPhone: Map<string, ExistingCustomer>;
  byEmail: Map<string, ExistingCustomer>;
}

export type Verdict = 'new' | 'update' | 'blocked';

export interface Decision {
  rowNumber: number;
  verdict: Verdict;
  /** Short and plain. Empty on a straightforward new row. */
  reason: string;
  /** The customer we matched, when we matched one. */
  customerId: string | null;
  matchedOn: 'phone' | 'email' | '';
  row: ImportRow;
}

export interface PlanCounts {
  total: number;
  newCustomers: number;
  updates: number;
  blocked: number;
  withStamps: number;
  stampsTotal: number;
  rewardsTotal: number;
}

export interface WriteCtx {
  orgId: string;
  batchId: string;
  /** ISO timestamp. Passed in, never read off the clock in here. */
  now: string;
}

export interface StampCard {
  id?: string | null;
  stamps_collected?: number | null;
  completed_count?: number | null;
}

export interface StampPlan {
  stampsCollected: number;
  completedCount: number;
  stampsAdded: number;
  rewardsAdded: number;
}

export interface ProgrammeVerdict {
  ok: boolean;
  message: string;
}

// ── batch tags ──────────────────────────────────────────────────────────────

/**
 * The tag every customer from one run carries, appended to `sources`.
 *
 * `sources` and not `tags`, for three reasons. `sources` is the append only
 * channel list every other writer already appends to (hubrise-ingest,
 * wifi-capture), it is NOT NULL default {} so there is no null to trip over,
 * and `source` is already a marketing segment field, so `source = import` is a
 * ready made audience with nothing new to whitelist. `tags` is written by
 * nothing in this repo and is nullable, so using it would be inventing a
 * convention nobody else follows.
 */
export function batchTag(batchId: unknown): string {
  const id = String(batchId ?? '').trim();
  return id ? 'import:' + id : '';
}

/** The first channel that ever saw them, when nothing else has. */
export const IMPORT_SOURCE = 'import';

/** Everything an import has ever stamped starts with this. */
export const STAMP_KEY_PREFIX = 'import:';

/**
 * The key that claims one customer's stamps for one programme.
 *
 * stamp_transactions.idempotency_key is UNIQUE, so this is the thing that
 * stops a second run doubling a balance.
 */
export function stampKey(batchId: unknown, customerId: unknown, programId: unknown): string {
  return 'import:' + String(batchId ?? '') + ':' + String(customerId ?? '') + ':' + String(programId ?? '');
}

// ── small helpers ───────────────────────────────────────────────────────────

function text(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function blank(value: unknown): boolean {
  return text(value) === '';
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Break a list into slices. An empty or silly size gives one slice. */
export function chunk<T>(list: T[], size: number): T[][] {
  const src = Array.isArray(list) ? list : [];
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : src.length || 1;
  const out: T[][] = [];
  for (let i = 0; i < src.length; i += step) out.push(src.slice(i, i + step));
  return out;
}

// ── who do we already have ──────────────────────────────────────────────────

/**
 * The venue's existing customers, keyed the way the file will be read, so a
 * phone typed four different ways still finds the one person.
 *
 * The FIRST row wins on a clash, which cannot happen in practice because both
 * keys are unique indexes on the live table, but a soft deleted row read in by
 * mistake should never displace a live one.
 */
export function indexExisting(rows: unknown): ExistingIndex {
  const byPhone = new Map<string, ExistingCustomer>();
  const byEmail = new Map<string, ExistingCustomer>();
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as ExistingCustomer;
    if (!c || typeof c !== 'object' || !c.id) continue;
    // One person, every shape their number could be on file in: what the app's
    // own rule produces (01614960000), the E.164 form an older run of this
    // importer wrote (+441614960000), and phone_raw, which is whatever they
    // typed. Index them ALL, or the same person is imported a second time with
    // the stamps on the row the till cannot find.
    const forms = phoneKeys(c.phone).concat(phoneKeys(c.phone_raw));
    for (let j = 0; j < forms.length; j++) if (!byPhone.has(forms[j])) byPhone.set(forms[j], c);
    const e = normaliseEmail(c.email);
    if (e.email && !byEmail.has(e.email)) byEmail.set(e.email, c);
  }
  return { byPhone, byEmail };
}

function asIndex(existing: unknown): ExistingIndex {
  const maybe = existing as ExistingIndex | null;
  if (maybe && maybe.byPhone instanceof Map && maybe.byEmail instanceof Map) return maybe;
  return indexExisting(existing);
}

/**
 * The phones and emails a chunk needs to look up, deduped.
 *
 * EVERY shape of each phone, not just the one we would write. The customer we
 * are looking for may be on file under the app's shape, under the E.164 form an
 * older run of this importer wrote, or under what they typed in phone_raw, and
 * index.ts asks the database for all of them against both phone and phone_raw.
 */
export function lookupKeys(rows: unknown): { phones: string[]; emails: string[] } {
  const phones = new Set<string>();
  const emails = new Set<string>();
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] as ImportRow;
    if (!r || typeof r !== 'object') continue;
    const forms = phoneKeys(r.phone).concat(phoneKeys(r.phoneRaw));
    for (let j = 0; j < forms.length; j++) phones.add(forms[j]);
    const e = normaliseEmail(r.email);
    if (e.email) emails.add(e.email);
  }
  return { phones: Array.from(phones), emails: Array.from(emails) };
}

// ── the verdict on each row ─────────────────────────────────────────────────

/**
 * New, update, or leave alone, one per row, in file order.
 *
 * Phone first, then email, the same order as every other writer. The one row we
 * refuse is a row with a phone we have never seen whose EMAIL already belongs to
 * somebody with a different phone: writing it would either fail on the unique
 * email index or quietly staple two different people together, and an operator
 * can fix a named row in a minute.
 *
 * Rows already decided (an array of Decisions) are passed straight back, so
 * running this on its own output changes nothing.
 */
export function decideRows(rows: unknown, existing: unknown): Decision[] {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const index = asIndex(existing);
  const out: Decision[] = [];

  for (let i = 0; i < list.length; i++) {
    const maybe = list[i] as Decision;
    if (maybe && typeof maybe === 'object' && 'verdict' in maybe && maybe.row) {
      out.push(maybe);
      continue;
    }
    const row = list[i] as ImportRow;
    if (!row || typeof row !== 'object') continue;
    const rowNumber = typeof row.rowNumber === 'number' ? row.rowNumber : i + 2;

    const phone = normalisePhoneUk(row.phone);
    const email = normaliseEmail(row.email).email;

    // Every shape this cell could already be filed under, so one person is
    // never imported twice under two spellings of one number.
    const forms = phoneKeys(row.phone).concat(phoneKeys(row.phoneRaw));
    let byPhone: ExistingCustomer | undefined;
    for (let j = 0; j < forms.length && !byPhone; j++) byPhone = index.byPhone.get(forms[j]);
    if (byPhone) {
      out.push({ rowNumber, verdict: 'update', reason: '', customerId: byPhone.id, matchedOn: 'phone', row });
      continue;
    }

    const byEmail = email ? index.byEmail.get(email) : undefined;
    if (byEmail) {
      const theirForms = phoneKeys(byEmail.phone).concat(phoneKeys(byEmail.phone_raw));
      const sameNumber = forms.some((f) => theirForms.indexOf(f) >= 0);
      const theirPhone = normalisePhoneUk(byEmail.phone);
      if (phone && theirPhone && !sameNumber) {
        out.push({
          rowNumber,
          verdict: 'blocked',
          reason: 'That email already belongs to somebody else here. We left both alone.',
          customerId: byEmail.id,
          matchedOn: 'email',
          row,
        });
        continue;
      }
      out.push({ rowNumber, verdict: 'update', reason: '', customerId: byEmail.id, matchedOn: 'email', row });
      continue;
    }

    out.push({ rowNumber, verdict: 'new', reason: '', customerId: null, matchedOn: '', row });
  }

  return out;
}

/** The numbers the screen shows before anybody presses Import. */
export function planCounts(decisions: unknown): PlanCounts {
  const list: Decision[] = Array.isArray(decisions) ? (decisions as Decision[]) : [];
  const counts: PlanCounts = {
    total: list.length,
    newCustomers: 0,
    updates: 0,
    blocked: 0,
    withStamps: 0,
    stampsTotal: 0,
    rewardsTotal: 0,
  };
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || !d.row) continue;
    if (d.verdict === 'new') counts.newCustomers++;
    else if (d.verdict === 'update') counts.updates++;
    else counts.blocked++;
    if (d.verdict === 'blocked') continue;
    const stamps = Number(d.row.stamps) || 0;
    const rewards = Number(d.row.rewardsUnused) || 0;
    if (stamps > 0 || rewards > 0) counts.withStamps++;
    counts.stampsTotal += stamps;
    counts.rewardsTotal += rewards;
  }
  return counts;
}

/** True when anything in this file needs a stamp card to land on. */
export function needsProgramme(rows: unknown): boolean {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] as Decision;
    const row = (item && typeof item === 'object' && 'verdict' in item ? item.row : item) as ImportRow;
    if (!row || typeof row !== 'object') continue;
    if ((Number(row.stamps) || 0) > 0 || (Number(row.rewardsUnused) || 0) > 0) return true;
  }
  return false;
}

// ── the stamp card has to exist first ───────────────────────────────────────

/**
 * Whether this run may go ahead, in words the operator can act on.
 *
 * Coffee Boy has a loyalty config and ZERO stamp card programmes today
 * (confirmed live), so this is the first thing a real import will hit. We do not
 * invent a programme: the number of stamps a free coffee costs is the operator's
 * decision, and guessing it wrong is money.
 */
export function programmeCheck(args: {
  rows?: unknown;
  programId?: unknown;
  program?: { id?: string; company_id?: string; stamps_required?: number | null; active?: boolean | null } | null;
  companyId?: unknown;
}): ProgrammeVerdict {
  const wanted = text(args?.programId);
  const program = args?.program ?? null;
  const companyId = text(args?.companyId);
  const stampsInFile = needsProgramme(args?.rows);

  if (!wanted) {
    if (stampsInFile) {
      return { ok: false, message: 'These people have stamps. Make a stamp card in Loyalty first, then import again.' };
    }
    return { ok: true, message: '' };
  }
  if (!program || !program.id) {
    return { ok: false, message: 'We cannot find that stamp card. Pick it again.' };
  }
  if (companyId && text(program.company_id) !== companyId) {
    return { ok: false, message: 'That stamp card belongs to a different company. Pick it again.' };
  }
  const required = Number(program.stamps_required);
  if (!Number.isFinite(required) || required < 1) {
    return { ok: false, message: 'That stamp card has no stamps set on it. Fix it in Loyalty first.' };
  }
  return { ok: true, message: '' };
}

// ── what we write ───────────────────────────────────────────────────────────

/**
 * A brand new customer row.
 *
 * `name` is never null: customers.name is NOT NULL with no default, and a null
 * there is refused silently, which broke every loyalty sign up on 17 Sep. The
 * rules file already guarantees a name, and this belt goes over that brace.
 */
export function buildInsert(row: ImportRow, ctx: WriteCtx, opts?: { allowOptIn?: boolean }): Record<string, unknown> {
  const tag = batchTag(ctx?.batchId);
  const sources = [IMPORT_SOURCE];
  if (tag) sources.push(tag);
  // A brand new customer row is still somebody who may have pressed unsubscribe
  // at this venue before. `allowOptIn` is false when their email or their phone
  // is on the suppression list.
  const allowOptIn = !opts || opts.allowOptIn !== false;
  const saidYes = allowOptIn && row?.marketingOptIn === true;
  return {
    org_id: ctx?.orgId ?? null,
    name: text(row?.name) || 'Customer',
    first_name: text(row?.firstName) || null,
    last_name: text(row?.lastName) || null,
    phone: row?.phone || null,
    phone_raw: text(row?.phoneRaw) || null,
    email: row?.email || null,
    birthday: row?.birthday || null,
    notes: text(row?.notes) || null,
    source: IMPORT_SOURCE,
    sources,
    marketing_opt_in: saidYes,
    marketing_opt_in_at: saidYes ? (row?.optInDate ? row.optInDate : ctx?.now ?? null) : null,
  };
}

/**
 * The columns one matched customer may change, and no others.
 *
 * Blanks only. If they already have a name we keep their name, if they already
 * have an email we keep their email. The only column that always moves is
 * `sources`, which gains this batch's tag so the run can be found again.
 *
 * Returns null when there is genuinely nothing to do, which is what a second
 * run of the same file under the same batch id looks like.
 *
 * `opts.allowOptIn` is false for somebody who has WITHDRAWN their consent here
 * since the file was exported. See consentDecision: a stale third party file
 * must not re-consent a person who has since said stop.
 *
 * EVERY patch that goes out carries `name`, even when the name is not the thing
 * we are changing. customers.name is NOT NULL with no default, and a bulk
 * upsert on conflict id is still an INSERT to Postgres: ExecConstraints runs on
 * the proposed tuple BEFORE the conflict is resolved, so a patch with no name
 * raises 23502 every single time and the whole bulk write is refused. The
 * filler is the name the customer ALREADY has, read back unchanged, so this is
 * not the padding that quietly overwrites what somebody typed at the till.
 */
export function buildPatch(
  row: ImportRow,
  existing: ExistingCustomer,
  ctx: WriteCtx,
  opts?: { allowOptIn?: boolean },
): Record<string, unknown> | null {
  if (!existing || !existing.id) return null;
  const patch: Record<string, unknown> = {};
  const allowOptIn = !opts || opts.allowOptIn !== false;

  if (blank(existing.name) && !blank(row?.name)) patch.name = text(row.name);
  if (blank(existing.first_name) && !blank(row?.firstName)) patch.first_name = text(row.firstName);
  if (blank(existing.last_name) && !blank(row?.lastName)) patch.last_name = text(row.lastName);
  if (blank(existing.email) && row?.email) patch.email = row.email;
  if (blank(existing.phone) && row?.phone) {
    patch.phone = row.phone;
    patch.phone_raw = text(row.phoneRaw) || row.phone;
  }
  if (blank(existing.birthday) && row?.birthday) patch.birthday = row.birthday;
  if (blank(existing.notes) && !blank(row?.notes)) patch.notes = text(row.notes);
  if (blank(existing.source)) patch.source = IMPORT_SOURCE;

  const sources = listOf(existing.sources);
  const tag = batchTag(ctx?.batchId);
  const wanted: string[] = [];
  if (sources.indexOf(IMPORT_SOURCE) < 0) wanted.push(IMPORT_SOURCE);
  if (tag && sources.indexOf(tag) < 0) wanted.push(tag);
  if (wanted.length) patch.sources = sources.concat(wanted);

  // Only ever true. A no in the file goes to the consent ledger, which
  // marketing-send reads first, and never wipes an earlier yes off the record.
  if (allowOptIn && row?.marketingOptIn === true && existing.marketing_opt_in !== true) {
    patch.marketing_opt_in = true;
    patch.marketing_opt_in_at = row?.optInDate ? row.optInDate : (ctx?.now ?? null);
  }

  if (!Object.keys(patch).length) return null;
  if (patch.name === undefined) patch.name = text(existing.name) || text(row?.name) || 'Customer';
  patch.id = existing.id;
  patch.org_id = ctx?.orgId ?? null;
  patch.updated_at = ctx?.now ?? null;
  return patch;
}

/**
 * Patches sorted into groups that share the same columns.
 *
 * PostgREST needs every object in one bulk write to carry the same keys, and we
 * refuse to pad the others with the values we are NOT changing, because padding
 * is how an import quietly overwrites a name somebody typed at the till. So the
 * patches are grouped by their shape instead, and each group is one write. In a
 * real file that is a handful of writes per chunk.
 */
export function groupPatches(patches: unknown): Array<Record<string, unknown>[]> {
  const list: Record<string, unknown>[] = Array.isArray(patches) ? (patches as Record<string, unknown>[]) : [];
  const groups = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== 'object') continue;
    const sig = Object.keys(p).sort().join('|');
    if (!groups.has(sig)) { groups.set(sig, []); order.push(sig); }
    (groups.get(sig) as Record<string, unknown>[]).push(p);
  }
  return order.map((sig) => groups.get(sig) as Record<string, unknown>[]);
}

/**
 * One consent row, for a yes AND for a no.
 *
 * customer_consents is the append only ledger and is the real record of
 * permission; marketing_opt_in on the customer is the older flag.
 * marketing-send reads the ledger first and only falls back to the flag, so a
 * no here is what actually stops the email.
 *
 * `location_id` is text NOT NULL on this table (confirmed live), and carries the
 * ops location the operator was signed into when they ran the import.
 */
export function buildConsent(row: ImportRow, args: {
  customerId: string;
  orgId: string;
  companyId?: string | null;
  locationId: string;
  consentText: string;
  privacyVersion?: string | null;
  now: string;
  /** When the consent happened. Defaults to now; see consentDecision. */
  createdAt?: string | null;
}): Record<string, unknown> | null {
  if (!args?.customerId) return null;
  if (row?.marketingOptIn == null) return null; // nobody said. A blank column is not a yes and not a no.
  return {
    customer_id: args.customerId,
    org_id: args.orgId ?? null,
    location_id: String(args.locationId ?? ''),
    company_id: args.companyId ?? null,
    channel: 'both',
    purpose: 'marketing',
    consented: row.marketingOptIn === true,
    source: IMPORT_SOURCE,
    method: 'imported_optin',
    consent_text: text(args.consentText) || null,
    privacy_version: args.privacyVersion ?? null,
    created_at: args.createdAt || args.now || null,
  };
}

// ── the mirror of "never clear a yes" ───────────────────────────────────────

export interface ConsentVerdict {
  /** Write a customer_consents row at all. */
  write: boolean;
  /** What that row says. */
  consented: boolean;
  /** created_at for it: the FILE's opt in date when the file gave one. */
  createdAt: string;
  /** Turn customers.marketing_opt_in on. Never true for a withheld yes. */
  setFlag: boolean;
  /** We held the yes back because they have since said stop. */
  withheld: boolean;
  /** Short plain words for the operator, empty unless withheld. */
  reason: string;
}

/**
 * NEVER CLEAR A YES has to have a mirror, or it is only half a rule.
 *
 * "Never clear a yes" stops an import erasing consent. Nothing stopped an
 * import RESTORING it. Somebody who unsubscribed at this venue (marketing_opt_in
 * false plus a customer_consents row saying consented false, or a
 * marketing_suppressions row) was re-consented the moment a stale third party
 * export was loaded: buildPatch set the flag back to true and index.ts wrote a
 * consent row dated NOW, which is newer than their withdrawal, and
 * marketing-send's hasConsent takes the NEWEST row. The person who pressed
 * unsubscribe starts getting the emails again, which is the venue's fine, not
 * ours.
 *
 * So before a yes is written:
 *  - a marketing_suppressions row, or a consent row saying no that is NEWER
 *    than the file's own opt in date, holds the yes back. The flag is left
 *    alone and the operator is told, by name, which rows we would not re-consent
 *  - the consent row we do write is dated with the FILE's opt in date, not with
 *    now, so it can never jump the queue in front of a later withdrawal
 *  - a file that gives no date at all (5Loyalty export none) cannot prove it is
 *    newer than anything, so a withdrawal always wins, and no row is written
 *    for it, because the only date we could put on it is now
 *
 * A NO in the file is never held back. A no is always recorded.
 */
export function consentDecision(row: ImportRow, args: {
  priorConsents?: unknown;
  suppressed?: boolean;
  now: string;
}): ConsentVerdict | null {
  const answer = row?.marketingOptIn;
  if (answer == null) return null;
  const now = text(args?.now);

  // A yes carries a date only when the old system gave us one. 5Loyalty do not
  // expose opt_in_date at all, so the sign up date is the next best truth.
  const fileDay = text(row?.optInDate) || text(row?.signedUpDate);
  const fileAt = fileDay ? fileDay.slice(0, 10) + 'T00:00:00.000Z' : '';

  if (answer === false) {
    return { write: true, consented: false, createdAt: fileAt || now, setFlag: false, withheld: false, reason: '' };
  }

  // The newest NO on file for this person, whoever wrote it.
  let newestNo = '';
  const list: unknown[] = Array.isArray(args?.priorConsents) ? (args.priorConsents as unknown[]) : [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as { consented?: unknown; created_at?: unknown; purpose?: unknown };
    if (!c || typeof c !== 'object') continue;
    if (c.consented === true) continue;
    const at = text(c.created_at);
    if (at > newestNo) newestNo = at;
  }

  const suppressed = args?.suppressed === true;
  const staleYes = !!newestNo && (!fileAt || fileAt <= newestNo);
  if (suppressed || staleYes) {
    return {
      write: !!fileAt,       // dated with the file's own day, so it cannot jump the withdrawal
      consented: true,
      createdAt: fileAt || now,
      setFlag: false,
      withheld: true,
      reason: 'They opted out here after this file was exported, so we left them opted out.',
    };
  }

  return { write: true, consented: true, createdAt: fileAt || now, setFlag: true, withheld: false, reason: '' };
}

/**
 * The consent rows this run still owes, once the ones already on file are out.
 *
 * A consent ledger is append only, so we never delete one. But running the same
 * file twice should not fill the ledger with the same sentence twice, so an
 * imported consent that already says the same thing, for the same person, in
 * the same words, is left alone.
 */
export function consentIsNew(candidate: Record<string, unknown>, already: unknown): boolean {
  const list: unknown[] = Array.isArray(already) ? already : [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i] as Record<string, unknown>;
    if (!row || typeof row !== 'object') continue;
    if (String(row.customer_id ?? '') !== String(candidate.customer_id ?? '')) continue;
    if (String(row.source ?? '') !== IMPORT_SOURCE) continue;
    if ((row.consented === true) !== (candidate.consented === true)) continue;
    if (text(row.consent_text) !== text(candidate.consent_text)) continue;
    return false;
  }
  return true;
}

// ── stamps ──────────────────────────────────────────────────────────────────

/**
 * What a stamp card becomes when this row's numbers are added to it.
 *
 * ADDED, never assigned. A customer who earned two stamps at the till between
 * the export and the import keeps those two. Same rollover maths as
 * loyalty-earn: while the pile reaches a full card, take a card off the pile and
 * count a reward.
 *
 *  - `stamps`         progress toward the next free one
 *  - `rewardsUnused`  free ones they have earned and not had yet, which is
 *                     completed_count. What they are still owed is
 *                     completed_count minus their redeem rows, which is the
 *                     rule loyalty-balance and loyalty-redeem already use.
 */
export function stampPlan(row: ImportRow, card: StampCard | null, stampsRequired: unknown): StampPlan {
  const required = Math.max(1, Math.floor(Number(stampsRequired) || 1));
  const haveStamps = Math.max(0, Math.floor(Number(card?.stamps_collected) || 0));
  const haveRewards = Math.max(0, Math.floor(Number(card?.completed_count) || 0));
  const addStamps = Math.max(0, Math.floor(Number(row?.stamps) || 0));
  const addRewards = Math.max(0, Math.floor(Number(row?.rewardsUnused) || 0));

  let stamps = haveStamps + addStamps;
  let rewards = haveRewards + addRewards;
  while (stamps >= required) {
    stamps -= required;
    rewards += 1;
  }

  return {
    stampsCollected: stamps,
    completedCount: rewards,
    stampsAdded: addStamps,
    rewardsAdded: addRewards,
  };
}

/**
 * Who in this chunk still needs their stamps, once the ones an import has
 * already stamped are taken out.
 *
 * `alreadyStamped` is the set of customer ids that carry ANY `import:` earn row
 * for this programme, from ANY batch. Matching on the prefix and not on this
 * batch's key is deliberate: re-uploading the same file under a fresh batch id
 * is the obvious human mistake, and it is the one that would double a balance.
 */
export function stampsOwed(decisions: unknown, alreadyStamped: unknown): Decision[] {
  const list: Decision[] = Array.isArray(decisions) ? (decisions as Decision[]) : [];
  const done: Set<string> = alreadyStamped instanceof Set
    ? (alreadyStamped as Set<string>)
    : new Set((Array.isArray(alreadyStamped) ? alreadyStamped : []).map((v) => String(v)));
  const out: Decision[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || !d.row || d.verdict === 'blocked' || !d.customerId) continue;
    const stamps = Number(d.row.stamps) || 0;
    const rewards = Number(d.row.rewardsUnused) || 0;
    if (stamps <= 0 && rewards <= 0) continue;
    if (done.has(String(d.customerId))) continue;
    out.push(d);
  }
  return out;
}

/**
 * The other half of stampsOwed: the people whose stamps we did NOT give,
 * because an import has already stamped them for this programme.
 *
 * The guard is right and it stays. What was wrong was the silence. A second,
 * CORRECTED export is the other obvious human move, and the first version of
 * this dropped every stamp for everybody already imported and reported the run
 * as a success, so the operator had no way of knowing their fix had not landed.
 * Now we hand the ids back and the screen says so out loud next to the stamp
 * tile.
 */
export function stampsSkipped(decisions: unknown, alreadyStamped: unknown): Decision[] {
  const list: Decision[] = Array.isArray(decisions) ? (decisions as Decision[]) : [];
  const done: Set<string> = alreadyStamped instanceof Set
    ? (alreadyStamped as Set<string>)
    : new Set((Array.isArray(alreadyStamped) ? alreadyStamped : []).map((v) => String(v)));
  const out: Decision[] = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (!d || !d.row || d.verdict === 'blocked' || !d.customerId) continue;
    const stamps = Number(d.row.stamps) || 0;
    const rewards = Number(d.row.rewardsUnused) || 0;
    if (stamps <= 0 && rewards <= 0) continue;
    if (!done.has(String(d.customerId))) continue;
    out.push(d);
  }
  return out;
}

/** The line the operator reads when we left cards alone. Empty when none. */
export function alreadyStampedLine(count: unknown): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) return '';
  const people = n === 1 ? '1 of these people' : n + ' of these people';
  return 'We already imported stamps for ' + people + ', so we left their cards alone.';
}

// ── progress ────────────────────────────────────────────────────────────────

export interface Progress {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  stamped: number;
  enrolled: number;
  /** People whose cards we left alone because an import already stamped them. */
  alreadyStamped: number;
  /** People we would not re-consent, because they opted out here since. */
  consentWithheld: number;
  errors: string[];
  /** Named lines the screen shows on their own, not as errors. */
  notes: string[];
}

export function emptyProgress(): Progress {
  return { rows: 0, created: 0, updated: 0, skipped: 0, stamped: 0, enrolled: 0, alreadyStamped: 0, consentWithheld: 0, errors: [], notes: [] };
}
