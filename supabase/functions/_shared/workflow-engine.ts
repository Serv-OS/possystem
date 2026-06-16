// _shared/workflow-engine.ts — slice 6 drip / workflow engine.
// Shared by marketing-run (cron) and marketing-workflows (BO run_now). Two phases per active workflow:
//   1. ENROLL customers matching the entry trigger (idempotent: unique (workflow_id, customer_id)).
//   2. ADVANCE every active enrollment whose next step is due: send the step (issue a code if the step
//      has an offer), then schedule the next step or complete. Per-step idempotency via unique
//      (enrollment_id, step_key) with the same claim-first / reclaim / guarded-recovery model as slice 4.
// `opts.now` (ISO) overrides the clock so a drip can be fast-forwarded in tests; the cron omits it.

import { genCode } from './promo.ts';

type SB = ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>;

export interface WfOpts { today: string; supabaseUrl: string; serviceRole: string; now?: string; }
export interface WfSummary { workflow_id: string; name: string; enrolled: number; advanced: number; completed: number; skipped: number; failed: number; error?: string; }

const TERMINAL = ['sent', 'partial', 'skipped'];

async function resolveIds(sb: SB, org: string, def: any): Promise<string[]> {
  if (!def) return [];
  const { data, error } = await sb.rpc('marketing_resolve_segment', { p_org: org, p_def: def, p_limit: null });
  if (error) throw new Error(`resolve: ${error.message}`);
  return (data ?? []).map((r: any) => r.customer_id);
}

async function issueCode(sb: SB, org: string, offer: any, customerId: string): Promise<string | null> {
  for (let a = 0; a < 6; a++) {
    const code = genCode(offer.code_prefix || '', offer.code_length || 5);
    const { data, error } = await sb.from('promo_codes').insert({
      offer_id: offer.id, org_id: org, code, customer_id: customerId,
      uses_allowed: 1, expires_at: offer.valid_to || null, status: 'issued',
    }).select('code').maybeSingle();
    if (!error && data) return data.code;
  }
  return null;
}

