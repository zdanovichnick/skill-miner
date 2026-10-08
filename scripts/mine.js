#!/usr/bin/env node
// Mines Claude Code transcripts for recurring work patterns and writes ranked candidates.
//
// Reads only what the person typed and the *shape* of the tool calls that ran (tool name,
// command head, file extension). Tool output, pasted blocks and system reminders are never
// read into a candidate: a skill drafted from them would carry injected text into every
// future session.
//
// Usage: node mine.js [--days 30] [--root ~/.claude/projects] [--out <dir>] [--min-sessions 3]
//                     [--live] [--live-dir ~/.claude/skill-miner/live]
//
// The live mod (hooks/register.ts) writes <live-dir>/repeats.json: corrections the person typed
// more than once, already grouped. They join the report as its first section; --live skips the
// transcript scan and reports them alone, for a run right after the mod's toast.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const args = parseArgs(process.argv.slice(2));
const DAYS = Number(args.days ?? 30);
const MIN_SESSIONS = Number(args['min-sessions'] ?? 3);
const ROOT = expandHome(args.root ?? '~/.claude/projects');
const OUT = expandHome(args.out ?? path.join('~/.claude/skill-miner/runs', new Date().toISOString().slice(0, 10)));
const LIVE_DIR = expandHome(args['live-dir'] ?? '~/.claude/skill-miner/live');
const LIVE_ONLY = args.live === 'true';

const ACTION = /^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Skill|Agent|Workflow|mcp):?/;
const KEPT_BASENAMES = /^(CLAUDE\.md|AGENTS\.md|README\.md|CHANGELOG\.md|SKILL\.md|Program\.cs|package\.json|pyproject\.toml|Makefile|Dockerfile|docker-compose\.ya?ml|pipeline\.ya?ml|hooks\.json|plugin\.json|settings(\.local)?\.json|appsettings(\.\w+)?\.json)$/i;
const SKIP_HEADS = new Set(['cd', 'echo', 'sleep', 'true', 'set', 'export', 'pwd', 'clear']);
// Tokens every coding session produces; a sequence made only of these is habit, not a workflow.
const GENERIC =
  /^(Read|Edit|Write|MultiEdit|Grep|Glob|ToolSearch|ExitPlanMode|EnterPlanMode|AskUserQuestion|TaskCreate|TaskUpdate|TaskList|TodoWrite|(Bash|PowerShell):(sed|grep|cat|head|tail|ls|find|wc|python|python3|node|rg|awk|sort|diff|xargs|git (status|diff|log|show)|dotnet (build|test|restore)|(npm|pnpm|yarn)( run)? (build|test|lint)|pytest|make (test|build|lint))\b.*)(:|$)/;
// Shell heads that say how a project is built, tested or shipped: the recipes worth keeping.
const RECIPE_HEAD =
  /^(cd \S+ && )?(dotnet|npm|pnpm|yarn|npx|make|uv|poetry|pytest|terraform|tf-run|aws|docker|docker-compose|bk|gh|kubectl|helm|mvn|\.\/mvnw|gradle|cargo|go|claude|az|flyway)\b/;
const CORRECTION_START =
  /^(no\b|nope\b|don'?t\b|dont\b|do not\b|stop\b|wrong\b|not (that|this|like)\b|actually\b|instead\b|you (missed|forgot|broke|didn'?t)\b|why (did|do) you\b|never\b|always\b|please (don'?t|dont|stop|use)\b|that'?s (wrong|not)\b)/i;
const CORRECTION_ANYWHERE =
  /\b(instead of|i said|i told you|not what i|you should(n'?t| not)|stop (doing|using)|(don'?t|dont|do not) (use|create|add|change|touch|break|need))\b/i;
