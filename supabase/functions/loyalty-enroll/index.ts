// supabase/functions/loyalty-enroll/index.ts
//
// Enrol a customer in the loyalty programme WITHOUT a purchase — used by the WiFi captive
// portal ("Join rewards") and reusable by any sign-up surface. Wraps the shared
// ensureMembership() so enrolment matches the purchase auto-enrol path exactly (config,
// member_code, welcome bonus). Idempotent: ensureMembership no-ops if already a member.
//
//   { customer_id, company_id, location_id?, source?, member_token? } → { enrolled, member_code?, is_new? }
//
// Called service-to-service from wifi-capture (Bearer service role). verify_jwt=false.
//
// 18 Sep 2026 (round three, enforced now). This had NO auth at all and credited the registration
// bonus to any customer id in any company. Its only caller is wifi-capture (service role). Now:
//   * who: the service role (wifi-capture), the member's own token for their own customer id in
//     that company, staff for the company (the database's access rule), or a claimed device of
//     the company. Anybody else: 401/403, logged.
//   * what: the customer must exist, not be deleted, and belong to one of THIS company's orgs.
//     A customer id from another tenant is refused (404), so a bonus can never be credited
//     across companies.
//   * location_id, when sent, must be a location of the company.

import {
  cors, json, opsAdmin, platformAdmin, getOrCreateConfig, ensureMembership,
  optionalCaller, isServiceRoleRequest, checkLoyaltyAuthority, deviceHintOf, uuidOr0,
} from '../_shared/loyalty-utils.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const customerId = String(body.customer_id ?? '').trim();
  const companyId = String(body.company_id ?? '').trim();
  if (!customerId || !companyId) return json({ error: 'customer_id and company_id required' }, 400);
  if (!UUID.test(customerId) || !UUID.test(companyId)) return json({ error: 'customer_id and company_id must be ids' }, 400);
  const locationId = body.location_id ? String(body.location_id) : null;

  // ── Who (before anything is read or written) ───────────────────────────
  const serviceRole = isServiceRoleRequest(req);
  if (!serviceRole) {
    const caller = await optionalCaller(req);
    const memberToken = body.member_token ?? req.headers.get('x-member-token');
    if (!caller && !memberToken) return json({ error: 'Unauthorized' }, 401);
    const gate = await checkLoyaltyAuthority({
      fn: 'loyalty-enroll',
      caller,
      locationId,
      companyId,
      customerId,
      memberToken,
      channel: body.source ?? null,
      modeOverride: 'enforce',        // no report period: the only real caller is the service role
      deviceHint: deviceHintOf(body),
    });
    if (!gate.allow) return gate.response!;
  }

  // ── What: the customer and the location must be this company's ────────
  const { data: locs } = await platformAdmin
    .from('locations')
    .select('id, ops_location_id, org_id')
    .eq('company_id', companyId)
    .limit(500);
  const orgIds = new Set((locs || []).map((l: any) => l.org_id).filter(Boolean).map(String));
  if (locationId) {
    const ok = (locs || []).some((l: any) => String(l.id) === locationId || String(l.ops_location_id) === locationId);
    if (!ok) return json({ error: 'location is not part of this company' }, 403);
  }
  // Ops locations carry the org too (the Platform copy may lag a new venue).
  const opsIds = (locs || []).map((l: any) => l.ops_location_id).filter(Boolean).map(String);
  if (opsIds.length) {
    const { data: opsLocs } = await opsAdmin.from('locations').select('org_id').in('id', opsIds.map(uuidOr0));
    for (const l of (opsLocs || [])) if (l.org_id) orgIds.add(String(l.org_id));
  }
  const { data: customer } = await opsAdmin
    .from('customers')
    .select('id, org_id')
    .eq('id', customerId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!customer || !customer.org_id || !orgIds.has(String(customer.org_id))) {
    return json({ error: 'Customer not found' }, 404);
  }

  const config = await getOrCreateConfig(companyId);
  if (!config || !config.enabled) return json({ enrolled: false, reason: 'loyalty_disabled' });

  const result = await ensureMembership(customerId, companyId, config);
  if (result instanceof Response) return result;        // surfaced error from the shared helper
  return json({ enrolled: true, member_code: result.membership?.member_code ?? null, is_new: !!result.isNew });
});
