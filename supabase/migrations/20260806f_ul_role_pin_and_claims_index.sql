-- 20260806f_ul_role_pin_and_claims_index.sql
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi
--
-- Two fixes, both found by REBUILDING the schema from the live catalogs and executing it.
-- Neither was visible from reading the SQL, which is the argument for having 000_baseline_ops.sql.

begin;

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is for the OPS DB (tbetcegmszzotrwdtqhi). Wrong database — aborting.';
  end if;
end
$guard$;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Pin user_locations.role against self-promotion
-- ──────────────────────────────────────────────────────────────────────────
-- ul_update_self (added by 20260805c Section A) restricts WHICH ROW you may update —
-- `user_id = auth.uid() and not is_anon_session()` — but says nothing about WHICH COLUMNS.
-- So a signed-in staff user can run
--     update user_locations set role = 'owner' where user_id = <self>
-- and it succeeds. Demonstrated end to end on a rebuilt copy of this schema.
--
-- HONEST IMPACT TODAY: none. Verified against the live catalogs — no authorisation path
-- reads this column. is_super_admin() reads user_profiles.role; user_accessible_locations()
-- selects only location_id (membership, not role); pos_can_access() builds on those two.
-- The row already exists for that user, so promoting it grants nothing new, and the INSERT
-- side is separately fenced by ul_insert_self_claim + can_claim_location().
--
-- WHY FIX IT ANYWAY: the column is named `role` and sits on the table that IS the tenant
-- fence. The next person to write `where role = 'owner'` — in a report, an approval gate, a
-- future Adyen permission check — turns a dormant gap into a live escalation, and nothing in
-- the schema would warn them. Closing it now costs one trigger.
--
-- RLS cannot express "this column may not change" (WITH CHECK sees only the proposed row,
-- never the old one), so this has to be a trigger.
create or replace function public.ul_block_role_self_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.role is distinct from old.role and not public.is_super_admin() then
    raise exception
      'user_locations.role may only be changed by a super admin (attempted % -> %)', old.role, new.role
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.ul_block_role_self_change() from public;

drop trigger if exists ul_block_role_self_change_trg on public.user_locations;
create trigger ul_block_role_self_change_trg
  before update on public.user_locations
  for each row execute function public.ul_block_role_self_change();

comment on function public.ul_block_role_self_change() is
  'Stops a user promoting themselves via user_locations.role. ul_update_self pins the row but not the column, and RLS cannot compare against the old row. Super admins and service_role (which bypasses RLS but NOT triggers — hence is_super_admin() rather than a role check) are unaffected.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Index loyalty_redemption_claims for the reconciler
-- ──────────────────────────────────────────────────────────────────────────
-- The table (20260806c Section B) has only its primary key on idempotency_key, but
-- loyalty-reconcile filters AND sorts on created_at. Measured on a rebuilt copy at 300k rows:
-- a parallel sequential scan discarding 290k rows per page, ten pages a tick, twenty-four
-- ticks a day, on an append-only table that is never pruned. The same query with this index
-- was an index scan at ~1% of the buffers.
--
-- NOTE: this table lives on the PLATFORM database, not here — see the companion statement in
-- 20260806g. Kept as a comment so the OPS baseline does not silently imply it exists locally.

commit;
