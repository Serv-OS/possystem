// Peter, 18 Sep 2026: "none of these download buttons work or the download all".
// The browser rules behind it are explained in lib/tableQr.js. These tests pin the
// shape of the fix: a click saves a finished file synchronously, the link is in the
// document when clicked, and "Download all" is one PDF.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { qrFileName } from './tableQr.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const lib = read('./tableQr.js');
const screen = read('../backoffice/sections/OnlineOrdering.jsx');

test('file names are safe and keep the table label', () => {
  assert.equal(qrFileName('T4'), 'qr-table-T4.jpg');
  assert.equal(qrFileName('Table 12'), 'qr-table-Table_12.jpg');
  assert.equal(qrFileName('../../x'), 'qr-table-x.jpg');
  assert.equal(qrFileName(''), 'qr-table-unknown.jpg');
});

test('the link is added to the page before it is clicked', () => {
  const i = lib.indexOf('export function saveHref(');
  const fn = lib.slice(i, lib.indexOf('\n}\n', i));
  assert.ok(fn.indexOf('document.body.appendChild(a)') > 0 && fn.indexOf('document.body.appendChild(a)') < fn.indexOf('a.click()'));
});

test('a JPEG click saves a finished image with no await in between', () => {
  const i = screen.indexOf('  const downloadOne = (table) => {');
  assert.ok(i > 0, 'downloadOne is synchronous');
  const fn = screen.slice(i, screen.indexOf('\n  };\n', i));
  assert.ok(!/await|async/.test(fn), 'nothing awaited inside the click');
  assert.ok(fn.includes('saveHref(img.dataUrl'), 'saves the pre drawn image');
});

test('Download all makes ONE PDF, synchronously, instead of a burst of downloads', () => {
  const i = screen.indexOf('  const downloadAll = () => {');
  assert.ok(i > 0, 'downloadAll is synchronous');
  const fn = screen.slice(i, screen.indexOf('\n  };\n', i));
  assert.ok(!/await|async|setTimeout/.test(fn), 'no await and no timed loop');
  assert.ok(fn.includes('buildQrPdf(') && fn.includes('savePdf('), 'one PDF');
  assert.ok(!screen.includes('await downloadOne('), 'the old per table loop is gone');
});

test('the images are drawn when the section opens, before any click', () => {
  assert.ok(screen.includes('renderTableQrJpeg({ url: q.url, label: q.label, footer })'));
  assert.ok(/useEffect\(\(\) => \{[\s\S]*renderTableQrJpeg[\s\S]*\}, \[qrSignature\]\);/.test(screen));
  assert.ok(!/from 'qrcode'/.test(screen), 'the screen no longer draws inside the click');
});
