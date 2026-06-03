# Releasing the Android app (auto-update)

> **STATUS (May 2026):** the signed + auto-publish flow described below is the **target**
> (roadmap in `AUTO_UPDATE_PLAN.md`). It is **not built yet.** Today the CI
> (`.github/workflows/build-apk.yml`) builds a **debug** APK and uploads it as a
> downloadable artifact — so the *current* process is: trigger that workflow → download
> the APK artifact → upload it to the bucket as `app.apk` → bump `latest.json`. ⚠️ Because
> debug builds use an inconsistent signing key, in-place auto-update is **not reliable**
> until the fixed-key signing in `AUTO_UPDATE_PLAN.md` is set up (devices may need a
> manual reinstall between debug builds).

The Android app (`co.posup.rpos`) is **sideloaded** (no Play Store), so it updates
itself. On launch — and every few hours while running — it reads a version file
from Supabase Storage and, if a newer build is listed, downloads the APK and shows
the system **Install** prompt (one tap).

- Manifest (version file): `https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/latest.json`
- APK: `https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/app.apk`
- Checker code: `android/app/src/main/java/co/posup/rpos/UpdateChecker.java`
- Canonical manifest (edit this, then upload it): `android/release/latest.json`

---

## One-time setup (already done / verify once)

1. **Supabase bucket** `app-releases` (public) — created. ✅
2. **Signing keystore** — keep ONE release keystore and always sign with it.
   Android will only auto-update an APK that's signed with the **same key** as the
   installed one. If the key changes, the device must uninstall + reinstall (which
   wipes the WebView's local cache / device pairing — POS data itself is safe in
   Supabase). ⚠️ **Back up the keystore + passwords somewhere safe.**
3. **First rollout** — the build currently on devices (v3) has no updater, so it
   can't update itself. Install **v4 (this build) manually, once**, on every device.
   From v4 onward, updates are automatic.
4. **Per device, once** — the first time an update runs, Android asks to "allow
   install from this source." Approve it. (On Sunmi this can also be pre-granted
   via their MDM.)

---

## To ship an update (every release)

1. **Bump the version** in `android/app/build.gradle`:
   ```gradle
   versionCode 5        // must increase by at least 1 every release
   versionName "1.4"    // human-facing
   ```
   The updater compares `versionCode`, so it MUST go up or devices won't update.

2. **Build a signed release APK** with the SAME keystore as last time:
   - Android Studio: *Build → Generate Signed Bundle / APK → APK → release*, or
   - CLI: `./gradlew assembleRelease` (with signing configured).
   Output: `android/app/build/outputs/apk/release/app-release.apk`.
   Keep it **under 50 MB** (the Supabase project's per-file limit). This APK is a
   thin WebView wrapper, so it's only a few MB — but if it ever grows past 50 MB,
   raise the limit in Supabase → Project Settings → Storage.

3. **Upload the APK** to the bucket as `app.apk` (overwrite). Either:
   - **Supabase dashboard** → Storage → `app-releases` → upload, name it `app.apk`
     (delete the old one first, or use "replace"), **or**
   - **CLI** (replace `<SERVICE_KEY>` with the project's service_role key):
     ```bash
     curl -X POST \
       "https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/app-releases/app.apk" \
       -H "Authorization: Bearer <SERVICE_KEY>" -H "x-upsert: true" \
       -H "Content-Type: application/vnd.android.package-archive" \
       --data-binary @android/app/build/outputs/apk/release/app-release.apk
     ```

4. **Update the manifest** — edit `android/release/latest.json` so `versionCode` /
   `versionName` match the new build (and set `notes`), commit it, then upload it
   the same way:
   ```bash
   curl -X POST \
     "https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/app-releases/latest.json" \
     -H "Authorization: Bearer <SERVICE_KEY>" -H "x-upsert: true" \
     -H "Content-Type: application/json" \
     --data-binary @android/release/latest.json
   ```

That's it. Within a few hours (or on next app launch) every till downloads it and
shows the one-tap **Install**.

### manifest fields
| field | meaning |
|---|---|
| `versionCode` | integer; update fires when this is **>** the installed versionCode |
| `versionName` | shown in the download notification |
| `apkUrl` | where to fetch the APK (leave as `.../app-releases/app.apk`) |
| `mandatory` | `true` = no "Later" / can't dismiss the permission prompt |
| `notes` | free text, for your own reference |

---

## Notes / future
- **Fully silent install** (zero taps) is possible on Sunmi via their device-owner /
  MDM APIs, or by making the app a privileged/system app. Not done yet — current
  flow is auto-download + one tap.
- The check is throttled (~3h) and skipped when already up to date, so it's cheap.
- Rollback: re-upload the previous APK as `app.apk` and lower `versionCode` in the
  manifest is NOT enough (Android won't downgrade). To roll back you must bump
  `versionCode` on a rebuilt older APK, or reinstall manually.
