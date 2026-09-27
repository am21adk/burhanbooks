// Search. The magnifier in the header drops a search box down over the page
// (without the script it's a link to /search/). Searching goes to /search/,
// which lists every book and hides those whose title, author and
// translators don't contain every word typed. The list is built with the
// page, so there's nothing to fetch.
import { searchText } from './shared.js';
import { CLOSE_ICON, closeOnRequest, openPanel, panelsWork } from './panel.js';

const ROOT = new URL('../', import.meta.url);
const searchPath = new URL('search/', ROOT).pathname;

/* ---------- The search panel ---------- */

/** @type {HTMLDialogElement|null} */
let panel = null;

/** @param {string} icon the magnifier, taken from the header link */
function searchPanel(icon) {
  if (panel) return panel;
  panel = document.createElement('dialog');
  panel.className = 'panel search-panel';
  panel.setAttribute('aria-labelledby', 'search-panel-title');
  panel.innerHTML = `<div class="search-panel__inner">
      <button class="panel__close" type="button" data-close-panel aria-label="Close search">${CLOSE_ICON}</button>
      <h2 class="panel__title search-panel__title" id="search-panel-title">Search</h2>
      <form class="search-form" action="${searchPath}" method="get" role="search">
        <label class="visually-hidden" for="search-panel-q">Search books</label>
        <input class="search-form__input" id="search-panel-q" type="search" name="q" placeholder="Title, author or translator" autocomplete="off" enterkeyhint="search" autofocus>
        <button class="search-form__submit" type="submit" aria-label="Search">${icon}</button>
      </form>
    </div>`;
  document.body.append(panel);
  closeOnRequest(panel);
  return panel;
}

if (panelsWork) {
  for (const link of document.querySelectorAll('[data-search-open]')) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', (event) => {
      const click = /** @type {MouseEvent} */ (event);
      if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
      event.preventDefault();
      const dialog = searchPanel(link.querySelector('svg')?.outerHTML ?? '');
      openPanel(dialog, /** @type {HTMLElement} */ (link));
      /** @type {HTMLInputElement} */ (dialog.querySelector('input')).select();
    });
  }
}

/* ---------- The search page ---------- */

const results = document.querySelector('[data-search-results]');
if (results) {
  const query = (new URLSearchParams(location.search).get('q') || '').trim();
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('search-q'));
  const summary = /** @type {HTMLElement} */ (document.querySelector('[data-search-summary]'));
  if (input) input.value = query;
  const words = searchText(query).split(' ').filter(Boolean);
  let found = 0;
  for (const card of results.querySelectorAll('[data-search]')) {
    const text = /** @type {HTMLElement} */ (card).dataset.search || '';
    const match = words.every((word) => text.includes(word));
    /** @type {HTMLElement} */ (card).hidden = !match;
    if (match) found++;
  }
  if (words.length) {
    summary.textContent = found
      ? `${found} ${found === 1 ? 'book matches' : 'books match'} “${query}”.`
      : `No books match “${query}”. Try fewer or different words.`;
  }
}
