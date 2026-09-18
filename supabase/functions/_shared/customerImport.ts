// supabase/functions/_shared/customerImport.ts
//
// MIRROR OF src/lib/customerImport.js. Same rules, same numbers, same words.
//
// The edge function that writes the imported customers cannot import out of
// src/: it is deployed on its own, and sometimes by pasting the files under
// supabase/functions into the Supabase dashboard editor, so a relative import
// climbing out of this folder would not survive. So the rules live twice, and
// src/lib/customerImportParity.test.js runs one shared case table through BOTH
// files and compares every output, plus the rule tables field by field. Change
// one file, change the other, in the same commit. Same arrangement as
// ezcaterMatch.js / ezcaterMatch.ts.
//
// PURE. No imports, no supabase client, no fetch, no Deno globals, and the only
// clock read is the last resort inside todayIso, which the caller overrides.
//
// ============================================================================
//  WHY THIS EXISTS. READ BEFORE CHANGING THE PHONE RULE.
// ============================================================================
//
// Coffee Boy is moving its loyalty customers off another marketing system: one
// CSV of people, their stamps and the rewards they have not used yet. All three
// Coffee Boy sites share ONE org, so a person imported once is a member at
// every site.
//
// THE PHONE IS THE KEY, and it is the whole risk in this job.
//
//  * Every customer writer in the app looks a person up with an EXACT match on
//    `customers.phone` (customerLookup.js, store/index.js, loyalty-otp). A phone
//    stored in a different shape is invisible at the till: the customer says
//    "I have stamps", the screen says no.
//  * Customers sign in to loyalty with their phone and a one time code, so the
//    phone we store IS their login. Get it wrong and they cannot get in, and no
//    password reset exists to save them.
//  * `customers` has a UNIQUE index on (org_id, phone) and another on
//    (org_id, lower(email)), both where not deleted. Two shapes of one phone
//    both insert and the person exists twice.
//
// So this file writes a phone in THE SHAPE THE APP ITSELF PRODUCES, which is
// what `appPhone` below is: a character for character copy of the rule in
// store/index.js, customerLookup.js and loyalty-otp. A leading + is kept, 07
// plus eleven digits becomes +44..., 44... becomes +44..., and everything else
// is the bare digits exactly as typed. A Manchester landline the till stored as
// 01614960000 is written back as 01614960000, not as +441614960000, because the
// second one is a customer nobody can find.
//
// And we look a person up under EVERY shape they could already be filed under:
// what the app produces, the E.164 form the first version of this importer
// wrote, and phone_raw. See `phoneKeys`.
//
// Anything we cannot make sense of is REFUSED. A refused row is shown to the
// operator with its row number, and nothing is written for it. We never guess a
// phone into the database: a wrong number is a stranger's phone.
//
// The one inference we DO make is named and flagged, and it adds nothing but a
// zero. Excel eats the leading zero off 07700900123 and hands back 7700900123,
// which is not a rare accident, it is what happens to nearly every phone column
// a shop opens in a spreadsheet before sending it. Peter, 17 Sep 2026: "dont
// worry about country code it should always start with a 0 just insert a 0 in
// front of the number." So a bare 10 digit number gets its zero back, `assumed`
// comes back true so the screen can say how many rows it did that to, and no
// country code is invented. Anything shorter stays an error, because a 9 digit
// fragment could be anything.
//
// NOTHING HERE ASSUMES A COUNTRY. The old rule read every bare 10 digit number
// as British, so a US list of 4155551234 came out as +444155551234 for every
// single row, which is somebody else's phone and their loyalty login. RPOS runs
// US venues. A number already written in full international form (+353..., +1...)
// is kept as it stands, because that is not a guess.
//
// A PHONE WE CANNOT READ STOPS THE ROW. A BAD EMAIL DOES NOT. That asymmetry is
// deliberate. The phone is the login and the till's search key, so a person
// imported without it is half a customer nobody can find or fix later, and the
// operator would never be told. An email is only a way to write to them: it is
// dropped, said out loud on screen, and the person still goes in. A row with a
// bad email AND no phone has nothing left, so that one stops too.
//
// ============================================================================
//  OTHER THINGS THE DATABASE MAKES TRUE
// ============================================================================
//
//  * `customers.name` is text NOT NULL with no default. A null name is silently
//    refused and the insert fails (it broke every loyalty sign up on 17 Sep
//    2026, see customersNameNotNull.test.js). So normaliseRow ALWAYS produces a
//    name: the name column, else first plus last, else the email local part,
//    else the phone, else the external id, else the word Customer.
//  * `customers.birthday` is a DATE, so dates come back as 'YYYY-MM-DD'.
//  * Stamps are two numbers, not one. `stamps` is progress toward the next
//    reward, `rewards_unused` is rewards already earned and not taken. They land
//    on customer_stamp_cards.stamps_collected and .completed_count. A points
//    column from the old system is NOT a stamp count and is ignored on purpose.
//
// This file decides nothing about writing. It reads a file and says, in plain
// words, what is in it and what is wrong with it.
// ============================================================================

