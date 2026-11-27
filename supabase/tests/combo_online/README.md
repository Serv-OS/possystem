# Combo online: SQL 20261217a (5.12.125)

`supabase/migrations/20261217a_OPS_public_order_combo_steps.sql` teaches the server's own line pricer,
`public._public_order_value`, to read a Combo built from steps, so a guest who builds one on the
online page or the catering link pays exactly what the page asked, and a doctored page never gets a
product for less. It also adds `public.public_order_features()` ({"combo_steps": true}), which the
pages ask before they offer such a Combo.

## Where the live text came from

Read read only from the Ops database (tbetcegmszzotrwdtqhi) on 27 Nov 2026:

| function | md5 of the live body | the same text in the repo |
|---|---|---|
| `_public_order_value` | `db3790dba28aaef13a346a11d0a59a36` | `20261020a_OPS_channel_parity_2.sql` |
| `_menu_item_floor_minor` | `40df516419cf02063b7bb36fe46c4a93` | `20260919a1_OPS_fence_identity_devices.sql` |
| `_menu_item_has_price` | `a994a37727388ce984ec7579f17829ec` | `20261020a_OPS_channel_parity_2.sql` |
| `_menu_channel_key` | `ebee263bf174b5b28ba7e09b0e1dcc66` | `20260919a1_OPS_fence_identity_devices.sql` |
| `place_public_order` | `85ccee3f5a5eb7dc59d2566c199078f7` | `20261020a` (not changed by 20261217a) |

So the generator works from the repo copy, and the file refuses unless the live body is still that
one (or its own result).

## Make it again

```
python3 supabase/tests/combo_online/gen_20261217a.py
```

It swaps exact pieces of the live body (each must be there exactly once, and they reverse back to
the live text) and writes the forward file and the ROLLBACK.

## Rehearse it

```
node supabase/tests/combo_online/run.mjs
```

A throwaway local PostgreSQL (initdb and pg_ctl from PATH or /opt/homebrew/bin), never Supabase. 47
checks: the gap before the file, the file twice, a basket built by the page's own code
(`src/lib/online/comboCart.js`) valued to the penny, doctored baskets (too many picks, a product a
step does not list, "each only once", a fake Combo, a second Combo line, odd words), an order with
no Combo valued exactly as the live function values it (15 baskets, 3 order types), and the roll
back byte for byte, twice.

## Order for Peter

1. 20261215a (stage 1): RUN on 27 Nov 2026.
2. This file, on Ops. The check row at the end reads true, true, true.
3. Deploy the edge function `catering-release` (from release 5.12.125).
4. Launch 5.12.125.
