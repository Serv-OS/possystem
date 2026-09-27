// supabase/functions/customer-merge
//
// PUT TWO CUSTOMER PROFILES TOGETHER. 26 Sep 2026, Coffee Boy Leeds: Ela Stettner's imported
// profile (email, 2 stamps, no phone) and the blank one the portal made from her phone could not
// be joined, and every save that tried hit a unique index ("DB error" at the till). Peter: "it
// should have matched the profile together". This is the one place that does.
//
//   POST { action: 'preview', target_id, source_id, location_id, phone_choice? }
//     Says which profile is kept (the one with history, see _shared/customerMergePlan.js), what
//     moves, and anything that stops the merge. Touches NOTHING. Contact details are masked.
//
//   POST { action: 'merge', target_id, source_id, location_id, phone_choice? }
//     Does it (_shared/customerMergeRun.js): Platform balances first, then Ops history, then the
//     two profiles. Safe to send again: a merge that stopped half way is finished, and nothing
//     is ever counted twice. Sent again after it finished, it changes nothing on the kept
//     profile (27 Sep 2026: a phone changed since, or marketing turned off, stays as it is).
//     Answers with the surviving profile.
//
// WHO MAY ASK (18 Sep 2026: any JWT is not authority). location_id is the venue the call is made
// from, and it must belong to the customers' organisation. Then exactly one of:
//   * an owner or manager of that venue, the organisation's owner, a company owner or admin, or a
//     super admin (Back Office, a real login, never anonymous);
//   * a till BOUND to that venue (the device arm of pos_can_access), and only when the profile
//     folded in is an empty shell: no name, no email, no points, no stamps, no orders. That is the
//     till case: staff add a customer, the phone lands on a blank profile the portal made, and
//     the real (imported) profile is found by email;
//   * the service role (another edge function).
// A caller who is none of these learns nothing about the customers.
//
// The rules and the steps live in the two _shared files (pure, and driven by node tests with a
// fake database); this file only asks who is calling and talks to the two databases.

import {
  cors, json, opsAdmin, platformAdmin, callerDeviceFor, resolveVenue, isServiceRoleRequest,
} from '../_shared/loyalty-utils.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';
import {
  validateMergeRequest, planMerge, decideMergeCaller, staffMergeRole, profileCard, survivorForCaller, MERGE_TABLES,
} from '../_shared/customerMergePlan.js';
import {
  readMergeFacts, countSourceRows, applyMerge, readSurvivor, MergeStepError,
} from '../_shared/customerMergeRun.js';

const clients = { ops: opsAdmin, platform: platformAdmin };

