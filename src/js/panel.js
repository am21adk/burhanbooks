// The two panels that open over the page: the cart, which slides in from
// the right, and search, which drops down from the top. Both are <dialog>s
// opened with showModal(), so focus stays inside, Escape closes them and the
// page behind can't be reached. They slide in and out unless the visitor
// prefers less motion, and focus goes back to whatever opened them.

/** Browsers without <dialog> keep the plain links to /cart/ and /search/. */
export const panelsWork = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;

/** @type {WeakMap<HTMLDialogElement, HTMLElement|null>} */
const openers = new WeakMap();

/**
 * @param {HTMLDialogElement} dialog
 * @param {HTMLElement|null} opener
 */
export function openPanel(dialog, opener) {
  if (dialog.open) return;
  openers.set(dialog, opener);
  dialog.classList.remove('is-closing');
  const root = document.documentElement;
  root.style.setProperty('--scrollbar-width', `${window.innerWidth - root.clientWidth}px`);
  dialog.showModal();
}

/** @param {HTMLDialogElement} dialog */
export function closePanel(dialog) {
  if (!dialog.open || dialog.classList.contains('is-closing')) return;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.classList.remove('is-closing');
    dialog.close();
    openers.get(dialog)?.focus();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }
  dialog.classList.add('is-closing');
  dialog.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 500); // in case the animation never runs
}

/**
 * A panel closes on Escape, on a click on the dimmed page around it, and
 * from any button inside it marked data-close-panel.
 * @param {HTMLDialogElement} dialog
 */
export function closeOnRequest(dialog) {
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePanel(dialog);
  });
  dialog.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === dialog) {
      const box = dialog.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) closePanel(dialog);
    } else if (target.closest('[data-close-panel]')) {
      closePanel(dialog);
    }
  });
}

/** The × for a panel's close button. */
export const CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4 4l12 12M16 4L4 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
