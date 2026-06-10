-- ============================================================================
-- Scale pass — composite indexes for the hot Workforce query paths.
--
-- wf_timesheets previously had only (location_id): every payroll preview,
-- pending-count check and range load scanned all of a location's rows. These
-- match the exact filters used by workforce-compute and wfData.loadTimesheets.
-- wf_announcements is read on every Time Clock PIN entry (location + recency).
-- wf_documents is listed per location on the Compliance screen.
-- ============================================================================

create index if not exists idx_wf_ts_loc_clockin on wf_timesheets (location_id, clock_in desc);
create index if not exists idx_wf_ts_loc_status_clockin on wf_timesheets (location_id, status, clock_in);
create index if not exists idx_wf_ann_loc_created on wf_announcements (location_id, created_at desc);
create index if not exists idx_wf_docs_loc on wf_documents (location_id);
