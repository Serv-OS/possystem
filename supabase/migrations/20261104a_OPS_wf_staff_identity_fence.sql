-- 20261104a_OPS_wf_staff_identity_fence.sql
-- Release 5.11.104, Workforce: who a staff record IS can no longer be changed by any Back Office login.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. It refuses a second run. #
-- #  Lock wait 3 s (it gives up, nothing changes). Run after UK close.        #
-- #  NEVER on 1 Nov 2026 (US clocks).                                         #
-- ############################################################################
--
-- THE GAP (found by the 5.11.102 review, true since the staff app shipped on 6 Aug 2026)
--   wf_staff has two identity columns: portal_user_id (the staff app login behind the record) and
--   pos_user_id (the till user behind it: the Manager app PIN, clock punches, sales attribution,
--   and from 5.11.102 the person's team chat). The update policy wf_staff_rls_update lets ANY Back
--   Office login of the company update ANY column of ANY staff row in the company. So a manager
--   could point a colleague's record at their own till user and act as that colleague: in the
--   Manager app, in the staff app's PIN flows, and in chat. portal_user_id has had a trigger since
--   7 Aug (20260806j) that refused everyone but the service role; pos_user_id had nothing.
--
-- WHAT IT DOES
--   1. Column privileges. The authenticated role (every Back Office login, super admins included)
--      loses UPDATE and INSERT on the whole table and gets them back on every column EXCEPT
--      portal_user_id, pos_user_id, portal_invite_hash and portal_invite_expires. PostgREST then
--      answers 42501 to any PATCH or POST that names one of them. Every other column is granted
--      one by one, so a column added later is NOT writable from the API until
--      public.wf_staff_regrant_api() is called again: every later migration that adds a wf_staff
--      column must call it (src/lib/wfStaffIdentityFence.test.js checks the repo for that).
--      SELECT and DELETE are not touched. anon is not touched (the policies already refuse it and
--      the guard below covers it).
--   2. The guard, wf_staff_identity_guard (BEFORE INSERT OR UPDATE): the four columns may change
--      only for the service role (the staff-portal and workforce-clock edge functions), the
--      database itself (the SQL editor, pg_cron: no API claims and not the API login), or inside
--      public.wf_staff_set_pos_user (read from the call stack, which a client cannot forge).
--      Everyone else gets 42501. It replaces 20260806j's wf_staff_block_portal_cols_trg (same
--      rule for portal_user_id and the invite columns, now with pos_user_id, and with the database
--      itself allowed, which the old trigger refused).
--   3. The audit, wf_staff_identity_audit (AFTER INSERT OR UPDATE): every change of portal_user_id
--      or pos_user_id, by anyone, writes a wf_audit row: action staff.identity_changed, entity
--      wf_staff, before and after holding only the columns that changed, actor_id the login,
--      actor_name the login's name (or "service role" / "database"), reason the path and the
--      reason given. wf_audit is append only, so the row cannot be edited afterwards.
--   4. The one door for the till link, public.wf_staff_set_pos_user(staff, till user, reason):
--      SECURITY DEFINER, for a signed in Back Office login that is an OWNER of the staff record's
--      company (user_profiles.role owner with that org, a user_locations row with role owner or
--      admin at a venue of that company, or a super admin), past the second sign in step. It
--      refuses a manager, an anonymous session, a leaver, a till user of another company, and a
--      till user already linked to another live staff record. Null unlinks. The Back Office
--      (Workforce, Set up on the POS) calls it from 5.11.104.
--
-- WHAT IT NEVER DOES
--   It changes no staff row, no till user and no audit row. Staff invites (accept_invite, the
--   service role), offboarding (status only) and clock in auto created records (the service role)
--   keep working. Bank details, rates, sections and every other Workforce edit keep working.
--
-- ROLLBACK
--   20261104a_OPS_wf_staff_identity_fence_ROLLBACK.sql (drops the two triggers, the door and the
--   regrant helper, gives authenticated the whole table back for INSERT and UPDATE, and puts the
--   20260806j trigger back as it was). Audit rows already written stay.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.wf_staff') is null or to_regclass('public.wf_audit') is null
     or to_regclass('public.staff_members') is null or to_regclass('public.locations') is null
     or to_regclass('public.user_profiles') is null then
    raise exception 'The Workforce tables are missing. Nothing was changed.';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'wf_staff'
         and column_name in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires')) <> 4 then
    raise exception 'wf_staff is missing an identity column (20260806f has not run). Nothing was changed.';
  end if;
  if to_regprocedure('public.is_super_admin()') is null or to_regprocedure('public.is_anon_session()') is null
     or to_regprocedure('public.second_step_ok()') is null then
    raise exception 'is_super_admin, is_anon_session or second_step_ok is missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_set_pos_user(uuid,uuid,text)') is not null then
    raise exception 'The staff identity fence (20261104a) has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- -- 1. The regrant helper: every column but the four, one by one ------------------------------
