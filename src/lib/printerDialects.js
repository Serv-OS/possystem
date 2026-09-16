/**
 * printerDialects.js: which bytes each printer model understands.
 *
 * PURE. No DOM, no Supabase, no window. Unit tested in printerDialects.test.js
 * against the manufacturers' command references:
 *
 *   escpos       Epson ESC/POS (Sunmi, Epson TM, Bixolon, Citizen, Xprinter, generic).
 *                Byte identical to the builder every till has used since v4 (golden test).
 *   star-line    Star Line Mode / StarPRNT text commands (TSP650II, TSP700II, TSP800II,
 *                mC-Print2, mC-Print3, TSP143IV). Source: "STAR Line Mode Command
 *                Specifications Rev 1.80" (starline_cm_en.pdf), the factory setting of
 *                every one of those printers. A venue must NOT switch the printer to its
 *                ESC/POS emulation.
 *   star-raster  Star Graphic Mode for the TSP100 family (TSP143III LAN). These printers
 *                have no fonts and no text mode at all: the whole receipt is drawn to a
 *                1 bit bitmap and sent as raster rows. Source: "STAR Graphic Mode Command
 *                Specifications Rev 2.32" (star_graphic_cm_en.pdf).
 *
 * The receipt CONTENT is built once (printDoc.js) as a list of ops; the three encoders
 * here turn the same ops into the bytes for one dialect. Widths:
 *   58mm paper   384 dots, 32 columns (Font A 12 dots per character)
 *   80mm paper   576 dots, 42 columns on ESC/POS (unchanged), 48 on Star Line Mode
 *   112mm paper  832 dots, 69 columns (TSP800II)
 */

import { buildGsV0, qrTextToEscPosBytes } from './receiptRaster.js';

// ─── Character transliteration (shared by every dialect) ──────────────────────
// v4.6.5 follow-up: transliterate common Unicode punctuation to ASCII so em
// dashes, curly quotes, bullets, middle dots, emoji etc. don't print as '?'.
// Anything still outside Latin-1 after this falls back to '?' in text().
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), 'g');
export function transliterate(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(NBSP_RE, ' ')
    .replace(/[·•]/g, '-')
    .replace(/…/g, '...')
    .replace(/™/g, '(TM)')
    .replace(/©/g, '(c)')
    .replace(/®/g, '(R)')
    .replace(/°/g, ' deg')
    .replace(/€/g, 'EUR')
    .replace(/[\uD800-\uDFFF]/g, '');
}

/** Latin-1 text as the printer sees it: transliterated, anything else becomes '?'. */
export function printableText(str) {
  const t = transliterate(str || '');
  let out = '';
  for (let i = 0; i < t.length; i++) out += t.charCodeAt(i) > 0xff ? '?' : t[i];
  return out;
}

// ─── Model table ──────────────────────────────────────────────────────────────
// `paper` fixes the paper width when the printer only comes in one size; models without
// it take the width chosen in Back Office (80 or 58). `unavailable` models stay in the
// table so a row saved earlier still resolves, but Back Office will not let a new one be
// picked. `twoColour` marks printers that can print red on two colour paper.
export const DIALECT_ESCPOS = 'escpos';
export const DIALECT_STAR_LINE = 'star-line';
export const DIALECT_STAR_RASTER = 'star-raster';

const ESCPOS_NOTE = 'ESC/POS, the factory setting. No printer setting needed.';
const STAR_LINE_NOTE = 'Leave the printer in Star Line Mode (StarPRNT), its factory setting. Do not switch it to ESC/POS emulation. We send Star text commands.';

