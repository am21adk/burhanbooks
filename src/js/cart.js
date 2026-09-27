// The cart. It lives in this browser (localStorage) as each book's web
// address and number of copies, nothing more: titles and prices always come
// from books.json, which the build writes from the same books as the pages.
// Checkout sends only addresses and copies, and /api/checkout prices them
// again itself.
//
// On every page this shows how many books are in the cart beside the Cart
// link. On a book page it makes Add to cart work without leaving the page,
// and on /cart/ it shows the cart.
import { MAX_QUANTITY, escapeHtml, formatPrice, keepHyphenatedWordsTogether, normaliseCart } from './shared.js';

/** @typedef {{ slug: string, quantity: number }} Line */
/**
 * @typedef {{ slug: string, title: string, author: string|null, path: string, pricePence: number,
 *   cover: { src: string, thumb: string, width: number, height: number, alt: string }|null }} CatalogueBook
 */

const KEY = 'burhanbooks-cart';
// The site's root, from where this script is served: /js/cart.js, or
// /burhanbooks/js/cart.js on the GitHub Pages copy.
const ROOT = new URL('../', import.meta.url);
const sitePath = (/** @type {string} */ rootRelative) => new URL(rootRelative.replace(/^\//, ''), ROOT).pathname;

// If this browser won't store anything (some private windows), the cart
// still works for as long as the page stays open.
/** @type {Line[]} */
let unsaved = [];

/** @returns {Line[]} */
function readCart() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? unsaved : normaliseCart(JSON.parse(stored));
  } catch {
    return unsaved;
  }
}

/** @param {Line[]} lines */
function writeCart(lines) {
  unsaved = normaliseCart(lines);
  try {
    if (unsaved.length) localStorage.setItem(KEY, JSON.stringify(unsaved));
    else localStorage.removeItem(KEY);
  } catch {
    // Kept in `unsaved` instead.
  }
  paintCount();
}

/**
 * @param {string} slug
 * @returns {number} how many copies of the book the cart now holds
 */
function addToCart(slug) {
  const lines = readCart();
  const line = lines.find((l) => l.slug === slug);
  if (line) line.quantity = Math.min(MAX_QUANTITY, line.quantity + 1);
  else lines.push({ slug, quantity: 1 });
  writeCart(lines);
  return copiesOf(slug);
}

const copiesOf = (/** @type {string} */ slug) => readCart().find((l) => l.slug === slug)?.quantity ?? 0;
const copies = (/** @type {number} */ n) => `${n} ${n === 1 ? 'copy' : 'copies'}`;

/** The number beside the Cart link, on every page. */
function paintCount() {
  const count = readCart().reduce((sum, line) => sum + line.quantity, 0);
  for (const badge of document.querySelectorAll('[data-cart-count]')) {
    badge.textContent = count > 99 ? '99+' : String(count);
    /** @type {HTMLElement} */ (badge).hidden = count === 0;
  }
  for (const link of document.querySelectorAll('[data-cart-link]')) {
    if (count) link.setAttribute('aria-label', `Cart, ${count} ${count === 1 ? 'book' : 'books'}`);
    else link.removeAttribute('aria-label');
  }
}

/* ---------- Book pages: Add to cart ---------- */

for (const form of document.querySelectorAll('form[data-add-to-cart]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const slug = String(new FormData(/** @type {HTMLFormElement} */ (form)).get('add') || '');
    const before = copiesOf(slug);
    const now = addToCart(slug);
    const status = form.querySelector('[data-cart-status]');
    if (!status) return;
    const message = now === before
      ? `Your cart already has ${copies(MAX_QUANTITY)} of this book, the most one order can take.`
      : now === 1 ? 'Added to your cart.' : `Added. Your cart has ${copies(now)} of this book.`;
    status.innerHTML = `${escapeHtml(message)} <a href="${sitePath('/cart/')}">View cart</a>`;
  });
}

/* ---------- The cart page ---------- */

