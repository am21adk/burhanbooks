// Draws src/img/share.jpg, the 1200×630 image link previews use for every
// page except a book's own (which uses its cover). It's the logo and the
// cover on white, nothing new. Re-run if either changes:
//
//   node scripts/make-share-image.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asDataUrl = (/** @type {string} */ file, /** @type {string} */ type) => `data:${type};base64,${fs.readFileSync(path.join(ROOT, file)).toString('base64')}`;

const html = `<!DOCTYPE html>
<html><body style="margin:0;width:1200px;height:630px;background:#fff;display:flex;align-items:center;justify-content:center;gap:110px">
  <img src="${asDataUrl('src/img/source/logo-1.png', 'image/png')}" style="width:520px;height:auto">
  <img src="${asDataUrl('src/img/books/shii-theology-kashf-al-murad.jpg', 'image/jpeg')}" style="height:540px;width:auto">
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: path.join(ROOT, 'src', 'img', 'share.jpg'), type: 'jpeg', quality: 85 });
await browser.close();
console.log('Wrote src/img/share.jpg');
