-- 20260612h: restrict review platforms to genuinely-connectable APIs (google/thefork/trustpilot); drop manual/none ones.

delete from review_platform_links where platform not in ('google','thefork','trustpilot');
update review_feedback set source_platform=null where source_platform is not null and source_platform not in ('google','thefork','trustpilot');
alter table review_platform_links drop constraint if exists review_platform_links_platform_check;
alter table review_platform_links add constraint review_platform_links_platform_check check (platform in ('google','thefork','trustpilot'));
alter table review_feedback drop constraint if exists review_feedback_source_platform_check;
alter table review_feedback add constraint review_feedback_source_platform_check check (source_platform is null or source_platform in ('google','thefork','trustpilot'));
