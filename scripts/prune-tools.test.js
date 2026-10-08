'use strict';
// Multi-tool pruning: a skill is judged only by transcripts of the tools that load its folder.
// Run: node --test scripts/prune-tools.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prune = require('./prune.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const jsonl = (...lines) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir, name) {
  put(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}\n---\n# ${name}\n`);
  put(path.join(dir, name, 'PROVENANCE.md'), 'target: skill\n');
}

function codexSession(root, i, at, prompt, extra = []) {
  const stamp = iso(at);
  put(
    path.join(root, `sessions/rollout-${i}.jsonl`),
    jsonl(
      { timestamp: stamp, type: 'session_meta', payload: { id: `t${i}`, timestamp: stamp, cwd: 'D:\\work\\shop-web', source: 'cli' } },
      { timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: prompt } },
      ...extra,
    ),
  );
}

function cursorSession(root, i, prompt, toolInput) {
  const lines = [{ role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] } }];
  if (toolInput) lines.push({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: toolInput }] } });
  put(path.join(root, `d-work-shop-web/agent-transcripts/c${i}/c${i}.jsonl`), jsonl(...lines));
}

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-miner-prune-tools-'));
  const h = {
    dir,
    claudeSkills: path.join(dir, 'claude-skills'),
    agentsSkills: path.join(dir, 'agents-skills'),
    cursorSkills: path.join(dir, 'cursor-skills'),
    state: path.join(dir, 'state'),
    claudeRoot: path.join(dir, 'claude-projects'),
    codexRoot: path.join(dir, 'codex'),
    cursorRoot: path.join(dir, 'cursor-projects'),
  };
  skill(h.claudeSkills, 'shared-name');
  skill(h.agentsSkills, 'shared-name');
  skill(h.agentsSkills, 'release-notes');
  skill(h.agentsSkills, 'db-reset-local');
  skill(h.cursorSkills, 'cursor-only');

  const installedAt = iso(NOW - 40 * DAY);
  put(
    path.join(h.state, 'installed.json'),
    JSON.stringify({
      installed: [
        { name: 'shared-name', target: 'skill', path: 'x', runDate: '2026-08-01', installedAt },
        { name: 'shared-name', target: 'skill', tool: 'agents', path: 'x', runDate: '2026-08-01', installedAt },
        { name: 'release-notes', target: 'skill', tool: 'agents', path: 'x', runDate: '2026-08-01', installedAt },
        { name: 'db-reset-local', target: 'skill', tool: 'agents', path: 'x', runDate: '2026-08-01', installedAt },
        { name: 'cursor-only', target: 'skill', tool: 'cursor', path: 'x', runDate: '2026-08-01', installedAt },
      ],
    }),
  );

  // Twelve Codex sessions; one mentions $release-notes, one reads db-reset-local's SKILL.md inside a
  // message the model wrote (not a typed prompt), one is an injected message naming $shared-name.
  for (let i = 0; i < 12; i++) {
    const at = NOW - (30 - i * 2) * DAY;
    const extra = [];
    if (i === 4) extra.push({ timestamp: iso(at + 1000), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use $shared-name' }] } });
    codexSession(h.codexRoot, i, at, i === 3 ? 'please $release-notes for v2' : 'add a test for the parser', extra);
  }
  // Cursor: one typed /shared-name, one read of cursor-only/SKILL.md.
  cursorSession(h.cursorRoot, 1, '/shared-name now');
  cursorSession(h.cursorRoot, 2, 'look at the skill', { path: '/home/me/.cursor/skills/cursor-only/SKILL.md' });
  for (let i = 3; i < 14; i++) cursorSession(h.cursorRoot, i, 'something else');
  // The Claude folder: one session that calls shared-name through the Skill tool.
  put(
    path.join(h.claudeRoot, 'D--work-shop-web/s1.jsonl'),
    jsonl({ type: 'assistant', timestamp: iso(NOW - 3 * DAY), message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'shared-name' } }] } }),
  );
  return h;
}

function opts(h, extra = {}) {
  return prune.options({
    targets: 'all',
    root: h.claudeRoot,
    'codex-root': h.codexRoot,
    'cursor-root': h.cursorRoot,
    skills: h.claudeSkills,
    'agents-skills': h.agentsSkills,
    'cursor-skills': h.cursorSkills,
    state: h.state,
    now: iso(NOW),
    ...extra,
  });
}

async function assessAll(h) {
  const o = opts(h);
  const skills = prune.generatedSkills(o);
  const roots = { claude: o.root, codex: o.codexRoot, cursor: o.cursorRoot };
  const scan = await prune.scanSources(roots, new Set(skills.map(s => s.name)), NOW - 40 * DAY);
  return { o, skills, scan, rows: prune.assess(skills, scan, o) };
}

const find = (rows, tool, name) => rows.find(r => r.tool === tool && r.name === name);

