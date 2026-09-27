// The Burhan Books admin: sign in, list the books (drafts included), add,
// edit and delete them, upload covers, and publish the site. The screens are
// in admin/index.html; this file switches between them and fills them in.
import { createClient, SupabaseError } from './supabase.js';
import { formatDescription, formatPrice, parsePrice, slugify, validateBook, isOnSale } from '../js/shared.js';

/** @typedef {Record<string, any>} Book */

const config = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('admin-config')).textContent || '{}');
const db = createClient({ url: config.supabaseUrl, anonKey: config.anonKey });

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
const button = (/** @type {string} */ id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));

/** @type {Book[]} */
let books = [];
/** @type {Book|null} the book being edited; null while adding */
let editing = null;
/** @type {{ blobs: { width: number, height: number, blob: Blob }[] }|'remove'|null} */
let coverChange = null;
let slugTouched = false;
let formDirty = false;

/* ---------- Views ---------- */

/** @param {'signin'|'list'|'edit'} name */
function show(name) {
  $('boot').hidden = true;
  for (const view of ['signin', 'list', 'edit']) $(`view-${view}`).hidden = view !== name;
  const heading = /** @type {HTMLElement} */ ($(`view-${name}`).querySelector('h1'));
  heading.focus();
  window.scrollTo(0, 0);
}

/** @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  el.textContent = text;
  el.hidden = !text;
}

function showAccount() {
  const user = db.user;
  $('account').hidden = !user;
  $('account-email').textContent = user ? `Signed in as ${user.email}` : '';
}

/** Any "signed out" failure lands back on the sign-in screen with the reason. @param {unknown} error */
function handleAuthFailure(error) {
  if (error instanceof SupabaseError && (error.kind === 'auth' || error.kind === 'forbidden')) {
    void db.signOut();
    showAccount();
    setText($('signin-error'), error.message);
    show('signin');
    return true;
  }
  return false;
}

/* ---------- A small house dialog, instead of the browser's confirm() ---------- */

/**
 * @param {{ title: string, body: string, confirm: string, cancel: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
function ask({ title, body, confirm, cancel, danger = false }) {
  const dialog = /** @type {HTMLDialogElement} */ ($('dialog'));
  $('dialog-title').textContent = title;
  $('dialog-body').textContent = body;
  const yes = button('dialog-confirm');
  const no = button('dialog-cancel');
  yes.textContent = confirm;
  no.textContent = cancel;
  yes.classList.toggle('button--danger', danger);
  return new Promise((resolve) => {
    const finish = (/** @type {boolean} */ answer) => {
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      dialog.removeEventListener('cancel', onNo);
      dialog.close();
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = (/** @type {Event} */ event) => { event.preventDefault(); finish(false); };
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    dialog.addEventListener('cancel', onNo);
    dialog.showModal();
    no.focus();
  });
}

