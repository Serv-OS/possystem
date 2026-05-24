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
  cors, json, platformAdmin, authenticateCaller, resolveCompanyId,
} from '../_shared/gift-card-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  const companyResult = await resolveCompanyId(caller.id);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body OK */ }

  const limit = Math.min(Number(body.limit) || 500, 1000);

  let query = platformAdmin
    .from('gift_cards')
    .select('id, code_last4, initial_amount_minor, balance_minor, status, issued_at, expires_at, recipient_name, recipient_email, recipient_phone, note, source, batch_name, batch_id, created_at')
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
