// supabase/functions/menu-translate/index.ts
//
// Translates a venue's menu text for the kiosk (v5.8.82): item names and descriptions,
// categories, option groups and options, instruction groups and their choices, into the
// kiosk languages (Spanish, French, Simplified Chinese; _shared/menuTranslate.js MENU_LANGS).
// Rows land in menu_translations, one per (entity, language), and the kiosk reads them when
// a customer picks a language.
//
// WHO CALLS IT
//   pg_cron   every 10 minutes, one call per venue that has a kiosk on the new design
//             (migration 20260916_OPS_menu_translations.sql, through call_edge_fn, so the
//             bearer is the service role key). pg_net gives up after 25 s, so the cron path
//             keeps under that (CRON_TIME_BUDGET_MS) and its report is recorded.
//   Back Office  after a menu save (src/lib/menuTranslateTrigger.js, debounced) and from the
//             Translate now button on the kiosk settings. The bearer is the user's JWT; the
//             user must have the venue in user_locations or be a super admin.
//
// WHAT ONE CALL DOES
//   1. reads the venue's menu rows and its translation rows (paged: PostgREST caps a read
//      at 1000 rows, and three languages of a big menu pass that)
//   2. plans the work (planTranslations): missing rows, and auto rows whose English changed.
//      Rows edited in Back Office (source 'manual') are never overwritten: the write goes
//      through menu_translations_upsert_auto, which skips a manual row even when one appeared
//      after the plan was made.
//   3. sends batches to Claude (claude-sonnet-5, a forced tool call, thinking off), three at
//      a time, and checks each reply entry by entry (parseTranslations). A reply cut at
//      max_tokens splits the batch in two and tries again; a bad entry waits for the next run.
//   4. deletes automatic rows whose entity no longer exists (archived item, deleted option).
//      Manual rows are never deleted here.
//   A call stops starting new batches after its time budget and reports what is left, so a
//   big menu finishes over a few runs instead of timing out.
//
// action 'status' (Back Office) plans without calling the model and says whether the
// translator is set up (ANTHROPIC_API_KEY present).
//
// Only venues with a kiosk on the new design are translated in the background. The Back
// Office button passes reason 'button', which translates regardless.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  MENU_LANGS, RUN_LIMIT, menuEntities, planTranslations, batchPlan, splitBatch, orphanedRows,
  translationPrompt, parseTranslations, TRANSLATE_TOOL,
} from '../_shared/menuTranslate.js';
import { secondStepRefusal } from '../_shared/second-step.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
// Stop starting batches after this; the next run continues. The cron path stays under
// call_edge_fn's 25 s pg_net timeout so its report lands in net._http_response.
const TIME_BUDGET_MS = 60_000;
const CRON_TIME_BUDGET_MS = 18_000;
const CRON_RUN_LIMIT = 120;
const CLAUDE_TIMEOUT_MS = 90_000;  // a stalled model call becomes a failed batch, never a hung run
const PARALLEL = 3;                // model calls in flight at once
const PAGE_ROWS = 1000;            // hosted PostgREST returns at most this many rows per request

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Body = { action?: string; location_id?: string; langs?: string[]; force?: boolean; reason?: string };
type Row = Record<string, unknown>;

