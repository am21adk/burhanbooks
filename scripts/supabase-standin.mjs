// An in-memory stand-in for the parts of Supabase the admin uses, so the
// whole admin can be clicked through on this machine before a Supabase
// project exists. It follows the same rules as supabase/02_policies.sql:
// visitors see published books, only the admin can see drafts or change
// anything. It also serves /api/publish with the real function from
// netlify/functions/publish.mjs, and a local "build hook" that rebuilds
// dist/ from this stand-in, so publishing works end to end here.
//
// Sign-ins (password "preview" for both):
//   admin@burhanbooks.test    the shop's admin
//   someone@burhanbooks.test  an account that isn't the admin
//
// Everything resets when the preview server stops. Preview only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBook } from '../src/js/shared.js';
import { handlePublish } from '../netlify/functions/publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANON_KEY = 'local-preview-anon-key';
const PASSWORD = 'preview';

const users = [
  { id: 'a0000000-0000-4000-8000-000000000001', email: 'admin@burhanbooks.test', admin: true },
  { id: 'a0000000-0000-4000-8000-000000000002', email: 'someone@burhanbooks.test', admin: false },
];
/** @type {Map<string, { userId: string, expires: number }>} */
const accessTokens = new Map();
/** @type {Map<string, string>} */
const refreshTokens = new Map();
/** @type {Map<string, { type: string, bytes: Buffer }>} */
const files = new Map();

/** @type {Record<string, any>[]} */
const books = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'books.seed.json'), 'utf8'))
  .map((/** @type {Record<string, any>} */ book) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...book }));

export const state = { books, files, publishes: /** @type {string[]} */ ([]), rebuilding: false };

/** @typedef {import('node:http').IncomingMessage} Req @typedef {import('node:http').ServerResponse} Res */

/** @param {Res} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** @param {Req} req @returns {Promise<Buffer>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** @param {Req} req */
function caller(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = accessTokens.get(token);
  if (!session || session.expires < Date.now()) return null;
  return users.find((u) => u.id === session.userId) || null;
}

/** @param {{ id: string, email: string }} user */
function issue(user) {
  const access = crypto.randomBytes(24).toString('hex');
  const refresh = crypto.randomBytes(24).toString('hex');
  const expiresIn = 3600;
  accessTokens.set(access, { userId: user.id, expires: Date.now() + expiresIn * 1000 });
  refreshTokens.set(refresh, user.id);
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn, user: { id: user.id, email: user.email } };
}

/** The PostgREST-style filters the site uses: column=eq.value. @param {URLSearchParams} params */
function matches(params) {
  const filters = [...params].filter(([key]) => !['select', 'order', 'on_conflict'].includes(key));
  return (/** @type {Record<string, any>} */ row) => filters.every(([key, value]) => value.startsWith('eq.') && String(row[key]) === value.slice(3));
}

const COLUMNS = ['slug', 'title', 'author', 'contributors', 'description', 'price_pence', 'cover_url', 'cover_small_url', 'cover_width', 'cover_height', 'is_published', 'sort_order'];

/** @param {Record<string, any>} row @param {string|null} exceptId */
function checkRow(row, exceptId) {
  const problems = validateBook(row);
  if (Object.keys(problems).length) return { code: '23514', message: Object.values(problems).join(' ') };
  if (books.some((b) => b.slug === row.slug && b.id !== exceptId)) return { code: '23505', message: 'duplicate key value violates unique constraint "books_slug_key"' };
  return null;
}

