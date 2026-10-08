'use strict';
// The hook payloads follow the Cursor and Codex hook documentation; no real Cursor or Codex run
// produced them, so these tests pin how the script reads the documented fields.
// Run: node --test scripts/live-hook.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const { handle, clear } = require('./live-hook.js');

const HOOK = path.join(__dirname, 'live-hook.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skill-miner-live-'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const cursorInput = (prompt, extra = {}) => ({
  hook_event_name: 'beforeSubmitPrompt',
  conversation_id: 'conv-1',
  generation_id: 'gen-1',
  workspace_roots: ['D:\\work\\shop-web'],
  prompt,
  attachments: [],
  ...extra,
});

const codexInput = (prompt, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  cwd: '/home/me/design-kit',
  prompt,
  ...extra,
});

test('a prompt that is not a correction records nothing and lets the prompt through', () => {
  const liveDir = tmp();
  const out = handle(cursorInput('add a retry to the upload service'), { tool: 'cursor', liveDir });
  assert.deepEqual(out, { continue: true });
  assert.equal(fs.existsSync(path.join(liveDir, 'corrections.cursor.json')), false);
});

test('a correction is recorded with its project and session', () => {
  const liveDir = tmp();
  handle(cursorInput("No, don't use moment, use date-fns"), { tool: 'cursor', liveDir, now: 1_000 });
  const [c] = read(path.join(liveDir, 'corrections.cursor.json')).corrections;
  assert.equal(c.project, 'shop-web');
  assert.equal(c.sessionId, 'conv-1');
  assert.equal(c.why, 'opening');
  assert.equal(c.key, 'no dont use moment use date fns');
  assert.equal(c.at, 1_000);
});

test('the second identical correction writes repeats; Cursor gets no notice field, Codex gets one', () => {
  const cursorDir = tmp();
  const first = handle(cursorInput("Don't touch the lockfile"), { tool: 'cursor', liveDir: cursorDir, now: 1 });
  const second = handle(cursorInput("don't touch the lockfile!", { conversation_id: 'conv-2' }), { tool: 'cursor', liveDir: cursorDir, now: 2 });
  assert.deepEqual(first, { continue: true });
  assert.deepEqual(second, { continue: true });
  const { repeats } = read(path.join(cursorDir, 'repeats.cursor.json'));
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].count, 2);
  assert.equal(repeats[0].sessions, 2);

  const codexDir = tmp();
  handle(codexInput("Don't touch the lockfile"), { tool: 'codex', liveDir: codexDir, now: 1 });
  const notice = handle(codexInput("Don't touch the lockfile", { session_id: 'sess-2' }), { tool: 'codex', liveDir: codexDir, now: 2 });
  assert.equal(notice.continue, true);
  assert.match(notice.systemMessage, /corrected this 2 times/);
  assert.equal(read(path.join(codexDir, 'repeats.codex.json')).repeats[0].projects[0], 'design-kit');
});

test('a correction already decided on stays out of the repeats', () => {
  const liveDir = tmp();
  fs.writeFileSync(path.join(liveDir, 'handled.json'), JSON.stringify({ keys: ['dont touch the lockfile'] }));
  handle(codexInput("Don't touch the lockfile"), { tool: 'codex', liveDir, now: 1 });
  const out = handle(codexInput("Don't touch the lockfile"), { tool: 'codex', liveDir, now: 2 });
  assert.equal(out.systemMessage, undefined);
  assert.equal(fs.existsSync(path.join(liveDir, 'repeats.codex.json')), false);
});

test('pasted logs, slash commands and context blocks are not corrections', () => {
  const liveDir = tmp();
  const cases = [
    "No, don't. Traceback (most recent call last):\n  File x",
    "/clear don't use that",
    '<system-reminder>Do not use that</system-reminder>',
    '2026-10-01T10:00:00Z no, stop',
  ];
  for (const prompt of cases) handle(codexInput(prompt), { tool: 'codex', liveDir });
  assert.equal(fs.existsSync(path.join(liveDir, 'corrections.codex.json')), false);
});

