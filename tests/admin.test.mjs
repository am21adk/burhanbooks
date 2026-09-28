// Drives the admin in a real browser against the Supabase stand-in, from
// sign-in to publishing, including the ways it can go wrong. Starts its own
// preview server on a spare port and rebuilds dist/ for it; leaves a normal
// local build behind when it's done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/preview.mjs';
import { routes, state } from '../scripts/supabase-standin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.ADMIN_SHOTS || '';
const BOOK = 'Shi’i Theology: A translation of Kashf al-Murad';

/** @type {import('node:http').Server} */
let server;
/** @type {import('playwright').Browser} */
let browser;
/** @type {import('playwright').Page} */
let page;
/** @type {string[]} */
const consoleProblems = [];

/** Runs the build without blocking, since it reads from the stand-in this same process serves. */
const build = (/** @type {Record<string, string>} */ env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['build.mjs'], { cwd: ROOT, env: { ...process.env, CONTEXT: '', ...env } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`build failed: ${stderr}`))));
});
const shot = async (/** @type {string} */ name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };

before(async () => {
  server = /** @type {import('node:http').Server} */ (await startPreview({ port: PORT, extraRoutes: routes }));
  await build({ SUPABASE_URL: `${BASE}/supabase`, SUPABASE_ANON_KEY: 'local-preview-anon-key' });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('Failed to load resource')) consoleProblems.push(m.text()); });
  page.on('pageerror', (e) => consoleProblems.push(String(e)));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.close();
  await build();
});

test('signed out: only the sign-in form, with the reason for each refusal', async () => {
  await page.goto(`${BASE}/admin/`);
  await page.getByRole('heading', { name: 'Admin sign in' }).waitFor();
  assert.equal(await page.locator('#account').isVisible(), false, 'no Sign out while signed out');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Admin sign in', 'focus starts on the heading');

  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Enter your email address.').waitFor();

  await page.getByLabel('Email').fill('admin@burhanbooks.test');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('That email and password don’t match an account.').waitFor();

  await page.getByLabel('Email').fill('unconfirmed@burhanbooks.test');
  await page.getByLabel('Password').fill('preview');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('This account’s email address hasn’t been confirmed, so Supabase won’t sign it in.', { exact: false }).waitFor();

  await page.getByLabel('Email').fill('someone@burhanbooks.test');
  await page.getByLabel('Password').fill('preview');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('This account isn’t the shop’s admin, so it can’t use this page.').waitFor();
  assert.equal(await page.locator('#account').isVisible(), false);
  await shot('admin-signin-refused');
});

test('the admin signs in and sees every book with its state', async () => {
  await page.getByLabel('Email').fill('admin@burhanbooks.test');
  await page.getByLabel('Password').fill('preview');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Books' }).waitFor();
  await page.getByText('Signed in as admin@burhanbooks.test').waitFor();
  const row = page.locator('.admin-book', { hasText: BOOK });
  assert.equal(await row.locator('.admin-book__meta').textContent(), 'On the site · No price yet');
  await shot('admin-list');
});

test('bad values are explained next to their fields and nothing is saved', async () => {
  await page.getByRole('button', { name: `Edit ${BOOK}` }).click();
  await page.getByRole('heading', { name: `Edit “${BOOK}”` }).waitFor();
  await page.getByLabel(/Price in pounds/).fill('abc');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Check the highlighted field and save again.').waitFor();
  await page.getByText('Enter a price such as 18.99, or leave it empty.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-price', 'focus moves to the first problem');
  assert.equal(await page.getByLabel(/Price in pounds/).getAttribute('aria-invalid'), 'true');
  await shot('admin-edit-errors');
});

test('saving a price, then publishing, puts Add to cart on the public page', async () => {
  await page.getByLabel(/Price in pounds/).fill('18.99');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText(`Saved “${BOOK}”. Press Publish changes to update the public site.`).waitFor();
  assert.equal(await page.locator('.admin-book', { hasText: BOOK }).locator('.admin-book__meta').textContent(), 'On the site · £18.99');

  const published = state.publishes.length;
  await page.getByRole('button', { name: 'Publish changes' }).click();
  await page.getByText('Publishing started. The public site will show your changes in a minute or two.').waitFor();
  assert.equal(state.publishes.length, published + 1, 'the build hook was called once');
  assert.match(state.publishes.at(-1) || '', /admin@burhanbooks\.test/);

  for (let i = 0; i < 100 && state.rebuilding; i++) await new Promise((r) => setTimeout(r, 100));
  const html = fs.readFileSync(path.join(ROOT, 'dist', 'product', 'shii-theology-a-translation-of-kashf-al-murad', 'index.html'), 'utf8');
  assert.match(html, /<p class="book-price">£18\.99<\/p>/);
  assert.match(html, /<form class="add-to-cart" action="\/cart\/" method="get" data-add-to-cart>/);
  assert.match(html, /<button class="button" type="submit">Add to cart<\/button>/);
  const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'books.json'), 'utf8'));
  assert.deepEqual(catalogue.books.map((/** @type {{ slug: string, pricePence: number }} */ b) => [b.slug, b.pricePence]), [['shii-theology-a-translation-of-kashf-al-murad', 1899]]);
  assert.doesNotMatch(html, /Not on sale yet/);
});

