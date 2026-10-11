// src/lib/closedCheckWrite.js
//
// THE ONE WAY A closed_checks ROW IS WRITTEN. By the time a check is written the customer's
// money is gone (card charged, gift card debited, cash in the drawer). If the insert fails
// the sale exists nowhere. v5.5.909 found the cause that matters here: PostgREST checks every
// KEY of the payload against its schema cache, so one column the database does not have yet
// (a migration not run) fails the WHOLE insert. The kiosk learned to strip the named column
// and retry (v5.5.909); v5.9.11 moves that loop here so every writer gets it, because every
// writer now sends `tenders` and Peter runs the migration by hand, sometimes after the deploy.
//
// A column found missing is remembered for 10 minutes, so a till does not pay a failing
// round trip on every sale; after that it tries again and picks the column up once it exists.
//
// 8 Oct 2026 (VAT audit): this is also where every sale meets the save time guard
// (lib/saleVatGuard.js assertSaleVat). A row with goods above 0 and no VAT, or no record of the
// rate, at a venue that has rates is repaired from its lines with the Back Office item rules and
// tagged source 'repair'; one that cannot be repaired is REFUSED with a named error (SaleVatError,
// code 'vat_missing') handed back as `error`, never saved with tax_amount null. The venue's rates
// come from the caller (`vat`) or, for writers with no venue context of their own (the offline
// replays, db.js), from the source the store registers (saleVatGuard.setVenueTaxSource).
//
// Pure apart from the client passed in (no import of the supabase module), so it is tested
// under `npm test` with a fake client.

import { scrubDiscounts, scrubItemDiscounts } from './discountApprover.js';
import { assertSaleVat, isSaleVatError, venueTaxNow } from './saleVatGuard.js';

const MISSING_TTL_MS = 10 * 60 * 1000;
const _missing = new Map();   // column -> until (ms)

/** The column PostgREST says it does not know, or null. */
export function missingColumnOf(error) {
  if (!error) return null;
  const msg = String(error.message || '');
  return /Could not find the '([^']+)' column/.exec(msg)?.[1]
    || (error.code === '42703' ? /column "?(?:[\w]+\.)?([\w]+)"? (?:of relation "[\w]+" )?does not exist/.exec(msg)?.[1] : null)
    || null;
}

/** Forget remembered missing columns (tests, and after a migration is known to have run). */
export function resetMissingColumns() { _missing.clear(); }

/**
 * Insert (or with `upsert`, INSERT ... ON CONFLICT (id) DO NOTHING returning the row) one
 * closed_checks row. Returns what supabase-js returns ({ data, error }) plus `dropped`, the
 * columns left out because the database does not have them. Never throws for a missing
 * column; any other error comes back as `error`, exactly as before.
 *
 * opts: { upsert?: boolean, select?: string, tag?: string, now?: () => number,
 *         vat?: venue tax for the save time guard (saleVatGuard.normaliseVenueTax shapes);
 *              left out = the source the store registered; null/false = judge nothing }
 * 8 Oct 2026: a row the guard refuses comes back as { data: null, error: SaleVatError, dropped: [] }
 * (error.code 'vat_missing'), so every caller's existing error handling keeps the sale and says so.
 */
export async function writeClosedCheckRow(client, row, opts = {}) {
  const { upsert = false, select = null, tag = 'closed_checks', now = () => Date.now() } = opts;
  let payload = { ...row };
  // 8 Oct 2026: the save time guard. Repairs the VAT from the lines (tagged) or refuses by name.
  try {
    const guarded = assertSaleVat(payload, 'vat' in opts ? opts.vat : venueTaxNow(), { tag, now });
    if (guarded !== payload) {
      console.warn(`[${tag}] closed_checks ${payload.ref || payload.id}: VAT ${guarded.tax_breakdown?.repair?.reason || 'repaired'} from the Back Office item rules before the save`);
      payload = guarded;
    }
  } catch (e) {
    if (!isSaleVatError(e)) throw e;
    console.error(`[${tag}] closed_checks ${payload.ref || payload.id} NOT saved: ${e.message}`);
    return { data: null, error: e, dropped: [] };
  }
  // v5.10.0: never a staff record (with its PIN) on a discount, whichever writer built the row.
  if ('discounts' in payload) payload.discounts = scrubDiscounts(payload.discounts);
  if ('items' in payload) payload.items = scrubItemDiscounts(payload.items);
  const dropped = [];
  const t = now();
  for (const [col, until] of _missing) {
    if (until > t && col in payload) { delete payload[col]; dropped.push(col); }
    else if (until <= t) _missing.delete(col);
  }
  const send = () => {
    let q = upsert
      ? client.from('closed_checks').upsert(payload, { onConflict: 'id', ignoreDuplicates: true })
      : client.from('closed_checks').insert(payload);
    if (select) q = q.select(select);
    return q;
  };
  let res = await send();
  for (let attempt = 0; res?.error && attempt < 6; attempt++) {
    const col = missingColumnOf(res.error);
    if (!col || !(col in payload) || col === 'id' || col === 'location_id') break;
    console.error(`[${tag}] closed_checks has no '${col}' column, sending the check without it so the paid sale still records. `
      + 'Run the pending migration to keep this detail.');
    delete payload[col];
    dropped.push(col);
    _missing.set(col, t + MISSING_TTL_MS);
    res = await send();
  }
  return { ...(res || {}), dropped };
}
