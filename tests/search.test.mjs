// Drives search in a real browser: the panel that drops down from the
// magnifier, and the /search/ page it leads to. Uses a normal local build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/preview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const BOOK = 'Shi’i Theology: A translation of Kashf al-Murad';

/** @type {import('node:http').Server} */
let server;
/** @type {import('playwright').Browser} */
let browser;
/** @type {import('playwright').Page} */
let page;
/** @type {string[]} */
const consoleProblems = [];

const panel = () => page.getByRole('dialog', { name: 'Search' });
const card = () => page.locator('.book-card', { hasText: BOOK });
const summary = () => page.locator('[data-search-summary]');

before(async () => {
  const run = spawnSync(process.execPath, ['build.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CONTEXT: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', BASE_PATH: '' } });
  assert.equal(run.status, 0, run.stderr);
  server = /** @type {import('node:http').Server} */ (await startPreview({ port: PORT }));
  browser = await chromium.launch();
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleProblems.push(m.text()); });
  page.on('pageerror', (e) => consoleProblems.push(String(e)));
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('the magnifier drops the search panel down from the top, ready to type in', async () => {
  await page.goto(`${BASE}/contact/`);
  await page.getByRole('link', { name: 'Search' }).click();
  await panel().waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const box = await panel().boundingBox();
  assert.ok(box && box.y === 0 && box.width === 1280, 'full width, against the top');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search-panel-q');
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search', 'focus returns to the magnifier');
});

test('searching goes to /search/ and shows the books that match', async () => {
  await page.getByRole('link', { name: 'Search' }).click();
  await page.keyboard.type('theology');
  await page.keyboard.press('Enter');
  await page.waitForURL(`${BASE}/search/?q=theology`);
  assert.equal(await summary().textContent(), '1 book matches “theology”.');
  assert.equal(await card().isVisible(), true);
  assert.equal(await page.getByLabel('Search books').inputValue(), 'theology', 'the box keeps what was searched');
});

test('case, accents and ‘ayn marks don’t matter; translators count; every word must match', async () => {
  for (const q of ['SHI’I', 'shii hilli', 'Ḥillī', 'bozorgi', 'kashf murad']) {
    await page.goto(`${BASE}/search/?q=${encodeURIComponent(q)}`);
    assert.equal(await summary().textContent(), `1 book matches “${q}”.`, q);
  }
  await page.goto(`${BASE}/search/?q=${encodeURIComponent('theology cookery')}`);
  assert.equal(await summary().textContent(), 'No books match “theology cookery”. Try fewer or different words.');
  assert.equal(await card().isVisible(), false);
});

test('with nothing typed, /search/ lists every book', async () => {
  await page.goto(`${BASE}/search/`);
  assert.equal(await summary().textContent(), '');
  assert.equal(await card().isVisible(), true);
});

test('no errors in the console', () => {
  assert.deepEqual(consoleProblems, []);
});