/** Every row of a query, read in pages of PAGE_ROWS. build() returns a FRESH query each call. */
async function readAll(build: () => any): Promise<{ data: Row[] | null; error: { message: string } | null }> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const res = await build().order('id', { ascending: true }).range(from, from + PAGE_ROWS - 1);
    if (res.error) return { data: null, error: res.error };
    const rows = Array.isArray(res.data) ? res.data : [];
    out.push(...rows);
    if (rows.length < PAGE_ROWS) break;
  }
  return { data: out, error: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Body = {};
  try { body = await req.json(); } catch { body = {}; }
  const locationId = String(body.location_id ?? '').trim();
  if (!locationId) return json({ error: 'location_id is required' }, 400);

  // ── Who is calling ──
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isService = SERVICE_ROLE !== '' && token === SERVICE_ROLE;
  if (!isService) {
    const { data } = await opsAdmin.auth.getUser(token);
    const user = data?.user;
    if (!user) return json({ error: 'invalid token' }, 401);
    const [{ data: link }, { data: prof }] = await Promise.all([
      opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', locationId).maybeSingle(),
      opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
    ]);
    if (!link && prof?.role !== 'super_admin') return json({ error: 'no access to this venue' }, 403);
  }

  const action = body.action === 'status' ? 'status' : 'run';
  const reason = String(body.reason ?? '');
  const langs = Array.isArray(body.langs) && body.langs.length
    ? body.langs.filter((l) => MENU_LANGS.includes(l))
    : MENU_LANGS;
  const started = Date.now();
  const budgetMs = reason === 'cron' ? CRON_TIME_BUDGET_MS : TIME_BUDGET_MS;
  const runLimit = reason === 'cron' ? CRON_RUN_LIMIT : RUN_LIMIT;

  // ── Eligibility: a kiosk on the new design, unless the Back Office button asked ──
  const { data: profiles } = await opsAdmin.from('device_profiles').select('id')
    .eq('location_id', locationId).eq('kiosk_new_design', true).limit(1);
  const eligible = Array.isArray(profiles) && profiles.length > 0;
  if (!eligible && reason !== 'button' && action !== 'status') {
    return json({ location_id: locationId, skipped: 'no kiosk on the new design at this venue' });
  }

  // ── The venue's text and what is translated already ──
  const [items, categories, groups, push, existing, venue] = await Promise.all([
    readAll(() => opsAdmin.from('menu_items').select('id,name,menu_name,description,archived').eq('location_id', locationId).eq('archived', false)),
    readAll(() => opsAdmin.from('menu_categories').select('id,label').eq('location_id', locationId)),
    readAll(() => opsAdmin.from('modifier_groups').select('id,name,options').eq('location_id', locationId)),
    opsAdmin.from('config_pushes').select('snapshot->instructionGroupDefs').eq('location_id', locationId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    readAll(() => opsAdmin.from('menu_translations').select('id,entity_type,entity_id,lang,source,source_hash').eq('location_id', locationId)),
    opsAdmin.from('locations').select('name').eq('id', locationId).maybeSingle(),
  ]);
  for (const r of [items, categories, groups, push, existing]) {
    if (r.error) return json({ error: `read failed: ${r.error.message}` }, 500);
  }
  // No config push yet means the kiosk has no instruction groups either; their rows (if any)
  // are left alone this run rather than treated as orphans.
  const defsKnown = push.data !== null && push.data !== undefined;
  const defs = (push.data as Record<string, unknown> | null)?.instructionGroupDefs;
  const entities = menuEntities({
    items: items.data ?? [], categories: categories.data ?? [], groups: groups.data ?? [],
    instructionDefs: Array.isArray(defs) ? defs : [],
  });
  const rows = existing.data ?? [];
  const plan = planTranslations({ entities, existing: rows, langs, limit: runLimit, force: body.force === true });

  if (action === 'status') {
    return json({
      location_id: locationId, eligible, hasKey: ANTHROPIC_API_KEY !== '', model: MODEL, langs,
      entities: entities.length, waiting: plan.todo.length + plan.remaining,
      upToDate: plan.upToDate, staleManual: plan.staleManual,
    });
  }
  if (!ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY is not set on the edge functions' }, 503);

  // ── Orphans: the item was archived or the option deleted (automatic rows only) ──
  const orphans = orphanedRows(entities, rows, defsKnown ? [] : ['instruction_group', 'instruction_option']);
  if (orphans.length) {
    await opsAdmin.from('menu_translations').delete().in('id', orphans.map((r) => r.id)).neq('source', 'manual');
  }

  // ── Translate, a few batches at a time, inside the time budget ──
  const batches = batchPlan(plan.todo);
  let translated = 0;
  let skippedForTime = 0;
  let keptManual = 0;
  const problems: string[] = [];
  const venueName = (venue.data as { name?: string } | null)?.name ?? '';
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      if (Date.now() - started > budgetMs) { skippedForTime += b.entries.length; continue; }
      try {
        const reply = await askClaude(translationPrompt(b.lang, b.entries, venueName));
        if (reply === TOO_LONG) {
          // The reply was cut at max_tokens: try the two halves (a single entry is a problem).
          const halves = splitBatch(b);
          if (halves.length) batches.push(...halves);
          else problems.push(`${b.lang} ${b.entries[0]?.type} ${b.entries[0]?.id}: reply too long`);
          continue;
        }
        const parsed = parseTranslations(b.lang, b.entries, reply);
        problems.push(...parsed.problems);
        if (parsed.rows.length) {
          const now = new Date().toISOString();
          const payload = parsed.rows.map((r) => ({
            location_id: locationId, entity_type: r.type, entity_id: r.id, lang: r.lang,
            text: { ...r.text, en: r.en, ...(r.group ? { group: r.group } : {}) },
            source_hash: r.hash, model: MODEL, updated_at: now,
          }));
          // Writes only rows that are not manual, even one edited since the plan was made.
          const up = await opsAdmin.rpc('menu_translations_upsert_auto', { p_rows: payload });
          if (up.error) problems.push(`save failed (${b.lang}): ${up.error.message}`);
          else {
            const written = Number(up.data ?? 0);
            translated += written;
            keptManual += Math.max(0, parsed.rows.length - written);
          }
        }
      } catch (e) {
        problems.push(`${b.lang} batch failed: ${(e as Error)?.message ?? String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, batches.length)) }, worker));

  return json({
    location_id: locationId, langs, model: MODEL, entities: entities.length,
    // Everything planned but not saved (out of time, a failed batch, a bad entry) is tried again next run.
    translated, remaining: plan.remaining + Math.max(0, plan.todo.length - translated - keptManual), skippedForTime, keptManual,
    problems: problems.slice(0, 20), problemCount: problems.length,
    staleManual: plan.staleManual, upToDate: plan.upToDate, orphansRemoved: orphans.length,
    ms: Date.now() - started,
  });
});

const TOO_LONG = Symbol('too long');

/**
 * One model call. The tool call is forced, so the reply is the tool's JSON input. Thinking is
 * off (a translation with a forced tool needs none, and thinking would share max_tokens).
 * No sampling parameters: claude-sonnet-5 rejects them. A reply cut at max_tokens resolves
 * TOO_LONG so the caller can split the batch.
 */
async function askClaude(prompt: string): Promise<unknown> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      tools: [TRANSLATE_TOOL],
      tool_choice: { type: 'tool', name: TRANSLATE_TOOL.name },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data?.stop_reason === 'max_tokens') return TOO_LONG;
  const block = (data?.content ?? []).find((c: { type?: string }) => c?.type === 'tool_use');
  if (!block) throw new Error(`no tool call in the reply (stop_reason ${data?.stop_reason ?? 'unknown'})`);
  return block.input;
}
