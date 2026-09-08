-- 20260615b_wifi_loyalty.sql
-- Let the WiFi portal offer loyalty sign-up. When the operator turns this on, the portal
-- shows a single "Join rewards" opt-in that BOTH grants marketing consent AND enrols the
-- guest in the loyalty programme (see wifi-capture → loyalty-enroll).
alter table wifi_portal_settings add column if not exists loyalty_offer boolean not null default false;
alter table wifi_portal_settings add column if not exists loyalty_copy  text default 'Join our rewards — earn points and get exclusive offers by email & SMS.';
