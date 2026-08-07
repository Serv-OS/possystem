-- 20260806i_training_content.sql — training is CONTENT + AGREEMENT, not a
-- checklist (Peter, 7 Aug: "things we upload in detail and then have to
-- complete and agree that they have done — like actual training").
--
-- A module now carries written training content and uploaded materials
-- (private wf-documents bucket, served via short-lived signed URLs from the
-- staff-portal fn). Completion is an ATTESTATION: the staff member agrees they
-- have completed and understood it — name + timestamp, recorded like the
-- contract e-sign. The app refuses the agreement until every material has
-- actually been opened (opened_files is the evidence trail).
-- tasks/tasks_done stay for optional checklists and future AI output.

begin;

alter table public.wf_training_modules add column if not exists content text;
alter table public.wf_training_modules add column if not exists attachments jsonb not null default '[]'::jsonb; -- [{id, name, path}]

alter table public.wf_training_assignments add column if not exists opened_files jsonb not null default '[]'::jsonb; -- [{fileId, at}]
alter table public.wf_training_assignments add column if not exists attested_at timestamptz;
alter table public.wf_training_assignments add column if not exists attestation jsonb; -- {name, at}

commit;
