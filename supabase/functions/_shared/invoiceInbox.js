/**
 * _shared/invoiceInbox.js: the pure part of the invoice inbox (multi site stock Drop 3, v5.11.96,
 * contract 3.5). No imports, no I/O: Node's test runner loads it (src/lib/stock/invoiceInbox.test.js)
 * and the invoice-inbox edge function imports it under Deno.
 *
 * The inbound email provider is not chosen yet (open question 15), so the edge function answers 503
 * until it is. Whatever provider is picked, its webhook is turned into ONE provider neutral body
 *   { token, from, subject, files: [{ filename, mime, content_base64 }] }
 * and this file checks it, names each file's storage path (bucket stock-invoice-inbox,
 * org/<org_id>/<id>.<ext>) and builds the p_files of stock_inbox_receive. The placing itself (by
 * account number or delivery address) is the database's.
 */

export const INBOX_BUCKET = 'stock-invoice-inbox';
export const INBOX_MAX_BYTES = 10 * 1024 * 1024;
export const INBOX_MAX_FILES = 10;
export const INBOX_MIMES = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
});
const EXT_MIME = Object.freeze({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic' });

/** The token of an inbox address: 'invoices+<24 hex>@...' (any case) or a bare token; else null. */
export function tokenOf(s) {
  const t = String(s || '').trim().toLowerCase();
  const m = t.match(/^(?:[^+@\s]*\+)?([0-9a-f]{24})(?:@.*)?$/);
  return m ? m[1] : null;
}

/** The address an inbox token gives with a domain, or null without one. */
export function inboxAddress(token, domain) {
  const t = tokenOf(token);
  const d = String(domain || '').trim().replace(/^@/, '');
  return t && d ? `invoices+${t}@${d}` : null;
}

/** A file's mime from what it says, else from its name; null when it is not a type the inbox takes. */
export function mimeOf(mime, filename) {
  const m = String(mime || '').trim().toLowerCase();
  if (INBOX_MIMES[m]) return m;
  if (m === 'image/jpg') return 'image/jpeg';
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || null;
}

/** Bytes in a base64 string (padding counted off). */
export function base64Bytes(b64) {
  const s = String(b64 || '').replace(/\s+/g, '');
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/**
 * Check a provider neutral body. Answers { ok: true, token, from, subject, files, skipped } or
 * { ok: false, error } in plain words. A file of the wrong type or over 10 MB is skipped and
 * named; a body with no usable file is refused.
 */
export function parseInboxBody(body) {
  const token = tokenOf(body?.token);
  if (!token) return { ok: false, error: 'This inbox address is not known.' };
  const files = [];
  const skipped = [];
  for (const f of Array.isArray(body?.files) ? body.files : []) {
    const name = String(f?.filename || 'invoice').slice(0, 200);
    const mime = mimeOf(f?.mime, name);
    const bytes = base64Bytes(f?.content_base64);
    if (!mime) { skipped.push({ filename: name, why: 'Not a PDF or a picture.' }); continue; }
    if (!bytes) { skipped.push({ filename: name, why: 'The file is empty.' }); continue; }
    if (bytes > INBOX_MAX_BYTES) { skipped.push({ filename: name, why: 'Over 10 MB.' }); continue; }
    if (files.length >= INBOX_MAX_FILES) { skipped.push({ filename: name, why: 'More than 10 files in one email.' }); continue; }
    files.push({ filename: name, mime, bytes, content_base64: String(f.content_base64).replace(/\s+/g, '') });
  }
  if (!files.length) return { ok: false, error: 'The email had no invoice file (PDF or picture) to keep.', skipped };
  return {
    ok: true,
    token,
    from: String(body?.from || '').trim().slice(0, 320) || null,
    subject: String(body?.subject || '').trim().slice(0, 500) || null,
    files,
    skipped,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The storage path of one inbox file: org/<org_id>/<id>.<ext> (the bucket policies read it). */
export function inboxPath(orgId, id, mime) {
  if (!UUID.test(String(orgId || '')) || !UUID.test(String(id || ''))) return null;
  const ext = INBOX_MIMES[mime] || 'pdf';
  return `org/${String(orgId).toLowerCase()}/${String(id).toLowerCase()}.${ext}`;
}

/**
 * The p_files of stock_inbox_receive for the files of a checked body: ids are made by the caller
 * (crypto.randomUUID) so the same list names the uploads. scans: optional { [index]: scan jsonb }.
 */
export function receiveFiles(orgId, files, ids, scans = {}) {
  return (files || []).map((f, i) => ({
    file_path: inboxPath(orgId, ids?.[i], f.mime),
    file_name: f.filename,
    mime: f.mime,
    scan: scans?.[i] ?? null,
  })).filter((x) => x.file_path);
}

/** The inbox row's placing in words (the Inbox tab). */
export function placedWords(row) {
  if (!row) return '';
  if (row.status === 'ignored') return 'Ignored.';
  if (row.status === 'posted') return `Posted at ${row.site_name || 'the site'}.`;
  if (row.status === 'placed' || row.location_id) {
    const how = row.placed_how === 'account_number' ? ' by account number' : row.placed_how === 'address' ? ' by delivery address' : row.placed_how === 'by_hand' ? ' by hand' : '';
    return `Placed at ${row.site_name || 'a site'}${how}.`;
  }
  return 'Waiting: it could not be placed. Pick the site.';
}

/** The Inbox tab's top line (4.2). */
export function inboxLine(address) {
  return address
    ? `Send invoices to ${address}. Each one goes to the right site by account number or delivery address. Anything it cannot place waits here.`
    : 'The inbox email address is not set up yet. Upload invoices here instead.';
}
