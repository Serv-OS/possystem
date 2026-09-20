// src/lib/customerFenceRules.js
//
// Pure rules for database fence stage 2 (the customer records). No imports, so tests and
// edge functions can read them without pulling in the browser client.

/**
 * Is this error "the server function is not there yet"? PostgREST answers PGRST202 for an
 * unknown RPC and Postgres 42883 for an unknown function; either means the fence file has
 * not been run, so the caller may take the old path. Anything else (a refusal, an expired
 * token, a network fault) must NOT send the caller back to the table.
 */
export function isMissingFn(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'PGRST202' || code === '42883') return true;
  const msg = String(error.message || '').toLowerCase();
  return msg.includes('could not find the function') || msg.includes('does not exist');
}
