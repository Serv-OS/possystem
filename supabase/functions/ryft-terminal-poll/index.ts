// supabase/functions/ryft-terminal-poll
//
// Poll the underlying Ryft payment session created by a terminal charge. The
// POS calls this ~1s until state is 'succeeded' or 'failed'. Mirrors
// stripe-poll-reader-action. Auth: service-role or signed-in user.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getPaymentSession, ryftConfigured } from '../_shared/ryft.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await opsAdmin.auth.getUser(token); return !!user; } catch { return false; }
}

// Ryft session status → normalised POS state.
function stateOf(status: string): 'processing' | 'succeeded' | 'failed' {
  if (status === 'Approved' || status === 'Captured') return 'succeeded';
  if (status === 'Declined' || status === 'Voided' || status === 'Failed') return 'failed';
  return 'processing'; // PendingPayment, InProgress, etc.
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await authorize(req))) return json({ error: 'unauthorized' }, 401);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);

  let body: { payment_session_id?: string; account_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!body.payment_session_id) return json({ error: 'payment_session_id required' }, 400);

  const res = await getPaymentSession(body.payment_session_id, body.account_id ? { accountId: body.account_id } : {});
  if (!res.ok) return json({ error: res.data?.message || `Ryft error (${res.status})`, ryft: res.data }, 502);

  const status = res.data?.status ?? 'PendingPayment';

  // Card receipt block (UK card-scheme receipt requirements) — best-effort extraction from the
  // Ryft PaymentSession. Field paths differ across Ryft API versions, so probe the known spots;
  // every field is nullable and a missing one never blocks the poll.
  let card: Record<string, unknown> | null = null;
  try {
    const d = res.data ?? {};
    const pm = d.paymentMethod ?? {};
    const c = pm.card ?? d.card ?? {};
    const tx = d.lastPaymentTransaction ?? d.transaction ?? {};
    const brand = c.scheme ?? c.brand ?? pm.scheme ?? null;
    const last4 = c.last4 ?? c.lastFour ?? null;
    const authCode = tx.approvalCode ?? tx.authorizationCode ?? d.approvalCode ?? d.authorizationCode ?? null;
    if (brand || last4 || authCode) {
      card = { brand, last4, auth_code: authCode, read_method: d.entryMode ?? tx.entryMode ?? null, aid: null, application_name: null, cvm: null, account_type: null };
    }
  } catch { /* receipt block is best-effort */ }

  return json({
    state: stateOf(status),
    status,
    amount: res.data?.amount ?? null,
    currency: res.data?.currency ?? null,
    sessionId: res.data?.id ?? body.payment_session_id,
    card,
  });
});
