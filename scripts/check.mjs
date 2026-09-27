// Checks the built site. Run after `node build.mjs`:
//
//   node scripts/check.mjs
//
// 1. HTML validation (html-validate) of every page in dist/
// 2. Type check of all JavaScript (tsc --checkJs, see tsconfig.json)
// 3. Every internal link, image, stylesheet and #anchor resolves
// 4. Stylesheets use colours only through the tokens in :root
// Exits non-zero if anything fails.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRedirects, matchRedirect } from './netlify-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const bin = (/** @type {string} */ name) => path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];
const record = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = '') => results.push({ name, ok, detail });

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is empty. Run `node build.mjs` first.');
  process.exit(1);
}

const htmlFiles = listFiles(DIST).filter((f) => f.endsWith('.html'));

// 1. HTML
{
  const run = spawnSync(bin('html-validate'), ['--formatter', 'text', ...htmlFiles.map((f) => path.relative(ROOT, f))], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  record(`HTML valid (${htmlFiles.length} pages)`, run.status === 0, (run.stdout + run.stderr).trim());
}

// 2. Types
{
  const run = spawnSync(bin('tsc'), ['-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  record('JavaScript type-checks', run.status === 0, (run.stdout + run.stderr).trim());
}

// 3. Links
{
  const redirects = readRedirects(DIST);
  /** @type {string[]} */
  const broken = [];
  let checked = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    const pagePath = '/' + path.relative(DIST, file).replace(/\\/g, '/').replace(/index\.html$/, '');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [
      ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+/)[0])),
    ];
    for (const ref of refs) {
      if (/^(https?:|mailto:|tel:|data:)/.test(ref)) continue;
      checked++;
      if (ref.startsWith('#')) {
        if (!ids.has(ref.slice(1))) broken.push(`${pagePath}: #${ref.slice(1)} has no matching id`);
        continue;
      }
      const target = new URL(ref, `https://burhanbooks.com${pagePath}`);
      if (!resolves(target.pathname, redirects)) broken.push(`${pagePath}: ${ref}`);
    }
  }
  record(`Internal links resolve (${checked} checked)`, broken.length === 0, broken.join('\n'));
}

// 4. Colour tokens
{
  /** @type {string[]} */
  const stray = [];
  for (const file of listFiles(path.join(ROOT, 'src')).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const outsideRoot = css.replace(/:root\s*\{[^}]*\}/g, '');
    for (const m of outsideRoot.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) stray.push(`${path.relative(ROOT, file)}: ${m[0]}`);
  }
  record('Colours come only from tokens', stray.length === 0, stray.join('\n'));
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (!r.ok) { failed++; if (r.detail) console.log(r.detail.split('\n').map((l) => `      ${l}`).join('\n')); }
}
console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);

/** @param {string} pathname @param {ReturnType<typeof readRedirects>} redirects */
function resolves(pathname, redirects) {
  const decoded = decodeURIComponent(pathname);
  const file = path.join(DIST, decoded.endsWith('/') ? `${decoded}index.html` : decoded);
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (exists) return true;
  if (!path.extname(decoded) && fs.existsSync(path.join(DIST, decoded, 'index.html'))) return true;
  return Boolean(matchRedirect(redirects, 'burhanbooks.com', decoded, false));
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}
