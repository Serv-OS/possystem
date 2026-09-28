// supabase/functions/xero-config/index.ts
//
// Read/write the Xero posting MAPPING for a venue, and fetch the org's accounts + tax
// rates + payment methods so the back office can populate the mapping dropdowns.
//   POST { action }:
//     options { locationId } -> { accounts:[{code,name,type,bank}], taxRates:[{taxType,name,rate,revenue,expense}],
//                                 salesTaxRates, purchaseTaxRates, servosTaxRates:[{id,name,code,pct,mode,isDefault,active}],
//                                 autoTax:{ [ServOS rate id | 'none']: taxType|null }, addedOnTax,
//                                 unmatchedTaxBuckets:[{key,name,pct}], taxRatesError, servosRatesError, paymentMethods:[...] }
//     get     { locationId } -> { mapping, detail, autoDaily, venue:{ timezone, dayStart, currency, currentDay, lastCompletedDay } }
//     save    { locationId, mapping } -> { ok, mapping }
// 28 Sep 2026: VAT on sales is chosen per ServOS tax rate (mapping.taxRateMap), from Xero's
// SALES rates only (the old list mixed in expense rates such as INPUT2); save refuses an
// expense rate for sales. Save never writes `detail` (xero-sales owns it).
// Location-fenced like xero-connect. Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';
import { venueClock, venueTaxRates } from '../_shared/accountingData.ts';
import { checkTenders, MONEY_KINDS, taxContext } from '../_shared/accountingDay.js';
import { revenueTaxRates, expenseTaxRates, canApplyToRevenue, canApplyToExpenses, pickSalesTaxType, validateTaxMapping } from '../_shared/xeroTax.js';
import { currentBusinessDay, lastCompletedBusinessDay } from '../_shared/businessDay.js';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

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

// The tender methods this venue has actually taken, as xero-sales will post them (v5.9.11:
// read through the same tender rules, so a split bill lists card and cash, an older split
// lists 'unallocated', and loyalty or promo credit, which is never money, is left out).
// Newest checks first, capped. Returns { methods: string[], kinds: { [method]: kind } }.
async function paymentMethods(locationId: string): Promise<{ methods: string[]; kinds: Record<string, string> }> {
  const q = (cols: string) => sb.from('closed_checks').select(cols).eq('location_id', locationId).order('closed_at', { ascending: false }).limit(2000);
  let { data, error } = await q('payment_method,method,total,tip,gift_card,payment_intents,source,loyalty,tenders');
  if (error) ({ data } = await q('payment_method,method,total,tip,gift_card,payment_intents,source,loyalty'));   // tenders migration not run yet
  const kinds: Record<string, string> = {};
  for (const r of (data || [])) {
    for (const t of checkTenders(r).tenders) {
      if (!MONEY_KINDS.has(t.kind) || kinds[t.method]) continue;
      kinds[t.method] = t.kind;
    }
  }
  const methods = Object.keys(kinds).slice(0, 30);
  return { methods, kinds: Object.fromEntries(methods.map((m) => [m, kinds[m]])) };
}

// 28 Sep 2026: percentages a recent push was refused for that no ServOS rate of this venue
// has (a 'pct:' bucket: another venue's rate id, or a deleted rate). The mapping screen shows
// a row for each, so the refusal can be cleared there. Read from the days still not posted;
// best effort, since it only adds rows.
async function refusedPctBuckets(locationId: string): Promise<{ key: string; name: string; pct: number | null }[]> {
  try {
    const { data } = await sb.from('xero_sync_log').select('ref_date,warnings:detail->warnings')
      .eq('location_id', locationId).eq('kind', 'daily_sales').neq('status', 'ok')
      .order('ref_date', { ascending: false }).limit(14);
    const out = new Map<string, { key: string; name: string; pct: number | null }>();
    for (const row of (data || []) as any[]) {
      for (const w of (Array.isArray(row?.warnings) ? row.warnings : [])) {
        if (w?.code !== 'tax_rate_unmapped' || !Array.isArray(w.blocked)) continue;
        for (const b of w.blocked) {
          const key = String(b?.key || '');
          if (!key.startsWith('pct:') || key.length > 80 || out.has(key)) continue;
          const pct = Number.isFinite(Number(b.pct)) && b.pct !== null ? Number(b.pct) : null;
          out.set(key, { key, name: String(b.name || key).slice(0, 80), pct });
        }
      }
    }
    return [...out.values()];
  } catch { return []; }
}

