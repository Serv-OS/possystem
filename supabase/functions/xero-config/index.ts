// supabase/functions/xero-config/index.ts
//
// Read/write the Xero posting MAPPING for a venue, and fetch the org's accounts + tax
// rates + payment methods so the back office can populate the mapping dropdowns.
//   POST { action }:
//     options { locationId } -> { accounts:[{id,code,name,type,cls,pay,status,bank}], trackingCategories, taxRates:[{taxType,name,rate,revenue,expense}],
//                                 salesTaxRates, purchaseTaxRates, servosTaxRates:[{id,name,code,pct,mode,isDefault,active}],
//                                 autoTax:{ [ServOS rate id | 'none']: taxType|null }, addedOnTax,
//                                 unmatchedTaxBuckets:[{key,name,pct}], taxRatesError, servosRatesError, paymentMethods:[...] }
//     get     { locationId } -> { mapping, detail, autoDaily, venue:{ timezone, dayStart, currency, currentDay, lastCompletedDay } }
//     save    { locationId, mapping } -> { ok, paused? } (paused: a sales invoice site whose
//             "figures checked" tick lapsed with this save, so nightly posting now waits)
// 28 Sep 2026: VAT on sales is chosen per ServOS tax rate (mapping.taxRateMap), from Xero's
// SALES rates only (the old list mixed in expense rates such as INPUT2); save refuses an
// expense rate for sales. Save never writes `detail` (xero-sales owns it).
//
// 30 Sep 2026, the daily sales invoice (_shared/xeroInvoicePlan.js):
//     site_data   { locationId } -> the site's name, suggested code, sibling sites on this Xero,
//                 its menu categories with 14 days of sales, discount labels, and what the setup
//                 must cover (sales and discount groups, money kinds, tips, service, gift cards)
//     readiness   { locationId, startDate? } -> the Ready checklist with Xero's accounts, tracking
//                 categories, organisation and tax rates
//     set_mode    { locationId, mode: 'sales_invoice' | 'bank_tx', startDate } (sales_invoice
//                 only when Ready; the start day is kept on the server)
//     figures_checked { locationId, date } -> ticks "I have checked a day's figures" for the
//                 choices as they are now (it lapses when they change)
//     history     { locationId, scope: 'site' | 'org', days } -> one row per site per day
//     history_detail { locationId, date, forLocationId? } -> exactly what was sent that day
//     lightspeed_suggest { locationId, contactName?, optionId?, optionName? } -> "Copy my
//                 Lightspeed setup" (read only); the tracking option picks this site's invoices
//     site_create { locationId, kind: 'accounts' | 'tracking', keys?, categoryName?, optionName? }
//                 creates the recommended accounts or tracking option in Xero (the only Xero
//                 write here; the screen asks first) and returns the choices to fill in
//     copy_site   { locationId, fromLocationId } -> another site's choices on this Xero, to fill in
// Save keeps the server owned invoiceStartDate and figuresChecked, validates the invoice choices,
// and refuses auto posting for a sales invoice site that is not Ready.
// Location-fenced like xero-connect. Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getValidAccessToken, xeroApi } from '../_shared/xero.ts';
import { venueClock, venueTaxRates, venueSite, venueCategories, salesRows } from '../_shared/accountingData.ts';
import { checkTenders, MONEY_KINDS, taxContext } from '../_shared/accountingDay.js';
import { revenueTaxRates, expenseTaxRates, canApplyToRevenue, canApplyToExpenses, pickSalesTaxType, validateTaxMapping } from '../_shared/xeroTax.js';
import { currentBusinessDay, lastCompletedBusinessDay, isYmd, addDays } from '../_shared/businessDay.js';
import { buildGroupedDay, makeGroupResolver, OTHER_GROUP, DISCOUNT_GROUPS } from '../_shared/accountingGroups.js';
import {
  planXeroInvoiceDay, invoiceReadiness, validateInvoiceMapping, mappingHash, seenFromGrouped, siteNameFrom, siteCodeFromSlug,
  xeroDocLink, dayModel,
} from '../_shared/xeroInvoicePlan.js';
import { suggestFromLightspeed, xeroDate } from '../_shared/lightspeedSuggest.js';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platform = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

type Caller = { userId: string | null; superAdmin: boolean; service: boolean };

async function requireAccess(req: Request, opsLocationId: string): Promise<{ ok: true; caller: Caller } | { ok: false; res: Response }> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, res: json({ error: 'Unauthorized' }, 401) };
  if (token === SERVICE_ROLE) return { ok: true, caller: { userId: null, superAdmin: true, service: true } };
  const { data: { user: caller } } = await sb.auth.getUser(token);
  if (!caller) return { ok: false, res: json({ error: 'Invalid token' }, 401) };
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  const superAdmin = prof?.role === 'super_admin';
  if (!ul && !superAdmin) return { ok: false, res: json({ error: 'No access to this location' }, 403) };
  return { ok: true, caller: { userId: caller.id, superAdmin, service: false } };
}

// The subset of `ids` the caller may open (their own venues, or every one for super admin).
async function accessible(caller: Caller, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  if (caller.service || caller.superAdmin) return ids;
  const { data } = await sb.from('user_locations').select('location_id').eq('user_id', caller.userId).in('location_id', ids);
  const ok = new Set((data || []).map((r: any) => r.location_id));
  return ids.filter((id) => ok.has(id));
}

