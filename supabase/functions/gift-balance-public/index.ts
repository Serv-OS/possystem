// supabase/functions/gift-balance-public/index.ts
//
// PUBLIC (no auth required) — customer-facing balance check.
// Body: { code, company_id }
// Returns: { balance_minor, code_last4, status, expires_at, currency }
//
// Security: verifies the code against argon2id hash so only the holder
// of the full code can see the balance. Returns minimal safe-to-display data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { argon2Verify } from 'https://esm.sh/hash-wasm@4.11.0';

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

// HMAC-SHA256 lookup index — same algo as gift-card-utils.ts
async function hmacLookup(code: string, hmacSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(code));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const code = String(body.code || '').replace(/[\s-]/g, '').toUpperCase();
  const companyId = body.company_id as string;

  if (!code || code.length < 10) return json({ error: 'Invalid code' }, 400);
  if (!companyId) return json({ error: 'company_id required' }, 400);

  // Get brand config for HMAC secret
  const { data: config } = await platformAdmin
    .from('gift_brand_config')
    .select('hmac_secret, currency')
    .eq('company_id', companyId)
    .maybeSingle();

  if (!config) return json({ error: 'Gift cards not configured for this venue' }, 404);

  // Compute HMAC lookup index
  const lookup = await hmacLookup(code, config.hmac_secret);

  // Find card by lookup index
  const { data: card } = await platformAdmin
    .from('gift_cards')
    .select('id, code_hash, code_last4, balance_minor, status, expires_at')
    .eq('company_id', companyId)
    .eq('code_lookup', lookup)
    .maybeSingle();

  if (!card) return json({ error: 'Card not found. Check the code and try again.' }, 404);

  // Verify code against argon2id hash
  const valid = await argon2Verify({ password: code, hash: card.code_hash });
  if (!valid) return json({ error: 'Card not found. Check the code and try again.' }, 404);

  // Check expiry
  let status = card.status;
  if (status === 'active' && card.expires_at && new Date(card.expires_at) < new Date()) {
    status = 'expired';
  }

  return json({
    balance_minor: card.balance_minor,
    code_last4: card.code_last4,
    status,
    expires_at: card.expires_at,
    currency: config.currency || 'gbp',
  });
});
