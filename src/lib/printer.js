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
import { loadLocationBranding, mergeBrandingIntoLocation, invalidateBrandingCache } from './receiptBranding';

// ─── ESC/POS builder ──────────────────────────────────────────────────────────
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// v4.6.5 follow-up: transliterate common Unicode punctuation to ASCII so em
// dashes, curly quotes, bullets, middle dots, emoji etc. don't print as '?'.
// Anything still outside Latin-1 after this falls back to '?' in text().
function _t(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u00B7\u2022]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2122/g, '(TM)')
    .replace(/\u00A9/g, '(c)')
    .replace(/\u00AE/g, '(R)')
    .replace(/\u00B0/g, ' deg')
    .replace(/\u20AC/g, 'EUR')
    .replace(/[\uD800-\uDFFF]/g, '');
}

class EscPosBuilder {
  constructor(charWidth = 42) { this.bytes = []; this.charWidth = charWidth; }

  _push(...args) {
    for (const a of args) {
      if (a instanceof Uint8Array) { for (let i = 0; i < a.length; i++) this.bytes.push(a[i]); }
      else if (Array.isArray(a)) this.bytes.push(...a);
      else if (typeof a === 'string') {
        for (let i = 0; i < a.length; i++) this.bytes.push(a.charCodeAt(i) & 0xff);
      }
      else this.bytes.push(a);
    }
    return this;
  }
  /** Append raw ESC/POS bytes (from rasteriser, QR helper, etc.). */
  raw(bytes) { return this._push(bytes); }

  init()             { return this._push([ESC,0x40]); }
  cut()              { return this._push([GS,0x56,0x42,0x00]); }
  cashDrawer()       { return this._push([ESC,0x70,0x00,0x19,0x19]); }
  lf(n=1)            { for(let i=0;i<n;i++) this._push(LF); return this; }
  bold(on=true)      { return this._push([ESC,0x45,on?1:0]); }
  center()           { return this._push([ESC,0x61,0x01]); }
  left()             { return this._push([ESC,0x61,0x00]); }
  doubleHeight()     { return this._push([ESC,0x21,0x10]); }
  doubleBoth()       { return this._push([ESC,0x21,0x30]); }
  normal()           { return this._push([ESC,0x21,0x00],[ESC,0x45,0x00],[ESC,0x61,0x00]); }
  underline(on)      { return this._push([ESC,0x2d,on?1:0]); }
  fontB()            { return this._push([ESC,0x4d,0x01]); }
  fontA()            { return this._push([ESC,0x4d,0x00]); }
  red()              { return this._push([ESC,0x72,0x01]); }  // ESC r 1 = red ink
  black()            { return this._push([ESC,0x72,0x00]); }  // ESC r 0 = black ink

  text(str) { return this._push(_t(str||'').replace(/[^\x00-\xff]/g,'?')); }
  line(str='') { return this.text(str).lf(); }
  divider(c='-') { return this.line(c.repeat(this.charWidth)); }

  twoCol(left, right) {
    const l=String(left||''), r=String(right||'');
    const pad=Math.max(1, this.charWidth-l.length-r.length);
    return this.line(l+' '.repeat(pad)+r);
  }

  centeredLine(str) {
    const s=String(str||'');
    const pad=Math.max(0,Math.floor((this.charWidth-s.length)/2));
    return this.line(' '.repeat(pad)+s);
  }

  toBytes() { return new Uint8Array(this.bytes); }
  toBase64() { return btoa(String.fromCharCode(...this.bytes)); }
}

