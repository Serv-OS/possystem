CREATE OR REPLACE FUNCTION public.set_inventory_on_hand(p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cur numeric;
  v_delta numeric;
  v_res jsonb;
begin
  select coalesce(on_hand, 0) into v_cur from inventory_items
    where id = p_inventory_item_id and location_id = p_location_id;
  if not found then return jsonb_build_object('error', 'item not found'); end if;
  v_delta := p_counted_qty - v_cur;
  if v_delta = 0 then return jsonb_build_object('on_hand', v_cur, 'delta', 0); end if;
  v_res := post_stock_movement(p_location_id, p_inventory_item_id, v_delta, 'STOCK_COUNT_ADJ',
    null, 'manual_count', null, null, now(), p_created_by, p_notes);
  return v_res || jsonb_build_object('delta', v_delta);
end $function$;
