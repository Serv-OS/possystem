// supabase/functions/_shared/customerMergeRun.js
//
// CARRY OUT a customer merge planned by customerMergePlan.js, across the two databases.
//
// WHY THIS ORDER (26 Sep 2026). There is no transaction across Ops and Platform, so a merge can
// stop between any two writes (a timeout, a dropped connection, a deploy). Every step is written
// so that running the whole merge again finishes the job and never counts anything twice:
//
//   Platform first (the balances):
//     1. a membership or stamp card only the source has is MOVED (one row changes customer);
//     2. one both have is FOLDED by ONE upsert statement that writes the target's sums AND
//        zeroes the source row. One statement is one transaction, so there is no moment where
//        the stamps are on both rows; a retry reads the zeroed source and adds nothing;
//     3. referrals and redemption claims that pointed at the source membership are repointed;
//     4. the (now empty) source rows are deleted.
//   Then Ops (the history):
//     5. every customer_id row is repointed (MERGE_TABLES), except where a unique key clashes:
//        venue visit records are folded the same way as stamp cards, campaign and automation
//        rows the survivor already has stay on the folded in profile and are counted;
//     6. ONE upsert writes both customers rows: the source is soft deleted, its phone and email
//        cleared (so the unique indexes let go of them) and it is tagged merged_into:<target>
//        with what it hands over; the survivor gets the filled blanks and the merged:<source> tag;
//     7. only THEN the survivor takes the phone and email (the unique indexes are free now), and
//        only into a field that is still null at that moment (the update says so), so a phone
//        typed on the survivor meanwhile is never overwritten;
//     8. the source is marked merge_done (skipped when 6 had nothing to hand over: then 6 marks it).
//   Stopped after 6 and before 8? The source row's tags still say what to hand over, and the
//   plan resumes from them (mode 'resume'). A resume never writes the survivor's profile
//   (27 Sep 2026, first review): steps 1 to 5 run again and add nothing twice, 6 is skipped, and
//   7 only fills what is still empty and nobody else holds (customerMergePlan.js resumeHandOver).
//
// No remote imports: the Supabase clients are passed in, so src/lib/customerMergeRun.test.js
// drives the whole merge, and a crash at every step, against an in memory fake.

import {
  MERGE_TABLES, MERGE_TAG, CUSTOMER_MERGE_COLS, MEMBERSHIP_COLS, CARD_COLS, LOCATION_COLS, SURVIVOR_COLS,
  planCustomerLocations, partitionClashes, mergedIntoOf, isMergeDone, tagValue, exactIlike,
} from './customerMergePlan.js';

/** Ids per `.in(...)` write. Keeps the PostgREST URL short. */
export const MERGE_WRITE_CHUNK = 100;

/** A step that failed. `done` lists the steps that had already landed; the merge is safe to ask for again. */
export class MergeStepError extends Error {
  constructor(step, cause, done = []) {
    super(`${step}: ${cause?.message || cause || 'failed'}`);
    this.step = step;
    this.cause = cause;
    this.done = done;
  }
}

const chunks = (ids, n = MERGE_WRITE_CHUNK) => {
  const out = [];
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
};

/**
 * Everything the plan needs, read fresh on every call (a retry must plan from what is there
 * NOW). A read that fails throws: a failed read is never "nothing there", or a retry would skip
 * a balance it did not see.
 */
