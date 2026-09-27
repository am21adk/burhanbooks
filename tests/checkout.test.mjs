// The checkout function on its own, with Stripe and the site's books.json
// replaced, so what it asks Stripe for and each way it can refuse or fail
// are checked without a Stripe account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCheckout } from '../netlify/functions/checkout.mjs';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_example' };
const SITE = 'https://burhanbooks.com';
const STRIPE = 'https://api.stripe.com/v1/checkout/sessions';
const CATALOGUE = {
  currency: 'GBP',
  books: [
    { slug: 'kashf', title: 'Shi’i Theology', author: '‘Allamah al-Hilli', path: '/product/kashf/', pricePence: 1899,
      cover: { src: '/img/books/kashf-468-abc.jpg', thumb: '/img/books/kashf-300-def.jpg', width: 468, height: 746, alt: 'Cover' } },
    { slug: 'no-cover', title: 'No cover', author: null, path: '/product/no-cover/', pricePence: 1250, cover: null },
  ],
};

/**
 * @param {{ stripe?: number, site?: number, down?: 'stripe'|'site' }} scenario
 * @returns {{ calls: { url: string, init?: RequestInit }[], fetchImpl: typeof fetch }}
 */
function fakeNetwork({ stripe = 200, site = 200, down } = {}) {
  /** @type {{ url: string, init?: RequestInit }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${SITE}/books.json`) {
      if (down === 'site') throw new TypeError('fetch failed');
      return Response.json(CATALOGUE, { status: site });
    }
    if (url === STRIPE) {
      if (down === 'stripe') throw new TypeError('fetch failed');
      return stripe === 200
        ? Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
        : Response.json({ error: { message: 'Invalid API Key provided: sk_test_****mple' } }, { status: stripe });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

const post = (/** @type {unknown} */ body) => new Request(`${SITE}/api/checkout`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const stripeForm = (/** @type {{ url: string, init?: RequestInit }[]} */ calls) => new URLSearchParams(String(calls.find((c) => c.url === STRIPE)?.init?.body));

test('a cart becomes a Stripe payment page, priced from the site’s own list, not the browser', async () => {
  const { calls, fetchImpl } = fakeNetwork();
  const response = await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 2, pricePence: 1 }, { slug: 'no-cover', quantity: 1 }] }), ENV, fetchImpl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

  const stripeCall = calls.find((c) => c.url === STRIPE);
  assert.equal(stripeCall?.init?.method, 'POST');
  assert.equal(new Headers(stripeCall?.init?.headers).get('authorization'), 'Bearer sk_test_example');
  assert.deepEqual(Object.fromEntries(stripeForm(calls)), {
    mode: 'payment',
    success_url: `${SITE}/cart/?order=placed`,
    cancel_url: `${SITE}/cart/`,
    'line_items[0][quantity]': '2',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': '1899',
    'line_items[0][price_data][product_data][name]': 'Shi’i Theology',
    'line_items[0][price_data][product_data][images][0]': `${SITE}/img/books/kashf-468-abc.jpg`,
    'line_items[1][quantity]': '1',
    'line_items[1][price_data][currency]': 'gbp',
    'line_items[1][price_data][unit_amount]': '1250',
    'line_items[1][price_data][product_data][name]': 'No cover',
    'shipping_address_collection[allowed_countries][0]': 'GB',
  });
});

test('a delivery charge made in Stripe is added when its id is set', async () => {
  const { calls, fetchImpl } = fakeNetwork();
  await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 1 }] }), { ...ENV, STRIPE_SHIPPING_RATE: 'shr_123' }, fetchImpl);
  assert.equal(stripeForm(calls).get('shipping_options[0][shipping_rate]'), 'shr_123');
});

test('copies are capped at 10 a book, and repeated lines are added together', async () => {
  const { calls, fetchImpl } = fakeNetwork();
  await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 50 }, { slug: 'no-cover', quantity: 2 }, { slug: 'no-cover', quantity: 3 }] }), ENV, fetchImpl);
  const form = stripeForm(calls);
  assert.equal(form.get('line_items[0][quantity]'), '10');
  assert.equal(form.get('line_items[1][quantity]'), '5');
  assert.equal(form.has('line_items[2][quantity]'), false);
});

test('only POST', async () => {
  const { calls, fetchImpl } = fakeNetwork();
  assert.equal((await handleCheckout(new Request(`${SITE}/api/checkout`), ENV, fetchImpl)).status, 405);
  assert.equal(calls.length, 0);
});

test('without the Stripe key, the customer is told checkout isn’t available and nothing is called', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { calls, fetchImpl } = fakeNetwork();
  const response = await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 1 }] }), {}, fetchImpl);
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /isn’t available yet/);
  assert.equal(calls.length, 0);
});

test('an empty or nonsense cart is refused before anything is called', async () => {
  for (const body of [{ items: [] }, {}, { items: 'kashf' }, { items: [{ slug: 'Bad Slug', quantity: 1 }] }, 'not json']) {
    const { calls, fetchImpl } = fakeNetwork();
    const response = await handleCheckout(post(body), ENV, fetchImpl);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test('a book no longer on sale is named back to the cart, and Stripe is never asked', async () => {
  const { calls, fetchImpl } = fakeNetwork();
  const response = await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 1 }, { slug: 'withdrawn', quantity: 1 }] }), ENV, fetchImpl);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body.unavailable, ['withdrawn']);
  assert.match(body.message, /no longer on sale/);
  assert.ok(!calls.some((c) => c.url === STRIPE));
});

test('when the book list or Stripe fails, the customer gets a plain message and no details', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  for (const scenario of [{ down: 'site' }, { site: 500 }, { down: 'stripe' }, { stripe: 401 }]) {
    const { fetchImpl } = fakeNetwork(/** @type {Parameters<typeof fakeNetwork>[0]} */ (scenario));
    const response = await handleCheckout(post({ items: [{ slug: 'kashf', quantity: 1 }] }), ENV, fetchImpl);
    assert.equal(response.status, 502, JSON.stringify(scenario));
    const { message } = await response.json();
    assert.equal(message, 'The payment page couldn’t be opened. Try again in a minute.');
  }
  assert.ok(logged.mock.calls.some((c) => String(c.arguments[0]).includes('Invalid API Key')), 'Stripe’s reason goes to the Netlify log');
});
