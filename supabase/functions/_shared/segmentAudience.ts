// supabase/functions/_shared/segmentAudience.ts (6 Nov 2026, marketing v3)
//
// ONE way to turn a segment definition into customer ids, shared by marketing-segments (count,
// preview, resolve), the campaign engine, the workflow engine and manual enrolment. Two steps:
//   1. Loyalty rules (points_balance, stamps_to_go, tier, loyalty_member ...) live on the Platform
//      database, which the Ops resolver cannot see. Each one is decided here per member from the
//      same rows the loyalty portal reads, and replaced in the definition by a customer_id list.
//      A definition with no loyalty rule is passed through untouched (no Platform read).
//   2. marketing_resolve_segment on Ops does the rest (groups to three levels, item rules, RFM),
//      paged in a fixed order past the API's 1,000 row cap.
import { collectLoyaltyRules, expandLoyaltyRules, loyaltyRuleMatches } from './loyaltyMerge.js';
import { loyaltyValuesFor } from './loyaltyMergeRead.ts';

/** The definition with its loyalty rules decided (customer id lists). Safe on a definition without any. */
export async function expandAudience(sb: any, orgId: string, def: any): Promise<any> {
  if (!def || typeof def !== 'object') return def;
  const loyaltyRules = collectLoyaltyRules(def);
  if (!loyaltyRules.length) return def;
  const { values, members } = await loyaltyValuesFor(sb, orgId, null);
  return expandLoyaltyRules(def, (rule: any) => {
    if (String(rule.field) === 'loyalty_member') {
      const ids = [...members];
      return String(rule.op || '').toLowerCase() === 'is_false' ? { ids, negate: true } : { ids };
    }
    const ids: string[] = [];
    for (const [id, v] of values) if (loyaltyRuleMatches(rule, v, true)) ids.push(id);
    return { ids };
  });
}

/** Every customer id the definition matches, in customer_id order. */
export async function resolveAudience(sb: any, orgId: string, def: any, limit?: number | null): Promise<string[]> {
  if (!def) return [];
  const expanded = await expandAudience(sb, orgId, def);
  const PAGE = 1000;
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.rpc('marketing_resolve_segment', { p_org: orgId, p_def: expanded, p_limit: limit ?? null })
      .order('customer_id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`resolve: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows as any[]) out.push(r.customer_id);
    if (rows.length < PAGE) break;
    if (limit && out.length >= limit) break;
  }
  return limit ? out.slice(0, limit) : out;
}
