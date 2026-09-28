// src/lib/fixtures/fakeWfDb.js
//
// One in memory database that answers the PostgREST calls the workforce edge functions make
// (select, eq, is, order, limit, maybeSingle, insert, update, delete), for wfAudit.test.js and
// clockSheet.test.js (28 Sep 2026). Every request is logged as a list of its calls, so a test can
// pin a read request for request. wf_audit rows get an increasing `at`, as the column default
// now() would give them. fail[table] makes the next request to that table answer an error,
// fail['table.insert'] (or .update, .delete, .select) the next request of that kind.

export function fakeWfDb(init = {}) {
  const db = JSON.parse(JSON.stringify(init));
  const log = [];
  const fail = {};
  let clock = Date.parse('2026-09-28T00:00:00Z');
  const from = (table) => {
    const q = { op: 'select', filters: [], cols: '*', lim: null, single: false, order: null, patch: null, rows: null };
    const calls = [['from', table]];
    const match = (r) => q.filters.every((f) => f(r));
    const project = (r) => (q.cols === '*' ? { ...r } : Object.fromEntries(String(q.cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, r[c] ?? null])));
    const run = () => {
      log.push(calls);
      for (const k of [`${table}.${q.op}`, table]) {
        if (fail[k]) { const message = fail[k]; delete fail[k]; return { data: null, error: { message } }; }
      }
      const all = db[table] || [];
      if (q.op === 'insert') {
        const rows = q.rows.map((r) => {
          const row = { ...r };
          if (table === 'wf_audit' && row.at == null) { clock += 1000; row.at = new Date(clock).toISOString(); }
          if (row.id == null) row.id = `${table}-${all.length + 1}`;
          return row;
        });
        db[table] = [...all, ...rows];
        return { data: null, error: null };
      }
      if (q.op === 'update') { db[table] = all.map((r) => (match(r) ? { ...r, ...q.patch } : r)); return { data: null, error: null }; }
      if (q.op === 'delete') { db[table] = all.filter((r) => !match(r)); return { data: null, error: null }; }
      let rows = all.filter(match);
      if (q.order) rows = [...rows].sort((a, b) => (String(a[q.order.c]) < String(b[q.order.c]) ? -1 : String(a[q.order.c]) > String(b[q.order.c]) ? 1 : 0) * (q.order.asc ? 1 : -1));
      if (q.lim != null) rows = rows.slice(0, q.lim);
      if (q.single) return { data: rows[0] ? project(rows[0]) : null, error: null };
      return { data: rows.map(project), error: null };
    };
    const b = {
      select(cols) { calls.push(['select', cols]); q.cols = cols || '*'; return b; },
      eq(c, v) { calls.push(['eq', c, v]); q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      is(c, v) { calls.push(['is', c, v]); q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order(c, o) { calls.push(['order', c, o]); q.order = { c, asc: o?.ascending !== false }; return b; },
      limit(n) { calls.push(['limit', n]); q.lim = n; return b; },
      maybeSingle() { calls.push(['maybeSingle']); q.single = true; return b; },
      insert(rows) { calls.push(['insert']); q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      update(patch) { calls.push(['update']); q.op = 'update'; q.patch = patch; return b; },
      delete() { calls.push(['delete']); q.op = 'delete'; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };
    return b;
  };
  return { from, log, fail, rows: (t) => JSON.parse(JSON.stringify(db[t] || [])) };
}