/** @param {HTMLElement} root */
async function startCartPage(root) {
  const params = new URLSearchParams(location.search);
  const heading = document.getElementById('cart-title');

  // Stripe sends the customer back here once they've paid.
  if (params.get('order') === 'placed') {
    writeCart([]);
    history.replaceState(null, '', location.pathname);
    if (heading) heading.textContent = 'Thank you';
    root.innerHTML = `<div class="cart__message"><p>Your order has been placed.</p>
      <p><a class="button button--secondary" href="${sitePath('/')}">See all books</a></p></div>`;
    return;
  }
  // Add to cart without the script on the book page lands here as ?add=….
  const adding = params.get('add');
  if (adding) {
    addToCart(adding);
    history.replaceState(null, '', location.pathname);
  }

  root.innerHTML = '<p class="cart__message">Loading your cart…</p>';
  /** @type {Map<string, CatalogueBook>} */
  let books;
  try {
    const response = await fetch(new URL('books.json', ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`books.json: ${response.status}`);
    const catalogue = /** @type {{ books: CatalogueBook[] }} */ (await response.json());
    books = new Map(catalogue.books.map((book) => [book.slug, book]));
  } catch {
    root.innerHTML = '<p class="cart__message">Your cart couldn’t load. Check your connection, then reload the page.</p>';
    return;
  }

  // Screen readers hear what each button did here; the cart itself is redrawn.
  const announcer = document.createElement('p');
  announcer.className = 'visually-hidden';
  announcer.setAttribute('role', 'status');
  root.after(announcer);
  let notice = '';

  /** Takes out books that are no longer on sale, and says so once. */
  const currentLines = () => {
    const lines = readCart();
    const kept = lines.filter((line) => books.has(line.slug));
    if (kept.length < lines.length) {
      writeCart(kept);
      notice = lines.length - kept.length === 1
        ? 'A book in your cart is no longer on sale, so it’s been taken out.'
        : 'Some books in your cart are no longer on sale, so they’ve been taken out.';
    }
    return kept;
  };

  /** @param {Line} line */
  const lineHtml = (line) => {
    const book = /** @type {CatalogueBook} */ (books.get(line.slug));
    const href = sitePath(book.path);
    const title = escapeHtml(book.title);
    const cover = book.cover
      ? `<img class="book-cover" src="${sitePath(book.cover.thumb)}" width="${book.cover.width}" height="${book.cover.height}" alt="">`
      : '<span class="book-cover book-cover--missing"></span>';
    return `<li class="cart-line" data-slug="${escapeHtml(line.slug)}">
      <a class="cart-line__cover tile" href="${href}" tabindex="-1" aria-hidden="true">${cover}</a>
      <div class="cart-line__body">
        <h2 class="cart-line__title"><a href="${href}">${keepHyphenatedWordsTogether(book.title)}</a></h2>
        ${book.author ? `<p class="cart-line__author label">${keepHyphenatedWordsTogether(book.author)}</p>` : ''}
        <p class="cart-line__each">${formatPrice(book.pricePence)} each</p>
        <div class="cart-line__controls">
          <div class="quantity" role="group" aria-label="Copies of ${title}">
            <button class="quantity__step" type="button" data-act="fewer" aria-label="One fewer"${line.quantity <= 1 ? ' aria-disabled="true"' : ''}>−</button>
            <span class="quantity__value">${line.quantity}</span>
            <button class="quantity__step" type="button" data-act="more" aria-label="One more"${line.quantity >= MAX_QUANTITY ? ' aria-disabled="true"' : ''}>+</button>
          </div>
          <button class="link-button" type="button" data-act="remove">Remove<span class="visually-hidden"> ${title}</span></button>
        </div>
      </div>
      <p class="cart-line__total">${formatPrice(book.pricePence * line.quantity)}</p>
    </li>`;
  };

  /** @param {string} [focus] a selector for what should have focus afterwards */
  const render = (focus) => {
    const lines = currentLines();
    const noticeHtml = notice ? `<p class="cart__notice">${escapeHtml(notice)}</p>` : '';
    notice = '';
    if (!lines.length) {
      root.innerHTML = `${noticeHtml}<div class="cart__message"><p>Your cart is empty.</p>
        <p><a class="button button--secondary" href="${sitePath('/')}">See all books</a></p></div>`;
    } else {
      const subtotal = lines.reduce((sum, line) => sum + /** @type {CatalogueBook} */ (books.get(line.slug)).pricePence * line.quantity, 0);
      root.innerHTML = `${noticeHtml}
        <ul class="cart__lines">${lines.map(lineHtml).join('')}</ul>
        <aside class="cart__summary" aria-labelledby="cart-summary-title">
          <h2 class="label" id="cart-summary-title">Order summary</h2>
          <p class="cart__subtotal"><span>Subtotal</span> <span>${formatPrice(subtotal)}</span></p>
          <p class="cart__note">Any delivery charge is added on the payment page, before you pay.</p>
          <button class="button" type="button" data-checkout>Checkout</button>
          <p class="cart__status" role="status" data-checkout-status></p>
          <p class="cart__continue"><a href="${sitePath('/')}">Continue shopping</a></p>
        </aside>`;
    }
    if (focus) /** @type {HTMLElement|null} */ (root.querySelector(focus) ?? heading)?.focus();
  };

  root.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    if (button.hasAttribute('data-checkout')) {
      checkout(button);
      return;
    }
    const row = /** @type {HTMLElement|null} */ (button.closest('[data-slug]'));
    const act = button.dataset.act;
    if (!row || !act) return;
    const slug = row.dataset.slug || '';
    const title = books.get(slug)?.title ?? '';
    const lines = readCart();
    const index = lines.findIndex((l) => l.slug === slug);
    if (index === -1) return;
    if (act === 'remove') {
      lines.splice(index, 1);
      writeCart(lines);
      const next = lines[Math.min(index, lines.length - 1)];
      render(next ? `[data-slug="${next.slug}"] .cart-line__title a` : '#cart-title');
      announcer.textContent = `Removed ${title}.`;
      return;
    }
    lines[index].quantity += act === 'more' ? 1 : -1;
    writeCart(lines);
    render(`[data-slug="${slug}"] [data-act="${act}"]`);
    announcer.textContent = `${copies(copiesOf(slug))} of ${title}.`;
  });

  /** @param {HTMLElement} button */
  const checkout = async (button) => {
    const status = /** @type {HTMLElement} */ (root.querySelector('[data-checkout-status]'));
    button.setAttribute('aria-disabled', 'true');
    button.textContent = 'Opening the payment page…';
    status.textContent = '';
    let message = 'The payment page couldn’t be opened. Try again in a minute.';
    try {
      const response = await fetch(new URL('api/checkout', ROOT), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: readCart() }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body.url === 'string') {
        location.assign(body.url);
        return;
      }
      if (response.status === 409 && Array.isArray(body.unavailable)) {
        writeCart(readCart().filter((line) => !body.unavailable.includes(line.slug)));
        notice = String(body.message || '');
        render('#cart-title');
        return;
      }
      if (response.status === 404 || response.status === 405) message = 'Checkout isn’t available on this copy of the site.';
      else if (typeof body.message === 'string') message = body.message;
    } catch {
      message = 'Couldn’t reach the shop. Check your connection and try again.';
    }
    button.removeAttribute('aria-disabled');
    button.textContent = 'Checkout';
    status.textContent = message;
  };

  render();
  // Another tab changed the cart, or Back returned here from the payment page.
  window.addEventListener('storage', (event) => { if (event.key === KEY) render(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) render(); });
}

paintCount();
window.addEventListener('storage', (event) => { if (event.key === KEY) paintCount(); });
const cartRoot = document.querySelector('[data-cart]');
if (cartRoot) startCartPage(/** @type {HTMLElement} */ (cartRoot));
