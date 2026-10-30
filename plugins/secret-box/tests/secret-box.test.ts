import { expect, test } from 'claude-code/testing'

import { isAbsolute, isEnvFile, isNotFound, WAITS } from '../hooks/register'

// Fake keys, built at run time so no key-shaped string sits in the repo
const STRIPE = 'sk_' + 'live_' + 'A1b2C3d4E5f6G7h8J9k0L1m2'
const WEAK = 'hunter' + '2hunter2' // a short password the detector alone would miss

type Answer = { deny?: string; result?: unknown }
const call = async ($: any, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer

// Stand in for Claude Code beneath the mod: the tool "prints" `output`,
// git reports `staged`, and .env holds `dotenv`.
function stubs(on: any, opts: { output?: string; staged?: string; dotenv?: string; seen?: string[]; cwd?: string; looked?: string[] } = {}) {
  on('tool.call', (_$: unknown, e: Record<string, unknown>) => {
    opts.seen?.push(String(e.command ?? ''))
    return { result: opts.output ?? 'ran' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: opts.staged ?? '', stderr: '' } }))
  on('session.cwd', () => ({ value: opts.cwd ?? '/repo' }))
  on('fs.exists', (_$: unknown, e: { path: string }) => {
    opts.looked?.push(e.path)
    return { value: opts.dotenv !== undefined }
  })
  on('fs.read', () => ({ value: opts.dotenv ?? '' }))
}

// What is blocked, and what now runs (with its output hidden instead)
const GUARD: [string, string, boolean][] = [
  ['cat .env runs', 'cat .env', false],
  ['source .env runs', 'source .env && node app.js', false],
  ['git add -f .env', 'git add -f .env', true],
  ['git add .env.local', 'git add .env.local', true],
  ['git add .env.example', 'git add .env.example', false],
  ['git status', 'git status', false],
]
for (const [name, command, isBlocked] of GUARD) {
  test(name, async ($, on) => {
    stubs(on)
    expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(isBlocked)
  })
}

// git add of a .env is refused on the words alone, with the same reach
for (const [name, command, isBlocked] of [
  ['an inline variable before git add .env', 'GIT_TRACE=0 git add -f .env', true],
  ['git add .env after then', 'if true; then git add .env; fi', true],
  ['an echo that mentions add and .env', 'echo add .env', false],
] as const) {
  test(name, async ($, on) => {
    gitStub(on, {})
    expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(isBlocked)
  })
}

for (const [staged, isBlocked] of [['src/app.ts\n.env\n', true], ['src/app.ts\n', false]] as const) {
  test(`git commit with staged ${JSON.stringify(staged)}`, async ($, on) => {
    stubs(on, { staged })
    expect(Boolean((await call($, { tool: 'Bash', command: 'git commit -m "wip"' })).deny)).toBe(isBlocked)
  })
}

for (const options of [{}, { pii: false }, { pii: true }, { pii: true, hideEmails: false }]) {
  test(`email visibility follows pii ${JSON.stringify(options)} while secrets stay hidden`, { options }, async ($, on) => {
    const address = 'dana.whitfield@northwind-labs.io'
    const publicIp = '8.8.8.8'
    stubs(on, { output: `contact ${address}, origin ${publicIp}, token ${STRIPE}` })
    const result = String((await call($, { tool: 'Bash', command: 'cat output.txt' })).result)
    if (options.pii) {
      expect(result).not.toContain(publicIp)
      expect(result).toMatch(/\[REDACTED-IP-[0-9a-f]{8}\]/)
    } else {
      expect(result).toContain(publicIp)
    }
    expect(result).not.toContain(STRIPE)
    expect(result).toMatch(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)
    if (options.pii && options.hideEmails !== false) {
      expect(result).not.toContain(address)
      expect(result).toMatch(/\[REDACTED-EMAIL-[0-9a-f]{8}\]/)
    } else {
      expect(result).toContain(address)
    }
  })
}

test('a key in any tool output comes back as a placeholder', async ($, on) => {
  stubs(on, { output: `charged with ${STRIPE}` })
  const r = await call($, { tool: 'Bash', command: 'node pay.js' })
  expect(String(r.result)).not.toContain(STRIPE)
  expect(String(r.result)).toMatch(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)
})

