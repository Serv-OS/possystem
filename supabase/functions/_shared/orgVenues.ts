// supabase/functions/_shared/orgVenues.ts (6 Nov 2026, 5.12.69)
//
// The one check behind every saved site scope (campaign schedule.location_ids, automation
// entry_trigger.location_ids, offer venue_ids, a quick send, a segment count): the ids named must be
// the organisation's own venues. Review finding, 6 Nov 2026: a failed locations read or a list of
// foreign ids must REFUSE, never fall through to [] (which means every site: a Leeds quick send
// would have gone to the whole company). No ids named = every site, no read.

import { keepOrgVenues, siteScopeIds } from './venueScope.js';

export type ScopeAnswer = { ok: true; ids: string[] } | { ok: false; error: string; status: number };

export async function scopeForOrg(sb: any, org_id: string, ids: unknown): Promise<ScopeAnswer> {
  const named = siteScopeIds({ location_ids: ids });
  if (!named.length) return { ok: true, ids: [] };
  const { data, error } = await sb.from('locations').select('id').eq('org_id', org_id).limit(500);
  if (error) return { ok: false, error: 'Your sites could not be checked. Try again.', status: 500 };
  const kept = keepOrgVenues(named, (data ?? []).map((l: any) => String(l.id)));
  if (!kept.length) return { ok: false, error: "Those sites are not this organisation's.", status: 400 };
  return { ok: true, ids: kept };
}