export async function readMergeFacts({ ops, platform }, { targetId, sourceId }) {
  const ids = [targetId, sourceId];
  const need = (what, res) => {
    if (res?.error) throw new MergeStepError(`read_${what}`, res.error);
    return res?.data ?? null;
  };
  const rows = need('customers', await ops.from('customers').select(CUSTOMER_MERGE_COLS).in('id', ids)) || [];
  const a = rows.find((r) => String(r.id) === String(targetId)) || null;
  const b = rows.find((r) => String(r.id) === String(sourceId)) || null;
  const facts = { a, b, memberships: [], cards: [], programs: [], activity: {}, latestConsent: null, holders: [] };
  // Nothing more is read for customers that cannot be merged (not found, another business).
  if (!a || !b || !a.org_id || String(a.org_id) !== String(b.org_id)) return facts;

  // 27 Sep 2026 (first review): a resume hands a phone or email over only when no other live
  // customer holds it NOW (a new sign up may have taken it since the merge stopped). Read who
  // holds each value the trail names; only for a folded in profile whose hand over is not done.
  const phones = new Set(); const raws = new Set(); const emails = new Set();
  for (const [c, other] of [[a, b], [b, a]]) {
    if (!c.deleted_at || mergedIntoOf(c.tags) !== String(other.id) || isMergeDone(c.tags)) continue;
    const p = tagValue(c.tags, MERGE_TAG.PHONE);
    const pr = tagValue(c.tags, MERGE_TAG.PHONE_RAW);
    const e = tagValue(c.tags, MERGE_TAG.EMAIL);
    if (p) { phones.add(p); raws.add(p); }
    if (pr) { phones.add(pr); raws.add(pr); }
    if (e) emails.add(e);
  }
  const held = new Map();
  const live = () => ops.from('customers').select('id, phone, phone_raw, email, deleted_at').eq('org_id', a.org_id).is('deleted_at', null);
  const holderReads = [];
  if (phones.size) holderReads.push(live().in('phone', [...phones]).limit(50));
  if (raws.size) holderReads.push(live().in('phone_raw', [...raws]).limit(50));
  for (const e of emails) holderReads.push(live().ilike('email', exactIlike(e)).limit(50));
  for (const res of await Promise.all(holderReads)) {
    for (const r of need('holders', res) || []) held.set(String(r.id), r);
  }
  facts.holders = [...held.values()];

  const [mRes, cRes] = await Promise.all([
    platform.from('customer_loyalty').select(MEMBERSHIP_COLS).in('customer_id', ids),
    platform.from('customer_stamp_cards').select(CARD_COLS).in('customer_id', ids),
  ]);
  facts.memberships = need('memberships', mRes) || [];
  facts.cards = need('stamp_cards', cRes) || [];
  const programIds = [...new Set(facts.cards.map((c) => String(c.program_id)))];
  if (programIds.length) {
    facts.programs = need('programs', await platform.from('stamp_card_programs').select('id, name, stamps_required').in('id', programIds)) || [];
  }

  const count = async (table, id) => {
    const res = await ops.from(table).select('customer_id', { count: 'exact', head: true }).eq('customer_id', id);
    if (res?.error) throw new MergeStepError(`read_${table}`, res.error);
    return Number(res?.count) || 0;
  };
  for (const id of ids) {
    const [orders, points, stamps] = await Promise.all([
      count('customer_orders', id), count('loyalty_transactions', id), count('stamp_transactions', id),
    ]);
    facts.activity[id] = { orders, ledger: points + stamps };
  }

  // The newest marketing consent record of either profile: a "no" there keeps marketing off.
  const consent = need('consents', await ops.from('customer_consents')
    .select('consented, created_at').in('customer_id', ids).eq('purpose', 'marketing')
    .order('created_at', { ascending: false }).limit(1)) || [];
  facts.latestConsent = consent.length ? consent[0].consented === true : null;
  return facts;
}

/** How many rows of each table name the source, for the preview. A failed count is null, never 0. */
export async function countSourceRows({ ops }, sourceId) {
  const out = {};
  await Promise.all(MERGE_TABLES.map(async (t) => {
    try {
      const res = await ops.from(t.table).select('customer_id', { count: 'exact', head: true }).eq('customer_id', sourceId);
      out[t.table] = res?.error ? null : (Number(res?.count) || 0);
    } catch {
      out[t.table] = null;
    }
  }));
  return out;
}

/**
 * Apply a plan (plan.ok must be true). Returns the steps that ran and, per table, how many rows
 * stayed on the folded in profile because the survivor already had them. Throws MergeStepError.
 */
