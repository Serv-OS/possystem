# Website Builder, architecture contract (v5.12.0, first iteration)

Owner decisions (Peter, 31 Oct 2026): built once, must work. Lives in Back Office under
Channels › Appearance as a fifth tab "Website builder". One website per COMPANY with a
Find us page (nearest shop, per location ordering). Venue buys its own domain, we never
sell domains. Blog in. Custom code allowed but owner only, off by default. The headline
flow is "Build me a website" and the AI does it. SEO matters: venues must come up in
Google and compete, so the public site is SERVER RENDERED HTML, never a blank JS shell.

Every agent reads this file first and builds only inside its file ownership (section 12).
Where this file and the code disagree, the code is right about what exists today and this
file is right about what to build. Do not invent other tables, routes or block names.

---

## 1. Where things run

| Piece | Runs where | Why |
|---|---|---|
| Website tables | PLATFORM Supabase DB (`yhzjgyrkyjabvhblqxzu`) | companies, locations, branding already live there |
| Public read of a published site | PLATFORM DB, anon SELECT on `web_sites_public` view | published content is public by definition |
| Back Office writes | Supabase edge function `website-admin` (Deno, service role, fenced) | same discipline as `location-admin` |
| Domain checks + Vercel domain registration | edge function `website-domain` (Deno) | needs secrets, DNS over HTTPS |
| AI designer | Vercel function `api/website-designer.js` (Node) | Anthropic key already lives on Vercel (`api/ai.js`) |
| Server rendered venue site (SEO) | Vercel function `api/site.js` (Node) | reads the published snapshot, returns real HTML |
| Interactive site in the browser | the existing React SPA, `src/surfaces/website/` | hydrates over the server HTML |
| Editor + designer chat UI | Back Office, `src/backoffice/sections/website/` | lazy chunk, never in the POS bundle |

Peter runs every SQL file by hand in the Supabase SQL editor and deploys functions with
the release paste. Claude never writes to production or deploys. Migrations go in
`supabase/migrations/20261031_PLATFORM_website_builder.sql` (one file, idempotent,
`create table if not exists`, re-runnable).

## 2. Data model (Platform DB)

All ids `uuid default gen_random_uuid()`. All tables `force row level security`.

### web_sites  (one per company)
```
id uuid pk
company_id uuid not null unique references companies(id)
slug text not null unique            -- free address <slug>.sites.serv-os.app, [a-z0-9-]{3,40}
custom_domain text unique            -- e.g. www.mozzpizza.com (lower case, no scheme), null until set
apex_domain text                     -- mozzpizza.com when custom_domain starts with www., redirects to www
domain_status jsonb not null default '{}'   -- {state:'none'|'pending'|'verified'|'live'|'error',
                                            --  records:[{type,name,value,ok}], ssl:'none'|'pending'|'active',
                                            --  checked_at, error}
status text not null default 'draft' check (status in ('draft','live','offline'))
theme jsonb not null default '{}'    -- section 5
nav jsonb not null default '[]'      -- [{label, page_id|href, kind:'page'|'link'}]
footer jsonb not null default '{}'   -- {text, links:[{label,href}], show_powered_by, instagram, facebook, email, phone}
seo jsonb not null default '{}'      -- {title, description, og_image_url, google_site_verification, locale, keywords[]}
settings jsonb not null default '{}' -- {allow_custom_code:false, custom_head_html:'', nearest_store:true,
                                     --  default_location_id, order_mode:'embed'}
published_version_id uuid            -- fk web_site_versions
published_at timestamptz
created_at, updated_at timestamptz default now()
```

### web_pages
```
id uuid pk
site_id uuid not null references web_sites(id) on delete cascade
slug text not null                   -- '' for home, 'menu', 'order', 'catering', 'loyalty', 'gift-cards',
                                     -- 'find-us', 'blog', 'our-story' ... unique per site
title text not null
kind text not null check (kind in ('home','menu','order','catering','loyalty','gift','findus','blog','location','custom'))
layout jsonb not null default '{"content":[],"root":{"props":{}}}'   -- Puck data, section 6
seo jsonb not null default '{}'      -- {title, description, og_image_url, noindex}
sort_order int not null default 0
status text not null default 'published' check (status in ('draft','published'))
location_id uuid                     -- kind='location' pages: one per platform location
updated_at timestamptz default now()
unique (site_id, slug)
```

