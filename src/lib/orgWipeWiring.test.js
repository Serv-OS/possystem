// src/lib/orgWipeWiring.test.js: delete an organisation and wipe all its data, the wiring
// (5 Nov 2026). Reads the source and pins the shape that keeps a wipe safe: the screen never
// deletes anything itself and never uses confirm(); the function fences the caller in the same
// order as update-emails-admin, checks the typed name, wipes venue by venue and only then the
// company; the SQL is service role only, ASCII, the engine identical on both databases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, needle) => s.split(needle).length - 1;
const between = (s, from, to) => { const a = s.indexOf(from); const b = s.indexOf(to, a); return a >= 0 && b > a ? s.slice(a, b) : ''; };

test('Company Admin: the delete buttons open the wipe screen and never delete from the browser', () => {
  const app = read('src/admin/CompanyAdminApp.jsx');
  assert.ok(app.includes("import { callOrgAdmin } from '../lib/orgAdmin';"));
  assert.ok(app.includes("import { ORG_WIPE_TITLE, LOCATION_WIPE_TITLE, nameMatches, wipeSummary, wipeDoneLine } from '../lib/orgWipeRules';"));
  // confirm() is gone from the code (it shows nothing in the app shells); the one mention is the comment saying so
  const code = app.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.equal(count(code, 'confirm('), 0, 'no confirm() left');
  // the browser no longer deletes tables one by one
  const deletes = between(app, '// ── Delete org', '// ── Rename location');
  assert.ok(deletes.length > 500);
  assert.equal(count(deletes, "method:'DELETE'"), 0, 'the delete paths never DELETE from the browser');
  assert.equal(count(deletes, 'sbFetch('), 0, 'the delete paths never touch the database themselves');
  assert.ok(app.includes("const deleteOrg = (org) => openWipe('org', org);"));
  assert.ok(app.includes("const deleteLocation = (loc) => openWipe('location', loc);"));
  // the dry run first, then the typed name, then the one call that deletes
  assert.ok(app.includes("await callOrgAdmin(kind === 'org' ? 'preview' : 'preview_location',"));
  assert.ok(app.includes('if (!nameMatches(typed, target.name)) return;'));
  assert.ok(app.includes("? await callOrgAdmin('delete_org', { org_id: target.id, name_typed: typed })"));
  assert.ok(app.includes(": await callOrgAdmin('delete_location', { location_id: target.id, name_typed: typed });"));
  // the screen: the title Peter asked for, the typed name, the red button only when it matches
  assert.ok(app.includes("const title = isOrg ? ORG_WIPE_TITLE : LOCATION_WIPE_TITLE;"));
  assert.ok(app.includes('const ready = !wipe.loading && !wipe.busy && !!wipe.preview && nameMatches(wipe.typed, name);'));
  assert.ok(app.includes('<button type="button" onClick={onConfirm} disabled={!ready}'));
  assert.ok(app.includes('aria-label="Name to confirm"'));
  assert.ok(app.includes('{wipe && <WipeModal wipe={wipe}'));
  // the buttons say what they do
  assert.ok(app.includes('title={ORG_WIPE_TITLE}') && app.includes('<Icon name="trash" size={14} />Delete organisation</button>'));
  assert.ok(app.includes('title={LOCATION_WIPE_TITLE}'));
});

test('the client only talks to org-admin and reads not_ready', () => {
  const c = read('src/lib/orgAdmin.js');
  assert.ok(c.includes('`${FUNCTIONS_URL}/org-admin`'));
  assert.ok(c.includes("authorization: `Bearer ${token}`"));
  assert.ok(c.includes("if (res.status === 404 || j.code === 'not_ready')"));
  assert.ok(read('src/lib/orgWipeRules.js').includes("export * from '../../supabase/functions/_shared/orgWipeRules.js';"));
});

