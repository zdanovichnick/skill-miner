#!/usr/bin/env node
'use strict';
// Installs what the person approved, into whichever tool will load it.
//
//   node install.js skill --from <proposal dir> --target claude|agents|cursor
//                         [--as <name>] [--replace] [--run-date YYYY-MM-DD] [--state <dir>] [--home <dir>]
//   node install.js self  --target claude|agents|cursor [--replace] [--home <dir>]
//   node install.js hooks --tool cursor|codex [--apply] [--script <live-hook.js>] [--home <dir>]
//
// skill  Copies SKILL.md and references/ from a proposal into the target's skill folder, writes
//        PROVENANCE.md beside them, and records the install in <state>/installed.json and decisions.json.
//        Targets: claude -> ~/.claude/skills (Claude Code, also read by Cursor), agents -> ~/.agents/skills
//        (Codex and Cursor), cursor -> ~/.cursor/skills (Cursor).
// self   Copies the miner itself, as a skill with its scripts beside it, so Codex or Cursor can run it
//        from any project.
// hooks  Prints the live-hook registration for Cursor (~/.cursor/hooks.json) or Codex (~/.codex/hooks.json);
//        with --apply, merges it into that file after saving a backup.
//
// Nothing is overwritten without --replace, and a replaced folder is moved aside, not deleted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('./lib/text');

const TARGETS = { claude: ['.claude', 'skills'], agents: ['.agents', 'skills'], cursor: ['.cursor', 'skills'] };
const PORTABLE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PORTABLE_KEYS = new Set(['name', 'description']);
const SKILL_CAP = 8;

function homeDir(opts) {
  return opts.home ?? os.homedir();
}

function skillsDir(target, opts) {
  if (!TARGETS[target]) throw new Error(`unknown target "${target}" (expected claude, agents or cursor)`);
  return path.join(homeDir(opts), ...TARGETS[target]);
}

function stateDir(opts) {
  return opts.state ?? path.join(homeDir(opts), '.claude', 'skill-miner');
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: src => !fs.lstatSync(src).isSymbolicLink() });
}

