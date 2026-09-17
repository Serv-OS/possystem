-- 20260917_OPS_ezcater_api_url.sql
--
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
-- Claude cannot apply production DDL by any route.
--
-- Idempotent: add column if not exists, and a comment that is simply replaced.
-- Safe to run twice.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THIS COLUMN EXISTS
-- ────────────────────────────────────────────────────────────────────────────
-- ezCater publish exactly ONE address in their docs,
-- https://api.ezcater.com/graphql, and no sandbox address at all. An owner with
-- a sandbox account is given theirs by ezCater in an email, so the only way we
-- can know it is for the operator to paste it into Back Office, Channels, 3rd
-- Party orders. It is stored per connection here.
--
-- NULL MEANS THE LIVE API. Every connection made before this file runs keeps
-- behaving exactly as it did: supabase/functions/_shared/ezcater.ts still
-- defaults to EZCATER_API, and resolveEzcaterApi(null) returns it.
--
-- https ONLY, enforced in the edge function rather than here, because a check
-- constraint on this column would reject nothing an operator can see. The API
-- token travels in a header on every call, so a plain http address would put it
-- on the wire in clear. The value is refused in the browser (validateApiUrl in
-- src/lib/ezcaterSettings.js) and again in ezcater-connect before it is stored.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE APP AND BOTH FUNCTIONS WORK BEFORE THIS FILE RUNS
-- ────────────────────────────────────────────────────────────────────────────
-- Naming a column that does not exist fails the WHOLE statement, which is the
-- same trap as menu_items.item_code on the item matching screen. So:
--
--   supabase/functions/ezcater-webhook  reads id, api_token, api_url and asks
--                                       again without api_url if that is why
--                                       the select failed (readConnection)
--   supabase/functions/ezcater-connect  names api_url in the insert ONLY when
--                                       the operator actually typed an address,
--                                       and says which file to run when the
--                                       column is not there (isAbsentColumn).
--                                       connectionForLocation selects *, so it
--                                       never names the column at all
--   src/backoffice/sections/EzcaterSettings.jsx  shows Live when api_url comes
--                                       back null or undefined, which is what
--                                       an un-migrated database gives it
--
-- So before this runs: connecting with an empty API address works and is live,
-- and connecting WITH a sandbox address is refused in plain words naming this
-- file. Nothing silently points a sandbox token at the live API.

begin;

alter table public.ezcater_connections
  add column if not exists api_url text;

comment on column public.ezcater_connections.api_url is
  'ezCater GraphQL endpoint for this connection. NULL means the live API, https://api.ezcater.com/graphql. Set only for a sandbox account, from the address ezCater gave the owner. https only, enforced in ezcater-connect.';

commit;
