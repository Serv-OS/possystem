-- ─────────────────────────────────────────────────────────────────────────────
-- 20260729_terminal_jobs_ryft_settle.sql   (OPS DB)
--
-- Ryft slice 2: settlement becomes PROCESSOR-VERIFIED.
--
-- Until now a REAL job was settled by terminal_report_result — i.e. by whatever
-- the device claimed. That was the honest best available while the charge path
-- was device-side (app-to-app G8). The real charge path (terminal-job-charge,
-- slice 3) initiates at Ryft server-side and can ASK Ryft what happened, so the
-- device is demoted to a witness:
--
--   * ONE settlement writer: terminal_job_settle_from_processor() is the ONLY
--     code that flips a real job to approved/declined/cancelled. The verify
--     action (terminal-job-charge 'result'), the webhook (slice 4) and the
--     sweeper (slice 6) all call it — so two writers can never drift.
--   * terminal_report_result: for real jobs, approved/declined become an
--     advisory CLAIM (recorded, compared, never trusted, never settling).
--     cancelled/unknown stay device-authoritative — the processor never sees a
--     never-initiated sale. SIMULATED jobs keep the full old settle path so
--     bench builds still complete end-to-end.
--   * terminal_job_sent: the charging transition is owned by terminal-job-charge
--     now; the app's markDispatched ping that arrives after it is an idempotent
--     ack, not a failure.
--
-- New columns:
--   payment_session_id  the Ryft ps_… this job initiated. UNIQUE while present —
--                       one session can never settle two jobs.
--   account_id          the Ryft sub-account the session lives under (needed to
--                       read the session back with the Account header).
--   verified_source     who proved the outcome: 'session' | 'webhook' | 'sweeper'.
--   verified_at         when.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ═══ 1. Columns + one-session-one-job index ══════════════════════════════════

alter table terminal_jobs add column if not exists payment_session_id text;
alter table terminal_jobs add column if not exists account_id         text;
alter table terminal_jobs add column if not exists verified_source    text;
alter table terminal_jobs add column if not exists verified_at        timestamptz;

create unique index if not exists idx_tj_payment_session
  on terminal_jobs (payment_session_id) where payment_session_id is not null;


