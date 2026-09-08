// supabase/functions/gift-branding-public/index.ts
//
// PUBLIC (no auth required) — returns gift card branding for a company.
// Used by customer-facing gift card pages to load the merchant's custom
// colours, logo, and hero image before rendering.
//
// Body: { company_id }
// Returns: { branding, enabled }

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

  const companyId = body.company_id as string;
  if (!companyId) return json({ error: 'company_id required' }, 400);

  const { data } = await platformAdmin
    .from('gift_brand_config')
    .select('branding, enabled')
    .eq('company_id', companyId)
    .maybeSingle();

  return json({
    branding: data?.branding || null,
    enabled: !!data?.enabled,
  });
});
