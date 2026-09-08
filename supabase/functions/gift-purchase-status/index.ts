// supabase/functions/gift-purchase-status/index.ts
//
// PUBLIC (no auth required) — polls purchase status for the success page.
// Body: { session_id, company_id }
// Returns: { status, amount_minor, currency, recipient_name, recipient_email,
//            code_last4?, delivery_type }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const sessionId  = body.session_id as string | undefined;
  // v5.5.911: a Ryft purchase has NO Stripe session id — it is looked up by our own
  // purchase id instead. The company_id fence below is unchanged and still applies to
  // both, so a bare purchase_id can never read another tenant's row.
  const purchaseId = body.purchase_id as string | undefined;
  const companyId  = body.company_id as string;

  if (!sessionId && !purchaseId) return json({ error: 'session_id or purchase_id required' }, 400);
  if (!companyId) return json({ error: 'company_id required' }, 400);

  let q = platformAdmin
    .from('gift_card_purchases')
    .select('id, status, amount_minor, currency, recipient_name, recipient_email, code_last4, delivery_type, sender_name')
    .eq('company_id', companyId);
  q = purchaseId ? q.eq('id', purchaseId) : q.eq('stripe_session_id', sessionId!);
  const { data: purchase } = await q.maybeSingle();

  if (!purchase) {
    return json({ error: 'Purchase not found', status: 'not_found' }, 404);
  }

  return json({
    status: purchase.status,
    amount_minor: purchase.amount_minor,
    currency: purchase.currency || 'gbp',
    recipient_name: purchase.recipient_name,
    recipient_email: purchase.recipient_email,
    sender_name: purchase.sender_name,
    code_last4: purchase.code_last4,
    delivery_type: purchase.delivery_type,
  });
});