export interface PhoneRead { phone: string | null; local: string | null; e164: string | null; ok: boolean; empty: boolean; assumed: boolean; reason: string }
export interface EmailRead { email: string | null; ok: boolean; empty: boolean; reason: string }
export interface NumberRead { value: number; ok: boolean; empty: boolean; reason: string }
export interface YesNoRead { value: boolean | null; ok: boolean; empty: boolean; reason: string }
export interface DateRead { date: string | null; ok: boolean; empty: boolean; monthFirst: boolean; reason: string }
export interface ReadOpts { today?: string | Date | null; earliestYear?: number }
export interface Note { field: string; message: string }
export interface RowNote { rowNumber: number; field: string; message: string; text: string }
export interface DuplicateNote extends RowNote { value: string; firstRowNumber: number }
export interface HeaderMap {
  found: boolean;
  index: Record<string, number>;
  unknown: string[];
  ignored: string[];
  duplicates: string[];
  missing: string[];
  hasPhone: boolean;
  hasEmail: boolean;
}
export interface RawRow { rowNumber?: number; [key: string]: unknown }
export interface FileRead extends HeaderMap { rows: RawRow[] }
export interface ImportRow {
  rowNumber: number;
  name: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phoneLocal: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  phoneAssumed: boolean;
  email: string | null;
  stamps: number;
  rewardsUnused: number;
  marketingOptIn: boolean | null;
  optInDate: string | null;
  optInSource: string;
  signedUpDate: string | null;
  birthday: string | null;
  externalId: string;
  notes: string;
  problems: Note[];
  warnings: Note[];
}
export interface Checked {
  ready: ImportRow[];
  errors: RowNote[];
  duplicatesInFile: DuplicateNote[];
  warnings: RowNote[];
}
export interface Totals {
  ready: number;
  newCustomers: number;
  alreadyKnown: number;
  withStamps: number;
  stampsTotal: number;
  rewardsTotal: number;
  canEmail: number;
  canText: number;
  optedOut: number;
  notSaid: number;
  phoneFixed: number;
  problems: number;
  duplicates: number;
  total: number;
}

// ── the template ────────────────────────────────────────────────────────────

/** The columns of the file we hand out, in this order. */
export const TEMPLATE_COLUMNS: string[] = [
  'name',
  'first_name',
  'last_name',
  'phone',
  'email',
  'stamps',
  'rewards_unused',
  'marketing_opt_in',
  'opt_in_date',
  'opt_in_source',
  'signed_up_date',
  'birthday',
  'external_id',
  'notes',
];

// ONE filled example row, which is the only guidance the file itself carries.
// There is deliberately NO second line of notes under the header: a spreadsheet
// would read it as a person, and so would we. The screen explains the columns.
//
// The example phone is written '07700 900123', with the space, on purpose.
// Excel keeps that as text; 07700900123 loses its zero the moment the file is
// opened, and a leading + is treated as the start of a formula. The number
// itself is an Ofcom reserved drama number, so it can never ring anybody.
export const TEMPLATE_EXAMPLE: Record<string, string> = {
  name: 'Jane Smith',
  first_name: 'Jane',
  last_name: 'Smith',
  phone: '07700 900123',
  email: 'jane@example.com',
  stamps: '4',
  rewards_unused: '1',
  marketing_opt_in: 'yes',
  opt_in_date: '2025-04-12',
  opt_in_source: 'Old loyalty app',
  signed_up_date: '2024-11-03',
  birthday: '1990-06-24',
  external_id: 'CB-1042',
  notes: 'Likes oat milk',
};

// Column names we accept from another system's export, matched by name after
// lowercasing and turning every run of punctuation into one space, so
// 'First Name', 'first_name' and 'FIRST-NAME' are all 'first name'. Column
// order never matters.
//
// Deliberately NOT aliased: 'email marketing' and 'sms marketing'. A file with
// both would quietly have one of them win. They show up as columns we did not
// use, and the operator's own tick box on the screen says what the batch means.
export const HEADER_ALIASES: Record<string, string[]> = {
  name: ['full name', 'fullname', 'customer name', 'contact name', 'display name', 'member name'],
  first_name: ['first', 'firstname', 'forename', 'given name', 'first names'],
  last_name: ['last', 'lastname', 'surname', 'family name', 'second name'],
  phone: ['mobile', 'mobile number', 'phone number', 'telephone', 'tel', 'cell', 'cell phone', 'contact number', 'msisdn'],
  email: ['email address', 'e mail', 'e mail address', 'mail'],
  stamps: ['stamp', 'stamps collected', 'stamps on card', 'current stamps', 'stamp count', 'stamp balance'],
  rewards_unused: ['rewards', 'reward', 'rewards available', 'unused rewards', 'rewards owed', 'free drinks', 'free drink', 'free items', 'completed cards'],
  marketing_opt_in: ['opt in', 'opted in', 'optin', 'consent', 'marketing consent', 'marketing', 'subscribed', 'opt in status'],
  opt_in_date: ['opted in date', 'consent date', 'date opted in', 'opt in at', 'subscribed date', 'marketing opt in date'],
  opt_in_source: ['consent source', 'opt in from', 'signed up via', 'where they opted in', 'source'],
  signed_up_date: ['signed up', 'sign up date', 'joined', 'join date', 'date joined', 'member since', 'created', 'created at', 'registered', 'registration date'],
  birthday: ['birth date', 'birthdate', 'date of birth', 'dob'],
  external_id: ['id', 'customer id', 'member id', 'member number', 'account number', 'card number', 'loyalty id', 'reference', 'ref'],
  notes: ['note', 'comment', 'comments', 'remarks'],
};

