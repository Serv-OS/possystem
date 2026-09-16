-- 20260916_OPS_menu_translations.sql  (OPS project tbetcegmszzotrwdtqhi)
--
-- Menu translations for the kiosk (v5.8.82). One row per piece of venue text per language:
-- an item's name and description, a category label, an option group name, an option name,
-- an instruction group name or one of its choices. The kiosk reads the rows for its venue
-- and the picked language and shows them instead of the English.
--
-- Rows are written by the menu-translate edge function (source 'auto', with the hash of the
-- English text they came from, so a changed item is translated again) and by Back Office
-- edits (source 'manual', never overwritten or deleted by the translator).
--
-- Reads: public, like menu_items and menu_categories (the kiosk reads with the anon key).
-- Writes: the venue's own users and devices (pos_can_access), super admins, and the service
-- role used by the edge function. The baseline's default privileges hand every new table to
-- anon and authenticated, so the grants below revoke first and grant back only what is meant.
--
-- pg_cron: every 10 minutes, one menu-translate call per venue that has a kiosk on the new
-- design, through call_edge_fn (the vault key it already uses). A venue with no such kiosk
-- costs nothing.

create table if not exists public.menu_translations (
  id           bigserial primary key,
  location_id  text not null,
  entity_type  text not null check (entity_type in ('item', 'category', 'modifier_group', 'modifier_option', 'instruction_group', 'instruction_option')),
  entity_id    text not null,
  lang         text not null check (lang in ('es', 'fr', 'zh', 'de', 'it', 'pt')),
  text         jsonb not null default '{}'::jsonb,
  source       text not null default 'auto' check (source in ('auto', 'manual')),
  source_hash  text not null default '',
  model        text,
  updated_at   timestamptz not null default now(),
  unique (location_id, entity_type, entity_id, lang)
);

create index if not exists menu_translations_loc_lang on public.menu_translations (location_id, lang);

alter table public.menu_translations enable row level security;

drop policy if exists menu_translations_anon_read on public.menu_translations;
create policy menu_translations_anon_read on public.menu_translations
  for select using (true);

drop policy if exists menu_translations_write_tenant on public.menu_translations;
create policy menu_translations_write_tenant on public.menu_translations
  for all
  using (public.pos_can_access(location_id) or public.is_super_admin())
  with check (public.pos_can_access(location_id) or public.is_super_admin());

-- Privileges: revoke the defaults first, then grant back exactly what is meant.
revoke all on public.menu_translations from public, anon, authenticated;
revoke all on sequence public.menu_translations_id_seq from public, anon, authenticated;
grant select on public.menu_translations to anon, authenticated;
grant insert, update, delete on public.menu_translations to authenticated;
grant usage, select on sequence public.menu_translations_id_seq to authenticated;

-- ── The translator's write: automatic rows only, a manual row is left exactly as it is ──
-- p_rows: [{ location_id, entity_type, entity_id, lang, text, source_hash, model, updated_at }]
-- Returns how many rows were written (inserted or refreshed). Service role only.
create or replace function public.menu_translations_upsert_auto(p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
begin
  with incoming as (
    select
      r->>'location_id' as location_id,
      r->>'entity_type' as entity_type,
      r->>'entity_id'   as entity_id,
      r->>'lang'        as lang,
      coalesce(r->'text', '{}'::jsonb) as text,
      coalesce(r->>'source_hash', '') as source_hash,
      r->>'model'       as model,
      coalesce((r->>'updated_at')::timestamptz, now()) as updated_at
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where coalesce(r->>'location_id', '') <> '' and coalesce(r->>'entity_id', '') <> ''
  ),
  written as (
    insert into public.menu_translations (location_id, entity_type, entity_id, lang, text, source, source_hash, model, updated_at)
    select location_id, entity_type, entity_id, lang, text, 'auto', source_hash, model, updated_at from incoming
    on conflict (location_id, entity_type, entity_id, lang) do update
      set text = excluded.text, source_hash = excluded.source_hash, model = excluded.model, updated_at = excluded.updated_at
      where public.menu_translations.source <> 'manual'
    returning 1
  )
  select count(*) into n from written;
  return n;
end $$;

revoke all on function public.menu_translations_upsert_auto(jsonb) from public, anon, authenticated;
grant execute on function public.menu_translations_upsert_auto(jsonb) to service_role;

-- ── Background translation: one edge function call per venue with a new design kiosk ──
create or replace function public.menu_translate_cron() returns void
language plpgsql security definer set search_path = public as $$
declare
  loc record;
begin
  for loc in
    select distinct location_id::text as location_id
    from public.device_profiles
    where kiosk_new_design = true and location_id is not null
  loop
    perform public.call_edge_fn('menu-translate', jsonb_build_object('location_id', loc.location_id, 'reason', 'cron'));
  end loop;
end $$;

-- SECURITY DEFINER and it spends money through the model: not callable from the API roles.
revoke all on function public.menu_translate_cron() from public, anon, authenticated;

do $$ begin perform cron.unschedule('menu-translate-10min'); exception when others then null; end $$;
select cron.schedule('menu-translate-10min', '*/10 * * * *', $$select public.menu_translate_cron()$$);

-- ── Self test: every line should read 1, and "anon writes" should read 0 ──
select 'table' as what, count(*) from information_schema.tables where table_schema = 'public' and table_name = 'menu_translations'
union all
select 'read policy', count(*) from pg_policies where tablename = 'menu_translations' and policyname = 'menu_translations_anon_read'
union all
select 'write policy', count(*) from pg_policies where tablename = 'menu_translations' and policyname = 'menu_translations_write_tenant'
union all
select 'auto upsert function', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'menu_translations_upsert_auto'
union all
select 'cron job', count(*) from cron.job where jobname = 'menu-translate-10min'
union all
select 'anon writes', count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'menu_translations' and grantee = 'anon' and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
