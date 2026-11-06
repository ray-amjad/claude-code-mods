import { expect, mock, test } from 'claude-code/testing'

// Headless (-p, SDK): no /explain command is registered. The control test runs last
// in this file, so the module-level flag is left false for other files.
function wire(on: any, counts: { command: number }) {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => { counts.command += 1; return { value: undefined } })
}

test('headless session registers no /explain command', async ($, on) => {
  const counts = { command: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: null, isInteractive: false })

  expect(counts.command).toBe(0)
})

// Positive control: the same stubs register /explain in an interactive session.
test('interactive session registers the /explain command', async ($, on) => {
  const counts = { command: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })

  expect(counts.command).toBe(1)
})
