<p align="center">
  <img src="assets/banner.svg" alt="skill-miner: turn how you actually use Claude Code into skills and memories" width="100%">
</p>

<p align="center">
  <a href="https://github.com/zdanovichnick/skill-miner/releases/tag/v0.2.0"><img alt="version" src="https://img.shields.io/badge/version-0.2.0-6366f1"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2018-339933">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-none-22c55e">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/zdanovichnick/skill-miner"></a>
</p>

**skill-miner** reads your own Claude Code transcripts, finds what you keep correcting and keep
repeating, and proposes skills and memories for it. You review every proposal. Nothing is
installed that you didn't pick.

It also runs **live**: a hooks module watches what you type, counts corrections on the status
line, and raises a toast the second time you correct the same thing, in any project, on any day.
`/corrections` shows the list; `/skill-miner:mine` turns repeats into proposals.

<p align="center">
  <img src="assets/live-mode.svg" alt="Live mode: a typed correction is counted, a repeat raises a toast, /corrections lists repeats first" width="100%">
</p>

> Illustration. Names and numbers are made up.

## Install

```
/plugin marketplace add zdanovichnick/skill-miner
/plugin install skill-miner@skill-miner-marketplace
```

## Use

| Command | What it does |
|---|---|
| `/skill-miner:mine [--days 30] [--min-sessions 3]` | Mines `~/.claude/projects/**/*.jsonl`, drafts up to 10 proposals under `~/.claude/skill-miner/proposals/<date>/`, asks which to keep |
| `/skill-miner:accept <name>...` | Installs kept proposals: skills into `~/.claude/skills/<name>/`, memories and CLAUDE.md lines into their target file |
| `/corrections [clear]` | Lists the corrections the live mod noticed as you typed them, repeats first; `clear` forgets them |

<p align="center">
  <img src="assets/example-session.svg" alt="Example session: mine, pick proposals, accept" width="100%">
</p>

> The session above is an illustration. Names and numbers are made up.

## How it works

<p align="center">
  <img src="assets/workflow.svg" alt="Transcripts, mine.js, candidates, classify and draft, you pick, accept" width="100%">
</p>

`scripts/mine.js` (Node ≥ 18, no dependencies) reads the transcripts offline and writes
`~/.claude/skill-miner/runs/<date>/report.md` and `candidates.json`:

- **Corrections**: prompts that open with or contain a correction ("don't use…", "instead of…",
  "I said…"), plus the prompt you typed right after interrupting a turn.
- **Repeated long instructions**: the same 160+ character instruction typed in 2+ sessions.
- **Tool sequences and shell recipes**: 3–5 tool n-grams and build/deploy commands seen in 3+
  sessions, with the edit→build→test loop every session has filtered out.
- **Prompt openings, slash-command use**, and up to 80 recent long instructions that the
  command clusters by intent.

### Live mode

`hooks/register.ts` is a Claude Code hooks module that runs in every session once the plugin is
installed. It watches each prompt you type (`prompt.submit`) with the same correction patterns
`mine.js` uses, plus the prompt right after you interrupt a turn, and keeps what it finds in the
plugin's own store (local, capped at 500 entries, ≤ 300 characters each):

- The status line under the prompt counts corrections noticed this session.
- When the same correction (case and punctuation folded) shows up a second time, in this or an
  earlier session, a toast says so and points at `/corrections` and `/skill-miner:mine`.
- `/corrections` lists repeats first, then the most recent entries; `/corrections clear` forgets them.

It records nothing from slash commands, pasted logs, task notifications, peer-session messages
or subagent turns, and it never changes or drops the prompt: every hook calls `next(e)`.

### Where a candidate ends up

The command classifies each candidate, checks it against the skills you already have, and
gives it exactly one destination.

<p align="center">
  <img src="assets/classification.svg" alt="Candidates become a skill, memory, CLAUDE.md line, conflict note, or are dropped" width="100%">
</p>

## Trust boundary

<p align="center">
  <img src="assets/trust-boundary.svg" alt="Only typed prompts are counted; tool output, subagent transcripts, pasted blocks and system context are stripped" width="100%">
</p>

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
| plugin store, key `corrections` | What the live mod noticed: text (≤ 300 chars), why, project folder name, session id, time |

## Roadmap

- [ ] Prune generated skills that never trigger
- [x] A live mod that notices corrections as they happen (`/corrections`, v0.2.0)
- [ ] Feed the live mod's repeats into `/skill-miner:mine` as candidates, so a rule can be
      proposed the moment it repeats rather than on the next mining run

## License

See [LICENSE](LICENSE).
