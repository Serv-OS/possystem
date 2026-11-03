// src/lib/forms/memDb.js
//
// A small in-memory stand in for the supabase-js query builder, for the marketing forms tests
// (formSubmitRun.test.js, formAutomation.test.js). It holds rows per table, applies the filters
// the code under test uses, and enforces the unique indexes that matter (a second insert for the
// same key is refused the way Postgres refuses it, code 23505). Not a general fake: only what the
// forms path calls. `missingColumns: { table: ['col'] }` makes a write naming that column fail
// with 42703, as a database without the forms SQL would.

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const UNIQUE = {
  customers: [(r) => (r.deleted_at ? null : r.phone ? `p:${r.org_id}:${r.phone}` : null), (r) => (r.deleted_at ? null : r.email ? `e:${r.org_id}:${String(r.email).toLowerCase()}` : null)],
  workflow_enrollments: [(r) => `${r.workflow_id}:${r.customer_id}`],
  workflow_step_sends: [(r) => `${r.enrollment_id}:${r.step_key}`],
  promo_codes: [(r) => String(r.code).toUpperCase()],
};

function likeToRe(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '\\' && i + 1 < pat.length) { out += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') out += '.*'; else if (ch === '_') out += '.'; else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

export function memDb(seed = {}, { missingColumns = {}, failInsert = {} } = {}) {
  const tables = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const rowsOf = (t) => (tables[t] = tables[t] || []);
  const log = [];

  function from(table) {
    const st = { op: 'select', cols: '*', filters: [], order: [], lim: null, range: null, count: false, head: false, payload: null, upsert: null, returning: false };
    const pass = (r) => st.filters.every((f) => f(r));
    const b = {
      select(cols = '*', opts = {}) { if (st.op !== 'select') st.returning = true; else { st.cols = cols; st.count = !!opts.count; st.head = !!opts.head; } return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      upsert(p, opts = {}) { st.op = 'upsert'; st.payload = p; st.upsert = opts; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(c, v) { st.filters.push((r) => r[c] !== undefined && r[c] !== null && String(r[c]) === String(v)); return b; },
      neq(c, v) { st.filters.push((r) => String(r[c]) !== String(v)); return b; },
      gte(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return b; },
      lte(c, v) { st.filters.push((r) => r[c] != null && String(r[c]) <= String(v)); return b; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c, op, v) { if (op === 'is' && v === null) st.filters.push((r) => r[c] != null); return b; },
      in(c, vs) { const set = new Set(vs.map(String)); st.filters.push((r) => r[c] != null && set.has(String(r[c]))); return b; },
      ilike(c, pat) { const re = likeToRe(pat); st.filters.push((r) => r[c] != null && re.test(String(r[c]))); return b; },
      or() { return b; },
      order(c, { ascending = true } = {}) { st.order.push([c, ascending]); return b; },
      limit(n) { st.lim = n; return b; },
      range(a, z) { st.range = [a, z]; return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      single() { st.single = 'one'; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };

    function missing(row) {
      const cols = missingColumns[table] || [];
      const hit = cols.find((c) => row && Object.prototype.hasOwnProperty.call(row, c));
      return hit ? { code: '42703', message: `column "${hit}" of relation "${table}" does not exist` } : null;
    }
    function conflict(row, except = null) {
      for (const key of UNIQUE[table] || []) {
        const k = key(row);
        if (k && rowsOf(table).some((x) => x !== except && key(x) === k)) return true;
      }
      return false;
    }
    function shape(list) {
      let out = list;
      for (const [c, asc] of [...st.order].reverse()) out = out.slice().sort((a, z) => (String(a[c]) === String(z[c]) ? 0 : (String(a[c]) < String(z[c])) === asc ? -1 : 1));
      if (st.range) out = out.slice(st.range[0], st.range[1] + 1);
      if (st.lim != null) out = out.slice(0, st.lim);
      const cols = String(st.cols).split(',').map((c) => c.trim());
      return out.map((r) => (cols.includes('*') ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]]))));
    }
    function finish(list, error = null) {
      if (error) return { data: null, error, count: null };
      if (st.single === 'maybe') return { data: list[0] || null, error: list.length > 1 ? { message: 'more than one row' } : null };
      if (st.single === 'one') return list.length === 1 ? { data: list[0], error: null } : { data: null, error: { message: 'not one row' } };
      return { data: list, error: null };
    }

    function run() {
      log.push({ table, op: st.op, payload: st.payload });
      if (st.op === 'select') {
        const found = rowsOf(table).filter(pass);
        if (st.head) return { data: null, error: null, count: found.length };
        const res = finish(shape(found));
        if (st.count) res.count = found.length;
        return res;
      }
      if (st.op === 'insert' || st.op === 'upsert') {
        if (st.op === 'insert' && failInsert[table]) return finish([], { message: `insert refused (fake ${table})` });
        const list = Array.isArray(st.payload) ? st.payload : [st.payload];
        const made = [];
        for (const p of list) {
          const err = missing(p);
          if (err) return finish([], err);
          const row = { id: uid(), created_at: new Date().toISOString(), ...p };
          if (conflict(row)) {
            if (st.op === 'upsert' && st.upsert && st.upsert.ignoreDuplicates) continue;
            return finish([], { code: '23505', message: `duplicate key value violates unique constraint on ${table}` });
          }
          rowsOf(table).push(row);
          made.push(row);
        }
        return st.returning || st.single ? finish(shape(made)) : { data: null, error: null };
      }
      if (st.op === 'update') {
        const err = missing(st.payload);
        if (err) return finish([], err);
        const hit = rowsOf(table).filter(pass);
        for (const r of hit) Object.assign(r, st.payload);
        return st.returning || st.single ? finish(shape(hit)) : { data: null, error: null };
      }
      if (st.op === 'delete') {
        tables[table] = rowsOf(table).filter((r) => !pass(r));
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'unknown op' } };
    }
    return b;
  }
  return { from, tables, log, rows: rowsOf };
}
