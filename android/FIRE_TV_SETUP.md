# Menu board on an Amazon Fire TV Stick

The menu board runs as its own small Fire-TV app — **Serv OS Menu**
(`co.posup.rpos.menuboard`). It boots straight to the board, stays on, and shows a
pairing code until you assign it a menu in Back Office. It installs **alongside** the
POS app (different package id), so a device can run either.

It's a thin WebView wrapper around `https://dev.serv-os.app/?mode=menuboard` — all the
menu content, layout, pairing and live updates come from the web app you already use.

---

## 0. Build the APK (one-time / when the wrapper changes)

The app is built by GitHub Actions, not the Play Store.

1. GitHub → the `Serv-OS/possystem` repo → **Actions** → **Build Android APK** →
   **Run workflow** (pick `develop`). It also runs automatically whenever anything
   under `android/` changes.
2. When it finishes (~3–4 min) it produces two downloadable artifacts:
   **`ServOS-MenuBoard-FireTV-APK`** (the Fire TV menu board) and `RestaurantOS-POS-APK`.

You then need to get that APK onto the stick. Two ways — pick one.

---

## Option A — direct download on the stick (recommended, no PC)

One-time: let CI host the APK at a public URL the stick can fetch.

1. In **GitHub → repo → Settings → Secrets and variables → Actions → New repository
   secret**, add **`SUPABASE_SERVICE_KEY`** = the Ops project's *service_role* key
   (Supabase → Project `tbetcegmszzotrwdtqhi` → Settings → API → `service_role`).
2. Re-run the **Build Android APK** workflow. It now uploads the APK to:
   ```
   https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/app-releases/menuboard.apk
   ```
   (a short link is easier to type on a TV remote — e.g. make a `bit.ly`/`tinyurl` of it).

Then on the Fire TV:

3. **Allow sideloading:** Settings → **My Fire TV** → **Developer options** →
   turn on **Apps from Unknown Sources** (and **ADB debugging** if you'll use Option B).
   *If you don't see Developer options, open Settings → My Fire TV → About and click the
   device name ~7 times to unlock it.*
4. Install the **Downloader** app (by AFTVnews) from the Fire TV **Appstore** (Search → "Downloader").
5. Open **Downloader** → in the URL box type your short link (or the full URL above) → **Go**.
6. It downloads the APK and opens the installer → **Install** → then **Open**.

## Option B — sideload from a computer over the network (ADB)

1. On the Fire TV: Settings → My Fire TV → Developer options → **ADB debugging** ON, and
   note the stick's IP (Settings → My Fire TV → About → Network).
2. Download + unzip the `ServOS-MenuBoard-FireTV-APK` artifact from the GitHub Actions run.
3. On your computer (with the Android platform-tools `adb` installed):
   ```bash
   adb connect <FIRE_TV_IP>:5555
   adb install -r app-menuboard-debug.apk
   ```

---

## 1. First launch & pairing

1. Open **Serv OS Menu** on the Fire TV (Home → Apps, or the "Your Apps & Channels" row).
2. It shows **"Pair this screen"** with a code, e.g. `K7P2-9XQM`.
3. In Back Office → **Channels → Menu boards → Paired screens**, type that code, pick the
   board to show, and **Pair screen**. The stick switches to the live menu within a few seconds.
4. Re-assign, unpair or remove it any time from that same panel — the screen follows along live.

---

## 2. Keep it on (recommended Fire TV settings)

The app holds the screen awake while it's in front, but also set:

- Settings → **Display & Sounds → Screensaver → Start time → Never** (or as long as possible).
- Settings → My Fire TV → **Sleep** → set the device not to sleep (where available).
- Plug the stick into a powered USB/mains source, not the TV's USB (some TVs cut USB power on standby).

---

## 3. Updating the app later

This first build is **debug-signed**, so to update you re-build and **re-install** it
(uninstall + install, or `adb install -r`). The pairing re-shows its code only if its saved
identity is wiped — a normal re-install keeps it paired.

A proper **release-signed + in-app auto-update** channel for the menu board (so it updates
itself like the POS app) is the next step — see `android/AUTO_UPDATE_PLAN.md`
(add release signing + a `latest-menuboard.json` update feed).

---

## Notes

- **URL/environment:** the app points at `dev.serv-os.app`. To point it at a different
  host (e.g. production), change `MENUBOARD_URL` in
  `android/app/src/main/java/co/posup/rpos/MainActivity.java` and rebuild.
- **Why a separate app:** the POS wrapper (`co.posup.rpos`) carries Sunmi printer /
  second-screen / self-update code that's irrelevant on a TV. The menu-board flavor strips
  all of that — it's display-only.
- **Other TVs:** the same APK works on any Android-TV / Google-TV device. For a non-Amazon
  smart TV's built-in browser, just open `https://dev.serv-os.app/?mode=menuboard` instead.
