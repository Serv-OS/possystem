// src/lib/customerImport.js
//
// PURE rules for importing a customer list out of another system's CSV. No
// imports, no supabase client, no fetch, no DOM, no clock read that the caller
// cannot override. Everything is a function of its arguments, so the admin
// portal screen (ServOS staff only) and the edge function that writes the rows
// can both run it and always agree about what the file said.
//
// MIRROR: supabase/functions/_shared/customerImport.ts holds the same rules for
// the edge function (an edge function is deployed on its own, sometimes by
// pasting the files under supabase/functions into the Supabase dashboard, so it
// cannot import out of src/). The two files are held together by
// src/lib/customerImportParity.test.js, which runs one shared case table
// through both and compares every output. Change one, change the other, in the
// same commit. Same arrangement as ezcaterMatch.js / ezcaterMatch.ts.
//
// ============================================================================
//  WHY THIS EXISTS. READ BEFORE CHANGING THE PHONE RULE.
// ============================================================================
//
// Coffee Boy is moving about 8,000 loyalty members off 5Loyalty: one CSV of
// people, their stamps and the rewards they have not used yet. Every Coffee Boy
// site shares ONE org, so a person imported once is a member at every site.
// The import is run by ServOS staff from the admin portal, after Peter's team
// has corrected the export in a spreadsheet. Assume the spreadsheet mangled it.
//
// THE PHONE IS THE KEY, and it is the whole risk in this job.
//
//  * Every customer writer in the app looks a person up with an EXACT match on
//    `customers.phone` (customerLookup.js, store/index.js, loyalty-otp). A phone
//    stored in a different shape is invisible at the till.
//  * Customers sign in to loyalty with their phone and a one time code, so the
//    phone we store IS their login. A wrong number is a stranger's login.
//  * `customers` has a UNIQUE index on (org_id, phone) and another on
//    (org_id, lower(email)), both where not deleted.
//
// THE INVARIANT IS SHAPE PARITY WITH THE TILL. For any cell, the phone we write
// is exactly what the app's own rule (`appPhone` below, a copy of the three live
// copies) produces for that cell. The ONLY edits made to a cell before the rule
// runs are ones that undo damage and invent nothing:
//
//  1. A spreadsheet number shape is turned back into its digits: 7.954412324E9
//     is 7954412324. If the spreadsheet ROUNDED it (7.95441E+09) the digits are
//     gone and the row is refused, never guessed.
//  2. 00 on the front is the international dialling prefix, so it reads as +.
//  3. After +44, a trunk 0 is dropped, because +44 (0)7700 900123 is how people
//     write a UK number and +4407700900123 is nobody's.
//  4. ONLY FOR A GB COMPANY, a bare ten digit UK shaped number gets its leading
//     0 back, because Excel eats it. Peter, 17 Sep 2026: "just insert a 0 in
//     front of the number". That was about the UK file from 5Loyalty, so it is
//     a GB rule and nothing else. `assumed` comes back true and the screen says
//     how many rows it did that to.
//
// For any other country, or when we do not know the country, the cell goes
// through the app's rule UNCHANGED: no zero, no country code, and a leading 44
// is not read as the UK code (a US area code 440 to 449 is not Britain). The
// first two versions of this file put a zero on every bare ten digit number and
// then let the app's rule turn 07 into +44, which wrote a US number with a 7xx
// area code as a real UK mobile belonging to somebody else.
//
// WE LOOK A PERSON UP under the shape we write, under the E.164 form an earlier
// version of this importer wrote (only when the cell carried a + or the company
// is GB and the number is a real UK shape, never invented for a US row), under
// the app's rule on the untouched cell, and in phone_raw under the cell exactly
// as the file wrote it. See `phoneKeys`.
//
// Anything we cannot make sense of is REFUSED with a plain reason and its row
// number. A refused row is never written.
//
// A PHONE WE CANNOT READ STOPS THE ROW. A BAD EMAIL DOES NOT. The phone is the
// login and the till's search key; an email is only a way to write to them. A
// bad email is dropped, said out loud, and the person still goes in. A row with
// a bad email AND no phone has nothing left, so that one stops too.
//
// ============================================================================
//  WHAT A SPREADSHEET DOES TO THE FILE, AND WHAT WE DO ABOUT IT
// ============================================================================
//
//  * a BOM on the front, and a semicolon or tab between the columns: read
//  * the header row re-typed in other capitals or punctuation: read
//  * blank rows and trailing empty columns: dropped
//  * phones without their 0, or as 7.954412324E9: see the phone rule above
//  * dates as 05/09/1984 or 5/9/1984: day first for a GB company. If one date
//    in a column can only be month first, the spreadsheet has turned that
//    column American, and every date in it that could be read both ways is
//    refused instead of guessed. For any other country a date that could be
//    read both ways is refused.
//  * stamps as 2.0, or 2,0 from a comma decimal spreadsheet: 2
//  * yes and no as TRUE, FALSE, Yes, Y: read
//  * a file saved in the wrong text encoding (a name full of the character
//    that means "unreadable"): the row is refused with the fix in words
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

// ── the template ────────────────────────────────────────────────────────────

