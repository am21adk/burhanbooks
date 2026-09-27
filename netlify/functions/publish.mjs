// POST /api/publish: rebuilds the public site so it shows the books as they
// now are in Supabase. Only the shop's admin can call it: the Supabase token
// sent with the request must be valid and belong to an account in admins.
// The build hook URL stays on Netlify (NETLIFY_BUILD_HOOK) and never reaches
// the browser.

/** @param {number} status @param {string} message */
function reply(status, message) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Netlify calls the default export with (request, context), so the settings
 * are read here and the work is done by handlePublish, which tests call
 * with settings of their own.
 * @param {Request} request
 */
export default async function publish(request) {
  return handlePublish(request, process.env);
}

/**
 * @param {Request} request
 * @param {Record<string, string|undefined>} env
 */
export async function handlePublish(request, env) {
  if (request.method !== 'POST') return reply(405, 'Use POST to publish.');
  const { SUPABASE_URL, SUPABASE_ANON_KEY, NETLIFY_BUILD_HOOK } = env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return reply(500, 'Publishing isn’t set up yet: SUPABASE_URL and SUPABASE_ANON_KEY are missing from the site’s settings on Netlify.');
  }
  if (!NETLIFY_BUILD_HOOK) {
    return reply(500, 'Publishing isn’t set up yet: the build hook (NETLIFY_BUILD_HOOK) is missing from the site’s settings on Netlify.');
  }

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return reply(401, 'Sign in before publishing.');
  const base = SUPABASE_URL.replace(/\/$/, '');
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };

  /** @type {{ id: string, email?: string }} */
  let user;
  try {
    const response = await fetch(`${base}/auth/v1/user`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return reply(401, 'Your sign-in has expired. Sign in again, then publish.');
    user = await response.json();
  } catch {
    return reply(502, 'Couldn’t reach the database to check your sign-in. Try again in a minute.');
  }

  try {
    const response = await fetch(`${base}/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers, signal: AbortSignal.timeout(10000) });
    const rows = response.ok ? await response.json() : [];
    if (!Array.isArray(rows) || rows.length !== 1) return reply(403, 'This account isn’t the shop’s admin, so it can’t publish.');
  } catch {
    return reply(502, 'Couldn’t reach the database to check your account. Try again in a minute.');
  }

  try {
    const hook = new URL(NETLIFY_BUILD_HOOK);
    hook.searchParams.set('trigger_title', `Published from the admin by ${user.email || user.id}`);
    const response = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return reply(502, `Netlify didn’t accept the publish request (${response.status}). Try again in a minute.`);
  } catch {
    return reply(502, 'Couldn’t reach Netlify to publish. Try again in a minute.');
  }
  return reply(202, 'Publishing started.');
}

export const config = { path: '/api/publish' };
