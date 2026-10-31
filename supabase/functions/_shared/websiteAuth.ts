// supabase/functions/_shared/websiteAuth.ts
//
// WEBSITE BUILDER (v5.12.0): the one fence website-admin and website-domain share.
//
// THE FENCE (in this order, copied from location-admin; do not reorder)
//   1. A bearer token is required and must belong to a REAL signed in user on the Ops project.
//      Anonymous sessions (till, kiosk, QR, menu board) are refused: a Back Office writer is
//      never an anonymous session.
//   2. The caller's venues are read SERVER side from the Ops database: user_locations rows,
//      plus every venue of their own organisation when their profile says owner (the same rule
//      as _shared/venueWriter.js and migration 20260921u), plus everything for super_admin.
//   3. Those Ops location ids are mapped to Platform `locations` rows (ops_location_id first,
//      legacy id second, the same order every Back Office screen reads them) and the COMPANY
//      ids come from there. The body may name a company_id only to CHOOSE among the companies
//      the caller already reaches; it can never widen them.
//
// The service role key (the AI designer on Vercel, cron) passes the fence and must name the
// company_id in the body. The Platform browser client holds no login, so nothing here trusts
// a Platform JWT.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from './second-step.ts';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

export const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
export const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
export const opsAdmin: SupabaseClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
export const platformAdmin: SupabaseClient = createClient(PLATFORM_URL, Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

export type Caller = {
  userId: string | null;
  service: boolean;
  superAdmin: boolean;
  companyIds: string[];
  opsLocationIds: string[];
  /** user_profiles.role on the Ops project ('owner', 'manager', ...), null for the service role. The custom code switch is owner only. */
  role: string | null;
};

export type Refusal = { status: number; error: string };

const chunk = <T>(arr: T[], n = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Platform company ids for a list of Ops location ids. Never throws: a failed read is []. */
export async function companiesForOpsLocations(opsIds: string[]): Promise<string[]> {
  const ids = [...new Set(opsIds.filter(Boolean))];
  if (!ids.length) return [];
  const found = new Set<string>();
  try {
    for (const part of chunk(ids)) {
      const { data } = await platformAdmin.from('locations').select('company_id, ops_location_id, id').in('ops_location_id', part);
      for (const r of (data ?? []) as Array<{ company_id: string | null }>) if (r.company_id) found.add(r.company_id);
      // Legacy rows: a venue made before ops_location_id existed carries the same id on both sides.
      const { data: legacy } = await platformAdmin.from('locations').select('company_id').in('id', part);
      for (const r of (legacy ?? []) as Array<{ company_id: string | null }>) if (r.company_id) found.add(r.company_id);
    }
  } catch (e) {
    console.warn('[websiteAuth] platform lookup failed:', String((e as Error)?.message || e));
  }
  return [...found];
}

/**
 * Who is calling. Returns the caller or a refusal (401 no login, 403 no venue).
 * Runs the second step check first (docs/SECOND_STEP.md) like every Back Office writer.
 */
export async function websiteCaller(req: Request): Promise<{ caller: Caller } | { refusal: Response }> {
  const secondStepBlock = await secondStepRefusal(req);
  if (secondStepBlock) return { refusal: secondStepBlock };
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { refusal: json({ error: 'Sign in to the Back Office again.' }, 401) };
  if (SERVICE_ROLE && token === SERVICE_ROLE) {
    return { caller: { userId: null, service: true, superAdmin: true, companyIds: [], opsLocationIds: [], role: null } };
  }
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user || user.is_anonymous) return { refusal: json({ error: 'Sign in to the Back Office again.' }, 401) };

  const [ulRes, profRes] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id),
    opsAdmin.from('user_profiles').select('role, org_id').eq('id', user.id).maybeSingle(),
  ]);
  const role = (profRes.data as { role?: string } | null)?.role ?? null;
  const orgId = (profRes.data as { org_id?: string } | null)?.org_id ?? null;
  const superAdmin = role === 'super_admin';
  const opsIds = new Set<string>(((ulRes.data ?? []) as Array<{ location_id: string }>).map((r) => r.location_id).filter(Boolean));
  if (role === 'owner' && orgId) {
    const { data } = await opsAdmin.from('locations').select('id').eq('org_id', orgId);
    for (const r of (data ?? []) as Array<{ id: string }>) opsIds.add(r.id);
  }
  const companyIds = superAdmin ? [] : await companiesForOpsLocations([...opsIds]);
  if (!superAdmin && !companyIds.length) {
    return { refusal: json({ error: 'This login has no venue on the platform yet, so there is nothing to build a site for.' }, 403) };
  }
  return { caller: { userId: user.id, service: false, superAdmin, companyIds, opsLocationIds: [...opsIds], role } };
}

/**
 * The company this request works on. The body's company_id may only pick among the caller's
 * companies; a super admin or the service role must name one (they reach every company).
 */
export function resolveCompany(caller: Caller, bodyCompanyId: unknown): { companyId: string } | { refusal: Response } {
  const wanted = typeof bodyCompanyId === 'string' && bodyCompanyId.trim() ? bodyCompanyId.trim() : '';
  if (caller.service || caller.superAdmin) {
    if (wanted) return { companyId: wanted };
    if (caller.companyIds.length === 1) return { companyId: caller.companyIds[0] };
    return { refusal: json({ error: 'company_id is needed for this login.' }, 400) };
  }
  if (wanted) {
    return caller.companyIds.includes(wanted)
      ? { companyId: wanted }
      : { refusal: json({ error: 'This login does not manage that company.' }, 403) };
  }
  if (caller.companyIds.length === 1) return { companyId: caller.companyIds[0] };
  return { refusal: json({ error: 'This login manages more than one company. Say which one (company_id).', companies: caller.companyIds }, 400) };
}

/** fetch with a hard timeout. Resolves to null on any failure, never throws. */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<Response | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    console.warn('[website] fetch failed:', url.split('?')[0], String((e as Error)?.message || e));
    return null;
  } finally {
    clearTimeout(t);
  }
}
