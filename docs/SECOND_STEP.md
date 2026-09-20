# Back Office second sign in step: runbook

Written 18 Sep 2026. Rebased onto v5.9.12 and finished 20 Sep 2026. Branch `feat/backoffice-second-step`.

## What this is

- **The problem**: a password is all anyone needs to get into Back Office today. 13 real logins, no second step.
- **The answer**: after the password, **Face ID or fingerprint** where it works, and an **authenticator app code** everywhere else. Every real login must have the app code as its backup.
- **Enforced by the database**, not only by the screens: a password only login is refused by the tables, by the Data API and by every edge function once you switch it on.
- **Nobody else is touched**: tills, KDS, kiosks, TVs, the host stand, customer pages and the staff app all sign in anonymously or through their own door.
- **You run every SQL file yourself.** Claude never runs them.

## Do these in Supabase yourself, before anything else

- **Turn sign ups OFF** (both projects). Dashboard, Authentication, Sign In / Providers, Email: **Allow new users to sign up** off. Anyone can sign up today and land inside.
- **Minimum password length 12** (Authentication, Providers, Email). Ours checks it too; this is the server's own rule.
- **Security emails on** (Authentication, Emails): a sign in from a new device tells the person.
- **Switch WebAuthn (Face ID) on** (Authentication, Providers, Multi Factor, WebAuthn). Relying party **app.serv-os.app**, and add the same as an allowed origin. TOTP (the authenticator app) is on by default.
- **Switch the MFA hook on** (Authentication, Hooks, **MFA Verification Attempt**): choose **Postgres function**, `public.second_step_mfa_hook`. Do it **after** you run the SQL file in step 3, and only then.
- **Leave everything else alone.**

## The order tonight

1. **The app release** goes out.
2. **Re-pair every device that runs on a person's login** (the list is in the file, V7).
3. **Run `20260919s_OPS_second_step.sql`** in the Ops SQL editor, outside service.
4. **Switch the MFA hook on** (above).
5. **Set your own login up first**, and check it.
6. **Tell your people**, and watch who has set up.
7. **Lock out anyone who never did**, then **switch enforcement on**.

## Step 1: the app release

- **What**: this branch, built and deployed to both web addresses (app.serv-os.app and possystem-liard.vercel.app).
- **Edge functions**: deploy **`second-step-reset`** and **`second-step-invite`** (they are new), plus every function this branch changed. `npx supabase functions deploy <name> --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`.
- **Nothing changes for anyone yet**: with the switch off, the app asks for a second step at sign in and the database refuses nobody.

## Step 2: re-pair the devices that run on a person's login

- **Why it matters tonight**: when a person sets up their second step, the auth server signs out **their other password only sessions**. A till running on their Back Office login loses its session with them, and **card payments, gift cards and loyalty stop on that till** until it is paired again.
- **Find them**: run **V7** in the file (Ops SQL editor). It lists every till, KDS, manager app, host stand, TV and card terminal that is running on a person's login.
- **Re-pair every one of them, tills included.** Back Office, Hardware, Terminals (or Channels, Kiosks) and pair the device again. Do not leave it for later: "tills heal themselves" is **not true** here.
- **How to be sure**: run V7 again. It must come back empty before step 7.

## Step 3: run the SQL file

- **Where**: the **Ops** SQL editor (tbetcegmszzotrwdtqhi). There is no Platform file: nobody signs in to Platform.
- **When**: **outside service, and at night**. It takes a lock on every table for a moment, and online ordering never closes, so a kiosk or a QR order can stall for a few seconds while it runs.
- **What**: paste all of `supabase/migrations/20260919s_OPS_second_step.sql` and press **Run**.
- **All or nothing**: if it stops, nothing changed. Fix the cause and run it again.
- **Then check, and treat any of these as a failure**: **V2** shows the Data API check, **V3** shows missing = 0, **V4** shows 1 (storage is fenced). If V2 or V4 is empty, tell Claude before you go on: the fence has a hole in it.
- **Run it again after any later migration that adds a table** (V3 tells you when one is missing).

