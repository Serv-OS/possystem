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
//   - A FILE MAY ONLY EVER ADD A YES. marketing_opt_in is only ever set to
//     true, never to false, and a "no" in the file writes NOTHING: no consent
//     row, no flag. A no from the old system means only "the old system holds
//     no consent", and marketing-send reads the NEWEST ledger row first, so a
//     no row dated today would silently switch off everybody who said yes here.
//   - ERASED PEOPLE STAY ERASED. A row that matches a customer deleted here
//     (Back Office soft delete, phone and email kept) is left out and named,
//     never inserted again as a twin and never un-deleted.
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

import { normaliseEmail, phoneKeys, rawPhoneKeys, normaliseCountry, readPhone } from './customerImport.ts';
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
  /** Set when Back Office deleted them. Their phone and email are kept. */
  deleted_at?: string | null;
}

interface KeyMaps {
  byPhone: Map<string, ExistingCustomer>;
  byRaw: Map<string, ExistingCustomer>;
  byEmail: Map<string, ExistingCustomer>;
}

export interface ExistingIndex {
  /** customers.phone, under every shape readPhone gives it for this country. */
  byPhone: Map<string, ExistingCustomer>;
  /** customers.phone_raw: the text as typed, and that text read as a phone. */
  byRaw: Map<string, ExistingCustomer>;
  byEmail: Map<string, ExistingCustomer>;
  /** The same three keys for customers deleted here. Never matched, only refused. */
  deleted: KeyMaps;
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
  /** True when the row is somebody deleted here. See DELETED_REASON. */
  deleted?: boolean;
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
  /** The company's country, which is how phone_raw is written. See phoneRawFor. */
  country?: string | null;
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
  const live = emptyMaps();
  const deleted = emptyMaps();
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as ExistingCustomer;
    if (!c || typeof c !== 'object' || !c.id) continue;
    // A deleted customer is indexed apart, so nothing can ever match onto them
    // and patch them, and a row that IS them can be refused by name.
    indexOne(text(c.deleted_at) ? deleted : live, c, country);
  }
  return { ...live, deleted };
}

function emptyMaps(): KeyMaps {
  return { byPhone: new Map(), byRaw: new Map(), byEmail: new Map() };
}

function indexOne(maps: KeyMaps, c: ExistingCustomer, country: string): void {
  const put = (map: Map<string, ExistingCustomer>, key: string): void => {
    if (key && !map.has(key)) map.set(key, c);
  };
  put(maps.byPhone, text(c.phone));
  const forms = phoneKeys(c.phone, { country });
  for (let j = 0; j < forms.length; j++) put(maps.byPhone, forms[j]);
  const raws = rawPhoneKeys(c.phone_raw);
  for (let j = 0; j < raws.length; j++) put(maps.byRaw, 'r:' + raws[j]);
  const rawForms = phoneKeys(c.phone_raw, { country });
  for (let j = 0; j < rawForms.length; j++) put(maps.byRaw, 'p:' + rawForms[j]);
  const e = normaliseEmail(c.email);
  if (e.email) put(maps.byEmail, e.email);
}

function asIndex(existing: unknown, opts?: MatchOpts | null): ExistingIndex {
  const maybe = existing as ExistingIndex | null;
  if (maybe && maybe.byPhone instanceof Map && maybe.byEmail instanceof Map && maybe.byRaw instanceof Map && maybe.deleted) return maybe;
  return indexExisting(existing, opts);
}

/** '+441614960000' back to the way it is dialled in the UK, '01614960000'. */
function ukNationalForm(e164: string | null): string {
  const v = text(e164);
  return /^\+44\d{9,10}$/.test(v) ? '0' + v.slice(3) : '';
}

/**
 * THE phone_raw WE WRITE: the repaired number, the way a person types it.
 *
 * phone_raw is what venue staff read in Back Office, in reports, in gift card
 * lookup and in search. It is NOT the spreadsheet's cell: '7.954412324E9',
 * '7954412324', "'+447954412324" and '0044 7954 412324' are all Excel damage,
 * and writing them there put that damage in front of every till. So:
 *   GB company, UK number   '07954 412324', '0161 496 0000', '020 7946 0100'
 *   US company, 10 digits   '(415) 555-0123'
 *   anything else           the number we write to customers.phone
 * The raw cell is still used, with all its variants, as a MATCH key against
 * the phone_raw already on file (see lookupKeys). It is simply never stored.
 */
