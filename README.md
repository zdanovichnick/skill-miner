<p align="center">
  <img src="assets/banner.svg" alt="skill-miner: turn how you actually use Claude Code into skills and memories" width="100%">
</p>

<p align="center">
  <a href="https://github.com/zdanovichnick/skill-miner/releases/tag/v0.4.0"><img alt="version" src="https://img.shields.io/badge/version-0.4.0-6366f1"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2018-339933">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-none-22c55e">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/zdanovichnick/skill-miner"></a>
</p>

**skill-miner** reads your own Claude Code transcripts, finds what you keep correcting and keep
repeating, and proposes skills and memories for it. You review every proposal. Nothing is
installed that you didn't pick.

It also runs **live**: a hooks module watches what you type, counts corrections on the status
line, and raises a toast the second time you correct the same thing, in any project, on any day.
`/corrections` shows the list; `/skill-miner:mine --live` proposes a rule for the repeats right
then, without waiting for the next full mining run.

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
| `/skill-miner:mine --live` | Skips the transcript scan and proposes rules for the live mod's repeats alone — the quick pass after a toast |
| `/skill-miner:accept <name>...` | Installs kept proposals: skills into `~/.claude/skills/<name>/`, memories and CLAUDE.md lines into their target file |
| `/corrections [clear]` | Lists the corrections the live mod noticed as you typed them, repeats first; `clear` forgets them |
| `/skill-miner:prune [--grace-days 14] [--grace-sessions 10]` | Finds generated skills never invoked since install and moves the ones you pick to `~/.claude/skill-miner/pruned/<date>/` |

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
  earlier session, the mod writes the grouped repeats to `~/.claude/skill-miner/live/repeats.json`
  and a toast points at `/skill-miner:mine --live`, which reads that file and proposes a rule
  without scanning transcripts. A full run reads it too, as the report's first section.
- Once a repeat has been kept or dropped, the command records its key in `live/handled.json`;
  the mod stops toasting for it and leaves it out of the next `repeats.json`.
- `/corrections` lists repeats first, then the most recent entries; `/corrections clear` forgets them.

It records nothing from slash commands, pasted logs, task notifications, peer-session messages
or subagent turns, and it never changes or drops the prompt: every hook calls `next(e)`.

### Pruning what never triggers

Every generated skill costs context on every turn, used or not. `scripts/prune.js` reads
`installed.json` (and any skill folder carrying the `PROVENANCE.md` that `accept` leaves beside
it), then counts, in the transcripts since each install, the `Skill` tool calls naming it and the
times you typed `/<name>`. Nothing else in a transcript is read.

<p align="center">
  <img src="assets/prune.svg" alt="Prune: generated skills listed with sessions since install and triggers; one never triggered is offered for removal" width="100%">
</p>

> Illustration. Names and numbers are made up.

- **never triggered**: older than the grace period, in days and in sessions, with no invocation.
  These are offered for removal; nothing is pre-selected.
- **too new to tell**: inside the grace period. Left alone.
- **in use**: invoked at least once since install. Left alone.
- A removed skill is moved to `~/.claude/skill-miner/pruned/<date>/<name>/`, not deleted; move it
  back to undo. Its `installed.json` entry gets `prunedAt`, and a `pruned` decision keeps
  `/skill-miner:mine` from proposing it again.

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
| `~/.claude/skill-miner/installed.json` | What was installed where, with `prunedAt` once pruned; `accept` points at `prune` past 8 generated skills |
| `~/.claude/skill-miner/pruned/<date>/<name>/` | Skills `prune` moved out of `~/.claude/skills`; move one back to undo |
| `~/.claude/skill-miner/runs/<date>/prune.md` | The use-since-install table `prune` reports from |
| plugin store, key `corrections` | What the live mod noticed: text (≤ 300 chars), why, project folder name, session id, time |
| `~/.claude/skill-miner/live/repeats.json` | Corrections typed 2+ times, grouped, with up to three quotes each; written by the mod, read by `mine.js` |
| `~/.claude/skill-miner/live/handled.json` | Repeat keys already kept or dropped; written by `/skill-miner:mine`, read by the mod |

## Roadmap

- [x] Prune generated skills that never trigger (`/skill-miner:prune`, v0.4.0)
- [x] A live mod that notices corrections as they happen (`/corrections`, v0.2.0)
- [x] Feed the live mod's repeats into `/skill-miner:mine` as candidates, so a rule can be
      proposed the moment it repeats rather than on the next mining run (`--live`, v0.3.0)

## License

See [LICENSE](LICENSE).
