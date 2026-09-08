-- v5.7.5 - TIP ON PRINTED RECEIPT (United States signature tip flow) - OPS DB tbetcegmszzotrwdtqhi
-- HAND-APPLY (production DDL is blocked for tooling): pbcopy < this file, then the SQL editor.
--
-- The flow: a main-POS Adyen card sale at a venue with pos_settings.tip_on_receipt.enabled
-- authorises WITHOUT capturing (authorisationType=PreAuth + manualCapture=true in
-- SaleToAcquirerData). Staff print a merchant slip, the guest writes a tip, staff enter it
-- later from Check History (adyen-modify action 'tip_capture'). Capture happens at
-- auth + tip. If nobody enters a tip before the venue's capture window closes, the
-- adyen-capture-sweep edge function captures at the ORIGINAL amount, so a forgotten tip
-- loses the tip, never the sale.
--
-- Everything here is additive. Safe while traffic flows.

begin;

-- 1. terminal_jobs.capture_mode: 'manual' = do not capture at auth; null = capture as today.
--    Stamped by terminal-job-create when the venue setting is on, the processor is Adyen,
--    the create call carries surface:'pos', and the job is a sale (bar-tab holds have no
--    job row so they can never be stamped).
alter table public.terminal_jobs
  add column if not exists capture_mode text;

