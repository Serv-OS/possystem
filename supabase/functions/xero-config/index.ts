// supabase/functions/xero-config/index.ts
//
// Read/write the Xero posting MAPPING for a venue, and fetch the org's accounts + tax
// rates + payment methods so the back office can populate the mapping dropdowns.
//   POST { action }:
//     options { locationId } -> { accounts:[{code,name,type,bank}], taxRates:[{taxType,name,rate}], paymentMethods:[...] }
//     get     { locationId } -> { mapping, detail }
//     save    { locationId, mapping } -> { ok, mapping }
// Location-fenced like xero-connect. Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true };
}

// The distinct payment-method strings this venue has actually used (so the operator maps
// exactly what they see), newest first, capped.
async function paymentMethods(locationId: string): Promise<string[]> {
  const { data } = await sb.from('closed_checks').select('payment_method,method').eq('location_id', locationId).order('closed_at', { ascending: false }).limit(2000);
  const set = new Set<string>();
  for (const r of (data || [])) { const m = (r.payment_method || r.method || '').trim(); if (m) set.add(m); }
  return [...set].slice(0, 30);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const { action, locationId } = body;
  if (!locationId) return json({ error: 'locationId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  try {
    if (action === 'get') {
      const { data } = await sb.from('xero_config').select('mapping,detail,auto_daily').eq('location_id', locationId).maybeSingle();
      return json({ mapping: data?.mapping || null, detail: data?.detail || null, autoDaily: !!data?.auto_daily });
    }

    if (action === 'save') {
      const patch: Record<string, unknown> = { location_id: locationId, updated_at: new Date().toISOString() };
      if (body.mapping !== undefined) patch.mapping = body.mapping || {};
      if (body.autoDaily !== undefined) patch.auto_daily = !!body.autoDaily;
      await sb.from('xero_config').upsert(patch, { onConflict: 'location_id' });
      return json({ ok: true });
    }

    if (action === 'options') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const [accRes, taxRes, methods] = await Promise.all([
        xeroApi(accessToken, tenantId, '/Accounts'),
        xeroApi(accessToken, tenantId, '/TaxRates').catch(() => ({ TaxRates: [] })),
        paymentMethods(locationId),
      ]);
      const accounts = (accRes?.Accounts || [])
        .filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        .map((a: any) => ({ id: a.AccountID, code: a.Code || '', name: a.Name, type: a.Type, bank: String(a.Type).toUpperCase() === 'BANK' }));
      const taxRates = (taxRes?.TaxRates || [])
        .filter((r: any) => String(r.Status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        .map((r: any) => ({ taxType: r.TaxType, name: r.Name, rate: Number(r.EffectiveRate) }));
      return json({ accounts, taxRates, paymentMethods: methods });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 500);
  }
});
