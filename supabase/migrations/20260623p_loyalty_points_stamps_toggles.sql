-- ============================================================================
-- PLATFORM DB (yhzjgyrkyjabvhblqxzu): independent on/off for points vs stamp cards.
-- A venue can now run points-only, stamp-cards-only, or both. Default both on so existing
-- programs are unchanged. loyalty-config whitelists both; loyalty-earn gates each path;
-- loyalty-member-lookup returns both so client surfaces can hide the disabled half.
-- ============================================================================

alter table loyalty_config add column if not exists points_enabled boolean not null default true;
alter table loyalty_config add column if not exists stamps_enabled boolean not null default true;
