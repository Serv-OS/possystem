-- 20260729d_pos_stock_read_rls.sql — OPS DB
--
-- TWO FIXES, ONE CAUSE: a paired till could not READ the stock model.
--
-- 1. THE WASTE MODAL SAID "NO RECIPES" WITH 8 RECIPES LIVE. Every stock table's RLS was
--    BO-user-only (user_accessible_locations()); a paired POS runs as an anonymous
--    device and read ZERO rows, so recipe explosion had nothing to explode. Writes
--    always worked (post_stock_movement is SECURITY DEFINER) — only reads were blind.
--    Devices get READ on the recipe/catalog tables; WRITES stay BO-only.
--
-- 2. pos_can_access() required devices.status = 'active', but real paired devices sit
--    at 'online' (Coffee Boy and BAR KDS lost bar_tabs over exactly this) — flagged in
--    the overnight RLS audit, closed here: status in ('active','online').
--
-- Idempotent. Policy split: SELECT = pos_can_access (BO OR paired device, definer),
-- INSERT/UPDATE/DELETE = user_accessible_locations() exactly as before.

begin;

create or replace function public.pos_can_access(p_loc uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if p_loc is null then return false; end if;
  if p_loc::text in (select user_accessible_locations()) then return true; end if;
  return exists (
    select 1 from public.devices d
    where d.device_uid = auth.uid()
      and d.status in ('active', 'online')
      and d.location_id = p_loc
  );
end $$;

create or replace function public.pos_can_access(p_loc text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if p_loc is null then return false; end if;
  if p_loc in (select user_accessible_locations()) then return true; end if;
  return exists (
    select 1 from public.devices d
    where d.device_uid = auth.uid()
      and d.status in ('active', 'online')
      and d.location_id::text = p_loc
  );
end $$;

do $$
declare t text;
begin
  foreach t in array array['recipes','recipe_lines','menu_item_recipes','inventory_items',
                           'inventory_item_conversions','supplier_products','item_packaging_formats'] loop
    execute format('drop policy if exists %1$I_rls on public.%1$I;', t);
    execute format('drop policy if exists %1$I_sel on public.%1$I;', t);
    execute format('drop policy if exists %1$I_write on public.%1$I;', t);
    execute format('create policy %1$I_sel on public.%1$I for select using (public.pos_can_access(location_id));', t);
    execute format('create policy %1$I_write on public.%1$I for insert with check (location_id::text in (select public.user_accessible_locations()));', t);
    execute format('create policy %1$I_upd on public.%1$I for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()));', t);
    execute format('create policy %1$I_del on public.%1$I for delete using (location_id::text in (select public.user_accessible_locations()));', t);
  end loop;
end $$;

commit;
