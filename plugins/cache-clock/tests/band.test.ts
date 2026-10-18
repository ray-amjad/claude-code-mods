import { expect, mock, test } from 'claude-code/testing'

import { handoffPath, lastLines, pickAction, tailCommand } from '../hooks/register'

test('the band draws one line', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
})

// Another mod's band (vercel-deploy-status, say) sits behind cache-clock in the chain
test('the band draws the other mods\' bands under it', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  let rows = -1
  on('ui.render', { component: 'AbovePrompt' }, (_$, e: any) => {
    rows = e.props.maxRows
    return { type: 'Text', children: ['other band'] } as never
  })
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /other band/ } as any)).toBeDefined()
  expect(rows).toBe(9)
})

const BAND = { plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any
const MIN = 60_000
// The band's first piece: '◷ cache 10:00 left'
async function cachePiece($: any) {
  const text = (await (await $.ui.mount(BAND)).find({ type: 'Text', text: /◷/ } as any))?.text
  return String(text).split('  ·  ')[0]
}

for (const [command, args] of [['recap', ''], ['btw', 'what word did you reply with?']]) {
  test(`/${command} restarts the main cache clock, though no turn.step fires for it (#15)`, async ($, on) => {
    let now = 1_000_000
    on('clock.now', () => ({ value: now }))
    on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
    on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
    on('command.run', () => ({ text: 'side answer' }))

    // Before any main request there is nothing cached to keep warm
    await $.command.run({ command, args } as any)
    expect(await cachePiece($)).toBe('◷ cache: no request yet')

    // A main turn starts the hour; 50 minutes later 10 are left
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of step);
    now += 50 * MIN
    expect(await cachePiece($)).toBe('◷ cache 10:00 left')

    // The side request reads the cache: a full hour again
    await $.command.run({ command, args } as any)
    expect(await cachePiece($)).toBe('◷ cache 60:00 left')
  })
}

test('a side request on a cold cache, or a bare /btw, leaves the clock alone', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
  on('command.run', () => ({ text: 'ok' }))
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
  for await (const _ of step);
  now += 50 * MIN
  await $.command.run({ command: 'btw', args: '  ' } as any)
  expect(await cachePiece($)).toBe('◷ cache 10:00 left')
  now += 20 * MIN
  await $.command.run({ command: 'recap', args: '' } as any)
  expect(await cachePiece($)).toBe('◷ cache cold')
})

test('another command leaves the cache clock alone', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
  on('command.run', () => ({ text: 'ok' }))
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
  for await (const _ of step);
  now += 50 * MIN
  await $.command.run({ command: 'cost', args: '' } as any)
  expect(await cachePiece($)).toBe('◷ cache 10:00 left')
})

test('the warning action comes from the env var, then the old switch, then the setting', async () => {
  expect(pickAction(undefined, undefined, undefined)).toBe('handoff')
  expect(pickAction(undefined, undefined, 'off')).toBe('off')
  expect(pickAction(undefined, '0', 'handoff')).toBe('off')
  expect(pickAction('handoff', '0', 'off')).toBe('handoff')
  // compact is gone (Claude Code's idle compaction does it); an old saved value means off
  expect(pickAction(undefined, undefined, 'compact')).toBe('off')
  expect(pickAction('compact', undefined, 'handoff')).toBe('off')
  expect(pickAction('nonsense', undefined, undefined)).toBe('handoff')
})

test('each session gets its own handoff note', async () => {
  expect(handoffPath('/w/proj', '1a2b3c4d-5e6f-7a8b-9c0d-ef0123456789')).toBe('/w/proj/HANDOFF-1a2b3c4d.md')
  expect(handoffPath('/w/notes/', '9f8e7d6c-0000')).toBe('/w/notes/HANDOFF-9f8e7d6c.md')
})

test('a Windows handoff folder with a trailing backslash gets one separator', async () => {
  expect(handoffPath('C:\\proj\\', '1a2b3c4d-0000')).toBe('C:\\proj/HANDOFF-1a2b3c4d.md')
})

test('lastLines takes the end of LF and CRLF text, like tail -n', async () => {
  expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\r\nb\r\nc\r\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\nb', 5)).toEqual(['a', 'b'])
  expect(lastLines('', 3)).toEqual([])
})

test('tail reads the end on Mac and Linux; PowerShell on Windows, with the path in an env var', async () => {
  expect(tailCommand(false, '/t/s.jsonl')).toEqual([['tail', '-n', '300', '/t/s.jsonl'], {}])
  const path = "C:\\Users\\U\\.claude\\projects\\p\\a'b.jsonl"
  const [argv, init] = tailCommand(true, path)
  expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(argv[4]).not.toContain(path)
  expect(init).toEqual({ env: { CACHE_CLOCK_FILE: path } })
})

// Headless (-p, SDK): no band timer and no /cache-clock command. The timer is
// what would submit handoff turns, so it must not exist without a person.
test('headless session starts no timer and no command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  expect(timers).toBe(0)
  expect(commands).toBe(0)
})

// Positive control: the same probes fire in an interactive session, so the
// headless test above cannot pass just because the event names are wrong.
test('interactive session starts the timer and the command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: 0 } }) as never)
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  expect(timers).toBe(1)
  expect(commands).toBe(1)
})

// classic.SessionStart fires before session.start, so it must not read the
// transcript itself: in a headless session that read is a wasted tail/PowerShell spawn
for (const isInteractive of [false, true]) {
  test(`${isInteractive ? 'interactive' : 'headless'} session ${isInteractive ? 'reads' : 'never reads'} the transcript at start`, async ($: any, on) => {
    mock.store(on, {})
    mock.env(on, {})
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('clock.every', () => ({ value: undefined }) as never)
    on('clock.now', () => ({ value: 1_000_000 }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    let runs = 0
    on('process.run', () => { runs += 1; return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
    on('classic.SessionStart', () => ({}) as never)
    await $.classic.SessionStart({ transcript_path: '/nowhere/t.jsonl' })
    await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive })
    expect(runs).toBe(isInteractive ? 1 : 0)
  })
}
