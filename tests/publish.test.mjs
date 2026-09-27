// The publish function on its own, with fetch replaced, so each way it can
// refuse or fail is checked without Supabase or Netlify.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublish } from '../netlify/functions/publish.mjs';

const ENV = { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', NETLIFY_BUILD_HOOK: 'https://api.netlify.com/build_hooks/abc' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * @param {{ user?: number, admin?: boolean, hook?: number, down?: 'supabase'|'netlify' }} scenario
 * @returns {string[]} the URLs called, filled in as the function runs
 */
function fakeNetwork({ user = 200, admin = true, hook = 200, down } = {}) {
  /** @type {string[]} */
  const calls = [];
  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method || 'GET'} ${url}`);
    if (url.startsWith('https://db.test') && down === 'supabase') throw new TypeError('fetch failed');
    if (url.startsWith('https://api.netlify.com') && down === 'netlify') throw new TypeError('fetch failed');
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'owner@shop.test' }), { status: user });
    if (url.includes('/rest/v1/admins')) return new Response(JSON.stringify(admin ? [{ user_id: 'u1' }] : []), { status: 200 });
    if (url.startsWith('https://api.netlify.com')) return new Response('', { status: hook });
    throw new Error(`unexpected ${url}`);
  });
  return calls;
}

const post = (/** @type {Record<string, string>} */ headers = { authorization: 'Bearer token' }) => new Request('https://burhanbooks.com/api/publish', { method: 'POST', headers });
const message = async (/** @type {Response} */ r) => (await r.json()).message;

test('the admin can publish, and the build hook is told who did it', async () => {
  const calls = fakeNetwork();
  const response = await handlePublish(post(), ENV);
  assert.equal(response.status, 202);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /^POST https:\/\/api\.netlify\.com\/build_hooks\/abc\?trigger_title=Published\+from\+the\+admin\+by\+owner%40shop\.test$/);
});

test('only POST', async () => {
  const response = await handlePublish(new Request('https://burhanbooks.com/api/publish'), ENV);
  assert.equal(response.status, 405);
});

test('no token, or one Supabase refuses, is 401 and never reaches Netlify', async () => {
  let calls = fakeNetwork();
  assert.equal((await handlePublish(post({}), ENV)).status, 401);
  assert.equal(calls.length, 0);
  calls = fakeNetwork({ user: 401 });
  assert.equal((await handlePublish(post(), ENV)).status, 401);
  assert.ok(!calls.some((c) => c.includes('netlify')));
});

test('a signed-in account that isn’t the admin is 403 and never reaches Netlify', async () => {
  const calls = fakeNetwork({ admin: false });
  const response = await handlePublish(post(), ENV);
  assert.equal(response.status, 403);
  assert.match(await message(response), /isn’t the shop’s admin/);
  assert.ok(!calls.some((c) => c.includes('netlify')));
});

test('missing settings say exactly which one', async () => {
  fakeNetwork();
  const noHook = await handlePublish(post(), { ...ENV, NETLIFY_BUILD_HOOK: '' });
  assert.equal(noHook.status, 500);
  assert.match(await message(noHook), /NETLIFY_BUILD_HOOK/);
  const noDb = await handlePublish(post(), { ...ENV, SUPABASE_URL: '' });
  assert.match(await message(noDb), /SUPABASE_URL/);
});

test('Supabase or Netlify being down is a 502 with a plain explanation', async () => {
  fakeNetwork({ down: 'supabase' });
  const db = await handlePublish(post(), ENV);
  assert.equal(db.status, 502);
  assert.match(await message(db), /Couldn’t reach the database/);
  fakeNetwork({ down: 'netlify' });
  const netlify = await handlePublish(post(), ENV);
  assert.equal(netlify.status, 502);
  assert.match(await message(netlify), /Couldn’t reach Netlify/);
  fakeNetwork({ hook: 404 });
  assert.match(await message(await handlePublish(post(), ENV)), /didn’t accept the publish request \(404\)/);
});
