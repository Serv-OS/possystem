-- ─────────────────────────────────────────────────────────────────────────────
-- 20260724_terminal_retire_and_sweep.sql   (OPS DB)
--
-- Three faults found in live use, all mine, all from 20260722*:
--
--   1. UNPAIRING A TERMINAL FAILS
--      "update or delete on table terminal_devices violates foreign key
--       constraint terminal_jobs_target_terminal_id_fkey"
--      The panel hard-DELETEs the device row. terminal_jobs.target_terminal_id
--      is NOT NULL and references it, so any payment history makes the device
--      undeletable. The table already has a 'retired' status designed for
--      exactly this, and the client function is even NAMED retire() — it just
--      wasn't implemented that way. Deleting a payment device is wrong anyway:
--      it would orphan the audit trail of real money.
--
--   2. "THIS TERMINAL IS ALREADY TAKING A PAYMENT", FOREVER
--      terminal_jobs_sweep() expires stale leases correctly, but NOTHING EVER
--      CALLS IT. One abandoned payment wedges the terminal permanently, with no
--      way out except hand-written SQL. That is not something a venue can do at
--      eight on a Friday.
--
--   3. NO OPERATOR ESCAPE HATCH
--      An 'unknown' job blocks the terminal by design (we cannot prove whether
--      a card was charged, so a human must decide). Correct — but there was no
--      way for that human to actually decide anything.
--
-- Fixes: retire instead of delete, a scheduled sweep, and an auth-fenced
-- operator action to release a wedged terminal that records WHO released it.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ═══ 1. Retire, don't delete ════════════════════════════════════════════════
-- Soft. Keeps every terminal_jobs row intact, so the money history survives.
-- Frees the serial + ryft_terminal_id unique indexes (both are partial, WHERE
-- status = 'paired'), so the same physical PAX can be re-paired afterwards.
create or replace function retire_terminal_device(p_terminal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare t terminal_devices;
begin
  select * into t from terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- Refuse while money is genuinely in flight. Retiring mid-charge would strand
  -- a payment nobody is watching. 'unknown' is deliberately NOT in this list —
  -- a quarantined job must never be able to trap a terminal in the estate
  -- forever; release it first (below), which is an audited act.
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging')) then
    raise exception 'this terminal is mid-payment — wait for it to finish, or release it first';
  end if;

  update terminal_devices
     set status              = 'retired',
         active              = false,
         claim_code          = null,        -- cannot be re-claimed with the old code
         bound_pos_device_id = null,        -- frees the till
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'retired', t.id);
end;
$fn$;

-- ═══ 2. Release a wedged terminal — the operator escape hatch ═══════════════
-- Expires anything stale and closes out quarantined jobs, recording who did it
-- and why. This is an AUDITED act, not a silent cleanup: an 'unknown' job means
-- we could not establish whether a customer was charged, and a human is now
-- asserting it is safe to move on. That assertion belongs in the record.
create or replace function release_terminal_jobs(p_terminal_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t terminal_devices;
  v_expired int := 0;
  v_closed  int := 0;
  v_who     text;
begin
  select * into t from terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  v_who := coalesce(auth.uid()::text, 'unknown user');

  -- Leases that ran out and never reached a terminal state. Exactly what the
  -- sweeper does; doing it here too means the operator is never blocked waiting
  -- for a cron tick.
  update terminal_jobs
     set status = 'expired'
   where target_terminal_id = t.id
     and status in ('pending','claimed','tipping')
     and claim_expires_at < now();
  get diagnostics v_expired = row_count;

  -- Quarantined jobs. Stamped with who released them and when.
  update terminal_jobs
     set status         = 'reconciled',
         needs_human    = false,
         decline_reason = concat_ws(' | ', decline_reason,
                            'released by ' || v_who || ' at ' || now()::text
                            || coalesce(': ' || nullif(p_note, ''), ''))
   where target_terminal_id = t.id
     and status = 'unknown';
  get diagnostics v_closed = row_count;

  return jsonb_build_object('ok', true, 'expired', v_expired, 'released', v_closed);
end;
$fn$;

-- ═══ 3. Stop hard-deleting payment devices from the client ══════════════════
-- Retiring is now the only route, and it goes through the RPC above.
drop policy if exists td_delete on terminal_devices;

-- ═══ 4. Actually run the sweeper ════════════════════════════════════════════
-- terminal_jobs_sweep() has existed since 20260722c and has never once run.
-- Schedule it if pg_cron is available; if it is not, say so loudly in the
-- output rather than leaving a silent gap — an unswept queue wedges terminals.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('paxpay-sweep')
      where exists (select 1 from cron.job where jobname = 'paxpay-sweep');
    perform cron.schedule('paxpay-sweep', '* * * * *',
                          $cron$ select public.terminal_jobs_sweep(200); $cron$);
    raise notice 'paxpay-sweep scheduled every minute via pg_cron';
  else
    raise warning 'pg_cron NOT installed — terminal_jobs_sweep() will not run automatically. Enable pg_cron, or call the terminal-job-reconcile edge function on a timer, or terminals will wedge on abandoned payments.';
  end if;
end $$;

-- ═══ Grants — match the pattern in 20260722c ═══════════════════════════════
revoke execute on function retire_terminal_device(uuid)          from public;
revoke execute on function release_terminal_jobs(uuid, text)     from public;
grant  execute on function retire_terminal_device(uuid)          to authenticated;
grant  execute on function release_terminal_jobs(uuid, text)     to authenticated;

commit;
