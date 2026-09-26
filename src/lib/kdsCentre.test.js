// v5.9.73: a kitchen screen follows the centre on its own devices row (Print routing binds a
// screen after pairing; the pairing record never learned it: Leeds, 26 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../surfaces/kds/KDSSurface.jsx', import.meta.url), 'utf8');

test('the centre is state read from the devices row and followed live, not the pairing record alone', () => {
  assert.match(src, /const \[centreId, setCentreId\] = useState\(device\.centreId\);/);
  assert.match(src, /supabase\.from\('devices'\)\.select\('centre_id'\)\.eq\('id', device\.id\)\.maybeSingle\(\)/);
  assert.match(src, /table: 'devices', filter: `id=eq\.\$\{device\.id\}`/);
  assert.match(src, /localStorage\.setItem\('rpos-device-config', JSON\.stringify\(\{ \.\.\.cfg, centreId: id \}\)\)/, 'remembered for the next boot');
  assert.match(src, /useEffect\(\(\) => \{ setStationFilter\(centreId \|\| 'all'\); \}, \[centreId\]\);/);
  assert.doesNotMatch(src, /const \{ locationId, centreId \} = device;/, 'no longer read once from the pairing record');
});
