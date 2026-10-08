---
description: Install approved /skill-miner:mine proposals — skills into ~/.claude/skills (or the Codex and Cursor folders), memories and CLAUDE.md lines into their target files
argument-hint: "<proposal-name> [<proposal-name> ...] [--target claude|agents|cursor]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, AskUserQuestion
---

# /skill-miner:accept

Install each proposal named in `$ARGUMENTS`. With no names, read the newest
`~/.claude/skill-miner/proposals/*/INDEX.md` and ask which to install.

For each name, locate `~/.claude/skill-miner/proposals/<run-date>/<name>/` (newest run wins) and read
its files before writing anything.

## Skill

`--target` picks the folder, and so which tool loads the skill:

| Target | Folder | Loaded by |
|---|---|---|
| `claude` (default) | `~/.claude/skills` | Claude Code, Cursor |
| `agents` | `~/.agents/skills` | Codex, Cursor |
| `cursor` | `~/.cursor/skills` | Cursor |

Default to `claude`. When `PROVENANCE.md` shows the evidence came from Codex or Cursor sessions
only, or the person asks, use `agents` or `cursor` instead.

Run once:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/install.js" skill --from ~/.claude/skill-miner/proposals/<run-date>/<name> --target <target>`

It validates the frontmatter and the folder name, copies `SKILL.md`, `references/` and
`PROVENANCE.md`, and records the install in `installed.json` and `decisions.json`. If it refuses
because the folder exists, show its message and ask whether to replace it (`--replace`: the old
folder is moved to `~/.claude/skill-miner/replaced/<date>/`, not deleted), install under another
name (`--as <name>`), or skip. Pass on any `note:` it prints, in particular the one suggesting
`/skill-miner:prune` once 8 or more generated skills are installed for a target.

## Memory, claude-md, conflict

`PROPOSAL.md` names the target file and the text. Re-read the target first; if it already says
the same thing, skip it, and if it contradicts it, show both and ask. Otherwise add the text
with Edit (or Write for a new memory file plus its one-line pointer in that store's
`MEMORY.md`).

For Codex or Cursor rules the target is `AGENTS.md` or `.cursor/rules/*.mdc`; Cursor's user rules
live only in the app, so print the text and ask the person to paste it into Customize, Rules.

## Record

The installer records skills itself. For the other targets append
`{name, target, path, runDate, installedAt}` to `~/.claude/skill-miner/installed.json` and set the
proposal's entry in `~/.claude/skill-miner/decisions.json` to `installed`.

Report each installed path. A new skill loads in the next session (or after `/reload-plugins`).
