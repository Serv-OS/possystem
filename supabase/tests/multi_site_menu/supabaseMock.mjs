// supabase/tests/multi_site_menu/supabaseMock.mjs
//
// A stand in for https://esm.sh/@supabase/supabase-js@2 that runs every query against the LOCAL
// harness Postgres through psql, as the role the key or token says (service_role for the service
// key, authenticated with the token's claims for a person). So the msm-publish edge function runs
// in node over real rows, and its calls hit the real grants, row level security and functions.
// Only what msm-publish and the _shared readers use is implemented.

import { spawnSync } from 'node:child_process';

const CONN = ['-h', process.env.MSM_PGHOST || '127.0.0.1', '-p', process.env.MSM_PGPORT || '55991', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'];
export const harness = { db: 'msm_edge', serviceKey: 'service-key-for-tests', log: [] };

const SRF = new Set(['msm_claim_due', 'msm_precheck_due', 'msm_mark_late', 'msm_mark_missed', 'msm_managed_items']);
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad identifier ${s}`); return s; };
const lit = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export const fakeToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const claimsOf = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; } };

function exec(sqlText, claims) {
  const pre = claims
    ? `do $c$ begin perform set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true); end $c$;\nset local role ${ident(claims.role === 'service_role' ? 'service_role' : claims.role === 'anon' ? 'anon' : 'authenticated')};\n`
    : '';
  const p = spawnSync('psql', [...CONN, '-d', harness.db], { input: `begin;\n${pre}${sqlText};\ncommit;\n`, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  harness.log.push(sqlText.slice(0, 160));
  if (p.status !== 0) return { data: null, error: { message: (p.stderr || '').replace(/^.*ERROR:\s*/s, '').split('\n')[0], code: /permission denied/.test(p.stderr) ? '42501' : 'P0001' } };
  const out = (p.stdout || '').trim();
  return { data: out ? JSON.parse(out) : null, error: null };
}

export function createClient(url, key, opts = {}) {
  const header = opts?.global?.headers?.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const claims = key === harness.serviceKey && !token ? { role: 'service_role' } : (claimsOf(token) || { role: 'anon' });
  const client = {
    from: (t) => builder(ident(t), claims),
    rpc: async (name, args = {}) => {
      const a = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
      return SRF.has(name)
        ? exec(`select coalesce(json_agg(t), '[]'::json) from public.${ident(name)}(${a}) t`, claims)
        : exec(`select to_json(public.${ident(name)}(${a}))`, claims);
    },
    auth: {
      async getUser(tok) { const c = claimsOf(tok); return c?.sub ? { data: { user: { id: c.sub } }, error: null } : { data: { user: null }, error: { message: 'bad token' } }; },
    },
  };
  return client;
}

function builder(table, claims) {
  const st = { cols: '*', join: null, where: [], order: [], from: null, to: null, limit: null, single: false, op: 'select', payload: null };
  const col = (c) => {
    if (c.includes('.')) { const [t, k] = c.split('.'); if (t !== st.join) throw new Error(`filter on ${t}`); return `j.${ident(k)}`; }
    return `a.${ident(c)}`;
  };
  const b = {
    select(cols = '*') {
      const m = /(\w+)!inner\((\w+)\)/.exec(cols);
      if (m) st.join = m[1];
      st.cols = cols.replace(/,?\s*\w+!inner\(\w+\)/, '').trim() || '*';
      return b;
    },
    eq(c, v) { st.where.push(`${col(c)} = ${lit(v)}`); return b; },
    in(c, vs) { st.where.push(vs.length ? `${col(c)} in (${vs.map(lit).join(', ')})` : 'false'); return b; },
    order(c, o = {}) { st.order.push(`${col(c)} ${o.ascending === false ? 'desc' : 'asc'}`); return b; },
    range(f, t) { st.from = f; st.to = t; return b; },
    limit(n) { st.limit = n; return b; },
    maybeSingle() { st.single = true; return b; },
    single() { st.single = true; return b; },
    insert(rows) { st.op = 'insert'; st.payload = Array.isArray(rows) ? rows : [rows]; return b; },
    then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
  };
  function run() {
    if (st.op === 'insert') {
      const cols = [...new Set(st.payload.flatMap((r) => Object.keys(r)))].map(ident).join(', ');
      const r = exec(`insert into public.${table} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${table}, ${lit(st.payload)})`, claims);
      return r.error ? r : { data: null, error: null };
    }
    const cols = st.cols === '*' ? 'a.*' : st.cols.split(',').map((c) => `a.${ident(c.trim())}`).join(', ');
    const joinSql = st.join ? ` join public.${ident(st.join)} j on j.id = a.${{ msm_products: 'product_id', msm_categories: 'category_id', msm_modifier_groups: 'group_id' }[st.join]}` : '';
    const joinCol = st.join ? `, json_build_object('menu_id', j.menu_id) as ${st.join}` : '';
    let sql = `select ${cols}${joinCol} from public.${table} a${joinSql}`;
    if (st.where.length) sql += ` where ${st.where.join(' and ')}`;
    if (st.order.length) sql += ` order by ${st.order.join(', ')}`;
    let lim = st.limit;
    if (st.from != null) { lim = Math.min(st.to - st.from + 1, lim ?? Infinity, 1000); sql += ` offset ${st.from}`; }
    sql += ` limit ${Math.min(lim ?? 1000, 1000)}`;       // the live cap
    const r = exec(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`, claims);
    if (r.error) return r;
    return st.single ? { data: r.data[0] || null, error: null } : r;
  }
  return b;
}
