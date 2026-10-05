// Renderers for the terminal (plain text) and Markdown. Only names, sizes,
// paths and advice are printed: never file contents, args, env or secrets.
import { fmtInt } from './model.mjs';

export const TOOL_LABEL = { claude: 'Claude Code', cursor: 'Cursor', codex: 'Codex', gemini: 'Gemini CLI' };
const KIND_LABEL = { duplicate: 'DUPLICATE', overlap: 'OVERLAP', large: 'LARGE', truncated: 'TRUNCATED', unused: 'UNUSED', unmeasured: 'UNMEASURED', info: 'INFO' };

export function format(report, { markdown = false, top = 10, all = false } = {}) {
  return markdown ? toMarkdown(report, { top, all }) : toText(report, { top, all });
}

function perTool(report) {
  return report.scanned.tools.map((tool) => {
    const items = report.items.filter((i) => i.tool === tool);
    const active = items.filter((i) => i.status === 'active');
    return {
      tool,
      items,
      active,
      always: active.reduce((s, i) => s + (i.always || 0), 0),
      onDemand: active.reduce((s, i) => s + (i.onDemand || 0), 0),
      unmeasuredMcp: active.filter((i) => i.category === 'mcp' && i.measured === 'unknown').length,
      injectingHooks: active.filter((i) => i.category === 'hook' && i.injects && i.injects !== 'tool').length,
      categories: report.categories.filter((c) => c.tool === tool),
      sources: report.sources.filter((c) => c.tool === tool),
      findings: report.findings.filter((f) => (f.refs?.length ? f.refs.some((r) => r.tool === tool) : (f.tool || 'claude') === tool)),
    };
  });
}

function topItems(t, n, all) {
  const list = t.active.filter((i) => (i.always || 0) > 0 || i.always == null).sort((a, b) => (b.always ?? -1) - (a.always ?? -1));
  return all ? list : list.slice(0, n);
}

function unmeasuredLine(t) {
  const parts = [];
  if (t.unmeasuredMcp) parts.push(`${t.unmeasuredMcp} MCP server${t.unmeasuredMcp > 1 ? 's' : ''}`);
  if (t.injectingHooks) parts.push(`${t.injectingHooks} context-adding hook${t.injectingHooks > 1 ? 's' : ''}`);
  return parts.join(', ');
}

// ---------------- text ----------------

function table(rows, aligns) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r, ri) => r.map((cell, c) => {
    const s = String(cell);
    const pad = aligns[c] === 'r' ? s.padStart(widths[c]) : s.padEnd(widths[c]);
    return pad;
  }).join('  ').trimEnd() + (ri === 0 ? '\n' + widths.map((w) => '-'.repeat(w)).join('  ') : '')).join('\n');
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function toText(report, { top, all }) {
  const out = [];
  out.push(`agent-context-cost ${report.version}   project: ${report.scanned.project}`);
  out.push(report.estimate.note);
  if (report.toolSearch) out.push(`MCP: ${report.toolSearch.reason}.`);
  for (const t of perTool(report)) {
    out.push('');
    out.push(`== ${TOOL_LABEL[t.tool] || t.tool} ==`);
    if (!t.items.length) { out.push('Nothing found.'); continue; }
    out.push(`Every session pays  ~${fmtInt(t.always)} tokens before you type anything`);
    out.push(`Paid only on use    ~${fmtInt(t.onDemand)} tokens`);
    const um = unmeasuredLine(t);
    if (um) out.push(`Not measured        ${um}`);
    if (t.tool === 'claude' && report.builtinStyleActive) out.push(`Output style        built-in "${report.builtinStyleActive}" (not measured)`);

    out.push('');
    out.push(table([
      ['category', 'always', 'on use', 'items'],
      ...t.categories.map((c) => [c.key, fmtInt(c.always) + (c.unknown ? ` +${c.unknown}?` : ''), fmtInt(c.onDemand), c.items]),
    ], ['l', 'r', 'r', 'r']));

    if (t.sources.length > 1) {
      out.push('');
      out.push('By source (what each add-on costs)');
      out.push(table([
        ['source', 'always', 'on use', 'items'],
        ...t.sources.map((c) => [c.key, fmtInt(c.always) + (c.unknown ? ` +${c.unknown}?` : ''), fmtInt(c.onDemand), c.items]),
      ], ['l', 'r', 'r', 'r']));
    }

    const tops = topItems(t, top, all);
    if (tops.length) {
      out.push('');
      out.push(all ? 'Always-loaded items' : `Top ${tops.length} always-loaded items`);
      out.push(table([
        ['#', 'tokens', 'category', 'name', 'source'],
        ...tops.map((i, n) => [n + 1, i.always == null ? '?' : fmtInt(i.always), i.category, clip(i.name, 48), clip(i.source, 24)]),
      ], ['r', 'r', 'l', 'l', 'l']));
    }

    if (t.findings.length) {
      out.push('');
      out.push('Findings');
      for (const f of t.findings) {
        out.push(`  ${(KIND_LABEL[f.kind] || f.kind.toUpperCase()).padEnd(10)} ${f.message}`);
        if (f.fix) out.push(`  ${''.padEnd(10)} fix: ${f.fix}`);
      }
    }

    if (tops.length) {
      out.push('');
      out.push('How to remove (printed only; this tool never changes files)');
      for (const i of tops) if (i.remove) out.push(`  ${clip(i.name, 40)}: ${i.remove}`);
    }
  }
  if (report.notes.length) { out.push(''); for (const n of report.notes) out.push(`Note: ${n}`); }
  return out.join('\n') + '\n';
}