// Columns we recognise and then ignore on purpose. They are listed back to the
// operator so nobody thinks we used them. Points are NOT stamps: a points
// balance dropped into a stamp column would hand out free coffee.
export const IGNORED_HEADERS: string[] = [
  'points',
  'point',
  'points balance',
  'loyalty points',
  'balance',
  'visits',
  'visit count',
  'total visits',
  'spend',
  'total spend',
  'lifetime spend',
  'last visit',
  'last order',
  'tier',
  'address',
  'postcode',
  'post code',
  'zip',
  'city',
  'town',
  'country',
];

// Sanity caps. A whole column landing in the wrong place is the realistic
// mistake, and it spends real money, so a silly number is an error the operator
// has to look at rather than free drinks for everybody.
export const MAX_STAMPS = 500;
export const MAX_REWARDS = 100;
export const EARLIEST_BIRTH_YEAR = 1900;

// Words an export writes when it means "nothing here".
const BLANK_WORDS: string[] = ['n/a', 'na', 'none', 'null', 'nil', 'unknown', '-', '--', '.'];

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const YES_WORDS: string[] = ['yes', 'y', 'true', 't', '1', 'on', 'opted in', 'opt in', 'subscribed', 'subscribe', 'signed up', 'active', 'consented'];
const NO_WORDS: string[] = ['no', 'n', 'false', 'f', '0', 'off', 'opted out', 'opt out', 'unsubscribed', 'unsubscribe', 'declined', 'never', 'inactive'];

// ── CSV in ──────────────────────────────────────────────────────────────────

/**
 * A small correct CSV reader. Quoted fields, embedded commas, "" for a quote
 * inside a quoted field, newlines inside a quoted field, CR / LF / CRLF line
 * endings, and a UTF-8 BOM on the front. Rows where every cell is empty are
 * dropped, because a spreadsheet leaves a trail of them at the bottom of a file.
 *
 * Returns an array of arrays of strings. Never throws, never uses a library.
 */
export function parseCsv(text: unknown): string[][] {
  const rows: string[][] = [];
  if (typeof text !== 'string' || !text) return rows;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const endRow = (): void => {
    row.push(field);
    field = '';
    let blank = true;
    for (let j = 0; j < row.length; j++) {
      if (row[j].trim() !== '') { blank = false; break; }
    }
    if (!blank) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** Header text in its comparing form: lower case, punctuation to one space. */
export function normaliseHeader(raw: unknown): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const HEADER_LOOKUP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (let i = 0; i < TEMPLATE_COLUMNS.length; i++) {
    const col = TEMPLATE_COLUMNS[i];
    map[normaliseHeader(col)] = col;
  }
  const cols = Object.keys(HEADER_ALIASES);
  for (let i = 0; i < cols.length; i++) {
    const list = HEADER_ALIASES[cols[i]];
    for (let j = 0; j < list.length; j++) {
      const key = normaliseHeader(list[j]);
      if (!map[key]) map[key] = cols[i];
    }
  }
  return map;
})();

const IGNORED_LOOKUP: Record<string, boolean> = (() => {
  const map: Record<string, boolean> = {};
  for (let i = 0; i < IGNORED_HEADERS.length; i++) map[normaliseHeader(IGNORED_HEADERS[i])] = true;
  return map;
})();

/** The column this header means, or '' when we do not know it. */
export function canonicalHeader(raw: unknown): string {
  const key = normaliseHeader(raw);
  if (!key) return '';
  return HEADER_LOOKUP[key] || '';
}

/** True for a column we know about and skip on purpose, such as points. */
export function isIgnoredHeader(raw: unknown): boolean {
  const key = normaliseHeader(raw);
  if (!key) return false;
  if (HEADER_LOOKUP[key]) return false;
  return !!IGNORED_LOOKUP[key];
}

/**
 * Work out which column is where. First match wins, so a file with two phone
 * columns uses the first and names the second in `duplicates`.
 */
export function mapHeaders(headerRow: unknown): HeaderMap {
  const index: Record<string, number> = {};
  const unknown: string[] = [];
  const ignored: string[] = [];
  const duplicates: string[] = [];
  const cells: unknown[] = Array.isArray(headerRow) ? headerRow : [];

  for (let i = 0; i < cells.length; i++) {
    const raw = cells[i] == null ? '' : String(cells[i]).trim();
    if (!raw) continue;
    const col = canonicalHeader(raw);
    if (col) {
      if (index[col] === undefined) index[col] = i;
      else duplicates.push(raw);
    } else if (isIgnoredHeader(raw)) {
      ignored.push(raw);
    } else {
      unknown.push(raw);
    }
  }

  const missing = TEMPLATE_COLUMNS.filter((c: string) => index[c] === undefined);
  return {
    found: Object.keys(index).length > 0,
    index,
    unknown,
    ignored,
    duplicates,
    missing,
    hasPhone: index.phone !== undefined,
    hasEmail: index.email !== undefined,
  };
}

/**
 * Read a whole file into raw rows keyed by our column names.
 *
 * Row numbers count the lines of the file with the header as line 1, so the
 * first person is row 2 and the number matches what a spreadsheet shows. Blank
 * lines are not counted, because a spreadsheet hides them too.
 */
