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

import { normaliseEmail, phoneKeys, rawPhoneKeys, normaliseCountry } from './customerImport.ts';
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
  /** customers.phone, under every shape readPhone gives it for this country. */
  byPhone: Map<string, ExistingCustomer>;
  /** customers.phone_raw: the text as typed, and that text read as a phone. */
  byRaw: Map<string, ExistingCustomer>;
  byEmail: Map<string, ExistingCustomer>;
}

/** The company's country, which is how a phone cell is read. See countryFromVenue. */
export interface MatchOpts { country?: string | null }

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
  /** The earlier row this one is the same person as, when that is why it was left out. */
  sameAs?: number;
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
 * The company's existing customers, keyed the way the file will be read, so a
 * phone typed four different ways still finds the one person.
 *
 * byPhone holds customers.phone EXACTLY as stored, plus that value read with
 * the company's country (a GB landline stored as 01614960000 is also
 * +441614960000, the shape an earlier version of this importer wrote). byRaw
 * holds customers.phone_raw as typed, and that text read as a phone, because
 * Back Office saves an edited phone into phone_raw. byEmail is lower case.
 *
 * The FIRST row wins on a clash, which cannot happen in practice because both
 * keys are unique indexes on the live table.
 */
export function indexExisting(rows: unknown, opts?: MatchOpts | null): ExistingIndex {
  const country = normaliseCountry(opts?.country);
  const byPhone = new Map<string, ExistingCustomer>();
  const byRaw = new Map<string, ExistingCustomer>();
  const byEmail = new Map<string, ExistingCustomer>();
  const put = (map: Map<string, ExistingCustomer>, key: string, c: ExistingCustomer): void => {
    if (key && !map.has(key)) map.set(key, c);
  };
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as ExistingCustomer;
    if (!c || typeof c !== 'object' || !c.id) continue;
    put(byPhone, text(c.phone), c);
    const forms = phoneKeys(c.phone, { country });
    for (let j = 0; j < forms.length; j++) put(byPhone, forms[j], c);
    const raws = rawPhoneKeys(c.phone_raw);
    for (let j = 0; j < raws.length; j++) put(byRaw, 'r:' + raws[j], c);
    const rawForms = phoneKeys(c.phone_raw, { country });
    for (let j = 0; j < rawForms.length; j++) put(byRaw, 'p:' + rawForms[j], c);
    const e = normaliseEmail(c.email);
    if (e.email) put(byEmail, e.email, c);
  }
  return { byPhone, byRaw, byEmail };
}

function asIndex(existing: unknown, opts?: MatchOpts | null): ExistingIndex {
  const maybe = existing as ExistingIndex | null;
  if (maybe && maybe.byPhone instanceof Map && maybe.byEmail instanceof Map && maybe.byRaw instanceof Map) return maybe;
  return indexExisting(existing, opts);
}

/** '+441614960000' back to the way it is dialled in the UK, '01614960000'. */
function ukNationalForm(e164: string | null): string {
  const v = text(e164);
  return /^\+44\d{9,10}$/.test(v) ? '0' + v.slice(3) : '';
}

/** The phone keys one row is looked up under. See phoneKeys. */
function rowPhoneKeys(r: ImportRow): string[] {
  const out: string[] = [];
  const list = [r.phone, r.phoneE164, r.phoneApp];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

/**
 * What to ask the database for, deduped.
 *
 *  - phones  compared with customers.phone: the shape we write, the E.164 form
 *            (only where readPhone built one), and the app's rule on the cell
 *  - raws    compared with customers.phone_raw, which is TEXT AS TYPED. So it
 *            is asked for the cell exactly as the file wrote it, plus the ways a
 *            person would type the same number ('07954412324', '+447954412324').
 *            A digits only key can only ever find a phone_raw that was typed as
 *            digits, and that is exactly what it is asked for.
 *  - emails  lower case
 */
export function lookupKeys(rows: unknown): { phones: string[]; raws: string[]; emails: string[] } {
  const phones = new Set<string>();
  const raws = new Set<string>();
  const emails = new Set<string>();
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] as ImportRow;
    if (!r || typeof r !== 'object') continue;
    const keys = rowPhoneKeys(r);
    for (let j = 0; j < keys.length; j++) { phones.add(keys[j]); raws.add(keys[j]); }
    const national = ukNationalForm(r.phoneE164);
    if (national) raws.add(national);
    const typed = rawPhoneKeys(r.phoneRaw);
    for (let j = 0; j < typed.length; j++) raws.add(typed[j]);
    const e = normaliseEmail(r.email);
    if (e.email) emails.add(e.email);
  }
  return { phones: Array.from(phones), raws: Array.from(raws), emails: Array.from(emails) };
}

/** The customer this row's phone already belongs to, if any: customers.phone
 *  first, then phone_raw as typed, then phone_raw read as a phone. */
