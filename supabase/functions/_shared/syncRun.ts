// supabase/functions/_shared/syncRun.ts
//
// One row per thing we post to an accounting system (xero_sync_log today: a day of takings
// keyed by ref_date, a bill keyed by ref_id), used as a LOCK, a PROGRESS record and a HISTORY.
//
// Why (19 Sep 2026): the old code deleted the row and inserted a new one on every attempt,
// so an error wiped the record of what had already been posted, two runs at once (the
// nightly post and someone pressing the button) could both post, and a day that failed
// halfway re-posted the half that had worked. Now:
//   - LOCK: a run claims the row with a compare and set on updated_at (or by inserting it;
//     the unique index turns a second insert away) and holds a lease for a few minutes. A
//     run that finds a live lease answers "busy" and posts nothing.
//   - PROGRESS: each posting is recorded as 'sending' BEFORE the request and 'posted' with
//     the remote id after it, so a retry skips what is done and checks the remote system
//     for anything whose answer was lost.
//   - HISTORY: every attempt is appended to detail.history (the last 40 are kept). The row is
//     updated in place, never deleted.
// No schema change: it uses the existing columns (status, xero_id, detail jsonb, updated_at).

export type SyncKey = { table: string; locationId: string; kind: string; refDate?: string | null; refId?: string | null };

const LEASE_MS = 5 * 60 * 1000;
const HISTORY_MAX = 40;

function keyed(q: any, key: SyncKey) {
  q = q.eq('location_id', key.locationId).eq('kind', key.kind);
  if (key.refDate) q = q.eq('ref_date', key.refDate);
  if (key.refId) q = q.eq('ref_id', key.refId);
  return q;
}

/** The current row, or null. */
export async function readSyncRow(sb: any, key: SyncKey): Promise<any | null> {
  const { data, error } = await keyed(sb.from(key.table).select('id,status,xero_id,detail,updated_at'), key).maybeSingle();
  if (error) throw new Error(`Could not read the sync log: ${error.message}`);
  return data || null;
}

export class SyncRun {
  sb: any; key: SyncKey; runId: string; id: string; updatedAt: string; detail: any; status: string; startedAt: string; lost = false;
  constructor(sb: any, key: SyncKey, runId: string, row: any) {
    this.sb = sb; this.key = key; this.runId = runId; this.id = row.id; this.updatedAt = row.updated_at;
    this.detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
    this.status = row.status; this.startedAt = new Date().toISOString();
  }

  /** Postings recorded so far: { [postingKey]: { status:'sending'|'posted', id?, reference, at } }. */
  get postings(): Record<string, any> { return (this.detail.postings && typeof this.detail.postings === 'object') ? this.detail.postings : {}; }

  /** Write the row, still holding the lease. Compare and set on updated_at: a lost lease throws. */
  async save(patch: { status?: string; xero_id?: string | null; detail?: Record<string, unknown> } = {}) {
    const now = new Date().toISOString();
    const detail = { ...this.detail, ...(patch.detail || {}), lock: { runId: this.runId, until: new Date(Date.now() + LEASE_MS).toISOString() } };
    const upd: Record<string, unknown> = { detail, updated_at: now };
    if (patch.status) upd.status = patch.status;
    if (patch.xero_id !== undefined) upd.xero_id = patch.xero_id;
    const { data, error } = await this.sb.from(this.key.table).update(upd).eq('id', this.id).eq('updated_at', this.updatedAt).select('id,updated_at');
    if (error) throw new Error(`Could not write the sync log: ${error.message}`);
    if (!data || !data.length) { this.lost = true; throw new Error('Another run took over this posting. Nothing more was sent; try again in a few minutes.'); }
    this.updatedAt = data[0].updated_at; this.detail = detail;
    if (patch.status) this.status = patch.status;
  }

  async setPosting(postingKey: string, value: Record<string, unknown>) {
    await this.save({ detail: { postings: { ...this.postings, [postingKey]: { ...value, at: new Date().toISOString() } } } });
  }

  /**
   * Finish: final status and detail, the lease released, this attempt appended to history.
   * `attempt` is a small summary ({ ok, error?, posted, skipped, auto, ... }).
   */
  async finish(status: string, patch: { xero_id?: string | null; detail?: Record<string, unknown> } = {}, attempt: Record<string, unknown> = {}) {
    const history = Array.isArray(this.detail.history) ? this.detail.history : [];
    const entry = { runId: this.runId, startedAt: this.startedAt, endedAt: new Date().toISOString(), status, ...attempt };
    const detail = { ...this.detail, ...(patch.detail || {}), history: [...history, entry].slice(-HISTORY_MAX) };
    delete (detail as any).lock;
    const upd: Record<string, unknown> = { status, detail, updated_at: new Date().toISOString() };
    if (patch.xero_id !== undefined) upd.xero_id = patch.xero_id;
    const { data, error } = await this.sb.from(this.key.table).update(upd).eq('id', this.id).eq('updated_at', this.updatedAt).select('id');
    if (error) throw new Error(`Could not write the sync log: ${error.message}`);
    if (!data || !data.length) this.lost = true;
    this.detail = detail; this.status = status;
  }
}

/**
 * Claim the row for this run. Returns { run } when claimed, { busy: row } when another run
 * holds a live lease (or won a race for it), or { done: row } when the row is already 'ok'
 * and `allowDone` is not set.
 */
export async function claimSyncRun(sb: any, key: SyncKey, opts: { runId?: string; allowDone?: boolean } = {}): Promise<{ run?: SyncRun; busy?: any; done?: any }> {
  const runId = opts.runId || crypto.randomUUID();
  const now = Date.now();
  const lock = { runId, until: new Date(now + LEASE_MS).toISOString() };
  const row = await readSyncRow(sb, key);
  if (row) {
    if (row.status === 'ok' && !opts.allowDone) return { done: row };
    const held = row.detail?.lock;
    if (held && held.runId !== runId && Date.parse(held.until) > now) return { busy: row };
    const detail = { ...(row.detail && typeof row.detail === 'object' ? row.detail : {}), lock };
    const { data, error } = await sb.from(key.table).update({ detail, updated_at: new Date(now).toISOString() })
      .eq('id', row.id).eq('updated_at', row.updated_at).select('id,status,xero_id,detail,updated_at');
    if (error) throw new Error(`Could not write the sync log: ${error.message}`);
    if (!data || !data.length) return { busy: row };
    return { run: new SyncRun(sb, key, runId, data[0]) };
  }
  const ins: Record<string, unknown> = {
    location_id: key.locationId, kind: key.kind, ref_date: key.refDate || null, ref_id: key.refId || null,
    status: 'running', detail: { lock, postings: {}, history: [] }, updated_at: new Date(now).toISOString(),
  };
  const { data, error } = await sb.from(key.table).insert(ins).select('id,status,xero_id,detail,updated_at');
  if (error) {
    if (error.code === '23505') return { busy: await readSyncRow(sb, key) };   // another run inserted first
    throw new Error(`Could not write the sync log: ${error.message}`);
  }
  return { run: new SyncRun(sb, key, runId, data[0]) };
}
