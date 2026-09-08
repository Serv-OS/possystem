-- 20260804_devices_app_version.sql   (OPS DB)
-- Fleet update reliability (v5.5.870): each paired device reports the app version it is RUNNING
-- on its heartbeat, so Back Office → Network Status can flag a till that is behind. Today a stale
-- device (esp. the Sunmi POS WebView, which keeps old code on a mere refresh) was invisible —
-- it silently broke online kitchen printing and cost hours to find.
alter table devices add column if not exists app_version text;
