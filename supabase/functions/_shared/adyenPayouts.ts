// supabase/functions/_shared/adyenPayouts.ts
//
// The two Adyen for Platforms writes that make money REACH a venue, shared by
// adyen-terminal-admin (the go live flow's step 5, Payouts and commission:
// set_split and setup_sweep) and adyen-onboard (configure_splits and
// setup_sweep). One copy of the calls, so the two doors cannot drift.
//
// Endpoints (docs.adyen.com, confirmed 9 Sep 2026):
//   POST   {mgmt}/merchants/{m}/splitConfigurations                 the commission profile
//   PATCH  {mgmt}/merchants/{m}/stores/{storeId}                    { splitConfiguration: { splitConfigurationId, balanceAccountId } }
//          (PATCH {mgmt}/stores/{storeId} when no merchant is given)
//   DELETE {mgmt}/merchants/{m}/splitConfigurations/{id}            ONLY the profile made seconds ago when the
//                                                                   store PATCH is refused (never the old one)
//   GET    {bcl}/balanceAccounts/{id}/sweeps                        idempotency: reuse the push to this bank
//   PATCH  {bcl}/balanceAccounts/{id}/sweeps/{sweepId}              { schedule } or { counterparty, schedule } or { status }
//   POST   {bcl}/balanceAccounts/{id}/sweeps                        sweepPayload (push, bank, daily, full balance)
// A profile on the store is enough on its own: Adyen applies it to every
// payment through the store, no request needs split instructions, and with
// NO profile the whole sale books to the platform's liable account. The
// commission always lands in the liable account, so the profile needs no
// liable account id; the store's balanceAccountId is the venue's.
//
// THE OLD PROFILE IS NEVER DELETED (9 Sep 2026). A split configuration
// profile is reusable across stores, and the one a store carried may be one
// FranPOS made in the Customer Area and attached to several stores: deleting
// it would strip the split from every other store naming it, and each sale
// there would book to ServOS's liable account. An unreferenced profile is
// harmless, so the old id is only handed back for the audit trail.
//
// ONE SWEEP, NEVER TWO (9 Sep 2026). Two active daily push sweeps on one
// balance account race at 07:00 CET and whichever runs first takes the whole
// balance, so a venue that changed bank could be paid to the account it
// stopped using. ensurePushSweep therefore RETARGETS an active push sweep
// that points at another bank (PATCH counterparty) instead of creating a
// second, and switches any further ones off.
//
// PURE of Supabase and Deno: the callers pass their own Adyen callers (the
// venue's config, keys and hosts are theirs) and log what came back.

import { findPushSweep, sweepRows, sweepSummary, sweepPayload, type SweepSummary } from './adyenLink.ts';

export interface AdyenAnswer<T = any> { ok: boolean; status: number; data: T }
export interface AdyenApi {
  mgmt: (method: string, path: string, body?: unknown) => Promise<AdyenAnswer>;
  bcl: (method: string, path: string, body?: unknown, idempotencyKey?: string) => Promise<AdyenAnswer>;
}

type Dict = Record<string, any>;
const enc = (v: unknown): string => encodeURIComponent(String(v ?? ''));

export interface SplitOutcome {
  ok: boolean;
  // Where it stopped: create (no profile), patch (profile made, store not
  // pointed at it), done.
  stage: 'create' | 'patch' | 'done';
  status: number;
  splitConfigurationId: string | null;
  // The raw Adyen answers, for the audit trail.
  created: unknown;
  patched: unknown;
  // The profile the store carried before (handed back for the log, never
  // deleted: it may still be on other stores).
  previousProfileId: string | null;
  // On a refused store PATCH the profile made seconds ago is ServOS's own
  // orphan and is deleted best effort, so the next click does not leave a
  // second one on the merchant: true deleted, false Adyen refused, null when
  // there was nothing to tidy.
  orphanDeleted: boolean | null;
}

// Create the profile on the merchant and point the store at it and at the
// venue balance account, in that order. A refused PATCH deletes the profile
// just made (best effort) and answers stage 'patch' with its id, so the
// caller can say what happened; the profile the store carried before is
// LEFT ALONE (see the header).
export async function createSplitOnStore(api: AdyenApi, opts: {
  merchant: string; storeId: string; balanceAccountId: string; profile: Dict; previousProfileId?: string | null;
}): Promise<SplitOutcome> {
  const m = enc(opts.merchant);
  const previousProfileId = String(opts.previousProfileId ?? '').trim() || null;
  const created = await api.mgmt('POST', `/merchants/${m}/splitConfigurations`, opts.profile);
  const id = String((created.data as Dict | null)?.splitConfigurationId ?? '').trim();
  if (!created.ok || !id) {
    return { ok: false, stage: 'create', status: created.status, splitConfigurationId: null, created: created.data ?? null, patched: null, previousProfileId, orphanDeleted: null };
  }
  const storePath = opts.merchant ? `/merchants/${m}/stores/${enc(opts.storeId)}` : `/stores/${enc(opts.storeId)}`;
  const patched = await api.mgmt('PATCH', storePath, { splitConfiguration: { splitConfigurationId: id, balanceAccountId: opts.balanceAccountId } });
  if (!patched.ok) {
    let orphanDeleted: boolean | null = null;
    try {
      const del = await api.mgmt('DELETE', `/merchants/${m}/splitConfigurations/${enc(id)}`);
      orphanDeleted = del.ok;
    } catch { orphanDeleted = false; }
    return { ok: false, stage: 'patch', status: patched.status, splitConfigurationId: id, created: created.data ?? null, patched: patched.data ?? null, previousProfileId, orphanDeleted };
  }
  return { ok: true, stage: 'done', status: patched.status, splitConfigurationId: id, created: created.data ?? null, patched: patched.data ?? null, previousProfileId, orphanDeleted: null };
}

