# Website builder, release pack (v5.12.0)

For Peter. Numbered steps, in order. Each paste says where it goes.
The app release itself (merge to main, Vercel deploy) is the normal flow and is not repeated here.

Area A (data, admin function, domain function) wrote steps 1 to 6 and 9.
The orchestrator adds the Vercel env and the proof lines for the public site in 7 and 8.

---

## 1. Run the SQL

**Where:** Supabase SQL editor, Platform project (`yhzjgyrkyjabvhblqxzu`).

1. Open the file `supabase/migrations/20261031_PLATFORM_website_builder.sql`.
2. Paste the whole file. Press Run.
3. **Check** the result grid at the bottom. Expected rows:
   - `tables` **6**, rls_on **true**, rls_forced **true**
   - `policies` **6**
   - `functions` **3**
   - `view` **1**
   - `bucket_public` **1**, rls_on column shows **true**
   - `web_sites_rows` **0** on a fresh install
4. If it says **"This file is for the PLATFORM project"**, you are in the Ops project. Nothing changed. Switch project and run again.
5. Safe to run twice.

What it makes: six `web_*` tables (RLS forced, browser roles get nothing), the public view `web_sites_public` (live sites only), the host lookup `web_resolve_host`, the AI fence `web_company_for_user` (service role only), the `web-assets` bucket (public read, images only, 10 MB).

---

## 2. Secrets on Supabase (Ops project, where the functions run)

**Where:** Mac Terminal app, any folder. One line at a time.

```
npx supabase secrets set WEBSITE_PREVIEW_SECRET="<paste a long random string>" --project-ref tbetcegmszzotrwdtqhi
npx supabase secrets set VERCEL_TOKEN="<your Vercel personal token>" --project-ref tbetcegmszzotrwdtqhi
npx supabase secrets set VERCEL_PROJECT_ID="<the possystem project id>" --project-ref tbetcegmszzotrwdtqhi
```

- **WEBSITE_PREVIEW_SECRET**: any long random string. Make one with `openssl rand -hex 32` in the same Terminal. The same value must be set on Vercel in step 7, or `/preview` links will not open.
- **VERCEL_TOKEN**: Vercel, Account settings, Tokens, Create. Scope: the team that owns possystem. No expiry, or a long one.
- **VERCEL_PROJECT_ID**: Vercel, possystem project, Settings, General, Project ID (starts `prj_`).
- **VERCEL_TEAM_ID**: only if the project lives in a team. Vercel, Team settings, General, Team ID (starts `team_`). Set it the same way.
- Already there from location-admin, do not touch: `PLATFORM_SUPABASE_URL`, `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`.

---

## 3. DNS record for the free addresses

**Where:** Vercel, Domains, `serv-os.app`, DNS records.

1. Add **one** record: Type **CNAME**, Name **`*.sites`**, Value **`cname.vercel-dns.com`** (the same value the existing `*` record has, copy it from that row).
2. Then Vercel, possystem project, Settings, Domains: add **`*.sites.serv-os.app`** as a project domain. Vercel will show it as verified because the DNS is on Vercel.
3. Also add **`sites.serv-os.app`** as a project domain (venue CNAMEs point at it).

Venue custom domains later point at us with: **CNAME `www` to `sites.serv-os.app`** and **A `@` to `76.76.21.21`**. The Branding and domain screen shows those to the venue, with copy buttons.

---

## 4. Deploy the two functions

**Where:** Mac Terminal app, in the repo folder (`possystem`).

```
npx supabase functions deploy website-admin --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
npx supabase functions deploy website-domain --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
```

Both read the bearer token themselves (real signed in user only, anonymous refused), so `--no-verify-jwt` is the same as every other Back Office function.

---

## 5. Bucket

Made by the SQL in step 1 (`web-assets`, public read). Nothing to click.
**Check:** Supabase, Platform project, Storage: a bucket **web-assets** marked **Public**.

---

## 6. Proof, admin side