-- 2. The capture ledger. One row per manual-capture authorisation; the sweep, the webhook
--    and adyen-modify tip_capture all key on it.
--    status walk: pending -> (adjusting ->) capturing -> captured
--                 pending -> failed (CAPTURE_FAILED webhook) / expired (auth provably dead)
--                 cancelled is reserved for a voided sale.
create table if not exists public.terminal_captures (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid,
  closed_check_id  text,
  location_id      uuid not null,
  psp_reference    text not null unique,
  merchant_account text,
  currency         text,
  auth_minor       bigint not null,
  tip_minor        bigint,
  final_minor      bigint,
  status           text not null default 'pending'
                   check (status in ('pending','adjusting','capturing','captured','failed','expired','cancelled')),
  -- attempts is the CAS token every claimant bumps (adyen-modify tip_capture,
  -- the webhook's post-adjust capture kick, the capture sweep): read the row,
  -- update ... eq(status, prior).eq(attempts, read) - zero rows = lost the
  -- race. It also salts every Adyen Idempotency-Key (tipcap:<id>:<amt>:<n>),
  -- so a RETRY is a fresh key while a RETRANSMIT of the same attempt replays.
  attempts         integer not null default 0,
  deadline_at      timestamptz not null,
  error            text,
  simulated        boolean not null default false,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Re-run safety: an earlier apply of this file without the column gets it here.
alter table public.terminal_captures
  add column if not exists attempts integer not null default 0;

create index if not exists idx_tc_status_deadline on public.terminal_captures (status, deadline_at);
create index if not exists idx_tc_location_status on public.terminal_captures (location_id, status);
create index if not exists idx_tc_job on public.terminal_captures (job_id);

-- RLS: location members may read (Back Office / History views); ALL writes are
-- service-role only (edge functions + the RPC below), so no write policy exists.
alter table public.terminal_captures enable row level security;

drop policy if exists tc_select_members on public.terminal_captures;
create policy tc_select_members on public.terminal_captures
  for select using (
    location_id in (select ul.location_id from public.user_locations ul where ul.user_id = auth.uid())
    or exists (select 1 from public.user_profiles up
                where up.id = auth.uid() and up.role = 'super_admin')
  );

-- 3. terminal_report_result: exact re-issue of the CURRENT live version
--    (20260729_terminal_jobs_ryft_settle.sql section 3) adding ONE thing at the very
--    end of the old settle path: a SIMULATED job with capture_mode='manual' that
--    settles approved inserts its terminal_captures row here, because the demo
--    reader's settle is this RPC (real Adyen jobs get their row from
--    adyen-terminal-charge's settleFromResponse instead). Every other byte of
--    behaviour is preserved.
create or replace function public.terminal_report_result(
  p_job_id         uuid,
  p_status         text,
  p_transaction_id text default null,
  p_auth_code      text default null,
  p_card           jsonb default null,
  p_reported_minor bigint default null,
  p_decline_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t terminal_devices; j terminal_jobs; v_status text; v_human boolean := false; v_err text;
  v_hours numeric;
begin
  t := _terminal_for_caller();

  v_status := lower(btrim(coalesce(p_status, '')));
  if v_status not in ('approved','declined','cancelled','unknown') then
    raise exception 'invalid result status %', p_status;
  end if;

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.status in ('approved','declined','cancelled','expired','reconciled') then
    return jsonb_build_object('ok', true, 'idempotent', true);   -- already settled
  end if;

  -- A cancel we cannot prove is deterministic becomes an unknown.
  if v_status = 'cancelled' and j.status = 'charging' then
    v_status := 'unknown';
    v_err := 'device reported cancelled after dispatch - outcome not established';
  end if;

  if v_status = 'unknown' then v_human := true; end if;

  -- Server computed the money; the device only reports it. Any disagreement stops
  -- the check closing until a human looks.
  if v_status = 'approved' and p_reported_minor is not null
     and j.charge_minor is not null and p_reported_minor <> j.charge_minor then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || format('amount mismatch: device %s vs server %s',
                                                    p_reported_minor, j.charge_minor);
  end if;

  -- v5.5.846: an approval with NO server charge should be impossible (terminal_commit_tip
  -- is the only path that prices a job). If a device claims approved anyway, money may
  -- have moved for an amount the server never authorised - park it for a human instead
  -- of letting it strand with needs_human=false, invisible to every queue.
  if v_status = 'approved' and j.charge_minor is null then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || 'approved with no server charge amount - investigate before closing';
  end if;

  -- Ryft slice 2: on a REAL job the device's approved/declined is an advisory
  -- CLAIM. Settlement is exclusively processor-verified via
  -- terminal_job_settle_from_processor (verify action / webhook / sweeper) -
  -- status and settled_at are deliberately untouched here. cancelled/unknown
  -- fall through to the old settle path (the processor never sees a
  -- never-initiated sale, and 'unknown' is the sweeper's input), and so do
  -- SIMULATED jobs (no processor exists to verify a bench sale).
  if (not j.simulated) and v_status in ('approved','declined') then
    update terminal_jobs
       set transaction_id = coalesce(p_transaction_id, transaction_id),
           auth_code      = coalesce(p_auth_code, auth_code),
           card           = coalesce(p_card, card),
           reported_minor = coalesce(p_reported_minor, reported_minor),
           decline_reason = coalesce(p_decline_reason, decline_reason),
           needs_human    = needs_human or v_human,
           last_error     = coalesce(v_err, last_error),
           updated_at     = now()
     where id = j.id;
    return jsonb_build_object('ok', true, 'recorded', true);
  end if;

  update terminal_jobs
     set status         = v_status,
         transaction_id = coalesce(p_transaction_id, transaction_id),
         auth_code      = coalesce(p_auth_code, auth_code),
         card           = coalesce(p_card, card),
         reported_minor = coalesce(p_reported_minor, reported_minor),
         decline_reason = coalesce(p_decline_reason, decline_reason),
         needs_human    = needs_human or v_human,
         last_error     = coalesce(v_err, last_error),
         settled_at     = now(),
         updated_at     = now()
   where id = j.id;

  -- v5.7.5 TIP ON RECEIPT (the ONLY addition): a simulated manual-capture job that just
  -- settled approved gets its capture-ledger row, mirroring what settleFromResponse does
  -- for real Adyen jobs. Demo mirrors the whole flow: the row is simulated=true, so
  -- tip_capture and the sweep short-circuit it before anything could reach Adyen.
  if j.simulated and j.capture_mode = 'manual' and v_status = 'approved' then
    begin
      select greatest(1, least(72, coalesce(
               nullif(l.pos_settings->'tip_on_receipt'->>'capture_hours', '')::numeric, 24)))
        into v_hours
        from public.locations l where l.id = j.location_id;
    exception when others then v_hours := 24;
    end;
    v_hours := coalesce(v_hours, 24);
    insert into public.terminal_captures
      (job_id, closed_check_id, location_id, psp_reference, currency, auth_minor,
       status, deadline_at, simulated)
    values
      (j.id, j.closed_check_id, j.location_id, 'DEMO-CAP-' || j.id::text,
       coalesce(j.currency, 'GBP'),
       coalesce(j.charge_minor, p_reported_minor, 0),
       'pending', now() + make_interval(hours => v_hours::int), true)
    on conflict (psp_reference) do nothing;
  end if;

  return jsonb_build_object('ok', true);
end; $$;

-- 4. pg_cron: run the capture sweep every 30 minutes. pg_cron + pg_net are installed on
--    ops (verified live 19 Aug: pg_cron 1.6.4, pg_net 0.20.0). Idempotent: unschedule
--    any existing job of the same name first. The x-sweep-token below is the shared
--    secret the edge function checks (set the same value as the ADYEN_SWEEP_TOKEN
--    Supabase secret before or right after applying this).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'adyen-capture-sweep') then
    perform cron.unschedule('adyen-capture-sweep');
  end if;
end $$;

select cron.schedule(
  'adyen-capture-sweep',
  '*/30 * * * *',
  $cron$
  select net.http_post(
    url     := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/adyen-capture-sweep',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', '9eea2e409e99a03ac980d4ef42845cba0c46c3d9a801b136'),
    timeout_milliseconds := 25000
  )
  $cron$
);

commit;
