// supabase/functions/marketing-forms/index.ts
//
// MARKETING FORMS (5.12.36): Back Office management of forms and their submissions. Auth mirrors
// marketing-workflows: a staff login with access to the active venue (user_locations) or a
// super_admin; the company (org) is worked out here from the venue, never taken from the body.
// The rules for a form live in _shared/formRules.js (the builder in the browser checks the same).
// Actions:
//   list_forms         { ops_location_id }                        → forms (with submission counts) + venues
//   save_form          { ops_location_id, form:{ id?, ... } }     → insert or update MY form
//   set_status         { ops_location_id, id, status }            → 'active' | 'archived'
//   list_submissions   { ops_location_id, form_id, limit?, offset? } → newest first, with customer names
//   export_submissions { ops_location_id, form_id }               → every row (up to 5,000) for the CSV

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { normaliseFormDef } from '../_shared/formRules.js';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const EXPORT_MAX = 5000;

async function caller(req: Request, opsLocationId: string): Promise<{ ok: boolean; userId: string | null }> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return { ok: false, userId: null };
  if (token === SERVICE_ROLE) return { ok: true, userId: null };
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return { ok: false, userId: null };
  const { data: ul } = await sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return { ok: true, userId: user.id };
  const { data: prof } = await sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return { ok: prof?.role === 'super_admin', userId: user.id };
}
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await sb.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}
const missingTable = (e: any) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|Could not find the table/i.test(String(e.message || '')));
const NOT_READY = 'Forms are not switched on yet: the forms SQL (20261111a) has not been run on the Ops database.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  const who = await caller(req, ops);
  if (!who.ok) return json({ error: 'no access to this location' }, 403);
  const org_id = await orgFor(ops);
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  if (action === 'list_forms') {
    const [{ data: forms, error }, { data: venues }] = await Promise.all([
      sb.from('marketing_forms').select('*').eq('org_id', org_id).order('created_at', { ascending: false }).limit(200),
      sb.from('locations').select('id, name, timezone').eq('org_id', org_id).order('name'),
    ]);
    if (error) return json(missingTable(error) ? { forms: [], venues: venues ?? [], not_ready: NOT_READY } : { error: error.message }, missingTable(error) ? 200 : 500);
    const counts = await Promise.all((forms ?? []).map((f: any) =>
      sb.from('marketing_form_submissions').select('id', { count: 'exact', head: true }).eq('form_id', f.id).eq('org_id', org_id).then((r: any) => r.count ?? 0)));
    return json({ forms: (forms ?? []).map((f: any, i: number) => ({ ...f, submissions: counts[i] })), venues: venues ?? [] });
  }

  if (action === 'save_form') {
    const incoming = body.form || {};
    const { ok, errors, clean } = normaliseFormDef(incoming);
    if (!ok) return json({ error: errors[0], errors }, 400);
    if (clean.location_id) {
      const { data: loc } = await sb.from('locations').select('id').eq('id', clean.location_id).eq('org_id', org_id).maybeSingle();
      if (!loc) return json({ error: 'That venue is not one of yours.' }, 400);
    }
    const row: Record<string, unknown> = { ...clean, org_id, updated_at: new Date().toISOString() };
    const id = incoming.id ? String(incoming.id) : '';
    let q;
    if (id) {
      // An id means "update MY form": it must exist in this company (never an upsert on a caller id).
      if (!UUID_RE.test(id)) return json({ error: 'form not found' }, 404);
      const { data: mine } = await sb.from('marketing_forms').select('id').eq('id', id).eq('org_id', org_id).maybeSingle();
      if (!mine) return json({ error: 'form not found' }, 404);
      q = sb.from('marketing_forms').update(row).eq('id', id).eq('org_id', org_id);
    } else {
      q = sb.from('marketing_forms').insert({ ...row, created_by: who.userId });
    }
    const { data, error } = await q.select('*').maybeSingle();
    if (error) return json({ error: missingTable(error) ? NOT_READY : error.message }, 500);
    return json({ ok: true, form: data });
  }

  if (action === 'set_status') {
    const id = String(body.id ?? '').trim();
    const status = String(body.status ?? '').trim();
    if (!UUID_RE.test(id) || !['active', 'archived'].includes(status)) return json({ error: 'id + status (active or archived) required' }, 400);
    const { data, error } = await sb.from('marketing_forms').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', org_id).select('id').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: 'form not found' }, 404);
    return json({ ok: true });
  }

  if (action === 'list_submissions' || action === 'export_submissions') {
    const formId = String(body.form_id ?? '').trim();
    if (!UUID_RE.test(formId)) return json({ error: 'form_id required' }, 400);
    const { data: form } = await sb.from('marketing_forms').select('id').eq('id', formId).eq('org_id', org_id).maybeSingle();
    if (!form) return json({ error: 'form not found' }, 404);
    const cols = 'id, answers, consent, customer_id, source, page_url, created_at';
    let rows: any[] = [];
    let total = 0;
    if (action === 'list_submissions') {
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
      const offset = Math.max(Number(body.offset) || 0, 0);
      const { data, error, count } = await sb.from('marketing_form_submissions').select(cols, { count: 'exact' })
        .eq('form_id', formId).eq('org_id', org_id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) return json({ error: error.message }, 500);
      rows = data ?? []; total = count ?? rows.length;
    } else {
      for (let from = 0; from < EXPORT_MAX; from += PAGE) {
        const { data, error } = await sb.from('marketing_form_submissions').select(cols)
          .eq('form_id', formId).eq('org_id', org_id).order('created_at', { ascending: false }).order('id').range(from, from + PAGE - 1);
        if (error) return json({ error: error.message }, 500);
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
      }
      total = rows.length;
    }
    // Customer names in batches of 200 (a long id list overflows the request).
    const ids = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
    const names: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb.from('customers').select('id, name, email, phone').eq('org_id', org_id).in('id', ids.slice(i, i + 200));
      for (const c of (data ?? []) as any[]) names[c.id] = c.name || c.email || c.phone || '';
    }
    return json({ ok: true, total, rows: rows.map((r) => ({ ...r, customer_name: r.customer_id ? (names[r.customer_id] ?? '') : '' })) });
  }

  return json({ error: 'unknown action' }, 400);
});