test('reading .env hides secret-named values and keeps the rest', async ($, on) => {
  const dotenv = `PORT=3000\nNODE_ENV=production\nDB_PASSWORD=${WEAK}\n`
  stubs(on, { output: dotenv, dotenv })
  const out = String((await call($, { tool: 'Read', file_path: '/repo/.env' })).result)
  expect(out).toContain('PORT=3000')
  expect(out).toContain('NODE_ENV=production')
  expect(out).not.toContain(WEAK)
})

test('a known .env value is hidden anywhere, even when it does not look like a key', async ($, on) => {
  stubs(on, { output: `connected as admin / ${WEAK}`, dotenv: `DB_PASSWORD=${WEAK}\n` })
  await call($, { tool: 'Read', file_path: '/repo/.env' })
  const out = String((await call($, { tool: 'Bash', command: 'node db.js' })).result)
  expect(out).not.toContain(WEAK)
})

test('a placeholder in a command becomes the real value when it runs', async ($, on) => {
  const seen: string[] = []
  stubs(on, { output: `key is ${STRIPE}`, seen })
  const tag = String((await call($, { tool: 'Bash', command: 'cat key.txt' })).result).match(/\[REDACTED-SECRET-[0-9a-f]{8}\]/)![0]
  await call($, { tool: 'Bash', command: `curl -u ${tag}: https://api.stripe.com/v1/balance` })
  expect(seen.at(-1)).toContain(STRIPE)
  expect(seen.at(-1)).not.toContain(tag)
})

test('a key is still hidden when .env cannot be read', async ($, on) => {
  on('tool.call', () => ({ result: `key is ${STRIPE}` }))
  const out = String((await call($, { tool: 'Read', file_path: '/repo/.env' })).result)
  expect(out).not.toContain(STRIPE)
})

test('a weak value in another .env file is hidden when that file is read', async ($, on) => {
  const plain = 'correct' + 'horsebattery' // letters only: no detector rule fires on it
  stubs(on, { output: `PORT=3000\nADMIN_PASS=${plain}\n`, dotenv: `PORT=3000\nADMIN_PASS=${plain}\n` })
  const out = String((await call($, { tool: 'Bash', command: 'cat config/.env.production' })).result)
  expect(out).not.toContain(plain)
  expect(out).toContain('PORT=3000')
})

test('a .env file that cannot be checked still runs, and is scanned', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => { throw new Error('disk gone') })
  // learnDotenv swallows a read error, so the call still runs and is scanned
  expect((await call($, { tool: 'Read', file_path: '/repo/.env' })).result).toBe('ran')
})

