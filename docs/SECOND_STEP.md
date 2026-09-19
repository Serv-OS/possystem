# Back Office second sign in step

Branch `feat/backoffice-second-step`. Peter, 18 Sep 2026: "so no matter if a hacker gets the password they cant login".

## The way we went

- **What changes:** after the password, every Back Office sign in needs a second step that only the person has.
- **Face ID or fingerprint** in normal browsers on app.serv-os.app: iPhone and iPad Safari, Mac (Touch ID), Windows (Windows Hello). Other devices get it only where the browser says the device has one; everyone else uses the code.
- **Authenticator app code** for everyone, always, as the backup: Google Authenticator, Microsoft Authenticator or 1Password.
- **Code only** where Face ID cannot work yet: inside our own iPhone and Android apps, on the Sunmi tills, and on possystem-liard.vercel.app.
- **Why both:** Face ID is the quick one. The code works everywhere, so nobody is ever stuck.
- **Why not Face ID only:** our apps need native changes first (listed under Later), and Supabase marks Face ID for sign in as experimental.
- **Why not passkeys instead of passwords:** Supabase passkey sign in is still beta and cannot be a second step. Later.
- **Who is asked:** Back Office, the admin portal and the Owner app. Same login, same second step, once per browser or app.
- **Who is never asked:** tills, KDS, kiosks, TVs, host stands, the Manager app and customers. They are devices with no password.
- **Staff app:** not included now. It only shows a person their own shifts and details, through one server function. The database refuses it everything else.
- **Enforced by the database too:** once you switch it on, the database and the server functions refuse a password only sign in, even if someone skips our screens.
- **One switch:** OFF until everyone has set up. One line of SQL turns it on or off. No deploy.
- **Lost phone:** owners reset their staff in Back Office. Only ServOS resets owners. Nobody resets themselves. Every reset is logged and emailed.
- **Platform:** nobody ever signs in to Platform (0 logins), so there is no Platform session to protect. Turn Platform sign ups off (step 1). No Platform SQL file.

## What is proven, and what is not yet

- **Proven:** the SQL on a local copy of Postgres 17 with the Supabase roles: 34 checks, run twice, wrong project refused, roll back and re install.
- **Proven:** the rules in 51 new unit tests (`npm test`, 2688 in all, all passing), including "tills and the service role are never refused".
- **Proven:** the real sign in screens in a real Chromium browser with its built in Face ID stand in: set up, Face ID sign in, the code, wrong codes, a failed Face ID, phone width, the Owner app, the settings page. 33 checks, against a stand in auth server that checks the signatures (see Proof).
- **Not proven yet:** the live Supabase auth server with Face ID switched on. It is off today. Step 5 is the first real test, by you, before anyone else.

## Runbook: do these in order

### Step 1. Supabase settings (you, in the dashboard)

What we are looking at: two Supabase projects. Only settings, no code.

**Ops project** (tbetcegmszzotrwdtqhi), Authentication:
- **Multi Factor:** authenticator app (TOTP) enroll and verify ON. They are already on.
- **Multi Factor:** WebAuthn enroll ON and verify ON.
- **Passkeys, Relying Party:** Display Name `ServOS`. ID `serv-os.app`. Origins `https://app.serv-os.app,https://dev.serv-os.app,https://stage.serv-os.app` (Supabase allows up to 5).
- **Passkeys sign in itself:** leave OFF. We only use the Relying Party boxes, which Face ID as a second step shares (one setting in the auth server for both).
- **Passwords:** minimum length `12`. Leaked password check stays ON.
- **Security emails:** turn ON the notices for password changed, email changed, and second step added or removed.
- **Leave sign ups ON:** turning them off also blocks the anonymous sign in every till uses.
- **Leave session time limits OFF:** they would also end till sessions.

**Platform project** (yhzjgyrkyjabvhblqxzu), Authentication:
- **Sign ups OFF.** Nobody uses Platform logins (0 users), so nothing breaks.
- **Leaked password check ON**, minimum length `12`.
- **Security emails ON.**

If the dashboard names differ, the auth config names are: `mfa_web_authn_enroll_enabled`, `mfa_web_authn_verify_enabled`, the WebAuthn relying party id, display name and origins, `password_min_length`, `password_hibp_enabled`, `disable_signup`.

### Step 2. Before the release: devices signed in as a person

What we are looking at: 13 devices run on someone's Back Office login instead of their own device identity (7 seen in the last fortnight). When that person sets up their second step, Supabase signs out their other password only sessions, including those devices.

- **Tills and KDS:** heal themselves. They take a fresh device session and claim the till again.
- **Manager app, host stands, menu boards, order screens, card terminals:** show their pairing code again. Pair them again in Back Office.
- **List them:** query V7 in the SQL file (device and venue names only).
- **Best fix, now:** on each one, sign out of Back Office, then pair it again as a device.