async function sendOne(opts: WfOpts, org: string, channel: 'email' | 'sms', customerId: string,
  content: { subject?: string; html?: string; sms?: string }, merge: Record<string, unknown>, promoCode: string | null, idemKey: string) {
  const res = await fetch(`${opts.supabaseUrl}/functions/v1/marketing-send`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.serviceRole}` },
    body: JSON.stringify({ action: 'send', org_id: org, channel, to: { customer_id: customerId }, subject: content.subject, html: content.html, sms_body: content.sms, merge, promo_code: promoCode || undefined, idempotency_key: idemKey }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: !!j.ok, status: j.status || (res.ok ? 'sent' : 'failed'), message_id: j.message_id as string | undefined };
}

// Customers matching the entry trigger (+ optional global segment filter).
async function entryAudience(sb: SB, wf: any, opts: WfOpts): Promise<string[]> {
  const org = wf.org_id; const tr = wf.entry_trigger || {}; const type = tr.type || 'manual';
  let ids: string[] = [];
  if (type === 'signup') {
    const since = new Date(new Date(opts.now || new Date().toISOString()).getTime() - 2 * 86400000).toISOString();
    const { data } = await sb.from('customers').select('id').eq('org_id', org).is('deleted_at', null).gte('created_at', since);
    ids = (data ?? []).map((r: any) => r.id);
  } else if (type === 'birthday') {
    ids = await resolveIds(sb, org, { match: 'all', rules: [{ field: 'birthday_in_days', op: 'eq', value: Number(tr.days_before ?? 7) }] });
  } else if (type === 'segment') {
    const sid = tr.segment_id || wf.segment_id;
    if (sid) { const { data: seg } = await sb.from('segments').select('definition').eq('id', sid).eq('org_id', org).maybeSingle(); ids = seg ? await resolveIds(sb, org, seg.definition) : []; }
  } else { return []; }   // manual → only enrolled via the BO action
  if (wf.segment_id && type !== 'segment') {
    const { data: seg } = await sb.from('segments').select('definition').eq('id', wf.segment_id).eq('org_id', org).maybeSingle();
    if (seg) { const set = new Set(await resolveIds(sb, org, seg.definition)); ids = ids.filter((id) => set.has(id)); }
  }
  return ids;
}

// Enroll a set of customers into a workflow at step 0 (used by entry triggers + BO manual enroll).
export async function enrollCustomers(sb: SB, wf: any, customerIds: string[], opts: WfOpts): Promise<number> {
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  if (!steps.length) return 0;
  const nowMs = new Date(opts.now || new Date().toISOString()).getTime();
  const firstDue = new Date(nowMs + (Number(steps[0].after_days) || 0) * 86400000).toISOString();
  let n = 0;
  for (const cid of customerIds) {
    const { data: en } = await sb.from('workflow_enrollments')
      .upsert({ org_id: wf.org_id, workflow_id: wf.id, customer_id: cid, status: 'active', current_step: 0, next_run_at: firstDue }, { onConflict: 'workflow_id,customer_id', ignoreDuplicates: true })
      .select('id').maybeSingle();
    if (en) n++;
  }
  return n;
}

export async function runWorkflow(sb: SB, wf: any, opts: WfOpts): Promise<WfSummary> {
  const org = wf.org_id;
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const summary: WfSummary = { workflow_id: wf.id, name: wf.name, enrolled: 0, advanced: 0, completed: 0, skipped: 0, failed: 0 };
  if (!steps.length) return summary;
  const nowIso = opts.now || new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  const dueAt = (afterDays: any) => new Date(nowMs + (Number(afterDays) || 0) * 86400000).toISOString();

  const advance = async (enId: string, idx: number) => {
    const nextIdx = idx + 1;
    if (nextIdx >= steps.length) { await sb.from('workflow_enrollments').update({ current_step: nextIdx, status: 'completed', completed_at: nowIso }).eq('id', enId); summary.completed++; }
    else { await sb.from('workflow_enrollments').update({ current_step: nextIdx, next_run_at: dueAt(steps[nextIdx].after_days) }).eq('id', enId); }
  };

  // 1. ENROLL
  try { summary.enrolled = await enrollCustomers(sb, wf, await entryAudience(sb, wf, opts), opts); }
  catch (e) { summary.error = `enroll: ${e instanceof Error ? e.message : e}`; }

  // 2. ADVANCE due enrollments (one step per enrollment per run).
  const { data: due } = await sb.from('workflow_enrollments').select('*').eq('workflow_id', wf.id).eq('status', 'active').lte('next_run_at', nowIso).limit(1000);
  const offerCache: Record<string, any> = {};
  for (const en of due ?? []) {
    const idx = en.current_step;
    const step = steps[idx];
    if (!step) { await sb.from('workflow_enrollments').update({ status: 'completed', completed_at: nowIso }).eq('id', en.id); summary.completed++; continue; }
    const stepKey = step.key || `s${idx}`;

    const { data: existing } = await sb.from('workflow_step_sends').select('id, status, promo_code').eq('enrollment_id', en.id).eq('step_key', stepKey).maybeSingle();
    if (existing && TERMINAL.includes(existing.status)) { await advance(en.id, idx); continue; }   // already sent → just move on

    // claim / reclaim the step row
    let rowId: string | null = existing?.id || null;
    let reuseCode: string | null = existing?.promo_code || null;
    if (!existing) {
      const { data: c } = await sb.from('workflow_step_sends')
        .upsert({ org_id: org, workflow_id: wf.id, enrollment_id: en.id, customer_id: en.customer_id, step_key: stepKey, channel: step.channel, status: 'pending' }, { onConflict: 'enrollment_id,step_key', ignoreDuplicates: true })
        .select('id').maybeSingle();
      if (c) rowId = c.id;
      else { const { data: e2 } = await sb.from('workflow_step_sends').select('id, status, promo_code').eq('enrollment_id', en.id).eq('step_key', stepKey).maybeSingle();
        if (e2 && TERMINAL.includes(e2.status)) { await advance(en.id, idx); continue; } rowId = e2?.id || null; reuseCode = e2?.promo_code || null; }
    } else {
      await sb.from('workflow_step_sends').update({ status: 'pending', error: null }).eq('id', rowId);
    }

    try {
      let offer = offerCache[step.offer_id];
      if (step.offer_id && offer === undefined) { const { data } = await sb.from('offers').select('*').eq('id', step.offer_id).eq('org_id', org).maybeSingle(); offer = data; offerCache[step.offer_id] = data; }
      let promoCode = reuseCode;
      if (offer && !promoCode) { promoCode = await issueCode(sb, org, offer, en.customer_id); if (promoCode) await sb.from('workflow_step_sends').update({ promo_code: promoCode }).eq('id', rowId); }
      const merge = { promo_code: promoCode || '', offer: offer?.reward_label || '' };
      const channels: ('email' | 'sms')[] = step.channel === 'both' ? ['email', 'sms'] : [step.channel];
      let emailMid: string | undefined, smsMid: string | undefined, anyOk = false, anyFail = false;
      for (const ch of channels) {
        const r = await sendOne(opts, org, ch, en.customer_id, { subject: step.subject, html: step.email_html, sms: step.sms_body }, merge, promoCode, `w:${en.id}:${stepKey}:${ch}`);
        if (ch === 'email') emailMid = r.message_id; else smsMid = r.message_id;
        if (r.ok) anyOk = true; else anyFail = true;
      }
      const st = anyOk && anyFail ? 'partial' : anyOk ? 'sent' : 'skipped';
      await sb.from('workflow_step_sends').update({ status: st, promo_code: promoCode, email_message_id: emailMid || null, sms_message_id: smsMid || null }).eq('id', rowId);
      summary.advanced++;
      await advance(en.id, idx);     // only advance on a completed send → a failure is retried next run
    } catch (e) {
      try { await sb.from('workflow_step_sends').update({ status: 'failed', error: String(e instanceof Error ? e.message : e).slice(0, 400) }).eq('id', rowId); } catch (_e2) { /* reclaimable */ }
      summary.failed++;
    }
  }
  return summary;
}

export async function runWorkflows(sb: SB, opts: WfOpts): Promise<WfSummary[]> {
  const { data: wfs } = await sb.from('workflows').select('*').eq('status', 'active');
  const out: WfSummary[] = [];
  for (const wf of wfs ?? []) out.push(await runWorkflow(sb, wf, opts));
  return out;
}
