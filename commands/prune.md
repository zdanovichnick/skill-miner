---
description: Find skill-miner-generated skills that have never been invoked since install and move the ones you pick out of ~/.claude/skills
argument-hint: "[--grace-days 14] [--grace-sessions 10]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, AskUserQuestion
---

# /skill-miner:prune

A generated skill that never triggers only costs context. Find those, and remove the ones the
person picks. Nothing is removed without their pick, and nothing is deleted: a pruned skill moves
to `~/.claude/skill-miner/pruned/<date>/<name>/`, where it can be moved back.

## 1. Measure

Run once: `node "${CLAUDE_PLUGIN_ROOT}/scripts/prune.js" $ARGUMENTS`

It prints the run directory (default `~/.claude/skill-miner/runs/<date>/`). Read `prune.md` there. One
row per generated skill (listed in `installed.json`, or carrying the `PROVENANCE.md` that
`/skill-miner:accept` writes beside it), with the sessions since it was installed, how often a
`Skill` tool call or a typed `/<name>` invoked it, and a status:

| Status | Meaning |
|---|---|
| never triggered | Installed longer than the grace period, in days and in sessions, and never invoked — a prune candidate |
| too new to tell | Inside the grace period; leave it |
| in use | Invoked at least once since install; leave it |
| folder gone | Listed in the ledger but no longer under `~/.claude/skills`; `--remove` tidies the ledger |

Only `Skill` tool calls and `<command-name>` tags are read from the transcripts; prompt text is not.

## 2. Ask

No candidates → say so, name any "too new" skills with their install dates, and stop.

Otherwise one question with `multiSelect: true`, an option per candidate: label = the skill name,
description = its `description` from the report plus "installed <date>, <n> sessions since". Ask
which to remove. The default is to keep: do not pre-select, and say that a skill can be kept now
and asked about again on the next run.

## 3. Remove

For the picked names, run once:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/prune.js" --remove <name>[,<name>...]`

It moves each folder to `~/.claude/skill-miner/pruned/<date>/<name>/`, sets `prunedAt` on its
`installed.json` entry, and appends `{decision: "pruned"}` to `decisions.json`, so
`/skill-miner:mine` does not propose it again.

Report each move with its new path, and that the skill unloads at the next session (or after
`/reload-plugins`). Finish with: pruned N of M candidates.
