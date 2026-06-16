// _shared/campaign-engine.ts — slice 4 campaign/trigger engine core.
// Shared by marketing-run (cron) and marketing-campaigns (BO "run now"). One campaign run:
//   1. claim the run (campaign_runs unique (campaign_id, run_key)) → idempotent per day-window,
//   2. resolve candidates (trigger rule ∩ optional segment) via marketing_resolve_segment,
//   3. per candidate: claim a send row FIRST (campaign_sends unique (campaign,customer,dedupe_key)) →
//      "never twice"; then issue a unique promo code (if an offer is attached) and call marketing-send
//      (which enforces consent/suppression/sandbox), then finalise the send row.
//
// All money/consent/deliverability concerns live in marketing-send; this file orchestrates only.

import { genCode } from './promo.ts';

type SB = ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>;

export interface RunOpts {
  today: string;            // 'YYYY-MM-DD' (UTC) — drives run_key + birthday occurrence
  supabaseUrl: string;
  serviceRole: string;
  force?: boolean;          // ignore the per-day run claim (BO "run now")
}

export interface RunSummary {
  campaign_id: string; run_key: string; status: string;
  candidates: number; sent: number; skipped: number; failed: number; error?: string;
}

// Build the trigger's audience rule + the dedupe/run keys for this campaign+day.
function triggerContext(campaign: any, today: string): { rule: any | null; runKey: string; dedupeKey: string } {
  const t = campaign.trigger || {};
  const type = String(t.type || (campaign.type === 'one_off' ? 'manual' : 'birthday'));
  if (type === 'birthday') {
    const daysBefore = Number(t.days_before ?? 7);
    const occ = new Date(today + 'T00:00:00Z');
    occ.setUTCDate(occ.getUTCDate() + daysBefore);
    return {
      rule: { match: 'all', rules: [{ field: 'birthday_in_days', op: 'eq', value: daysBefore }] },
      runKey: `birthday:${today}`,
      dedupeKey: `bday:${occ.getUTCFullYear()}`,
    };
  }
  if (type === 'lapsed') {
    const days = Number(t.days ?? 30);
    return {
      rule: { match: 'all', rules: [{ field: 'days_since_visit', op: 'gte', value: days }] },
      runKey: `lapsed:${today}`,
      dedupeKey: `lapsed:${today.slice(0, 7)}`,   // once per calendar month
    };
  }
  // manual / one_off / date — audience is the segment; runs once.
  return { rule: null, runKey: `${type}:${today}`, dedupeKey: `oneoff:${campaign.id}` };
}

async function resolveIds(sb: SB, org: string, def: any): Promise<string[]> {
  if (!def) return [];
  const { data, error } = await sb.rpc('marketing_resolve_segment', { p_org: org, p_def: def, p_limit: null });
  if (error) throw new Error(`resolve: ${error.message}`);
  return (data ?? []).map((r: any) => r.customer_id);
}

// Issue a unique single-use promo code for a customer against the campaign's offer.
async function issueCode(sb: SB, campaign: any, offer: any, customerId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode(offer.code_prefix || '', offer.code_length || 5);
    const { data, error } = await sb.from('promo_codes').insert({
      offer_id: offer.id, org_id: campaign.org_id, code, customer_id: customerId,
      uses_allowed: 1, expires_at: offer.valid_to || null, status: 'issued',
      campaign_id: campaign.id,
    }).select('code').maybeSingle();
    if (!error && data) return data.code;
  }
  return null;
}

