// supabase/functions/gift-list/index.ts
//
// v5.5.200: List gift cards for the caller's org with filtering.
// Body: { limit?, status?, source?, batch_name?, search? }
//   limit      — max results (default 500, max 1000)
//   status     — filter: 'active', 'redeemed', 'voided', 'expired'
//   source     — filter: 'manual', 'online', 'bulk', 'import'
//   batch_name — partial match on batch name
//   search     — search code_last4, recipient_name, or recipient_email

import {
  cors, json, opsAdmin, platformAdmin, authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';
import { decideCompanyStaff, PURCHASE_LIST_COLUMNS } from '../_shared/companyStaffAccess.js';

// Database fence stage 1 (contract P3): is the caller Back Office staff of this company?
// user_locations to a venue of the company, a super admin, or a Platform company role. Never
// "has a JWT": an anonymous session is free to anybody holding the public key.
async function isCompanyStaff(user: any, companyId: string): Promise<boolean> {
  if (!user?.id || user.is_anonymous) return false;
  const [prof, ul, venues, roles] = await Promise.all([
    opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
    opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id),
    platformAdmin.from('locations').select('ops_location_id').eq('company_id', companyId),
    platformAdmin.from('user_company_roles').select('company_id').eq('user_id', user.id),
  ]);
  return decideCompanyStaff({
    user,
    role: (prof.data as any)?.role ?? null,
    userLocationIds: ((ul.data as any[]) || []).map((r) => r.location_id),
    companyOpsLocationIds: ((venues.data as any[]) || []).map((r) => r.ops_location_id).filter(Boolean),
    companyRoleCompanyIds: ((roles.data as any[]) || []).map((r) => r.company_id),
    companyId,
  }).ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body OK */ }

  // v5.5.207: resolve company via location_id (reliable) with user fallback
  const companyResult = await resolveCompanyForLocation(caller.id, body.location_id as string);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // ── purchases: the Back Office "Online purchases" list (contract P3) ─────
  // The columns the screen shows, NOT fulfilled_code (a spendable code), and only for staff
  // of the company. After 20260919d the browser cannot read gift_card_purchases at all.
  if (body.action === 'purchases') {
    if (!body.location_id) return json({ error: 'location_id required' }, 400);
    if (!(await isCompanyStaff(caller, companyId))) return json({ error: 'not staff of this company' }, 403);
    const { data: rows, error: pErr } = await platformAdmin
      .from('gift_card_purchases')
      .select(PURCHASE_LIST_COLUMNS)
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(body.limit) || 50, 200));
    if (pErr) return json({ error: pErr.message }, 500);
    return json({ purchases: rows ?? [] });
  }

  const limit = Math.min(Number(body.limit) || 500, 1000);

  let query = platformAdmin
    .from('gift_cards')
    .select('id, code_last4, code_plain, initial_amount_minor, balance_minor, status, issued_at, expires_at, recipient_name, recipient_email, recipient_phone, note, source, batch_name, batch_id, created_at')
    .eq('company_id', companyId);

  // Apply filters
  if (body.status && typeof body.status === 'string') {
    query = query.eq('status', body.status);
  }
  if (body.source && typeof body.source === 'string') {
    query = query.eq('source', body.source);
  }
  if (body.batch_name && typeof body.batch_name === 'string') {
    query = query.ilike('batch_name', `%${body.batch_name}%`);
  }
  if (body.search && typeof body.search === 'string') {
    const s = body.search as string;
    query = query.or(`code_last4.ilike.%${s}%,recipient_name.ilike.%${s}%,recipient_email.ilike.%${s}%,recipient_phone.ilike.%${s}%`);
  }

  const { data, error: err } = await query
    .order('created_at', { ascending: false })
    .limit(limit);

  if (err) return json({ error: err.message }, 500);

  return json({ cards: data ?? [], total: data?.length ?? 0 });
});
