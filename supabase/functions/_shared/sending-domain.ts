// _shared/sending-domain.ts — resolve a venue's branded From, or the platform fallback.
// SAFE BY DESIGN: only returns a custom sender when the org has a domain that is BOTH status='verified'
// AND is_active. Any other state (none / pending / failed / inactive) → the platform fallback, so a
// missing or broken custom domain can never block a send (especially a receipt).
//
// Returns { from, email, name?, replyTo? } so each provider adapter can format correctly:
//   Resend / Postmark → use `from` ("Name <email>" or email) + replyTo
//   SendGrid          → use { email, name } + replyTo

export interface Sender { from: string; email: string; name?: string; replyTo?: string }

// RFC 5322 display-name: strip CR/LF, and quote+escape if it contains any specials (commas, quotes, @ …).
export function encodeDisplayName(name: string): string {
  const n = String(name).replace(/[\r\n]+/g, ' ').trim();
  if (!n) return '';
  return /[()<>[\]:;@\\,."]/.test(n) ? `"${n.replace(/(["\\])/g, '\\$1')}"` : n;
}

// Caller may use the BRANDED From for this location only if it's a trusted internal call (service-role)
// or a user with access to the location. Anonymous kiosk/online callers fail this → they still send,
// but from the platform default (prevents using a victim org's verified domain via a guessed location_id).
export async function callerCanBrandForLocation(req: Request, admin: any, locationId: string | null | undefined, serviceRole: string): Promise<boolean> {
  if (!locationId) return false;
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (serviceRole && token === serviceRole) return true;
  try {
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return false;
    const { data: ul } = await admin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', locationId).maybeSingle();
    if (ul) return true;
    const { data: prof } = await admin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
    return prof?.role === 'super_admin';
  } catch { return false; }
}

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
    const safe = name ? encodeDisplayName(name) : '';
    const replyTo = (dom.reply_to || '').trim() || undefined;
    return { from: safe ? `${safe} <${dom.from_address}>` : dom.from_address, email: dom.from_address, name, replyTo };
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
