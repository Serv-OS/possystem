-- 20260826_venue_code.sql
--
-- Give every venue a short, permanent, human-copyable ID.
--
-- WHY: the support chat can tell us which venue it was opened from, but the NAME
-- cannot identify anyone. The POS calls a site "Leeds" while the CRM holds three
-- Leeds venues under different brands, so matching on a name picks the wrong
-- customer. Matching on the venue's uuid works but nobody can read a uuid off a
-- screen and type it into a CRM record.
--
-- So: a short code, generated automatically, shown in the admin portal, copied
-- into the CRM once when the venue is set up. After that the chat carries the
-- code and support knows exactly who is asking, whatever anyone renamed things to.
--
-- The DEFAULT is the point. Every insert path gets a code without remembering to
-- ask for one, so a venue created by any route, now or later, is never codeless.

begin;

-- Starts at 1001 so a code is always four digits and never looks like a count.
create sequence if not exists public.venue_code_seq start with 1001;

alter table public.locations
  add column if not exists venue_code text;

alter table public.locations
  alter column venue_code
  set default 'SV-' || lpad(nextval('public.venue_code_seq')::text, 4, '0');

-- Existing venues, oldest first, so the numbers follow the order they were opened.
update public.locations
   set venue_code = 'SV-' || lpad(nextval('public.venue_code_seq')::text, 4, '0')
 where venue_code is null;

-- Unique, and enforced: a duplicate would send support to the wrong customer.
create unique index if not exists locations_venue_code_key
  on public.locations (venue_code);

comment on column public.locations.venue_code is
  'Short permanent public ID for this venue (SV-1001). Generated on insert, shown in the admin portal, and copied into the CRM so support can identify a caller. Never reuse or change one: it is how another system points at this venue.';

commit;

-- Rollback:
-- begin;
--   drop index if exists public.locations_venue_code_key;
--   alter table public.locations alter column venue_code drop default;
--   alter table public.locations drop column if exists venue_code;
--   drop sequence if exists public.venue_code_seq;
-- commit;