/* ---------- Sign in ---------- */

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = /** @type {HTMLFormElement} */ (event.currentTarget);
  const email = input('signin-email').value.trim();
  const password = input('signin-password').value;
  if (!email || !password) {
    setText($('signin-error'), !email ? 'Enter your email address.' : 'Enter your password.');
    (!email ? input('signin-email') : input('signin-password')).focus();
    return;
  }
  const submit = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  setText($('signin-error'), '');
  try {
    await db.signIn(email, password);
    if (!(await db.isAdmin())) {
      await db.signOut();
      setText($('signin-error'), 'This account isn’t the shop’s admin, so it can’t use this page.');
      return;
    }
    input('signin-password').value = '';
    showAccount();
    await openList();
  } catch (error) {
    setText($('signin-error'), error instanceof Error ? error.message : 'Signing in failed. Try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

button('sign-out').addEventListener('click', async () => {
  if (formDirty && !$('view-edit').hidden && !(await confirmDiscard())) return;
  formDirty = false;
  await db.signOut();
  showAccount();
  setText($('signin-error'), '');
  show('signin');
});

/* ---------- Book list ---------- */

/** @param {string} [notice] */
async function openList(notice = '') {
  show('list');
  setText($('list-notice'), notice);
  await loadBooks();
}

async function loadBooks() {
  $('list-error').hidden = true;
  $('list-empty').hidden = true;
  $('list-loading').hidden = false;
  $('book-rows').replaceChildren();
  try {
    books = await db.listBooks();
    renderBooks();
  } catch (error) {
    if (handleAuthFailure(error)) return;
    $('list-error-text').textContent = `Couldn’t load the books. ${error instanceof Error ? error.message : ''}`;
    $('list-error').hidden = false;
  } finally {
    $('list-loading').hidden = true;
  }
}

function renderBooks() {
  const list = $('book-rows');
  list.replaceChildren();
  $('list-empty').hidden = books.length > 0;
  for (const book of books) {
    const item = document.createElement('li');
    item.className = 'admin-book';

    const thumb = document.createElement('div');
    thumb.className = 'admin-book__cover';
    const src = book.cover_small_url || book.cover_url;
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.width = 60;
      img.height = book.cover_width && book.cover_height ? Math.round((60 * book.cover_height) / book.cover_width) : 90;
      thumb.append(img);
    }

    const text = document.createElement('div');
    text.className = 'admin-book__text';
    const title = document.createElement('p');
    title.className = 'admin-book__title';
    title.textContent = book.title;
    const meta = document.createElement('p');
    meta.className = 'admin-book__meta';
    const status = book.is_published ? 'On the site' : 'Draft, not on the site';
    const sale = isOnSale(book) ? formatPrice(book.price_pence) : book.price_pence != null ? `${formatPrice(book.price_pence)}, no payment link yet` : 'No price yet';
    meta.textContent = `${status} · ${sale}`;
    text.append(title, meta);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button button--secondary';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${book.title}`);
    edit.addEventListener('click', () => openEditor(book));

    item.append(thumb, text, edit);
    list.append(item);
  }
}

button('list-retry').addEventListener('click', () => loadBooks());
button('add-book').addEventListener('click', () => openEditor(null));

/* ---------- Publish ---------- */

button('publish').addEventListener('click', async () => {
  const publish = button('publish');
  publish.disabled = true;
  publish.textContent = 'Publishing…';
  setText($('list-notice'), '');
  $('list-error').hidden = true;
  try {
    let response;
    try {
      response = await fetch('/api/publish', { method: 'POST', headers: { Authorization: `Bearer ${await db.accessToken()}` } });
    } catch (error) {
      if (error instanceof SupabaseError) throw error;
      throw new Error('Couldn’t reach the site’s server to publish. Check your connection and try again.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new SupabaseError('Your sign-in has expired. Sign in again, then publish.', { status: response.status, kind: 'auth' });
    }
    /** @type {{ message?: string }} */
    let body = {};
    try { body = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) throw new Error(body.message || `Publishing failed (${response.status}). Try again in a minute.`);
    setText($('list-notice'), 'Publishing started. The public site will show your changes in a minute or two.');
  } catch (error) {
    if (handleAuthFailure(error)) return;
    $('list-error-text').textContent = error instanceof Error ? error.message : 'Publishing failed.';
    $('list-error').hidden = false;
  } finally {
    publish.disabled = false;
    publish.textContent = 'Publish changes';
  }
});

/* ---------- Editor ---------- */

const FIELDS = {
  title: 'f-title', slug: 'f-slug', author: 'f-author', contributors: 'f-contributors',
  description: 'f-description', price_pence: 'f-price', payment_url: 'f-payment', cover: 'f-cover',
};

/** @param {Book|null} book */
function openEditor(book) {
  editing = book;
  coverChange = null;
  slugTouched = Boolean(book);
  formDirty = false;
  const form = /** @type {HTMLFormElement} */ ($('book-form'));
  form.reset();
  clearErrors();
  $('edit-title').textContent = book ? `Edit “${book.title}”` : 'Add a book';
  input('f-title').value = book?.title ?? '';
  input('f-slug').value = book?.slug ?? '';
  input('f-author').value = book?.author ?? '';
  input('f-contributors').value = book?.contributors ?? '';
  /** @type {HTMLTextAreaElement} */ ($('f-description')).value = book?.description ?? '';
  input('f-price').value = book?.price_pence != null ? (book.price_pence / 100).toFixed(2) : '';
  input('f-payment').value = book?.payment_url ?? '';
  input('f-order').value = String(book?.sort_order ?? nextSortOrder());
  input('f-published').checked = book?.is_published ?? false;
  button('delete').hidden = !book;
  $('f-slug-warning').hidden = true;
  $('f-cover-warning').hidden = true;
  renderCoverPreview();
  renderDescriptionPreview();
  show('edit');
}

function nextSortOrder() {
  return books.length ? Math.max(...books.map((b) => Number(b.sort_order) || 0)) + 1 : 0;
}

function renderCoverPreview() {
  const preview = $('f-cover-preview');
  preview.replaceChildren();
  let src = '';
  let note = '';
  if (coverChange === 'remove') note = 'The cover will be removed when you save.';
  else if (coverChange) src = URL.createObjectURL(coverChange.blobs[0].blob);
  else if (editing?.cover_url) src = editing.cover_small_url || editing.cover_url;
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = coverChange ? 'The new cover, not saved yet' : 'The current cover';
    preview.append(img);
  } else {
    const empty = document.createElement('p');
    empty.className = 'cover-field__empty';
    empty.textContent = note || 'No cover yet.';
    preview.append(empty);
  }
  button('f-cover-remove').hidden = !(coverChange && coverChange !== 'remove') && !(editing?.cover_url && coverChange !== 'remove');
}

function renderDescriptionPreview() {
  const text = /** @type {HTMLTextAreaElement} */ ($('f-description')).value;
  // formatDescription escapes everything before adding <p>, <em> and <strong>.
  $('f-description-preview').innerHTML = text.trim() ? formatDescription(text) : '<p>Nothing to preview yet.</p>';
}

$('book-form').addEventListener('input', (event) => {
  formDirty = true;
  const target = /** @type {HTMLInputElement} */ (event.target);
  if (target.id === 'f-title' && !slugTouched) input('f-slug').value = slugify(target.value);
  if (target.id === 'f-slug') {
    slugTouched = true;
    $('f-slug-warning').hidden = !(editing?.is_published && target.value !== editing.slug);
  }
  if (target.id === 'f-description') renderDescriptionPreview();
});

input('f-cover').addEventListener('change', async () => {
  const file = input('f-cover').files?.[0];
  setFieldError('cover', '');
  $('f-cover-warning').hidden = true;
  if (!file) return;
  try {
    const blobs = await prepareCover(file);
    coverChange = { blobs };
    formDirty = true;
    if (blobs[0].width < 400) {
      setText($('f-cover-warning'), `This image is only ${blobs[blobs.length - 1].width} pixels wide, so the cover will look small. A larger image would be better.`);
    }
    renderCoverPreview();
  } catch (error) {
    setFieldError('cover', error instanceof Error ? error.message : 'That image couldn’t be read.');
  } finally {
    input('f-cover').value = '';
  }
});

button('f-cover-remove').addEventListener('click', () => {
  coverChange = editing?.cover_url ? 'remove' : null;
  formDirty = true;
  renderCoverPreview();
  button('f-cover-remove').hidden = true;
});

/**
 * Shrinks the chosen image to 480 and 960 pixels wide (1x and 2x on the
 * book page), as JPEG on white, so uploads are small and consistent.
 * @param {File} file
 * @returns {Promise<{ width: number, height: number, blob: Blob }[]>} smallest first
 */
async function prepareCover(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That image is over 25 MB. Choose a smaller one.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That image couldn’t be read. It may be damaged; try exporting it again.');
  }
  const widths = bitmap.width >= 960 ? [480, 960] : bitmap.width > 480 ? [480, bitmap.width] : [bitmap.width];
  const out = [];
  for (const width of widths) {
    const height = Math.round((bitmap.height * width) / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image couldn’t be resized.'))), 'image/jpeg', 0.86));
    out.push({ width, height, blob: /** @type {Blob} */ (blob) });
  }
  bitmap.close();
  return out;
}

/** @param {string} field @param {string} message */
function setFieldError(field, message) {
  const id = FIELDS[/** @type {keyof typeof FIELDS} */ (field)];
  if (!id) return;
  const error = $(`${id}-error`);
  setText(error, message);
  const control = $(id);
  if (message) control.setAttribute('aria-invalid', 'true');
  else control.removeAttribute('aria-invalid');
}

function clearErrors() {
  for (const field of Object.keys(FIELDS)) setFieldError(field, '');
  setText($('book-error'), '');
}

function readForm() {
  const price = parsePrice(input('f-price').value);
  const order = Number.parseInt(input('f-order').value, 10);
  return {
    title: input('f-title').value.trim(),
    slug: input('f-slug').value.trim(),
    author: input('f-author').value.trim() || null,
    contributors: input('f-contributors').value.trim() || null,
    description: /** @type {HTMLTextAreaElement} */ ($('f-description')).value.trim() || null,
    price_pence: price,
    payment_url: input('f-payment').value.trim() || null,
    sort_order: Number.isFinite(order) ? order : 0,
    is_published: input('f-published').checked,
  };
}

$('book-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  const values = readForm();
  const problems = validateBook(values);
  if (Number.isNaN(values.price_pence)) problems.price_pence = 'Enter a price such as 18.99, or leave it empty.';
  if (Object.keys(problems).length) {
    for (const [field, message] of Object.entries(problems)) setFieldError(field, message);
    setText($('book-error'), `Check the ${Object.keys(problems).length === 1 ? 'highlighted field' : `${Object.keys(problems).length} highlighted fields`} and save again.`);
    const first = FIELDS[/** @type {keyof typeof FIELDS} */ (Object.keys(problems)[0])];
    if (first) $(first).focus();
    return;
  }
  await save(values);
});

