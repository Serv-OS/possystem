// supabase/functions/ryft-terminal-debug
//
// TEMPORARY PROBE (v5.5.865) for getting the receiptPrintingSource='PointOfSale'
// confirm-receipt flow right — WITHOUT guessing at Ryft's shapes again. Lets us
// drive the sequence BY HAND against a real terminal in the awaiting-receipt state:
//
//   POST { op:'get',      ryft_terminal_id, account_id }  -> raw GET /in-person/terminals/{id}
//   POST { op:'merchant', ryft_terminal_id, account_id }  -> POST confirm-receipt {merchantCopy:{status:'Succeeded'}}
//   POST { op:'customer', ryft_terminal_id, account_id }  -> POST confirm-receipt {customerCopy:{status:'Succeeded'}}
//
// 'get' shows exactly where receiptDetail lives and its merchantCopy/customerCopy
// status values ('Required' etc.) while a tapped payment waits; the confirm ops
// let us advance it one copy at a time and watch it complete. Auth: any valid BO
// user (this only reads/confirms; it never charges). DELETE after the real
// implementation lands in ryft-webhook / terminal-job-charge.

import { getTerminal, confirmTerminalReceipt, createTerminalPayment, cancelTerminalAction, ryftConfigured } from '../_shared/ryft.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  if (token !== SERVICE_ROLE) {
    try { const { data } = await opsAdmin.auth.getUser(token); if (!data?.user) return json({ error: 'unauthorized' }, 401); }
    catch { return json({ error: 'unauthorized' }, 401); }
  }

  let body: { op?: string; ryft_terminal_id?: string; account_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const op = String(body.op ?? 'get');
  const tid = String(body.ryft_terminal_id ?? '');
  if (!tid) return json({ error: 'ryft_terminal_id required' }, 400);
  const opts = body.account_id ? { accountId: body.account_id } : {};

  try {
    if (op === 'initiate') {
      // Fire a £1 (or given amount) PointOfSale payment straight at the terminal —
      // isolated from production terminal_jobs, purely to observe the receiptDetail
      // shape while it awaits confirm. No platformFee (irrelevant to receipts).
      const amt = Number(body.amount_minor ?? 100);
      const r = await createTerminalPayment(tid, {
        amounts: { requested: amt },
        currency: 'GBP',
        settings: { receiptPrintingSource: 'PointOfSale' },
      }, opts);
      return json({ ok: r.ok, status: r.status, data: r.data });
    }
    if (op === 'cancel') {
      const r = await cancelTerminalAction(tid, {}, opts);
      return json({ ok: r.ok, status: r.status, data: r.data });
    }
    if (op === 'get') {
      const r = await getTerminal(tid, opts);
      return json({ ok: r.ok, status: r.status, data: r.data });
    }
    if (op === 'merchant') {
      const r = await confirmTerminalReceipt(tid, { merchantCopy: { status: 'Succeeded' } }, opts);
      return json({ ok: r.ok, status: r.status, data: r.data });
    }
    if (op === 'customer') {
      const r = await confirmTerminalReceipt(tid, { customerCopy: { status: 'Succeeded' } }, opts);
      return json({ ok: r.ok, status: r.status, data: r.data });
    }
    return json({ error: `unknown op: ${op}` }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
