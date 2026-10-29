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
import { deliverBatch } from './marketingDeliver.ts';
import { chunk, claimDecision, outOfTime, sendOutcome, runStalled, EMAIL_BATCH, SMS_BATCH, RESEND_BATCH_GAP_MS, DEFAULT_BUDGET_MS } from './campaignBatch.js';

type SB = ReturnType<typeof import('https://esm.sh/@supabase/supabase-js@2').createClient>;

export interface RunOpts {
  today: string;            // 'YYYY-MM-DD' (UTC) — drives run_key + birthday occurrence
  supabaseUrl: string;
  serviceRole: string;
  force?: boolean;          // ignore the per-day run claim (BO "run now")
  deadlineMs?: number;      // 29 Oct 2026 (v5.11.117): stop sending after this long and leave the rest pending under this run
  resumeRunId?: string | null;   // continue an earlier time boxed run instead of claiming a new one
}

export interface RunSummary {
  campaign_id: string; run_key: string; status: string;
  candidates: number; sent: number; skipped: number; failed: number; error?: string;
  remaining?: number;       // v5.11.117: recipients left pending when the run was time boxed
  run_id?: string | null;
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
  // 28 Sep 2026: marketing_resolve_segment RETURNS TABLE, and the API hands back at most 1,000 rows
  // per request, so every audience stopped at 1,000 (Coffee Boy: 2,898 email subscribers, 8,030
  // customers) and a campaign reached only the first 1,000. Page it, in a fixed order, to the end.
  const PAGE = 1000;
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.rpc('marketing_resolve_segment', { p_org: org, p_def: def, p_limit: null })
      .order('customer_id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`resolve: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows as any[]) out.push(r.customer_id);
    if (rows.length < PAGE) break;
  }
  return out;
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
  if (opts.resumeRunId) {
    // v5.11.117: a continuation of a time boxed run. Its counts so far carry on.
    const { data: run } = await sb.from('campaign_runs').select('id, sent, skipped, failed, candidates').eq('id', opts.resumeRunId).eq('campaign_id', campaign.id).maybeSingle();
    if (!run) { summary.status = 'error'; summary.error = 'run to resume not found'; return summary; }
    runId = run.id; summary.sent = Number(run.sent || 0); summary.skipped = Number(run.skipped || 0); summary.failed = Number(run.failed || 0);
  } else if (!opts.force) {
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
    //
    // v5.5.946: a ONE-OFF campaign's audience is its segment, full stop. The campaign
    // editor used to persist a leftover automation trigger (e.g. birthday days_before:7)
    // on one_off rows, and the intersection silently shrank the audience to ~zero — the
    // live "sent to my segment, nobody got it" case ran 'done' with candidates:0 and no
    // explanation. Trigger rules only mean something on automations.
    let ids: string[];
    const effectiveRule = campaign.type === 'one_off' ? null : rule;
    if (effectiveRule) {
      ids = await resolveIds(sb, org, effectiveRule);
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

    // 29 Oct 2026 (v5.11.117): claimed in bulk, sent in batches, time boxed. The per recipient HTTP
    // call to marketing-send is gone (the gateway rate limited it and the run overran the wall clock
    // on the first big audience). See _shared/campaignBatch.js for the rules.
    const startedMs = Date.now();
    const budgetMs = Math.max(10_000, Number(opts.deadlineMs ?? DEFAULT_BUDGET_MS));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Work = { id: string; customer_id: string; promo_code: string | null };
    const work: Work[] = [];
    for (const part of chunk(ids, 500)) {
      const rows = part.map((customerId: string) => ({ org_id: org, campaign_id: campaign.id, run_id: runId, customer_id: customerId, dedupe_key: dedupeKey, channel: campaign.channel, status: 'pending' }));
      // ON CONFLICT DO NOTHING returns only the rows it inserted: those are claimed by this run.
      const { data: claimed } = await sb.from('campaign_sends')
        .upsert(rows, { onConflict: 'campaign_id,customer_id,dedupe_key', ignoreDuplicates: true })
        .select('id, customer_id');
      const got = new Set((claimed ?? []).map((r: any) => r.customer_id));
      for (const r of claimed ?? []) work.push({ id: r.id, customer_id: r.customer_id, promo_code: null });
      const missing = part.filter((c: string) => !got.has(c));
      if (missing.length) {
        const { data: ex } = await sb.from('campaign_sends').select('id, customer_id, status, promo_code, created_at, run_id')
          .eq('campaign_id', campaign.id).eq('dedupe_key', dedupeKey).in('customer_id', missing);
        const nowMs = Date.now();
        const reclaim = (ex ?? []).filter((r: any) => claimDecision(r, { ownRunId: runId, nowMs }) === 'reclaim');
        if (reclaim.length) {
          await sb.from('campaign_sends').update({ run_id: runId, status: 'pending', error: null }).in('id', reclaim.map((r: any) => r.id));
          for (const r of reclaim) work.push({ id: r.id, customer_id: r.customer_id, promo_code: r.promo_code || null });   // reuse an issued code (no leak on retry)
        }
        if (!opts.resumeRunId) summary.skipped += (ex ?? []).length - reclaim.length;   // terminal rows: already sent or skipped
      }
    }

    const batchSize = campaign.channel === 'sms' ? SMS_BATCH : EMAIL_BATCH;
    let remaining = work.length;
    for (const part of chunk(work, batchSize)) {
      if (outOfTime(startedMs, Date.now(), budgetMs)) break;
      // one unique code per recipient when an offer is attached; persisted at once so a retry reuses it
      for (const w of part) {
        if (offer && !w.promo_code) {
          w.promo_code = await issueCode(sb, campaign, offer, w.customer_id);
          if (w.promo_code) await sb.from('campaign_sends').update({ promo_code: w.promo_code }).eq('id', w.id);
        }
      }
      const variants = Array.isArray(campaign.variants) ? campaign.variants.filter((v: any) => v && v.subject) : [];
      const recips = part.map((w) => {
        let variantKey: string | null = null, subject: string | null = campaign.subject || null;
        if (variants.length >= 2) {
          const idx = Math.min(Math.floor((hashInt(`${w.customer_id}:${campaign.id}`) / 4294967296) * variants.length), variants.length - 1);
          variantKey = variants[idx].key || null; subject = variants[idx].subject || campaign.subject;
        }
        return { w, variantKey, subject, merge: { promo_code: w.promo_code || '', offer: offer?.reward_label || '' } };
      });
      const perCustomer = new Map<string, { emailMid?: string | null; smsMid?: string | null; results: { ok: boolean; status: string }[] }>();
      for (const ch of channels) {
        const results = await deliverBatch(sb, {
          org_id: org, channel: ch, campaign_id: campaign.id,
          subject: campaign.subject, html: campaign.email_html, sms_body: campaign.sms_body,
          recipients: recips.map((r) => ({ customer_id: r.w.customer_id, idempotency_key: `c:${campaign.id}:${r.w.customer_id}:${dedupeKey}:${ch}`, merge: r.merge, promo_code: r.w.promo_code, subject: r.subject })),
        });
        for (const r of results) {
          const s = perCustomer.get(r.customer_id) || { results: [] };
          if (ch === 'email') s.emailMid = r.message_id || null; else s.smsMid = r.message_id || null;
          s.results.push({ ok: !!r.ok, status: r.status });
          perCustomer.set(r.customer_id, s);
        }
      }
      await mapPool(part, SEND_CONCURRENCY, async (w) => {
        const s = perCustomer.get(w.customer_id) || { results: [{ ok: false, status: 'failed' }] };
        const status = sendOutcome(s.results);
        const variantKey = recips.find((r) => r.w.customer_id === w.customer_id)?.variantKey ?? null;
        await sb.from('campaign_sends').update({ status, run_id: runId, promo_code: w.promo_code, email_message_id: s.emailMid || null, sms_message_id: s.smsMid || null, variant_key: variantKey, error: status === 'failed' ? 'provider refused the batch' : null }).eq('id', w.id);
        if (status === 'sent' || status === 'partial') summary.sent++; else if (status === 'failed') summary.failed++; else summary.skipped++;
      });
      remaining -= part.length;
      await sleep(RESEND_BATCH_GAP_MS);   // Resend allows two requests a second
    }
    summary.remaining = remaining;
    summary.run_id = runId;
    if (remaining > 0) {
      // Time boxed: the unsent rows stay 'pending' under this run. The caller continues it at once
      // (marketing-campaigns blast_continue) and the hourly cron resumes a run that stalled.
      await sb.from('campaign_runs').update({ status: 'running', candidates: summary.candidates, sent: summary.sent, skipped: summary.skipped, failed: summary.failed, error: `time boxed: ${remaining} still to send` }).eq('id', runId);
      summary.status = 'running';
      return summary;
    }

    summary.status = 'done';
    // v5.5.946: a zero-recipient run must SAY SO — 'done, 0' with no explanation is how
    // the birthday-trigger audience kill went unnoticed. The note rides in run.error
    // (nullable text) without changing status semantics.
    if (summary.candidates === 0) {
      summary.error = 'No recipients matched at send time — check the audience segment, and that members have contact details + marketing consent.';
    }
    await sb.from('campaign_runs').update({ status: 'done', candidates: summary.candidates, sent: summary.sent, skipped: summary.skipped, failed: summary.failed, error: summary.error ?? null, finished_at: new Date().toISOString() }).eq('id', runId);
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

// 29 Oct 2026 (v5.11.117): a time boxed run whose continuation never came (the function died, a
// deploy in between) is picked up by the hourly cron. Only runs that still have pending rows.
export async function resumeStalledRuns(sb: SB, opts: RunOpts): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  const { data: runs } = await sb.from('campaign_runs').select('id, campaign_id, status, run_at, finished_at').eq('status', 'running').order('run_at', { ascending: true }).limit(10);
  for (const run of runs ?? []) {
    if (!runStalled(run)) continue;
    const { count } = await sb.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('run_id', run.id).eq('status', 'pending');
    if (!count) {
      await sb.from('campaign_runs').update({ status: 'done', finished_at: new Date().toISOString(), error: null }).eq('id', run.id);
      continue;
    }
    const { data: c } = await sb.from('campaigns').select('*').eq('id', run.campaign_id).maybeSingle();
    if (!c) continue;
    // Peter, 29 Oct 2026: "a quick send has no schedule". A quick send (ephemeral campaign) that stopped
    // short is only ever continued by a person, through Continue sending in Quick send. The hour job
    // closes its run so nothing picks it up later; its pending rows stay and the button reclaims them.
    if (c.ephemeral === true) {
      await sb.from('campaign_runs').update({ status: 'error', finished_at: new Date().toISOString(), error: 'stopped short: a quick send is only continued by Continue sending in Quick send' }).eq('id', run.id).eq('status', 'running');
      continue;
    }
    out.push(await runCampaign(sb, c, { ...opts, force: true, resumeRunId: run.id }));
  }
  return out;
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