// ---------------- markdown ----------------

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

function mdTable(head, rows, aligns) {
  const sep = aligns.map((a) => (a === 'r' ? '---:' : '---'));
  return [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

function toMarkdown(report, { top, all }) {
  const out = [];
  out.push(`# Context cost report`);
  out.push('');
  out.push(`Project: \`${report.scanned.project}\`. ${report.estimate.note}`);
  if (report.toolSearch) out.push(`MCP: ${report.toolSearch.reason}.`);
  for (const t of perTool(report)) {
    out.push('');
    out.push(`## ${TOOL_LABEL[t.tool] || t.tool}`);
    out.push('');
    if (!t.items.length) { out.push('Nothing found.'); continue; }
    out.push(`- **Every session:** ~${fmtInt(t.always)} tokens before you type anything`);
    out.push(`- **On use only:** ~${fmtInt(t.onDemand)} tokens`);
    const um = unmeasuredLine(t);
    if (um) out.push(`- **Not measured:** ${um}`);
    out.push('');
    out.push(mdTable(['category', 'always', 'on use', 'items'],
      t.categories.map((c) => [c.key, fmtInt(c.always) + (c.unknown ? ` +${c.unknown}?` : ''), fmtInt(c.onDemand), c.items]), ['l', 'r', 'r', 'r']));
    if (t.sources.length > 1) {
      out.push('');
      out.push('### By source');
      out.push('');
      out.push(mdTable(['source', 'always', 'on use', 'items'],
        t.sources.map((c) => [c.key, fmtInt(c.always) + (c.unknown ? ` +${c.unknown}?` : ''), fmtInt(c.onDemand), c.items]), ['l', 'r', 'r', 'r']));
    }
    const tops = topItems(t, top, all);
    if (tops.length) {
      out.push('');
      out.push(`### ${all ? 'Always-loaded items' : `Top ${tops.length} always-loaded items`}`);
      out.push('');
      out.push(mdTable(['#', 'tokens', 'category', 'name', 'source', 'how to remove'],
        tops.map((i, n) => [n + 1, i.always == null ? '?' : fmtInt(i.always), i.category, `\`${i.name}\``, i.source, i.remove || '']), ['r', 'r', 'l', 'l', 'l', 'l']));
    }
    if (t.findings.length) {
      out.push('');
      out.push('### Findings');
      out.push('');
      for (const f of t.findings) out.push(`- **${KIND_LABEL[f.kind] || f.kind}:** ${f.message}${f.fix ? `. Fix: ${f.fix}` : ''}`);
    }
  }
  if (report.notes.length) { out.push(''); for (const n of report.notes) out.push(`> ${n}`); }
  return out.join('\n') + '\n';
}
