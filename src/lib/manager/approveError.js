// src/lib/manager/approveError.js: pure, no I/O (node tests import it; data.js cannot load in node).

/** v5.10.2: manager-approve refuses with a 4xx and { error } in the body ('PIN not recognised',
 *  'not allowed to approve', 'already clocked out'). supabase-js reports any non-2xx as the same
 *  "Edge Function returned a non-2xx status code", so the Team and Kitchen tabs could never tell a
 *  wrong PIN from anything else. Read the server's own message; the transport message otherwise. */
export async function approveErrorMessage(error) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return String(body.error);
  } catch { /* not JSON: fall back to the transport message */ }
  return error?.message || 'Could not save';
}
