# CLAUDE.md

Claude Code wrapper for the vayada monorepo.

**The canonical agent guide is [`AGENTS.md`](AGENTS.md) — read it first.** It covers app map, per-stack commands, validation expectations, shipping conventions, Linear workflow, deployment, and gotchas. This file only holds Claude-specific behavior that doesn't apply to other agents.

## Claude-specific notes

- **Skills.** Project skills live at `.agents/skills/<name>/SKILL.md`. They are shared with Codex and any other agent rather than duplicated per tool. The bootstrap skill at `.agents/skills/vayada-skills-storage/SKILL.md` documents where new skills go.
- **Deferred tools.** Many MCP/built-in tools are deferred and not present in the initial tool list. Before claiming a tool is missing, check the deferred-tools system-reminder and load it via `ToolSearch`.

## Linear

This project uses the **Vayada** Linear workspace (team key: VAY).

- Use `mcp__linear__*` tools for all Linear operations in this repo
