/**
 * printDoc.js: what goes on the paper, once, for every printer model.
 *
 * PURE (no DOM, no Supabase). The customer receipt, merchant tip slip, kitchen ticket, fire
 * course marker, transfer notice and test page are built here as a DOCUMENT: a list of ops
 * ({ t:'text', s }, { t:'bold', on }, { t:'cut' } ...) recorded by DocBuilder, whose call
 * surface is the old EscPosBuilder's. printerDialects.js turns the same ops into ESC/POS,
 * Star Line Mode or a Star raster bitmap, so the content is one source of truth and only
 * the encoding differs per model. v5.8.84.
 *
 * Images cannot be fetched here: the caller (printer.js) loads the logo and the uploaded
 * QR image to 1 bit bitmaps first and passes them in as `assets`, exactly where the old
 * builders awaited the rasteriser. A missing asset is simply skipped, as before.
 */

import { money } from './currency.js';
import { v2ReceiptLines, taxLineLabel, breakdownLabel } from './receiptTax.js';
import { consolidateReceiptLines } from './receiptLines.js';
import { cardReceiptLines } from './cardReceipt.js';

/** db.js shortOrderRef, mirrored so this file stays import free of Supabase: 'R1247' gives '47'. */
export function shortOrderRef(ref) {
  if (typeof ref !== 'string') return ref;
  const m = /^R(\d+)$/.exec(ref);
  if (!m) return ref;
  return m[1].length > 2 ? m[1].slice(-2) : m[1];
}

export class DocBuilder {
  constructor(cols = 42) { this.ops = []; this.cols = cols; }
  _op(op) { this.ops.push(op); return this; }

  init()             { return this._op({ t: 'init' }); }
  cut()              { return this._op({ t: 'cut' }); }
  cashDrawer()       { return this._op({ t: 'drawer' }); }
  lf(n = 1)          { return this._op({ t: 'lf', n }); }
  bold(on = true)    { return this._op({ t: 'bold', on: !!on }); }
  center()           { return this._op({ t: 'align', v: 'center' }); }
  left()             { return this._op({ t: 'align', v: 'left' }); }
  doubleHeight()     { return this._op({ t: 'size', v: 'height' }); }
  doubleBoth()       { return this._op({ t: 'size', v: 'both' }); }
  normal()           { return this._op({ t: 'normal' }); }
  underline(on)      { return this._op({ t: 'underline', on: !!on }); }
  fontB()            { return this._op({ t: 'font', v: 'B' }); }
  fontA()            { return this._op({ t: 'font', v: 'A' }); }
  red()              { return this._op({ t: 'color', v: 'red' }); }
  black()            { return this._op({ t: 'color', v: 'black' }); }

  text(str)          { return this._op({ t: 'text', s: str || '' }); }
  line(str = '')     { return this.text(str).lf(); }
  divider(c = '-')   { return this._op({ t: 'divider', c }); }
  twoCol(l, r)       { return this._op({ t: 'twoCol', l: String(l || ''), r: String(r || '') }); }
  /** Two columns with the left one trimmed to what fits beside the right (item lines). */
  twoColTrunc(l, r)  { return this._op({ t: 'twoColTrunc', l: String(l || ''), r: String(r || '') }); }
  centeredLine(str)  { return this._op({ t: 'centeredLine', s: String(str || '') }); }
  /** A 1 bit bitmap { width, height, bits } (MSB first, 1 = black). */
  bitmap(bm)         { return bm ? this._op({ t: 'bitmap', width: bm.width, height: bm.height, bits: bm.bits }) : this; }
  qr(text, moduleSize = 6, ec = 'M') { return this._op({ t: 'qr', text: String(text), moduleSize, ec }); }

  toDoc() { return { ops: this.ops, cols: this.cols }; }
}

const datePart = (d) => ({
  time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
});

