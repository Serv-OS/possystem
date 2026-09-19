/**
 * PrintService — Supabase-queued ESC/POS printing
 *
 * Architecture:
 *   POS (any device, any platform) → Supabase print_jobs table → print-agent.js (LAN) → TCP 9100 → Printer
 *
 * No HTTP bridge server. No port forwarding. No CORS.
 * The agent runs on any machine on the same LAN as the printer.
 * Only outbound connections needed: agent → Supabase, agent → printer.
 *
 * Fallback: window.print() always available if Supabase is down.
 */

import { supabase, getLocationId } from './supabase';
import { reportWriteRefused } from './deviceLink';
import { shortOrderRef } from './db.js';
import { loadLocationBranding, mergeBrandingIntoLocation } from './receiptBranding';
import { money } from './currency.js';
import { breakdownLabel, breakdownIsExclusive } from './receiptTax.js';
import { consolidateReceiptLines } from './receiptLines.js';
import { cardReceiptLines } from './cardReceipt.js';
import {
  buildCustomerReceiptDoc, buildMerchantTipSlipDoc, buildKitchenTicketDoc, buildFireCourseTicketDoc,
  buildTransferNoticeTicketDoc, buildTestPageDoc, docHasCut, docHasDrawer,
} from './printDoc.js';
import {
  EscPosBuilder, resolvePrinterSpec, encodeEscPos, encodeStarLine, encodeStarRaster, cashDrawerBytes,
  DIALECT_STAR_LINE, DIALECT_STAR_RASTER,
} from './printerDialects.js';
import { printEnvironment, printSentFromWords } from './printPathWords.js';
import { VERSION } from './version.js';

// ─── Builders ─────────────────────────────────────────────────────────────────
// v5.8.84: the CONTENT of every document lives in printDoc.js (one source of truth for
// every printer model) and the BYTES per model in printerDialects.js: ESC/POS (Sunmi,
// Epson, Bixolon, Citizen, Xprinter, generic), Star Line Mode (TSP650II/700II/800II,
// mC-Print, TSP143IV) and Star raster graphics (TSP143III, which has no text mode).
// The exported builders keep their old signatures: with no printer they return ESC/POS
// bytes at 42 columns, byte identical to the v4 builders (printer.golden.test.js).
// A Star raster printer needs the canvas renderer, so PrintService always encodes through
// encodeDocForPrinter (async); the sync builders below are for ESC/POS and Star Line only.

/** Encode a document for one printer row: ESC/POS or Star Line (sync), Star raster (canvas). */
export async function encodeDocForPrinter(doc, printer) {
  const spec = resolvePrinterSpec(printer);
  if (spec.dialect === DIALECT_STAR_RASTER) {
    const { renderDocToBitmap } = await import('./printerRaster.js');
    const bitmap = await renderDocToBitmap(doc, spec);
    return encodeStarRaster(bitmap, { cut: docHasCut(doc), drawer: docHasDrawer(doc) });
  }
  return encodeTextDoc(doc, printer, spec);
}

function encodeTextDoc(doc, printer, spec = resolvePrinterSpec(printer)) {
  if (spec.dialect === DIALECT_STAR_LINE) return encodeStarLine(doc, spec);
  return encodeEscPos(doc, spec);
}

// The receipt logo and an uploaded footer QR are fetched here as 1 bit bitmaps before the
// pure builder runs, exactly where the old builders awaited the rasteriser. Either failing
// (missing, slow CDN, no DOM) just leaves it off the paper, as before.
async function loadReceiptAssets(location, { qr = true } = {}) {
  const header = location?.receipt_branding?.header || null;
  const footer = location?.receipt_branding?.footer || null;
  const assets = {};
  if (header?.logo_url) {
    try {
      const { imageUrlToBitmap } = await import('./receiptRaster.js');
      assets.logo = await imageUrlToBitmap(header.logo_url, header.logo_width_dots || 384);
    } catch (e) {
      // Never let a missing/slow logo block the receipt: just skip it.
      console.warn('[Print] Logo rasterise failed, skipping:', e.message);
    }
  }
  if (qr && footer?.qr?.enabled && footer.qr.mode === 'upload' && footer.qr.image_url) {
    try {
      const { imageUrlToBitmap } = await import('./receiptRaster.js');
      assets.qrImage = await imageUrlToBitmap(footer.qr.image_url, footer.qr.size_dots || 160);
    } catch (e) {
      console.warn('[Print] Footer QR render failed, skipping:', e.message);
    }
  }
  return assets;
}

export async function buildCustomerReceipt(args, printer = null) {
  const spec = resolvePrinterSpec(printer);
  const assets = await loadReceiptAssets(args?.location);
  return encodeDocForPrinter(buildCustomerReceiptDoc(args, { cols: spec.cols, assets }), printer);
}

export async function buildMerchantTipSlip(args, printer = null) {
  const spec = resolvePrinterSpec(printer);
  const assets = await loadReceiptAssets(args?.location, { qr: false });
  return encodeDocForPrinter(buildMerchantTipSlipDoc(args, { cols: spec.cols, assets }), printer);
}

