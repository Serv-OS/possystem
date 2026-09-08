# Adding a new Serv OS device app (the standard)

Every device app is its own Gradle module with its own `applicationId`, icon, CI workflow, and
**self-update channel**, all signed with the **one shared release keystore** so updates install in
place. POS (`:app`), MPOS (`:mpos`) and Menu Board (`:menuboard`) all follow this. Copy `:mpos`
as the template (it's the cleanest WebView + auto-update example).

Replace `<app>` below with the new module name (e.g. `kds`, `kiosk`), `<APP>` with a label
(e.g. "Serv OS KDS"), and pick the web surface `?mode=<surface>`.

## 1. Module files (under `android/<app>/`)
- **`build.gradle`** — copy `android/mpos/build.gradle`. Change `namespace`/`applicationId` to
  `co.posup.rpos.<app>`, set `versionCode 1` / `versionName "1.0"`. Keep the `signingConfigs.release`
  + `hasKeystore ? release : debug` block verbatim (shared keystore via env).
- **`src/main/AndroidManifest.xml`** — copy `:mpos`'s. Keep `INTERNET`, `ACCESS_NETWORK_STATE`,
  `WAKE_LOCK`, **`REQUEST_INSTALL_PACKAGES`**, and the **FileProvider** block. Adjust
  `screenOrientation` / launcher categories per device (TV apps add `LEANBACK_LAUNCHER` +
  `uses-feature touchscreen/leanback required=false`, like `:menuboard`).
- **`src/main/java/co/posup/rpos/<app>/MainActivity.java`** — copy `:mpos`'s; change the package,
  the URL to `?mode=<surface>`, and the user-agent tag. Keep the `UpdateChecker` wiring
  (`check(false)` on launch + `onResume`, `destroy()` on `onDestroy`).
- **`src/main/java/co/posup/rpos/<app>/UpdateChecker.java`** — copy `:mpos`'s; change the package
  and the three channel constants: `MANIFEST_URL` → `app-releases/latest-<app>.json`,
  `PREFS` → `<app>_update`, `APK_NAME` → `<app>-update.apk`, and the notification title.
- **`src/main/res/xml/file_paths.xml`** — copy verbatim.
- **`src/main/res/values/strings.xml`** — `app_name` = `<APP>`.
- **`src/main/res/mipmap-*/ic_launcher.png`** — the app's icon at 48/72/96/144/192 px
  (`sips -z <px> <px> icon-1024.png --out mipmap-<d>/ic_launcher.png`).

## 2. Register the module
- `android/settings.gradle`: add `include ':<app>'`.

## 3. Update channel
- `android/release/latest-<app>.json`: `{ versionCode, versionName, apkUrl:
  ".../app-releases/<app>.apk", mandatory:false, notes }` (start at versionCode 1).

## 4. CI workflow
- `.github/workflows/build-<app>.yml`: copy `build-mpos.yml`. Change the trigger paths
  (`android/<app>/**`, `android/release/latest-<app>.json`, the workflow file), the
  `assembleRelease` task to `:<app>:assembleRelease`, the artifact name, and the two publish
  URLs to `<app>.apk` / `latest-<app>.json`. (Pushing a workflow file needs the PAT's `workflow`
  scope — already enabled.)

## 5. Secrets (already set once, shared by all apps)
Repo secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
(`servos`), `ANDROID_KEY_PASSWORD`, and `SUPABASE_SERVICE_KEY` (for auto-publish). The keystore is
PKCS12, generated once — back it up; losing it breaks auto-update for every app.

## 6. Ship + updates
- Push → CI builds the signed APK and (with `SUPABASE_SERVICE_KEY`) publishes `<app>.apk` +
  `latest-<app>.json`. Install once on the device (the first signed build; uninstall any prior
  debug build — signature changes once).
- **Every later release:** bump `versionCode` (+ `versionName`) in BOTH `android/<app>/build.gradle`
  AND `android/release/latest-<app>.json`, then push. Devices self-update on next launch (≤3h).

That's the whole standard: new app = copy `:mpos`, swap names + icon + surface, add the workflow.
Icon and auto-update come for free because they're part of the template.