// git answers per subcommand: `index` for what is staged, `tree` for what is
// changed or untracked, `fails` for a git call that errors. `argvs` keeps every call.
function gitStub(on: any, opts: { index?: string; tree?: string; fails?: boolean; argvs?: string[][] }) {
  on('tool.call', () => ({ result: 'ran' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    opts.argvs?.push([...e.argv])
    if (opts.fails) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
    const stdout = e.argv.includes('ls-files') ? opts.tree ?? '' : opts.index ?? ''
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
}

const STAGE_AND_COMMIT: [string, string, string, boolean][] = [
  ['git add -A && git commit with an untracked .env.production', 'git add -A && git commit -m init', 'src/app.ts\n.env.production\n', true],
  ['git add -A && git commit with no .env around', 'git add -A && git commit -m init', 'src/app.ts\n', false],
  ['git commit -am with a changed .env.local', 'git commit -am wip', 'config/.env.local\n', true],
  ['git commit with an untracked .env it does not stage', 'git commit -m wip', '.env\n', false],
]
for (const [name, command, tree, isBlocked] of STAGE_AND_COMMIT) {
  test(name, async ($, on) => {
    gitStub(on, { tree })
    expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(isBlocked)
  })
}

test('git -C checks the repository it names', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { index: '.env\n', argvs })
  const r = await call($, { tool: 'Bash', command: 'git -C ../other commit -m wip' })
  expect(Boolean(r.deny)).toBe(true)
  expect(argvs.some((a) => a.join(' ') === 'git -C ../other diff --cached --name-only')).toBe(true)
})

test('a commit is blocked when git cannot say what it includes', async ($, on) => {
  gitStub(on, { fails: true })
  expect(Boolean((await call($, { tool: 'Bash', command: 'git commit -m wip' })).deny)).toBe(true)
})

// Only git run as a command counts: the same words in a URL, a file name or an argument do not
for (const [name, command, isBlocked] of [
  ['the Git Data API with a commit.json file', 'gh api repos/o/r/git/trees --input "$S/commit.json"', false],
  ['git log searching for commit', 'git log --grep commit', false],
  ['bash -c running git commit', "bash -c 'git commit -m wip'", true],
  ['git commit after a newline', 'x=1\ngit commit -m wip', true],
  ['env and a path before git commit', 'env GIT_EDITOR=true /usr/bin/git commit', true],
  ['git log searching for commit with =', 'git log --grep=commit', false],
  ['a file path with git and commit in it', 'cat .git/commit.json', false],
  ['git show of a file named commit', 'git show HEAD:commit.txt', false],
  ['a word that ends in git', 'legit commit', false],
  // Each of these commits for real: a miss lets a .env through
  ['an inline variable before git commit', 'GIT_AUTHOR_NAME=x git commit -m wip', true],
  ['git.exe commit', 'git.exe commit -m wip', true],
  ['a quoted Windows path to git.exe', '"C:\\Program Files\\Git\\cmd\\git.exe" commit -m wip', true],
  ['git commit after then', 'if true; then git commit -m wip; fi', true],
  ['git commit after do', 'for f in a; do git commit -m wip; done', true],
  ['git commit in braces', '{ git commit -m wip; }', true],
  ['time, nohup and xargs before git commit', 'time nohup xargs git commit -m wip', true],
  ['sudo -u before git commit', 'sudo -u bob git commit -m wip', true],
  ['--git-dir with a space before commit', 'git --git-dir .git commit -m wip', true],
  ['a quoted -c value before commit', 'git -c "user.name=A B" commit -m wip', true],
] as const) {
  test(name, async ($, on) => {
    gitStub(on, { fails: true })
    expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(isBlocked)
  })
}

test('a Windows .env path is read where it is, and its weak values are hidden', async ($, on) => {
  const plain = 'staple' + 'gunwindow' // letters only: no detector rule fires on it
  const looked: string[] = []
  stubs(on, { output: `PORT=3000\nADMIN_PASS=${plain}\n`, dotenv: `ADMIN_PASS=${plain}\n`, cwd: 'C:\\repo', looked })
  const out = String((await call($, { tool: 'Read', file_path: 'C:\\repo\\.env' })).result)
  // The engine resolves a fs path with the host's path rules, so off Windows it gets a prefix
  expect(looked.some(p => p.endsWith('C:\\repo\\.env'))).toBe(true)
  expect(out).not.toContain(plain)
  expect(out).toContain('PORT=3000')
})

test('isEnvFile takes the name after a / or a \\', async () => {
  expect(isEnvFile('C:\\repo\\.env.local')).toBe(true)
  expect(isEnvFile('/repo/.env')).toBe(true)
  expect(isEnvFile('C:\\repo\\.env.example')).toBe(false)
  expect(isEnvFile('C:\\repo\\app.env')).toBe(false)
})

test('isAbsolute knows Unix, drive-letter and UNC paths', async () => {
  for (const p of ['/repo/.env', 'C:\\repo\\.env', 'd:/repo/.env', '\\\\server\\share\\.env']) expect(isAbsolute(p)).toBe(true)
  for (const p of ['.env', 'config\\.env', 'C:.env', '~/.env']) expect(isAbsolute(p)).toBe(false)
})

test('the box waits with sleep on Mac and Linux, and with node, else ping, on Windows', async () => {
  expect(WAITS.unix).toEqual([['sleep', '0.3']])
  expect(WAITS.windows.map(w => w[0])).toEqual(['node', 'ping'])
  expect(isNotFound(new Error("$.process.run(node) failed to start: ENOENT: Command 'node' not found"))).toBe(true)
  expect(isNotFound(new Error('timed out'))).toBe(false)
})