### web_posts  (blog)
```
id uuid pk
site_id uuid not null references web_sites(id) on delete cascade
slug text not null
title text not null
excerpt text
body_md text not null default ''     -- Markdown, rendered server and client side with the same renderer
cover_url text
author text
tags text[] default '{}'
status text not null default 'draft' check (status in ('draft','published'))
published_at timestamptz
updated_at timestamptz default now()
unique (site_id, slug)
```

### web_site_versions  (every publish is kept, one press restores)
```
id uuid pk
site_id uuid not null references web_sites(id) on delete cascade
snapshot jsonb not null              -- full published site: {site:{theme,nav,footer,seo,settings,slug,custom_domain},
                                     --  pages:[...], posts:[...], locations:[...], generated_at}
note text
created_by uuid
created_at timestamptz default now()
```

### web_ai_messages  (designer chat per site, so the conversation survives a reload)
```
id uuid pk
site_id uuid not null references web_sites(id) on delete cascade
role text not null check (role in ('user','assistant'))
content text not null
patch jsonb                          -- the site patch the assistant applied, if any
created_at timestamptz default now()
```

### web_assets  (uploads used by the site: photos, og image, favicon)
Files go to Platform Storage bucket `web-assets`, path `<site_id>/<uuid>.<ext>`, public read.
Row: `id, site_id, path, kind ('photo'|'logo'|'og'|'favicon'|'post'), alt text, width, height, created_at`.

### View `web_sites_public`
Anon readable, exposes ONLY live sites: `slug, custom_domain, apex_domain, published_version_id, snapshot`
(join to the published version). Everything else in `web_*` is service role only. RLS: owners read
their own rows through `user_accessible_locations()` joined via `locations.company_id`; writes
only through the edge function (service role). No anon write anywhere.

### Hostname lookup
`web_resolve_host(p_host text)` SECURITY DEFINER, anon granted, returns the public row for
`custom_domain = host` or `apex_domain = host` or `slug = <first label when host ends with .sites.serv-os.app>`.
Used by `api/site.js` and the SPA.

## 3. Hosts and routing

- Free address: `https://<slug>.sites.serv-os.app`. Peter adds ONE DNS record in Vercel DNS:
  `*.sites` CNAME → the possystem project (same as the existing `*` record). Document in the release pack.
- Custom domain: the venue adds `CNAME www → sites.serv-os.app` and `A @ → 76.76.21.21`.
  `website-domain` registers both names on the Vercel project with the Vercel API
  (`POST /v10/projects/{VERCEL_PROJECT_ID}/domains`, secret `VERCEL_TOKEN`), re checks DNS with
  DNS over HTTPS (`https://dns.google/resolve?name=…&type=CNAME`), stores `domain_status`.
  If Vercel asks for a TXT verification record, it is appended to `records` and shown.
- `<slug>.serv-os.app` keeps doing what it does today (online ordering at `/`). Nothing
  existing changes URL. Website hosts are new hosts only.
- `vercel.json` gains, BEFORE the SPA catch all:
  ```
  { "source": "/(.*)", "has": [{ "type": "host", "value": "(?<slug>[a-z0-9-]+)\\.sites\\.serv-os\\.app" }], "destination": "/api/site?path=/$1" }
  { "source": "/(.*)", "has": [{ "type": "host", "value": "^(?!.*(serv-os\\.app|servos\\.app|pos-up\\.com|vercel\\.app|localhost)).*$" }], "destination": "/api/site?path=/$1" }
  ```
  Paths that must NOT be rewritten on website hosts: `/assets/*`, `/api/*`, `/favicon*`, `/.well-known/*`.
  Add `has` free rewrites for those first so they keep hitting static files.
  Since Claude cannot deploy, the SPA keeps a client side fallback: `src/lib/customerUrl.js`
  recognises `.sites.serv-os.app` and unknown hosts, `App.jsx` renders `WebsiteSurface` for them.
  If a rewrite does not fire on Vercel the site still works, only without server HTML.
