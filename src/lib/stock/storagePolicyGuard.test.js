/**
 * storagePolicyGuard.test.js: the CI tripwire for the 23 Oct 2026 storage incident (release 5.11.100).
 * Run: `npm test`, or `node --test src/lib/stock/storagePolicyGuard.test.js`.
 *
 * What happened: Drop 3's storage rule stock_invoice_inbox_files_add (INSERT on storage.objects) called
 * public.stock_level(), which signed in logins may not run. Postgres checks EXECUTE on every function a rule
 * names for every row of that command, whichever bucket it is for, so EVERY upload in every bucket failed
 * ("permission denied for function stock_level"), the menu board logo first.
 *
 * This test replays every migration in file order with a small model of function grants (created: everyone
 * may run it, as Supabase's default privileges give; revoke and grant by name; the catalog loops that revoke
 * a whole prefix; renames and drops) and then, for every storage.objects rule as it stands at the end and
 * every rule a stock file (20261021 on) makes on any table, fails when the rule calls a function the rule's
 * roles cannot run. The same check against a real database is in supabase/tests/stock_native/drop4b.mjs
 * (section 61, POLICY_GUARD_SQL) and in the asserts of 20261030a, which refuse to commit such a rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '../../../supabase/migrations');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && !/ROLLBACK/i.test(f)).sort();
const strip = (s) => s.replace(/--[^\n]*/g, '');
const ROLES = ['anon', 'authenticated'];
const STOCK_ERA = '20261021';
// prefixes the stock files revoke from every API role in a catalog loop
const LOOP_PREFIXES = [/^stock_co__/, /^stock_rp__/, /^report_export_/];

function model() {
  const fns = new Map();           // name -> { anon, authenticated }
  const policies = new Map();      // table|name -> { file, table, roles, text }
  const roleList = (s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const f of files) {
    const text = strip(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const events = [];
    const add = (re, kind) => { for (const m of text.matchAll(re)) events.push({ at: m.index, kind, m }); };
    add(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi, 'create');
    add(/revoke\s+(?:all|execute)(?:\s+privileges)?\s+on\s+function\s+(?:public\.)?([a-z_0-9]+)\s*\([^)]*\)\s+from\s+([a-z_, ]+);/gi, 'revoke');
    add(/grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z_0-9]+)\s*\([^)]*\)\s+to\s+([a-z_, ]+);/gi, 'grant');
    add(/alter\s+function\s+(?:public\.)?([a-z_0-9]+)\s*\([^)]*\)\s+rename\s+to\s+([a-z_0-9]+)/gi, 'rename');
    add(/drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_0-9]+)\s*\(/gi, 'drop');
    add(/proname\s+~\s+'\^([a-z_0-9]+)'[\s\S]{0,400}?execute\s+format\('revoke all on function/gi, 'loop');
    add(/create\s+policy\s+("?[a-z_0-9 ]+"?)\s+on\s+([a-z_.]+)([\s\S]*?);/gi, 'policy');
    add(/drop\s+policy\s+(?:if\s+exists\s+)?("?[a-z_0-9 ]+"?)\s+on\s+([a-z_.]+)/gi, 'unpolicy');
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      const m = e.m;
      if (e.kind === 'create') {
        const n = m[1].toLowerCase();
        if (!fns.has(n)) fns.set(n, { anon: true, authenticated: true });
      } else if (e.kind === 'revoke' || e.kind === 'grant') {
        const n = m[1].toLowerCase();
        const st = fns.get(n) || { anon: true, authenticated: true };
        for (const r of roleList(m[2])) {
          if (r === 'public') { if (e.kind === 'grant') { st.anon = true; st.authenticated = true; } continue; }
          if (ROLES.includes(r)) st[r] = e.kind === 'grant';
        }
        fns.set(n, st);
      } else if (e.kind === 'rename') {
        const st = fns.get(m[1].toLowerCase());
        fns.delete(m[1].toLowerCase());
        if (st) fns.set(m[2].toLowerCase(), st);
      } else if (e.kind === 'drop') {
        fns.delete(m[1].toLowerCase());
      } else if (e.kind === 'loop') {
        const re = new RegExp(`^${m[1]}`);
        for (const [n, st] of fns) if (re.test(n)) { st.anon = false; st.authenticated = false; }
      } else if (e.kind === 'policy') {
        const name = m[1].replace(/"/g, '').trim();
        const table = m[2].toLowerCase().replace(/^public\./, '');
        const rest = m[3];
        const to = /\bto\s+([a-z_, ]+?)(?:\s+using|\s+with\s+check|\s*$)/i.exec(rest);
        policies.set(`${table}|${name}`, { file: f, table, name, roles: to ? roleList(to[1]) : ['public'], text: rest });
      } else if (e.kind === 'unpolicy') {
        policies.delete(`${m[2].toLowerCase().replace(/^public\./, '')}|${m[1].replace(/"/g, '').trim()}`);
      }
    }
    // the stock files' catalog loops that revoke a whole prefix from every API role (one statement per file)
    if (f >= STOCK_ERA) {
      for (const re of LOOP_PREFIXES) {
        if (new RegExp(`proname ~ '\\${re.source}'`).test(text) && /revoke all on function %s from public, anon, authenticated, service_role|revoke all on function ' \|\|/i.test(text)) {
          // granted back afterwards by name in the same file: replay that file's grants once more
          for (const [n, st] of fns) if (re.test(n)) { st.anon = false; st.authenticated = false; }
          for (const g of text.matchAll(/grant\s+execute\s+on\s+function\s+(?:public\.)?([a-z_0-9]+)\s*\([^)]*\)\s+to\s+([a-z_, ]+);/gi)) {
            const n = g[1].toLowerCase();
            if (!re.test(n) || !fns.has(n)) continue;
            for (const r of roleList(g[2])) if (ROLES.includes(r)) fns.get(n)[r] = true;
          }
        }
      }
    }
  }
  return { fns, policies };
}

