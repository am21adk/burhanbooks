import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDescription, slugify, parsePrice, formatPrice, validateBook, isOnSale } from '../src/js/shared.js';
import { firstSentence } from '../lib/books.mjs';
import { fill, readFrontMatter } from '../lib/template.mjs';

test('descriptions: paragraphs, *italic*, **bold**, ***both***, and nothing else gets through', () => {
  assert.equal(formatDescription('One *two* **three**\n\nFour ***five***'),
    '<p>One <em>two</em> <strong>three</strong></p>\n<p>Four <em><strong>five</strong></em></p>');
  assert.equal(formatDescription('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(formatDescription('line one\nline two'), '<p>line one line two</p>');
  assert.equal(formatDescription('   \n\n  '), '');
});

test('slugs drop apostrophes and ‘ayn marks rather than turning them into hyphens', () => {
  assert.equal(slugify('Shi’i Theology: A translation of Kashf al-Murad'), 'shii-theology-a-translation-of-kashf-al-murad');
  assert.equal(slugify('‘Allamah al-Hilli'), 'allamah-al-hilli');
  assert.equal(slugify('  Café — Été  '), 'cafe-ete');
});

test('prices are read in pounds and stored in pence', () => {
  assert.equal(parsePrice('12'), 1200);
  assert.equal(parsePrice('£12.5'), 1250);
  assert.equal(parsePrice('1,012.99'), 101299);
  assert.equal(parsePrice(''), null);
  assert.ok(Number.isNaN(parsePrice('twelve')));
  assert.ok(Number.isNaN(parsePrice('12.999')));
  assert.equal(formatPrice(1250), '£12.50');
});

test('a book is on sale only with both a price and a payment link', () => {
  assert.equal(isOnSale({ price_pence: 1200, payment_url: 'https://buy.stripe.com/x' }), true);
  assert.equal(isOnSale({ price_pence: null, payment_url: 'https://buy.stripe.com/x' }), false);
  assert.equal(isOnSale({ price_pence: 0, payment_url: null }), false);
});

test('validation explains each problem in plain words', () => {
  assert.deepEqual(validateBook({ title: 'A', slug: 'a' }), {});
  const problems = validateBook({ title: '', slug: 'Bad Slug', payment_url: 'http://example.com', price_pence: -1 });
  assert.deepEqual(Object.keys(problems).sort(), ['payment_url', 'price_pence', 'slug', 'title']);
  assert.match(problems.payment_url, /https:\/\//);
});

test('meta descriptions use the first sentence, word for word', () => {
  assert.equal(firstSentence('*Shi‘i Theology* is a book. It has two parts.'), 'Shi‘i Theology is a book.');
  const long = `${'word '.repeat(60)}end.`;
  const cut = firstSentence(long);
  assert.ok(cut.length <= 200 && cut.endsWith('…'));
});

test('templates escape by default and refuse missing values', () => {
  assert.equal(fill('<p>{{a}}</p>{{{b}}}', { a: '<b>', b: '<i>x</i>' }), '<p>&lt;b&gt;</p><i>x</i>');
  assert.throws(() => fill('{{missing}}', {}), /no value for \{\{missing\}\}/);
  assert.throws(() => readFrontMatter('<p>no front matter</p>', 'x.html'), /missing front matter/);
});