### Step 3. Deploy the server functions (Claude, with the access token)

- The 96 functions in the deploy list at the end, plus the new `second-step-reset`.
- **Safe before the SQL:** the switch reads OFF while its table does not exist, so nothing changes for anyone.

### Step 4. Run the SQL (you, outside service)

What we are looking at: `supabase/migrations/20260919s_OPS_second_step.sql`, Ops project only.

- **When:** outside service. It adds a fence to every table, and a busy table makes it stop (just run it again).
- **How:** paste into the Ops SQL editor, press Run. One transaction: an error means nothing changed.
- **Check:** run V1 to V5 from the bottom of the file. Each says what you should see.
- **If you see "The Data API check was NOT switched on":** tell Claude. The tables are still fenced.
- **Refuses nobody** until step 6.

### Step 5. App release and your own first test

- **Release:** merge the branch and let Vercel deploy.
- **You first,** on app.serv-os.app in Safari or Chrome: sign in, set up the authenticator app (scan the code), then add Face ID.
- **Test 1:** sign out, sign in again with Face ID.
- **Test 2:** sign in on a second browser with the 6 digit code.
- **Test 3:** Settings, Sign in security, see your team list.
- **Then tell owners:** "Next time you sign in to Back Office you will set up a second step. Have your phone ready. It takes a minute."

### Step 6. Switch enforcement on (you, when everyone is set up)

- **Watch:** query V6 (counts only, no names). You need `active_without_second_step = 0` and `password_only_sessions_7_days = 0`.
- **Who is missing:** Company Admin, Sign in security shows each login and its status.
- **Switch on:** `update public.second_step_settings set enforce = true, updated_at = now(), note = 'switched on by Peter' where id;`
- **Takes effect:** within 30 seconds. No deploy.
- **Test:** a password only sign in now sees nothing and gets "Your sign in needs its second step".

## Emergency

- **Break glass, one line:** `update public.second_step_settings set enforce = false, updated_at = now() where id;`
- **If sign in itself is broken** (Supabase second step down): `update public.second_step_settings set enforce = false, app_gate = false, updated_at = now() where id;` The app then stops asking. Put `app_gate` back to true straight after.
- **Full roll back:** the two pastes at the end of the SQL file, 10 seconds apart, in that order.

## Lost phone

- **Staff:** the venue owner opens Settings, Sign in security, Your team, and presses Reset.
- **Owners and ServOS admins:** only ServOS, in Company Admin, Sign in security.
- **Check it is really them:** call them back on a number you already know.
- **They set up again** at their next sign in. They get an email. The reset is logged in `second_step_resets`.

## Later

- **Face ID inside our apps:** iOS needs the Associated Domains entitlement (`webcredentials:serv-os.app`) and an apple-app-site-association file on serv-os.app (the website repo). Android needs androidx.webkit, Credential Manager and an assetlinks.json file. Then new app builds.
- **Passkeys instead of passwords** when Supabase makes them stable.
- **Staff app:** add the second step for bank detail changes first.
- **New sign ups get an owner profile** (`handle_new_user`): the database fence project closes this.
- **Side finding:** the Vercel `api/ai.js` does not check who is calling it.

---

## For engineers

### How it fits together

| Layer | What it does | Where |
|---|---|---|
| App gate | After the password: challenge, set up, or backup. Nothing loads before it passes. | `src/components/secondStep/SecondStepGate.jsx`, rules in `src/lib/secondStep/rules.js`, auth calls in `src/lib/secondStep/client.js` |
| Surfaces | Back Office, admin portal, Owner app, password reset landing | `BackOfficeApp.jsx`, `CompanyAdminApp.jsx`, `OwnerSurface.jsx`, `BOLogin.jsx` |
| Settings page | Your second steps, add Face ID or another app, change password, your team | `src/backoffice/sections/SignInSecurity.jsx`, `src/admin/sections/AdminSecondSteps.jsx` |
| Edge functions | Refuse an aal1 real login when the switch is on; tills, service role, no token: always pass | `supabase/functions/_shared/second-step.ts`, wired into 78 functions plus `authenticateCaller` (17) and the branded email check |
| Recovery | Remove a login's factors (owner: their staff; ServOS: anyone else), audit first, email | `supabase/functions/second-step-reset`, rules in `_shared/second-step-reset-rules.ts` |
| Database | Restrictive `second_step_fence` on every public RLS table and `storage.objects`; PostgREST pre-request check covers the 86 SECURITY DEFINER functions | `supabase/migrations/20260919s_OPS_second_step.sql` |

### Rules worth knowing

