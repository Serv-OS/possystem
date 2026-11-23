// itemStickerWiring.test.js: sticker mode (18 Nov 2026) is wired end to end: the four callers hand
// the ticket meta and the order wide run to routePrintJob, the branch prints through
// printItemSticker, the print service builds buildItemStickerDoc, and the setting's words say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const has = (src, needle, why) => assert.ok(src.includes(needle), why || needle);

test('store: the sticker branch prints one sticker per unit through printItemSticker with the order wide run', () => {
  const src = read('../store/index.js');
  has(src, "import { stickerRuns } from '../lib/itemSticker';");
  has(src, "centre?.splitPerItem && !job.itemLabel)", 'a labelled notice never splits');
  has(src, "printItems.filter(it => !it?.noKitchen).forEach(it => { const q = Math.max(1, Math.round(it.qty || 1));", 'kitchen lines only, one per unit');
  has(src, "const run = job.stickerRun && Number(job.stickerRun.total) >= units.length ? job.stickerRun : { offset: 0, total: units.length };", 'the caller\'s run, else its own');
  has(src, "const r = await printService.printItemSticker({");
  has(src, "meta: job.meta || null, table: job.tableLabel || '', centreName: centre?.name || job.printerName || 'Kitchen',");
  has(src, "item: units[i], index: offset + i + 1, total, sentAt: basePrintJob.sentAt, delivery: job.delivery || null,");
  assert.ok(!src.includes('itemLabel: `ITEM ${i + 1} OF ${total}`'), 'the old ITEM X OF Y sticker is gone');
});

test('store: the four callers pass the ticket meta and the run', () => {
  const src = read('../store/index.js');
  assert.equal((src.match(/const stickerRunsHere = stickerRuns\(newTickets\.map\(t => t\.items\)\);/g) || []).length, 3, 'table, walk in and bar round');
  assert.equal((src.match(/meta: t\.meta, stickerRun: stickerRunsHere\[ti\],/g) || []).length, 3);
  has(src, "const runsInOrder = stickerRuns(Object.values(byCentre));\n      const centreRuns = new Map(Object.keys(byCentre).map((id, i) => [id, runsInOrder[i]]));", 'channel orders');
  has(src, "meta: _kdsMeta || null, stickerRun: centreRuns.get(centreId),");
});

test('printer.js: printItemSticker builds buildItemStickerDoc on the centre printer', () => {
  const src = read('printer.js');
  has(src, 'buildItemStickerDoc, docHasCut, docHasDrawer,');
  has(src, 'async printItemSticker(data, printerId = null, opts = {}) {');
  has(src, "const printer = this._printerForRole('kitchen', printerId);\n    if (printer?.address) {\n      const bytes = await encodeDocForPrinter(buildItemStickerDoc(data, { cols: resolvePrinterSpec(printer).cols }), printer);");
  has(src, "sticker: `${data.index} of ${data.total}`");
});

test('Print routing: the setting says what a sticker carries', () => {
  const src = read('../backoffice/sections/PrintRouting.jsx');
  has(src, 'numbered 1 of 3 across the whole order');
  assert.ok(!src.includes('ITEM 1 OF 3'));
});

test('no long dashes in the new words', () => {
  const dash = new RegExp('[\\u2013\\u2014]');
  for (const f of ['itemSticker.js', 'itemSticker.test.js', 'itemStickerWiring.test.js']) assert.ok(!dash.test(read(f)), f);
  const doc = read('printDoc.js');
  const start = doc.indexOf('export function buildItemStickerDoc');
  const end = doc.indexOf('export function buildFireCourseTicketDoc');
  assert.ok(start > 0 && end > start);
  assert.ok(!dash.test(doc.slice(start, end)), 'buildItemStickerDoc');
});
