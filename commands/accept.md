---
description: Install approved /skill-miner:mine proposals — skills into ~/.claude/skills, memories and CLAUDE.md lines into their target files
argument-hint: "<proposal-name> [<proposal-name> ...]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, AskUserQuestion
---

# /skill-miner:accept

Install each proposal named in `$ARGUMENTS`. With no names, read the newest
`~/.claude/skill-miner/proposals/*/INDEX.md` and ask which to install.

For each name, locate `~/.claude/skill-miner/proposals/<run-date>/<name>/` (newest run wins) and read
its files before writing anything.

## Skill

1. If `~/.claude/skills/<name>/` already exists, do not overwrite it: ask whether to replace it,
   install under another name, or skip.
2. Read `~/.claude/skill-miner/installed.json` (`{"installed": []}` when absent). If 8 or more entries
   have `target: "skill"` without `prunedAt`, say so and suggest `/skill-miner:prune` before
   adding — generated skills that never trigger only cost context.
3. Copy `SKILL.md` (and any `references/`) to `~/.claude/skills/<name>/`, and `PROVENANCE.md`
   beside it. Do not add provenance to `SKILL.md`.

## Memory, claude-md, conflict

`PROPOSAL.md` names the target file and the text. Re-read the target first; if it already says
the same thing, skip it, and if it contradicts it, show both and ask. Otherwise add the text
with Edit (or Write for a new memory file plus its one-line pointer in that store's
`MEMORY.md`).

## Record

Append `{name, target, path, runDate, installedAt}` to `~/.claude/skill-miner/installed.json`, and set
the proposal's entry in `~/.claude/skill-miner/decisions.json` to `installed`.

Report each installed path. A new skill loads in the next session (or after `/reload-plugins`).
