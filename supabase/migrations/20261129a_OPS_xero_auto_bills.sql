-- 20261129a_OPS_xero_auto_bills.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 2 columns, 1 function, 1 cron job. Changes no data by itself.      #
-- ############################################################################
--
-- WHY (Peter, 7 Nov 2026)
--   "we need to start getting ready for all stock syncing for invoices credit notes etc".
--   Supplier invoices only reached Xero when someone pressed Push to Xero on the invoice, and
--   credit notes never did. A forgotten button is a missing bill.
--
-- WHAT THIS FILE ADDS
--   xero_config.auto_bills        the switch (Back Office, Xero, Connection: "Send bills and
--                                 credit notes automatically"), off until someone turns it on
--   xero_config.auto_bills_since  when it was turned on: only invoices posted and credit notes
--                                 added AFTER that moment are sent by themselves, so switching
--                                 on never pushes a venue's history into Xero unasked
--   public.xero_auto_bills_post() every 15 minutes (pg_cron job xero-auto-bills): for each
--                                 connected venue with the switch on, asks the xero-bills
--                                 function to send each POSTED supplier invoice and each credit
--                                 note that has no ok row in xero_sync_log yet. A refused one is
--                                 tried again after two hours, six times at most; the function
--                                 records every attempt (detail.history) and Back Office lists
--                                 them under Bills and credit notes with a Retry button. One
--                                 being sent right now (a 'sending' row under 30 minutes old) is
--                                 left alone. 20 of each per venue per run.
--
-- The call carries the project's secret key from Vault (xero_cron_key, the same secret the
-- hourly sales job uses), so xero-bills treats it as the service role. Needs 20260715b (the
-- vault secret and pg_net) and the xero-bills function from release 5.12.73 deployed; until
-- that deploy the credit note calls answer an error and are tried again.
--
-- Rollback: 20261129a_OPS_xero_auto_bills_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.xero_config') is null or to_regclass('public.xero_sync_log') is null then
    raise exception 'This is not the Ops database (xero_config or xero_sync_log is missing). Nothing was changed.';
  end if;
end
$guard$;

alter table public.xero_config add column if not exists auto_bills boolean not null default false;
alter table public.xero_config add column if not exists auto_bills_since timestamptz;

create or replace function public.xero_auto_bills_post() returns void
language plpgsql security definer set search_path = public as $$
declare
  loc record;
  doc record;
  key text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  if key is null then return; end if;
  for loc in
    select c.location_id, g.auto_bills_since
    from public.xero_connections c
    join public.xero_config g on g.location_id = c.location_id
    where g.auto_bills = true and g.auto_bills_since is not null
  loop
    -- Posted supplier invoices with no ok row: never sent, or refused and due another try.
    for doc in
      select i.id
      from public.supplier_invoices i
      left join public.xero_sync_log s
        on s.location_id = i.location_id and s.kind = 'bill' and s.ref_id = i.id::text
      where i.location_id = loc.location_id
        and upper(coalesce(i.status, '')) = 'POSTED'
        and coalesce(i.posted_at, i.approved_at, i.updated_at) >= loc.auto_bills_since
        and (s.id is null
             or (s.status = 'error' and s.updated_at < now() - interval '2 hours'
                 and coalesce(jsonb_array_length(s.detail -> 'history'), 1) < 6)
             or (s.status = 'sending' and s.updated_at < now() - interval '30 minutes'))
      order by coalesce(i.posted_at, i.approved_at, i.updated_at)
      limit 20
    loop
      perform net.http_post(
        url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-bills',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
        body    := jsonb_build_object('locationId', loc.location_id, 'invoiceId', doc.id, 'auto', true)
      );
    end loop;
    -- Credit notes added since the switch went on, the same way.
    for doc in
      select n.id
      from public.stock_credit_notes n
      left join public.xero_sync_log s
        on s.location_id = n.location_id and s.kind = 'credit_note' and s.ref_id = n.id::text
      where n.location_id = loc.location_id
        and n.created_at >= loc.auto_bills_since
        and (s.id is null
             or (s.status = 'error' and s.updated_at < now() - interval '2 hours'
                 and coalesce(jsonb_array_length(s.detail -> 'history'), 1) < 6)
             or (s.status = 'sending' and s.updated_at < now() - interval '30 minutes'))
      order by n.created_at
      limit 20
    loop
      perform net.http_post(
        url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-bills',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
        body    := jsonb_build_object('action', 'credit_note', 'locationId', loc.location_id, 'noteId', doc.id, 'auto', true)
      );
    end loop;
  end loop;
end $$;

revoke all on function public.xero_auto_bills_post() from public, anon, authenticated;

do $$ begin perform cron.unschedule('xero-auto-bills'); exception when others then null; end $$;
select cron.schedule('xero-auto-bills', '*/15 * * * *', $$select public.xero_auto_bills_post()$$);

notify pgrst, 'reload schema';

-- VISIBLE CHECK: two columns and the job at '*/15 * * * *'.
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'xero_config' and column_name in ('auto_bills', 'auto_bills_since')) as columns_added,
       (select schedule from cron.job where jobname = 'xero-auto-bills') as job_schedule;