export function phoneRawFor(row: ImportRow | null | undefined, country?: unknown): string {
  const phone = text(row?.phone);
  if (!phone) return '';
  const c = normaliseCountry(country);
  const e164 = text(row?.phoneE164);
  if (c === 'GB') {
    const national = ukNationalForm(e164) || ukNationalForm(/^\+44/.test(phone) ? phone : '') || (/^0\d{9,10}$/.test(phone) ? phone : '');
    if (national) return ukSpaced(national);
  }
  if (c === 'US' && !/^\+(?!1)/.test(phone)) {
    const d = phone.replace(/\D/g, '');
    const ten = d.length === 11 && d.charAt(0) === '1' ? d.slice(1) : d;
    if (ten.length === 10) return '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6);
  }
  return phone;
}

/** A UK number with its 0, spaced the way it is said out loud. */
function ukSpaced(n: string): string {
  if (/^07\d{9}$/.test(n)) return n.slice(0, 5) + ' ' + n.slice(5);
  if (/^02\d{9}$/.test(n)) return n.slice(0, 3) + ' ' + n.slice(3, 7) + ' ' + n.slice(7);
  if (/^01\d1\d{7}$/.test(n) || /^011\d{8}$/.test(n)) return n.slice(0, 4) + ' ' + n.slice(4, 7) + ' ' + n.slice(7);
  if (/^0[389]\d{9}$/.test(n)) return n.slice(0, 4) + ' ' + n.slice(4, 7) + ' ' + n.slice(7);
  if (/^0\d{9,10}$/.test(n)) return n.slice(0, 5) + ' ' + n.slice(5);
  return n;
}

/**
 * True when a phone_raw on file is spreadsheet damage of THIS row's number:
 * scientific notation, a trailing .0, a leading apostrophe, a 00 prefix, a UK
 * 44 with no +, or a GB number missing its 0. Only such a value, on a customer
 * an import brought in, may be corrected by a later import. A clean value
 * somebody typed at the till is never touched.
 */
export function damagedPhoneRaw(value: unknown, row: ImportRow | null | undefined, country?: unknown): boolean {
  const v = text(value);
  if (!v || !row || !row.phone) return false;
  const c = normaliseCountry(country);
  if (v === phoneRawFor(row, c)) return false;
  const read = readPhone(v, { country: c });
  if (!read.ok || !read.phone) return false;
  const same = read.phone === row.phone || (!!read.e164 && read.e164 === row.phoneE164);
  if (!same) return false;
  const bare = v.replace(/[\s()-]/g, '');
  if (/^'/.test(v)) return true;
  if (/[eE]\+?\d{1,2}$/.test(v)) return true;
  if (/^\d+[.,]0+$/.test(v)) return true;
  if (/^00/.test(bare)) return true;
  if (read.assumed === true) return true;
  return c === 'GB' && /^44\d{9,10}$/.test(bare);
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
    // And the clean form this importer WRITES, so a second run finds its own.
    for (const c of ['GB', 'US']) {
      const clean = phoneRawFor(r, c);
      if (clean) raws.add(clean);
    }
    const e = normaliseEmail(r.email);
    if (e.email) emails.add(e.email);
  }
  return { phones: Array.from(phones), raws: Array.from(raws), emails: Array.from(emails) };
}

/** Emails per case blind read. Each one is a whole ilike term in the URL. */
export const EMAIL_READ_CHUNK = 50;

/**
 * A PostgREST `or` filter that finds these emails WHATEVER CASE they were
 * stored in: email.ilike."a@b.com",email.ilike."c@d.com". An exact `in` read
 * missed Jane@Example.com, which for a LIVE customer only cost a retry (the
 * unique index on lower(email) refused the insert), but for a DELETED one let
 * a twin in, because that index skips deleted rows. Each value is double
 * quoted, so a dot or a comma in it is not read as syntax. `_` in an address
 * is a one character wildcard to ILIKE, which can only ever find MORE rows;
 * the matcher then compares the normalised email exactly, so it is harmless.
 */
