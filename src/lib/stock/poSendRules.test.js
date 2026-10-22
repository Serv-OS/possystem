// node --test: the one purchase order email (supabase/functions/_shared/poSend.ts, multi site stock Drop 3,
// contract 3.5, decisions 4 and 5) and the send-receipt cc and attachments (contract 3.5): the CSV rows,
// the CC list, the delivery fee line, the CSV only for multi site companies, a waiting approval and a
// kitchen order refused, and send-receipt's request byte for byte today's without cc or attachments.
// Synthetic names, numbers and addresses only (the repo is public).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import {
  WAITING_WORDS, OVER_LIMIT_WORDS, INTERNAL_WORDS, CSV_HEADER, ccList, feeOf, poCsvRows, csvText, b64utf8, csvName, poEmailHtml, receiptBody, sendPurchaseOrder,
} from '../../../supabase/functions/_shared/poSend.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const L1 = '10000000-0000-4000-8000-000000000001';
const ORG = 'a0000000-0000-4000-8000-00000000000a';
const PO = 'p0000000-0000-4000-8000-000000000001';
const SUP = 's0000000-0000-4000-8000-000000000001';
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

const LINES = [
  { id: 'l1', supplier_product_id: 'sp1', description: 'Flour, strong', qty_packs: 2, pack_qty: 1, inner_qty: 16, inner_unit: 'kg', unit_price: 12.5 },
  { id: 'l2', supplier_product_id: 'sp2', description: 'Milk "whole"', qty_packs: 3, pack_qty: 6, inner_qty: 2, inner_unit: 'l', unit_price: 7 },
];

test('the CSV: header, one row per line, the delivery fee row, quoted where needed', () => {
  const rows = poCsvRows(LINES, { skuBySp: { sp1: 'FL16' }, deliveryFee: 12.5 });
  assert.deepEqual(rows[0], CSV_HEADER);
  assert.deepEqual(rows[0], ['SKU', 'Item', 'Pack', 'Quantity', 'Unit price', 'Line total']);
  assert.deepEqual(rows[1], ['FL16', 'Flour, strong', '1 x 16kg', '2', '12.50', '25.00']);
  assert.deepEqual(rows[2], ['', 'Milk "whole"', '6 x 2l', '3', '7.00', '21.00']);
  assert.deepEqual(rows[3], ['', 'Delivery fee', '', '1', '12.50', '12.50']);
  assert.equal(poCsvRows(LINES).length, 3, 'no fee, no fee row');
  const text = csvText(rows);
  assert.match(text, /^SKU,Item,Pack,Quantity,Unit price,Line total\r\n/);
  assert.match(text, /FL16,"Flour, strong",1 x 16kg,2,12.50,25.00\r\n/);
  assert.match(text, /,"Milk ""whole""",/);
  assert.ok(text.endsWith('\r\n'));
  assert.equal(fromB64(b64utf8('Café 1')), 'Café 1');
  assert.equal(csvName('PO-12/A'), 'order_PO-12_A.csv');
});

test('the CC list: valid addresses, once each, never the main address, at most 10', () => {
  assert.deepEqual(ccList(['a@x.test', 'A@X.test', 'bad', 'main@x.test', ' b@x.test '], 'main@x.test'), ['a@x.test', 'b@x.test']);
  assert.deepEqual(ccList(null), []);
  assert.equal(ccList(Array.from({ length: 20 }, (_, i) => `p${i}@x.test`)).length, 10);
  assert.equal(feeOf({ delivery_fee: 12.5 }), 12.5);
  assert.equal(feeOf({ delivery_fee: null }), null);
  assert.equal(feeOf({ delivery_fee: 0 }), null);
  assert.equal(feeOf({}), null);
});

test('send-receipt body: today\'s four keys when there is no cc and no attachment', () => {
  assert.deepEqual(Object.keys(receiptBody({ to: 't@x.test', subject: 's', html: 'h', location_id: L1 })), ['to', 'subject', 'html', 'location_id']);
  assert.deepEqual(Object.keys(receiptBody({ to: 't@x.test', subject: 's', html: 'h', location_id: L1, cc: [], attachments: [] })), ['to', 'subject', 'html', 'location_id']);
  assert.deepEqual(receiptBody({ to: 't', subject: 's', html: 'h', location_id: L1, cc: ['c@x.test'], attachments: [{ filename: 'f' }] }).cc, ['c@x.test']);
});

