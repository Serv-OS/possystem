-- paid_minor becomes a TRIGGER-maintained projection (15 Aug, live defect).
--
-- 20260815b published active_sessions.paid_minor from ONE branch of ONE edge
-- function. Live result today, twice: T3's £20 leg and T4's £20 leg both settled
-- and reconciled perfectly, the RPC's own maths stayed right (the final legs were
-- correctly due 6833 and 4035, because terminal_start_table_payment_for
-- recomputes from _terminal_paid_legs_for rather than reading the column) — and
-- paid_minor never left 0. So neither the reader nor the till ever showed the
-- part payment, which is exactly what the owner reported: "paying £1 off table 10
-- then it not showing it been deducted either on the reader or on the POS".
--
-- Three reasons that placement was wrong, not just unlucky:
--   • terminal_job_settle_from_processor is "the ONE settlement writer" and has
--     five callers, plus the device report path and the sweeper. Two of them
--     published paid state; every other route leaves the column stale forever.
--   • edge functions deploy MANUALLY and drift silently (the block sat undeployed
--     for hours today while every other symptom looked fine).
--   • the call sites read `.rpc(...).then(ok, err)`. supabase-js RESOLVES with
--     {data, error} and does not reject, so that error handler is dead code — a
--     failing publish logged NOTHING, which is why this survived three rounds of
--     debugging.
--
-- paid_minor is a pure projection of the approved/reconciled adyen_pay_at_table
-- legs of one occupation. Derive it where the fact is written: in the same
-- transaction as the status flip. Skip-proof, deploy-proof, and idempotent
-- because it RECOMPUTES rather than increments.
begin;

-- Fenceless core. The trigger fires under whatever identity settled the job —
-- including a POS device (role `authenticated`) calling terminal_pos_mark_
-- reconciled — so it must NOT go through terminal_sync_table_paid's
-- _terminal_is_service_role() check. A raising trigger there would abort the
-- close and strand money, which is far worse than a stale display.
create or replace function _terminal_publish_paid(p_job terminal_jobs)
returns void
language plpgsql security definer set search_path = public as $$
declare
  d      jsonb := coalesce(p_job.check_draft, '{}'::jsonb);
  v_paid bigint;
  v_legs jsonb;
begin
  if d ->> 'source' is distinct from 'adyen_pay_at_table' or d ->> 'tableId' is null then
    return;
  end if;
  select paid, legs into v_paid, v_legs
    from _terminal_paid_legs_for(p_job.location_id, d ->> 'tableId', d ->> 'sessionId', d ->> 'seatedAt');
  update active_sessions a
     set paid_minor = v_paid, paid_legs = v_legs
   where a.location_id = p_job.location_id
     and a.table_id = d ->> 'tableId'
     and a.session ->> 'id' is not distinct from d ->> 'sessionId'
     and a.session ->> 'seatedAt' is not distinct from d ->> 'seatedAt';
exception when others then
  -- NEVER let a display projection roll back a settlement.
  raise warning 'publish paid_minor failed for job %: %', p_job.id, sqlerrm;
end; $$;

create or replace function _terminal_jobs_paid_trg()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Any transition into or out of a counted status re-projects the occupation.
  if tg_op = 'INSERT' or new.status is distinct from old.status
     or new.due_minor is distinct from old.due_minor then
    perform _terminal_publish_paid(new);
  end if;
  return null;                                   -- AFTER trigger
end; $$;

drop trigger if exists trg_terminal_jobs_paid on terminal_jobs;
create trigger trg_terminal_jobs_paid
  after insert or update of status, due_minor, tip_minor, charge_minor on terminal_jobs
  for each row execute function _terminal_jobs_paid_trg();

-- Backfill every occupation that already has settled legs, so tables part-paid
-- before this migration stop showing the gross bill.
update active_sessions a
   set paid_minor = p.paid, paid_legs = p.legs
  from lateral (
    select * from _terminal_paid_legs_for(a.location_id, a.table_id,
                                          a.session ->> 'id', a.session ->> 'seatedAt')
  ) p
 where p.paid > 0 and a.paid_minor is distinct from p.paid;

commit;