// ─── Receipt templates ────────────────────────────────────────────────────────
// buildCustomerReceipt is async because it may await image rasterisation
// (header logo, footer QR image mode). The native QR path is synchronous.
// All branding is optional: a location with no receipt_branding falls back
// to the legacy text-only receipt unchanged.
export async function buildCustomerReceipt({ location, check, items, totals }) {
  // Defensive: callers historically passed { subtotal, tip, total } instead of
  // { subtotal, service, tip, grand }. Normalise so totals.grand.toFixed() etc
  // never crashes, and the receipt prints with sensible numbers either way.
  totals = {
    subtotal: Number(totals?.subtotal ?? check?.subtotal ?? 0) || 0,
    service:  Number(totals?.service  ?? check?.service  ?? 0) || 0,
    tip:      Number(totals?.tip      ?? check?.tip      ?? 0) || 0,
    grand:    Number(totals?.grand    ?? totals?.total   ?? check?.total ?? 0) || 0,
    taxBreakdown: totals?.taxBreakdown,
  };
  const b = new EscPosBuilder(42);
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  const dateStr = now.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

  const branding = location?.receipt_branding || null;
  const header = branding?.header || null;
  const footer = branding?.footer || null;

  b.init();

  // ── Header logo (raster) ────────────────────────────────────────────────
  if (header?.logo_url) {
    try {
      const { imageUrlToEscPosRaster } = await import('./receiptRaster.js');
      const rasterBytes = await imageUrlToEscPosRaster(
        header.logo_url,
        header.logo_width_dots || 384,
      );
      b.center().raw(rasterBytes).lf();
    } catch (e) {
      // Never let a missing/slow logo block the receipt — just skip it.
      console.warn('[Print] Logo rasterise failed, skipping:', e.message);
    }
  }

  // ── Business name / address / phone / tax id ────────────────────────────
  const businessName = header?.business_name || location?.name || 'Restaurant';
  b.center().bold(true).doubleBoth().text(businessName).lf().normal().center();

  const addressLines = header?.address_lines?.length
    ? header.address_lines.filter(Boolean)
    : (location?.address ? String(location.address).split('\n') : []);
  addressLines.forEach(line => b.line(line));

  if (header?.phone)  b.line(header.phone);
  if (header?.tax_id) b.fontB().line(header.tax_id).fontA();

  b.lf().divider().left();

  // ── Check header ────────────────────────────────────────────────────────
  // Order number — prominent, centered, double-height so it's impossible to miss.
  b.bold(true).doubleHeight().center().line(`ORDER # ${check?.ref||''}`).normal().left();
  b.twoCol('Date', `${dateStr} ${timeStr}`);
  if (header?.show_server_name !== false) {
    b.twoCol(`Server: ${check?.server||''}`, check?.covers>1 && header?.show_covers !== false ? `${check.covers} covers` : '');
  }
  b.twoCol(`${check?.tableLabel||check?.orderType||''}`, '')
   .divider()
   .bold(true).line('ITEMS').bold(false);

  (items||[]).filter(i=>!i.voided).forEach(item=>{
    const linePrice=`\xA3${(item.price*item.qty).toFixed(2)}`;
    const nameStr=item.qty>1?`${item.qty}x ${item.name}`:item.name;
    b.twoCol(nameStr.substring(0,42-linePrice.length-1), linePrice);
    const modLines = Array.isArray(item.mods) ? item.mods : (item.mods ? item.mods.split(' · ') : []);
    modLines.forEach(m => b.fontB().line(`  ${typeof m === 'string' ? m : (m.label||'')}`).fontA());
    if(item.notes) b.fontB().line(`  Note: ${item.notes}`).fontA();
  });

  b.divider();
  if(totals.subtotal!==totals.grand) b.twoCol('Subtotal',`\xA3${totals.subtotal.toFixed(2)}`);
  if(totals.service>0) b.twoCol('Service (12.5%)',`\xA3${totals.service.toFixed(2)}`);
  if(totals.tip>0) b.twoCol('Tip',`\xA3${totals.tip.toFixed(2)}`);

  // Tax breakdown
  if(totals.taxBreakdown?.breakdown?.length) {
    const hasExcl = totals.taxBreakdown.hasExclusiveTax;
    if(hasExcl) {
      // US: show net + tax lines
      b.twoCol('Subtotal (ex. tax)',`\xA3${totals.taxBreakdown.subtotal.toFixed(2)}`);
      totals.taxBreakdown.breakdown.forEach(br => {
        const pct = (br.rate.rate*100).toFixed(1).replace('.0','');
        b.twoCol(`${br.rate.name} (${pct}%)`,`\xA3${br.tax.toFixed(2)}`);
      });
    } else {
      // UK: show 'of which VAT' lines under total
      totals.taxBreakdown.breakdown.forEach(br => {
        if(br.tax > 0) {
          const pct = (br.rate.rate*100).toFixed(1).replace('.0','');
          b.fontB().twoCol(`  of which ${br.rate.name} (${pct}%)`,`\xA3${br.tax.toFixed(2)}`).fontA();
        }
      });
    }
  }

  b.bold(true).doubleHeight()
   .twoCol('TOTAL',`\xA3${totals.grand.toFixed(2)}`)
   .normal();

  if(check?.method) b.divider().twoCol('Payment',check.method.toUpperCase()).twoCol('Status','PAID');

  // ── Footer message ─────────────────────────────────────────────────────
  const footerMsg = footer?.message || location?.receiptFooter || 'Thank you for dining with us!';
  b.lf().center().line(footerMsg);

  // ── Footer QR code ─────────────────────────────────────────────────────
  const qr = footer?.qr;
  if (qr?.enabled) {
    try {
      if (qr.mode === 'url' && qr.url_value) {
        // Native ESC/POS QR — crisp at any paper width, no image fetch
        const { qrTextToEscPosBytes } = await import('./receiptRaster.js');
        const moduleSize = Math.max(1, Math.min(16, Math.round((qr.size_dots || 160) / 25)));
        b.lf().center().raw(qrTextToEscPosBytes(qr.url_value, moduleSize, 'M')).lf();
      } else if (qr.mode === 'upload' && qr.image_url) {
        // Uploaded QR as a rasterised image
        const { imageUrlToEscPosRaster } = await import('./receiptRaster.js');
        const rasterBytes = await imageUrlToEscPosRaster(qr.image_url, qr.size_dots || 160);
        b.lf().center().raw(rasterBytes).lf();
      }
      if (qr.caption) b.fontB().center().line(qr.caption).fontA();
    } catch (e) {
      console.warn('[Print] Footer QR render failed, skipping:', e.message);
    }
  }

  b.fontB().line('Powered by Restaurant OS').fontA()
   .lf(4).cut();

  return b.toBytes();
}