1. Back Office, Channels, Appearance, **Website builder** tab opens. First visit shows **Build me a website**.
2. Press it, let the designer build. Pages appear in the list.
3. Press **Publish**. Status card says **Live** with a time.
4. **Check in SQL** (Platform project): `select slug, status, published_at from public.web_sites;` shows the venue slug and `live`.
5. Branding and domain: type a domain you own, press **Check**. The records table shows CNAME and A with a red or green dot each, and the state reads **pending** until DNS is added. If Vercel asks for a TXT record it appears as a third row.
6. Preview: press **Preview**. A `/preview?token=` link opens the draft. The link stops working after 30 minutes.
7. Upload a photo in the editor. The file lands in Storage, `web-assets/<site id>/`.

---

## 7. Vercel env (orchestrator)

**Where:** Vercel, possystem project, Settings, Environment Variables. Set each for Production and Preview.

- `WEBSITE_PREVIEW_SECRET`: the same value as step 2. Without it every `/preview?token=` link answers 403.
- `PLATFORM_SUPABASE_URL`, `PLATFORM_SUPABASE_ANON_KEY`, `PLATFORM_SUPABASE_SERVICE_ROLE_KEY`: add if missing (Supabase, Platform project, Settings, API). The public site read (`api/site.js`) uses the anon key, the draft preview and the AI designer use the service role key.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Ops project): already there for `api/ai.js`; the live menu on the website reads the Ops menu tables with them. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are read as a fallback.
- `ANTHROPIC_API_KEY`: already there. Optional `WEBSITE_DESIGNER_MODEL` overrides the designer model (default `claude-opus-5-5`).
- Optional `SUPABASE_SERVICE_ROLE_KEY` (Ops): lets the designer read menu facts for venues whose menu tables are not anon readable. Not needed for the public site.
- Redeploy after adding (Deployments, Redeploy). The two Vercel functions, `api/site.js` and `api/website-designer.js`, ship with the app, nothing to deploy by hand.

How the hosts reach the function: `vercel.json` rewrites every path on `*.sites.serv-os.app` and on any host that is not ours to `/api/site?path=/...` (assets, favicon, `/.well-known` and `/api` stay static). If a rewrite ever fails to fire, the page still works: the app itself recognises the host and renders the site in the browser (`src/lib/customerUrl.js`), only without the server HTML.

---

## 8. Proof, public side

**Where:** Mac Terminal app, any folder.

Before anything is live, the offline check runs with no network: in the repo folder, `node scripts/website-smoke.mjs` prints **OK** (it renders the sample site's home, menu, a location page, the blog list and a post, and checks the h1, JSON-LD, sitemap and robots).

Local testing of a published site on any host: `http://localhost:5173/?site=<slug>` renders that live site in the browser (no server HTML). The Back Office preview link has the shape `https://<slug>.sites.serv-os.app/preview?token=...&page=/menu`.

```
curl -s https://mozz.sites.serv-os.app/ | grep -c "<h1"
curl -s https://mozz.sites.serv-os.app/ | grep -o 'application/ld+json' | head -1
curl -s https://mozz.sites.serv-os.app/sitemap.xml | head -5
curl -s https://mozz.sites.serv-os.app/robots.txt
```

Expected: the first line prints **1** (one real `<h1>` in the raw HTML), the second prints **application/ld+json**, the sitemap lists the pages, robots has a **Sitemap:** line and **Disallow: /preview**.
Replace `mozz` with the venue's slug from step 6.4.

---

## 9. Roll back

- Site offline: Back Office, Website builder, Publish card, **Take offline**. Or in SQL: `update public.web_sites set status = 'offline' where slug = '<slug>';`
- Functions: redeploy the previous commit's `website-admin` and `website-domain` the same way as step 4.
- Tables: leave them. Nothing else reads them. To remove everything:
  `drop view if exists public.web_sites_public; drop table if exists public.web_assets, public.web_ai_messages, public.web_site_versions, public.web_posts, public.web_pages, public.web_sites cascade; drop function if exists public.web_resolve_host(text), public.web_company_for_user(uuid, uuid[]), public.web_my_companies();`
