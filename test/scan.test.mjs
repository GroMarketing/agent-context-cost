import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scan, format, estimateTokens } from '../src/index.mjs';
import { parseFrontmatter, walkFiles } from '../src/fsutil.mjs';
import { findImports, encodeProjectPath } from '../src/claude.mjs';
import { describeServer, measureTools, expandVars } from '../src/mcp.mjs';
import { shellPath, launcherPackage, stripControl } from '../src/model.mjs';
import { parseTomlSubset } from '../src/others.mjs';
import { makeFixture, FIXTURE_NOW } from '../examples/fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'agent-context-cost.mjs');
const FAKE = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

const find = (r, cat, name) => r.items.find((i) => i.category === cat && i.name === name);

function snapshot(dir) {
  const out = {};
  for (const f of walkFiles(dir, { maxDepth: 20, skip: new Set() })) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + fs.statSync(f).mtimeMs;
  }
  return out;
}

test('token heuristic: ~4 chars/token prose, denser for JSON', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'.repeat(25), 'prose'), 25);
  assert.equal(estimateTokens('abc'.repeat(10), 'json'), 10);
  assert.ok(estimateTokens('x'.repeat(100), 'json') > estimateTokens('x'.repeat(100), 'prose'));
  assert.ok(estimateTokens('日本語', 'prose') >= 3);
});

test('frontmatter: scalars, block scalars, lists, booleans', () => {
  const { data, body } = parseFrontmatter('---\nname: a\ndescription: |\n  line one\n  line two\npaths:\n  - "src/**"\nflag: true\n---\nBody\n');
  assert.equal(data.name, 'a');
  assert.equal(data.description, 'line one\nline two');
  assert.deepEqual(data.paths, ['src/**']);
  assert.equal(data.flag, true);
  assert.equal(body.trim(), 'Body');
});

test('imports: @path outside code, not inside backticks or fences, not emails', () => {
  const t = 'see @docs/a.md and `@b.md`\n```\n@c.md\n```\nmail me at x@y.com\n@~/notes/d.md\n@my\\ file.md';
  assert.deepEqual(findImports(t), ['docs/a.md', '~/notes/d.md', 'my file.md']);
});

test('project path encoding matches Claude Code naming', () => {
  assert.equal(encodeProjectPath('/home/dev/My Repo.v2'), '-home-dev-My-Repo-v2');
});

test('MCP descriptions never carry args, env or URL paths', () => {
  const d = describeServer({ command: '/usr/local/bin/npx', args: ['-y', '@scope/pkg@1.2.0', '--token', 'sekrit'], env: { KEY: 'sekrit' } });
  assert.equal(d.command, 'npx');
  assert.equal(d.package, '@scope/pkg');
  assert.ok(!JSON.stringify(d).includes('sekrit'));
  const h = describeServer({ type: 'http', url: 'https://mcp.example.com/v1?key=sekrit' });
  assert.equal(h.host, 'mcp.example.com');
  assert.ok(!JSON.stringify(h).includes('sekrit'));
  assert.equal(launcherPackage('uvx', ['some-server']), 'some-server');
  assert.equal(expandVars('${A}-${B:-dflt}', { A: 'x' }), 'x-dflt');
});

test('measureTools: deferred names are far cheaper than full schemas', () => {
  const m = measureTools([{ name: 't', description: 'd'.repeat(400), inputSchema: { type: 'object' } }], { serverName: 's', instructions: 'use t' });
  assert.equal(m.toolCount, 1);
  assert.ok(m.schemaTokens > m.namesTokens * 5);
  assert.ok(m.instructionsTokens > 0);
});

test('shellPath quotes paths with spaces and keeps ~ expandable', () => {
  assert.equal(shellPath('~/.claude/skills/x'), '~/.claude/skills/x');
  assert.equal(shellPath('~/my dir/x'), '"$HOME/my dir/x"');
});

test('toml subset: mcp_servers tables and arrays', () => {
  const t = parseTomlSubset('a = 1\n[mcp_servers.gh]\ncommand = "npx"\nargs = ["-y", "pkg"]\n[mcp_servers.gh.env]\nK = "v"\n');
  assert.equal(t.a, 1);
  assert.equal(t.mcp_servers.gh.command, 'npx');
  assert.deepEqual(t.mcp_servers.gh.args, ['-y', 'pkg']);
});

