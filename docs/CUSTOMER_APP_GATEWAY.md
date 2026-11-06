# Customer app gateway (edge function `customer-app`)

6 Nov 2026. One thin, additive edge function for the native customer app (one Expo app themed
per tenant, its own repository). It adds the four things the web loyalty portal never needed and
changes nothing that exists: `loyalty-otp`, its session token and every table it reads are
untouched. The app still calls `loyalty-otp` itself for `send`, `verify`, `refresh` and
`update_profile`, with the access token this function mints.

- **URL** `https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/customer-app`
- **Call** `POST { action, ... }` with the public (anon) key as `apikey` and `Authorization: Bearer <anon key>`, exactly like `loyalty-otp`. Deployed with `--no-verify-jwt`.
- **Source** `supabase/functions/customer-app/index.ts`; the pure rules in `supabase/functions/_shared/customerAppRules.js` (re-exported as `src/lib/customerAppRules.js`, tested by `src/lib/customerAppRules.test.js` and `src/lib/customerAppWiring.test.js`).
- **SQL** `supabase/migrations/20261126a_OPS_customer_app.sql` (Ops: two tables, one trigger, the delete function) and `supabase/migrations/20261126b_PLATFORM_customer_app.sql` (Platform: the end loyalty function). Each has a `_ROLLBACK.sql` twin. Offline proof: `supabase/tests/customer_app/test_customer_app.py` against a local Postgres 17.
- **Deploy** `npx supabase functions deploy customer-app --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt`

## Rules that keep it safe

- **No customer id from the body.** Every member action derives the customer from a verified loyalty-otp session token, or from the row a refresh token hashes to. The wiring test pins this.
- **Refresh tokens are never stored.** Only the sha256 hex is kept. A reused old token (one that was already rotated) revokes the whole family: every device signed in from that chain signs in again with a code.
- **Service role only.** Both tables have row level security on with no policy and are revoked from `anon` and `authenticated`; both SQL functions are `security definer`, `search_path = public, pg_temp`, execute granted to `service_role` only.
- **The access token is a real loyalty-otp token.** Same `_shared/loyalty-session.ts`, same `OTP_HMAC_SECRET`, same 24 hours, carrying the phone the customer row holds. Every existing `loyalty-otp` action accepts it.
- **The theme is checked on the way out** against `_shared/tenantAppSchema.json` (a copy of the app's `schemas/tenant.schema.json`). A row that does not match answers 500 `theme_invalid` and never reaches a phone.

## Actions

Errors are `{ error, code? }`: 400 bad request, 401 sign in again, 404 no such tenant or theme,
409 `not_ready` (a database update has not run; the file is named), 429 too soon, 500 a database
refusal or an invalid theme row.

### Sessions

| Action | Request | Response |
| --- | --- | --- |
| `session_start` | `{ action: "session_start", token, device? }` where `token` is a live loyalty-otp session token (just issued by `verify`) and `device` is up to eight short strings (`platform`, `os`, `osVersion`, `model`, `appVersion`, `build`, `locale`, `installId`) | `{ refreshToken, refreshExpiresAt }` (180 days) |
| `session_refresh` | `{ action: "session_refresh", refreshToken }` | `{ accessToken, refreshToken, expiresIn: 86400, refreshExpiresAt }`. The old refresh token is dead; keep the new one. 401 `reused` (family revoked), `revoked`, `expired`, `not_found`, `sign_in_again`; 429 `too_soon` (one refresh per row per 5 seconds) |
| `session_end` | `{ action: "session_end", refreshToken }` | `{ ended: true }` always |

### Delete my account

| Action | Request | Response |
| --- | --- | --- |
| `delete_account` | `{ action: "delete_account", token, confirm: "DELETE" }` | the report below. 400 `confirm_required` without the word. The old loyalty-otp token then finds no customer (`refresh` answers 401 `sign_in_again`). |

```json
{
  "ok": true,
  "customerId": "uuid",
  "alreadyDeleted": false,
  "personal": { "customersUpdated": 1, "columnsCleared": ["name", "email", "phone", "..."], "venueNotesCleared": 1 },
  "sessionsRevoked": 2,
  "loyalty": { "membershipsEnded": 1, "pointsForfeited": 450, "stampCardsEnded": 1, "stampsForfeited": 7, "referralsUnlinked": 0 },
  "kept": ["closed_checks", "customer_orders", "loyalty_transactions", "stamp_transactions", "gift_cards", "gift_card_transactions"]
}
```

What it does (Peter, 18 Sep 2026): the personal fields on `customers` are cleared (`name` becomes
`Deleted customer` because the column is NOT NULL; email, phone, birthday, notes, marketing and
every other personal column the table has), `deleted_at` is set, the staff notes about the person
at each venue go, every app session is revoked; the Platform membership (`customer_loyalty`) and
stamp card progress (`customer_stamp_cards`) are deleted. Closed checks, orders, the loyalty and
stamp ledgers, gift cards and their transactions are not touched. Platform first, Ops second;
both halves are no ops on a second run, so pressing Delete again finishes the job.

### Public (no token)

| Action | Request | Response |
| --- | --- | --- |
| `tenant` | `{ action: "tenant", tenantId }` | `{ tenantId, orgId, companyId, displayName }`. `companyId` is what `loyalty-otp` wants as `company_id` (the Platform company the organisation's venues are linked to). `Cache-Control: public, max-age=60` |
| `venues` | `{ action: "venues", tenantId }` | `{ tenantId, venues: [ { id, name, addressLines, phone, openingHours, timezone, currency, status, latitude, longitude, orderingUrl } ] }`. Live, non demo venues of the organisation only, by name. `status` is `open`, `closed` or `unknown` on the venue clock. `orderingUrl` is `https://<slug>.serv-os.app/` when web ordering is on, else null. `id` is the Ops location id. |
| `theme` | `{ action: "theme", tenantId }` | the `tenant_app_config` payload with `tenantId` and `version` from the row (`version` goes up on every payload change). 404 `{ code: "no_theme" }` with no row. `Cache-Control: public, max-age=60` |

`tenantId` must match `^[a-z][a-z0-9-]{1,31}$` (400 `bad_tenant` otherwise); an unknown one is 404 `no_tenant`.

## Tables (Ops)

- `customer_app_sessions` (id, customer_id, company_id, family_id, refresh_token_hash unique, device jsonb, created_at, last_used_at, expires_at default now() + 180 days, revoked_at, replaced_by)
- `tenant_app_config` (tenant_id text primary key, org_id references organisations, payload jsonb, version int default 1, created_at, updated_at); trigger `trg_tenant_app_config_bump` bumps `version` on every payload change and owns the number.

The first tenant is inserted by hand; the example insert is a comment at the end of the Ops file.