- Website paths: `/` home, `/<page slug>`, `/blog`, `/blog/<post slug>`, `/locations/<location slug>`,
  `/sitemap.xml`, `/robots.txt`, `/preview?token=…` (draft preview, token issued by website-admin).

## 4. Server rendered site, `api/site.js` (the SEO heart)

Input: host + path. Steps:
1. `web_resolve_host(host)` with the anon key. No row → 404 page with a plain "no site here" message.
2. Pick the page: path → page slug, or blog list, or post, or location page. Unknown → the site's 404.
3. Build HEAD: `<title>`, meta description, canonical (`https://<custom_domain or free host><path>`),
   `og:*` + twitter card, `<link rel=alternate>` none, robots (noindex when status offline or page noindex),
   theme colour, favicon, Google site verification meta when set, preconnect to fonts.
4. JSON-LD, all from the snapshot, never invented:
   - `Restaurant` (or `FoodEstablishment`) per location: name, address, geo, telephone, url,
     `openingHoursSpecification` from opening_hours, `servesCuisine` from settings, `acceptsReservations`
     when bookings on, `hasMenu` → `/menu`, `priceRange`.
   - `Menu` with `hasMenuSection` → `MenuSection` → `hasMenuItem` → `MenuItem` {name, description,
     offers{price,priceCurrency}, suitableForDiet from dietary tags}. Built from the LIVE menu
     (section 7), capped at 300 items.
   - `Organization` + `WebSite` (with `potentialAction` SearchAction omitted, no search).
   - `BreadcrumbList` on sub pages, `BlogPosting` on posts, `FAQPage` when an FAQ block exists.
5. BODY: render every block of the page to semantic HTML with `src/surfaces/website/ssr/renderBlocks.js`
   (plain string templates, shared constants with the React blocks: same class names, same order).
   Real `<h1>` once, `<nav>`, `<main>`, `<footer>`, real text for menu items, prices, hours, addresses.
   Embedded surfaces (ordering, catering, loyalty, gift, booking) render as a labelled `<a href>` card
   plus the iframe tag, so crawlers see a link and humans get the frame.
6. Shell: fetch the deployment's `/index.html` (`https://${req.headers['x-vercel-deployment-url']}/index.html`,
   cached in module scope for 5 minutes) and inject HEAD into `<head>` and BODY into `<div id="root">`,
   plus `<script>window.__SERVOS_SITE__ = {snapshot, path}</script>` so the SPA hydrates without
   a second fetch. Fallback when the fetch fails: a self contained minimal HTML document with the
   same content and a `<script type=module>` pointing at nothing (still indexable).
7. Headers: `Cache-Control: public, s-maxage=60, stale-while-revalidate=600` for live sites,
   `no-store` for previews and offline sites. `/sitemap.xml` and `/robots.txt` served by the same
   function (`Sitemap:` line in robots, `Disallow: /preview`).
8. Custom code: when `settings.allow_custom_code` is true, `custom_head_html` is injected as is,
   AFTER sanitising nothing (owner only switch, their own domain). Default false, never set by the AI.

The SPA side: `WebsiteSurface` reads `window.__SERVOS_SITE__` first, else fetches via
`web_resolve_host`. React replaces the server HTML on mount (not strict hydration; the server
HTML exists for crawlers and first paint). Keep the first paint visually identical by sharing
the class names and the theme CSS variables (section 5).

## 5. Theme contract

