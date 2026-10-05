// Read-only filesystem helpers. Nothing in this package writes, renames or
// deletes files on the machine it scans.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

export function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export function listDir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

export function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** Recursively list files under dir whose name passes `filter`. Bounded. */
export function walkFiles(dir, { filter = () => true, maxDepth = 6, skip = SKIP_DIRS, limit = 5000 } = {}) {
  const out = [];
  const visit = (d, depth) => {
    if (out.length >= limit) return;
    for (const e of listDir(d)) {
      const full = path.join(d, e.name);
      let isD = e.isDirectory();
      let isF = e.isFile();
      if (e.isSymbolicLink()) { isD = isDir(full); isF = isFile(full); }
      if (isD) {
        if (depth < maxDepth && !skip.has(e.name)) visit(full, depth + 1);
      } else if (isF && filter(e.name, full)) {
        out.push(full);
        if (out.length >= limit) return;
      }
    }
  };
  visit(dir, 0);
  return out.sort();
}

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.turbo', '.idea',
]);

/**
 * Minimal YAML frontmatter reader: top-level `key: value`, quoted strings,
 * `|` and `>` block scalars, and `- item` lists. Enough for skill, agent,
 * command, rule and output-style headers.
 */
export function parseFrontmatter(text) {
  if (!text || !/^---\r?\n/.test(text)) return { data: {}, body: text || '' };
  const end = text.search(/\r?\n---\s*(\r?\n|$)/);
  if (end < 0) return { data: {}, body: text };
  const head = text.slice(text.indexOf('\n') + 1, end);
  const rest = text.slice(end).replace(/^\r?\n---\s*(\r?\n)?/, '');
  const data = {};
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '|' || val === '>' || val === '|-' || val === '>-' || val === '|+' || val === '>+') {
      const fold = val.startsWith('>');
      const buf = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        buf.push(lines[++i].replace(/^\s+/, ''));
      }
      data[key] = (fold ? buf.join(' ') : buf.join('\n')).trim();
      continue;
    }
    if (val === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, '').trim()));
      }
      // multi-line plain scalar continuation
      if (!items.length) {
        const buf = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) buf.push(lines[++i].trim());
        data[key] = buf.join(' ');
      } else data[key] = items;
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      continue;
    }
    // plain scalar that continues on indented lines
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*-\s/.test(lines[i + 1])) {
      val += ' ' + lines[++i].trim();
    }
    data[key] = unquote(val);
  }
  return { data, body: rest };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

/** Build a function that shortens absolute paths for display (~ and project-relative). */
export function makeDisplay({ home, project }) {
  const h = home ? path.resolve(home) : null;
  const p = project ? path.resolve(project) : null;
  return (abs) => {
    if (!abs) return abs;
    const a = path.resolve(abs);
    if (p && (a === p || a.startsWith(p + path.sep))) return '.' + a.slice(p.length) || '.';
    if (h && (a === h || a.startsWith(h + path.sep))) return '~' + a.slice(h.length);
    return a;
  };
}

export function expandHome(p, home) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