## Step 4: switch the MFA hook on

- **Where**: Authentication, Hooks, **MFA Verification Attempt**, Postgres function `public.second_step_mfa_hook`.
- **What it does**: nobody can set up a **first** second step with only a password. They must type a code we email to the address on their account first.
- **Why it matters**: 7 of your 13 logins have not signed in for a month. Without this, a thief with one of those passwords sets up **their own** phone and the second step protects them, not you.
- **Check it**: **V9** in the file. Expect `needs_email` true, `hook_rejects_a_first_factor` true, `auth_server_may_call_it` true.

## Step 5: set your own login up first

- **Sign in to Back Office.** You are asked to set up.
- **Press "Email me a code"**, open your email, type the 6 digits.
- **Scan the QR code** with your authenticator app (or press **Open in my authenticator app** if you are on your phone), type the 6 digit code it shows.
- **Add Face ID** when it offers, on the device you use most.
- **Sign out and back in.** Face ID or the code is asked for.
- **Make a second super admin tonight** (the break glass section in the file has the line). One lost phone must never be the end of it. Have them set up their own second step the same day.

## Step 6: tell your people

- **What to say**: "From tonight, signing in to Back Office needs your password and your phone. The first time, we email you a code to make sure it is you. It takes a minute and you only do it once."
- **What they need**: their email, and an authenticator app (Google Authenticator, Microsoft Authenticator, Apple Passwords or 1Password).
- **Lost phone**: an **owner** resets their own staff in Back Office, Settings, Sign in security. **Owners ask ServOS.** Nobody resets themselves.
- **No email**: an owner, or ServOS, can set them up instead (the same screen, "Send a set up code").
- **Watch who has done it**: **V6** in the file (counts only) and **V6b** (who is left, by email).

## Step 7: lock out, then switch on

- **Only when V6 says** `back_office_without_second_step` = 0 **and** `back_office_password_only_sessions` = 0. The staff app is not counted: it signs in at aal1 by design and never reaches Back Office.
- **Lock out first**: the one line under **LOCK OUT** in the file bans every Back Office login that never set up. They are not deleted, and one line lets any of them back in when they ask.
- **Then switch on**: the one line under **SWITCH ENFORCEMENT ON**.
- **Watch for ten minutes**: open Back Office, the admin portal and the Owner app; take a card payment on a till; place an online order.

## If something goes wrong

- **Break glass, one line, no deploy, takes effect in 30 seconds**:
  `update public.second_step_settings set enforce = false, app_gate = false, updated_at = now() where id;`
- **You lost your phone**: clear your own factors in the SQL editor (the break glass section of the file has the exact line), then sign in and set up again. Or Authentication, Users, your user, Delete MFA factor.
- **Setting up is broken for everyone**: switch the MFA hook off in the dashboard, or
  `update public.second_step_settings set first_factor_needs_email = false, updated_at = now() where id;`
- **The database is refusing everyone**: `alter role authenticator reset pgrst.db_pre_request;` then `notify pgrst, 'reload config';`
- **Roll it all back**: the ROLL BACK block at the end of the file. Two pastes, ten seconds apart. It drops nothing, so nothing can break while it runs.

## What is still open after this

- **The staff app** signs in at aal1 and is out of scope. It reaches one person's own records through one server function. Its money actions (bank details) now ask for a second step from anyone who ALSO has Back Office reach.
- **Anonymous sessions** are not a login, so the second step is not what stops them. That is the database fence: `20260919a1` is live, **`20260919a2` is the half that closes the money functions to a browser with only the public key**. Run it when you are ready (`docs/FENCE_STAGE_1_PAYMENTS.md`).
- **Sign ups**: turning them off is the first bullet of this runbook. Until it is done, anyone can make themselves an account.
