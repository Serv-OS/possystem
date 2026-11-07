/**
 * xeroAutoBills.test.js: bills and credit notes to Xero by themselves (5.12.73, 7 Nov 2026). Pins the
 * wiring: the SQL job sends only what was posted or added after the switch went on, retries are
 * bounded, the function has the credit note path, the screens show the marks and the Retry.
 * Run: `node --test src/lib/accounting/xeroAutoBills.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;

test('the SQL: two columns, the 15 minute job, only documents after the switch, bounded retries, both kinds', () => {
  const sql = read('supabase/migrations/20261129a_OPS_xero_auto_bills.sql');
  const rb = read('supabase/migrations/20261129a_OPS_xero_auto_bills_ROLLBACK.sql');
  for (const [name, s] of [['sql', sql], ['rollback', rb]]) {
    assert.ok(!/[^ -~\n]/.test(s), `${name} is ASCII only (pbcopy is Mac Roman)`);
    assert.equal(count(s, '\nbegin;'), 0, `${name} has no begin`);
  }
  assert.ok(sql.includes('alter table public.xero_config add column if not exists auto_bills boolean not null default false;'));
  assert.ok(sql.includes('alter table public.xero_config add column if not exists auto_bills_since timestamptz;'));
  assert.ok(sql.includes("select cron.schedule('xero-auto-bills', '*/15 * * * *', $$select public.xero_auto_bills_post()$$);"));
  assert.ok(sql.includes("where g.auto_bills = true and g.auto_bills_since is not null"));
  // only what came after the switch, never the venue's history
  assert.ok(sql.includes('and coalesce(i.posted_at, i.approved_at, i.updated_at) >= loc.auto_bills_since'));
  assert.ok(sql.includes('and n.created_at >= loc.auto_bills_since'));
  assert.ok(sql.includes("and upper(coalesce(i.status, '')) = 'POSTED'"));
  // bounded retries, a sending row left alone for 30 minutes
  assert.equal(count(sql, "coalesce(jsonb_array_length(s.detail -> 'history'), 1) < 6"), 2);
  assert.equal(count(sql, "s.status = 'error' and s.updated_at < now() - interval '2 hours'"), 2);
  assert.equal(count(sql, "s.status = 'sending' and s.updated_at < now() - interval '30 minutes'"), 2);
  assert.equal(count(sql, 'limit 20'), 2);
  // the same function the Push buttons call, as the service role, both kinds
  assert.equal(count(sql, "url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-bills'"), 2);
  assert.ok(sql.includes("'locationId', loc.location_id, 'invoiceId', doc.id, 'auto', true"));
  assert.ok(sql.includes("'action', 'credit_note', 'locationId', loc.location_id, 'noteId', doc.id, 'auto', true"));
  assert.ok(sql.includes("where name = 'xero_cron_key'"));
  assert.ok(sql.includes('revoke all on function public.xero_auto_bills_post() from public, anon, authenticated;'));
  // the rollback undoes all of it
  assert.ok(rb.includes("perform cron.unschedule('xero-auto-bills')"));
  assert.ok(rb.includes('drop function if exists public.xero_auto_bills_post();'));
  assert.ok(rb.includes('alter table public.xero_config drop column if exists auto_bills;'));
  assert.ok(rb.includes('alter table public.xero_config drop column if exists auto_bills_since;'));
});

test('xero-bills: the credit note path, idempotent per note, allocated against its bill, the scan attached', () => {
  const fn = read('supabase/functions/xero-bills/index.ts');
  assert.ok(fn.includes("import { buildCreditNotePayload, allocationFor, creditNoteLink } from '../_shared/xeroCreditNote.js';"));
  assert.ok(fn.includes("if (body?.action === 'credit_note') return await creditNote(req, body);"));
  assert.ok(fn.includes("const logKey = { table: 'xero_sync_log', locationId, kind: 'credit_note', refId: String(noteId) };"));
  assert.ok(fn.includes("sb.from('stock_credit_notes').select('*').eq('id', noteId).eq('location_id', locationId).maybeSingle()"));
  assert.ok(fn.includes("readSyncRow(sb, { table: 'xero_sync_log', locationId, kind: 'bill', refId: String(request.invoice_id) })"), 'the bill the request answers');
  assert.ok(fn.includes("xeroApi(accessToken, tenantId, '/CreditNotes', { method: 'PUT', body: JSON.stringify(payload), idempotencyKey: idem })"));
  assert.ok(fn.includes("`/CreditNotes/${cn.CreditNoteID}/Allocations`, { method: 'PUT'"));
  assert.ok(fn.includes("const amt = allocationFor(cn.Total, b?.Invoices?.[0]);"));
  assert.ok(fn.includes("`${XERO_API}/CreditNotes/${cn.CreditNoteID}/Attachments/${encodeURIComponent(fname)}`"));
  assert.ok(fn.includes("if ((inv.status || '').toUpperCase() !== 'POSTED') throw new HttpError"), 'the bill gate is unchanged');
  // a credit note that cannot go says so before Xero is reached (rules module)
  assert.ok(read('supabase/functions/_shared/xeroCreditNote.js').includes("throw new Error('The credit note VAT is more than its amount. Check the note before sending it.');"));
});

