#!/usr/bin/env node
// Mines coding-assistant transcripts (Claude Code, Codex, Cursor) for recurring work patterns and
// writes ranked candidates.
//
// Reads only what the person typed and the *shape* of the tool calls that ran (tool name,
// command head, file extension). Tool output, pasted blocks, injected context and system reminders
// are never read into a candidate: a skill drafted from them would carry injected text into every
// future session. Each tool's transcript format is read by its own reader in lib/sources.js.
//
// Usage: node mine.js [--days 30] [--out <dir>] [--min-sessions 3]
//                     [--source auto|all|claude,codex,cursor]
//                     [--root ~/.claude/projects] [--codex-root ~/.codex] [--cursor-root ~/.cursor/projects]
//                     [--live] [--live-dir ~/.claude/skill-miner/live]
//
// --source auto (the default) reads every tool whose transcript folder exists.
//
// The live hooks write <live-dir>/repeats.json (Claude) and repeats.<tool>.json (Codex, Cursor): corrections typed more than once,
// already grouped. They join the report as its first section; --live skips the transcript scan
// and reports them alone, for a run right after a live notice.

'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./lib/text');
const { resolve, CAN_ZSTD } = require('./lib/sources');

const args = T.parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 30);
const MIN_SESSIONS = Number(args['min-sessions'] ?? 3);
const OUT = T.expandHome(args.out ?? path.join('~/.claude/skill-miner/runs', new Date().toISOString().slice(0, 10)));
const LIVE_DIR = T.expandHome(args['live-dir'] ?? '~/.claude/skill-miner/live');
const LIVE_ONLY = args.live === 'true';
const { CORRECTION_START, CORRECTION_ANYWHERE } = T;

const ACTION = /^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Skill|Agent|Workflow|mcp):?/;
// Tokens every coding session produces; a sequence made only of these is habit, not a workflow.
const GENERIC =
  /^(Read|Edit|Write|MultiEdit|Grep|Glob|ToolSearch|ExitPlanMode|EnterPlanMode|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TodoWrite|(Bash|PowerShell):(sed|grep|cat|head|tail|ls|find|wc|python|python3|node|rg|awk|sort|diff|xargs|git (status|diff|log|show)|dotnet (build|test|restore)|(npm|pnpm|yarn)( run)? (build|test|lint)|pytest|make (test|build|lint))\b.*)(:|$)/;
// Shell heads that say how a project is built, tested or shipped: the recipes worth keeping.
const RECIPE_HEAD =
  /^(cd \S+ && )?(dotnet|npm|pnpm|yarn|npx|make|uv|poetry|pytest|terraform|tf-run|aws|docker|docker-compose|bk|gh|kubectl|helm|mvn|\.\/mvnw|gradle|cargo|go|claude|az|flyway)\b/;

// True when more than one tool was read; only then do candidates say which tool they came from.
let MULTI = false;

main().catch(e => {
  console.error(`[skill-miner] ${e.stack || e}`);
  process.exit(1);
});

