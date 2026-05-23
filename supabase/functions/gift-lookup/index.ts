// supabase/functions/gift-lookup/index.ts
//
// Look up a gift card by full code or by code_last4 + email.
// Returns card details and recent transactions.
//
// Body: { code } or { code_last4, email }

import {
  cors, json, platformAdmin, authenticateCaller, resolveCompanyId,
  normalizeCode, hmacLookup,
} from '../_shared/gift-card-utils.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const caller = authResult.user;

  // Resolve company
  const companyResult = await resolveCompanyId(caller.id);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult;

  // Parse body
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { code, code_last4, email } = body as any;

  let card: any = null;

  if (code) {
    // Full code lookup via HMAC index
    const normalized = normalizeCode(code as string);
    if (normalized.length !== 16) {
      return json({ error: 'Code must be 16 characters' }, 400);
    }

    // Get org's HMAC secret
    const { data: config } = await platformAdmin
      .from('gift_brand_config')
      .select('hmac_secret, currency')
      .eq('company_id', companyId)
      .maybeSingle();
    if (!config) return json({ error: 'Gift cards not configured for this org' }, 404);

    const lookup = await hmacLookup(normalized, config.hmac_secret);
    const { data } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('code_lookup', lookup)
      .eq('company_id', companyId)
      .maybeSingle();
    card = data;
  } else if (code_last4 && email) {
    // Support lookup by last4 + email
    const { data } = await platformAdmin
      .from('gift_cards')
      .select('*')
      .eq('company_id', companyId)
      .eq('code_last4', String(code_last4).toUpperCase())
      .eq('recipient_email', String(email).toLowerCase().trim())
      .maybeSingle();
    card = data;
  } else {
    return json({ error: 'Provide either { code } or { code_last4, email }' }, 400);
  }

  if (!card) return json({ error: 'Card not found' }, 404);

  // Get currency from brand config
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('currency')
    .eq('company_id', companyId)
    .maybeSingle();

  // Fetch recent transactions (last 20)
  const { data: txns } = await platformAdmin
    .from('gift_card_transactions')
    .select('id, type, amount_minor, balance_after_minor, location_id, order_id, channel, staff_id, note, created_at')
    .eq('card_id', card.id)
    .order('created_at', { ascending: false })
    .limit(20);

  return json({
    card_id: card.id,
    status: card.status,
    balance: card.balance_minor,
    initial_amount: card.initial_amount_minor,
    currency: config?.currency || 'gbp',
    code_last4: card.code_last4,
    expires_at: card.expires_at,
    issued_at: card.issued_at,
    recipient_name: card.recipient_name,
    recipient_email: card.recipient_email,
    note: card.note,
    recent_transactions: txns ?? [],
  });
});
