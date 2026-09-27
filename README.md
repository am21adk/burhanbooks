# burhanbooks.com

The Burhan Books shop: static pages built from the book list in Supabase,
hosted on Netlify, with a small admin for adding and editing books.

- **Public pages** are plain HTML and CSS written by `build.mjs` into `dist/`.
  They never call Supabase, so they keep working if it's down.
- **Books** live in Supabase. The admin at `/admin/` edits them; pressing
  *Publish changes* rebuilds the site on Netlify (about a minute).
- **Payment** is a payment link per book (for example a Stripe Payment
  Link). The site takes no card details itself.

No runtime dependencies: the build and the publish function use only Node's
standard library. `devDependencies` are checks and tests for this machine.

## Working on it

```sh
npm install                 # dev tools only
node build.mjs              # → dist/, from src/data/books.seed.json
node scripts/preview.mjs    # → http://localhost:8790 (admin at /admin/)
node scripts/check.mjs      # HTML, types, links, colour tokens
npm test                    # unit, build, database, publish and admin tests
```

The preview server stands in for Supabase and Netlify, so the admin works
locally. Sign in as `admin@burhanbooks.test` (or `someone@burhanbooks.test`,
who isn't an admin) with the password `preview`. Publishing rebuilds `dist/`
from the stand-in. Everything resets when the server stops.

**Preview on GitHub Pages:** every push to `main` publishes the built pages
to https://am21adk.github.io/burhanbooks/ (`.github/workflows/pages.yml`,
built with `BASE_PATH=/burhanbooks`). It's a preview only: noindex
everywhere, the book from the seed file, the `NEEDS:` gaps visible, and the
admin switched off because there's no Supabase behind it. The real site
goes on Netlify.

`NEEDS:` marks copy only the owner can supply (the tagline, contact details
and the policy pages). Local builds list what's missing; **a production
build on Netlify fails until every gap is filled**, so the shop can't go live
without them.

## Setting it up

### 1. Supabase

1. Create a project (region: London).
2. In **SQL Editor**, run `supabase/01_schema.sql`, `02_policies.sql`,
   `03_storage.sql` and `04_seed.sql`, in that order. Each is safe to run again.
3. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new
   users to sign up". Only accounts you create can sign in.
4. **Authentication → Users → Add user → Create new user:** the admin's email
   and a strong password, with "Auto confirm user" ticked.
5. Make that account the admin. In the SQL Editor, with the admin's email
   in place of `ADMIN_EMAIL`:

   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'ADMIN_EMAIL';
   ```

   Anyone else who signs in can see only what a visitor sees.
6. Note the **Project URL** and the **anon public** key (Project Settings → API).

If the admin forgets their password, create a new admin user (steps 4–5) and
delete the old one. The admin page doesn't handle password-reset emails.

### 2. Netlify

1. Push this repository to GitHub and create a Netlify site from it. Build
   settings come from `netlify.toml`.
2. **Site configuration → Environment variables:** add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`.
3. **Site configuration → Build & deploy → Build hooks:** add a hook for the
   production branch, then add its URL as the environment variable
   `NETLIFY_BUILD_HOOK`. It stays on Netlify; the admin only calls
   `/api/publish`, which checks the admin's sign-in first.
4. Deploy. Deploy previews and branch deploys are built with `noindex` and
   a robots.txt that blocks everything; only the production build is
   indexable.

### 3. Before and after going live

- In the admin, give the book its price and payment link, then publish.
- Fill every `NEEDS:` gap (in `src/site.json` and `src/pages/`).
- Add `burhanbooks.com` as the site's domain in Netlify and point DNS at it
  from Cloudflare. **Change only the `burhanbooks.com` and `www` records.
  Leave the email (MX, SPF, DKIM) records alone.** Netlify issues the HTTPS
  certificate; the production build then redirects the `*.netlify.app`
  name to `burhanbooks.com`.
- Old WordPress addresses (`/shop/`, `/basket/`, `/my-account/` and so on)
  redirect to the home page; the book keeps its old address.

## Layout

| Path | What |
|---|---|
| `build.mjs` | Builds `dist/`: pages, book pages, admin, sitemap, robots, `_headers`, `_redirects` |
| `lib/` | Build helpers: templates, loading books, covers |
| `src/pages/` | Hand-written pages (front matter + HTML) |
| `src/templates/book.html` | One page per book |
| `src/partials/` | Layout, header, footer, book card |
| `src/admin/` | The admin page, its script and styles, and a small Supabase client |
| `src/js/shared.js` | Rules shared by the build and the admin |
| `src/css/site.css` | All public styles, built on the tokens in `:root` |
| `supabase/` | Tables, access rules, covers bucket, seed (run in the SQL editor) |
| `netlify/functions/publish.mjs` | `/api/publish`: checks the admin, triggers the build hook |
| `scripts/` | Preview server and Supabase stand-in, checks, share image and seed generators (not deployed) |
| `tests/` | `npm test` |