export function emailIlikeFilter(emails: unknown): string {
  const list: unknown[] = Array.isArray(emails) ? emails : [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = text(list[i]).toLowerCase();
    if (!e) continue;
    const quoted = e.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '\\%');
    out.push('email.ilike."' + quoted + '"');
  }
  return out.join(',');
}

/** The customer this row's phone already belongs to, if any: customers.phone
 *  first, then phone_raw as typed, then phone_raw read as a phone. */
function findByPhone(row: ImportRow, index: KeyMaps): ExistingCustomer | undefined {
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

    // ERASED PEOPLE STAY ERASED. Somebody deleted here, still in a stale
    // export, is left out by name. Checked FIRST, on every key, so they can
    // neither be inserted again (both unique indexes skip deleted rows, so the
    // database would let a twin in) nor land on a live row by their email.
    const gone = (row.phone ? findByPhone(row, index.deleted) : undefined)
      || findByRawOnly(row, index.deleted)
      || (email ? index.deleted.byEmail.get(email) : undefined);
    if (gone) {
      out.push({ rowNumber, verdict: 'blocked', reason: DELETED_REASON, customerId: null, matchedOn: '', row, deleted: true });
      continue;
    }

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

/** The typed phone of a row, against phone_raw, even when no phone could be written. */
function findByRawOnly(row: ImportRow, maps: KeyMaps): ExistingCustomer | undefined {
  const typed = rawPhoneKeys(row.phoneRaw);
  for (let j = 0; j < typed.length; j++) {
    const c = maps.byRaw.get('r:' + typed[j]);
    if (c) return c;
  }
  return undefined;
}

/** The words for a row that is somebody deleted here. */
export const DELETED_REASON = 'They were deleted here, so we left them out. We never bring back somebody who was deleted.';

/** The run note naming them. Empty when there are none. */
export function deletedLine(people: unknown): string {
  const list: Array<{ rowNumber?: unknown; name?: unknown }> = Array.isArray(people) ? people : [];
  if (!list.length) return '';
  const named = list.map((p) => 'row ' + (Number(p?.rowNumber) || 0) + ' (' + (text(p?.name) || 'no name') + ')');
  return 'Left out because they were deleted here: ' + named.join(', ') + '.';
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
    phone_raw: phoneRawFor(row, ctx?.country) || null,
    email: row?.email || null,
    birthday: row?.birthday || null,
    notes: text(row?.notes) || null,
    source: IMPORT_SOURCE,
    sources,
    marketing_opt_in: saidYes,
    marketing_opt_in_at: saidYes ? (row?.optInDate ? row.optInDate : ctx?.now ?? null) : null,
  };
}

/** A customer an import brought in: the only kind whose phone_raw an import may correct. */
function importedHere(c: ExistingCustomer): boolean {
  return text(c?.source) === IMPORT_SOURCE || listOf(c?.sources).indexOf(IMPORT_SOURCE) >= 0;
}

/** The columns a patch really changes: not the id, the org, the clock, the
 *  batch tag, or the name read back unchanged to satisfy NOT NULL. */
export function patchChanges(patch: Record<string, unknown> | null, existing?: ExistingCustomer | null): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const k of Object.keys(patch)) {
    if (k === 'id' || k === 'org_id' || k === 'updated_at' || k === 'sources' || k === 'source') continue;
    if (k === 'name' && existing && text(existing.name) === text(patch.name)) continue;
    out.push(k);
  }
  return out.sort();
}