// Today's email (po-send v5.11.79 to v5.11.93) written out again here, so the shared body is proven
// to send a one site company exactly the same html.
const EM = '\u2014';
const escT = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function todayHtml({ venue, ref, po, supplier, locRow, lines, skuBySp, anyCode, dayText }) {
  const rows = lines.map((l) => `
    <tr>
      ${anyCode ? `<td style="padding:6px 10px;border-bottom:1px solid #ddd;font-family:monospace">${escT(skuBySp[l.supplier_product_id] || '')}</td>` : ''}
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${escT(l.description)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.qty_packs)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd">${Number(l.pack_qty)}×${Number(l.inner_qty)}${escT(l.inner_unit)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(l.unit_price).toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${(Number(l.qty_packs) * Number(l.unit_price)).toFixed(2)}</td>
    </tr>`).join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">Purchase order ${EM} ${escT(venue)}</h2>
    <p style="margin:0 0 8px;color:#555">Ref ${escT(ref)}${po.expected_date ? ` · requested delivery ${escT(dayText)}` : ''}</p>
    ${supplier.account_number ? `<p style="margin:0 0 4px;font-size:14px"><b>Account no:</b> ${escT(supplier.account_number)}</p>` : ''}
    <p style="margin:0 0 14px;font-size:14px"><b>Deliver to:</b> ${escT(venue)}${locRow?.address ? `, ${escT(locRow.address)}` : ''}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#555">
        ${anyCode ? '<th style="padding:6px 10px;border-bottom:2px solid #333">Your code</th>' : ''}
        <th style="padding:6px 10px;border-bottom:2px solid #333">Item</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Packs</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333">Pack</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Price</th>
        <th style="padding:6px 10px;border-bottom:2px solid #333;text-align:right">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:14px 0 0;font-size:14px"><b>Order total (ex VAT): ${Number(po.subtotal || 0).toFixed(2)}</b></p>
    <p style="margin:14px 0 0;color:#555;font-size:12px">Please reply to this email to confirm or query the order.</p>
  </div>`;
}

test('the email: with no fee it is today\'s html exactly; a fee adds one line and joins the total', () => {
  const base = { venue: 'North <Kitchen>', ref: 'PO-7', po: { expected_date: '2026-10-16', subtotal: 46 }, supplier: { account_number: 'AC1' }, locRow: { address: '1 High St' }, lines: LINES, skuBySp: { sp1: 'FL16' } };
  for (const anyCode of [true, false]) {
    assert.equal(poEmailHtml({ ...base, anyCode }), todayHtml({ ...base, anyCode, dayText: 'Fri 16 Oct 2026' }));
  }
  assert.equal(poEmailHtml({ ...base, po: { subtotal: 1 }, supplier: {}, locRow: null, anyCode: false }), todayHtml({ ...base, po: { subtotal: 1 }, supplier: {}, locRow: null, anyCode: false }));
  const withFee = poEmailHtml({ ...base, anyCode: false, fee: 12.5 });
  assert.match(withFee, /Delivery fee: 12\.50/);
  assert.match(withFee, /Order total \(ex VAT\): 58\.50/);
  assert.doesNotMatch(poEmailHtml({ ...base, anyCode: false }), /Delivery fee/);
});

// A service role client stand in: enough of supabase-js for sendPurchaseOrder.
function fakeAdmin(tables, log = []) {
  const from = (table) => {
    const st = { filters: [], op: 'select', payload: null };
    const rows = () => (tables[table] || []).filter((r) => st.filters.every(([k, v, op]) => (op === 'in' ? v.includes(r[k]) : r[k] === v)));
    const run = (single) => {
      if (tables[table] === undefined) return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } };
      if (st.op === 'update') { log.push({ table, update: st.payload, filters: st.filters }); return { data: null, error: null }; }
      const r = rows();
      return { data: single ? (r[0] || null) : r, error: null };
    };
    const q = {
      select: () => q, order: () => q,
      eq: (k, v) => { st.filters.push([k, v, 'eq']); return q; },
      in: (k, v) => { st.filters.push([k, v, 'in']); return q; },
      update: (p) => { st.op = 'update'; st.payload = p; return q; },
      maybeSingle: async () => run(true),
      then: (res, rej) => Promise.resolve(run(false)).then(res, rej),
    };
    return q;
  };
  const rpc = async (name, args) => {
    log.push({ rpc: name, args });
    return tables.__rpc ? tables.__rpc(name, args) : { data: { ok: true, send: true, po_id: args.p_po }, error: null };
  };
  return { from, rpc };
}

function tablesFor({ multi = false, approval = null, internal = false, fee = null } = {}) {
  return {
    purchase_orders: [{ id: PO, location_id: L1, supplier_id: SUP, status: 'DRAFT', reference: 'PO-7', expected_date: '2026-10-16', subtotal: 46, delivery_fee: fee }],
    po_lines: LINES.map((l) => ({ ...l, location_id: L1, po_id: PO })),
    locations: [{ id: L1, name: 'North', address: '1 High St', org_id: ORG }],
    stock_po_approvals: approval ? [{ po_id: PO, status: approval }] : [],
    suppliers: [{ id: SUP, location_id: L1, name: 'Bakers', email: 'orders@bakers.test', account_number: 'AC1', cc_emails: ['cc@bakers.test', 'bad'], company_ref: internal ? 'co-sup' : null }],
    stock_co_suppliers: internal ? [{ id: 'co-sup', internal_location_id: 'kitchen' }] : [],
    stock_co_settings: [{ org_id: ORG, multi_since: multi ? '2026-10-01T00:00:00Z' : null }],
    supplier_products: [{ id: 'sp1', location_id: L1, supplier_sku: 'FL16' }],
  };
}

async function send(tables, opts = {}) {
  const log = [];
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); };
  const r = await sendPurchaseOrder(fakeAdmin(tables, log), { poId: PO, locationId: L1, supabaseUrl: 'https://ops.test', serviceKey: 'svc', fetchFn, now: () => '2026-10-22T10:00:00Z', ...opts });
  return { r, log, sent };
}

test('a one site company: today\'s email, no CC, no CSV, then the order is marked sent', async () => {
  const { r, log, sent } = await send(tablesFor());
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ops.test/functions/v1/send-receipt');
  assert.deepEqual(Object.keys(sent[0].body), ['to', 'subject', 'html', 'location_id']);
  assert.equal(sent[0].body.subject, `Purchase order PO-7 ${EM} North`);
  assert.equal(sent[0].body.to, 'orders@bakers.test');
  assert.doesNotMatch(sent[0].body.html, /Delivery fee/);
  assert.deepEqual(log, [{ table: 'purchase_orders', update: { status: 'SENT', ordered_at: '2026-10-22T10:00:00Z', updated_at: '2026-10-22T10:00:00Z' }, filters: [['location_id', L1, 'eq'], ['id', PO, 'eq']] }]);
});

test('a database before Drop 3 (no approvals, settings or company suppliers tables) still sends as today', async () => {
  const t = tablesFor();
  delete t.stock_po_approvals; delete t.stock_co_settings; delete t.stock_co_suppliers;
  const { r, sent } = await send(t);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(sent[0].body), ['to', 'subject', 'html', 'location_id']);
});

test('a multi site company: CC from the supplier row and the CSV attached, the fee line in both', async () => {
  const { r, sent } = await send(tablesFor({ multi: true, fee: 12.5 }));
  assert.equal(r.ok, true);
  assert.equal(r.csv, true);
  assert.deepEqual(sent[0].body.cc, ['cc@bakers.test']);
  assert.equal(sent[0].body.attachments.length, 1);
  const a = sent[0].body.attachments[0];
  assert.equal(a.filename, 'order_PO-7.csv');
  assert.equal(a.mime, 'text/csv');
  const csv = fromB64(a.content_base64);
  assert.match(csv, /^SKU,Item,Pack,Quantity,Unit price,Line total\r\nFL16,"Flour, strong",1 x 16kg,2,12.50,25.00\r\n/);
  assert.match(csv, /,Delivery fee,,1,12.50,12.50\r\n$/);
  assert.match(sent[0].body.html, /Delivery fee: 12\.50/);
});

test('refused, nothing sent: an order waiting for approval, a kitchen order, a received order, no email', async () => {
  for (const approval of ['waiting', 'sent_back']) {
    const { r, sent, log } = await send(tablesFor({ approval }));
    assert.deepEqual([r.ok, r.status, r.error, r.final], [false, 409, WAITING_WORDS, true]);
    assert.equal(sent.length + log.length, 0);
  }
  const approved = await send(tablesFor({ approval: 'sent_unapproved' }));
  assert.equal(approved.r.ok, true, 'sent at the cut off with no answer');
  const kitchen = await send(tablesFor({ internal: true }));
  assert.deepEqual([kitchen.r.ok, kitchen.r.error, kitchen.sent.length], [false, INTERNAL_WORDS, 0]);
  const t = tablesFor(); t.purchase_orders[0].status = 'RECEIVED';
  assert.equal((await send(t)).r.error, 'PO is RECEIVED');
  const t2 = tablesFor(); t2.suppliers[0].email = null;
  assert.deepEqual([(await send(t2)).r.status, (await send(t2)).r.error], [422, 'supplier_has_no_email']);
  const t3 = tablesFor(); t3.purchase_orders = [];
  assert.equal((await send(t3)).r.error, 'PO not found');
});

// -- send-receipt as it ships, one provider at a time -------------------------------------------
async function loadSendReceipt(provider) {
  const file = path.join(ROOT, 'supabase/functions/send-receipt/index.ts');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace("import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';", 'const createClient = () => globalThis.__sr.client;');
  src = src.replace("import { resolveSenderFrom, callerCanBrandForLocation, type Sender } from '../_shared/sending-domain.ts';",
    "type Sender = any; const resolveSenderFrom = async () => ({ from: 'Venue <orders@venue.test>', email: 'orders@venue.test', name: 'Venue', replyTo: null }); const callerCanBrandForLocation = async () => true;");
  src = src.replace("import { secondStepRefusal } from '../_shared/second-step.ts';", 'const secondStepRefusal = async () => null;');
  assert.doesNotMatch(src, /^import /m, 'every import stood in for');
  const out = path.join(os.tmpdir(), `send-receipt-${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(out, stripTypeScriptTypes(src, { mode: 'strip' }));
  const env = { SUPABASE_URL: 'https://ops.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', RECEIPT_EMAIL_PROVIDER: provider, RESEND_API_KEY: 'k', POSTMARK_API_TOKEN: 'k', SENDGRID_API_KEY: 'k' };
  const q = { insert: () => q, select: () => q, single: async () => ({ data: { id: 'row1' }, error: null }), update: () => q, eq: async () => ({ error: null }) };
  globalThis.__sr = { client: { from: () => q, auth: { getUser: async (t) => ({ data: { user: t === 'user-token' ? { id: 'u1', is_anonymous: true } : null } }) } } };
  let handler = null;
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  try { await import(pathToFileURL(out).href); } finally { fs.rmSync(out, { force: true }); }
  return handler;
}

async function providerRequest(provider, extra, bearer = 'svc') {
  const handler = await loadSendReceipt(provider);
  const calls = [];
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    if (provider === 'sendgrid') return new Response('', { status: 202, headers: { 'x-message-id': 'm1' } });
    return new Response('{"id":"m1","MessageID":"m1"}', { status: 200 });
  };
  try {
    const res = await handler(new Request('https://ops.test/functions/v1/send-receipt', {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ location_id: L1, to: 'orders@bakers.test', subject: 'Purchase order PO-7', html: '<p>Order</p>', ...extra }),
    }));
    assert.equal(res.status, 200, `${provider}: ${await res.clone().text()}`);
  } finally { globalThis.fetch = fetch0; }
  assert.equal(calls.length, 1);
  return calls[0].body;
}