test('other events, missing prompts and unknown tools pass through untouched', () => {
  const liveDir = tmp();
  assert.deepEqual(handle(codexInput("No, don't", { hook_event_name: 'PreToolUse' }), { tool: 'codex', liveDir }), { continue: true });
  assert.deepEqual(handle({ hook_event_name: 'UserPromptSubmit' }, { tool: 'codex', liveDir }), { continue: true });
  assert.deepEqual(handle(codexInput("No, don't"), { tool: 'windsurf', liveDir }), { continue: true });
  assert.deepEqual(handle(null, { tool: 'codex', liveDir }), { continue: true });
  assert.deepEqual(fs.readdirSync(liveDir), []);
});

test('the list keeps only the newest 500 corrections', () => {
  const liveDir = tmp();
  for (let i = 0; i < 505; i++) handle(codexInput(`No, use option ${i}`), { tool: 'codex', liveDir, now: i });
  const list = read(path.join(liveDir, 'corrections.codex.json')).corrections;
  assert.equal(list.length, 500);
  assert.equal(list[0].at, 5);
});

test('run as a process it answers {"continue":true} on stdin that is not JSON, and never fails', () => {
  const liveDir = tmp();
  const r = spawnSync(process.execPath, [HOOK, '--tool', 'cursor', '--live-dir', liveDir], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true });
});

test('run as a process it records a repeat and prints the Codex notice', () => {
  const liveDir = tmp();
  const run = input => spawnSync(process.execPath, [HOOK, '--tool', 'codex', '--live-dir', liveDir], { input: JSON.stringify(input), encoding: 'utf8' });
  run(codexInput('Always run the formatter first'));
  const r = run(codexInput('Always run the formatter first', { session_id: 'sess-2' }));
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /2 times/);
});

test('a live-dir that cannot be written does not break the prompt', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const r = spawnSync(process.execPath, [HOOK, '--tool', 'codex', '--live-dir', path.join(blocker, 'live')], { input: JSON.stringify(codexInput("No, don't")), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { continue: true });
});

test('--clear forgets one tool or all', () => {
  const liveDir = tmp();
  for (const tool of ['codex', 'cursor']) {
    fs.writeFileSync(path.join(liveDir, `corrections.${tool}.json`), '{}');
    fs.writeFileSync(path.join(liveDir, `repeats.${tool}.json`), '{}');
  }
  fs.writeFileSync(path.join(liveDir, 'handled.json'), '{}');
  assert.equal(clear(liveDir, ['codex']).length, 2);
  assert.deepEqual(fs.readdirSync(liveDir).sort(), ['corrections.cursor.json', 'handled.json', 'repeats.cursor.json']);
  assert.equal(clear(liveDir, ['codex', 'cursor']).length, 2);
  assert.deepEqual(fs.readdirSync(liveDir), ['handled.json']);
});

test('mine.js --live merges repeats from Claude, Codex and Cursor and drops handled keys', () => {
  const liveDir = tmp();
  const out = tmp();
  const repeat = (key, count, project, at) => ({ key, count, sessions: count, projects: [project], firstSeen: at, lastSeen: at, quotes: [`quote of ${key}`] });
  const write = (name, repeats) => fs.writeFileSync(path.join(liveDir, name), JSON.stringify({ repeats }));
  write('repeats.json', [repeat('use date fns', 2, 'shop-web', Date.parse('2026-09-01')), repeat('already decided', 2, 'shop-web', 0)]);
  write('repeats.codex.json', [repeat('use date fns', 3, 'design-kit', Date.parse('2026-10-01'))]);
  write('repeats.cursor.json', [repeat('keep lockfile', 2, 'shop-web', Date.parse('2026-10-02'))]);
  fs.writeFileSync(path.join(liveDir, 'handled.json'), JSON.stringify({ keys: ['already decided'] }));

  execFileSync(process.execPath, [path.join(__dirname, 'mine.js'), '--live', '--live-dir', liveDir, '--out', out], { encoding: 'utf8' });
  const { liveRepeats } = read(path.join(out, 'candidates.json'));

  assert.deepEqual(liveRepeats.map(r => r.key), ['use date fns', 'keep lockfile']);
  const merged = liveRepeats[0];
  assert.equal(merged.count, 5);
  assert.equal(merged.projects, 2);
  assert.deepEqual(merged.projectNames.sort(), ['design-kit', 'shop-web']);
  assert.equal(merged.firstSeen, '2026-09-01');
  assert.equal(merged.lastSeen, '2026-10-01');
});
