'use strict';
// Run: node --test scripts/prune.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prune = require('./prune.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const iso = ms => new Date(ms).toISOString();

function line(o) {
  return JSON.stringify(o) + '\n';
}

function skillCall(at, skill) {
  return line({ type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
}

function slash(at, name) {
  return line({ type: 'user', timestamp: iso(at), message: { content: `<command-name>${name}</command-name><command-args></command-args>` } });
}

function prompt(at, text) {
  return line({ type: 'user', timestamp: iso(at), message: { content: text } });
}

// A home with three generated skills: one invoked, one never, one installed yesterday; and a
// fourth skill the person wrote by hand, which the pruner must not touch.
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-miner-prune-'));
  const skills = path.join(dir, 'skills');
  const state = path.join(dir, 'skill-miner');
  const root = path.join(dir, 'projects');
  const mk = (name, generated, description) => {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
    if (generated) fs.writeFileSync(path.join(skills, name, 'PROVENANCE.md'), 'target: skill\n');
  };
  mk('release-notes', true, 'Drafts release notes from merged PRs');
  mk('db-reset-local', true, 'Resets the local database the way the person does it');
  mk('pr-checklist', true, 'Checks a PR against the person\'s list');
  mk('handwritten', false, 'Not generated');

  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, 'installed.json'),
    JSON.stringify({
      installed: [
        { name: 'release-notes', target: 'skill', path: path.join(skills, 'release-notes'), runDate: '2026-08-01', installedAt: iso(NOW - 40 * DAY) },
        { name: 'db-reset-local', target: 'skill', path: path.join(skills, 'db-reset-local'), runDate: '2026-08-01', installedAt: iso(NOW - 40 * DAY) },
        { name: 'pr-checklist', target: 'skill', path: path.join(skills, 'pr-checklist'), runDate: '2026-10-01', installedAt: iso(NOW - 1 * DAY) },
        { name: 'a-memory', target: 'memory', path: 'x', runDate: '2026-08-01', installedAt: iso(NOW - 40 * DAY) },
      ],
    }),
  );

  const project = path.join(root, 'D--Projects-shop-web');
  fs.mkdirSync(path.join(project, 'subagents'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    const at = NOW - (30 - i * 2) * DAY;
    let body = prompt(at, 'add a test for the parser');
    if (i === 3) body += skillCall(at + 1000, 'release-notes');
    if (i === 7) body += slash(at + 1000, 'release-notes');
    if (i === 8) body += slash(at + 1000, '/clear') + skillCall(at + 2000, 'some-plugin:db-reset-local');
    fs.writeFileSync(path.join(project, `s${i}.jsonl`), body);
  }
  // A subagent transcript counts for triggers, not for sessions.
  fs.writeFileSync(path.join(project, 'subagents', 'agent-1.jsonl'), skillCall(NOW - 2 * DAY, 'release-notes'));

  return { dir, skills, state, root };
}

test('tells never-triggered generated skills from used, new and handwritten ones', async () => {
  const h = home();
  const opts = prune.options({ root: h.root, skills: h.skills, state: h.state, now: iso(NOW), 'grace-sessions': '10', 'grace-days': '14' });

  const skills = prune.generatedSkills(opts);
  assert.deepEqual(skills.map(s => s.name), ['release-notes', 'db-reset-local', 'pr-checklist']);

  const scan = await prune.scanTriggers(opts.root, new Set(skills.map(s => s.name)), NOW - 40 * DAY);
  assert.equal(scan.sessions.length, 12);
  assert.equal(scan.files, 13);

  const rows = prune.assess(skills, scan, opts);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(byName['release-notes'].status, 'used');
  assert.equal(byName['release-notes'].triggered, 3);
  assert.equal(byName['release-notes'].triggerSessions, 3);
  assert.equal(byName['release-notes'].lastTriggered, iso(NOW - 2 * DAY));
  // A plugin skill of the same bare name is not this skill.
  assert.equal(byName['db-reset-local'].status, 'never');
  assert.equal(byName['db-reset-local'].sessionsSince, 12);
  assert.equal(byName['pr-checklist'].status, 'too-new');
  assert.equal(byName['pr-checklist'].sessionsSince, 0);

  const md = prune.renderReport({ generatedAt: iso(NOW), window: { since: iso(NOW - 40 * DAY), files: 13, sessions: 12, graceDays: 14, graceSessions: 10 }, skills: rows });
  assert.match(md, /## Prune candidates \(1\)/);
  assert.match(md, /- `db-reset-local` — Resets the local database/);
  assert.match(md, /--remove db-reset-local/);
  assert.match(md, /Too new to judge: `pr-checklist`/);
});

test('a skill folder with a PROVENANCE.md counts even when the ledger forgot it', () => {
  const h = home();
  fs.writeFileSync(path.join(h.state, 'installed.json'), JSON.stringify({ installed: [] }));
  const opts = prune.options({ root: h.root, skills: h.skills, state: h.state, now: iso(NOW) });

  const names = prune.generatedSkills(opts).map(s => s.name).sort();
  assert.deepEqual(names, ['db-reset-local', 'pr-checklist', 'release-notes']);
});

test('remove moves the folder aside, marks it pruned and records the decision', () => {
  const h = home();
  const opts = prune.options({ root: h.root, skills: h.skills, state: h.state, now: iso(NOW) });

  const moved = prune.remove(['db-reset-local', 'nope', '../escape'], opts);
  assert.equal(moved[0].status, 'moved');
  assert.equal(moved[1].status, 'already gone');
  assert.match(moved[2].status, /skipped/);

  assert.equal(fs.existsSync(path.join(h.skills, 'db-reset-local')), false);
  assert.equal(fs.existsSync(path.join(h.state, 'pruned', '2026-10-08', 'db-reset-local', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(h.skills, 'release-notes', 'SKILL.md')), true);

  const ledger = JSON.parse(fs.readFileSync(path.join(h.state, 'installed.json'), 'utf8'));
  assert.equal(ledger.installed.find(e => e.name === 'db-reset-local').prunedAt, iso(NOW));
  assert.equal(ledger.installed.find(e => e.name === 'release-notes').prunedAt, undefined);

  const decisions = JSON.parse(fs.readFileSync(path.join(h.state, 'decisions.json'), 'utf8'));
  assert.deepEqual(decisions.decisions, [{ name: 'db-reset-local', runDate: '2026-08-01', target: 'skill', decision: 'pruned', at: iso(NOW) }]);

  // Pruned, it is no longer a generated skill to assess.
  assert.deepEqual(prune.generatedSkills(opts).map(s => s.name), ['release-notes', 'pr-checklist']);
});
