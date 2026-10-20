-- inventory_item_areas_rehome and its trigger, the text of 20261016_OPS_stock_areas.sql (section 4b), byte for byte.
create or replace function public.inventory_item_areas_rehome()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_primary then
    update stock_movements set area_id = new.area_id
     where location_id = new.location_id and inventory_item_id = new.inventory_item_id and area_id is null;
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
    select new.location_id, new.inventory_item_id, new.area_id, coalesce(sum(m.qty_base), 0), now()
      from stock_movements m
     where m.location_id = new.location_id and m.inventory_item_id = new.inventory_item_id and m.area_id = new.area_id
    on conflict (inventory_item_id, area_id) do update set on_hand = excluded.on_hand, updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists inventory_item_areas_rehome_trg on public.inventory_item_areas;
create trigger inventory_item_areas_rehome_trg
  after insert or update of area_id on public.inventory_item_areas
  for each row execute function public.inventory_item_areas_rehome();
