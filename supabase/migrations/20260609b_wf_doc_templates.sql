-- ============================================================================
-- Workforce document templates — reusable offer-letter & contract templates
-- with {{merge}} placeholders (Workforce.com / Deputy model). Location-scoped
-- RLS; the app ships built-in defaults and stores edited copies here.
-- Already applied to the Ops DB; kept as source of truth. Idempotent.
-- ============================================================================

create table if not exists wf_doc_templates (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid not null,
  kind          text not null check (kind in ('offer','contract')),
  name          text not null,
  body          text not null default '',
  contract_type text,                 -- optional scope: zeroHours|partTime|fullTime|salaried
  is_default    boolean not null default false,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_wf_tpl_loc on wf_doc_templates(location_id, kind);

do $$ begin
  alter table wf_doc_templates add constraint wf_doc_templates_loc_org_fk
    foreign key (location_id, org_id) references locations (id, org_id);
exception when duplicate_object then null; end $$;

drop trigger if exists trg_wf_doc_templates_touch on wf_doc_templates;
create trigger trg_wf_doc_templates_touch before update on wf_doc_templates for each row execute function wf_touch_updated_at();

alter table wf_doc_templates enable row level security;
alter table wf_doc_templates force row level security;
do $$ begin create policy wf_doc_templates_rls_select on wf_doc_templates for select using (location_id::text in (select public.user_accessible_locations())); exception when duplicate_object then null; end $$;
do $$ begin create policy wf_doc_templates_rls_insert on wf_doc_templates for insert with check (location_id::text in (select public.user_accessible_locations())); exception when duplicate_object then null; end $$;
do $$ begin create policy wf_doc_templates_rls_update on wf_doc_templates for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations())); exception when duplicate_object then null; end $$;
do $$ begin create policy wf_doc_templates_rls_delete on wf_doc_templates for delete using (location_id::text in (select public.user_accessible_locations())); exception when duplicate_object then null; end $$;
do $$ begin create policy wf_doc_templates_super_admin_all on wf_doc_templates for all using (public.is_super_admin()) with check (public.is_super_admin()); exception when duplicate_object then null; end $$;
