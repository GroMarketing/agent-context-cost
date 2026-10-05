// Claude Code scanner. Reads (never writes) the documented on-disk layout:
//   ~/.claude/CLAUDE.md, ~/.claude/rules/, ./CLAUDE.md, ./.claude/CLAUDE.md,
//   ./CLAUDE.local.md and their ancestors, @imports, AGENTS.md fallback,
//   auto memory (MEMORY.md), skills, commands, agents, output styles,
//   hooks, plugins (installed_plugins.json + enabledPlugins) and MCP servers
//   (~/.claude.json user and local scope, ./.mcp.json project scope, plugins).
import path from 'node:path';
import os from 'node:os';
import {
  isFile, isDir, readText, readJson, listDir, realpath, walkFiles, parseFrontmatter, expandHome,
} from './fsutil.mjs';
import { estimateTokens } from './tokens.mjs';
import { makeItem, hash, shellPath } from './model.mjs';
import { describeServer, measureTools, transportOf } from './mcp.mjs';

export const SKILL_DESC_CAP = 1536;
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 25 * 1024;
export const IMPORT_MAX_HOPS = 4;
export const HOOK_CONTEXT_CAP_CHARS = 10000;
const BUILTIN_STYLES = new Set(['default', 'Default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);

const SESSION_EVENTS = new Set(['SessionStart', 'SubagentStart']);
const PROMPT_EVENTS = new Set(['UserPromptSubmit', 'UserPromptExpansion', 'PostModelSwitch']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SubagentStop']);

export function claudePaths({ home, env = {} }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(expandHome(env.CLAUDE_CONFIG_DIR, home)) : path.join(home, '.claude');
  const claudeJson = env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(home, '.claude.json');
  return { claudeDir, claudeJson };
}

/** Encode a project path the way Claude Code names ~/.claude/projects/<dir>. */
export function encodeProjectPath(p) {
  return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

function gitRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (isDir(path.join(d, '.git')) || isFile(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Directories from the stop boundary down to the project (top first). */
function ancestorDirs(project, home) {
  const out = [];
  let d = path.resolve(project);
  const h = path.resolve(home);
  const underHome = d === h || d.startsWith(h + path.sep);
  for (;;) {
    out.push(d);
    if (underHome && d === h) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out.reverse();
}

function mergeSettings(list) {
  const merged = { enabledPlugins: {}, skillOverrides: {}, env: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] };
  for (const { data } of list) {
    if (!data) continue;
    Object.assign(merged.enabledPlugins, data.enabledPlugins || {});
    Object.assign(merged.skillOverrides, data.skillOverrides || {});
    Object.assign(merged.env, data.env || {});
    if (Array.isArray(data.enabledMcpjsonServers)) merged.enabledMcpjsonServers.push(...data.enabledMcpjsonServers);
    if (Array.isArray(data.disabledMcpjsonServers)) merged.disabledMcpjsonServers.push(...data.disabledMcpjsonServers);
    for (const k of ['outputStyle', 'enableAllProjectMcpServers', 'disableAllHooks', 'autoMemoryEnabled']) {
      if (data[k] !== undefined) merged[k] = data[k];
    }
  }
  return merged;
}

// ---------- @imports ----------

/** Paths imported with @path, ignoring code fences and inline code spans. */
export function findImports(text) {
  const stripped = text.replace(/```[\s\S]*?(```|$)/g, '').replace(/~~~[\s\S]*?(~~~|$)/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  const re = /(^|[\s(])@((?:\\ |[^\s\\"'`])+)/gm;
  for (const m of stripped.matchAll(re)) {
    const raw = m[2].replace(/\\ /g, ' ');
    if (raw.includes('@')) continue;
    out.push(raw);
  }
  return out;
}

function resolveImport(raw, fromFile, home) {
  const tries = [raw, raw.replace(/[),.;:!?]+$/, '')];
  for (const t of tries) {
    if (!t) continue;
    const p = t.startsWith('~') ? expandHome(t, home) : path.isAbsolute(t) ? t : path.resolve(path.dirname(fromFile), t);
    if (isFile(p)) return p;
  }
  return null;
}

// ---------- scanner ----------

export function scanClaude(opts) {
  const { home, project, env = {}, includeManaged = false, display } = opts;
  const { claudeDir, claudeJson: claudeJsonPath } = claudePaths({ home, env });
  const items = [];
  const findings = [];
  const add = (f) => { const it = makeItem({ tool: 'claude', ...f }); items.push(it); return it; };
  const d = display;
  const claudeJson = readJson(claudeJsonPath) || {};
  const projectAbs = path.resolve(project);
  const groot = gitRoot(projectAbs);
  const projKeys = [projectAbs, realpath(projectAbs), groot].filter(Boolean);
  const projEntry = projKeys.map((k) => claudeJson.projects?.[k]).find(Boolean) || {};

  const settingsFiles = [
    { scope: 'user', file: path.join(claudeDir, 'settings.json') },
    { scope: 'project', file: path.join(projectAbs, '.claude', 'settings.json') },
    { scope: 'local', file: path.join(projectAbs, '.claude', 'settings.local.json') },
  ].map((s) => ({ ...s, data: readJson(s.file) }));
  const settings = mergeSettings(settingsFiles);
  const fileForScope = (scope) => settingsFiles.find((s) => s.scope === scope).file;

  // ---- instructions: CLAUDE.md, rules, imports, AGENTS.md ----
  const seen = new Set();
  const addInstruction = (file, { source, always, label, category = 'instructions', removeHint }) => {
    const rp = realpath(file);
    if (seen.has(rp)) return null;
    seen.add(rp);
    const text = readText(file);
    if (text == null) return null;
    const tok = estimateTokens(text, 'markdown');
    const lines = text.split('\n').length;
    const it = add({
      category, name: label || d(file), source, path: d(file),
      always: always ? tok : 0, onDemand: always ? 0 : tok,
      lines, contentHash: hash(text.trim()),
      remove: removeHint || `Trim ${d(file)}: move task-specific sections into a skill, or into a .claude/rules/ file with a paths: header so they load only when relevant.`,
    });
    if (always && lines > 200) it.notes.push(`${lines} lines; Claude Code's docs suggest staying under 200`);
    expandImportsOf(file, text, it, 1);
    return it;
  };
  const projectEntryApprovedExternal = projEntry.hasClaudeMdExternalIncludesApproved === true;
  const expandImportsOf = (file, text, parent, hop) => {
    if (hop > IMPORT_MAX_HOPS) return;
    for (const raw of findImports(text)) {
      const target = resolveImport(raw, file, home);
      if (!target) continue;
      const rp = realpath(target);
      if (seen.has(rp)) continue;
      seen.add(rp);
      const t = readText(target);
      if (t == null) continue;
      const tok = estimateTokens(t, 'markdown');
      const external = parent.source !== 'user' && parent.source !== 'managed' &&
        !(rp === projectAbs || rp.startsWith(projectAbs + path.sep));
      const pending = external && !projectEntryApprovedExternal;
      const parentAlways = parent.always > 0 || parent.status === 'needs-approval';
      const it = add({
        category: 'instructions', name: `@import ${d(target)}`, source: parent.source, path: d(target),
        always: parentAlways && !pending ? tok : 0, onDemand: parentAlways ? 0 : tok,
        status: pending ? 'needs-approval' : 'active', importedBy: parent.path,
        lines: t.split('\n').length, contentHash: hash(t.trim()),
        remove: `Remove the @${raw} line from ${parent.path.replace(/^@import /, '')}, or trim ${d(target)}.`,
      });
      if (pending) it.notes.push('imported from outside the project; loads only after you approve external imports');
      expandImportsOf(target, t, it, hop + 1);
    }
  };

  if (includeManaged) {
    const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
      : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\CLAUDE.md' : '/etc/claude-code/CLAUDE.md';
    if (isFile(managed)) addInstruction(managed, { source: 'managed', always: true, removeHint: 'Managed by your organization; it cannot be excluded locally.' });
  }
  const userClaudeMd = path.join(claudeDir, 'CLAUDE.md');
  if (isFile(userClaudeMd)) addInstruction(userClaudeMd, { source: 'user', always: true });

  const addRules = (dir, source) => {
    for (const f of walkFiles(dir, { filter: (n) => n.endsWith('.md'), maxDepth: 8 })) {
      const text = readText(f);
      if (text == null) continue;
      const { data } = parseFrontmatter(text);
      const scoped = data.paths != null && data.paths !== '';
      const it = addInstruction(f, {
        source, always: !scoped, category: 'rule',
        removeHint: scoped ? `Delete ${d(f)} if you no longer need it.` : `Add a paths: header to ${d(f)} so it loads only for matching files, or delete it.`,
      });
      if (it && scoped) it.notes.push('path-scoped (paths:), loads when matching files are read');
    }
  };
  addRules(path.join(claudeDir, 'rules'), 'user');

  const dirs = ancestorDirs(projectAbs, home);
  let sawProjectClaudeMd = false;
  for (const dir of dirs) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const f = path.join(dir, name);
      if (!isFile(f) || realpath(f) === realpath(userClaudeMd)) continue;
      sawProjectClaudeMd = true;
      addInstruction(f, { source: name === 'CLAUDE.local.md' ? 'local' : 'project', always: true });
    }
  }
  if (!sawProjectClaudeMd) {
    for (const dir of dirs) {
      for (const name of ['AGENTS.md', path.join('.claude', 'AGENTS.md')]) {
        const f = path.join(dir, name);
        if (isFile(f)) {
          const it = addInstruction(f, { source: 'project', always: true });
          if (it) it.notes.push('loaded because no CLAUDE.md exists in this directory or above');
        }
      }
    }
  }
  addRules(path.join(projectAbs, '.claude', 'rules'), 'project');

  // subdirectory CLAUDE.md and nested rules: loaded when Claude reads files there
  const projectOwn = new Set([
    path.join(projectAbs, 'CLAUDE.md'), path.join(projectAbs, '.claude', 'CLAUDE.md'), path.join(projectAbs, 'CLAUDE.local.md'),
  ].map(realpath));
  const sub = walkFiles(projectAbs, {
    filter: (n, full) => {
      if (full.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) return false;
      if (n === 'CLAUDE.md' || n === 'CLAUDE.local.md') return true;
      return n.endsWith('.md') && full.includes(`${path.sep}.claude${path.sep}rules${path.sep}`) &&
        !full.startsWith(path.join(projectAbs, '.claude', 'rules') + path.sep);
    },
    maxDepth: 5,
  });
  for (const f of sub) {
    if (projectOwn.has(realpath(f))) continue;
    const it = addInstruction(f, {
      source: 'project', always: false, category: f.includes(`${path.sep}rules${path.sep}`) ? 'rule' : 'instructions',
      removeHint: `Loads only when Claude works in ${d(path.dirname(f))}; trim it if it is long.`,
    });
    if (it) it.notes.push('subdirectory file, loads when Claude reads files there');
  }

  // ---- auto memory ----
  const memoryOff = settings.autoMemoryEnabled === false || env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1';
  if (!memoryOff) {
    const candidates = [projectAbs, groot].filter(Boolean).map((p) => path.join(claudeDir, 'projects', encodeProjectPath(p), 'memory'));
    const memDir = candidates.find((m) => isFile(path.join(m, 'MEMORY.md')));
    if (memDir) {
      const f = path.join(memDir, 'MEMORY.md');
      const text = readText(f) || '';
      let loaded = text.split('\n').slice(0, MEMORY_MAX_LINES).join('\n');
      if (Buffer.byteLength(loaded) > MEMORY_MAX_BYTES) loaded = Buffer.from(loaded).subarray(0, MEMORY_MAX_BYTES).toString('utf8');
      // the encoded directory name repeats the absolute project path; keep it out of output
      const shown = d(f).replace(/projects[\\/][^\\/]+[\\/]memory/, 'projects/<this-project>/memory');
      const it = add({
        category: 'memory', name: 'auto memory index (MEMORY.md)', source: 'local', path: shown,
        always: estimateTokens(loaded, 'markdown'), onDemand: 0, lines: text.split('\n').length,
        remove: `Trim ${shown} (only the first 200 lines or 25KB load), or set "autoMemoryEnabled": false in ${d(fileForScope('user'))}.`,
      });
      if (loaded.length < text.length) it.notes.push('longer than 200 lines or 25KB; the rest is cut off and never seen');
      let topics = 0;
      for (const e of listDir(memDir)) {
        if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') topics += estimateTokens(readText(path.join(memDir, e.name)) || '', 'markdown');
      }
      if (topics) it.onDemand = topics;
    }
  }

  // ---- plugins ----
  const installedRaw = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const installed = installedRaw?.plugins || {};
  const plugins = [];
  for (const [key, val] of Object.entries(installed)) {
    const installs = Array.isArray(val) ? val : [val];
    const applicable = installs.filter((i) => {
      if (!i) return false;
      if (!i.scope || i.scope === 'user' || i.scope === 'managed') return true;
      return i.projectPath && projKeys.some((k) => path.resolve(expandHome(i.projectPath, home)) === k);
    });
    if (!applicable.length) continue;
    const inst = applicable[applicable.length - 1];
    const [pname, market] = key.split('@');
    let root = inst.installPath ? path.resolve(expandHome(inst.installPath, home)) : null;
    if (!root || !isDir(root)) root = path.join(claudeDir, 'plugins', 'cache', market || '', pname, inst.version || '');
    const enabled = settings.enabledPlugins[key] === true;
    plugins.push({ key, name: pname, marketplace: market, root, enabled, scope: inst.scope || 'user', version: inst.version });
  }
  for (const [key, on] of Object.entries(settings.enabledPlugins)) {
    if (on === true && !installed[key]) {
      findings.push({ kind: 'info', tool: 'claude', message: `Plugin ${key} is enabled in settings but not installed; it costs nothing until installed.` });
    }
  }
  const marketplacesRaw = readJson(path.join(claudeDir, 'plugins', 'known_marketplaces.json')) || {};
  const marketplaces = Object.keys(marketplacesRaw).map((name) => ({
    name,
    installedPlugins: Object.keys(installed).filter((k) => k.split('@')[1] === name).length,
  }));

  // ---- components (skills, commands, agents, output styles) ----
  const usage = {
    skill: claudeJson.skillUsage || null,
    agent: claudeJson.agentLastUsed || null,
    plugin: claudeJson.pluginUsage || null,
  };
  const overrideFor = (name, bare) => settings.skillOverrides[name] ?? settings.skillOverrides[bare];

  const addSkillLike = (file, { kind, name, source, plugin }) => {
    const text = readText(file);
    if (text == null) return;
    const { data, body } = parseFrontmatter(text);
    const bare = String(data.name || name);
    const full = plugin ? `${plugin.name}:${bare}` : bare;
    let desc = [data.description, data.when_to_use].filter((x) => typeof x === 'string' && x).join(' ');
    let notes = [];
    if (!desc && kind === 'command') {
      desc = (body.split('\n').find((l) => l.trim()) || '').trim().slice(0, 250);
      if (desc) notes.push('no description field; the first line is used');
    }
    if (!desc && kind === 'skill') notes.push('no description; Claude has little to go on when deciding to use it');
    let truncated = false;
    if (desc.length > SKILL_DESC_CAP) { desc = desc.slice(0, SKILL_DESC_CAP); truncated = true; }
    const ov = overrideFor(full, bare);
    const manualOnly = data['disable-model-invocation'] === true;
    let always = estimateTokens(`- ${full}: ${desc}`, 'prose');
    let status = 'active';
    if (ov === 'off' || ov === 'user-invocable-only') { always = 0; status = 'disabled'; notes.push(`skillOverrides: "${ov}"`); }
    else if (ov === 'name-only') { always = estimateTokens(`- ${full}`, 'prose'); notes.push('skillOverrides: "name-only"'); }
    else if (manualOnly) { always = 0; notes.push('disable-model-invocation: only loads when you type it'); }
    if (truncated && status === 'active') notes.push(`description over ${SKILL_DESC_CAP} chars; the rest is cut from the listing`);
    if (plugin && !plugin.enabled) { always = 0; status = 'disabled'; }
    const where = path.dirname(file);
    let remove;
    if (plugin) remove = `claude plugin disable ${plugin.key}  (whole plugin), or hide just this one: "skillOverrides": { "${full}": "off" } in ${d(fileForScope('user'))}`;
    else if (kind === 'skill') remove = `Hide: "skillOverrides": { "${bare}": "off" } in ${d(fileForScope(source === 'user' ? 'user' : 'local'))}   Delete: rm -r ${shellPath(d(where))}`;
    else remove = `rm ${shellPath(d(file))}`;
    const it = add({
      category: kind, name: full, bareName: bare, source: plugin ? `plugin:${plugin.name}` : source, path: d(kind === 'skill' ? where : file),
      always, onDemand: status === 'disabled' ? 0 : estimateTokens(body, 'markdown'), status, notes, remove,
      contentHash: hash(body.trim()), plugin: plugin?.key,
    });
    if (kind === 'skill' && usage.skill) attachUsage(it, plugin ? usage.skill[full] : usage.skill[bare]);
    return it;
  };

  const addAgent = (file, { source, plugin }) => {
    const text = readText(file);
    if (text == null) return;
    const { data, body } = parseFrontmatter(text);
    const bare = String(data.name || path.basename(file, '.md'));
    const full = plugin ? `${plugin.name}:${bare}` : bare;
    const tools = Array.isArray(data.tools) ? data.tools.join(', ') : data.tools || '*';
    const listing = `- ${full}: ${data.description || ''} (Tools: ${tools})`;
    const it = add({
      category: 'agent', name: full, bareName: bare, source: plugin ? `plugin:${plugin.name}` : source, path: d(file),
      always: plugin && !plugin.enabled ? 0 : estimateTokens(listing, 'prose'),
      onDemand: estimateTokens(body, 'markdown'), status: plugin && !plugin.enabled ? 'disabled' : 'active',
      contentHash: hash(body.trim()), plugin: plugin?.key,
      remove: plugin ? `claude plugin disable ${plugin.key}  (whole plugin)` : `rm ${shellPath(d(file))}`,
    });
    if (!data.description) it.notes.push('no description');
    if (usage.agent) attachUsage(it, usage.agent[full] ?? usage.agent[bare]);
    return it;
  };

  const addStyle = (file, { source, plugin }) => {
    const text = readText(file);
    if (text == null) return;
    const { data, body } = parseFrontmatter(text);
    const name = String(data.name || path.basename(file, '.md'));
    const forced = plugin?.enabled && data['force-for-plugin'] === true;
    const active = forced || (!plugin || plugin.enabled) && settings.outputStyle === name;
    const tok = estimateTokens(body, 'markdown');
    const which = ['local', 'project', 'user'].find((s) => settingsFiles.find((f) => f.scope === s).data?.outputStyle === name);
    const it = add({
      category: 'output-style', name, source: plugin ? `plugin:${plugin.name}` : source, path: d(file),
      always: active ? tok : 0, onDemand: active ? 0 : tok, status: active ? 'active' : 'inactive',
      remove: forced ? `claude plugin disable ${plugin.key}  (it forces this style)`
        : active ? `Set "outputStyle": "default" in ${d(fileForScope(which || 'user'))}` : `Not selected, so it costs nothing. Delete ${d(file)} if unused.`,
    });
    if (active && data['keep-coding-instructions'] !== true) it.notes.push('replaces Claude Code\'s built-in coding instructions (keep-coding-instructions is not true)');
    if (!active) it.notes.push('not selected; costs nothing until chosen');
  };

  const scanSkillsDir = (dir, source, plugin) => {
    for (const e of listDir(dir)) {
      const sd = path.join(dir, e.name);
      const f = path.join(sd, 'SKILL.md');
      if (isFile(f)) addSkillLike(f, { kind: 'skill', name: e.name, source, plugin });
    }
  };
  const scanCommandsDir = (dir, source, plugin) => {
    for (const f of walkFiles(dir, { filter: (n) => n.endsWith('.md'), maxDepth: 4 })) {
      const rel = path.relative(dir, f).replace(/\.md$/, '').split(path.sep).join(':');
      addSkillLike(f, { kind: 'command', name: rel, source, plugin });
    }
  };
  const scanAgentsDir = (dir, source, plugin) => {
    for (const f of walkFiles(dir, { filter: (n) => n.endsWith('.md'), maxDepth: 3 })) addAgent(f, { source, plugin });
  };
  const scanStylesDir = (dir, source, plugin) => {
    for (const f of walkFiles(dir, { filter: (n) => n.endsWith('.md'), maxDepth: 2 })) addStyle(f, { source, plugin });
  };

  scanSkillsDir(path.join(claudeDir, 'skills'), 'user');
  scanCommandsDir(path.join(claudeDir, 'commands'), 'user');
  scanAgentsDir(path.join(claudeDir, 'agents'), 'user');
  scanStylesDir(path.join(claudeDir, 'output-styles'), 'user');
  const projectClaudeDirs = dirs.map((x) => path.join(x, '.claude')).filter((x) => realpath(x) !== realpath(claudeDir) && isDir(x));
  const pcd = path.join(projectAbs, '.claude');
  if (isDir(pcd) && realpath(pcd) !== realpath(claudeDir)) {
    scanSkillsDir(path.join(pcd, 'skills'), 'project');
    scanCommandsDir(path.join(pcd, 'commands'), 'project');
  }
  // agents and output styles are discovered walking up from the working directory
  for (const x of projectClaudeDirs) {
    scanAgentsDir(path.join(x, 'agents'), 'project');
    scanStylesDir(path.join(x, 'output-styles'), 'project');
  }

  // same-named agents: the project definition wins over the user one
  const agentByName = new Map();
  for (const a of items.filter((i) => i.category === 'agent' && !i.plugin)) {
    if (!agentByName.has(a.name)) agentByName.set(a.name, []);
    agentByName.get(a.name).push(a);
  }
  for (const group of agentByName.values()) {
    if (group.length < 2) continue;
    // project agents were scanned top-down, so the last project copy is the closest
    const proj = group.filter((a) => a.source === 'project');
    const win = proj.length ? proj[proj.length - 1] : group[0];
    for (const a of group) {
      if (a === win) continue;
      a.status = 'shadowed';
      a.always = 0;
      a.onDemand = 0;
      a.notes.push(`shadowed by ${win.path}`);
    }
  }

  // ---- hooks ----
  const hookEntries = [];
  for (const s of settingsFiles) {
    for (const [event, groups] of Object.entries(s.data?.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        hookEntries.push({ event, matcher: g.matcher, count: (g.hooks || []).length, source: s.scope, file: s.file });
      }
    }
  }

  // ---- MCP servers ----
  const servers = [];
  for (const [name, cfg] of Object.entries(claudeJson.mcpServers || {})) servers.push({ name, cfg, scope: 'user', file: claudeJsonPath });
  for (const [name, cfg] of Object.entries(projEntry.mcpServers || {})) servers.push({ name, cfg, scope: 'local', file: claudeJsonPath });
  const mcpJsonPath = path.join(projectAbs, '.mcp.json');
  const mcpJson = readJson(mcpJsonPath);
  const enabledMcpjson = new Set([...settings.enabledMcpjsonServers, ...(projEntry.enabledMcpjsonServers || [])]);
  const disabledMcpjson = new Set([...settings.disabledMcpjsonServers, ...(projEntry.disabledMcpjsonServers || [])]);
  // approval that comes only from the project's checked-in settings is not
  // the user's own trust; it still decides what Claude Code loads, so it
  // counts for cost, but it never makes a server eligible for --probe-mcp
  const userSide = settingsFiles.filter((f) => f.scope !== 'project').map((f) => f.data || {});
  const userApproved = (name) => userSide.some((dta) => dta.enableAllProjectMcpServers === true ||
    (Array.isArray(dta.enabledMcpjsonServers) && dta.enabledMcpjsonServers.includes(name))) ||
    (projEntry.enabledMcpjsonServers || []).includes(name);
  for (const [name, cfg] of Object.entries(mcpJson?.mcpServers || {})) {
    let status = 'needs-approval';
    if (disabledMcpjson.has(name)) status = 'disabled';
    else if (settings.enableAllProjectMcpServers === true || enabledMcpjson.has(name)) status = 'active';
    servers.push({ name, cfg, scope: 'project', file: mcpJsonPath, status, approvedByProjectOnly: status === 'active' && !userApproved(name) });
  }

  // ---- plugin contents ----
  for (const p of plugins) {
    const manifest = readJson(path.join(p.root, '.claude-plugin', 'plugin.json')) || {};
    if (manifest.name) p.name = manifest.name;
    const extra = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => path.resolve(p.root, x));
    const plugin = p;
    const skillDirs = [path.join(p.root, 'skills'), ...extra(manifest.skills)];
    for (const sd of skillDirs) {
      if (isFile(path.join(sd, 'SKILL.md'))) addSkillLike(path.join(sd, 'SKILL.md'), { kind: 'skill', name: path.basename(sd), source: 'plugin', plugin });
      else scanSkillsDir(sd, 'plugin', plugin);
    }
    for (const cd of [path.join(p.root, 'commands'), ...extra(manifest.commands)]) {
      if (isFile(cd)) addSkillLike(cd, { kind: 'command', name: path.basename(cd, '.md'), source: 'plugin', plugin });
      else scanCommandsDir(cd, 'plugin', plugin);
    }
    for (const ad of [path.join(p.root, 'agents'), ...extra(manifest.agents)]) {
      if (isFile(ad)) addAgent(ad, { source: 'plugin', plugin });
      else scanAgentsDir(ad, 'plugin', plugin);
    }
    for (const od of [path.join(p.root, 'output-styles'), ...extra(manifest.outputStyles)]) {
      if (isFile(od)) addStyle(od, { source: 'plugin', plugin });
      else scanStylesDir(od, 'plugin', plugin);
    }
    // hooks
    const hookSources = [];
    if (isFile(path.join(p.root, 'hooks', 'hooks.json'))) hookSources.push(readJson(path.join(p.root, 'hooks', 'hooks.json')));
    for (const h of Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks ? [manifest.hooks] : []) {
      hookSources.push(typeof h === 'string' ? readJson(path.resolve(p.root, h)) : h);
    }
    for (const hs of hookSources) {
      for (const [event, groups] of Object.entries(hs?.hooks || {})) {
        for (const g of Array.isArray(groups) ? groups : []) {
          hookEntries.push({ event, matcher: g.matcher, count: (g.hooks || []).length, source: `plugin:${p.name}`, plugin: p });
        }
      }
    }
    // MCP
    const mcpSources = [];
    if (isFile(path.join(p.root, '.mcp.json'))) mcpSources.push(readJson(path.join(p.root, '.mcp.json')));
    for (const m of Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers ? [manifest.mcpServers] : []) {
      mcpSources.push(typeof m === 'string' ? readJson(path.resolve(p.root, m)) : m);
    }
    for (const ms of mcpSources) {
      const map = ms?.mcpServers || ms || {};
      for (const [name, cfg] of Object.entries(map)) {
        if (cfg && typeof cfg === 'object') servers.push({ name, cfg, scope: 'plugin', plugin: p, file: path.join(p.root, '.mcp.json'), status: p.enabled ? 'active' : 'disabled' });
      }
    }
    // plugin summary row (zero cost itself; components carry the tokens)
    const pu = usage.plugin ? usage.plugin[p.key] || usage.plugin[p.name] : undefined;
    p.usage = pu;
  }

  for (const h of hookEntries) {
    const injects = SESSION_EVENTS.has(h.event) ? 'session' : PROMPT_EVENTS.has(h.event) ? 'prompt' : TOOL_EVENTS.has(h.event) ? 'tool' : null;
    const disabled = settings.disableAllHooks === true || (h.plugin && !h.plugin.enabled);
    const it = add({
      category: 'hook', name: h.event + (h.matcher ? ` [${h.matcher}]` : ''), source: h.source,
      path: h.file ? d(h.file) : h.plugin ? d(h.plugin.root) : null,
      always: 0, onDemand: 0, measured: injects ? 'unknown' : 'estimate', status: disabled ? 'disabled' : 'active',
      injects, maxInjectTokens: injects ? Math.ceil(HOOK_CONTEXT_CAP_CHARS / 4) : 0,
      remove: h.plugin ? `claude plugin disable ${h.plugin.key}  (whole plugin)` : `Remove the hooks.${h.event} entry from ${d(h.file)}`,
    });
    if (injects === 'session') it.notes.push('its output is added to context at session start (up to 10,000 chars, about 2,500 tokens); size unknown without running it');
    else if (injects === 'prompt') it.notes.push('its output can be added to context on every prompt (up to 10,000 chars each time)');
    else if (injects === 'tool') it.notes.push('can add context next to tool results');
    else it.notes.push('no model context cost');
  }

  // MCP precedence: local > project > user for the same name
  const rank = { local: 0, project: 1, user: 2 };
  const winner = new Map();
  for (const s of servers) {
    if (s.scope === 'plugin') continue;
    if (s.status && s.status !== 'active') continue;
    const cur = winner.get(s.name);
    if (!cur || rank[s.scope] < rank[cur.scope]) winner.set(s.name, s);
  }
  const disabledByToggle = new Set(projEntry.disabledMcpServers || []);
  for (const s of servers) {
    const desc = describeServer(s.cfg);
    let status = s.status || 'active';
    const label = s.plugin ? `${s.plugin.name}:${s.name}` : s.name;
    if (disabledByToggle.has(s.name) || disabledByToggle.has(label)) status = 'disabled';
    if (status === 'active' && s.scope !== 'plugin' && winner.get(s.name) !== s) status = 'shadowed';
    let remove;
    if (s.scope === 'plugin') remove = `claude plugin disable ${s.plugin.key}  (whole plugin)`;
    else if (s.scope === 'project') remove = `Remove "${s.name}" from .mcp.json, or just for you: add "${s.name}" to "disabledMcpjsonServers" in .claude/settings.local.json`;
    else remove = `claude mcp remove ${s.name} -s ${s.scope}`;
    const it = add({
      category: 'mcp', name: label, serverName: s.name, source: s.scope === 'plugin' ? `plugin:${s.plugin.name}` : s.scope,
      path: d(s.file), always: null, onDemand: null, measured: 'unknown', status, remove,
      mcp: { ...desc, pluginName: s.plugin?.name || null },
      _cfg: s.cfg, _plugin: s.plugin,
    });
    if (status === 'needs-approval') it.notes.push('in .mcp.json but not approved for this project; costs nothing until approved');
    if (s.approvedByProjectOnly) it.notes.push('approved only by the project\'s checked-in .claude/settings.json');
    if (status === 'shadowed') it.notes.push(`a ${winner.get(s.name).scope}-scope server with the same name takes precedence`);
    if (status === 'disabled') { it.always = 0; it.onDemand = 0; }
    if (status === 'needs-approval' || status === 'shadowed') { it.always = 0; it.onDemand = 0; }
    if (transportOf(s.cfg) !== 'stdio' && status === 'active') it.notes.push('remote server; tool schemas are not measured (no network calls)');
  }

  return {
    tool: 'claude', items, findings, marketplaces, usage,
    plugins: plugins.map((p) => ({ key: p.key, name: p.name, marketplace: p.marketplace, enabled: p.enabled, scope: p.scope, version: p.version, path: d(p.root), usage: p.usage || null })),
    settings: { outputStyle: settings.outputStyle || null, toolSearchEnv: settings.env.ENABLE_TOOL_SEARCH ?? null, baseUrlEnv: settings.env.ANTHROPIC_BASE_URL ?? null, disableAllHooks: settings.disableAllHooks === true },
    builtinStyleActive: settings.outputStyle && BUILTIN_STYLES.has(settings.outputStyle) ? settings.outputStyle : null,
  };
}

function attachUsage(item, u) {
  if (u == null) { item.usage = { count: 0, lastUsedAt: null }; return; }
  if (typeof u === 'number') item.usage = { count: null, lastUsedAt: u };
  else item.usage = { count: u.usageCount ?? null, lastUsedAt: u.lastUsedAt ?? null };
}

/** Apply MCP measurements (from a probe or a cache) and tool-search mode to MCP items. */
export function applyMcpMeasurement(item, m, { deferred }) {
  item.measured = 'measured';
  item.mcp = { ...item.mcp, toolCount: m.toolCount, schemaTokens: m.schemaTokens, namesTokens: m.namesTokens, instructionsTokens: m.instructionsTokens, largestTools: m.largestTools, toolNames: m.toolNames };
  if (item.status !== 'active') { item.always = 0; item.onDemand = 0; return; }
  if (deferred) {
    item.always = m.namesTokens + m.instructionsTokens;
    item.onDemand = m.schemaTokens;
  } else {
    item.always = m.schemaTokens + m.instructionsTokens;
    item.onDemand = 0;
  }
}

export { measureTools };
export const _internal = { ancestorDirs, mergeSettings, gitRoot, os };
