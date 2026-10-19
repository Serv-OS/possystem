// src/lib/msm/fakeClient.js: an in memory stand in for the Supabase client, for the Multi site menu
// tests. It ENFORCES the 1,000 row cap the live Data API has (reference_postgrest_max_rows_cap), so
// a reader that forgets to page loses rows here exactly as it would in production.
//
// Supports: from(t).select(cols).eq().in().is().order().range().limit().maybeSingle().single(),
// insert/update/delete/upsert with eq filters, and rpc(name, args) through `rpcs`.
// An embedded inner join filter (select('*, msm_products!inner(menu_id)').eq('msm_products.menu_id', x))
// joins on <singular>_id (product_id, category_id, group_id).

const JOIN_KEY = { msm_products: 'product_id', msm_categories: 'category_id', msm_modifier_groups: 'group_id', msm_modifier_options: 'option_id' };

// One ordering rule and one cap rule for tables and functions alike.
const compareBy = (orders, get) => (a, b) => {
  for (const [c, asc] of orders) {
    const x = get(a, c), y = get(b, c);
    if (x === y) continue;
    const cmp = x == null ? -1 : y == null ? 1 : (typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1);
    return asc ? cmp : -cmp;
  }
  return 0;
};
// [from, to + 1] for slice(): range, then limit, then THE CAP.
const sliceWindow = (st, cap) => {
  const from = st.from ?? 0;
  let to = st.to ?? (from + (st.limit ?? cap) - 1);
  if (st.limit != null) to = Math.min(to, from + st.limit - 1);
  to = Math.min(to, from + cap - 1);
  return [from, to + 1];
};

