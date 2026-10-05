// Duplicate and bloat detection over scanned items. Findings are advice,
// printed with the exact edit or command; nothing here changes any file.
import { fmtInt } from './model.mjs';

const DAY = 24 * 60 * 60 * 1000;
export const STALE_DAYS = 60;
export const LARGE_ITEM_TOKENS = 2000;
export const AGENT_DESC_WARN = 15000;

export function analyze(items, { now = Date.now(), usageAvailable = {} } = {}) {
  const findings = [];
  const push = (kind, message, refs = [], fix = null) => findings.push({ kind, message, refs, fix });
  const live = items.filter((i) => i.status === 'active');

  // same skill / command / agent name in more than one place
  for (const cat of ['skill', 'agent', 'command']) {
    const byName = groupBy(items.filter((i) => i.category === cat && i.status !== 'disabled'), (i) => `${i.tool}|${i.bareName || i.name}`);
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const nm = group[0].bareName || group[0].name;
      const total = group.reduce((s, i) => s + (i.always || 0), 0);
      const shadowed = group.filter((i) => i.status === 'shadowed');
      if (shadowed.length) {
        push('duplicate', `${cat} "${nm}" is defined ${group.length} times (${group.map((i) => i.source).join(', ')}); only one loads, the ${shadowed.map((i) => i.source).join(' and ')} copy is ignored here`, group.map(ref), `If the ignored copy is not needed elsewhere: ${shadowed[0].remove}`);
        continue;
      }
      push('duplicate', `${cat} "${nm}" is installed ${group.length} times (${group.map((i) => i.source).join(', ')}), ~${fmtInt(total)} always-loaded tokens between them`, group.map(ref), `Keep one. ${group[group.length - 1].remove}`);
    }
  }
  // identical bodies under different names
  for (const cat of ['skill', 'agent', 'command']) {
    const byHash = groupBy(items.filter((i) => i.category === cat && i.contentHash && i.onDemand > 20), (i) => i.contentHash);
    for (const group of byHash.values()) {
      const names = new Set(group.map((i) => i.bareName || i.name));
      if (group.length < 2 || names.size < 2) continue;
      push('duplicate', `${group.length} ${cat}s have identical content: ${[...names].join(', ')}`, group.map(ref), `Keep one. ${group[1].remove}`);
    }
  }
  // a command and a skill that both create the same /name
  const skills = new Map(items.filter((i) => i.category === 'skill' && i.status === 'active').map((i) => [`${i.tool}|${i.name}`, i]));
  for (const c of items.filter((i) => i.category === 'command' && i.status === 'active')) {
    const s = skills.get(`${c.tool}|${c.name}`);
    if (s) push('duplicate', `/${c.name} is defined both as a command (${c.path}) and as a skill (${s.path})`, [ref(c), ref(s)], c.remove);
  }
  // identical instruction files (e.g. AGENTS.md copied into CLAUDE.md)
  const instr = groupBy(items.filter((i) => (i.category === 'instructions' || i.category === 'rule') && i.always > 0 && i.contentHash), (i) => `${i.tool}|${i.contentHash}`);
  for (const group of instr.values()) {
    if (group.length < 2) continue;
    push('duplicate', `${group.length} instruction files with identical content are all loaded: ${group.map((i) => i.path).join(', ')}`, group.map(ref), `Delete or empty all but one, or replace the copies with an @import of one file.`);
  }

  // MCP: same command/url under different names, same package, overlapping tools
  const mcp = items.filter((i) => i.category === 'mcp' && i.status === 'active');
  for (const group of groupBy(mcp.filter((i) => i.mcp?.fingerprint), (i) => `${i.tool}|${i.mcp.fingerprint}`).values()) {
    if (group.length < 2) continue;
    push('duplicate', `MCP servers ${group.map((i) => `"${i.name}"`).join(' and ')} run the same command or URL`, group.map(ref), `Keep one. ${group[group.length - 1].remove}`);
  }
  const fpDup = new Set(findings.filter((f) => f.kind === 'duplicate').flatMap((f) => f.refs.map((r) => r.id)));
  for (const group of groupBy(mcp.filter((i) => i.mcp?.package), (i) => `${i.tool}|${i.mcp.package}`).values()) {
    if (group.length < 2 || group.every((i) => fpDup.has(ref(i).id))) continue;
    push('overlap', `MCP servers ${group.map((i) => `"${i.name}"`).join(' and ')} both launch ${group[0].mcp.package}`, group.map(ref), `If they are the same server with different settings, keep the one you use. ${group[group.length - 1].remove}`);
  }
  const measured = mcp.filter((i) => i.mcp?.toolNames?.length);
  for (let a = 0; a < measured.length; a++) {
    for (let b = a + 1; b < measured.length; b++) {
      const A = new Set(measured[a].mcp.toolNames);
      const shared = measured[b].mcp.toolNames.filter((t) => A.has(t));
      const smaller = Math.min(A.size, measured[b].mcp.toolNames.length);
      if (shared.length >= 3 && shared.length / smaller >= 0.5) {
        push('overlap', `MCP servers "${measured[a].name}" and "${measured[b].name}" share ${shared.length} of ${smaller} tool names`, [ref(measured[a]), ref(measured[b])], measured[b].remove);
      }
    }
  }
  for (const s of items.filter((i) => i.category === 'mcp' && i.status === 'shadowed')) {
    push('duplicate', `MCP server "${s.name}" (${s.source}) is configured in more than one scope; this copy is ignored`, [ref(s)], s.remove);
  }

  // bloat
  for (const i of live) {
    if (i.always >= LARGE_ITEM_TOKENS) push('large', `${label(i)} costs ~${fmtInt(i.always)} tokens in every session`, [ref(i)], i.remove);
  }
  for (const i of live.filter((x) => x.notes.some((n) => /cut off|cut from|the rest is cut/.test(n)))) {
    push('truncated', `${label(i)} is longer than what loads; the tail is never seen`, [ref(i)], i.remove);
  }
  for (const i of live.filter((x) => (x.category === 'instructions' || x.category === 'rule') && x.always > 0 && x.lines > 200)) {
    push('large', `${i.path} is ${i.lines} lines; Claude Code's docs suggest under 200 per CLAUDE.md`, [ref(i)], i.remove);
  }
  const agentDesc = live.filter((i) => i.tool === 'claude' && i.category === 'agent').reduce((s, i) => s + i.always, 0);
  if (agentDesc > AGENT_DESC_WARN) push('large', `Subagent descriptions total ~${fmtInt(agentDesc)} tokens; Claude Code warns above 15,000`, [], 'Shorten descriptions and move detail into each agent\'s body, which loads only when it runs.');

  // rarely used: only skills, where Claude Code keeps a usage counter
  if (usageAvailable.skill) {
    const tracked = live.filter((i) => i.category === 'skill' && i.usage && i.always > 0);
    const never = tracked.filter((i) => i.usage.lastUsedAt == null);
    if (never.length) {
      const tok = never.reduce((s, i) => s + i.always, 0);
      push('unused', `${never.length} skill(s) have no recorded use but cost ~${fmtInt(tok)} tokens every session: ${never.map((i) => i.name).join(', ')}`, never.map(ref), 'Hide or remove the ones you do not use (see "How to remove").');
    }
    for (const i of tracked.filter((x) => x.usage.lastUsedAt != null && now - x.usage.lastUsedAt > STALE_DAYS * DAY)) {
      push('unused', `${label(i)} was last used ${Math.floor((now - i.usage.lastUsedAt) / DAY)} days ago`, [ref(i)], i.remove);
    }
  }

  // hooks that inject context
  const injecting = live.filter((i) => i.category === 'hook' && i.injects && i.injects !== 'tool');
  if (injecting.length) {
    push('unmeasured', `${injecting.length} hook(s) can add their output to context (${[...new Set(injecting.map((i) => i.name.split(' ')[0]))].join(', ')}); each run can add up to 10,000 chars`, injecting.map(ref), 'Run the hook command by hand to see how much it prints.');
  }
  const unmeasured = mcp.filter((i) => i.measured === 'unknown');
  if (unmeasured.length) {
    const local = unmeasured.filter((i) => i.mcp?.transport === 'stdio').length;
    push('unmeasured', `${unmeasured.length} MCP server(s) have unmeasured tool schemas` + (local ? `; ${local} are local stdio servers that --probe-mcp can measure (it launches them)` : ''), unmeasured.map(ref), null);
  }
  return findings;
}

function label(i) {
  return `${i.category} "${i.name}"${i.source ? ` (${i.source})` : ''}`;
}
function ref(i) {
  return { id: `${i.tool}:${i.category}:${i.source}:${i.name}:${i.path}`, tool: i.tool, category: i.category, name: i.name, source: i.source };
}
function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
