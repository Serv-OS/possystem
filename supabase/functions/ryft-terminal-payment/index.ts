// supabase/functions/ryft-terminal-payment
//
// Card-present (POS) charge on a Ryft Android terminal. Mirrors
// stripe-process-payment-on-reader. Resolves the location's registered Ryft
// terminal + sub-account, starts the on-terminal payment, and returns the
// underlying paymentSessionId — the POS then polls ryft-terminal-poll until the
// customer taps and the session reaches Approved/Captured.
//
// NOT yet verified against hardware (no reader available) — built to the Ryft
// in-person spec. Auth: service-role or signed-in user. Amounts MINOR units.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTerminalPayment, ryftConfigured } from '../_shared/ryft.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await opsAdmin.auth.getUser(token); return !!user; } catch { return false; }
}

interface Body {
  location_id?: string;          // Ops location id
  pos_device_id?: string;        // optional — prefer a terminal bound to this POS
  terminal_id?: string;          // optional explicit Ryft terminal id (testing)
  amount_minor?: number;
  currency?: string;
  capture_method?: 'automatic' | 'manual';
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
  const { location_id, pos_device_id, amount_minor, capture_method = 'automatic', closed_check_id, metadata = {} } = body;
  const currency = String(body.currency || 'gbp').toUpperCase();
  if (!amount_minor || amount_minor <= 0) return json({ error: 'amount_minor must be > 0' }, 400);

  // Resolve the Ryft terminal + sub-account for this location.
  let terminalId = body.terminal_id;
  let accountId: string | undefined;
  let platformFee: number | undefined;
  if (!terminalId) {
    if (!location_id) return json({ error: 'location_id or terminal_id required' }, 400);
    // Ops location → Platform location (ops_location_id) → Ryft terminal.
    const { data: ploc } = await platformAdmin.from('locations').select('id').eq('ops_location_id', location_id).maybeSingle();
    const platformLocId = ploc?.id ?? location_id;
    let q = platformAdmin.from('payment_devices')
      .select('ryft_terminal_id, bound_pos_device_id')
      .eq('location_id', platformLocId).eq('processor', 'ryft').not('ryft_terminal_id', 'is', null);
    const { data: devices } = await q;
    const match = (devices ?? []).find((d: any) => pos_device_id && d.bound_pos_device_id === pos_device_id) ?? (devices ?? [])[0];
    if (!match?.ryft_terminal_id) return json({ error: 'no Ryft terminal registered for this location' }, 400);
    terminalId = match.ryft_terminal_id;
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
      .select('ryft_account_id, markup_percent, markup_fixed_pence').eq('location_id', platformLocId).maybeSingle();
    accountId = mra?.ryft_account_id ?? undefined;
    // platformFee (our take) = our MARKUP: markup% × amount + fixed pence. Ryft
    // charges the card-network fees itself. Merchant override → platform default.
    if (accountId) {
      const { data: ps } = await platformAdmin.from('platform_settings')
        .select('default_ryft_markup_percent, default_ryft_markup_fixed_pence').eq('id', true).maybeSingle();
      const pct = mra?.markup_percent != null ? Number(mra.markup_percent) : Number(ps?.default_ryft_markup_percent ?? 0);
      const fixed = mra?.markup_fixed_pence != null ? Number(mra.markup_fixed_pence) : Number(ps?.default_ryft_markup_fixed_pence ?? 0);
      const fee = Math.round(amount_minor * (pct / 100)) + Math.round(fixed);
      if (fee > 0) platformFee = fee;
    }
  }

  const res = await createTerminalPayment(terminalId!, {
    amounts: { requested: amount_minor },
    currency,
    captureFlow: capture_method === 'manual' ? 'Manual' : 'Automatic',
    settings: { receiptPrintingSource: 'PointOfSale' },
    ...(platformFee != null ? { paymentSession: { platformFee } } : {}),
    metadata: { ...(closed_check_id ? { closed_check_id } : {}), ...metadata },
  }, accountId ? { accountId } : {});

  if (!res.ok) {
    return json({ error: res.data?.message || res.data?.code || `Ryft terminal error (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
  }

  const action = res.data?.action ?? {};
  return json({
    processor: 'ryft',
    terminalId,
    accountId: accountId ?? null,
    paymentSessionId: action?.transaction?.paymentSessionId ?? null,
    actionStatus: action?.status ?? null,    // e.g. "InProgress"
    raw: res.data,
  });
});
