export const DB = {};
export const WRITES = [];
class Q {
  constructor(t) { this.t = t; this.f = []; this.lim = 1000; this.one = null; this.mode = 'select'; this.patch = null; }
  select() { return this; }
  update(p) { this.mode = 'update'; this.patch = p; return this; }
  insert(rows) { this.mode = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows) { return this.insert(rows); }
  delete() { this.mode = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.f.push((r) => String(r[c]) !== String(v)); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c, vs) { const s = new Set(vs.map(String)); this.f.push((r) => s.has(String(r[c]))); return this; }
  gte(c, v) { this.f.push((r) => r[c] != null && r[c] >= v); return this; }
  gt(c, v) { this.f.push((r) => r[c] != null && Number(r[c]) > Number(v)); return this; }
  lte(c, v) { this.f.push((r) => r[c] != null && r[c] <= v); return this; }
  lt(c, v) { this.f.push((r) => r[c] != null && r[c] < v); return this; }
  not(c, op, v) { if (op === 'is' && v === null) this.f.push((r) => r[c] != null); return this; }
  or() { return this; } order() { return this; }
  range(a, b) { this.lim = b - a + 1; return this; }
  limit(n) { this.lim = Math.min(n, 1000); return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  single() { this.one = 'single'; return this; }
  then(res, rej) {
    const tbl = (DB[this.t] ||= []);
    let data = null, error = null;
    if (this.mode === 'update') {
      if (DB.__missingCols?.some((c) => c in this.patch)) { error = { message: `column "${DB.__missingCols.find((c) => c in this.patch)}" of relation "${this.t}" does not exist` }; }
      else { const hit = tbl.filter((r) => this.f.every((f) => f(r))); hit.forEach((r) => Object.assign(r, this.patch)); WRITES.push({ t: this.t, patch: this.patch }); data = hit; }
    } else if (this.mode === 'insert') { const rows = this.rows.map((r, i) => ({ id: r.id || `${this.t}-${tbl.length + i}`, ...r })); tbl.push(...rows); data = this.one ? rows[0] : rows; }
    else if (this.mode === 'delete') { data = []; }
    else { const rows = tbl.filter((r) => this.f.every((f) => f(r))).slice(0, this.lim); data = this.one ? (rows[0] ?? null) : rows; }
    return Promise.resolve({ data, error }).then(res, rej);
  }
}
export function createClient() {
  return { from: (t) => new Q(t), auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) }, rpc: async () => ({ data: null, error: null }) };
}
