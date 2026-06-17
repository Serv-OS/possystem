// _shared/sending-domain.ts — resolve a venue's branded From, or the platform fallback.
// SAFE BY DESIGN: only returns a custom sender when the org has a domain that is BOTH status='verified'
// AND is_active. Any other state (none / pending / failed / inactive) → the platform fallback, so a
// missing or broken custom domain can never block a send (especially a receipt).
//
// Returns { from, email, name?, replyTo? } so each provider adapter can format correctly:
//   Resend / Postmark → use `from` ("Name <email>" or email) + replyTo
//   SendGrid          → use { email, name } + replyTo

export interface Sender { from: string; email: string; name?: string; replyTo?: string }

// Resolve by org_id (marketing-send already knows the org).
export async function resolveSenderForOrg(admin: any, orgId: string | null | undefined, fallbackEmail: string): Promise<Sender> {
  const fallback: Sender = { from: fallbackEmail, email: fallbackEmail };
  try {
    if (!orgId) return fallback;
    const { data: dom } = await admin.from('org_sending_domains')
      .select('from_address, from_name, reply_to')
      .eq('org_id', orgId).eq('is_active', true).eq('status', 'verified').maybeSingle();
    if (!dom?.from_address) return fallback;
    const name = dom.from_name || undefined;
    return { from: name ? `${name} <${dom.from_address}>` : dom.from_address, email: dom.from_address, name, replyTo: dom.reply_to || undefined };
  } catch { return fallback; }   // never let sender resolution break a send
}

// Daily re-check of non-terminal domains against Resend, so a domain that silently loses a DNS record
// (Resend → temporary_failure/failed) is reflected and the sender stops trusting it. Called by the cron.
export async function refreshSendingDomains(admin: any, resendKey: string, _opts?: unknown): Promise<number> {
  if (!resendKey) return 0;
  const { data: rows } = await admin.from('org_sending_domains')
    .select('id, resend_domain_id, status, verified_at')
    .not('resend_domain_id', 'is', null)
    .in('status', ['pending', 'verified', 'partially_verified', 'partially_failed', 'temporary_failure']);
  let n = 0;
  for (const row of rows ?? []) {
    try {
      const r = await fetch(`https://api.resend.com/domains/${row.resend_domain_id}`, { headers: { Authorization: `Bearer ${resendKey}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.status) continue;
      const now = new Date().toISOString();
      const upd: Record<string, unknown> = { status: j.status, last_checked_at: now, updated_at: now };
      if (j.records) upd.dns_records = j.records;
      if (j.status === 'verified' && !row.verified_at) upd.verified_at = now;
      await admin.from('org_sending_domains').update(upd).eq('id', row.id);
      n++;
    } catch (_e) { /* skip this domain */ }
  }
  return n;
}

// Resolve by location_id (receipt/welcome senders get a location, not an org).
export async function resolveSenderFrom(admin: any, locationId: string | null | undefined, fallbackEmail: string): Promise<Sender> {
  if (!locationId) return { from: fallbackEmail, email: fallbackEmail };
  try {
    const { data: loc } = await admin.from('locations').select('org_id').eq('id', locationId).maybeSingle();
    return await resolveSenderForOrg(admin, loc?.org_id, fallbackEmail);
  } catch { return { from: fallbackEmail, email: fallbackEmail }; }
}