const { fns, policies } = model();

function callsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:public\.)?([a-z_][a-z_0-9]*)\s*\(/gi)) {
    const n = m[1].toLowerCase();
    if (fns.has(n)) out.add(n);
  }
  return [...out];
}

function offenders(filter) {
  const bad = [];
  for (const p of policies.values()) {
    if (!filter(p)) continue;
    const roles = p.roles.includes('public') ? ROLES : p.roles.filter((r) => ROLES.includes(r));
    for (const fn of callsIn(p.text)) {
      for (const r of roles) if (!fns.get(fn)[r]) bad.push(`${p.file}: ${p.table} ${p.name} (${r} cannot run ${fn})`);
    }
  }
  return bad;
}

test('the model sees the incident: stock_level is not for signed in logins, and the old Drop 3 rule called it', () => {
  assert.equal(fns.get('stock_level')?.authenticated, false, 'stock_level() is revoked from signed in logins (0a)');
  assert.equal(fns.get('stock_invoice_inbox_upload_ok')?.authenticated, true, 'the upload check is granted to signed in logins');
  assert.equal(fns.get('stock_invoice_inbox_upload_ok')?.anon, false, 'and not to the anon key');
  const old = "with check (bucket_id = 'stock-invoice-inbox' and public.stock_level(auth.uid(), ((storage.foldername(name))[2])::uuid) = 'all')";
  const roles = ['authenticated'];
  const bad = callsIn(old).filter((fn) => roles.some((r) => !fns.get(fn)[r]));
  assert.deepEqual(bad, ['stock_level'], 'the 22 Oct rule text is caught');
});

test('no storage.objects rule calls a function its roles cannot run (every bucket\'s uploads depend on it)', () => {
  const bad = offenders((p) => p.table === 'storage.objects');
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.ok([...policies.values()].some((p) => p.table === 'storage.objects' && p.name === 'stock_invoice_inbox_files_add'
    && /stock_invoice_inbox_upload_ok\(name\)/.test(p.text)), 'the inbox rule as it stands calls the upload check');
});

test('no rule a stock file makes, on any table, calls a function its roles cannot run', () => {
  const bad = offenders((p) => p.file >= STOCK_ERA);
  assert.deepEqual(bad, [], bad.join('\n'));
});