-- Owned by the database. Not callable from the API. Later migrations that add a wf_staff column
-- call it so the Back Office can write the new column.
create function public.wf_staff_regrant_api()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_cols text;
  v_n integer;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*)
    into v_cols, v_n
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'wf_staff'
     and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_api() from public, anon, authenticated, service_role;
comment on function public.wf_staff_regrant_api() is
  'Grants INSERT and UPDATE on every wf_staff column except portal_user_id, pos_user_id, portal_invite_hash and portal_invite_expires to authenticated. Call it after adding a wf_staff column. 20261104a.';

-- -- 2. The guard ------------------------------------------------------------------------------
create function public.wf_staff_identity_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_ctx text;
  v_changed boolean;
begin
  -- The staff-portal and workforce-clock edge functions.
  if v_role = 'service_role' then
    return new;
  end if;
  -- The database itself: the SQL editor, pg_cron, a migration. Never the login the API connects as.
  if v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    return new;
  end if;
  -- The one door for the till link. The call stack cannot be set by a client.
  get diagnostics v_ctx = pg_context;
  if v_ctx ~ 'function (public\.)?wf_staff_set_pos_user\(uuid,uuid,text\)' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_changed := new.portal_user_id is not null or new.pos_user_id is not null
              or new.portal_invite_hash is not null or new.portal_invite_expires is not null;
  else
    v_changed := new.portal_user_id is distinct from old.portal_user_id
              or new.pos_user_id is distinct from old.pos_user_id
              or new.portal_invite_hash is distinct from old.portal_invite_hash
              or new.portal_invite_expires is distinct from old.portal_invite_expires;
  end if;
  if v_changed then
    raise exception 'wf_staff.portal_user_id, pos_user_id and the invite columns change only through the staff app service or wf_staff_set_pos_user (an owner of the company)'
      using errcode = '42501';
  end if;
  return new;
end
$f$;
revoke all on function public.wf_staff_identity_guard() from public, anon, authenticated, service_role;

-- -- 3. The audit ------------------------------------------------------------------------------
create function public.wf_staff_identity_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_uid uuid := auth.uid();
  v_ctx text;
  v_via text;
  v_actor text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_reason text := nullif(current_setting('wf.identity_reason', true), '');
