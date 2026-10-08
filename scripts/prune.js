#!/usr/bin/env node
'use strict';
// Which skill-miner-generated skills have never been invoked since they were installed?
//
// Usage: node prune.js [--grace-days 14] [--grace-sessions 10] [--targets all|claude,agents,cursor]
//                      [--root ~/.claude/projects] [--codex-root ~/.codex] [--cursor-root ~/.cursor/projects]
//                      [--skills ~/.claude/skills] [--agents-skills ~/.agents/skills] [--cursor-skills ~/.cursor/skills]
//                      [--state ~/.claude/skill-miner] [--out <dir>]
//        node prune.js --remove <name|tool:name>[,...]     (tool is claude, agents or cursor; bare name means claude)
//
// A generated skill is one listed with target "skill" in <state>/installed.json (its `tool` field says
// which skill folder it went to, claude when absent), or any <skills>/<name>/ holding the PROVENANCE.md
// that the installer writes beside it. A trigger is the way each tool itself invokes a skill:
//   Claude Code  a Skill tool call naming it, or the person typing /<name>
//   Codex        the person typing $<name>, or a command that reads <name>/SKILL.md or runs <name>/scripts
//   Cursor       the person typing /<name>, or a tool call that reads <name>/SKILL.md
// Only transcripts of the tools that load a skill's folder are consulted for it. A skill younger than
// the grace period, in days or in sessions since install, is "too new" rather than "never".
//
// --remove moves each named folder to <state>/pruned/<date>/<name>/ (<tool>@<name> for the Codex/Cursor
// folders; reversible by moving it back), marks it pruned in installed.json and decisions.json, and exits.

const fs = require('node:fs');
const path = require('node:path');
const T = require('./lib/text');
const { SOURCES, SKILL_TARGETS, CAN_ZSTD } = require('./lib/sources');

const TARGET_IDS = Object.keys(SKILL_TARGETS);

// `targets` defaults to the Claude folder alone here, so a caller that builds options by hand keeps
// reading only what it points at; the command line passes `all`.
function options(args) {
  const dirs = {
    claude: T.expandHome(args.skills ?? SKILL_TARGETS.claude.dir()),
    agents: T.expandHome(args['agents-skills'] ?? SKILL_TARGETS.agents.dir()),
    cursor: T.expandHome(args['cursor-skills'] ?? SKILL_TARGETS.cursor.dir()),
  };
  const wanted = args.targets === undefined ? ['claude'] : args.targets === 'all' ? TARGET_IDS : String(args.targets).split(',').map(x => x.trim()).filter(Boolean);
  for (const id of wanted) if (!SKILL_TARGETS[id]) throw new Error(`unknown target "${id}" (expected claude, agents, cursor or all)`);
  return {
    root: T.expandHome(args.root ?? '~/.claude/projects'),
    codexRoot: T.expandHome(args['codex-root'] ?? SOURCES.codex.defaultRoot()),
    cursorRoot: T.expandHome(args['cursor-root'] ?? SOURCES.cursor.defaultRoot()),
    skills: dirs.claude,
    dirs,
    targets: wanted,
    state: T.expandHome(args.state ?? '~/.claude/skill-miner'),
    out: args.out ? T.expandHome(args.out) : null,
    graceDays: Number(args['grace-days'] ?? 14),
    graceSessions: Number(args['grace-sessions'] ?? 10),
    now: args.now ? Date.parse(args.now) : Date.now(),
  };
}

async function main(args) {
  const opts = options({ targets: 'all', ...args });
  if (args.remove) {
    const moved = remove(String(args.remove).split(',').map(s => s.trim()).filter(Boolean), opts);
    for (const m of moved) console.log(`[skill-miner] ${m.name}: ${m.status}${m.to ? ` -> ${m.to}` : ''}`);
    return;
  }

  const skills = generatedSkills(opts);
  const since = skills.length > 0 ? Math.min(...skills.map(s => s.installedAt)) : opts.now;
  const roots = {};
  for (const id of new Set(skills.flatMap(s => SKILL_TARGETS[s.tool].loadedBy))) {
    roots[id] = { claude: opts.root, codex: opts.codexRoot, cursor: opts.cursorRoot }[id];
  }
  const scan = await scanSources(roots, new Set(skills.map(s => s.name)), since);
  const rows = assess(skills, scan, opts);
  const result = {
    generatedAt: new Date(opts.now).toISOString(),
    window: {
      since: new Date(since).toISOString(),
      files: scan.files,
      sessions: scan.sessions.length,
      graceDays: opts.graceDays,
      graceSessions: opts.graceSessions,
      sources: scan.sources,
    },
    skills: rows,
  };

  const out = opts.out ?? path.join(opts.state, 'runs', new Date(opts.now).toISOString().slice(0, 10));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'prune.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, 'prune.md'), renderReport(result));

  const count = status => rows.filter(r => r.status === status).length;
  console.log(`[skill-miner] ${rows.length} generated skills, ${scan.sessions.length} sessions since ${result.window.since.slice(0, 10)} -> ${out}`);
  console.log(`[skill-miner] never ${count('never')}, too new ${count('too-new')}, used ${count('used')}, missing ${count('missing')}`);
}

