/**
 * xeroCreditNote.test.js: supplier credit notes to Xero (5.12.73, 7 Nov 2026). Peter: "we need to
 * start getting ready for all stock syncing for invoices credit notes etc".
 * Run: `node --test src/lib/accounting/xeroCreditNote.test.js`.
 *
 * A credit note recorded in Purchasing, Credits goes to Xero as an ACCPAYCREDIT credit note with
 * one net line, and is set against the bill it answers when that bill is in Xero. These are the
 * rules with no network, plus how a screen reads the sync log's marks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreditNotePayload, allocationFor, creditNoteDescription, creditNoteLink, billLink, xeroDocState, autoBillsWords, CREDIT_REASON_WORDS } from '../../../supabase/functions/_shared/xeroCreditNote.js';

const note = { id: '11111111-2222-3333-4444-555555555555', number: 'CN-204', note_date: '2026-11-05', amount: 48, tax: 8 };
const request = { reason: 'short', invoice_id: 'inv-1' };
const tracking = { Name: 'Site', Option: 'Leeds' };

test('the payload: ACCPAYCREDIT, one NET line (amount minus VAT) on the purchases account, Exclusive, tracking, AUTHORISED', () => {
  const p = buildCreditNotePayload({ note, request, supplierName: 'Bako', contactId: 'c-1', purchasesAccount: '300', purchaseTax: 'INPUT2', tracking, invoiceNumber: 'BK-9001' });
  const cn = p.CreditNotes[0];
  assert.equal(cn.Type, 'ACCPAYCREDIT');
  assert.deepEqual(cn.Contact, { ContactID: 'c-1' });
  assert.equal(cn.Date, '2026-11-05');
  assert.equal(cn.CreditNoteNumber, 'CN-204');
  assert.equal(cn.Reference, 'ServOS credit 11111111');
  assert.equal(cn.LineAmountTypes, 'Exclusive');
  assert.equal(cn.Status, 'AUTHORISED');
  assert.equal(cn.LineItems.length, 1);
  const line = cn.LineItems[0];
  assert.equal(line.UnitAmount, 40, 'net = 48 gross minus 8 VAT; Xero adds the VAT from the TaxType');
  assert.equal(line.Quantity, 1);
  assert.equal(line.AccountCode, '300');
  assert.equal(line.TaxType, 'INPUT2');
  assert.deepEqual(line.Tracking, [tracking]);
  assert.equal(line.Description, 'Credit note CN-204 from Bako, short delivery, against invoice BK-9001');
});

test('a note with no number, no request and no tracking still sends; a dry run has no contact yet', () => {
  const p = buildCreditNotePayload({ note: { ...note, number: null, tax: 0 }, supplierName: 'Bako', purchasesAccount: '300' });
  const cn = p.CreditNotes[0];
  assert.equal('CreditNoteNumber' in cn, false);
  assert.equal('Contact' in cn, false);
  assert.equal(cn.LineItems[0].UnitAmount, 48);
  assert.equal(cn.LineItems[0].TaxType, 'NONE');
  assert.equal('Tracking' in cn.LineItems[0], false);
  assert.equal(cn.LineItems[0].Description, 'Credit note from Bako');
});

test('VAT above the amount, or an amount below zero, is refused before anything reaches Xero', () => {
  assert.throws(() => buildCreditNotePayload({ note: { ...note, amount: 5, tax: 6 }, supplierName: 'Bako', purchasesAccount: '300' }), /VAT is more than its amount/);
  assert.throws(() => buildCreditNotePayload({ note: { ...note, amount: -1, tax: 0 }, supplierName: 'Bako', purchasesAccount: '300' }), /below zero/);
});

test('every credit reason has words', () => {
  for (const r of ['overcharge', 'short', 'not_coming', 'damaged', 'other']) assert.ok(CREDIT_REASON_WORDS[r]);
  assert.equal(creditNoteDescription({ note: { number: '7' }, request: { reason: 'nonsense' }, supplierName: 'X' }), 'Credit note 7 from X');
});

test('allocation: the smaller of the note total and what the bill still owes; nothing for a paid, voided, draft or missing bill', () => {
  assert.equal(allocationFor(48, { Status: 'AUTHORISED', AmountDue: 120 }), 48);
  assert.equal(allocationFor(48, { Status: 'AUTHORISED', AmountDue: 30.5 }), 30.5);
  assert.equal(allocationFor(48, { Status: 'AUTHORISED', AmountDue: 0 }), null);
  assert.equal(allocationFor(48, { Status: 'PAID', AmountDue: 0 }), null);
  assert.equal(allocationFor(48, { Status: 'VOIDED', AmountDue: 48 }), null);
  assert.equal(allocationFor(48, { Status: 'DRAFT', AmountDue: 48 }), null);
  assert.equal(allocationFor(48, null), null);
  assert.equal(allocationFor(0, { Status: 'AUTHORISED', AmountDue: 48 }), null);
});

test('links open the document in Xero', () => {
  assert.equal(creditNoteLink('abc'), 'https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=abc');
  assert.equal(billLink('abc'), 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=abc');
});

test('a screen reads the marks: ok is a link, error is the words, sending is busy, unknown rows are absent', () => {
  const st = xeroDocState([
    { refId: 'a', status: 'ok', link: 'https://x/a' },
    { refId: 'b', status: 'error', error: 'Xero 400' },
    { refId: 'c', status: 'sending' },
    { refId: 'd', status: 'error' },
    { status: 'ok' },
  ]);
  assert.deepEqual(st, { a: { link: 'https://x/a' }, b: { error: 'Xero 400' }, c: 'busy', d: { error: 'Failed' } });
  assert.deepEqual(xeroDocState(), {});
});

test('the words under the switch', () => {
  assert.match(autoBillsWords(null), /^Off\./);
  assert.match(autoBillsWords('2026-11-07T20:00:00Z'), /^On since 7 Nov 2026\./);
  assert.match(autoBillsWords('2026-11-07T20:00:00Z'), /within fifteen minutes/);
  assert.match(autoBillsWords('garbage'), /^On\. /);
});
