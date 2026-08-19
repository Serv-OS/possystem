-- release_terminal_jobs must also clear an ADYEN job that never left the building.
--
-- Live 19 Aug: a test dispatch to the S1F2L wedged the terminal with "That card
-- machine is already taking a payment (£2.85)". The job sat in 'charging_unsent'
-- past its 15-minute lease and NOTHING could clear it — Back Office's "Release
-- stuck payment" only covers pending/claimed/tipping (lease expired) and
-- 'unknown', so it truthfully reported "Nothing was stuck on this terminal"
-- while the per-terminal mutex kept refusing every new payment.
--
-- WHY 'charging_unsent' IS EXCLUDED IN GENERAL, AND WHY ADYEN IS DIFFERENT.
-- On PAX/Ryft that status means the DEVICE holds the job, has already committed
-- the tip, and is about to talk to the card. Releasing it blind could double
-- charge, so it must stay excluded there.
--
-- The Adyen path is the opposite, and provably so. adyen-terminal-charge does a
-- CAS 'charging_unsent' -> 'charging' and stamps nexo_service_id BEFORE any
-- network call (its write-ahead rule). So an Adyen job still in 'charging_unsent'
-- with nexo_service_id IS NULL means no nexo message was ever built, let alone
-- sent. Add the payment_session_id / transaction_id null checks and the expired
-- lease and the conclusion is airtight: no card was touched.
--
-- Gated on processor = 'adyen' precisely so the PAX/Ryft semantics are untouched.
begin;

create or replace function release_terminal_jobs(p_terminal_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t terminal_devices;
  v_expired int := 0;
  v_unsent  int := 0;
  v_closed  int := 0;
  v_who     text;
begin
  select * into t from terminal_devices where id = p_terminal_id;
  if not found then raise exception 'terminal not found'; end if;
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  v_who := coalesce(auth.uid()::text, 'unknown user');

  -- Leases that ran out and never reached a terminal state.
  update terminal_jobs
     set status = 'expired'
   where target_terminal_id = t.id
     and status in ('pending','claimed','tipping')
     and claim_expires_at < now();
  get diagnostics v_expired = row_count;

  -- NEW: an Adyen dispatch that provably never reached the reader.
  update terminal_jobs
     set status         = 'expired',
         decline_reason = concat_ws(' | ', decline_reason,
                            'released by ' || v_who || ' at ' || now()::text
                            || ' (adyen charging_unsent, never dispatched)'
                            || coalesce(': ' || nullif(p_note, ''), ''))
   where target_terminal_id = t.id
     and status = 'charging_unsent'
     and processor = 'adyen'
     and claim_expires_at < now()
     and nexo_service_id is null
     and payment_session_id is null
     and transaction_id is null;
  get diagnostics v_unsent = row_count;

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

  return jsonb_build_object('ok', true, 'expired', v_expired + v_unsent, 'released', v_closed);
end; $$;

commit;