export async function applyMerge({ ops, platform }, plan) {
  if (!plan?.ok) throw new MergeStepError('plan', new Error('the plan has refusals'));
  const T = plan.target_id;
  const S = plan.source_id;
  const done = [];
  const stayed = {};
  const must = async (step, query) => {
    let res;
    try { res = await query; } catch (e) { throw new MergeStepError(step, e, done.slice()); }
    if (res?.error) throw new MergeStepError(step, res.error, done.slice());
    if (!done.includes(step)) done.push(step);
    return res;
  };

  // ── Platform: memberships ──
  const mp = plan.memberships;
  for (const mv of mp.moves) {
    await must('membership_move', platform.from('customer_loyalty').update({ customer_id: T }).eq('id', mv.id).eq('customer_id', S));
  }
  if (mp.upserts.length) {
    await must('membership_fold', platform.from('customer_loyalty').upsert(mp.upserts, { onConflict: 'id' }));
  }
  for (const r of mp.referrals) {
    // Before the delete: referred_by is ON DELETE SET NULL, so a delete first would lose them.
    await must('membership_referrals', platform.from('customer_loyalty').update({ referred_by: r.to }).eq('referred_by', r.from).neq('id', r.to));
    await must('membership_claims', platform.from('loyalty_redemption_claims').update({ membership_id: r.to }).eq('membership_id', r.from));
  }
  for (const d of mp.deletes) {
    await must('membership_delete', platform.from('customer_loyalty').delete().eq('id', d.id).eq('customer_id', S));
  }

  // ── Platform: stamp cards ──
  const cp = plan.stamp_cards;
  for (const mv of cp.moves) {
    await must('card_move', platform.from('customer_stamp_cards').update({ customer_id: T }).eq('id', mv.id).eq('customer_id', S));
  }
  if (cp.upserts.length) {
    await must('card_fold', platform.from('customer_stamp_cards').upsert(cp.upserts, { onConflict: 'id' }));
  }
  for (const d of cp.deletes) {
    await must('card_delete', platform.from('customer_stamp_cards').delete().eq('id', d.id).eq('customer_id', S));
  }

  // ── Ops: every row that names the source ──
  for (const t of MERGE_TABLES) {
    if (t.sum) {
      const sRows = (await must(`read_${t.table}`, ops.from(t.table).select(LOCATION_COLS).eq('customer_id', S))).data || [];
      if (!sRows.length) continue;
      const tRows = (await must(`read_${t.table}`, ops.from(t.table).select(LOCATION_COLS).eq('customer_id', T))).data || [];
      const lp = planCustomerLocations(T, S, tRows, sRows);
      for (const mv of lp.moves) {
        await must(`repoint_${t.table}`, ops.from(t.table).update({ customer_id: T }).eq('customer_id', S).eq('location_id', mv.location_id));
      }
      if (lp.upserts.length) {
        await must(`fold_${t.table}`, ops.from(t.table).upsert(lp.upserts, { onConflict: 'customer_id,location_id' }));
      }
      for (const d of lp.deletes) {
        await must(`fold_${t.table}`, ops.from(t.table).delete().eq('customer_id', S).eq('location_id', d.location_id));
      }
      continue;
    }
    if (t.unique) {
      const cols = ['id', ...t.unique].join(', ');
      const sRows = (await must(`read_${t.table}`, ops.from(t.table).select(cols).eq('customer_id', S).limit(10000))).data || [];
      if (!sRows.length) continue;
      const tRows = (await must(`read_${t.table}`, ops.from(t.table).select(cols).eq('customer_id', T).limit(10000))).data || [];
      const { move, stay } = partitionClashes(sRows, tRows, t.unique);
      for (const slice of chunks(move)) {
        await must(`repoint_${t.table}`, ops.from(t.table).update({ customer_id: T }).in('id', slice).eq('customer_id', S));
      }
      if (stay.length) stayed[t.table] = stay.length;
      continue;
    }
    await must(`repoint_${t.table}`, ops.from(t.table).update({ customer_id: T }).eq('customer_id', S));
  }

  // ── Ops: the two profiles, in ONE statement (source let go, survivor filled) ──
  // A resume has no rows here (27 Sep 2026, first review): the survivor's profile is never
  // written a second time, so a phone changed or marketing turned off since stays as it is.
  const pc = plan.customers || {};
  if (pc.source && pc.target) {
    await must('fold_profiles', ops.from('customers').upsert([pc.source, pc.target], { onConflict: 'id' }));
  }

  // ── Ops: the survivor takes the phone and email the source let go of ──
  // Only into a field that is still null as the update runs (.is(..., null)): an update that
  // finds the field filled changes nothing. The unique indexes refuse a value another live
  // customer took meanwhile; that stops here and a retry skips it (resumeHandOver).
  const mv = pc.move || {};
  if (mv.phone || mv.phone_raw) {
    const patch = {};
    if (mv.phone) patch.phone = mv.phone;
    if (mv.phone_raw) patch.phone_raw = mv.phone_raw;
    let q = ops.from('customers').update(patch).eq('id', T).is('deleted_at', null).is('phone', null);
    if (mv.phone_raw) q = q.is('phone_raw', null);
    await must('hand_over_contact', q);
  }
  if (mv.email) {
    await must('hand_over_contact', ops.from('customers').update({ email: mv.email }).eq('id', T).is('deleted_at', null).is('email', null));
  }

  // ── Ops: the hand over is done; a later resume hands nothing over again ──
  if (pc.finish?.tags) {
    await must('merge_finished', ops.from('customers').update({ tags: pc.finish.tags }).eq('id', S));
  }
  return { steps: done, stayed };
}

/** The survivor as the screens need it: the profile, its memberships and its stamp cards. */
export async function readSurvivor({ ops, platform }, id) {
  const c = await ops.from('customers').select(SURVIVOR_COLS).eq('id', id).maybeSingle();
  if (c?.error) throw new MergeStepError('read_survivor', c.error);
  const [m, cards] = await Promise.all([
    platform.from('customer_loyalty').select('id, company_id, member_code, points_balance, visit_count, enrolled_at').eq('customer_id', id),
    platform.from('customer_stamp_cards').select('program_id, company_id, stamps_collected, completed_count, last_stamp_at').eq('customer_id', id),
  ]);
  return {
    customer: c?.data ?? null,
    memberships: m?.error ? [] : (m?.data || []),
    stamp_cards: cards?.error ? [] : (cards?.data || []),
  };
}