// stamp (opt in, for the demo mode screens): an insert gets an id and created_at / updated_at when it
// has none, and an update moves updated_at on and answers with the rows as they are after it (the
// way the database does with .select()). defaults: { table: { column: value } } for the columns the
// database would fill in on an insert (stamp only).
export function fakeClient(tables = {}, { cap = 1000, rpcs = {}, fail = {}, stamp = false, defaults = {} } = {}) {
  const calls = [];
  let seq = 0;
  let clock = Date.parse('2026-10-17T09:00:00Z');
  const tick = () => new Date(clock += 1000).toISOString();
  const newId = () => `dddddddd-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const client = {
    calls, db,
    from(table) { return builder(table); },
    // 18 Oct 2026: a thenable builder, as supabase-js's rpc() is, with order(), range() and limit().
    // A function that returns a table is CUT AT THE CAP like any other read (the live Data API's
    // max rows applies to "a view, table, or function"): msm_sold_recently lost 259 of a seven
    // site company's 1,259 sold pairs with no error because this stand in used to hand the array back whole.
    // A single value (jsonb, a number) comes back as it is.
    rpc(name, args) {
      calls.push({ rpc: name, args });
      const st = { orders: [], from: null, to: null, limit: null };
      const run = async () => {
        const f = rpcs[name];
        if (!f) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
        let res;
        try { res = await f(args, db); } catch (e) { return { data: null, error: { message: e.message } }; }
        if (!res || !Array.isArray(res.data)) return res;
        const out = res.data.map((r) => r);
        if (st.orders.length) out.sort(compareBy(st.orders, (r, c) => r[c]));
        return { ...res, data: out.slice(...sliceWindow(st, cap)) };
      };
      const b = {
        order(c, o = {}) { st.orders.push([c, o.ascending !== false]); return b; },
        range(a, z) { st.from = a; st.to = z; return b; },
        limit(n) { st.limit = n; return b; },
        then(res, rej) { return run().then(res, rej); },
        catch(rej) { return run().catch(rej); },
        finally(fn) { return run().finally(fn); },
      };
      return b;
    },
  };
  function builder(table) {
    const st = { table, filters: [], orders: [], from: null, to: null, limit: null, single: null, op: 'select', payload: null, joins: [], cols: '*', onConflict: null };
    const b = {
      select(cols = '*') { st.cols = cols; const re = /(\w+)!inner\((\w+)\)/g; let m; while ((m = re.exec(cols))) st.joins.push(m[1]); return b; },
      eq(c, v) { st.filters.push((r) => get(r, c) === v); return b; },
      neq(c, v) { st.filters.push((r) => get(r, c) !== v); return b; },
      in(c, vs) { st.filters.push((r) => vs.includes(get(r, c))); return b; },
      is(c, v) { st.filters.push((r) => (get(r, c) ?? null) === v); return b; },
      not(c, op, v) { st.filters.push((r) => (op === 'is' ? (get(r, c) ?? null) !== v : true)); return b; },
      order(c, o = {}) { st.orders.push([c, o.ascending !== false]); return b; },
      range(a, z) { st.from = a; st.to = z; return b; },
      limit(n) { st.limit = n; return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      single() { st.single = 'one'; return b; },
      insert(rows) { st.op = 'insert'; st.payload = Array.isArray(rows) ? rows : [rows]; return b; },
      upsert(rows, o = {}) { st.op = 'upsert'; st.payload = Array.isArray(rows) ? rows : [rows]; st.onConflict = o.onConflict || 'id'; return b; },
      update(patch) { st.op = 'update'; st.payload = patch; return b; },
      delete() { st.op = 'delete'; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    const get = (r, c) => {
      if (c.includes('.')) { const [t, k] = c.split('.'); return r[t]?.[k]; }
      return r[c];
    };
    function run() {
      calls.push({ table, op: st.op });
      if (fail[table]) return { data: null, error: { message: fail[table] } };
      const rows = db[table] || (db[table] = []);
      if (st.op === 'insert') {
        if (stamp) {
          const made = st.payload.map((r) => { const t = tick(); return { id: newId(), created_at: t, updated_at: t, ...(defaults[table] || {}), ...r }; });
          for (const r of made) rows.push({ ...r });
          return { data: st.single ? made[0] : made, error: null };
        }
        for (const r of st.payload) rows.push({ ...r });
        return { data: st.payload, error: null };
      }
      if (st.op === 'upsert') {
        const keys = String(st.onConflict).split(',');
        for (const r of st.payload) {
          const i = rows.findIndex((x) => keys.every((k) => x[k] === r[k]));
          if (i >= 0) rows[i] = { ...rows[i], ...r }; else rows.push({ ...r });
        }
        return { data: st.payload, error: null };
      }
      let out = rows.map((r) => {
        const x = { ...r };
        for (const j of st.joins) { const parent = (db[j] || []).find((p) => p.id === r[JOIN_KEY[j]]); x[j] = parent ? { ...parent } : null; }
        return x;
      }).filter((r) => st.joins.every((j) => r[j]));
      out = out.filter((r) => st.filters.every((f) => f(r)));
      if (st.op === 'update') {
        const ids = new Set(out.map((r) => r.id ?? JSON.stringify(r)));
        const done = [];
        for (let i = 0; i < rows.length; i++) if (ids.has(rows[i].id ?? JSON.stringify(rows[i]))) { rows[i] = { ...rows[i], ...st.payload, ...(stamp ? { updated_at: tick() } : {}) }; done.push({ ...rows[i] }); }
        return { data: stamp ? done : out, error: null };
      }
      if (st.op === 'delete') {
        const keep = rows.filter((r) => !out.some((o) => o.id === r.id));
        db[table] = keep;
        return { data: out, error: null };
      }
      if (st.orders.length) out.sort(compareBy(st.orders, get));
      out = out.slice(...sliceWindow(st, cap));     // THE CAP
      if (st.single) {
        if (st.single === 'one' && out.length !== 1) return { data: null, error: { message: 'not one row' } };
        return { data: out[0] || null, error: null };
      }
      return { data: out, error: null };
    }
    return b;
  }
  return client;
}
