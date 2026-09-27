# burhanbooks.com

The Burhan Books shop: static pages built from the book list in Supabase,
hosted on Netlify, with a small admin for adding and editing books.

- **Public pages** are plain HTML and CSS written by `build.mjs` into `dist/`.
  They never call Supabase, so they keep working if it's down.
- **Books** live in Supabase. The admin at `/admin/` edits them; pressing
  *Publish changes* rebuilds the site on Netlify (about a minute).
- **Buying:** customers add books to a cart, kept in their own browser, which
  slides in from the right over the page (and is also a page at `/cart/`),
  and pay on a Stripe Checkout page. `/api/checkout` prices the cart from the
  site's own list of books on sale (`books.json`, written by the build), so
  a book costs what its page says, then asks Stripe for the payment page.
  The site takes no card details itself.
- **Search** drops down from the magnifier in the header and goes to
  `/search/`, which lists every book and hides those that don't match the
  words typed. Nothing is fetched: the list is built with the page.

No runtime dependencies: the build and the two functions use only Node's
standard library. `devDependencies` are checks and tests for this machine.

## Working on it

```sh
npm install                 # dev tools only
node build.mjs              # → dist/, from src/data/books.seed.json
node scripts/preview.mjs    # → http://localhost:8790 (admin at /admin/)
node scripts/check.mjs      # HTML, types, links, colour tokens
npm test                    # unit, build, database, publish, checkout, admin, cart and search tests
```

The preview server stands in for Supabase, Netlify and Stripe, so the admin
and the cart work locally. Sign in as `admin@burhanbooks.test` (or
`someone@burhanbooks.test`, who isn't an admin) with the password `preview`.
Publishing rebuilds `dist/` from the stand-in. Give the book a price there to
see Add to cart; Checkout then goes to a stand-in payment page, and nothing is
charged. Everything resets when the server stops.

**Preview on GitHub Pages:** every push to `main` publishes the built pages
to https://am21adk.github.io/burhanbooks/ (`.github/workflows/pages.yml`,
built with `BASE_PATH=/burhanbooks`). It's a preview only: noindex
everywhere and the `NEEDS:` gaps visible. It reads the books from the shop's
Supabase project, and its admin (https://am21adk.github.io/burhanbooks/admin/)
signs in to it. GitHub Pages can't run the publish or checkout functions, so
the preview's Publish button opens the workflow on GitHub instead (press
**Run workflow**), and Checkout says it isn't available there. The real site
goes on Netlify.

`NEEDS:` marks copy only the owner can supply (the tagline and the contact
details). Local builds list what's missing; **a production
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

### 3. Stripe

1. Try it first in Stripe's test mode, then repeat these steps in live mode.
2. **Developers → API keys:** create a restricted key with write access to
   Checkout Sessions, and add it in Netlify as the environment variable
   `STRIPE_SECRET_KEY`. It stays on Netlify; only `/api/checkout` uses it.
   If Stripe refuses the key, the function's log in Netlify gives Stripe's
   reason (such as a permission the key lacks).
3. Delivery: Stripe asks for a UK delivery address (`DELIVERY_COUNTRIES` in
   `netlify/functions/checkout.mjs`). To charge for delivery, make a shipping
   rate in Stripe and add its id (`shr_…`) as `STRIPE_SHIPPING_RATE`.
   Without it, no delivery charge is added.
4. Orders appear in Stripe under Payments, with the customer's address.
   Stripe can email the customer a receipt, and you a note of each payment;
   both are switched on in Stripe's settings.

### 4. Before and after going live

- In the admin, give the book its price, then publish.
- Fill every `NEEDS:` gap (in `src/site.json` and `src/pages/`).
- Add `burhanbooks.com` as the site's domain in Netlify and point DNS at it
  from Cloudflare. **Change only the `burhanbooks.com` and `www` records.
  Leave the email (MX, SPF, DKIM) records alone.** Netlify issues the HTTPS
  certificate; the production build then redirects the `*.netlify.app`
  name to `burhanbooks.com`.
- Old WordPress addresses redirect: `/basket/` and `/checkout/` to the cart,
  `/shop/`, `/my-account/` and the rest to the home page. The book keeps
  its old address.

## Layout

| Path | What |
|---|---|
| `build.mjs` | Builds `dist/`: pages, book pages, admin, sitemap, robots, `_headers`, `_redirects` |
| `lib/` | Build helpers: templates, loading books, covers |
| `src/pages/` | Hand-written pages (front matter + HTML) |
| `src/templates/book.html` | One page per book |
| `src/partials/` | Layout, header, footer, book card |
| `src/admin/` | The admin page, its script and styles, and a small Supabase client |
| `src/js/shared.js` | Rules shared by the build, the admin, the cart and checkout |
| `src/js/cart.js` | The cart: the count by the Cart link, Add to cart, the cart panel and page |
| `src/js/search.js` | The search panel, and matching books on `/search/` |
| `src/js/panel.js` | Opening and closing the cart and search panels |
| `src/css/site.css` | All public styles, built on the tokens in `:root` |
| `supabase/` | Tables, access rules, covers bucket, seed (run in the SQL editor) |
| `netlify/functions/publish.mjs` | `/api/publish`: checks the admin, triggers the build hook |
| `netlify/functions/checkout.mjs` | `/api/checkout`: prices the cart, opens a Stripe Checkout page |
| `scripts/` | Preview server with Supabase and Stripe stand-ins, checks, share image and seed generators (not deployed) |
| `tests/` | `npm test` |
