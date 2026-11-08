// menuBoardStayOn.test.js: the Fire TV menu board app (android/menuboard) stays on the screen.
//
// Peter, 8 Nov 2026: "the menu boards and a few stores keep quitting - they close down and dont
// re open". The app had no handler for its page's Chrome process being killed, nothing relaunched
// it after a crash, and nothing opened it when the stick started. These pins keep 1.2's three
// answers in the build, and keep the version pointer the sticks read in step with the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const A = new URL('../../android/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, A), 'utf8');

test('the page killed for memory is replaced in place, never the whole app closed', () => {
  const main = read('menuboard/src/main/java/co/posup/rpos/menuboard/MainActivity.java');
  assert.match(main, /public boolean onRenderProcessGone\(WebView view, RenderProcessGoneDetail detail\)/);
  assert.match(main, /return true;\s+\/\/ handled: the app stays up/);
  assert.match(main, /setRendererPriorityPolicy\(WebView\.RENDERER_PRIORITY_IMPORTANT, false\)/);
  assert.match(main, /StayOn\.rendererGoneDelay\(MainActivity\.this, crashed\)/);
  assert.match(main, /ui\.postDelayed\(MainActivity\.this::mountWebView, delay\)/);
  assert.match(main, /StayOn\.install\(this\)/);
  assert.match(main, /ServOS-MenuBoard\/1\.2/, 'the user agent carries the app version');
});

test('a crash relaunches the board with a growing wait: 1 s, 5 s, then a minute', () => {
  const stay = read('menuboard/src/main/java/co/posup/rpos/menuboard/StayOn.java');
  assert.match(stay, /Thread\.setDefaultUncaughtExceptionHandler/);
  assert.match(stay, /DELAYS_MS = \{ 1000L, 5000L, 60000L \}/);
  assert.match(stay, /QUIET_MS = 10L \* 60 \* 1000/);
  assert.match(stay, /setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP/, 'no exact alarm permission needed');
  assert.match(stay, /PendingIntent\.FLAG_IMMUTABLE/);
  // the pure rule, run here the way the Java runs it
  const delayFor = (n) => [1000, 5000, 60000][Math.min(Math.max(1, n) - 1, 2)];
  assert.deepEqual([1, 2, 3, 4, 9].map(delayFor), [1000, 5000, 60000, 60000, 60000]);
});

test('the board opens when the stick starts; the manifest declares what Fire OS 8 needs for the one time grant', () => {
  const manifest = read('menuboard/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.RECEIVE_BOOT_COMPLETED/);
  assert.match(manifest, /android\.permission\.SYSTEM_ALERT_WINDOW/);
  assert.match(manifest, /<receiver\s+android:name="\.BootReceiver"\s+android:exported="true"/);
  assert.match(manifest, /android\.intent\.action\.BOOT_COMPLETED/);
  assert.match(manifest, /android:launchMode="singleTask"/, 'a relaunch reuses the one board, never stacks two');
  const boot = read('menuboard/src/main/java/co/posup/rpos/menuboard/BootReceiver.java');
  assert.match(boot, /Intent\.ACTION_BOOT_COMPLETED\.equals\(a\)/);
  assert.match(boot, /FLAG_ACTIVITY_NEW_TASK/);
  const setup = read('FIRE_TV_SETUP.md');
  assert.match(setup, /adb shell appops set co\.posup\.rpos\.menuboard SYSTEM_ALERT_WINDOW allow/);
});

test('version 1.2 = versionCode 3 in the build and in the pointer the sticks read; the pointer is not mandatory', () => {
  const gradle = read('menuboard/build.gradle');
  assert.match(gradle, /versionCode 3\b/);
  assert.match(gradle, /versionName "1\.2"/);
  const release = JSON.parse(read('release/latest-menuboard.json'));
  assert.equal(release.versionCode, 3);
  assert.equal(release.versionName, '1.2');
  assert.equal(release.mandatory, false, 'the board stays visible behind an update prompt staff can press Later on');
  assert.equal(release.apkUrl, 'https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/menuboard.apk');
});

test('plain ASCII in the Java, manifest and guide (no dashes as punctuation)', () => {
  for (const rel of ['menuboard/src/main/java/co/posup/rpos/menuboard/MainActivity.java', 'menuboard/src/main/java/co/posup/rpos/menuboard/StayOn.java', 'menuboard/src/main/java/co/posup/rpos/menuboard/BootReceiver.java', 'menuboard/src/main/AndroidManifest.xml', 'release/latest-menuboard.json']) {
    const t = read(rel);
    assert.ok(!/[–—]/.test(t), `${rel} has a dash`);
  }
});