export function buildKitchenTicket({ table, server, covers, course, centreName, items, sentAt }) {
  const b = new EscPosBuilder(42);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=')
   .left().bold(true).doubleBoth();

  // Use native ESC center (not space-padded centeredLine) — centeredLine pads to
  // full charWidth (42) which overflows when doubleBoth is active: spaces print
  // double-wide too, so 42 cols of padded content becomes ~50 physical cols and wraps.
  // Result looked like the table number was right-aligned and on two lines.
  if(table) {
    // v4.6.5 follow-up: only prepend "TABLE" for actual table labels. Non-table
    // labels are composed as "Takeaway . Sarah" / "Bar . Maria" etc and are
    // self-describing — printing "TABLE Takeaway . Sarah" looked absurd.
    const isNonTableLabel = / . /.test(table) || /^(takeaway|collection|delivery|counter)$/i.test(table);
    b.center().line(isNonTableLabel ? table : `TABLE ${table}`).left();
  } else {
    b.center().line('WALK-IN').left();
  }

  b.normal();
  if(server) b.fontB().line(`Server: ${server}`).fontA();
  if(covers>1) b.fontB().line(`Covers: ${covers}`).fontA();
  // v4.6.9: no more single-course header line. Per-course headers below handle it
  // so multi-course tickets are unambiguous and single-course tickets still get a
  // labelled FIRING/HOLD banner.
  b.divider().bold(true).lf();

  // v4.6.9: group items by course with FIRING/HOLD headers, mirroring the KDS layout.
  // Peter's spec: every course prints on the initial docket, separated like the KDS
  // groups them; a later fireCourse() call emits a separate minimal "FIRE COURSE N"
  // marker docket (see buildFireCourseTicket). item.fired is set in createKdsTickets
  // from FIRED_ON_SEND so every item in the same course has a consistent flag.
  const byCourse = {};
  (items||[]).forEach(i => {
    const c = i.course ?? 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(i);
  });
  const courseNums = Object.keys(byCourse).map(Number).sort((a,b)=>a-b);

  courseNums.forEach((courseN, idx) => {
    const courseItems = byCourse[courseN];
    const isFired = courseItems.some(i => i.fired);
    if (idx > 0) b.lf();
    b.normal().bold(true)
     .center().line(`COURSE ${courseN} -- ${isFired ? 'FIRING' : 'HOLD'}`)
     .left().bold(false).divider();

    courseItems.forEach(item=>{
      b.doubleBoth();
      const qty=item.qty>1?`${item.qty}x `:'';
      b.text(qty+(item.name||'').toUpperCase().substring(0,22)).lf();
      b.normal();
      if(item.seat) b.fontB().line(`  Seat ${item.seat}`).fontA();
      // Each mod/instruction on its own red line
      const modLines = Array.isArray(item.mods) ? item.mods : (item.mods ? item.mods.split(' · ') : []);
      modLines.forEach(m => {
        const text = (typeof m === 'string' ? m : (m.label||'')).trim();
        if (!text) return;
        b.red().bold(true).line(`  ${text}`).bold(false).black();
      });
      if(item.notes) b.red().bold(true).underline(true).line(`  ${item.notes}`).bold(false).underline(false).black();
      b.lf();
    });
  });

  b.divider('=').lf(3).cut();
  return b.toBytes();
}

