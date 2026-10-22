// src/lib/stock/invoiceInbox.test.js: the pure part of the invoice inbox (multi site stock Drop 3,
// v5.11.96, contract 3.5). The edge function answers 503 until the inbound provider is chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import {
  tokenOf, inboxAddress, mimeOf, base64Bytes, parseInboxBody, inboxPath, receiveFiles, placedWords, inboxLine,
  INBOX_BUCKET, INBOX_MAX_BYTES,
} from '../../../supabase/functions/_shared/invoiceInbox.js';

const TOKEN = '0123456789abcdef01234567';
const ORG = '11111111-2222-3333-4444-555555555555';
const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const B64 = Buffer.from('%PDF-1.4 synthetic').toString('base64');

test('tokenOf and inboxAddress', () => {
  assert.equal(tokenOf(TOKEN), TOKEN);
  assert.equal(tokenOf(`invoices+${TOKEN.toUpperCase()}@in.example.test`), TOKEN);
  assert.equal(tokenOf('invoices+short@x'), null);
  assert.equal(tokenOf(null), null);
  assert.equal(inboxAddress(TOKEN, 'in.example.test'), `invoices+${TOKEN}@in.example.test`);
  assert.equal(inboxAddress(TOKEN, ''), null, 'no domain yet: no address');
});

test('mimeOf and base64Bytes', () => {
  assert.equal(mimeOf('application/pdf', 'a.pdf'), 'application/pdf');
  assert.equal(mimeOf('', 'scan.JPEG'), 'image/jpeg');
  assert.equal(mimeOf('image/jpg', 'x'), 'image/jpeg');
  assert.equal(mimeOf('text/html', 'x.html'), null);
  assert.equal(base64Bytes(Buffer.from('abcd').toString('base64')), 4);
  assert.equal(base64Bytes(Buffer.from('abcde').toString('base64')), 5);
  assert.equal(base64Bytes(''), 0);
});

test('parseInboxBody keeps PDFs and pictures, skips the rest with words', () => {
  const big = 'A'.repeat(Math.ceil((INBOX_MAX_BYTES + 10) * 4 / 3));
  const r = parseInboxBody({ token: TOKEN, from: 'Supplier <bills@example.test>', subject: 'Invoice 12', files: [
    { filename: 'inv.pdf', mime: 'application/pdf', content_base64: B64 },
    { filename: 'logo.gif', mime: 'image/gif', content_base64: B64 },
    { filename: 'huge.pdf', mime: 'application/pdf', content_base64: big },
    { filename: 'empty.png', mime: 'image/png', content_base64: '' },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.token, TOKEN);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].mime, 'application/pdf');
  assert.deepEqual(r.skipped.map((s) => s.why), ['Not a PDF or a picture.', 'Over 10 MB.', 'The file is empty.']);
  assert.deepEqual(parseInboxBody({ token: 'nope', files: [] }), { ok: false, error: 'This inbox address is not known.' });
  assert.equal(parseInboxBody({ token: TOKEN, files: [] }).error, 'The email had no invoice file (PDF or picture) to keep.');
  const many = parseInboxBody({ token: TOKEN, files: Array.from({ length: 12 }, (_, i) => ({ filename: `${i}.pdf`, content_base64: B64 })) });
  assert.equal(many.files.length, 10);
  assert.equal(many.skipped.length, 2);
});

test('inboxPath and receiveFiles: org/<org>/<id>.<ext>, the bucket policies read the org folder', () => {
  assert.equal(INBOX_BUCKET, 'stock-invoice-inbox');
  assert.equal(inboxPath(ORG, ID, 'application/pdf'), `org/${ORG}/${ID}.pdf`);
  assert.equal(inboxPath(ORG, ID, 'image/jpeg'), `org/${ORG}/${ID}.jpg`);
  assert.equal(inboxPath('x', ID, 'image/png'), null);
  const r = parseInboxBody({ token: TOKEN, files: [{ filename: 'a.pdf', content_base64: B64 }, { filename: 'b.png', content_base64: B64 }] });
  assert.deepEqual(receiveFiles(ORG, r.files, [ID, ID.replace('a', 'b')], { 0: { invoice_number: '12' } }), [
    { file_path: `org/${ORG}/${ID}.pdf`, file_name: 'a.pdf', mime: 'application/pdf', scan: { invoice_number: '12' } },
    { file_path: `org/${ORG}/${ID.replace('a', 'b')}.png`, file_name: 'b.png', mime: 'image/png', scan: null },
  ]);
  assert.deepEqual(receiveFiles(ORG, r.files, []), [], 'no id, no path');
});

test('placedWords and inboxLine', () => {
  assert.equal(placedWords({ status: 'placed', location_id: 'x', site_name: 'Site A', placed_how: 'account_number' }), 'Placed at Site A by account number.');
  assert.equal(placedWords({ status: 'placed', location_id: 'x', site_name: 'Site A', placed_how: 'address' }), 'Placed at Site A by delivery address.');
  assert.equal(placedWords({ status: 'waiting' }), 'Waiting: it could not be placed. Pick the site.');
  assert.equal(placedWords({ status: 'ignored' }), 'Ignored.');
  assert.equal(placedWords({ status: 'posted', site_name: 'Site B' }), 'Posted at Site B.');
  assert.match(inboxLine('invoices+x@y'), /^Send invoices to invoices\+x@y\. Each one goes to the right site/);
  assert.equal(inboxLine(null), 'The inbox email address is not set up yet. Upload invoices here instead.');
});

test('the edge function answers 503 until the provider is chosen, POST only, no key, never stripe', () => {
  const src = fs.readFileSync(new URL('../../../supabase/functions/invoice-inbox/index.ts', import.meta.url), 'utf8');
  assert.match(src, /The invoice inbox address is not set up yet\./);
  assert.match(src, /405/);
  assert.match(src, /503/);
  assert.match(src, /from '\.\.\/_shared\/invoiceInbox\.js'/);
  assert.doesNotMatch(src, /stripe/i);
  assert.doesNotMatch(src, /[\u2013\u2014]/);
  assert.doesNotMatch(fs.readFileSync(new URL('../../../supabase/functions/_shared/invoiceInbox.js', import.meta.url), 'utf8'), /^import /m, 'pure');
});