-- ═══ 2. terminal_job_settle_from_processor — the ONE settlement writer ═══════
-- service_role only (same fence as terminal_jobs_sweep — the JWT role is
-- re-checked in the DB, so a leaked anon token can never assert an outcome).
--
-- TRANSITION TABLE (row = job status, column = p_outcome):
--
--                       approved            declined            cancelled
--   charging_unsent     settle¹             settle              settle² (needs no psId)
--   charging            settle¹             settle              REFUSED
--   unknown             settle¹ + clears    settle + clears     REFUSED
--                       needs_human³        needs_human³
--   pending/claimed/
--   tipping             REFUSED (never priced — a processor outcome is impossible)
--   approved/declined/
--   cancelled/expired/
--   reconciled          { ok:true, idempotent:true } — settled rows are immutable
--
--   ¹ amount cross-check: p_session_amount_minor ≠ charge_minor → settles but
--     parks needs_human with the discrepancy in last_error (server money wins).
--   ² 'cancelled' is only believed when it is PROVABLY never-initiated:
--     status='charging_unsent' AND no payment_session_id anywhere (stored or
--     supplied). Anything else may have money moving — refuse; the sweeper's
--     evidence-based cancel (slice 6) will carry its own proof.
--   ³ a clean processor verdict on an 'unknown' row is exactly the recovery the
--     quarantine was waiting for — clear the flag; a dirty one keeps it.
--
-- payment_session_id is backfilled (coalesce) on settle AND on the idempotent
-- guard, so a webhook that matched by metadata.terminal_job_id still leaves the
-- ledger joinable.
create or replace function terminal_job_settle_from_processor(
  p_job_id               uuid,
  p_outcome              text,
  p_payment_session_id   text    default null,
  p_transaction_id       text    default null,
  p_auth_code            text    default null,
  p_card                 jsonb   default null,
  p_decline_reason       text    default null,
  p_source               text    default 'session',
  p_session_amount_minor bigint  default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  j       terminal_jobs;
  v_out   text;
  v_human boolean := false;
  v_final_human boolean;
  v_err   text;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;

  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled') then
    raise exception 'invalid outcome %', p_outcome;
  end if;
  if coalesce(btrim(p_source), '') = '' then
    raise exception 'p_source required';
  end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;

  -- Idempotent guard: settled rows are immutable. Device replays, late webhooks
  -- and a lost race between verify/webhook/sweeper all land here harmlessly.
  -- Still backfill a missing psId so the ledger stays joinable.
  if j.status in ('approved','declined','cancelled','expired','reconciled') then
    if j.payment_session_id is null and p_payment_session_id is not null then
      update terminal_jobs
         set payment_session_id = p_payment_session_id, updated_at = now()
       where id = j.id;
    end if;
    return jsonb_build_object('ok', true, 'idempotent', true, 'status', j.status);
  end if;

  -- Status gate: only rows that could have reached the processor.
  if j.status not in ('charging_unsent','charging','unknown') then
    return jsonb_build_object('ok', false, 'status', j.status,
      'reason', format('job is %s — a processor outcome is not possible here', j.status));
  end if;

  -- 'cancelled' must be PROVABLY never-initiated (see the transition table).
  if v_out = 'cancelled'
     and not (j.status = 'charging_unsent'
              and j.payment_session_id is null
              and p_payment_session_id is null) then
    return jsonb_build_object('ok', false, 'status', j.status,
      'reason', 'cancelled requires charging_unsent with no payment session — the card may have been charged');
  end if;

  -- A settle citing a DIFFERENT session than the one this job initiated is a
  -- wiring fault, not a verdict conflict to swallow: settle (the processor did
  -- speak) but park it and keep OUR stored psId.
  if j.payment_session_id is not null and p_payment_session_id is not null
     and j.payment_session_id <> p_payment_session_id then
    v_human := true;
    v_err := format('payment session mismatch: job holds %s, settle cited %s',
                    j.payment_session_id, p_payment_session_id);
  end if;

  -- Server computed the money; the processor's captured amount must agree.
  if v_out = 'approved' and p_session_amount_minor is not null
     and j.charge_minor is not null and p_session_amount_minor <> j.charge_minor then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '')
             || format('amount mismatch: processor %s vs server %s',
                       p_session_amount_minor, j.charge_minor);
  end if;

  v_final_human := case when v_human then true
                        when j.status = 'unknown' then false   -- clean recovery clears the quarantine
                        else j.needs_human end;

  update terminal_jobs
     set status             = v_out,
         transaction_id     = coalesce(p_transaction_id, transaction_id),
         auth_code          = coalesce(p_auth_code, auth_code),
         card               = coalesce(p_card, card),
         decline_reason     = coalesce(p_decline_reason, decline_reason),
         payment_session_id = coalesce(payment_session_id, p_payment_session_id),
         verified_source    = p_source,
         verified_at        = now(),
         needs_human        = v_final_human,
         last_error         = coalesce(v_err, last_error),
         settled_at         = now(),
         updated_at         = now()
   where id = j.id;

  return jsonb_build_object('ok', true, 'status', v_out, 'needs_human', v_final_human);
end; $$;