async function main() {
  const since = Date.now() - DAYS * 86_400_000;
  const picks = LIVE_ONLY ? [] : resolve(args.source ?? 'auto', args);
  MULTI = picks.length > 1;

  const sessions = [];
  const sources = [];
  for (const pick of picks) {
    const stat = { id: pick.id, root: pick.root, files: 0, sessions: 0, skipped: {} };
    sources.push(stat);
    if (!pick.present) {
      console.error(`[skill-miner] ${pick.source.label}: ${pick.root} not found`);
      continue;
    }
    for (const entry of pick.source.discover(pick.root, since)) {
      stat.files++;
      if (entry.compressed && !CAN_ZSTD) {
        skip(stat, 'compressed');
        continue;
      }
      let s;
      try {
        s = await pick.source.parse(entry);
      } catch {
        skip(stat, 'unreadable');
        continue;
      }
      if (s.skip) {
        skip(stat, s.skip);
        continue;
      }
      if (s.prompts.length > 0 || s.tools.length > 0) {
        sessions.push(s);
        stat.sessions++;
      }
    }
  }
  const files = sources.reduce((n, x) => n + x.files, 0);

  const result = {
    generatedAt: new Date().toISOString(),
    window: { days: DAYS, files, sessions: sessions.length, minSessions: MIN_SESSIONS, liveOnly: LIVE_ONLY, sources },
    liveRepeats: readLiveRepeats(),
    toolSequences: mineSequences(sessions),
    shellRecipes: mineShell(sessions),
    promptOpenings: minePrompts(sessions),
    repeatedInstructions: mineRepeatedText(sessions),
    slashCommands: mineSlash(sessions),
    longInstructions: collectLongInstructions(sessions),
    corrections: collectCorrections(sessions),
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, 'report.md'), renderReport(result));
  console.log(`[skill-miner] ${sessions.length} sessions from ${files} files (${DAYS}d) -> ${OUT}`);
  for (const x of sources) {
    if (MULTI || Object.keys(x.skipped).length > 0) console.log(`[skill-miner]   ${x.id}: ${describeSource(x)}`);
  }
  if (sources.some(x => x.skipped.compressed) && !CAN_ZSTD) {
    console.log(`[skill-miner]   compressed Codex sessions need Node 22.15 or newer to read; this is ${process.version}`);
  }
  console.log(
    `[skill-miner] live repeats ${result.liveRepeats.length}, sequences ${result.toolSequences.length}, shell ${result.shellRecipes.length}, ` +
      `openings ${result.promptOpenings.length}, repeated ${result.repeatedInstructions.length}, corrections ${result.corrections.length}`,
  );
}

function skip(stat, why) {
  stat.skipped[why] = (stat.skipped[why] ?? 0) + 1;
}

function describeSource(x) {
  const skipped = Object.entries(x.skipped).map(([why, n]) => `${n} ${why}`);
  return `${x.sessions} sessions from ${x.files} files${skipped.length > 0 ? `, skipped ${skipped.join(', ')}` : ''}`;
}

