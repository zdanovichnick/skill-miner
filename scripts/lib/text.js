'use strict';
// Text and path helpers shared by the miner, the pruner, the installer and the live hook.
// Nothing here knows which tool wrote a transcript.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORRECTION_START =
  /^(no\b|nope\b|don'?t\b|dont\b|do not\b|stop\b|wrong\b|not (that|this|like)\b|actually\b|instead\b|you (missed|forgot|broke|didn'?t)\b|why (did|do) you\b|never\b|always\b|please (don'?t|dont|stop|use)\b|that'?s (wrong|not)\b)/i;
const CORRECTION_ANYWHERE =
  /\b(instead of|i said|i told you|not what i|you should(n'?t| not)|stop (doing|using)|(don'?t|dont|do not) (use|create|add|change|touch|break|need))\b/i;
// Pasted logs and stack traces are not instructions, and are untrusted text besides.
const PASTED_LOG =
  /(\bat [A-Z][\w.`]+\(|Exception:|Traceback \(most recent|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b[\s\S]*\b\d{2}:\d{2}:\d{2}\b|Waited \d+s · Ran in|^\s*[{[]\s*")/m;

const SKIP_HEADS = new Set(['cd', 'echo', 'sleep', 'true', 'set', 'export', 'pwd', 'clear']);
const KEPT_BASENAMES = /^(CLAUDE\.md|AGENTS\.md|README\.md|CHANGELOG\.md|SKILL\.md|Program\.cs|package\.json|pyproject\.toml|Makefile|Dockerfile|docker-compose\.ya?ml|pipeline\.ya?ml|hooks\.json|plugin\.json|settings(\.local)?\.json|appsettings(\.\w+)?\.json)$/i;

// Greedy, and an unclosed block runs to the end: pasted and harness text must never reach a
// proposal, so losing a typed line between two pastes is the cheaper mistake.
function stripContext(text) {
  return text
    .replace(/<pasted_content\b[^>]*>[\s\S]*(<\/pasted_content[^>]*>|$)/g, ' [pasted] ')
    .replace(/<(system-reminder|session-context)\b[^>]*>[\s\S]*(<\/\1[^>]*>|$)/g, ' ')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, ' ')
    .replace(/<command-(message|name|args)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Why a typed prompt reads as a correction, or undefined. afterInterrupt is true when the person
// interrupted the agent just before typing it; slash commands and pasted logs never count.
function classifyCorrection(text, afterInterrupt = false) {
  if (!text || text.startsWith('/') || PASTED_LOG.test(text)) return undefined;
  if (afterInterrupt) return 'after-interrupt';
  if (CORRECTION_START.test(text)) return 'opening';
  if (CORRECTION_ANYWHERE.test(text)) return 'phrase';
  return undefined;
}

// Two corrections worded alike share a key: case, apostrophes and punctuation do not matter.
function correctionKey(text) {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
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

// `Edit:.cs`, `Read:package.json`: the file's role, never its path.
function fileToken(verb, filePath) {
  const base = path.win32.basename(String(filePath ?? ''));
  if (KEPT_BASENAMES.test(base)) return `${verb}:${base}`;
  if (/\.(cs|fs)proj$/i.test(base)) return `${verb}:.csproj`;
  const ext = path.extname(base).toLowerCase();
  return `${verb}:${ext || base || '?'}`;
}

// `C:\Projects\shop-web` and `/home/me/shop-web` both flatten the way Claude Code names its
// project folders, so one project reads the same whichever tool the session ran in.
function flattenPath(p) {
  return String(p ?? '').replace(/[:\\/]/g, '-').replace(/[^\w.-]/g, '-');
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = {
  CORRECTION_START,
  CORRECTION_ANYWHERE,
  PASTED_LOG,
  stripContext,
  classifyCorrection,
  correctionKey,
  commandHeads,
  normalizeCommand,
  fileToken,
  flattenPath,
  expandHome,
  walk,
  parseArgs,
  readJson,
};
