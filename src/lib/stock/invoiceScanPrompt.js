// src/lib/stock/invoiceScanPrompt.js
//
// 5.12.57 (US basics batch 7): what the invoice reader (api/stock-invoice-scan.js) is told about the
// venue. The reader used to be told every invoice was for a UK business in pounds with VAT, so a US
// date 03/11/2026 (11 March, month first) could be read as 3 November. Now the site's currency
// decides: a US site is told the US, USD, sales tax and month first dates; an Irish site Ireland,
// EUR and day first. A UK site (or no currency at all) gets exactly the words it got before.
//
// PURE: imports only regionPack.js, so the API and node --test read the same text.

import { regionOf } from '../../../supabase/functions/_shared/regionPack.js';

const SHAPE = (currency) => `Return ONLY a single JSON object, no prose, no code fences. Shape:
{
  "supplier_name": string|null,
  "invoice_number": string|null,
  "invoice_date": "YYYY-MM-DD"|null,
  "currency": "${currency}"|string|null,
  "lines": [ { "code": string|null, "description": string, "qty": number, "unit": string, "unit_price": number, "line_total": number } ],
  "subtotal": number|null, "tax": number|null, "total": number|null,
  "confidence": number  // 0-1 your overall confidence
}`;

const CODE_RULE = 'code is the supplier\'s product code or SKU printed on the line (for example SKU-022-HAR), null when none is printed; never invent one.';

/** The UK text, word for word what the reader was told before 5.12.57. */
const UK_SYSTEM = `You extract structured data from a supplier invoice or delivery note for a UK hospitality business.
${SHAPE('GBP')}
Rules: qty is the number of packs/units billed; unit is the pack/measure word as printed (e.g. "case","kg","each","ltr"); unit_price is the price per that unit (ex-VAT if shown separately); line_total is the line's net amount. Use numbers (not strings) for money/quantities. If a field is missing use null. Never invent lines. ${CODE_RULE}`;

const US_SYSTEM = `You extract structured data from a supplier invoice or delivery note for a restaurant in the United States.
The venue's currency is USD (US dollars). Dates on the invoice are written month first (MM/DD/YYYY): 03/11/2026 is 11 March 2026, so invoice_date is "2026-03-11". Volume units are US measures: a gallon is a US gallon, a pint a US pint, a fl oz a US fluid ounce; "#" after a number means pounds (lb); "cs" means case.
${SHAPE('USD')}
Rules: qty is the number of packs/units billed; unit is the pack/measure word as printed (e.g. "cs","lb","each","gal"); unit_price is the price per that unit (before sales tax if tax is shown separately); line_total is the line's amount before sales tax; tax is the sales tax on the invoice, if any. Use numbers (not strings) for money/quantities. If a field is missing use null. Never invent lines. ${CODE_RULE} If the invoice is plainly in another currency, put that currency's code in currency.`;

const IE_SYSTEM = `You extract structured data from a supplier invoice or delivery note for a hospitality business in Ireland.
The venue's currency is EUR (euro). Dates on the invoice are written day first (DD/MM/YYYY): 03/11/2026 is 3 November 2026, so invoice_date is "2026-11-03".
${SHAPE('EUR')}
Rules: qty is the number of packs/units billed; unit is the pack/measure word as printed (e.g. "case","kg","each","ltr"); unit_price is the price per that unit (ex-VAT if shown separately); line_total is the line's net amount. Use numbers (not strings) for money/quantities. If a field is missing use null. Never invent lines. ${CODE_RULE} If the invoice is plainly in another currency, put that currency's code in currency.`;

/**
 * The reader's system text for one site. currency: the site's ('GBP' | 'USD' | 'EUR'); anything
 * else (or nothing) is the UK text, as before.
 */
export function invoiceScanSystem(currency = null) {
  const c = String(currency || '').trim().toUpperCase();
  if (!c) return UK_SYSTEM;
  const country = regionOf(c);
  if (country === 'US') return US_SYSTEM;
  if (country === 'IE' && c === 'EUR') return IE_SYSTEM;
  return UK_SYSTEM;
}

/** The one line the reader is asked with, per site. */
export function invoiceScanAsk(currency = null) {
  const country = regionOf(String(currency || '').trim().toUpperCase() || 'GBP');
  if (country === 'US') return 'Extract this invoice as JSON per the schema. It is a US invoice: dates are month first.';
  return 'Extract this invoice as JSON per the schema.';
}