/** @param {ReturnType<typeof readForm>} values */
async function save(values) {
  const saveButton = button('save');
  const fields = /** @type {HTMLFieldSetElement} */ ($('book-fields'));
  saveButton.disabled = true;
  fields.disabled = true;
  saveButton.textContent = coverChange && coverChange !== 'remove' ? 'Uploading the cover…' : 'Saving…';
  /** @type {string[]} */
  let uploaded = [];
  const oldCovers = [editing?.cover_url, editing?.cover_small_url].filter(Boolean);
  try {
    /** @type {Record<string, unknown>} */
    const record = { ...values };
    if (coverChange === 'remove') {
      Object.assign(record, { cover_url: null, cover_small_url: null, cover_width: null, cover_height: null });
    } else if (coverChange) {
      const stamp = Date.now().toString(36);
      for (const { width, blob } of coverChange.blobs) {
        uploaded.push(await db.uploadCover(`books/${values.slug}-${stamp}-${width}.jpg`, blob));
      }
      const [smallest] = coverChange.blobs;
      Object.assign(record, {
        cover_url: uploaded[uploaded.length - 1],
        cover_small_url: uploaded.length > 1 ? uploaded[0] : null,
        cover_width: smallest.width,
        cover_height: smallest.height,
      });
      saveButton.textContent = 'Saving…';
    }
    const saved = editing ? await db.updateBook(editing.id, record) : await db.createBook(record);
    if (coverChange) db.deleteCovers(/** @type {string[]} */ (oldCovers)).catch(() => {});
    formDirty = false;
    await openList(`Saved “${saved.title}”. Press Publish changes to update the public site.`);
  } catch (error) {
    if (uploaded.length) db.deleteCovers(uploaded).catch(() => {});
    if (handleAuthFailure(error)) return;
    if (error instanceof SupabaseError && error.kind === 'conflict') setFieldError('slug', error.message);
    setText($('book-error'), error instanceof Error ? `Not saved. ${error.message}` : 'Not saved. Try again.');
  } finally {
    saveButton.disabled = false;
    fields.disabled = false;
    saveButton.textContent = 'Save';
  }
}