export function readCsv(text: unknown): FileRead {
  const table = parseCsv(text);
  if (!table.length) {
    return {
      found: false,
      index: {},
      unknown: [],
      ignored: [],
      duplicates: [],
      missing: TEMPLATE_COLUMNS.slice(),
      hasPhone: false,
      hasEmail: false,
      rows: [],
    };
  }
  const head = mapHeaders(table[0]);
  const rows: RawRow[] = [];
  if (head.found) {
    for (let i = 1; i < table.length; i++) {
      const cells = table[i];
      const row: RawRow = { rowNumber: i + 1 };
      for (let c = 0; c < TEMPLATE_COLUMNS.length; c++) {
        const col = TEMPLATE_COLUMNS[c];
        const at = head.index[col];
        const cell = at === undefined ? '' : cells[at];
        row[col] = cell == null ? '' : String(cell);
      }
      rows.push(row);
    }
  }
  return {
    found: head.found,
    index: head.index,
    unknown: head.unknown,
    ignored: head.ignored,
    duplicates: head.duplicates,
    missing: head.missing,
    hasPhone: head.hasPhone,
    hasEmail: head.hasEmail,
    rows,
  };
}

// ── CSV out ─────────────────────────────────────────────────────────────────

/**
 * One cell, safe for a spreadsheet. Same rule as the Customers export: a
 * leading = + - @ or tab is neutralised so nobody's file runs a formula, and
 * anything with a quote, comma or newline is quoted.
 */
