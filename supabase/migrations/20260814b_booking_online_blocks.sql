-- Online-booking blocks (Peter, 14 Aug): blackout DATES the widget must not
-- sell, and TABLES the widget must never offer. Both apply to the ONLINE door
-- only — the host stand books freely on both. Enforced server-side in
-- booking-widget (the rules row already rides to the fn and the BO).
begin;

alter table public.booking_rules
  add column if not exists blocked_dates    jsonb not null default '[]'::jsonb,
  add column if not exists no_online_tables jsonb not null default '[]'::jsonb;

comment on column public.booking_rules.blocked_dates    is 'YYYY-MM-DD strings the online widget refuses (host stand unaffected)';
comment on column public.booking_rules.no_online_tables is 'floor_tables ids the online widget never offers (host stand unaffected)';

commit;
