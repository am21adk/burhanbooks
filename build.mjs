// Builds the public site into dist/.
//
//   node build.mjs
//
// Books come from Supabase when SUPABASE_URL and SUPABASE_ANON_KEY are set
// (as on Netlify), otherwise from src/data/books.seed.json. On Netlify,
// CONTEXT tells production from deploy previews: previews are built with
// noindex everywhere, and a production build refuses to finish while any
// "NEEDS:" gap (copy only the owner can supply) is left in the output.
//
// Two switches exist only for checking a production build on this machine,
// and are never set on Netlify:
//   BOOKS_SOURCE=seed  build production from the seed file
//   ALLOW_GAPS=1       let a production build finish with NEEDS: gaps
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fill, readFrontMatter, partialLoader } from './lib/template.mjs';
import { loadBookRows, normaliseBooks, publishCover } from './lib/books.mjs';
import { escapeHtml } from './src/js/shared.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const env = process.env;
const production = env.CONTEXT === 'production';
const site = JSON.parse(fs.readFileSync(path.join(SRC, 'site.json'), 'utf8'));
const partial = partialLoader(path.join(SRC, 'partials'));
const year = new Date().getFullYear();

const CSP_PUBLIC = [
  "default-src 'self'", "img-src 'self' data:", "font-src 'self'", "style-src 'self'", "script-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", 'upgrade-insecure-requests',
].join('; ');

async function main() {
  const started = Date.now();
  if (production && !(env.SUPABASE_URL && env.SUPABASE_ANON_KEY) && env.BOOKS_SOURCE !== 'seed') {
    throw new Error('A production build needs SUPABASE_URL and SUPABASE_ANON_KEY (set them in Netlify → Site configuration → Environment variables).');
  }
  const useSupabase = env.BOOKS_SOURCE !== 'seed' && Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  const { rows, from } = await loadBookRows({
    supabaseUrl: useSupabase ? env.SUPABASE_URL : undefined,
    anonKey: useSupabase ? env.SUPABASE_ANON_KEY : undefined,
    seedFile: path.join(SRC, 'data', 'books.seed.json'),
  });
  const books = normaliseBooks(rows);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  copyDir(path.join(SRC, 'root'), DIST);
  copyDir(path.join(SRC, 'fonts'), path.join(DIST, 'fonts'));
  // img/books is published per book by publishCover; img/source holds originals that aren't served.
  copyDir(path.join(SRC, 'img'), path.join(DIST, 'img'), (rel) => !/^(books|source)[\\/]/.test(rel));
  const css = hashedCopy(path.join(SRC, 'css', 'site.css'), 'css');

  const covers = new Map();
  for (const book of books) covers.set(book.slug, await publishCover(book, { srcDir: SRC, distDir: DIST }));

  const shared = {
    siteName: site.name,
    year,
    css,
    csp: CSP_PUBLIC,
    robots: production ? '' : '<meta name="robots" content="noindex, nofollow">',
    navBooks: '',
    navContact: '',
  };

  /** @type {{ loc: string, lastmod: Date|null }[]} */
  const sitemap = [];

  // Pages written by hand: home, contact, the policy pages and 404.
  for (const file of fs.readdirSync(path.join(SRC, 'pages')).filter((f) => f.endsWith('.html'))) {
    const sourceFile = path.join(SRC, 'pages', file);
    const { meta, body } = readFrontMatter(fs.readFileSync(sourceFile, 'utf8'), file);
    const isHome = meta.path === '/';
    const is404 = meta.path === '/404.html';
    const vars = {
      ...shared,
      bookList: isHome ? renderBookList(books, covers) : '',
      navBooks: isHome ? ' aria-current="page"' : '',
      navContact: meta.path === '/contact/' ? ' aria-current="page"' : '',
    };
    const html = renderPage({
      title: isHome ? site.name : `${meta.title} – ${site.name}`,
      description: isHome ? site.tagline : meta.description,
      path: meta.path,
      body: fill(body, vars, partial, file),
      vars,
      noindex: is404,
    });
    write(is404 ? '404.html' : path.join(meta.path, 'index.html'), html);
    if (!is404) {
      const dates = [gitDate(sourceFile), ...(isHome ? books.map((b) => b.updatedAt) : [])].filter(Boolean);
      sitemap.push({ loc: meta.path, lastmod: dates.length ? new Date(Math.max(...dates.map(Number))) : null });
    }
  }

  // One page per book, from src/templates/book.html.
  const bookTemplate = fs.readFileSync(path.join(SRC, 'templates', 'book.html'), 'utf8');
  for (const book of books) {
    const cover = covers.get(book.slug) ?? null;
    const vars = { ...shared, ...bookVars(book, cover, { eager: true, sizes: '(min-width: 800px) 480px, 90vw' }) };
    const html = renderPage({
      title: `${book.title} – ${site.name}`,
      description: book.summary || `${book.title}${book.author ? ` by ${book.author}` : ''}.`,
      path: book.path,
      body: fill(bookTemplate, vars, partial, `book ${book.slug}`),
      vars,
      share: cover ? { src: cover.src, width: cover.naturalWidth, height: Math.round((cover.naturalWidth * cover.height) / cover.width), alt: book.coverAlt, card: 'summary' } : undefined,
    });
    write(path.join(book.path, 'index.html'), html);
    sitemap.push({ loc: book.path, lastmod: book.updatedAt });
  }

  write('sitemap.xml', renderSitemap(sitemap));
  write('robots.txt', production
    ? `User-agent: *\nDisallow: /admin/\n\nSitemap: ${site.url}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n');

  const gaps = findGaps(DIST);
  const summary = `Built ${countFiles(DIST)} files into dist/ from ${books.length} book${books.length === 1 ? '' : 's'} (${from}) in ${Date.now() - started} ms${production ? ', production' : ''}.`;
  if (gaps.length) {
    const list = gaps.map((g) => `  ${g.file}: ${g.text}`).join('\n');
    if (production && env.ALLOW_GAPS !== '1') {
      throw new Error(`The site still has ${gaps.length} gap(s) only the owner can fill, so it can't go live yet:\n${list}`);
    }
    console.warn(`${gaps.length} NEEDS: gap(s) left${production ? ' (ALLOW_GAPS=1, local check only)' : ''}:\n${list}`);
  }
  console.log(summary);
}

