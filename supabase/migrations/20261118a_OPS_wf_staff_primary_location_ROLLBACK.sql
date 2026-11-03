-- 20261118a ROLLBACK: removes the primary location door (primary_venue_id values stay as they are).
drop function if exists public.wf_staff_set_primary(uuid, uuid);
