# skill-miner

Proposes skills and memories from how you actually use Claude Code, then installs only the
ones you approve.

```
/plugin marketplace add zdanovichnick/skill-miner
/plugin install skill-miner@skill-miner-marketplace
```

| Command | What it does |
|---|---|
| `/skill-miner:mine [--days 30] [--min-sessions 3]` | Mines `~/.claude/projects/**/*.jsonl`, drafts up to 10 proposals under `~/.claude/skill-miner/proposals/<date>/`, asks which to keep |
| `/skill-miner:accept <name>...` | Installs kept proposals: skills into `~/.claude/skills/<name>/`, memories and CLAUDE.md lines into their target file |

## How it works

`scripts/mine.js` (Node ≥ 18, no dependencies) reads the transcripts offline and writes
`~/.claude/skill-miner/runs/<date>/report.md` and `candidates.json`:

- **Corrections**: prompts that open with or contain a correction ("don't use…", "instead of…",
  "I said…"), plus the prompt you typed right after interrupting a turn.
- **Repeated long instructions**: the same 160+ character instruction typed in 2+ sessions.
- **Tool sequences and shell recipes**: 3–5 tool n-grams and build/deploy commands seen in 3+
  sessions, with the edit→build→test loop every session has filtered out.
- **Prompt openings, slash-command use**, and up to 80 recent long instructions that the
  command clusters by intent.

The command then classifies each candidate as a skill, a memory, a CLAUDE.md line, a conflict
with an existing skill, or noise, and checks it against the skills you already have.

## Trust boundary

Only prompts you typed are mined. Tool output, subagent transcripts, pasted blocks, system
reminders, harness context and peer-session messages are all stripped before anything is
counted. Instructions planted in those would otherwise become standing skills. Proposals
restate your rules without URLs, hosts, accounts or secrets, and nothing reaches
`~/.claude/skills` without your pick.

## State

| File | Holds |
|---|---|
| `~/.claude/skill-miner/runs/<date>/` | Raw miner output: local, contains your prompt text |
| `~/.claude/skill-miner/proposals/<date>/` | Drafts plus `PROVENANCE.md` and `INDEX.md` |
| `~/.claude/skill-miner/decisions.json` | Kept/dropped/installed per proposal; dropped ones are not proposed again |
| `~/.claude/skill-miner/installed.json` | What was installed where; `accept` warns past 8 generated skills |

Not built yet: pruning generated skills that never trigger, and a live mod that notices
corrections as they happen. The second waits on whether `/skill-miner:mine` finds enough worth
keeping.