/** @type {import('./preview.mjs').Route} */
async function supabase(req, res, url) {
  if (!url.pathname.startsWith('/supabase/')) return false;
  const route = url.pathname.slice('/supabase'.length);
  if (req.headers.apikey !== ANON_KEY) { send(res, 401, { message: 'No API key found in request' }); return true; }
  const user = caller(req);

  if (route === '/auth/v1/token' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (url.searchParams.get('grant_type') === 'password') {
      const found = users.find((u) => u.email === String(body.email).toLowerCase());
      if (!found || body.password !== PASSWORD) { send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }); return true; }
      send(res, 200, issue(found));
      return true;
    }
    const userId = refreshTokens.get(body.refresh_token);
    const found = users.find((u) => u.id === userId);
    if (!found) { send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }); return true; }
    refreshTokens.delete(body.refresh_token);
    send(res, 200, issue(found));
    return true;
  }
  if (route === '/auth/v1/logout' && req.method === 'POST') {
    accessTokens.delete(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    res.writeHead(204).end();
    return true;
  }
  if (route === '/auth/v1/user') {
    if (!user) send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    else send(res, 200, { id: user.id, email: user.email });
    return true;
  }

  if (route === '/rest/v1/admins') {
    if (!user) { send(res, 401, { code: '42501', message: 'permission denied for table admins' }); return true; }
    send(res, 200, user.admin ? [{ user_id: user.id }].filter(matches(url.searchParams)) : []);
    return true;
  }

  if (route === '/rest/v1/books') {
    const admin = Boolean(user?.admin);
    const visible = books.filter((b) => admin || b.is_published).filter(matches(url.searchParams));
    if (req.method === 'GET') {
      visible.sort((a, b) => (a.sort_order - b.sort_order) || a.title.localeCompare(b.title));
      send(res, 200, visible);
      return true;
    }
    if (!user) { send(res, 401, { code: '42501', message: 'permission denied for table books' }); return true; }
    if (req.method === 'POST') {
      if (!admin) { send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "books"' }); return true; }
      const body = JSON.parse((await readBody(req)).toString());
      const row = { id: crypto.randomUUID(), author: null, contributors: null, description: null, price_pence: null, cover_url: null, cover_small_url: null, cover_width: null, cover_height: null, is_published: false, sort_order: 0, ...pick(body), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const problem = checkRow(row, null);
      if (problem) { send(res, problem.code === '23505' ? 409 : 400, problem); return true; }
      books.push(row);
      send(res, 201, [row]);
      return true;
    }
    if (req.method === 'PATCH') {
      const body = pick(JSON.parse((await readBody(req)).toString()));
      const targets = admin ? visible : [];
      for (const row of targets) {
        const next = { ...row, ...body };
        const problem = checkRow(next, row.id);
        if (problem) { send(res, problem.code === '23505' ? 409 : 400, problem); return true; }
      }
      for (const row of targets) Object.assign(row, body, { updated_at: new Date().toISOString() });
      send(res, 200, targets);
      return true;
    }
    if (req.method === 'DELETE') {
      const targets = admin ? visible : [];
      for (const row of targets) books.splice(books.indexOf(row), 1);
      send(res, 200, targets);
      return true;
    }
  }

  if (route.startsWith('/storage/v1/object/public/covers/')) {
    const file = files.get(route.slice('/storage/v1/object/public/covers/'.length));
    if (!file) { send(res, 404, { message: 'Object not found' }); return true; }
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=31536000' });
    res.end(file.bytes);
    return true;
  }
  if (route.startsWith('/storage/v1/object/covers')) {
    if (!user?.admin) { send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }); return true; }
    if (req.method === 'POST') {
      const key = decodeURIComponent(route.slice('/storage/v1/object/covers/'.length));
      const type = String(req.headers['content-type'] || '');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) { send(res, 415, { message: 'mime type not supported' }); return true; }
      if (files.has(key)) { send(res, 409, { message: 'The resource already exists' }); return true; }
      files.set(key, { type, bytes: await readBody(req) });
      send(res, 200, { Key: `covers/${key}` });
      return true;
    }
    if (req.method === 'DELETE') {
      const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || '{}');
      for (const key of prefixes) files.delete(key);
      send(res, 200, prefixes.map((/** @type {string} */ name) => ({ name })));
      return true;
    }
  }
  send(res, 404, { message: `The stand-in doesn't handle ${req.method} ${route}` });
  return true;
}

/** Only real columns get written, as PostgREST would insist. @param {Record<string, any>} body */
function pick(body) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => COLUMNS.includes(key)));
}

/** /api/publish, using the real Netlify function against this stand-in. @type {import('./preview.mjs').Route} */
async function publishRoute(req, res, url) {
  if (url.pathname !== '/api/publish') return false;
  const origin = `http://${req.headers.host}`;
  const request = new Request(`${origin}/api/publish`, { method: req.method, headers: { authorization: String(req.headers.authorization || '') } });
  const response = await handlePublish(request, { SUPABASE_URL: `${origin}/supabase`, SUPABASE_ANON_KEY: ANON_KEY, NETLIFY_BUILD_HOOK: `${origin}/__build-hook` });
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
  return true;
}

/** A local build hook: rebuilds dist/ from this stand-in, as Netlify would from Supabase. @type {import('./preview.mjs').Route} */
async function buildHook(req, res, url) {
  if (url.pathname !== '/__build-hook' || req.method !== 'POST') return false;
  state.publishes.push(url.searchParams.get('trigger_title') || '');
  res.writeHead(200).end();
  if (state.rebuilding) return true;
  state.rebuilding = true;
  const child = spawn(process.execPath, ['build.mjs'], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, SUPABASE_URL: `http://${req.headers.host}/supabase`, SUPABASE_ANON_KEY: ANON_KEY },
  });
  child.on('exit', () => { state.rebuilding = false; });
  return true;
}

export const routes = [supabase, publishRoute, buildHook];
