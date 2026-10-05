---
name: context-cost
description: Audit what loads into the context window before the user types anything (CLAUDE.md files, skills, subagents, plugins, hooks, MCP tool schemas), rank it by token cost, flag duplicates, and give removal steps. Use when the user asks what is using their context, why sessions start heavy, or which plugins, skills or MCP servers to remove.
---

# context-cost

Run the auditor from the project the user is working in:

```bash
npx -y agent-context-cost --json
```

Add `--tool all` if they also use Cursor, Codex or Gemini CLI. Each agent has
its own context window, so report each one separately and never add their
totals together.

## Rules

- **It is read-only and stays that way.** The report prints removal commands
  and edits. Do not run any of them, or edit settings, until the user picks
  which items to remove and says go.
- **Never add `--probe-mcp` on your own.** It launches every configured local
  MCP server command. Offer it, explain that, and run it only if the user
  agrees. It asks for confirmation and refuses without a terminal; never add
  `--yes` unless the user has seen the command list and said yes.
  `--probe-only <name>` limits it to named servers, and is the only way to
  measure servers defined in the project's own `.mcp.json`.
- **The numbers are estimates** (about 4 characters per token for prose, 3 for
  JSON). Say "about". For the real figure in a live session, the user can run
  `/context`.
- Do not paste file contents back to the user. The report holds only names,
  sizes and paths, and your summary should too.

## Report

1. One line per agent: always-loaded tokens, on-demand tokens, and what was
   not measured (MCP servers without `--probe-mcp`, hooks that print into
   context).
2. The five biggest always-loaded items with their source (user, project,
   local, or which plugin).
3. Duplicates and overlaps, then unused or truncated items.
4. For each item the user wants gone, the exact command or edit from the
   report's `remove` field.

Keep the distinction clear: "always" is paid by every session; "on use" is
paid only when a skill, subagent or tool is actually invoked.
