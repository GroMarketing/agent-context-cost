#!/usr/bin/env node
// agent-context-cost: what is eating your agent's context window before you
// type anything. Read-only. No network unless you opt in to --probe-mcp,
// which launches local stdio MCP servers (never remote ones).
import readline from 'node:readline';
import { scan, format, VERSION, TOOLS } from '../src/index.mjs';

const HELP = `agent-context-cost ${VERSION}
What is eating your coding agent's context window before you type anything,
and what each add-on costs. Read-only: it prints removal steps, it never runs them.

Usage
  agent-context-cost [options]

Options
  --tool <list>        claude (default), cursor, codex, gemini, or all. Comma-separated.
  --project <dir>      project to scan (default: current directory)
  --home <dir>         home directory to scan (default: your home). Also: AGENT_CONTEXT_COST_HOME
  --json               machine-readable report
  --markdown           Markdown report, for sharing
  --top <n>            how many items to rank (default 10)
  --all                list every always-loaded item
  --probe-mcp          OPT-IN: launch each configured local (stdio) MCP server, ask it
                       for tools/list, and stop it, to measure tool schemas exactly.
                       This runs the commands in your MCP config with your environment.
  --probe-only <names> like --probe-mcp, but only for these servers (comma-separated).
                       Servers from the project's own config (.mcp.json, .cursor/mcp.json,
                       .gemini/settings.json) are launched only when named here.
  --yes                confirm the launch without a prompt (needed when there is no terminal)
  --mcp-cache <file>   reuse MCP measurements from an earlier --json report
  --tool-search <on|off>  override detection of Claude Code's MCP tool search
  --chars-per-token <n>  prose chars per token (default 4; code and JSON scale with it)
  --managed            also count the organization-managed CLAUDE.md
  --fail-over <n>      exit 2 if any agent's always-loaded total exceeds n tokens (for CI)
  -h, --help           this help
  -v, --version        print the version

Token counts are estimates (~4 chars/token for prose, ~3 for JSON schemas).
Inside a Claude Code session, /context shows the real numbers.`;

function parseArgs(argv) {
  const o = { tools: ['claude'], top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) fail(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--json') o.json = true;
    else if (a === '--markdown' || a === '--md') o.markdown = true;
    else if (a === '--all') o.all = true;
    else if (a === '--probe-mcp') o.probeMcp = o.probeMcp || true;
    else if (a === '--probe-only') o.probeMcp = val().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--managed') o.includeManaged = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--home') o.home = val();
    else if (a === '--project' || a === '--root') o.project = val();
    else if (a === '--mcp-cache') o.mcpCache = val();
    else if (a === '--top') o.top = Math.max(1, parseInt(val(), 10) || 10);
    else if (a === '--chars-per-token') o.charsPerToken = parseFloat(val());
    else if (a === '--fail-over') o.failOver = parseInt(val(), 10);
    else if (a === '--tool-search') {
      const v = val();
      if (!['on', 'off'].includes(v)) fail('--tool-search takes on or off');
      o.toolSearch = v === 'on';
    } else if (a === '--tool' || a === '--tools') {
      const v = val();
      o.tools = v === 'all' ? [...TOOLS] : v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = o.tools.filter((t) => !TOOLS.includes(t));
      if (bad.length) fail(`unknown tool: ${bad.join(', ')} (use ${TOOLS.join(', ')} or all)`);
    } else fail(`unknown option: ${a}`);
  }
  return o;
}

function fail(msg) {
  process.stderr.write(`agent-context-cost: ${msg}\nRun with --help for usage.\n`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { process.stdout.write(HELP + '\n'); process.exit(0); }
if (opts.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }

const home = opts.home || process.env.AGENT_CONTEXT_COST_HOME;
// With an explicit home, ignore env vars that point at the real config dirs.
const env = { ...process.env };
if (home) { delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; }
const report = await scan({
  home,
  env,
  project: opts.project,
  tools: opts.tools,
  probeMcp: opts.probeMcp,
  mcpCache: opts.mcpCache,
  toolSearch: opts.toolSearch ?? null,
  includeManaged: opts.includeManaged && !home,
  charsPerToken: opts.charsPerToken,
  log: (m) => process.stderr.write(m + '\n'),
  confirm: async (n) => {
    if (opts.yes) return true;
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      process.stderr.write('No terminal to confirm in. Re-run with --yes to launch these commands.\n');
      return false;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((res) => rl.question(`Launch these ${n} command(s)? [y/N] `, res));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  },
});

if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else process.stdout.write(format(report, { markdown: opts.markdown, top: opts.top, all: opts.all }));

if (Number.isFinite(opts.failOver)) {
  for (const tool of report.scanned.tools) {
    const total = report.items.filter((i) => i.tool === tool && i.status === 'active').reduce((s, i) => s + (i.always || 0), 0);
    if (total > opts.failOver) {
      process.stderr.write(`agent-context-cost: ${tool} always-loaded total ~${total} tokens is over ${opts.failOver}\n`);
      process.exitCode = 2;
    }
  }
}