export function buildFireCourseTicket({ table, courseNum, centreName, sentAt }) {
  const b = new EscPosBuilder(42);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=');

  if (table) {
    // Same non-table-label heuristic as buildKitchenTicket — "Takeaway · Sarah" prints as-is,
    // bare "T7" gets "TABLE " prefix.
    const isNonTableLabel = / · /.test(table) || /^(takeaway|collection|delivery|counter)$/i.test(table);
    b.center().bold(true).doubleBoth().line(isNonTableLabel ? table : `TABLE ${table}`).normal();
  }

  b.lf().center().bold(true).doubleBoth().line(`FIRE COURSE ${courseNum}`).normal();

  b.divider('=').lf(3).cut();
  return b.toBytes();
}


export function buildTransferNoticeTicket({ fromTable, toTable, centreName, items, server, sentAt }) {
  // v4.6.28: kitchen alert docket fired when a table is moved/combined so the
  // expo/kitchen sees that previously-sent items now sit at a different table.
  // Format mirrors buildFireCourseTicket: bold centre header, time, large notice.
  const b = new EscPosBuilder(42);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=');
  b.lf().center().bold(true).doubleBoth().line('** TABLE MOVED **').normal();
  b.lf().center().bold(true).doubleBoth().line(`${fromTable||'?'}  \u2192  ${toTable||'?'}`).normal();
  if (server) b.lf().center().line(`Server: ${server}`);
  b.lf().divider('-');
  // List every item that's now at the new location. This is the already-sent
  // items from the source session — kitchen/expo needs to know what food is
  // where, not just that a move happened.
  b.left().bold(true).line('Items now at ' + (toTable||'?') + ':').bold(false);
  (items||[]).forEach(it => {
    const qty = it.qty || 1;
    const name = it.name || '';
    b.line(`${qty} \u00d7 ${name}`);
    if (Array.isArray(it.mods) && it.mods.length) {
      it.mods.forEach(m => {
        const t = typeof m === 'string' ? m : (m?.label || m?.name || '');
        if (t) b.line(`  \u00b7 ${t}`);
      });
    }
  });
  b.divider('=').lf(3).cut();
  return b.toBytes();
}
export function buildTestPage() {
  const b = new EscPosBuilder(42);
  b.init()
   .center().bold(true).doubleBoth().text('RESTAURANT OS').lf()
   .normal().center().line('Print agent connected').divider()
   .left().bold(true).line('ESC/POS test:').bold(false)
   .line('Normal text')
   .bold(true).line('Bold text').bold(false)
   .doubleBoth().line('Large').normal()
   .divider()
   .twoCol('Subtotal', '\xA312.50')
   .twoCol('Service',  '\xA3 1.56')
   .bold(true).doubleHeight().twoCol('TOTAL','\xA314.06').normal()
   .divider()
   .center().bold(true).line('Connection OK \u2713').bold(false)
   .fontB().line(new Date().toLocaleString()).fontA()
   .lf(4).cut();
  return b.toBytes();
}