// Exactly what each provider received before v5.11.96 for this send.
const TODAY = {
  resend: JSON.stringify({ from: 'Venue <orders@venue.test>', to: 'orders@bakers.test', subject: 'Purchase order PO-7', html: '<p>Order</p>', text: undefined }),
  postmark: JSON.stringify({ From: 'Venue <orders@venue.test>', To: 'orders@bakers.test', Subject: 'Purchase order PO-7', HtmlBody: '<p>Order</p>', TextBody: undefined }),
  sendgrid: JSON.stringify({ personalizations: [{ to: [{ email: 'orders@bakers.test' }] }], from: { email: 'orders@venue.test', name: 'Venue' }, subject: 'Purchase order PO-7', content: [{ type: 'text/plain', value: 'Order' }, { type: 'text/html', value: '<p>Order</p>' }] }),
};

test('send-receipt: with no cc and no attachment each provider gets today\'s request byte for byte', async () => {
  for (const provider of ['resend', 'postmark', 'sendgrid']) {
    assert.equal(await providerRequest(provider, {}), TODAY[provider], provider);
    assert.equal(await providerRequest(provider, { cc: [], attachments: [] }), TODAY[provider], `${provider}, empty lists`);
  }
});

test('send-receipt: cc and the CSV reach all three providers; bad addresses and files are left out', async () => {
  const extra = { cc: ['cc@bakers.test', 'not an address'], attachments: [{ filename: 'order_PO-7.csv', content_base64: b64utf8('a,b\r\n'), mime: 'text/csv' }, { filename: 'bad.bin', content_base64: '%%%' }] };
  const resend = JSON.parse(await providerRequest('resend', extra));
  assert.deepEqual(resend.cc, ['cc@bakers.test']);
  assert.deepEqual(resend.attachments, [{ filename: 'order_PO-7.csv', content: b64utf8('a,b\r\n') }]);
  const postmark = JSON.parse(await providerRequest('postmark', extra));
  assert.equal(postmark.Cc, 'cc@bakers.test');
  assert.deepEqual(postmark.Attachments, [{ Name: 'order_PO-7.csv', Content: b64utf8('a,b\r\n'), ContentType: 'text/csv' }]);
  const sendgrid = JSON.parse(await providerRequest('sendgrid', extra));
  assert.deepEqual(sendgrid.personalizations, [{ to: [{ email: 'orders@bakers.test' }], cc: [{ email: 'cc@bakers.test' }] }]);
  assert.deepEqual(sendgrid.attachments, [{ content: b64utf8('a,b\r\n'), filename: 'order_PO-7.csv', type: 'text/csv', disposition: 'attachment' }]);
});

