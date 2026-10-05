// Public API: scan() returns a report; format.mjs renders it.
import os from 'node:os';
import path from 'node:path';
import { readJson, makeDisplay } from './fsutil.mjs';
import { scanClaude, applyMcpMeasurement } from './claude.mjs';
import { scanCursor, scanCodex, scanGemini } from './others.mjs';
import { measureTools, probeStdio, transportOf } from './mcp.mjs';
import { analyze } from './findings.mjs';
import { stripControl, sanitizeDeep } from './model.mjs';
import { heuristicNote, RATIOS, setCharsPerToken, estimateTokens } from './tokens.mjs';

export const VERSION = '0.1.0';
export const TOOLS = ['claude', 'cursor', 'codex', 'gemini'];

/**
 * @param {object} o
 * @param {string} [o.home]       home directory to scan (default: os.homedir())
 * @param {string} [o.project]    project directory (default: process.cwd())
 * @param {string[]} [o.tools]    which agents to scan (default ['claude'])
 * @param {object} [o.env]        environment (default process.env)
 * @param {boolean|string[]} [o.probeMcp]  launch local stdio MCP servers to list tools (true = all, or a list of names)
 * @param {string} [o.mcpCache]   path to an earlier --json report to reuse MCP measurements from
 * @param {boolean|null} [o.toolSearch] force tool search on/off (null = detect)
 * @param {boolean} [o.includeManaged] include the managed-policy CLAUDE.md
 * @param {number} [o.charsPerToken] prose chars per token (default 4); code and JSON scale with it
 * @param {(n: number) => Promise<boolean>} [o.confirm] asked before any MCP server is launched; without it nothing is launched
 * @param {(msg: string) => void} [o.log] progress/warning sink (stderr)
 */
export async function scan(o = {}) {
  const home = path.resolve(o.home || os.homedir());
  const project = path.resolve(o.project || process.cwd());
  const env = o.env || process.env;
  const tools = o.tools?.length ? o.tools : ['claude'];
  const log = o.log || (() => {});
  setCharsPerToken(o.charsPerToken);
  const display = makeDisplay({ home, project });
  const items = [];
  const extraFindings = [];
  const notes = [];
  let claude = null;

  if (tools.includes('claude')) {
    claude = scanClaude({ home, project, env, includeManaged: o.includeManaged ?? false, display });
    items.push(...claude.items);
    extraFindings.push(...claude.findings);
  }
  for (const [name, fn] of [['cursor', scanCursor], ['codex', scanCodex], ['gemini', scanGemini]]) {
    if (!tools.includes(name)) continue;
    const r = fn({ home, project, env, display });
    items.push(...r.items);
    notes.push(...(r.notes || []));
  }

  // tool search: Claude Code defers MCP tool schemas by default
  let deferred = true;
  let toolSearchReason = 'Claude Code default: MCP tool schemas are deferred behind tool search; only tool names load up front';
  const tsEnv = env.ENABLE_TOOL_SEARCH ?? claude?.settings.toolSearchEnv;
  const baseUrl = env.ANTHROPIC_BASE_URL ?? claude?.settings.baseUrlEnv;
  if (o.toolSearch === true) { deferred = true; toolSearchReason = 'tool search forced on (--tool-search on)'; }
  else if (o.toolSearch === false) { deferred = false; toolSearchReason = 'tool search forced off (--tool-search off): full MCP schemas load up front'; }
  else if (String(tsEnv).toLowerCase() === 'false') { deferred = false; toolSearchReason = 'ENABLE_TOOL_SEARCH=false: full MCP schemas load up front'; }
  else if (baseUrl) { deferred = false; toolSearchReason = 'ANTHROPIC_BASE_URL is set, which turns tool search off: full MCP schemas load up front'; }

  // MCP measurement: cache first, then the opt-in probe
  const cache = o.mcpCache ? loadCache(o.mcpCache) : new Map();
  const mcpItems = items.filter((i) => i.category === 'mcp');
  for (const it of mcpItems) {
    const hit = cache.get(cacheKey(it));
    if (hit) { applyFor(it, hit); it.notes.push('measured earlier (from --mcp-cache)'); }
  }
  if (o.probeMcp) {
    const only = Array.isArray(o.probeMcp) ? new Set(o.probeMcp) : null;
    const named = (i) => !!only && (only.has(i.name) || only.has(i.serverName));
    // Project-scope configs (.mcp.json, .cursor/mcp.json, .gemini/settings.json
    // in the project) come from whatever repo you cloned. They are launched
    // only when named in --probe-only, whatever the repo's own settings say.
    const targets = mcpItems.filter((i) => {
      if (i.measured !== 'unknown' || transportOf(i._cfg) !== 'stdio') return false;
      if (i.source === 'project') return named(i) && (i.status === 'active' || i.status === 'needs-approval');
      return i.status === 'active' && (!only || named(i));
    });
    const skippedProject = mcpItems.filter((i) => i.source === 'project' && i.measured === 'unknown' && transportOf(i._cfg) === 'stdio' && !targets.includes(i));
    for (const i of skippedProject) i.notes.push('project-scope server not launched; name it in --probe-only to measure it');
    if (targets.length) {
      log(`WARNING: this will launch ${targets.length} MCP server command(s) on this machine, with your environment:`);
      for (const t of targets) {
        const env = Object.keys(t._cfg.env || {});
        log(`  - [${t.tool}] ${stripControl(t.name)} (${t.source})`);
        log(`      ${[t._cfg.command, ...(t._cfg.args || [])].map((a) => JSON.stringify(stripControl(String(a)))).join(' ')}`);
        if (env.length) log(`      env keys: ${env.map((k) => stripControl(k)).join(', ')}`);
      }
      log('Each is started, asked for tools/list, and stopped. Remote (http/sse) servers are never contacted.');
      const ok = o.confirm ? await o.confirm(targets.length) : false;
      if (!ok) {
        log('Not launching anything (not confirmed).');
        for (const t of targets) t.notes.push('probe not confirmed; nothing was launched');
        targets.length = 0;
      }
    }
    for (const t of targets) {
      try {
        const extraVars = t._plugin ? { CLAUDE_PLUGIN_ROOT: path.resolve(t._plugin.root) } : {};
        const res = await probeStdio(t._cfg, { cwd: project, env, extraVars, timeoutMs: o.probeTimeoutMs || 20000 });
        const m = measureTools(res.tools, { serverName: t.serverName || t.name, pluginName: t.mcp.pluginName, instructions: res.instructions });
        m.toolNames = res.tools.map((x) => x.name);
        applyFor(t, m);
        t.notes.push('measured with --probe-mcp');
      } catch (e) {
        t.notes.push(`probe failed: ${probeErrorKind(e)}`);
      }
    }
  }
  function applyFor(it, m) {
    if (it.tool === 'claude') applyMcpMeasurement(it, m, { deferred });
    else applyMcpMeasurement(it, m, { deferred: false });
  }

  const usageAvailable = {
    skill: !!(claude?.usage.skill && Object.keys(claude.usage.skill).length),
  };
  const findings = [...extraFindings, ...analyze(items, { now: o.now, usageAvailable })];

  // public copies only: drop internal fields (raw MCP configs can hold secrets)
  const publicItems = items.map(stripInternal);
  return sanitizeDeep({
    tool: 'agent-context-cost',
    version: VERSION,
    estimate: { note: heuristicNote(), charsPerToken: { ...RATIOS } },
    scanned: { tools, home: '~', project: display(project) === '.' ? path.basename(project) : display(project) },
    toolSearch: tools.includes('claude') ? { deferred, reason: toolSearchReason } : null,
    totals: totals(publicItems),
    categories: byKey(publicItems, (i) => `${i.tool}|${i.category}`),
    sources: byKey(publicItems, (i) => `${i.tool}|${i.source}`),
    items: publicItems,
    findings,
    plugins: claude?.plugins || [],
    marketplaces: claude?.marketplaces || [],
    builtinStyleActive: claude?.builtinStyleActive || null,
    notes,
  });
}