// ─── HTML fallback builders ───────────────────────────────────────────────────
function buildReceiptHtml({ location, check, items, totals }) {
  const now = new Date();
  const rows = (items||[]).filter(i=>!i.voided).map(item=>{
    const modLines = Array.isArray(item.mods) ? item.mods : (item.mods ? item.mods.split(' · ') : []);
    return `
    <div class="row"><span>${item.qty>1?`${item.qty}\xD7 `:''}${item.name}</span><span>\xA3${(item.price*item.qty).toFixed(2)}</span></div>
    ${modLines.map(m=>`<div style="padding-left:8px;font-size:10px">${typeof m==='string'?m:(m.label||'')}</div>`).join('')}
  `;}).join('');
  return `
    <div class="center bold big">${location?.name||'Restaurant'}</div>
    <div class="center">${location?.address||''}</div>
    <div class="divider"></div>
    <div class="row"><span>${check?.ref}</span><span>${now.toLocaleString('en-GB',{dateStyle:'short',timeStyle:'short'})}</span></div>
    <div class="row"><span>Server: ${check?.server}</span><span>${check?.tableLabel||check?.orderType}</span></div>
    <div class="divider"></div>${rows}
    <div class="divider"></div>
    ${totals.service>0?`<div class="row"><span>Subtotal</span><span>\xA3${totals.subtotal?.toFixed(2)}</span></div>`:''}
    ${totals.service>0?`<div class="row"><span>Service</span><span>\xA3${totals.service?.toFixed(2)}</span></div>`:''}
    ${totals.tip>0?`<div class="row"><span>Tip</span><span>\xA3${totals.tip?.toFixed(2)}</span></div>`:''}
    <div class="row bold big"><span>TOTAL</span><span>\xA3${totals.grand?.toFixed(2)}</span></div>
    ${totals.taxBreakdown?.breakdown?.filter(b=>b.tax>0).map(b => {
      const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
      const label = b.rate.type==='exclusive' ? `${b.rate.name} (${pct}%)` : `of which ${b.rate.name} (${pct}%)`;
      return `<div class="row" style="font-size:10px;color:#666"><span>${label}</span><span>\xA3${b.tax.toFixed(2)}</span></div>`;
    }).join('') || ''}
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
  _printerForRole(role, printerId = null) {
    this._refreshPrinters();
    if (printerId) return this._printers.find(p => p.id === printerId) || null;
    return this._printers.find(p => p.roles?.includes(role)) || this._printers[0] || null;
  }

  // v4.6.30: lightweight printer lookup helpers used by openCashDrawer.
  _allPrinters() {
    try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]') || []; }
    catch { return []; }
  }
  _printerById(id) {
    return this._allPrinters().find(p => p?.id === id) || null;
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

    const printer = this._printerForRole('receipt', printerId);
    if (printer?.address) {
      const bytes = await buildCustomerReceipt({ location: locationWithBranding, check, items, totals });
      return this._submitJob(printer, 'receipt', bytes, {
        idempotencyKey: opts.idempotencyKey || (check?.ref ? `receipt-${check.ref}-${Date.now()}` : undefined),
        metadata: { ref: check?.ref, total: totals?.grand, tableLabel: check?.tableLabel, orderType: check?.orderType, server: check?.server },
        label: `Receipt ${check?.ref || ''} — £${(totals?.grand || 0).toFixed(2)}`.trim(),
      });
    }
    // Fallback: browser print
    browserPrint(buildReceiptHtml({ location: locationWithBranding, check, items, totals }));
    return { ok: true, transport: 'browser' };
  }

  async printKitchenTicket(ticketData, printerId = null, opts = {}) {
    const printer = this._printerForRole('kitchen', printerId);
    if (printer?.address) {
      const bytes = buildKitchenTicket(ticketData);
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
      const bytes = buildFireCourseTicket(ticketData);
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
      const bytes = buildTransferNoticeTicket(ticketData);
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
    const bytes = buildTestPage();
    return this._submitJob(printer, 'test', bytes, {
      label: `Test print → ${printer.name}`,
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
      const all = this._allPrinters ? this._allPrinters() : [];
      printer = all.find(p => p?.cashDrawerAttached && p?.address)
             || this._printerForRole('receipt', null);
    }
    if (!printer?.address) throw new Error('No printer with cash drawer configured');
    const b = new EscPosBuilder();
    b.init().cashDrawer();
    return this._submitJob(printer, 'cash_drawer', b.toBytes());
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
export { EscPosBuilder, isNativeBridgeAvailable };
