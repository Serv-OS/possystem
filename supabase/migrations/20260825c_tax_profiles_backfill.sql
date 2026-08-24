-- 20260825c_tax_profiles_backfill.sql — OPS database, hand-applied.
-- Tax profiles slice 2: generate one profile per existing ACTIVE tax rate so
-- the new dropdowns are populated from day one. NOTHING is assigned to any
-- item or category here — the engine's binding cascade keeps every existing
-- venue on its legacy configuration (byte-identical maths) until an operator
-- deliberately assigns a profile. Idempotent: re-running finds the stamped
-- generated_from_rate_id rows and inserts nothing.
--
-- Deviation from the plan text, justified: the plan sketched extra "combo"
-- profiles for per-item override shapes. The binding cascade correction makes
-- item legacy config outrank ALL profiles, so combo profiles add nothing but
-- dropdown clutter. Operators build real combined profiles in the builder UI.

begin;

-- One profile per active rate, stamped with its source rate id.
insert into public.tax_profiles (location_id, name, description, generated_from_rate_id, sort_order)
select r.location_id,
       r.name,
       'Generated from the existing tax rate. Safe to rename or edit.',
       r.id,
       coalesce(row_number() over (partition by r.location_id order by r.rate desc), 0)
from public.tax_rates r
where r.active
  and not exists (
    select 1 from public.tax_profiles p
    where p.generated_from_rate_id = r.id
  );

-- One line per generated profile, copying the rate verbatim.
insert into public.tax_profile_lines
  (profile_id, location_id, name, jurisdiction, line_type, rate, mode, sort_order)
select p.id,
       p.location_id,
       r.name,
       case when r.type = 'inclusive' then 'HMRC' else null end,
       'rate',
       r.rate,
       case when r.type = 'exclusive' then 'exclusive' else 'inclusive' end,
       0
from public.tax_profiles p
join public.tax_rates r on r.id = p.generated_from_rate_id
where not exists (
  select 1 from public.tax_profile_lines l where l.profile_id = p.id
);

-- Venue default profile = the profile generated from the venue's default rate.
-- Inert until the engine cutover (no consumer reads it yet); at cutover it
-- resolves identically to the legacy default via the parity adapter.
update public.locations loc
set default_tax_profile_id = p.id
from public.tax_rates r
join public.tax_profiles p on p.generated_from_rate_id = r.id
where r.location_id = loc.id
  and r.is_default
  and r.active
  and loc.default_tax_profile_id is null;

commit;
