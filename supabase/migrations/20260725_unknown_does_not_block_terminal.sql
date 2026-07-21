-- ─────────────────────────────────────────────────────────────────────────────
-- 20260725_unknown_does_not_block_terminal.sql   (OPS DB)
--
-- A stuck payment currently takes the whole terminal out of service. In a busy
-- venue that is unusable, and it is a design mistake of mine, not a trade-off.
--
-- THERE ARE TWO DIFFERENT GUARDS AND I GAVE THEM THE SAME RULE:
--
--   A. the CHECK guard  — "is someone already paying this bill?"
--      terminal_start_table_payment, matching on check_key.
--      'unknown' MUST stay here. If we cannot prove whether a card was charged
--      for this bill, nobody may start a second payment against it. That is the
--      double-charge fence and it does not move.
--
--   B. the TERMINAL guard — "is this machine mid-transaction?"
--      idx_tj_one_live_per_terminal.
--      'unknown' must NOT be here. An unknown job is not in flight — it is
--      SETTLED BUT UNVERIFIED. The device has finished with it; it is parked
--      for a human to say what happened. The next customer is a different
--      person paying a different bill, and there is no safety argument for
--      refusing them. No card terminal in a real venue behaves this way: an
--      unresolved transaction goes to a reconciliation queue, the terminal
--      keeps trading.
--
-- Net effect: a payment we cannot verify becomes a manager's job, not an outage.
--
-- The states that DO still block the terminal are the genuinely concurrent ones:
--   claimed / tipping        — a customer is at the screen right now
--   charging_unsent          — tip taken, request about to go out
--   charging                 — dispatched, card may be moving
-- Two of those at once on one device would be a real double-charge risk.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

drop index if exists idx_tj_one_live_per_terminal;

create unique index idx_tj_one_live_per_terminal
  on terminal_jobs (target_terminal_id)
  where status in ('claimed','tipping','charging_unsent','charging');

comment on index idx_tj_one_live_per_terminal is
  'One IN-FLIGHT job per terminal. Deliberately excludes ''unknown'': that is settled-but-unverified, '
  'belongs in the reconcile queue, and must never take a terminal out of service. The double-charge '
  'fence for an unverified payment lives on check_key in terminal_start_table_payment, not here.';

commit;


-- ── CHECK ───────────────────────────────────────────────────────────────────
-- Expect: the index no longer lists 'unknown', and any terminal carrying an
-- unresolved job can still take a new payment.

select indexdef from pg_indexes where indexname = 'idx_tj_one_live_per_terminal';

select td.label,
       count(*) filter (where j.status = 'unknown')                                    as unresolved,
       count(*) filter (where j.status in ('claimed','tipping','charging_unsent','charging')) as in_flight,
       case when count(*) filter (where j.status in ('claimed','tipping','charging_unsent','charging')) = 0
            then 'can take payments' else 'busy (correctly)' end as state
from public.terminal_devices td
left join public.terminal_jobs j on j.target_terminal_id = td.id
where td.status <> 'retired'
group by td.label;