export function csvEscape(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows of cells to CSV text, CRLF line endings, trailing newline. */
export function toCsv(rows: unknown): string {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const lines: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const cells: unknown[] = Array.isArray(list[i]) ? list[i] as unknown[] : [list[i]];
    const out: string[] = [];
    for (let j = 0; j < cells.length; j++) out.push(csvEscape(cells[j]));
    lines.push(out.join(','));
  }
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

/**
 * The file behind the Download template button: the header row and ONE filled
 * example row. Pass { bom: true } for the byte order mark that makes Excel read
 * accented names properly on Windows.
 */
export function templateCsv(opts?: { bom?: boolean } | null): string {
  const example: string[] = [];
  for (let i = 0; i < TEMPLATE_COLUMNS.length; i++) {
    const col = TEMPLATE_COLUMNS[i];
    example.push(TEMPLATE_EXAMPLE[col] === undefined ? '' : TEMPLATE_EXAMPLE[col]);
  }
  const text = toCsv([TEMPLATE_COLUMNS.slice(), example]);
  return opts && opts.bom ? '\uFEFF' + text : text;
}

// ── single values ───────────────────────────────────────────────────────────

function cleanText(raw: unknown): string {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function isBlankWord(text: string): boolean {
  const t = text.toLowerCase();
  for (let i = 0; i < BLANK_WORDS.length; i++) if (BLANK_WORDS[i] === t) return true;
  return false;
}

/**
 * The app's OWN phone rule, character for character.
 *
 * There are three identical copies of it live already, and every one of them
 * is a place a customer is looked up or written:
 *   src/store/index.js          _normalisePhone   (the till)
 *   src/lib/customerLookup.js   normalisePhone    (kiosk and online)
 *   supabase/functions/loyalty-otp/index.ts       (the loyalty login)
 *
 * It keeps a leading +, turns 07 plus eleven digits into +44..., turns 44...
 * into +44..., and hands EVERYTHING ELSE back as the bare digits exactly as
 * typed. So a Manchester landline sits in customers.phone as 01614960000, not
 * as +441614960000, and an importer that writes the E.164 form creates a second
 * customer the till can never find, with the stamps on the row nobody sees.
 *
 * This is a copy on purpose: an edge function cannot import out of src/, and
 * this file is mirrored into supabase/functions/_shared. Do NOT change the
 * shape here without changing the three above, which is a different job.
 */
export function appPhone(raw: unknown): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

/**
 * One phone cell read, or refused with a reason.
 *
 * Returns { phone, local, e164, ok, empty, assumed, reason }.
 *  - phone   what we WRITE: the cell put through the app's own rule above, so
 *            the till finds the person it already knows. '+447700900123' for a
 *            mobile, '01614960000' for a landline, '+353861234567' for a number
 *            that already carried its own country code.
 *  - local   the number the way the operator would key it in, leading zero and
 *            all, or null when the cell was already international.
 *  - e164    the full international form, kept as a SECOND key to look under,
 *            because the first version of this importer wrote that shape and
 *            those rows have to be found, not doubled.
 *  - empty   true when the cell was blank (not an error on its own)
 *  - assumed true when we put back a leading zero a spreadsheet ate
 *  - reason  short plain words for the operator when ok is false
 *
 * Peter, 17 Sep 2026: "dont worry about country code it should always start
 * with a 0 just insert a 0 in front of the number." So a bare ten digit number
 * gets its zero back and then goes through the same rule as every other number.
 * We never bolt a country code onto a number that did not carry one: the old
 * rule read every bare ten digit number as British, and a US list of
 * 4155551234 came out as +444155551234, which is a stranger's phone and their
 * loyalty login. A number that DOES carry its own + is kept as it stands,
 * because that is not a guess.
 */
export function readPhone(raw: unknown): PhoneRead {
  const text = cleanText(raw);
  const no = (reason: string): PhoneRead => ({ phone: null, local: null, e164: null, ok: false, empty: false, assumed: false, reason });
  if (!text || isBlankWord(text)) return { phone: null, local: null, e164: null, ok: true, empty: true, assumed: false, reason: '' };
  if (/[a-z]/i.test(text)) return no('We cannot read that phone number.');

  let s = text.replace(/[\s()\-.\u2010-\u2015/\\]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const plus = s.startsWith('+');
  const digits = plus ? s.slice(1) : s;
  if (!digits || !/^\d+$/.test(digits)) return no('We cannot read that phone number.');

  // A number with no country code on it: 9 or 10 digits once the trunk zero is
  // off. We put the zero back and let the app's rule say what gets stored.
  const dialled = (national: string, assumed: boolean): PhoneRead => {
    if (national.length < 9) return no('That phone number is too short.');
    if (national.length > 10) return no('That phone number is too long.');
    if (national.charAt(0) === '0') return no('We cannot read that phone number.');
    const local = '0' + national;
    return { phone: appPhone(local), local, e164: '+44' + national, ok: true, empty: false, assumed, reason: '' };
  };

  if (digits.startsWith('44')) {
    let national = digits.slice(2);
    if (national.charAt(0) === '0') national = national.slice(1);
    return dialled(national, false);
  }
  if (plus) {
    if (digits.length < 8) return no('That phone number is too short.');
    if (digits.length > 15) return no('That phone number is too long.');
    return { phone: '+' + digits, local: null, e164: '+' + digits, ok: true, empty: false, assumed: false, reason: '' };
  }
  if (digits.charAt(0) === '0') return dialled(digits.slice(1), false);
  // Excel ate the leading zero off the phone column, which is what happens to
  // nearly every list a shop opens in a spreadsheet. Put it back. Nine digits
  // or fewer stays an error, because a short fragment could be anything.
  if (digits.length === 10) return dialled(digits, true);
  if (digits.length < 10) return no('That phone number is too short.');
  return no('We cannot read that phone number. Put + and the country code on the front.');
}

/** The phone in the shape the whole app looks customers up by, or null. */
export function normalisePhoneUk(raw: unknown): string | null {
  const r = readPhone(raw);
  return r.ok ? r.phone : null;
}

/**
 * Every shape one phone can already be sitting in the database under.
 *
 * A person's number can be on file three ways at once: what the app's rule
 * produced when the till saved them (01614960000), the E.164 form an earlier
 * run of this importer wrote (+441614960000), and phone_raw, which is whatever
 * somebody typed. Matching on only one of them is how one customer becomes two,
 * with the stamps on the row the till cannot find. So we look under all of
 * them, and we write only the one the app itself produces.
 */
export function phoneKeys(raw: unknown): string[] {
  const out: string[] = [];
  const add = (v: string | null) => { if (v && out.indexOf(v) < 0) out.push(v); };
  const r = readPhone(raw);
  if (r.ok) { add(r.phone); add(r.e164); add(r.local); }
  add(appPhone(raw));
  return out;
}

/**
 * An email in the shape the unique index uses: trimmed, lower case, and pulled
 * out of "Jane Smith <jane@x.com>" if that is how the old system wrote it.
 */
export function normaliseEmail(raw: unknown): EmailRead {
  let text = cleanText(raw);
  if (!text || isBlankWord(text)) return { email: null, ok: true, empty: true, reason: '' };
  const angled = text.match(/<([^>]+)>/);
  if (angled) text = angled[1].trim();
  const value = text.toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(value)) {
    return { email: null, ok: false, empty: false, reason: 'We cannot read that email.' };
  }
  return { email: value, ok: true, empty: false, reason: '' };
}

/**
 * A count of things: a whole number, 0 or more, blank meaning 0.
 */
export function readWholeNumber(raw: unknown, max?: number, label?: string): NumberRead {
  const text = cleanText(raw).replace(/,/g, '');
  const what = label || 'That number';
  if (!text || isBlankWord(text)) return { value: 0, ok: true, empty: true, reason: '' };
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return { value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  if (n < 0) return { value: 0, ok: false, empty: false, reason: what + ' cannot be less than 0.' };
  if (!Number.isInteger(n)) return { value: 0, ok: false, empty: false, reason: what + ' must be a whole number.' };
  if (typeof max === 'number' && n > max) return { value: 0, ok: false, empty: false, reason: what + ' is too high. Check the column.' };
  return { value: n, ok: true, empty: false, reason: '' };
}

/**
 * Yes or no out of whatever the other system wrote. Blank is null, which means
 * nobody said. It is not a yes.
 */
export function readYesNo(raw: unknown): YesNoRead {
  const text = cleanText(raw).toLowerCase();
  if (!text || isBlankWord(text)) return { value: null, ok: true, empty: true, reason: '' };
  for (let i = 0; i < YES_WORDS.length; i++) if (YES_WORDS[i] === text) return { value: true, ok: true, empty: false, reason: '' };
  for (let i = 0; i < NO_WORDS.length; i++) if (NO_WORDS[i] === text) return { value: false, ok: true, empty: false, reason: '' };
  return { value: null, ok: false, empty: false, reason: 'We cannot read yes or no there.' };
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y < 80 ? 2000 + y : 1900 + y;
}

/** Today as 'YYYY-MM-DD'. The caller passes the venue's own date; only the last
 *  resort reads the machine clock, so the rules stay testable. */
function todayIso(opts?: ReadOpts | null): string {
  const t = opts ? opts.today : null;
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (t instanceof Date && !isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * A date out of ISO or the shapes a UK export writes. Day comes FIRST, because
 * the file is British: 03/04/2025 is 3 April. Month first is only read when day
 * first is impossible (04/25/2025), and then `monthFirst` comes back true so the
 * screen can say so.
 *
 * A date after today is refused. Pass { earliestYear } for a birthday.
 */
export function readDate(raw: unknown, opts?: ReadOpts | null): DateRead {
  const text = cleanText(raw);
  if (!text || isBlankWord(text)) return { date: null, ok: true, empty: true, monthFirst: false, reason: '' };

  let y = 0;
  let m = 0;
  let d = 0;
  let monthFirst = false;

  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  const dMonY = text.match(/^(\d{1,2})[\s-]+([a-z]+)[\s-]+(\d{2,4})$/i);
  const monDY = text.match(/^([a-z]+)[\s-]+(\d{1,2}),?[\s-]+(\d{2,4})$/i);

  if (iso) {
    y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]);
  } else if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    y = fullYear(Number(dmy[3]));
    if (isRealDate(y, b, a)) { d = a; m = b; } else if (isRealDate(y, a, b)) { d = b; m = a; monthFirst = true; } else { d = a; m = b; }
  } else if (dMonY) {
    d = Number(dMonY[1]);
    m = MONTHS[dMonY[2].toLowerCase()] || 0;
    y = fullYear(Number(dMonY[3]));
  } else if (monDY) {
    m = MONTHS[monDY[1].toLowerCase()] || 0;
    d = Number(monDY[2]);
    y = fullYear(Number(monDY[3]));
  } else {
    return { date: null, ok: false, empty: false, monthFirst: false, reason: 'We cannot read that date. Use 2025-04-12.' };
  }

  if (!isRealDate(y, m, d)) return { date: null, ok: false, empty: false, monthFirst: false, reason: 'That date is not a real day.' };

  const value = y + '-' + pad2(m) + '-' + pad2(d);
  if (value > todayIso(opts)) return { date: null, ok: false, empty: false, monthFirst, reason: 'That date is in the future.' };
  const earliest = opts && typeof opts.earliestYear === 'number' ? opts.earliestYear : 0;
  if (earliest && y < earliest) return { date: null, ok: false, empty: false, monthFirst, reason: 'That date is too long ago to be right.' };
  return { date: value, ok: true, empty: false, monthFirst, reason: '' };
}

// ── one row ─────────────────────────────────────────────────────────────────

function looksNormalised(row: unknown): boolean {
  const r = row as ImportRow | null;
  return !!r && typeof r === 'object' && Array.isArray(r.problems) && Object.prototype.hasOwnProperty.call(r, 'phoneRaw');
}

/**
 * Rows stripped back to the raw cells of the template and nothing else.
 *
 * normaliseRow hands an ALREADY normalised row straight back, which is the only
 * reason validateRows is safe to run on its own output. That passthrough is a
 * hole the moment the rows came off the wire: any signed in Back Office user of
 * the venue could POST { problems: [], phoneRaw: null, stamps: 100000,
 * marketingOptIn: true } and walk straight past validateRows, which is the edge
 * function's single guard, into a hundred thousand free coffees.
 *
 * So anything arriving from a browser goes through here first. Every key that
 * is not a template column is dropped, every cell becomes a string, and the
 * rules then run on the cells instead of on somebody's idea of the answer.
 */
export function rawRowsOnly(rows: unknown): Record<string, unknown>[] {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i++) {
    const src = (list[i] && typeof list[i] === 'object' ? list[i] : {}) as Record<string, unknown>;
    const row: Record<string, unknown> = { rowNumber: typeof src.rowNumber === 'number' ? src.rowNumber : i + 2 };
    for (let c = 0; c < TEMPLATE_COLUMNS.length; c++) {
      const col = TEMPLATE_COLUMNS[c];
      const cell = src[col];
      row[col] = cell == null ? '' : String(cell);
    }
    out.push(row);
  }
  return out;
}

/**
 * One raw row from readCsv into the shape we would write, with everything that
 * is wrong with it listed in plain words.
 *
 * `problems` stop the row being written. `warnings` do not: they are things we
 * dropped or read a particular way, and the screen shows them.
 *
 * The name is NEVER empty, because customers.name is NOT NULL and a null name
 * is refused without a word of explanation.
 */
export function normaliseRow(row: unknown, opts?: ReadOpts | null): ImportRow {
  if (looksNormalised(row)) return row as ImportRow;
  const src = (row && typeof row === 'object' ? row : {}) as RawRow;
  const problems: Note[] = [];
  const warnings: Note[] = [];
  const say = (list: Note[], field: string, message: string): void => { list.push({ field, message }); };

  const phoneRaw = cleanText(src.phone);
  const p = readPhone(src.phone);
  if (!p.ok) say(problems, 'phone', p.reason);
  if (p.assumed) say(warnings, 'phone', 'We put a 0 back on the front of that number.');

  const e = normaliseEmail(src.email);
  // A bad email does not lose the person when we can still reach them by phone.
  // It is dropped, said out loud, and the row still goes in.
  if (!e.ok && p.ok && p.phone) say(warnings, 'email', 'We could not read that email, so we left it out.');
  else if (!e.ok) say(problems, 'email', e.reason);

  if (p.ok && !p.phone && (!e.ok || !e.email)) say(problems, 'phone', 'We need a phone number or an email.');

  const firstName = cleanText(src.first_name);
  const lastName = cleanText(src.last_name);
  const given = cleanText(src.name);
  const emailLocal = e.email ? e.email.split('@')[0] : '';
  const externalId = cleanText(src.external_id);
  const name = given
    || cleanText(firstName + ' ' + lastName)
    || emailLocal
    || p.phone
    || phoneRaw
    || externalId
    || 'Customer';

  const stamps = readWholeNumber(src.stamps, MAX_STAMPS, 'Stamps');
  if (!stamps.ok) say(problems, 'stamps', stamps.reason);
  const rewards = readWholeNumber(src.rewards_unused, MAX_REWARDS, 'Rewards');
  if (!rewards.ok) say(problems, 'rewards_unused', rewards.reason);

  const optIn = readYesNo(src.marketing_opt_in);
  if (!optIn.ok) say(problems, 'marketing_opt_in', optIn.reason);

  const optInDate = readDate(src.opt_in_date, opts);
  if (!optInDate.ok) say(problems, 'opt_in_date', optInDate.reason);
  const signedUpDate = readDate(src.signed_up_date, opts);
  if (!signedUpDate.ok) say(problems, 'signed_up_date', signedUpDate.reason);
  const birthOpts: ReadOpts = { today: opts ? opts.today : null, earliestYear: EARLIEST_BIRTH_YEAR };
  const birthday = readDate(src.birthday, birthOpts);
  if (!birthday.ok) say(problems, 'birthday', birthday.reason);

  if (optInDate.monthFirst || signedUpDate.monthFirst || birthday.monthFirst) {
    say(warnings, 'opt_in_date', 'We read that date as month first.');
  }

  return {
    rowNumber: typeof src.rowNumber === 'number' ? src.rowNumber : 0,
    name,
    firstName,
    lastName,
    phone: p.phone,
    phoneLocal: p.local,
    phoneE164: p.e164,
    phoneRaw: phoneRaw || null,
    phoneAssumed: !!p.assumed,
    email: e.email,
    stamps: stamps.value,
    rewardsUnused: rewards.value,
    marketingOptIn: optIn.value,
    optInDate: optInDate.date,
    optInSource: cleanText(src.opt_in_source),
    signedUpDate: signedUpDate.date,
    birthday: birthday.date,
    externalId,
    notes: cleanText(src.notes),
    problems,
    warnings,
  };
}

// ── the whole file ──────────────────────────────────────────────────────────

function lineOf(rowNumber: number, message: string): string {
  return 'Row ' + rowNumber + ': ' + message;
}

/**
 * Every row of the file, sorted into what we can write and what we cannot.
 *
 *  - ready            rows we would write, in file order
 *  - errors           one per problem, each naming its row number
 *  - duplicatesInFile the same person twice in one file. The FIRST one is kept
 *                     and the rest are reported, never written, because
 *                     (org_id, phone) and (org_id, lower(email)) are unique and
 *                     the second write would fail or split the person in two.
 *  - warnings         things we did that the operator should see
 *
 * Rows may be raw (from readCsv) or already normalised. Running it twice on its
 * own output gives the same answer.
 */
export function validateRows(rows: unknown, opts?: ReadOpts | null): Checked {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const ready: ImportRow[] = [];
  const errors: RowNote[] = [];
  const duplicatesInFile: DuplicateNote[] = [];
  const warnings: RowNote[] = [];
  const seenPhone = new Map<string, number>();
  const seenEmail = new Map<string, number>();

  for (let i = 0; i < list.length; i++) {
    const r = normaliseRow(list[i], opts);
    const rowNumber = r.rowNumber || i + 2;

    for (let j = 0; j < r.warnings.length; j++) {
      const w = r.warnings[j];
      warnings.push({ rowNumber, field: w.field, message: w.message, text: lineOf(rowNumber, w.message) });
    }

    if (r.problems.length) {
      for (let j = 0; j < r.problems.length; j++) {
        const p = r.problems[j];
        errors.push({ rowNumber, field: p.field, message: p.message, text: lineOf(rowNumber, p.message) });
      }
      continue;
    }

    if (r.phone && seenPhone.has(r.phone)) {
      const first = seenPhone.get(r.phone) as number;
      const message = 'Same phone as row ' + first + '. We keep the first one.';
      duplicatesInFile.push({ rowNumber, field: 'phone', value: r.phone, firstRowNumber: first, message, text: lineOf(rowNumber, message) });
      continue;
    }
    if (r.email && seenEmail.has(r.email)) {
      const first = seenEmail.get(r.email) as number;
      const message = 'Same email as row ' + first + '. We keep the first one.';
      duplicatesInFile.push({ rowNumber, field: 'email', value: r.email, firstRowNumber: first, message, text: lineOf(rowNumber, message) });
      continue;
    }

    if (r.phone) seenPhone.set(r.phone, rowNumber);
    if (r.email) seenEmail.set(r.email, rowNumber);
    ready.push(r);
  }

  return { ready, errors, duplicatesInFile, warnings };
}

/**
 * The people already in the database, as keys this file can compare against.
 * Takes customer rows ({ phone, email }), plain strings, a { phones, emails }
 * pair, or a Set this function already built, and gives back a Set of
 * 'p:+44...' / 'e:jane@x.com'. Running it on its own output changes nothing.
 */
export function buildExistingKeys(source: unknown): Set<string> {
  const keys = new Set<string>();
  if (!source) return keys;
  if (source instanceof Set) return buildExistingKeys(Array.from(source));

  const addPhone = (v: unknown): void => { const list = phoneKeys(v); for (let i = 0; i < list.length; i++) keys.add('p:' + list[i]); };
  const addEmail = (v: unknown): void => { const n = normaliseEmail(v); if (n.email) keys.add('e:' + n.email); };

  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) {
      const item = source[i];
      if (item == null) continue;
      if (typeof item === 'string') {
        if (item.startsWith('p:') || item.startsWith('e:')) keys.add(item);
        else if (item.indexOf('@') >= 0) addEmail(item);
        else addPhone(item);
      } else if (typeof item === 'object') {
        const c = item as { phone?: unknown; phone_raw?: unknown; phoneRaw?: unknown; email?: unknown };
        addPhone(c.phone);
        addPhone(c.phone_raw);
        addPhone(c.phoneRaw);
        addEmail(c.email);
      }
    }
    return keys;
  }
  if (typeof source === 'object') {
    const pair = source as { phones?: unknown; emails?: unknown };
    const phones = pair.phones;
    const emails = pair.emails;
    const ph: unknown[] = phones instanceof Set ? Array.from(phones) : (Array.isArray(phones) ? phones : []);
    const em: unknown[] = emails instanceof Set ? Array.from(emails) : (Array.isArray(emails) ? emails : []);
    for (let i = 0; i < ph.length; i++) addPhone(ph[i]);
    for (let i = 0; i < em.length; i++) addEmail(em[i]);
  }
  return keys;
}

