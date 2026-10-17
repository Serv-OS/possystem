// supabase/functions/msm-publish/index.ts
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): THE PUBLISH RUNNER. Writes the group menu into each
// venue's own rows and sends that venue's tills the same refresh as Push to POS, one venue at a
// time, one transaction per venue. Deployed with --no-verify-jwt: it checks the caller itself.
//
// Peter, 17 Oct 2026: "schedule menu push so we can add items then say these items need to be on
// the POS by X date and time". The person picks the time; this runs it with no screen open.
//
// WHO CALLS IT
//   pg_cron   job msm-run-due, every minute, through public.msm_run_due(), which posts
//             { action: 'run_due' } ONLY when something is due, with the vault key in x-cron-key.
//   Back Office  { action: 'run_version', version_id } right after public.msm_publish_now (or
//             msm_retry_site) froze the set, with the person's own sign in. If this call is lost,
//             the job picks the work up within a minute.
//
// WHAT ONE SITE RUN DOES (design 1.5, with the review's fixes)
//   1. public.msm_start_version: the set is applied to the central tables once (idempotent).
//   2. The venue fingerprint (public.msm_venue_fingerprint), THEN the venue's rows read fresh,
//      paged (venueMenuCore.readVenueRaw), and its latest config push.
//   3. The pure planner (msmPlan.js), the health check (msmHealth.js) and the push snapshot
//      (msmSnapshot.js): the same code the screen previews with.
//   4. A blocking problem: the site is skipped and marked failed IN WORDS, the others still run;
//      the person who scheduled it and every editor are emailed, and the venue's feed says so.
//   5. public.msm_apply_site writes rows and push together, or nothing. A venue saved in between
//      (fingerprint moved) is read again once; if it moves again the site is queued a minute later.
//   Values always come from central state at run time; the set only says which fields to touch.
//
// ROUND 2 (17 Oct 2026, same release)
//   * Option groups and VAT per order type go through the same path (the planner and
//     public.msm_apply_site do the work). Before planning, the database must answer
//     public.msm_sql_contract() >= SQL_CONTRACT: against an older database a site is put back in
//     the queue with the words "Run 20261017c first", never half applied.
//   * { action: 'refresh_groups', menu_id }: the one time option group refresh for a group menu
//     imported before round 2 (a person's call; editor, second step). Every site is read (its
//     fingerprint first), the pure refresher (msmImport.refreshGroupsPayload) proves zero writes,
//     and public.msm_import_groups saves it AS THE PERSON, refusing if any site saved meanwhile.
//   * Translations: the menu-translate-10min job reads every venue's modifier_groups names and
//     options at new design kiosk venues, so changed option text is translated without a call here.

// ALSO ON EVERY run_due
//   * the pre check, 60 minutes before a site is due: the same plan and health check, no writes;
//     a blocking problem marks it "will fail" and emails the scheduler and the editors;
//   * the late alarm: a site run not done 15 minutes after its time is marked late, once, with an
//     email and a feed entry.
// A ledger (public.msm_note_notified) makes sure each message goes once.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { isServiceRoleBearer, bearerOf } from '../_shared/cronKey.js';
import { callerAccess } from '../_shared/msmAccess.js';
import { readVenueRaw } from '../_shared/venueMenuCore.js';
import { readCentral, readChanges } from '../_shared/msmRead.js';
import { planSite, touchedFromChanges, countsWords } from '../_shared/msmPlan.js';
import { refreshGroupsPayload } from '../_shared/msmImport.js';
import { SQL_CONTRACT } from '../_shared/msmModel.js';
import { checkSite, failWords } from '../_shared/msmHealth.js';
import { buildMsmSnapshot, appliedRaw } from '../_shared/msmSnapshot.js';
import { applyChanges } from '../_shared/msmDiff.js';
import { messageFor, recipients } from '../_shared/msmNotify.js';
import { whenText } from '../_shared/msmSchedule.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const EMAIL_PROVIDER = (Deno.env.get('RECEIPT_EMAIL_PROVIDER') || 'log').toLowerCase();
const EMAIL_FROM = Deno.env.get('RECEIPT_EMAIL_FROM') || 'hello@posup.co.uk';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const POSTMARK_KEY = Deno.env.get('POSTMARK_API_TOKEN') ?? '';

// pg_net gives up after 25 s, so the scheduled path stops starting new sites after 18 s (a site in
// progress always finishes; the next minute carries on). A person's call may run longer.
const CRON_BUDGET_MS = 18_000;
const USER_BUDGET_MS = 45_000;

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Row = Record<string, any>;