- `aal` comes from the access token. A refresh keeps it. Removing a factor drops that session back to aal1 at the next refresh, and the app gate closes again.
- A successful second step makes Supabase delete that person's OTHER aal1 sessions. That is why step 2 exists.
- The auth server will not change a password on an aal1 session once the login has a second step. The reset landing asks for the second step first.
- auth-js `mfa.webauthn.register()` is never used: on a failed enrol it unenrolls the login's VERIFIED factor with the same name. We enrol, challenge and verify ourselves, and only ever clean up unverified leftovers.
- auth-js defaults ask for a USB security key. We ask for the device's own biometric (`authenticatorAttachment: 'platform'`, `userVerification: 'required'`).
- The server decides the Face ID domain (`serv-os.app`). The client list `WEBAUTHN_HOSTS` must match the Supabase origins.
- The edge helper decodes the token without checking the signature. It only ever refuses, never grants; every function still proves the caller with `getUser`.
- The switch is read with the service role, cached 30 seconds. Table missing or row missing: OFF. Never read and the read fails: ON for aal1 logins only (fail closed), with a "try again" message.

### Proof

- **SQL:** `scratchpad/sstest/run.sh` builds a local Postgres 17 with Supabase like roles (postgres not a superuser; anon, authenticated, service_role, authenticator), runs the file twice as postgres in one transaction, then 34 behaviour checks: password only login refused on a location fenced table, an allow all table and storage; refused by the pre-request check, including a SECURITY DEFINER write that row level security alone would let through; tills, aal2 logins, the public key and the service role untouched; the switch table unreadable and unwritable by logins; break glass; a missing row is OFF. Also: the wrong project guard changes nothing, and the two paste roll back removes everything before a clean re install.
- **Browser:** `scratchpad/ssproof/proof.mjs` runs real Chromium with its virtual authenticator (internal, user verification on) against `mockauth.mjs`, a stand in for the auth server's password and MFA endpoints that follows the auth-js 2.103 request shapes and really checks: the WebAuthn challenge, origin, relying party hash, user presence and verification flags, the ES256 signature against the key from set up, the sign count, and RFC 6238 codes. It drives the real BOLogin, SecondStepGate, Sign in security page and Owner app through the app's own supabase client. 33 checks pass: no skip on the first set up, QR and typed key, code then Face ID offer, Face ID sign in (signature verified, sign count moves on), wrong code refused, failed Face ID refused then the code works, reload goes straight in, phone width layout, the last authenticator app cannot be removed, removing the Face ID a session used closes the gate again, a new password still needs the second step, the Owner app gate, and no console errors.
- **Not proven by the stand in:** the real Supabase auth server. Its WebAuthn MFA is switched off today; step 5 is the first real run.

### Deploy list

`second-step-reset` (new), and every function below (they import the changed shared files or were wired):

adyen-create-session, adyen-financial, adyen-modify, adyen-onboard, adyen-terminal-admin, adyen-terminal-charge, challenge21-counter, create-user, customer-import, ezcater-connect, gift-fulfill, hubrise-catalog-push, hubrise-connect, hubrise-inventory-push, hubrise-order-status, location-admin, manager-approve, manager-snapshot, marketing-admin, marketing-campaigns, marketing-compliance, marketing-domains, marketing-report, marketing-segments, marketing-send, marketing-workflows, menu-translate, owner-snapshot, payments-admin, payments-onboard, payments-processor, provision-location, review-admin, review-google, review-reply, review-request, review-sync, ryft-create-payment-session, ryft-disputes, ryft-refund, ryft-tab, ryft-terminal-cancel, ryft-terminal-debug, ryft-terminal-payment, ryft-terminal-poll, ryft-terminals, send-receipt, send-sms, send-welcome, stripe-assign-reader-to-pos, stripe-cancel-reader-action, stripe-create-payment-intent, stripe-increment-authorization, stripe-link-merchant, stripe-poll-reader-action, stripe-process-payment-on-reader, stripe-readers-status, stripe-refund, stripe-register-network-reader, stripe-sync-location-reader-config, stripe-terminal-connection-token, stripe-unregister-reader, stripe-update-reader-display, stripe-upload-reader-splashscreen, terminal-job-cancel, terminal-job-charge, terminal-job-create, terminal-job-status, trading-report, uber-direct, wifi-admin, workforce-clock, workforce-compute, xero-bills, xero-config, xero-connect, xero-sales, po-send, staff-portal, gift-issue, gift-bulk-create, gift-redeem, gift-import, gift-void, gift-lookup, gift-reverse-redeem, gift-config, gift-list, gift-resend, message-templates, loyalty-config, loyalty-earn, loyalty-member-lookup, loyalty-refund, loyalty-redeem, loyalty-rewards.

Also safe to redeploy (they import a changed shared file but call nothing that changed): loyalty-enroll, loyalty-reconcile, loyalty-balance, marketing-run, order-notify.

Command: `SUPABASE_ACCESS_TOKEN=... npx --yes supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`