// The ledger first, then any skill folder carrying a PROVENANCE.md the ledger has forgotten.
function generatedSkills(opts) {
  const ledger = T.readJson(path.join(opts.state, 'installed.json'), { installed: [] });
  const entries = Array.isArray(ledger.installed) ? ledger.installed : [];
  const skills = [];
  const seen = new Set();
  for (const e of entries) {
    const tool = e?.tool ?? 'claude';
    if (e?.target !== 'skill' || typeof e.name !== 'string' || e.prunedAt || !opts.targets.includes(tool) || !SKILL_TARGETS[tool]) continue;
    const installedAt = Date.parse(e.installedAt);
    seen.add(`${tool}:${e.name}`);
    skills.push({ name: e.name, tool, installedAt: Number.isFinite(installedAt) ? installedAt : 0, runDate: e.runDate ?? null, source: 'installed.json' });
  }
  for (const tool of opts.targets) {
    const dir = opts.dirs[tool];
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || seen.has(`${tool}:${d.name}`)) continue;
      const folder = path.join(dir, d.name);
      if (!fs.existsSync(path.join(folder, 'PROVENANCE.md')) || !fs.existsSync(path.join(folder, 'SKILL.md'))) continue;
      const st = fs.statSync(path.join(folder, 'SKILL.md'));
      skills.push({ name: d.name, tool, installedAt: st.birthtimeMs || st.mtimeMs, runDate: null, source: 'PROVENANCE.md' });
    }
  }
  for (const s of skills) {
    const file = path.join(opts.dirs[s.tool], s.name, 'SKILL.md');
    s.present = fs.existsSync(file);
    s.description = s.present ? skillDescription(file) : '';
  }
  return skills.sort((a, b) => a.installedAt - b.installedAt);
}

function skillDescription(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
  const m = /^description:\s*(.+)$/m.exec(head);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 160) : '';
}

// Every transcript touched since the earliest install, sub-agents included: a skill a sub-agent
// invoked is in use. Sessions are counted from main transcripts only. `roots` maps a transcript
// source to its folder; a folder that does not exist is passed over.
async function scanSources(roots, names, since) {
  const triggers = [];
  const sessions = [];
  const sources = [];
  let files = 0;
  for (const [id, root] of Object.entries(roots)) {
    const stat = { id, files: 0, skipped: {} };
    sources.push(stat);
    if (!root || !fs.existsSync(root)) continue;
    for (const entry of SOURCES[id].discover(root, since, { subagents: true })) {
      stat.files++;
      if (entry.compressed && !CAN_ZSTD) {
        stat.skipped.compressed = (stat.skipped.compressed ?? 0) + 1;
        continue;
      }
      const r = await SOURCES[id].scan(entry, names);
      for (const t of r.triggers) triggers.push({ ...t, tool: id });
      if (!r.subagent) sessions.push({ session: r.session, startedAt: r.startedAt, tool: id });
    }
    files += stat.files;
  }
  return { files, triggers, sessions, sources };
}

// Claude Code transcripts alone: the original entry point, kept for callers that pass one folder.
function scanTriggers(root, names, since) {
  return scanSources({ claude: root }, names, since);
}

function assess(skills, scan, opts) {
  const day = 86_400_000;
  return skills.map(s => {
    const loadedBy = SKILL_TARGETS[s.tool].loadedBy;
    const uses = scan.triggers.filter(t => t.name === s.name && t.at >= s.installedAt && loadedBy.includes(t.tool ?? 'claude')).sort((a, b) => a.at - b.at);
    const sessionsSince = scan.sessions.filter(x => x.startedAt >= s.installedAt && loadedBy.includes(x.tool ?? 'claude')).length;
    const ageDays = Math.floor((opts.now - s.installedAt) / day);
    let status;
    if (!s.present) status = 'missing';
    else if (uses.length > 0) status = 'used';
    else if (ageDays < opts.graceDays || sessionsSince < opts.graceSessions) status = 'too-new';
    else status = 'never';
    return {
      name: s.name,
      tool: s.tool,
      description: s.description,
      source: s.source,
      runDate: s.runDate,
      installedAt: new Date(s.installedAt).toISOString(),
      ageDays,
      sessionsSince,
      triggered: uses.length,
      triggerSessions: new Set(uses.map(u => u.session)).size,
      lastTriggered: uses.length > 0 ? new Date(uses[uses.length - 1].at).toISOString() : null,
      status,
    };
  });
}