function findByPhone(row: ImportRow, index: ExistingIndex): ExistingCustomer | undefined {
  const keys = rowPhoneKeys(row);
  for (let j = 0; j < keys.length; j++) {
    const c = index.byPhone.get(keys[j]);
    if (c) return c;
  }
  const typed = rawPhoneKeys(row.phoneRaw);
  for (let j = 0; j < typed.length; j++) {
    const c = index.byRaw.get('r:' + typed[j]);
    if (c) return c;
  }
  for (let j = 0; j < keys.length; j++) {
    const c = index.byRaw.get('p:' + keys[j]);
    if (c) return c;
  }
  return undefined;
}

// ── the verdict on each row ─────────────────────────────────────────────────

/**
 * New, update, or leave alone, one per row, in file order.
 *
 * Phone first, then email, the same order as every other writer. Two kinds of
 * row are refused:
 *
 *  - a row with a phone we have never seen whose EMAIL already belongs to
 *    somebody with a different phone: writing it would either fail on the
 *    unique email index or quietly staple two different people together.
 *  - a row that lands on a customer an EARLIER row already landed on (row A
 *    found them by phone, row B by email). Both patches in one bulk write is
 *    Postgres 21000 "ON CONFLICT DO UPDATE command cannot affect row a second
 *    time", which refuses the WHOLE statement, and it is two lines of the file
 *    claiming to be one person. The first row wins, and the second names it.
 *
 * opts.country is the company's country, which is how the stored phones are
 * read for comparing. Rows already decided (an array of Decisions) are passed
 * straight back, so running this on its own output changes nothing.
 */
export function decideRows(rows: unknown, existing: unknown, opts?: MatchOpts | null): Decision[] {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const index = asIndex(existing, opts);
  const out: Decision[] = [];
  const claimedBy = new Map<string, number>();

  const claim = (d: Decision): Decision => {
    if (!d.customerId || d.verdict === 'blocked') return d;
    const first = claimedBy.get(d.customerId);
    if (first !== undefined && first !== d.rowNumber) {
      return {
        ...d,
        verdict: 'blocked',
        reason: sameAsReason(first),
        sameAs: first,
      };
    }
    claimedBy.set(d.customerId, d.rowNumber);
    return d;
  };

  for (let i = 0; i < list.length; i++) {
    const maybe = list[i] as Decision;
    if (maybe && typeof maybe === 'object' && 'verdict' in maybe && maybe.row) {
      out.push(claim(maybe));
      continue;
    }
    const row = list[i] as ImportRow;
    if (!row || typeof row !== 'object') continue;
    const rowNumber = typeof row.rowNumber === 'number' ? row.rowNumber : i + 2;
    const email = normaliseEmail(row.email).email;

    const byPhone = row.phone ? findByPhone(row, index) : undefined;
    if (byPhone) {
      out.push(claim({ rowNumber, verdict: 'update', reason: '', customerId: byPhone.id, matchedOn: 'phone', row }));
      continue;
    }

    const byEmail = email ? index.byEmail.get(email) : undefined;
    if (byEmail) {
      // The row has a phone that is not theirs, and they already have one.
      if (row.phone && text(byEmail.phone)) {
        out.push({
          rowNumber,
          verdict: 'blocked',
          reason: 'That email already belongs to somebody else here, with a different phone. We left both alone.',
          customerId: byEmail.id,
          matchedOn: 'email',
          row,
        });
        continue;
      }
      out.push(claim({ rowNumber, verdict: 'update', reason: '', customerId: byEmail.id, matchedOn: 'email', row }));
      continue;
    }

    out.push({ rowNumber, verdict: 'new', reason: '', customerId: null, matchedOn: '', row });
  }

  return out;
}

/** The words for a row that is the same person as an earlier one. */
export function sameAsReason(firstRowNumber: unknown): string {
  const n = Number(firstRowNumber) || 0;
  return 'Same person as row ' + n + '. We already have them, and row ' + n + ' fills them in, so we left this row out.';
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
 * One patch per customer. decideRows already refuses a second row for the same
 * customer, and this is the belt over that brace: two patches for one id in
 * one bulk upsert is Postgres 21000, which refuses the WHOLE statement. The
 * FIRST patch wins every column it has; a later one only adds columns the first
 * did not touch. Nothing is ever padded with a value we were not changing.
 */
export function collapsePatches(patches: unknown): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = Array.isArray(patches) ? (patches as Record<string, unknown>[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== 'object' || p.id == null) continue;
    const id = String(p.id);
    const had = byId.get(id);
    if (!had) {
      byId.set(id, { ...p });
      order.push(id);
      continue;
    }
    for (const k of Object.keys(p)) if (!(k in had)) had[k] = p[k];
  }
  return order.map((id) => byId.get(id) as Record<string, unknown>);
}

