// customer-app-admin: the Back Office side of the customer app (Appearance, App branding tab).
// Reads and writes tenant_app_config for the caller's organisation and stores the logo and icon.
// The table is service role only, so this is the only writer. Deployed --no-verify-jwt: the
// caller's Supabase JWT is checked here (second step, owner or admin of the org, or super_admin).
//
// Actions (POST { action, ops_location_id, ... }):
//   get    -> { orgId, orgName, tenant: { tenantId, version, payload, updatedAt } | null, defaults }
//   save   -> { tenantId, payload, version } (validated against the app's tenant schema)
//   upload -> { url } for { tenantId, kind: logoLight|logoDark|icon, contentType, base64 }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { validateTenantPayload } from '../_shared/customerAppRules.js';
import {
  ASSET_KINDS, ASSET_TYPES, MAX_ASSET_BYTES, TENANT_ID_RE,
  cleanPayload, decideTenantWriter, defaultPayload, formProblems,
} from '../_shared/customerAppBrand.js';
import tenantSchema from '../_shared/tenantAppSchema.json' with { type: 'json' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ops = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const BUCKET = 'receipt-assets';

interface Caller { userId: string; role: string | null; orgId: string | null; }

async function caller(req: Request): Promise<Caller | null> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await ops.auth.getUser(token);
  const user = data?.user;
  if (error || !user || user.is_anonymous) return null;
  const { data: prof } = await ops.from('user_profiles').select('role, org_id').eq('id', user.id).maybeSingle();
  return { userId: user.id, role: prof?.role ?? null, orgId: prof?.org_id ?? null };
}

/** The organisation the page is working in: the managed venue's org (super_admin) or the caller's own. */
async function targetOrg(c: Caller, opsLocationId: string): Promise<{ id: string; name: string } | null> {
  const { data: loc } = await ops.from('locations').select('org_id, currency').eq('id', opsLocationId).maybeSingle();
  const orgId = c.role === 'super_admin' ? (loc?.org_id ?? c.orgId) : c.orgId;
  if (!orgId) return null;
  if (c.role !== 'super_admin' && loc?.org_id && String(loc.org_id) !== String(orgId)) return null;
  const { data: org } = await ops.from('organisations').select('id, name').eq('id', orgId).maybeSingle();
  return org ? { id: String(org.id), name: String(org.name ?? '') } : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock;
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const opsLocationId = String(body?.ops_location_id ?? '').trim();
  if (!action || !opsLocationId) return json({ error: 'action and ops_location_id required' }, 400);

  const c = await caller(req);
  if (!c) return json({ error: 'sign in again', code: 'unauthorized' }, 401);
  if (!(c.role === 'super_admin' || c.role === 'owner' || c.role === 'admin')) return json({ error: 'owners and admins only', code: 'forbidden' }, 403);
  const org = await targetOrg(c, opsLocationId);
  if (!org) return json({ error: 'no organisation for this login', code: 'no_org' }, 403);

  const orgRow = async () => {
    const { data } = await ops.from('tenant_app_config').select('tenant_id, org_id, payload, version, updated_at').eq('org_id', org.id).maybeSingle();
    return data ?? null;
  };

  if (action === 'get') {
    const row = await orgRow();
    const { data: venues } = await ops.from('locations').select('currency').eq('org_id', org.id).limit(1);
    const currency = venues?.[0]?.currency ?? 'GBP';
    const defaults = defaultPayload({ orgName: org.name, currency, locale: String(currency).toUpperCase() === 'USD' ? 'en-US' : 'en-GB' });
    return json({
      orgId: org.id, orgName: org.name,
      tenant: row ? { tenantId: row.tenant_id, version: row.version, payload: row.payload, updatedAt: row.updated_at } : null,
      defaults,
    });
  }

  if (action === 'save') {
    const tenantId = String(body?.tenantId ?? body?.payload?.tenantId ?? '').trim();
    if (!TENANT_ID_RE.test(tenantId)) return json({ error: 'bad app id', code: 'bad_tenant_id' }, 400);
    const problems = formProblems({ ...body?.payload, tenantId });
    if (problems.length) return json({ error: problems[0], code: 'invalid', problems }, 400);
    const payload = cleanPayload({ ...body?.payload, tenantId });
    const v = validateTenantPayload(tenantSchema, payload);
    if (!v.ok) return json({ error: 'theme does not match the app schema', code: 'schema', problems: v.errors }, 400);

    const [{ data: byId }, mine] = await Promise.all([
      ops.from('tenant_app_config').select('tenant_id, org_id').eq('tenant_id', tenantId).maybeSingle(),
      orgRow(),
    ]);
    const d = decideTenantWriter({ role: c.role, orgId: org.id, rowOrgId: byId?.org_id ?? null, orgRowTenantId: mine?.tenant_id ?? null, tenantId });
    if (!d.ok) {
      const msg = d.code === 'tenant_taken' ? 'That app id belongs to another organisation'
        : d.code === 'org_has_app' ? `This organisation already has the app "${d.existing}"; the app id cannot change`
        : 'owners and admins only';
      return json({ error: msg, code: d.code }, d.code === 'forbidden' ? 403 : 409);
    }
    const { data: saved, error } = byId
      ? await ops.from('tenant_app_config').update({ payload }).eq('tenant_id', tenantId).select('tenant_id, version, payload').single()
      : await ops.from('tenant_app_config').insert({ tenant_id: tenantId, org_id: org.id, payload }).select('tenant_id, version, payload').single();
    if (error) return json({ error: error.message, code: 'db' }, 500);
    return json({ tenantId: saved.tenant_id, version: saved.version, payload: saved.payload });
  }

  if (action === 'upload') {
    const tenantId = String(body?.tenantId ?? '').trim();
    const kind = String(body?.kind ?? '');
    const contentType = String(body?.contentType ?? '');
    if (!TENANT_ID_RE.test(tenantId)) return json({ error: 'bad app id', code: 'bad_tenant_id' }, 400);
    if (!ASSET_KINDS.includes(kind)) return json({ error: 'kind must be logoLight, logoDark or icon', code: 'bad_kind' }, 400);
    const ext = (ASSET_TYPES as Record<string, string>)[contentType];
    if (!ext) return json({ error: 'PNG, JPEG or SVG only', code: 'bad_type' }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(String(body?.base64 ?? '')), (ch) => ch.charCodeAt(0)); } catch { return json({ error: 'bad image data', code: 'bad_data' }, 400); }
    if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return json({ error: 'image must be under 2 MB', code: 'too_big' }, 400);
    const { data: byId } = await ops.from('tenant_app_config').select('org_id').eq('tenant_id', tenantId).maybeSingle();
    if (byId && String(byId.org_id) !== org.id && c.role !== 'super_admin') return json({ error: 'That app id belongs to another organisation', code: 'tenant_taken' }, 409);
    const path = `app/${tenantId}/${kind}-${Date.now()}.${ext}`;
    const { error } = await ops.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (error) return json({ error: error.message, code: 'storage' }, 500);
    const { data } = ops.storage.from(BUCKET).getPublicUrl(path);
    return json({ url: data.publicUrl, path });
  }

  return json({ error: `unknown action ${action}`, code: 'unknown_action' }, 400);
});