const NOT_HUMAN_PREFIX = /^<(local-command-|task-notification|system-reminder|bash-|user-memory-input|teammate-message)/;
const NOT_HUMAN_TEXT = /^(\[Request interrupted by user|Another Claude session sent a message)/;
const INTERRUPTED = /^\[Request interrupted by user/;
// Pasted logs and stack traces are not instructions, and are untrusted text besides.
const PASTED_LOG =
  /(\bat [A-Z][\w.`]+\(|Exception:|Traceback \(most recent|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b[\s\S]*\b\d{2}:\d{2}:\d{2}\b|Waited \d+s · Ran in|^\s*[{[]\s*")/m;

main().catch(e => {
  console.error(`[skill-miner] ${e.stack || e}`);
  process.exit(1);
});

async function main() {
  const since = Date.now() - DAYS * 86_400_000;
  const files = LIVE_ONLY
    ? []
    : walk(ROOT).filter(f => f.endsWith('.jsonl') && !f.includes(`${path.sep}subagents${path.sep}`) && fs.statSync(f).mtimeMs >= since);

  const sessions = [];
  for (const file of files) {
    const s = await parseSession(file);
    if (s.prompts.length > 0 || s.tools.length > 0) sessions.push(s);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    window: { days: DAYS, files: files.length, sessions: sessions.length, minSessions: MIN_SESSIONS, liveOnly: LIVE_ONLY },
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
  console.log(`[skill-miner] ${sessions.length} sessions from ${files.length} files (${DAYS}d) -> ${OUT}`);
  console.log(
    `[skill-miner] live repeats ${result.liveRepeats.length}, sequences ${result.toolSequences.length}, shell ${result.shellRecipes.length}, ` +
      `openings ${result.promptOpenings.length}, repeated ${result.repeatedInstructions.length}, corrections ${result.corrections.length}`,
  );
}

// What the live mod grouped already: each entry a correction typed 2+ times, with up to three
// quotes of the person's words. Absent or unreadable, there are none.
function readLiveRepeats() {
  const file = path.join(LIVE_DIR, 'repeats.json');
  if (!fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const day = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
  return (Array.isArray(parsed?.repeats) ? parsed.repeats : [])
    .filter(r => typeof r?.key === 'string' && Array.isArray(r.quotes))
    .map(r => ({
      key: r.key,
      count: Number(r.count) || r.quotes.length,
      sessions: Number(r.sessions) || 1,
      projects: Array.isArray(r.projects) ? r.projects.length : 1,
      projectNames: Array.isArray(r.projects) ? r.projects.slice(0, 6) : [],
      firstSeen: day(r.firstSeen),
      lastSeen: day(r.lastSeen),
      quotes: r.quotes.filter(q => typeof q === 'string').slice(0, 3).map(q => q.slice(0, 300)),
    }))
    .sort((a, b) => b.count - a.count);
}

async function parseSession(file) {
  const s = { id: path.basename(file, '.jsonl'), project: path.basename(path.dirname(file)), date: null, prompts: [], tools: [], shell: [] };
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const isUser = line.includes('"type":"user"');
    const isAssistant = !isUser && line.includes('"type":"assistant"') && line.includes('"tool_use"');
    if (!isUser && !isAssistant) continue;
    if (isUser && line.includes('"toolUseResult"')) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    s.date ??= o.timestamp?.slice(0, 10) ?? null;

    if (o.type === 'user') {
      if (INTERRUPTED.test(rawText(o).trim())) {
        s.interrupted = true;
        continue;
      }
      const prompt = humanPrompt(o);
      if (prompt) {
        prompt.afterInterrupt = s.interrupted === true;
        s.interrupted = false;
        s.prompts.push(prompt);
      }
    } else if (o.type === 'assistant') {
      for (const part of o.message?.content ?? []) {
        if (part.type !== 'tool_use') continue;
        const token = toolToken(part.name, part.input ?? {});
        if (s.tools[s.tools.length - 1] !== token) s.tools.push(token);
        if ((part.name === 'Bash' || part.name === 'PowerShell') && typeof part.input?.command === 'string') {
          s.shell.push(normalizeCommand(part.input.command));
        }
      }
    }
  }
  return s;
}

function humanPrompt(o) {
  if (o.isMeta || o.isCompactSummary) return null;
  const kind = o.origin?.kind;
  if (kind !== undefined && kind !== 'human') return null;
  let text = rawText(o).trim();
  if (!text || NOT_HUMAN_PREFIX.test(text) || NOT_HUMAN_TEXT.test(text)) return null;
  if (text.startsWith('This session is being continued')) return null;

  const slash = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)?.[1]?.trim() ?? null;
  const cmdArgs = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  if (slash) text = cmdArgs;

  text = text
    // Greedy, and an unclosed block runs to the end: pasted and harness text must never reach a
    // proposal, so losing a typed line between two pastes is the cheaper mistake.
    .replace(/<pasted_content\b[^>]*>[\s\S]*(<\/pasted_content[^>]*>|$)/g, ' [pasted] ')
    .replace(/<(system-reminder|session-context)\b[^>]*>[\s\S]*(<\/\1[^>]*>|$)/g, ' ')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, ' ')
    .replace(/<command-(message|name|args)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!slash && !text) return null;
  return { text, slash, at: o.timestamp ?? null, isLog: PASTED_LOG.test(text) };
}

function rawText(o) {
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
}

function toolToken(name, input) {
  if (name === 'Bash' || name === 'PowerShell') {
    const heads = commandHeads(String(input.command ?? ''));
    return `${name}:${heads.slice(0, 2).join('+') || '?'}`;
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const p = String(input.file_path ?? input.notebook_path ?? '');
    const base = path.win32.basename(p);
    if (KEPT_BASENAMES.test(base)) return `${name}:${base}`;
    if (/\.(cs|fs)proj$/i.test(base)) return `${name}:.csproj`;
    const ext = path.extname(base).toLowerCase();
    return `${name}:${ext || base || '?'}`;
  }
  if (name === 'Skill') return `Skill:${input.skill ?? '?'}`;
  if (name === 'Agent') return `Agent:${input.subagent_type ?? 'general'}`;
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return `mcp:${server}.${tool}`;
  }
  return name;
}

function commandHeads(command) {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map(seg => seg.trim().replace(/^(\w+=\S+\s+)+/, ''))
    .map(seg => {
      const words = seg.split(/\s+/).filter(Boolean);
      if (words.length === 0 || SKIP_HEADS.has(words[0])) return null;
      const prog = path.win32.basename(words[0].replace(/^["']|["']$/g, '')).replace(/\.(exe|cmd|ps1)$/i, '');
      const sub = words[1] && /^[a-z][\w:-]*$/.test(words[1]) ? ` ${words[1]}` : '';
      if (prog === 'node' || prog === 'python' || prog === 'python3') {
        const script = words.slice(1).find(w => !w.startsWith('-'));
        return script ? `${prog} ${path.win32.basename(script.replace(/["']/g, ''))}` : prog;
      }
      return `${prog}${sub}`;
    })
    .filter(Boolean);
}

function normalizeCommand(command) {
  return command
    .replace(/<<'?(\w+)'?[\s\S]*?\n\1\b/g, '<<HEREDOC')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '"…"')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"']+|~[\\/][^\s"']+|\.{1,2}[\\/][^\s"']+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
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
      out.push({ text: p.text.slice(0, 300), why, session: s.id, project: s.project, at: p.at });
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
      out.push({ text: p.text.slice(0, 500), session: s.id, project: s.project, at: p.at });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
}

function bump(map, key, s, extra = {}) {
  let e = map.get(key);
  if (!e) map.set(key, (e = { key, ...extra, sessionIds: new Set(), projectIds: new Set(), lastSeen: null }));
  e.sessionIds.add(s.id);
  e.projectIds.add(s.project);
  if (s.date && (!e.lastSeen || s.date > e.lastSeen)) e.lastSeen = s.date;
}

function finalize(map) {
  return [...map.values()].map(({ sessionIds, projectIds, ...rest }) => ({
    ...rest,
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
    `Evidence is limited to typed prompts and tool-call shapes; tool output never enters a candidate.`,
    ``,
    `## Live repeats (${r.liveRepeats.length})`,
    ``,
    `Corrections typed more than once, grouped by the live mod as they happened. A repeat is a candidate on its own, whatever the session threshold; its key goes to live/handled.json once decided.`,
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
  const common = [['sessions', x => x.sessions], ['projects', x => x.projects], ['last', x => x.lastSeen ?? '']];
  table('Repeated long instructions', r.repeatedInstructions, [['instruction', x => x.example], ...common]);
  table('Tool sequences', r.toolSequences, [['sequence', x => x.key], ['score', x => x.score], ...common]);
  table('Shell recipes', r.shellRecipes, [['command', x => '`' + x.key + '`'], ...common]);
  table('Prompt openings', r.promptOpenings, [['opening', x => x.key], ['example', x => x.example], ...common]);
  table('Slash commands used', r.slashCommands, [['command', x => '/' + x.key], ...common]);
  lines.push(`## Corrections (${r.corrections.length}, newest first)`, ``);
  for (const c of r.corrections.slice(0, 80)) lines.push(`- [${c.why}] ${cell(c.text)} _(${c.project}, ${String(c.at).slice(0, 10)})_`);
  lines.push(``, `## Long instructions for clustering (${r.longInstructions.length}, newest first)`, ``);
  for (const l of r.longInstructions) lines.push(`- ${cell(l.text)} _(${l.project}, ${String(l.at).slice(0, 10)})_`);
  return lines.join('\n') + '\n';
}

function cell(v) {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function round(x) {
  return Math.round(x * 10) / 10;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}
