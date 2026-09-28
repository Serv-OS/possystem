// src/lib/ops/formRules.js
//
// Operations Documents and Forms (28 Sep 2026, v5.11.4): the PURE rules.
// NO imports, so node:test loads it, and the tablet, Back Office and the data layer share it.
//
//   Documents: categories, the 20 MB limit, file type and name checks, bucket paths, opening.
//   Forms: field types, form and question checks, answer checks, answer text, finding a form
//   by name, searching and paging completed forms, CSV export and the print page.
//   (28 Sep 2026: no ready made forms. Every form is built and named by the venue, an
//   "Accident book" included; Peter's call.)
//
// MIRRORS supabase/migrations/20260928c_OPS_documents_forms.sql: the category keys, the
// 20 MB limit, the private 'ops-files' bucket and its paths
//   <location_id>/documents/<document_id>/<file name>
//   <location_id>/forms/<submission_id>/<question id>-<tag>.<ext>
// The storage rules key on those first two folders. Change both together.

export const OPS_FILES_BUCKET = 'ops-files';
export const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 20 MB, the bucket's own limit too
export const SIGNED_URL_SECONDS = 300;            // a document link lives 5 minutes
export const VIEW_URL_SECONDS = 600;              // photos and signatures in a submission, 10 minutes

// ── "not set up yet" (the migration has not run) ──────────────────────────────
export const NOT_SET_UP = {
  documents: 'Documents are not set up yet. The database update for Documents and Forms (20260928c) needs to run first.',
  forms: 'Forms are not set up yet. The database update for Documents and Forms (20260928c) needs to run first.',
};
const ABSENT_CODES = ['PGRST205', '42P01', 'PGRST202', '42883', '42703', 'PGRST204'];
const messageOf = (e) => (typeof e === 'string' ? e : String(e?.message || ''));

/** True when the error means the migration is not applied yet: a missing table, column,
 *  function or bucket. Never true for a refusal (row level security) or a network fault. */
export function isAbsentError(err) {
  if (!err) return false;
  if (typeof err === 'object' && ABSENT_CODES.includes(String(err.code || ''))) return true;
  const msg = messageOf(err).toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table')
    || msg.includes('schema cache') || msg.includes('bucket not found');
}

// ── ids ──────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => UUID_RE.test(String(s || ''));

/** A v4 uuid. The app mints document and submission ids so the file path can be named
 *  before the row exists. */
export function newId(cryptoImpl) {
  const c = cryptoImpl || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A short random tag for a file name (a retried submit never reuses an earlier photo's path). */
export function shortTag(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36) % 36];
  return s;
}

// ── Documents ────────────────────────────────────────────────────────────────
export const DOC_CATEGORIES = [
  { key: 'food_safety', label: 'Food safety' },
  { key: 'health_safety', label: 'Health and safety' },
  { key: 'certificates', label: 'Certificates' },
  { key: 'policies', label: 'Policies' },
  { key: 'other', label: 'Other' },
];
const DOC_CATEGORY_KEYS = DOC_CATEGORIES.map((c) => c.key);
export const isDocCategory = (key) => DOC_CATEGORY_KEYS.includes(key);
export const docCategoryLabel = (key) => (DOC_CATEGORIES.find((c) => c.key === key) || DOC_CATEGORIES[4]).label;

/** 0 B, 950 B, 12 KB, 3.4 MB. */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${Math.max(0, Math.round(b))} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

