// Rules shared by the build (Node) and the admin (browser), so a book looks
// and validates the same in both places. No DOM or Node APIs in here.

export const CURRENCY = 'GBP';

/** Longest values the database accepts; keep in step with supabase/01_schema.sql. */
export const LIMITS = { title: 200, author: 200, contributors: 300, description: 20000 };

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The most copies of one book a cart can hold; checkout enforces it too. */
export const MAX_QUANTITY = 10;

/** @param {string} value */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes text and stops short hyphenated names ("al-Murad") breaking
 * across two lines at the hyphen. Long ones are left free to wrap.
 * @param {string} text
 * @returns {string} HTML
 */
export function keepHyphenatedWordsTogether(text) {
  return escapeHtml(text).replace(/\S+-\S+/g, (word) => (word.length <= 20 ? `<span class="nowrap">${word}</span>` : word));
}

/**
 * Turns a title into a URL slug: "Shi’i Theology: A translation" → "shii-theology-a-translation".
 * Apostrophes and ‘ayn marks are dropped rather than turned into hyphens.
 * @param {string} title
 */
export function slugify(title) {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘'ʿʾ`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * Book descriptions are plain text: a blank line starts a new paragraph,
 * *text* is italic and **text** is bold. Everything else is escaped.
 * @param {string} text
 * @returns {string} HTML
 */
export function formatDescription(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const inline = escapeHtml(block.replace(/\s*\n\s*/g, ' '))
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return `<p>${inline}</p>`;
    })
    .join('\n');
}

/** @param {number} pence */
export function formatPrice(pence) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: CURRENCY }).format(pence / 100);
}

/**
 * Parses what someone typed into a price box ("12", "12.5", "£12.50") into pence.
 * @param {string} input
 * @returns {number|null} null when empty; NaN when not a price
 */
export function parsePrice(input) {
  const cleaned = String(input).trim().replace(/^£/, '').replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Checks a book as the admin form or the database would, and returns
 * human-readable problems keyed by field. An empty object means it's fine.
 * @param {{title?: string, slug?: string, author?: string|null, contributors?: string|null,
 *   description?: string|null, price_pence?: number|null}} book
 * @returns {Record<string, string>}
 */
export function validateBook(book) {
  /** @type {Record<string, string>} */
  const problems = {};
  const title = (book.title || '').trim();
  if (!title) problems.title = 'Give the book a title.';
  else if (title.length > LIMITS.title) problems.title = `Keep the title under ${LIMITS.title} characters.`;

  if (!book.slug) problems.slug = 'The web address can’t be empty.';
  else if (!SLUG_PATTERN.test(book.slug)) problems.slug = 'Use lower-case letters, numbers and single hyphens only.';

  if (book.author && book.author.length > LIMITS.author) problems.author = `Keep the author under ${LIMITS.author} characters.`;
  if (book.contributors && book.contributors.length > LIMITS.contributors) problems.contributors = `Keep this line under ${LIMITS.contributors} characters.`;
  if (book.description && book.description.length > LIMITS.description) problems.description = `Keep the description under ${LIMITS.description.toLocaleString('en-GB')} characters.`;

  if (book.price_pence != null && (!Number.isInteger(book.price_pence) || book.price_pence < 1 || book.price_pence > 1000000)) {
    problems.price_pence = 'Enter a price such as 12.50, or leave it empty.';
  }
  return problems;
}

/**
 * A book can be added to the cart once it has a price.
 * @param {{price_pence?: number|null}} book
 */
export function isOnSale(book) {
  return book.price_pence != null && book.price_pence > 0;
}

/**
 * Tidies a cart as a browser holds or sends it: one line per book, each a
 * valid web address with a whole number of copies from 1 to MAX_QUANTITY.
 * Anything else is dropped, so a damaged or hand-edited cart can't break
 * the cart page or reach checkout.
 * @param {unknown} items
 * @returns {{ slug: string, quantity: number }[]}
 */
export function normaliseCart(items) {
  if (!Array.isArray(items)) return [];
  /** @type {Map<string, number>} */
  const lines = new Map();
  for (const item of items.slice(0, 100)) {
    const { slug, quantity } = /** @type {{ slug?: unknown, quantity?: unknown }} */ (item ?? {});
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || !Number.isInteger(quantity) || /** @type {number} */ (quantity) < 1) continue;
    lines.set(slug, Math.min(MAX_QUANTITY, (lines.get(slug) ?? 0) + /** @type {number} */ (quantity)));
  }
  return [...lines].map(([slug, quantity]) => ({ slug, quantity }));
}
