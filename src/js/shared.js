// Rules shared by the build (Node) and the admin (browser), so a book looks
// and validates the same in both places. No DOM or Node APIs in here.

export const CURRENCY = 'GBP';

/** Longest values the database accepts; keep in step with supabase/01_schema.sql. */
export const LIMITS = { title: 200, author: 200, contributors: 300, description: 20000 };

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/** @param {string} url */
export function isHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Checks a book as the admin form or the database would, and returns
 * human-readable problems keyed by field. An empty object means it's fine.
 * @param {{title?: string, slug?: string, author?: string|null, contributors?: string|null,
 *   description?: string|null, price_pence?: number|null, payment_url?: string|null}} book
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

  if (book.price_pence != null && (!Number.isInteger(book.price_pence) || book.price_pence < 0 || book.price_pence > 1000000)) {
    problems.price_pence = 'Enter a price such as 12.50, or leave it empty.';
  }
  if (book.payment_url && !isHttpsUrl(book.payment_url)) problems.payment_url = 'The payment link must start with https://';
  return problems;
}

/**
 * A book can be bought only when it has both a price and a payment link.
 * @param {{price_pence?: number|null, payment_url?: string|null}} book
 */
export function isOnSale(book) {
  return book.price_pence != null && Boolean(book.payment_url);
}