function readLedger(opts) {
  const ledger = T.readJson(path.join(stateDir(opts), 'installed.json'), { installed: [] });
  if (!Array.isArray(ledger.installed)) ledger.installed = [];
  return ledger;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// `from` holds SKILL.md and optionally references/ and PROVENANCE.md. Returns what was installed
// and any warnings; throws, having written nothing, when the proposal cannot be installed as it is.
function installSkill(opts) {
  const target = opts.target ?? 'claude';
  const from = path.resolve(opts.from);
  const skillFile = path.join(from, 'SKILL.md');
  if (!fs.existsSync(skillFile)) throw new Error(`${from} has no SKILL.md`);

  const name = opts.as ?? path.basename(from);
  const strictName = target === 'claude' ? /^[\w.-]+$/ : PORTABLE_NAME;
  if (!strictName.test(name)) {
    throw new Error(`"${name}" is not a valid skill folder name for target ${target}${target === 'claude' ? '' : ' (lowercase letters, digits and single hyphens)'}`);
  }

  let text = fs.readFileSync(skillFile, 'utf8');
  const meta = frontmatter(text);
  if (!meta) throw new Error('SKILL.md has no frontmatter');
  if (!meta.name) throw new Error('SKILL.md frontmatter has no name');
  if (!meta.description) throw new Error('SKILL.md frontmatter has no description');
  if (opts.as) text = text.replace(/^(---\r?\n[\s\S]*?)^name:.*$/m, `$1name: ${name}`);
  else if (meta.name !== name) throw new Error(`frontmatter name "${meta.name}" does not match the folder "${name}"; pass --as ${name} to rename it`);

  const warnings = [];
  const extra = Object.keys(meta).filter(k => !PORTABLE_KEYS.has(k));
  if (target !== 'claude' && extra.length > 0) {
    warnings.push(`frontmatter has ${extra.join(', ')}; Codex and Cursor read only name and description from the portable format, so fold that text into the description`);
  }

  const dest = path.join(skillsDir(target, opts), name);
  const state = stateDir(opts);
  const now = new Date(opts.now ?? Date.now());
  const ledger = readLedger(opts);

  const active = ledger.installed.filter(e => e?.target === 'skill' && !e.prunedAt && (e.tool ?? 'claude') === target);
  if (active.length >= SKILL_CAP) {
    warnings.push(`${active.length} generated skills are already installed for ${target}; run the pruner before adding more, since skills that never trigger only cost context`);
  }

  let replaced = null;
  if (fs.existsSync(dest)) {
    if (!opts.replace) throw new Error(`${dest} already exists; pass --replace to move it aside and install over it`);
    replaced = path.join(state, 'replaced', now.toISOString().slice(0, 10), target === 'claude' ? name : `${target}@${name}`);
    fs.mkdirSync(path.dirname(replaced), { recursive: true });
    fs.rmSync(replaced, { recursive: true, force: true });
    fs.cpSync(dest, replaced, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), text);
  if (fs.existsSync(path.join(from, 'references'))) copyTree(path.join(from, 'references'), path.join(dest, 'references'));
  if (fs.existsSync(path.join(from, 'PROVENANCE.md'))) fs.copyFileSync(path.join(from, 'PROVENANCE.md'), path.join(dest, 'PROVENANCE.md'));

  const parent = path.basename(path.dirname(from));
  const runDate = opts.runDate ?? (/^\d{4}-\d{2}-\d{2}$/.test(parent) ? parent : now.toISOString().slice(0, 10));
  const at = now.toISOString();
  const entry = ledger.installed.find(e => e?.name === name && e.target === 'skill' && !e.prunedAt && (e.tool ?? 'claude') === target);
  const record = { name, target: 'skill', tool: target, path: dest, runDate, installedAt: at };
  if (entry) Object.assign(entry, record);
  else ledger.installed.push(record);
  writeJson(path.join(state, 'installed.json'), ledger);

  const decisionsFile = path.join(state, 'decisions.json');
  const decisions = T.readJson(decisionsFile, { decisions: [] });
  if (!Array.isArray(decisions.decisions)) decisions.decisions = [];
  const decision = decisions.decisions.find(d => d?.name === name && d.runDate === runDate && (d.target ?? 'skill') === 'skill');
  if (decision) Object.assign(decision, { decision: 'installed', tool: target, at });
  else decisions.decisions.push({ name, runDate, target: 'skill', tool: target, decision: 'installed', at });
  writeJson(decisionsFile, decisions);

  return { name, target, path: dest, replaced, warnings };
}

// The miner as a skill: SKILL.md (and agents/openai.yaml), with the scripts it runs beside it.
function installSelf(opts) {
  const target = opts.target ?? 'agents';
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, '.agents', 'skills', 'skill-miner');
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`${source} has no SKILL.md`);

  const dest = path.join(skillsDir(target, opts), 'skill-miner');
  if (fs.existsSync(dest)) {
    if (!opts.replace) throw new Error(`${dest} already exists; pass --replace to install over it`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  copyTree(source, dest);
  fs.cpSync(__dirname, path.join(dest, 'scripts'), {
    recursive: true,
    filter: src => !fs.lstatSync(src).isSymbolicLink() && !/\.test\.js$/.test(src),
  });
  return { target, path: dest };
}

const HOOK_FLAGS = { cursor: '--tool cursor', codex: '--tool codex' };

// What each tool's hook file needs for one prompt-submit hook. Cursor's schema is versioned and flat;
// Codex nests handlers under an event and a handler type.
function hookEntry(tool, script) {
  const command = `node "${script.replaceAll('\\', '/')}" ${HOOK_FLAGS[tool]}`;
  if (tool === 'cursor') return { event: 'beforeSubmitPrompt', value: { command, timeout: 10 } };
  // No timeout for Codex: its unit is not confirmed, and the hook ends itself after four seconds.
  if (tool === 'codex') return { event: 'UserPromptSubmit', value: { hooks: [{ type: 'command', command }] } };
  throw new Error(`unknown tool "${tool}" (expected cursor or codex)`);
}

function hooksFile(tool, opts) {
  return path.join(homeDir(opts), tool === 'cursor' ? '.cursor' : '.codex', 'hooks.json');
}

function isOurs(tool, handler) {
  const cmd = tool === 'cursor' ? handler?.command : handler?.hooks?.[0]?.command;
  return typeof cmd === 'string' && cmd.includes('live-hook.js');
}

// The file as it would be after adding the hook; the hook already registered is updated in place.
function mergeHooks(tool, existing, script) {
  const { event, value } = hookEntry(tool, script);
  const doc = existing ?? (tool === 'cursor' ? { version: 1, hooks: {} } : { hooks: {} });
  if (typeof doc !== 'object' || Array.isArray(doc) || (doc.hooks !== undefined && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))) {
    throw new Error('the hooks file is not an object with a "hooks" object; leaving it alone');
  }
  doc.hooks ??= {};
  if (tool === 'cursor') doc.version ??= 1;
  const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
  const at = list.findIndex(h => isOurs(tool, h));
  if (at >= 0) list[at] = value;
  else list.push(value);
  doc.hooks[event] = list;
  return doc;
}

