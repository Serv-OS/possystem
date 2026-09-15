// The Android device apps on the shared shell (android/webshell, v5.8.79). Reads the Android files so
// a wrong page, a missing update channel or location on the wrong app fails here, before a build.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const A = new URL('../../android/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, A), 'utf8');
const APPS = {
  kds: { name: 'ServOS KDS', mode: 'kds' },
  kiosk: { name: 'ServOS Kiosk', mode: 'kiosk' },
  owner: { name: 'ServOS Owner', mode: 'owner' },
  manager: { name: 'ServOS Manager', mode: 'manager' },
  staff: { name: 'ServOS Staff', mode: 'staff' },
  clock: { name: 'ServOS Time Clock', mode: 'clock' },
  waitlist: { name: 'ServOS Waitlist', mode: 'waitlist' },
  bookings: { name: 'ServOS Bookings', mode: 'bookings' },
};
const value = (xml, kind, name) => {
  const m = xml.match(new RegExp(`<${kind} name="${name}"[^>]*>([^<]*)</${kind}>`));
  return m ? m[1] : null;
};

test('every device app opens its live page, has its own update channel, name and icons', () => {
  const settings = read('settings.gradle');
  assert.match(settings, /include ':webshell'/);
  const workflow = fs.readFileSync(new URL('../.github/workflows/build-device-apps.yml', A), 'utf8');
  for (const [m, a] of Object.entries(APPS)) {
    assert.match(settings, new RegExp(`include ':${m}'`), m);
    const shell = read(`${m}/src/main/res/values/shell.xml`);
    assert.equal(value(shell, 'string', 'shell_app_url'), `https://app.serv-os.app/?mode=${a.mode}`, m);
    assert.equal(value(shell, 'string', 'shell_channel'), m, m);
    assert.equal(value(read(`${m}/src/main/res/values/strings.xml`), 'string', 'app_name'), a.name, m);
    const gradle = read(`${m}/build.gradle`);
    assert.match(gradle, new RegExp(`applicationId "co\\.posup\\.rpos\\.${m}"`), m);
    assert.match(gradle, /implementation project\(':webshell'\)/, m);
    const code = Number(gradle.match(/versionCode (\d+)/)[1]);
    const release = JSON.parse(read(`release/latest-${m}.json`));
    assert.equal(release.versionCode, code, `${m}: latest-${m}.json and build.gradle must move together`);
    assert.equal(release.apkUrl, `https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/${m}.apk`, m);
    for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      assert.ok(fs.existsSync(new URL(`${m}/src/main/res/mipmap-${d}/ic_launcher.png`, A)), `${m} ${d} icon`);
    }
    assert.match(workflow, new RegExp(`'android/${m}/\\*\\*'`), `${m} in the build workflow paths`);
    assert.match(read(`${m}/src/main/AndroidManifest.xml`), /android:name="co\.posup\.rpos\.webshell\.ShellActivity"/, m);
  }
});

test('only Staff has location (the geofenced clock in), as on iOS; only the kiosk locks the back button', () => {
  for (const m of Object.keys(APPS)) {
    const shell = read(`${m}/src/main/res/values/shell.xml`);
    const manifest = read(`${m}/src/main/AndroidManifest.xml`);
    assert.equal(value(shell, 'bool', 'shell_allows_location'), m === 'staff' ? 'true' : 'false', m);
    assert.equal(/ACCESS_FINE_LOCATION/.test(manifest), m === 'staff', m);
    assert.equal(value(shell, 'bool', 'shell_lock_back'), m === 'kiosk' ? 'true' : 'false', m);
    assert.doesNotMatch(manifest, /android\.permission\.CAMERA/, m);
  }
  // The staff clock card sees the Android app and its bridge (src/staff/ClockCard.jsx).
  const shellJava = read('webshell/src/main/java/co/posup/rpos/webshell/ShellActivity.java');
  assert.match(shellJava, /addJavascriptInterface\(new ShellMarker\(\), "RposAndroid"\)/);
  assert.match(shellJava, /window\.RposLocation=\{__android:true,get:function\(\)/);
  const clock = fs.readFileSync(new URL('../src/staff/ClockCard.jsx', A), 'utf8');
  assert.match(clock, /window\.RposIOS \|\| window\.RposAndroid/);
});
