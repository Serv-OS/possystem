// supabase/functions/loyalty-enroll/index.ts
//
// Enrol a customer in the loyalty programme WITHOUT a purchase — used by the WiFi captive
// portal ("Join rewards") and reusable by any sign-up surface. Wraps the shared
// ensureMembership() so enrolment matches the purchase auto-enrol path exactly (config,
// member_code, welcome bonus). Idempotent: ensureMembership no-ops if already a member.
//
//   { customer_id, company_id, location_id?, source? } → { enrolled, member_code?, is_new? }
//
// Called service-to-service from wifi-capture (Bearer service role). verify_jwt=false.

import { cors, json, getOrCreateConfig, ensureMembership } from '../_shared/loyalty-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const customerId = String(body.customer_id ?? '').trim();
  const companyId = String(body.company_id ?? '').trim();
  if (!customerId || !companyId) return json({ error: 'customer_id and company_id required' }, 400);

  const config = await getOrCreateConfig(companyId);
  if (!config || !config.enabled) return json({ enrolled: false, reason: 'loyalty_disabled' });

  const result = await ensureMembership(customerId, companyId, config);
  if (result instanceof Response) return result;        // surfaced error from the shared helper
  return json({ enrolled: true, member_code: result.membership?.member_code ?? null, is_new: !!result.isNew });
});