test('send-receipt: a signed in (kiosk, online, till) caller cannot add cc or files: each provider gets today\'s request', async () => {
  const extra = { cc: ['a@x.test', 'b@x.test'], attachments: [{ filename: 'invoice.pdf', content_base64: b64utf8('%PDF'), mime: 'application/pdf' }] };
  for (const provider of ['resend', 'postmark', 'sendgrid']) {
    assert.equal(await providerRequest(provider, extra, 'user-token'), TODAY[provider], provider);
  }
});

test('a multi site DRAFT goes through the order rule first: over the limit raises the approval and nothing is emailed', async () => {
  const t = tablesFor({ multi: true });
  t.__rpc = () => ({ data: { ok: true, needs_approval: true, limit: 50, amount: 120 }, error: null });
  const { r, log, sent } = await send(t, { by: { uid: 'u-1', name: 'Sam' } });
  assert.deepEqual([r.ok, r.status, r.error, r.needs_approval, r.final], [false, 409, OVER_LIMIT_WORDS, true, true]);
  assert.equal(sent.length, 0, 'no email');
  assert.deepEqual(log, [{ rpc: 'stock_po_submit', args: { p_po: PO, p_section: 'purchasing', p_actor: { location_id: L1, uid: 'u-1', name: 'Sam' } } }]);
  const refused = tablesFor({ multi: true });
  refused.__rpc = () => ({ data: null, error: { code: '22023', message: 'Over the maximum 800 for Bakers. Split the order or ask head office.' } });
  const r2 = await send(refused);
  assert.deepEqual([r2.r.ok, r2.sent.length], [false, 0]);
  assert.match(r2.r.error, /Over the maximum/);
  const ok = await send(tablesFor({ multi: true }));
  assert.equal(ok.r.ok, true);
  assert.equal(ok.log[0].rpc, 'stock_po_submit');
  const old = tablesFor({ multi: true });
  old.__rpc = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.stock_po_submit' } });
  assert.equal((await send(old)).r.ok, true, 'a database before Drop 3 sends as today');
  const one = await send(tablesFor());
  assert.equal(one.log.some((x) => x.rpc), false, 'a one site company never asks the rule');
});

test('the runner sends only a DRAFT: an order the screen sent already, or cancelled, is skipped with no email', async () => {
  for (const status of ['SENT', 'CANCELLED', 'RECEIVED']) {
    const t = tablesFor({ multi: true, approval: 'approved' }); t.purchase_orders[0].status = status;
    const { r, sent, log } = await send(t, { onlyDraft: true });
    assert.deepEqual([r.ok, r.skipped, sent.length, log.length], [true, true, 0, 0], status);
  }
  const t = tablesFor({ multi: true, approval: 'approved' });
  const { r, sent } = await send(t, { onlyDraft: true });
  assert.deepEqual([r.ok, sent.length], [true, 1], 'an approved DRAFT is emailed');
});
