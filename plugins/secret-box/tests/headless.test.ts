import { expect, test } from 'claude-code/testing'

// Headless (-p, SDK): no request_secret tool, since there is no one to paste into the box.
// Redaction and the .env guard still run there, so they are not tested as gated here.
function wire(on: any, counts: { tool: number }) {
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => { counts.tool += 1; return { value: undefined } })
  on('fs.exists', () => ({ value: false }))
}

test('headless session registers no request_secret tool', async ($, on) => {
  const counts = { tool: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: null, isInteractive: false })

  expect(counts.tool).toBe(0)
})

// Positive control: the same stubs register the request_secret tool in an interactive session.
test('interactive session registers the request_secret tool', async ($, on) => {
  const counts = { tool: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })

  expect(counts.tool).toBe(1)
})

// The desktop app and the editors start the session headless and attach their surface after (#24)
test('a session the desktop app attaches to registers the request_secret tool', async ($, on) => {
  const counts = { tool: 0 }
  wire(on, counts)
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/nowhere', surface: null, isInteractive: false })
  expect(counts.tool).toBe(0)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(counts.tool).toBe(1)
})
