import { expect, mock, test } from 'claude-code/testing'

// Headless (-p, SDK): no status line and no bounce toast, but the drop still happens.
// The gate is `=== false`, so a host that omits the field keeps the UI.
function wire(on: Parameters<typeof mock.env>[0], counts: { status: number; toast: number }) {
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.status', () => { counts.status += 1; return { value: undefined } as never })
  on('ui.toast', () => { counts.toast += 1; return { value: undefined } as never })
}

test('headless session draws no status and no bounce toast, but still drops a vague prompt', async ($, on) => {
  const counts = { status: 0, toast: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  const r = await $.prompt.submit({ text: 'fix the thing' })

  expect(counts.status).toBe(0)
  expect(counts.toast).toBe(0)
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
})

// Positive control: the same stubs draw the status and the toast when a person is there.
test('interactive session draws the status and the bounce toast', async ($, on) => {
  const counts = { status: 0, toast: 0 }
  wire(on, counts)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: 'fix the thing' })

  expect(counts.status).toBe(1)
  expect(counts.toast).toBe(1)
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
})
