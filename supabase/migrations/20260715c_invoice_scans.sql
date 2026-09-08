-- Keep the scanned supplier-invoice image so it can (a) be re-viewed in the back office
-- and (b) ride along to Xero as the bill attachment.
--
-- supplier_invoices.image_path = '<location_id>/<uuid>.<ext>' inside the PRIVATE
-- 'invoice-scans' bucket. BO users may only touch files under a location they can
-- access (user_accessible_locations); reads happen via signed URLs or the service role.

alter table public.supplier_invoices add column if not exists image_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-scans', 'invoice-scans', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update set public = false;

drop policy if exists invoice_scans_bo_insert on storage.objects;
create policy invoice_scans_bo_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoice-scans'
  and (storage.foldername(name))[1] in (select user_accessible_locations())
);

drop policy if exists invoice_scans_bo_read on storage.objects;
create policy invoice_scans_bo_read on storage.objects for select to authenticated
using (
  bucket_id = 'invoice-scans'
  and (storage.foldername(name))[1] in (select user_accessible_locations())
);