begin
  if tg_op = 'INSERT' then
    if new.portal_user_id is not null then v_after := v_after || jsonb_build_object('portal_user_id', new.portal_user_id); end if;
    if new.pos_user_id is not null then v_after := v_after || jsonb_build_object('pos_user_id', new.pos_user_id); end if;
  else
    if new.portal_user_id is distinct from old.portal_user_id then
      v_before := v_before || jsonb_build_object('portal_user_id', old.portal_user_id);
      v_after := v_after || jsonb_build_object('portal_user_id', new.portal_user_id);
    end if;
    if new.pos_user_id is distinct from old.pos_user_id then
      v_before := v_before || jsonb_build_object('pos_user_id', old.pos_user_id);
      v_after := v_after || jsonb_build_object('pos_user_id', new.pos_user_id);
    end if;
  end if;
  if v_after = '{}'::jsonb and v_before = '{}'::jsonb then
    return new;
  end if;
  get diagnostics v_ctx = pg_context;
  if v_ctx ~ 'function (public\.)?wf_staff_set_pos_user\(uuid,uuid,text\)' then
    v_via := 'wf_staff_set_pos_user';
  elsif v_role = 'service_role' then
    v_via := 'service role';
  elsif v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    v_via := 'database (' || session_user::text || ')';
  else
    v_via := 'api (' || v_role || ')';
  end if;
  if v_uid is not null then
    select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Back Office login')
      into v_actor from public.user_profiles p where p.id = v_uid;
  end if;
  v_actor := coalesce(v_actor, case when v_via like 'database%' then 'database' when v_via = 'service role' then 'service role' else 'Back Office login' end);
  insert into public.wf_audit (location_id, org_id, actor_id, actor_name, action, entity, entity_id, reason, before, after)
  values (new.location_id, new.org_id, v_uid, v_actor, 'staff.identity_changed', 'wf_staff', new.id::text,
          v_via || coalesce(': ' || v_reason, ''), v_before, v_after || jsonb_build_object('via', v_via, 'op', lower(tg_op)));
  return new;
end
$f$;
revoke all on function public.wf_staff_identity_audit() from public, anon, authenticated, service_role;

