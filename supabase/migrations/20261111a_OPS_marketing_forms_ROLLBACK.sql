-- 20261111a_OPS_marketing_forms_ROLLBACK.sql
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261111a_OPS_marketing_forms.sql.
-- WARNING: drops every form and every submission. The customers the forms made, their consent
-- rows and the codes sent stay (they belong to the CRM and the marketing ledgers).
-- Run only after the form-submit and marketing-forms functions are undeployed or the app is back
-- on the previous version, or the public forms answer "This form is not available".

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is the OPS rollback. Run it on the Ops database only. Nothing was changed.';
  end if;
end $guard$;

drop function if exists public.marketing_form_public(uuid, uuid[]);
drop table if exists public.marketing_form_submissions;
drop table if exists public.marketing_forms;
drop index if exists public.promo_codes_form_idx;
alter table public.promo_codes drop column if exists form_id;
alter table public.promo_codes drop column if exists workflow_id;
-- workflow_enrollments.round stays: dropping it would make a second round's step rows look like
-- round 0 again. It is harmless at 0.