function installHooks(opts) {
  const tool = opts.tool;
  const script = path.resolve(opts.script ?? path.join(__dirname, 'live-hook.js'));
  const file = hooksFile(tool, opts);
  let existing = null;
  let raw = null;
  if (fs.existsSync(file)) {
    raw = fs.readFileSync(file, 'utf8');
    try {
      existing = JSON.parse(raw);
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first, nothing was changed`);
    }
  }
  const merged = mergeHooks(tool, existing, script);
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (!opts.apply) return { file, applied: false, text, backup: null };

  let backup = null;
  if (raw !== null) {
    backup = `${file}.skill-miner.bak`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file, applied: true, text, backup };
}

function main(argv) {
  const [command, ...rest] = argv;
  const a = T.parseArgs(rest);
  const flag = v => v === 'true';
  if (command === 'skill') {
    if (!a.from) throw new Error('--from <proposal dir> is required');
    const r = installSkill({ from: a.from, target: a.target ?? 'claude', as: a.as, replace: flag(a.replace), runDate: a['run-date'], state: a.state && T.expandHome(a.state), home: a.home });
    console.log(`[skill-miner] installed ${r.name} for ${r.target} -> ${r.path}`);
    if (r.replaced) console.log(`[skill-miner] the previous folder was moved to ${r.replaced}`);
    for (const w of r.warnings) console.log(`[skill-miner] note: ${w}`);
    if (r.target === 'claude') console.log('[skill-miner] a new skill loads in the next Claude Code session, or after /reload-plugins');
    else console.log(`[skill-miner] a new skill loads in the next ${r.target === 'agents' ? 'Codex or Cursor' : 'Cursor'} session`);
    return;
  }
  if (command === 'self') {
    const r = installSelf({ target: a.target ?? 'agents', replace: flag(a.replace), home: a.home });
    console.log(`[skill-miner] installed the miner as a skill for ${r.target} -> ${r.path}`);
    console.log(`[skill-miner] its scripts are in ${path.join(r.path, 'scripts')}; point hooks there with: node ${path.join(r.path, 'scripts', 'install.js')} hooks --tool cursor|codex --script ${path.join(r.path, 'scripts', 'live-hook.js')}`);
    return;
  }
  if (command === 'hooks') {
    if (!HOOK_FLAGS[a.tool]) throw new Error('--tool cursor or --tool codex is required');
    const r = installHooks({ tool: a.tool, apply: flag(a.apply), script: a.script, home: a.home });
    if (r.applied) {
      console.log(`[skill-miner] wrote ${r.file}${r.backup ? ` (previous copy: ${r.backup})` : ''}`);
      if (a.tool === 'codex') console.log('[skill-miner] Codex runs a new hook only after you review and trust it: open /hooks in Codex once');
      else console.log('[skill-miner] restart Cursor if the hook does not run');
    } else {
      console.log(`[skill-miner] ${r.file} would become:\n${r.text}`);
      console.log('[skill-miner] re-run with --apply to write it');
    }
    return;
  }
  throw new Error('usage: install.js skill|self|hooks (see the header of this file)');
}

module.exports = { installSkill, installSelf, installHooks, mergeHooks, hookEntry, frontmatter, skillsDir };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[skill-miner] ${e.message}`);
    process.exit(1);
  }
}
