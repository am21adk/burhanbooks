// Runs supabase/01-04 in PGlite (real Postgres, in Node) on a stand-in for a
// new Supabase project, then checks what a signed-out visitor, a signed-in
// non-admin and the admin can each do. The stand-in reproduces Supabase's
// generous defaults (every table and function in public granted to anon and
// authenticated) so the tests prove the SQL takes them back.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SLUG = 'shii-theology-a-translation-of-kashf-al-murad';

const SUPABASE_STANDIN = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;

  create schema storage;
  grant usage on schema storage to anon, authenticated;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid);
  alter table storage.objects enable row level security;
  grant all on storage.objects to anon, authenticated;
`;

/** @type {PGlite} */
let db;

/** Switch identity, as Supabase does from the request's token. */
async function as(/** @type {'anon'|'authenticated'} */ role, sub = '') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub}', false); set role ${role};`);
}
const rows = async (/** @type {string} */ sql) => (await db.query(sql)).rows;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  for (const file of ['01_schema.sql', '02_policies.sql', '03_storage.sql', '04_seed.sql']) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', file), 'utf8'));
  }
  // Every file can be run a second time without error.
  for (const file of ['01_schema.sql', '02_policies.sql', '03_storage.sql', '04_seed.sql']) {
    await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', file), 'utf8'));
  }
  await db.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@test'), ('${OTHER}', 'someone@test');
    insert into public.admins (user_id) values ('${ADMIN}');
    insert into public.books (slug, title, is_published) values ('a-draft', 'A draft', false);
  `);
});

test('the seed book is there once, published, with no price yet', async () => {
  await db.exec('reset role');
  const [book] = await rows(`select title, price_pence, is_published, cover_width from public.books where slug = '${SLUG}'`);
  assert.equal(book.title, 'Shi’i Theology: A translation of Kashf al-Murad');
  assert.equal(book.price_pence, null);
  assert.equal(book.is_published, true);
  assert.equal(book.cover_width, 468);
  assert.equal((await rows('select count(*)::int as n from public.books')).at(0)?.n, 2);
});

test('a signed-out visitor sees published books only, and can change nothing', async () => {
  await as('anon');
  assert.deepEqual((await rows('select slug from public.books order by slug')).map((r) => r.slug), [SLUG]);
  await assert.rejects(db.query(`insert into public.books (slug, title) values ('x', 'X')`), /permission denied/);
  await assert.rejects(db.query(`update public.books set title = 'Hacked'`), /permission denied/);
  await assert.rejects(db.query('delete from public.books'), /permission denied/);
  await assert.rejects(db.query('select * from public.admins'), /permission denied/);
  await assert.rejects(db.query('select public.is_admin()'), /permission denied/);
  await assert.rejects(db.query(`insert into storage.objects (bucket_id, name) values ('covers', 'x.jpg')`), /row-level security/);
});

test('a signed-in account that is not an admin gets no more than a visitor', async () => {
  await as('authenticated', OTHER);
  assert.deepEqual((await rows('select slug from public.books')).map((r) => r.slug), [SLUG]);
  assert.equal((await rows('select public.is_admin() as ok')).at(0)?.ok, false);
  assert.deepEqual(await rows('select * from public.admins'), []);
  await assert.rejects(db.query(`insert into public.books (slug, title) values ('x', 'X')`), /row-level security/);
  assert.deepEqual(await rows(`update public.books set title = 'Hacked' returning id`), []);
  assert.deepEqual(await rows('delete from public.books returning id'), []);
  await assert.rejects(db.query(`insert into public.admins (user_id) values ('${OTHER}')`), /permission denied/);
  await assert.rejects(db.query(`insert into storage.objects (bucket_id, name) values ('covers', 'x.jpg')`), /row-level security/);
});

test('the admin sees drafts and can add, edit and delete books and covers', async () => {
  await as('authenticated', ADMIN);
  assert.equal((await rows('select public.is_admin() as ok')).at(0)?.ok, true);
  assert.deepEqual((await rows('select slug from public.books order by slug')).map((r) => r.slug), ['a-draft', SLUG]);
  await db.query(`insert into public.books (slug, title, price_pence) values ('new-book', 'New book', 1250)`);
  const [before] = await rows(`select updated_at from public.books where slug = 'new-book'`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await rows(`update public.books set is_published = true where slug = 'new-book' returning id`)).length, 1);
  const [after] = await rows(`select updated_at from public.books where slug = 'new-book'`);
  assert.ok(new Date(after.updated_at) > new Date(before.updated_at), 'updated_at moves on edit');
  assert.equal((await rows(`delete from public.books where slug = 'new-book' returning id`)).length, 1);
  await db.query(`insert into storage.objects (bucket_id, name) values ('covers', 'books/x.jpg')`);
  assert.equal((await rows(`delete from storage.objects where name = 'books/x.jpg' returning id`)).length, 1);
  await assert.rejects(db.query(`insert into storage.objects (bucket_id, name) values ('other', 'x.jpg')`), /row-level security|foreign key/);
  await assert.rejects(db.query(`insert into public.admins (user_id) values ('${OTHER}')`), /permission denied/);
});

test('the database refuses what the admin form refuses', async () => {
  await as('authenticated', ADMIN);
  const bad = {
    'bad web address': `insert into public.books (slug, title) values ('Bad Slug', 'X')`,
    'empty title': `insert into public.books (slug, title) values ('x1', '   ')`,
    'negative price': `insert into public.books (slug, title, price_pence) values ('x4', 'X', -1)`,
    'price of nothing': `insert into public.books (slug, title, price_pence) values ('x2', 'X', 0)`,
    'cover without size': `insert into public.books (slug, title, cover_url) values ('x5', 'X', 'https://a.b/c.jpg')`,
    'cover from anywhere else': `insert into public.books (slug, title, cover_url, cover_width, cover_height) values ('x6', 'X', 'data:image/png;base64,AA', 1, 1)`,
    'duplicate web address': `insert into public.books (slug, title) values ('${SLUG}', 'Copy')`,
  };
  for (const [label, sql] of Object.entries(bad)) {
    await assert.rejects(db.query(sql), Error, `should refuse: ${label}`);
  }
});