test('xero-config: the switch stamps its moment once; documents and bills_history read the log', () => {
  const fn = read('supabase/functions/xero-config/index.ts');
  assert.ok(fn.includes("select('mapping,detail,auto_daily,post_mode,auto_bills,auto_bills_since')"));
  assert.ok(fn.includes("autoBills: !!data?.auto_bills, autoBillsSince: data?.auto_bills_since || null,"));
  assert.ok(fn.includes("patch.auto_bills = !!body.autoBills;"));
  assert.ok(fn.includes("if (body.autoBills && !cur?.auto_bills) patch.auto_bills_since = new Date().toISOString();"));
  assert.ok(fn.includes(".select('mapping,post_mode,auto_bills')"), 'the save reads the old switch');
  assert.ok(fn.includes("if (action === 'documents') {"));
  assert.ok(fn.includes("const kind = body.kind === 'credit_note' ? 'credit_note' : 'bill';"));
  assert.ok(fn.includes("if (action === 'bills_history') {"));
  assert.ok(fn.includes(".in('kind', ['bill', 'credit_note'])"));
});

test('the screens: the switch, the marks on invoices and credit notes, the Bills and credit notes card with Retry', () => {
  const lib = read('src/lib/xero.js');
  for (const fnName of ['xeroPushCreditNote', 'xeroDocuments', 'xeroBillsHistory', 'xeroSetAutoBills']) assert.ok(lib.includes(`export const ${fnName} = `), fnName);
  assert.ok(lib.includes("export { xeroDocState, autoBillsWords } from '../../supabase/functions/_shared/xeroCreditNote.js';"));
  const xi = read('src/backoffice/sections/XeroIntegration.jsx');
  assert.ok(xi.includes('Send bills and credit notes automatically'));
  assert.ok(xi.includes('await xeroSetAutoBills(locId, v); await refreshMode();'));
  assert.ok(xi.includes('{autoBillsWords(autoBills ? autoBillsSince : null)}'));
  const inv = read('src/backoffice/sections/purchasing/InvoicesSite.jsx');
  assert.ok(inv.includes("const d = await xeroDocuments(loc, 'bill', ids).catch(() => null);"));
  assert.ok(inv.includes('setXeroPush(p => ({ ...xeroDocState(d.docs), ...p }));'), 'a push in this visit wins over the log');
  const cr = read('src/backoffice/sections/purchasing/Credits.jsx');
  assert.ok(cr.includes("xeroDocuments(loc, 'credit_note', bySite[loc])"));
  assert.ok(cr.includes("await xeroPushCreditNote(r.location_id, n.id)"));
  assert.ok(cr.includes("{st && st.error ? 'Retry Xero' : 'Send to Xero'}"));
  assert.ok(cr.includes("if (!xeroSites[r.location_id]) return null;"), 'no button at a site without Xero');
  const bh = read('src/backoffice/sections/xero/BillsHistory.jsx');
  assert.ok(bh.includes('Bills and credit notes') && bh.includes('>Retry<') === false && bh.includes("'Retry'"));
  assert.ok(bh.includes("if (r.kind === 'bill') await xeroPushBill(locId, r.refId); else await xeroPushCreditNote(locId, r.refId);"));
  assert.ok(read('src/backoffice/sections/xero/PostingsHistory.jsx').includes('<BillsHistory locId={locId} currency={currency} />'));
});
