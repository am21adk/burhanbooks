-- Burhan Books, 3 of 4: the covers bucket.
--
-- Public, so the site's build can download covers by URL. Only admins can
-- add, replace or delete files, only images, and at most 5 MB each (the
-- admin shrinks covers before uploading, so they're far smaller).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists covers_admin_select on storage.objects;
create policy covers_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'covers' and public.is_admin());

drop policy if exists covers_admin_insert on storage.objects;
create policy covers_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'covers' and public.is_admin());

drop policy if exists covers_admin_update on storage.objects;
create policy covers_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'covers' and public.is_admin())
  with check (bucket_id = 'covers' and public.is_admin());

drop policy if exists covers_admin_delete on storage.objects;
create policy covers_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'covers' and public.is_admin());