A site never carries hard coded colours. `theme` jsonb:
```
{ layout: 'ember'|'ledger'|'marquee',
  type: 'warm-serif'|'clean-sans'|'classic',       -- Fraunces+Hanken, Space Grotesk+Inter, Playfair+Source Sans 3
  buttons: 'pill'|'rounded'|'square',
  mood: 'light'|'dark'|'brand',
  brand_color: null }                              -- null = inherit online_branding.brand_color (default)
```
`src/surfaces/website/theme.js` exports `siteVars(theme, onlineBranding)` → CSS variable object built with
`deriveVars(brandColor)` from `src/surfaces/menu/menuTheme.js` (hue preserving palette) plus:
`--w-bg, --w-card, --w-ink, --w-muted, --w-line, --w-brand, --w-brand-deep, --w-warm, --w-radius, --w-font-display, --w-font-body`.
Logo, display name, hero photo come from `locations.online_branding` of the company's default location
(`settings.default_location_id`, else the first location). The same function is used by the SSR string
renderer (emits a `:root{}` style block) and by React. Rule from Peter: customer screens follow
Appearance branding, never random colours. Dark mood = ink background, paper text, brand accent;
contrast must stay 4.5:1 for body text.

## 6. Blocks (Puck config), the one registry

`src/surfaces/website/blocks/registry.js` exports `BLOCKS`: `{ [type]: { label, group:'servos'|'content',
fields, defaultProps, ssr(props, ctx) → html string, Component } }` and `puckConfig(ctx)` builds the Puck
`config` from it. Puck 0.20 (`@measured/puck`, installed) is used ONLY in Back Office (`<Puck>`); the public
site renders with our own `<BlockRenderer data>` (not Puck's `<Render>`, to keep Puck out of the public
bundle). Puck data shape is kept exactly: `{ root:{props:{}}, content:[{type, props:{id,...}}] }`.

ServOS blocks (live data, group 'servos'):
| type | props | data source |
|---|---|---|
| `Hero` | headline, sub, photo_url (default hero_url), show_status, primary {label,href}, secondary, height 'tall'/'short' | branding + hours |
| `OrderBar` | collection, delivery, book, catering (booleans) | channel flags |
| `LiveMenu` | menu_id or 'follow', categories[] or 'all', layout 'cards'/'list'/'board', show {prices,photos,descriptions,allergens,dietary,hide_sold_out,add_button}, price_mode 'collection'/'dinein'/'delivery', location_id or 'default', max_items | section 7 |
| `Specials` | title, source 'tagged' (items tagged special) or 'manual' ids | menu |
| `OrderEmbed` | mode 'online'/'catering', location_id, height | iframe of `customerUrl(slug, '/')` or `/catering` |
| `LoyaltyJoin` | headline, sub, show_card_preview | loyalty config; the join form is an iframe of `/account/register` or a link, v1 = link card + iframe |
| `GiftCards` | headline, sub, show_art | iframe/link `/gift` and `/gift/balance` |
| `BookTable` | location_id, height | iframe `/book` (already embed ready) |
| `Waitlist` | location_id | link/iframe `/waitlist` |
| `Hours` | location_id or 'all', show_today_first | opening_hours |
| `FindUs` | show_map, show_nearest, show_hours, show_order_buttons | all company locations, section 8 |
| `Reviews` | min_stars 4, count 6 | reviews table via existing public read if any, else hidden (never fails) |
| `BlogList` | count, show_excerpt | web_posts published |

Content blocks (group 'content'): `Text` (markdown), `Columns` (2 or 3, each markdown), `Gallery` (photos[],
cols), `Button` (label, href, style), `FAQ` (items[{q,a}]), `Instagram` (handle, link only), `Divider`, `Spacer`,
`CustomHtml` (only when settings.allow_custom_code).

Every block: never throws. Missing data renders the block's empty state or nothing, never a crash
(customer facing never fails). Every `href` goes through `resolveHref(ctx, href)`: `page:<id>` → site path,
`servos:order|catering|loyalty|gift|book|waitlist` → `customerUrl(ctx.location.online_slug, path)`, else as is.

## 7. Live menu data

