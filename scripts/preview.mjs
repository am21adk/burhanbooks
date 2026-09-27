// Serves dist/ the way Netlify will, for checking the site on this machine.
//
//   node build.mjs && node scripts/preview.mjs     then open http://localhost:8790
//
// Tidy URLs (/contact/ → contact/index.html, /contact → 301 /contact/), the
// 404 page, and the _redirects and _headers files the build writes.
// Handlers added with extraRoutes (the admin's Supabase stand-in) are
// consulted first. Preview only; nothing here is deployed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRedirects, matchRedirect, readHeaders, headersFor } from './netlify-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/** @typedef {(req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>|boolean} Route */

/** @param {{ port?: number, extraRoutes?: Route[] }} [options] */
export function startPreview({ port = Number(process.env.PORT || 8790), extraRoutes = [] } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    try {
      for (const route of extraRoutes) if (await route(req, res, url)) return;
      serveStatic(req, res, url);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Preview server error: ${/** @type {Error} */ (error).message}`);
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} url */
function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.split('/').some((part) => part.startsWith('.'))) return notFound(res);
  const redirects = readRedirects(DIST);
  const headerRules = readHeaders(DIST);

  let file = path.join(DIST, pathname);
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');
  const exists = fs.existsSync(file) && fs.statSync(file).isFile();

  const redirect = matchRedirect(redirects, url.host, pathname, exists);
  if (redirect) {
    res.writeHead(redirect.status, { location: redirect.location });
    return res.end();
  }
  if (!exists && !path.extname(pathname) && fs.existsSync(path.join(DIST, pathname, 'index.html'))) {
    res.writeHead(301, { location: `${pathname}/${url.search}` });
    return res.end();
  }
  if (!exists) return notFound(res, headersFor(headerRules, '/404.html'));
  const type = TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file).toLowerCase())] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, ...headersFor(headerRules, pathname) });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/** @param {http.ServerResponse} res @param {Record<string, string>} [headers] */
function notFound(res, headers = {}) {
  const page = path.join(DIST, '404.html');
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(fs.existsSync(page) ? fs.readFileSync(page) : 'Not found');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { routes } = await import('./supabase-standin.mjs');
  const port = Number(process.env.PORT || 8790);
  await startPreview({ port, extraRoutes: routes });
  console.log(`Preview on http://localhost:${port}  (serving ${path.relative(process.cwd(), DIST) || 'dist'})`);
}
