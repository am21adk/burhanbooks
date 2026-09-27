// POST /api/checkout: turns a cart into a Stripe Checkout page and replies
// with its address. The browser sends only each book's web address and how
// many copies; the titles and prices come from /books.json, the list of books
// on sale that the build wrote along with the pages, so a book is charged
// the price its page shows. The Stripe secret key (STRIPE_SECRET_KEY) stays
// on Netlify and never reaches the browser.
import { CURRENCY, normaliseCart } from '../../src/js/shared.js';

// Stripe asks for a delivery address in these countries only (ISO codes).
const DELIVERY_COUNTRIES = ['GB'];

/** @typedef {{ slug: string, title: string, pricePence: number, cover: { src: string }|null }} CatalogueBook */

/** @param {number} status @param {Record<string, unknown>} body */
function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const UNAVAILABLE = 'The payment page couldn’t be opened. Try again in a minute.';

/**
 * Netlify calls the default export with (request, context), so the settings
 * are read here and the work is done by handleCheckout, which tests and the
 * preview server call with settings (and a stand-in for Stripe) of their own.
 * @param {Request} request
 */
export default async function checkout(request) {
  return handleCheckout(request, process.env);
}

/**
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 * @param {typeof fetch} [fetchImpl]
 */
export async function handleCheckout(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return reply(405, { message: 'Use POST to check out.' });
  if (!env.STRIPE_SECRET_KEY) {
    console.error('Checkout isn’t set up: STRIPE_SECRET_KEY is missing from the site’s environment variables on Netlify.');
    return reply(503, { message: 'Checkout isn’t available yet. Please try again later.' });
  }

  const body = /** @type {{ items?: unknown }|null} */ (await request.json().catch(() => null));
  const cart = normaliseCart(body?.items);
  if (!cart.length) return reply(400, { message: 'Your cart is empty.' });

  const origin = new URL(request.url).origin;
  /** @type {Map<string, CatalogueBook>} */
  let books;
  try {
    const response = await fetchImpl(`${origin}/books.json`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`books.json returned ${response.status}`);
    const catalogue = /** @type {{ books: CatalogueBook[] }} */ (await response.json());
    books = new Map(catalogue.books.map((book) => [book.slug, book]));
  } catch (error) {
    console.error('Checkout couldn’t read books.json:', error);
    return reply(502, { message: UNAVAILABLE });
  }

  const unavailable = cart.filter((line) => !books.has(line.slug)).map((line) => line.slug);
  if (unavailable.length) {
    return reply(409, {
      message: unavailable.length === 1
        ? 'A book in your cart is no longer on sale, so it’s been taken out. Check your cart, then check out again.'
        : 'Some books in your cart are no longer on sale, so they’ve been taken out. Check your cart, then check out again.',
      unavailable,
    });
  }

  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${origin}/cart/?order=placed`,
    cancel_url: `${origin}/cart/`,
  });
  cart.forEach((line, i) => {
    const book = /** @type {CatalogueBook} */ (books.get(line.slug));
    const item = `line_items[${i}]`;
    params.set(`${item}[quantity]`, String(line.quantity));
    params.set(`${item}[price_data][currency]`, CURRENCY.toLowerCase());
    params.set(`${item}[price_data][unit_amount]`, String(book.pricePence));
    params.set(`${item}[price_data][product_data][name]`, book.title);
    // Stripe fetches the cover itself, so only from a public https address.
    if (book.cover && origin.startsWith('https://')) params.set(`${item}[price_data][product_data][images][0]`, origin + book.cover.src);
  });
  DELIVERY_COUNTRIES.forEach((country, i) => params.set(`shipping_address_collection[allowed_countries][${i}]`, country));
  // A delivery charge, if there is one, is a shipping rate made in Stripe.
  if (env.STRIPE_SHIPPING_RATE) params.set('shipping_options[0][shipping_rate]', env.STRIPE_SHIPPING_RATE);

  try {
    const response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(15000),
    });
    const session = /** @type {{ url?: unknown, error?: { message?: string } }} */ (await response.json().catch(() => ({})));
    if (!response.ok || typeof session.url !== 'string') {
      console.error(`Stripe refused the checkout (${response.status}): ${session.error?.message ?? 'no message'}`);
      return reply(502, { message: UNAVAILABLE });
    }
    return reply(200, { url: session.url });
  } catch (error) {
    console.error('Couldn’t reach Stripe:', error);
    return reply(502, { message: UNAVAILABLE });
  }
}

export const config = { path: '/api/checkout' };