// Plain words for a database error (never a stack, never a key).
const words = (e: any) => String(e?.message || e || 'Something went wrong').replace(/\s+/g, ' ').slice(0, 300);

async function sendEmail(to: string, subject: string, html: string) {
  try {
    if (EMAIL_PROVIDER === 'resend' && RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      return res.ok;
    }
    if (EMAIL_PROVIDER === 'postmark' && POSTMARK_KEY) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'X-Postmark-Server-Token': POSTMARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ From: EMAIL_FROM, To: to, Subject: subject, HtmlBody: html }),
      });
      return res.ok;
    }
    console.warn(`[msm-publish] email not sent, provider not set up (${EMAIL_PROVIDER})`);
    return false;
  } catch {
    return false;
  }
}

// ── Small cached reads for ONE request ──────────────────────────────────────
// A warm worker keeps module state between requests, so the cache is emptied at the start of
// every request (Deno.serve below): a set unscheduled, edited and published again must never be
// planned from the list of changes an earlier request read.
const cache = { versions: new Map<string, Row>(), central: new Map<string, any>(), changes: new Map<string, Row[]>(), sites: new Map<string, Row>(), contract: null as number | null };
function clearCache() {
  cache.versions.clear(); cache.central.clear(); cache.changes.clear(); cache.sites.clear(); cache.contract = null;
}

// The database's side of the contract (20261017c answers 2). 0 when it cannot be read.
async function sqlContract(): Promise<number> {
  if (cache.contract != null) return cache.contract;
  const { data, error } = await db.rpc('msm_sql_contract');
  cache.contract = error ? 0 : Number(data) || 0;
  return cache.contract;
}
const CONTRACT_WORDS = 'The database is older than this publish runner. Run 20261017c first; this site will try again in a few minutes.';

async function version(id: string): Promise<Row> {
  if (cache.versions.has(id)) return cache.versions.get(id)!;
  const { data, error } = await db.from('msm_versions').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new Error(error?.message || 'No such publish');
  cache.versions.set(id, data);
  return data;
}
async function centralOf(menuId: string, fresh = false) {
  if (!fresh && cache.central.has(menuId)) return cache.central.get(menuId);
  const c = await readCentral(db, menuId);
  if (!c.ok) throw new Error(`Could not read the group menu (${c.failed.join(', ')})`);
  cache.central.set(menuId, c);
  return c;
}
async function changesOf(setId: string | null): Promise<Row[]> {
  if (!setId) return [];
  if (cache.changes.has(setId)) return cache.changes.get(setId)!;
  const r = await readChanges(db, setId);
  if (!r.rows) throw new Error('Could not read the changes');
  cache.changes.set(setId, r.rows);
  return r.rows;
}
async function siteRow(loc: string): Promise<Row> {
  if (cache.sites.has(loc)) return cache.sites.get(loc)!;
  const { data } = await db.from('locations').select('id,name,timezone,org_id').eq('id', loc).maybeSingle();
  const row = data || { id: loc, name: 'A site', timezone: 'Europe/London' };
  cache.sites.set(loc, row);
  return row;
}

// ── Messages: email the scheduler and every editor, and the venue's feed ────
async function notify(kind: string, v: Row, loc: string | null, ctx: Row) {
  if (loc) {
    const { data: first } = await db.rpc('msm_note_notified', { p_version: v.id, p_location: loc, p_key: kind });
    if (first !== true) return;          // already sent
  }
  const msg = messageFor(kind, { title: v.title, ...ctx });
  if (loc) {
    await db.from('activity_events').insert({
      location_id: loc, kind: 'menu', severity: msg.severity === 'error' ? 'warning' : msg.severity,
      title: msg.subject.slice(0, 120), body: msg.text.slice(0, 600), ref_type: 'msm_version', ref_id: v.id,
      actor_name: 'Multi site menu',
    }).then(() => null, () => null);
  }
  const { data: members } = await db.from('msm_members').select('user_id, role').eq('org_id', v.org_id);
  const ids = [...new Set([...(members || []).map((m: Row) => m.user_id), v.created_by].filter(Boolean))];
  if (!ids.length) return;
  const { data: people } = await db.from('user_profiles').select('id, email').in('id', ids);
  const roleOf = new Map((members || []).map((m: Row) => [m.user_id, m.role]));
  const set = v.change_set_id ? (await db.from('msm_change_sets').select('scheduled_by').eq('id', v.change_set_id).maybeSingle()).data : null;
  const to = recipients((people || []).map((p: Row) => ({ user_id: p.id, email: p.email, role: roleOf.get(p.id) || null })), set?.scheduled_by || v.created_by);
  for (const addr of to) await sendEmail(addr, msg.subject, msg.html);
}

