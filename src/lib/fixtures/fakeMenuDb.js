// src/lib/fixtures/fakeMenuDb.js
//
// An in memory database that answers like PostgREST for the menu tables, for the stale tab
// tests (27 Sep 2026: menuRowWrite.test.js, menuWriters.test.js, venueMenuRead.test.js).
// What it does that the real one does and the tests depend on:
//   * update(...).eq(...).select() and delete().eq(...).select() return ONLY the rows they
//     changed (none: an empty list)
//   * upsert(..., { ignoreDuplicates: true }) is ON CONFLICT DO NOTHING: an existing id is
//     left alone and not returned
//   * `trigger: true` stamps updated_at from its own clock on every insert and update, as
//     20260927_OPS_menu_rows_server_time.sql does; without it the value the writer sends is
//     stored as it is (the database before the migration)
//   * range() pages, maybeSingle() returns one row or null
//   * `beforeWrite(table, op)` runs before each write, so a test can slip another window's
//     write in between a read and a write
//   * `afterRead(table)` holds a read's answer back AFTER its rows were taken (a slow network),
//     so a test can land a write between a read and its answer
//   * `readFail(table)` returning true makes that read fail
//   * `refuse(table, op, row)` returning true makes a write match nothing (row level security)

export function fakeMenuDb(init = {}, { trigger = false, start = Date.parse('2026-09-27T13:50:00.000Z') } = {}) {
  const db = JSON.parse(JSON.stringify(init));
  let clock = start;
  const log = [];
  const hooks = { beforeWrite: null, refuse: null, readFail: null, afterRead: null };
  const tick = () => { clock += 7; return new Date(clock).toISOString(); };

  const from = (table) => {
    const q = { op: 'select', filters: [], orders: [], range: null, single: false, patch: null, rows: null, ignoreDuplicates: false, returning: false };
    const match = (r) => q.filters.every((f) => f(r));
    const run = async () => {
      const rows = db[table] || (db[table] = []);
      if (q.op === 'select') {
        log.push(`${table}.select`);
        if (hooks.readFail && hooks.readFail(table)) return { data: null, error: { message: `read of ${table} failed (fake)` } };
        let out = rows.filter(match);
        for (const o of [...q.orders].reverse()) {
          out = [...out].sort((a, b) => {
            const x = a[o.c], y = b[o.c];
            if (x === y) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
          });
        }
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        out = out.map((r) => JSON.parse(JSON.stringify(r)));
        // The rows are taken NOW; `afterRead` holds the answer back, like a slow network.
        if (hooks.afterRead) await hooks.afterRead(table);
        if (q.single) return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
      if (hooks.beforeWrite) await hooks.beforeWrite(table, q.op, q);
      log.push(`${table}.${q.op}`);
      if (q.op === 'update') {
        const hit = rows.filter(match).filter((r) => !(hooks.refuse && hooks.refuse(table, 'update', r)));
        for (const r of hit) {
          Object.assign(r, JSON.parse(JSON.stringify(q.patch)));
          if (trigger) r.updated_at = tick();
        }
        return { data: q.returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (q.op === 'upsert') {
        const created = [];
        for (const row of q.rows) {
          const i = rows.findIndex((r) => r.id === row.id);
          if (hooks.refuse && hooks.refuse(table, 'upsert', row)) continue;
          if (i >= 0) {
            if (q.ignoreDuplicates) continue;
            Object.assign(rows[i], JSON.parse(JSON.stringify(row)));
            if (trigger) rows[i].updated_at = tick();
            created.push({ ...rows[i] });
          } else {
            const r = { updated_at: tick(), ...JSON.parse(JSON.stringify(row)) };
            if (trigger) r.updated_at = tick();
            rows.push(r);
            created.push({ ...r });
          }
        }
        return { data: q.returning ? created : null, error: null };
      }
      if (q.op === 'delete') {
        const hit = rows.filter(match).filter((r) => !(hooks.refuse && hooks.refuse(table, 'delete', r)));
        db[table] = rows.filter((r) => !hit.includes(r));
        return { data: q.returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      return { data: null, error: { message: `unsupported ${q.op}` } };
    };
    const b = {
      select(cols) { if (q.op === 'select') q.cols = cols; else q.returning = true; return b; },
      eq(c, v) { q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      is(c, v) { q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      in(c, vals) { const s = new Set((vals || []).map(String)); q.filters.push((r) => r[c] != null && s.has(String(r[c]))); return b; },
      order(c, o) { q.orders.push({ c, asc: o?.ascending !== false }); return b; },
      range(a, z) { q.range = [a, z]; return b; },
      maybeSingle() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      delete() { q.op = 'delete'; return b; },
      upsert(rows, o) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.ignoreDuplicates = !!o?.ignoreDuplicates; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };
    return b;
  };

  return {
    from,
    log,
    hooks,
    rows: (table) => db[table] || [],
    row: (table, id) => (db[table] || []).find((r) => r.id === id),
    /** Another window's write, straight to the database (updated_at stamped like any write). */
    touch(table, id, patch) {
      const r = (db[table] || []).find((x) => x.id === id);
      if (!r) throw new Error(`no ${table} ${id}`);
      Object.assign(r, patch, { updated_at: tick() });
      return { ...r };
    },
  };
}
