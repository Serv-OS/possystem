/**
 * printerDialects.test.js: every byte the Star dialects send is checked against the
 * manufacturer's command references (Star Line Mode Command Specifications Rev 1.80,
 * Star Graphic Mode Command Specifications Rev 2.32). Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRINTER_MODELS, resolvePrinterSpec, modelSetupNote, paperOptionsFor, printerModel,
  encodeStarLine, encodeStarRaster, starRasterRow, starRasterDrawerJob, cashDrawerBytes,
  layoutDocRows, rowHeight, StarLineBuilder, transliterate, printableText,
  DIALECT_ESCPOS, DIALECT_STAR_LINE, DIALECT_STAR_RASTER, STAR_RASTER,
} from './printerDialects.js';
import { DocBuilder, buildKitchenTicketDoc, buildCustomerReceiptDoc } from './printDoc.js';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const latin = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');

// ─── Model table ─────────────────────────────────────────────────────────────
test('every Back Office model resolves to a dialect, with generic as ESC/POS', () => {
  const expected = {
    'sunmi-nt311': DIALECT_ESCPOS, 'sunmi-nt310': DIALECT_ESCPOS,
    'epson-tm-t88': DIALECT_ESCPOS, 'epson-tm-t20': DIALECT_ESCPOS, 'epson-tm-m30': DIALECT_ESCPOS, 'epson-tm-t82': DIALECT_ESCPOS, 'epson-tm-t70': DIALECT_ESCPOS,
    'star-tsp143': DIALECT_STAR_RASTER, 'star-tsp143iv': DIALECT_STAR_LINE, 'star-tsp100': DIALECT_STAR_RASTER,
    'star-tsp654': DIALECT_STAR_LINE, 'star-tsp700': DIALECT_STAR_LINE, 'star-tsp800': DIALECT_STAR_LINE,
    'star-mcprint3': DIALECT_STAR_LINE, 'star-mcprint2': DIALECT_STAR_LINE,
    'bixolon-srp350': DIALECT_ESCPOS, 'bixolon-srpq300': DIALECT_ESCPOS,
    'citizen-cts310': DIALECT_ESCPOS, 'citizen-cte351': DIALECT_ESCPOS,
    'xprinter-xp80': DIALECT_ESCPOS, 'generic': DIALECT_ESCPOS,
  };
  for (const [id, dialect] of Object.entries(expected)) {
    assert.equal(resolvePrinterSpec({ model: id }).dialect, dialect, id);
    assert.ok(printerModel(id), `${id} in the table`);
  }
  assert.equal(PRINTER_MODELS.length, Object.keys(expected).length);
  assert.equal(resolvePrinterSpec({ model: 'no-such-model' }).dialect, DIALECT_ESCPOS);
  assert.equal(resolvePrinterSpec(undefined).dialect, DIALECT_ESCPOS);
  // The DB row shape (meta.model, paper_width) resolves too.
  assert.equal(resolvePrinterSpec({ meta: { model: 'star-tsp654' }, paper_width: 80 }).dialect, DIALECT_STAR_LINE);
});

test('an old row saved as star-tsp100 still prints (raster) but the model cannot be picked anew', () => {
  const m = printerModel('star-tsp100');
  assert.equal(m.unavailable, true);
  assert.equal(resolvePrinterSpec({ model: 'star-tsp100' }).dialect, DIALECT_STAR_RASTER);
  assert.match(modelSetupNote('star-tsp100'), /USB only/);
  assert.match(modelSetupNote('star-tsp100'), /TSP143III LAN or TSP143IV/);
});

test('columns and dots per dialect and paper width', () => {
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'epson-tm-t88', paperWidth: 80 })), { cols: 42, dots: 576, paper: 80 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'epson-tm-t88', paperWidth: 58 })), { cols: 32, dots: 384, paper: 58 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-tsp654', paperWidth: 80 })), { cols: 48, dots: 576, paper: 80 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-tsp654', paperWidth: 58 })), { cols: 32, dots: 384, paper: 58 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-tsp800', paperWidth: 80 })), { cols: 69, dots: 832, paper: 112 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-mcprint2', paperWidth: 80 })), { cols: 32, dots: 384, paper: 58 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-tsp143', paperWidth: 80 })), { cols: 48, dots: 576, paper: 80 });
  assert.deepEqual(pick(resolvePrinterSpec({ model: 'star-tsp143', paperWidth: 58 })), { cols: 32, dots: 384, paper: 58 });
  assert.deepEqual(paperOptionsFor('star-tsp800'), [112]);
  assert.deepEqual(paperOptionsFor('sunmi-nt310'), [58]);
  assert.deepEqual(paperOptionsFor('epson-tm-t88'), [80, 58]);
  function pick(s) { return { cols: s.cols, dots: s.dots, paper: s.paper }; }
});

test('setup notes are plain words with no dashes and say what mode the printer must be in', () => {
  for (const m of PRINTER_MODELS) {
    assert.ok(m.note.length > 10, m.id);
    assert.ok(!/[–—]/.test(m.note), `${m.id} note has a dash`);
    assert.ok(!/[–—]/.test(m.desc), `${m.id} desc has a dash`);
  }
  assert.match(modelSetupNote('star-tsp654'), /Star Line Mode/);
  assert.match(modelSetupNote('star-tsp654'), /factory setting/);
  assert.match(modelSetupNote('star-tsp143'), /graphics/);
  assert.match(modelSetupNote('star-tsp143iv'), /StarPRNT/);
  assert.match(modelSetupNote('star-tsp700'), /two colour paper/);
  assert.match(modelSetupNote('epson-tm-m30'), /ESC\/POS/);
  assert.match(modelSetupNote('unknown-model'), /ESC\/POS/);
});

// ─── Transliteration ─────────────────────────────────────────────────────────
test('transliteration maps Unicode punctuation and drops what Latin-1 cannot hold', () => {
  assert.equal(transliterate('Fish — Chips ‘ok’ “q” • 5° €9 ™'), 'Fish - Chips \'ok\' "q" - 5 deg EUR9 (TM)');
  assert.equal(printableText('Café 中'), 'Café ?');
  assert.equal(transliterate(null), '');
});

// ─── Star Line Mode ──────────────────────────────────────────────────────────
test('Star Line commands match the Line Mode spec byte for byte', () => {
  const b = new StarLineBuilder(48);
  assert.equal(hex(b.init().toBytes()), '1b40' + '1b1d7420');                 // ESC @, ESC GS t 32 (CP1252)
  assert.equal(hex(new StarLineBuilder().bold(true).toBytes()), '1b45');       // ESC E emphasis on
  assert.equal(hex(new StarLineBuilder().bold(false).toBytes()), '1b46');      // ESC F emphasis off
  assert.equal(hex(new StarLineBuilder().center().toBytes()), '1b1d6101');     // ESC GS a 1
  assert.equal(hex(new StarLineBuilder().left().toBytes()), '1b1d6100');       // ESC GS a 0
  assert.equal(hex(new StarLineBuilder().doubleHeight().toBytes()), '1b690100'); // ESC i 1 0
  assert.equal(hex(new StarLineBuilder().doubleBoth().toBytes()), '1b690101');   // ESC i 1 1
  assert.equal(hex(new StarLineBuilder().normal().toBytes()), '1b690000' + '1b46' + '1b1d6100');
  assert.equal(hex(new StarLineBuilder().underline(true).toBytes()), '1b2d01');  // ESC - 1
  assert.equal(hex(new StarLineBuilder().fontB().toBytes()), '1b1e4601');        // ESC RS F 1
  assert.equal(hex(new StarLineBuilder().fontA().toBytes()), '1b1e4600');        // ESC RS F 0
  assert.equal(hex(new StarLineBuilder().cut().toBytes()), '1b6403');            // ESC d 3: feed then partial cut
  assert.equal(hex(new StarLineBuilder().cashDrawer().toBytes()), '1b071414' + '07'); // ESC BEL 20 20, BEL
  assert.equal(hex(new StarLineBuilder().lf(2).toBytes()), '0a0a');
  assert.equal(hex(new StarLineBuilder().text('A£').toBytes()), '41a3');   // Latin-1 bytes
});

test('Star Line two colour: only TSP700II gets ESC RS C / ESC RS c, and the job ends in single colour', () => {
  const plain = new StarLineBuilder(48, { twoColour: false });
  assert.equal(hex(plain.red().text('x').black().toBytes()), '78');            // no colour commands at all
  const two = new StarLineBuilder(48, { twoColour: true });
  assert.equal(hex(two.red().text('x').black().toBytes()), '1b1e4301' + '1b1e6301' + '78' + '1b1e6300');
  const doc = new DocBuilder(48).init().red().line('note').black().cut().toDoc();
  const bytes = hex(encodeStarLine(doc, resolvePrinterSpec({ model: 'star-tsp700' })));
  assert.ok(bytes.includes('1b1e4301'), 'selects 2 colour mode');
  assert.ok(bytes.endsWith('1b1e4300' + '1b6403'), 'cancels 2 colour mode before the cut');
  const bytes654 = hex(encodeStarLine(doc, resolvePrinterSpec({ model: 'star-tsp654' })));
  assert.ok(!bytes654.includes('1b1e43'), 'TSP654II never sees 2 colour commands');
});

test('Star Line QR is the ESC GS y sequence', () => {
  const bytes = hex(new StarLineBuilder().qr('AB', 6, 'M').toBytes());
  assert.equal(bytes,
    '1b1d79533002'   // model 2
    + '1b1d79533101' // error correction M
    + '1b1d79533206' // cell size 6
    + '1b1d7944310002004142' // D 1 m=0 nL=2 nH=0 "AB"
    + '1b1d7950');   // print
  assert.ok(hex(new StarLineBuilder().qr('x', 16, 'H').toBytes()).includes('1b1d79533208'), 'cell size clamps to 8');
});

test('Star Line bitmap goes as ESC k bands of 24 rows at 3mm pitch, then back to 4mm', () => {
  const width = 16, height = 30, stride = 2;
  const bits = new Uint8Array(stride * height).fill(0xff);
  const bytes = new StarLineBuilder().bitmap({ width, height, bits }).toBytes();
  const h = hex(bytes);
  assert.ok(h.startsWith('1b30'), 'ESC 0: 3mm line pitch');
  assert.ok(h.endsWith('1b7a01'), 'ESC z 1: 4mm line pitch restored');
  // two bands: ESC k 2 0 (4 bytes) + 24 rows x 2 bytes + LF, second band padded with white rows
  const band1 = 4 + 48 + 1;
  assert.equal(bytes.length, 2 + band1 * 2 + 3);
  assert.equal(hex(bytes.subarray(2, 6)), '1b6b0200');
  assert.equal(bytes[2 + band1 + 4 + 12 * stride], 0x00, 'rows past the image are white');
  // Wider than the paper: skipped rather than read as text by the printer.
  const wide = new StarLineBuilder(48, { dots: 576 }).bitmap({ width: 600, height: 8, bits: new Uint8Array(75 * 8) }).toBytes();
  assert.equal(wide.length, 0);
  const fits = new StarLineBuilder(48, { dots: 576 }).bitmap({ width: 576, height: 8, bits: new Uint8Array(72 * 8) }).toBytes();
  assert.ok(fits.length > 0);
});

test('layoutDocRows feeds a blank line for a bare line feed', () => {
  const doc = new DocBuilder(48).line('a').lf().line('b').lf(2).line('').line('c').lf(4).cut().toDoc();
  const { rows } = layoutDocRows(doc, { cols: 48 });
  // interior feeds are blank rows; the lf(4) before the cut is feed only and is trimmed
  assert.deepEqual(rows.map((r) => r.kind), ['text', 'blank', 'text', 'blank', 'blank', 'blank', 'text']);
});

test('a kitchen ticket for a TSP654II is Star text at 48 columns with no ESC/POS bytes', () => {
  const spec = resolvePrinterSpec({ model: 'star-tsp654' });
  const doc = buildKitchenTicketDoc({ table: 'T7', server: 'Jane', covers: 2, centreName: 'Kitchen', sentAt: 0,
    items: [{ name: 'Fish', qty: 1, course: 1, fired: true, mods: ['No salt'], notes: 'allergy' }] }, { cols: spec.cols });
  const bytes = encodeStarLine(doc, spec);
  const h = hex(bytes), t = latin(bytes);
  assert.ok(h.startsWith('1b401b1d7420'), 'init');
  assert.ok(t.includes('='.repeat(48) + '\n'), 'dividers span 48 columns');
  assert.ok(!h.includes('1d564200'), 'no ESC/POS cut');
  assert.ok(!h.includes('1b2110') && !h.includes('1b2130'), 'no ESC ! size commands');
  assert.ok(!h.includes('1b7201'), 'no ESC r colour command');
  assert.ok(h.endsWith('0a0a0a1b6403'), 'three feeds then ESC d 3 partial cut');
});

test('a customer receipt for a TSP800II lays out at 69 columns', () => {
  const spec = resolvePrinterSpec({ model: 'star-tsp800' });
  const doc = buildCustomerReceiptDoc({ location: { name: 'Wide' }, check: { ref: 'R1' }, items: [{ name: 'Tea', price: 2, qty: 1 }], totals: { subtotal: 2, grand: 2 } }, { cols: spec.cols });
  const t = latin(encodeStarLine(doc, spec));
  assert.ok(t.includes('-'.repeat(69) + '\n'));
  assert.ok(/TOTAL {59}£2\.00\n/.test(t), 'right column sits at column 69 (5 + 59 + 5)');
});

// ─── Star raster (TSP100 family) ─────────────────────────────────────────────
test('raster job: initialise, enter, page length 0, EOT mode 13, one b row per dot row, EOT, quit', () => {
  const width = 16, height = 3;   // stride 2 bytes per row
  const bits = new Uint8Array([0xff, 0x00,  0x00, 0x00,  0x81, 0x01]);
  const h = hex(encodeStarRaster({ width, height, bits }, { cut: true }));
  const expected =
    '1b2a7252'        // ESC * r R
    + '1b2a7241'      // ESC * r A
    + '1b2a725030 00' // ESC * r P "0" NUL
    + '1b2a7245 3133 00' // ESC * r E "13" NUL (print, feed, partial cut) as ASCII digits
    + '62 0100 ff'    // row 1: trailing white byte trimmed
    + '62 0100 00'    // row 2: blank row keeps one byte
    + '62 0200 8101'  // row 3
    + '1b0c04'        // ESC FF EOT
    + '1b2a7242';     // ESC * r B
  assert.equal(h, expected.replace(/ /g, ''));
});

test('raster job without a cut uses EOT mode 1, and an empty bitmap sends no EOT', () => {
  const h = hex(encodeStarRaster({ width: 8, height: 1, bits: new Uint8Array([0x80]) }, { cut: false }));
  assert.ok(h.includes('1b2a72453100'), 'EOT mode "1"');
  const empty = hex(encodeStarRaster({ width: 8, height: 0, bits: new Uint8Array(0) }));
  assert.ok(!empty.includes('1b0c04'));
  assert.equal(hex(starRasterRow(new Uint8Array([0, 0, 0])).subarray(0, 3)), '620100');
});

test('raster numeric parameters are ASCII decimal digits per the Graphic Mode spec', () => {
  assert.equal(hex(Uint8Array.from(STAR_RASTER.eotMode(13))), '1b2a7245313300');
  assert.equal(hex(Uint8Array.from(STAR_RASTER.pageLength(0))), '1b2a72503000');
  assert.equal(hex(Uint8Array.from(STAR_RASTER.drawer(1))), '1b2a72443100');
  assert.equal(hex(Uint8Array.from(STAR_RASTER.executeEOT)), '1b0c04');
  assert.equal(hex(Uint8Array.from(STAR_RASTER.executeFF)), '1b0c00');
});

test('a 30 line receipt raster stays a sane size for TCP', () => {
  const rows = 30 * 30, stride = 72;
  const bits = new Uint8Array(stride * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < 40; x++) bits[y * stride + x] = (y % 3) ? 0x55 : 0x00;
  const job = encodeStarRaster({ width: 576, height: rows, bits });
  assert.ok(job.length < 80_000, `job is ${job.length} bytes`);
  assert.ok(job.length > rows * 3);
});

test('raster width never exceeds the paper: 576 dots at 80mm, 384 at 58mm', () => {
  assert.equal(resolvePrinterSpec({ model: 'star-tsp143', paperWidth: 80 }).dots, 576);
  assert.equal(resolvePrinterSpec({ model: 'star-tsp143', paperWidth: 58 }).dots, 384);
  assert.equal(resolvePrinterSpec({ model: 'star-tsp143', paperWidth: 112 }).dots, 576);
});

// ─── Cash drawer per dialect ─────────────────────────────────────────────────
test('cash drawer bytes differ per dialect and never send ESC p to a Star printer', () => {
  assert.equal(hex(cashDrawerBytes(resolvePrinterSpec({ model: 'sunmi-nt311' }))), '1b401b70001919');
  assert.equal(hex(cashDrawerBytes(resolvePrinterSpec({ model: 'star-tsp654' }))), '1b401b1d7420' + '1b071414' + '07');
  assert.equal(hex(cashDrawerBytes(resolvePrinterSpec({ model: 'star-tsp143' }))), '1b2a7252' + '1b2a7241' + '1b2a72443100' + '1b2a7242');
  assert.equal(hex(starRasterDrawerJob()), hex(cashDrawerBytes({ dialect: DIALECT_STAR_RASTER })));
  assert.equal(hex(cashDrawerBytes(null)), '1b401b70001919');
});

// ─── Raster layout (pure part of the canvas renderer) ────────────────────────
test('layoutDocRows mirrors the text printer state machine', () => {
  const doc = new DocBuilder(48).init()
    .center().bold(true).doubleBoth().text('Kitchen').lf()
    .normal().center().line('12:00').divider('=')
    .left().red().line('  no salt').black()
    .fontB().line('small').fontA()
    .lf(3).cut().toDoc();
  const { rows, hasCut, cols } = layoutDocRows(doc, { cols: 48 });
  assert.equal(cols, 48);
  assert.equal(hasCut, true);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].align, 'center');
  assert.deepEqual({ bold: rows[0].segs[0].style.bold, size: rows[0].segs[0].style.size }, { bold: true, size: 'both' });
  assert.equal(rows[1].segs[0].s, '12:00');
  assert.equal(rows[1].segs[0].style.size, 'normal', 'normal() reset the size');
  assert.equal(rows[2].segs[0].s, '='.repeat(48));
  assert.equal(rows[3].align, 'left');
  assert.equal(rows[3].segs[0].style.red, true);
  assert.equal(rows[4].segs[0].style.font, 'B');
  // lf(3) before the cut is feed only: trailing blank rows are dropped
  assert.equal(rows[rows.length - 1].kind, 'text');
  assert.equal(rowHeight(rows[0]), 54);
  assert.equal(rowHeight(rows[1]), 30);
});

test('layoutDocRows pads two column lines and truncates item names at the column count', () => {
  const doc = new DocBuilder(32).twoCol('Subtotal', '£1.00').twoColTrunc('A very long item name that overflows', '£9.99').centeredLine('hi').toDoc();
  const { rows } = layoutDocRows(doc, { cols: 32 });
  assert.equal(rows[0].segs[0].s.length, 32);
  assert.equal(rows[1].segs[0].s.length, 32);
  assert.ok(rows[1].segs[0].s.endsWith(' £9.99'));
  assert.equal(rows[2].segs[0].s, ' '.repeat(15) + 'hi');
});
