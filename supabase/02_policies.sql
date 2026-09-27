-- Burhan Books, 2 of 4: who can read and write what.
--
-- Signed-out visitors (and the site's build) can read published books and
-- nothing else. Only accounts listed in admins can see drafts or change
-- anything. Any other account that signs in gets the same as a visitor.

alter table public.admins enable row level security;
alter table public.books enable row level security;

-- Supabase grants every table in public to anon and authenticated by
-- default. Take that back and give only what the policies below need.
revoke all on public.books from anon, authenticated;
revoke all on public.admins from anon, authenticated;
grant select on public.books to anon, authenticated;
grant insert, update, delete on public.books to authenticated;
grant select on public.admins to authenticated;

drop policy if exists books_read_published on public.books;
create policy books_read_published on public.books
  for select to anon, authenticated
  using (is_published);

drop policy if exists books_admin_read on public.books;
create policy books_admin_read on public.books
  for select to authenticated
  using (public.is_admin());

drop policy if exists books_admin_insert on public.books;
create policy books_admin_insert on public.books
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists books_admin_update on public.books;
create policy books_admin_update on public.books
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists books_admin_delete on public.books;
create policy books_admin_delete on public.books
  for delete to authenticated
  using (public.is_admin());

drop policy if exists admins_read_own_row on public.admins;
create policy admins_read_own_row on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- Supabase also lets anon and authenticated execute every new function in
-- public, and revoking from "public" alone doesn't undo that. is_admin() is
-- needed by signed-in users (the policies call it as them); the trigger
-- function needs nobody.
revoke execute on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
