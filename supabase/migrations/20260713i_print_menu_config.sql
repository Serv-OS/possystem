-- 20260713i — Print Menu / PDF builder config (ops DB). Per-location layout config for the
-- back-office printable-menu designer (categories, columns, orientation, paper, font, logo,
-- toggles, disclaimers). Additive jsonb column; nothing reads it until the BO screen writes it.
alter table public.locations add column if not exists print_menu_config jsonb;
