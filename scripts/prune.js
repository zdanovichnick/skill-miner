#!/usr/bin/env node
'use strict';
// Which skill-miner-generated skills have never been invoked since they were installed?
//
// Usage: node prune.js [--grace-days 14] [--grace-sessions 10] [--root ~/.claude/projects]
//                      [--skills ~/.claude/skills] [--state ~/.claude/skill-miner] [--out <dir>]
//        node prune.js --remove <name>[,<name>...]
//
// A generated skill is one listed with target "skill" in <state>/installed.json, or any
// <skills>/<name>/ holding the PROVENANCE.md that /skill-miner:accept writes beside it. A trigger is
// a Skill tool call naming it or the person typing /<name>; nothing else in a transcript is read.
// A skill younger than the grace period, in days or in sessions since install, is "too new" rather
// than "never".
//
// --remove moves each named folder to <state>/pruned/<date>/<name>/ (reversible by moving it back),
// marks it pruned in installed.json and decisions.json, and exits.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const SKILL_CALL = '"name":"Skill"';
const SLASH = '<command-name>';
const SLASH_RE = /<command-name>\/?([^<]+)<\/command-name>/g;

function options(args) {
  return {
    root: expandHome(args.root ?? '~/.claude/projects'),
    skills: expandHome(args.skills ?? '~/.claude/skills'),
    state: expandHome(args.state ?? '~/.claude/skill-miner'),
    out: args.out ? expandHome(args.out) : null,
    graceDays: Number(args['grace-days'] ?? 14),
    graceSessions: Number(args['grace-sessions'] ?? 10),
    now: args.now ? Date.parse(args.now) : Date.now(),
  };
}