test('Claude Code scan of the synthetic fixture', async () => {
  const fx = makeFixture();
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {}, now: FIXTURE_NOW });
    // instructions
    const userMd = find(r, 'instructions', '~/.claude/CLAUDE.md');
    assert.ok(userMd.always > 100);
    const imp = find(r, 'instructions', '@import ~/.claude/notes/writing-style.md');
    assert.ok(imp && imp.always > 0, 'import counted as always loaded');
    assert.ok(!r.items.some((i) => i.name.includes('not-an-import')), 'backticked @path is not an import');
    assert.ok(find(r, 'instructions', './CLAUDE.md').always > 0);
    assert.ok(find(r, 'instructions', './CLAUDE.local.md').always > 0);
    assert.ok(!r.items.some((i) => i.path === './AGENTS.md'), 'AGENTS.md skipped when CLAUDE.md exists');
    const sub = find(r, 'instructions', './packages/web/CLAUDE.md');
    assert.equal(sub.always, 0);
    assert.ok(sub.onDemand > 0);
    assert.ok(find(r, 'rule', '~/.claude/rules/git.md').always > 0);
    const py = find(r, 'rule', '~/.claude/rules/python.md');
    assert.equal(py.always, 0);
    assert.ok(py.onDemand > 0);
    assert.equal(find(r, 'rule', './.claude/rules/api.md').always, 0);
    // memory: first 200 lines only
    const mem = r.items.find((i) => i.category === 'memory');
    assert.ok(mem.always > 0 && mem.notes.some((n) => n.includes('cut off')));
    assert.ok(mem.path.includes('<this-project>'));
    // skills
    assert.equal(find(r, 'skill', 'old-notes').always, 0, 'skillOverrides off');
    assert.equal(find(r, 'skill', 'old-notes').status, 'disabled');
    const dh = find(r, 'skill', 'deploy-helper');
    assert.equal(dh.always, 0);
    assert.ok(dh.onDemand > 0);
    const api = find(r, 'skill', 'api-reference');
    assert.ok(api.onDemand > api.always * 5, 'body is on demand');
    assert.ok(api.notes.some((n) => n.includes('1536')));
    assert.ok(api.always <= Math.ceil((1536 + 40) / 4));
    assert.equal(find(r, 'skill', 'lint-pack:lint').status, 'disabled', 'disabled plugin costs nothing');
    assert.ok(find(r, 'skill', 'doc-kit:docx-writer').always > 0);
    // output style
    const style = find(r, 'output-style', 'terse');
    assert.equal(style.status, 'active');
    assert.ok(style.always > 0);
    // agents
    assert.ok(find(r, 'agent', 'research-assistant').always > find(r, 'agent', 'test-writer').always);
    // hooks
    const ss = find(r, 'hook', 'SessionStart');
    assert.equal(ss.injects, 'session');
    assert.equal(ss.measured, 'unknown');
    assert.equal(find(r, 'hook', 'PostToolUse [Edit|Write]').always, 0);
    // MCP
    assert.equal(find(r, 'mcp', 'browser').status, 'needs-approval');
    assert.equal(find(r, 'mcp', 'postgres').status, 'active');
    assert.equal(find(r, 'mcp', 'postgres').measured, 'unknown');
    assert.equal(find(r, 'mcp', 'tracker').mcp.transport, 'http');
    assert.equal(find(r, 'mcp', 'doc-kit:doc-search').source, 'plugin:doc-kit');
    // findings
    const msgs = r.findings.map((f) => f.message).join('\n');
    assert.match(msgs, /skill "pdf-tools" is installed 2 times/);
    assert.match(msgs, /agent "code-reviewer" is defined 2 times .*the user copy is ignored/);
    assert.equal(r.items.find((i) => i.category === 'agent' && i.name === 'code-reviewer' && i.source === 'user').status, 'shadowed');
    assert.match(msgs, /\/commit-helper is defined both as a command/);
    assert.match(msgs, /"github" and "gh-issues" both launch @modelcontextprotocol\/server-github/);
    assert.match(msgs, /no recorded use/);
    assert.match(msgs, /pdf-tools" \(user\) was last used \d+ days ago/);
    // totals
    assert.ok(r.totals.always > 1000);
    assert.equal(r.toolSearch.deferred, true);
    assert.deepEqual(r.marketplaces.map((m) => m.installedPlugins), [2, 0]);
    // privacy: no raw configs, no secrets, no absolute fixture paths
    const json = JSON.stringify(r);
    assert.ok(!json.includes('_cfg'));
    assert.ok(!json.includes('GITHUB_TOKEN'));
    assert.ok(!json.includes('--read-only'), 'MCP args are not echoed');
    assert.ok(!json.includes(fx.base), 'paths are shown relative to ~ or the project');
    assert.ok(!json.includes('Prefer small, reviewable commits'), 'file contents are never included');
  } finally { fx.cleanup(); }
});