// ─── Customer receipt ─────────────────────────────────────────────────────────
// All branding is optional: a location with no receipt_branding falls back to the legacy
// text-only receipt unchanged.
export function buildCustomerReceiptDoc({ location, check, items, totals }, { cols = 42, assets = {} } = {}) {
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
  // v5.7.34: venue currency. money(n, code) falls back to the device's active
  // currency then GBP, so the output is byte-identical to the old `\xA3${...}`
  // strings on every GBP venue and prints $ at USD venues.
  const mny = (n) => money(n, location?.currency);
  const b = new DocBuilder(cols);
  const { time: timeStr, date: dateStr } = datePart(new Date());

  const branding = location?.receipt_branding || null;
  const header = branding?.header || null;
  const footer = branding?.footer || null;

  b.init();

  // Header logo (raster): loaded by the caller; a missing or slow logo never blocks the receipt.
  if (header?.logo_url && assets.logo) b.center().bitmap(assets.logo).lf();

  // Business name / address / phone / tax id
  const businessName = header?.business_name || location?.name || 'Restaurant';
  b.center().bold(true).doubleBoth().text(businessName).lf().normal().center();

  const addressLines = header?.address_lines?.length
    ? header.address_lines.filter(Boolean)
    : (location?.address ? String(location.address).split('\n') : []);
  addressLines.forEach(line => b.line(line));

  if (header?.phone)  b.line(header.phone);
  if (header?.tax_id) b.fontB().line(header.tax_id).fontA();

  b.lf().divider().left();

  // Check header. Order number: prominent, centered, double height so it is impossible to
  // miss. Short display form: the number staff call out, matching the kiosk reveal and the
  // collection board. The full ref stays the identity everywhere else.
  b.bold(true).doubleHeight().center().line(`ORDER # ${shortOrderRef(check?.ref)||''}`).normal().left();
  b.twoCol('Date', `${dateStr} ${timeStr}`);
  if (header?.show_server_name !== false) {
    b.twoCol(`Server: ${check?.server||''}`, check?.covers>1 && header?.show_covers !== false ? `${check.covers} covers` : '');
  }
  // Drive thru (16 Sep 2026): the key prints as its label, matching the on screen receipt.
  // Every other order type prints exactly as it did (the goldens pin that).
  b.twoCol(`${check?.tableLabel||(check?.orderType === 'drive-thru' ? 'Drive thru' : check?.orderType)||''}`, '');

  // Delivery channel block (HubRise/Deliveroo etc.): the order number already printed above
  // as "ORDER #". Add channel + payment + the customer/address details from the platform.
  if (check?.delivery) {
    const d = check.delivery;
    b.divider();
    if (d.channel) b.bold(true).line(String(d.channel).toUpperCase() + (d.serviceType ? `  ·  ${String(d.serviceType).toUpperCase()}` : '')).bold(false);
    // v5.5.850: 3-state: a partial channel payment prints the amount still to collect.
    b.line(d.paid ? 'PAID online' : (Number(d.paidAmount) > 0 ? `PART-PAID ${mny(+d.paidAmount)} — COLLECT ${mny(+d.due)}` : 'UNPAID — collect on delivery'));
    if (d.expected) b.fontB().line(`Wanted: ${d.expected}`).fontA();
    if (d.name) b.line(d.name);
    if (d.phone) b.line(d.phone);
    (Array.isArray(d.address) ? d.address : []).filter(Boolean).forEach(l => b.line(l));
    if (d.notes) b.fontB().line(`Note: ${d.notes}`).fontA();
  }

  b.divider().bold(true).line('ITEMS').bold(false);

  consolidateReceiptLines(items).forEach(item=>{
    const linePrice=mny(item.price*item.qty);
    // Triple-naming: receipts print the item's explicit receipt name when the
    // line carries one (snapshotted at add time), else the POS line name.
    const printName=item.receiptName||item.name;
    const nameStr=item.qty>1?`${item.qty}x ${printName}`:printName;
    b.twoColTrunc(nameStr, linePrice);
    const modLines = Array.isArray(item.mods) ? item.mods : (item.mods ? item.mods.split(' · ') : []);
    modLines.forEach(m => b.fontB().line(`  ${typeof m === 'string' ? m : (m.label||'')}`).fontA());
    if(item.notes) b.fontB().line(`  Note: ${item.notes}`).fontA();
  });

  b.divider();
  if(totals.subtotal!==totals.grand) b.twoCol('Subtotal',mny(totals.subtotal));
  // v5.5.853: itemised discount lines (POS manual/auto + channel promos): the customer
  // could see a Subtotal to TOTAL drop with no explanation. Named, one line each.
  (Array.isArray(check?.discounts) ? check.discounts : []).forEach(d => {
    const amt = Number(d.amount ?? d.value) || 0;
    if (amt > 0) b.twoCol((d.label || d.name || 'Discount').substring(0, 34), `-${mny(amt)}`);
  });
  if(totals.service>0) b.twoCol('Service',mny(totals.service));
  if(totals.tip>0) b.twoCol('Tip',mny(totals.tip));
  // v5.5.657: delivery fee line (online/POS/catering delivery orders)
  const _delFee = Number(check?.customer?.delivery_fee ?? check?.delivery?.deliveryFee ?? check?.deliveryFee ?? 0) || 0;
  if(_delFee>0) b.twoCol('Delivery',mny(_delFee));

  // Tax breakdown. v5.7.34: NAMED LINES from the check's v2 record, but ONLY when the check
  // actually needs them (an exclusive/per_unit component, or a real non-mirror profile; the
  // gate lives in receiptTax.shouldRenderV2). Every pure inclusive legacy-shaped check,
  // every UK VAT check, takes the legacy branch below, whose output is BYTE-identical to the
  // pre-cutover builder. Per-unit v2 lines print name + amount with no percent.
  {
    const _tb = totals.taxBreakdown;
    const _v2 = v2ReceiptLines(_tb);
    if (_v2) {
      const excl = _v2.filter(l => l.exclusive);
      const incl = _v2.filter(l => !l.exclusive);
      if (excl.length) {
        // US: show net + added-on tax lines above the total
        if (_tb?.subtotal != null) b.twoCol('Subtotal (ex. tax)', mny(_tb.subtotal));
        excl.forEach(l => b.twoCol(taxLineLabel(l).substring(0, 30), mny(l.amount)));
      }
      // UK-style 'of which' lines for tax already inside the price
      incl.forEach(l => b.fontB().twoCol(`  of which ${taxLineLabel(l)}`.substring(0, 34), mny(l.amount)).fontA());
    } else if (_tb?.breakdown?.length) {
      const hasExcl = _tb.hasExclusiveTax;
      if(hasExcl) {
        // US: show net + tax lines (rate-null guard: per-unit entries print
        // the line name + amount, no percent, via breakdownLabel)
        b.twoCol('Subtotal (ex. tax)',mny(_tb.subtotal));
        _tb.breakdown.forEach(br => {
          b.twoCol(breakdownLabel(br, 1),mny(br.tax));
        });
      } else {
        // UK: show 'of which VAT' lines under total, byte-identical to the
        // pre-cutover output (breakdownLabel reproduces the exact pct string)
        _tb.breakdown.forEach(br => {
          if(br.tax > 0) {
            b.fontB().twoCol(`  of which ${breakdownLabel(br, 1)}`,mny(br.tax)).fontA();
          }
        });
      }
    }
  }

  b.bold(true).doubleHeight()
   .twoCol('TOTAL',mny(totals.grand))
   .normal();

  // v5.5.853: channel orders can be paid in legs (part on the platform, balance at the
  // till): print each decoded payment so the receipt tells the whole money story.
  const _chPays = Array.isArray(check?.customer?.payments) ? check.customer.payments.filter(p => Number(p.amount)) : [];
  if (_chPays.length) {
    b.divider();
    _chPays.forEach(p => b.twoCol(`${p.name || 'Payment'}${p.ref ? ` (${p.ref})` : ''}`.substring(0, 30), mny(Number(p.amount))));
    b.twoCol('Status','PAID');
  } else if(check?.method) b.divider().twoCol('Payment',check.method.toUpperCase()).twoCol('Status','PAID');

  // Card-scheme block (UK receipt rules: masked PAN, scheme, auth code, entry/CVM, AID)
  const cardLines = cardReceiptLines(check);
  if (cardLines.length) {
    b.divider();
    for (const [label, value] of cardLines) b.twoCol(label, String(value));
    b.line('Please retain this receipt');
  }

  // Footer message
  const footerMsg = footer?.message || location?.receiptFooter || 'Thank you for dining with us!';
  b.lf().center().line(footerMsg);

  // Footer QR code
  const qr = footer?.qr;
  if (qr?.enabled) {
    // Same shape as the old try block: an uploaded image that failed to load skipped the
    // caption too; a url mode QR, or nothing to draw, still printed the caption.
    let imageFailed = false;
    if (qr.mode === 'url' && qr.url_value) {
      // Native QR: crisp at any paper width, no image fetch
      const moduleSize = Math.max(1, Math.min(16, Math.round((qr.size_dots || 160) / 25)));
      b.lf().center().qr(qr.url_value, moduleSize, 'M').lf();
    } else if (qr.mode === 'upload' && qr.image_url) {
      // Uploaded QR as a rasterised image
      if (assets.qrImage) b.lf().center().bitmap(assets.qrImage).lf();
      else imageFailed = true;
    }
    if (qr.caption && !imageFailed) b.fontB().center().line(qr.caption).fontA();
  }

  b.fontB().line('Powered by Serv OS').fontA()
   .lf(4).cut();

  return b.toDoc();
}

