// Loads the published books (from Supabase on Netlify, or the seed file when
// building locally), checks them, and copies each cover into the site so the
// public pages never depend on Supabase being up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SLUG_PATTERN, formatDescription, formatPrice, isOnSale, validateBook } from '../src/js/shared.js';

export const BOOK_COLUMNS = [
  'slug', 'title', 'author', 'contributors', 'description', 'price_pence', 'payment_url',
  'cover_url', 'cover_small_url', 'cover_width', 'cover_height', 'sort_order', 'updated_at',
];

/**
 * @typedef {object} BookRow
 * @property {string} slug
 * @property {string} title
 * @property {string|null} author
 * @property {string|null} contributors
 * @property {string|null} description
 * @property {number|null} price_pence
 * @property {string|null} payment_url
 * @property {string|null} cover_url
 * @property {string|null} cover_small_url
 * @property {number|null} cover_width
 * @property {number|null} cover_height
 * @property {number} sort_order
 * @property {string} updated_at
 */

/**
 * @param {{ supabaseUrl?: string, anonKey?: string, seedFile: string }} source
 * @returns {Promise<{ rows: BookRow[], from: string }>}
 */
export async function loadBookRows({ supabaseUrl, anonKey, seedFile }) {
  if (supabaseUrl && anonKey) {
    const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/books?select=${BOOK_COLUMNS.join(',')}&is_published=eq.true&order=sort_order.asc,title.asc`;
    const response = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Supabase returned ${response.status} for the book list: ${(await response.text()).slice(0, 300)}`);
    return { rows: await response.json(), from: 'Supabase' };
  }
  const rows = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  return { rows: rows.filter((/** @type {BookRow & {is_published?: boolean}} */ r) => r.is_published !== false), from: path.basename(seedFile) };
}

/**
 * Turns database rows into what the templates need. Anything the database
 * should have refused is a build error rather than a quietly broken page.
 * @param {BookRow[]} rows
 */
export function normaliseBooks(rows) {
  const seen = new Set();
  return rows.map((row) => {
    const problems = validateBook(row);
    if (!SLUG_PATTERN.test(row.slug || '')) problems.slug = 'bad slug';
    if (Object.keys(problems).length) throw new Error(`Book "${row.title || row.slug}": ${Object.values(problems).join(' ')}`);
    if (seen.has(row.slug)) throw new Error(`Two books share the web address "${row.slug}"`);
    seen.add(row.slug);
    const title = row.title.trim();
    const author = (row.author || '').trim() || null;
    return {
      slug: row.slug,
      path: `/product/${row.slug}/`,
      title,
      author,
      contributors: (row.contributors || '').trim() || null,
      descriptionHtml: formatDescription(row.description || ''),
      summary: firstSentence(row.description || ''),
      price: row.price_pence != null ? formatPrice(row.price_pence) : null,
      pricePence: row.price_pence,
      paymentUrl: row.payment_url,
      onSale: isOnSale(row),
      coverAlt: `Cover of ${title}${author ? ` by ${author}` : ''}`,
      coverSources: /** @type {string[]} */ ([row.cover_small_url, row.cover_url].filter(Boolean)),
      coverWidth: row.cover_width,
      coverHeight: row.cover_height,
      updatedAt: new Date(row.updated_at),
    };
  });
}

/**
 * The first sentence of a description, without the *emphasis* marks, for
 * meta descriptions. Word for word; only cut at a sentence end, or at a word
 * boundary with an ellipsis when the sentence is very long.
 * @param {string} text
 */
export function firstSentence(text) {
  const plain = text.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  const end = plain.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? plain : plain.slice(0, end + 1);
  if (sentence.length <= 200) return sentence;
  return `${sentence.slice(0, 197).replace(/\s+\S*$/, '')}…`;
}

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/**
 * Copies (local) or downloads (Supabase Storage) each cover into dist and
 * returns the site paths, content-hashed so they can be cached for a year.
 * @param {ReturnType<typeof normaliseBooks>[number]} book
 * @param {{ srcDir: string, distDir: string }} dirs
 */
export async function publishCover(book, { srcDir, distDir }) {
  if (!book.coverSources.length) return null;
  if (!book.coverWidth || !book.coverHeight) throw new Error(`Book "${book.title}": cover has no size recorded`);
  const outDir = path.join(distDir, 'img', 'books');
  fs.mkdirSync(outDir, { recursive: true });
  /** @type {{ src: string, width: number }[]} */
  const files = [];
  for (const source of book.coverSources) {
    let bytes;
    let ext;
    if (source.startsWith('/img/books/')) {
      const file = path.join(srcDir, source);
      if (!fs.existsSync(file)) throw new Error(`Book "${book.title}": cover file ${source} is missing from src/`);
      bytes = fs.readFileSync(file);
      ext = path.extname(file).toLowerCase();
    } else {
      const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
      const type = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok || !(type in IMAGE_TYPES)) throw new Error(`Book "${book.title}": couldn't download its cover (${response.status} ${type}) from ${source}`);
      bytes = Buffer.from(await response.arrayBuffer());
      ext = IMAGE_TYPES[/** @type {keyof typeof IMAGE_TYPES} */ (type)];
    }
    const width = imageWidth(bytes);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    const name = `${book.slug}-${width}-${hash}${ext}`;
    fs.writeFileSync(path.join(outDir, name), bytes);
    files.push({ src: `/img/books/${name}`, width });
  }
  files.sort((a, b) => a.width - b.width);
  const largest = files[files.length - 1];
  return {
    src: largest.src,
    srcset: files.length > 1 ? files.map((f) => `${f.src} ${f.width}w`).join(', ') : '',
    width: book.coverWidth,
    height: book.coverHeight,
    naturalWidth: largest.width,
  };
}

/**
 * Reads the pixel width from a JPEG, PNG or WebP header, so srcset widths are
 * the real ones rather than what the database says.
 * @param {Buffer} bytes
 */
export function imageWidth(bytes) {
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return bytes.readUInt32BE(16);
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return 1 + bytes.readUIntLE(24, 3);
    if (chunk === 'VP8L') return 1 + (bytes.readUInt16LE(21) & 0x3fff);
    return bytes.readUInt16LE(26) & 0x3fff;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return bytes.readUInt16BE(at + 7);
      at += 2 + length;
    }
  }
  throw new Error('Cover is not a JPEG, PNG or WebP image');
}