/**
 * The columns one matched customer may change, and no others.
 *
 * Blanks only. If they already have a name we keep their name, if they already
 * have an email we keep their email. The only column that always moves is
 * `sources`, which gains this batch's tag so the run can be found again.
 *
 * Returns null when there is genuinely nothing to change. The batch tag in
 * `sources` rides along with a real change and is never a change on its own,
 * so a second run of the same file, under ANY batch id, writes nothing.
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
    patch.phone_raw = phoneRawFor(row, ctx?.country) || row.phone;
  } else if (importedHere(existing) && damagedPhoneRaw(existing.phone_raw, row, ctx?.country)) {
    // An earlier import wrote the spreadsheet's damage here. Put it right.
    patch.phone_raw = phoneRawFor(row, ctx?.country);
  }
  if (blank(existing.birthday) && row?.birthday) patch.birthday = row.birthday;
  if (blank(existing.notes) && !blank(row?.notes)) patch.notes = text(row.notes);

  // Only ever true. A no in the file writes nothing at all.
  if (allowOptIn && row?.marketingOptIn === true && existing.marketing_opt_in !== true) {
    patch.marketing_opt_in = true;
    patch.marketing_opt_in_at = row?.optInDate ? row.optInDate : (ctx?.now ?? null);
  }

  // NOTHING REAL TO CHANGE IS NO WRITE AT ALL. The batch tag and the source
  // are bookkeeping, never a change on their own: a second run of the same
  // file must leave every person exactly as they were, and must count them as
  // already up to date, not filled in.
  if (!Object.keys(patch).length) return null;
  if (blank(existing.source)) patch.source = IMPORT_SOURCE;

  const sources = listOf(existing.sources);
  const tag = batchTag(ctx?.batchId);
  const wanted: string[] = [];
  if (sources.indexOf(IMPORT_SOURCE) < 0) wanted.push(IMPORT_SOURCE);
  if (tag && sources.indexOf(tag) < 0) wanted.push(tag);
  if (wanted.length) patch.sources = sources.concat(wanted);

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
 * One consent row, for a yes, and never for anything else.
 *
 * customer_consents is the append only ledger and is the real record of
 * permission; marketing_opt_in on the customer is the older flag.
 * marketing-send reads the NEWEST ledger row first and only falls back to the
 * flag, which is exactly why a file's no must never be written: dated today it
 * would outrank a yes given here at the kiosk, the till or the portal.
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
  // A YES ONLY. A blank is nobody saying, and a no from another system means
  // only that it holds no consent: it never becomes a no row here, because the
  // newest ledger row is what marketing-send obeys.
  if (row?.marketingOptIn !== true) return null;
  return {
    customer_id: args.customerId,
    org_id: args.orgId ?? null,
    location_id: String(args.locationId ?? ''),
    company_id: args.companyId ?? null,
    channel: 'both',
    purpose: 'marketing',
    consented: true,
    source: IMPORT_SOURCE,
    method: 'imported_optin',
    consent_text: text(args.consentText) || null,
    privacy_version: args.privacyVersion ?? null,
    created_at: args.createdAt || args.now || null,
  };
}

// ── consent: a file may only ever ADD a yes ─────────────────────────────────

export interface ConsentVerdict {
  /** Write a customer_consents row at all. Only ever a yes row. */
  write: boolean;
  /** What that row says. Always true when write is true. */
  consented: boolean;
  /** created_at for it: the FILE's opt_in_date when the file gave one, else now. */
  createdAt: string;
  /** Turn customers.marketing_opt_in on. Never true for a withheld yes. */
  setFlag: boolean;
  /** We held the yes back. */
  withheld: boolean;
  /** Why, when withheld: they switched it off here, or they are simply not opted in here. */
  kind: '' | 'withdrawn' | 'not_opted_in';
  /** Short plain words for the operator, empty unless withheld. */
  reason: string;
}

/**
 * What a file's answer about marketing is allowed to do to one person.
 *
 * A FILE NO WRITES NOTHING. The real Coffee Boy file has 5,097 rows that say no
 * and not one opt_in_date. A no row dated today would become the NEWEST ledger
 * row, marketing-send obeys the newest row first, and everybody who said yes
 * here (kiosk, till, portal, Back Office) would be switched off in silence
 * while their flag still read true. A no from another system means only "the
 * old system holds no consent". So: no consent row, no flag, nothing.
 *
 * A FILE YES may switch somebody ON only when nothing here says otherwise.
 * It is held back when:
 *  - they WITHDREW here, which is knowable three ways:
 *      a customer_consents row saying no that is newer than the file's own
 *        opt_in_date (or any no at all when the file has no date)
 *      a marketing_suppressions row (an unsubscribe click or a STOP text)
 *      customers.marketing_opt_in = false with a marketing_opt_in_at on it.
 *        Every path that switches somebody on stamps that time, and Back
 *        Office's untick and the loyalty portal toggle leave it there when
 *        they switch them off, so false with a time means "was on, then off".
 *  - they are NOT OPTED IN here: marketing_opt_in = false with no time. That
 *    is the column's default, so most of these people never said stop. We
 *    still keep round three's rule and leave them alone, but we do NOT claim
 *    they said stop; the note says the file's yes was not applied.
 *
 * When a yes is held back the flag is left alone. A consent row is written for
 * it ONLY when the ledger already holds a newer no and the file gave its own
 * date, dated with that day so it can never jump the no. Against a flag only
 * refusal, a yes row of any date would become the newest ledger row and turn
 * the emails on, so none is written.
 *
 * A yes that goes ahead is dated from the file's opt_in_date when it has one,
 * and otherwise now.
 */
