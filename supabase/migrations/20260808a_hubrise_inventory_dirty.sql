-- Stop re-pushing the whole 86 list to HubRise every two minutes.
--
-- hubrise-reconcile ran resyncInventory() unconditionally on its */2 cron, so a
-- venue that had changed nothing all day still had its full out-of-stock set
-- PUT to HubRise 720 times a day. HubRise's review flagged it, correctly: 86
-- state is pushed from the POS the moment it changes, and the cron only needs to
-- catch the case where that push did not land.
--
-- This flag is that case. Set when an instant push fails, cleared when the
-- catch-up succeeds. No change, no traffic.

alter table public.hubrise_connections
  add column if not exists inventory_dirty boolean not null default false,
  add column if not exists inventory_pushed_at timestamptz;

comment on column public.hubrise_connections.inventory_dirty is
  'An 86 change did not reach HubRise. hubrise-reconcile re-pushes and clears it. False = in sync, nothing to send.';
