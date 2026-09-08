# Android build & auto-update — roadmap

> Status: **planned, not yet implemented.** The auto-update *client* (in-app checker)
> ships in v1.3. The signed + automated *publishing* pipeline below is the next step,
> to do when ready. Decided May 2026.

## Where we are today
- **App:** `co.posup.rpos` — single WebView wrapper. versionCode **4 / v1.3** = the build
  that adds the in-app updater (`UpdateChecker.java`).
- **Build:** GitHub Actions `.github/workflows/build-apk.yml` → on push to `main` (or
  manual "Run workflow") → `./gradlew assembleDebug` → uploads the APK as a downloadable
  **artifact**. Someone downloads it and sideloads it. (No local Android SDK needed — this
  is how it's "always been built for you.")
- **Auto-update client:** built. On launch + every ~3h the app reads
  `app-releases/latest.json` from Supabase; if `versionCode` is higher it downloads
  `app.apk` and shows the one-tap installer. (See `RELEASING.md`.)

## The blocker (why auto-update isn't production-ready yet)
The CI builds a **debug** APK. Debug APKs are signed with a **throwaway key that changes
every CI run**, and Android refuses an in-place update when the signing key differs →
auto-update fails with a signature error.

**Fix: sign every build with ONE fixed release key.** Then versionCode bumps update in
place forever. ⚠️ The repo is **public**, so the keystore must live in **GitHub Actions
secrets**, never committed (committing it would let anyone sign a fake "update").

## Target pipeline (a release = one push)
1. **Signing**
   - Generate one release keystore. Store as GH secrets: `KEYSTORE_BASE64`,
     `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
   - `app/build.gradle`: a `release` signingConfig that decodes the keystore from env.
   - Switch CI from `assembleDebug` → `assembleRelease`.
   - Keystore generation (no JDK locally): a one-off `workflow_dispatch` job runs
     `keytool` on the runner and uploads the .jks as an artifact → add it as a secret →
     delete the artifact. (Or generate with keytool on any machine that has Java.)
2. **Auto-publish to Supabase** (after a successful build)
   - GH secret `SUPABASE_SERVICE_KEY`.
   - Workflow `curl`s the signed APK to `app-releases/<flavor>.apk` and writes
     `app-releases/latest-<flavor>.json` (versionCode/versionName from build.gradle).
3. **Trigger** — code now lives on `develop`, but the workflow watches `main`. Switch to
   `develop` with `paths: [ android/** ]` (build only when Android changes) +
   `workflow_dispatch`. (Or tag-based releases.)
4. **Multi-app flavors** (POS now; Kiosk / MPOS / KDS / Menu Board later)
   - gradle `productFlavors` on a `surface` dimension, each with its own `applicationId`,
     `app_name`, and a `BuildConfig.MODE`:
     | flavor | applicationId | mode |
     |---|---|---|
     | pos | `co.posup.rpos` *(KEEP — existing tills upgrade in place)* | pos |
     | kiosk | `co.posup.rpos.kiosk` | kiosk |
     | mpos | `co.posup.rpos.mpos` | mpos |
     | kds | `co.posup.rpos.kds` | kds |
     | menuboard | `co.posup.rpos.menuboard` | menuboard *(no `?mode=menuboard` web surface exists yet — build that first)* |
   - `MainActivity` loads `https://<host>/?mode=` + `BuildConfig.MODE`
     (needs `buildFeatures { buildConfig true }`).
   - `UpdateChecker`: `MANIFEST_URL` → `app-releases/latest-${MODE}.json`, apk →
     `${MODE}.apk` — each app on its own update channel.
   - CI **matrix** builds + publishes each flavor.

## One-time migration cost
Moving from the throwaway debug key to the fixed release key changes the signature, so the
tills running the current debug build must be **uninstalled + reinstalled once** onto the
first release-signed build (local WebView cache / device pairing resets — POS data is safe
in Supabase). After that, every update is in-place and automatic.

## Execution order (when ready)
1. Generate release keystore → add the 4 signing secrets + `SUPABASE_SERVICE_KEY`.
2. Add `release` signingConfig to `build.gradle`; CI → `assembleRelease`.
3. Add the Supabase publish step; switch trigger to `develop` + `paths` filter.
4. POS first: build → reinstall once on tills → confirm auto-update works v(n)→v(n+1).
5. Add flavors as Kiosk/MPOS/KDS/Menu Board are wanted; CI matrix per flavor.

## Decisions captured
- Hosting: Supabase Storage bucket `app-releases` (public). Project per-file cap = 50 MB.
- UX: auto-download + one-tap install; `mandatory` flag supported.
- POS keeps `co.posup.rpos`; other surfaces get suffixed package ids (side-by-side installs).
- Build/sign/publish: **GitHub Actions** (confirmed — not Vercel).
