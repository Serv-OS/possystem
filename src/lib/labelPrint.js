/**
 * labelPrint.js: one label to the Label printer role (multi site stock Drop 2, v5.11.93, map 8.3
 * step 7, contract 3.3). The Back Office label screen (produce/BatchLabels.jsx) and the KDS recipe
 * card both print through here, so the words and the job shape are the same on every path.
 *
 *   printLabel(doc, { printerId, label, idempotencyKey, metadata })
 *       doc is a printDoc document (lib/stock/batchLabel.js), or a function (printer, spec) that
 *       builds one at that printer's column count. Answers { ok, error, printer, transport, jobId },
 *       never throws. No label printer: the contract's words. A refused document ({ error }, the
 *       PPDS label before sign off) never reaches a printer.
 *   labelPrinter()   the printer that carries the Label printer role, or null (for a preview's
 *                    column count and the "no label printer" line before anyone presses Print)
 *
 * printer.js is loaded when the first label is asked for (it reads the Supabase client and the
 * browser's import.meta.env, which node --test cannot load), so labelPrint.test.js drives every
 * line here with a stand in service through the `service` option. printer.js already loads its
 * raster renderer the same way.
 */

import { NO_LABEL_PRINTER } from './stock/batchLabel.js';

export const NOTHING_TO_PRINT = 'Nothing to print.';
export const PRINT_NOT_HERE = 'Printing is not available on this device.';
export const PRINT_NEEDS_APP = 'This app needs an update to print labels.';
export const LABEL_FAILED = 'The label did not print.';

let servicePromise = null;
async function loadPrintService() {
  if (!servicePromise) servicePromise = import('./printer.js').then((m) => m.printService);
  return servicePromise;
}

/** A key that stops a double press printing twice: 'label-<time>-<random>'. */
export function labelKey(now = Date.now(), random = Math.random()) {
  return `label-${now}-${Math.floor(random * 1e6).toString(36)}`;
}

/** The job options printLabelDoc is given (pure): the key, the job's name and its metadata. */
export function labelJobOpts({ label = null, idempotencyKey = null, metadata = null } = {}) {
  const name = String(label || '').trim() || 'Label';
  return {
    idempotencyKey: idempotencyKey || labelKey(),
    label: name,
    metadata: { ...(metadata || {}) },
  };
}

/**
 * The print service's answer in one shape (pure): { ok, error, printer, transport, jobId }.
 * A false answer with no words gets the plain one; an idempotent repeat is ok.
 */
export function labelPrintOutcome(result) {
  const ok = !!result?.ok;
  return {
    ok,
    error: ok ? null : String(result?.error || LABEL_FAILED),
    printer: result?.printer || null,
    transport: result?.transport || null,
    jobId: result?.jobId || null,
  };
}

/** True when the words are the "no label printer" refusal (the screen then points at Hardware). */
export function isNoPrinter(error) {
  return String(error?.message || error || '') === NO_LABEL_PRINTER;
}

/**
 * Print one label. `doc` is a built document or a builder (printer, spec) => doc. A builder that
 * answers { error } (the PPDS label before sign off) stops the job with those words.
 */
export async function printLabel(doc, { printerId = null, label = null, idempotencyKey = null, metadata = null, service = null } = {}) {
  if (!doc) return labelPrintOutcome({ ok: false, error: NOTHING_TO_PRINT });
  if (typeof doc !== 'function') {
    if (doc.error) return labelPrintOutcome({ ok: false, error: doc.error });
    if (!Array.isArray(doc.ops) || !doc.ops.length) return labelPrintOutcome({ ok: false, error: NOTHING_TO_PRINT });
  }
  let svc = service;
  if (!svc) {
    try { svc = await loadPrintService(); } catch { return labelPrintOutcome({ ok: false, error: PRINT_NOT_HERE }); }
  }
  if (!svc || typeof svc.printLabelDoc !== 'function') return labelPrintOutcome({ ok: false, error: PRINT_NEEDS_APP });
  const build = typeof doc === 'function'
    ? (printer, spec) => {
      const built = doc(printer, spec);
      if (!built || built.error) throw new Error(built?.error || NOTHING_TO_PRINT);
      if (!Array.isArray(built.ops) || !built.ops.length) throw new Error(NOTHING_TO_PRINT);
      return built;
    }
    : doc;
  let r;
  try { r = await svc.printLabelDoc(build, printerId, labelJobOpts({ label, idempotencyKey, metadata })); } catch (e) { r = { ok: false, error: e?.message || LABEL_FAILED }; }
  return labelPrintOutcome(r);
}

/** The printer with the Label printer role (null when none is set up here). Never throws. */
export async function labelPrinter({ service = null } = {}) {
  let svc = service;
  if (!svc) {
    try { svc = await loadPrintService(); } catch { return null; }
  }
  if (!svc || typeof svc._printerForRole !== 'function') return null;
  try { return svc._printerForRole('label', null) || null; } catch { return null; }
}
