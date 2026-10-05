// Optional scanners for other agents, limited to documented locations:
//   Cursor:     .cursor/rules/**/*.mdc, legacy .cursorrules, AGENTS.md,
//               ~/.cursor/mcp.json and .cursor/mcp.json
//   Codex:      $CODEX_HOME (default ~/.codex) AGENTS.override.md / AGENTS.md,
//               AGENTS.md from the git root down to the working directory,
//               [mcp_servers.*] in config.toml
//   Gemini CLI: ~/.gemini/GEMINI.md, GEMINI.md in ancestor directories,
//               mcpServers in ~/.gemini/settings.json and .gemini/settings.json,
//               extensions in ~/.gemini/extensions/*/gemini-extension.json
import path from 'node:path';
import { isFile, isDir, readText, readJson, listDir, walkFiles, parseFrontmatter, expandHome } from './fsutil.mjs';
import { estimateTokens } from './tokens.mjs';
import { makeItem, hash } from './model.mjs';
import { describeServer } from './mcp.mjs';
import { findImports } from './claude.mjs';

function gitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (isDir(path.join(d, '.git')) || isFile(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function dirsDown(from, to) {
  const out = [];
  let d = path.resolve(to);
  const stop = path.resolve(from);
  for (;;) {
    out.push(d);
    if (d === stop) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out.reverse();
}

function mcpItems(tool, map, { source, file, display, removeHint }) {
  return Object.entries(map || {}).filter(([, c]) => c && typeof c === 'object').map(([name, cfg]) => makeItem({
    tool, category: 'mcp', name, serverName: name, source, path: display(file),
    always: cfg.disabled === true ? 0 : null, onDemand: cfg.disabled === true ? 0 : null,
    measured: 'unknown', status: cfg.disabled === true || cfg.enabled === false ? 'disabled' : 'active',
    mcp: describeServer(cfg), remove: removeHint(name), _cfg: cfg,
    notes: ['tool schemas load up front unless the client defers them'],
  }));
}

function fileItem(tool, file, { category = 'instructions', source, always, display, remove, notes = [] }) {
  const text = readText(file);
  if (text == null) return null;
  const tok = estimateTokens(text, 'markdown');
  return makeItem({
    tool, category, name: display(file), source, path: display(file),
    always: always ? tok : 0, onDemand: always ? 0 : tok, lines: text.split('\n').length,
    contentHash: hash(text.trim()), remove: remove || `Trim ${display(file)}.`, notes,
  });
}

// ---------- Cursor ----------
export function scanCursor({ home, project, display }) {
  const items = [];
  const projectAbs = path.resolve(project);
  const rulesDir = path.join(projectAbs, '.cursor', 'rules');
  for (const f of walkFiles(rulesDir, { filter: (n) => n.endsWith('.mdc') || n.endsWith('.md'), maxDepth: 6 })) {
    const text = readText(f);
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);
    const bodyTok = estimateTokens(body, 'markdown');
    let always = 0;
    let onDemand = bodyTok;
    let mode;
    if (data.alwaysApply === true) { always = bodyTok; onDemand = 0; mode = 'always applied'; }
    else if (data.description && !data.globs) { always = estimateTokens(String(data.description), 'prose'); mode = 'agent decides from the description'; }
    else if (data.globs) mode = 'attached when matching files are in context';
    else mode = 'manual (@-mention only)';
    items.push(makeItem({
      tool: 'cursor', category: 'rule', name: display(f), source: 'project', path: display(f), always, onDemand,
      contentHash: hash(body.trim()), notes: [mode],
      remove: data.alwaysApply === true ? `Set alwaysApply: false and add a description or globs in ${display(f)}, or delete it.` : `Delete ${display(f)} if unused.`,
    }));
  }
  const legacy = path.join(projectAbs, '.cursorrules');
  if (isFile(legacy)) {
    const it = fileItem('cursor', legacy, { source: 'project', always: true, display, notes: ['legacy format'], remove: `Move ${display(legacy)} into .cursor/rules/ with alwaysApply: false where possible.` });
    if (it) items.push(it);
  }
  const agents = path.join(projectAbs, 'AGENTS.md');
  if (isFile(agents)) { const it = fileItem('cursor', agents, { source: 'project', always: true, display }); if (it) items.push(it); }
  for (const [file, source] of [[path.join(home, '.cursor', 'mcp.json'), 'user'], [path.join(projectAbs, '.cursor', 'mcp.json'), 'project']]) {
    const j = readJson(file);
    if (j) items.push(...mcpItems('cursor', j.mcpServers, { source, file, display, removeHint: (n) => `Remove "${n}" from ${display(file)}` }));
  }
  return { tool: 'cursor', items, findings: [], notes: ['Cursor user rules live in the app settings, not on disk, and are not counted.'] };
}

// ---------- Codex ----------
/** Tiny TOML reader for the parts of config.toml this tool needs. */
export function parseTomlSubset(text) {
  const root = {};
  let cur = root;
  for (let line of (text || '').split(/\r?\n/)) {
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.match(/^\[([^\]]+)\]$/);
    if (t) {
      cur = root;
      for (const part of splitKey(t[1])) { cur[part] = cur[part] || {}; cur = cur[part]; }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    let target = cur;
    const keys = splitKey(kv[1]);
    for (const k of keys.slice(0, -1)) { target[k] = target[k] || {}; target = target[k]; }
    target[keys[keys.length - 1]] = parseTomlValue(kv[2].trim());
  }
  return root;
}
function splitKey(k) {
  return (k.match(/"[^"]*"|[^.]+/g) || []).map((s) => s.trim().replace(/^"|"$/g, ''));
}
function parseTomlValue(v) {
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return (v.slice(1, -1).match(/"[^"]*"|'[^']*'|[^,\s]+/g) || []).map((x) => parseTomlValue(x.trim()));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    const o = {};
    for (const m of v.slice(1, -1).matchAll(/([A-Za-z0-9_-]+)\s*=\s*("[^"]*"|'[^']*'|[^,]+)/g)) o[m[1]] = parseTomlValue(m[2].trim());
    return o;
  }
  return v;
}

export function scanCodex({ home, project, env = {}, display }) {
  const items = [];
  const codexHome = env.CODEX_HOME ? path.resolve(expandHome(env.CODEX_HOME, home)) : path.join(home, '.codex');
  const configFile = path.join(codexHome, 'config.toml');
  const config = parseTomlSubset(readText(configFile) || '');
  const maxBytes = Number(config.project_doc_max_bytes) || 32 * 1024;
  const names = ['AGENTS.md', ...(Array.isArray(config.project_doc_fallback_filenames) ? config.project_doc_fallback_filenames : [])];

  const globalOverride = path.join(codexHome, 'AGENTS.override.md');
  const globalFile = isFile(globalOverride) ? globalOverride : path.join(codexHome, 'AGENTS.md');
  if (isFile(globalFile)) { const it = fileItem('codex', globalFile, { source: 'user', always: true, display }); if (it) items.push(it); }

  const projectAbs = path.resolve(project);
  const root = gitRoot(projectAbs) || projectAbs;
  let budget = maxBytes;
  for (const dir of dirsDown(root, projectAbs)) {
    const override = path.join(dir, 'AGENTS.override.md');
    const pick = isFile(override) ? override : names.map((n) => path.join(dir, n)).find(isFile);
    if (!pick) continue;
    const text = readText(pick) || '';
    const bytes = Buffer.byteLength(text);
    const kept = Math.max(0, Math.min(bytes, budget));
    budget -= kept;
    const it = fileItem('codex', pick, { source: 'project', always: true, display });
    if (!it) continue;
    if (kept < bytes) {
      it.always = estimateTokens(Buffer.from(text).subarray(0, kept).toString('utf8'), 'markdown');
      it.notes.push(`project docs are capped at ${maxBytes} bytes in total (project_doc_max_bytes); the rest is cut`);
    }
    items.push(it);
  }
  items.push(...mcpItems('codex', config.mcp_servers, {
    source: 'user', file: configFile, display, removeHint: (n) => `Remove the [mcp_servers.${n}] table from ${display(configFile)}`,
  }));
  return { tool: 'codex', items, findings: [], notes: [] };
}

// ---------- Gemini CLI ----------
export function scanGemini({ home, project, display }) {
  const items = [];
  const gdir = path.join(home, '.gemini');
  const userSettings = readJson(path.join(gdir, 'settings.json')) || {};
  const projectAbs = path.resolve(project);
  const projSettingsFile = path.join(projectAbs, '.gemini', 'settings.json');
  const projSettings = readJson(projSettingsFile) || {};
  const fileNameSetting = projSettings.context?.fileName ?? userSettings.context?.fileName ?? projSettings.contextFileName ?? userSettings.contextFileName;
  const names = Array.isArray(fileNameSetting) ? fileNameSetting : fileNameSetting ? [fileNameSetting] : ['GEMINI.md'];
  const seen = new Set();
  const addCtx = (file, source, always, extraNote) => {
    if (seen.has(file)) return;
    seen.add(file);
    const it = fileItem('gemini', file, { source, always, display, notes: extraNote ? [extraNote] : [] });
    if (!it) return;
    items.push(it);
    const text = readText(file) || '';
    for (const raw of findImports(text)) {
      const target = raw.startsWith('~') ? expandHome(raw, home) : path.resolve(path.dirname(file), raw);
      if (isFile(target) && !seen.has(target)) {
        seen.add(target);
        const imp = fileItem('gemini', target, { source, always, display, notes: [`imported by ${display(file)}`] });
        if (imp) { imp.name = `@import ${display(target)}`; items.push(imp); }
      }
    }
  };
  for (const n of names) {
    const f = path.join(gdir, n);
    if (isFile(f)) addCtx(f, 'user', true);
  }
  const h = path.resolve(home);
  const under = projectAbs === h || projectAbs.startsWith(h + path.sep);
  const top = under ? h : path.parse(projectAbs).root;
  const root = gitRoot(projectAbs);
  for (const dir of dirsDown(root && root.startsWith(top) ? root : top, projectAbs)) {
    for (const n of names) {
      const f = path.join(dir, n);
      if (isFile(f)) addCtx(f, 'project', true);
    }
  }
  for (const f of walkFiles(projectAbs, { filter: (n) => names.includes(n), maxDepth: 5 })) {
    if (!seen.has(f)) addCtx(f, 'project', false, 'subdirectory file, loads when a tool touches that directory');
  }
  for (const [file, data, source] of [[path.join(gdir, 'settings.json'), userSettings, 'user'], [projSettingsFile, projSettings, 'project']]) {
    items.push(...mcpItems('gemini', data.mcpServers, { source, file, display, removeHint: (n) => `Remove "${n}" from mcpServers in ${display(file)}` }));
  }
  const extDir = path.join(gdir, 'extensions');
  for (const e of listDir(extDir)) {
    const root = path.join(extDir, e.name);
    const manifest = readJson(path.join(root, 'gemini-extension.json'));
    if (!manifest) continue;
    const ename = manifest.name || e.name;
    const ctxNames = Array.isArray(manifest.contextFileName) ? manifest.contextFileName : [manifest.contextFileName || 'GEMINI.md'];
    for (const n of ctxNames) {
      const f = path.join(root, n);
      if (isFile(f)) {
        const it = fileItem('gemini', f, { source: `extension:${ename}`, always: true, display, remove: `gemini extensions uninstall ${ename}` });
        if (it) items.push(it);
      }
    }
    items.push(...mcpItems('gemini', manifest.mcpServers, {
      source: `extension:${ename}`, file: path.join(root, 'gemini-extension.json'), display, removeHint: () => `gemini extensions uninstall ${ename}`,
    }));
  }
  return { tool: 'gemini', items, findings: [], notes: [] };
}
