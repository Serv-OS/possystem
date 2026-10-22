// Multi site stock Drop 2: the label print route (src/lib/labelPrint.js) with a stand in print
// service, and the one method it leans on in src/lib/printer.js (read as text: that file needs
// the browser). Synthetic names only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as LP from './labelPrint.js';
import { batchLabelDoc, ppdsLabelDoc, labelCols, NO_LABEL_PRINTER, PPDS_NOT_SIGNED_OFF } from './stock/batchLabel.js';

const DOC = batchLabelDoc({ name: 'Test sauce', madeAt: '2026-10-21T13:05:00Z', allergens: ['milk'], venueTz: 'Europe/London' }, { cols: 32 });

/** A print service stand in: records every call, answers what it is told to. */
function service(answer = { ok: true, transport: 'native', printer: 'Label 1', jobId: 'j-1' }, printer = { id: 'p1', name: 'Label 1', address: '10.0.0.9', roles: ['label'], paperWidth: 58 }) {
  const calls = [];
  return {
    calls,
    printLabelDoc: async (doc, printerId, opts) => {
      const built = typeof doc === 'function' ? doc(printer, { cols: labelCols(printer), paper: 58 }) : doc;
      calls.push({ doc: built, printerId, opts });
      return typeof answer === 'function' ? answer(built, printerId, opts) : answer;
    },
    _printerForRole: (role, id) => (id ? (printer?.id === id ? printer : null) : (printer?.roles?.includes(role) ? printer : null)),
  };
}

test('the words and the file: no long dash, printer.js is never loaded by the tests', () => {
  assert.equal(LP.NOTHING_TO_PRINT, 'Nothing to print.');
  assert.equal(LP.PRINT_NEEDS_APP, 'This app needs an update to print labels.');
  const src = fs.readFileSync(new URL('./labelPrint.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
  assert.ok(src.includes("import('./printer.js')"), 'printer.js is loaded when the first label is asked for, not at import');
  assert.ok(!/^import .* from '\.\/printer(\.js)?';$/m.test(src), 'no top level import of printer.js');
});

test('labelKey and labelJobOpts: a key every time, a job name, metadata always an object', () => {
  assert.equal(LP.labelKey(1700000000000, 0.5), `label-1700000000000-${Math.floor(0.5 * 1e6).toString(36)}`);
  assert.notEqual(LP.labelKey(), LP.labelKey());
  assert.match(LP.labelKey(), /^label-\d+-[0-9a-z]+$/);
  const o = LP.labelJobOpts({ label: 'Label: Test sauce', idempotencyKey: 'k-1', metadata: { recipeId: 'r-1' } });
  assert.deepEqual(o, { idempotencyKey: 'k-1', label: 'Label: Test sauce', metadata: { recipeId: 'r-1' } });
  const d = LP.labelJobOpts();
  assert.equal(d.label, 'Label');
  assert.match(d.idempotencyKey, /^label-/);
  assert.deepEqual(d.metadata, {});
  assert.equal(LP.labelJobOpts({ label: '   ' }).label, 'Label');
});

test('labelPrintOutcome: one shape, plain words when the service gave none', () => {
  assert.deepEqual(LP.labelPrintOutcome({ ok: true, transport: 'native', printer: 'Label 1', jobId: 'j-1' }), { ok: true, error: null, printer: 'Label 1', transport: 'native', jobId: 'j-1' });
  assert.deepEqual(LP.labelPrintOutcome({ ok: false, error: NO_LABEL_PRINTER }), { ok: false, error: NO_LABEL_PRINTER, printer: null, transport: null, jobId: null });
  assert.deepEqual(LP.labelPrintOutcome({ ok: false }), { ok: false, error: LP.LABEL_FAILED, printer: null, transport: null, jobId: null });
  assert.deepEqual(LP.labelPrintOutcome(null), { ok: false, error: LP.LABEL_FAILED, printer: null, transport: null, jobId: null });
  assert.equal(LP.labelPrintOutcome({ ok: true, transport: 'idempotent', printer: 'Label 1' }).ok, true, 'a double press that was already printed is ok');
});

test('isNoPrinter sees the contract words only', () => {
  assert.equal(LP.isNoPrinter(NO_LABEL_PRINTER), true);
  assert.equal(LP.isNoPrinter(new Error(NO_LABEL_PRINTER)), true);
  assert.equal(LP.isNoPrinter('No kitchen printer configured'), false);
  assert.equal(LP.isNoPrinter(null), false);
});

test('printLabel sends a built document to printLabelDoc with the job options and answers the outcome', async () => {
  const svc = service();
  const r = await LP.printLabel(DOC, { label: 'Label: Test sauce', idempotencyKey: 'k-1', metadata: { recipeId: 'r-1' }, service: svc });
  assert.deepEqual(r, { ok: true, error: null, printer: 'Label 1', transport: 'native', jobId: 'j-1' });
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].doc, DOC);
  assert.equal(svc.calls[0].printerId, null);
  assert.deepEqual(svc.calls[0].opts, { idempotencyKey: 'k-1', label: 'Label: Test sauce', metadata: { recipeId: 'r-1' } });
});