/** The caller's roles, read with the service role. A failed read is "no role", never a role. */
async function roleFacts(user: any, opsLocationId: string, companyId: string | null) {
  try {
    const [prof, link, ucr] = await Promise.all([
      opsAdmin.from('user_profiles').select('role, org_id').eq('id', user.id).maybeSingle(),
      opsAdmin.from('user_locations').select('role').eq('user_id', user.id).eq('location_id', opsLocationId).limit(5),
      companyId
        ? platformAdmin.from('user_company_roles').select('role').eq('user_id', user.id).eq('company_id', companyId).limit(5)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const linkRoles = ((link as any)?.data || []).map((r: any) => String(r.role || ''));
    const companyRoles = ((ucr as any)?.data || []).map((r: any) => String(r.role || ''));
    return {
      profileRole: (prof as any)?.data?.role ?? null,
      profileOrgId: (prof as any)?.data?.org_id ?? null,
      linkRole: linkRoles.find((r: string) => r === 'owner' || r === 'manager') ?? linkRoles[0] ?? null,
      companyRole: companyRoles.find((r: string) => r === 'owner' || r === 'admin' || r === 'manager') ?? companyRoles[0] ?? null,
    };
  } catch (e) {
    console.warn('[customer-merge] role read failed:', (e as any)?.message || e);
    return { profileRole: null, profileOrgId: null, linkRole: null, companyRole: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ ok: false, code: 'bad_request', error: 'POST only' }, 405);

  let body: unknown = null;
  try { body = await req.json(); } catch { return json({ ok: false, code: 'bad_request', error: 'invalid json' }, 400); }
  // JS modules are loosely typed here: the shapes are pinned by src/lib/customerMergePlan.test.js.
  const r: any = validateMergeRequest(body);
  if (!r.ok) return json({ ok: false, code: 'bad_request', error: r.error }, 400);

  // ── who is asking ──
  const service = isServiceRoleRequest(req);
  let user: any = null;
  if (!service) {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!token) return json({ ok: false, code: 'sign_in', error: 'Sign in first.' }, 401);
    const { data } = await opsAdmin.auth.getUser(token);
    user = data?.user ?? null;
    if (!user) return json({ ok: false, code: 'sign_in', error: 'Sign in first.' }, 401);
  }

  // ── the venue the call is made from, and its organisation (always the OPS row's org) ──
  const venue = await resolveVenue(r.locationId);
  if (!venue.opsLocationId) return json({ ok: false, code: 'no_venue', error: 'That venue could not be found.' }, 404);
  const { data: vloc } = await opsAdmin.from('locations').select('org_id').eq('id', venue.opsLocationId).maybeSingle();
  const venueOrgId: string | null = (vloc as any)?.org_id ?? null;

  // ── staff, or a device of the venue? Settled BEFORE any customer is read ──
  let roles = { profileRole: null as string | null, profileOrgId: null as string | null, linkRole: null as string | null, companyRole: null as string | null };
  let device = false;
  if (!service) {
    roles = await roleFacts(user, venue.opsLocationId, venue.companyId);
    const staff = staffMergeRole({ user, ...roles, venueOrgId });
    if (!staff) device = (await callerDeviceFor(user, venue.opsLocationId)).ok === true;
    if (!staff && !device) {
      console.warn('[customer-merge] refused', JSON.stringify({ reason: 'not_allowed', caller_id: user?.id, anonymous: !!user?.is_anonymous, location_id: venue.opsLocationId }));
      return json({ ok: false, code: 'not_allowed', error: 'Only an owner or a manager can merge customers.' }, 403);
    }
  }

  // ── the two profiles, their balances and their history ──
  let facts: any;
  try {
    facts = await readMergeFacts(clients, { targetId: r.targetId, sourceId: r.sourceId });
  } catch (e) {
    const step = e instanceof MergeStepError ? e.step : 'read';
    console.warn('[customer-merge] read failed', step, (e as any)?.message || e);
    return json({ ok: false, code: 'read_failed', step, error: 'The customers could not be read just now. Nothing was changed. Try again.' }, 503);
  }
  if (!facts.a || !facts.b) return json({ ok: false, code: 'not_found', error: 'One of the two customers could not be found.' }, 404);
  const customersOrgId = String(facts.a.org_id) === String(facts.b.org_id) ? facts.a.org_id : null;

  const now = new Date().toISOString();
  const base: any = { a: facts.a, b: facts.b, memberships: facts.memberships, cards: facts.cards, programs: facts.programs, activity: facts.activity, latestConsent: facts.latestConsent, holders: facts.holders, now };
  // Who the source is does not depend on the phone choice, so the till test is made on this plan.
  const first: any = planMerge({ ...base, phoneChoice: null });
  const decision: any = decideMergeCaller({
    service, user, ...roles, venueOrgId, customersOrgId, device, sourceBlank: first.source_blank,
  });
  if (!decision.ok) {
    console.warn('[customer-merge] refused', JSON.stringify({ reason: decision.code, caller_id: user?.id ?? null, location_id: venue.opsLocationId }));
    return json({ ok: false, code: decision.code, error: decision.error }, decision.status);
  }
  // Only a person chooses between two phone numbers; a till never does.
  const phoneChoice = decision.as === 'device' ? null : r.phoneChoice;
  const plan: any = phoneChoice ? planMerge({ ...base, phoneChoice }) : first;

  const target = plan.target_id && String(plan.target_id) === String(facts.b.id) ? facts.b : facts.a;
  const source = target === facts.a ? facts.b : facts.a;
  const answer = {
    mode: plan.mode,
    swapped: plan.swapped,
    target_id: target.id,
    source_id: source.id,
    source_blank: plan.source_blank,
    caller: decision.as,
    phone_choice: phoneChoice,
    summary: plan.summary,
    refusals: plan.refusals,
    warnings: plan.warnings,
  };

  if (r.action === 'preview') {
    const counts = plan.source_id ? await countSourceRows(clients, plan.source_id) : {};
    return json({
      ok: true,
      action: 'preview',
      can_merge: plan.ok,
      ...answer,
      target: profileCard(target, plan.target_history, facts.memberships, facts.cards, facts.programs),
      source: profileCard(source, plan.source_history, facts.memberships, facts.cards, facts.programs),
      moves: MERGE_TABLES
        .map((t) => ({ table: t.table, label: t.label, one: t.one, rows: (counts as any)[t.table] ?? null }))
        .filter((m) => m.rows !== 0),
      memberships: plan.memberships
        ? { moved: plan.memberships.moves.length, folded: plan.memberships.deletes.length, kept_codes: plan.memberships.kept_codes, retired_codes: plan.memberships.dropped_codes }
        : null,
      stamp_cards: plan.stamp_cards
        ? { moved: plan.stamp_cards.moves.length, folded: plan.stamp_cards.deletes.length }
        : null,
    });
  }

  // ── merge ──
  if (!plan.ok) {
    return json({ ok: false, action: 'merge', code: 'refused', error: plan.refusals[0]?.message || 'These two cannot be merged.', ...answer }, 409);
  }
  let applied: any;
  try {
    applied = await applyMerge(clients, plan);
  } catch (e) {
    const step = e instanceof MergeStepError ? e.step : 'unknown';
    const done = e instanceof MergeStepError ? e.done : [];
    console.error('[customer-merge] step failed', JSON.stringify({ step, done, target_id: plan.target_id, source_id: plan.source_id, message: (e as any)?.cause?.message || (e as any)?.message || String(e) }));
    return json({
      ok: false, action: 'merge', code: 'step_failed', step, done, retry_safe: true,
      error: 'The merge stopped part way. Nothing is lost and nothing is counted twice: press Merge again to finish it.',
      ...answer,
    }, 500);
  }
  const survivor = await readSurvivor(clients, plan.target_id).catch(() => ({ customer: null, memberships: [], stamp_cards: [] }));
  console.log('[customer-merge] merged', JSON.stringify({
    target_id: plan.target_id, source_id: plan.source_id, mode: plan.mode, caller: decision.as, via: decision.via,
    caller_id: user?.id ?? null, location_id: venue.opsLocationId, steps: applied.steps, stayed: applied.stayed,
  }));
  return json({
    ok: true,
    action: 'merge',
    ...answer,
    survivor_id: plan.target_id,
    merged_source_id: plan.source_id,
    // A till gets only what its screen shows (the customer fence), never notes or tags.
    survivor: survivorForCaller(survivor.customer, decision.as),
    memberships: survivor.memberships,
    stamp_cards: survivor.stamp_cards,
    stayed: applied.stayed,
    steps: applied.steps,
  });
});