async function main(args) {
  const opts = options(args);
  if (args.remove) {
    const moved = remove(String(args.remove).split(',').map(s => s.trim()).filter(Boolean), opts);
    for (const m of moved) console.log(`[skill-miner] ${m.name}: ${m.status}${m.to ? ` -> ${m.to}` : ''}`);
    return;
  }

  const skills = generatedSkills(opts);
  const since = skills.length > 0 ? Math.min(...skills.map(s => s.installedAt)) : opts.now;
  const scan = await scanTriggers(opts.root, new Set(skills.map(s => s.name)), since);
  const rows = assess(skills, scan, opts);
  const result = {
    generatedAt: new Date(opts.now).toISOString(),
    window: { since: new Date(since).toISOString(), files: scan.files, sessions: scan.sessions.length, graceDays: opts.graceDays, graceSessions: opts.graceSessions },
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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The ledger first, then any skill folder carrying a PROVENANCE.md the ledger has forgotten.
function generatedSkills(opts) {
  const ledger = readJson(path.join(opts.state, 'installed.json'), { installed: [] });
  const entries = Array.isArray(ledger.installed) ? ledger.installed : [];
  const skills = [];
  const seen = new Set();
  for (const e of entries) {
    if (e?.target !== 'skill' || typeof e.name !== 'string' || e.prunedAt) continue;
    const installedAt = Date.parse(e.installedAt);
    seen.add(e.name);
    skills.push({ name: e.name, installedAt: Number.isFinite(installedAt) ? installedAt : 0, runDate: e.runDate ?? null, source: 'installed.json' });
  }
  if (fs.existsSync(opts.skills)) {
    for (const d of fs.readdirSync(opts.skills, { withFileTypes: true })) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      const dir = path.join(opts.skills, d.name);
      if (!fs.existsSync(path.join(dir, 'PROVENANCE.md')) || !fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const st = fs.statSync(path.join(dir, 'SKILL.md'));
      skills.push({ name: d.name, installedAt: st.birthtimeMs || st.mtimeMs, runDate: null, source: 'PROVENANCE.md' });
    }
  }
  for (const s of skills) {
    s.present = fs.existsSync(path.join(opts.skills, s.name, 'SKILL.md'));
    s.description = s.present ? skillDescription(path.join(opts.skills, s.name, 'SKILL.md')) : '';
  }
  return skills.sort((a, b) => a.installedAt - b.installedAt);
}

function skillDescription(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
  const m = /^description:\s*(.+)$/m.exec(head);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').slice(0, 160) : '';
}

// Every transcript touched since the earliest install, subagents included: a skill a subagent
// invoked is in use. Sessions are counted from main transcripts only.
async function scanTriggers(root, names, since) {
  const files = fs.existsSync(root) ? walk(root).filter(f => f.endsWith('.jsonl') && fs.statSync(f).mtimeMs >= since) : [];
  const triggers = [];
  const sessions = [];
  for (const file of files) {
    const isSubagent = file.includes(`${path.sep}subagents${path.sep}`);
    const session = path.basename(file, '.jsonl');
    let startedAt = null;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const wantsSkill = line.includes(SKILL_CALL);
      const wantsSlash = line.includes(SLASH) && line.includes('"type":"user"');
      if (startedAt !== null && !wantsSkill && !wantsSlash) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(o.timestamp ?? '');
      if (startedAt === null && Number.isFinite(at)) startedAt = at;
      if (!Number.isFinite(at)) continue;
      if (wantsSkill && o.type === 'assistant') {
        for (const part of o.message?.content ?? []) {
          if (part.type !== 'tool_use' || part.name !== 'Skill') continue;
          const name = String(part.input?.skill ?? '');
          if (names.has(name)) triggers.push({ name, at, session, via: 'tool' });
        }
      }
      if (wantsSlash && o.type === 'user') {
        const text = typeof o.message?.content === 'string' ? o.message.content : (o.message?.content ?? []).map(p => p.text ?? '').join('\n');
        for (const m of text.matchAll(SLASH_RE)) {
          const name = m[1].trim();
          if (names.has(name)) triggers.push({ name, at, session, via: 'slash' });
        }
      }
    }
    if (!isSubagent) sessions.push({ session, startedAt: startedAt ?? fs.statSync(file).mtimeMs });
  }
  return { files: files.length, triggers, sessions };
}

function assess(skills, scan, opts) {
  const day = 86_400_000;
  return skills.map(s => {
    const uses = scan.triggers.filter(t => t.name === s.name && t.at >= s.installedAt).sort((a, b) => a.at - b.at);
    const sessionsSince = scan.sessions.filter(x => x.startedAt >= s.installedAt).length;
    const ageDays = Math.floor((opts.now - s.installedAt) / day);
    let status;
    if (!s.present) status = 'missing';
    else if (uses.length > 0) status = 'used';
    else if (ageDays < opts.graceDays || sessionsSince < opts.graceSessions) status = 'too-new';
    else status = 'never';
    return {
      name: s.name,
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

function remove(names, opts) {
  const stamp = new Date(opts.now).toISOString().slice(0, 10);
  const ledgerFile = path.join(opts.state, 'installed.json');
  const decisionsFile = path.join(opts.state, 'decisions.json');
  const ledger = readJson(ledgerFile, { installed: [] });
  const decisions = readJson(decisionsFile, { decisions: [] });
  if (!Array.isArray(ledger.installed)) ledger.installed = [];
  if (!Array.isArray(decisions.decisions)) decisions.decisions = [];
  const at = new Date(opts.now).toISOString();
  const moved = [];
  for (const name of names) {
    if (!/^[\w.-]+$/.test(name)) {
      moved.push({ name, status: 'skipped: not a skill folder name' });
      continue;
    }
    const src = path.join(opts.skills, name);
    const entry = ledger.installed.find(e => e?.name === name && e.target === 'skill');
    if (!fs.existsSync(src)) {
      if (entry && !entry.prunedAt) entry.prunedAt = at;
      moved.push({ name, status: 'already gone' });
      continue;
    }
    const dest = path.join(opts.state, 'pruned', stamp, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
    if (entry) entry.prunedAt = at;
    else ledger.installed.push({ name, target: 'skill', path: src, runDate: null, installedAt: null, prunedAt: at });
    decisions.decisions.push({ name, runDate: entry?.runDate ?? null, target: 'skill', decision: 'pruned', at });
    moved.push({ name, status: 'moved', to: dest });
  }
  fs.mkdirSync(opts.state, { recursive: true });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  fs.writeFileSync(decisionsFile, JSON.stringify(decisions, null, 2));
  return moved;
}

function renderReport(r) {
  const label = { never: 'never triggered', 'too-new': 'too new to tell', used: 'in use', missing: 'folder gone' };
  const day = iso => (iso ? iso.slice(0, 10) : '—');
  const lines = [
    `# Generated skills: use since install`,
    ``,
    `${r.window.sessions} sessions from ${r.window.files} transcripts since ${day(r.window.since)}, generated ${r.generatedAt}.`,
    `A trigger is a Skill tool call naming the skill or a typed /<name>. Grace: ${r.window.graceDays} days and ${r.window.graceSessions} sessions.`,
    ``,
  ];
  if (r.skills.length === 0) {
    lines.push(`_No generated skills found: nothing in installed.json with target "skill", and no skill folder carries a PROVENANCE.md._`, ``);
    return lines.join('\n');
  }
  lines.push(`| Skill | Installed | Sessions since | Triggered | Last triggered | Status |`, `|---|---|---|---|---|---|`);
  for (const s of r.skills) {
    lines.push(`| \`${s.name}\` | ${day(s.installedAt)} (${s.ageDays} d) | ${s.sessionsSince} | ${s.triggered}× in ${s.triggerSessions} | ${day(s.lastTriggered)} | ${label[s.status]} |`);
  }
  const never = r.skills.filter(s => s.status === 'never');
  lines.push(``, `## Prune candidates (${never.length})`, ``);
  if (never.length === 0) lines.push(`_none_`);
  for (const s of never) lines.push(`- \`${s.name}\`${s.description ? ` — ${s.description}` : ''}`);
  if (never.length > 0) {
    lines.push(``, `Remove the ones the person picks with \`node prune.js --remove ${never.map(s => s.name).join(',')}\`; each folder moves to \`pruned/<date>/<name>/\` and can be moved back.`);
  }
  const young = r.skills.filter(s => s.status === 'too-new');
  if (young.length > 0) lines.push(``, `Too new to judge: ${young.map(s => `\`${s.name}\``).join(', ')}.`);
  lines.push(``);
  return lines.join('\n');
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

module.exports = { options, generatedSkills, scanTriggers, assess, remove, renderReport, parseArgs };

if (require.main === module) {
  main(parseArgs(process.argv.slice(2))).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