test('adding a draft with a cover: the address follows the title, the cover is resized and uploaded', async () => {
  await page.getByRole('button', { name: 'Add a book' }).click();
  await page.getByRole('heading', { name: 'Add a book' }).waitFor();
  await page.getByLabel('Title').fill('A Test Book: Volume One');
  assert.equal(await page.getByLabel('Web address').inputValue(), 'a-test-book-volume-one');
  await page.locator('#f-cover').setInputFiles(path.join(ROOT, 'src', 'img', 'share.jpg'));
  await page.locator('#f-cover-preview img[alt="The new cover, not saved yet"]').waitFor();
  await page.getByLabel(/Description/).fill('A *short* description.\n\nSecond **paragraph**.');
  await page.locator('.preview summary').click();
  assert.equal(await page.locator('#f-description-preview').innerHTML(), '<p>A <em>short</em> description.</p>\n<p>Second <strong>paragraph</strong>.</p>');
  await shot('admin-add');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved “A Test Book: Volume One”.', { exact: false }).waitFor();
  const row = page.locator('.admin-book', { hasText: 'A Test Book: Volume One' });
  assert.equal(await row.locator('.admin-book__meta').textContent(), 'Draft, not on the site · No price yet');
  const saved = state.books.find((b) => b.slug === 'a-test-book-volume-one');
  assert.ok(saved, 'saved to the stand-in');
  assert.equal(saved.cover_width, 480, '1x width recorded');
  assert.equal(saved.cover_height, 252);
  assert.match(saved.cover_url, /books\/a-test-book-volume-one-.+-960\.jpg$/);
  assert.match(saved.cover_small_url, /-480\.jpg$/);
  assert.equal(state.files.size, 2, 'both sizes uploaded');
});

test('an address already in use is refused with a clear message', async () => {
  await page.getByRole('button', { name: 'Add a book' }).click();
  await page.getByLabel('Title').fill('Duplicate');
  await page.getByLabel('Web address').fill('a-test-book-volume-one');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('#f-slug-error', { hasText: 'Another book already uses that web address.' }).waitFor();
  await page.locator('#book-error', { hasText: 'Not saved.' }).waitFor();
});

test('leaving with unsaved changes asks first', async () => {
  await page.getByRole('button', { name: 'Cancel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard your changes?' });
  await dialog.waitFor();
  await shot('admin-discard-dialog');
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('heading', { name: 'Add a book' }).waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('heading', { name: 'Books' }).waitFor();
});

test('deleting a book asks first, then removes it and its cover files', async () => {
  await page.getByRole('button', { name: 'Edit A Test Book: Volume One' }).click();
  await page.getByRole('button', { name: 'Delete book' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this book?' });
  await dialog.getByRole('button', { name: 'Delete book' }).click();
  await page.getByText('Deleted “A Test Book: Volume One”. Press Publish changes to take it off the public site.').waitFor();
  assert.equal(await page.locator('.admin-book', { hasText: 'A Test Book' }).count(), 0);
  for (let i = 0; i < 20 && state.files.size; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.files.size, 0, 'cover files deleted too');
});

test('if the database can’t be reached, the list says so and offers to try again', async () => {
  await page.route('**/supabase/rest/v1/books**', (route) => route.abort());
  await page.reload();
  await page.getByText('Couldn’t load the books. Couldn’t reach the database. Check your internet connection and try again.').waitFor();
  await shot('admin-offline');
  await page.unroute('**/supabase/rest/v1/books**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('.admin-book', { hasText: BOOK }).waitFor();
});

test('an expired sign-in goes back to the sign-in form with the reason', async () => {
  await page.evaluate(() => {
    const key = 'burhanbooks.admin.session';
    const session = JSON.parse(sessionStorage.getItem(key) || '{}');
    sessionStorage.setItem(key, JSON.stringify({ ...session, access_token: 'expired', refresh_token: 'expired', expires_at: 0 }));
  });
  await page.reload();
  await page.getByText('Your sign-in has expired. Sign in again to carry on.').waitFor();
  await page.getByRole('heading', { name: 'Admin sign in' }).waitFor();
});

test('on the GitHub Pages preview, Publish opens the workflow on GitHub instead', async () => {
  const workflow = 'https://github.com/am21adk/burhanbooks/actions/workflows/pages.yml';
  await build({ SUPABASE_URL: `${BASE}/supabase`, SUPABASE_ANON_KEY: 'local-preview-anon-key', PREVIEW_PUBLISH_URL: workflow });
  await page.goto(`${BASE}/admin/`);
  await page.getByLabel('Email').fill('admin@burhanbooks.test');
  await page.getByLabel('Password').fill('preview');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Books' }).waitFor();
  const link = page.getByRole('link', { name: 'Publish on GitHub (opens in a new tab)' });
  assert.equal(await link.getAttribute('href'), workflow);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await page.getByRole('button', { name: 'Publish changes' }).count(), 0);
  assert.match(await page.locator('#publish-note').textContent() || '', /press Run workflow there/);
  assert.ok(await page.locator('.admin-account').isVisible());
  const account = await page.locator('.admin-account').boundingBox();
  const publish = await link.boundingBox();
  assert.ok(account && publish && Math.abs((account.x + account.width) - (publish.x + publish.width)) <= 1, 'Sign out lines up with the right edge of the page');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Admin sign in' }).waitFor();
  await build({ SUPABASE_URL: `${BASE}/supabase`, SUPABASE_ANON_KEY: 'local-preview-anon-key' });
  await page.goto(`${BASE}/admin/`);
});

test('signing out returns to the sign-in form', async () => {
  await page.getByLabel('Email').fill('admin@burhanbooks.test');
  await page.getByLabel('Password').fill('preview');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Books' }).waitFor();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Admin sign in' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('burhanbooks.admin.session')), null);
});

test('no errors or warnings in the console along the way', () => {
  assert.deepEqual(consoleProblems, []);
});