test('org-admin: the gate in order, the typed name, venue by venue, the company last, the logins through the auth API', () => {
  const fn = read('supabase/functions/org-admin/index.ts');
  const gate = between(fn, 'Deno.serve(async (req) => {', "const action = String(body?.action ?? '');");
  const order = ['requireAal2(req, [SERVICE_ROLE])', 'admin.auth.getUser(token)', 'if (user.is_anonymous)', "profile?.role !== 'super_admin'", 'await req.json()'];
  let last = -1;
  for (const step of order) { const at = gate.indexOf(step); assert.ok(at > last, `gate step in order: ${step}`); last = at; }
  assert.ok(fn.includes("import { nameMatches, isUuid, isMissingWipeFunction, STORAGE_BUCKETS, storagePrefixes, NEEDS_UPDATE_LINE } from '../_shared/orgWipeRules.js';"));
  assert.ok(fn.includes("if (!nameMatches(body?.name_typed, name)) return json({ error: 'The name typed does not match the organisation name. Nothing was deleted.', code: 'name_mismatch' }, 409);"));
  assert.ok(fn.includes("if (!nameMatches(body?.name_typed, name)) return json({ error: 'The name typed does not match the location name. Nothing was deleted.', code: 'name_mismatch' }, 409);"));
  // a dry run before anything, by the same functions
  assert.ok(fn.includes("await rpc(admin, 'admin_wipe_organisation', { p_org_id: orgId, p_org_name: name, p_dry_run: true })"));
  // the delete: each venue on its own (Ops, Platform, files), then the organisation, then the logins, then the Platform company
  const del = between(fn, "// 4. The typed name.", "// ── One location");
  const steps = ["for (const loc of locations) {", "await rpc(admin, 'admin_wipe_locations', { p_location_ids: [loc.id], p_dry_run: false })",
    "await rpc(platform, 'admin_wipe_platform_locations', { p_ops_location_ids: [loc.id], p_dry_run: false })", 'await sweepStorage([loc.id])',
    "await rpc(admin, 'admin_wipe_organisation', { p_org_id: orgId, p_org_name: String(body?.name_typed ?? ''), p_dry_run: false })",
    'await removeLogins(loginIds)', "await rpc(platform, 'admin_wipe_platform_company', { p_company_id: companyId, p_dry_run: false })"];
  last = -1;
  for (const step of steps) { const at = del.indexOf(step); assert.ok(at > last, `delete step in order: ${step}`); last = at; }
  assert.ok(fn.includes('await admin.auth.admin.deleteUser(id);'), 'logins go through the auth admin API');
  assert.equal(count(fn, 'auth.users'), 0, 'the function never touches auth.users itself');
  // a missing function is said in words, not a raw error
  assert.ok(fn.includes("if (isMissingWipeFunction(e)) return json({ error: where === 'ops' ? OPS_NOT_READY : PLATFORM_NOT_READY, code: 'not_ready', where }, 409);"));
  // the Platform client uses the same env names as provision-location
  assert.ok(fn.includes("Deno.env.get('PLATFORM_SUPABASE_URL')") && fn.includes("Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY')"));
  assert.ok(read('supabase/functions/provision-location/index.ts').includes("Deno.env.get('PLATFORM_SUPABASE_URL')"));
});

test('the SQL: service role only, ASCII, the same engine on both databases, a guard for the wrong database', () => {
  const ops = read('supabase/migrations/20261125a_OPS_admin_wipe.sql');
  const plat = read('supabase/migrations/20261125b_PLATFORM_admin_wipe.sql');
  for (const [name, s] of [['ops', ops], ['platform', plat], ['ops rollback', read('supabase/migrations/20261125a_OPS_admin_wipe_ROLLBACK.sql')], ['platform rollback', read('supabase/migrations/20261125b_PLATFORM_admin_wipe_ROLLBACK.sql')]]) {
    assert.ok(!/[^ -~\n]/.test(s), `${name} is ASCII only (pbcopy is Mac Roman)`);
    assert.equal(count(s, '\nbegin;'), 0, `${name} has no begin`);
  }
  const engine = (s) => between(s, '-- ENGINE BEGIN', '-- ENGINE END');
  assert.ok(engine(ops).length > 2000);
  assert.equal(engine(ops), engine(plat), 'one engine, two databases');
  assert.ok(ops.includes("raise exception 'This is not the Ops database"));
  assert.ok(plat.includes("raise exception 'This is not the Platform database"));
  for (const sig of ['admin_wipe_tables(text[], text[], text[], jsonb, boolean)', 'admin_wipe_locations(uuid[], boolean)', 'admin_wipe_organisation(uuid, text, boolean)']) {
    assert.ok(ops.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig);
    assert.ok(ops.includes(`grant execute on function public.${sig} to service_role;`), sig);
  }
  for (const sig of ['admin_wipe_tables(text[], text[], text[], jsonb, boolean)', 'admin_wipe_platform_locations(uuid[], boolean)', 'admin_wipe_platform_company(uuid, boolean)']) {
    assert.ok(plat.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), sig);
    assert.ok(plat.includes(`grant execute on function public.${sig} to service_role;`), sig);
  }
  // all or nothing, and the super admin's profile is never deleted
  assert.ok(ops.includes("raise exception 'Wipe stopped: % still refused by a foreign key after % passes. Nothing was changed.'"));
  assert.ok(ops.includes("where org_id = p_org_id and coalesce(role, '') <> 'super_admin';"));
  assert.ok(ops.includes("update public.user_profiles set org_id = null, location_id = null where org_id = p_org_id and role = 'super_admin';"));
  const opsCode = ops.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.equal(count(opsCode, 'auth.users'), 0, 'the Ops SQL never touches auth.users outside comments');
});
