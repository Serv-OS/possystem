-- v5.5.962 — Smart Quick Screen: sales-ranked auto/hybrid quick picks
-- quick_screen_mode: 'manual' (default, today's behaviour: only the pinned ids),
--                    'auto'   (best sellers for the current daypart),
--                    'hybrid' (pins first, empty slots auto-filled with best sellers)
-- quick_screen_auto: { computed_at, days, lists: { breakfast:[], lunch:[], dinner:[], late:[] } }
--                    computed in the Back Office from closed_checks and stored here so the
--                    till only ever reads a small column — fast and offline-safe.
begin;

alter table locations
  add column if not exists quick_screen_mode text not null default 'manual';

do $$ begin
  alter table locations
    add constraint locations_quick_screen_mode_check
    check (quick_screen_mode in ('manual','auto','hybrid'));
exception when duplicate_object then null; end $$;

alter table locations
  add column if not exists quick_screen_auto jsonb;

commit;
