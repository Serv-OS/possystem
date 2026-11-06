// supabase/functions/_shared/loyaltyMergeRead.ts (6 Nov 2026, marketing v3)
//
// Reads, for a set of Ops customers of one organisation, the loyalty rows the loyalty portal
// reads (loyalty-otp memberAccount) and turns them into merge values with loyaltyMerge.js.
// Used by marketing-send, the batch sender and the segment loyalty rules. Never throws: a
// failed read leaves every tag at its blank value, so a send is never blocked by loyalty.
//
// The key is Ops customers.id plus the Platform company_id (loyalty is company wide); the
// company is found through the organisation's venues: Ops locations.org_id -> locations.id ->
// Platform locations.ops_location_id -> company_id.
import { loyaltyMergeValues, LOYALTY_TAGS } from './loyaltyMerge.js';

// The Platform client is made on first use, never at load: the workflow engine (which imports this
// through segmentAudience.ts) also runs under node in the test suite, where neither Deno nor an
// https import exists. A definition without a loyalty rule never reaches this client.
const env = (k: string): string => (typeof Deno !== 'undefined' && Deno.env ? Deno.env.get(k) ?? '' : '');
const platformUrl = env('PLATFORM_SUPABASE_URL');
const platformKey = env('PLATFORM_SUPABASE_SERVICE_ROLE_KEY');
export const platformReady = !!(platformUrl && platformKey);
let platformPromise: Promise<any> | null = null;
function platformClient(): Promise<any> {
  if (!platformReady) return Promise.resolve(null);
  if (!platformPromise) {
    platformPromise = import('https://esm.sh/@supabase/supabase-js@2')
      .then((m) => m.createClient(platformUrl, platformKey, { auth: { autoRefreshToken: false, persistSession: false } }))
      .catch((e) => { console.warn('[loyaltyMergeRead] platform client failed:', e instanceof Error ? e.message : String(e)); platformPromise = null; return null; });
  }
  return platformPromise;
}

export type LoyaltyValues = Record<string, string | number>;
export const BLANK_LOYALTY: LoyaltyValues = Object.fromEntries(LOYALTY_TAGS.map((k: string) => [k, k === 'tier' || k === 'next_reward' || k === 'stamp_reward' || k === 'stamp_card' ? '' : 0]));

