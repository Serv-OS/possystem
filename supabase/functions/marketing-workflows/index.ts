// supabase/functions/marketing-workflows/index.ts
//
// Slice 6 — back-office drip/workflow management. Auth mirrors marketing-campaigns. Actions:
//   list_workflows   { ops_location_id }                         → workflows + segments + offers + venues (5.12.68: for the site scope picker)
//   save_workflow    { ops_location_id, workflow:{...} }         → upsert
//   set_status       { ops_location_id, id, status }
//   delete_workflow  { ops_location_id, id }
//   run_now          { ops_location_id, id, now? }               → enroll + advance one pass (test)
//   enroll           { ops_location_id, id, segment_id?|customer_ids? } → manual enrolment
//   list_enrollments { ops_location_id, workflow_id }            → enrollments + recent step sends
// 5.12.40: list_workflows also returns the company's forms (for the "Form submitted" trigger), and
// save_workflow refuses a form trigger whose form is not this company's.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runWorkflow, enrollCustomers } from '../_shared/workflow-engine.ts';
import { PREBUILT, resolveSegmentRef } from '../_shared/segments-prebuilt.ts';
import { resolveAudience } from '../_shared/segmentAudience.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const WORKFLOW_FIELDS = ['name', 'description', 'status', 'entry_trigger', 'segment_id', 'steps'];

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return true;
  const { data: prof } = await sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin';
}
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await sb.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}
const engineOpts = (now?: string) => ({ today: new Date().toISOString().slice(0, 10), supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, now });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const org_id = await orgFor(ops);
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  if (action === 'list_workflows') {
    const [{ data: workflows }, { data: segments }, { data: offers }, formsRes, { data: venues }] = await Promise.all([
      sb.from('workflows').select('*').eq('org_id', org_id).order('created_at', { ascending: false }),
      sb.from('segments').select('id, name').eq('org_id', org_id).order('name'),
      sb.from('offers').select('id, name, per_customer_limit').eq('org_id', org_id).eq('active', true).order('name'),
      // The forms table may not be there yet (SQL not run): no forms, never an error.
      sb.from('marketing_forms').select('id, name, status').eq('org_id', org_id).neq('status', 'archived').order('name'),
      sb.from('locations').select('id, name').eq('org_id', org_id).order('name').limit(200),
    ]);
    return json({ workflows: workflows ?? [], segments: segments ?? [], offers: offers ?? [], forms: formsRes?.data ?? [], venues: venues ?? [], prebuilt: PREBUILT });
  }

  if (action === 'save_workflow') {
    const incoming = body.workflow || {};
    const row: Record<string, unknown> = { org_id, updated_at: new Date().toISOString() };
    for (const k of WORKFLOW_FIELDS) if (k in incoming) row[k] = incoming[k];
    if (incoming.id) row.id = incoming.id;
    if (!row.name) return json({ error: 'name required' }, 400);
    // 5.12.40: an id means "update MY automation" (same rule as save_offer since review round four):
    // upserting on a caller's id let one company overwrite another company's automation.
    if (incoming.id) {
      const { data: mine } = await sb.from('workflows').select('id').eq('id', String(incoming.id)).eq('org_id', org_id).maybeSingle();
      if (!mine) return json({ error: 'automation not found' }, 404);
    }
    const trig = row.entry_trigger as any;
    if (trig && typeof trig === 'object' && trig.type === 'form_submitted') {
      const fid = String(trig.form_id ?? '').trim();
      if (!fid) return json({ error: 'Pick the form that starts this automation.' }, 400);
      const { data: form } = await sb.from('marketing_forms').select('id').eq('id', fid).eq('org_id', org_id).maybeSingle();
      if (!form) return json({ error: 'That form is not one of yours.' }, 400);
      row.entry_trigger = { type: 'form_submitted', form_id: fid };
    }
    // Guarantee every step has a UNIQUE key — the engine keys per-step idempotency on (enrollment, step_key),
    // so a duplicate/missing key would make one step silently overwrite/skip another.
    if (Array.isArray(row.steps)) {
      const seen = new Set<string>();
      row.steps = (row.steps as any[]).map((st, i) => {
        let key = String(st?.key || '').trim();
        if (!key || seen.has(key)) key = `s${i}_${crypto.randomUUID().slice(0, 8)}`;
        seen.add(key);
        return { ...st, key };
      });
    }
    // Persist any prebuilt audience picked for the segment filter or a segment entry trigger.
    if ('segment_id' in row) row.segment_id = await resolveSegmentRef(sb, org_id, row.segment_id);
    if (row.entry_trigger && typeof row.entry_trigger === 'object' && (row.entry_trigger as any).segment_id) {
      (row.entry_trigger as any).segment_id = await resolveSegmentRef(sb, org_id, (row.entry_trigger as any).segment_id);
    }
    const { data, error } = await sb.from('workflows').upsert(row, { onConflict: 'id' }).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, workflow: data });
  }

  if (action === 'set_status') {
    const id = String(body.id ?? '').trim();
    const status = String(body.status ?? '').trim();
    if (!id || !['draft', 'active', 'paused', 'archived'].includes(status)) return json({ error: 'id + valid status required' }, 400);
    const { error } = await sb.from('workflows').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'delete_workflow') {
    const id = String(body.id ?? '').trim();
    if (!id) return json({ error: 'id required' }, 400);
    const { error } = await sb.from('workflows').delete().eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'run_now') {
    const { data: wf } = await sb.from('workflows').select('*').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (!wf) return json({ error: 'workflow not found' }, 404);
    const summary = await runWorkflow(sb, wf, engineOpts(body.now));
    return json({ ok: true, summary });
  }

  if (action === 'enroll') {
    const { data: wf } = await sb.from('workflows').select('*').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (!wf) return json({ error: 'workflow not found' }, 404);
    let ids: string[] = Array.isArray(body.customer_ids) ? body.customer_ids.map(String) : [];
    if (ids.length) {
      // Only enrol real customers in THIS org — drop fabricated or foreign-org UUIDs.
      const { data: valid } = await sb.from('customers').select('id').eq('org_id', org_id).is('deleted_at', null).in('id', ids);
      ids = (valid ?? []).map((r: any) => r.id);
    } else if (body.segment_id) {
      const { data: seg } = await sb.from('segments').select('definition').eq('id', String(body.segment_id)).eq('org_id', org_id).maybeSingle();
      if (seg) ids = await resolveAudience(sb, org_id, seg.definition, null);   // 5.12.67: shared resolver, every row
    }
    const r = await enrollCustomers(sb, wf, ids, engineOpts(body.now));
    return json({ ok: true, enrolled: r.enrolled, already_enrolled: r.skipped, candidates: ids.length });
  }

  if (action === 'list_enrollments') {
    const wid = String(body.workflow_id ?? '').trim();
    const head = (q: any) => q.then((r: any) => r.count ?? 0);
    const [active, completed, { data: sends }] = await Promise.all([
      head(sb.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('org_id', org_id).eq('workflow_id', wid).eq('status', 'active')),
      head(sb.from('workflow_enrollments').select('id', { count: 'exact', head: true }).eq('org_id', org_id).eq('workflow_id', wid).eq('status', 'completed')),
      sb.from('workflow_step_sends').select('step_key, channel, status, promo_code, created_at').eq('org_id', org_id).eq('workflow_id', wid).order('created_at', { ascending: false }).limit(50),
    ]);
    return json({ active, completed, sends: sends ?? [] });
  }

  return json({ error: 'unknown action' }, 400);
});
