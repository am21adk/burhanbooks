// A stand-in for Stripe Checkout, so the cart can be clicked through to
// "paid" on this machine without a Stripe account. /api/checkout runs the
// real function from netlify/functions/checkout.mjs; only its call to
// Stripe is answered here, with a plain page that sends you back to the
// site the way Stripe would after paying, or after pressing Back.
//
// Nothing is charged and nothing leaves this machine. Preview only.
import { handleCheckout } from '../netlify/functions/checkout.mjs';
import { escapeHtml, formatPrice } from '../src/js/shared.js';

/** Every checkout asked for, as the form Stripe would have received. */
export const stripeState = { sessions: /** @type {URLSearchParams[]} */ ([]) };

/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** /api/checkout, using the real Netlify function. @type {import('./preview.mjs').Route} */
async function checkoutRoute(req, res, url) {
  if (url.pathname !== '/api/checkout') return false;
  const origin = `http://${req.headers.host}`;
  const request = new Request(`${origin}/api/checkout`, {
    method: req.method,
    headers: { 'content-type': String(req.headers['content-type'] || '') },
    body: req.method === 'POST' ? await readBody(req) : undefined,
  });
  /** @type {typeof fetch} */
  const stripe = async (input, init) => {
    if (String(input) !== 'https://api.stripe.com/v1/checkout/sessions') return fetch(input, init);
    stripeState.sessions.push(new URLSearchParams(String(init?.body)));
    return Response.json({ url: `${origin}/__stripe/pay?session=${stripeState.sessions.length - 1}` });
  };
  const response = await handleCheckout(request, { STRIPE_SECRET_KEY: 'sk_test_local_preview' }, stripe);
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
  return true;
}

/** The stand-in payment page. @type {import('./preview.mjs').Route} */
function payPage(req, res, url) {
  if (url.pathname !== '/__stripe/pay') return false;
  const session = stripeState.sessions[Number(url.searchParams.get('session'))];
  if (!session) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('No such checkout');
    return true;
  }
  const lines = [];
  let total = 0;
  for (let i = 0; session.has(`line_items[${i}][quantity]`); i++) {
    const quantity = Number(session.get(`line_items[${i}][quantity]`));
    const each = Number(session.get(`line_items[${i}][price_data][unit_amount]`));
    total += quantity * each;
    lines.push(`<li>${escapeHtml(session.get(`line_items[${i}][price_data][product_data][name]`) || '')} × ${quantity}, ${formatPrice(each)} each</li>`);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stand-in payment page</title></head>
<body style="max-width: 36rem; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.5">
<h1>Stand-in payment page</h1>
<p>On the real site this is Stripe's payment page. Nothing is charged here.</p>
<ul>${lines.join('')}</ul>
<p><strong>Total before delivery: ${formatPrice(total)}</strong></p>
<p>Delivery address in: ${escapeHtml(session.get('shipping_address_collection[allowed_countries][0]') || 'anywhere')}</p>
<p><a href="${escapeHtml(session.get('success_url') || '/')}">Pay</a> · <a href="${escapeHtml(session.get('cancel_url') || '/')}">Back</a></p>
</body>
</html>`);
  return true;
}

export const routes = [checkoutRoute, payPage];