/** The columns of the file we hand out, in this order. */
export const TEMPLATE_COLUMNS = [
  'name',
  'first_name',
  'last_name',
  'phone',
  'email',
  'stamps',
  'rewards_unused',
  'points',
  'gift_card_code',
  'gift_card_balance',
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
export const TEMPLATE_EXAMPLE = {
  name: 'Jane Smith',
  first_name: 'Jane',
  last_name: 'Smith',
  phone: '07700 900123',
  email: 'jane@example.com',
  stamps: '4',
  rewards_unused: '1',
  points: '250',
  gift_card_code: 'GC-4417-8820',
  gift_card_balance: '12.50',
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
export const HEADER_ALIASES = {
  name: ['full name', 'fullname', 'customer name', 'contact name', 'display name', 'member name'],
  first_name: ['first', 'firstname', 'forename', 'given name', 'first names'],
  last_name: ['last', 'lastname', 'surname', 'family name', 'second name'],
  phone: ['mobile', 'mobile number', 'phone number', 'telephone', 'tel', 'cell', 'cell phone', 'contact number', 'msisdn'],
  email: ['email address', 'e mail', 'e mail address', 'mail'],
  stamps: ['stamp', 'stamps collected', 'stamps on card', 'current stamps', 'stamp count', 'stamp balance'],
  rewards_unused: ['rewards', 'reward', 'rewards available', 'unused rewards', 'rewards owed', 'free drinks', 'free drink', 'free items', 'completed cards'],
  // Points are a COUNT and gift card money is MONEY. They were both ignored
  // until 21 Sep 2026 precisely so neither could land in the stamps column and
  // buy the shop a round; they are read properly now, each with its own cap.
  points: ['point', 'points balance', 'point balance', 'loyalty points', 'reward points', 'points earned', 'current points'],
  gift_card_code: ['gift card', 'gift card code', 'gift card number', 'giftcard', 'giftcard code', 'card code', 'voucher', 'voucher code', 'gift voucher'],
  gift_card_balance: ['gift card balance', 'giftcard balance', 'gift balance', 'gift card value', 'voucher balance', 'stored value', 'credit balance', 'account credit', 'wallet balance'],
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
export const IGNORED_HEADERS = [
  // 'balance' on its own is the one we still refuse to guess: in one export it
  // is points, in the next it is money on a gift card, and guessing wrong either
  // hands out free coffee or invents cash. The screen asks for it to be renamed.
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
// Points are cheap individually and expensive in bulk: 100,000 is far above any
// real balance and far below a phone number or a spend figure in pence, which
// are the two columns that realistically land here by mistake.
export const MAX_POINTS = 100000;
// Gift card money is real money. 500 is above any card a venue actually sells
// and below a date (20250412), an order total in pence, or an account number.
export const MAX_GIFT_BALANCE = 500;
export const EARLIEST_BIRTH_YEAR = 1900;

// Words an export writes when it means "nothing here".
const BLANK_WORDS = ['n/a', 'na', 'none', 'null', 'nil', 'unknown', '-', '--', '.'];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const YES_WORDS = ['yes', 'y', 'true', 't', '1', 'on', 'opted in', 'opt in', 'subscribed', 'subscribe', 'signed up', 'active', 'consented'];
const NO_WORDS = ['no', 'n', 'false', 'f', '0', 'off', 'opted out', 'opt out', 'unsubscribed', 'unsubscribe', 'declined', 'never', 'inactive'];

// ── CSV in ──────────────────────────────────────────────────────────────────

/**
 * Which character separates the columns: comma, semicolon or tab.
 *
 * Excel in much of Europe saves "CSV" with semicolons, because the comma is its
 * decimal point. We look at the header line only (outside quotes) and take the
 * separator it uses most. A plain file with commas is always a comma file.
 */
export function detectDelimiter(text) {
  if (typeof text !== 'string' || !text) return ',';
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && c === ',') commas++;
    else if (!inQuotes && c === ';') semis++;
    else if (!inQuotes && c === '\t') tabs++;
  }
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * A small correct CSV reader. Quoted fields, embedded separators, "" for a
 * quote inside a quoted field, newlines inside a quoted field, CR / LF / CRLF
 * line endings, a UTF-8 BOM on the front, and a comma, semicolon or tab
 * between the columns (see detectDelimiter).
 *
 * Returns one entry per record that has anything in it, as { record, cells }.
 * `record` counts EVERY record, blank ones included, with the first as 1, so it
 * is the row number a spreadsheet shows even when somebody left an empty row in
 * the middle of the sheet. Never throws, never uses a library.
 */
export function parseCsvRecords(text, delimiter) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter === ';' || delimiter === '\t' || delimiter === ',' ? delimiter : detectDelimiter(src);

  let field = '';
  let row = [];
  let inQuotes = false;
  let record = 0;

  const endRow = () => {
    row.push(field);
    field = '';
    record++;
    let blank = true;
    for (let j = 0; j < row.length; j++) {
      if (row[j].trim() !== '') { blank = false; break; }
    }
    if (!blank) out.push({ record, cells: row });
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
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return out;
}

/**
 * The same reader, cells only. Rows where every cell is empty are dropped,
 * because a spreadsheet leaves a trail of them at the bottom of a file.
 */
export function parseCsv(text, delimiter) {
  const records = parseCsvRecords(text, delimiter);
  const rows = [];
  for (let i = 0; i < records.length; i++) rows.push(records[i].cells);
  return rows;
}

/** Header text in its comparing form: lower case, punctuation to one space. */
export function normaliseHeader(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const HEADER_LOOKUP = (() => {
  const map = {};
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

const IGNORED_LOOKUP = (() => {
  const map = {};
  for (let i = 0; i < IGNORED_HEADERS.length; i++) map[normaliseHeader(IGNORED_HEADERS[i])] = true;
  return map;
})();

/** The column this header means, or '' when we do not know it. */
export function canonicalHeader(raw) {
  const key = normaliseHeader(raw);
  if (!key) return '';
  return HEADER_LOOKUP[key] || '';
}

/** True for a column we know about and skip on purpose, such as points. */
export function isIgnoredHeader(raw) {
  const key = normaliseHeader(raw);
  if (!key) return false;
  if (HEADER_LOOKUP[key]) return false;
  return !!IGNORED_LOOKUP[key];
}

/**
 * Work out which column is where. First match wins, so a file with two phone
 * columns uses the first and names the second in `duplicates`.
 *
 * Returns { found, index, unknown, ignored, duplicates, missing, hasPhone, hasEmail }.
 */
export function mapHeaders(headerRow) {
  const index = {};
  const unknown = [];
  const ignored = [];
  const duplicates = [];
  const cells = Array.isArray(headerRow) ? headerRow : [];

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

  const missing = TEMPLATE_COLUMNS.filter((c) => index[c] === undefined);
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
 * Row numbers are the rows a spreadsheet shows, with the header as row 1, so
 * the first person is row 2. A blank row in the middle of the sheet still
 * counts, because the spreadsheet still shows it, so "Row 44" in a message is
 * row 44 in the sheet the operator has open.
 */
export function readCsv(text) {
  const delimiter = detectDelimiter(text);
  const records = parseCsvRecords(text, delimiter);
  if (!records.length) {
    return {
      delimiter,
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
  const head = mapHeaders(records[0].cells);
  // Row numbers are counted from the header, which a spreadsheet shows as row
  // 1, so a blank row ABOVE the header does not shift every number by one.
  const base = records[0].record - 1;
  const rows = [];
  if (head.found) {
    for (let i = 1; i < records.length; i++) {
      const cells = records[i].cells;
      const row = { rowNumber: records[i].record - base };
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
    delimiter,
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
export function csvEscape(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows of cells to CSV text, CRLF line endings, trailing newline. */
export function toCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const cells = Array.isArray(list[i]) ? list[i] : [list[i]];
    const out = [];
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
export function templateCsv(opts) {
  const example = [];
  for (let i = 0; i < TEMPLATE_COLUMNS.length; i++) {
    const col = TEMPLATE_COLUMNS[i];
    example.push(TEMPLATE_EXAMPLE[col] === undefined ? '' : TEMPLATE_EXAMPLE[col]);
  }
  const text = toCsv([TEMPLATE_COLUMNS.slice(), example]);
  return opts && opts.bom ? '\uFEFF' + text : text;
}

// ── single values ───────────────────────────────────────────────────────────

function cleanText(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

function isBlankWord(text) {
  const t = text.toLowerCase();
  for (let i = 0; i < BLANK_WORDS.length; i++) if (BLANK_WORDS[i] === t) return true;
  return false;
}

// ── the company's country ───────────────────────────────────────────────────

const GB_NAMES = ['GB', 'UK', 'GBR', 'UNITED KINGDOM', 'GREAT BRITAIN', 'BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND'];
const US_NAMES = ['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA', 'AMERICA'];

/**
 * A country written any way at all, as a two letter code, or '' when it says
 * nothing we can trust. 'uk', 'GBR' and 'United Kingdom' are all 'GB'.
 */
export function normaliseCountry(value) {
  if (value == null) return '';
  const t = String(value).toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
  if (!t) return '';
  if (GB_NAMES.indexOf(t) >= 0) return 'GB';
  if (US_NAMES.indexOf(t) >= 0) return 'US';
  return /^[A-Z]{2}$/.test(t) ? t : '';
}

/** The country in words for the preview line. */
export function countryLabel(country) {
  const c = normaliseCountry(country);
  if (c === 'GB') return 'United Kingdom';
  if (c === 'US') return 'United States';
  return c || 'not known';
}

/**
 * The country a venue's phones and dates are read as, and where we got it.
 *
 * In this order, and the FIRST one that says something wins:
 *   country           Ops locations.country, where that column exists
 *   platform_country  Platform locations.country, where that column exists
 *   platform_currency Platform locations.currency, which a person set when the
 *                     venue was provisioned
 *   currency          a currency with no source named (older callers)
 *   ops_currency      Ops locations.currency, LAST, because it DEFAULTS to
 *                     'GBP': a US venue nobody updated in Ops reads as GBP
 *
 * Only GBP means GB and only USD means US. Anything else is '' and nothing is
 * assumed: no zero is put on a phone and no date is read day first.
 *
 * Returns { country, source, label }, source one of the names above, or ''.
 */
export function countryFromVenue(venue) {
  const v = venue && typeof venue === 'object' ? venue : {};
  const named = [['country', v.country], ['platform_country', v.platformCountry]];
  for (let i = 0; i < named.length; i++) {
    const c = normaliseCountry(named[i][1]);
    if (c) return { country: c, source: String(named[i][0]), label: countryLabel(c) };
  }
  const money = [['platform_currency', v.platformCurrency], ['currency', v.currency], ['ops_currency', v.opsCurrency]];
  for (let i = 0; i < money.length; i++) {
    const cur = String(money[i][1] == null ? '' : money[i][1]).trim().toUpperCase();
    if (!cur) continue;
    if (cur === 'GBP') return { country: 'GB', source: String(money[i][0]), label: countryLabel('GB') };
    if (cur === 'USD') return { country: 'US', source: String(money[i][0]), label: countryLabel('US') };
    // A currency that says nothing about phones stops the search: a EUR venue
    // is not read as GB because Ops still holds its default.
    return { country: '', source: '', label: countryLabel('') };
  }
  return { country: '', source: '', label: countryLabel('') };
}

// ── phones ──────────────────────────────────────────────────────────────────

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
 * typed. customerImportParity.test.js holds this copy against customerLookup.js
 * on a table of cells, so it cannot drift.
 *
 * Do NOT change the shape here without changing the three above, which is a
 * different job.
 */
export function appPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('07') && digits.length === 11) return '+44' + digits.slice(1);
  if (digits.startsWith('44')) return '+' + digits;
  return digits;
}

/** A UK number once its 0 is off: 9 or 10 digits, starting with a digit a UK
 *  number can start with. 4 and 6 are not used, and 0 would be a second zero. */
function ukNational(n) {
  return /^[1235789]\d{8,9}$/.test(n);
}

function ukProblem(n) {
  if (n.length < 9) return 'That phone number is too short.';
  if (n.length > 10) return 'That phone number is too long.';
  return 'We cannot read that phone number.';
}

/**
 * One phone cell read, or refused with a reason.
 *
 * opts.country is the COMPANY's country ('GB', 'US', or '' for not known). See
 * countryFromVenue. It is the only thing that lets us put a 0 back.
 *
 * Returns { phone, e164, app, ok, empty, assumed, reason }.
 *  - phone   what we WRITE. Always what appPhone gives for the cell, after the
 *            four repairs listed at the top of this file and nothing else.
 *  - e164    the full international form, ONLY when the cell carried a + (or
 *            00) or the company is GB and this is a real UK shape. It is a
 *            second key to look under, because an earlier version of this
 *            importer wrote that shape for a landline. Never invented for a
 *            number from anywhere else.
 *  - app     appPhone on the cell exactly as typed, which is how the till would
 *            have stored it if somebody keyed it in the same way. A third key.
 *  - empty   true when the cell was blank (not an error on its own)
 *  - assumed true when we put back a leading zero a spreadsheet ate (GB only)
 *  - reason  short plain words for the operator when ok is false
 */
export function readPhone(raw, opts) {
  const gb = normaliseCountry(opts && opts.country) === 'GB';
  const none = { phone: null, e164: null, app: null, ok: true, empty: true, assumed: false, reason: '' };
  const no = (reason) => ({ phone: null, e164: null, app: null, ok: false, empty: false, assumed: false, reason });
  let text = cleanText(raw);
  if (!text || isBlankWord(text)) return none;
  // A leading apostrophe is how a spreadsheet marks "this is text", and it is
  // what our own rows to fix file puts in front of a +.
  if (text.charAt(0) === "'") text = text.slice(1).trim();
  if (!text) return none;

  // Repair 1: a spreadsheet turned the phone into a number.
  const sci = text.match(/^(\d)(?:[.,](\d+))?[eE]\+?(\d{1,2})$/);
  if (sci) {
    const digits = sci[1] + (sci[2] || '');
    const places = Number(sci[3]);
    if (digits.length < places + 1) return no('A spreadsheet rounded this phone number. Type it in full.');
    if (digits.length > places + 1) return no('We cannot read that phone number.');
    text = digits;
  } else if (/^\d+[.,]0+$/.test(text)) {
    text = text.replace(/[.,]0+$/, '');
  }

  if (/[a-z]/i.test(text)) return no('We cannot read that phone number.');
  // The till's rule on the cell as it was typed, once a spreadsheet's damage
  // is undone. A key to look under, never what we write.
  const typed = appPhone(text);
  let s = text.replace(/[\s()\-.‐-―/\\]/g, '');
  // Repair 2: 00 is the international dialling prefix.
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const plus = s.startsWith('+');
  const digits = plus ? s.slice(1) : s;
  if (!digits || !/^\d+$/.test(digits)) return no('We cannot read that phone number.');
  const ok = (phone, e164, assumed) => ({ phone, e164, app: typed, ok: true, empty: false, assumed, reason: '' });

  if (plus) {
    if (digits.startsWith('44')) {
      // Repair 3: +44 (0)7700 900123.
      let national = digits.slice(2);
      if (national.charAt(0) === '0') national = national.slice(1);
      if (!ukNational(national)) return no(ukProblem(national));
      return ok('+44' + national, '+44' + national, false);
    }
    if (digits.length < 8) return no('That phone number is too short.');
    if (digits.length > 15) return no('That phone number is too long.');
    return ok('+' + digits, '+' + digits, false);
  }

  if (gb) {
    if (digits.startsWith('44') && digits.length > 10) {
      // Excel ate the + off +44 7954 412324. For a GB company 44 IS the UK code.
      const national = digits.slice(2);
      if (national.charAt(0) === '0') return no('That number has 44 and a 0 on the front. Write it as 07... or +44 7...');
      if (!ukNational(national)) return no(ukProblem(national));
      return ok(appPhone(digits), '+44' + national, false);
    }
    if (digits.charAt(0) === '0') {
      const national = digits.slice(1);
      if (!ukNational(national)) return no(ukProblem(national));
      return ok(appPhone(digits), '+44' + national, false);
    }
    // Repair 4: Excel ate the leading zero. Put it back and let the app's rule
    // decide. Only a real UK shape: a US 415 number in a UK file is refused.
    if (digits.length === 10 && ukNational(digits)) return ok(appPhone('0' + digits), '+44' + digits, true);
    if (digits.length < 10) return no('That phone number is too short. If it lost its 0, put the 0 back.');
    return no('We cannot read that phone number. Put + and the country code on the front.');
  }

  // Not GB, or we do not know the country: the app's own rule on the cell as it
  // stands. No zero, no country code, and a leading 44 is just digits.
  if (digits.length < 7) return no('That phone number is too short.');
  if (digits.length > 15) return no('That phone number is too long.');
  return ok(appPhone(digits), null, false);
}

/** The phone we would write for this cell, or null. */
export function writtenPhone(raw, opts) {
  const r = readPhone(raw, opts);
  return r.ok ? r.phone : null;
}

/**
 * Every value customers.phone could already hold for this cell: the shape we
 * write, the E.164 form an earlier importer wrote (only where readPhone would
 * build one, never invented), and the app's rule on the cell as typed. Empty
 * for a cell we cannot read.
 */
export function phoneKeys(raw, opts) {
  const out = [];
  const add = (v) => { if (v && out.indexOf(v) < 0) out.push(v); };
  const r = readPhone(raw, opts);
  if (r.ok) { add(r.phone); add(r.e164); add(r.app); }
  return out;
}

/**
 * The values customers.phone_raw could hold for this cell. phone_raw is what
 * somebody TYPED ('0161 496 0000'), so it is compared with the cell as the file
 * wrote it, never with a digits only key that it could not possibly equal.
 */
export function rawPhoneKeys(raw) {
  const out = [];
  if (raw == null) return out;
  const trimmed = String(raw).trim();
  const collapsed = cleanText(raw);
  if (trimmed && !isBlankWord(trimmed)) out.push(trimmed);
  if (collapsed && out.indexOf(collapsed) < 0 && !isBlankWord(collapsed)) out.push(collapsed);
  return out;
}

// ── other single values ─────────────────────────────────────────────────────

/**
 * An email in the shape the unique index uses: trimmed, lower case, and pulled
 * out of "Jane Smith <jane@x.com>" or "mailto:jane@x.com" if that is how the
 * old system or the spreadsheet wrote it.
 * Returns { email, ok, empty, reason }.
 */
export function normaliseEmail(raw) {
  let text = cleanText(raw);
  if (!text || isBlankWord(text)) return { email: null, ok: true, empty: true, reason: '' };
  const angled = text.match(/<([^>]+)>/);
  if (angled) text = angled[1].trim();
  if (/^mailto:/i.test(text)) text = text.slice(7).trim();
  const value = text.toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(value)) {
    return { email: null, ok: false, empty: false, reason: 'We cannot read that email.' };
  }
  return { email: value, ok: true, empty: false, reason: '' };
}

/**
 * A count of things: a whole number, 0 or more, blank meaning 0.
 * Returns { value, ok, empty, reason }.
 *
 * A spreadsheet writes 2 as 2.0, or as 2,0 where the comma is the decimal
 * point. Both are 2. 1,200 with a thousands comma is 1200. 2,5 is not a whole
 * number and is refused, never rounded.
 */
export function readWholeNumber(raw, max, label) {
  let text = cleanText(raw).replace(/\s/g, '');
  const what = label || 'That number';
  if (!text || isBlankWord(text)) return { value: 0, ok: true, empty: true, reason: '' };
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (/^[+-]?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return { value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  if (n < 0) return { value: 0, ok: false, empty: false, reason: what + ' cannot be less than 0.' };
  if (!Number.isInteger(n)) return { value: 0, ok: false, empty: false, reason: what + ' must be a whole number.' };
  if (typeof max === 'number' && n > max) return { value: 0, ok: false, empty: false, reason: what + ' is too high. Check the column.' };
  return { value: n === 0 ? 0 : n, ok: true, empty: false, reason: '' };
}

/**
 * MONEY out of whatever the other system wrote: '£12.50', '$5', '12,50',
 * '1,250.00', '12.5', '(3.00)' for a negative.
 *
 * Returns { minor, value, ok, empty, reason } where MINOR IS THE ANSWER: an
 * integer number of pence or cents, because that is what a balance is stored
 * and spent in. `value` is the same figure as a decimal, for showing back.
 *
 * Three decimal places or more is a refusal, not a rounding: '12.500' is far
 * more likely to be a thousands separator read the European way than half a
 * penny, and quietly turning it into £12.50 would be inventing money.
 */
export function readMoney(raw, max, label) {
  const what = label || 'That amount';
  let text = cleanText(raw).replace(/\s/g, '');
  if (!text || isBlankWord(text)) return { minor: 0, value: 0, ok: true, empty: true, reason: '' };
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/^[£$€]/, '').replace(/[£$€]$/, '');
  text = text.replace(/^(GBP|USD|EUR)/i, '');
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  if (text.startsWith('+')) text = text.slice(1);
  // 1,250.00 (thousands) vs 12,50 (European decimal). A comma with exactly two
  // digits after it and no dot anywhere is a decimal comma; otherwise commas
  // are thousands separators.
  if (/^\d+,\d{2}$/.test(text)) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { minor: 0, value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  }
  const dot = text.indexOf('.');
  if (dot >= 0 && text.length - dot - 1 > 2) {
    return { minor: 0, value: 0, ok: false, empty: false, reason: what + ' has too many decimal places to be money. Write it as 12.50.' };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { minor: 0, value: 0, ok: false, empty: false, reason: 'We cannot read ' + what.toLowerCase() + '.' };
  if (negative && n !== 0) return { minor: 0, value: 0, ok: false, empty: false, reason: what + ' cannot be less than 0.' };
  if (typeof max === 'number' && n > max) {
    return { minor: 0, value: 0, ok: false, empty: false, reason: what + ' is too high. Check the column.' };
  }
  // Round the multiplication, never trust it: 12.45 * 100 is 1244.9999... in
  // binary floating point, and |0 would bank 1244.
  const minor = Math.round(n * 100);
  return { minor, value: minor / 100, ok: true, empty: false, reason: '' };
}

/**
 * Yes or no out of whatever the other system, or the spreadsheet, wrote.
 * TRUE and FALSE are what a spreadsheet tick box saves as.
 * Returns { value, ok, empty, reason }, value true, false or null.
 * Blank is null, which means nobody said. It is not a yes.
 */
export function readYesNo(raw) {
  const text = cleanText(raw).toLowerCase();
  if (!text || isBlankWord(text)) return { value: null, ok: true, empty: true, reason: '' };
  for (let i = 0; i < YES_WORDS.length; i++) if (YES_WORDS[i] === text) return { value: true, ok: true, empty: false, reason: '' };
  for (let i = 0; i < NO_WORDS.length; i++) if (NO_WORDS[i] === text) return { value: false, ok: true, empty: false, reason: '' };
  return { value: null, ok: false, empty: false, reason: 'We cannot read yes or no there.' };
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function fullYear(y) {
  if (y >= 100) return y;
  return y < 80 ? 2000 + y : 1900 + y;
}

/** Today as 'YYYY-MM-DD'. The caller passes the venue's own date; only the last
 *  resort reads the machine clock, so the rules stay testable. */
function todayIso(opts) {
  const t = opts ? opts.today : null;
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (t instanceof Date && !isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

const DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?)?$/i;

/**
 * A date out of ISO or the shapes a spreadsheet writes.
 *
 * opts.country decides a date like 05/09/1984 that could be either:
 *  - GB: day first, 5 September. `ambiguous` comes back true, so validateRows
 *    can refuse it if the same column also holds a date that can only be month
 *    first (the sign a spreadsheet turned the column American).
 *  - US: month first, 9 May, and `ambiguous` is true the same way.
 *  - anything else, or not known: refused. We do not guess.
 * A date that can only be read one way is read that way, and `unusual` comes
 * back true when that is the opposite of the country's own order.
 *
 * Returns { date, ok, empty, monthFirst, ambiguous, unusual, reason }.
 * A date after today is refused. Pass { earliestYear } for a birthday.
 */
export function readDate(raw, opts) {
  const text = cleanText(raw);
  if (!text || isBlankWord(text)) return { date: null, ok: true, empty: true, monthFirst: false, ambiguous: false, unusual: false, reason: '' };
  const country = normaliseCountry(opts && opts.country);

  let y = 0;
  let m = 0;
  let d = 0;
  let monthFirst = false;
  let ambiguous = false;
  let unusual = false;
  const refuse = (reason) => ({ date: null, ok: false, empty: false, monthFirst, ambiguous, unusual, reason });

  if (/^\d{5}(\.\d+)?$/.test(text)) return refuse('That is a spreadsheet date number. Format the column as a date and save again.');

  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  const dmy = text.match(DMY);
  const dMonY = text.match(/^(\d{1,2})[\s-]+([a-z]+)[\s-]+(\d{2,4})$/i);
  const monDY = text.match(/^([a-z]+)[\s-]+(\d{1,2}),?[\s-]+(\d{2,4})$/i);

  if (iso) {
    y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]);
  } else if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    y = fullYear(Number(dmy[3]));
    const dayFirstOk = isRealDate(y, b, a);
    const monthFirstOk = isRealDate(y, a, b);
    if (dayFirstOk && monthFirstOk && a !== b) {
      ambiguous = true;
      if (country === 'GB') { d = a; m = b; } else if (country === 'US') { m = a; d = b; monthFirst = true; } else {
        return refuse('We cannot tell the day from the month. Write it as 1984-09-05.');
      }
    } else if (dayFirstOk) {
      d = a; m = b;
      unusual = country === 'US' && a !== b;
    } else if (monthFirstOk) {
      m = a; d = b; monthFirst = true;
      unusual = country !== 'US';
    } else {
      d = a; m = b;
    }
  } else if (dMonY) {
    d = Number(dMonY[1]);
    m = MONTHS[dMonY[2].toLowerCase()] || 0;
    y = fullYear(Number(dMonY[3]));
  } else if (monDY) {
    m = MONTHS[monDY[1].toLowerCase()] || 0;
    d = Number(monDY[2]);
    y = fullYear(Number(monDY[3]));
  } else {
    return refuse('We cannot read that date. Use 2025-04-12.');
  }

  if (!isRealDate(y, m, d)) return refuse('That date is not a real day.');

  const value = y + '-' + pad2(m) + '-' + pad2(d);
  if (value > todayIso(opts)) return refuse('That date is in the future.');
  const earliest = opts && typeof opts.earliestYear === 'number' ? opts.earliestYear : 0;
  if (earliest && y < earliest) return refuse('That date is too long ago to be right.');
  return { date: value, ok: true, empty: false, monthFirst, ambiguous, unusual, reason: '' };
}

// ── one row ─────────────────────────────────────────────────────────────────

/** The date columns, which validateRows checks as a column as well as a cell. */
const DATE_COLUMNS = ['opt_in_date', 'signed_up_date', 'birthday'];

/** The words in front of the reason when a birthday is left out and the row still goes in. */
export const BIRTHDAY_DROPPED = 'We left the birthday out. ';

function looksNormalised(row) {
  return !!row && typeof row === 'object' && Array.isArray(row.problems) && Object.prototype.hasOwnProperty.call(row, 'phoneRaw');
}

/**
 * Rows stripped back to the raw cells of the template and nothing else.
 *
 * normaliseRow hands an ALREADY normalised row straight back, which is the only
 * reason validateRows is safe to run on its own output. That passthrough is a
 * hole the moment the rows came off the wire: a caller could POST
 * { problems: [], phoneRaw: null, stamps: 100000, marketingOptIn: true } and
 * walk straight past validateRows, which is the edge function's single guard,
 * into a hundred thousand free coffees.
 *
 * So anything arriving from a browser goes through here first. Every key that
 * is not a template column is dropped, every cell becomes a string, and the
 * rules then run on the cells instead of on somebody's idea of the answer.
 */
export function rawRowsOnly(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const src = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const row = { rowNumber: typeof src.rowNumber === 'number' ? src.rowNumber : i + 2 };
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
 * opts: { today, country }. country is the company's, see countryFromVenue.
 *
 * `problems` stop the row being written. `warnings` do not: they are things we
 * dropped or read a particular way, and the screen shows them.
 *
 * The name is NEVER empty, because customers.name is NOT NULL and a null name
 * is refused without a word of explanation.
 */
export function normaliseRow(row, opts) {
  if (looksNormalised(row)) return row;
  const src = row && typeof row === 'object' ? row : {};
  const country = normaliseCountry(opts && opts.country);
  const problems = [];
  const warnings = [];
  const say = (list, field, message) => { list.push({ field, message }); };

  // A file saved in the wrong text encoding turns every accented letter into
  // the character that means "unreadable". Writing that into somebody's name is
  // worse than stopping, and the fix is one menu choice in the spreadsheet.
  for (let c = 0; c < TEMPLATE_COLUMNS.length; c++) {
    const cell = src[TEMPLATE_COLUMNS[c]];
    if (cell != null && String(cell).indexOf('�') >= 0) {
      say(problems, TEMPLATE_COLUMNS[c], 'This row has letters we cannot read. Save the file as CSV UTF-8 and pick it again.');
      break;
    }
  }

  const phoneRaw = src.phone == null ? '' : String(src.phone).trim();
  const p = readPhone(src.phone, { country });
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

  const points = readWholeNumber(src.points, MAX_POINTS, 'Points');
  if (!points.ok) say(problems, 'points', points.reason);

  // A gift card needs BOTH its code and its balance to mean anything. A balance
  // with no code is money we cannot attach to a card anybody holds, and a code
  // with no balance is an empty card, which is worse than no card at all
  // because the customer tries it at the till.
  const giftCode = cleanText(src.gift_card_code);
  const giftBalance = readMoney(src.gift_card_balance, MAX_GIFT_BALANCE, 'Gift card balance');
  if (!giftBalance.ok) say(problems, 'gift_card_balance', giftBalance.reason);
  else if (giftCode && giftBalance.empty) say(problems, 'gift_card_balance', 'This gift card has no balance. Give it one, or take the code out.');
  else if (!giftCode && !giftBalance.empty) say(problems, 'gift_card_code', 'There is a gift card balance here with no card code to put it on.');
  else if (giftCode && giftCode.length < 4) say(problems, 'gift_card_code', 'That gift card code is too short to be a real card.');

  const optIn = readYesNo(src.marketing_opt_in);
  if (!optIn.ok) say(problems, 'marketing_opt_in', optIn.reason);

  const today = opts ? opts.today : null;
  const reads = {
    opt_in_date: readDate(src.opt_in_date, { today, country }),
    signed_up_date: readDate(src.signed_up_date, { today, country }),
    birthday: readDate(src.birthday, { today, country, earliestYear: EARLIEST_BIRTH_YEAR }),
  };
  const dateFlags = {};
  for (let i = 0; i < DATE_COLUMNS.length; i++) {
    const col = DATE_COLUMNS[i];
    const r = reads[col];
    // A birthday is a nice to have. One that cannot be read is dropped, said
    // out loud, and the row (with its stamps and rewards) still goes in, the
    // same as a bad email. The two other dates still stop the row.
    if (!r.ok && col === 'birthday') say(warnings, col, BIRTHDAY_DROPPED + r.reason);
    else if (!r.ok) say(problems, col, r.reason);
    else if (r.unusual) say(warnings, col, country === 'US' ? 'We read that date as day first.' : 'We read that date as month first.');
    dateFlags[col] = r.ok && r.unusual ? 'unusual' : (r.ok && r.ambiguous ? 'ambiguous' : '');
  }

  return {
    rowNumber: typeof src.rowNumber === 'number' ? src.rowNumber : 0,
    name,
    firstName,
    lastName,
    phone: p.phone,
    phoneE164: p.e164,
    phoneApp: p.app,
    phoneRaw: phoneRaw || null,
    phoneAssumed: !!p.assumed,
    email: e.email,
    stamps: stamps.value,
    rewardsUnused: rewards.value,
    points: points.value,
    giftCardCode: giftCode || null,
    giftCardMinor: giftBalance.minor,
    marketingOptIn: optIn.value,
    optInDate: reads.opt_in_date.date,
    optInSource: cleanText(src.opt_in_source),
    signedUpDate: reads.signed_up_date.date,
    birthday: reads.birthday.date,
    externalId,
    notes: cleanText(src.notes),
    dates: {
      opt_in_date: cleanText(src.opt_in_date),
      signed_up_date: cleanText(src.signed_up_date),
      birthday: cleanText(src.birthday),
    },
    dateFlags,
    sharedWith: null,
    problems,
    warnings,
  };
}

// ── the whole file ──────────────────────────────────────────────────────────

function lineOf(rowNumber, message) {
  return 'Row ' + rowNumber + ': ' + message;
}

/** The keys two rows' phones can collide on: what we write and its E.164 form,
 *  so 0161 496 0000 on one row and +44 161 496 0000 on another are one number. */
function rowPhoneForms(r) {
  const out = [];
  const list = [r.phone, r.phoneE164];
  for (let i = 0; i < list.length; i++) if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i]);
  return out;
}

/**
 * Every row of the file, sorted into what we can write and what we cannot.
 *
 * opts: { today, country }.
 *
 * Returns { ready, errors, duplicatesInFile, warnings }.
 *  - ready            rows we would write, in file order
 *  - errors           one per problem, each naming its row number
 *  - duplicatesInFile rows left out because an earlier row already is them
 *  - warnings         things we did that the operator should see
 *
 * TWO ROWS, ONE PHONE. 5Loyalty let two accounts share a number, and the Coffee
 * Boy file has 140 numbers on 283 rows ("shares this phone with N other
 * account(s)" in notes). (org_id, phone) is unique, so only one of them can
 * have it. The FIRST row in the file keeps the phone. A later row that has its
 * own email still goes in, by email only, with the number named in the warning
 * so the operator can fix the sheet; nobody's stamps are dropped because of
 * somebody else's number. The same for two rows with one email: the later one
 * goes in by phone only. A row that has nothing of its own left (same phone and
 * no email, same email and no phone, or both the same) is left out and named,
 * because it IS the earlier row.
 *
 * THE DATE COLUMN CHECK. If any date in a column can only be read month first,
 * a spreadsheet has turned that column American, so every date in the same
 * column that could be read either way is refused instead of guessed.
 *
 * Rows may be raw (from readCsv) or already normalised. Running it twice on its
 * own output gives the same answer.
 */
export function validateRows(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const ready = [];
  const errors = [];
  const duplicatesInFile = [];
  const warnings = [];
  const seenPhone = new Map();
  const seenEmail = new Map();
  const seenGiftCode = new Map();
  const country = normaliseCountry(opts && opts.country);

  const all = [];
  for (let i = 0; i < list.length; i++) {
    const r = normaliseRow(list[i], opts);
    all.push({ r, rowNumber: r.rowNumber || i + 2 });
  }

  for (let c = 0; c < DATE_COLUMNS.length; c++) {
    const col = DATE_COLUMNS[c];
    let witness = null;
    for (let i = 0; i < all.length && !witness; i++) {
      if (all[i].r.dateFlags && all[i].r.dateFlags[col] === 'unusual') witness = all[i];
    }
    if (!witness) continue;
    const order = country === 'US' ? 'day first' : 'month first';
    const shown = witness.r.dates ? witness.r.dates[col] : '';
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      if (!it.r.dateFlags || it.r.dateFlags[col] !== 'ambiguous') continue;
      const message = 'Row ' + witness.rowNumber + ' has a ' + order + ' date in this column (' + shown + '), so we cannot trust this one. Write it as 1984-09-05.';
      const flags = { ...it.r.dateFlags };
      flags[col] = '';
      if (col === 'birthday') {
        // The column rule can reach thousands of rows. For a birthday it drops
        // the birthday only, never the person and their stamps.
        const dropped = BIRTHDAY_DROPPED + message;
        it.r = { ...it.r, birthday: null, dateFlags: flags, warnings: it.r.warnings.concat([{ field: col, message: dropped }]) };
      } else {
        it.r = { ...it.r, dateFlags: flags, problems: it.r.problems.concat([{ field: col, message }]) };
      }
    }
  }

  for (let i = 0; i < all.length; i++) {
    let r = all[i].r;
    const rowNumber = all[i].rowNumber;

    if (r.problems.length) {
      for (let j = 0; j < r.problems.length; j++) {
        const p = r.problems[j];
        errors.push({ rowNumber, field: p.field, message: p.message, text: lineOf(rowNumber, p.message) });
      }
    } else {
      const forms = rowPhoneForms(r);
      let phoneFirst = 0;
      for (let j = 0; j < forms.length && !phoneFirst; j++) phoneFirst = seenPhone.get(forms[j]) || 0;
      const emailFirst = r.email ? (seenEmail.get(r.email) || 0) : 0;

      let dup = '';
      let dupField = '';
      let dupFirst = 0;
      if (phoneFirst && emailFirst) {
        dup = phoneFirst === emailFirst
          ? 'Same phone and email as row ' + phoneFirst + '. We keep the first one.'
          : 'Same phone as row ' + phoneFirst + ' and same email as row ' + emailFirst + '. We keep the first ones.';
        dupField = 'phone';
        dupFirst = phoneFirst;
      } else if (phoneFirst && !r.email) {
        dup = 'Same phone as row ' + phoneFirst + ', and no email to tell them apart. We keep the first one.';
        dupField = 'phone';
        dupFirst = phoneFirst;
      } else if (emailFirst && !r.phone) {
        dup = 'Same email as row ' + emailFirst + ', and no phone to tell them apart. We keep the first one.';
        dupField = 'email';
        dupFirst = emailFirst;
      } else if (phoneFirst) {
        const message = 'Shares a phone with row ' + phoneFirst + ', so this one goes in by email only. The phone stays with row ' + phoneFirst + '.';
        r = {
          ...r,
          phone: null,
          phoneE164: null,
          phoneApp: null,
          phoneRaw: null,
          phoneAssumed: false,
          sharedWith: { field: 'phone', rowNumber: phoneFirst, value: r.phone || r.phoneRaw || '' },
          warnings: r.warnings.filter((w) => w.field !== 'phone').concat([{ field: 'phone', message }]),
        };
      } else if (emailFirst) {
        const message = 'Shares an email with row ' + emailFirst + ', so this one goes in by phone only. The email stays with row ' + emailFirst + '.';
        r = {
          ...r,
          email: null,
          sharedWith: { field: 'email', rowNumber: emailFirst, value: r.email || '' },
          warnings: r.warnings.concat([{ field: 'email', message }]),
        };
      }

      if (dup) {
        const value = dupField === 'phone' ? (r.phone || '') : (r.email || '');
        duplicatesInFile.push({ rowNumber, field: dupField, value, firstRowNumber: dupFirst, message: dup, text: lineOf(rowNumber, dup) });
      } else {
        // ONE CARD, ONE OWNER. A gift card code that appears twice in the file
        // is one physical card written against two people: whoever we put it on
        // last would own money the other customer is holding a card for. The
        // person still goes in; the card comes off the second row and is said
        // out loud, because dropping money silently is how a venue finds out at
        // the counter.
        if (r.giftCardCode) {
          const codeKey = r.giftCardCode.toUpperCase();
          const cardFirst = seenGiftCode.get(codeKey) || 0;
          if (cardFirst) {
            const message = 'Gift card ' + r.giftCardCode + ' is already on row ' + cardFirst + '. A card belongs to one person, so this row goes in without it.';
            r = {
              ...r,
              giftCardCode: null,
              giftCardMinor: 0,
              warnings: r.warnings.concat([{ field: 'gift_card_code', message }]),
            };
            warnings.push({ rowNumber, field: 'gift_card_code', message, text: lineOf(rowNumber, message) });
          } else {
            seenGiftCode.set(codeKey, rowNumber);
          }
        }
        const keep = rowPhoneForms(r);
        for (let j = 0; j < keep.length; j++) if (!seenPhone.has(keep[j])) seenPhone.set(keep[j], rowNumber);
        if (r.email && !seenEmail.has(r.email)) seenEmail.set(r.email, rowNumber);
        ready.push(r);
      }
    }

    for (let j = 0; j < r.warnings.length; j++) {
      const w = r.warnings[j];
      warnings.push({ rowNumber, field: w.field, message: w.message, text: lineOf(rowNumber, w.message) });
    }
  }

  return { ready, errors, duplicatesInFile, warnings };
}

/**
 * The raw cells we POST for the rows we would write, in file order.
 *
 * The server reads every row again from its cells, and it only ever sees one
 * slice of the file, so a row whose phone (or email) stays with an earlier row
 * has to ARRIVE without it. The number that stayed behind is written into the
 * notes, so it is not lost.
 */
export function rowsToSend(raw, checked) {
  const cells = new Map();
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].rowNumber) cells.set(list[i].rowNumber, list[i]);
  const ready = checked && Array.isArray(checked.ready) ? checked.ready : [];
  const out = [];
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i];
    const src = cells.get(r.rowNumber);
    if (!src) continue;
    const row = { rowNumber: r.rowNumber };
    for (let c = 0; c < TEMPLATE_COLUMNS.length; c++) {
      const v = src[TEMPLATE_COLUMNS[c]];
      row[TEMPLATE_COLUMNS[c]] = v == null ? '' : String(v);
    }
    if (r.sharedWith) {
      const f = r.sharedWith.field;
      const line = (f === 'phone' ? 'Phone ' : 'Email ') + r.sharedWith.value + ' kept on row ' + r.sharedWith.rowNumber + '.';
      row[f] = '';
      row.notes = cleanText(row.notes) ? cleanText(row.notes) + ' | ' + line : line;
    }
    out.push(row);
  }
  return out;
}

/** Distinct row numbers with something wrong with them. One row with three
 *  problems is ONE row, not three. */
export function problemRowNumbers(checked) {
  const c = checked || {};
  const errors = Array.isArray(c.errors) ? c.errors : [];
  const seen = new Set();
  for (let i = 0; i < errors.length; i++) {
    const n = errors[i] && errors[i].rowNumber;
    if (n) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * What the server said about each row, keyed by row number, or null when we
 * have not asked it. Takes a Map, or the `verdicts` list a preview answers with
 * ({ row_number, verdict, reason, customer_id }).
 *
 * This is THE answer to "do we already have this person", and the preview
 * tiles and the preview table both read it, so they can never disagree.
 */
export function verdictsByRow(verdicts) {
  if (verdicts == null) return null;
  if (verdicts instanceof Map) return verdicts;
  const out = new Map();
  const list = Array.isArray(verdicts) ? verdicts : [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (!v || typeof v !== 'object') continue;
    const n = Number(v.row_number != null ? v.row_number : v.rowNumber);
    if (!n) continue;
    const id = v.customer_id != null ? v.customer_id : v.customerId;
    out.set(n, { verdict: String(v.verdict || ''), reason: String(v.reason || ''), customerId: id != null ? String(id) : null });
  }
  return out;
}

/**
 * The numbers the preview screen shows before anybody presses Import.
 *
 * `rows` may be raw rows, normalised rows, or the result of validateRows.
 * `verdicts` is what the server said about each row (see verdictsByRow), or
 * null before it has been asked, in which case nobody is counted as new or
 * known: they are `unchecked`, and the screen says so.
 *
 * Counted as they can be emailed only where the file says yes AND there is an
 * email. A blank opt in column is nobody's yes.
 */
export function summarise(rows, verdicts, opts) {
  const checked = rows && !Array.isArray(rows) && Array.isArray(rows.ready)
    ? rows
    : validateRows(Array.isArray(rows) ? rows : [], opts);
  const byRow = verdictsByRow(verdicts);

  let newCustomers = 0;
  let alreadyKnown = 0;
  let blocked = 0;
  let unchecked = 0;
  let withStamps = 0;
  let stampsTotal = 0;
  let rewardsTotal = 0;
  let withPoints = 0;
  let pointsTotal = 0;
  let withGiftCards = 0;
  let giftMinorTotal = 0;
  let canEmail = 0;
  let canText = 0;
  let optedOut = 0;
  let notSaid = 0;
  let phoneFixed = 0;
  let sharedPhone = 0;
  let sharedEmail = 0;

  for (let i = 0; i < checked.ready.length; i++) {
    const r = checked.ready[i];
    const v = byRow ? byRow.get(r.rowNumber) : null;
    const verdict = v ? v.verdict : '';
    if (verdict === 'blocked') { blocked++; continue; }
    if (verdict === 'update') alreadyKnown++;
    else if (verdict === 'new') newCustomers++;
    else unchecked++;
    if (r.stamps > 0 || r.rewardsUnused > 0) withStamps++;
    stampsTotal += r.stamps;
    rewardsTotal += r.rewardsUnused;
    if (r.points > 0) { withPoints++; pointsTotal += r.points; }
    // The money figure is the one to say out loud before anybody presses the
    // button: it is the total this import is about to make spendable at the till.
    if (r.giftCardCode && r.giftCardMinor > 0) { withGiftCards++; giftMinorTotal += r.giftCardMinor; }
    if (r.marketingOptIn === true) {
      if (r.email) canEmail++;
      if (r.phone) canText++;
    } else if (r.marketingOptIn === false) optedOut++;
    else notSaid++;
    if (r.phoneAssumed) phoneFixed++;
    if (r.sharedWith && r.sharedWith.field === 'phone') sharedPhone++;
    if (r.sharedWith && r.sharedWith.field === 'email') sharedEmail++;
  }

  const problemRows = problemRowNumbers(checked);

  return {
    ready: checked.ready.length - blocked,
    newCustomers,
    alreadyKnown,
    blocked,
    unchecked,
    withStamps,
    stampsTotal,
    rewardsTotal,
    withPoints,
    pointsTotal,
    withGiftCards,
    giftMinorTotal,
    canEmail,
    canText,
    optedOut,
    notSaid,
    phoneFixed,
    sharedPhone,
    sharedEmail,
    problems: problemRows.length,
    duplicates: checked.duplicatesInFile.length,
    total: checked.ready.length + problemRows.length + checked.duplicatesInFile.length,
  };
}
