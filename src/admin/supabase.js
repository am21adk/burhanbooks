// The little of Supabase the admin needs, over plain fetch: password sign-in
// with token refresh, the books table, and the covers bucket. The session
// lives in sessionStorage, so closing the tab signs the admin out.

const STORAGE_KEY = 'burhanbooks.admin.session';

/**
 * @typedef {{ access_token: string, refresh_token: string, expires_at: number, user: { id: string, email: string } }} Session
 */

/** A failure the admin page can explain to a person. */
export class SupabaseError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, kind?: 'network'|'auth'|'forbidden'|'conflict'|'invalid'|'server' }} [details]
   */
  constructor(message, { status = 0, code = '', kind = 'server' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

/** @param {{ url: string, anonKey: string }} config */
export function createClient({ url, anonKey }) {
  const base = url.replace(/\/$/, '');
  /** @type {Session|null} */
  let session = readSession();

  /** @returns {Session|null} */
  function readSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** @param {Session|null} next */
  function saveSession(next) {
    session = next;
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing can refuse storage; the session still lasts for this page.
    }
  }

  /**
   * @param {string} path
   * @param {RequestInit & { auth?: boolean }} [init]
   */
  async function send(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('apikey', anonKey);
    if (init.auth !== false) headers.set('Authorization', `Bearer ${await accessToken()}`);
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...init, headers });
    } catch {
      throw new SupabaseError('Couldn’t reach the database. Check your internet connection and try again.', { kind: 'network' });
    }
    return response;
  }

  /** @param {Response} response */
  async function failure(response) {
    /** @type {Record<string, any>} */
    let body = {};
    try { body = await response.json(); } catch { /* not JSON */ }
    const code = String(body.code ?? body.error_code ?? body.error ?? '');
    const text = String(body.message ?? body.msg ?? body.error_description ?? '');
    if (response.status === 401 || /JWT|PGRST30/.test(code + text)) {
      return new SupabaseError('Your sign-in has expired. Sign in again to carry on.', { status: 401, code, kind: 'auth' });
    }
    if (response.status === 403 || code === '42501' || /row-level security/.test(text)) {
      return new SupabaseError('This account isn’t allowed to change the shop. Sign in with the admin account.', { status: 403, code, kind: 'forbidden' });
    }
    if (code === '23505') return new SupabaseError('Another book already uses that web address. Choose a different one.', { status: 409, code, kind: 'conflict' });
    if (code === '23514') return new SupabaseError(`The database refused one of the values (${text}).`, { status: 400, code, kind: 'invalid' });
    return new SupabaseError(`The database returned an error (${response.status}${text ? `: ${text}` : ''}).`, { status: response.status, code });
  }

  /** @returns {Promise<string>} */
  async function accessToken() {
    if (!session) throw new SupabaseError('You’re not signed in.', { status: 401, kind: 'auth' });
    if (session.expires_at * 1000 - Date.now() < 60_000) await refresh();
    return /** @type {Session} */ (session).access_token;
  }

  async function refresh() {
    if (!session) throw new SupabaseError('You’re not signed in.', { status: 401, kind: 'auth' });
    const response = await send('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!response.ok) {
      saveSession(null);
      throw new SupabaseError('Your sign-in has expired. Sign in again to carry on.', { status: 401, kind: 'auth' });
    }
    saveSession(toSession(await response.json()));
  }

  /** @param {any} body @returns {Session} */
  function toSession(body) {
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600),
      user: { id: body.user.id, email: body.user.email },
    };
  }

  /** @param {string} path @param {RequestInit & { auth?: boolean }} init */
  async function json(path, init) {
    const response = await send(path, init);
    if (!response.ok) throw await failure(response);
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    get user() { return session?.user ?? null; },

    /** @param {string} email @param {string} password */
    async signIn(email, password) {
      const response = await send('/auth/v1/token?grant_type=password', {
        method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (response.status === 400 || response.status === 401) {
        throw new SupabaseError('That email and password don’t match an account.', { status: response.status, kind: 'auth' });
      }
      if (response.status === 429) {
        throw new SupabaseError('Too many sign-in attempts. Wait a few minutes and try again.', { status: 429, kind: 'auth' });
      }
      if (!response.ok) throw await failure(response);
      saveSession(toSession(await response.json()));
      return /** @type {Session} */ (session).user;
    },

    /** Signs out of this browser only (scope=local), not every device. */
    async signOut() {
      if (session) {
        try {
          await fetch(`${base}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}` } });
        } catch {
          // Offline: the token is dropped here anyway and expires on its own.
        }
      }
      saveSession(null);
    },

    async isAdmin() {
      const user = session?.user;
      if (!user) return false;
      const rows = await json(`/rest/v1/admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, {});
      return Array.isArray(rows) && rows.length === 1;
    },

    async accessToken() { return accessToken(); },

    /** @returns {Promise<any[]>} */
    async listBooks() {
      return json('/rest/v1/books?select=*&order=sort_order.asc,title.asc', {});
    },

    /** @param {Record<string, unknown>} values */
    async createBook(values) {
      const rows = await json('/rest/v1/books', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(values),
      });
      return rows[0];
    },

    /** @param {string} id @param {Record<string, unknown>} values */
    async updateBook(id, values) {
      const rows = await json(`/rest/v1/books?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(values),
      });
      if (!rows.length) throw new SupabaseError('That book couldn’t be saved: it may have been deleted, or this account can’t change it.', { status: 404, kind: 'forbidden' });
      return rows[0];
    },

    /** @param {string} id */
    async deleteBook(id) {
      const rows = await json(`/rest/v1/books?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!rows.length) throw new SupabaseError('That book couldn’t be deleted: it may already be gone, or this account can’t change it.', { status: 404, kind: 'forbidden' });
    },

    /** @param {string} path @param {Blob} file */
    async uploadCover(path, file) {
      const response = await send(`/storage/v1/object/covers/${path}`, {
        method: 'POST', headers: { 'Content-Type': file.type, 'x-upsert': 'false', 'cache-control': '31536000' }, body: file,
      });
      if (!response.ok) throw await failure(response);
      return `${base}/storage/v1/object/public/covers/${path}`;
    },

    /** Deletes cover files by their public URLs; ones outside the bucket are skipped. @param {string[]} urls */
    async deleteCovers(urls) {
      const prefix = `${base}/storage/v1/object/public/covers/`;
      const paths = urls.filter((u) => u && u.startsWith(prefix)).map((u) => u.slice(prefix.length));
      if (!paths.length) return;
      await json('/storage/v1/object/covers', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
    },
  };
}
