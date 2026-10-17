// Multi site menu ROUND 2, design review blocker 1: the sharing engine (src/lib/db.js) never writes
// into an option group or sub item the group menu manages at ANOTHER venue. Driven end to end
// through the REAL db.js with lib/supabase.js replaced by a small stub (Vite's import.meta.env),
// as src/sync/queueDeleteFence.test.js does; the database is fakeClient.js.
//   1. an owner venue not in the group menu edits a group whose copy at another site is managed:
//      that site's row stays byte for byte;
//   2. a group copy that is not managed still follows, but a managed sub item it offers there is
//      left as head office published it;
//   3. an unmanaged group still propagates as today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fakeClient } from './fakeClient.js';

globalThis.window = globalThis.window || new EventTarget();
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const L1 = '11111111-0000-4000-8000-0000000a0001';   // the owner, not in any group menu
const L2 = '22222222-0000-4000-8000-0000000b0002';   // head office manages Milk and Oat milk here
const L3 = '33333333-0000-4000-8000-0000000c0003';   // nothing managed here
const ORG = '00000000-0000-4000-8000-0000000000a1';
const sfx = (l) => l.slice(-8);

function world() {
  return fakeClient({
    locations: [{ id: L1, org_id: ORG, name: 'Owner' }, { id: L2, org_id: ORG, name: 'Managed' }, { id: L3, org_id: ORG, name: 'Plain' }],
    modifier_groups: [
      { id: 'mgd-milk', location_id: L1, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.7, itemId: 'm-oat' }] },
      { id: `mgd-milk_${sfx(L2)}`, location_id: L2, name: 'Milk options', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4, itemId: `m-oat_${sfx(L2)}` }] },
      { id: `mgd-milk_${sfx(L3)}`, location_id: L3, name: 'Milk', min: 0, max: 1, selection_type: 'single', sort_order: 0, options: [{ id: 'opt-oat', name: 'Oat milk', price: 0.4 }] },
      { id: 'mgd-sugar', location_id: L1, name: 'Sugar', min: 0, max: 1, selection_type: 'single', sort_order: 1, options: [{ id: 'opt-white', name: 'White', price: 0.05 }] },
      { id: `mgd-sugar_${sfx(L3)}`, location_id: L3, name: 'Sugar', min: 0, max: 1, selection_type: 'single', sort_order: 1, options: [{ id: 'opt-white', name: 'White', price: 0 }] },
    ],
    menu_items: [
      { id: 'm-latte', location_id: L1, name: 'Latte', scope: 'global', assigned_modifier_groups: [{ groupId: 'mgd-milk' }, { groupId: 'mgd-sugar' }] },
      { id: 'm-oat', location_id: L1, name: 'Oat milk', type: 'subitem', sold_alone: false, master_id: null, pricing: { base: 0.7 } },
      { id: `m-oat_${sfx(L2)}`, location_id: L2, name: 'Oat milk', type: 'subitem', sold_alone: false, master_id: 'm-oat', pricing: { base: 0.4 } },
    ],
  }, {
    rpcs: {
      msm_managed_at: ({ p_locations }) => ({
        data: {
          on: true,
          groups: p_locations.includes(L2) ? [{ location_id: L2, venue_group_id: `mgd-milk_${sfx(L2)}` }] : [],
          items: p_locations.includes(L2) ? [{ location_id: L2, venue_item_id: `m-oat_${sfx(L2)}` }] : [],
        },
        error: null,
      }),
    },
  });
}

