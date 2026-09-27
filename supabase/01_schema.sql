-- Burhan Books, 1 of 4: tables.
-- Run the files in order (01, 02, 03, 04) in the Supabase SQL editor.
-- Each can be run again safely.

-- Who may use the admin. Rows are added by hand in the SQL editor (see the
-- README); nothing on the website can write to this table.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The books on the site. The public pages are built from the published
-- rows; limits match src/js/shared.js so the admin form says the same thing
-- the database would.
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  title text not null
    check (length(btrim(title)) between 1 and 200),
  author text
    check (author is null or length(author) <= 200),
  contributors text
    check (contributors is null or length(contributors) <= 300),
  description text
    check (description is null or length(description) <= 20000),
  price_pence integer
    check (price_pence is null or price_pence between 0 and 1000000),
  payment_url text
    check (payment_url is null or payment_url ~ '^https://[^\s/]+\.[^\s/]+(/\S*)?$'),
  cover_url text
    check (cover_url is null or cover_url ~ '^(https://|/img/books/)\S+$'),
  cover_small_url text
    check (cover_small_url is null or cover_small_url ~ '^(https://|/img/books/)\S+$'),
  cover_width integer
    check (cover_width is null or cover_width between 1 and 10000),
  cover_height integer
    check (cover_height is null or cover_height between 1 and 10000),
  is_published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A cover always comes with its size, so pages can reserve its space.
  constraint books_cover_has_size
    check ((cover_url is null) = (cover_width is null) and (cover_width is null) = (cover_height is null)),
  constraint books_small_cover_needs_cover
    check (cover_small_url is null or cover_url is not null)
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists books_touch_updated_at on public.books;
create trigger books_touch_updated_at
  before update on public.books
  for each row execute function public.touch_updated_at();

-- True when the signed-in user is in admins. Runs as the caller (not
-- security definer): admins can read their own row, so it answers
-- correctly, and nobody learns anything about anyone else.
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
