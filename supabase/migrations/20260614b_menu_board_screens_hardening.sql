-- Hardening for the menu-board pairing flow (follows 20260614_menu_board_screens.sql).
-- Adversarial RLS review flagged that an UNPAIRED screen (location_id NULL) could,
-- in principle, have its pairing code brute-forced via claim_menu_board_screen and be
-- bound to an attacker's board (denial-of-pairing + content injection on an unclaimed
-- display — no data access, no cross-tenant location takeover). Two mitigations:
--   1) Pairing codes are now ~39-bit (8 chars / 30-symbol alphabet) in the surface,
--      making the codespace infeasible to enumerate.
--   2) TTL below: a code can only be claimed while the screen is actually live (or
--      freshly registered). Abandoned/stale codes can no longer be pre-claimed.

create or replace function claim_menu_board_screen(p_code text, p_board_id uuid)
returns menu_board_screens
language plpgsql security definer set search_path = public as $$
declare b record; s record;
begin
  select id, location_id, org_id into b from menu_boards where id = p_board_id;
  if b.id is null then raise exception 'board not found'; end if;
  if not _mb_user_has_location(b.location_id) then raise exception 'no access to this location'; end if;
  select * into s from menu_board_screens where lower(code) = lower(btrim(p_code)) limit 1;
  if s.id is null then raise exception 'pairing code not found'; end if;
  if s.location_id is not null and not _mb_user_has_location(s.location_id)
    then raise exception 'screen belongs to another location'; end if;
  -- TTL: only an actively-online (or just-registered) screen may be claimed.
  if coalesce(s.last_seen_at, s.created_at) < now() - interval '30 minutes'
    then raise exception 'pairing code expired — restart the screen to get a new code'; end if;
  update menu_board_screens
     set board_id = b.id, location_id = b.location_id, org_id = b.org_id,
         status = 'paired', paired_at = now(), updated_at = now()
   where id = s.id;
  select * into s from menu_board_screens where id = s.id;
  return s;
end; $$;
