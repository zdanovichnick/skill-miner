#!/usr/bin/env node
'use strict';
// Live correction notice for Cursor (beforeSubmitPrompt) and Codex (UserPromptSubmit).
//
//   node live-hook.js --tool cursor|codex [--live-dir ~/.claude/skill-miner/live]
//   node live-hook.js --clear [--tool cursor|codex] [--live-dir <dir>]
//
// Reads the hook's JSON from stdin, notes the prompt when it reads as a correction, and groups the
// ones typed more than once into <live-dir>/repeats.<tool>.json, which /skill-miner:mine --live
// reads. It never blocks, rewrites or delays a prompt, and every failure ends in {"continue":true}.
// Codex shows a one-line notice on a repeat; Cursor's hook has no field for a notice on a prompt
// that goes through, so there the repeat is only recorded.

const fs = require('node:fs');
const path = require('node:path');
const T = require('./lib/text');

const TOOLS = ['cursor', 'codex'];
const MAX_RECORDS = 500;
const MAX_TEXT = 300;
const MAX_QUOTES = 3;
const EVENTS = new Set(['UserPromptSubmit', 'beforeSubmitPrompt']);

function inputFields(tool, input) {
  if (tool === 'cursor') {
    const root = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
    return { prompt: input.prompt, session: input.conversation_id, cwd: root };
  }
  return { prompt: input.prompt, session: input.session_id, cwd: input.cwd };
}

function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'unknown';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || 'unknown';
}

function readList(file) {
  const parsed = T.readJson(file, null);
  const list = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
  return list.filter(c => typeof c?.text === 'string' && typeof c.key === 'string');
}

function readHandled(liveDir) {
  const keys = T.readJson(path.join(liveDir, 'handled.json'), null)?.keys;
  return new Set(Array.isArray(keys) ? keys.filter(k => typeof k === 'string') : []);
}

// A write that stops halfway must not leave a file the next prompt cannot parse.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function repeats(list, handled) {
  const byKey = new Map();
  for (const c of list) {
    if (handled.has(c.key)) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([key, group]) => ({
      key,
      count: group.length,
      sessions: new Set(group.map(c => c.sessionId)).size,
      projects: [...new Set(group.map(c => c.project))],
      firstSeen: Math.min(...group.map(c => c.at)),
      lastSeen: Math.max(...group.map(c => c.at)),
      quotes: [...new Set(group.map(c => c.text))].slice(0, MAX_QUOTES),
    }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

// input: the hook's parsed stdin. Returns the hook's stdout object.
function handle(input, { tool, liveDir, now = Date.now() }) {
  const out = { continue: true };
  if (!TOOLS.includes(tool) || typeof input !== 'object' || input === null) return out;
  if (typeof input.hook_event_name === 'string' && !EVENTS.has(input.hook_event_name)) return out;

  const { prompt, session, cwd } = inputFields(tool, input);
  if (typeof prompt !== 'string') return out;
  const text = T.stripContext(prompt);
  // A hook cannot see whether the person interrupted the agent first, so only wording counts here.
  const why = T.classifyCorrection(text, false);
  if (why === undefined) return out;

  const file = path.join(liveDir, `corrections.${tool}.json`);
  const record = {
    text: text.slice(0, MAX_TEXT),
    key: T.correctionKey(text),
    why,
    project: projectName(cwd),
    sessionId: typeof session === 'string' ? session : 'unknown',
    at: now,
  };
  if (record.key === '') return out;
  const list = [...readList(file), record].slice(-MAX_RECORDS);
  writeJson(file, { corrections: list });

  const open = repeats(list, readHandled(liveDir));
  const mine = open.find(r => r.key === record.key);
  if (mine) {
    writeJson(path.join(liveDir, `repeats.${tool}.json`), { generatedAt: new Date(now).toISOString(), repeats: open });
    if (tool === 'codex') {
      out.systemMessage = `skill-miner: you have corrected this ${mine.count} times. Ask $skill-miner to mine live repeats and it proposes a rule now.`;
    }
  }
  return out;
}

function clear(liveDir, tools) {
  const removed = [];
  for (const tool of tools) {
    for (const name of [`corrections.${tool}.json`, `repeats.${tool}.json`]) {
      const file = path.join(liveDir, name);
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        removed.push(file);
      }
    }
  }
  return removed;
}

function liveDirFrom(args) {
  return T.expandHome(args['live-dir'] ?? '~/.claude/skill-miner/live');
}

function main() {
  const args = T.parseArgs(process.argv.slice(2));
  const liveDir = liveDirFrom(args);

  if (args.clear === 'true') {
    const removed = clear(liveDir, TOOLS.includes(args.tool) ? [args.tool] : TOOLS);
    console.log(`[skill-miner] forgot ${removed.length} live file(s)${removed.length > 0 ? `: ${removed.join(', ')}` : ''}`);
    return;
  }

  let raw = '';
  let done = false;
  const finish = out => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  };
  const timer = setTimeout(() => finish({ continue: true }), 4000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
  });
  process.stdin.on('error', () => finish({ continue: true }));
  process.stdin.on('end', () => {
    clearTimeout(timer);
    let out = { continue: true };
    try {
      out = handle(JSON.parse(raw), { tool: args.tool, liveDir });
    } catch {
      out = { continue: true };
    }
    finish(out);
  });
}

module.exports = { handle, repeats, clear };

if (require.main === module) main();
