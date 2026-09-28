// 28 Sep 2026: the receipt footer QR prints as a raster picture (the Sunmi NT311 drew nothing
// for the native QR command).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qrTextToGsV0 } from './receiptRaster.js';

test('the footer QR is a GS v 0 raster picture with a white border and a black finder corner', () => {
  const bytes = qrTextToGsV0('https://coffee-boy-leeds.serv-os.app/account/register', 6, 'M');
  assert.deepEqual([...bytes.slice(0, 4)], [0x1d, 0x76, 0x30, 0x00], 'GS v 0');
  const widthBytes = bytes[4] | (bytes[5] << 8);
  const height = bytes[6] | (bytes[7] << 8);
  const dots = height;
  assert.equal(widthBytes, (dots + 7) >> 3, 'square');
  assert.equal(dots % 6, 0, 'whole modules at size 6');
  assert.ok(dots <= 576, 'fits 80 mm paper');
  const bits = bytes.slice(8);
  const px = (x, y) => (bits[y * widthBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  assert.equal(px(0, 0), false, 'white border');
  assert.equal(px(4 * 6, 4 * 6), true, 'top left finder pattern starts after the 4 module border');
});

test('the ESC/POS encoder sends the QR as the picture, with the native command only as a fallback', () => {
  const src = fs.readFileSync(new URL('./printerDialects.js', import.meta.url), 'utf8');
  assert.match(src, /try \{ qrBytes = qrTextToGsV0\(op\.text, op\.moduleSize, op\.ec\); \} catch \{ qrBytes = qrTextToEscPosBytes\(op\.text, op\.moduleSize, op\.ec\); \}/);
});

test('28 Sep 2026: the loyalty report and the Customers total are not capped at 1,000 rows', () => {
  const rep = fs.readFileSync(new URL('../backoffice/sections/reports/LoyaltyReport.jsx', import.meta.url), 'utf8');
  assert.match(rep, /async function readAllRows\(makeQuery, page = 1000\)/);
  assert.equal((rep.match(/readAllRows\(\(\) =>/g) || []).length, 4, 'members, stamp cards and both transaction reads page');
  assert.doesNotMatch(rep, /\.limit\(500\)/);
  const cust = fs.readFileSync(new URL('../backoffice/sections/Customers.jsx', import.meta.url), 'utf8');
  assert.match(cust, /select\('id', \{ count: 'exact', head: true \}\)/);
  assert.match(cust, /\(totalCount \?\? customers\.length\)\.toLocaleString\('en-GB'\)/);
});
