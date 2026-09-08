// supabase/functions/ryft-create-payment-session
//
// Ryft equivalent of stripe-create-payment-intent. Creates a Payment Session
// and returns a NORMALISED shape the client can render with the Ryft embedded
// SDK: { processor:'ryft', sessionId, clientSecret, publicKey, accountId }.
//
// If the location has a Ryft sub-account (merchant_ryft_accounts), the payment
// is routed to it (Account header) with a platform fee; otherwise it's created
// on the platform account directly (useful for sandbox before onboarding).
//
// Auth: service-role key (internal / curl tests) OR a signed-in user — mirrors
// the hardened send-* functions. Amounts are MINOR units.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createPaymentSession, ryftPublicKey, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await opsAdmin.auth.getUser(token); return !!user; } catch { return false; }
}

interface Body {
  location_id?: string;
  amount_minor?: number;
  currency?: string;                       // gbp|usd|eur (any case)
  channel?: 'card_present' | 'online';
  capture_method?: 'automatic' | 'manual';
  customer_email?: string;
  closed_check_id?: string;
  metadata?: Record<string, string>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await authorize(req))) return json({ error: 'unauthorized' }, 401);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured — set RYFT_SECRET_KEY' }, 500);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const { location_id, amount_minor, channel = 'online', capture_method = 'automatic', customer_email, closed_check_id, metadata = {} } = body;
  const currency = String(body.currency || 'gbp').toUpperCase();
  if (!amount_minor || amount_minor <= 0) return json({ error: 'amount_minor must be > 0' }, 400);
  if (!['GBP', 'USD', 'EUR'].includes(currency)) return json({ error: 'currency must be gbp, usd or eur' }, 400);

  // Resolve the location's Ryft sub-account (marketplace). Optional in sandbox —
  // without one we create on the platform account so the flow is testable now.
  // platformFee (our take) = OUR MARKUP added on top: markup% × amount + fixed
  // pence. Ryft charges the card-network fees itself; we only add our bit.
  // Merchant override → platform default.
  let accountId: string | undefined;
  let platformFee: number | undefined;
  if (location_id) {
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id, charges_enabled, markup_percent, markup_fixed_pence')
      .eq('location_id', location_id).maybeSingle();
    if (mra?.ryft_account_id) {
      if (mra.charges_enabled === false) return json({ error: 'Ryft account cannot accept charges yet' }, 400);
      accountId = mra.ryft_account_id;
      const { data: ps } = await platformAdmin.from('platform_settings')
        .select('default_ryft_markup_percent, default_ryft_markup_fixed_pence').eq('id', true).maybeSingle();
      const pct = mra.markup_percent != null ? Number(mra.markup_percent) : Number(ps?.default_ryft_markup_percent ?? 0);
      const fixed = mra.markup_fixed_pence != null ? Number(mra.markup_fixed_pence) : Number(ps?.default_ryft_markup_fixed_pence ?? 0);
      const fee = Math.round(amount_minor * (pct / 100)) + Math.round(fixed);
      if (fee > 0) platformFee = fee;
    }
  }

  // Book Ryft's fees to the merchant sub-account (explicit, model-agnostic —
  // `combined` is valid on any pricing model). NB: saving the card for a tab
  // hold is done CLIENT-SIDE via Ryft.attemptPayment({ paymentMethodOptions:
  // { store: true } }), not here — that field isn't valid on session create.
  const res = await createPaymentSession({
    amount: amount_minor,
    currency,
    captureFlow: capture_method === 'manual' ? 'Manual' : 'Automatic',
    ...(accountId ? { paymentSettings: { platform: { paymentFees: { combined: { bookTo: accountId } } } } } : {}),
    ...(customer_email ? { customerEmail: customer_email } : {}),
    ...(platformFee != null ? { platformFee } : {}),
    metadata: { channel, ...(closed_check_id ? { closed_check_id } : {}), ...metadata },
  }, accountId ? { accountId } : {});

  if (!res.ok) {
    return json({ error: res.data?.message || res.data?.code || `Ryft error (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
  }

  const ps = res.data || {};
  return json({
    processor: 'ryft',
    sessionId: ps.id ?? null,
    clientSecret: ps.clientSecret ?? null,
    publicKey: ryftPublicKey(),
    accountId: accountId ?? null,
    status: ps.status ?? null,
    raw: ps,                                 // kept while we confirm the sandbox shape
  });
});
