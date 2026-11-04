-- 20261120b_OPS_challenge_id_last4.sql (5.12.57, US basics batch 2). OPTIONAL data fix, Peter's call.
-- Run in the Ops SQL editor. ASCII only.
--
-- Since 5.12.57 the Challenge 21 / ID check keeps only the last 4 characters of an ID number and
-- shows "ending 1234". Rows saved before kept the whole number (1 row on 3 Nov 2026); the screen hides
-- it, but the browser still receives it. This cuts those rows to their last 4 characters. It cannot be
-- undone (the full numbers are gone), which is the point.
begin;
update public.challenge_21_checks
   set id_document_number = right(id_document_number, 4)
 where id_document_number is not null and length(id_document_number) > 4;
commit;
-- VISIBLE CHECK: one row, 0.
select count(*) as full_numbers_left from public.challenge_21_checks where length(id_document_number) > 4;