test('the scan is read-only: no file in the scanned home changes', async () => {
  const fx = makeFixture();
  try {
    const before = snapshot(fx.base);
    await scan({ home: fx.home, project: fx.project, env: {}, tools: ['claude', 'cursor', 'codex', 'gemini'] });
    assert.deepEqual(snapshot(fx.base), before);
  } finally { fx.cleanup(); }
});

test('MCP servers are never launched without --probe-mcp', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'acc-')), 'launched');
  const fx = makeFixture({ localMcp: { trap: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } });
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {} });
    assert.equal(find(r, 'mcp', 'trap').measured, 'unknown');
    assert.equal(fs.existsSync(marker), false);
  } finally { fx.cleanup(); }
});

test('--probe-mcp measures a local stdio server, with pagination and instructions', async () => {
  const fx = makeFixture({ localMcp: { notes: { type: 'stdio', command: process.execPath, args: [FAKE] } } });
  const logs = [];
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: { PATH: process.env.PATH }, probeMcp: ['notes'], confirm: async () => true, log: (m) => logs.push(m), probeTimeoutMs: 10000 });
    const it = find(r, 'mcp', 'notes');
    assert.equal(it.measured, 'measured');
    assert.equal(it.mcp.toolCount, 3, 'follows nextCursor');
    assert.ok(it.mcp.instructionsTokens > 0);
    assert.equal(it.always, it.mcp.namesTokens + it.mcp.instructionsTokens, 'tool search: names up front');
    assert.equal(it.onDemand, it.mcp.schemaTokens);
    assert.ok(logs.some((l) => l.startsWith('WARNING')), 'warns before launching');
    assert.equal(find(r, 'mcp', 'github').measured, 'unknown', 'servers outside the list are not launched');
    const off = await scan({ home: fx.home, project: fx.project, env: { PATH: process.env.PATH }, probeMcp: ['notes'], confirm: async () => true, toolSearch: false, log: () => {}, probeTimeoutMs: 10000 });
    const it2 = find(off, 'mcp', 'notes');
    assert.equal(it2.always, it2.mcp.schemaTokens + it2.mcp.instructionsTokens, 'no tool search: full schemas up front');

    // reuse the measurement from a saved report
    const cacheFile = path.join(fx.base, 'report.json');
    fs.writeFileSync(cacheFile, JSON.stringify(r));
    const cached = await scan({ home: fx.home, project: fx.project, env: {}, mcpCache: cacheFile });
    assert.equal(find(cached, 'mcp', 'notes').mcp.toolCount, 3);
  } finally { fx.cleanup(); }
});

test('Cursor, Codex and Gemini CLI scanners use documented locations', async () => {
  const fx = makeFixture();
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {}, tools: ['cursor', 'codex', 'gemini'] });
    const by = (tool) => r.items.filter((i) => i.tool === tool);
    const style = by('cursor').find((i) => i.name.endsWith('style.mdc'));
    const testing = by('cursor').find((i) => i.name.endsWith('testing.mdc'));
    assert.ok(style.always > 0);
    assert.equal(testing.always, 0);
    assert.ok(by('cursor').some((i) => i.category === 'mcp' && i.name === 'github'));
    assert.ok(by('codex').some((i) => i.path === '~/.codex/AGENTS.md' && i.always > 0));
    assert.ok(by('codex').some((i) => i.path === './AGENTS.md'));
    assert.ok(by('codex').some((i) => i.category === 'mcp' && i.name === 'github'));
    assert.ok(by('gemini').some((i) => i.path === '~/.gemini/GEMINI.md'));
    assert.ok(by('gemini').some((i) => i.path === './GEMINI.md'));
    assert.ok(by('gemini').some((i) => i.category === 'mcp'));
    assert.ok(!JSON.stringify(r).includes('placeholder'), 'Codex env values are not echoed');
  } finally { fx.cleanup(); }
});