// ── the daily sales invoice: sites sharing one Xero organisation ───────────────

async function connectionOf(locationId: string) {
  const { data } = await sb.from('xero_connections').select('location_id,tenant_id,tenant_name').eq('location_id', locationId).maybeSingle();
  return data || null;
}

/** Other venues connected to the same Xero organisation: { locationId, name, code, clearing, postMode, slug }. */
async function siblingsOf(locationId: string, tenantId: string | null) {
  if (!tenantId) return [];
  const { data } = await sb.from('xero_connections').select('location_id').eq('tenant_id', tenantId).neq('location_id', locationId);
  const ids = (data || []).map((r: any) => r.location_id);
  if (!ids.length) return [];
  const [{ data: cfgs }, { data: locs }] = await Promise.all([
    sb.from('xero_config').select('location_id,mapping,post_mode').in('location_id', ids),
    platform.from('locations').select('ops_location_id,name,online_slug').in('ops_location_id', ids),
  ]);
  return ids.map((id: string) => {
    const c: any = (cfgs || []).find((x: any) => x.location_id === id);
    const l: any = (locs || []).find((x: any) => x.ops_location_id === id);
    return {
      locationId: id, name: String(c?.mapping?.site?.name || '').trim() || siteNameFrom(l?.name || '') || 'Another site',
      code: c?.mapping?.site?.code || null, clearing: c?.mapping?.clearing || {}, postMode: c?.post_mode || null, slug: l?.online_slug || null,
    };
  });
}

/** This site's name and suggested code. */
async function siteIdentity(locationId: string, mapping: any, siblings: any[]) {
  let site: any = { name: '', onlineSlug: null, companyId: null, found: false };
  try { site = await venueSite(platform, locationId); } catch { /* shown as unknown */ }
  let slugs: string[] = [];
  if (site.companyId) {
    const { data } = await platform.from('locations').select('online_slug').eq('company_id', site.companyId);
    slugs = (data || []).map((r: any) => r.online_slug).filter((x: any) => x && x !== site.onlineSlug);
  }
  const suggestedCode = siteCodeFromSlug(site.onlineSlug || site.name || '', slugs, siblings.map((x: any) => x.code).filter(Boolean));
  return {
    name: String(mapping?.site?.name || '').trim() || siteNameFrom(site.name),
    code: mapping?.site?.code || null,
    platformName: site.name || null, slug: site.onlineSlug || null, suggestedCode, platformId: site.platformId || null,
  };
}

