import { expect, mock, test } from 'claude-code/testing'

// Headless (-p, SDK): no pane, no /diagram command, no MCP tools. The control test
// runs last in this file, so the module-level flag is left false for other files.
function wire(on: any, counts: { open: number; command: number; tool: number }) {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => { counts.open += 1; return { value: undefined } })
  on('command.register', () => { counts.command += 1; return { value: undefined } })
  on('tool.register', () => { counts.tool += 1; return { value: undefined } })
}

test('headless session opens no pane and registers no command or tool', async ($, on) => {
  const counts = { open: 0, command: 0, tool: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })

  expect(counts.open).toBe(0)
  expect(counts.command).toBe(0)
  expect(counts.tool).toBe(0)
})

// Positive control: the same stubs open the pane, add /diagram and register both tools.
test('interactive session opens the pane and registers the command and tools', async ($, on) => {
  const counts = { open: 0, command: 0, tool: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })

  expect(counts.open).toBe(1)
  expect(counts.command).toBe(1)
  expect(counts.tool).toBe(2)
})
