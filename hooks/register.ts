import type { Register } from 'claude-code'

// Same patterns as scripts/mine.js. That file is CommonJS and cannot be imported
// from an ES hooks module, so a change to one must be mirrored in the other.
const CORRECTION_START =
  /^(no\b|nope\b|don'?t\b|dont\b|do not\b|stop\b|wrong\b|not (that|this|like)\b|actually\b|instead\b|you (missed|forgot|broke|didn'?t)\b|why (did|do) you\b|never\b|always\b|please (don'?t|dont|stop|use)\b|that'?s (wrong|not)\b)/i
const CORRECTION_ANYWHERE =
  /\b(instead of|i said|i told you|not what i|you should(n'?t| not)|stop (doing|using)|(don'?t|dont|do not) (use|create|add|change|touch|break|need))\b/i
const PASTED_LOG =
  /(\bat [A-Z][\w.`]+\(|Exception:|Traceback \(most recent|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b[\s\S]*\b\d{2}:\d{2}:\d{2}\b|Waited \d+s · Ran in|^\s*[{[]\s*")/m

const STORE_KEY = 'corrections'
const COMMAND = 'corrections'
const MAX_RECORDS = 500
const MAX_TEXT = 300
const LIST_DEFAULT = 20

export type Why = 'after-interrupt' | 'opening' | 'phrase'

export type Correction = {
  text: string
  key: string
  why: Why
  project: string
  sessionId: string
  at: number
}

// Pastes arrive already expanded in e.text, so the blocks are stripped here as
// mine.js strips them from the transcript: only the person's own words count.
export function humanText(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, ' ')
    .replace(/<(system-reminder|session-context)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, ' ')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function classify(text: string, afterInterrupt: boolean): Why | undefined {
  if (text === '' || text.startsWith('/') || PASTED_LOG.test(text)) return undefined
  if (afterInterrupt) return 'after-interrupt'
  if (CORRECTION_START.test(text)) return 'opening'
  if (CORRECTION_ANYWHERE.test(text)) return 'phrase'
  return undefined
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function isRecord(value: unknown): value is Correction {
  return typeof value === 'object' && value !== null && typeof (value as Correction).text === 'string'
}

function asList(value: unknown): Correction[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function when(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function report(list: Correction[], now: number, limit = LIST_DEFAULT): string {
  if (list.length === 0) {
    return 'No corrections noticed yet. They are recorded as you type them; this list is local to this machine.'
  }
  const counts = new Map<string, { n: number; text: string }>()
  for (const c of list) {
    const seen = counts.get(c.key)
    if (seen) seen.n += 1
    else counts.set(c.key, { n: 1, text: c.text })
  }
  const repeated = [...counts.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n)
  const lines: string[] = [`${list.length} corrections noticed, ${counts.size} distinct.`]
  if (repeated.length > 0) {
    lines.push('', 'Repeated:')
    for (const c of repeated.slice(0, 10)) lines.push(`  ${c.n}×  ${c.text.slice(0, 120)}`)
  }
  lines.push('', `Recent (${Math.min(limit, list.length)} of ${list.length}):`)
  for (const c of list.slice(-limit).reverse()) {
    lines.push(`  [${when(c.at, now)}] ${c.project} · ${c.why}: ${c.text.slice(0, 120)}`)
  }
  lines.push('', `Run /skill-miner:mine to turn repeats into proposals; /${COMMAND} clear forgets this list.`)
  return lines.join('\n')
}

export const register: Register = on => {
  let afterInterrupt = false
  let inSession = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'skill-miner: corrections noticed while you type, across sessions',
      argumentHint: '[clear]',
    })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'aborted') afterInterrupt = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isTyped || e.turnId !== undefined) return next(e)

    const text = humanText(e.text)
    const why = classify(text, afterInterrupt)
    afterInterrupt = false
    if (why === undefined) return next(e)

    const [now, root, sessionId] = await Promise.all([$.clock.now(), $.session.root(), $.session.id()])
    const record: Correction = {
      text: text.slice(0, MAX_TEXT),
      key: normalize(text),
      why,
      project: basename(root),
      sessionId,
      at: now,
    }
    const list = [...asList(await $.store.get(STORE_KEY)), record].slice(-MAX_RECORDS)
    await $.store.set(STORE_KEY, list)

    inSession += 1
    $.ui.status(`${inSession} correction${inSession === 1 ? '' : 's'} noticed this session`)

    const repeats = list.filter(c => c.key === record.key).length
    if (repeats >= 2) {
      $.ui.toast(`You have corrected this ${repeats} times. /${COMMAND} lists it; /skill-miner:mine can make it a rule.`)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await $.store.delete(STORE_KEY)
      inSession = 0
      $.ui.status(undefined)
      return { text: 'Forgot every noticed correction.' }
    }
    const [list, now] = await Promise.all([$.store.get(STORE_KEY), $.clock.now()])
    return { text: report(asList(list), now) }
  })
}