The site reads the Ops DB exactly like `OnlineSurface.jsx` (anon RLS already allows it): `menu_items`,
`menu_categories`, `menu_category_links`, `menus`, `eighty_six`, plus `resolveActiveMenu` for timed menus,
`resolveItemPrice` for the price mode, `dietaryBadges` for V VG GF, `allergens` text[] for allergen words,
image via `product-images` public URL. Shared loader `src/surfaces/website/data/loadMenu.js` returns
`{ categories:[{id,label,items:[{id,name,description,price,currency,image,dietary[],allergens[],sold_out}]}] }`
and is used by React AND by `api/site.js` (Node, service or anon key, same RLS). Sold out = in `eighty_six`
or stock 0: hidden when `hide_sold_out`, else greyed with "Sold out today". Realtime refresh in the browser
reuses the `online-86:<loc>` channel pattern. Multi location: `LiveMenu.location_id` picks which venue's
menu; default is `settings.default_location_id`.

## 8. Find us and nearest store

`FindUs` lists every platform location of the company that has `online_slug` (name, address, phone,
opening hours with today first, open/closed now in the venue's timezone, Order here → that venue's ordering,
Directions → Google Maps link, Book when bookings on). Coordinates: `locations.lat/lng` if present, else
geocode once in `website-admin` action `geocode_locations` (Nominatim, cached on the row in `web_sites.settings.geo[location_id]`,
never at request time). "Nearest shop": browser geolocation (ask on tap, never on load), Haversine in the
client, sorts the cards and sets the order button's default venue. Server HTML lists all locations in
sort order (crawlers see every address). Location pages `/locations/<slug>` exist for local SEO: one
`kind='location'` page per location, generated by the designer, with Hero (location name), Hours, FindUs
(that location only), LiveMenu (that location), OrderEmbed.

## 9. Back Office UI (`src/backoffice/sections/website/`)

Appearance (`MenuAppearance.jsx`) gets a fifth SECTIONS entry `['website', '🌐', 'Website builder']` that
renders `<WebsiteBuilder/>` (lazy). WebsiteBuilder has internal views, mirroring the prototype:
1. **Overview**: site status card (domain, SSL, published when), Pages list with status, "Connected to your
   ServOS" switches (these toggle `settings.channels.<x>`, which hides the matching blocks and nav items
   everywhere), Site health checklist (domain, SSL, phone layout, Google listing, share image, missing photos),
   buttons: Open AI designer, Edit pages, Branding and domain, View live site. First visit with no site:
   a single big card "Build me a website" → designer with the brief prefilled from ServOS facts.
2. **Designer**: chat left (messages from `web_ai_messages`), suggestions chips, input; right: three layout
   cards (Ember, Ledger, Marquee) with the mini wireframes, chosen one highlighted; "Build my site".
   After a build: the right side becomes a live preview (BlockRenderer in an iframe sized device).
3. **Editor**: Puck. Left palette grouped ServOS / Content; page tabs across the top with Add page;
   Desktop / Phone toggle (iframe width); Undo (Puck history); Ask designer (opens designer with the page
   in context); Preview (opens `/preview?token`); Publish (creates a version, sets published_version_id,
   status live). Autosave drafts every 3 s after a change via `save_page`.
4. **Branding and domain**: branding synced panel (read only here, link to Brand basics), type pairing,
   buttons, mood; domain card with free address, custom domain input, Check button, records table with
   copy buttons, SSL row, numbered steps, "Email these steps" (mailto); Search and sharing (seo fields,
   og image upload, Google verification code, Instagram handle); Publish card (live/offline, draft changes,
   History list with Restore).
5. **Blog**: posts list, editor (title, slug, excerpt, cover upload, markdown body with preview, tags,
   publish/unpublish), "Write it for me" → designer with the post in context.

Style: existing BO tokens only (`var(--bg1)`, `var(--acc)`, `.sv-tile`, radius 14/16, Space Grotesk).
Puck's CSS is scoped inside the editor view; override its theme variables to match the BO skin.
All writes go through `src/lib/websiteAdmin.js` → `website-admin` edge function. Reads of the owner's
own site rows can use the platform client under RLS.

## 10. `website-admin` edge function (Deno)