/** Read every row of a query in pages of 1000 (the API hands back at most 1,000 rows a request). */
async function pageAll(build: (from: number, to: number) => any, cap = 50000): Promise<any[]> {
  const PAGE = 1000;
  const out: any[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** The Platform company for an Ops organisation (its first venue that is on the Platform), or null. */
export async function companyForOrg(ops: any, orgId: string): Promise<string | null> {
  const platformAdmin = await platformClient();
  if (!platformAdmin) return null;
  const { data: locs } = await ops.from('locations').select('id').eq('org_id', orgId).limit(50);
  const ids = (locs ?? []).map((l: any) => l.id);
  if (!ids.length) return null;
  const { data } = await platformAdmin.from('locations').select('company_id').in('ops_location_id', ids).not('company_id', 'is', null).limit(1);
  return data?.[0]?.company_id ?? null;
}

export type CompanyLoyalty = {
  companyId: string;
  rewards: any[]; tiers: any[]; programs: any[];
};

/** The company's reward ladder, tiers and stamp programs (one read per send batch). */
export async function companyLoyalty(ops: any, orgId: string): Promise<CompanyLoyalty | null> {
  const platformAdmin = await platformClient();
  if (!platformAdmin) return null;
  const companyId = await companyForOrg(ops, orgId);
  if (!companyId) return null;
  const [{ data: rewards }, { data: tiers }, { data: programs }] = await Promise.all([
    platformAdmin.from('loyalty_rewards').select('id, name, points_cost, active').eq('company_id', companyId).eq('active', true).order('sort_order'),
    platformAdmin.from('loyalty_tiers').select('id, name').eq('company_id', companyId),
    platformAdmin.from('stamp_card_programs').select('id, name, stamps_required, reward_description, active').eq('company_id', companyId).eq('active', true).order('created_at'),
  ]);
  return { companyId, rewards: rewards ?? [], tiers: tiers ?? [], programs: programs ?? [] };
}

/**
 * Merge values per customer id. `customerIds` null = every member of the company (segment rules).
 * Customers with no loyalty row get BLANK_LOYALTY (and are absent from `members`).
 */
export async function loyaltyValuesFor(ops: any, orgId: string, customerIds: string[] | null, company?: CompanyLoyalty | null)
  : Promise<{ values: Map<string, LoyaltyValues>; members: Set<string> }> {
  const values = new Map<string, LoyaltyValues>();
  const members = new Set<string>();
  try {
    const co = company === undefined ? await companyLoyalty(ops, orgId) : company;
    const platformAdmin = co ? await platformClient() : null;
    if (!co || !platformAdmin) return { values, members };
    const ids = customerIds ? [...new Set(customerIds)] : null;
    if (ids && !ids.length) return { values, members };
    const inChunks = async (list: string[] | null, q: (chunk: string[] | null) => Promise<any[]>): Promise<any[]> => {
      if (!list) return q(null);
      const out: any[] = [];
      for (let i = 0; i < list.length; i += 200) out.push(...await q(list.slice(i, i + 200)));
      return out;
    };
    const loyaltyRows = await inChunks(ids, (chunk) => pageAll((from, to) => {
      let q = platformAdmin.from('customer_loyalty').select('customer_id, points_balance, tier_id').eq('company_id', co.companyId);
      if (chunk) q = q.in('customer_id', chunk);
      return q.order('customer_id').range(from, to);
    }));
    const progIds = co.programs.map((p: any) => p.id);
    const cardRows = progIds.length ? await inChunks(ids, (chunk) => pageAll((from, to) => {
      let q = platformAdmin.from('customer_stamp_cards').select('customer_id, program_id, stamps_collected, completed_count').eq('company_id', co.companyId).in('program_id', progIds);
      if (chunk) q = q.in('customer_id', chunk);
      return q.order('customer_id').range(from, to);
    })) : [];
    // rewards ready = completed cards minus the 'redeem' rows in the Ops stamp ledger (the portal's rule)
    const redeemRows = progIds.length && cardRows.some((c: any) => Number(c.completed_count) > 0) ? await inChunks(ids, (chunk) => pageAll((from, to) => {
      let q = ops.from('stamp_transactions').select('customer_id, program_id').eq('type', 'redeem').in('program_id', progIds);
      if (chunk) q = q.in('customer_id', chunk);
      return q.order('id').range(from, to);
    })) : [];
    const cardsBy = new Map<string, any[]>();
    for (const c of cardRows) { const l = cardsBy.get(c.customer_id) || []; l.push(c); cardsBy.set(c.customer_id, l); }
    const redeemedBy = new Map<string, Record<string, number>>();
    for (const r of redeemRows) { const m = redeemedBy.get(r.customer_id) || {}; m[String(r.program_id)] = (m[String(r.program_id)] || 0) + 1; redeemedBy.set(r.customer_id, m); }
    const loyaltyBy = new Map<string, any>(loyaltyRows.map((r: any) => [r.customer_id, r]));
    const everyone = new Set<string>([...loyaltyBy.keys(), ...cardsBy.keys()]);
    for (const id of everyone) {
      members.add(id);
      values.set(id, loyaltyMergeValues({ loyalty: loyaltyBy.get(id) || null, rewards: co.rewards, tiers: co.tiers, programs: co.programs, cards: cardsBy.get(id) || [], redeemedByProgram: redeemedBy.get(id) || {} }) as LoyaltyValues);
    }
  } catch (e) {
    console.warn('[loyaltyMergeRead] loyalty read failed, tags left blank:', e instanceof Error ? e.message : String(e));
  }
  return { values, members };
}