// `name` removes from the Claude folder; `agents:name` and `cursor:name` from the others.
function remove(names, opts) {
  const stamp = new Date(opts.now).toISOString().slice(0, 10);
  const ledgerFile = path.join(opts.state, 'installed.json');
  const decisionsFile = path.join(opts.state, 'decisions.json');
  const ledger = T.readJson(ledgerFile, { installed: [] });
  const decisions = T.readJson(decisionsFile, { decisions: [] });
  if (!Array.isArray(ledger.installed)) ledger.installed = [];
  if (!Array.isArray(decisions.decisions)) decisions.decisions = [];
  const at = new Date(opts.now).toISOString();
  const moved = [];
  for (const spec of names) {
    const [, prefix, name] = /^(?:(\w+):)?(.*)$/.exec(spec);
    const tool = prefix ?? 'claude';
    if (!SKILL_TARGETS[tool] || !/^[\w.-]+$/.test(name)) {
      moved.push({ name: spec, status: 'skipped: not a skill folder name' });
      continue;
    }
    const src = path.join(opts.dirs[tool], name);
    const entry = ledger.installed.find(e => e?.name === name && e.target === 'skill' && (e.tool ?? 'claude') === tool);
    if (!fs.existsSync(src)) {
      if (entry && !entry.prunedAt) entry.prunedAt = at;
      moved.push({ name: spec, status: 'already gone' });
      continue;
    }
    const dest = path.join(opts.state, 'pruned', stamp, tool === 'claude' ? name : `${tool}@${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
    const which = tool === 'claude' ? {} : { tool };
    if (entry) entry.prunedAt = at;
    else ledger.installed.push({ name, target: 'skill', ...which, path: src, runDate: null, installedAt: null, prunedAt: at });
    decisions.decisions.push({ name, runDate: entry?.runDate ?? null, target: 'skill', ...which, decision: 'pruned', at });
    moved.push({ name: spec, status: 'moved', to: dest });
  }
  fs.mkdirSync(opts.state, { recursive: true });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  fs.writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2));
  return moved;
}

const TRIGGER_RULES = {
  claude: 'Claude Code: a Skill tool call naming the skill, or a typed /<name>',
  codex: 'Codex: a typed $<name>, or a command that reads <name>/SKILL.md or runs its scripts',
  cursor: 'Cursor: a typed /<name>, or a tool call that reads <name>/SKILL.md',
};

function renderReport(r) {
  const label = { never: 'never triggered', 'too-new': 'too new to tell', used: 'in use', missing: 'folder gone' };
  const folder = { claude: '~/.claude/skills', agents: '~/.agents/skills', cursor: '~/.cursor/skills' };
  const day = iso => (iso ? iso.slice(0, 10) : '—');
  const sources = (r.window.sources ?? []).map(x => x.id);
  const tools = new Set(r.skills.map(s => s.tool ?? 'claude'));
  const handle = s => ((s.tool ?? 'claude') === 'claude' ? s.name : `${s.tool}:${s.name}`);
  const lines = [
    `# Generated skills: use since install`,
    ``,
    `${r.window.sessions} sessions from ${r.window.files} transcripts since ${day(r.window.since)}, generated ${r.generatedAt}.`,
    `A trigger is how each tool itself invokes a skill. ${(sources.length > 0 ? sources : ['claude']).map(id => TRIGGER_RULES[id]).join('; ')}. Grace: ${r.window.graceDays} days and ${r.window.graceSessions} sessions.`,
    ``,
  ];
  if (sources.includes('cursor')) {
    lines.push(`Cursor transcripts carry no timestamps, so Cursor sessions and triggers are dated by when the transcript file was last written.`, ``);
  }
  if (r.skills.length === 0) {
    lines.push(`_No generated skills found: nothing in installed.json with target "skill", and no skill folder carries a PROVENANCE.md._`, ``);
    return lines.join('\n');
  }
  const multi = tools.size > 1;
  lines.push(
    `| Skill | ${multi ? 'Folder | ' : ''}Installed | Sessions since | Triggered | Last triggered | Status |`,
    `|---|${multi ? '---|' : ''}---|---|---|---|---|`,
  );
  for (const s of r.skills) {
    lines.push(
      `| \`${s.name}\` | ${multi ? `${folder[s.tool ?? 'claude']} | ` : ''}${day(s.installedAt)} (${s.ageDays} d) | ${s.sessionsSince} | ${s.triggered}× in ${s.triggerSessions} | ${day(s.lastTriggered)} | ${label[s.status]} |`,
    );
  }
  const never = r.skills.filter(s => s.status === 'never');
  lines.push(``, `## Prune candidates (${never.length})`, ``);
  if (never.length === 0) lines.push(`_none_`);
  for (const s of never) lines.push(`- \`${s.name}\`${multi ? ` (${folder[s.tool ?? 'claude']})` : ''}${s.description ? ` — ${s.description}` : ''}`);
  if (never.length > 0) {
    lines.push(``, `Remove the ones the person picks with \`node prune.js --remove ${never.map(handle).join(',')}\`; each folder moves to \`pruned/<date>/<name>/\` and can be moved back.`);
  }
  const young = r.skills.filter(s => s.status === 'too-new');
  if (young.length > 0) lines.push(``, `Too new to judge: ${young.map(s => `\`${s.name}\``).join(', ')}.`);
  lines.push(``);
  return lines.join('\n');
}

module.exports = { options, generatedSkills, scanTriggers, scanSources, assess, remove, renderReport, parseArgs: T.parseArgs };

if (require.main === module) {
  main(T.parseArgs(process.argv.slice(2))).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
