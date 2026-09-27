// Runs the real build in a child process and checks the guards that stop a
// broken or unfinished site from being published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageWidth } from '../lib/books.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = (/** @type {Record<string, string>} */ env) => spawnSync(process.execPath, ['build.mjs'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONTEXT: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', BOOKS_SOURCE: '', ALLOW_GAPS: '', ...env },
});

test('a local build succeeds and lists the NEEDS: gaps', () => {
  const run = build({});
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /NEEDS: gap/);
  assert.match(fs.readFileSync(path.join(ROOT, 'dist', 'robots.txt'), 'utf8'), /Disallow: \//);
  assert.match(fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow">/);
});

test('a production build refuses to go live with gaps', () => {
  const run = build({ CONTEXT: 'production', BOOKS_SOURCE: 'seed' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /can't go live yet/);
});

test('a production build needs the Supabase settings', () => {
  const run = build({ CONTEXT: 'production' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /SUPABASE_URL and SUPABASE_ANON_KEY/);
});

test('a production build (checked locally with the seed) is indexable and has no noindex', () => {
  const run = build({ CONTEXT: 'production', BOOKS_SOURCE: 'seed', ALLOW_GAPS: '1' });
  assert.equal(run.status, 0, run.stderr);
  const robots = fs.readFileSync(path.join(ROOT, 'dist', 'robots.txt'), 'utf8');
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Sitemap: https:\/\/burhanbooks\.com\/sitemap\.xml/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8'), /name="robots"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'dist', '404.html'), 'utf8'), /<meta name="robots" content="noindex">/);
  build({}); // leave dist/ as a normal local build
});

test('a copy built for a folder (GitHub Pages) prefixes every internal address and switches the admin off', () => {
  const run = build({ BASE_PATH: '/burhanbooks' });
  assert.equal(run.status, 0, run.stderr);
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, 'dist', rel), 'utf8');
  const home = read('index.html');
  assert.match(home, /<link rel="stylesheet" href="\/burhanbooks\/css\/site\.[0-9a-f]+\.css">/);
  assert.match(home, /href="\/burhanbooks\/contact\/"/);
  assert.match(home, /href="\/burhanbooks\/product\/shii-theology-a-translation-of-kashf-al-murad\/"/);
  assert.match(home, /srcset="\/burhanbooks\/img\/books\/[^ ]+ 300w, \/burhanbooks\/img\/books\/[^ ]+ 468w"/);
  assert.match(home, /<link rel="canonical" href="https:\/\/burhanbooks\.com\/">/, 'canonical still names the real address');
  assert.doesNotMatch(home, /\s(?:href|src)="\/(?!burhanbooks\/)/, 'no root-relative address left unprefixed');
  const css = fs.readdirSync(path.join(ROOT, 'dist', 'css')).map((f) => read(`css/${f}`)).join('');
  assert.match(css, /url\("\/burhanbooks\/fonts\/nunito-sans\.woff2"\)/);
  assert.match(read('site.webmanifest'), /"src": "\/burhanbooks\/icon-192\.png"/);
  assert.match(read('admin/index.html'), /"supabaseUrl":null/);
  assert.match(read('admin/index.html'), /src="\/burhanbooks\/admin\/admin\.js"/);
  assert.match(read('404.html'), /href="\/burhanbooks\/"/);
  build({});
});

test('no invented social proof: no star ratings, review scores or "people viewing" counters', () => {
  const run = build({});
  assert.equal(run.status, 0, run.stderr);
  const pages = fs.readdirSync(path.join(ROOT, 'dist'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => path.join(e.parentPath, e.name));
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    assert.doesNotMatch(html, /out of 5|star.?rating|rating(value)?|aggregateRating|people[ _-]viewing|viewing[ _-](this|now)|number__of_people/i, `${path.relative(ROOT, page)} shows a rating or viewer count`);
  }
});

test('image widths are read from the file itself', () => {
  const cover = fs.readFileSync(path.join(ROOT, 'src', 'img', 'books', 'shii-theology-kashf-al-murad.jpg'));
  assert.equal(imageWidth(cover), 468);
  const png = fs.readFileSync(path.join(ROOT, 'src', 'img', 'logo-312.png'));
  assert.equal(imageWidth(png), 312);
  assert.throws(() => imageWidth(Buffer.from('not an image')), /not a JPEG, PNG or WebP/);
});