-- -- 4. The door -------------------------------------------------------------------------------
create function public.wf_staff_set_pos_user(p_staff_id uuid, p_pos_user_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_uid uuid := auth.uid();
  v_trusted boolean := false;
  st public.wf_staff;
  sm public.staff_members;
  v_other uuid;
  v_prev uuid;
begin
  if p_staff_id is null then
    raise exception 'No staff record given' using errcode = '22023';
  end if;
  -- Who is asking. The service role and the database itself are trusted; a login must be an owner.
  if v_role = 'service_role' then
    v_trusted := true;
  elsif v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then
    v_trusted := true;
  else
    if v_uid is null or public.is_anon_session() then
      raise exception 'Sign in to Back Office first' using errcode = '42501';
    end if;
    if not public.second_step_ok() then
      raise exception 'Finish your second sign in step first' using errcode = '42501';
    end if;
  end if;

  select * into st from public.wf_staff where id = p_staff_id for update;
  if not found then
    raise exception 'No staff record with that id' using errcode = 'P0002';
  end if;

  if not v_trusted then
    v_trusted := public.is_super_admin()
      or exists (select 1 from public.user_profiles p
                  where p.id = v_uid and p.role = 'owner' and p.org_id is not null and p.org_id = st.org_id)
      or exists (select 1 from public.user_locations ul
                   join public.locations l on l.id = ul.location_id
                  where ul.user_id = v_uid and lower(coalesce(ul.role, '')) in ('owner', 'admin') and l.org_id = st.org_id);
    if not v_trusted then
      raise exception 'Only an owner of this company can link a till user to a staff record' using errcode = '42501';
    end if;
  end if;

  if st.status = 'leaver' then
    raise exception 'This person is a leaver. Reinstate them before linking a till user' using errcode = '22023';
  end if;

  if p_pos_user_id is not null then
    select * into sm from public.staff_members where id = p_pos_user_id;
    if not found then
      raise exception 'No till user with that id' using errcode = '22023';
    end if;
    if not (sm.org_id is not null and sm.org_id = st.org_id)
       and not exists (select 1 from public.locations l where l.id = sm.location_id and l.org_id = st.org_id) then
      raise exception 'That till user belongs to another company' using errcode = '22023';
    end if;
    select w.id into v_other from public.wf_staff w
     where w.pos_user_id = p_pos_user_id and w.id <> st.id and w.status <> 'leaver' limit 1;
    if found then
      raise exception 'That till user is already linked to another staff record' using errcode = '23505';
    end if;
  end if;

  v_prev := st.pos_user_id;
  if v_prev is not distinct from p_pos_user_id then
    return jsonb_build_object('ok', true, 'changed', false, 'staff_id', st.id, 'pos_user_id', p_pos_user_id, 'previous', v_prev);
  end if;
  perform set_config('wf.identity_reason', coalesce(left(btrim(p_reason), 200), ''), true);
  update public.wf_staff set pos_user_id = p_pos_user_id, updated_at = now() where id = st.id;
  perform set_config('wf.identity_reason', '', true);
  return jsonb_build_object('ok', true, 'changed', true, 'staff_id', st.id, 'pos_user_id', p_pos_user_id, 'previous', v_prev);
end
$f$;
revoke all on function public.wf_staff_set_pos_user(uuid, uuid, text) from public, anon;
grant execute on function public.wf_staff_set_pos_user(uuid, uuid, text) to authenticated, service_role;
comment on function public.wf_staff_set_pos_user(uuid, uuid, text) is
  'The one door for wf_staff.pos_user_id: an owner of the company (user_profiles owner of the org, user_locations owner or admin at a venue of it, or a super admin), the service role, or the database. Writes a wf_audit row. 20261104a.';

-- -- 5. Triggers: the old portal guard goes, the two new ones come -----------------------------
drop trigger if exists wf_staff_block_portal_cols_trg on public.wf_staff;
drop function if exists public.wf_staff_block_portal_cols();

create trigger wf_staff_identity_guard_trg
  before insert or update on public.wf_staff
  for each row execute function public.wf_staff_identity_guard();

create trigger wf_staff_identity_audit_trg
  after insert or update of portal_user_id, pos_user_id on public.wf_staff
  for each row execute function public.wf_staff_identity_audit();

-- -- 6. Column privileges ----------------------------------------------------------------------
revoke insert, update on table public.wf_staff from authenticated;
select public.wf_staff_regrant_api() as columns_granted;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: api_updates_pos_user false, api_updates_portal_user false,
-- api_inserts_identity false, api_updates_name true, api_inserts_name true, api_reads true,
-- other_columns_all_granted true, guard true, audit true, old_guard_gone true, door true,
-- door_open_to_anon false, door_open_to_api true, staff_rows_changed 0.
select
  has_column_privilege('authenticated', 'public.wf_staff', 'pos_user_id', 'update') as api_updates_pos_user,
  has_column_privilege('authenticated', 'public.wf_staff', 'portal_user_id', 'update') as api_updates_portal_user,
  (has_column_privilege('authenticated', 'public.wf_staff', 'pos_user_id', 'insert')
    or has_column_privilege('authenticated', 'public.wf_staff', 'portal_user_id', 'insert')
    or has_column_privilege('authenticated', 'public.wf_staff', 'portal_invite_hash', 'insert')
    or has_column_privilege('authenticated', 'public.wf_staff', 'portal_invite_expires', 'update')) as api_inserts_identity,
  has_column_privilege('authenticated', 'public.wf_staff', 'name', 'update') as api_updates_name,
  has_column_privilege('authenticated', 'public.wf_staff', 'name', 'insert') as api_inserts_name,
  has_table_privilege('authenticated', 'public.wf_staff', 'select') as api_reads,
  (select bool_and(has_column_privilege('authenticated', 'public.wf_staff', c.column_name, 'update')
                   and has_column_privilege('authenticated', 'public.wf_staff', c.column_name, 'insert'))
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'wf_staff'
      and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires')) as other_columns_all_granted,
  exists (select 1 from pg_trigger where tgrelid = 'public.wf_staff'::regclass and tgname = 'wf_staff_identity_guard_trg') as guard,
  exists (select 1 from pg_trigger where tgrelid = 'public.wf_staff'::regclass and tgname = 'wf_staff_identity_audit_trg') as audit,
  not exists (select 1 from pg_trigger where tgrelid = 'public.wf_staff'::regclass and tgname = 'wf_staff_block_portal_cols_trg') as old_guard_gone,
  to_regprocedure('public.wf_staff_set_pos_user(uuid,uuid,text)') is not null as door,
  has_function_privilege('anon', 'public.wf_staff_set_pos_user(uuid,uuid,text)', 'execute') as door_open_to_anon,
  has_function_privilege('authenticated', 'public.wf_staff_set_pos_user(uuid,uuid,text)', 'execute') as door_open_to_api,
  (select count(*)::int from public.wf_staff where updated_at >= now()) as staff_rows_changed;