// What the live hooks grouped already: each entry a correction typed 2+ times, with up to three
// quotes of the person's words. Claude's mod writes repeats.json, the Codex and Cursor hooks write
// repeats.<tool>.json; the same correction in two tools merges into one entry. Keys already decided
// on (handled.json) are left out. Absent or unreadable, there are none.
function readLiveRepeats() {
  const day = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
  let names = [];
  try {
    names = fs.readdirSync(LIVE_DIR).filter(n => n === 'repeats.json' || /^repeats\.[a-z]+\.json$/.test(n)).sort();
  } catch {
    return [];
  }
  const handledKeys = T.readJson(path.join(LIVE_DIR, 'handled.json'), null)?.keys;
  const handled = new Set(Array.isArray(handledKeys) ? handledKeys : []);
  const merged = new Map();
  for (const name of names) {
    const parsed = T.readJson(path.join(LIVE_DIR, name), null);
    for (const r of Array.isArray(parsed?.repeats) ? parsed.repeats : []) {
      if (typeof r?.key !== 'string' || !Array.isArray(r.quotes) || handled.has(r.key)) continue;
      const quotes = r.quotes.filter(q => typeof q === 'string').map(q => q.slice(0, 300));
      const projects = Array.isArray(r.projects) ? r.projects.filter(p => typeof p === 'string') : [];
      const seen = merged.get(r.key);
      if (!seen) {
        merged.set(r.key, {
          key: r.key,
          count: Number(r.count) || quotes.length,
          sessions: Number(r.sessions) || 1,
          projectNames: projects,
          first: Number(r.firstSeen),
          last: Number(r.lastSeen),
          quotes,
        });
        continue;
      }
      seen.count += Number(r.count) || quotes.length;
      seen.sessions += Number(r.sessions) || 1;
      seen.projectNames = [...new Set([...seen.projectNames, ...projects])];
      seen.first = Math.min(seen.first, Number(r.firstSeen));
      seen.last = Math.max(seen.last, Number(r.lastSeen));
      seen.quotes = [...new Set([...seen.quotes, ...quotes])];
    }
  }
  return [...merged.values()]
    .map(r => ({
      key: r.key,
      count: r.count,
      sessions: r.sessions,
      projects: Math.max(r.projectNames.length, 1),
      projectNames: r.projectNames.slice(0, 6),
      firstSeen: day(r.first),
      lastSeen: day(r.last),
      quotes: r.quotes.slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count);
}

function mineSequences(sessions) {
  const grams = new Map();
  for (const s of sessions) {
    const seen = new Set();
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i + n <= s.tools.length; i++) {
        const gram = s.tools.slice(i, i + n);
        if (!gram.some(t => ACTION.test(t)) || gram.every(t => GENERIC.test(t))) continue;
        if (new Set(gram).size < 2) continue;
        const key = gram.join(' → ');
        if (seen.has(key)) continue;
        seen.add(key);
        bump(grams, key, s, { n });
      }
    }
  }
  const ranked = finalize(grams).filter(g => g.sessions >= MIN_SESSIONS);
  // A gram whose every occurrence sits inside a longer, equally frequent gram adds nothing.
  const kept = ranked.filter(g => !ranked.some(o => o.n > g.n && o.sessions >= g.sessions && o.key.includes(g.key)));
  return kept
    .map(g => ({ ...g, score: round(g.sessions * Math.log2(g.n + 1) * (1 + 0.5 * (g.projects - 1))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
}

function mineShell(sessions) {
  const m = new Map();
  for (const s of sessions) for (const cmd of new Set(s.shell)) bump(m, cmd, s);
  return finalize(m)
    .filter(g => g.sessions >= MIN_SESSIONS && RECIPE_HEAD.test(g.key))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 40);
}

function minePrompts(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const seen = new Set();
    for (const p of s.prompts) {
      if (p.slash || p.isLog || p.text.length < 12) continue;
      const key = p.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
      if (key.split(' ').length < 3 || seen.has(key)) continue;
      seen.add(key);
      bump(m, key, s, { example: p.text.slice(0, 240) });
    }
  }
  return finalize(m).filter(g => g.sessions >= MIN_SESSIONS).sort((a, b) => b.sessions - a.sessions).slice(0, 40);
}

// Long instructions typed (or retyped) in several sessions are the strongest skill signal:
// the person is carrying a procedure by hand.
function mineRepeatedText(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const seen = new Set();
    for (const p of s.prompts) {
      if (p.isLog || p.text.length < 160) continue;
      const key = p.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      bump(m, key, s, { example: p.text.slice(0, 600) });
    }
  }
  return finalize(m).filter(g => g.sessions >= 2).sort((a, b) => b.sessions - a.sessions).slice(0, 20);
}

function mineSlash(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const seen = new Set();
    for (const p of s.prompts) {
      if (!p.slash || seen.has(p.slash)) continue;
      seen.add(p.slash);
      bump(m, p.slash, s, { example: p.text.slice(0, 160) });
    }
  }
  return finalize(m).sort((a, b) => b.sessions - a.sessions).slice(0, 40);
}

