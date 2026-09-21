-- ═══════════════════════════════════════════════════════════════════════════
-- OWNERS HOLD THEIR OWN COMPANY. 21 Sep 2026. OPS (tbetcegmszzotrwdtqhi).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE FAULT, in one line: since the fence (20260919a1) access means a row in
-- user_locations and nothing else, so a venue added today cannot be reached by
-- the person who owns it until somebody writes that row by hand.
--
--   user_accessible_locations() = user_locations rows + every venue if super admin
--   the profile guard           = "You can only switch to a venue you are linked to"
--   provisioning                = writes ONE link row, for the venue of the day
--
-- That is why Coffee Boy Barnsley Train Station refuses to save (Peter, 21 Sep:
-- one link row in the whole system), and why it would have refused at every one
-- of the twenty venues going in this week. It is not twenty errors to capture,
-- it is one rule that stopped matching how venues are created.
--
-- THIS FILE ONLY EVER ADDS ACCESS. Nothing that works today can start failing:
-- every arm is a UNION onto the existing rule, and the backfill only writes the
-- venue a login was already pointed at. Safe to run during service.
--
-- WHY TRUSTING role AND org_id IS SAFE HERE (both were holes once):
--   * role   cannot be changed by its own login  (20260915c user_profiles_role_guard)
--   * org_id can only be set to an org you already reach (20260919a1 fence guard)
-- So "owner of org X" cannot be self awarded by anyone not already inside X.

-- ── 0. What is live right now, before anything changes ────────────────────
select 'BEFORE' as stage,
       pg_get_functiondef('public.user_accessible_locations()'::regprocedure) as rule;

-- ── 1. Backfill: the venue every login was already pointed at ─────────────
-- Before the fence, user_profiles.location_id WAS access. The fence removed that
-- arm and nobody wrote the rows it had been standing in for, so staff who were
-- only ever given a profile venue have been refused everywhere since.
insert into public.user_locations (user_id, location_id, role)
select p.id,
       p.location_id,
       case when p.role in ('owner', 'manager', 'staff') then p.role else 'manager' end
  from public.user_profiles p
 where p.location_id is not null
   and exists (select 1 from public.locations l where l.id = p.location_id)
   and not exists (select 1 from public.user_locations ul
                    where ul.user_id = p.id and ul.location_id = p.location_id);

-- ── 2. The rule: an owner holds every venue in their organisation ─────────
create or replace function public.user_accessible_locations()
returns setof text
language sql
stable
security definer
set search_path = public
as $fn$
  select ul.location_id::text
    from public.user_locations ul
   where ul.user_id = auth.uid()
     and not public.is_anon_session()
  union
  select l.id::text
    from public.locations l
   where public.is_super_admin()
  union
  -- NEW 21 Sep 2026: the owner of an organisation holds every venue in it the
  -- moment it is created. No link row, no hand holding, no silent refusal.
  select l.id::text
    from public.locations l
    join public.user_profiles p on p.id = auth.uid()
   where not public.is_anon_session()
     and p.role = 'owner'
     and p.org_id is not null
     and l.org_id = p.org_id;
$fn$;

comment on function public.user_accessible_locations() is
  '20260921: user_locations, every venue for a super admin, and every venue of their own organisation for an owner. user_profiles.location_id is the venue Back Office opens on, never access.';

-- ── 3. The switcher: let an owner switch to a venue the rule already allows ─
-- Without this the rule says yes while the trigger still says no, which is the
-- worst of both: the venue is listed, and switching to it fails.
-- Byte for byte the 20260919a1 guard, with ONE branch changed (marked below).
create or replace function public.user_profiles_fence_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if public._fence_api_role() not in ('authenticated', 'anon') or public._fence_bypass() then
    return new;
  end if;
  if public.is_super_admin() then
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'A profile id cannot change' using errcode = '42501';
  end if;
  if v_uid is null or old.id <> v_uid then
    -- A manager switching a teammate's Back Office access: that column only.
    if new.org_id is distinct from old.org_id or new.location_id is distinct from old.location_id
       or new.full_name is distinct from old.full_name or new.email is distinct from old.email
       or new.role is distinct from old.role then
      raise exception 'You can only switch Back Office access for a team member' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Own row.
  if new.bo_access is distinct from old.bo_access then
    raise exception 'Back Office access is switched by the venue owner or a manager' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'Your email is changed through your login, not here' using errcode = '42501';
  end if;
  if new.org_id is distinct from old.org_id then
    if old.org_id is not null or new.org_id is null
       or not (public._org_created_by_me(new.org_id) or new.org_id::text in (select public.user_accessible_orgs())) then
      raise exception 'Only the platform can change which company a login belongs to' using errcode = '42501';
    end if;
  end if;
  if new.location_id is distinct from old.location_id and new.location_id is not null then
    -- CHANGED 21 Sep 2026: one rule decides this, the same one every policy uses,
    -- so an owner's own venues are never refused here while the policies allow them.
    if new.location_id::text not in (select public.user_accessible_locations())
       and not exists (select 1 from public.locations l
                        where l.id = new.location_id and l.created_by = v_uid) then
      raise exception 'You can only switch to a venue you are linked to' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.user_profiles_fence_guard() from public, anon, authenticated;

-- ── 4. The report: who can actually write where, now ──────────────────────
-- Read the zeros. Anybody on 0 gets the red bar at every screen they touch.
select u.email,
       p.role,
       (select l.name from public.locations l where l.id = p.location_id) as opens_on,
       (select count(*) from public.user_locations ul where ul.user_id = p.id) as link_rows,
       case
         when p.role = 'super_admin' then (select count(*) from public.locations)
         when p.role = 'owner' and p.org_id is not null then
           (select count(distinct l.id) from public.locations l
             where l.org_id = p.org_id
                or l.id in (select ul.location_id from public.user_locations ul where ul.user_id = p.id))
         else (select count(*) from public.user_locations ul where ul.user_id = p.id)
       end as can_write_at
  from public.user_profiles p
  join auth.users u on u.id = p.id
 order by can_write_at, u.email;
