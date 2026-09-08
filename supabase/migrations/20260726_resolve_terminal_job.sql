-- ─────────────────────────────────────────────────────────────────────────────
-- 20260726_resolve_terminal_job.sql   (OPS DB)
--
-- Lets a MANAGER record what actually happened to an unresolved card payment,
-- from Back Office, without the service-role key ever touching a browser.
--
-- WHY THIS EXISTS
--   terminal_job_reconcile() and the terminal-job-reconcile edge function are
--   both service_role only — the function literally byte-compares the bearer
--   against SUPABASE_SERVICE_ROLE_KEY. That is correct for a sweeper. It is
--   useless for a person: the only ways to make the Back Office screen work
--   through it were to ship the service-role key to the client (which hands
--   every visitor the whole database) or to loosen that fence (which weakens
--   the sweeper's). Neither is acceptable, so this is a third door, fenced on
--   the manager's own venue access exactly like release_terminal_jobs (20260724).
--
-- IT ALSO FIXES A DEAD END
--   terminal_report_result sets needs_human on an APPROVED job when the device's
--   reported_minor disagrees with the server's charge_minor. terminal_job_reconcile
--   only ever touches `where status = 'unknown'`, so those rows could never be
--   cleared by anything and would sit in the queue forever. This handles both:
--   an unverified job gets an outcome, an amount-mismatch job gets acknowledged.
--
-- EVERY CALL IS ATTRIBUTED. Asserting that a customer was or was not charged is
-- a judgement about real money, made without proof, and it must carry a name.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function resolve_terminal_job(
  p_job_id  uuid,
  p_outcome text,
  p_note    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j     terminal_jobs;
  v_out text;
  v_who text;
  v_stamp text;
begin
  v_out := lower(btrim(coalesce(p_outcome, '')));
  if v_out not in ('approved','declined','cancelled','acknowledged') then
    raise exception 'invalid outcome %', p_outcome;
  end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'payment not found'; end if;

  -- Same fence as release_terminal_jobs: the manager must have this venue.
  if not _terminal_user_has_location(j.location_id) then
    raise exception 'no access to this payment';
  end if;

  -- Refuse while the payment is genuinely still running. A manager resolving a
  -- live charge from Back Office while a customer is mid-tap would be deciding
  -- the outcome of something that has not happened yet.
  if j.status in ('claimed','tipping','charging_unsent','charging') then
    return jsonb_build_object('ok', false,
      'reason', 'this payment is still running on the terminal — wait for it to finish');
  end if;

  v_who   := coalesce((select email from user_profiles where id = auth.uid()), auth.uid()::text, 'unknown user');
  v_stamp := concat_ws(' ', v_out, '— confirmed by', v_who, 'at', now()::text,
                       nullif(concat(': ', nullif(btrim(coalesce(p_note,'')), '')), ': '));

  if v_out = 'acknowledged' then
    -- The outcome is already known (e.g. approved with an amount mismatch); the
    -- manager is signing off the discrepancy, not deciding what happened. Status
    -- is deliberately left alone.
    update terminal_jobs
       set needs_human = false,
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  else
    update terminal_jobs
       set status      = v_out,
           needs_human = false,
           settled_at  = coalesce(settled_at, now()),
           reconcile_attempts = reconcile_attempts + 1,
           last_error  = concat_ws(' | ', last_error, v_stamp),
           updated_at  = now()
     where id = j.id;
  end if;

  return jsonb_build_object('ok', true, 'outcome', v_out, 'by', v_who);
end;
$fn$;

revoke execute on function resolve_terminal_job(uuid, text, text) from public;
-- authenticated only. NOT anon: a till or a kiosk must never be able to decide
-- that a customer was charged.
grant  execute on function resolve_terminal_job(uuid, text, text) to authenticated;

commit;


-- ── CHECK ───────────────────────────────────────────────────────────────────
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'resolve_terminal_job';