// ── One site ────────────────────────────────────────────────────────────────
type SiteResult = { location_id: string; status: string; words: string; push_id?: string | null };

async function planFor(v: Row, loc: string, { precheck = false } = {}) {
  const changes = await changesOf(v.change_set_id);
  // Always a fresh read of the central menu (the pre check too: its verdict must be today's).
  let central = await centralOf(v.menu_id, true);
  // Before the set starts (the pre check) the central tables do not hold it yet: lay it on in memory.
  if (precheck) central = applyChanges(central, changes).central;
  const fingerprint = precheck ? null : (await db.rpc('msm_venue_fingerprint', { p_location: loc })).data;
  const raw = await readVenueRaw(db, loc);
  if (!raw.ok) throw new Error(`Could not read this site's menu (${raw.failed.join(', ')})`);
  const plan = planSite({ central, touched: touchedFromChanges(changes), locationId: loc, orgId: v.org_id, venue: raw });
  const health = checkSite(plan, { siteName: (await siteRow(loc)).name });
  return { plan, health, raw, fingerprint };
}

async function runSite(versionId: string, loc: string): Promise<SiteResult> {
  const v = await version(versionId);
  const site = await siteRow(loc);
  const fail = async (text: string, retryIn: number | null = null) => {
    const { data } = await db.rpc('msm_fail_site', { p_version: versionId, p_location: loc, p_words: text, p_retry_in: retryIn });
    if (data?.status === 'failed') await notify('failed', v, loc, { siteName: site.name, words: text });
    return { location_id: loc, status: data?.status || 'failed', words: text };
  };
  try {
    // Round 2: never plan against an older database (it would drop option group writes).
    if ((await sqlContract()) < SQL_CONTRACT) return await fail(CONTRACT_WORDS, 5);
    const started = await db.rpc('msm_start_version', { p_version: versionId });
    if (started.error) return await fail(`It could not start: ${words(started.error)}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { plan, health, raw, fingerprint } = await planFor(v, loc);
      if (!health.ok) return await fail(failWords(site.name, v.title, health.blocking));
      // The id goes to msm_apply_site: a Push to POS that lands after this read makes it refuse
      // (reason 'changed'), so its instruction groups and the rest are never replaced by these.
      const { data: lastRow } = await db.from('config_pushes').select('id, snapshot').eq('location_id', loc).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const snapshot = buildMsmSnapshot({
        raw: appliedRaw(raw, plan),
        last: lastRow?.snapshot || null,
        pushSource: { versionId, title: v.title, applyWhenIdle: v.apply_when_idle !== false },
        pushedBy: v.kind === 'scheduled' ? 'Multi site menu (scheduled)' : `Multi site menu: ${v.created_by_name || 'head office'}`,
        resort: plan.writes.items.insert.length + plan.writes.categories.insert.length + plan.writes.menus.insert.length > 0,
      });
      const res = await db.rpc('msm_apply_site', {
        p_version: versionId, p_location: loc, p_writes: plan.writes, p_snapshot: snapshot, p_fingerprint: fingerprint,
        p_counts: plan.counts, p_pushed_by: snapshot.pushedBy, p_summary: `Head office menu update${v.title ? ` "${v.title}"` : ''}: ${countsWords(plan.counts) || 'no changes here'}.`,
        p_last_push_id: lastRow?.id || null,
      });
      if (res.error) return await fail(`${site.name} was not changed: ${words(res.error)}`);
      // Switched off between the claim and the write: the database put the site back in the
      // queue; it runs when the company is switched on again (design 3.4).
      if (res.data?.ok === false && res.data?.reason === 'paused') return { location_id: loc, status: 'scheduled', words: res.data.words || 'Paused' };
      if (res.data?.ok === false && res.data?.reason === 'changed') continue;     // read again once
      return { location_id: loc, status: res.data?.push_id ? 'done' : 'nothing', words: countsWords(plan.counts) || 'Nothing to change', push_id: res.data?.push_id || null };
    }
    return await fail(`Someone was saving the menu at ${site.name}; it will try again in a minute.`, 1);
  } catch (e) {
    return await fail(`${site.name} was not changed: ${words(e)}`);
  }
}

// After a version's sites have all run: one message if some failed.
async function afterVersion(versionId: string) {
  const { data: v } = await db.from('msm_versions').select('*').eq('id', versionId).maybeSingle();
  if (!v || !['partly_done', 'failed'].includes(v.status)) return;
  const { data: sites } = await db.from('msm_version_sites').select('location_id,status').eq('version_id', versionId);
  const failed = (sites || []).filter((s: Row) => s.status === 'failed');
  if (failed.length < 2) return;     // one failed site was already told about on its own
  const names = [];
  for (const s of failed) names.push((await siteRow(s.location_id)).name);
  await notify('done_with_failures', v, failed[0].location_id, {
    doneCount: (sites || []).filter((s: Row) => s.status === 'done' || s.status === 'nothing').length,
    siteCount: (sites || []).length, failedSites: names,
  });
}

// ── The passes ──────────────────────────────────────────────────────────────
// Scheduled runs more than 6 hours past their time are failed in words, never run by themselves.
async function missedPass() {
  const { data } = await db.rpc('msm_mark_missed');
  for (const r of data || []) {
    try {
      const v = await version(r.version_id);
      const s = await siteRow(r.location_id);
      const when = r.due_at ? whenText(Date.parse(r.due_at), s.timezone) : '';
      await notify('failed', v, r.location_id, { siteName: s.name, words: `${s.name} missed its time${when ? ` (${when})` : ''}, so nothing was changed there. Press Retry on the Publish tab if it should still go out.` });
    } catch (e) { console.warn('[msm-publish] missed notice failed', words(e)); }
  }
}

async function latePass() {
  const { data } = await db.rpc('msm_mark_late');
  for (const r of data || []) {
    try {
      const v = await version(r.version_id);
      const s = await siteRow(r.location_id);
      const { data: vs } = await db.from('msm_version_sites').select('due_at').eq('version_id', r.version_id).eq('location_id', r.location_id).maybeSingle();
      await notify('late', v, r.location_id, { siteName: s.name, when: vs?.due_at ? whenText(Date.parse(vs.due_at), s.timezone) : '' });
    } catch (e) { console.warn('[msm-publish] late notice failed', words(e)); }
  }
}

async function precheckPass(deadline: number) {
  const { data } = await db.rpc('msm_precheck_due', { p_limit: 10 });
  for (const r of data || []) {
    if (Date.now() > deadline) break;
    try {
      const v = await version(r.version_id);
      const s = await siteRow(r.location_id);
      const { health } = await planFor(v, r.location_id, { precheck: true });
      const text = health.ok ? '' : failWords(s.name, v.title, health.blocking);
      await db.rpc('msm_precheck_result', { p_version: r.version_id, p_location: r.location_id, p_ok: health.ok, p_words: text || null });
      if (!health.ok) {
        const { data: vs } = await db.from('msm_version_sites').select('due_at').eq('version_id', r.version_id).eq('location_id', r.location_id).maybeSingle();
        await notify('will_fail', v, r.location_id, { siteName: s.name, words: text, when: vs?.due_at ? whenText(Date.parse(vs.due_at), s.timezone) : '' });
      }
    } catch (e) {
      await db.rpc('msm_precheck_result', { p_version: r.version_id, p_location: r.location_id, p_ok: false, p_words: `The check could not run: ${words(e)}` });
    }
  }
}

async function claimLoop(deadline: number) {
  const done: SiteResult[] = [];
  const versions = new Set<string>();
  while (Date.now() < deadline) {
    const { data, error } = await db.rpc('msm_claim_due', { p_limit: 1 });
    if (error) { console.warn('[msm-publish] claim failed', words(error)); break; }
    const row = (data || [])[0];
    if (!row) break;
    versions.add(row.version_id);
    done.push(await runSite(row.version_id, row.location_id));
  }
  for (const id of versions) await afterVersion(id).catch(() => null);
  return done;
}

// ── The door ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  clearCache();
  let body: Row = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || '');

  const service = isServiceRoleBearer(req.headers.get('Authorization'), SERVICE_ROLE);
  const key = String(req.headers.get('x-cron-key') || '').trim();
  const keyCheck = !service && key ? await db.rpc('msm_cron_ok', { p_key: key }) : null;
  let user: Row | null = null;
  const token = bearerOf(req.headers.get('Authorization'));
  if (!service && !key && token) {
    const { data, error } = await db.auth.getUser(token);
    user = { id: data?.user?.id || null, error };
  }
  const access = callerAccess({ service, key, keyCheck, user });
  if (!access.ok) return json({ ok: false, error: 'Not allowed', reason: access.reason }, 403);

  try {
    if (action === 'run_due') {
      if (access.by === 'user') return json({ ok: false, error: 'Only the scheduler runs this.' }, 403);
      const deadline = Date.now() + CRON_BUDGET_MS;
      await missedPass().catch((e) => console.warn('[msm-publish] missed pass', words(e)));
      await latePass().catch((e) => console.warn('[msm-publish] late pass', words(e)));
      const ran = await claimLoop(deadline);
      if (Date.now() < deadline) await precheckPass(deadline).catch((e) => console.warn('[msm-publish] pre check pass', words(e)));
      return json({ ok: true, ran });
    }

    if (action === 'run_version') {
      const versionId = String(body.version_id || '');
      if (!versionId) return json({ ok: false, error: 'Which publish?' }, 400);
      if (access.by === 'user') {
        const refusal = await secondStepRefusal(req);
        if (refusal) return refusal;
        // Ask the database AS THE PERSON whether they edit this company (row level security and
        // msm_can_edit decide; the service client is never trusted with that question).
        const v = await version(versionId);
        const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
        const { data: can, error } = await asUser.rpc('msm_can_edit', { p_org: v.org_id });
        if (error || can !== true) return json({ ok: false, error: 'Only people ServOS added as an editor can publish.' }, 403);
      }
      const ran = await claimLoop(Date.now() + (access.by === 'user' ? USER_BUDGET_MS : CRON_BUDGET_MS));
      const { data: sites } = await db.from('msm_version_sites').select('location_id,status,error,push_id').eq('version_id', versionId);
      const { data: v2 } = await db.from('msm_versions').select('status,version_no').eq('id', versionId).maybeSingle();
      return json({ ok: true, status: v2?.status || null, version_no: v2?.version_no ?? null, sites: sites || [], ran });
    }

    if (action === 'refresh_groups') {
      if (access.by !== 'user') return json({ ok: false, error: 'Only a signed in editor runs this.' }, 403);
      const refusal = await secondStepRefusal(req);
      if (refusal) return refusal;
      const menuId = String(body.menu_id || '');
      const { data: m } = await db.from('msm_menus').select('id, org_id, status, refreshed_at').eq('id', menuId).maybeSingle();
      if (!m || m.status !== 'live') return json({ ok: false, error: 'No such group menu.' }, 404);
      const asUser = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
      const { data: can, error: canErr } = await asUser.rpc('msm_can_edit', { p_org: m.org_id });
      if (canErr || can !== true) return json({ ok: false, error: 'Only people ServOS added as an editor can do this.' }, 403);
      if ((await sqlContract()) < SQL_CONTRACT) return json({ ok: false, error: 'Run 20261017c first. Nothing was changed.' }, 409);
      if (m.refreshed_at) return json({ ok: true, already: true, words: 'The option groups are already brought in. Nothing to do.' });
      const central = await centralOf(menuId, true);
      const fingerprints: Record<string, string> = {};
      const sites: Row[] = [];
      for (const s of central.sites || []) {
        // The fingerprint BEFORE the read, as a publish does: the database refuses the save if any
        // site saved its menu in between.
        const fp = await db.rpc('msm_venue_fingerprint', { p_location: s.location_id });
        const raw = await readVenueRaw(db, s.location_id);
        const site = await siteRow(s.location_id);
        if (fp.error || !raw.ok) return json({ ok: false, error: `Could not read ${site.name}'s menu. Nothing was changed. Try again.` }, 503);
        fingerprints[s.location_id] = fp.data;
        sites.push({ location_id: s.location_id, name: site.name, raw });
      }
      const r = refreshGroupsPayload(central, sites);
      if (!r.ok) return json({ ok: false, error: r.words, check: r.check || null }, 409);
      const res = await asUser.rpc('msm_import_groups', { p_menu: menuId, p_payload: { ...r.payload, fingerprints } });
      if (res.error) return json({ ok: false, error: words(res.error) }, 400);
      return json({ ok: true, ...(res.data || {}), counts: r.counts, words: r.words });
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('[msm-publish] failed', words(e));
    return json({ ok: false, error: words(e) }, 500);
  }
});
