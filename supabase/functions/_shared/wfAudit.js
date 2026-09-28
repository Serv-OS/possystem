// supabase/functions/_shared/wfAudit.js: the ONE writer of the wf_audit hash chain (v5.10.3).
// Plain JS, no Deno or esm.sh imports, so node tests drive the real thing (wfAudit.test.js).
//
// INVARIANTS (Workforce / Payroll): wf_audit rows form a prev_hash/row_hash chain per location and
// are only written here. This is workforce-compute's writeAudit lifted out unchanged (same read,
// same hashed JSON, same columns), so rows it writes chain exactly as before. manager-approve used
// to insert its own rows with no hash and never looked at the insert error.
//
// What changed from the copy it replaces: a failure now comes back as { error } instead of being
// dropped. A failed chain read writes nothing (a row hashed onto '' because the read failed would
// look like the start of a new chain), and a failed insert is reported. The caller decides what a
// missing audit row means for its action.

/** Hex SHA-256 of a string (Web Crypto: Deno and node 20 both have it). */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hashed content of a row: exactly what workforce-compute has always hashed. */
export function auditHashInput(loc, org, action, d, prev) {
  return JSON.stringify({ loc, org, action, ...d, prev });
}

/**
 * Append one tamper-evident audit row (prev_hash = the location's latest row_hash, '' if none).
 * d: { actorId, actorName, amount, currency, reason, entity, entityId, before, after }; only the
 * keys given are hashed, in the order given, so callers keep passing the same shape.
 * Returns { error: null, row_hash } or { error: 'message' } (never throws).
 */
export async function writeWfAudit(client, loc, org, action, d = {}) {
  try {
    const { data: last, error: readErr } = await client.from('wf_audit')
      .select('row_hash').eq('location_id', loc).order('at', { ascending: false }).limit(1).maybeSingle();
    if (readErr) return { error: `audit chain read failed: ${readErr.message || readErr}` };
    const prev = last?.row_hash ?? '';
    const row_hash = await sha256Hex(auditHashInput(loc, org, action, d, prev));
    const { error } = await client.from('wf_audit').insert({
      location_id: loc, org_id: org, action,
      actor_id: d.actorId ?? null, actor_name: d.actorName ?? null,
      amount: d.amount ?? null, currency: d.currency ?? null, reason: d.reason ?? null,
      entity: d.entity ?? null, entity_id: d.entityId ?? null,
      before: d.before ?? null, after: d.after ?? null, prev_hash: prev, row_hash,
    });
    if (error) return { error: `audit write failed: ${error.message || error}` };
    return { error: null, row_hash };
  } catch (e) {
    return { error: `audit write failed: ${e?.message || e}` };
  }
}
