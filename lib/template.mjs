// A deliberately small template language, enough for a handful of pages:
//   {{name}}    the value, HTML-escaped
//   {{{name}}}  the value as-is (for HTML the build has already made safe)
//   {{> name}}  the partial src/partials/<name>.html
// A name with no value is a build error, so a typo can't publish an empty gap.
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml } from '../src/js/shared.js';

/**
 * @param {string} source
 * @param {Record<string, unknown>} vars
 * @param {(name: string) => string} [loadPartial]
 * @param {string} [label] used in error messages
 * @returns {string}
 */
export function fill(source, vars, loadPartial, label = 'template') {
  /** @type {string} */
  const withPartials = source.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (/** @type {string} */ _, /** @type {string} */ name) => {
    if (!loadPartial) throw new Error(`${label}: partial "${name}" used but no partials available`);
    return fill(loadPartial(name), vars, loadPartial, `partial ${name}`);
  });
  return withPartials.replace(/\{\{(\{)?\s*([\w.]+)\s*\}?\}\}/g, (/** @type {string} */ match, /** @type {string|undefined} */ raw, /** @type {string} */ name) => {
    if (!(name in vars) || vars[name] === undefined || vars[name] === null) {
      throw new Error(`${label}: no value for {{${raw ? '{' : ''}${name}${raw ? '}' : ''}}}`);
    }
    return raw ? String(vars[name]) : escapeHtml(String(vars[name]));
  });
}

/**
 * Splits a page file into its front matter (simple "key: value" lines between
 * two "---" lines) and its HTML body.
 * @param {string} source
 * @param {string} file
 */
export function readFrontMatter(source, file) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing front matter`);
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at < 1) throw new Error(`${file}: bad front matter line "${line}"`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  for (const key of ['title', 'description', 'path']) {
    if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
  }
  return { meta, body: match[2] };
}

/** @param {string} dir */
export function partialLoader(dir) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  return (/** @type {string} */ name) => {
    if (!cache.has(name)) cache.set(name, fs.readFileSync(path.join(dir, `${name}.html`), 'utf8'));
    return /** @type {string} */ (cache.get(name));
  };
}
