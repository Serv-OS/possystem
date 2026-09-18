// Peter, 18 Sep 2026: Back Office kept showing the red bar "YOUR CHANGES ARE NOT
// SAVING: new row violates row-level security policy for table shifts". App
// mounts useSupabaseInit on every surface, Back Office included, and its boot
// reconcile tried to OPEN a till shift with the owner's login. The shifts policy
// refused it for the venue in the switcher, and the refusal was reported as a
// failed save. Back Office must only read the shift at boot, never write it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const store = read('../store/index.js');

const body = (name) => {
  const i = store.indexOf(`  ${name}: async () => {`);
  assert.ok(i > 0, `${name} exists`);
  const next = store.indexOf('\n  },\n', i);
  return store.slice(i, next);
};

test('only a till may open or roll over a shift by itself at boot', () => {
  assert.ok(store.includes('canAutoRunShiftLifecycle: () => !isHostStandMode() && !isBackOfficeMode(),'));
  assert.ok(/import \{[^}]*\bisBackOfficeMode\b[^}]*\} from '\.\.\/lib\/supabase'/.test(store), 'imported statically');
});

test('the boot reconcile in Back Office reads the shift and returns before any write', () => {
  const b = body('reconcileShiftOnMount');
  const gate = b.indexOf('if (!get().canAutoRunShiftLifecycle()) {');
  assert.ok(gate > 0, 'gated');
  const firstOpen = b.indexOf('openShift?.()');
  const firstClose = b.indexOf('closeShift?.(');
  assert.ok(firstOpen > 0 && firstClose > 0, 'the till path still opens and closes');
  assert.ok(gate < firstOpen && gate < firstClose, 'the gate comes before every open and close');
  const gated = b.slice(gate, b.indexOf('return;', gate));
  assert.ok(gated.includes('await get().loadCurrentShift?.();'), 'EOD close and the Shift page still get the open shift');
});

test('a person can still open a shift from Back Office by pressing the button', () => {
  const b = store.slice(store.indexOf('  openShift: async (staffId = null) => {'), store.indexOf('  finaliseShift: async'));
  assert.ok(b.includes('if (!get().canRunShiftLifecycle()) {'), 'manual open keeps the host stand guard only');
  assert.ok(!b.includes('canAutoRunShiftLifecycle'), 'manual open is not blocked in Back Office');
});

test('the boot hook still runs the reconcile (tills depend on it)', () => {
  const init = read('./useSupabaseInit.js');
  assert.ok(init.includes('await useStore.getState().reconcileShiftOnMount?.();'));
});
