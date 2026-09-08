-- 2026-04-21-instruction-groups-jsonb.sql
--
-- Fixes the bug where menu_items.assigned_instruction_groups got silently
-- wiped on every save / push / deploy. The column was text[] but the
-- application writes it using the same array-of-objects shape it uses for
-- assigned_modifier_groups (which is jsonb). text[] rejects objects, so
-- writes either failed silently or coerced to [].
--
-- This migration changes the column type to jsonb to match the app and
-- to match assigned_modifier_groups. Safe: all existing values were []
-- by the time the bug was diagnosed, so there's no real data to preserve.
-- to_jsonb(text[]) handles any legacy string array gracefully.
--
-- Idempotent via the DO block: skips if already jsonb.
--
-- Run on Ops Supabase (tbetcegmszzotrwdtqhi) via SQL Editor.
-- (Already run against the live db on 21 Apr 2026 during the diagnosis
-- session; this file is committed for future reproducibility.)

do $$
begin
  if (select data_type from information_schema.columns
      where table_schema='public' and table_name='menu_items'
        and column_name='assigned_instruction_groups') <> 'jsonb' then
    execute 'alter table public.menu_items alter column assigned_instruction_groups drop default';
    execute 'alter table public.menu_items alter column assigned_instruction_groups type jsonb using coalesce(to_jsonb(assigned_instruction_groups), ''[]''::jsonb)';
    execute 'alter table public.menu_items alter column assigned_instruction_groups set default ''[]''::jsonb';
  end if;
end $$;
