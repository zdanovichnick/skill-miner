import { describe, expect, mock, test } from 'claude-code/testing'

import { classify, humanText, normalize, repeats, report } from './register'
import type { Correction } from './register'

const composer = { kind: 'composer' } as const
const taskNotification = { kind: 'task-notification' } as const
const presentation = { isFullscreen: false, columns: 120 }
const none: ReadonlySet<string> = new Set()

const typed = (text: string) => ({ text, wait: false, origin: composer })

describe('classify', () => {
  test('tags an opening correction', () => {
    expect(classify("don't use npm here, this repo is pnpm", false)).toBe('opening')
    expect(classify('No, the other file', false)).toBe('opening')
  })

  test('tags a correction phrase inside a sentence', () => {
    expect(classify('run the tests with vitest instead of jest', false)).toBe('phrase')
  })

  test('tags the prompt after an interrupt whatever it says', () => {
    expect(classify('use the other branch', true)).toBe('after-interrupt')
  })

  test('skips slash commands, logs and plain prompts', () => {
    expect(classify('/skill-miner:mine', false)).toBeUndefined()
    expect(classify('no idea why:\n   at Foo.Bar(Baz.cs:12)\nException: boom', false)).toBeUndefined()
    expect(classify('add a test for the parser', false)).toBeUndefined()
    expect(classify('', false)).toBeUndefined()
  })
})

describe('humanText and normalize', () => {
  test('strips pasted blocks and harness context before matching', () => {
    const text = humanText(
      "don't do that <pasted_content id=\"x\">stop using the other thing</pasted_content> <system-reminder>never</system-reminder>",
    )
    expect(text).toBe("don't do that")
  })

  test('normalizes punctuation and case into one key', () => {
    expect(normalize("Don't use NPM here!")).toBe(normalize('dont use npm here'))
  })
})

describe('repeats', () => {
  const one: Correction = { text: 'use pnpm', key: 'use pnpm', why: 'opening', project: 'app', sessionId: 's1', at: 10 }
  const two: Correction = { ...one, text: 'Use PNPM!', project: 'kit', sessionId: 's2', at: 20 }
  const other: Correction = { ...one, text: 'use yarn', key: 'use yarn' }

  test('groups a key typed twice and leaves singles out', () => {
    expect(repeats([one, other, two], none)).toEqual([
      { key: 'use pnpm', count: 2, sessions: 2, projects: ['app', 'kit'], firstSeen: 10, lastSeen: 20, quotes: ['use pnpm', 'Use PNPM!'] },
    ])
  })

  test('leaves out keys already decided on', () => {
    expect(repeats([one, two], new Set(['use pnpm']))).toEqual([])
  })
})

describe('report', () => {
  const at = 10 * 60_000
  const one: Correction = { text: 'use pnpm', key: 'use pnpm', why: 'opening', project: 'app', sessionId: 's1', at }

  test('says when nothing was noticed', () => {
    expect(report([], none, at)).toContain('No corrections noticed yet')
  })

  test('lists repeats first and recent entries after', () => {
    const text = report([one, { ...one, sessionId: 's2', at: at + 60_000 }], none, at + 120_000)
    expect(text).toContain('2 corrections noticed, 1 distinct')
    expect(text).toContain('2×  use pnpm')
    expect(text).toContain('[1 min ago] app · opening: use pnpm')
    expect(text).toContain('/skill-miner:mine --live')
  })

  test('marks handled corrections and drops them from the repeats', () => {
    const text = report([one, { ...one, sessionId: 's2', at: at + 60_000 }], new Set(['use pnpm']), at + 120_000)
    expect(text).not.toContain('2×')
    expect(text).toContain('opening ✓: use pnpm')
  })
})

