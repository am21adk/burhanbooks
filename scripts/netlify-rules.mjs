// Reads Netlify's _redirects and _headers files and applies them the way
// Netlify does, so the preview server and the link checker behave like
// production. Only the parts this site uses: exact paths, a trailing /* splat
// with :splat, absolute "from" URLs (matched on host), and a trailing ! to
// force a rule even when a file exists at that path.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ host: string|null, from: string, to: string, status: number, force: boolean }} RedirectRule
 * @typedef {{ pattern: string, headers: [string, string][] }} HeaderRule
 */

/** @param {string} dist @returns {RedirectRule[]} */
export function readRedirects(dist) {
  const file = path.join(dist, '_redirects');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from, to, code = '301'] = line.split(/\s+/);
      const force = code.endsWith('!');
      let host = null;
      let fromPath = from;
      if (/^https?:\/\//.test(from)) {
        const url = new URL(from.replace('/*', '/__splat__'));
        host = url.host;
        fromPath = url.pathname.replace('/__splat__', '/*');
      }
      return { host, from: fromPath, to, status: Number(code.replace('!', '')), force };
    });
}

/**
 * @param {RedirectRule[]} rules
 * @param {string} host
 * @param {string} pathname
 * @param {boolean} fileExists
 * @returns {{ status: number, location: string }|null}
 */
export function matchRedirect(rules, host, pathname, fileExists) {
  for (const rule of rules) {
    if (rule.host && rule.host !== host) continue;
    if (fileExists && !rule.force) continue;
    let splat = null;
    if (rule.from.endsWith('/*')) {
      const base = rule.from.slice(0, -2);
      if (pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/`)) splat = pathname.slice(base.length + 1);
      else continue;
    } else if (rule.from !== pathname && `${rule.from}/` !== pathname) {
      continue;
    }
    return { status: rule.status, location: rule.to.replace(':splat', splat ?? '') };
  }
  return null;
}

/** @param {string} dist @returns {HeaderRule[]} */
export function readHeaders(dist) {
  const file = path.join(dist, '_headers');
  if (!fs.existsSync(file)) return [];
  /** @type {HeaderRule[]} */
  const rules = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: [] });
    else {
      const at = line.indexOf(':');
      rules[rules.length - 1].headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}

/** @param {HeaderRule[]} rules @param {string} pathname */
export function headersFor(rules, pathname) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rule of rules) {
    const matches = rule.pattern.endsWith('*') ? pathname.startsWith(rule.pattern.slice(0, -1)) : rule.pattern === pathname;
    if (matches) for (const [name, value] of rule.headers) out[name] = value;
  }
  return out;
}