// The server's own error text can echo env values or args, so only a category is reported.
function probeErrorKind(e) {
  if (e && e.code) return `could not start (${String(e.code).replace(/[^A-Z0-9_]/g, '')})`;
  const m = String(e?.message || '');
  if (m.startsWith('timed out')) return 'timed out';
  if (m.startsWith('server exited')) return 'server exited before answering';
  return 'server returned an error';
}

function stripInternal(i) {
  const out = {};
  for (const [k, v] of Object.entries(i)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function totals(items) {
  const active = items.filter((i) => i.status === 'active');
  return {
    always: active.reduce((s, i) => s + (i.always || 0), 0),
    onDemand: active.reduce((s, i) => s + (i.onDemand || 0), 0),
    items: items.length,
    activeItems: active.length,
    unmeasured: active.filter((i) => i.measured === 'unknown' && i.category === 'mcp').length,
    injectingHooks: active.filter((i) => i.category === 'hook' && i.injects && i.injects !== 'tool').length,
  };
}

function byKey(items, fn) {
  const m = new Map();
  for (const i of items) {
    const k = fn(i);
    if (!m.has(k)) {
      const [tool, key] = k.split('|');
      m.set(k, { tool, key, always: 0, onDemand: 0, items: 0, unknown: 0 });
    }
    const row = m.get(k);
    row.items++;
    if (i.status !== 'active') continue;
    row.always += i.always || 0;
    row.onDemand += i.onDemand || 0;
    if (i.always == null) row.unknown++;
  }
  return [...m.values()].sort((a, b) => b.always - a.always || b.onDemand - a.onDemand);
}

function cacheKey(i) {
  return `${i.tool}|${i.name}|${i.mcp?.fingerprint || ''}`;
}

function loadCache(file) {
  const j = readJson(file);
  const m = new Map();
  for (const i of j?.items || []) {
    if (i.category !== 'mcp' || i.measured !== 'measured' || !i.mcp?.toolCount && i.mcp?.toolCount !== 0) continue;
    m.set(cacheKey(i), {
      toolCount: i.mcp.toolCount, schemaTokens: i.mcp.schemaTokens, namesTokens: i.mcp.namesTokens,
      instructionsTokens: i.mcp.instructionsTokens || 0, largestTools: i.mcp.largestTools || [], toolNames: i.mcp.toolNames || [],
    });
  }
  return m;
}

export { estimateTokens };
export { format } from './format.mjs';
