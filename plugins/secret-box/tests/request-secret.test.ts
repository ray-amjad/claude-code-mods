import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__secret-box__request_secret'
const DUMMY = 'TEST_DUMMY_' + '123'

type Answer = { deny?: string; result?: unknown }
const ask = async ($: any, input: Record<string, unknown>) =>
  (await $.tool.call({ tool: TOOL, reason: 'test', ...input } as never)) as Answer

// Stand in for the engine around the box, on a Unix host: `sleep` is the
// pause (WAITS is tested on its own), and with `noPause` nothing can wait.
// `git` answers check-ignore with `ignoredExit` and ls-files with
// `trackedExit` (1: not tracked). Each pause calls `onPause(n)`, where a test
// plays the person.
function host(on: any, opts: { ignoredExit?: number; trackedExit?: number; noPause?: boolean; root?: string; onPause?: (n: number) => Promise<void> } = {}) {
  const files: Record<string, string> = {}
  // The engine hands paths in the host's own form (C:\repo\.env on Windows)
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  let clock = 1_000
  let pauses = 0
  on('env.get', () => ({ value: 'Linux' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.cwd', () => ({ value: '/repo' }))
  // The project root; a test moves it away from the cwd with `root`
  on('session.root', () => ({ value: opts.root ?? '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: key(e.path) in files }))
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: files[key(e.path)] ?? '' }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'git') {
      const exitCode = e.argv[1] === 'ls-files' ? opts.trackedExit ?? 1 : opts.ignoredExit ?? 1
      return { value: { exitCode, stdout: '', stderr: '' } }
    }
    if (opts.noPause) throw new Error('nothing starts')
    clock += 1_000
    await opts.onPause?.(++pauses)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  return { files, advance: (ms: number) => (clock += ms) }
}

// The person types into the box and presses Enter
async function typeAndSave($: any, text: string) {
  const ui = await $.ui.mount({
    plugin: 'secret-box',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'secret-box',
    props: { title: 'secret-box', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
  })
  await ui.input({ key: 'secret', text, kind: 'change' } as never)
  await ui.input({ key: 'secret', text: '•'.repeat(text.length) } as never)
}

test('the box saves to .env and answers with a placeholder', async ($, on) => {
  const h = host(on, { onPause: (n) => (n === 1 ? typeAndSave($, DUMMY) : Promise.resolve()) })
  const r = await ask($, { name: 'DUMMY_KEY' });
  expect(String(r.result)).toMatch(/saved to \/repo\/\.env/)
  expect(String(r.result)).toMatch(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)
  expect(String(r.result)).not.toContain(DUMMY)
  expect(h.files['/repo/.env']).toBe(`DUMMY_KEY=${DUMMY}\n`)
})

test('the key goes to the project root, not to the folder the shell has cd-ed into', async ($, on) => {
  const h = host(on, { root: '/proj', onPause: (n) => (n === 1 ? typeAndSave($, DUMMY) : Promise.resolve()) })
  const r = await ask($, { name: 'DUMMY_KEY' })
  expect(String(r.result)).toMatch(/saved to \/proj\/\.env/)
  expect(h.files['/proj/.env']).toBe(`DUMMY_KEY=${DUMMY}\n`)
  expect(h.files['/repo/.env']).toBe(undefined)
})

test('file: .env.local is written and added to .gitignore when git does not ignore it', async ($, on) => {
  const h = host(on, { ignoredExit: 1, onPause: (n) => (n === 1 ? typeAndSave($, DUMMY) : Promise.resolve()) })
  const r = await ask($, { name: 'DUMMY_KEY', file: '.env.local' })
  expect(String(r.result)).toMatch(/saved to \/repo\/\.env\.local \(and added \.env\.local to \/repo\/\.gitignore\)/)
  expect(h.files['/repo/.env.local']).toBe(`DUMMY_KEY=${DUMMY}\n`)
  expect(h.files['/repo/.env']).toBe(undefined)
  expect(h.files['/repo/.gitignore']).toBe('.env.local\n')
})

test('a file git already ignores leaves .gitignore alone', async ($, on) => {
  const h = host(on, { ignoredExit: 0, onPause: (n) => (n === 1 ? typeAndSave($, DUMMY) : Promise.resolve()) })
  await ask($, { name: 'DUMMY_KEY', file: '.env.local' })
  expect(h.files['/repo/.gitignore']).toBe(undefined)
})

test('a file git tracks is refused, and nothing is written', async ($, on) => {
  const h = host(on, { trackedExit: 0, onPause: (n) => (n === 1 ? typeAndSave($, DUMMY) : Promise.resolve()) })
  const r = await ask($, { name: 'DUMMY_KEY', file: '.env.local' })
  expect(String(r.result)).toMatch(/tracked by git/)
  expect(String(r.result)).not.toContain(DUMMY)
  expect(Object.keys(h.files)).toEqual([])
})

// A trailing dot is dropped by Windows: .env.example. would open .env.example
for (const file of ['../.env', 'config/.env', 'config\\.env', '.env.example', '.env.example.', '.env..', '.env.local.', 'secrets.txt']) {
  test(`file ${JSON.stringify(file)} is refused`, async ($, on) => {
    host(on)
    expect(String((await ask($, { name: 'DUMMY_KEY', file })).result)).toMatch(/not an env file name/)
  })
}

test('a box that cannot wait lets go, so the next request is not stuck', async ($, on) => {
  host(on, { noPause: true })
  expect(String((await ask($, { name: 'A_KEY' })).result)).toMatch(/could not wait/)
  expect(String((await ask($, { name: 'B_KEY' })).result)).not.toMatch(/already waiting/)
})

test('a box nobody answers times out, and the next request opens a new one', async ($, on) => {
  // Pause 1 jumps past the deadline: A_KEY times out. Pause 2 is B_KEY's box: the person saves.
  const h = host(on, { onPause: async (n) => (n === 1 ? void h.advance(11 * 60_000) : typeAndSave($, DUMMY)) })
  expect(String((await ask($, { name: 'A_KEY' })).result)).toMatch(/cancelled/)
  expect(String((await ask($, { name: 'B_KEY' })).result)).toMatch(/saved to \/repo\/\.env/)
  expect(h.files['/repo/.env']).toBe(`B_KEY=${DUMMY}
`)
})

test('a stalled request that wakes after a newer one only lets go of its own', async ($, on) => {
  let b: Answer | undefined
  // Pause 1 is A's: A stalls past its deadline, and B runs to the end meanwhile.
  // Pause 2 is B's box: the person saves. Then A wakes up.
  const h = host(on, {
    onPause: async (n) => {
      if (n === 1) {
        h.advance(11 * 60_000)
        b = await ask($, { name: 'B_KEY' })
      } else if (n === 2) await typeAndSave($, DUMMY)
    },
  })
  const a = await ask($, { name: 'A_KEY' })
  expect(String(b?.result)).toMatch(/B_KEY\. It was saved to \/repo\/\.env/)
  expect(String(a.result)).toMatch(/cancelled\. A_KEY was not saved/)
  expect(h.files['/repo/.env']).toBe(`B_KEY=${DUMMY}\n`)
})