/**
 * True when this row is somebody the venue already has.
 *
 * Checked against EVERY shape of their phone, not just the one we would write,
 * because the same person can be on file under the app's shape or under the
 * E.164 form an older run of this importer wrote.
 */
export function matchesExisting(row: unknown, keys: unknown): boolean {
  const r = row as ImportRow | null;
  const set = keys as Set<string> | null;
  if (!r || !set || typeof set.has !== 'function') return false;
  const forms = [r.phone, r.phoneE164, r.phoneLocal];
  for (let i = 0; i < forms.length; i++) if (forms[i] && set.has('p:' + forms[i])) return true;
  return !!(r.email && set.has('e:' + r.email));
}

/** Distinct row numbers with something wrong with them. One row with three
 *  problems is ONE row, not three. */
export function problemRowNumbers(checked: unknown): number[] {
  const c = (checked || {}) as Checked;
  const errors = Array.isArray(c.errors) ? c.errors : [];
  const seen = new Set<number>();
  for (let i = 0; i < errors.length; i++) {
    const n = errors[i] && errors[i].rowNumber;
    if (n) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * The numbers the preview screen shows before anybody presses Import.
 *
 * `rows` may be raw rows, normalised rows, or the result of validateRows.
 * `existingKeys` is whatever buildExistingKeys accepts, or nothing on a venue
 * with no customers yet (Coffee Boy today), in which case everybody is new.
 *
 * Counted as they can be emailed only where the file says yes AND there is an
 * email. A blank opt in column is nobody's yes.
 */
export function summarise(rows: unknown, existingKeys?: unknown, opts?: ReadOpts | null): Totals {
  const asChecked = rows as Checked | null;
  const checked: Checked = rows && !Array.isArray(rows) && asChecked && Array.isArray(asChecked.ready)
    ? asChecked
    : validateRows(Array.isArray(rows) ? rows : [], opts);
  const keys = buildExistingKeys(existingKeys);

  let newCustomers = 0;
  let alreadyKnown = 0;
  let withStamps = 0;
  let stampsTotal = 0;
  let rewardsTotal = 0;
  let canEmail = 0;
  let canText = 0;
  let optedOut = 0;
  let notSaid = 0;
  let phoneFixed = 0;

  for (let i = 0; i < checked.ready.length; i++) {
    const r = checked.ready[i];
    if (matchesExisting(r, keys)) alreadyKnown++; else newCustomers++;
    if (r.stamps > 0 || r.rewardsUnused > 0) withStamps++;
    stampsTotal += r.stamps;
    rewardsTotal += r.rewardsUnused;
    if (r.marketingOptIn === true) {
      if (r.email) canEmail++;
      if (r.phone) canText++;
    } else if (r.marketingOptIn === false) optedOut++;
    else notSaid++;
    if (r.phoneAssumed) phoneFixed++;
  }

  const problemRows = problemRowNumbers(checked);

  return {
    ready: checked.ready.length,
    newCustomers,
    alreadyKnown,
    withStamps,
    stampsTotal,
    rewardsTotal,
    canEmail,
    canText,
    optedOut,
    notSaid,
    phoneFixed,
    problems: problemRows.length,
    duplicates: checked.duplicatesInFile.length,
    total: checked.ready.length + problemRows.length + checked.duplicatesInFile.length,
  };
}