test('text and Markdown output: totals, tables, no dashes in prose', async () => {
  const fx = makeFixture();
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {}, now: FIXTURE_NOW, tools: ['claude', 'codex'] });
    const text = format(r);
    assert.match(text, /Every session pays\s+~[\d,]+ tokens/);
    assert.match(text, /== Claude Code ==/);
    assert.match(text, /== Codex ==/);
    assert.match(text, /How to remove \(printed only/);
    const md = format(r, { markdown: true });
    assert.match(md, /^# Context cost report/m);
    assert.match(md, /\| category \| always \| on use \| items \|/);
    for (const out of [text, md]) assert.ok(!/[\u2013\u2014]/.test(out), 'no en or em dashes');
  } finally { fx.cleanup(); }
});

test('CLI: --json, --fail-over, bad options', () => {
  const fx = makeFixture();
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: '' };
    const out = execFileSync(process.execPath, [BIN, '--home', fx.home, '--project', fx.project, '--json'], { env, encoding: 'utf8' });
    const j = JSON.parse(out);
    assert.equal(j.tool, 'agent-context-cost');
    assert.ok(j.items.length > 20);
    const over = spawnSync(process.execPath, [BIN, '--home', fx.home, '--project', fx.project, '--fail-over', '10'], { env, encoding: 'utf8' });
    assert.equal(over.status, 2);
    const bad = spawnSync(process.execPath, [BIN, '--nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /--probe-mcp/);
  } finally { fx.cleanup(); }
});

// ---------- security ----------

function trapScript(marker) {
  return ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
}

/** A fixture whose only launchable servers are traps that write marker files. */
function hostileFixture() {
  const fx = makeFixture();
  const markers = { project: path.join(fx.base, 'm-project'), cursor: path.join(fx.base, 'm-cursor'), gemini: path.join(fx.base, 'm-gemini') };
  const w = (rel, obj) => { fs.mkdirSync(path.dirname(path.join(fx.project, rel)), { recursive: true }); fs.writeFileSync(path.join(fx.project, rel), JSON.stringify(obj)); };
  // the cloned repo tries to auto-approve and launch its own servers
  w('.mcp.json', { mcpServers: { trap: { command: process.execPath, args: trapScript(markers.project) } } });
  w('.claude/settings.json', { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['trap'] });
  w('.cursor/mcp.json', { mcpServers: { trap: { command: process.execPath, args: trapScript(markers.cursor) } } });
  w('.gemini/settings.json', { mcpServers: { trap: { command: process.execPath, args: trapScript(markers.gemini) } } });
  // remove every user-side launchable server so nothing else could start
  const cj = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude.json'), 'utf8'));
  cj.mcpServers = {};
  fs.writeFileSync(path.join(fx.home, '.claude.json'), JSON.stringify(cj));
  for (const f of ['.cursor/mcp.json', '.gemini/settings.json']) fs.writeFileSync(path.join(fx.home, f), '{}');
  fs.writeFileSync(path.join(fx.home, '.codex/config.toml'), '');
  fs.rmSync(path.join(fx.home, '.claude/plugins/cache/acme-tools/doc-kit/1.2.0/.mcp.json'));
  const fired = () => Object.values(markers).filter((m) => fs.existsSync(m));
  return { ...fx, markers, fired };
}

const ALL = ['claude', 'cursor', 'codex', 'gemini'];
const ENV = { PATH: process.env.PATH };

test('security: a hostile project config cannot launch anything with --probe-mcp, even confirmed', async () => {
  const fx = hostileFixture();
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: ENV, tools: ALL, probeMcp: true, confirm: async () => true, log: () => {} });
    assert.deepEqual(fx.fired(), []);
    const t = r.items.find((i) => i.tool === 'claude' && i.name === 'trap');
    assert.equal(t.status, 'active', 'still counted for cost, since Claude Code would load it');
    assert.ok(t.notes.some((n) => n.includes('checked-in')));
    assert.ok(t.notes.some((n) => n.includes('not launched')));
  } finally { fx.cleanup(); }
});