export const PRINTER_MODELS = [
  // Sunmi
  { id: 'sunmi-nt311', label: 'Sunmi NT311', brand: 'Sunmi', desc: '80mm cloud printer, WiFi/LAN', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'sunmi-nt310', label: 'Sunmi NT310', brand: 'Sunmi', desc: '58mm cloud printer, WiFi/LAN', dialect: DIALECT_ESCPOS, paper: 58, note: ESCPOS_NOTE },
  // Epson TM series
  { id: 'epson-tm-t88', label: 'Epson TM-T88V / VI / VII', brand: 'Epson', desc: '80mm LAN, industry standard', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'epson-tm-t20', label: 'Epson TM-T20 II / III', brand: 'Epson', desc: '80mm LAN, budget option', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'epson-tm-m30', label: 'Epson TM-m30 / m30II', brand: 'Epson', desc: '80mm LAN, compact/tablet', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'epson-tm-t82', label: 'Epson TM-T82 III', brand: 'Epson', desc: '80mm LAN, entry level', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'epson-tm-t70', label: 'Epson TM-T70 II', brand: 'Epson', desc: '80mm LAN, under counter', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  // Star TSP / mC-Print
  { id: 'star-tsp143', label: 'Star TSP143III LAN', brand: 'Star', desc: '80mm LAN, popular modern', dialect: DIALECT_STAR_RASTER,
    note: 'No printer setting needed. This printer has no text mode, so we send the whole receipt as graphics (Star raster).' },
  { id: 'star-tsp143iv', label: 'Star TSP143IV', brand: 'Star', desc: '80mm LAN / WiFi, current model', dialect: DIALECT_STAR_LINE,
    note: 'Leave the printer in StarPRNT mode, its factory setting. Do not switch it to ESC/POS emulation. We send Star text commands.' },
  { id: 'star-tsp100', label: 'Star TSP100 ECO / futurePRNT', brand: 'Star', desc: 'USB only', dialect: DIALECT_STAR_RASTER, unavailable: true,
    note: 'Star TSP100 ECO / futurePRNT: USB only, cannot print over Wi-Fi. Use a TSP143III LAN or TSP143IV.' },
  { id: 'star-tsp654', label: 'Star TSP654II LAN', brand: 'Star', desc: '80mm LAN, kitchen workhorse', dialect: DIALECT_STAR_LINE, note: STAR_LINE_NOTE },
  { id: 'star-tsp700', label: 'Star TSP700II LAN', brand: 'Star', desc: '80mm LAN, two colour capable', dialect: DIALECT_STAR_LINE, twoColour: true,
    note: `${STAR_LINE_NOTE} Red kitchen notes need two colour paper; on plain paper they print grey.` },
  { id: 'star-tsp800', label: 'Star TSP800II LAN', brand: 'Star', desc: '112mm LAN, wider tickets', dialect: DIALECT_STAR_LINE, paper: 112, note: STAR_LINE_NOTE },
  { id: 'star-mcprint3', label: 'Star mC-Print3', brand: 'Star', desc: '80mm LAN, newest Star', dialect: DIALECT_STAR_LINE, note: STAR_LINE_NOTE },
  { id: 'star-mcprint2', label: 'Star mC-Print2', brand: 'Star', desc: '58mm LAN', dialect: DIALECT_STAR_LINE, paper: 58, note: STAR_LINE_NOTE },
  // Bixolon
  { id: 'bixolon-srp350', label: 'Bixolon SRP-350III', brand: 'Bixolon', desc: '80mm LAN', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'bixolon-srpq300', label: 'Bixolon SRP-Q300', brand: 'Bixolon', desc: '80mm LAN, compact', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  // Citizen
  { id: 'citizen-cts310', label: 'Citizen CT-S310II', brand: 'Citizen', desc: '80mm LAN', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'citizen-cte351', label: 'Citizen CT-E351', brand: 'Citizen', desc: '80mm LAN', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  // Budget / generic
  { id: 'xprinter-xp80', label: 'Xprinter XP-T80 / N160II', brand: 'Xprinter', desc: '80mm LAN, budget ESC/POS', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
  { id: 'generic', label: 'Other / Generic ESC/POS', brand: 'Generic', desc: 'Any ESC/POS printer on TCP 9100', dialect: DIALECT_ESCPOS, note: ESCPOS_NOTE },
];

export const DIALECT_LABELS = {
  [DIALECT_ESCPOS]: 'ESC/POS',
  [DIALECT_STAR_LINE]: 'Star Line Mode',
  [DIALECT_STAR_RASTER]: 'Star graphics',
};

export function printerModel(modelId) {
  return PRINTER_MODELS.find((m) => m.id === modelId) || null;
}

/** Plain words for Back Office: what the physical printer must be set to and what we send. */
export function modelSetupNote(modelId) {
  const m = printerModel(modelId);
  return m ? m.note : ESCPOS_NOTE;
}

/** Paper widths a model can be set to in Back Office. */
export function paperOptionsFor(modelId) {
  const m = printerModel(modelId);
  if (m?.paper) return [m.paper];
  return [80, 58];
}

// Columns and dots per dialect and paper width. ESC/POS 80mm stays at 42 columns: that is
// what every live till prints today and the golden test pins it.
const WIDTHS = {
  [DIALECT_ESCPOS]: { 58: { cols: 32, dots: 384 }, 80: { cols: 42, dots: 576 }, 112: { cols: 42, dots: 576 } },
  [DIALECT_STAR_LINE]: { 58: { cols: 32, dots: 384 }, 80: { cols: 48, dots: 576 }, 112: { cols: 69, dots: 832 } },
  [DIALECT_STAR_RASTER]: { 58: { cols: 32, dots: 384 }, 80: { cols: 48, dots: 576 }, 112: { cols: 48, dots: 576 } },
};

/**
 * Everything the encoders need to know about one printer row (Back Office shape:
 * { model, paperWidth, ... } or the DB shape { meta.model, paper_width }). A missing or
 * unknown model is generic ESC/POS at 80mm: exactly what the old code assumed for everyone.
 */
export function resolvePrinterSpec(printer) {
  const modelId = printer?.model || printer?.meta?.model || 'generic';
  const model = printerModel(modelId) || printerModel('generic');
  const dialect = model.dialect;
  const requested = Number(printer?.paperWidth ?? printer?.paper_width) || 80;
  const paper = model.paper || (WIDTHS[dialect][requested] ? requested : 80);
  const w = WIDTHS[dialect][paper];
  return {
    dialect,
    dialectLabel: DIALECT_LABELS[dialect],
    model: model.id,
    modelLabel: model.label,
    paper,
    cols: w.cols,
    dots: w.dots,
    twoColour: !!model.twoColour,
  };
}

// ─── ESC/POS builder ──────────────────────────────────────────────────────────
// Unchanged from the v4 builder in printer.js, byte for byte. Kept as a class so the
// `EscPosBuilder` export of printer.js keeps working.
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

export class EscPosBuilder {
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

  text(str) { return this._push(printableText(str)); }
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

// ─── Star Line Mode builder ───────────────────────────────────────────────────
// Same surface as EscPosBuilder so one op walker drives both. Command bytes are from the
// Star Line Mode spec, section and page noted on each line.
const RS = 0x1e, BEL = 0x07;

export class StarLineBuilder {
  constructor(charWidth = 48, { twoColour = false, dots = 0 } = {}) {
    this.bytes = []; this.charWidth = charWidth; this.twoColour = twoColour; this._inTwoColour = false;
    // Printable width in dots (Font A is 12 dots per column when not given).
    this.dots = dots || charWidth * 12;
  }
  _push(...args) {
    for (const a of args) {
      if (a instanceof Uint8Array) { for (let i = 0; i < a.length; i++) this.bytes.push(a[i]); }
      else if (Array.isArray(a)) this.bytes.push(...a);
      else if (typeof a === 'string') { for (let i = 0; i < a.length; i++) this.bytes.push(a.charCodeAt(i) & 0xff); }
      else this.bytes.push(a);
    }
    return this;
  }
  raw(bytes) { return this._push(bytes); }

  // ESC @ initialise (3.3.16), then ESC GS t 32 = code page 1252 Windows Latin-1 (3.3.1) so the
  // Latin-1 bytes of printableText print as the same characters as on the ESC/POS path.
  init()             { return this._push([ESC,0x40],[ESC,GS,0x74,32]); }
  // ESC d 3: feed to the cutting position, then partial cut (3.3.11). The ESC/POS path uses
  // GS V 66 0, also feed then partial cut.
  cut()              { if (this._inTwoColour) this.twoColourOff(); return this._push([ESC,0x64,0x03]); }
  // ESC BEL n1 n2 sets drawer 1 pulse to 10 x n1 ms on, 10 x n2 ms off (3.3.12); BEL fires it.
  cashDrawer()       { return this._push([ESC,BEL,20,20],[BEL]); }
  lf(n=1)            { for(let i=0;i<n;i++) this._push(LF); return this; }
  bold(on=true)      { return this._push([ESC, on ? 0x45 : 0x46]); }            // ESC E / ESC F (3.3.3)
  center()           { return this._push([ESC,GS,0x61,0x01]); }                    // ESC GS a 1 (3.3.6)
  left()             { return this._push([ESC,GS,0x61,0x00]); }                    // ESC GS a 0
  doubleHeight()     { return this._push([ESC,0x69,0x01,0x00]); }                  // ESC i 1 0 (3.3.2)
  doubleBoth()       { return this._push([ESC,0x69,0x01,0x01]); }                  // ESC i 1 1
  normal()           { return this._push([ESC,0x69,0x00,0x00],[ESC,0x46],[ESC,GS,0x61,0x00]); }
  underline(on)      { return this._push([ESC,0x2d,on?1:0]); }                     // ESC - n (3.3.3)
  fontB()            { return this._push([ESC,RS,0x46,0x01]); }                    // ESC RS F 1: 9 x 24 (3.3.1)
  fontA()            { return this._push([ESC,RS,0x46,0x00]); }                    // ESC RS F 0: 12 x 24
  // Two colour printing (3.6): ESC RS C 1 selects 2 colour mode (needs two colour paper),
  // ESC RS c n picks the colour. Only sent on models flagged twoColour; elsewhere red text
  // simply prints black, as it does on a single colour Epson.
  twoColourOn()      { this._inTwoColour = true; return this._push([ESC,RS,0x43,0x01]); }
  twoColourOff()     { this._inTwoColour = false; return this._push([ESC,RS,0x43,0x00]); }
  red()              { if (!this.twoColour) return this; if (!this._inTwoColour) this.twoColourOn(); return this._push([ESC,RS,0x63,0x01]); }
  black()            { if (!this.twoColour) return this; return this._push([ESC,RS,0x63,0x00]); }

  text(str) { return this._push(printableText(str)); }
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

  /**
   * Native QR (3.12): ESC GS y S 0 2 model 2, S 1 n error level (0 L, 1 M, 2 Q, 3 H),
   * S 2 n cell size 1..8, D 1 0 nL nH data, then P prints it at the current alignment.
   */
  qr(text, moduleSize = 6, ec = 'M') {
    const ecMap = { L: 0, M: 1, Q: 2, H: 3 };
    const cell = Math.max(1, Math.min(8, moduleSize | 0));
    const data = Array.from(new TextEncoder().encode(String(text)));
    const n = data.length;
    return this._push(
      [ESC,GS,0x79,0x53,0x30,0x02],
      [ESC,GS,0x79,0x53,0x31, ecMap[ec] ?? 1],
      [ESC,GS,0x79,0x53,0x32, cell],
      [ESC,GS,0x79,0x44,0x31,0x00, n & 0xff, (n >> 8) & 0xff], data,
      [ESC,GS,0x79,0x50],
    );
  }

  /**
   * Bitmap as ESC k bands (3.3.8 "fine density bit image"): each command carries 24 dot
   * rows of X bytes, row after row, bit 7 the leftmost dot. ESC 0 sets the line pitch to
   * 3mm (exactly 24 dots) so the LF after each band butts the next one up to it; ESC z 1
   * puts the pitch back to the 4mm Star default afterwards. Star Line Mode has no
   * GS ( L raster print (the spec lists it as "receive and discard"), hence the bands.
   */
  bitmap({ width, height, bits }) {
    const stride = (width + 7) >> 3;
    // Wider than the paper and Spec A printers would read the overflow as text: skip it.
    if (!stride || stride > 255 || !height || stride * 8 > this.dots) return this;
    this._push([ESC,0x30]);
    for (let y0 = 0; y0 < height; y0 += 24) {
      const band = new Uint8Array(stride * 24);
      const rows = Math.min(24, height - y0);
      band.set(bits.subarray(y0 * stride, (y0 + rows) * stride), 0);
      this._push([ESC,0x6b, stride, 0x00], band, [LF]);
    }
    return this._push([ESC,0x7a,0x01]);
  }

  toBytes() { return new Uint8Array(this.bytes); }
}

// ─── Op walker: one document, any text dialect ───────────────────────────────
// Document ops come from printDoc.js's DocBuilder. Each op maps to exactly one builder
// call, in the same order the old builders called them, which is what keeps the ESC/POS
// output byte identical.
function walkOps(doc, b, spec) {
  for (const op of doc.ops) {
    switch (op.t) {
      case 'init': b.init(); break;
      case 'cut': b.cut(); break;
      case 'drawer': b.cashDrawer(); break;
      case 'lf': b.lf(op.n); break;
      case 'bold': b.bold(op.on); break;
      case 'align': op.v === 'center' ? b.center() : b.left(); break;
      case 'size': op.v === 'both' ? b.doubleBoth() : b.doubleHeight(); break;
      case 'normal': b.normal(); break;
      case 'underline': b.underline(op.on); break;
      case 'font': op.v === 'B' ? b.fontB() : b.fontA(); break;
      case 'color': op.v === 'red' ? b.red() : b.black(); break;
      case 'text': b.text(op.s); break;
      case 'divider': b.divider(op.c); break;
      case 'twoCol': b.twoCol(op.l, op.r); break;
      case 'twoColTrunc': {
        // Left column trimmed to what fits beside the right one (the receipt item line).
        const r = String(op.r || '');
        b.twoCol(String(op.l || '').substring(0, Math.max(0, spec.cols - r.length - 1)), r);
        break;
      }
      case 'centeredLine': b.centeredLine(op.s); break;
      case 'bitmap':
        if (b instanceof EscPosBuilder) b.raw(buildGsV0(op.bits, op.width, op.height));
        else b.bitmap(op);
        break;
      case 'qr':
        if (b instanceof EscPosBuilder) b.raw(qrTextToEscPosBytes(op.text, op.moduleSize, op.ec));
        else b.qr(op.text, op.moduleSize, op.ec);
        break;
      default: break;
    }
  }
  return b;
}

export function encodeEscPos(doc, spec) {
  return walkOps(doc, new EscPosBuilder(spec?.cols ?? 42), spec || { cols: 42 }).toBytes();
}

export function encodeStarLine(doc, spec) {
  const b = new StarLineBuilder(spec?.cols ?? 48, { twoColour: !!spec?.twoColour, dots: spec?.dots });
  walkOps(doc, b, spec || { cols: 48 });
  if (b._inTwoColour) b.twoColourOff();   // never leave a printer in 2 colour mode
  return b.toBytes();
}

// ─── Star raster (TSP100 family) ──────────────────────────────────────────────
// Graphic Mode spec section 3-2. Numeric parameters of the ESC * r commands are ASCII
// decimal digits ("13" is 0x31 0x33), and the mode setting commands are ignored once raster
// data is in the buffer, so every setting goes before the first row.
const ascii = (n) => Array.from(String(n | 0), (c) => c.charCodeAt(0));
export const STAR_RASTER = {
  initialize: [ESC, 0x2a, 0x72, 0x52],                 // ESC * r R
  enter:      [ESC, 0x2a, 0x72, 0x41],                 // ESC * r A
  quit:       [ESC, 0x2a, 0x72, 0x42],                 // ESC * r B
  pageLength: (n) => [ESC, 0x2a, 0x72, 0x50, ...ascii(n), 0x00],   // ESC * r P n NUL (0 = continuous)
  eotMode:    (n) => [ESC, 0x2a, 0x72, 0x45, ...ascii(n), 0x00],   // ESC * r E n NUL
  ffMode:     (n) => [ESC, 0x2a, 0x72, 0x46, ...ascii(n), 0x00],   // ESC * r F n NUL
  drawer:     (n) => [ESC, 0x2a, 0x72, 0x44, ...ascii(n), 0x00],   // ESC * r D n NUL (1 = drawer 1)
  executeFF:  [ESC, 0x0c, 0x00],                        // ESC FF NUL
  executeEOT: [ESC, 0x0c, 0x04],                        // ESC FF EOT
  // EOT / FF mode values (spec table): 1 print only, 13 print + feed + partial cut
  MODE_PRINT: 1,
  MODE_PARTIAL_CUT: 13,
};

/**
 * One raster row command: b n1 n2 d1..dk with trailing white bytes trimmed (the printer
 * pads the rest of the row white). A blank row still carries one byte so it feeds.
 */
export function starRasterRow(rowBytes) {
  let len = rowBytes.length;
  while (len > 1 && rowBytes[len - 1] === 0) len--;
  const out = new Uint8Array(3 + len);
  out[0] = 0x62; out[1] = len & 0xff; out[2] = (len >> 8) & 0xff;
  out.set(rowBytes.subarray(0, len), 3);
  return out;
}

/**
 * A complete raster print job from a packed 1 bit bitmap ({ width, height, bits }, MSB
 * first, 1 = black). `cut` ends the job with feed + partial cut (EOT mode 13); without it
 * the paper just prints (mode 1). `drawer` fires drawer 1 after the paper is out.
 */
export function encodeStarRaster(bitmap, { cut = true, drawer = false } = {}) {
  const width = bitmap?.width || 0, height = bitmap?.height || 0;
  const stride = (width + 7) >> 3;
  const parts = [
    STAR_RASTER.initialize,
    STAR_RASTER.enter,
    STAR_RASTER.pageLength(0),
    STAR_RASTER.eotMode(cut ? STAR_RASTER.MODE_PARTIAL_CUT : STAR_RASTER.MODE_PRINT),
  ];
  for (let y = 0; y < height; y++) parts.push(starRasterRow(bitmap.bits.subarray(y * stride, (y + 1) * stride)));
  if (height > 0) parts.push(STAR_RASTER.executeEOT);
  if (drawer) parts.push(STAR_RASTER.drawer(1));
  parts.push(STAR_RASTER.quit);
  return concatBytes(parts);
}

/** Standalone cash drawer job for a raster printer (no paper moves). */
export function starRasterDrawerJob() {
  return concatBytes([STAR_RASTER.initialize, STAR_RASTER.enter, STAR_RASTER.drawer(1), STAR_RASTER.quit]);
}

// ─── Cash drawer bytes per dialect ───────────────────────────────────────────
// The native bridges' openCashDrawer sends a fixed ESC p pulse, which only ESC/POS printers
// understand. The web side builds the right pulse and sends it through print() instead.
export function cashDrawerBytes(spec) {
  const dialect = spec?.dialect || DIALECT_ESCPOS;
  if (dialect === DIALECT_STAR_RASTER) return starRasterDrawerJob();
  if (dialect === DIALECT_STAR_LINE) return new StarLineBuilder(spec.cols).init().cashDrawer().toBytes();
  return new EscPosBuilder().init().cashDrawer().toBytes();   // ESC @, ESC p 0 25 25: unchanged
}

export function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ─── Layout for the raster renderer ──────────────────────────────────────────
// Turns the ops into printed rows with resolved style, mirroring what a text printer would
// do with the same commands: text accumulates until a line feed; `normal` resets size, bold,
// alignment, underline and font (ESC ! 0 semantics). The DOM renderer (printerRaster.js)
// only has to paint rows; this part is pure and tested.
const fresh = () => ({ bold: false, size: 'normal', align: 'left', underline: false, font: 'A', red: false });

export function layoutDocRows(doc, spec) {
  const cols = spec?.cols ?? 48;
  const rows = [];
  let st = fresh();
  let cur = null;    // { kind:'text', segs:[{s, style}], align }
  let hasCut = false, hasDrawer = false;
  const flush = () => { if (cur) { rows.push(cur); cur = null; } };
  const seg = (s) => {
    if (!s) return;
    if (!cur) cur = { kind: 'text', segs: [], align: st.align };
    cur.segs.push({ s: printableText(s), style: { ...st } });
  };
  const padTwo = (l, r) => { l = String(l || ''); r = String(r || ''); return l + ' '.repeat(Math.max(1, cols - l.length - r.length)) + r; };
  for (const op of doc.ops) {
    switch (op.t) {
      case 'lf': {
        // A line feed prints the pending text; with nothing pending it feeds a blank line,
        // exactly as a text printer does. Extra feeds are blank lines too.
        if (cur) flush(); else rows.push({ kind: 'blank', size: st.size });
        for (let i = 1; i < (op.n || 1); i++) rows.push({ kind: 'blank', size: st.size });
        break;
      }
      case 'text': seg(op.s); break;
      case 'divider': seg(String(op.c || '-').repeat(cols)); flush(); break;
      case 'twoCol': seg(padTwo(op.l, op.r)); flush(); break;
      case 'twoColTrunc': { const r = String(op.r || ''); seg(padTwo(String(op.l || '').substring(0, Math.max(0, cols - r.length - 1)), r)); flush(); break; }
      case 'centeredLine': { const s = String(op.s || ''); seg(' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s); flush(); break; }
      case 'bold': st.bold = !!op.on; break;
      case 'align': st.align = op.v === 'center' ? 'center' : 'left'; if (cur && !cur.segs.length) cur.align = st.align; break;
      case 'size': st.size = op.v === 'both' ? 'both' : 'height'; break;
      case 'normal': st = { ...st, bold: false, size: 'normal', align: 'left', underline: false, font: 'A' }; break;
      case 'underline': st.underline = !!op.on; break;
      case 'font': st.font = op.v === 'B' ? 'B' : 'A'; break;
      case 'color': st.red = op.v === 'red'; break;
      case 'bitmap': flush(); rows.push({ kind: 'bitmap', bitmap: op, align: st.align }); break;
      case 'qr': flush(); rows.push({ kind: 'qr', text: op.text, moduleSize: op.moduleSize, ec: op.ec, align: st.align }); break;
      case 'cut': flush(); hasCut = true; break;
      case 'drawer': flush(); hasDrawer = true; break;
      case 'init': st = fresh(); break;
      default: break;
    }
  }
  flush();
  // Trailing blank rows before the cut are only feed: the raster EOT mode feeds to the
  // cutter itself, so they would be blank paper twice.
  while (rows.length && rows[rows.length - 1].kind === 'blank') rows.pop();
  return { rows, hasCut, hasDrawer, cols };
}

/** Raster geometry: Font A is 12 x 24 dots on Star printers; rows get a 30 dot pitch. */
export const RASTER_METRICS = { charW: 12, charH: 24, pitch: 30, pitchTall: 54, fontBW: 9 };

/** Dot height of a laid out row. QR rows are measured by the renderer once encoded. */
export function rowHeight(row) {
  if (row.kind === 'blank') return row.size === 'normal' ? RASTER_METRICS.pitch : RASTER_METRICS.pitchTall;
  if (row.kind === 'text') return row.segs.some((g) => g.style.size !== 'normal') ? RASTER_METRICS.pitchTall : RASTER_METRICS.pitch;
  if (row.kind === 'bitmap') return (row.bitmap.height || 0) + 8;
  return 0;
}
