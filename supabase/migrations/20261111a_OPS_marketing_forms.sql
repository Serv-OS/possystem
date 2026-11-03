-- 20261111a_OPS_marketing_forms.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). 5.12.40, 2 Nov 2026. Marketing forms.
--
-- Peter: "we need a way to have forms that you can create and embed on a website or on the website
-- builder that then you can attach to an automation to trigger the code to be sent out
-- automatically to the customer filling in the form".
--
-- What this adds (additive only, safe to run twice):
--   1. marketing_forms: a form built in Back Office (Customers, Forms). Company wide or one venue.
--      Read by the company's own Back Office logins; written only by the marketing-forms function.
--   2. marketing_form_submissions: one row per person who sent a form. FORCE row level security:
--      a Back Office login reads its own company only; nobody but the service role (the public
--      form-submit function, which checks the honeypot, the size, the 5 per 10 minutes limit and
--      the form's own fields) can write a row. No insert, update or delete rule for anyone.
--   3. marketing_form_public(form id, venue ids): what a public page needs to paint a form (fields,
--      words) and nothing else, only for an ACTIVE form, only when the form belongs to the same
--      company as one of the venue ids given (the website's own venues). Anon may call it.
--   4. promo_codes.form_id and promo_codes.workflow_id: the code an automation sent is attributed
--      to the form and the automation (the customer was already on the row).
--   5. workflow_enrollments.round: a "Form submitted" automation can take the same person again
--      when the offer allows more than one code each (offers.per_customer_limit); each round sends
--      its steps once (step key + #r<round>). Every existing enrollment is round 0, unchanged.
--
-- Why marketing_forms is NOT forced (and submissions is): marketing_form_public runs as the table
-- owner. With FORCE on, the owner is fenced by the rules too, and the public form would read
-- nothing (the chat hotfix of 28 Oct, 20261110a, is the same lesson). Signed in people are fenced
-- by the same rule either way.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS migration. Run it on the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.customers') is null or to_regclass('public.workflows') is null or to_regclass('public.promo_codes') is null then
    raise exception 'customers, workflows and promo_codes must exist first (marketing slices). Nothing was changed.';
  end if;
end $guard$;

set local lock_timeout = '3s';

-- 1. Forms ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.marketing_forms (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  location_id     uuid,                                   -- null = the whole company
  name            text not null,
  fields          jsonb not null default '[]'::jsonb,     -- [{ id, kind, label, required, options?, long? }], max 12
  consent_enabled boolean not null default true,
  consent_text    text not null default '',
  submit_label    text not null default 'Send',
  thanks_text     text not null default '',
  status          text not null default 'active' check (status in ('active','archived')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint marketing_forms_fields_array check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 12),
  constraint marketing_forms_name_len check (char_length(name) between 1 and 120)
);
create index if not exists marketing_forms_org_idx on public.marketing_forms (org_id, created_at desc);
alter table public.marketing_forms enable row level security;
drop policy if exists marketing_forms_read on public.marketing_forms;
create policy marketing_forms_read on public.marketing_forms for select to authenticated
  using (org_id::text in (select public.user_accessible_orgs()));
revoke all on public.marketing_forms from anon;
revoke insert, update, delete, truncate on public.marketing_forms from authenticated;
grant select on public.marketing_forms to authenticated;

-- 2. Submissions ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.marketing_form_submissions (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references public.marketing_forms(id) on delete cascade,
  org_id        uuid not null,
  location_id   uuid,
  answers       jsonb not null default '{}'::jsonb,
  consent       boolean not null default false,
  consent_text  text,                                     -- the words the person ticked, as shown
  customer_id   uuid,                                     -- the CRM customer it was matched to or made
  ip_hash       text,                                     -- salted SHA-256, never the address itself
  user_agent    text,
  source        text not null default 'website' check (source in ('website','embed','hosted')),
  page_url      text,
  created_at    timestamptz not null default now(),
  constraint marketing_form_submissions_answers_obj check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 16384)
);
create index if not exists marketing_form_submissions_form_idx on public.marketing_form_submissions (form_id, created_at desc);
create index if not exists marketing_form_submissions_rate_idx on public.marketing_form_submissions (form_id, ip_hash, created_at desc);
create index if not exists marketing_form_submissions_org_idx on public.marketing_form_submissions (org_id, created_at desc);
create index if not exists marketing_form_submissions_customer_idx on public.marketing_form_submissions (customer_id) where customer_id is not null;
alter table public.marketing_form_submissions enable row level security;
alter table public.marketing_form_submissions force row level security;
drop policy if exists marketing_form_submissions_read on public.marketing_form_submissions;
create policy marketing_form_submissions_read on public.marketing_form_submissions for select to authenticated
  using (org_id::text in (select public.user_accessible_orgs()));
revoke all on public.marketing_form_submissions from anon;
revoke insert, update, delete, truncate on public.marketing_form_submissions from authenticated;
grant select on public.marketing_form_submissions to authenticated;

-- 3. The public read ───────────────────────────────────────────────────────────────────────────
-- p_location_ids: the Ops venue ids of the page asking (a website's venues, or null for the hosted
-- form page, which shows the form by its own id). The form must be active and, when venues are
-- given, belong to the same company as one of them.
create or replace function public.marketing_form_public(p_form_id uuid, p_location_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $fn$
  select jsonb_build_object(
    'id', f.id, 'name', f.name, 'fields', f.fields,
    'consent_enabled', f.consent_enabled, 'consent_text', f.consent_text,
    'submit_label', f.submit_label, 'thanks_text', f.thanks_text,
    'location_id', f.location_id,
    -- the venue whose Appearance paints the hosted page: the form's own, else the company's first
    'brand_location_id', coalesce(f.location_id, (
      select l.id from public.locations l where l.org_id = f.org_id order by l.created_at nulls last, l.id limit 1)))
  from public.marketing_forms f
  where f.id = p_form_id
    and f.status = 'active'
    and (p_location_ids is null or exists (
      select 1 from public.locations l where l.id = any(p_location_ids) and l.org_id = f.org_id))
$fn$;
revoke all on function public.marketing_form_public(uuid, uuid[]) from public;
grant execute on function public.marketing_form_public(uuid, uuid[]) to anon, authenticated;

-- 4. Code attribution ──────────────────────────────────────────────────────────────────────────
alter table public.promo_codes add column if not exists form_id uuid;
alter table public.promo_codes add column if not exists workflow_id uuid;
create index if not exists promo_codes_form_idx on public.promo_codes (form_id, customer_id) where form_id is not null;

-- 5. Rounds ────────────────────────────────────────────────────────────────────────────────────
alter table public.workflow_enrollments add column if not exists round integer not null default 0;

-- Self check: the shape the functions rely on.
do $check$
begin
  if to_regprocedure('public.marketing_form_public(uuid, uuid[])') is null then
    raise exception 'marketing_form_public did not install';
  end if;
  if not exists (select 1 from pg_class where relname = 'marketing_form_submissions' and relforcerowsecurity) then
    raise exception 'marketing_form_submissions is not forced';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'form_id') then
    raise exception 'promo_codes.form_id missing';
  end if;
end $check$;
