# Back Office sign in: passkeys. The runbook

Written 18 Sep 2026. Rewritten 20 Sep 2026 for passkeys. Branch `feat/passkey-sign-in`.

## What this is

- **The problem**: a password is all anyone needs to get into Back Office. Passwords get guessed, reused and phished.
- **The answer**: a **passkey**. Your fingerprint on your laptop, your face on your phone, Windows Hello on Windows.
- **Peter chose it** (20 Sep): "I just want it more secure I hate multi factor auth apps, this is what toast does I want this", and "we need this for every user across every device".
- **No app, no codes, no typing.** The passkey never leaves the device and there is nothing to phish.
- **One set up, once.** Then that device signs you in with a touch.
- **Enforced by the database**, not only by the screens. That part is already live (`20260919s`, run on production 20 Sep, enforcement still off).
- **You run every SQL file yourself.** Claude never runs them.

## The thing to understand first: a passkey is aal1

- **Supabase calls a passkey a FIRST factor.** A passkey sign in gives a session at **aal1**, not aal2, because the passkey replaces the password instead of coming after it.
- **The rule we shipped on 19 Sep only let aal2 through.** Left as it was, switching people to passkeys would refuse **every single person** the moment enforcement went on.
- **So the fix is `20260920p_OPS_passkey_second_step.sql`**: it asks the session itself **how you signed in** (`auth.mfa_amr_claims`, plus the token's own `amr` claim), and a session that signed in with a passkey passes.
- **The method names are a setting**, not a guess in the code: `second_step_settings.passkey_methods` starts as `webauthn`, `passkey`, `webauthn_credential`. If Supabase names it something else, change that one row, no deploy.
- **aal2 still passes** exactly as before, so anybody already on an authenticator app is untouched.
- **A password only session is still refused** when enforcement is on. That is the whole point.

## Back Office lives at app.serv-os.app

- **A passkey belongs to one domain.** Ours is **serv-os.app**, and a passkey made there works on app, dev and stage.
- **possystem-liard.vercel.app can never have passkeys.** It is not our domain, so the browser itself refuses to make one, whatever we write.
- **So Back Office must be used at app.serv-os.app.** Tell everyone that once, and change the bookmarks.
- **The old address is not blocked.** Anyone who opens it still signs in with their password and the emailed code, and the screen says in plain words: open app.serv-os.app.
- **What to do about it**: keep possystem-liard.vercel.app as the **device** address (tills, KDS, kiosks, TVs) and point **people** at app.serv-os.app. When you are ready to retire it, redirect it to app.serv-os.app.

## Do these in Supabase yourself

Already done on 20 Sep, so check rather than redo:

- **Passkeys on**: Authentication, Sign In / Providers, **Passkeys** enabled, relying party **serv-os.app**, origins `https://app.serv-os.app`, `https://dev.serv-os.app`, `https://stage.serv-os.app`.
- **Sign ups off** (both projects). Authentication, Sign In / Providers, Email: **Allow new users to sign up** off.
- **Minimum password length 12** (same screen). The password is still the fallback, so it still matters.
- **Security emails on** (Authentication, Emails).

Still to do, in this order:

1. **Run `20260920p_OPS_passkey_second_step.sql`** in the **Ops** SQL editor (tbetcegmszzotrwdtqhi). One paste, all or nothing.
2. **Check P1 to P5** at the end of that file. P1 every row ok. P2 the three settings. P3 the two new functions. P4 the passkey table is private. P5 the fence untouched (203 policies).
3. **MFA hook**: Authentication, Hooks, **MFA Verification Attempt**, Postgres function `public.second_step_mfa_hook`. It is what stops a stolen password setting up a thief's own second step. Switch it on after step 1.
4. **Leave WebAuthn MFA alone.** Supabase refused it on this project ("Enabling of MFA with WebAuthn not currently supported"). We do not need it: passkeys are a separate thing and they are on.

## The order

1. **Deploy the app** (this branch), and the edge functions it changed: `second-step-reset`, `second-step-invite`.
2. **Run `20260920p`** and check P1 to P5.
3. **Switch the MFA hook on.**
4. **Set your own passkey up first**, on your laptop, then add your phone.
5. **Make a second super admin** and have them set up their own passkey the same day.
6. **Tell your people.**
7. **Watch who has set up** (V6 and V6b in `20260919s`; a passkey now counts).
8. **Lock out anyone who never did, then switch enforcement on.** The lock out
   query must count **passkeys as well as authenticator apps** (a passkey is not
   an `mfa_factor` on this project). The corrected one is in `20260919s`; the
   version written before passkeys would have banned everyone who set one up.

## Setting your own up

- **Open app.serv-os.app** and sign in with your password.
- **Type the code we email you.** This happens once, before your first passkey, so a stolen password cannot set one up.
- **Press "Set up my passkey"** and use your fingerprint, face or PIN when your device asks.
- **Sign out and back in.** Press **Sign in with a passkey**. No password.
- **Add your phone too**: on your phone, Back Office, Settings, **Sign in security**, "Add a passkey for this device".
- **Two devices is the rule of thumb.** One passkey is enough to sign in, two is enough to never be stuck.

## Day to day

- **Adding a device**: Settings, Sign in security, "Add a passkey for this device". As many as you like.
- **Removing one**: same screen. The **last** one cannot be removed unless you kept an authenticator app, so nobody can lock themselves out.
- **A device with no fingerprint or face** (an old shared PC, our own apps, the Sunmi tills): it offers the authenticator app instead, and says so. Nobody meets a dead end.
- **Lost phone**: an **owner** resets their own staff in Settings, Sign in security. **Owners ask ServOS.** Nobody resets themselves.
- **A reset removes their passkeys too.** If any could not be removed, the screen says so in red and tells you to call ServOS: a passkey left on a lost phone can still sign in on its own.
- **After a reset** they are emailed, and set up again at their next sign in: the emailed code, then a new passkey.

## If something goes wrong

- **Break glass, one line, no deploy, 30 seconds**:
  `update public.second_step_settings set enforce = false, app_gate = false, updated_at = now() where id;`
- **Passkeys are refused but people have them**: check the method name.
  `select passkey_methods from public.second_step_settings;` then, if GoTrue is calling it something else,
  `update public.second_step_settings set passkey_methods = array['webauthn','passkey','webauthn_credential','<the name>'] where id;`
- **You lost every device**: clear your own factors and passkeys in the SQL editor (the break glass block of `20260919s`, plus `delete from public.second_step_passkeys where user_id = '<you>';` and Authentication, Users, your user, remove the passkey), then sign in with your password and set up again.
- **Setting up is broken for everyone**: switch the MFA hook off, or
  `update public.second_step_settings set first_factor_needs_email = false, updated_at = now() where id;`
- **The database is refusing everyone**: `alter role authenticator reset pgrst.db_pre_request;` then `notify pgrst, 'reload config';`
- **Roll the passkey rule back**: the ROLL BACK block at the end of `20260920p`. It switches enforcement off first, puts the aal2 only rule back, and **drops nothing**.

## How this was proved

- **The rules**: `npm test` (the passkey rules, the ceremony, the client, the reset).
- **A real browser**: `node supabase/tests/second_step/passkey_browser_proof.mjs` drives headless Chromium with a **virtual fingerprint sensor**: register, sign in with no password, a second device, removal, the last one refused, a forgotten passkey, a device with no sensor, and a domain that is not ours. **17 of 17**.
- **The SQL**: `supabase/tests/second_step/test_second_step.py` on a throwaway Postgres 17, both files, applied twice, with the roll back run exactly as you run it. **83 of 83**.
- **Nothing was run against production by Claude.**

## What is still open

- **The staff app** signs in at aal1 and is out of scope. One person's own records, through one server function.
- **Anonymous sessions** are not a login. That is the database fence: `20260919a1` is live, and **`20260919a2`** is the half that closes the money functions to a browser holding only the public key (`docs/FENCE_STAGE_1_PAYMENTS.md`).
- **supabase-js 2.103** has no passkey code, so we speak to the same auth endpoints ourselves (`src/lib/secondStep/passkey.js`). When the app moves to 2.116 or later, each call swaps for the built in one.
- **possystem-liard.vercel.app** keeps working with passwords. Retire it when the bookmarks have moved.
