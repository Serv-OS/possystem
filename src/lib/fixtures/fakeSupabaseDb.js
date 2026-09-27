// src/lib/fixtures/fakeSupabaseDb.js
//
// Two in memory databases that answer like PostgREST, for the customer merge tests (moved here
// from customerMergeRun.test.js on 27 Sep 2026 so the portal's automatic join, which runs the
// same merge core, is tested against the same fake: portalEmailJoin.test.js).
//
// It enforces the unique indexes the live tables have (customers phone and email per org, one
// membership per company, one card per programme, visit records per venue, campaign and
// automation keys), and a shared `fault` makes the Nth write of a run fail before it lands
// ("fetch failed") or after it ("the answer was lost").

const lower = (v) => (v == null ? null : String(v).toLowerCase());
export const UNIQUES = {
  customers: [
    { name: 'customers_pkey', key: (r) => r.id },
    { name: 'idx_customers_org_phone', key: (r) => (r.phone != null && r.deleted_at == null ? `${r.org_id}|${r.phone}` : null) },
    { name: 'idx_customers_org_email', key: (r) => (r.email != null && r.deleted_at == null ? `${r.org_id}|${lower(r.email)}` : null) },
  ],
  customer_locations: [{ name: 'customer_locations_pkey', key: (r) => `${r.customer_id}|${r.location_id}` }],
  campaign_sends: [{ name: 'campaign_sends_uidx', key: (r) => (r.dedupe_key == null ? null : `${r.campaign_id}|${r.customer_id}|${r.dedupe_key}`) }],
  workflow_enrollments: [{ name: 'workflow_enrollments_uidx', key: (r) => `${r.workflow_id}|${r.customer_id}` }],
  stamp_transactions: [{ name: 'idx_stamp_txn_idempotency', key: (r) => r.idempotency_key ?? null }],
  customer_loyalty: [
    { name: 'customer_loyalty_pkey', key: (r) => r.id },
    { name: 'customer_loyalty_customer_id_company_id_key', key: (r) => `${r.customer_id}|${r.company_id}` },
    { name: 'customer_loyalty_member_code_key', key: (r) => r.member_code ?? null },
  ],
  customer_stamp_cards: [
    { name: 'customer_stamp_cards_pkey', key: (r) => r.id },
    { name: 'idx_customer_stamp_cards_uniq', key: (r) => `${r.customer_id}|${r.program_id}|${r.company_id}` },
  ],
};

function violation(table, rows) {
  for (const u of UNIQUES[table] || []) {
    const seen = new Set();
    for (const r of rows) {
      const k = u.key(r);
      if (k == null) continue;
      if (seen.has(k)) return { code: '23505', message: `duplicate key value violates unique constraint "${u.name}"` };
      seen.add(k);
    }
  }
  return null;
}

/** One database. `fault` is shared by both so "the Nth write of the merge" spans the two. */
export function fakeDb(init, fault) {
  let db = JSON.parse(JSON.stringify(init));
  const from = (table) => {
    const q = { op: 'select', filters: [], cols: '*', count: null, head: false, lim: null, single: false, order: null, patch: null, rows: null, onConflict: 'id' };
    const match = (r) => q.filters.every((f) => f(r));
    const project = (r) => (q.cols === '*' ? { ...r } : Object.fromEntries(String(q.cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => [c, r[c] ?? null])));
    const write = () => {
      const all = db[table] || [];
      let next;
      if (q.op === 'update') next = all.map((r) => (match(r) ? { ...r, ...q.patch } : r));
      else if (q.op === 'delete') next = all.filter((r) => !match(r));
      else {
        // One statement: every row lands or none does (a bulk upsert is one transaction).
        const keys = q.onConflict.split(',').map((s) => s.trim());
        const keyOf = (r) => keys.map((k) => String(r[k])).join('|');
        const seen = new Set();
        next = [...all];
        for (const row of q.rows) {
          const k = keyOf(row);
          if (seen.has(k)) return { data: null, error: { code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } };
          seen.add(k);
          const i = next.findIndex((r) => keyOf(r) === k);
          if (i >= 0) next[i] = { ...next[i], ...row }; else next.push({ ...row });
        }
      }
      const err = violation(table, next);
      if (err) return { data: null, error: err };
      db[table] = next;
      return { data: null, error: null };
    };
    const run = () => {
      if (q.op !== 'select') {
        const n = fault.writes++;
        fault.log.push(`${table}.${q.op}`);
        if (fault.at === n && fault.mode === 'before') return { data: null, error: { message: 'TypeError: fetch failed (fake)' } };
        const res = write();
        if (fault.at === n && fault.mode === 'after') return { data: null, error: { message: 'the answer was lost (fake)' } };
        return res;
      }
      if (fault.readFail === table) return { data: null, error: { message: 'read failed (fake)' } };
      let rows = (db[table] || []).filter(match);
      if (q.order) rows = [...rows].sort((a, b) => (String(a[q.order.c]) < String(b[q.order.c]) ? -1 : 1) * (q.order.asc ? 1 : -1));
      if (q.lim != null) rows = rows.slice(0, q.lim);
      if (q.count) return { data: q.head ? null : rows.map(project), count: rows.length, error: null };
      if (q.single) return { data: rows[0] ? project(rows[0]) : null, error: null };
      return { data: rows.map(project), error: null };
    };
    const b = {
      select(cols, o) { q.cols = cols || '*'; if (o?.count) q.count = o.count; if (o?.head) q.head = true; return b; },
      eq(c, v) { q.filters.push((r) => r[c] != null && String(r[c]) === String(v)); return b; },
      neq(c, v) { q.filters.push((r) => r[c] != null && String(r[c]) !== String(v)); return b; },
      in(c, vals) { const s = new Set((vals || []).map(String)); q.filters.push((r) => r[c] != null && s.has(String(r[c]))); return b; },
      is(c, v) { q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      // ilike as PostgREST reads it: % and _ are wildcards unless escaped with a backslash.
      ilike(c, pattern) {
        let re = '';
        for (let i = 0; i < pattern.length; i += 1) {
          const ch = pattern[i];
          if (ch === '\\' && i + 1 < pattern.length) { i += 1; re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
          else if (ch === '%') re += '.*';
          else if (ch === '_') re += '.';
          else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        const rx = new RegExp(`^${re}$`, 'i');
        q.filters.push((r) => r[c] != null && rx.test(String(r[c])));
        return b;
      },
      order(c, o) { q.order = { c, asc: o?.ascending !== false }; return b; },
      limit(n) { q.lim = n; return b; },
      maybeSingle() { q.single = true; return b; },
      update(patch) { q.op = 'update'; q.patch = patch; return b; },
      upsert(rows, o) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.onConflict = o?.onConflict || 'id'; return b; },
      delete() { q.op = 'delete'; return b; },
      then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
    };
    return b;
  };
  return { from, dump: () => JSON.parse(JSON.stringify(db)) };
}

export const newFault = () => ({ writes: 0, at: null, mode: 'before', log: [], readFail: null });