test('each skill is judged by the tools that load its folder', async () => {
  const { rows } = await assessAll(home());

  // Codex mention of a skill in ~/.agents/skills.
  assert.equal(find(rows, 'agents', 'release-notes').status, 'used');
  assert.equal(find(rows, 'agents', 'release-notes').triggered, 1);
  // Never invoked anywhere.
  assert.equal(find(rows, 'agents', 'db-reset-local').status, 'never');
  // Cursor reads ~/.agents/skills too, so its typed /shared-name counts for the agents copy.
  assert.equal(find(rows, 'agents', 'shared-name').status, 'used');
  // The Claude copy is used through the Skill tool and by Cursor; the injected Codex message is not a trigger for either.
  assert.equal(find(rows, 'claude', 'shared-name').triggered, 2);
  assert.equal(find(rows, 'cursor', 'cursor-only').status, 'used');
});

test('a Codex session does not count toward a skill in the Claude-only folder', async () => {
  const { rows } = await assessAll(home());
  const claudeCopy = find(rows, 'claude', 'shared-name');
  const agentsCopy = find(rows, 'agents', 'shared-name');
  assert.ok(agentsCopy.sessionsSince > claudeCopy.sessionsSince, 'the agents copy sees Codex and Cursor sessions, the Claude copy sees Claude and Cursor');
});

test('mentions inside injected or model-written messages are not triggers', async () => {
  const h = home();
  const { scan } = await assessAll(h);
  const codexShared = scan.triggers.filter(t => t.tool === 'codex' && t.name === 'shared-name');
  assert.equal(codexShared.length, 0);
});

test('a skill whose tool has no transcripts is too new or never, not used', async () => {
  const h = home();
  fs.rmSync(h.cursorRoot, { recursive: true });
  fs.rmSync(h.codexRoot, { recursive: true });
  const { rows } = await assessAll(h);
  assert.equal(find(rows, 'cursor', 'cursor-only').status, 'too-new');
  assert.equal(find(rows, 'agents', 'db-reset-local').status, 'too-new');
});

test('remove takes tool-prefixed names and records the tool', async () => {
  const h = home();
  const o = opts(h);
  const moved = prune.remove(['agents:db-reset-local', 'shared-name', 'windsurf:x'], o);

  assert.deepEqual(moved.map(m => m.status), ['moved', 'moved', 'skipped: not a skill folder name']);
  assert.equal(fs.existsSync(path.join(h.agentsSkills, 'db-reset-local')), false);
  assert.equal(fs.existsSync(path.join(h.agentsSkills, 'shared-name', 'SKILL.md')), true, 'the other tool\'s copy of the same name stays');
  assert.equal(fs.existsSync(path.join(h.claudeSkills, 'shared-name')), false);
  assert.equal(fs.existsSync(path.join(h.state, 'pruned', '2026-10-08', 'agents@db-reset-local', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(h.state, 'pruned', '2026-10-08', 'shared-name', 'SKILL.md')), true);

  const ledger = JSON.parse(fs.readFileSync(path.join(h.state, 'installed.json'), 'utf8'));
  const entry = (name, tool) => ledger.installed.find(e => e.name === name && (e.tool ?? 'claude') === tool);
  assert.equal(entry('db-reset-local', 'agents').prunedAt, iso(NOW));
  assert.equal(entry('shared-name', 'claude').prunedAt, iso(NOW));
  assert.equal(entry('shared-name', 'agents').prunedAt, undefined);

  const decisions = JSON.parse(fs.readFileSync(path.join(h.state, 'decisions.json'), 'utf8')).decisions;
  assert.deepEqual(decisions.find(d => d.name === 'db-reset-local'), { name: 'db-reset-local', runDate: '2026-08-01', target: 'skill', tool: 'agents', decision: 'pruned', at: iso(NOW) });
});

test('the report names the folder per skill and builds a remove command with tool prefixes', async () => {
  const { rows, scan } = await assessAll(home());
  const md = prune.renderReport({ generatedAt: iso(NOW), window: { since: iso(NOW - 40 * DAY), files: scan.files, sessions: scan.sessions.length, graceDays: 14, graceSessions: 10, sources: scan.sources }, skills: rows });
  assert.match(md, /\| Skill \| Folder \|/);
  assert.match(md, /--remove agents:db-reset-local/);
  assert.match(md, /Cursor transcripts carry no timestamps/);
  assert.match(md, /Codex: a typed \$<name>/);
});

test('options reject an unknown target and default to the Claude folder alone', () => {
  assert.throws(() => prune.options({ targets: 'windsurf' }), /unknown target/);
  assert.deepEqual(prune.options({}).targets, ['claude']);
  assert.deepEqual(prune.options({ targets: 'claude,cursor' }).targets, ['claude', 'cursor']);
});
