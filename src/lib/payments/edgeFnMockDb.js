// src/lib/payments/edgeFnMockDb.js
//
// TEST ONLY. An in-memory stand in for supabase-js: just enough PostgREST for the card reader
// edge functions (adyen-terminal-charge and terminal-job-create) to RUN under `npm test`.
// readerLockReplay.test.js bundles those two functions, points their supabase-js import at this
// file, and replays real card reader timelines against the real code. Nothing in the app imports
// this file, so it never reaches a build.
//
// Two databases, picked by the URL createClient is given (the Ops project and the Platform
// project). The two rules of the real tables that the replays lean on are kept here:
//   - a primary key refuses a second row (activity_events and adyen_webhook_events are how a
//     note is written "exactly once"),
//   - terminal_jobs allows one live job per card machine and one per check (the two unique
//     indexes terminal-job-create answers 23505 for).

export const dbs = { ops: {}, platform: {} };
/** Database functions the replays need, by name: (args, db) => answer. */
export const rpcs = {};
/** Every write, in order, for the replay's own checks. */
export const writes = [];
/** Sign ins: bearer token to user id (auth.getUser). The service role key is never in here. */
export const users = {};

const PKS = { adyen_webhook_events: 'event_key', activity_events: 'id', terminal_jobs: 'id' };
const LIVE_PER_READER = ['claimed', 'tipping', 'charging_unsent', 'charging'];
const LIVE_PER_CHECK = ['pending', 'claimed', 'tipping', 'charging_unsent', 'charging', 'unknown'];

const likeToRe = (p) => new RegExp('^' + String(p).split('%').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const val = (v) => (v instanceof Date ? v.toISOString() : v);
const duplicate = (name) => ({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${name}"` } });

/** Empty both databases (the same objects stay exported). */
export function resetDb() {
  for (const db of [dbs.ops, dbs.platform]) for (const k of Object.keys(db)) delete db[k];
  for (const k of Object.keys(users)) delete users[k];
  writes.length = 0;
}

class Query {
  constructor(dbName, table) {
    this.dbName = dbName; this.table = table; this.filters = []; this.op = 'select';
    this._order = null; this._limit = null; this._single = false; this._returning = false;
  }
  rows() { return (dbs[this.dbName][this.table] ||= []); }
  select() { if (this.op !== 'select') this._returning = true; return this; }
  insert(row) { this.op = 'insert'; this.payload = Array.isArray(row) ? row : [row]; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { throw new Error('mock: delete is not supported (nothing on the card path deletes)'); }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  in(c, list) { this.filters.push((r) => list.includes(r[c])); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  not(c, op, v) {
    if (op !== 'is' || v !== null) throw new Error(`mock: not(${c},${op},${v}) unsupported`);
    this.filters.push((r) => r[c] != null); return this;
  }
  gte(c, v) { this.filters.push((r) => r[c] != null && cmp(val(r[c]), v) >= 0); return this; }
  lte(c, v) { this.filters.push((r) => r[c] != null && cmp(val(r[c]), v) <= 0); return this; }
  gt(c, v) { this.filters.push((r) => r[c] != null && cmp(val(r[c]), v) > 0); return this; }
  lt(c, v) { this.filters.push((r) => r[c] != null && cmp(val(r[c]), v) < 0); return this; }
  like(c, p) { const re = likeToRe(p); this.filters.push((r) => typeof r[c] === 'string' && re.test(r[c])); return this; }
  or(expr) {
    const parts = String(expr).split(',').map((p) => {
      const [c, op, ...rest] = p.split('.');
      if (op !== 'eq') throw new Error(`mock: or(${expr}) unsupported`);
      return [c, rest.join('.')];
    });
    this.filters.push((r) => parts.some(([c, v]) => String(r[c]) === v)); return this;
  }
  order(c, { ascending = true } = {}) { this._order = [c, ascending]; return this; }
  limit(n) { this._limit = n; return this; }
  maybeSingle() { this._single = true; return this; }
  single() { this._single = true; return this; }
  run() {
    const match = (r) => this.filters.every((f) => f(r));
    if (this.op === 'insert') {
      const pk = PKS[this.table];
      for (const row of this.payload) {
        if (pk && row[pk] != null && this.rows().some((r) => r[pk] === row[pk])) return duplicate(`${this.table}_pkey`);
        if (this.table === 'terminal_jobs') {
          if (LIVE_PER_CHECK.includes(row.status) && this.rows().some((r) => r.check_key === row.check_key && LIVE_PER_CHECK.includes(r.status))) return duplicate('idx_tj_one_live_per_check');
          if (LIVE_PER_READER.includes(row.status) && this.rows().some((r) => r.target_terminal_id === row.target_terminal_id && LIVE_PER_READER.includes(r.status))) return duplicate('idx_tj_one_live_per_terminal');
        }
      }
      const added = this.payload.map((row) => ({ created_at: new Date().toISOString(), ...row }));
      this.rows().push(...added);
      writes.push({ at: Date.now(), db: this.dbName, table: this.table, op: 'insert', rows: added.map((r) => ({ ...r })) });
      return { data: this._returning ? (this._single ? added[0] : added) : null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.rows().filter(match);
      for (const r of hit) Object.assign(r, this.payload);
      writes.push({ at: Date.now(), db: this.dbName, table: this.table, op: 'update', patch: { ...this.payload }, ids: hit.map((r) => r.id ?? null) });
      return { data: this._returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    let out = this.rows().filter(match).map((r) => ({ ...r }));
    if (this._order) { const [c, asc] = this._order; out.sort((a, b) => (asc ? 1 : -1) * cmp(val(a[c]) ?? '', val(b[c]) ?? '')); }
    if (this._limit != null) out = out.slice(0, this._limit);
    if (this._single) return out.length > 1 ? { data: null, error: { code: 'PGRST116', message: 'more than one row' } } : { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  then(res, rej) {
    let r;
    try { r = this.run(); } catch (e) { return Promise.reject(e).then(res, rej); }
    return Promise.resolve(r).then(res, rej);
  }
}

export function createClient(url) {
  const dbName = String(url).includes('platform') ? 'platform' : 'ops';
  return {
    from: (table) => new Query(dbName, table),
    rpc: (name, args) => {
      const fn = rpcs[name];
      if (!fn) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `mock: no rpc ${name}` } });
      try { return Promise.resolve({ data: fn(args, dbs[dbName]), error: null }); }
      catch (e) { return Promise.resolve({ data: null, error: { code: 'P0001', message: e.message } }); }
    },
    auth: { getUser: async (token) => ({ data: { user: users[token] ? { id: users[token] } : null } }) },
  };
}
