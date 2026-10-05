// Copies the synthetic fixture home to a temp directory and adds the parts
// that depend on absolute paths (Claude Code keys project state by path).
// Everything in fixture-home is invented for tests and the README sample.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeProjectPath } from '../src/claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SRC = path.join(here, 'fixture-home');
// fixed "now" so usage findings render the same way every time
export const FIXTURE_NOW = Date.UTC(2026, 8, 30);

export function makeFixture({ localMcp } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-fixture-'));
  const home = path.join(base, 'home');
  fs.cpSync(FIXTURE_SRC, home, { recursive: true });
  const project = path.join(home, 'projects', 'demo-app');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });

  const memDir = path.join(home, '.claude', 'projects', encodeProjectPath(project), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const lines = ['# Memory index', ''];
  for (let i = 1; i <= 230; i++) lines.push(`- [Note ${i}](note-${i}.md) - fact ${i}`);
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(memDir, 'note-1.md'), '# Note 1\n\nThe staging database is reset every Monday.\n');

  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  cj.projects = {
    [project]: {
      mcpServers: localMcp || {},
      enabledMcpjsonServers: [],
      disabledMcpServers: [],
    },
  };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cj, null, 2));
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
