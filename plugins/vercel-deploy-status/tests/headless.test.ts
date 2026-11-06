import { expect, mock, test } from 'claude-code/testing'

// Headless (-p, SDK): no poll loop and no pane. The gate is `=== false`, so a
// host that omits the field is still treated as a person at the prompt.
test('headless session starts no poll loop', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: '{"projectName":"demo"}' }) as never)
  let polls = 0
  on('clock.every', () => { polls += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  expect(polls).toBe(0)
})

// Positive control: the same stubs reach the poll loop when a person is there.
test('interactive session starts the poll loop', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: '{"projectName":"demo"}' }) as never)
  on('clock.now', () => ({ value: 1_000_000 }) as never)
  let polls = 0
  on('clock.every', () => { polls += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  expect(polls).toBe(1)
})