/**
 * Patches sorted into groups that share the same columns, one patch per
 * customer (see collapsePatches).
 *
 * PostgREST needs every object in one bulk write to carry the same keys, and we
 * refuse to pad the others with the values we are NOT changing, because padding
 * is how an import quietly overwrites a name somebody typed at the till. So the
 * patches are grouped by their shape instead, and each group is one write. In a
 * real file that is a handful of writes per chunk.
 */
export function groupPatches(patches: unknown): Array<Record<string, unknown>[]> {
  const list = collapsePatches(patches);
  const groups = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
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
 * import RESTORING it. A stale export loaded after somebody opted out here
 * re-consented them, and the emails started again, which is the venue's fine.
 *
 * THERE ARE THREE WAYS SOMEBODY SAYS STOP HERE, and every one of them holds a
 * yes in the file back:
 *  - customers.marketing_opt_in = false. The two live opt out paths write ONLY
 *    this: Back Office (staff untick Marketing because the customer asked,
 *    src/backoffice/sections/Customers.jsx) and the customer's own toggle in the
 *    loyalty portal (loyalty-otp update profile). Neither writes a consent row,
 *    so reading only the ledger missed both. An existing false is a withdrawal
 *    made here, and a file's yes never overturns it. (A person an earlier
 *    import brought in as a no reads the same way, which is the safe side:
 *    staff can switch them on by hand with the customer's say so.)
 *  - a customer_consents row saying no, newer than the file's own opt in date
 *  - a marketing_suppressions row (an unsubscribe click or a STOP text)
 *
 * When a yes is held back the flag is left alone and the operator is told, by
 * row and name, which people. A consent row is written for it ONLY when the
 * ledger already holds a newer no, dated with the file's own day so it can
 * never jump that no. Against a flag only withdrawal a yes row of any date
 * would become the newest ledger row, and marketing-send reads the ledger
 * FIRST, so it would switch the emails back on. None is written.
 *
 * A NO in the file is never held back. A no is always recorded.
 */
export function consentDecision(row: ImportRow, args: {
  priorConsents?: unknown;
  suppressed?: boolean;
  /** customers.marketing_opt_in as it stands now, for somebody we already have. */
  currentFlag?: boolean | null;
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
  const switchedOff = args?.currentFlag === false;
  const staleYes = !!newestNo && (!fileAt || fileAt <= newestNo);
  if (suppressed || staleYes || switchedOff) {
    return {
      write: !!fileAt && staleYes,
      consented: true,
      createdAt: fileAt || now,
      setFlag: false,
      withheld: true,
      reason: switchedOff
        ? 'They switched marketing off here, so we left it off.'
        : 'They opted out here after this file was exported, so we left them opted out.',
    };
  }

  return { write: true, consented: true, createdAt: fileAt || now, setFlag: true, withheld: false, reason: '' };
}

/**
 * The line the operator reads about the people whose yes we held back, by row
 * and by name. Empty when there are none.
 */
export function withheldLine(people: unknown): string {
  const list: Array<{ rowNumber?: unknown; name?: unknown }> = Array.isArray(people) ? people : [];
  if (!list.length) return '';
  const who = list.length === 1 ? '1 person' : list.length + ' people';
  const named = list.map((p) => 'row ' + (Number(p?.rowNumber) || 0) + ' (' + (text(p?.name) || 'no name') + ')');
  return 'We left marketing OFF for ' + who + ' who said stop here, although the file says yes: ' + named.join(', ') + '.';
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

/** One row that did not go in, with the plain reason. */
export interface RowFailure { rowNumber: number; reason: string }

export interface Progress {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  stamped: number;
  enrolled: number;
  /** People whose cards we left alone because an import already stamped them. */
  alreadyStamped: number;
  /** People we would not re-consent, because they said stop here. */
  consentWithheld: number;
  /** Rows we left out on purpose (a problem, a repeat, a refusal), by row. */
  skippedRows: RowFailure[];
  /** Rows we tried to write and could not, by row. */
  failed: RowFailure[];
  /** Lines about the whole run, not about one row. The screen shows every one. */
  notes: string[];
}

export function emptyProgress(): Progress {
  return {
    rows: 0, created: 0, updated: 0, skipped: 0, stamped: 0, enrolled: 0, alreadyStamped: 0, consentWithheld: 0,
    skippedRows: [], failed: [], notes: [],
  };
}

/** A row we left out on purpose. Counted once, said by row. */
export function skipRow(progress: Progress, rowNumber: unknown, reason: string): void {
  progress.skipped++;
  progress.skippedRows.push({ rowNumber: Number(rowNumber) || 0, reason: text(reason) });
}

/** A row we tried to write and could not. */
export function failRow(progress: Progress, rowNumber: unknown, reason: string): void {
  progress.failed.push({ rowNumber: Number(rowNumber) || 0, reason: text(reason) });
}

/** A line about the whole run. Never counted as a row. */
export function runNote(progress: Progress, line: string): void {
  const t = text(line);
  if (t && progress.notes.indexOf(t) < 0) progress.notes.push(t);
}

/**
 * The chunk part of the answer. `failed` and `skipped_rows` are by row, with a
 * row number the screen can find in the file; `notes` are about the run and are
 * never counted as rows.
 */
export function chunkAnswer(progress: Progress): Record<string, unknown> {
  const rowList = (list: RowFailure[]) => list.map((f) => ({ row_number: f.rowNumber, reason: f.reason }));
  return {
    rows: progress.rows,
    created: progress.created,
    updated: progress.updated,
    skipped: progress.skipped,
    stamped: progress.stamped,
    enrolled: progress.enrolled,
    already_stamped: progress.alreadyStamped,
    consent_withheld: progress.consentWithheld,
    skipped_rows: rowList(progress.skippedRows),
    failed: rowList(progress.failed),
    notes: progress.notes.slice(),
  };
}

// ── who may run it ──────────────────────────────────────────────────────────

/** ServOS's own email domains. Overridden with SERVOS_STAFF_EMAIL_DOMAINS. */
export const STAFF_EMAIL_DOMAINS = ['posup.co.uk', 'serv-os.app'];

/**
 * SERVOS STAFF ONLY. Peter, 18 Sep 2026: "I dont want customer able to mess
 * something up so can we hide it or make it so only internal to servos can
 * access it?". Hiding the screen is not security, so this is the rule the edge
 * function applies to EVERY action, preview included.
 *
 * A caller passes when:
 *  - it is the service role, or
 *  - it is a signed in, non anonymous user whose user_profiles.role is
 *    'super_admin' AND whose CONFIRMED email is on a ServOS domain.
 *
 * Having a user_locations row for the venue is NOT enough: that is exactly the
 * venue owner Peter wants kept out.
 *
 * Why the email as well as the role. Until migration
 * 20260915c_OPS_user_profiles_admin_guard.sql is live, any owner login can
 * delete its own user_profiles row and insert it again as super_admin. The
 * role alone would then let a venue owner in. A confirmed email on a ServOS
 * domain cannot be given to yourself: changing it needs the new address to
 * click the link. So the email half keeps this check shut whether or not that
 * migration has been run, and the role half keeps it shut to ServOS people who
 * are not admins.
 */
export function staffVerdict(args: {
  serviceRole?: boolean;
  user?: { id?: unknown; email?: unknown; email_confirmed_at?: unknown; is_anonymous?: unknown } | null;
  role?: unknown;
  domains?: unknown;
}): { ok: boolean; reason: string } {
  if (args?.serviceRole === true) return { ok: true, reason: '' };
  const user = args?.user ?? null;
  if (!user || !text(user.id)) return { ok: false, reason: 'Sign in first.' };
  if (user.is_anonymous === true) return { ok: false, reason: 'Sign in first.' };
  if (text(args?.role) !== 'super_admin') return { ok: false, reason: 'Only ServOS staff can import customers.' };
  const email = text(user.email).toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at + 1) : '';
  const listed = Array.isArray(args?.domains) && (args.domains as unknown[]).length
    ? (args.domains as unknown[]).map((d) => text(d).toLowerCase()).filter(Boolean)
    : STAFF_EMAIL_DOMAINS;
  if (!domain || listed.indexOf(domain) < 0) return { ok: false, reason: 'Only ServOS staff can import customers.' };
  if (!text(user.email_confirmed_at)) return { ok: false, reason: 'Confirm your email first.' };
  return { ok: true, reason: '' };
}

// ── the batch row ───────────────────────────────────────────────────────────

/** A batch id has to be a uuid: import_batches.id is one. */
export function isBatchId(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value));
}

/**
 * The import_batches row, written (upserted on its id) by EVERY chunk. The
 * screen mints the id and sends it on every chunk, so "the first chunk is the
 * one with no batch id" was never true and the row was never written. An
 * upsert that ignores a row already there is right whichever chunk arrives
 * first, and a chunk sent again after a dropped connection.
 */
export function batchRecord(args: {
  batchId: string;
  orgId: string;
  companyId?: string | null;
  programId?: string | null;
  filename?: unknown;
  userId?: string | null;
  consentText?: unknown;
}): Record<string, unknown> {
  const note = text(args?.consentText);
  return {
    id: args.batchId,
    org_id: args.orgId,
    company_id: args?.companyId || null,
    program_id: args?.programId || null,
    filename: text(args?.filename).slice(0, 200) || null,
    row_count: 0,
    created_count: 0,
    updated_count: 0,
    skipped_count: 0,
    created_by: args?.userId || null,
    notes: note ? note.slice(0, 500) : null,
  };
}
