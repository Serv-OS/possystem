// demoPairing.test.js — the reviewer's way in.
//
// 13 Oct 2026: Apple could not pair the Manager app. Manager, Waitlist and Bookings
// show a code that somebody must type into Back Office, which a reviewer does not
// have, so the app is rejected for incomplete access. "Try the demo" pairs the phone
// to the demo venue itself (migration 20261013a, claim_demo_ops_device).
//
// What must stay true:
//   - only a venue flagged is_demo can be reached, and the flag is off by default;
//   - the staff PIN still stands between the demo and the venue's data;
//   - the call can be made again (a reviewer reinstalls; a prospect comes back);
//   - a failure says something a person can act on, never a silent dead end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the demo pairing migration opens the demo venue and nothing else', () => {
  const sql = read('../../../supabase/migrations/20261013a_OPS_demo_pairing.sql');

  assert.match(sql, /add column if not exists is_demo boolean not null default false/, 'flag is off by default');
  assert.match(sql, /where is_demo is true/, 'only a flagged venue is reachable');
  assert.ok(!/update public\.locations\s+set is_demo = true/.test(sql.replace(/--.*$/gm, '')),
    'the migration never flags a venue itself: Peter picks it by hand');

  // It links the caller's own row, so it can be run again and cannot take someone else's.
  assert.match(sql, /where device_uid = auth\.uid\(\)/, 'only this session\'s own device row');
  assert.ok(!/claim_code/.test(sql), 'no code is consumed, so pairing again works for ever');

  // Every answer carries a reason and a message the app can show.
  for (const reason of ['no_session', 'no_demo_venue', 'not_registered']) {
    assert.ok(sql.includes(`'${reason}'`), `refusal ${reason} is spelled out`);
  }
  assert.match(sql, /grant execute on function public\.claim_demo_ops_device\(\) to anon, authenticated/);
  assert.match(sql, /revoke all on function public\.claim_demo_ops_device\(\) from public/);
});

test('the Manager pairing screen offers the demo, and the PIN still guards the venue', () => {
  const data = read('./data.js');
  assert.match(data, /export const opsClaimDemo = async \(\) => rpc\('claim_demo_ops_device', \{\}\);/);

  const mgr = read('../../surfaces/ManagerSurface.jsx');
  assert.ok(mgr.includes('No venue yet? Try the demo'), 'the button is on the pairing screen');
  assert.ok(mgr.includes('const { data, error } = await opsClaimDemo();'), 'it calls the demo claim');
  assert.ok(mgr.includes("setStage('pin')") && mgr.indexOf("setStage('pin')") > 0,
    'a demo pairing lands on the PIN screen, never straight in the app');
  assert.ok(mgr.includes('setDemoErr(data?.message || error?.message'), 'a refusal is shown, not swallowed');
});
