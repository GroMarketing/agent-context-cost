// MCP server helpers: describe a configured server without exposing its
// secrets, turn a tools/list result into token numbers, and (only when the
// user passes --probe-mcp) launch a stdio server locally to ask for its tools.
import { spawn } from 'node:child_process';
import { estimateTokens } from './tokens.mjs';
import { commandName, launcherPackage, urlHost, hash } from './model.mjs';

export function transportOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'unknown';
  const t = cfg.type || cfg.transport;
  if (t === 'http' || t === 'streamable-http' || t === 'streamableHttp') return 'http';
  if (t === 'sse') return 'sse';
  if (t === 'stdio' || cfg.command) return 'stdio';
  if (cfg.url || cfg.httpUrl || cfg.serverUrl) return 'http';
  return 'unknown';
}

/** Public description of a server: no args, env, headers, or URL paths. */
export function describeServer(cfg) {
  const transport = transportOf(cfg);
  const url = cfg?.url || cfg?.httpUrl || cfg?.serverUrl;
  return {
    transport,
    command: transport === 'stdio' ? commandName(cfg.command) : null,
    package: transport === 'stdio' ? launcherPackage(cfg.command, cfg.args) : null,
    host: url ? urlHost(url) : null,
    // one-way fingerprint used to spot the same server configured twice
    fingerprint: transport === 'stdio'
      ? hash(JSON.stringify([String(cfg.command || '').trim(), ...(cfg.args || []).map(String)]))
      : url ? hash(String(url).replace(/\/+$/, '')) : null,
  };
}

/** Tool name as Claude Code exposes it to the model. */
export function exposedToolName(serverName, toolName, pluginName) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const prefix = pluginName ? `plugin_${clean(pluginName)}_${clean(serverName)}` : clean(serverName);
  return `mcp__${prefix}__${toolName}`;
}

/**
 * Token cost of a tools/list result.
 * schemaTokens: name + description + input schema for every tool (what the
 *   model sees when the full definitions load).
 * namesTokens: just the tool names (what loads up front when tool search
 *   defers the schemas).
 */
export function measureTools(tools, { serverName, pluginName, instructions } = {}) {
  const per = [];
  let schemaTokens = 0;
  let namesTokens = 0;
  for (const t of tools || []) {
    const exposed = exposedToolName(serverName || 'server', t.name, pluginName);
    const def = JSON.stringify({ name: exposed, description: t.description || '', input_schema: t.inputSchema || {} });
    const tok = estimateTokens(def, 'json');
    schemaTokens += tok;
    namesTokens += estimateTokens(exposed, 'json') + 1;
    per.push({ name: t.name, tokens: tok });
  }
  per.sort((a, b) => b.tokens - a.tokens);
  return {
    toolCount: per.length,
    schemaTokens,
    namesTokens,
    instructionsTokens: instructions ? estimateTokens(instructions, 'prose') : 0,
    largestTools: per.slice(0, 5),
  };
}

/** Expand ${VAR} and ${VAR:-default} the way Claude Code does in MCP configs. */
export function expandVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, def) =>
    vars[k] != null && vars[k] !== '' ? vars[k] : def != null ? def : '');
}

/**
 * Launch one stdio MCP server, run initialize + tools/list (following
 * pagination), then kill it. Resolves { tools, instructions } or rejects.
 */
export function probeStdio(cfg, { cwd, env = process.env, extraVars = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const vars = { ...env, ...extraVars };
    const command = expandVars(String(cfg.command), vars);
    const args = (cfg.args || []).map((a) => expandVars(String(a), vars));
    const childEnv = { ...env };
    for (const [k, v] of Object.entries(cfg.env || {})) childEnv[k] = expandVars(String(v), vars);
    let child;
    try {
      child = spawn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch (e) { reject(e); return; }

    let buf = '';
    let nextId = 1;
    const pending = new Map();
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);

    const send = (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };
    const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`server exited (code ${code}) before answering`)));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? p.rej(new Error(msg.error.message || 'MCP error')) : p.res(msg.result);
        }
      }
    });

    (async () => {
      const init = await send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agent-context-cost', version: '0.1.0' },
      });
      notify('notifications/initialized', {});
      const tools = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const res = await send('tools/list', cursor ? { cursor } : {});
        tools.push(...(res?.tools || []));
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      finish(null, { tools, instructions: init?.instructions || '' });
    })().catch((e) => finish(e));
  });
}