export interface SweepOutcome {
  ok: boolean;
  // Where it stopped: list (the sweeps could not be read), update (an
  // existing sweep could not be rescheduled or repointed), create, done.
  stage: 'list' | 'update' | 'create' | 'done';
  status: number;
  sweep: SweepSummary | null;
  created: boolean;
  existed: boolean;
  updated: boolean;
  // An active push sweep to ANOTHER bank was repointed at the chosen one
  // (its id), and any further ones were switched off (their ids).
  retargeted: string | null;
  deactivated: string[];
  // The raw Adyen answer of the call that decided it, for the audit trail.
  data: unknown;
}

// The daily push of the full balance to the venue's bank, idempotent and
// SINGLE: the existing push to THIS bank is reused (rescheduled when the
// schedule differs); an active push to ANOTHER bank is repointed at this one
// (never a second sweep); any further active pushes are switched off; only
// with none at all is one created. The caller's idempotency key names the
// bank (sweep:<env>:<venue>:<SI...>), so a create for a different bank
// inside Adyen's replay window is a new request, not a replay.
export async function ensurePushSweep(api: AdyenApi, opts: {
  balanceAccountId: string; transferInstrumentId: string; currency: string;
  schedule?: string; cronExpression?: string | null; description?: string; idempotencyKey?: string;
}): Promise<SweepOutcome> {
  const ba = enc(opts.balanceAccountId);
  const payload = sweepPayload({
    transferInstrumentId: opts.transferInstrumentId, currency: opts.currency,
    schedule: opts.schedule, cronExpression: opts.cronExpression, description: opts.description,
  });
  const wanted = payload.schedule as Dict;
  const none = { created: false, existed: false, updated: false, retargeted: null as string | null, deactivated: [] as string[] };
  const list = await api.bcl('GET', `/balanceAccounts/${ba}/sweeps`);
  if (!list.ok) return { ok: false, stage: 'list', status: list.status, sweep: null, ...none, data: list.data ?? null };
  const rawOf = (id: string): Dict | null => (sweepRows(list.data).find((s) => String(s?.id ?? '') === id) as Dict | undefined) ?? null;
  const livePushes = sweepRows(list.data).map(sweepSummary)
    .filter((s): s is SweepSummary => !!s && !!s.id && s.type === 'push' && s.category === 'bank' && s.status !== 'inactive');
  const existing = findPushSweep(list.data, opts.transferInstrumentId);
  // The one sweep that stays: the push to this bank, else the first active
  // push to another bank (repointed below). Every other active push goes off.
  const keep = existing ?? livePushes[0] ?? null;
  const deactivated: string[] = [];
  for (const other of livePushes) {
    if (!keep || other.id === keep.id) continue;
    const off = await api.bcl('PATCH', `/balanceAccounts/${ba}/sweeps/${enc(other.id as string)}`, { status: 'inactive' });
    if (!off.ok) return { ok: false, stage: 'update', status: off.status, sweep: other, ...none, existed: true, deactivated, data: off.data ?? null };
    deactivated.push(other.id as string);
  }
  if (keep?.id) {
    const keepId = keep.id as string;
    const raw = rawOf(keepId);
    const sameBank = keep.transferInstrumentId === opts.transferInstrumentId;
    const sameCron = wanted.type !== 'cron' || String(raw?.schedule?.cronExpression ?? '') === String(wanted.cronExpression ?? '');
    const sameSchedule = keep.schedule === wanted.type && sameCron;
    if (!sameBank || !sameSchedule) {
      const change: Dict = sameBank ? { schedule: wanted } : { counterparty: { transferInstrumentId: opts.transferInstrumentId }, schedule: wanted };
      const up = await api.bcl('PATCH', `/balanceAccounts/${ba}/sweeps/${enc(keepId)}`, change);
      if (!up.ok) return { ok: false, stage: 'update', status: up.status, sweep: keep, ...none, existed: true, deactivated, data: up.data ?? null };
      return {
        ok: true, stage: 'done', status: up.status,
        sweep: {
          ...keep, schedule: String(wanted.type), transferInstrumentId: opts.transferInstrumentId,
          status: String((up.data as Dict)?.status ?? keep.status ?? 'active').toLowerCase(),
        },
        created: false, existed: true, updated: true, retargeted: sameBank ? null : keepId, deactivated, data: up.data ?? null,
      };
    }
    return { ok: true, stage: 'done', status: list.status, sweep: keep, created: false, existed: true, updated: false, retargeted: null, deactivated, data: null };
  }
  const r = await api.bcl('POST', `/balanceAccounts/${ba}/sweeps`, payload, opts.idempotencyKey);
  const id = String((r.data as Dict | null)?.id ?? '').trim();
  if (!r.ok || !id) return { ok: false, stage: 'create', status: r.status, sweep: null, ...none, deactivated, data: r.data ?? null };
  return {
    ok: true, stage: 'done', status: r.status,
    sweep: {
      id, type: 'push', category: 'bank', schedule: String(wanted.type),
      status: String((r.data as Dict)?.status ?? 'active').toLowerCase(),
      transferInstrumentId: opts.transferInstrumentId, currency: String(payload.currency),
    },
    created: true, existed: false, updated: false, retargeted: null, deactivated, data: r.data ?? null,
  };
}