test('security: naming a project server is not enough without confirmation', async () => {
  const fx = hostileFixture();
  try {
    await scan({ home: fx.home, project: fx.project, env: ENV, tools: ALL, probeMcp: ['trap'], confirm: async () => false, log: () => {} });
    await scan({ home: fx.home, project: fx.project, env: ENV, tools: ALL, probeMcp: ['trap'], log: () => {} });
    assert.deepEqual(fx.fired(), []);
    const cli = spawnSync(process.execPath, [BIN, '--home', fx.home, '--project', fx.project, '--tool', 'all', '--probe-only', 'trap'], { encoding: 'utf8', input: '' });
    assert.equal(cli.status, 0);
    assert.match(cli.stderr, /--yes/);
    assert.ok(cli.stderr.includes('writeFileSync'), 'the full command and args are shown before anything runs');
    assert.deepEqual(fx.fired(), [], 'no terminal and no --yes: refused');
  } finally { fx.cleanup(); }
});

test('security: named and confirmed is the only way a project server runs; errors stay generic', async () => {
  const fx = hostileFixture();
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: ENV, tools: ['claude'], probeMcp: ['trap'], confirm: async () => true, log: () => {}, probeTimeoutMs: 5000 });
    assert.deepEqual(fx.fired(), [fx.markers.project]);
    const note = r.items.find((i) => i.name === 'trap').notes.find((n) => n.startsWith('probe failed'));
    assert.equal(note, 'probe failed: server exited before answering');
  } finally { fx.cleanup(); }
});

test('security: probe errors never echo server text', async () => {
  const leaky = `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.id==null)return;
    if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
    else console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'bad token '+process.env.LEAKY_SECRET}}));});`;
  const fx = makeFixture({ localMcp: { leaky: { command: process.execPath, args: ['-e', leaky], env: { LEAKY_SECRET: 'hunter2-value' } } } });
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: ENV, probeMcp: ['leaky'], confirm: async () => true, log: () => {}, probeTimeoutMs: 5000 });
    const out = JSON.stringify(r) + format(r);
    assert.ok(!out.includes('hunter2-value'));
    assert.ok(r.items.find((i) => i.name === 'leaky').notes.includes('probe failed: server returned an error'));
  } finally { fx.cleanup(); }
});

test('security: launcher flag values with credentials or paths never reach output', async () => {
  const uvx = { command: 'uvx', args: ['--from', 'git+https://x-access-token:ghp_FAKE0000000000000000@github.com/example/tool', 'example-tool'] };
  const npx = { command: 'npx', args: ['--registry', 'https://user:npm_FAKE0000000000@registry.example.com', '-y', '@example/server'] };
  const docker = { command: 'docker', args: ['run', '--env-file', '/home/me/secrets.env', '-i', '--rm', 'example/image'] };
  assert.equal(launcherPackage(uvx.command, uvx.args), 'example-tool');
  assert.equal(launcherPackage(npx.command, npx.args), '@example/server');
  assert.equal(launcherPackage(docker.command, docker.args), null, 'path-like image names fall back to null');
  assert.equal(launcherPackage('uvx', ['--from', 'git+https://x-access-token:ghp_FAKE@github.com/a/b']), null);
  const fx = makeFixture({ localMcp: { a: uvx, b: npx, c: docker } });
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {} });
    for (const out of [JSON.stringify(r), format(r, { all: true }), format(r, { markdown: true, all: true })]) {
      for (const bad of ['ghp_', 'npm_', 'secrets.env', 'x-access-token', '://user']) assert.ok(!out.includes(bad), bad);
    }
  } finally { fx.cleanup(); }
});

test('security: ANSI and control characters in config names are stripped', async () => {
  assert.equal(stripControl('a\u001b[31mb\u001b[0m\u0007c'), 'abc');
  const fx = makeFixture({ localMcp: { 'evil\u001b[2Jname\u0007': { type: 'http', url: 'https://mcp.example.com/x' } } });
  try {
    const r = await scan({ home: fx.home, project: fx.project, env: {} });
    const out = JSON.stringify(r) + format(r, { all: true }) + format(r, { markdown: true, all: true });
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out.replace(/\n/g, '')));
    assert.ok(r.items.some((i) => i.name === 'evilname'));
  } finally { fx.cleanup(); }
});
