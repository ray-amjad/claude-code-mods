import { expect, mock, test } from 'claude-code/testing'

const BAND = { plugin: 'vercel-deploy-status', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as never

// Another mod's band (memory-fork, say) sits behind this one in the chain.
// While the band shows, it must still be drawn under it.
test('the band draws the other mods\' bands under it', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: '{"projectName":"demo"}' }) as never)
  on('clock.now', () => ({ value: 1_000_000 }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('clock.after', () => ({ value: { cancel() {} } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '' } }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: '' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['other band'] }) as never)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  // A push puts the band in its waiting state, so it draws
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /waiting for a deploy/ } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /other band/ } as never)).toBeDefined()
})
