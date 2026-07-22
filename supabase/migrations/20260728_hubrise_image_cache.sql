-- v5.5.850 — HubRise catalog image-id cache (sign-off item #55).
--
-- HubRise guidance: do NOT GET /catalogs/:id before publishing. The pre-publish GET
-- existed only to reuse already-uploaded image ids; cache them on our side instead,
-- keyed per item on the source URL at upload time so a changed image URL re-uploads
-- automatically (fixes the stale-image bug the GET approach had).
--
-- Shape: { "<menu item id>": { "id": "<hubrise image id>", "url": "<item.image at upload>" } }
-- Row deletion on disconnect (hubrise-connect) destroys the cache with the connection.
--
-- Apply BEFORE deploying the new hubrise-catalog-push code: without the column the
-- function degrades to a full image re-upload per push (not broken, just slower).

alter table hubrise_connections
  add column if not exists catalog_image_ids jsonb not null default '{}'::jsonb;
