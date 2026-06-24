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

// Stable 32-bit FNV-1a hash → deterministic A/B variant assignment (no Math.random, so a recipient
// always lands in the same bucket across reruns; salted by campaign id so buckets don't correlate
// across different A/B tests).
function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ISO-8601 week string (YYYY-Www) for recurring weekly dedupe.
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((((date.getTime() - firstThursday.getTime()) / 86400000) - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Whether a recurring campaign should fire in the current hour (gated; dedupe makes it fire once/period).
export function recurringDueNow(campaign: any, opts: RunOpts): boolean {
  const t = campaign.trigger || {};
  const now = new Date(opts.now || new Date().toISOString());
  if (now.getUTCHours() < Number(t.hour ?? 9)) return false;
  if (t.recurrence === 'monthly') return now.getUTCDate() === Number(t.monthday ?? 1);
  return now.getUTCDay() === Number(t.weekday ?? 1);   // weekly (default): 1 = Monday
}

// Forecast trigger (#6): fire when actual sales are below threshold_pct of forecast, at/after the cutoff.
// scope 'day' = today's forecast vs sales-so-far; 'week' = week-to-date (only on the cutoff weekday).
// UTC day boundaries (venue-timezone refinement is a future enhancement).
export async function forecastDueNow(sb: SB, campaign: any, opts: RunOpts): Promise<boolean> {
  const t = campaign.trigger || {};
  const now = new Date(opts.now || new Date().toISOString());
  const scope = t.scope === 'week' ? 'week' : 'day';
  if (scope === 'week' && now.getUTCDay() !== Number(t.cutoff_weekday ?? 3)) return false;  // default Wednesday
  if (now.getUTCHours() < Number(t.cutoff_hour ?? 14)) return false;
  const todayStr = (opts.now || now.toISOString()).slice(0, 10);
  let startDate = todayStr;
  if (scope === 'week') {
    const d = new Date(todayStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;  // 0 = Mon
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow); startDate = mon.toISOString().slice(0, 10);
  }
  const { data: fc } = await sb.from('wf_sales_forecast').select('amount').eq('org_id', campaign.org_id).gte('forecast_date', startDate).lte('forecast_date', todayStr);
  const forecast = (fc ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
  if (forecast <= 0) return false;   // no forecast set for the period → never fire
  const { data: actual } = await sb.rpc('marketing_period_sales', { p_org: campaign.org_id, p_start: `${startDate}T00:00:00Z`, p_end: now.toISOString() });
  return (Number(actual || 0) / forecast) * 100 < Number(t.threshold_pct ?? 60);
}

// Build the trigger's audience rule + the dedupe/run keys for this campaign+day.
function triggerContext(campaign: any, today: string): { rule: any | null; runKey: string; dedupeKey: string } {
  const t = campaign.trigger || {};
  const type = String(t.type || (campaign.type === 'one_off' ? 'manual' : 'birthday'));
  if (type === 'recurring') {
    const period = t.recurrence === 'monthly' ? today.slice(0, 7) : isoWeek(new Date(today + 'T00:00:00Z'));
    return { rule: null, runKey: `recurring:${period}`, dedupeKey: `recurring:${period}` };  // audience = segment, once/period
  }
  if (type === 'forecast') {
    const period = t.scope === 'week' ? isoWeek(new Date(today + 'T00:00:00Z')) : today;
    return { rule: null, runKey: `forecast:${period}`, dedupeKey: `forecast:${period}` };   // audience = segment, once/period
  }
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

// Bounded-concurrency map: run `fn` over `items` with at most `concurrency` in flight. A blast used
// to dispatch strictly one recipient at a time — each await is a marketing-send round trip to
// Resend/Twilio (~200-800ms) — so a large audience (≈600+) overran the edge-function wall-clock
// limit and the run aborted mid-list. Each recipient is fully independent (its own race-safe claim
// row, its own idempotent send keyed per campaign+customer+channel), so a small pool is safe and
// raises the per-invocation ceiling ~Nx. Kept conservative to stay well under provider burst limits.
const SEND_CONCURRENCY = 6;
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  // next++ is synchronous (no await between the read and the increment) so each worker claims a
  // distinct index — no double-processing despite the shared cursor.
  const workers = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
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
        // If the segment was deleted, do NOT zero the audience — fall back to the trigger matches.
        if (seg) {
          const segIds = new Set(await resolveIds(sb, org, seg.definition));
          ids = ids.filter((id) => segIds.has(id));
        }
      }
    } else {
      // No trigger rule (one_off / manual): the segment IS the audience. A missing/deleted segment is an
      // explicit error, not a silent zero-send (so the operator can tell it apart from "0 matched").
      if (!campaign.segment_id) {
        summary.status = 'error'; summary.error = 'no audience: pick a segment for a one-off campaign';
        await sb.from('campaign_runs').update({ status: 'error', error: summary.error, finished_at: new Date().toISOString() }).eq('id', runId);
        return summary;
      }
      const { data: seg } = await sb.from('segments').select('definition').eq('id', campaign.segment_id).eq('org_id', org).maybeSingle();
      if (!seg) {
        summary.status = 'error'; summary.error = 'audience segment not found (deleted?)';
        await sb.from('campaign_runs').update({ status: 'error', error: summary.error, finished_at: new Date().toISOString() }).eq('id', runId);
        return summary;
      }
      ids = await resolveIds(sb, org, seg.definition);
    }
    // Audience exclusion: remove anyone in the exclusion segment (e.g. "everyone except VIPs").
    if (campaign.exclusion_segment_id) {
      const { data: ex } = await sb.from('segments').select('definition').eq('id', campaign.exclusion_segment_id).eq('org_id', org).maybeSingle();
      if (ex) { const exSet = new Set(await resolveIds(sb, org, ex.definition)); ids = ids.filter((id) => !exSet.has(id)); }
    }
    summary.candidates = ids.length;

    // optional offer (one unique code per recipient)
    let offer: any = null;
    if (campaign.offer_id) {
      const { data } = await sb.from('offers').select('*').eq('id', campaign.offer_id).eq('org_id', org).maybeSingle();
      offer = data;
    }

    const channels: ('email' | 'sms')[] = campaign.channel === 'both' ? ['email', 'sms'] : [campaign.channel];

    // Dispatch recipients with bounded concurrency (was strictly sequential — see mapPool). Each
    // iteration's claim→send→update is independent and race-safe, so the pool can't double-send.
    await mapPool(ids, SEND_CONCURRENCY, async (customerId) => {
      // 3. Claim the send FIRST → never twice. On conflict, reclaim only an ORPHANED row: a failed
      // attempt, or a 'pending' older than 5 min (a crashed run). A FRESH 'pending' means a concurrent
      // run owns it → skip (no double-send). A terminal success (sent/partial/skipped) is never resent.
      let claimedId: string | null = null;
      let reuseCode: string | null = null;
      const { data: claimed } = await sb.from('campaign_sends')
        .upsert({ org_id: org, campaign_id: campaign.id, run_id: runId, customer_id: customerId, dedupe_key: dedupeKey, channel: campaign.channel, status: 'pending' },
          { onConflict: 'campaign_id,customer_id,dedupe_key', ignoreDuplicates: true })
        .select('id').maybeSingle();
      if (claimed) {
        claimedId = claimed.id;
      } else {
        const { data: ex } = await sb.from('campaign_sends').select('id, status, promo_code, created_at')
          .eq('campaign_id', campaign.id).eq('customer_id', customerId).eq('dedupe_key', dedupeKey).maybeSingle();
        const stalePending = ex?.status === 'pending' && (Date.now() - new Date(ex.created_at).getTime() > 5 * 60 * 1000);
        if (ex && (ex.status === 'failed' || stalePending)) {
          claimedId = ex.id; reuseCode = ex.promo_code || null;   // reuse an already-issued code (no leak on retry)
          await sb.from('campaign_sends').update({ run_id: runId, status: 'pending', error: null }).eq('id', claimedId);
        } else { summary.skipped++; return; }
      }

      try {
        // Reuse a code already issued for this send; only mint a new one if none exists. Persist it
        // immediately so a later retry reuses it rather than issuing another.
        let promoCode = reuseCode;
        if (offer && !promoCode) { promoCode = await issueCode(sb, campaign, offer, customerId); if (promoCode) await sb.from('campaign_sends').update({ promo_code: promoCode }).eq('id', claimedId); }
        const merge = { promo_code: promoCode || '', offer: offer?.reward_label || '' };
        // A/B subject split (email-only): pick a variant deterministically per (customer, campaign).
        const variants = Array.isArray(campaign.variants) ? campaign.variants.filter((v: any) => v && v.subject) : [];
        let variantKey: string | null = null;
        let subjectForRecipient = campaign.subject;
        if (variants.length >= 2) {
          // Reduce via the well-mixed high bits (NOT % n: the FNV multiply preserves low bits, so a
          // mod-2 split would degenerate to character-parity and ignore the campaign salt).
          const idx = Math.min(Math.floor((hashInt(`${customerId}:${campaign.id}`) / 4294967296) * variants.length), variants.length - 1);
          const v = variants[idx];
          variantKey = v.key || null;
          subjectForRecipient = v.subject || campaign.subject;
        }
        let emailMid: string | undefined, smsMid: string | undefined, anyOk = false, anyFail = false;
        for (const ch of channels) {
          const r = await sendOne(opts, org, campaign.id, ch, customerId,
            { subject: subjectForRecipient, html: campaign.email_html, sms: campaign.sms_body }, merge, promoCode, dedupeKey);
          if (ch === 'email') emailMid = r.message_id; else smsMid = r.message_id;
          if (r.ok) anyOk = true; else anyFail = true;
        }
        const status = anyOk && anyFail ? 'partial' : anyOk ? 'sent' : 'skipped';
        await sb.from('campaign_sends').update({ status, run_id: runId, promo_code: promoCode, email_message_id: emailMid || null, sms_message_id: smsMid || null, variant_key: variantKey }).eq('id', claimedId);
        if (anyOk) summary.sent++; else summary.skipped++;
      } catch (e) {
        // The recovery write is itself guarded — a transient failure here must NOT abort the run or
        // orphan the row permanently (a 'failed'/stale-'pending' row is reclaimable on a later run).
        try { await sb.from('campaign_sends').update({ status: 'failed', error: String(e instanceof Error ? e.message : e).slice(0, 400) }).eq('id', claimedId); } catch (_e2) { /* swallow; reclaimable */ }
        summary.failed++;
      }
    });

    summary.status = 'done';
    await sb.from('campaign_runs').update({ status: 'done', candidates: summary.candidates, sent: summary.sent, skipped: summary.skipped, failed: summary.failed, finished_at: new Date().toISOString() }).eq('id', runId);
    await sb.from('campaigns').update({ last_run_at: new Date().toISOString() }).eq('id', campaign.id);
  } catch (e) {
    summary.status = 'error'; summary.error = String(e instanceof Error ? e.message : e);
    // Best-effort: a run that aborted mid-loop may have left 'pending' rows — mark them failed (guarded)
    // so reports show no unexplained 'pending' and the occurrences stay reclaimable.
    try { await sb.from('campaign_sends').update({ status: 'failed', error: 'run aborted' }).eq('run_id', runId).eq('status', 'pending'); } catch (_e2) { /* swallow */ }
    await sb.from('campaign_runs').update({ status: 'error', error: summary.error.slice(0, 500), finished_at: new Date().toISOString() }).eq('id', runId);
  }
  return summary;
}

// Run all active automations (the daily cron entry).
export async function runDueCampaigns(sb: SB, opts: RunOpts): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  // Active automations (birthday/lapsed/recurring). Recurring only fires inside its weekly/monthly window.
  const { data: autos } = await sb.from('campaigns').select('*').eq('status', 'active').eq('type', 'automation');
  for (const c of autos ?? []) {
    if (c.trigger?.type === 'recurring' && !recurringDueNow(c, opts)) continue;
    if (c.trigger?.type === 'forecast' && !(await forecastDueNow(sb, c, opts))) continue;
    out.push(await runCampaign(sb, c, opts));
  }
  // Scheduled one-offs whose send_at has arrived → run once, then archive.
  const nowIso = opts.now || new Date().toISOString();
  const { data: sched } = await sb.from('campaigns').select('*').eq('status', 'scheduled');
  for (const c of sched ?? []) {
    if (c.schedule?.send_at && String(c.schedule.send_at) <= nowIso) {
      out.push(await runCampaign(sb, c, opts));
      await sb.from('campaigns').update({ status: 'archived', updated_at: nowIso }).eq('id', c.id);
    }
  }
  return out;
}