globalThis.__share = { client: null };
// Every name the real lib/supabase.js exports, as a harmless stand in, then the ones db.js uses.
const REAL = readFileSync(new URL('../supabase.js', import.meta.url), 'utf8');
const OURS = new Set(['supabase', 'staffSupabase', 'isMock', 'getLocationId', 'getActiveLocationSync', 'getResolvedLocationIdSync', 'isBackOfficeMode', 'getDeviceMode', 'readLocalDevice', 'isHostStandMode', 'getLastDeviceLinkOutcome', 'sendDeviceHeartbeat', 'linkDevice']);
const OTHERS = [...new Set([...REAL.matchAll(/export\s+(?:async\s+)?(?:const|let|function)\s+(\w+)/g)].map((m) => m[1]))].filter((n) => !OURS.has(n));
const SUPABASE_STUB = OTHERS.map((n) => `export const ${n} = null;`).join('\n') + `
export const supabase = new Proxy({}, { get: (_t, k) => { const c = globalThis.__share.client; const v = c[k]; return typeof v === 'function' ? v.bind(c) : v; } });
export const staffSupabase = null;
export const isMock = false;
export async function getLocationId() { return '${L1}'; }
export function getActiveLocationSync() { return '${L1}'; }
export function getResolvedLocationIdSync() { return '${L1}'; }
export function isBackOfficeMode() { return true; }
export function getDeviceMode() { return 'backoffice'; }
export function readLocalDevice() { return null; }
export function isHostStandMode() { return false; }
export function getLastDeviceLinkOutcome() { return null; }
export async function sendDeviceHeartbeat() { return null; }
export async function linkDevice() { return { outcome: 'none' }; }
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+(\?.*)?$/i.test(specifier)) {
      try { return nextResolve(`${specifier}.js`, context); } catch { return nextResolve(`${specifier}/index.js`, context); }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/lib/supabase.js')) return { format: 'module', source: SUPABASE_STUB, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const db = await import('../db.js');
const { resetMsmManagedForTest } = await import('./msmManaged.js');
const row = (c, table, id) => JSON.stringify(c.db[table].find((r) => r.id === id));

test('1 and 3: an owner editing a group never writes the copy head office manages; the plain copy still follows', async () => {
  resetMsmManagedForTest();
  const c = world();
  globalThis.__share.client = c;
  const before = row(c, 'modifier_groups', `mgd-milk_${sfx(L2)}`);
  const r = await db.propagateModifierGroupEdit(c.db.modifier_groups.find((g) => g.id === 'mgd-milk'));
  assert.equal(r.ok, true);
  assert.equal(row(c, 'modifier_groups', `mgd-milk_${sfx(L2)}`), before, 'the managed copy, byte for byte');
  assert.equal(row(c, 'menu_items', `m-oat_${sfx(L2)}`), JSON.stringify(c.db.menu_items.find((i) => i.id === `m-oat_${sfx(L2)}`)));
  const plain = c.db.modifier_groups.find((g) => g.id === `mgd-milk_${sfx(L3)}`);
  assert.equal(plain.options[0].price, 0.7, 'the copy nobody manages follows the edit, as today');
  assert.equal(r.propagated, 1, 'only the plain copy counts');
});

test('2: a copy that is not managed follows, but a managed sub item it offers there is left as published', async () => {
  resetMsmManagedForTest();
  const c = world();
  // This time the group copy at L2 is NOT managed, only its sub item is.
  c.db.modifier_groups.find((g) => g.id === `mgd-milk_${sfx(L2)}`).name = 'Milk';
  globalThis.__share.client = c;
  const managedGroups = new Set();
  c.rpc = async (name, args) => (name === 'msm_managed_at'
    ? { data: { on: true, groups: [...managedGroups].map((id) => ({ location_id: L2, venue_group_id: id })), items: args.p_locations.includes(L2) ? [{ location_id: L2, venue_item_id: `m-oat_${sfx(L2)}` }] : [] }, error: null }
    : { data: null, error: { code: 'PGRST202', message: 'no' } });
  const subBefore = row(c, 'menu_items', `m-oat_${sfx(L2)}`);
  const r = await db.propagateModifierGroupEdit(c.db.modifier_groups.find((g) => g.id === 'mgd-milk'));
  assert.equal(r.ok, true);
  assert.equal(row(c, 'menu_items', `m-oat_${sfx(L2)}`), subBefore, 'the managed sub item is not written');
  const copy = c.db.modifier_groups.find((g) => g.id === `mgd-milk_${sfx(L2)}`);
  assert.equal(copy.options[0].price, 0.7, 'the group itself (not managed) follows');
  assert.equal(copy.options[0].itemId, `m-oat_${sfx(L2)}`, 'pointing at the sub item that is there');
});

test('a failed check while the company may be on copies nothing, and says so', async () => {
  resetMsmManagedForTest();
  const c = world();
  c.rpc = async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
  globalThis.__share.client = c;
  const before = row(c, 'modifier_groups', `mgd-milk_${sfx(L3)}`);
  const r = await db.propagateModifierGroupEdit(c.db.modifier_groups.find((g) => g.id === 'mgd-milk'));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /could not check which option groups the group menu manages there/);
  assert.equal(row(c, 'modifier_groups', `mgd-milk_${sfx(L3)}`), before);
});

test('before 20261017c has run (no such function): the engine works exactly as before', async () => {
  resetMsmManagedForTest();
  const c = world();
  c.rpc = async (name) => ({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
  globalThis.__share.client = c;
  const r = await db.propagateModifierGroupEdit(c.db.modifier_groups.find((g) => g.id === 'mgd-milk'));
  assert.equal(r.ok, true);
  assert.equal(c.db.modifier_groups.find((g) => g.id === `mgd-milk_${sfx(L2)}`).options[0].price, 0.7, 'no group menu: every copy follows, as today');
});