// The venue's business day, for the Back Office date picker (never the browser's clock).
async function venueDay(locationId: string) {
  try {
    const v = await venueClock(platform, locationId);
    const now = Date.now();
    return { ...v, currentDay: currentBusinessDay(now, v.timezone, v.dayStart), lastCompletedDay: lastCompletedBusinessDay(now, v.timezone, v.dayStart) };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const { action, locationId } = body;
  if (!locationId) return json({ error: 'locationId required' }, 400);
  const acc = await requireAccess(req, locationId);
  if (!acc.ok) return acc.res;

  try {
    if (action === 'get') {
      const [{ data }, venue] = await Promise.all([
        sb.from('xero_config').select('mapping,detail,auto_daily').eq('location_id', locationId).maybeSingle(),
        venueDay(locationId),
      ]);
      return json({ mapping: data?.mapping || null, detail: data?.detail || null, autoDaily: !!data?.auto_daily, venue });
    }

    if (action === 'save') {
      const patch: Record<string, unknown> = { location_id: locationId, updated_at: new Date().toISOString() };
      if (body.mapping !== undefined) {
        const bad = validateTaxMapping(body.mapping);
        if (bad) return json({ error: bad }, 400);
        patch.mapping = body.mapping || {};
      }
      if (body.autoDaily !== undefined) patch.auto_daily = !!body.autoDaily;
      await sb.from('xero_config').upsert(patch, { onConflict: 'location_id' });
      return json({ ok: true });
    }

    if (action === 'options') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      // A failed tax rate read is SAID (the flags), never shown as "no rates": the screen would
      // otherwise call a correct choice wrong, or say the venue has no VAT rates.
      let taxRatesError = false, servosRatesError = false;
      const [accRes, taxRes, methods, servos, unmatchedTaxBuckets] = await Promise.all([
        xeroApi(accessToken, tenantId, '/Accounts'),
        xeroApi(accessToken, tenantId, '/TaxRates').catch(() => { taxRatesError = true; return { TaxRates: [] }; }),
        paymentMethods(locationId),
        venueTaxRates(sb, locationId).catch(() => { servosRatesError = true; return []; }),
        refusedPctBuckets(locationId),
      ]);
      const accounts = (accRes?.Accounts || [])
        .filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        .map((a: any) => ({ id: a.AccountID, code: a.Code || '', name: a.Name, type: a.Type, bank: String(a.Type).toUpperCase() === 'BANK' }));
      const list = Array.isArray(taxRes?.TaxRates) ? taxRes.TaxRates : [];
      if (!list.length) taxRatesError = true;
      const taxRates = list
        .filter((r: any) => String(r.Status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        .map((r: any) => ({ taxType: r.TaxType, name: r.Name, rate: Number(r.EffectiveRate), revenue: canApplyToRevenue(r), expense: canApplyToExpenses(r) }));
      // 28 Sep 2026: sales dropdowns list only rates Xero allows on sales, purchases only
      // purchase rates; each ServOS rate shows what Auto would pick for it.
      const salesTaxRates = revenueTaxRates(list);
      const purchaseTaxRates = expenseTaxRates(list);
      const ctx = taxContext(servos);
      const servosTaxRates = ctx.rates.map((r: any) => ({ id: r.id, name: r.name, code: r.code, pct: r.pct, mode: r.mode, isDefault: r.isDefault, active: r.active }));
      const autoTax: Record<string, string | null> = {};
      if (list.length) {
        for (const r of ctx.rates) if (r.mode === 'inclusive') autoTax[r.id] = pickSalesTaxType(salesTaxRates, { pct: r.pct, zeroKind: r.zeroKind });
        autoTax.none = pickSalesTaxType(salesTaxRates, { pct: 0 });
      }
      return json({
        accounts, taxRates, salesTaxRates, purchaseTaxRates, servosTaxRates, autoTax, addedOnTax: ctx.addedOn,
        unmatchedTaxBuckets, taxRatesError, servosRatesError, paymentMethods: methods.methods, paymentMethodKinds: methods.kinds,
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 500);
  }
});
