-- 20260919n_OPS_closed_checks_tenders.sql  (Ops DB tbetcegmszzotrwdtqhi)  v5.9.11
--
-- 1. closed_checks.tenders: what paid each check, one entry per tender,
--      [{ "method": "card", "amount": 20.00, "tip": 2.00, "psp_ref": "...", "processor": "adyen" },
--       { "method": "cash", "amount": 10.00, "tip": 0 }]
--    amount = bill money on that tender, tip = gratuity on it, both in major units like the
--    other money columns. Written by every till and web checkout from v5.9.11 (src/lib/accounting/
--    tenders.js). NULL on older rows: the accounting layer falls back to the method column,
--    and an older split bill posts to Unallocated. No backfill: the old rows never stored the
--    split, so there is nothing true to backfill from.
--    Safe before the app update: nothing reads it yet. Safe after: every writer drops the key
--    and retries if the column is missing, so no sale is lost either way round.
--
-- 2. The Xero nightly post runs HOURLY and lets xero-sales pick the day. The function now books
--    each venue's last COMPLETED business day on the venue's own clock (time zone + business
--    day start) and ignores the UTC date this job sends (kept only so the file is safe to run
--    before or after the function deploy). Hourly means every venue's day posts about four
--    hours after it closes (the grace lets offline tills catch up), whatever its time zone. A
--    day that is already posted returns at once without touching Xero; days with no sales post
--    nothing. The first business day after the last day the old code posted starts where that
--    UTC day ended, so the change over neither misses nor repeats any trade.
--
-- Bare, idempotent statements, no transaction block (the SQL editor chokes on begin/commit).

alter table public.closed_checks add column if not exists tenders jsonb;

comment on column public.closed_checks.tenders is
  'v5.9.11: what paid the check, [{method, amount, tip, gift_card_id?, psp_ref?, processor?}] in major units; amount = bill money, tip = gratuity on that tender. Lists every tender incl. gift card, booking credit and loyalty/promo credit. NULL = written before v5.9.11 (fall back to method).';

create or replace function public.xero_nightly_post() returns void
language plpgsql security definer set search_path = public as $$
declare
  loc record;
  key text;
begin
  select decrypted_secret into key from vault.decrypted_secrets where name = 'xero_cron_key' limit 1;
  if key is null then return; end if;
  for loc in
    select c.location_id
    from public.xero_connections c
    join public.xero_config g on g.location_id = c.location_id
    where g.auto_daily = true
  loop
    -- xero-sales v5.9.11+ IGNORES this date when auto is true and books the venue's last
    -- completed business day itself. The date stays only so this file is safe to run BEFORE
    -- the new function is deployed: the old function, given no date, would post today's
    -- unfinished UTC day and lock the rest of it out.
    perform net.http_post(
      url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/xero-sales',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
      body    := jsonb_build_object(
        'locationId', loc.location_id,
        'date', to_char((now() at time zone 'utc')::date - 1, 'YYYY-MM-DD'),
        'auto', true
      )
    );
  end loop;
end $$;

revoke all on function public.xero_nightly_post() from public, anon, authenticated;

do $$ begin perform cron.unschedule('xero-nightly-sales'); exception when others then null; end $$;
select cron.schedule('xero-nightly-sales', '10 * * * *', $$select public.xero_nightly_post()$$);

-- Check (should list the column, then the job at '10 * * * *'):
--   select column_name, data_type from information_schema.columns where table_name = 'closed_checks' and column_name = 'tenders';
--   select jobname, schedule from cron.job where jobname = 'xero-nightly-sales';