// ─── v5.7.5 Merchant tip slip (US signature flow) ────────────────────────────
// Printed alongside the customer receipt on a tip-on-receipt venue: the card authorised
// WITHOUT capturing, the guest writes a tip and signs, staff type it into History, Add tip.
// Same branding as the customer receipt (logo, business name, address), then the card
// scheme block, then the write-in lines. No items: this is the signature voucher, not the bill.
export function buildMerchantTipSlipDoc({ location, check, totals }, { cols = 42, assets = {} } = {}) {
  const b = new DocBuilder(cols);
  const { time: timeStr, date: dateStr } = datePart(new Date());
  const branding = location?.receipt_branding || null;
  const header = branding?.header || null;

  b.init();

  if (header?.logo_url && assets.logo) b.center().bitmap(assets.logo).lf();

  const businessName = header?.business_name || location?.name || 'Restaurant';
  b.center().bold(true).doubleBoth().text(businessName).lf().normal().center();
  const addressLines = header?.address_lines?.length
    ? header.address_lines.filter(Boolean)
    : (location?.address ? String(location.address).split('\n') : []);
  addressLines.forEach(line => b.line(line));
  if (header?.phone) b.line(header.phone);

  b.lf().divider().left();
  b.bold(true).doubleHeight().center().line(`ORDER # ${shortOrderRef(check?.ref) || ''}`).normal().left();
  b.twoCol('Date', `${dateStr} ${timeStr}`);
  if (check?.server) b.twoCol(`Server: ${check.server}`, '');
  if (check?.tableLabel || check?.orderType) b.twoCol(`${check?.tableLabel || (check?.orderType === 'drive-thru' ? 'Drive thru' : check?.orderType)}`, '');

  // Card-scheme block: masked PAN, scheme, auth code, entry/CVM, AID.
  const cardLines = cardReceiptLines(check);
  if (cardLines.length) {
    b.divider();
    for (const [label, value] of cardLines) b.twoCol(label, String(value));
  }

  // The money: the authorised amount, then the guest's write-in lines.
  const grand = Number(totals?.grand ?? check?.total ?? 0) || 0;
  b.divider();
  b.bold(true).doubleHeight().twoCol('AMOUNT', money(grand, location?.currency)).normal();
  b.lf();
  b.bold(true).line('TIP:   ____________________').lf();
  b.line('TOTAL: ____________________').bold(false).lf();
  b.lf();
  b.line('X ________________________________');
  b.fontB().line('  SIGNATURE').fontA();
  b.lf().center().bold(true).line('* MERCHANT COPY *').bold(false);
  b.fontB().center().line('Guest keeps the printed receipt').fontA();
  b.lf(4).cut();
  return b.toDoc();
}

