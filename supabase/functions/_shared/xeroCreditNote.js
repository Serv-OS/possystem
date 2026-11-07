// supabase/functions/_shared/xeroCreditNote.js
//
// Supplier credit notes to Xero (5.12.73, 7 Nov 2026). Peter: "we need to start getting ready for
// all stock syncing for invoices credit notes etc". The rules, with no network: what the credit
// note sent to Xero looks like, how much of it is set against the bill it came from, where its
// link goes, and how a screen reads a document's state from the sync log. Tested in
// src/lib/accounting/xeroCreditNote.test.js. Node and Deno both load this file (no imports).
//
// A credit note from Purchasing > Credits records the supplier's number, date, amount and VAT.
// It goes to Xero as an ACCPAYCREDIT credit note: one NET line (amount minus VAT, Exclusive) on
// the purchases account, the venue's site tracking, AUTHORISED. When the request it answers
// names a supplier invoice that is already in Xero as a bill, the credit note is allocated
// against that bill, up to what the bill still owes.

export const CREDIT_REASON_WORDS = Object.freeze({
  overcharge: 'Overcharge', short: 'Short delivery', not_coming: 'Not coming', damaged: 'Damaged', other: 'Other',
});

export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const short = (id) => String(id || '').slice(0, 8);

/** The words on the one line. */
export function creditNoteDescription({ note, request = null, supplierName = '', invoiceNumber = null }) {
  const parts = [`Credit note${note?.number ? ` ${note.number}` : ''} from ${supplierName || 'the supplier'}`];
  const reason = CREDIT_REASON_WORDS[request?.reason] || null;
  if (reason) parts.push(reason.toLowerCase());
  if (invoiceNumber) parts.push(`against invoice ${invoiceNumber}`);
  return parts.join(', ');
}

/**
 * The Xero credit note. Throws when the note cannot be sent (VAT above the amount).
 * tracking: { Name, Option } or null. contactId may be null on a dry run.
 */
export function buildCreditNotePayload({ note, request = null, supplierName, contactId = null, purchasesAccount, purchaseTax = 'NONE', tracking = null, invoiceNumber = null }) {
  const gross = money(note?.amount);
  const tax = money(note?.tax);
  if (gross < 0) throw new Error('The credit note amount is below zero.');
  if (tax > gross) throw new Error('The credit note VAT is more than its amount. Check the note before sending it.');
  const line = {
    Description: creditNoteDescription({ note, request, supplierName, invoiceNumber }),
    Quantity: 1,
    UnitAmount: money(gross - tax),
    AccountCode: purchasesAccount,
    TaxType: purchaseTax || 'NONE',
    ...(tracking ? { Tracking: [tracking] } : {}),
  };
  return {
    CreditNotes: [{
      Type: 'ACCPAYCREDIT',
      ...(contactId ? { Contact: { ContactID: contactId } } : {}),
      Date: note?.note_date || new Date().toISOString().slice(0, 10),
      ...(note?.number ? { CreditNoteNumber: String(note.number).slice(0, 255) } : {}),
      Reference: `ServOS credit ${short(note?.id)}`,
      LineAmountTypes: 'Exclusive',
      LineItems: [line],
      Status: 'AUTHORISED',
    }],
  };
}

/**
 * How much of the credit note goes against the bill: the smaller of the note's total and what the
 * bill still owes. null when there is nothing to allocate (no bill, a bill that is paid, voided,
 * deleted or still a draft).
 */
export function allocationFor(creditTotal, bill) {
  if (!bill || bill.Status !== 'AUTHORISED') return null;
  const due = money(bill.AmountDue);
  const total = money(creditTotal);
  if (!(due > 0) || !(total > 0)) return null;
  return money(Math.min(due, total));
}

export const creditNoteLink = (id) => `https://go.xero.com/AccountsPayable/ViewCreditNote.aspx?creditNoteID=${id}`;
export const billLink = (id) => `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${id}`;

/**
 * A screen's state for the documents the sync log knows (xero-config 'documents'):
 * ok -> { link }, error -> { error }, sending -> 'busy'. Rows the log does not have are absent.
 */
export function xeroDocState(docs = []) {
  const out = {};
  for (const d of docs || []) {
    if (!d?.refId) continue;
    if (d.status === 'ok') out[d.refId] = { link: d.link || null };
    else if (d.status === 'sending') out[d.refId] = 'busy';
    else out[d.refId] = { error: d.error || 'Failed' };
  }
  return out;
}

/** The words under the automatic sending switch. */
export function autoBillsWords(since) {
  if (!since) return 'Off. Bills and credit notes go to Xero when someone presses Push.';
  const d = new Date(since);
  const day = Number.isNaN(d.getTime()) ? '' : ` since ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `On${day}. A posted supplier invoice goes to Xero as a bill, and a credit note when it is added, within fifteen minutes. Anything refused is listed under Bills and credit notes with a Retry button.`;
}
