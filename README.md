# burhanbooks.com

The Burhan Books shop: static pages built from the book list in Supabase,
hosted on Netlify, with a small admin for adding and editing books.

- **Public pages** are plain HTML and CSS written by `build.mjs` into `dist/`.
  They never call Supabase, so they keep working if it's down.
- **Books** live in Supabase. The admin (`/admin/`) edits them; pressing
  *Publish changes* rebuilds the site on Netlify.
- **Payment** is a payment link per book (for example a Stripe Payment
  Link). The site takes no card details itself.

No runtime dependencies: the build uses only Node's standard library. The
`devDependencies` are for checks and tests on this machine.

## Working on it

```sh
npm install            # dev tools only
node build.mjs         # → dist/ (uses src/data/books.seed.json without Supabase settings)
node scripts/preview.mjs   # → http://localhost:8790
node scripts/check.mjs     # HTML, types, links, colour tokens
```

`NEEDS:` in any page marks copy only the owner can supply (policies,
contact details, the tagline). Local builds list them; a production build
on Netlify fails until they're all filled in.

## Layout

| Path | What |
|---|---|
| `build.mjs` | Builds `dist/` |
| `lib/` | Build helpers: templates, loading books, covers |
| `src/pages/` | Hand-written pages (front matter + HTML) |
| `src/templates/book.html` | One page per book |
| `src/partials/` | Layout, header, footer, book card |
| `src/js/shared.js` | Rules shared by the build and the admin |
| `src/css/site.css` | All public styles, built on the tokens in `:root` |
| `scripts/` | Preview server, checks (not deployed) |
