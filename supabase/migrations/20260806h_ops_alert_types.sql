-- 20260806h_ops_alert_types.sql — widen ops_alerts.type for two new producers.
--
-- 'staff_change'     staff-portal: a staff member changed their BANK details
--                    from the staff app. Managers must see it (payroll-fraud
--                    vector) but the POS tills must NOT — Peter, 6 Aug: "it's
--                    not needed on that level". ops_alerts surfaces in the
--                    Manager app (Need-you-now count + alerts list + ack) and
--                    BO Operations, never on tills.
-- 'training_overdue' reserved for the nightly training sweep (plan slice 4).
--
-- Rule applied: new record source ⇒ WIDEN the constraint (the Table-Pay
-- closed_checks_source_check lesson).

begin;
alter table public.ops_alerts drop constraint if exists ops_alerts_type_check;
alter table public.ops_alerts add constraint ops_alerts_type_check
  check (type in ('temp_breach','missed_check','overdue_task','maintenance','corrective','staff_change','training_overdue'));
commit;