-- ═══ 3. terminal_report_result — the device becomes a witness ════════════════
-- Exact re-issue of the CURRENT live version (20260727 § 2, the one WITH the
-- chargeless-approval hardening) changing ONLY the settle semantics:
--   * real (simulated=false) jobs, approved/declined: record the claim
--     (reported_minor / transaction_id / auth_code / card), keep every
--     needs_human check, DO NOT touch status/settled_at → { ok, recorded:true }.
--   * simulated=true keeps the full old settle path (bench builds end-to-end).
--   * cancelled / unknown semantics byte-identical (pre-dispatch cancels stay
--     device-authoritative; cancelled-while-charging still coerces to unknown).
create or replace function terminal_report_result(
  p_job_id         uuid,
  p_status         text,
  p_transaction_id text default null,
  p_auth_code      text default null,
  p_card           jsonb default null,
  p_reported_minor bigint default null,
  p_decline_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; j terminal_jobs; v_status text; v_human boolean := false; v_err text;
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
    v_err := 'device reported cancelled after dispatch — outcome not established';
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
  -- have moved for an amount the server never authorised — park it for a human instead
  -- of letting it strand with needs_human=false, invisible to every queue.
  if v_status = 'approved' and j.charge_minor is null then
    v_human := true;
    v_err := coalesce(v_err || ' / ', '') || 'approved with no server charge amount — investigate before closing';
  end if;

  -- Ryft slice 2: on a REAL job the device's approved/declined is an advisory
  -- CLAIM. Settlement is exclusively processor-verified via
  -- terminal_job_settle_from_processor (verify action / webhook / sweeper) —
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

  return jsonb_build_object('ok', true);
end; $$;


-- ═══ 4. terminal_job_sent — tolerate the edge fn owning the transition ═══════
-- terminal-job-charge (slice 3) performs charging_unsent→charging itself as its
-- CAS write-ahead, so the app's markDispatched ping now usually arrives to find
-- the job ALREADY 'charging'. That is success, not failure — old APKs keep
-- retrying jobSent three times on { ok:false }, and those retries are noise.
create or replace function terminal_job_sent(p_job_id uuid, p_transaction_id text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t terminal_devices; v_n integer; v_status text;
begin
  t := _terminal_for_caller();
  update terminal_jobs
     set status = 'charging',
         transaction_id = coalesce(p_transaction_id, transaction_id),
         updated_at = now()
   where id = p_job_id and target_terminal_id = t.id and status = 'charging_unsent';
  get diagnostics v_n = row_count;
  if v_n = 1 then return jsonb_build_object('ok', true); end if;

  select status into v_status from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id;
  if v_status = 'charging' then
    return jsonb_build_object('ok', true, 'idempotent', true);
  end if;
  return jsonb_build_object('ok', v_n = 1);
end; $$;


-- ═══ Grants — match 20260722c ════════════════════════════════════════════════
-- terminal_report_result / terminal_job_sent: CREATE OR REPLACE preserves the
-- existing grants (anon, authenticated). The new settle RPC is sweeper-class:
-- no client grant at all, and the function re-checks the JWT role anyway.
revoke execute on function terminal_job_settle_from_processor(uuid, text, text, text, text, jsonb, text, text, bigint) from public;
grant  execute on function terminal_job_settle_from_processor(uuid, text, text, text, text, jsonb, text, text, bigint) to service_role;

commit;


-- ── CHECK ───────────────────────────────────────────────────────────────────
-- Pure-SQL harness against the REAL tables, entirely inside a rolled-back
-- transaction — nothing it seeds survives. It simulates identities the same way
-- PostgREST does (request.jwt.claims), covering:
--   settle: approved/declined from charging + charging_unsent, amount mismatch,
--           idempotent guard, cancelled-requires-no-psId, unknown clean
--           recovery clears needs_human, psId backfill, status gate, role fence.
--   report: real approved = claim only (status untouched), mismatch flags,
--           simulated still settles, cancelled-while-charging → unknown.
--   sent:   charging_unsent→charging, then { ok, idempotent } replay.
-- Each live job gets its OWN terminal row (idx_tj_one_live_per_terminal allows
-- only one live job per terminal). ASSERT failures abort loudly.
begin;

-- Harness helpers. pg_temp.* — session-local, and the whole transaction rolls
-- back anyway. (plpgsql has no nested procedures, hence temp functions.)
create function pg_temp.hx_seed(p_uid uuid, p_loc uuid, p_job uuid, p_status text,
                                p_simulated boolean default false, p_ps text default null)
returns uuid language plpgsql as $hx$
declare v_term uuid;
begin
  insert into terminal_devices (id, device_uid, serial_number, location_id, status, active, last_seen_at)
  values (gen_random_uuid(), p_uid, 'HARNESS-' || left(p_uid::text, 8), p_loc, 'paired', true, now())
  returning id into v_term;
  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, training,
    tip_basis_minor, due_minor, tip_minor, charge_minor, currency,
    tip_config, closed_check_id, check_draft, status, processor, simulated,
    payment_session_id, needs_human,
    claim_expires_at, dispatched_at, charged_at
  ) values (
    p_job, p_loc::text || ':T-' || left(p_job::text, 8) || ':s1', p_loc, v_term, false,
    1000, 1000, 250, 1250, 'GBP',
    '{"enabled":false}'::jsonb, 'chk-harness-' || left(p_job::text, 8),
    '{"source":"harness"}'::jsonb, p_status, 'ryft', p_simulated,
    p_ps, (p_status = 'unknown'),
    now() + interval '5 minutes', now(), now()
  );
  return v_term;
end; $hx$;

-- Simulate a PostgREST identity: the same GUCs auth.uid() / _terminal_is_service_role() read.
create function pg_temp.hx_as_device(p_uid uuid) returns void language plpgsql as $hx$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end; $hx$;

create function pg_temp.hx_as_service() returns void language plpgsql as $hx$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
end; $hx$;

do $chk$
declare
  v_loc  uuid := gen_random_uuid();
  v_res  jsonb;
  j      terminal_jobs;
  -- one device_uid + terminal + job per scenario (idx_tj_one_live_per_terminal
  -- allows only one live job per terminal)
  u1 uuid := gen_random_uuid(); j1 uuid := gen_random_uuid();  -- charging, clean approve
  u2 uuid := gen_random_uuid(); j2 uuid := gen_random_uuid();  -- charging, amount mismatch
  u3 uuid := gen_random_uuid(); j3 uuid := gen_random_uuid();  -- charging, declined
  u4 uuid := gen_random_uuid(); j4 uuid := gen_random_uuid();  -- charging_unsent no psId → cancelled OK
  u5 uuid := gen_random_uuid(); j5 uuid := gen_random_uuid();  -- charging_unsent WITH psId → cancelled refused
  u6 uuid := gen_random_uuid(); j6 uuid := gen_random_uuid();  -- unknown, clean recovery
  u7 uuid := gen_random_uuid(); j7 uuid := gen_random_uuid();  -- tipping → status gate refusal
  u8 uuid := gen_random_uuid(); j8 uuid := gen_random_uuid();  -- real charging: report=claim, then settle
  u9 uuid := gen_random_uuid(); j9 uuid := gen_random_uuid();  -- simulated charging: report still settles
  uA uuid := gen_random_uuid(); jA uuid := gen_random_uuid();  -- real charging: cancelled → unknown coercion
  uB uuid := gen_random_uuid(); jB uuid := gen_random_uuid();  -- charging_unsent: job_sent + idempotent replay
begin
  perform pg_temp.hx_seed(u1, v_loc, j1, 'charging', false, 'ps_chk_1');
  perform pg_temp.hx_seed(u2, v_loc, j2, 'charging', false, 'ps_chk_2');
  perform pg_temp.hx_seed(u3, v_loc, j3, 'charging', false, 'ps_chk_3');
  perform pg_temp.hx_seed(u4, v_loc, j4, 'charging_unsent');
  perform pg_temp.hx_seed(u5, v_loc, j5, 'charging_unsent', false, 'ps_chk_5');
  perform pg_temp.hx_seed(u6, v_loc, j6, 'unknown', false, 'ps_chk_6');
  perform pg_temp.hx_seed(u7, v_loc, j7, 'tipping');
  perform pg_temp.hx_seed(u8, v_loc, j8, 'charging');            -- no psId yet: tests backfill too
  perform pg_temp.hx_seed(u9, v_loc, j9, 'charging', true, 'ps_chk_9');
  perform pg_temp.hx_seed(uA, v_loc, jA, 'charging', false, 'ps_chk_A');
  perform pg_temp.hx_seed(uB, v_loc, jB, 'charging_unsent');

  -- ── settle RPC: role fence ────────────────────────────────────────────────
  perform pg_temp.hx_as_device(u1);
  begin
    perform terminal_job_settle_from_processor(j1, 'approved');
    raise exception 'FENCE FAILED: non-service-role settled a job';
  exception when others then
    if sqlerrm like '%FENCE FAILED%' then raise; end if;  -- expected: 'service role required'
  end;

  perform pg_temp.hx_as_service();

  -- ── 1. clean approve from charging ────────────────────────────────────────
  v_res := terminal_job_settle_from_processor(j1, 'approved', 'ps_chk_1', 'txn_1', 'AUTH01',
             '{"brand":"visa","last4":"4242"}'::jsonb, null, 'session', 1250);
  select * into j from terminal_jobs where id = j1;
  assert (v_res ->> 'ok')::boolean, 'settle 1 not ok';
  assert j.status = 'approved',                    'settle 1: status';
  assert j.verified_source = 'session',            'settle 1: verified_source';
  assert j.verified_at is not null,                'settle 1: verified_at';
  assert j.settled_at is not null,                 'settle 1: settled_at';
  assert not j.needs_human,                        'settle 1: needs_human should be false';
  assert j.auth_code = 'AUTH01',                   'settle 1: auth_code';

  -- ── 2. idempotent guard on a settled row ──────────────────────────────────
  v_res := terminal_job_settle_from_processor(j1, 'declined', 'ps_chk_1');
  assert (v_res ->> 'idempotent')::boolean,        'settle 2: not idempotent';
  select * into j from terminal_jobs where id = j1;
  assert j.status = 'approved',                    'settle 2: settled row mutated';

  -- ── 3. amount mismatch settles but parks ──────────────────────────────────
  v_res := terminal_job_settle_from_processor(j2, 'approved', 'ps_chk_2', null, null, null, null, 'session', 9999);
  select * into j from terminal_jobs where id = j2;
  assert j.status = 'approved' and j.needs_human,  'settle 3: mismatch must settle + park';
  assert j.last_error like '%amount mismatch%',    'settle 3: last_error';

  -- ── 4. declined from charging ─────────────────────────────────────────────
  v_res := terminal_job_settle_from_processor(j3, 'declined', 'ps_chk_3', null, null, null, 'insufficient_funds', 'session', null);
  select * into j from terminal_jobs where id = j3;
  assert j.status = 'declined' and j.decline_reason = 'insufficient_funds', 'settle 4: declined';

  -- ── 5. cancelled: allowed ONLY charging_unsent + no psId ─────────────────
  v_res := terminal_job_settle_from_processor(j4, 'cancelled');
  select * into j from terminal_jobs where id = j4;
  assert j.status = 'cancelled',                   'settle 5a: clean cancel refused';
  v_res := terminal_job_settle_from_processor(j5, 'cancelled');
  assert not (v_res ->> 'ok')::boolean,            'settle 5b: cancel with psId must refuse';
  select * into j from terminal_jobs where id = j5;
  assert j.status = 'charging_unsent',             'settle 5b: row mutated';

  -- ── 6. clean recovery of an unknown clears needs_human ────────────────────
  v_res := terminal_job_settle_from_processor(j6, 'approved', 'ps_chk_6', null, null, null, null, 'sweeper', 1250);
  select * into j from terminal_jobs where id = j6;
  assert j.status = 'approved' and not j.needs_human, 'settle 6: unknown clean recovery must clear needs_human';
  assert j.verified_source = 'sweeper',            'settle 6: verified_source';

  -- ── 7. status gate: tipping is not settleable ─────────────────────────────
  v_res := terminal_job_settle_from_processor(j7, 'approved');
  assert not (v_res ->> 'ok')::boolean,            'settle 7: tipping must refuse';
  select * into j from terminal_jobs where id = j7;
  assert j.status = 'tipping',                     'settle 7: row mutated';

  -- ── 8. REAL job: device approved = claim only, then processor settles ─────
  perform pg_temp.hx_as_device(u8);
  v_res := terminal_report_result(j8, 'approved', 'txn_dev', 'AUTHD1', '{"last4":"1111"}'::jsonb, 1250, null);
  assert (v_res ->> 'recorded')::boolean,          'report 8: expected recorded:true';
  select * into j from terminal_jobs where id = j8;
  assert j.status = 'charging',                    'report 8: device claim must NOT settle';
  assert j.reported_minor = 1250,                  'report 8: claim not recorded';
  assert j.settled_at is null,                     'report 8: settled_at must stay null';
  perform pg_temp.hx_as_service();
  v_res := terminal_job_settle_from_processor(j8, 'approved', 'ps_chk_8', 'txn_8', null, null, null, 'webhook', 1250);
  select * into j from terminal_jobs where id = j8;
  assert j.status = 'approved',                    'settle 8: post-claim settle';
  assert j.payment_session_id = 'ps_chk_8',        'settle 8: psId backfill';
  assert j.verified_source = 'webhook',            'settle 8: verified_source';

  -- ── 9. SIMULATED job: old settle path intact ──────────────────────────────
  perform pg_temp.hx_as_device(u9);
  v_res := terminal_report_result(j9, 'approved', 'SIM-txn', null, null, 1250, null);
  select * into j from terminal_jobs where id = j9;
  assert j.status = 'approved' and j.settled_at is not null, 'report 9: simulated must settle';

  -- ── A. real cancelled-while-charging still coerces to unknown ─────────────
  perform pg_temp.hx_as_device(uA);
  v_res := terminal_report_result(jA, 'cancelled');
  select * into j from terminal_jobs where id = jA;
  assert j.status = 'unknown' and j.needs_human,   'report A: cancel-after-dispatch must quarantine';

  -- ── B. terminal_job_sent: transition then idempotent replay ───────────────
  perform pg_temp.hx_as_device(uB);
  v_res := terminal_job_sent(jB);
  assert (v_res ->> 'ok')::boolean and (v_res -> 'idempotent') is null, 'sent B1: first call';
  select * into j from terminal_jobs where id = jB;
  assert j.status = 'charging',                    'sent B1: status';
  v_res := terminal_job_sent(jB);
  assert (v_res ->> 'ok')::boolean and (v_res ->> 'idempotent')::boolean, 'sent B2: replay must be { ok, idempotent }';

  raise notice 'terminal_jobs_ryft_settle CHECK: all assertions passed';
end
$chk$;

rollback;
