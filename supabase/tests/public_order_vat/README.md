# Offline proof of 20261009a (the server books the VAT of a public order itself)

`run.mjs` applies `supabase/migrations/20261009a_OPS_public_order_vat_server.sql` to a **local,
throwaway PostgreSQL 17** that carries the live shape of the tables the file touches and the
**real text of the two functions it replaces**, then re derives live sales through it. It never
connects to Supabase.

```sh
node supabase/tests/public_order_vat/run.mjs
```

It starts its own cluster in a temp folder (`initdb` and `pg_ctl` from PATH or `/opt/homebrew/bin`,
`psql` the same) and stops it at the end. `VAT_PGHOST` / `VAT_PGPORT` point it at a running local
server instead (a socket folder works as the host). Exit code 0 only when every check holds.

## What is in here

- `live/*.sql`: `pg_get_functiondef` of `_public_order_check_row` (as 20261002b left it),
  `settle_qr_tab` (as 20260927c left it), `_fence_num` and `_fence_bool`, read from the Ops
  database on 8 Oct 2026 with the read only Management API. The migration's guard refuses to run
  unless the live function bodies have exactly these md5s (`767b8354…` and `6a335ccf…`); the
  harness proves these texts install with those md5s, so the guard constants are right.
- `schema.sql`: the tables (`locations`, `tax_rates`, `tax_profiles`, `menu_categories`,
  `menu_items`, `closed_checks`, `order_queue`, `payment_proofs`) with the live column types the
  functions read or write, `auth.uid()` as a session variable, and stubs of the helpers
  `settle_qr_tab` calls that are not under test (`_qr_tab_is_member`, `pos_can_access`,
  `is_super_admin`, a reduced `_public_order_value` that values the rounds at the prices they carry).
- `fixtures/tax_rates.json`: every live tax rate (32 rows, 11 venues).
- `fixtures/menu_items.json`: the live menu rows the sales below name, and their parents (318 rows:
  id, venue, parent, tax rate, overrides).
- `fixtures/qr14.json`: the 14 QR sales of the VAT audit (the lines, the order type, the stored VAT).
- `fixtures/till200.json`: 200 till sales of 1 to 8 Oct 2026 from the five Coffee Boy venues
  (lines, discounts, the stored VAT and the stored share). No customer data, no tenders.

## What it proves (D8)

1. Both live function texts install with the md5s the guard expects.
2. The migration applies the way the SQL editor runs a paste (one transaction, stop on error), its
   self test block included; its visible check answers true; it runs a second time (its own version
   passes the guard).
3. The 14 QR sales re derive through `_public_order_vat`: 13 to their stored penny (QR-4OGI7 among
   them, which the owner had corrected to 0.81 by the time this was written), and QR-186RY (5.85)
   to 0.98 where 0.97 was stored: a half penny the 2 Oct backfill rounded down; the one rounding
   rule (half up) gives 0.98, as the page now sends.
4. The 200 till sales re derive from their lines, each venue's menu rows and rates, with the
   share of the goods charged (the till's rule: item and check discounts off, loyalty and promo
   credits not): 183 to the penny, 17 one penny above. Every one of the 17 sits on a half penny
   that the till of those days stored as a float rounded down (`1.6749999999999998` became 1.67);
   under the one rule it is 1.68, which is what the till books since Lane A. None is further off,
   none is below. Till lines carry their modifiers inside `price`, order queue lines keep them
   apart; the harness passes the till lines without mods for that reason.
5. `settle_qr_tab` end to end: a tab with no figure from the phone books the server's VAT and says
   so (`booked: 'server'`, `reason: 'page-sent-none'`); a phone figure within 1p is kept
   (`booked: 'page'`) with the server's split by rate behind it; a figure of 0 is replaced and
   flagged (`page-differs`); a round with an automatic deal books the VAT on what was charged
   (share 0.5); closing a closed tab again writes nothing.
6. The ROLLBACK file puts both functions back byte for byte (the live md5s again), drops the four
   helpers, and the migration applies again after it.

8 Oct 2026: all checks passing (183 of 200 till sales exact, 17 half pennies, 0 misses).
