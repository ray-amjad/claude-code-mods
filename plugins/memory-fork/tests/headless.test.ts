import { expect, mock, test } from 'claude-code/testing'

// Headless (-p, SDK): no memory pane is opened. The write pipeline is left alone.
// The gate is `=== false`, so a host that omits the field still gets the pane.
test('headless session opens no memory pane and registers no /memory-fork', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let commands = 0
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  let panes = 0
  on('ui.open', () => { panes += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  expect(panes).toBe(0)
  expect(commands).toBe(0)
})

// Positive control: the same stubs open the pane when a person is there.
test('interactive session opens the memory pane', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  let panes = 0
  on('ui.open', () => { panes += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  expect(panes).toBe(1)
})
