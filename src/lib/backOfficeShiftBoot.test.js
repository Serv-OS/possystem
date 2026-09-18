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
  const i = store.indexOf('  canAutoRunShiftLifecycle: () => {');
  assert.ok(i > 0, 'the gate exists');
  const gate = store.slice(i, store.indexOf('\n  },', i));
  assert.ok(gate.includes('if (isHostStandMode() || isBackOfficeMode()) return false;'), 'host stands and Back Office never write');
  assert.ok(gate.includes("return mode === '' || mode === 'pos' || mode === 'mpos';"), 'an allowlist of till modes, not a denylist');
  for (const m of ['getDeviceMode', 'isBackOfficeMode', 'isHostStandMode']) {
    assert.ok(new RegExp('import \\{[^}]*\\b' + m + '\\b[^}]*\\} from \'\\.\\./lib/supabase\'').test(store), m + ' imported statically');
  }
});

test('the allowlist decides correctly for every surface the app has', async () => {
  // Evaluate the gate's rule against every ?mode= the app routes (App.jsx).
  const rule = (mode, backOffice, hostStand) => {
    if (hostStand || backOffice) return false;
    return mode === '' || mode === 'pos' || mode === 'mpos';
  };
  const tills = ['', 'pos', 'mpos'];
  const notTills = ['office', 'backoffice', 'admin', 'manager', 'owner', 'ops', 'staff', 'kiosk', 'menuboard',
    'orderscreen', 'customer-display', 'clock', 'readerdemo', 'waitlist', 'bookings'];
  for (const m of tills) assert.equal(rule(m, false, false), true, m + ' is a till');
  const bo = new Set(['office', 'backoffice', 'admin']);
  const hs = new Set(['waitlist', 'bookings']);
  for (const m of notTills) assert.equal(rule(m, bo.has(m), hs.has(m)), false, m + ' must only read the shift');
  // Every mode App.jsx routes is classified here, so a new surface cannot slip in unnoticed.
  const app = read('../App.jsx');
  const routed = new Set([...app.matchAll(/deviceMode === '([a-z_-]+)'/g)].map((x) => x[1]));
  for (const m of routed) assert.ok(tills.includes(m) || notTills.includes(m), 'classify the new surface: ' + m);
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