export function consentDecision(row: ImportRow, args: {
  priorConsents?: unknown;
  suppressed?: boolean;
  /** customers.marketing_opt_in as it stands now, for somebody we already have. */
  currentFlag?: boolean | null;
  /** customers.marketing_opt_in_at as it stands now. */
  currentFlagAt?: string | null;
  now: string;
}): ConsentVerdict | null {
  const answer = row?.marketingOptIn;
  if (answer == null) return null;
  const now = text(args?.now);

  if (answer !== true) {
    return { write: false, consented: false, createdAt: '', setFlag: false, withheld: false, kind: '', reason: '' };
  }

  const fileDay = text(row?.optInDate);
  const fileAt = fileDay ? fileDay.slice(0, 10) + 'T00:00:00.000Z' : '';

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
  const flagOff = args?.currentFlag === false;
  const flagWithdrawn = flagOff && !!text(args?.currentFlagAt);
  const withdrawn = suppressed || staleYes || flagWithdrawn;

  if (withdrawn) {
    return {
      write: !!fileAt && staleYes,
      consented: true,
      createdAt: fileAt || now,
      setFlag: false,
      withheld: true,
      kind: 'withdrawn',
      reason: 'They switched marketing off here, so we left it off.',
    };
  }
  if (flagOff) {
    return {
      write: false,
      consented: true,
      createdAt: fileAt || now,
      setFlag: false,
      withheld: true,
      kind: 'not_opted_in',
      reason: 'Not opted in here, so the file\'s yes was not applied.',
    };
  }

  return { write: true, consented: true, createdAt: fileAt || now, setFlag: true, withheld: false, kind: '', reason: '' };
}

/**
 * The lines the operator reads about the people whose yes we held back, by row
 * and by name, one line for each kind. Empty when there are none.
 */
export function withheldLines(people: unknown): string[] {
  const list: Array<{ rowNumber?: unknown; name?: unknown; kind?: unknown }> = Array.isArray(people) ? people : [];
  const named = (xs: typeof list) => xs.map((p) => 'row ' + (Number(p?.rowNumber) || 0) + ' (' + (text(p?.name) || 'no name') + ')').join(', ');
  const who = (n: number) => (n === 1 ? '1 person' : n + ' people');
  const off = list.filter((p) => p && p.kind === 'withdrawn');
  const notIn = list.filter((p) => p && p.kind !== 'withdrawn');
  const out: string[] = [];
  if (off.length) out.push('We left marketing OFF for ' + who(off.length) + ' who switched it off here, although the file says yes: ' + named(off) + '.');
  if (notIn.length) out.push(who(notIn.length) + (notIn.length === 1 ? ' is' : ' are') + ' not opted in here, so the file\'s yes was not applied: ' + named(notIn) + '.');
  return out;
}

/** withheldLines as one string, for callers that want a single line. */
export function withheldLine(people: unknown): string {
  return withheldLines(people).join(' ');
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
  /** People we already had, with nothing in the file to fill in. Never counted as updated. */
  upToDate: number;
  /** Rows left out because the person was deleted here. Also in skippedRows. */
  deleted: number;
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
    rows: 0, created: 0, updated: 0, skipped: 0, stamped: 0, enrolled: 0, alreadyStamped: 0, upToDate: 0, deleted: 0, consentWithheld: 0,
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
    up_to_date: progress.upToDate,
    deleted: progress.deleted,
    consent_withheld: progress.consentWithheld,
    skipped_rows: rowList(progress.skippedRows),
    failed: rowList(progress.failed),
    notes: progress.notes.slice(),
  };
}

// ── who may run it ──────────────────────────────────────────────────────────

