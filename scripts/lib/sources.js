'use strict';
// One reader per coding tool, all producing the same session shape for the miner and the pruner.
//
//   session = { id, project, date, source, prompts: [{ text, slash, at, isLog, afterInterrupt }],
//               tools: [token], shell: [normalizedCommand] }
//
// A reader returns only what the person typed and the shape of the tool calls that ran. Injected
// context (AGENTS.md, environment blocks, harness reminders), tool output and sub-agent turns are
// never returned: a skill drafted from them would carry text the person never wrote into every
// future session.
//
// Claude Code, Codex and Cursor each get a reader. Formats:
//   claude  ~/.claude/projects/<project>/<session>.jsonl, one object per line with type user|assistant
//   codex   $CODEX_HOME|~/.codex/{sessions/YYYY/MM/DD,archived_sessions}/rollout-*.jsonl[.zst], one
//           {timestamp, type, payload} object per line (openai/codex codex-rs/history, rollout)
//   cursor  ~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl, one {role, message} per line;
//           no timestamps, and tool output is not recorded

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const T = require('./text');

// zlib gained zstd in Node 22.15; older runtimes skip the compressed rollouts Codex leaves on cold sessions.
const CAN_ZSTD = typeof zlib.createZstdDecompress === 'function';

async function* readLines(file) {
  const raw = fs.createReadStream(file);
  let input = raw;
  if (file.endsWith('.zst')) {
    input = zlib.createZstdDecompress();
    raw.on('error', e => input.destroy(e));
    raw.pipe(input);
  }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } catch {
    // A truncated or unreadable file ends the read; whatever was parsed so far stands.
  } finally {
    rl.close();
    // A caller that stops early (a Codex rollout that turns out to be a sub-agent) must not leave the
    // file open until garbage collection.
    raw.destroy();
    input.destroy();
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function blankSession(id, project, source) {
  return { id, project, date: null, source, prompts: [], tools: [], shell: [], interrupted: false };
}

// Folds one typed message into the session. A leading `lead` token (a slash command or a skill
// mention) becomes `slash` and the rest of the message is the text, as for Claude's slash commands.
function addPrompt(s, text, at, lead) {
  let body = text;
  let slash = null;
  const m = lead ? lead.exec(body.trimStart()) : null;
  if (m) {
    slash = m[1];
    body = body.trimStart().slice(m[0].length);
  }
  body = T.stripContext(body);
  if (!slash && !body) return;
  const prompt = { text: body, slash, at: at ?? null, isLog: T.PASTED_LOG.test(body), afterInterrupt: s.interrupted === true };
  s.interrupted = false;
  s.prompts.push(prompt);
}

function pushTool(s, token) {
  if (s.tools[s.tools.length - 1] !== token) s.tools.push(token);
}

function mcpToken(name) {
  const [, server, tool] = name.split('__');
  return `mcp:${server}.${tool}`;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------- Claude Code

const INTERRUPTED = /^\[Request interrupted by user/;
const NOT_HUMAN_PREFIX = /^<(local-command-|task-notification|system-reminder|bash-|user-memory-input|teammate-message)/;
const NOT_HUMAN_TEXT = /^(\[Request interrupted by user|Another Claude session sent a message)/;
const SKILL_CALL = '"name":"Skill"';
const SLASH_RE = /<command-name>\/?([^<]+)<\/command-name>/g;

function claudeText(o) {
  const c = o.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
}

function claudePrompt(o) {
  if (o.isMeta || o.isCompactSummary) return null;
  const kind = o.origin?.kind;
  if (kind !== undefined && kind !== 'human') return null;
  let text = claudeText(o).trim();
  if (!text || NOT_HUMAN_PREFIX.test(text) || NOT_HUMAN_TEXT.test(text)) return null;
  if (text.startsWith('This session is being continued')) return null;

  const slash = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)?.[1]?.trim() ?? null;
  const cmdArgs = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  if (slash) text = cmdArgs;
  text = T.stripContext(text);
  if (!slash && !text) return null;
  return { text, slash, at: o.timestamp ?? null, isLog: T.PASTED_LOG.test(text) };
}

function claudeTool(name, input) {
  if (name === 'Bash' || name === 'PowerShell') {
    const heads = T.commandHeads(String(input.command ?? ''));
    return `${name}:${heads.slice(0, 2).join('+') || '?'}`;
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return T.fileToken(name, input.file_path ?? input.notebook_path);
  }
  if (name === 'Skill') return `Skill:${input.skill ?? '?'}`;
  if (name === 'Agent') return `Agent:${input.subagent_type ?? 'general'}`;
  if (name.startsWith('mcp__')) return mcpToken(name);
  return name;
}

const claude = {
  id: 'claude',
  label: 'Claude Code',
  defaultRoot: () => T.expandHome('~/.claude/projects'),
  skillsDir: () => T.expandHome('~/.claude/skills'),

  discover(root, since, { subagents = false } = {}) {
    const sub = `${path.sep}subagents${path.sep}`;
    return T.walk(root)
      .filter(f => f.endsWith('.jsonl') && (subagents || !f.includes(sub)))
      .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs, subagent: file.includes(sub) }))
      .filter(e => e.mtimeMs >= since);
  },

  async parse(entry) {
    const file = entry.file;
    const s = blankSession(path.basename(file, '.jsonl'), path.basename(path.dirname(file)), 'claude');
    for await (const line of readLines(file)) {
      const isUser = line.includes('"type":"user"');
      const isAssistant = !isUser && line.includes('"type":"assistant"') && line.includes('"tool_use"');
      if (!isUser && !isAssistant) continue;
      if (isUser && line.includes('"toolUseResult"')) continue;

      const o = parseLine(line);
      if (!o || o.isSidechain) continue;
      s.date ??= o.timestamp?.slice(0, 10) ?? null;

      if (o.type === 'user') {
        if (INTERRUPTED.test(claudeText(o).trim())) {
          s.interrupted = true;
          continue;
        }
        const prompt = claudePrompt(o);
        if (prompt) {
          prompt.afterInterrupt = s.interrupted === true;
          s.interrupted = false;
          s.prompts.push(prompt);
        }
      } else if (o.type === 'assistant') {
        for (const part of o.message?.content ?? []) {
          if (part.type !== 'tool_use') continue;
          pushTool(s, claudeTool(part.name, part.input ?? {}));
          if ((part.name === 'Bash' || part.name === 'PowerShell') && typeof part.input?.command === 'string') {
            s.shell.push(T.normalizeCommand(part.input.command));
          }
        }
      }
    }
    return s;
  },

  // Skill tool calls and typed /<name>, sub-agents included: a skill a sub-agent invoked is in use.
  async scan(entry, names) {
    const file = entry.file;
    const session = path.basename(file, '.jsonl');
    const triggers = [];
    let startedAt = null;
    for await (const line of readLines(file)) {
      const wantsSkill = line.includes(SKILL_CALL);
      const wantsSlash = line.includes('<command-name>') && line.includes('"type":"user"');
      if (startedAt !== null && !wantsSkill && !wantsSlash) continue;
      const o = parseLine(line);
      if (!o) continue;
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
    return { session, startedAt: startedAt ?? entry.mtimeMs, triggers, subagent: entry.subagent === true };
  },
};

// ------------------------------------------------------------------------------------------ Codex

// Interactive surfaces only. exec, mcp, custom and internal runs are scripted: their prompts are
// written by a program, and repeating one is not the person repeating themselves.
const CODEX_INTERACTIVE = new Set(['cli', 'vscode']);

function codexHome() {
  return process.env.CODEX_HOME ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex');
}

// A session_meta payload says whether the rollout is a person's session or something Codex spawned.
function codexSkipReason(meta) {
  if (meta.parent_thread_id) return 'subagent';
  const src = meta.source;
  if (src === undefined || src === null) return null;
  if (typeof src === 'string') return CODEX_INTERACTIVE.has(src) ? null : 'automated';
  if (typeof src === 'object') return 'subagent' in src ? 'subagent' : 'automated';
  return 'automated';
}

function safeJson(text) {
  if (typeof text !== 'string') return text && typeof text === 'object' ? text : null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const SHELL_PROGRAMS = /^(bash|sh|zsh|dash|fish|pwsh|powershell|cmd)(\.exe)?$/i;

// A tool call is a shell call when its arguments carry a command, whatever the tool is named.
function codexShellCommand(args) {
  const c = args?.command ?? args?.cmd;
  if (Array.isArray(c) && c.length > 0) {
    const argv = c.map(String);
    return SHELL_PROGRAMS.test(path.win32.basename(argv[0])) && argv.length >= 3 ? argv[argv.length - 1] : argv.join(' ');
  }
  return typeof c === 'string' && c.trim() ? c : null;
}

function codexToolCall(p) {
  if (p.type === 'local_shell_call') return { command: codexShellCommand({ command: p.action?.command }), name: 'shell' };
  if (p.type === 'function_call') {
    const args = safeJson(p.arguments);
    return { command: codexShellCommand(args), name: String(p.name ?? ''), args };
  }
  if (p.type === 'custom_tool_call') return { command: null, name: String(p.name ?? ''), input: typeof p.input === 'string' ? p.input : '' };
  return null;
}

function codexToken(call) {
  if (call.command !== null) return `Bash:${T.commandHeads(call.command).slice(0, 2).join('+') || '?'}`;
  if (call.name === 'apply_patch') return 'Edit:patch';
  if (call.name.startsWith('mcp__')) return mcpToken(call.name);
  return call.name || 'tool';
}

function codexUserText(item) {
  return (item?.content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n');
}

const codex = {
  id: 'codex',
  label: 'Codex',
  defaultRoot: () => codexHome(),
  skillsDir: () => T.expandHome('~/.agents/skills'),

  // A rollout Codex has compressed sits beside no plain copy; where both exist the plain file wins.
  discover(root, since) {
    const files = [];
    for (const sub of ['sessions', 'archived_sessions']) files.push(...T.walk(path.join(root, sub)));
    const plain = new Set(files.filter(f => /rollout-.*\.jsonl$/.test(path.basename(f))));
    return files
      .filter(f => plain.has(f) || (/rollout-.*\.jsonl\.zst$/.test(path.basename(f)) && !plain.has(f.slice(0, -4))))
      .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs, compressed: file.endsWith('.zst') }))
      .filter(e => e.mtimeMs >= since);
  },

  async parse(entry) {
    const file = entry.file;
    const stem = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
    const s = blankSession(stem, 'codex', 'codex');
    let last = { text: null, ms: NaN };
    const typed = (text, at) => {
      // Legacy rollouts persist user_message, paginated ones item_completed; a session resumed across the
      // two could record one prompt twice, a moment apart.
      const ms = Date.parse(at ?? '');
      const twice = text === last.text && (!Number.isFinite(ms) || !Number.isFinite(last.ms) || Math.abs(ms - last.ms) < 5000);
      last = { text, ms };
      if (!twice) addPrompt(s, text, at, /^\$([\w.-]+)(?=\s|$)/);
    };

    for await (const line of readLines(file)) {
      const o = parseLine(line);
      if (!o || typeof o.type !== 'string') continue;
      s.date ??= o.timestamp?.slice(0, 10) ?? null;
      const p = o.payload ?? {};

      if (o.type === 'session_meta') {
        const why = codexSkipReason(p);
        if (why) {
          s.skip = why;
          return s;
        }
        if (p.id) s.id = String(p.id);
        if (p.cwd) s.project = T.flattenPath(p.cwd);
        s.date = (p.timestamp ?? o.timestamp ?? '').slice(0, 10) || s.date;
      } else if (o.type === 'event_msg') {
        if (p.type === 'user_message' && typeof p.message === 'string') typed(p.message, o.timestamp);
        else if (p.type === 'item_completed' && p.item?.type === 'UserMessage') typed(codexUserText(p.item), o.timestamp);
        else if (p.type === 'turn_aborted' && p.reason === 'interrupted') s.interrupted = true;
      } else if (o.type === 'response_item') {
        const call = codexToolCall(p);
        if (!call) continue;
        pushTool(s, codexToken(call));
        if (call.command !== null) s.shell.push(T.normalizeCommand(call.command));
      }
    }
    return s;
  },

  // `$name` in a typed prompt, or a shell command that reads <name>/SKILL.md or runs <name>/scripts:
  // the two ways Codex itself recognises a skill being used.
  async scan(entry, names) {
    const file = entry.file;
    const session = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
    const triggers = [];
    const list = [...names];
    const quick = list.length > 0 ? new RegExp(list.map(esc).join('|')) : /$^/;
    const implicit = new Map(list.map(n => [n, new RegExp(`[\\\\/]${esc(n)}[\\\\/](SKILL\\.md|scripts[\\\\/])`, 'i')]));
    let startedAt = null;
    let subagent = false;
    for await (const line of readLines(file)) {
      if (startedAt !== null && !quick.test(line)) continue;
      const o = parseLine(line);
      if (!o) continue;
      const at = Date.parse(o.timestamp ?? '');
      if (startedAt === null && Number.isFinite(at)) startedAt = at;
      const p = o.payload ?? {};
      if (o.type === 'session_meta') {
        subagent = codexSkipReason(p) !== null;
        continue;
      }
      if (!Number.isFinite(at)) continue;
      let text = null;
      if (o.type === 'event_msg' && p.type === 'user_message') text = p.message;
      else if (o.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') text = codexUserText(p.item);
      if (typeof text === 'string') {
        for (const m of text.matchAll(/(?<![\w$])\$([\w.-]+)/g)) if (names.has(m[1])) triggers.push({ name: m[1], at, session, via: 'mention' });
        continue;
      }
      if (o.type === 'response_item') {
        const call = codexToolCall(p);
        const haystack = call ? (call.command ?? call.input ?? '') : '';
        if (!haystack) continue;
        for (const [name, re] of implicit) if (re.test(haystack)) triggers.push({ name, at, session, via: 'read' });
      }
    }
    return { session, startedAt: startedAt ?? entry.mtimeMs, triggers, subagent };
  },
};

// ----------------------------------------------------------------------------------------- Cursor

const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const CURSOR_TIME = /<timestamp>([^<]+)<\/timestamp>/;

// Cursor wraps what the person typed in <user_query>; every other tag in the message is context
// Cursor attached. Without the wrapper, well-formed tag blocks are dropped rather than trusted.
function cursorTyped(content) {
  const text = (Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '') : [String(content ?? '')]).join('\n');
  const at = CURSOR_TIME.exec(text)?.[1] ?? null;
  const wrapped = USER_QUERY.exec(text);
  const body = wrapped ? wrapped[1] : text.replace(/<([a-z][a-z0-9_]*)>[\s\S]*?<\/\1>/g, ' ');
  return { body, at: at && Number.isFinite(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null };
}

// Tool names vary by Cursor release, so a call is classified by the shape of its input.
function cursorToken(name, input) {
  const n = String(name ?? '');
  if (/mcp/i.test(n) && input?.server) return `mcp:${input.server}.${input.toolName ?? input.tool ?? '?'}`;
  if (typeof input?.command === 'string' && /shell|bash|terminal|command|exec/i.test(n)) {
    return `Bash:${T.commandHeads(input.command).slice(0, 2).join('+') || '?'}`;
  }
  const file = input?.path ?? input?.file_path ?? input?.target_file ?? input?.target_notebook;
  if (file) {
    const verb = /read|view|open/i.test(n) ? 'Read' : /write|create/i.test(n) ? 'Write' : /replace|edit|patch|delete/i.test(n) ? 'Edit' : null;
    if (verb) return T.fileToken(verb, file);
  }
  return n || 'tool';
}

function cursorProject(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('agent-transcripts');
  return i > 0 ? parts[i - 1] : 'cursor';
}

const cursor = {
  id: 'cursor',
  label: 'Cursor',
  defaultRoot: () => T.expandHome('~/.cursor/projects'),
  skillsDir: () => T.expandHome('~/.cursor/skills'),

  discover(root, since) {
    const marker = `${path.sep}agent-transcripts${path.sep}`;
    return T.walk(root)
      .filter(f => f.endsWith('.jsonl') && f.includes(marker) && !/subagent/i.test(f.slice(f.indexOf(marker))))
      .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .filter(e => e.mtimeMs >= since);
  },

  async parse(entry) {
    const file = entry.file;
    const s = blankSession(path.basename(file, '.jsonl'), cursorProject(file), 'cursor');
    for await (const line of readLines(file)) {
      const o = parseLine(line);
      if (!o) continue;
      if (o.role === 'user') {
        const { body, at } = cursorTyped(o.message?.content);
        s.date ??= (at ?? '').slice(0, 10) || null;
        addPrompt(s, body, at, /^\/([a-z][\w.-]*)(?=\s|$)/i);
      } else if (o.role === 'assistant') {
        for (const part of o.message?.content ?? []) {
          if (part?.type !== 'tool_use') continue;
          pushTool(s, cursorToken(part.name, part.input ?? {}));
          if (typeof part.input?.command === 'string' && cursorToken(part.name, part.input).startsWith('Bash:')) {
            s.shell.push(T.normalizeCommand(part.input.command));
          }
        }
      }
    }
    // The transcript has no clock of its own; a prompt without a <timestamp> is dated by the file.
    const modified = new Date(entry.mtimeMs).toISOString();
    for (const p of s.prompts) p.at ??= modified;
    s.date ??= modified.slice(0, 10);
    return s;
  },

  // A typed /<name>, or a tool call whose input names <name>/SKILL.md. Cursor transcripts carry no
  // timestamps, so a trigger is dated by the message's own <timestamp> tag when it has one, else by
  // the file's modification time.
  async scan(entry, names) {
    const file = entry.file;
    const session = path.basename(file, '.jsonl');
    const triggers = [];
    const stat = fs.statSync(file);
    const fallback = stat.mtimeMs;
    const implicit = new Map([...names].map(n => [n, new RegExp(`[\\\\/]${esc(n)}[\\\\/]SKILL\\.md`, 'i')]));
    for await (const line of readLines(file)) {
      const o = parseLine(line);
      if (!o) continue;
      if (o.role === 'user') {
        const { body, at } = cursorTyped(o.message?.content);
        const m = /^\/([a-z][\w.-]*)(?=\s|$)/i.exec(body.trimStart());
        if (m && names.has(m[1])) triggers.push({ name: m[1], at: at ? Date.parse(at) : fallback, session, via: 'slash' });
      } else if (o.role === 'assistant') {
        for (const part of o.message?.content ?? []) {
          if (part?.type !== 'tool_use') continue;
          const haystack = JSON.stringify(part.input ?? {});
          for (const [name, re] of implicit) if (re.test(haystack)) triggers.push({ name, at: fallback, session, via: 'read' });
        }
      }
    }
    return { session, startedAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : fallback, triggers, subagent: false };
  },
};

// --------------------------------------------------------------------------------------- registry

const SOURCES = { claude, codex, cursor };

// Skill folders each tool loads. Cursor reads the Claude and Codex ones too, so use there counts.
const SKILL_TARGETS = {
  claude: { dir: () => T.expandHome('~/.claude/skills'), loadedBy: ['claude', 'cursor'], label: 'Claude Code (and Cursor)' },
  agents: { dir: () => T.expandHome('~/.agents/skills'), loadedBy: ['codex', 'cursor'], label: 'Codex and Cursor' },
  cursor: { dir: () => T.expandHome('~/.cursor/skills'), loadedBy: ['cursor'], label: 'Cursor' },
};

// `--source auto` (the default) takes every tool whose transcript folder exists; a name list or
// `all` is taken as given, and a missing folder is reported rather than silently skipped.
function resolve(spec, args = {}) {
  const roots = {
    claude: args.root ? T.expandHome(args.root) : claude.defaultRoot(),
    codex: args['codex-root'] ? T.expandHome(args['codex-root']) : codex.defaultRoot(),
    cursor: args['cursor-root'] ? T.expandHome(args['cursor-root']) : cursor.defaultRoot(),
  };
  const wanted = spec === 'auto' ? Object.keys(SOURCES) : spec === 'all' ? Object.keys(SOURCES) : String(spec).split(',').map(x => x.trim()).filter(Boolean);
  const picks = [];
  for (const id of wanted) {
    if (!SOURCES[id]) throw new Error(`unknown source "${id}" (expected claude, codex, cursor, all or auto)`);
    const present = fs.existsSync(roots[id]);
    if (spec === 'auto' && !present) continue;
    picks.push({ id, source: SOURCES[id], root: roots[id], present });
  }
  return picks;
}

module.exports = { SOURCES, SKILL_TARGETS, CAN_ZSTD, resolve, readLines, codexSkipReason };