// The world beneath the mod: a store and a file system in memory the test can
// read back, the session facts, and the display calls, each answered by a bottom hook.
function world(on: Parameters<Parameters<typeof test>[1]>[1], entries: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const store = new Map<string, unknown>(Object.entries(entries))
  const disk = new Map<string, string>(Object.entries(files))
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const done = { value: undefined }
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), done))
  on('store.delete', (_, e) => (store.delete(e.key), done))
  on('session.root', () => ({ value: 'D:/Projects/app' }))
  on('session.id', () => ({ value: 'session-1' }))
  // The engine hands paths over in the platform's spelling; the disk here keeps one.
  const at = (path: string) => path.replace(/\\/g, '/')
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? 'C:/Users/me' : undefined }))
  on('fs.read', (_, e) => {
    const text = disk.get(at(e.path))
    return text === undefined ? { deny: `no such file: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => (disk.set(at(e.path), e.text), done))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), done))
  on('ui.status', (_, e) => (statuses.push(e.text), done))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', (_, e) => ({ text: `no such command: ${e.command}` }))
  const corrections = () => (store.get('corrections') as Correction[] | undefined) ?? []
  const repeatsFile = () => {
    const text = disk.get('C:/Users/me/.claude/skill-miner/live/repeats.json')
    return text === undefined ? undefined : (JSON.parse(text) as { generatedAt: string; repeats: { key: string; count: number }[] })
  }
  return { store, disk, toasts, statuses, corrections, repeatsFile }
}

const seeded = [{ text: "don't use npm here", key: 'dont use npm here', why: 'opening', project: 'kit', sessionId: 'older', at: 0 }]

describe('the mod', () => {
  test('records a typed correction and keeps the prompt flowing', async ($, on) => {
    const w = world(on)
    mock.clock(on, { now: 1_000 })

    const entered = await $.prompt.submit(typed("don't use npm here"))

    expect(entered.text).toBe("don't use npm here")
    expect(w.corrections()).toHaveLength(1)
    expect(w.corrections()[0]).toEqual(
      expect.objectContaining({ text: "don't use npm here", why: 'opening', project: 'app', sessionId: 'session-1', at: 1_000 }),
    )
    expect(w.statuses).toEqual(['1 correction noticed this session'])
    expect(w.toasts).toEqual([])
    expect(w.repeatsFile()).toBeUndefined()
  })

  test('toasts once a correction repeats, across sessions, and hands the repeats to mine.js', async ($, on) => {
    const w = world(on, { corrections: seeded })
    mock.clock(on, { now: 5_000 })

    // A different correction: its own key, no repeat yet.
    await $.prompt.submit(typed('No, use pnpm here!'))
    expect(w.corrections()).toHaveLength(2)
    expect(w.toasts).toHaveLength(0)
    expect(w.repeatsFile()).toBeUndefined()

    // The stored one again, case and punctuation aside.
    await $.prompt.submit(typed("Don't use NPM here!"))
    expect(w.corrections()).toHaveLength(3)
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('2 times')
    expect(w.toasts[0]).toContain('/skill-miner:mine --live')
    expect(w.repeatsFile()?.repeats).toEqual([
      expect.objectContaining({ key: 'dont use npm here', count: 2, sessions: 2, projects: ['kit', 'app'], quotes: ["don't use npm here", "Don't use NPM here!"] }),
    ])

    await $.prompt.submit(typed('DONT use npm here'))
    expect(w.toasts).toHaveLength(2)
    expect(w.toasts[1]).toContain('3 times')
    expect(w.repeatsFile()?.repeats[0]?.count).toBe(3)
  })

  test('stays quiet about a repeat the mine command has already decided on', async ($, on) => {
    const w = world(
      on,
      { corrections: seeded },
      { 'C:/Users/me/.claude/skill-miner/live/handled.json': JSON.stringify({ keys: ['dont use npm here'] }) },
    )
    mock.clock(on, { now: 5_000 })

    await $.prompt.submit(typed("Don't use NPM here!"))

    expect(w.corrections()).toHaveLength(2)
    expect(w.toasts).toEqual([])
    expect(w.repeatsFile()).toBeUndefined()
  })

  test('ignores prompts that are not the person typing', async ($, on) => {
    const w = world(on)
    mock.clock(on)

    await $.prompt.submit({ text: "don't use npm here", wait: false, origin: taskNotification })

    expect(w.corrections()).toEqual([])
    expect(w.statuses).toEqual([])
  })

  test('tags the prompt after an interrupted turn, then resets', async ($, on) => {
    const w = world(on)
    mock.clock(on)

    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' })
    await $.prompt.submit(typed('use the other branch'))
    await $.prompt.submit(typed('use the other branch'))

    expect(w.corrections().map(c => c.why)).toEqual(['after-interrupt'])
  })

  test("a subagent's interrupted turn does not count", async ($, on) => {
    const w = world(on)
    mock.clock(on)

    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', agentId: 'a1', reason: 'aborted' })
    await $.prompt.submit(typed('use the other branch'))

    expect(w.corrections()).toEqual([])
  })

  test('lists and clears through its command, emptying the repeats file too', async ($, on) => {
    const w = world(
      on,
      { corrections: [{ text: 'use pnpm', key: 'use pnpm', why: 'opening', project: 'app', sessionId: 's1', at: 0 }] },
      { 'C:/Users/me/.claude/skill-miner/live/repeats.json': JSON.stringify({ generatedAt: '', repeats: [{ key: 'use pnpm', count: 2 }] }) },
    )
    mock.clock(on, { now: 60_000 })
    await $.session.start({ cwd: 'D:/Projects/app', surface: 'terminal', isInteractive: true })

    const listed = await $.command.run({ command: 'corrections', args: '', origin: composer, presentation })
    expect(listed.text).toContain('1 corrections noticed')
    expect(listed.text).toContain('[1 min ago] app · opening: use pnpm')

    const cleared = await $.command.run({ command: 'corrections', args: 'clear', origin: composer, presentation })
    expect(cleared.text).toContain('Forgot')
    expect(w.store.has('corrections')).toBe(false)
    expect(w.repeatsFile()?.repeats).toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
  })
})