export function buildKitchenTicket(ticketData, printer = null) {
  return encodeTextDoc(buildKitchenTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
}

export function buildFireCourseTicket(ticketData, printer = null) {
  return encodeTextDoc(buildFireCourseTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
}

export function buildTransferNoticeTicket(ticketData, printer = null) {
  return encodeTextDoc(buildTransferNoticeTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
}

export function buildTestPage(info = null, printer = null) {
  return encodeTextDoc(buildTestPageDoc(info, { cols: resolvePrinterSpec(printer).cols }), printer);
}

// ─── HTML fallback builders ───────────────────────────────────────────────────
function buildReceiptHtml({ location, check, items, totals }) {
  const now = new Date();
  // v5.7.34: venue currency (byte-identical for GBP, symbol swaps for USD/EUR).
  const mny = (n) => money(Number(n) || 0, location?.currency);
  const rows = consolidateReceiptLines(items).map(item=>{
    const modLines = Array.isArray(item.mods) ? item.mods : (item.mods ? item.mods.split(' · ') : []);
    return `
    <div class="row"><span>${item.qty>1?`${item.qty}\xD7 `:''}${item.receiptName||item.name}</span><span>${mny(item.price*item.qty)}</span></div>
    ${modLines.map(m=>`<div style="padding-left:8px;font-size:10px">${typeof m==='string'?m:(m.label||'')}</div>`).join('')}
  `;}).join('');
  return `
    <div class="center bold big">${location?.name||'Restaurant'}</div>
    <div class="center">${location?.address||''}</div>
    <div class="divider"></div>
    <div class="row"><span>ORDER # ${shortOrderRef(check?.ref) ?? ''}</span><span>${now.toLocaleString('en-GB',{dateStyle:'short',timeStyle:'short'})}</span></div>
    <div class="row"><span>Server: ${check?.server}</span><span>${check?.tableLabel||check?.orderType}</span></div>
    <div class="divider"></div>${rows}
    <div class="divider"></div>
    ${(totals.service>0||totals.delivery>0)?`<div class="row"><span>Subtotal</span><span>${mny(totals.subtotal)}</span></div>`:''}
    ${totals.service>0?`<div class="row"><span>Service</span><span>${mny(totals.service)}</span></div>`:''}
    ${totals.delivery>0?`<div class="row"><span>Delivery</span><span>${mny(totals.delivery)}</span></div>`:''}
    ${totals.tip>0?`<div class="row"><span>Tip</span><span>${mny(totals.tip)}</span></div>`:''}
    <div class="row bold big"><span>TOTAL</span><span>${mny(totals.grand)}</span></div>
    ${totals.taxBreakdown?.breakdown?.filter(b=>b.tax>0).map(b => {
      // rate-null guard (per-unit entries): name + amount, no percent, no crash
      const label = breakdownIsExclusive(b) ? breakdownLabel(b, 1) : `of which ${breakdownLabel(b, 1)}`;
      return `<div class="row" style="font-size:10px;color:#666"><span>${label}</span><span>${mny(b.tax)}</span></div>`;
    }).join('') || ''}
    ${(() => {
      // Card-scheme block (masked PAN / scheme / auth code / entry / CVM / AID). Values are
      // card-supplied (EMV app name etc.) — escape them, unlike the operator-controlled copy.
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const cl = cardReceiptLines(check);
      if (!cl.length) return '';
      return `<div class="divider"></div>${cl.map(([l, v]) => `<div class="row"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join('')}<div class="center" style="font-size:10px">Please retain this receipt</div>`;
    })()}
    <div class="divider"></div>
    <div class="center">${location?.receiptFooter||'Thank you for dining with us!'}</div>
  `;
}

function browserPrint(html) {
  const w = window.open('','_blank','width=400,height=600');
  w.document.write(`<html><head><style>
    body{font-family:monospace;font-size:12px;width:72mm;margin:0;padding:4mm;color:#000;background:#fff}
    .center{text-align:center}.bold{font-weight:bold}.big{font-size:16px}
    .divider{border-top:1px dashed #000;margin:4px 0}.row{display:flex;justify-content:space-between}
    @media print{@page{margin:0;size:80mm auto}}
  </style></head><body>${html}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),500)}<\/script></body></html>`);
  w.document.close();
}


// ─── Native Android/iOS bridge ────────────────────────────────────────────────
// On Android: window.RposPrinter is injected by PrinterBridge.java
// On iOS: window.RposPrinter will be injected by WKScriptMessageHandler (future)
// On browser: window.RposPrinter is undefined → falls back to Supabase queue

let _callbackCounter = 0;
const _pendingCallbacks = {};

// Called by Android Java via evaluateJavascript
if (typeof window !== 'undefined') {
  window.__rposPrintCallback = (callbackId, success, error) => {
    const cb = _pendingCallbacks[callbackId];
    if (cb) {
      delete _pendingCallbacks[callbackId];
      if (success) cb.resolve({ ok: true, transport: 'native' });
      else cb.reject(new Error(error || 'Print failed'));
    }
  };
}

function nativePrint(bytes, printerAddress, port = 9100) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.RposPrinter) {
      reject(new Error('Native bridge not available'));
      return;
    }
    const callbackId = 'cb_' + (++_callbackCounter);
    _pendingCallbacks[callbackId] = { resolve, reject };
    const base64 = btoa(String.fromCharCode(...bytes));
    window.RposPrinter.print(base64, printerAddress, port, callbackId);
  });
}

function isNativeBridgeAvailable() {
  return typeof window !== 'undefined' && !!window.RposPrinter;
}

// Get a stable device ID used for claim attribution (shared with MasterSync device id)
function getDeviceId() {
  try {
    const dev = JSON.parse(localStorage.getItem('rpos-device') || 'null');
    return dev?.id || 'unknown-device';
  } catch { return 'unknown-device'; }
}

// Small UUID-ish for idempotency key — enough entropy for our volume
function genIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `ik-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Cross-tab duplicate-receipt guard ────────────────────────────────────────
// Several tabs of the app open on one machine each run the same AUTOMATIC receipt
// print for the same order — boot-loading the order queue does exactly that, and on
// 6 Aug 2026 three Back Office tabs printed two July orders three times each inside
// 0.6s. Nothing downstream catches it: the print_jobs idempotency key carries
// Date.now(), so it is unique per attempt by construction and the DB unique index
// never fires.
//
// This is a machine-local note that a given receipt was just printed, kept in
// localStorage so a tab opened AFTER the first print still sees it (a live
// BroadcastChannel listener would not — a tab that wasn't running never heard the
// message). Nothing here touches the database or the idempotency key.
//
// TTL is deliberately tiny, and that is the whole safety argument. The key says
// "this receipt went to this printer moments ago", not "this order has been
// printed" — a permanent key would eventually suppress a reprint someone
// genuinely asked for. When the window lapses the worst case is the current
// behaviour: an extra receipt.
const RECEIPT_GUARD_STORE = 'rpos-recent-receipts';
const RECEIPT_GUARD_TTL_MS = 10_000;

// location + ref + pennies + the printer it resolved to. The total keeps two
// genuinely different sales apart if a ref is ever duplicated (the offline
// fallback in db.js mints per-device and can repeat a number); the printer
// keeps a deliberate same-receipt-to-two-printers dispatch out of it. Every part is
// derived the same way in every tab (the printer list and this device's assignment
// are shared localStorage), so tabs on one machine agree on the key for one order.
function receiptGuardKey(locationId, ref, grand, printerId) {
  return `${locationId || 'no-loc'}|${ref}|${Math.round((Number(grand) || 0) * 100)}|${printerId || 'no-printer'}`;
}

function readReceiptGuard() {
  const raw = JSON.parse(localStorage.getItem(RECEIPT_GUARD_STORE) || '{}');
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

// FAILS OPEN in every direction: no entry, an unreadable store, localStorage
// throwing (private mode / quota / disabled), or an age that isn't a sane recent
// interval (NaN, or a timestamp in the future after a clock change) all return
// false, which prints.
function receiptPrintedRecently(key) {
  try {
    const age = Date.now() - Number(readReceiptGuard()[key]);
    return Number.isFinite(age) && age >= 0 && age < RECEIPT_GUARD_TTL_MS;
  } catch { return false; }
}

function markReceiptPrinted(key) {
  try {
    const now = Date.now();
    const map = readReceiptGuard();
    // Drop anything outside the window — including future-dated entries, so a clock
    // jump can't leave a guard sitting there suppressing receipts.
    for (const k of Object.keys(map)) {
      const age = now - Number(map[k]);
      if (!(Number.isFinite(age) && age >= 0 && age < RECEIPT_GUARD_TTL_MS)) delete map[k];
    }
    map[key] = now;
    localStorage.setItem(RECEIPT_GUARD_STORE, JSON.stringify(map));
  } catch { /* guard is a nicety; printing is not */ }
}

// A print the operator asked for must never be swallowed by the guard. It can't be
// signalled by the caller: two of the four Print buttons reach printReceipt through
// store.printCustomerReceipt / store.reprintOrderReceipt, which forward no opts at
// all. So read the browser instead. A button press happens in a tab that is on
// screen and holds a live user activation; a background tab replaying the order
// queue has neither. Anything we cannot determine counts as a press.
//
// Must be called synchronously at the top of printReceipt — user activation is
// transient (a few seconds) and every Print button reaches that first line inside
// its own click handler.
function isUserInitiatedPrint() {
  try {
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return true;
    if (!navigator.userActivation) return true;   // not supported here — assume a press
    return document.visibilityState !== 'hidden' && navigator.userActivation.isActive === true;
  } catch { return true; }
}

// ─── Print Service ────────────────────────────────────────────────────────────
class PrintService {
  constructor() {
    this._printers = this._loadPrinters();
  }

  _loadPrinters() {
    try { return JSON.parse(localStorage.getItem('rpos-printers')||'[]'); } catch { return []; }
  }

  _refreshPrinters() {
    this._printers = this._loadPrinters();
  }

  // Find which printer to use for a given role ('receipt' | 'kitchen' | 'bar')
  // v5.5.835: dropped the blind `|| this._printers[0]` tail. Falling back to
  // "whatever printer happens to be first" is never a correct answer — if no
  // printer carries the role, the caller should be told, not guessed at. The
  // role scan itself stays: kitchen / bar / drawer routing still depends on it.
  _printerForRole(role, printerId = null) {
    this._refreshPrinters();
    if (printerId) return this._printers.find(p => p.id === printerId) || null;
    return this._printers.find(p => p.roles?.includes(role)) || null;
  }

  // v5.5.835: CASH DRAWER — deliberately keeps the `|| this._printers[0]` fallback that
  // _printerForRole just dropped. This is NOT a leftover. Do not "tidy" it to match.
  //
  // WHY: a drawer that won't open is an immediate physical failure mid-service — a member
  // of staff at a till who cannot give change. `cashDrawerAttached` defaults to false, so
  // any venue that never ticked that box in Back office → Printers is relying on this
  // fallback chain to find the till printer the drawer is wired into. Removing it would
  // silently break those venues.
  //
  // Receipts fail closed because printing to the WRONG printer is the bug being fixed and
  // a mis-routed receipt is recoverable. A jammed-shut drawer is not the same trade-off,
  // and the drawer was never part of the reported fault. Reproduces the pre-v5.5.835
  // `_printerForRole('receipt', null)` semantics exactly: role scan → first printer → null.
  _drawerPrinter() {
    this._refreshPrinters();
    return this._printers.find(p => p.roles?.includes('receipt')) || this._printers[0] || null;
  }

  // v5.5.835: RECEIPT ROUTING — deliberately separate from _printerForRole.
  //
  // A customer receipt belongs to the device that took the money, not to "whichever
  // printer in the venue happens to carry the receipt role". The old role scan is why
  // an unconfigured MPOS handheld printed to the counter: every printer is created
  // with roles:['receipt'] by default, so the scan always matched something.
  //
  // Resolution order — no guessing at any step:
  //   1. an explicit printerId argument (kitchen-style routing, reprints to a chosen printer)
  //   2. opts.venueScope -> the venue default, and ONLY that. For receipts with no
  //      originating device (HubRise / online / delivery orders fired from OrdersHub).
  //   3. this device's assignment, hydrated from devices.receipt_printer_id at boot
  //   4. nothing. Caller must surface this to the operator — never fall back.
  //
  // Returns { printer, src } where src is 'explicit'|'device'|'venue-default'|'none'.
  _receiptTarget(printerId = null, opts = {}) {
    this._refreshPrinters();

    if (printerId) {
      const p = this._printers.find(x => x.id === printerId) || null;
      if (!p) console.warn(`[Print] Receipt: explicit printerId "${printerId}" is not in this venue's printer list.`);
      return { printer: p, src: p ? 'explicit' : 'none' };
    }

    if (opts.venueScope) {
      const vid = this._venueDefaultPrinterId();
      if (!vid) {
        console.warn('[Print] Receipt: no venue default receipt printer set. Back office → Production printing → Customer receipts. Order-source receipts (online / delivery / HubRise) will not print until one is chosen.');
        return { printer: null, src: 'none' };
      }
      const p = this._printers.find(x => x.id === vid) || null;
      if (!p) console.warn(`[Print] Receipt: venue default printer "${vid}" no longer exists in the printer list.`);
      return { printer: p, src: p ? 'venue-default' : 'none' };
    }

    // Device-originated — and the manual "Print receipt" reprint. Print to THIS till's OWN
    // receipt printer: the device you pressed Print on. v5.5.867: if this device has no printer
    // of its own, fall back to the venue default rather than failing — so a reprint on any till
    // that is connected to a printer just works, and the venue default is a convenience, not a
    // prerequisite. Only "nothing configured anywhere" returns none.
    let cached = null;
    try {
      const raw = localStorage.getItem('rpos-receipt-target');
      if (raw) cached = JSON.parse(raw);
    } catch { /* corrupt cache — treat as unset */ }
    if (cached?.printerId) {
      const p = this._printers.find(x => x.id === cached.printerId) || null;
      if (p) return { printer: p, src: 'device' };
      console.warn(`[Print] Receipt: this device is assigned printer "${cached.printerId}" but it is not in the venue printer list (deleted?) — trying the venue default.`);
    }
    // Fall back to the venue default receipt printer, if one is set.
    const vid = this._venueDefaultPrinterId();
    if (vid) {
      const vp = this._printers.find(x => x.id === vid) || null;
      if (vp) return { printer: vp, src: 'venue-default' };
    }
    console.warn('[Print] Receipt: no receipt printer set for this till (Back office → Devices → Receipt printer) and no venue default. Refusing to guess.');
    return { printer: null, src: 'none' };
  }

  // v5.5.835: venue-wide default receipt printer, for receipts that have no originating
  // device. Set in Back office → Production printing; persisted on ops
  // locations.pos_settings.default_receipt_printer_id and mirrored to localStorage by
  // useSupabaseInit so this stays a synchronous read.
  _venueDefaultPrinterId() {
    try { return localStorage.getItem('rpos-venue-receipt-printer') || null; } catch { return null; }
  }

  // v4.6.30: lightweight printer lookup helpers used by openCashDrawer.
  _allPrinters() {
    try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]') || []; }
    catch { return []; }
  }
  _printerById(id) {
    return this._allPrinters().find(p => p?.id === id) || null;
  }

  // FAST PATH — lazily subscribe a per-location broadcast channel and cache it.
  // First call awaits SUBSCRIBED (typical 100-300ms); every subsequent call
  // returns instantly. This is the single biggest cause of broadcasts being
  // silently dropped — without awaiting subscribe, the first send no-ops
  // because the channel hasn't joined the realtime topic yet.
  async _ensureFastChannel(locationId) {
    if (this._fastChannel && this._fastChannelLocId === locationId && this._fastChannelReady) {
      try { await this._fastChannelReady; } catch {}
      return this._fastChannel;
    }
    // Tear down any stale channel for a different location
    if (this._fastChannel && this._fastChannelLocId !== locationId) {
      try { supabase.removeChannel(this._fastChannel); } catch {}
      this._fastChannel = null;
      this._fastChannelReady = null;
    }
    if (!this._fastChannel) {
      this._fastChannel = supabase.channel(`print-fast:${locationId}`);
      this._fastChannelLocId = locationId;
      this._fastChannelReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('subscribe timeout')), 4000);
        this._fastChannel.subscribe((status) => {
          if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timer); reject(new Error(`channel ${status}`));
          }
        });
      }).catch((e) => {
        // Don't poison the cache forever — let the next print try again
        console.warn('[Print] fast channel subscribe failed:', e?.message);
        this._fastChannel = null;
        this._fastChannelReady = null;
        throw e;
      });
    }
    try { await this._fastChannelReady; return this._fastChannel; }
    catch { return null; }
  }

  // v4.3.0 — DURABLE-FIRST SUBMIT
  // Always inserts a print_jobs row before attempting to dispatch. If the app
  // crashes mid-dispatch, the row survives and the PrintRetrier picks it up.
  //
  // Returns { ok, transport, jobId, printer } on success
  //         { ok:false, error, jobId? } on failure (but job row still exists)
  async _submitJob(printer, jobType, bytes, opts = {}) {
    const ip = printer.address;
    const port = printer.port || 9100;
    const payload = btoa(String.fromCharCode(...bytes));
    const idempotencyKey = opts.idempotencyKey || genIdempotencyKey();
    const metadata = opts.metadata || null;

    // ── MASTER FAST PATH — dispatch FIRST, persist in the background ────────────
    // If this device can print directly (native bridge), send the bytes to the printer
    // IMMEDIATELY, then persist the durable/audit row asynchronously. No Supabase round-trip
    // sits on the hot path, so paper (and the cash-drawer pulse) come out in the printer's
    // own latency — not 2-3s of insert + claim + Realtime choreography. This is the whole
    // point of the master being the print host. Durability is preserved: a FAILED dispatch
    // is persisted (+ offline-queued) for PrintRetrier; a SUCCESS writes a 'done' audit row
    // in the background. An in-memory key window dedupes double-fires without the DB.
    if (isNativeBridgeAvailable() && ip) {
      if (this._isRecentlyDispatched(idempotencyKey)) return { ok: true, transport: 'idempotent', printer: printer.name };
      this._markDispatched(idempotencyKey);
      try {
        const result = await nativePrint(bytes, ip, port);
        this._persistJobAsync(printer, jobType, bytes, idempotencyKey, metadata, 'done', null);
        return { ...result, ok: true, transport: 'native', printer: printer.name };
      } catch (e) {
        const errMsg = e.message || 'Native bridge failure';
        this._persistJobAsync(printer, jobType, bytes, idempotencyKey, metadata, 'failed', errMsg);
        console.warn('[Print] Native dispatch failed — queued for retry:', errMsg);
        return { ok: false, error: errMsg, transport: 'native-failed' };
      }
    }

    // ── FAST PATH (slave / browser: no local printer — master prints) ───────────
    // Fire a Supabase Realtime broadcast BEFORE the durable insert. The master
    // device subscribes to `print-fast:${locationId}` and prints immediately on
    // receipt — typical broadcast latency is 50-150ms each leg, so paper comes
    // out in ~250-500ms vs 2-3s via postgres+realtime.
    //
    // The durable insert below still happens as the audit trail. Master upserts
    // the row to status='printed' on broadcast print success, so the audit
    // record is consistent regardless of which path lands first.
    //
    // CRITICAL: supabase-js channel.send() silently no-ops if the channel
    // isn't in SUBSCRIBED state. We MUST await subscription before the first
    // send. Subsequent sends fire instantly because the channel stays open.
    try {
      const fastLocId = await getLocationId();
      if (supabase && fastLocId) {
        const ch = await this._ensureFastChannel(fastLocId);
        if (ch) {
          // Fire and forget — broadcast send returns 'ok' / 'timed_out' /
          // 'rate_limited'. We don't gate on the result; the durable INSERT
          // below is the safety net for any misses.
          ch.send({
            type: 'broadcast',
            event: 'print',
            payload: {
              idempotency_key: idempotencyKey,
              location_id:     fastLocId,
              printer_id:      printer.id,
              printer_ip:      ip,
              printer_port:    port,
              job_type:        jobType,
              payload_b64:     payload,
              metadata,
              ts:              Date.now(),
            },
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[Print] fast broadcast failed (falling back to durable):', e?.message);
    }

    // ── Step 1: Insert durable row BEFORE any dispatch attempt ─────────────────
    let jobId = null;
    if (supabase) {
      try {
        const locationId = await getLocationId();
        if (locationId) {
          const row = {
            location_id:     locationId,
            printer_id:      printer.id,
            printer_ip:      ip,
            printer_port:    port,
            job_type:        jobType,
            payload,
            status:          'pending',
            idempotency_key: idempotencyKey,
            attempts:        0,
            metadata,
          };
          const { data, error } = await supabase.from('print_jobs').insert(row).select('id').single();
          if (!error) jobId = data?.id;
          else if (error.code === '23505') {
            // idempotency_key collision — job already exists, look it up
            const { data: existing } = await supabase.from('print_jobs').select('id,status').eq('idempotency_key', idempotencyKey).single();
            if (existing) {
              // Already succeeded? Skip dispatch.
              if (existing.status === 'printed' || existing.status === 'done') {
                return { ok: true, transport: 'idempotent', printer: printer.name, jobId: existing.id };
              }
              jobId = existing.id;
            }
          } else {
            reportWriteRefused(error);   // fence stage 1: a refused print job may mean a lost link
            console.warn('[Print] Durable insert failed, will try offline queue:', error.message);
          }
        }
      } catch (e) {
        console.warn('[Print] Durable insert threw:', e.message);
      }
    }

    // If Supabase insert failed, queue it durably via OfflineQueue — will replay on reconnect
    if (!jobId) {
      try {
        const { queueWrite } = await import('../sync/OfflineQueue.js');
        const locationId = (await getLocationId().catch(() => null));
        await queueWrite({
          type: 'insert',
          table: 'print_jobs',
          kind: 'print_job',
          label: opts.label || `${jobType} → ${printer.name}`,
          payload: {
            location_id:     locationId,
            printer_id:      printer.id,
            printer_ip:      ip,
            printer_port:    port,
            job_type:        jobType,
            payload,
            status:          'pending',
            idempotency_key: idempotencyKey,
            attempts:        0,
            metadata,
          },
        });
      } catch (e) {
        // Last resort: try native bridge directly without durability.
        // Only acceptable fallback if supabase is genuinely unreachable.
        console.warn('[Print] OfflineQueue unavailable:', e.message);
      }
    }

    // ── Step 2: Try to dispatch immediately via native bridge (fast path) ───────
    if (isNativeBridgeAvailable() && ip) {
      const deviceId = getDeviceId();
      if (jobId && supabase) {
        // Claim the job so retrier won't race us
        try {
          await supabase.from('print_jobs')
            .update({ status: 'sending', claimed_by: deviceId, claimed_at: new Date().toISOString() })
            .eq('id', jobId);
        } catch {}
      }
      try {
        const result = await nativePrint(bytes, ip, port);
        // Update job row to printed
        if (jobId && supabase) {
          try {
            await supabase.from('print_jobs').update({
              status: 'done',
              processed_at: new Date().toISOString(),
              agent_id: deviceId,
            }).eq('id', jobId);
          } catch {}
        }
        return { ...result, transport: 'native', printer: printer.name, jobId };
      } catch (e) {
        // Native bridge failed — mark failed with short retry, PrintRetrier will pick up
        const errMsg = e.message || 'Native bridge failure';
        if (jobId && supabase) {
          try {
            const nextRetry = new Date(Date.now() + 2000).toISOString();
            await supabase.from('print_jobs').update({
              status: 'failed',
              error_message: errMsg,
              attempts: 1,
              next_retry_at: nextRetry,
              claimed_by: null,
              claimed_at: null,
              processed_at: new Date().toISOString(),
            }).eq('id', jobId);
          } catch {}
        }
        console.warn('[Print] Native bridge failed — row marked for retry:', errMsg);
        return { ok: false, error: errMsg, transport: 'native-failed', jobId };
      }
    }

    // ── Step 3: No native bridge — row is pending, agent will pick up ──────────
    return { ok: true, transport: 'queued', printer: printer.name, jobId };
  }

  // ── Master fast-path helpers ───────────────────────────────────────────────
  // In-memory dedup so a double-fire of the same idempotency key can't print twice
  // without waiting on the DB unique constraint (60s window).
  _isRecentlyDispatched(key) {
    const m = this._recentKeys || (this._recentKeys = new Map());
    const t = m.get(key);
    return !!t && (Date.now() - t) < 60_000;
  }
  _markDispatched(key) {
    const m = this._recentKeys || (this._recentKeys = new Map());
    m.set(key, Date.now());
    if (m.size > 500) for (const [k, ts] of m) if (Date.now() - ts > 60_000) m.delete(k);
  }
  // Persist the durable/audit print_jobs row OFF the hot path (after the bytes are already
  // sent). 'done' = audit only; 'failed' = retry trigger (PrintRetrier polls it), with an
  // OfflineQueue fallback so a failed print is never lost if Supabase is unreachable.
  _persistJobAsync(printer, jobType, bytes, idempotencyKey, metadata, status, errorMsg) {
    (async () => {
      try {
        if (!supabase) return;
        const locationId = await getLocationId().catch(() => null);
        if (!locationId) return;
        const base = {
          location_id: locationId, printer_id: printer.id, printer_ip: printer.address,
          printer_port: printer.port || 9100, job_type: jobType,
          payload: btoa(String.fromCharCode(...bytes)), idempotency_key: idempotencyKey, metadata,
        };
        const row = status === 'done'
          ? { ...base, status: 'done', attempts: 0, processed_at: new Date().toISOString(), agent_id: getDeviceId() }
          : { ...base, status: 'failed', attempts: 1, error_message: errorMsg, next_retry_at: new Date(Date.now() + 2000).toISOString(), processed_at: new Date().toISOString() };
        const { error } = await supabase.from('print_jobs').insert(row);
        if (error && error.code !== '23505' && status === 'failed') {
          try { const { queueWrite } = await import('../sync/OfflineQueue.js'); await queueWrite({ type: 'insert', table: 'print_jobs', kind: 'print_job', payload: row }); } catch { /* last resort */ }
        }
      } catch (e) { console.warn('[Print] async persist failed:', e?.message); }
    })();
  }

  // Called by PrintRetrier (master POS only) to redispatch a failed/retry-pending job.
  // Only dispatches via native bridge — agent handles its own polling.
  async dispatchJob(jobRow) {
    if (!isNativeBridgeAvailable() || !jobRow.printer_ip) {
      return { ok: false, error: 'No native bridge on this device' };
    }
    const deviceId = getDeviceId();
    const bytes = Uint8Array.from(atob(jobRow.payload), c => c.charCodeAt(0));
    try {
      await nativePrint(bytes, jobRow.printer_ip, jobRow.printer_port || 9100);
      // Mark printed
      if (supabase) {
        await supabase.from('print_jobs').update({
          status: 'done',
          processed_at: new Date().toISOString(),
          agent_id: deviceId,
          claimed_by: null,
          claimed_at: null,
        }).eq('id', jobRow.id);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Called by PrintOrchestrator.dispatchJob (v4.3). Thin wrapper that dispatches
  // bytes via the native bridge and returns { ok, error } — orchestrator handles
  // the durable-row state transitions itself.
  //
  // This method was referenced by PrintOrchestrator since v4.3 but never
  // implemented on PrintService, which caused every orchestrator dispatch on
  // native-bridge devices (Sunmi etc.) to throw TypeError and mark the row
  // failed. Symptom: "Printer offline" in Back Office, jobs stuck in failed/
  // failed_permanent despite printer being fully reachable.
  async _dispatchBytesDirect(bytes, ip, port = 9100) {
    if (!isNativeBridgeAvailable()) {
      return { ok: false, error: 'No native bridge on this device (browser-only)' };
    }
    if (!ip) {
      return { ok: false, error: 'No printer IP' };
    }
    try {
      await nativePrint(bytes, ip, port);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'Native print failed' };
    }
  }

  // Public API — opts: { idempotencyKey?, metadata?, label?, skipBranding? }
  async printReceipt({ location, check, items, totals }, printerId = null, opts = {}) {
    // Read BEFORE the first await — user activation is transient and the awaits
    // below (branding fetch) can outlast it. See isUserInitiatedPrint.
    const userInitiated = isUserInitiatedPrint();

    // Auto-fetch per-location branding so callers don't have to. Non-blocking:
    // if the branding fetch fails for any reason we fall through to the plain
    // text receipt using the location fields already present.
    let locationWithBranding = location;

    // If caller didn't populate location.id, fall back to getLocationId() —
    // POSSurface destructures `location` from the Zustand store, but the store
    // has no `location` field, so location is undefined at call time. Without
    // this fallback the branding fetch is skipped entirely.
    let effectiveLocationId = location?.id || null;
    if (!effectiveLocationId && !opts?.skipBranding) {
      try { effectiveLocationId = await getLocationId(); } catch {}
    }

    if (!opts?.skipBranding && (effectiveLocationId || location?.receipt_branding)) {
      try {
        const branding = location?.receipt_branding || await loadLocationBranding(effectiveLocationId);
        if (branding) locationWithBranding = mergeBrandingIntoLocation(location || { id: effectiveLocationId }, branding);
      } catch (e) {
        console.warn('[Print] Branding fetch failed, using plain receipt:', e?.message || e);
      }
    }

    // v5.5.835: route by DEVICE assignment (or an explicit id / the venue default),
    // never by a role scan across the whole venue. See _receiptTarget.
    const { printer, src } = this._receiptTarget(printerId, opts);
    if (printer?.address) {
      // Cross-tab duplicate guard (see RECEIPT_GUARD_STORE). Only the automatic path
      // is ever suppressed — a press always prints — but BOTH paths leave the mark, so
      // a receipt the operator printed also stops the automatic copy behind it. Marked
      // before dispatch, not after: the six duplicates arrived inside 0.6s, so a mark
      // that waits for the printer is too late to stop the tab beside it.
      const guardKey = check?.ref ? receiptGuardKey(effectiveLocationId, check.ref, totals?.grand, printer.id) : null;
      if (guardKey) {
        if (!userInitiated && receiptPrintedRecently(guardKey)) {
          console.info(`[Print] Receipt ${check.ref} was printed on this machine seconds ago — skipping this automatic copy.`);
          return { ok: true, transport: 'duplicate-suppressed', printer: printer.name };
        }
        markReceiptPrinted(guardKey);
      }
      const bytes = await buildCustomerReceipt({ location: locationWithBranding, check, items, totals }, printer);
      return this._submitJob(printer, 'receipt', bytes, {
        idempotencyKey: opts.idempotencyKey || (check?.ref ? `receipt-${check.ref}-${Date.now()}` : undefined),
        metadata: { ref: check?.ref, total: totals?.grand, tableLabel: check?.tableLabel, orderType: check?.orderType, server: check?.server, routedBy: src },
        label: `Receipt ${check?.ref || ''} — ${money((totals?.grand || 0))}`.trim(),
      });
    }

    // v5.5.835: FAIL CLOSED. The browser-print fallback used to fire automatically
    // whenever no thermal printer resolved, which is half of why an unconfigured
    // device still produced output. It is now opt-in and passed ONLY by the two
    // user-initiated reprint buttons (ReceiptModal, CheckHistory) — that is how
    // someone prints or PDFs a receipt from a laptop with no thermal printer.
    if (opts.allowBrowserFallback) {
      browserPrint(buildReceiptHtml({ location: locationWithBranding, check, items, totals }));
      return { ok: true, transport: 'browser' };
    }
    const error = printer && !printer.address
      ? `Receipt printer "${printer.name || printer.id}" has no address configured`
      : opts.venueScope
        ? 'No default receipt printer set for this venue'
        : 'No receipt printer configured for this device';
    console.warn(`[Print] Receipt not printed — ${error}.`);
    return { ok: false, error, reason: 'no-printer' };
  }

  // v5.7.5 - merchant tip slip (US signature flow). Same routing + branding as
  // the customer receipt, but its OWN duplicate-guard keyspace: printReceipt's
  // guard keys on location|ref|pennies|printer, and this slip prints seconds
  // after that receipt for the same ref and total - sharing the key would eat
  // exactly one of the two every time. Prefixing the ref keeps one guard store,
  // two keyspaces, and still stops a cross-tab double slip.
  async printMerchantTipSlip({ location, check, totals }, printerId = null, opts = {}) {
    let locationWithBranding = location;
    let effectiveLocationId = location?.id || null;
    if (!effectiveLocationId) {
      try { effectiveLocationId = await getLocationId(); } catch { /* branding optional */ }
    }
    if (effectiveLocationId || location?.receipt_branding) {
      try {
        const branding = location?.receipt_branding || await loadLocationBranding(effectiveLocationId);
        if (branding) locationWithBranding = mergeBrandingIntoLocation(location || { id: effectiveLocationId }, branding);
      } catch (e) {
        console.warn('[Print] Tip slip branding fetch failed, using plain slip:', e?.message || e);
      }
    }
    const { printer, src } = this._receiptTarget(printerId, opts);
    if (!printer?.address) {
      return { ok: false, error: 'No receipt printer configured for this device', reason: 'no-printer' };
    }
    const guardKey = check?.ref
      ? receiptGuardKey(effectiveLocationId, `tipslip:${check.ref}`, totals?.grand, printer.id)
      : null;
    if (guardKey) {
      if (receiptPrintedRecently(guardKey)) {
        console.info(`[Print] Tip slip for ${check.ref} was printed on this machine seconds ago - skipping the duplicate.`);
        return { ok: true, transport: 'duplicate-suppressed', printer: printer.name };
      }
      markReceiptPrinted(guardKey);
    }
    const bytes = await buildMerchantTipSlip({ location: locationWithBranding, check, totals }, printer);
    return this._submitJob(printer, 'receipt', bytes, {
      idempotencyKey: opts.idempotencyKey || (check?.ref ? `tipslip-${check.ref}-${Date.now()}` : undefined),
      metadata: { ref: check?.ref, total: totals?.grand, tableLabel: check?.tableLabel, type: 'merchant-tip-slip', routedBy: src },
      label: `Tip slip ${check?.ref || ''} - ${money(totals?.grand || 0)}`.trim(),
    });
  }

  async printKitchenTicket(ticketData, printerId = null, opts = {}) {
    const printer = this._printerForRole('kitchen', printerId);
    if (printer?.address) {
      // ticketData.delivery (if set) renders the channel block. Encoded for THIS printer's
      // dialect (ESC/POS, Star Line Mode, or Star raster via the canvas renderer).
      const bytes = await encodeDocForPrinter(buildKitchenTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
      return this._submitJob(printer, 'kitchen', bytes, {
        idempotencyKey: opts.idempotencyKey,
        metadata: { tableLabel: ticketData.table, server: ticketData.server, covers: ticketData.covers, course: ticketData.course, centreName: ticketData.centreName },
        label: `Kitchen ticket — ${ticketData.table || 'Walk-in'} (${ticketData.centreName || 'kitchen'})`,
      });
    }
    return { ok: false, error: 'No kitchen printer configured' };
  }

  async printFireCourseTicket(ticketData, printerId = null, opts = {}) {
    const printer = this._printerForRole('kitchen', printerId);
    if (printer?.address) {
      const bytes = await encodeDocForPrinter(buildFireCourseTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
      return this._submitJob(printer, 'kitchen', bytes, {
        idempotencyKey: opts.idempotencyKey,
        metadata: { tableLabel: ticketData.table, courseNum: ticketData.courseNum, centreName: ticketData.centreName, type: 'fire-marker' },
        label: `Fire course ${ticketData.courseNum} — ${ticketData.table || 'Walk-in'} (${ticketData.centreName || 'kitchen'})`,
      });
    }
    return { ok: false, error: 'No kitchen printer configured' };
  }


  async printTransferNoticeTicket(ticketData, printerId = null, opts = {}) {
    // v4.6.28: kitchen alert on table move. Uses the kitchen-role printer for
    // the centre, same routing as a normal ticket, different builder.
    const printer = this._printerForRole('kitchen', printerId);
    if (printer?.address) {
      const bytes = await encodeDocForPrinter(buildTransferNoticeTicketDoc(ticketData, { cols: resolvePrinterSpec(printer).cols }), printer);
      return this._submitJob(printer, 'kitchen', bytes, {
        idempotencyKey: opts.idempotencyKey,
        metadata: {
          fromTable: ticketData.fromTable,
          toTable: ticketData.toTable,
          centreName: ticketData.centreName,
          itemCount: (ticketData.items||[]).length,
        },
        label: `Transfer notice \u2014 ${ticketData.fromTable||'?'} \u2192 ${ticketData.toTable||'?'} (${ticketData.centreName||'kitchen'})`,
      });
    }
    return { ok: false, error: 'No kitchen printer configured' };
  }
  async printTestPage(printer) {
    if (!printer?.address) throw new Error('No printer address');
    // v5.8.84: the page describes itself (model, dialect, address, paper, where it was
    // sent from, app version) so a photo of it tells us which path printed it.
    const spec = resolvePrinterSpec(printer);
    const env = printEnvironment();
    const doc = buildTestPageDoc({ printer, spec, version: VERSION, sentFrom: printSentFromWords(env) }, { cols: spec.cols });
    const bytes = await encodeDocForPrinter(doc, printer);
    return this._submitJob(printer, 'test', bytes, {
      label: `Test print → ${printer.name}`,
      metadata: { model: spec.model, dialect: spec.dialect, paper: spec.paper, env, version: VERSION },
    });
  }

  async openCashDrawer(printerId = null) {
    // v4.6.30: prefer a printer explicitly flagged as cashDrawerAttached in the
    // back-office Printers section. Fall back to the receipt-role printer if
    // none is flagged — preserves prior behaviour for existing installs.
    let printer = null;
    if (printerId) {
      printer = this._printerById ? this._printerById(printerId) : this._printerForRole('receipt', printerId);
    } else {
      // v5.5.835: was _printerForRole('receipt', null). Pinned to _drawerPrinter() so the
      // drawer keeps its original fallback chain even though _printerForRole no longer
      // falls back to the first printer — see the comment on _drawerPrinter.
      const all = this._allPrinters ? this._allPrinters() : [];
      printer = all.find(p => p?.cashDrawerAttached && p?.address)
             || this._drawerPrinter();
    }
    if (!printer?.address) throw new Error('No printer with cash drawer configured');
    // v5.8.84: the pulse in the printer's own dialect (ESC p on ESC/POS, unchanged; ESC BEL
    // + BEL on Star Line Mode; ESC * r D on a Star raster printer), sent through the normal
    // print path. The native bridges' openCashDrawer (a fixed ESC p) is no longer called.
    const bytes = cashDrawerBytes(resolvePrinterSpec(printer));
    return this._submitJob(printer, 'cash_drawer', bytes, { metadata: { dialect: resolvePrinterSpec(printer).dialect } });
  }

  // Watch a job's status in Supabase (for feedback in the UI)
  watchJob(jobId, onUpdate) {
    if (!supabase) return () => {};
    const channel = supabase
      .channel(`job-${jobId}`)
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'print_jobs', filter:`id=eq.${jobId}` },
        payload => onUpdate(payload.new))
      .subscribe();
    return () => supabase.removeChannel(channel);
  }

  // Update printer_health table after a job completes — called by PrinterRegistry after test
  async recordPrinterHealth(printerId, status, error = null) {
    if (!supabase) return;
    try {
      const locationId = await getLocationId();
      if (!locationId) return;
      const now = new Date().toISOString();
      await supabase.from('printer_health').upsert({
        printer_id: printerId,
        location_id: locationId,
        status,
        last_job_at: now,
        ...(status === 'online'  ? { last_success_at: now, consecutive_failures: 0 } : {}),
        ...(status === 'offline' || status === 'error' ? {
          last_error_at: now,
          last_error: error || 'Unknown error',
        } : {}),
        updated_at: now,
      }, { onConflict: 'printer_id' });
    } catch(e) { console.warn('printer_health update failed', e); }
  }

  // Load printer health from Supabase
  async getPrinterHealth(locationId) {
    if (!supabase || !locationId) return {};
    try {
      const { data } = await supabase.from('printer_health').select('*').eq('location_id', locationId);
      return Object.fromEntries((data || []).map(r => [r.printer_id, r]));
    } catch { return {}; }
  }

  // Watch all printer health changes in realtime
  watchPrinterHealth(locationId, onUpdate) {
    if (!supabase) return () => {};
    const channel = supabase
      .channel(`printer-health-${locationId}`)
      .on('postgres_changes', { event:'*', schema:'public', table:'printer_health', filter:`location_id=eq.${locationId}` },
        payload => onUpdate(payload.new || payload.old))
      .subscribe();
    return () => supabase.removeChannel(channel);
  }

  // Watch print agent heartbeats
  watchAgents(locationId, onUpdate) {
    if (!supabase) return () => {};
    const channel = supabase
      .channel(`printer-agents-${locationId}`)
      .on('postgres_changes', { event:'*', schema:'public', table:'printer_agents', filter:`location_id=eq.${locationId}` },
        payload => onUpdate(payload.new))
      .subscribe();
    return () => supabase.removeChannel(channel);
  }
}

export const printService = new PrintService();

// v5.5.835: can THIS device print a customer receipt right now? Used by the MPOS
// receipt screens to disable (never hide) the "Print at counter" button with a real
// reason, instead of letting a server tap it and have the receipt go nowhere.
// Returns { ok, reason } — reason is null when ok.
export function receiptTargetStatus() {
  const { printer } = printService._receiptTarget();
  if (!printer) return { ok: false, reason: 'No printer set for this device' };
  if (!printer.address) return { ok: false, reason: `${printer.name || 'Assigned printer'} has no address set` };
  return { ok: true, reason: null };
}

export { EscPosBuilder, isNativeBridgeAvailable };
