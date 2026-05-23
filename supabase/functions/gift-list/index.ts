// supabase/functions/gift-list/index.ts
//
// List recent gift cards for the caller's org.
// Body: { limit? } (default 50)

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

  const limit = Math.min(Number(body.limit) || 50, 200);

  const { data, error: err } = await platformAdmin
    .from('gift_cards')
    .select('id, code_last4, initial_amount_minor, balance_minor, status, issued_at, expires_at, recipient_name, recipient_email, note')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (err) return json({ error: err.message }, 500);

  return json({ cards: data ?? [] });
});