const EXT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv', txt: 'text/plain', rtf: 'application/rtf',
};
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'];
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** 'Menu.PDF' gives 'pdf'; no extension gives ''. */
export function fileExtension(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

/** The content type stored with the file: the browser's own when it is a clean type, else
 *  the extension's, else a plain binary type. Any type is allowed. */
export function contentTypeFor(file) {
  const t = String(file?.type || '').trim().toLowerCase();
  if (t && MIME_RE.test(t)) return t;
  return EXT_TYPES[fileExtension(file?.name)] || 'application/octet-stream';
}

/** A broad kind, for the icon and the word next to a document. */
export function fileKind(name, type) {
  const t = String(type || '').toLowerCase();
  const ext = fileExtension(name);
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image';
  if (/word|opendocument\.text|rtf/.test(t) || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) return 'word';
  if (/sheet|excel|csv/.test(t) || ['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (/presentation|powerpoint/.test(t) || ['ppt', 'pptx'].includes(ext)) return 'slides';
  if (t.startsWith('text/') || ext === 'txt') return 'text';
  return 'other';
}
const KIND_WORD = { pdf: 'PDF', image: 'Image', word: 'Document', sheet: 'Spreadsheet', slides: 'Slides', text: 'Text', other: 'File' };
export const fileKindWord = (kind) => KIND_WORD[kind] || 'File';

/** Size and presence check for any upload into the bucket. { ok, error }. */
export function checkDocumentFile(file) {
  if (!file) return { ok: false, error: 'Choose a file first.' };
  const size = Number(file.size);
  if (!Number.isFinite(size) || size < 0) return { ok: false, error: 'That file could not be read. Choose it again.' };
  if (size === 0) return { ok: false, error: 'That file is empty.' };
  if (size > MAX_FILE_BYTES) return { ok: false, error: `That file is ${formatBytes(size)}. The limit is 20 MB.` };
  return { ok: true, error: '' };
}

/** A photo answer: the same size rule, and it must be a picture. */
export function checkPhotoFile(file) {
  const base = checkDocumentFile(file);
  if (!base.ok) return base;
  if (fileKind(file.name, file.type) !== 'image') return { ok: false, error: 'That is not a photo. Choose a JPG, PNG or HEIC picture.' };
  return { ok: true, error: '' };
}

/** Title, category and file for a new document. { ok, errors: { title, category, file } }. */
export function checkDocumentDraft({ title, category, file } = {}) {
  const errors = {};
  const t = String(title || '').trim();
  if (!t) errors.title = 'Give the document a title.';
  else if (t.length > 200) errors.title = 'Keep the title under 200 characters.';
  if (!isDocCategory(category)) errors.category = 'Choose a category.';
  const f = checkDocumentFile(file);
  if (!f.ok) errors.file = f.error;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** A storage safe file name: letters, digits, dot, dash, underscore; the extension kept. */
export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const ext = fileExtension(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const clean = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  const s = clean(stem).slice(0, 100) || 'file';
  return ext ? `${s}.${ext}` : s;
}

/** 'Fire-risk_assessment 2026.pdf' gives 'Fire risk assessment 2026'. */
export function titleFromFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const ext = fileExtension(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export const documentPath = (locationId, documentId, fileName) =>
  `${locationId}/documents/${documentId}/${safeFileName(fileName)}`;
export const formFilePath = (locationId, submissionId, fieldId, ext, tag) =>
  `${locationId}/forms/${submissionId}/${fieldId}${tag ? `-${tag}` : ''}.${ext || 'bin'}`;

/** Is this a path the storage rules put in this venue's documents or forms folder? */
export function pathInVenue(path, locationId, kind) {
  const parts = String(path || '').split('/');
  return parts.length >= 3 && parts[0] === String(locationId) && parts[1] === kind && parts.every(Boolean);
}

/**
 * How a document opens here (28 Sep 2026):
 *   'tab'      a browser: a new tab, opened from the tap before the signed link is fetched.
 *   'navigate' the Android device shell (android/webshell ShellActivity): a page link off
 *              app.serv-os.app goes to the phone's own viewer and the app stays put.
 *   'viewer'   the iOS shells (ios/ServOSPOS/WebView.swift, the old RestaurantOS app) and the
 *              Sunmi till app: they keep every *.supabase.co link INSIDE the app, with no back
 *              gesture, so a file link would replace the app. Show it in an in-app viewer
 *              with a Close button instead.
 */
export function docOpenMode(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return 'tab';
  const ua = String(w.navigator?.userAgent || '');
  if ((w.RposIOS && typeof w.RposIOS === 'object') || /\bRposIOS\//.test(ua) || /\bRestaurantOS\//.test(ua)) return 'viewer';
  if ((w.RposAndroid && typeof w.RposAndroid === 'object') || /\bRposAndroid\//.test(ua)) return 'navigate';
  return 'tab';
}

// ── Forms: questions ─────────────────────────────────────────────────────────
export const FIELD_TYPES = [
  { key: 'short_text', label: 'Short text' },
  { key: 'long_text', label: 'Long text' },
  { key: 'number', label: 'Number' },
  { key: 'date', label: 'Date' },
  { key: 'time', label: 'Time' },
  { key: 'yes_no', label: 'Yes or no' },
  { key: 'single_choice', label: 'Single choice' },
  { key: 'multi_choice', label: 'Multiple choice' },
  { key: 'photo', label: 'Photo' },
  { key: 'signature', label: 'Signature' },
];
const FIELD_TYPE_KEYS = FIELD_TYPES.map((t) => t.key);
export const CHOICE_TYPES = ['single_choice', 'multi_choice'];
export const FILE_TYPES = ['photo', 'signature'];
export const isFieldType = (t) => FIELD_TYPE_KEYS.includes(t);
export const fieldTypeLabel = (t) => (FIELD_TYPES.find((x) => x.key === t) || FIELD_TYPES[0]).label;

export const LIMITS = {
  name: 200, description: 1000, fields: 100,
  label: 200, help: 500, option: 100, options: 50,
  shortText: 500, longText: 5000,
};
const FIELD_ID_RE = /^[a-z0-9_]{1,40}$/;

/** A new question id, unique within the form. */
export function newFieldId(existing = [], rand = Math.random) {
  const taken = new Set(existing);
  for (let i = 0; i < 50; i++) {
    const id = `f_${shortTag(rand)}`;
    if (!taken.has(id)) return id;
  }
  return `f_${Date.now().toString(36)}`;
}

export function blankField(type = 'short_text', existing = [], rand = Math.random) {
  const t = isFieldType(type) ? type : 'short_text';
  return {
    id: newFieldId(existing, rand), type: t, label: '', help: '', required: false,
    options: CHOICE_TYPES.includes(t) ? ['Option 1', 'Option 2'] : [],
  };
}

/** One question as the database keeps it (trimmed, a known type, options only for choices). */
export function normaliseField(f) {
  const type = isFieldType(f?.type) ? f.type : 'short_text';
  const seen = new Set();
  const options = CHOICE_TYPES.includes(type)
    ? (Array.isArray(f?.options) ? f.options : [])
      .map((o) => String(o ?? '').trim()).filter((o) => {
        const k = o.toLowerCase();
        if (!o || seen.has(k)) return false;
        seen.add(k); return true;
      })
    : [];
  return {
    id: String(f?.id ?? '').trim(),
    type,
    label: String(f?.label ?? '').trim(),
    help: String(f?.help ?? '').trim(),
    required: f?.required === true,
    options,
  };
}

export function normaliseForm(form) {
  return {
    ...form,
    name: String(form?.name ?? '').trim(),
    description: String(form?.description ?? '').trim(),
    fields: (Array.isArray(form?.fields) ? form.fields : []).map(normaliseField),
  };
}

/** Problems with one question (raw, as typed). An empty list means it is fine. */
export function validateFieldDef(field) {
  const out = [];
  const id = String(field?.id ?? '').trim();
  if (!FIELD_ID_RE.test(id)) out.push('This question has no usable id. Remove it and add it again.');
  if (!isFieldType(field?.type)) out.push('Choose a question type.');
  const label = String(field?.label ?? '').trim();
  if (!label) out.push('Every question needs a label.');
  else if (label.length > LIMITS.label) out.push(`Keep the label under ${LIMITS.label} characters.`);
  if (String(field?.help ?? '').trim().length > LIMITS.help) out.push(`Keep the help line under ${LIMITS.help} characters.`);
  if (CHOICE_TYPES.includes(field?.type)) {
    const raw = (Array.isArray(field?.options) ? field.options : []).map((o) => String(o ?? '').trim()).filter(Boolean);
    const unique = new Set(raw.map((o) => o.toLowerCase()));
    if (unique.size < 2) out.push('A choice question needs at least 2 options.');
    if (unique.size !== raw.length) out.push('Two options are the same.');
    if (raw.length > LIMITS.options) out.push(`Keep it to ${LIMITS.options} options.`);
    if (raw.some((o) => o.length > LIMITS.option)) out.push(`Keep each option under ${LIMITS.option} characters.`);
  }
  return out;
}

/** The whole form. { ok, errors: [form level], fieldErrors: { index: [messages] } }. */
export function validateFormDef(form) {
  const errors = [];
  const fieldErrors = {};
  const name = String(form?.name ?? '').trim();
  if (!name) errors.push('Give the form a name.');
  else if (name.length > LIMITS.name) errors.push(`Keep the name under ${LIMITS.name} characters.`);
  if (String(form?.description ?? '').trim().length > LIMITS.description) errors.push(`Keep the description under ${LIMITS.description} characters.`);
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  if (fields.length === 0) errors.push('Add at least one question.');
  if (fields.length > LIMITS.fields) errors.push(`Keep it to ${LIMITS.fields} questions.`);
  const ids = new Set();
  fields.forEach((f, i) => {
    const probs = validateFieldDef(f);
    const id = String(f?.id ?? '').trim();
    if (id && ids.has(id)) probs.push('Two questions share an id. Remove one and add it again.');
    ids.add(id);
    if (probs.length) fieldErrors[i] = probs;
  });
  const firstField = Object.keys(fieldErrors).map(Number).sort((a, b) => a - b)[0];
  if (firstField != null && !errors.length) errors.push(`Question ${firstField + 1}: ${fieldErrors[firstField][0]}`);
  return { ok: errors.length === 0 && Object.keys(fieldErrors).length === 0, errors, fieldErrors };
}

// ── Forms: answers ───────────────────────────────────────────────────────────
const isFileLike = (v) => !!v && typeof v === 'object' && typeof v.size === 'number';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const SIGNATURE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function realDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Has this question been answered at all? */
export function isAnswered(field, value) {
  if (value == null) return false;
  switch (field?.type) {
    case 'photo': return isFileLike(value) || (typeof value === 'string' && value.trim() !== '');
    case 'signature': return typeof value === 'string' && value.trim() !== '';
    case 'multi_choice': return Array.isArray(value) && value.length > 0;
    case 'yes_no': return value === 'yes' || value === 'no';
    default: return String(value).trim() !== '';
  }
}

/** The problem with one answer, or '' when it is fine. */
export function validateAnswer(field, value) {
  if (!isAnswered(field, value)) return field?.required ? 'This is required.' : '';
  const s = typeof value === 'string' ? value.trim() : value;
  switch (field.type) {
    case 'short_text': return s.length > LIMITS.shortText ? `Keep this under ${LIMITS.shortText} characters.` : '';
    case 'long_text': return s.length > LIMITS.longText ? `Keep this under ${LIMITS.longText} characters.` : '';
    case 'number': return NUMBER_RE.test(String(s)) ? '' : 'Enter a number.';
    case 'date': return realDate(s) ? '' : 'Enter a date.';
    case 'time': return TIME_RE.test(String(s)) ? '' : 'Enter a time.';
    case 'yes_no': return '';
    case 'single_choice': return (field.options || []).includes(s) ? '' : 'Choose one of the options.';
    case 'multi_choice': return value.every((v) => (field.options || []).includes(v)) ? '' : 'Choose from the options.';
    case 'photo': return isFileLike(value) ? checkPhotoFile(value).error : '';
    case 'signature': return SIGNATURE_RE.test(s) || !s.startsWith('data:') ? '' : 'Sign in the box again.';
    default: return '';
  }
}

/** Every answer. { ok, errors: { questionId: message } }. */
export function validateAnswers(fields, answers) {
  const errors = {};
  (fields || []).forEach((f) => {
    const msg = validateAnswer(f, (answers || {})[f.id]);
    if (msg) errors[f.id] = msg;
  });
  return { ok: Object.keys(errors).length === 0, errors };
}

/** The answers as they are stored: known questions only, text trimmed, numbers as numbers,
 *  choices in the form's order. A photo stays a File and a signature a data URL here; the
 *  data layer swaps each for its bucket path after the upload. */
export function cleanAnswers(fields, answers) {
  const out = {};
  (fields || []).forEach((f) => {
    const v = (answers || {})[f.id];
    if (!isAnswered(f, v)) return;
    if (f.type === 'number') out[f.id] = Number(String(v).trim());
    else if (f.type === 'multi_choice') out[f.id] = (f.options || []).filter((o) => v.includes(o));
    else if (f.type === 'photo' || f.type === 'signature' || f.type === 'yes_no') out[f.id] = v;
    else out[f.id] = String(v).trim();
  });
  return out;
}

/** 'data:image/png;base64,...' to { mime, bytes }, or null. */
export function dataUrlToBytes(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };
export const extForMime = (mime) => MIME_EXT[String(mime || '').toLowerCase()] || '';

// ── Showing answers ──────────────────────────────────────────────────────────
/** '2026-09-28' gives '28/09/2026'; anything else comes back as it is. */
export function ukDate(s) {
  const m = DATE_RE.exec(String(s || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s ?? '');
}

/** One answer as words. Photos and signatures say they are there (their links expire). */
export function answerText(field, value) {
  if (!isAnswered(field, value)) return '';
  switch (field?.type) {
    case 'yes_no': return value === 'yes' ? 'Yes' : 'No';
    case 'multi_choice': return value.join(', ');
    case 'photo': return 'Photo attached';
    case 'signature': return 'Signed';
    case 'date': return ukDate(value);
    default: return String(value);
  }
}

/** The questions to show for a list of submissions: the form's own first, then any question a
 *  submission was made with that the form no longer has (a question removed later). */
export function submissionFields(form, submissions) {
  const out = [];
  const seen = new Set();
  const add = (f) => { if (f && f.id && !seen.has(f.id)) { seen.add(f.id); out.push(normaliseField(f)); } };
  (form?.fields || []).forEach(add);
  (submissions || []).forEach((s) => (s?.fields || []).forEach(add));
  return out;
}

/** '28/09/2026 14:05' on the venue's clock. */
export function formatWhen(iso, timeZone) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
  } catch {
    return formatWhen(iso, 'Europe/London');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** One CSV cell. Quoted when needed, and text that a spreadsheet would run as a formula
 *  (starting = + - @) gets a leading apostrophe. Plain numbers are left alone. */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER_RE.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** All submissions of one form as CSV (CRLF lines). */
export function submissionsToCsv(form, submissions, { timeZone } = {}) {
  const fields = submissionFields(form, submissions);
  const head = ['Submitted at', 'Submitted by', ...fields.map((f) => f.label || f.id)];
  const rows = (submissions || []).map((s) => [
    formatWhen(s.submittedAt, timeZone),
    s.submittedByName || '',
    ...fields.map((f) => answerText(f, (s.answers || {})[f.id])),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

const fileDate = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 'accident-book-submissions-2026-09-28.csv'. */
export function csvFileName(formName, now = new Date()) {
  const slug = String(formName || 'form').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'form';
  return `${slug}-submissions-${fileDate(now)}.csv`;
}

/** 'completed-forms-2026-09-28.csv': every kind of form in one file. */
export const completedCsvFileName = (now = new Date()) => `completed-forms-${fileDate(now)}.csv`;

// \u2500\u2500 Finding a form, and finding completed forms (28 Sep 2026) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Peter: "we don't want an accident book [template]. We will have a form called accident book,
// but [we need] the ability to pull forms up so we can name each form, then find the
// different types of forms completed." The tablet finds a form by its name. Back Office,
// Operations, Forms, Completed forms lists every submission at the venue, filtered by form,
// by a search over the answers and who submitted, and by a date range.

/** The API returns at most 1,000 rows per request, so completed forms are read in pages. */
export const PAGE_ROWS = 1000;
/** The most completed forms one list holds; narrow the dates to reach older ones. */
export const MAX_COMPLETED_ROWS = 20000;

/** The words of a search, lower case: '  Accident  BOOK ' gives ['accident', 'book']. */
export const searchWords = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

/** Does this (lower case) text hold every word? */
export const textHasWords = (text, words) => (words || []).every((w) => String(text || '').includes(w));

/** Forms whose name holds every word typed, in any order and any case (the tablet's search). */
export function filterFormsByName(forms, query) {
  const list = Array.isArray(forms) ? forms : [];
  const words = searchWords(query);
  if (!words.length) return list;
  return list.filter((f) => textHasWords(String(f?.name || '').toLowerCase(), words));
}

/** What a completed form is searched by, lower case: who submitted it and every answer as
 *  words (a date both as 28/09/2026 and 2026-09-28). Never a stored file path. */
export function submissionSearchText(submission) {
  const fields = Array.isArray(submission?.fields) ? submission.fields : [];
  const ans = submission?.answers || {};
  const parts = [String(submission?.submittedByName || '')];
  fields.forEach((raw) => {
    const f = normaliseField(raw);
    const v = ans[f.id];
    const t = answerText(f, v);
    if (t) parts.push(t);
    if (f.type === 'date' && typeof v === 'string' && t !== v) parts.push(v);
  });
  return parts.join('\n').toLowerCase();
}

/** Does a completed form match the search? An empty search matches everything. */
export function submissionMatches(submission, query) {
  const words = searchWords(query);
  return !words.length || textHasWords(submissionSearchText(submission), words);
}

/** A date range filter in venue calendar days, either end optional. '' when it is fine. */
export function dateRangeProblem(fromYmd, toYmd) {
  if (fromYmd && !realDate(fromYmd)) return 'The From date is not a real date.';
  if (toYmd && !realDate(toYmd)) return 'The To date is not a real date.';
  if (fromYmd && toYmd && fromYmd > toYmd) return 'The From date is after the To date.';
  return '';
}

/** How a date range reads: 'all dates', 'on 28/09/2026', 'from 01/09/2026',
 *  'up to 28/09/2026' or '01/09/2026 to 28/09/2026'. */
export function dateRangeText(fromYmd, toYmd) {
  if (fromYmd && toYmd) return fromYmd === toYmd ? `on ${ukDate(fromYmd)}` : `${ukDate(fromYmd)} to ${ukDate(toYmd)}`;
  if (fromYmd) return `from ${ukDate(fromYmd)}`;
  if (toYmd) return `up to ${ukDate(toYmd)}`;
  return 'all dates';
}

/**
 * Read every row of one query in range pages of PAGE_ROWS. `fetchPage(from, to)` asks for
 * rows from..to (inclusive) in ONE fixed order (submitted_at, then id, newest first) and
 * returns { data, error }. Stops at a short page, an error, or `max` rows.
 * Each row is kept once, by id: a submission that lands while the pages are read goes to the
 * top (the database stamps its time) and pushes the rest down one place, so a page can
 * repeat the row before it but never skip one. Submissions are never deleted.
 * `onPage(rowsSoFar)` runs after each full page, so a list can show the first rows early.
 * @returns {Promise<{ data: object[], error: any, capped: boolean }>} capped: there may be more.
 */
export async function readAllPages(fetchPage, { pageSize = PAGE_ROWS, max = MAX_COMPLETED_ROWS, onPage = null } = {}) {
  const out = [];
  const seen = new Set();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = (await fetchPage(from, from + pageSize - 1)) || {};
    if (error) return { data: out, error, capped: false };
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      const id = r?.id;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      out.push(r);
    }
    if (rows.length < pageSize) return { data: out, error: null, capped: false };
    if (out.length >= max) return { data: out.slice(0, max), error: null, capped: true };
    if (onPage) onPage(out.slice());
  }
}

/** A one line preview of a completed form: its first answered text or choice question. */
export function submissionPreview(submission) {
  const ans = submission?.answers || {};
  for (const raw of (Array.isArray(submission?.fields) ? submission.fields : [])) {
    const f = normaliseField(raw);
    if (!['short_text', 'long_text', 'single_choice'].includes(f.type)) continue;
    const t = answerText(f, ans[f.id]);
    if (t) return { label: f.label || '', text: t.replace(/\s+/g, ' ').trim() };
  }
  return null;
}

/**
 * Completed forms of every kind as one CSV (CRLF lines): Submitted at, Form, Submitted by,
 * then each form's questions headed "Form name: question", forms in name order. A row fills
 * only its own form's columns. `forms` (the venue's forms) gives each form's current name and
 * question order; questions a submission was made with that the form no longer has follow,
 * as in submissionsToCsv.
 */
export function completedFormsToCsv(submissions, { forms = [], timeZone } = {}) {
  const list = Array.isArray(submissions) ? submissions : [];
  const byId = new Map((forms || []).filter((f) => f && f.id).map((f) => [f.id, f]));
  const keyOf = (s) => String(s?.formId || s?.formName || '');
  const nameOf = (s) => byId.get(s?.formId)?.name || s?.formName || 'Form';
  const groups = new Map();
  list.forEach((s) => {
    const k = keyOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  });
  const keys = [...groups.keys()].sort((a, b) => (
    nameOf(groups.get(a)[0]).localeCompare(nameOf(groups.get(b)[0]), 'en', { sensitivity: 'base' }) || a.localeCompare(b)
  ));
  const cols = [];
  keys.forEach((k) => {
    const rows = groups.get(k);
    const name = nameOf(rows[0]);
    submissionFields(byId.get(rows[0]?.formId) || null, rows)
      .forEach((f) => cols.push({ k, f, head: `${name}: ${f.label || f.id}` }));
  });
  const head = ['Submitted at', 'Form', 'Submitted by', ...cols.map((c) => c.head)];
  const body = list.map((s) => {
    const k = keyOf(s);
    return [
      formatWhen(s.submittedAt, timeZone), nameOf(s), s.submittedByName || '',
      ...cols.map((c) => (c.k === k ? answerText(c.f, (s.answers || {})[c.f.id]) : '')),
    ];
  });
  return [head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Every stored file path in a submission's answers (photos and signatures). */
export function submissionFilePaths(submission) {
  const fields = Array.isArray(submission?.fields) ? submission.fields : [];
  const ans = submission?.answers || {};
  return fields.filter((f) => FILE_TYPES.includes(f.type))
    .map((f) => ans[f.id]).filter((v) => typeof v === 'string' && v && !v.startsWith('data:'));
}

/** A print page for one submission (the browser's print view). Pictures only from https links. */
export function buildSubmissionPrintHtml({ formName, submission, venueName, timeZone, fileUrls = {}, printedAt = new Date() }) {
  const fields = (submission?.fields || []).map(normaliseField);
  const ans = submission?.answers || {};
  const rows = fields.map((f) => {
    const v = ans[f.id];
    let cell;
    if (FILE_TYPES.includes(f.type) && typeof v === 'string' && /^https:\/\//.test(fileUrls[v] || '')) {
      cell = `<img src="${escapeHtml(fileUrls[v])}" alt="${escapeHtml(f.label)}" class="${f.type === 'signature' ? 'sig' : 'photo'}">`;
    } else {
      const t = answerText(f, v);
      cell = t ? escapeHtml(t).replace(/\n/g, '<br>') : '<span class="none">No answer</span>';
    }
    return `<tr><th>${escapeHtml(f.label || f.id)}</th><td>${cell}</td></tr>`;
  }).join('');
  const title = escapeHtml(formName || submission?.formName || 'Form');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0F1211; margin:28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#5b6660; font-size:12px; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { border:1px solid #d7ddd9; padding:8px 10px; text-align:left; vertical-align:top; }
  th { width:34%; background:#f3f6f4; font-weight:600; }
  img.photo { max-width:320px; max-height:320px; }
  img.sig { max-width:320px; max-height:120px; background:#fff; }
  .none { color:#7a847e; font-style:italic; }
  .foot { margin-top:18px; color:#7a847e; font-size:10px; }
  tr { page-break-inside:avoid; }
</style></head>
<body onload="window.focus();window.print();">
  <h1>${title}</h1>
  <div class="sub">${escapeHtml(venueName || '')}${venueName ? ' &middot; ' : ''}Submitted ${escapeHtml(formatWhen(submission?.submittedAt, timeZone))}${submission?.submittedByName ? ` by ${escapeHtml(submission.submittedByName)}` : ''}</div>
  <table>${rows}</table>
  <div class="foot">Printed ${escapeHtml(formatWhen(printedAt, timeZone))} from ServOS Operations.</div>
</body></html>`;
}