async function confirmDiscard() {
  return ask({ title: 'Discard your changes?', body: 'You’ve changed this book without saving.', confirm: 'Discard changes', cancel: 'Keep editing', danger: true });
}

async function leaveEditor() {
  if (formDirty && !(await confirmDiscard())) return;
  formDirty = false;
  await openList();
}

button('back').addEventListener('click', leaveEditor);
button('cancel').addEventListener('click', leaveEditor);

button('delete').addEventListener('click', async () => {
  if (!editing) return;
  const book = editing;
  const sure = await ask({
    title: 'Delete this book?',
    body: `“${book.title}” will be deleted from the shop, and taken off the site the next time you publish. This can’t be undone.`,
    confirm: 'Delete book',
    cancel: 'Keep it',
    danger: true,
  });
  if (!sure) return;
  const del = button('delete');
  del.disabled = true;
  del.textContent = 'Deleting…';
  try {
    await db.deleteBook(book.id);
    db.deleteCovers([book.cover_url, book.cover_small_url].filter(Boolean)).catch(() => {});
    formDirty = false;
    await openList(`Deleted “${book.title}”. Press Publish changes to take it off the public site.`);
  } catch (error) {
    if (handleAuthFailure(error)) return;
    setText($('book-error'), error instanceof Error ? error.message : 'The book couldn’t be deleted.');
  } finally {
    del.disabled = false;
    del.textContent = 'Delete book';
  }
});

window.addEventListener('beforeunload', (event) => {
  if (formDirty && !$('view-edit').hidden) event.preventDefault();
});

/* ---------- Start ---------- */

(async function start() {
  if (!db.user) {
    show('signin');
    return;
  }
  try {
    if (!(await db.isAdmin())) {
      await db.signOut();
      setText($('signin-error'), 'This account isn’t the shop’s admin, so it can’t use this page.');
      show('signin');
      return;
    }
    showAccount();
    await openList();
  } catch (error) {
    if (handleAuthFailure(error)) return;
    showAccount();
    await openList();
  }
})();
