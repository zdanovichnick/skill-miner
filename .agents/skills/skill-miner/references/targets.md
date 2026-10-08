# Where each tool keeps things

Read this when installing a proposal, listing existing skills, or setting up the live hook.

## Skills

| Tool | Folders it reads |
|---|---|
| Codex | `.agents/skills` in the project and its parents, `~/.agents/skills`, `/etc/codex/skills` |
| Cursor | `.agents/skills`, `.cursor/skills`, `~/.agents/skills`, `~/.cursor/skills`, and for compatibility `.claude/skills` and `.codex/skills` |
| Claude Code | `~/.claude/skills`, `.claude/skills`, plugin skills |

`install.js skill --target agents|cursor|claude` writes to the user-level folder of that row.
Codex and Cursor read only `name` and `description` from the frontmatter, so a proposal for them
carries nothing else. A Codex user invokes a skill with `$name`, a Cursor user with `/name`.

## Rules and memory

| Tool | Where a rule goes |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` (all projects), the project's `CLAUDE.md`, or the memory store named in the proposal |
| Codex | `~/.codex/AGENTS.md` (all projects) or the project's `AGENTS.md`. If `~/.codex/AGENTS.override.md` exists and is not empty, Codex reads it first: say so and ask which file to edit. Codex reads at most 32 KiB of these files |
| Cursor | the project's `AGENTS.md`, or `.cursor/rules/<name>.mdc` with frontmatter `description`, `globs` and `alwaysApply: true` for a rule that applies to every chat. Cursor's user rules live only in the app (Customize, Rules) and have no file: print the text and ask the person to paste it there |

## Live hook (optional)

The hook only records what the person typed; it never blocks, rewrites or delays a prompt.

```
node <scripts>/install.js hooks --tool cursor            # prints what ~/.cursor/hooks.json would become
node <scripts>/install.js hooks --tool cursor --apply    # writes it, keeping a .skill-miner.bak copy
node <scripts>/install.js hooks --tool codex  --apply    # same for ~/.codex/hooks.json
```

- If the skill was installed with `install.js self`, pass `--script <installed scripts>/live-hook.js`
  so the hook points at the installed copy, not at a clone.
- Codex runs a new hook only after it is reviewed and trusted: open `/hooks` in Codex once.
- On the second identical correction the Codex hook returns a one-line `systemMessage`. Cursor has no field for a
  notice on a prompt that goes through, so there a repeat is only recorded; it appears in the next
  `mine` run, or run `mine --live` to see it now.
- `node <scripts>/live-hook.js --clear [--tool cursor|codex]` forgets what it recorded.