Fence, in this order, copied from `location-admin`: real signed in user (no anon), caller has
`user_locations` access to at least one location of the company (or super_admin), company id derived
SERVER side from the caller's locations, never trusted from the body. Actions:
```
get_site            {} → site + pages + posts (creates the draft web_sites row with slug from the company slug
                        or display name when none exists)
save_site           {patch:{theme,nav,footer,seo,settings,slug}}  whitelisted keys, slug validated + reserved list
save_page           {page_id|null, patch:{slug,title,kind,layout,seo,sort_order,status,location_id}}
delete_page         {page_id}
reorder_pages       {ids[]}
save_post / delete_post
publish             {note} → snapshot built server side (section 2), version row, published_version_id, status live
unpublish           {} → status offline
restore_version     {version_id} → republish that snapshot as a new version
preview_token       {} → signed token (HMAC with WEBSITE_PREVIEW_SECRET, 30 min) for /preview
upload_url          {kind, ext} → signed upload URL into web-assets
apply_ai_patch      {patch, message_id} → validates the patch against the block registry schema, applies
geocode_locations   {} → section 8
```
Limits: layout ≤ 400 KB, ≤ 60 pages, ≤ 500 posts, strings ≤ 20 KB, slugs `[a-z0-9-]{1,60}`.
Reserved site slugs: www, app, api, admin, sites, order, cater, dev, stage, test, servos, serv-os.
Every refused write returns 400 with a plain reason, never a silent drop.

## 11. AI designer, `api/website-designer.js` (Node, Vercel)

Auth: bearer Supabase user token verified with the Ops project (same as `api/ai.js`), then the same
company fence as website-admin (call a Platform RPC `web_company_for_user(uid)` or query user_locations).
Input: `{site_id, message, mode:'build'|'chat'|'post', page_id?, layout?}`. The function assembles the
VENUE FACTS itself (never from the client): company name, locations (name, address, hours, timezone,
currency), online_branding (brand colour, logo, display name, hero), channel flags (online, catering,
loyalty type stamps/points, gift, bookings, waitlist), menu summary (categories with 5 item names each,
counts, photo coverage), existing site snapshot and the last 20 chat messages.
Model: `claude-opus-5-5` (env `WEBSITE_DESIGNER_MODEL` overrides), temperature default, max_tokens 16000,
tool use with ONE tool `apply_site_patch` whose JSON schema is generated from the block registry
(`src/surfaces/website/blocks/schema.js`, shared with the validator). The patch shape:
```
{ reply: string,                               -- what the designer says, short, plain English
  theme?: {...}, nav?: [...], footer?: {...}, seo?: {...},
  pages?: [{ slug, title, kind, seo, layout }], -- full replacement of the named pages
  delete_pages?: [slug], posts?: [{slug,title,excerpt,body_md,tags}] }
```
Rules in the system prompt: use only block types in the schema; every ServOS block must be present
where the channel is on (menu, order, loyalty, gift, catering, bookings) unless the user said no; never
write prices, hours or menu items as text (they are live blocks); write real copy from the venue facts,
no lorem, no invented awards or years; SEO title ≤ 60 chars with the town, description ≤ 155 chars with
cuisine + town + "order online"; one `Hero` per page; location pages for every location; blog gets
2 starter posts in `build` mode marked draft; honour `theme` the user picked; keep what the user already
edited unless asked to change it (patch only the pages named in the message).
The function validates the patch with the shared validator, saves the message pair to `web_ai_messages`
and applies it via the same code path as `apply_ai_patch` (call the edge function with the service role,
or duplicate the validator in Node and write directly with the Platform service role key: choose direct
write, same validator module). Response: `{reply, applied:true, pages_changed:[...]}`.
"Build me a website" with no brief: `mode:'build'`, the designer picks `ember` when photo coverage ≥ 60 %,
`ledger` otherwise, says why in the reply, and builds home, menu, order, catering (if on), loyalty (if on),
gift cards (if on), find us, one page per location, blog with 2 draft posts, our story (draft).

## 12. File ownership (agents never edit outside their list)