test('printLabel with a builder: the document is built at the printer\'s columns', async () => {
  const svc = service();
  const seen = [];
  const r = await LP.printLabel((printer, spec) => { seen.push({ printer, spec }); return batchLabelDoc({ name: 'Test sauce' }, { cols: labelCols({ ...printer, cols: spec.cols }) }); }, { service: svc, printerId: 'p1' });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].printer.name, 'Label 1');
  assert.equal(svc.calls[0].doc.cols, 32, '58 mm paper: 32 columns');
  assert.equal(svc.calls[0].printerId, 'p1');
});

test('printLabel refuses before the printer: nothing, an empty document, a PPDS label not signed off', async () => {
  const svc = service();
  assert.deepEqual(await LP.printLabel(null, { service: svc }), { ok: false, error: LP.NOTHING_TO_PRINT, printer: null, transport: null, jobId: null });
  assert.equal((await LP.printLabel({ ops: [], cols: 32 }, { service: svc })).error, LP.NOTHING_TO_PRINT);
  assert.equal((await LP.printLabel({ error: PPDS_NOT_SIGNED_OFF }, { service: svc })).error, PPDS_NOT_SIGNED_OFF);
  const refused = ppdsLabelDoc({ name: 'Test sandwich', signedOff: false }, { cols: 32 });
  assert.equal((await LP.printLabel(refused, { service: svc })).error, PPDS_NOT_SIGNED_OFF);
  const viaBuilder = await LP.printLabel(() => refused, { service: svc });
  assert.deepEqual(viaBuilder, { ok: false, error: PPDS_NOT_SIGNED_OFF, printer: null, transport: null, jobId: null });
  const emptyBuilder = await LP.printLabel(() => ({ ops: [], cols: 32 }), { service: svc });
  assert.equal(emptyBuilder.error, LP.NOTHING_TO_PRINT);
  assert.equal(svc.calls.length, 0, 'no job was made for any refusal: the builder paths stop inside the build, before a job');
});

test('printLabel: no label printer is the contract\'s words; a service that throws is a plain failure; an old app says so', async () => {
  const none = service({ ok: false, error: NO_LABEL_PRINTER });
  const r = await LP.printLabel(DOC, { service: none });
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_LABEL_PRINTER);
  assert.equal(LP.isNoPrinter(r.error), true);
  const boom = { printLabelDoc: async () => { throw new Error('socket closed'); } };
  assert.deepEqual(await LP.printLabel(DOC, { service: boom }), { ok: false, error: 'socket closed', printer: null, transport: null, jobId: null });
  const quiet = { printLabelDoc: async () => { throw new Error(''); } };
  assert.equal((await LP.printLabel(DOC, { service: quiet })).error, LP.LABEL_FAILED);
  assert.equal((await LP.printLabel(DOC, { service: {} })).error, LP.PRINT_NEEDS_APP);
  const failed = service({ ok: false, error: 'Native bridge failure', transport: 'native-failed' });
  assert.deepEqual(await LP.printLabel(DOC, { service: failed }), { ok: false, error: 'Native bridge failure', printer: null, transport: 'native-failed', jobId: null });
});

test('labelPrinter: the Label printer role or null, never a throw', async () => {
  const svc = service();
  assert.equal((await LP.labelPrinter({ service: svc }))?.name, 'Label 1');
  const kitchenOnly = service(undefined, { id: 'p2', name: 'Kitchen', address: '10.0.0.8', roles: ['kitchen'] });
  assert.equal(await LP.labelPrinter({ service: kitchenOnly }), null);
  assert.equal(await LP.labelPrinter({ service: {} }), null);
  assert.equal(await LP.labelPrinter({ service: { _printerForRole: () => { throw new Error('x'); } } }), null);
});

// ── printer.js: the one new method, read as text ──
test('printer.js printLabelDoc is the contract method on the Label printer role, beside the kitchen ticket', () => {
  const src = fs.readFileSync(new URL('./printer.js', import.meta.url), 'utf8');
  const at = src.indexOf('async printLabelDoc(doc, printerId = null, opts = {}) {');
  assert.ok(at > 0, 'the method exists');
  assert.ok(at > src.indexOf('async printKitchenTicket('), 'after printKitchenTicket');
  assert.ok(at < src.indexOf('async printFireCourseTicket('), 'before printFireCourseTicket');
  const body = src.slice(at, src.indexOf('\n  }\n', at));
  assert.ok(body.includes("this._printerForRole('label', printerId)"));
  assert.ok(body.includes(`return { ok: false, error: '${NO_LABEL_PRINTER}' };`), 'the no printer words, exactly');
  assert.ok(body.includes('typeof doc === \'function\' ? doc(printer, resolvePrinterSpec(printer)) : doc'), 'a builder gets the printer and its spec');
  assert.ok(body.includes('await encodeDocForPrinter(built, printer)'));
  assert.ok(body.includes("this._submitJob(printer, 'label', bytes, {"));
  assert.ok(body.includes("metadata: { type: 'label', ...opts.metadata }"));
  assert.ok(body.includes("label: opts.label || 'Label'"));
  assert.doesNotMatch(body, /[\u2013\u2014]/);
  assert.equal(src.split('async printLabelDoc(').length - 1, 1, 'one method only');
});
