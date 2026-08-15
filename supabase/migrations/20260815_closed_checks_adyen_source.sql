-- The July lesson, repeated to the letter (memory: "new record.source ⇒ widen
-- constraint"): closed_checks_source_check refused every 'adyen_pay_at_table'
-- booking — card captured, closer retrying forever, "sale not recorded" on the
-- till. Widen the allow-list.
begin;

alter table public.closed_checks drop constraint if exists closed_checks_source_check;
alter table public.closed_checks add constraint closed_checks_source_check
  check (source = any (array[
    'pos','kiosk','online','mobile','catering','hubrise',
    'pax_table_pay','pos_send_to_terminal','adyen_pay_at_table'
  ]::text[]));

commit;