function collectCorrections(sessions) {
  const out = [];
  for (const s of sessions) {
    for (const p of s.prompts) {
      if (p.slash || p.isLog) continue;
      const why = p.afterInterrupt
        ? 'after-interrupt'
        : CORRECTION_START.test(p.text)
          ? 'opening'
          : CORRECTION_ANYWHERE.test(p.text)
            ? 'phrase'
            : null;
      if (!why) continue;
      out.push({ text: p.text.slice(0, 300), why, session: s.id, project: s.project, at: p.at, ...(MULTI ? { tool: s.source } : {}) });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 150);
}

// Exact-prefix repeats miss reworded instructions; these go to the model to cluster by intent.
function collectLongInstructions(sessions) {
  const out = [];
  const seen = new Set();
  for (const s of sessions) {
    for (const p of s.prompts) {
      if (p.slash || p.isLog || p.text.length < 200) continue;
      const key = p.text.toLowerCase().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: p.text.slice(0, 500), session: s.id, project: s.project, at: p.at, ...(MULTI ? { tool: s.source } : {}) });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
}

function bump(map, key, s, extra = {}) {
  let e = map.get(key);
  if (!e) map.set(key, (e = { key, ...extra, sessionIds: new Set(), projectIds: new Set(), sourceIds: new Set(), lastSeen: null }));
  e.sessionIds.add(s.id);
  e.projectIds.add(s.project);
  e.sourceIds.add(s.source);
  if (s.date && (!e.lastSeen || s.date > e.lastSeen)) e.lastSeen = s.date;
}

function finalize(map) {
  return [...map.values()].map(({ sessionIds, projectIds, sourceIds, ...rest }) => ({
    ...rest,
    ...(MULTI ? { tools: [...sourceIds] } : {}),
    sessions: sessionIds.size,
    projects: projectIds.size,
    projectNames: [...projectIds].slice(0, 6),
    sampleSessions: [...sessionIds].slice(0, 4),
  }));
}

function renderReport(r) {
  const lines = [
    `# Work-pattern candidates`,
    ``,
    r.window.liveOnly
      ? `Live run: transcripts not scanned, generated ${r.generatedAt}.`
      : `${r.window.sessions} sessions, last ${r.window.days} days, generated ${r.generatedAt}. Threshold: ${r.window.minSessions}+ sessions.`,
    ``,
    ...(r.window.sources.length > 1 || r.window.sources.some(x => Object.keys(x.skipped).length > 0)
      ? [`Sources: ${r.window.sources.map(x => `${x.id} (${describeSource(x)})`).join('; ')}.`, ``]
      : []),
    `Evidence is limited to typed prompts and tool-call shapes; tool output never enters a candidate.`,
    ``,
    `## Live repeats (${r.liveRepeats.length})`,
    ``,
    `Corrections typed more than once, grouped by the live mod as they happened. A repeat is a candidate on its own, whatever the session threshold; its key goes to live/handled.json once decided; the Claude mod and the Codex and Cursor hooks all feed it.`,
    ``,
  ];
  if (r.liveRepeats.length === 0) lines.push(`_none_`, ``);
  for (const l of r.liveRepeats) {
    lines.push(`- **${l.count}×** in ${l.sessions} session(s), ${l.projectNames.join(', ')} (${l.firstSeen} → ${l.lastSeen}) — key \`${cell(l.key)}\``);
    for (const q of l.quotes) lines.push(`  - "${cell(q)}"`);
  }
  lines.push(``);
  const table = (title, rows, cols) => {
    lines.push(`## ${title} (${rows.length})`, ``);
    if (rows.length === 0) return lines.push(`_none_`, ``);
    lines.push(`| ${cols.map(c => c[0]).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
    for (const row of rows) lines.push(`| ${cols.map(c => cell(c[1](row))).join(' | ')} |`);
    lines.push(``);
  };
  const common = [
    ['sessions', x => x.sessions],
    ['projects', x => x.projects],
    ['last', x => x.lastSeen ?? ''],
    ...(r.window.sources.length > 1 ? [['tools', x => (x.tools ?? []).join(', ')]] : []),
  ];
  table('Repeated long instructions', r.repeatedInstructions, [['instruction', x => x.example], ...common]);
  table('Tool sequences', r.toolSequences, [['sequence', x => x.key], ['score', x => x.score], ...common]);
  table('Shell recipes', r.shellRecipes, [['command', x => '`' + x.key + '`'], ...common]);
  table('Prompt openings', r.promptOpenings, [['opening', x => x.key], ['example', x => x.example], ...common]);
  const multi = r.window.sources.length > 1;
  table(multi ? 'Slash commands and skill mentions' : 'Slash commands used', r.slashCommands, [['command', x => (multi ? x.key : '/' + x.key)], ...common]);
  lines.push(`## Corrections (${r.corrections.length}, newest first)`, ``);
  for (const c of r.corrections.slice(0, 80)) lines.push(`- [${c.why}] ${cell(c.text)} _(${[c.tool, c.project].filter(Boolean).join(', ')}, ${String(c.at).slice(0, 10)})_`);
  lines.push(``, `## Long instructions for clustering (${r.longInstructions.length}, newest first)`, ``);
  for (const l of r.longInstructions) lines.push(`- ${cell(l.text)} _(${[l.tool, l.project].filter(Boolean).join(', ')}, ${String(l.at).slice(0, 10)})_`);
  return lines.join('\n') + '\n';
}

function cell(v) {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function round(x) {
  return Math.round(x * 10) / 10;
}