- **A. Data + admin + domain** (`supabase/migrations/20261031_PLATFORM_website_builder.sql`,
  `supabase/functions/website-admin/**`, `supabase/functions/website-domain/**`,
  `supabase/functions/_shared/website*.ts`, `src/lib/websiteAdmin.js`, `src/lib/website/validatePatch.js`,
  `src/lib/website/*.test.js`, `docs/website-builder/RELEASE.md` sections for SQL, secrets, DNS)
- **B. Public site + SEO** (`src/surfaces/website/**`, `api/site.js`, `api/_lib/website/**`,
  `src/lib/customerUrl.js` (additive: `.sites.` + unknown host → `{mode:'website', host}`),
  `src/App.jsx` (one added branch before the customer modes), `vercel.json` rewrites, `src/surfaces/website/*.test.js`)
  Note B owns the block registry `src/surfaces/website/blocks/**` and `schema.js`; A and D import from it.
- **C. Back Office UI** (`src/backoffice/sections/website/**`, the one SECTIONS line in `MenuAppearance.jsx`,
  `src/backoffice/sections/website/*.test.js`)
- **D. AI designer** (`api/website-designer.js`, `api/_lib/website/designerPrompt.js`,
  `api/_lib/website/venueFacts.js`, `src/backoffice/sections/website/designer/**` (chat UI only; C mounts it),
  tests beside them)
- **Me (orchestrator)**: `src/lib/version.js`, `src/lib/changelog.js`, `docs/website-builder/*`, `package.json`.

Shared imports allowed: `src/surfaces/menu/menuTheme.js`, `src/lib/menuPricing.js`, `src/lib/dietary.js`,
`src/lib/env.js` (`customerUrl`), `src/lib/menus/resolveActiveMenu.js`, `src/lib/supabase.js`.
Node code under `api/` cannot import JSX; B keeps `blocks/registry.js`, `ssr/renderBlocks.js`, `theme.js`,
`data/loadMenu.js` as plain `.js` (no JSX) so `api/site.js` can import them; React components live in
`blocks/components/*.jsx` and are referenced from the registry by lazy import on the browser side only.

## 13. Tests and proof

`npm test` runs `node --test "src/**/*.test.js"`. Every agent adds tests beside its code; `api/**` tests
live in `src/lib/website/api.*.test.js` importing from `../../..` (no JSX). Minimum:
- A: validator accepts the designer sample patch, refuses unknown block types, bad slugs, oversized layouts;
  publish snapshot shape; reserved slugs; domain record builder; DNS answer parser.
- B: host parsing (`mozz.sites.serv-os.app`, `www.mozzpizza.com`, `mozz.serv-os.app` stays ordering);
  `renderBlocks` produces an `<h1>` once, menu items with prices, JSON-LD validates (`JSON.parse`, `@type`s);
  sitemap and robots; `resolveHref`; `siteVars` contrast ≥ 4.5 for every mood; empty data never throws.
- C: pure helpers (page ordering, health checklist, draft diff) and that the SECTIONS list has 5 entries.
- D: prompt assembly never leaks another company's facts; patch applied through the validator; build mode
  picks the layout by photo coverage.
`npm run build` must pass (gate on exit code, never grep output). Version bump to 5.12.0 on the branch,
changelog entry. No secrets in the repo. No Firebase. No new dependency besides `@measured/puck`.

## 14. Release pack (for Peter, written by A and me)

`docs/website-builder/RELEASE.md`: 1 run the SQL in the Platform SQL editor; 2 secrets to set
(`VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `WEBSITE_PREVIEW_SECRET` on Supabase; `PLATFORM_SUPABASE_URL` +
service key already there; Vercel already has `ANTHROPIC_API_KEY`, add `PLATFORM_SUPABASE_URL`,
`PLATFORM_SUPABASE_ANON_KEY`, `PLATFORM_SUPABASE_SERVICE_ROLE_KEY` if missing); 3 Vercel DNS: `*.sites` CNAME;
4 deploy functions `website-admin`, `website-domain`; 5 create bucket `web-assets` (public read);
6 proof: open `mozz.sites.serv-os.app`, curl it and see `<h1>` and JSON-LD in the raw HTML.
