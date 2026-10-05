// Shared item model and small helpers used by every scanner.
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * An item is one thing that can occupy the context window.
 *  always    tokens paid by every session (null = unknown)
 *  onDemand  tokens paid only when the item is used (null = unknown)
 *  measured  'estimate' | 'exact' | 'unknown'
 *  status    'active' | 'disabled' | 'shadowed' | 'needs-approval' | 'inactive'
 */
export function makeItem(fields) {
  return {
    tool: 'claude',
    category: 'other',
    name: '',
    source: 'user',
    path: null,
    always: 0,
    onDemand: 0,
    measured: 'estimate',
    status: 'active',
    notes: [],
    remove: null,
    ...fields,
  };
}

export function hash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/** Render a display path (~/x or ./x) as something safe to paste into a shell. */
export function shellPath(display) {
  if (!display) return '';
  if (!/[\s'"$`\\()&;|<>*?!#]/.test(display)) return display;
  let p = display;
  if (p.startsWith('~/')) p = '$HOME/' + p.slice(2);
  return '"' + p.replace(/(["\\`])/g, '\\$1') + '"';
}

/** First token of a command line, without its directory, so args never print. */
export function commandName(cmd) {
  if (!cmd) return null;
  return path.basename(String(cmd).trim().split(/\s+/)[0]);
}

// Flags whose next token is a value, not the package. Their values can hold
// URLs with credentials, registry tokens or file paths, so they are skipped.
const VALUED_FLAGS = new Set([
  '--from', '--registry', '--spec', '-p', '--package', '--with', '--with-requirements', '--python',
  '--index', '--index-url', '--extra-index-url', '--find-links', '-f', '--cache', '--userconfig', '-c', '--call',
  '--env-file', '--network', '--net', '-e', '--env', '-v', '--volume', '--mount', '--name', '--publish',
  '-w', '--workdir', '-u', '--user', '--entrypoint', '-l', '--label', '--platform', '--add-host', '--hostname', '-h',
]);

const SAFE_NAME = /^(@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*(\[[\w,.-]+\])?$/;

/** Only an npm/PyPI style name (optionally @scope/name) is ever returned. */
export function safePackageName(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (s.includes('://')) return null;
  // strip a version or tag suffix: pkg@1.2.3, @scope/pkg@latest, image:tag, pkg==1.0
  const stripped = s.replace(/(.)@[^@/]*$/, '$1').replace(/:[^:/@]*$/, '').replace(/[=<>~!]=?.*$/, '');
  return SAFE_NAME.test(stripped) ? stripped : null;
}

/** Package name passed to a launcher such as npx, uvx, bunx or pnpm dlx. */
export function launcherPackage(cmd, args = []) {
  const name = commandName(cmd);
  if (!name) return null;
  const all = [...String(cmd).trim().split(/\s+/).slice(1), ...(Array.isArray(args) ? args.map(String) : [])];
  const launchers = new Set(['npx', 'bunx', 'uvx', 'pipx', 'pnpx']);
  let rest = null;
  if (launchers.has(name)) rest = all;
  else if ((name === 'pnpm' || name === 'yarn' || name === 'npm') && ['dlx', 'exec', 'x'].includes(all[0])) rest = all.slice(1);
  else if (name === 'docker' && all[0] === 'run') rest = all.slice(1);
  else if (name === 'pipx' && all[0] === 'run') rest = all.slice(1);
  if (!rest) return null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUED_FLAGS.has(a)) i++;
      continue;
    }
    if (a === 'run' && name === 'pipx') continue;
    return safePackageName(a);
  }
  return null;
}

/** Remove ANSI escapes and control characters from text read from configs. */
export function stripControl(s) {
  return String(s)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** Deep-copy a value with every string passed through stripControl. */
export function sanitizeDeep(v) {
  if (typeof v === 'string') return stripControl(v);
  if (Array.isArray(v)) return v.map(sanitizeDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[stripControl(k)] = sanitizeDeep(x);
    return o;
  }
  return v;
}

/** Host of a URL, never its path or query (which may carry keys). */
export function urlHost(u) {
  try { return new URL(u).host; } catch { return null; }
}

export const fmtInt = (n) => (n == null ? '?' : Math.round(n).toLocaleString('en-US'));
