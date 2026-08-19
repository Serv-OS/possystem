-- release_terminal_jobs must also clear an ADYEN job that never left the building.
--
-- Live 19 Aug: a test dispatch to the S1F2L wedged the terminal with "That card
-- machine is already taking a payment (£2.85)". The job sat in 'charging_unsent'
-- and NOTHING could clear it — Back Office's "Release stuck payment" only covers
-- pending/claimed/tipping (lease expired) and 'unknown', so it truthfully said
-- "Nothing was stuck on this terminal" while the per-terminal mutex refused every
-- new payment. Unrecoverable from the UI by design, not by accident.
--
-- WHY 'charging_unsent' IS EXCLUDED IN GENERAL, AND WHY ADYEN IS DIFFERENT.
-- On PAX/Ryft that status means the DEVICE holds the job, has already committed
-- the tip, and is about to talk to the card. Releasing it blind could double
-- charge, so it MUST stay excluded there. Hence the processor='adyen' gate.
--
-- NOTE ON QUALIFICATION: every table is written public.<name>, and the rowtype is
-- declared public.terminal_devices%rowtype. plpgsql resolves DECLARE types when the
-- function is created, using the CREATING session's search_path — the function's own
-- SET search_path only applies at run time. The Supabase SQL editor does not
-- necessarily run with public on the path, which is exactly how this failed with
-- 'type "terminal_devices" does not exist'.
--
-- WHAT ACTUALLY MAKES THIS SAFE — and it is NOT the lease.
-- adyen-terminal-charge's write-ahead rule is a single atomic CAS:
--   UPDATE ... SET status='charging', nexo_service_id=<id> WHERE status='charging_unsent'
-- performed BEFORE any network call. So:
--   * status still 'charging_unsent' + nexo_service_id NULL  ⇒ the CAS never ran
--     ⇒ no nexo message was ever built, let alone sent ⇒ no card was touched.
--   * the UPDATE below carries `status='charging_unsent'` in its own WHERE, so it
--     races the CAS atomically: if the charge initiator wins, this matches zero
--     rows and the payment proceeds untouched; if this wins, the initiator's CAS
--     matches zero rows and it refuses to dispatch. Either way exactly one of the
--     two happens, and neither can charge a card the other has released.
-- An earlier draft of this also required claim_expires_at < now(). That was
-- cargo-culted from the pending/claimed branch and is wrong here: it does not add
-- safety (the atomicity does), and it left the operator blocked for 15 minutes on
-- a job that provably never reached the reader.
begin;

create or replace function release_terminal_jobs(p_terminal_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.terminal_devices%rowtype;
  v_expired int := 0;
  v_unsent  int := 0;
  v_closed  int := 0;
  v_who     text;
begin
  select * into t from public.terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  v_who := coalesce(auth.uid()::text, 'unknown user');

  -- Leases that ran out and never reached a terminal state.
  update public.terminal_jobs
     set status = 'expired'
   where target_terminal_id = t.id
     and status in ('pending','claimed','tipping')
     and claim_expires_at < now();
  get diagnostics v_expired = row_count;

  -- An Adyen dispatch that provably never reached the reader. See header.
  update public.terminal_jobs
     set status         = 'expired',
         settled_at     = now(),
         updated_at     = now(),
         decline_reason = concat_ws(' | ', decline_reason,
                            'released by ' || v_who || ' at ' || now()::text
                            || ' (adyen charging_unsent, never dispatched)'
                            || coalesce(': ' || nullif(p_note, ''), ''))
   where target_terminal_id = t.id
     and status = 'charging_unsent'
     and processor = 'adyen'
     and nexo_service_id is null
     and payment_session_id is null
     and transaction_id is null;
  get diagnostics v_unsent = row_count;

  -- Quarantined jobs. Stamped with who released them and when.
  update public.terminal_jobs
     set status         = 'reconciled',
         needs_human    = false,
         decline_reason = concat_ws(' | ', decline_reason,
                            'released by ' || v_who || ' at ' || now()::text
                            || coalesce(': ' || nullif(p_note, ''), ''))
   where target_terminal_id = t.id
     and status = 'unknown';
  get diagnostics v_closed = row_count;

  return jsonb_build_object('ok', true, 'expired', v_expired + v_unsent, 'released', v_closed);
end; $$;

-- Clear the job that is wedged RIGHT NOW, under the same guards.
update public.terminal_jobs
   set status         = 'expired',
       settled_at     = now(),
       updated_at     = now(),
       decline_reason = concat_ws(' | ', decline_reason,
                          'released 19 Aug: adyen charging_unsent, never dispatched')
 where status = 'charging_unsent'
   and processor = 'adyen'
   and nexo_service_id is null
   and payment_session_id is null
   and transaction_id is null;

commit;
