-- 20260612f_review_platforms_expand.sql  (OPS DB)
--
-- Expand the platform enums beyond the launch three (google/tripadvisor/
-- facebook) to the realistic UK hospitality/retail set, so any connected
-- platform can be modelled. API-capable ones (thefork/trustpilot/booking) get
-- live calls wired later; the rest ride the manual deep-link fallback. Keeps
-- the CHECK as the source of truth alongside _shared/review-platforms.ts.

alter table review_platform_links drop constraint if exists review_platform_links_platform_check;
alter table review_platform_links add constraint review_platform_links_platform_check
  check (platform in ('google','tripadvisor','facebook','thefork','trustpilot','booking','yelp','opentable','ubereats','deliveroo','justeat'));

alter table review_feedback drop constraint if exists review_feedback_source_platform_check;
alter table review_feedback add constraint review_feedback_source_platform_check
  check (source_platform is null or source_platform in ('google','tripadvisor','facebook','thefork','trustpilot','booking','yelp','opentable','ubereats','deliveroo','justeat'));
