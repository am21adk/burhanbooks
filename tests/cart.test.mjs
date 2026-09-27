// Drives the cart in a real browser, from Add to cart to the payment page
// and back, against the Supabase and Stripe stand-ins. The book is given a
// price in the stand-in only (it has none yet), then the site is rebuilt
// from it; a normal local build is left behind when it's done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/preview.mjs';
import { routes as supabase, state } from '../scripts/supabase-standin.mjs';
import { routes as stripe, stripeState } from '../scripts/stripe-standin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.CART_SHOTS || '';
const SLUG = 'shii-theology-a-translation-of-kashf-al-murad';
const BOOK = 'Shi’i Theology: A translation of Kashf al-Murad';

/** @type {import('node:http').Server} */
let server;
/** @type {import('playwright').Browser} */
let browser;
/** @type {import('playwright').Page} */
let page;
/** @type {string[]} */
const consoleProblems = [];

const build = (/** @type {Record<string, string>} */ env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['build.mjs'], { cwd: ROOT, env: { ...process.env, CONTEXT: '', ...env } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`build failed: ${stderr}`))));
});
const shot = async (/** @type {string} */ name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };
const badge = () => page.locator('[data-cart-count]');
const line = () => page.locator('.cart-line', { hasText: BOOK });

before(async () => {
  const book = state.books.find((b) => b.slug === SLUG);
  assert.ok(book);
  book.price_pence = 1899;
  server = /** @type {import('node:http').Server} */ (await startPreview({ port: PORT, extraRoutes: [...supabase, ...stripe] }));
  await build({ SUPABASE_URL: `${BASE}/supabase`, SUPABASE_ANON_KEY: 'local-preview-anon-key' });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleProblems.push(m.text()); });
  page.on('pageerror', (e) => consoleProblems.push(String(e)));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  server?.close();
  await build();
});

const panel = () => page.getByRole('dialog', { name: 'Cart' });
const panelLine = () => panel().locator('.cart-line', { hasText: BOOK });
const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim());
const settled = () => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));

test('Add to cart opens the cart over the page, from the right, and the Cart link counts it', async () => {
  await page.goto(`${BASE}/product/${SLUG}/`);
  assert.equal(await badge().isVisible(), false, 'no count while the cart is empty');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await panel().waitFor();
  await panel().getByText('Added to your cart.').waitFor();
  await panelLine().waitFor();
  assert.equal(await focused(), 'cart-panel-title', 'focus goes to the panel’s heading');
  assert.equal(await badge().textContent(), '1');
  await settled();
  const box = await panel().boundingBox();
  assert.ok(box && Math.round(box.x + box.width) === 1280 && box.width === 480, 'a 480px panel against the right edge');

  await panel().getByRole('button', { name: 'Continue shopping' }).click();
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await focused(), 'Add to cart', 'focus returns to the button that opened it');

  await page.getByRole('button', { name: 'Add to cart' }).click();
  await panelLine().locator('.quantity__value', { hasText: '2' }).waitFor();
  assert.equal(await badge().textContent(), '2');
  await shot('cart-panel');
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, `/product/${SLUG}/`, 'never left the book page');
});

test('the Cart link opens the same panel on any page; a click on the dimmed page closes it', async () => {
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'Cart, 2 books' }).click();
  await panelLine().waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page.mouse.click(20, 450);
  await panel().waitFor({ state: 'hidden' });
});

test('in the panel, the quantity buttons keep focus and the subtotal follows; Checkout goes to the payment page', async () => {
  await page.getByRole('link', { name: 'Cart, 2 books' }).click();
  await panelLine().waitFor();
  assert.equal(await panelLine().locator('.cart-line__each').textContent(), '£18.99 each');
  assert.equal(await panelLine().locator('.cart-line__total').textContent(), '£37.98');

  await panelLine().getByRole('button', { name: 'One more' }).click();
  assert.equal(await panelLine().locator('.quantity__value').textContent(), '3');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'One more');
  assert.match(await panel().locator('.cart__subtotal').textContent() || '', /£56\.97/);
  await page.getByText(`3 copies of ${BOOK}.`).waitFor();

  await panelLine().getByRole('button', { name: 'One fewer' }).click();
  await panelLine().getByRole('button', { name: 'One fewer' }).click();
  assert.equal(await panelLine().locator('.quantity__value').textContent(), '1');
  assert.equal(await panelLine().getByRole('button', { name: 'One fewer' }).getAttribute('aria-disabled'), 'true', 'can’t go below one: Remove does that');
  await panelLine().getByRole('button', { name: 'One fewer' }).click({ force: true });
  assert.equal(await panelLine().locator('.quantity__value').textContent(), '1');
  assert.equal(await badge().textContent(), '1');

  const sessions = stripeState.sessions.length;
  await panel().getByRole('button', { name: 'Checkout' }).click();
  await page.waitForURL(/\/__stripe\/pay/);
  assert.equal(stripeState.sessions.length, sessions + 1);
  const form = stripeState.sessions.at(-1);
  assert.equal(form?.get('line_items[0][quantity]'), '1');
  assert.equal(form?.get('line_items[0][price_data][unit_amount]'), '1899');
  assert.equal(form?.get('shipping_address_collection[allowed_countries][0]'), 'GB');
});

test('Back from the payment page lands on the cart page, with the cart as it was', async () => {
  await page.getByRole('link', { name: 'Back' }).click();
  await page.waitForURL(`${BASE}/cart/`);
  await line().waitFor();
  assert.match(await page.locator('.cart__subtotal').textContent() || '', /Subtotal\s+£18\.99/);
  assert.equal(await badge().textContent(), '1');
  await shot('cart-page');
});

test('paying empties the cart and says thank you', async () => {
  await page.getByRole('button', { name: 'Checkout' }).click();
  await page.waitForURL(/\/__stripe\/pay/);
  await page.getByRole('link', { name: 'Pay' }).click();
  await page.getByRole('heading', { name: 'Thank you' }).waitFor();
  await page.getByText('Your order has been placed.').waitFor();
  assert.equal(new URL(page.url()).search, '', 'the address is tidied, so reloading doesn’t repeat it');
  assert.equal(await badge().isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('burhanbooks-cart')), null);
  await shot('cart-thank-you');
});

test('Remove takes the book out, and an empty cart says so', async () => {
  await page.goto(`${BASE}/cart/?add=${SLUG}`);
  await line().waitFor();
  assert.equal(new URL(page.url()).search, '', 'the ?add= from a book page without the script is used once, then tidied');
  await line().getByRole('button', { name: `Remove ${BOOK}` }).click();
  await page.getByText('Your cart is empty.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cart-title', 'focus goes to the heading');
  await page.getByText(`Removed ${BOOK}.`).waitFor();
  await shot('cart-empty');
});

test('a book that has gone off sale is taken out of the cart, with a note', async () => {
  await page.evaluate((slug) => localStorage.setItem('burhanbooks-cart', JSON.stringify([{ slug, quantity: 1 }, { slug: 'withdrawn-book', quantity: 2 }])), SLUG);
  await page.goto(`${BASE}/cart/`);
  await page.getByText('A book in your cart is no longer on sale, so it’s been taken out.').waitFor();
  assert.equal(await page.locator('.cart-line').count(), 1);
  assert.equal(await badge().textContent(), '1');
});

test('no errors in the console', () => {
  assert.deepEqual(consoleProblems, []);
});
