'use strict';
// Run: node --test scripts/install.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const install = require('./install.js');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skill-miner-install-'));

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A proposal folder as /skill-miner:mine drafts it: <run-date>/<name>/SKILL.md.
function proposal(root, name, { frontmatter = `name: ${name}\ndescription: Does ${name}`, runDate = '2026-10-07' } = {}) {
  const dir = path.join(root, runDate, name);
  put(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${name}\n`);
  put(path.join(dir, 'references', 'notes.md'), 'notes\n');
  put(path.join(dir, 'PROVENANCE.md'), 'target: skill\n');
  return dir;
}

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a skill lands in the folder of the chosen tool, with references and provenance', () => {
  for (const [target, parts] of [['claude', ['.claude', 'skills']], ['agents', ['.agents', 'skills']], ['cursor', ['.cursor', 'skills']]]) {
    const home = tmp();
    const from = proposal(tmp(), 'release-notes');
    const r = install.installSkill({ from, target, home, now: NOW });
    const dest = path.join(home, ...parts, 'release-notes');
    assert.equal(r.path, dest);
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dest, 'references', 'notes.md')));
    assert.ok(fs.existsSync(path.join(dest, 'PROVENANCE.md')));
  }
});

test('the ledger and decisions record the tool and the run date', () => {
  const home = tmp();
  install.installSkill({ from: proposal(tmp(), 'release-notes'), target: 'agents', home, now: NOW });
  const state = path.join(home, '.claude', 'skill-miner');
  const ledger = read(path.join(state, 'installed.json'));
  assert.deepEqual(ledger.installed.map(e => [e.name, e.tool, e.target, e.runDate, e.installedAt]), [['release-notes', 'agents', 'skill', '2026-10-07', '2026-10-08T12:00:00.000Z']]);
  const { decisions } = read(path.join(state, 'decisions.json'));
  assert.deepEqual(decisions.map(d => [d.name, d.tool, d.decision, d.runDate]), [['release-notes', 'agents', 'installed', '2026-10-07']]);
});

test('an existing folder is never overwritten without --replace, and a replaced one is moved aside', () => {
  const home = tmp();
  const from = proposal(tmp(), 'release-notes');
  install.installSkill({ from, target: 'cursor', home, now: NOW });
  assert.throws(() => install.installSkill({ from, target: 'cursor', home, now: NOW }), /already exists/);

  const installed = path.join(home, '.cursor', 'skills', 'release-notes', 'SKILL.md');
  fs.writeFileSync(installed, fs.readFileSync(installed, 'utf8') + 'hand edit\n');
  const r = install.installSkill({ from, target: 'cursor', home, now: NOW, replace: true });
  assert.match(fs.readFileSync(path.join(r.replaced, 'SKILL.md'), 'utf8'), /hand edit/);
  assert.doesNotMatch(fs.readFileSync(installed, 'utf8'), /hand edit/);
  assert.match(r.replaced, /replaced[\\/]2026-10-08[\\/]cursor@release-notes$/);
});

test('portable targets reject names Codex and Cursor would not load', () => {
  const home = tmp();
  const from = proposal(tmp(), 'Release_Notes');
  assert.throws(() => install.installSkill({ from, target: 'agents', home }), /not a valid skill folder name/);
  assert.throws(() => install.installSkill({ from, target: 'cursor', home }), /not a valid skill folder name/);
  assert.doesNotThrow(() => install.installSkill({ from, target: 'claude', home }));
});

test('--as renames the folder and the frontmatter together; a mismatch without it is refused', () => {
  const home = tmp();
  const from = proposal(tmp(), 'Release_Notes', { frontmatter: 'name: Release_Notes\ndescription: Does it' });
  assert.throws(() => install.installSkill({ from, target: 'agents', home, as: 'Bad Name' }), /not a valid skill folder name/);
  install.installSkill({ from, target: 'agents', home, as: 'release-notes' });
  const text = fs.readFileSync(path.join(home, '.agents', 'skills', 'release-notes', 'SKILL.md'), 'utf8');
  assert.match(text, /^name: release-notes$/m);
  assert.match(text, /^description: Does it$/m);

  const mismatch = proposal(tmp(), 'db-reset-local', { frontmatter: 'name: something-else\ndescription: Does it' });
  assert.throws(() => install.installSkill({ from: mismatch, target: 'agents', home }), /does not match the folder/);
});

test('a proposal without SKILL.md, frontmatter, name or description writes nothing', () => {
  const home = tmp();
  const empty = path.join(tmp(), 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => install.installSkill({ from: empty, target: 'agents', home }), /no SKILL\.md/);

  const bare = path.join(tmp(), 'bare');
  put(path.join(bare, 'SKILL.md'), '# no frontmatter\n');
  assert.throws(() => install.installSkill({ from: bare, target: 'agents', home }), /no frontmatter/);

  const noName = path.join(tmp(), 'no-name');
  put(path.join(noName, 'SKILL.md'), '---\ndescription: x\n---\n');
  assert.throws(() => install.installSkill({ from: noName, target: 'agents', home }), /no name/);

  const noDescription = path.join(tmp(), 'no-description');
  put(path.join(noDescription, 'SKILL.md'), '---\nname: no-description\n---\n');
  assert.throws(() => install.installSkill({ from: noDescription, target: 'agents', home }), /no description/);

  assert.equal(fs.existsSync(path.join(home, '.agents')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});

test('Claude-only frontmatter keys warn for Codex and Cursor but not for Claude', () => {
  const from = proposal(tmp(), 'release-notes', { frontmatter: 'name: release-notes\ndescription: Does it\nwhen_to_use: when releasing' });
  const forAgents = install.installSkill({ from, target: 'agents', home: tmp(), now: NOW });
  assert.equal(forAgents.warnings.length, 1);
  assert.match(forAgents.warnings[0], /when_to_use/);
  assert.deepEqual(install.installSkill({ from, target: 'claude', home: tmp(), now: NOW }).warnings, []);
});

test('the ninth generated skill for a tool warns; other tools are counted separately', () => {
  const home = tmp();
  const source = tmp();
  for (let i = 0; i < 8; i++) install.installSkill({ from: proposal(source, `skill-${i}`), target: 'agents', home, now: NOW });
  const ninth = install.installSkill({ from: proposal(source, 'skill-8'), target: 'agents', home, now: NOW });
  assert.match(ninth.warnings.join(' '), /8 generated skills are already installed for agents/);
  const other = install.installSkill({ from: proposal(source, 'skill-9'), target: 'cursor', home, now: NOW });
  assert.deepEqual(other.warnings, []);
});

test('self installs the miner as a skill with its scripts, minus the tests', () => {
  const home = tmp();
  const r = install.installSelf({ target: 'agents', home });
  assert.equal(r.path, path.join(home, '.agents', 'skills', 'skill-miner'));
  assert.ok(fs.existsSync(path.join(r.path, 'SKILL.md')));
  for (const f of ['mine.js', 'prune.js', 'install.js', 'live-hook.js', path.join('lib', 'text.js'), path.join('lib', 'sources.js')]) {
    assert.ok(fs.existsSync(path.join(r.path, 'scripts', f)), f);
  }
  assert.deepEqual(fs.readdirSync(path.join(r.path, 'scripts')).filter(f => f.endsWith('.test.js')), []);
  assert.throws(() => install.installSelf({ target: 'agents', home }), /already exists/);
  assert.doesNotThrow(() => install.installSelf({ target: 'agents', home, replace: true }));
});

test('the installed copy of the scripts runs from where it was put', () => {
  const home = tmp();
  const r = install.installSelf({ target: 'cursor', home });
  const run = spawnSync(process.execPath, [path.join(r.path, 'scripts', 'prune.js'), '--help'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.doesNotMatch(run.stderr, /Cannot find module/);
});

test('hooks: a dry run prints the merged file and writes nothing', () => {
  const home = tmp();
  const script = '/tools/skill-miner/scripts/live-hook.js';
  const resolved = path.resolve(script).replaceAll(path.sep, '/');
  const r = install.installHooks({ tool: 'cursor', home, script });
  assert.equal(r.applied, false);
  assert.equal(fs.existsSync(r.file), false);
  const doc = JSON.parse(r.text);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.hooks.beforeSubmitPrompt, [{ command: `node "${resolved}" --tool cursor`, timeout: 10 }]);
});

test('hooks: Codex nests the handler under the event', () => {
  const home = tmp();
  const script = '/tools/skill-miner/scripts/live-hook.js';
  const resolved = path.resolve(script).replaceAll(path.sep, '/');
  const r = install.installHooks({ tool: 'codex', home, apply: true, script });
  assert.equal(r.file, path.join(home, '.codex', 'hooks.json'));
  assert.deepEqual(read(r.file).hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: `node "${resolved}" --tool codex` }] },
  ]);
});

test('hooks: other hooks are kept, a backup is made, and applying twice changes nothing', () => {
  const home = tmp();
  const file = put(
    path.join(home, '.cursor', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: './audit.sh' }], stop: [{ command: './done.sh' }] } }),
  );
  const script = path.join(home, 'live-hook.js');
  const first = install.installHooks({ tool: 'cursor', home, apply: true, script });
  assert.equal(first.backup, `${file}.skill-miner.bak`);
  assert.deepEqual(read(first.backup).hooks.beforeSubmitPrompt, [{ command: './audit.sh' }]);

  const after = read(file);
  assert.equal(after.hooks.beforeSubmitPrompt.length, 2);
  assert.equal(after.hooks.beforeSubmitPrompt[0].command, './audit.sh');
  assert.deepEqual(after.hooks.stop, [{ command: './done.sh' }]);

  const before = fs.readFileSync(file, 'utf8');
  install.installHooks({ tool: 'cursor', home, apply: true, script });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('hooks: a moved script updates the entry in place instead of adding a second', () => {
  const home = tmp();
  install.installHooks({ tool: 'codex', home, apply: true, script: '/old/skill-miner/scripts/live-hook.js' });
  install.installHooks({ tool: 'codex', home, apply: true, script: '/new/skill-miner/scripts/live-hook.js' });
  const list = read(path.join(home, '.codex', 'hooks.json')).hooks.UserPromptSubmit;
  assert.equal(list.length, 1);
  assert.match(list[0].hooks[0].command, /\/new\/skill-miner/);
});

test('hooks: a file that is not valid JSON, or not an object, is left exactly as it was', () => {
  const home = tmp();
  const file = put(path.join(home, '.cursor', 'hooks.json'), '{ not json');
  assert.throws(() => install.installHooks({ tool: 'cursor', home, apply: true }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.equal(fs.existsSync(`${file}.skill-miner.bak`), false);

  fs.writeFileSync(file, '[]');
  assert.throws(() => install.installHooks({ tool: 'cursor', home, apply: true }), /not an object/);
  assert.equal(fs.readFileSync(file, 'utf8'), '[]');
});

test('hooks: backslashes in a Windows script path become forward slashes in the command', () => {
  const { value } = install.hookEntry('cursor', 'C:\\Users\\me\\.agents\\skills\\skill-miner\\scripts\\live-hook.js');
  assert.equal(value.command, 'node "C:/Users/me/.agents/skills/skill-miner/scripts/live-hook.js" --tool cursor');
});

test('hooks: an unknown tool is refused', () => {
  assert.throws(() => install.hookEntry('windsurf', '/x/live-hook.js'), /unknown tool/);
});

test('the command line prints what it did and exits non-zero on a refusal', () => {
  const home = tmp();
  const from = proposal(tmp(), 'release-notes');
  const run = (...argv) => spawnSync(process.execPath, [path.join(__dirname, 'install.js'), ...argv], { encoding: 'utf8' });

  const ok = run('skill', '--from', from, '--target', 'agents', '--home', home);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /installed release-notes for agents/);

  const again = run('skill', '--from', from, '--target', 'agents', '--home', home);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);

  assert.equal(run('hooks', '--tool', 'windsurf', '--home', home).status, 1);
  assert.equal(run('nonsense').status, 1);
});