/** The last 14 days of sales, grouped as the invoice will post them, for the setup screen. */
async function recentDays(locationId: string, mapping: any) {
  const venue = await venueClock(platform, locationId);
  const toMs = Date.now();
  const fromMs = toMs - 14 * 86400000;
  const day = { ymd: 'last-14-days', fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
  const [rows, taxRates] = await Promise.all([salesRows(sb, locationId, day.fromIso, day.toIso, true), venueTaxRates(sb, locationId)]);
  const categories = await venueCategories(sb, locationId, rows);
  const resolver = makeGroupResolver(mapping, categories);
  const grouped = buildGroupedDay({ day, saleRows: rows, refundRows: [], venue, taxRates, resolver });
  return { venue, grouped, categories, resolver, taxRates };
}

const accountView = (a: any) => ({
  id: a.AccountID, code: a.Code || '', name: a.Name, type: a.Type, cls: a.Class || null,
  pay: a.EnablePaymentsToAccount === true || String(a.EnablePaymentsToAccount) === 'true', status: a.Status || 'ACTIVE',
  bank: String(a.Type).toUpperCase() === 'BANK',
});
const trackingView = (c: any) => ({
  id: c.TrackingCategoryID, name: c.Name, status: c.Status || 'ACTIVE',
  options: (c.Options || []).map((o: any) => ({ id: o.TrackingOptionID, name: o.Name, status: o.Status || 'ACTIVE' })),
});

// The history row's status in plain words.
function historyStatus(row: any): string {
  const s = String(row.status || '');
  if (s === 'ok') return 'posted';
  if (s === 'partial') return 'partly_posted';
  if (s === 'running') {
    const live = row.lock?.until && Date.parse(row.lock.until) > Date.now();
    return live ? 'sending' : 'failed';
  }
  if (s === 'error') return row.notReady || row.problems ? 'blocked' : 'failed';
  return s || 'failed';
}

function historyDocs(row: any, shortCode: string | null) {
  if (Array.isArray(row.documents) && row.documents.length) {
    return row.documents.map((d: any) => ({ type: d.type, number: d.number, reference: d.reference, total: d.total, xeroId: d.xeroId, link: d.link || (d.type === 'invoice' || d.type === 'credit_note' ? xeroDocLink(d.type, d.xeroId, shortCode) : null) }));
  }
  if (Array.isArray(row.lines) && row.lines.length) {
    return row.lines.filter((l: any) => l.bankTransactionID).map((l: any) => ({ type: 'bank', number: l.reference, reference: l.reference, total: l.total, xeroId: l.bankTransactionID, direction: l.direction, link: l.link || xeroDocLink('bank', l.bankTransactionID, shortCode) }));
  }
  const postings = row.postings && typeof row.postings === 'object' ? row.postings : {};
  return Object.entries(postings).filter(([, p]: [string, any]) => p?.status === 'posted' && p.id).map(([k, p]: [string, any]) => {
    const type = p.type || (k.startsWith('RECEIVE') || k.startsWith('SPEND') ? 'bank' : k === 'INVOICE' ? 'invoice' : k === 'CREDIT' ? 'credit_note' : 'payment');
    return { type, number: p.number || p.reference, reference: p.reference, total: p.total, xeroId: p.id, direction: k.startsWith('SPEND') ? 'refunds' : 'takings', link: type === 'invoice' || type === 'credit_note' || type === 'bank' ? xeroDocLink(type, p.id, shortCode) : null };
  });
}

const RECOMMENDED: Record<string, (site: { name: string; code: string }) => any> = {
  cardClearing: (x) => ({ Name: `Card clearing ${x.name}`.slice(0, 150), Code: `CC${x.code}`.slice(0, 10), Type: 'CURRENT', EnablePaymentsToAccount: true, Description: 'Card takings waiting for the processor payout (ServOS).' }),
  cashInTill: (x) => ({ Name: `Cash in till ${x.name}`.slice(0, 150), Code: `CT${x.code}`.slice(0, 10), Type: 'BANK', BankAccountNumber: `SOS-CASH-${x.code}`.slice(0, 30) }),
  giftLiability: () => ({ Name: 'Gift card liability', Code: 'SOSGIFT', Type: 'CURRLIAB', EnablePaymentsToAccount: true, Description: 'Gift cards sold and not yet spent (ServOS).' }),
  tipsPayable: () => ({ Name: 'ServOS Tips Payable', Code: 'SOSTIPS', Type: 'CURRLIAB', Description: 'Tips owed to staff (ServOS).' }),
  servicePayable: () => ({ Name: 'ServOS Service Charge Payable', Code: 'SOSSVCCHG', Type: 'CURRLIAB', Description: 'Service charge owed to staff (ServOS).' }),
  discounts: () => ({ Name: 'Sales discounts', Code: 'SOSDISC', Type: 'REVENUE', Description: 'Discounts, rewards and comps given at the till (ServOS).' }),
};

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
  const caller = acc.caller;

  try {
    if (action === 'get') {
      const [{ data }, venue, conn, servos] = await Promise.all([
        sb.from('xero_config').select('mapping,detail,auto_daily,post_mode').eq('location_id', locationId).maybeSingle(),
        venueDay(locationId),
        connectionOf(locationId),
        venueTaxRates(sb, locationId).catch(() => null),
      ]);
      const siblings = conn ? await siblingsOf(locationId, conn.tenant_id).catch(() => []) : [];
      // Tax added on top of prices (US): the screens say "tax", not "VAT".
      const addedOnTax = Array.isArray(servos) ? taxContext(servos).addedOn : false;
      return json({
        mapping: data?.mapping || null, detail: data?.detail || null, autoDaily: !!data?.auto_daily, venue, addedOnTax,
        postMode: data?.post_mode === 'sales_invoice' ? 'sales_invoice' : 'bank_tx',
        tenantName: conn?.tenant_name || null, siblings: siblings.map((x: any) => ({ locationId: x.locationId, name: x.name, code: x.code, postMode: x.postMode === 'sales_invoice' ? 'sales_invoice' : 'bank_tx' })),
      });
    }

    if (action === 'save') {
      const patch: Record<string, unknown> = { location_id: locationId, updated_at: new Date().toISOString() };
      const { data: cur } = await sb.from('xero_config').select('mapping,post_mode').eq('location_id', locationId).maybeSingle();
      let mapping = cur?.mapping || {};
      if (body.mapping !== undefined) {
        const bad = validateTaxMapping(body.mapping) || validateInvoiceMapping(body.mapping);
        if (bad) return json({ error: bad }, 400);
        const next: Record<string, unknown> = { ...(body.mapping || {}) };
        // Server owned (30 Sep 2026): a stale screen can never drop or forge the start day or the
        // "figures checked" tick.
        for (const k of ['invoiceStartDate', 'figuresChecked']) {
          if (cur?.mapping?.[k] !== undefined) next[k] = cur.mapping[k]; else delete next[k];
        }
        patch.mapping = next;
        mapping = next;
      }
      if (body.autoDaily !== undefined) {
        if (body.autoDaily && cur?.post_mode === 'sales_invoice') {
          const r = invoiceReadiness(mapping, {});
          if (!r.ready) return json({ error: `Auto posting stays off until this site is Ready: ${r.items.filter((i) => !i.ok).map((i) => i.detail || i.label).join(' ')}`, readiness: r }, 400);
        }
        patch.auto_daily = !!body.autoDaily;
      }
      const { error } = await sb.from('xero_config').upsert(patch, { onConflict: 'location_id' });
      if (error) return json({ error: `Could not save: ${error.message}` }, 500);
      // A site live on the sales invoice posts only while its figures tick matches its choices.
      // A save that changes them lapses the tick, so nightly posting now waits: say so plainly.
      const live = cur?.post_mode === 'sales_invoice';
      const wasChecked = !!cur?.mapping?.figuresChecked?.hash && cur.mapping.figuresChecked.hash === mappingHash(cur.mapping);
      const paused = live && wasChecked && mappingHash(mapping) !== cur.mapping.figuresChecked.hash;
      return json({ ok: true, ...(paused ? { paused: true, message: "Saved. Nightly posting to Xero is paused until you check a day's figures again, because the choices changed." } : {}) });
    }

    if (action === 'site_data') {
      const [{ data: cfg }, conn] = await Promise.all([
        sb.from('xero_config').select('mapping,post_mode').eq('location_id', locationId).maybeSingle(),
        connectionOf(locationId),
      ]);
      const mapping = cfg?.mapping || {};
      const siblings = conn ? await siblingsOf(locationId, conn.tenant_id) : [];
      const [site, recent] = await Promise.all([siteIdentity(locationId, mapping, siblings), recentDays(locationId, mapping)]);
      const { grouped, categories, resolver } = recent;
      const sold = grouped.groups.categories || {};
      const local = categories.filter((c: any) => c.local !== false);
      const cats = local.map((c: any) => {
        const g = resolver.itemGroup({ cat: c.id });
        return { id: c.id, label: c.label, parentId: c.parent_id || null, accountingGroup: c.accounting_group || '', masterId: c.master_id || null, goods: (sold[c.id]?.goods || 0) / 100, group: g.key, resolved: g.resolved };
      }).sort((a: any, b: any) => b.goods - a.goods || String(a.label).localeCompare(String(b.label)));
      let onlineGift = false;
      if (site.platformId) {
        const { count } = await platform.from('gift_card_purchases').select('id', { count: 'exact', head: true })
          .in('location_id', [site.platformId, locationId]).gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString());
        onlineGift = (count || 0) > 0;
      }
      const seen = { ...seenFromGrouped(grouped), onlineGift };
      return json({
        site, siblings, postMode: cfg?.post_mode === 'sales_invoice' ? 'sales_invoice' : 'bank_tx', tenantName: conn?.tenant_name || null,
        categories: cats, discountLabels: grouped.groups.discountLabels, groupNames: grouped.groups.names, seen,
        otherGroup: OTHER_GROUP, discountGroups: DISCOUNT_GROUPS, mappingHash: mappingHash(mapping),
        totals: { goods: grouped.groups.goodsTotal / 100, unresolved: grouped.groups.unresolved.goods / 100 },
      });
    }

    if (action === 'readiness') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const [{ data: cfg }, conn] = await Promise.all([
        sb.from('xero_config').select('mapping,detail,post_mode').eq('location_id', locationId).maybeSingle(),
        connectionOf(locationId),
      ]);
      const mapping = cfg?.mapping || {};
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const [accRes, trRes, orgRes, taxRes, siblings, recent] = await Promise.all([
        xeroApi(accessToken, tenantId, '/Accounts'),
        xeroApi(accessToken, tenantId, '/TrackingCategories'),
        xeroApi(accessToken, tenantId, '/Organisation'),
        xeroApi(accessToken, tenantId, '/TaxRates'),
        siblingsOf(locationId, conn?.tenant_id || tenantId),
        recentDays(locationId, mapping),
      ]);
      const accounts = (accRes?.Accounts || []).filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE').map(accountView);
      const tracking = (trRes?.TrackingCategories || []).map(trackingView);
      const org = orgRes?.Organisations?.[0] || {};
      const salesTaxRates = revenueTaxRates(taxRes?.TaxRates || []);
      // The ServOS rates the last 14 days used, resolved against Xero's sales rates as a post would.
      const plan = planXeroInvoiceDay(recent.grouped, { mapping, detail: { ...(cfg?.detail || {}), salesTaxRates }, site: { name: mapping.site?.name || 'Site', code: mapping.site?.code || 'SITE' }, date: recent.venue ? lastCompletedBusinessDay(Date.now(), recent.venue.timezone, recent.venue.dayStart) : undefined });
      const startDate = isYmd(body.startDate) ? body.startDate : undefined;
      const readiness = invoiceReadiness(mapping, {
        accounts, tracking, orgCurrency: org.BaseCurrency || null, venueCurrency: recent.venue?.currency || null,
        siblings, seen: seenFromGrouped(recent.grouped), taxBlocked: plan.blockedRates,
        lightspeedLastDate: mapping.lightspeed?.lastDate || null, startDate, addedOn: taxContext(recent.taxRates).addedOn,
      });
      return json({ ...readiness, org: { name: org.Name || null, currency: org.BaseCurrency || null, shortCode: org.ShortCode || null }, postMode: cfg?.post_mode === 'sales_invoice' ? 'sales_invoice' : 'bank_tx', startDate: mapping.invoiceStartDate || null, mappingHash: mappingHash(mapping) });
    }

    if (action === 'figures_checked') {
      if (!isYmd(body.date)) return json({ error: 'Choose the day whose figures you checked.' }, 400);
      const { data: cfg } = await sb.from('xero_config').select('mapping').eq('location_id', locationId).maybeSingle();
      const mapping = { ...(cfg?.mapping || {}) };
      if (body.hash && body.hash !== mappingHash(mapping)) return json({ error: 'The choices changed after these figures were worked out. Check the figures again.' }, 409);
      mapping.figuresChecked = { date: body.date, at: new Date().toISOString(), by: caller.userId, hash: mappingHash(mapping) };
      const { error } = await sb.from('xero_config').upsert({ location_id: locationId, mapping, updated_at: new Date().toISOString() }, { onConflict: 'location_id' });
      if (error) return json({ error: `Could not save: ${error.message}` }, 500);
      return json({ ok: true, figuresChecked: mapping.figuresChecked });
    }

    if (action === 'set_mode') {
      const { data: cfg } = await sb.from('xero_config').select('mapping,post_mode,auto_daily').eq('location_id', locationId).maybeSingle();
      const mapping = { ...(cfg?.mapping || {}) };
      if (body.mode === 'bank_tx') {
        // Back to the bank transactions. Days already sent as invoices finish as invoices.
        const { error } = await sb.from('xero_config').update({ post_mode: 'invoice', updated_at: new Date().toISOString() }).eq('location_id', locationId);
        if (error) return json({ error: `Could not save: ${error.message}` }, 500);
        return json({ ok: true, postMode: 'bank_tx' });
      }
      if (body.mode !== 'sales_invoice') return json({ error: 'Unknown posting model.' }, 400);
      if (!isYmd(body.startDate)) return json({ error: 'Choose the first business day to post as a sales invoice.' }, 400);
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const conn = await connectionOf(locationId);
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const [accRes, trRes, orgRes, taxRes, siblings, recent] = await Promise.all([
        xeroApi(accessToken, tenantId, '/Accounts'),
        xeroApi(accessToken, tenantId, '/TrackingCategories'),
        xeroApi(accessToken, tenantId, '/Organisation'),
        xeroApi(accessToken, tenantId, '/TaxRates'),
        siblingsOf(locationId, conn?.tenant_id || tenantId),
        recentDays(locationId, mapping),
      ]);
      const plan = planXeroInvoiceDay(recent.grouped, { mapping, detail: { salesTaxRates: revenueTaxRates(taxRes?.TaxRates || []) }, site: { name: 'Site', code: 'SITE' } });
      const readiness = invoiceReadiness(mapping, {
        accounts: (accRes?.Accounts || []).filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE').map(accountView),
        tracking: (trRes?.TrackingCategories || []).map(trackingView),
        orgCurrency: orgRes?.Organisations?.[0]?.BaseCurrency || null, venueCurrency: recent.venue?.currency || null,
        siblings, seen: seenFromGrouped(recent.grouped), taxBlocked: plan.blockedRates, lightspeedLastDate: mapping.lightspeed?.lastDate || null, startDate: body.startDate,
        addedOn: taxContext(recent.taxRates).addedOn,
      });
      if (!readiness.ready) return json({ error: `This site is not Ready yet: ${readiness.items.filter((i) => !i.ok).map((i) => i.detail || i.label).join(' ')}`, readiness }, 400);
      // A start day on or before a day already in Xero keeps that day as it is (dayModel), so say so.
      const { data: posted } = await sb.from('xero_sync_log').select('ref_date,status').eq('location_id', locationId).eq('kind', 'daily_sales').gte('ref_date', body.startDate).in('status', ['ok', 'partial']).limit(31);
      mapping.invoiceStartDate = body.startDate;
      const { error } = await sb.from('xero_config').update({ post_mode: 'sales_invoice', mapping, updated_at: new Date().toISOString() }).eq('location_id', locationId);
      if (error) return json({ error: `Could not save: ${error.message}` }, 500);
      const kept = (posted || []).map((r: any) => r.ref_date).sort();
      return json({ ok: true, postMode: 'sales_invoice', startDate: body.startDate, readiness, keptOldDays: kept });
    }

    if (action === 'history') {
      const days = Math.max(7, Math.min(120, Number(body.days) || 60));
      const conn = await connectionOf(locationId);
      let ids = [locationId];
      const names: Record<string, string> = {};
      if (body.scope === 'org' && conn?.tenant_id) {
        const sibs = await siblingsOf(locationId, conn.tenant_id);
        const allowed = await accessible(caller, sibs.map((x: any) => x.locationId));
        ids = [locationId, ...allowed];
        for (const x of sibs) names[x.locationId] = x.name;
      }
      const { data: own } = await sb.from('xero_config').select('location_id,mapping,detail->site,post_mode').in('location_id', ids);
      const shortCodes: Record<string, string | null> = {};
      for (const c of (own || []) as any[]) {
        shortCodes[c.location_id] = c.site?.shortCode || null;
        if (c.mapping?.site?.name) names[c.location_id] = c.mapping.site.name;
      }
      if (!names[locationId]) { try { names[locationId] = siteNameFrom((await venueSite(platform, locationId)).name); } catch { names[locationId] = ''; } }
      const clocks: Record<string, any> = {};
      await Promise.all(ids.map(async (id) => { clocks[id] = await venueDay(id); }));
      const lastDay = clocks[locationId]?.lastCompletedDay || new Date().toISOString().slice(0, 10);
      const since = addDays(lastDay, -days);
      const cols = 'location_id,ref_date,status,xero_id,updated_at,model:detail->model,documents:detail->documents,summary:detail->summary,warnings:detail->warnings,error:detail->error,notReady:detail->notReady,problems:detail->problems,lines:detail->lines,lock:detail->lock';
      const [{ data: rows, error }, { data: open }] = await Promise.all([
        sb.from('xero_sync_log').select(cols).in('location_id', ids).eq('kind', 'daily_sales').gte('ref_date', since).order('ref_date', { ascending: false }).limit(1000),
        sb.from('xero_sync_log').select('location_id,ref_date,postings:detail->postings').in('location_id', ids).eq('kind', 'daily_sales').gte('ref_date', since).neq('status', 'ok').limit(400),
      ]);
      if (error) return json({ error: `Could not read the postings: ${error.message}` }, 500);
      const postingsOf = new Map((open || []).map((r: any) => [`${r.location_id}|${r.ref_date}`, r.postings]));
      const out: any[] = [];
      const seenDays = new Map<string, Set<string>>();
      for (const r of (rows || []) as any[]) {
        const k = `${r.location_id}|${r.ref_date}`;
        const row = { ...r, postings: postingsOf.get(k) || null };
        const docs = historyDocs(row, shortCodes[r.location_id] || null);
        const model = r.model || (docs.some((d: any) => d.type === 'invoice' || d.type === 'credit_note') ? 'sales_invoice' : 'bank_tx');
        const sm = r.summary || {};
        out.push({
          date: r.ref_date, locationId: r.location_id, site: names[r.location_id] || '', model, status: historyStatus(row),
          documents: docs, totals: { sales: sm.sales?.total ?? null, refunds: sm.refunds?.total ?? null, vat: sm.sales?.tax != null ? Math.round(((sm.sales?.tax || 0) - (sm.refunds?.tax || 0)) * 100) / 100 : null },
          warnings: Array.isArray(r.warnings) ? r.warnings.length : 0, error: r.error || null, notReady: r.notReady || null, updatedAt: r.updated_at,
        });
        const set = seenDays.get(r.location_id) || new Set<string>();
        set.add(r.ref_date); seenDays.set(r.location_id, set);
      }
      // Business days with no row yet (a day with no sales never gets one): Waiting.
      for (const id of ids) {
        const set = seenDays.get(id);
        const cfgRow: any = (own || []).find((c: any) => c.location_id === id);
        const first = [...(set || [])].sort()[0] || cfgRow?.mapping?.invoiceStartDate || null;
        const last = clocks[id]?.lastCompletedDay;
        if (!first || !last) continue;
        for (let d = first < since ? since : first; d <= last; d = addDays(d, 1)) {
          if (set?.has(d)) continue;
          const model = dayModel(null, cfgRow?.post_mode, cfgRow?.mapping?.invoiceStartDate, d);
          out.push({ date: d, locationId: id, site: names[id] || '', model, status: 'waiting', documents: [], totals: { sales: null, refunds: null, vat: null }, warnings: 0, error: null, notReady: null, updatedAt: null });
        }
      }
      out.sort((a, b) => b.date.localeCompare(a.date) || String(a.site).localeCompare(String(b.site)));
      return json({ rows: out, days, scope: body.scope === 'org' ? 'org' : 'site', sites: ids.map((id) => ({ locationId: id, name: names[id] || '' })) });
    }

    if (action === 'history_detail') {
      if (!isYmd(body.date)) return json({ error: 'date required' }, 400);
      let target = locationId;
      if (body.forLocationId && body.forLocationId !== locationId) {
        const conn = await connectionOf(locationId);
        const other = await connectionOf(body.forLocationId);
        const allowed = await accessible(caller, [body.forLocationId]);
        if (!conn || !other || conn.tenant_id !== other.tenant_id || !allowed.length) return json({ error: 'No access to that site' }, 403);
        target = body.forLocationId;
      }
      const { data: row, error } = await sb.from('xero_sync_log').select('ref_date,status,xero_id,updated_at,detail').eq('location_id', target).eq('kind', 'daily_sales').eq('ref_date', body.date).maybeSingle();
      if (error) return json({ error: `Could not read the posting: ${error.message}` }, 500);
      if (!row) return json({ date: body.date, status: 'waiting', postings: {}, documents: [] });
      const d = row.detail || {};
      const postings = Object.fromEntries(Object.entries(d.postings || {}).map(([k, p]: [string, any]) => [k, { status: p?.status, type: p?.type || null, id: p?.id || null, number: p?.number || null, reference: p?.reference || null, total: p?.total ?? null, xeroStatus: p?.xeroStatus || null, at: p?.at || null, payload: p?.payload || null }]));
      return json({
        date: row.ref_date, status: historyStatus({ ...row, notReady: d.notReady, problems: d.problems, lock: d.lock }), model: d.model || (Object.keys(d.postings || {}).some((k) => /^(RECEIVE|SPEND):/.test(k)) ? 'bank_tx' : d.model || 'bank_tx'),
        postings, documents: d.documents || [], lines: d.lines || [], warnings: d.warnings || [], summary: d.summary || null, error: d.error || null,
        notReady: d.notReady || null, problems: d.problems || null, site: d.site || null, attempts: (d.history || []).slice(-10),
      });
    }

    if (action === 'lightspeed_suggest') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const { data: cfg } = await sb.from('xero_config').select('mapping').eq('location_id', locationId).maybeSingle();
      const mapping = cfg?.mapping || {};
      const conn = await connectionOf(locationId);
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      const terms = ['lightspeed', String(body.contactName || '').trim()].filter((t) => t && t.length <= 80);
      const contacts: any[] = [];
      for (const t of terms) {
        const r = await xeroApi(accessToken, tenantId, `/Contacts?searchTerm=${encodeURIComponent(t)}&page=1`);
        for (const c of r?.Contacts || []) if (!contacts.some((x) => x.ContactID === c.ContactID)) contacts.push(c);
      }
      const ids = contacts.slice(0, 10).map((c) => c.ContactID);
      const order = encodeURIComponent('Date DESC');
      const invRes = ids.length
        ? await xeroApi(accessToken, tenantId, `/Invoices?ContactIDs=${ids.join(',')}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID&order=${order}&page=1`)
        : await xeroApi(accessToken, tenantId, `/Invoices?where=${encodeURIComponent('Reference!=null AND Reference.Contains("Lightspeed")')}&order=${order}&page=1`);
      const invoices = (invRes?.Invoices || []).filter((i: any) => i?.Type === 'ACCREC').slice(0, 60);
      const dates = invoices.map((i: any) => xeroDate(i.DateString || i.Date)).filter(Boolean).sort();
      let payments: any[] = [];
      if (dates.length) {
        const [y, m, d] = String(dates[0]).split('-').map(Number);
        for (let page = 1; page <= 3; page++) {
          const r = await xeroApi(accessToken, tenantId, `/Payments?where=${encodeURIComponent(`Date>=DateTime(${y},${m},${d})`)}&page=${page}`);
          const list = r?.Payments || [];
          payments = payments.concat(list);
          if (list.length < 100) break;
        }
      }
      const [trRes, accRes, siblings, categories] = await Promise.all([
        xeroApi(accessToken, tenantId, '/TrackingCategories'),
        xeroApi(accessToken, tenantId, '/Accounts'),
        siblingsOf(locationId, conn?.tenant_id || tenantId),
        venueCategories(sb, locationId, []),
      ]);
      const site = await siteIdentity(locationId, mapping, siblings);
      // This site's tracking option, when the person chose one (or the site already has one):
      // only the invoices carrying it are read, so another site's accounts are never suggested.
      const clip = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 120 ? v.trim() : null);
      const chosen = clip(body.optionId) || clip(body.optionName)
        ? { optionId: clip(body.optionId), optionName: clip(body.optionName) }
        : (mapping.tracking && !mapping.tracking.none && (mapping.tracking.optionId || mapping.tracking.optionName) ? { optionId: mapping.tracking.optionId || null, optionName: mapping.tracking.optionName || null } : null);
      const suggestion = suggestFromLightspeed({
        invoices, payments, accounts: accRes?.Accounts || [], trackingCategories: trRes?.TrackingCategories || [],
        site: { name: site.name }, siblings: siblings.map((x: any) => ({ name: x.name })),
        categories: categories.filter((c: any) => c.local !== false).map((c: any) => ({ id: c.id, label: c.label })),
        option: chosen,
      });
      return json({ suggestion, searched: terms, contactsFound: contacts.map((c) => c.Name).slice(0, 10), invoicesRead: invoices.length });
    }

    if (action === 'site_create') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const { data: cfg } = await sb.from('xero_config').select('mapping').eq('location_id', locationId).maybeSingle();
      const mapping = cfg?.mapping || {};
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      if (body.kind === 'tracking') {
        const catName = String(body.categoryName || 'Location').trim().slice(0, 100);
        const optName = String(body.optionName || '').trim().slice(0, 100);
        if (!optName) return json({ error: 'Give the option a name (usually the site).' }, 400);
        const tr = await xeroApi(accessToken, tenantId, '/TrackingCategories');
        let cat = (tr?.TrackingCategories || []).find((c: any) => String(c.Name).toLowerCase() === catName.toLowerCase());
        if (!cat) cat = (await xeroApi(accessToken, tenantId, '/TrackingCategories', { method: 'PUT', body: JSON.stringify({ Name: catName }) }))?.TrackingCategories?.[0];
        if (!cat?.TrackingCategoryID) return json({ error: 'Xero did not create the tracking category.' }, 500);
        let opt = (cat.Options || []).find((o: any) => String(o.Name).toLowerCase() === optName.toLowerCase());
        if (!opt) opt = (await xeroApi(accessToken, tenantId, `/TrackingCategories/${cat.TrackingCategoryID}/Options`, { method: 'PUT', body: JSON.stringify({ Name: optName }) }))?.Options?.[0];
        if (!opt?.TrackingOptionID) return json({ error: 'Xero did not create the tracking option.' }, 500);
        return json({ ok: true, patch: { tracking: { categoryId: cat.TrackingCategoryID, categoryName: cat.Name, optionId: opt.TrackingOptionID, optionName: opt.Name } } });
      }
      if (body.kind !== 'accounts') return json({ error: 'Unknown kind' }, 400);
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k: string) => RECOMMENDED[k]);
      if (!keys.length) return json({ error: 'Choose which accounts to create.' }, 400);
      const conn = await connectionOf(locationId);
      const siblings = await siblingsOf(locationId, conn?.tenant_id || tenantId);
      const site = await siteIdentity(locationId, mapping, siblings);
      const who = { name: site.name || 'Site', code: String(mapping.site?.code || site.suggestedCode || 'SITE') };
      const accRes = await xeroApi(accessToken, tenantId, '/Accounts');
      const accounts: any[] = accRes?.Accounts || [];
      const created: any[] = [];
      const patch: any = {};
      const ref = (a: any) => a.Code || a.AccountID;
      for (const k of keys) {
        const def = RECOMMENDED[k](who);
        let a = accounts.find((x) => String(x.Name || '').toLowerCase() === String(def.Name).toLowerCase() || (def.Code && String(x.Code || '').toUpperCase() === String(def.Code).toUpperCase()));
        const existed = !!a;
        if (!a) {
          a = (await xeroApi(accessToken, tenantId, '/Accounts', { method: 'PUT', body: JSON.stringify(def) }))?.Accounts?.[0];
          if (!a) return json({ error: `Xero did not create ${def.Name}.`, created }, 500);
          if (def.EnablePaymentsToAccount && a.EnablePaymentsToAccount !== true) {
            a = (await xeroApi(accessToken, tenantId, `/Accounts/${a.AccountID}`, { method: 'POST', body: JSON.stringify({ EnablePaymentsToAccount: true }) }))?.Accounts?.[0] || a;
          }
          accounts.push(a);
        }
        created.push({ key: k, name: a.Name, code: a.Code || '', id: a.AccountID, existed });
        if (k === 'cardClearing') patch.clearing = { ...(patch.clearing || {}), card: ref(a) };
        if (k === 'cashInTill') patch.clearing = { ...(patch.clearing || {}), cash: ref(a) };
        if (k === 'giftLiability') { patch.giftLiabilityAccount = ref(a); patch.clearing = { ...(patch.clearing || {}), gift_card: ref(a) }; }
        if (k === 'tipsPayable') patch.tipsAccount = ref(a);
        if (k === 'servicePayable') patch.serviceAccount = ref(a);
        if (k === 'discounts') patch.discountAccount = ref(a);
      }
      return json({ ok: true, created, patch });
    }

    if (action === 'copy_site') {
      const from = String(body.fromLocationId || '');
      const conn = await connectionOf(locationId);
      const other = from ? await connectionOf(from) : null;
      const allowed = from ? await accessible(caller, [from]) : [];
      if (!conn || !other || conn.tenant_id !== other.tenant_id || !allowed.length) return json({ error: 'You can copy only from a site on this same Xero organisation that you can open.' }, 403);
      const [{ data: src }, localCats, srcCats] = await Promise.all([
        sb.from('xero_config').select('mapping').eq('location_id', from).maybeSingle(),
        venueCategories(sb, locationId, []),
        venueCategories(sb, from, []),
      ]);
      const m = src?.mapping || {};
      const patch: any = {};
      for (const k of ['groups', 'discounts', 'tipsAccount', 'serviceAccount', 'giftLiabilityAccount', 'otherSalesAccount']) if (m[k] !== undefined) patch[k] = m[k];
      if (m.tracking?.categoryName) patch.tracking = { categoryId: m.tracking.categoryId || null, categoryName: m.tracking.categoryName, optionId: null, optionName: null };
      // Category choices follow the category: by master id, then by label.
      const byMaster = new Map(localCats.map((c: any) => [String(c.master_id || c.id), c.id]));
      const byLabel = new Map(localCats.map((c: any) => [String(c.label || '').trim().toLowerCase(), c.id]));
      const cg: Record<string, string> = {};
      let matched = 0, missed = 0;
      for (const [catId, g] of Object.entries(m.categoryGroups || {})) {
        const sc: any = srcCats.find((c: any) => c.id === catId);
        const local = (sc && (byMaster.get(String(sc.master_id || sc.id)) || byLabel.get(String(sc.label || '').trim().toLowerCase()))) || null;
        if (local) { cg[local as string] = g as string; matched += 1; } else missed += 1;
      }
      if (Object.keys(cg).length) patch.categoryGroups = cg;
      return json({ ok: true, patch, categories: { matched, missed } });
    }

    if (action === 'options') {
      if (!CLIENT_ID) return json({ error: 'Xero not configured' }, 400);
      const { accessToken, tenantId } = await getValidAccessToken(sb, locationId, CLIENT_ID, CLIENT_SECRET);
      // A failed tax rate read is SAID (the flags), never shown as "no rates": the screen would
      // otherwise call a correct choice wrong, or say the venue has no VAT rates.
      let taxRatesError = false, servosRatesError = false;
      let trackingError = false;
      const [accRes, taxRes, methods, servos, unmatchedTaxBuckets, trRes] = await Promise.all([
        xeroApi(accessToken, tenantId, '/Accounts'),
        xeroApi(accessToken, tenantId, '/TaxRates').catch(() => { taxRatesError = true; return { TaxRates: [] }; }),
        paymentMethods(locationId),
        venueTaxRates(sb, locationId).catch(() => { servosRatesError = true; return []; }),
        refusedPctBuckets(locationId),
        xeroApi(accessToken, tenantId, '/TrackingCategories').catch(() => { trackingError = true; return { TrackingCategories: [] }; }),
      ]);
      const accounts = (accRes?.Accounts || [])
        .filter((a: any) => String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE')
        .map(accountView);
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
        trackingCategories: (trRes?.TrackingCategories || []).map(trackingView), trackingError,
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 500);
  }
});