/**
 * @param {{ title: string, description: string, path: string, body: string, vars: Record<string, unknown>,
 *   noindex?: boolean, share?: { src: string, width: number, height: number, alt: string, card: string } }} page
 */
function renderPage({ title, description, path: pagePath, body, vars, noindex = false, share }) {
  const image = share || { ...site.shareImage, card: 'summary_large_image' };
  const pageVars = {
    ...vars,
    title,
    description,
    canonical: site.url + pagePath,
    robots: noindex && !vars.robots ? '<meta name="robots" content="noindex">' : vars.robots,
    ogImage: site.url + image.src,
    ogImageWidth: image.width,
    ogImageHeight: image.height,
    ogImageAlt: image.alt,
    twitterCard: image.card,
    locale: site.locale,
    content: body,
  };
  return fill(partial('layout'), pageVars, partial, 'layout');
}

/**
 * @param {ReturnType<typeof normaliseBooks>} books
 * @param {Map<string, Awaited<ReturnType<typeof publishCover>>>} covers
 */
function renderBookList(books, covers) {
  if (!books.length) return fill(partial('book-list-empty'), {}, partial);
  const cards = books.map((book, index) => fill(partial('book-card'), {
    ...bookVars(book, covers.get(book.slug) ?? null, { eager: index < 4, sizes: '(min-width: 600px) 280px, 90vw' }),
  }, partial, `card ${book.slug}`));
  return `<ul class="book-grid">\n${cards.join('\n')}\n</ul>`;
}

/**
 * The cover's width and height attributes are its 1x size, so with
 * max-width: 100% it can shrink but is never stretched past its real pixels.
 * @param {ReturnType<typeof normaliseBooks>[number]} book
 * @param {Awaited<ReturnType<typeof publishCover>>} cover
 * @param {{ eager: boolean, sizes: string }} options
 */
function bookVars(book, cover, { eager, sizes }) {
  const image = cover
    ? `<img class="book-cover" src="${cover.src}"${cover.srcset ? ` srcset="${cover.srcset}" sizes="${sizes}"` : ''} width="${cover.width}" height="${cover.height}" alt="${escapeHtml(book.coverAlt)}"${eager ? '' : ' loading="lazy"'} decoding="async">`
    : `<div class="book-cover book-cover--missing" role="img" aria-label="${escapeHtml(`No cover image for ${book.title}`)}"><span>${escapeHtml(book.title)}</span></div>`;
  return {
    bookTitle: book.title,
    bookPath: book.path,
    bookCover: image,
    bookAuthor: book.author ? `<p class="book-author">${escapeHtml(book.author)}</p>` : '',
    bookContributors: book.contributors ? `<p class="book-contributors">${escapeHtml(book.contributors)}</p>` : '',
    bookDescription: book.descriptionHtml,
    bookPrice: book.onSale ? `<p class="book-price">${escapeHtml(/** @type {string} */ (book.price))}</p>` : '<p class="book-unavailable">Not on sale yet.</p>',
    bookBuy: book.onSale ? `<a class="button" href="${escapeHtml(/** @type {string} */ (book.paymentUrl))}">Buy</a>` : '',
  };
}

/** @param {{ loc: string, lastmod: Date|null }[]} entries */
function renderSitemap(entries) {
  const urls = entries
    .sort((a, b) => a.loc.localeCompare(b.loc))
    .map((e) => `  <url>\n    <loc>${site.url}${e.loc}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * The date a source file last changed in git, so the sitemap's lastmod means
 * something. Files not yet committed have no date.
 * @param {string} file
 */
function gitDate(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? new Date(out) : null;
  } catch {
    return null;
  }
}

/** Copies a file into dist under a content-hashed name and returns its URL. */
function hashedCopy(/** @type {string} */ file, /** @type {string} */ dir) {
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  const name = `${path.basename(file, path.extname(file))}.${hash}${path.extname(file)}`;
  fs.mkdirSync(path.join(DIST, dir), { recursive: true });
  fs.writeFileSync(path.join(DIST, dir, name), bytes);
  return `/${dir}/${name}`;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {(rel: string) => boolean} [keep]
 */
function copyDir(from, to, keep = () => true) {
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(from, abs);
    if (!keep(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(abs, path.join(to, rel));
  }
}

/** @param {string} rel @param {string} html */
function write(rel, html) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

/** @param {string} dir */
function countFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}

/**
 * Every "NEEDS:" left in the built HTML, with the text that follows it.
 * @param {string} dir
 */
function findGaps(dir) {
  /** @type {{ file: string, text: string }[]} */
  const gaps = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(html|xml|txt|json|webmanifest)$/.test(entry.name)) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(abs, 'utf8');
    const seen = new Set();
    for (const match of text.matchAll(/NEEDS:\s*([^<"\n]{0,120})/g)) {
      const what = match[1].trim();
      if (seen.has(what)) continue;
      seen.add(what);
      gaps.push({ file: path.relative(dir, abs).replace(/\\/g, '/'), text: what });
    }
  }
  return gaps;
}

main().catch((error) => {
  console.error(`Build failed: ${error.message}`);
  process.exit(1);
});
