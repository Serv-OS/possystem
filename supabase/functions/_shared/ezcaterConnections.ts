// supabase/functions/_shared/ezcaterConnections.ts
//
// WHICH ezCater CONNECTION SERVES A VENUE, and WHICH COMPANY a venue belongs to. Used by
// ezcater-connect. The Supabase clients are passed in, so this file has no Deno globals and is
// unit tested under node (src/lib/ezcaterRound4.test.js).
//
// Review round 4 (18 Sep 2026):
//   * connectionForLocation FILTERS BY COMPANY IN THE QUERY. It used to read the 20 oldest
//     connected rows on the whole platform and test each one's company in code, so a venue whose
//     company's connection was the 21st oldest was told it had none.
//   * venueCompanyStrict tells a FAILED lookup apart from "this venue has no company", so
//     connect_token never stores company_id null because Platform blinked (that connection could
//     then never be found for the company again).

/**
 * The company that owns an Ops location (Platform locations.company_id, on ops_location_id then
 * id). { ok: false } when Platform could not be asked or answered with an error; { ok: true,
 * companyId: null } only when Platform answered and the venue has no company.
 */
export async function venueCompanyStrict(platform: any, opsLocationId: string): Promise<{ ok: true; companyId: string | null } | { ok: false; error: string }> {
  if (!platform) return { ok: false, error: 'Platform is not configured' };
  try {
    const a = await platform.from('locations').select('id, company_id').eq('ops_location_id', opsLocationId).maybeSingle();
    if (a?.error) return { ok: false, error: a.error.message || String(a.error) };
    let data = a?.data || null;
    if (!data) {
      const b = await platform.from('locations').select('id, company_id').eq('id', opsLocationId).maybeSingle();
      if (b?.error) return { ok: false, error: b.error.message || String(b.error) };
      data = b?.data || null;
    }
    return { ok: true, companyId: data?.company_id ? String(data.company_id) : null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The company of a venue, or null when there is none or it could not be read. */
export async function venueCompany(platform: any, opsLocationId: string): Promise<string | null> {
  const r = await venueCompanyStrict(platform, opsLocationId);
  return r.ok ? r.companyId : null;
}

/** The Ops location ids of every venue of one company (Platform), for the legacy lookup. */
async function companyVenueIds(platform: any, companyId: string): Promise<string[]> {
  if (!platform) return [];
  try {
    const { data, error } = await platform.from('locations').select('id, ops_location_id').eq('company_id', companyId).limit(1000);
    if (error) return [];
    const ids = new Set<string>();
    for (const l of data || []) {
      if (l?.ops_location_id) ids.add(String(l.ops_location_id));
      if (l?.id) ids.add(String(l.id));
    }
    return [...ids];
  } catch { return []; }
}

/**
 * The connection serving a location:
 *   1. the one its own mapped caterer belongs to;
 *   2. else a connected row STAMPED with the venue's company (company_id, in the query);
 *   3. else a connected row made before company_id was written (company_id null) that a caterer
 *      mapped to a venue OF THE SAME COMPANY belongs to (all three filters in the queries).
 * NEVER another company's connection (review round 3, F). A venue whose company cannot be told
 * gets null (not connected).
 */
export async function connectionForLocation(sb: any, platform: any, opsLocationId: string): Promise<any | null> {
  const { data: cat } = await sb.from('ezcater_caterers')
    .select('connection_id').eq('location_id', opsLocationId).not('connection_id', 'is', null).limit(1).maybeSingle();
  if (cat?.connection_id) {
    const { data } = await sb.from('ezcater_connections').select('*').eq('id', cat.connection_id).maybeSingle();
    if (data) return data;
  }
  const company = await venueCompany(platform, opsLocationId);
  if (!company) return null;
  const { data: own } = await sb.from('ezcater_connections').select('*')
    .eq('status', 'connected').eq('company_id', company).order('connected_at', { ascending: true }).limit(1);
  if (own?.length) return own[0];
  const venues = await companyVenueIds(platform, company);
  if (!venues.length) return null;
  const { data: cats } = await sb.from('ezcater_caterers').select('connection_id')
    .in('location_id', venues).not('connection_id', 'is', null).limit(200);
  const connIds = [...new Set((cats || []).map((c: any) => String(c.connection_id || '')).filter(Boolean))];
  if (!connIds.length) return null;
  const { data: legacy } = await sb.from('ezcater_connections').select('*')
    .eq('status', 'connected').is('company_id', null).in('id', connIds).order('connected_at', { ascending: true }).limit(1);
  return legacy?.[0] || null;
}

/**
 * The company an ezCater connection belongs to: its company_id, else the company of a venue one
 * of its caterers is mapped to (a connection made before company_id was written). null when
 * neither says.
 */
export async function connectionCompany(sb: any, platform: any, conn: any): Promise<string | null> {
  if (!conn?.id) return null;
  if (conn.company_id) return String(conn.company_id);
  const { data: cats } = await sb.from('ezcater_caterers').select('location_id')
    .eq('connection_id', conn.id).not('location_id', 'is', null).limit(5);
  for (const c of cats || []) {
    const co = await venueCompany(platform, String(c.location_id));
    if (co) return co;
  }
  return null;
}
