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
// Pure apart from the client passed in (no import of the supabase module), so it is tested
// under `npm test` with a fake client.

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
 * opts: { upsert?: boolean, select?: string, tag?: string, now?: () => number }
 */
export async function writeClosedCheckRow(client, row, opts = {}) {
  const { upsert = false, select = null, tag = 'closed_checks', now = () => Date.now() } = opts;
  const payload = { ...row };
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