// ─── Kitchen ticket ───────────────────────────────────────────────────────────
export function buildKitchenTicketDoc({ table, server, covers, centreName, items, sentAt, delivery, itemLabel, reprint }, { cols = 42 } = {}) {
  const b = new DocBuilder(cols);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=')
   .left().bold(true).doubleBoth();

  // Use native centre alignment (not space-padded centeredLine): centeredLine pads to the
  // full width, which overflows when doubleBoth is active: spaces print double-wide too,
  // so a full width of padded content becomes ~50 physical cols and wraps.
  if(table) {
    // v4.6.5 follow-up: only prepend "TABLE" for actual table labels. Non-table labels are
    // composed as "Takeaway . Sarah" / "Bar . Maria" etc and are self-describing.
    // v5.5.127: extended whitelist: kiosk / online / qr orders pass labels like
    // "Online OL-XXX" / "Kiosk K-XXX" / "Table T5" which are already self-describing.
    // Drive thru (16 Sep 2026): a bare 'drive-thru' label (no customer name) is a lane, not a table.
    const isNonTableLabel = / . /.test(table)
      || /^(takeaway|collection|delivery|counter|drive-thru)$/i.test(table)
      || /^(online|kiosk|qr|table|hubrise)\s/i.test(table);
    b.center().line(isNonTableLabel ? table : `TABLE ${table}`).left();
  } else {
    b.center().line('WALK-IN').left();
  }

  // v5.7.72: duplicate docket requested from the till, still in doubleBoth so it prints BIG.
  // The kitchen must not read this as a new order.
  if (reprint) b.center().line('** REPRINT **').left();

  // Coffee-shop "sticker" mode: one ticket per item, numbered ITEM X OF Y.
  if (itemLabel) b.center().bold(true).line(itemLabel).bold(false).left();

  b.normal();

  // v5.5.547: HubRise / delivery-channel context block. Only present for HubRise orders
  // (delivery passed in); all other tickets are unchanged. Gives the kitchen + packer the
  // channel, paid status, handover code, customer/address and ETA.
  if (delivery) {
    b.divider();
    if (delivery.channel) b.center().bold(true).line(String(delivery.channel).toUpperCase()).bold(false).left();
    if (delivery.collectionCode) b.center().bold(true).doubleBoth().line(`#${delivery.collectionCode}`).normal().left();
    const st = delivery.serviceType === 'delivery' ? 'DELIVERY'
      : delivery.serviceType === 'collection' ? 'COLLECTION'
      : delivery.serviceType === 'eat_in' ? 'EAT IN' : 'ORDER';
    // v5.5.850: 3-state: partial channel payments show what's paid vs what to collect.
    // Fence S3 (fix round): a payment being checked prints as that, never "UNPAID, COLLECT".
    b.bold(true).line(`${st}  ·  ${delivery.paymentChecking ? 'PAYMENT BEING CHECKED, DO NOT CHARGE' : delivery.paid ? 'PAID' : (Number(delivery.paidAmount) > 0 ? `PART ${money(+delivery.paidAmount)} — COLLECT ${money(+delivery.due)}` : 'UNPAID — COLLECT')}`).bold(false);
    if (delivery.expected) b.fontB().line(`Wanted: ${delivery.expected}`).fontA();
    if (delivery.name) b.line(delivery.name);
    if (delivery.phone) b.line(delivery.phone);
    if (delivery.address) {
      const a = delivery.address;
      [a.line1, a.line2, [a.city, a.postcode].filter(Boolean).join(' ')].filter(Boolean).forEach(l => b.line(l));
    }
    if (delivery.deliveryFee != null && Number(delivery.deliveryFee) > 0) b.fontB().line(`Delivery fee: ${money(Number(delivery.deliveryFee))}`).fontA();
    // v5.5.847: channel charges + discounts (Deliveroo/UberEats/JustEat via HubRise).
    (delivery.charges || []).forEach(ch => {
      const amt = Number(ch.amount) || 0;
      if (amt !== 0) b.fontB().line(`${ch.name || 'Charge'}: ${money(amt)}`).fontA();
    });
    (delivery.discounts || []).forEach(d => {
      const amt = Number(d.amount) || 0;
      if (amt !== 0) b.fontB().bold(true).line(`${d.name || 'Discount'}: -${money(amt)}`).bold(false).fontA();
    });
    if (delivery.notes) b.red().bold(true).underline(true).line(delivery.notes).underline(false).bold(false).black();
    b.divider();
  }

  if(server) b.fontB().line(`Server: ${server}`).fontA();
  if(covers>1) b.fontB().line(`Covers: ${covers}`).fontA();
  // v4.6.9: no more single-course header line. Per-course headers below handle it.
  b.divider().bold(true).lf();

  // v4.6.9: group items by course with FIRING/HOLD headers, mirroring the KDS layout.
  const byCourse = {};
  // v5.7.28: noKitchen lines (the prepaid booking package revenue line) never print on a
  // kitchen docket.
  (items||[]).filter(i => !i?.noKitchen).forEach(i => {
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
      // Triple-naming: kitchen tickets print the item's explicit kitchen name when the line
      // carries one.
      b.text(qty+(item.kitchenName||item.name||'').toUpperCase().substring(0,22)).lf();
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
  return b.toDoc();
}

export function buildFireCourseTicketDoc({ table, courseNum, centreName, sentAt }, { cols = 42 } = {}) {
  const b = new DocBuilder(cols);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=');

  if (table) {
    // Same non-table-label heuristic as the kitchen ticket: "Takeaway · Sarah" prints as-is,
    // bare "T7" gets "TABLE " prefix.
    const isNonTableLabel = / · /.test(table) || /^(takeaway|collection|delivery|counter|drive-thru)$/i.test(table);
    b.center().bold(true).doubleBoth().line(isNonTableLabel ? table : `TABLE ${table}`).normal();
  }

  b.lf().center().bold(true).doubleBoth().line(`FIRE COURSE ${courseNum}`).normal();

  b.divider('=').lf(3).cut();
  return b.toDoc();
}

export function buildTransferNoticeTicketDoc({ fromTable, toTable, centreName, items, server, sentAt }, { cols = 42 } = {}) {
  // v4.6.28: kitchen alert docket fired when a table is moved/combined so the expo/kitchen
  // sees that previously-sent items now sit at a different table.
  const b = new DocBuilder(cols);
  const time = new Date(sentAt||Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  b.init().center().bold(true).doubleBoth().text(centreName||'Kitchen').lf()
   .normal().center().line(time).divider('=');
  b.lf().center().bold(true).doubleBoth().line('** TABLE MOVED **').normal();
  b.lf().center().bold(true).doubleBoth().line(`${fromTable||'?'}  →  ${toTable||'?'}`).normal();
  if (server) b.lf().center().line(`Server: ${server}`);
  b.lf().divider('-');
  // List every item that's now at the new location.
  b.left().bold(true).line('Items now at ' + (toTable||'?') + ':').bold(false);
  (items||[]).forEach(it => {
    const qty = it.qty || 1;
    const name = it.name || '';
    b.line(`${qty} × ${name}`);
    if (Array.isArray(it.mods) && it.mods.length) {
      it.mods.forEach(m => {
        const t = typeof m === 'string' ? m : (m?.label || m?.name || '');
        if (t) b.line(`  · ${t}`);
      });
    }
  });
  b.divider('=').lf(3).cut();
  return b.toDoc();
}

// ─── Test page ────────────────────────────────────────────────────────────────
// Without `info` this is the v4 test page, byte for byte (golden test). With `info` the
// page describes itself: model, dialect, address, paper, where it was sent from and the app
// version, so a tester can photograph it and we know which path printed it.
export function buildTestPageDoc(info = null, { cols = 42 } = {}) {
  const b = new DocBuilder(cols);
  if (!info) {
    b.init()
     .center().bold(true).doubleBoth().text('RESTAURANT OS').lf()
     .normal().center().line('Print agent connected').divider()
     .left().bold(true).line('ESC/POS test:').bold(false)
     .line('Normal text')
     .bold(true).line('Bold text').bold(false)
     .doubleBoth().line('Large').normal()
     .divider()
     .twoCol('Subtotal', money(12.50))
     .twoCol('Service',  money(1.56))
     .bold(true).doubleHeight().twoCol('TOTAL',money(14.06)).normal()
     .divider()
     .center().bold(true).line('Connection OK ✓').bold(false)
     .fontB().line(new Date().toLocaleString()).fontA()
     .lf(4).cut();
    return b.toDoc();
  }
  const { printer = {}, spec = {}, version = '', sentFrom = '' } = info;
  b.init()
   .center().bold(true).doubleBoth().text('SERV OS').lf()
   .normal().center().line('Printer test page').divider()
   .left()
   .twoCol('Printer', String(printer.name || '').substring(0, cols - 9))
   .twoCol('Model', String(spec.modelLabel || printer.model || 'generic').substring(0, cols - 7))
   .twoCol('We send', `${spec.dialectLabel || 'ESC/POS'} (${spec.dialect || 'escpos'})`)
   .twoCol('Address', `${printer.address || '?'}:${printer.port || 9100}`)
   .twoCol('Paper', `${spec.paper || 80}mm, ${spec.cols || cols} columns`)
   .twoCol('Sent from', sentFrom || 'unknown')
   .twoCol('App version', version ? `v${version}` : 'unknown')
   .twoCol('Time', new Date().toLocaleString('en-GB'))
   .divider()
   .bold(true).line('Text test:').bold(false)
   .line('Normal text')
   .bold(true).line('Bold text').bold(false)
   .doubleHeight().line('Tall text').normal()
   .doubleBoth().line('Large').normal()
   .fontB().line('Small font B text').fontA()
   .center().line('Centred text').left()
   .divider()
   .twoCol('Subtotal', money(12.50))
   .twoCol('Service',  money(1.56))
   .bold(true).doubleHeight().twoCol('TOTAL',money(14.06)).normal()
   .divider()
   .center().bold(true).line('If you can read this, printing works').bold(false).left()
   .fontB().line('Photograph this page and send it to support').fontA()
   .lf(4).cut();
  return b.toDoc();
}

/** True when a doc has a cut op (the raster encoder ends the job with a cut then). */
export function docHasCut(doc) { return (doc?.ops || []).some((o) => o.t === 'cut'); }
export function docHasDrawer(doc) { return (doc?.ops || []).some((o) => o.t === 'drawer'); }
