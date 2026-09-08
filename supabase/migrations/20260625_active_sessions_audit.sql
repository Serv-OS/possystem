-- 20260625_active_sessions_audit.sql
-- TEMPORARY diagnostic (v5.5.639): record who/what writes & removes active_sessions rows, so we can
-- confirm the "tables silently vanish from the waitlist" root cause (stale offline-queue delete /
-- cross-device sweep) and verify the self-heal fix repairs occupancy. Captures the caller's JWT
-- role + sub (the device's anon/auth identity) on every INSERT and DELETE. Low volume (table
-- open/close events). DROP THIS once the fix is confirmed stable (see bottom of file).

create table if not exists public.active_sessions_audit (
  id           bigserial primary key,
  op           text        not null,        -- 'INSERT' | 'DELETE'
  table_id     text,
  location_id  uuid,
  seated_at    text,                         -- session->>'seatedAt' (epoch ms as text)
  item_count   int,
  jwt_role     text,                         -- claims.role  (anon | authenticated | service_role)
  jwt_sub      text,                         -- claims.sub   (the auth.uid() of the deleting device)
  db_user      text default current_user,
  at           timestamptz not null default now()
);

create or replace function public.log_active_sessions_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims json;
  sess   jsonb;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
  exception when others then
    claims := null;
  end;
  sess := coalesce(OLD.session, NEW.session);
  insert into public.active_sessions_audit (op, table_id, location_id, seated_at, item_count, jwt_role, jwt_sub)
  values (
    TG_OP,
    coalesce(OLD.table_id, NEW.table_id),
    coalesce(OLD.location_id, NEW.location_id),
    sess->>'seatedAt',
    coalesce(jsonb_array_length(coalesce(sess->'items', '[]'::jsonb)), 0),
    coalesce(claims->>'role', current_user),
    claims->>'sub'
  );
  return null; -- AFTER trigger
end;
$$;

drop trigger if exists trg_active_sessions_audit on public.active_sessions;
create trigger trg_active_sessions_audit
  after insert or delete on public.active_sessions
  for each row execute function public.log_active_sessions_change();

-- TEARDOWN (run when done diagnosing):
--   drop trigger if exists trg_active_sessions_audit on public.active_sessions;
--   drop function if exists public.log_active_sessions_change();
--   drop table if exists public.active_sessions_audit;