/** The environment variable that lists the ServOS staff who may import. */
export const STAFF_EMAILS_ENV = 'SERVOS_IMPORT_STAFF_EMAILS';

/** What a signed in person is told while nobody is on the list. */
export const IMPORT_SWITCHED_OFF = 'Import is switched off: no staff emails configured.';

/**
 * SERVOS_IMPORT_STAFF_EMAILS read into a list: comma separated, trimmed, lower
 * case, blanks dropped, each one a whole email address. Unset or empty is an
 * empty list, which switches the import off for everybody but the service role.
 */
export function parseStaffEmails(value: unknown): string[] {
  const out: string[] = [];
  const parts = text(value).split(',');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i].trim().toLowerCase();
    if (!e || e.indexOf('@') < 1 || out.indexOf(e) >= 0) continue;
    out.push(e);
  }
  return out;
}

/**
 * SERVOS STAFF ONLY. Peter, 18 Sep 2026: "I dont want customer able to mess
 * something up so can we hide it or make it so only internal to servos can
 * access it?". Hiding the screen is not security, so this is the rule the edge
 * function applies to EVERY action, preview included.
 *
 * A caller passes when:
 *  - it is the service role, or
 *  - it is a signed in, NON anonymous user, AND their user_profiles.role is
 *    'super_admin', AND their email is EXACTLY one of the addresses in
 *    SERVOS_IMPORT_STAFF_EMAILS (compared without regard to case), AND that
 *    email is confirmed.
 *
 * Having a user_locations row for the venue is NOT enough: that is exactly the
 * venue owner Peter wants kept out.
 *
 * WHY AN EXACT LIST AND NOT A DOMAIN. An earlier version let in any confirmed
 * email on posup.co.uk or serv-os.app, on the theory that such an email
 * "cannot be given to yourself". That was false. create-user lets a venue
 * owner or manager make a login for ANY email address with email_confirm true
 * (no link is ever clicked), so a venue owner could mint a confirmed
 * anything@serv-os.app login. A named list of real people cannot be minted.
 * The super_admin half still matters: it means a name on the list is not
 * enough on its own either.
 *
 * An EMPTY list refuses everybody except the service role, and says so plainly.
 */
export function staffVerdict(args: {
  serviceRole?: boolean;
  user?: { id?: unknown; email?: unknown; email_confirmed_at?: unknown; is_anonymous?: unknown } | null;
  role?: unknown;
  allowlist?: unknown;
}): { ok: boolean; reason: string } {
  if (args?.serviceRole === true) return { ok: true, reason: '' };
  const allowed = Array.isArray(args?.allowlist)
    ? parseStaffEmails((args.allowlist as unknown[]).map((v) => text(v)).join(','))
    : parseStaffEmails(args?.allowlist);
  if (!allowed.length) return { ok: false, reason: IMPORT_SWITCHED_OFF };
  const user = args?.user ?? null;
  if (!user || !text(user.id)) return { ok: false, reason: 'Sign in first.' };
  if (user.is_anonymous === true) return { ok: false, reason: 'Sign in first.' };
  if (text(args?.role) !== 'super_admin') return { ok: false, reason: 'Only ServOS staff can import customers.' };
  const email = text(user.email).toLowerCase();
  if (!email || allowed.indexOf(email) < 0) return { ok: false, reason: 'Only ServOS staff can import customers.' };
  if (!text(user.email_confirmed_at)) return { ok: false, reason: 'Confirm your email first.' };
  return { ok: true, reason: '' };
}

// ── no record, no import ────────────────────────────────────────────────────

/** What the screen and the server say while import_batches does not exist. */
export const BATCH_TABLE_MISSING = 'Run the import_batches migration first.';

/**
 * Whether an action may go ahead, given whether the import_batches table is
 * there. Every run has to leave a record of who ran it and what it did, so the
 * IMPORT is refused until migration 20260918_OPS_customer_import_batches.sql
 * has been run. context and preview write nothing, so they still work.
 */
export function batchTableGate(action: unknown, batchTable: unknown): { ok: boolean; message: string } {
  if (text(action) !== 'import') return { ok: true, message: '' };
  if (batchTable === true) return { ok: true, message: '' };
  return { ok: false, message: BATCH_TABLE_MISSING };
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