async function sendOne(opts: RunOpts, org: string, campaignId: string, channel: 'email' | 'sms',
  customerId: string, content: { subject?: string; html?: string; sms?: string }, merge: Record<string, unknown>,
  promoCode: string | null, dedupeKey: string): Promise<{ ok: boolean; status: string; message_id?: string }> {
  const res = await fetch(`${opts.supabaseUrl}/functions/v1/marketing-send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.serviceRole}` },
    body: JSON.stringify({
      action: 'send', org_id: org, channel,
      to: { customer_id: customerId },
      subject: content.subject, html: content.html, sms_body: content.sms,
      merge, campaign_id: campaignId, promo_code: promoCode || undefined,
      idempotency_key: `c:${campaignId}:${customerId}:${dedupeKey}:${channel}`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: !!j.ok, status: j.status || (res.ok ? 'sent' : 'failed'), message_id: j.message_id };
}

export async function runCampaign(sb: SB, campaign: any, opts: RunOpts): Promise<RunSummary> {
  const org = campaign.org_id;
  const { rule, runKey, dedupeKey } = triggerContext(campaign, opts.today);
  const summary: RunSummary = { campaign_id: campaign.id, run_key: runKey, status: 'running', candidates: 0, sent: 0, skipped: 0, failed: 0 };

  // 1. Claim the run (idempotent per day-window) unless forced.
  let runId: string | null = null;
  if (!opts.force) {
    const { data: run } = await sb.from('campaign_runs')
      .upsert({ org_id: org, campaign_id: campaign.id, run_key: runKey, status: 'running' }, { onConflict: 'campaign_id,run_key', ignoreDuplicates: true })
      .select('id').maybeSingle();
    if (!run) { summary.status = 'skipped'; return summary; }   // already ran this window
    runId = run.id;
  } else {
    const { data: run } = await sb.from('campaign_runs').insert({ org_id: org, campaign_id: campaign.id, run_key: `${runKey}:force:${new Date().toISOString()}`, status: 'running' }).select('id').maybeSingle();
    runId = run?.id ?? null;
  }

  try {
    // 2. Resolve candidates: trigger rule ∩ optional segment.
    let ids: string[];
    if (rule) {
      ids = await resolveIds(sb, org, rule);
      if (campaign.segment_id) {
        const { data: seg } = await sb.from('segments').select('definition').eq('id', campaign.segment_id).eq('org_id', org).maybeSingle();
        const segIds = new Set(await resolveIds(sb, org, seg?.definition));
        ids = ids.filter((id) => segIds.has(id));
      }
    } else {
      const { data: seg } = await sb.from('segments').select('definition').eq('id', campaign.segment_id).eq('org_id', org).maybeSingle();
      ids = seg ? await resolveIds(sb, org, seg.definition) : [];
    }
    summary.candidates = ids.length;

    // optional offer (one unique code per recipient)
    let offer: any = null;
    if (campaign.offer_id) {
      const { data } = await sb.from('offers').select('*').eq('id', campaign.offer_id).eq('org_id', org).maybeSingle();
      offer = data;
    }

    const channels: ('email' | 'sms')[] = campaign.channel === 'both' ? ['email', 'sms'] : [campaign.channel];

    for (const customerId of ids) {
      // 3. Claim the send FIRST → never twice.
      const { data: claimed } = await sb.from('campaign_sends')
        .upsert({ org_id: org, campaign_id: campaign.id, run_id: runId, customer_id: customerId, dedupe_key: dedupeKey, channel: campaign.channel, status: 'pending' },
          { onConflict: 'campaign_id,customer_id,dedupe_key', ignoreDuplicates: true })
        .select('id').maybeSingle();
      if (!claimed) { summary.skipped++; continue; }   // already handled this occurrence

      try {
        const promoCode = offer ? await issueCode(sb, campaign, offer, customerId) : null;
        const merge = { promo_code: promoCode || '', offer: offer?.reward_label || '' };
        let emailMid: string | undefined, smsMid: string | undefined, anyOk = false, anyFail = false;
        for (const ch of channels) {
          const r = await sendOne(opts, org, campaign.id, ch, customerId,
            { subject: campaign.subject, html: campaign.email_html, sms: campaign.sms_body }, merge, promoCode, dedupeKey);
          if (ch === 'email') emailMid = r.message_id; else smsMid = r.message_id;
          if (r.ok) anyOk = true; else anyFail = true;
        }
        const status = anyOk && anyFail ? 'partial' : anyOk ? 'sent' : 'skipped';
        await sb.from('campaign_sends').update({ status, promo_code: promoCode, email_message_id: emailMid || null, sms_message_id: smsMid || null }).eq('id', claimed.id);
        if (anyOk) summary.sent++; else summary.skipped++;
      } catch (e) {
        await sb.from('campaign_sends').update({ status: 'failed', error: String(e instanceof Error ? e.message : e).slice(0, 400) }).eq('id', claimed.id);
        summary.failed++;
      }
    }

    summary.status = 'done';
    await sb.from('campaign_runs').update({ status: 'done', candidates: summary.candidates, sent: summary.sent, skipped: summary.skipped, failed: summary.failed, finished_at: new Date().toISOString() }).eq('id', runId);
    await sb.from('campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', campaign.id);
  } catch (e) {
    summary.status = 'error'; summary.error = String(e instanceof Error ? e.message : e);
    await sb.from('campaign_runs').update({ status: 'error', error: summary.error.slice(0, 500), finished_at: new Date().toISOString() }).eq('id', runId);
  }
  return summary;
}

// Run all active automations (the daily cron entry).
export async function runDueCampaigns(sb: SB, opts: RunOpts): Promise<RunSummary[]> {
  const { data: campaigns } = await sb.from('campaigns').select('*').eq('status', 'active').eq('type', 'automation');
  const out: RunSummary[] = [];
  for (const c of campaigns ?? []) out.push(await runCampaign(sb, c, opts));
  return out;
}
