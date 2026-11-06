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

// Every token has one reading: a regex with two readings per token never
// returns on this (2^75 paths) and the test times out
test('a long command of repeated wrappers and options is checked at once', async ($, on) => {
  gitStub(on, {})
  const command = 'env -- '.repeat(25) + 'env -u env '.repeat(25) + 'git ' + '-c -c '.repeat(25) + 'log'
  expect(Boolean((await call($, { tool: 'Bash', command })).deny)).toBe(false)
})

// git add of a .env is refused on the words alone, with the same reach
for (const [name, command, isBlocked] of [
  ['an inline variable before git add .env', 'GIT_TRACE=0 git add -f .env', true],
  ['git add .env after then', 'if true; then git add .env; fi', true],
  ['xargs -0 running git add on .env', "printf '%s\\0' .env | xargs -0 git add", true],
  ['git add .env in a while loop', 'while git add .env; do :; done', true],
  ['an echo that mentions add and .env', 'echo add .env', false],
  // #30: only a .env in the add's own arguments counts
  ['git add src/.env.local', 'git add src/.env.local', true],
  ['git -C foo add .env', 'git -C foo add .env', true],
  ['git -c core.x=1 add .env', 'git -c core.x=1 add .env', true],
  ['git stage .env', 'git stage .env', true],
  ['git add -f .env 2>&1', 'git add -f .env 2>&1', true],
  ['git add &>/dev/null then .env', 'git add &>/dev/null .env', true],
  ['the second of two adds names .env', 'git add a.ts && git add .env', true],
  ['git add of a variable set to .env', 'f=.env; git add "$f"', true],
  ['git add of a glob, with .env named elsewhere', 'git add -f .e*; echo .env', true],
  ['git add -A, then an echo', 'git add -A && echo x', false],
  ['git add a.ts, then cat .env', 'git add a.ts; cat .env', false],
  ['git add with --env-file=.env later in the command', 'git add src && node --env-file=.env app.js', false],
  ['git worktree add with a .env path', 'git worktree add x ../.env', false],
  ['git worktree add, then an append to .env', 'git worktree add -q --detach dir origin/main && echo ok >> .env', false],
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
// `repos`, when given, are the only -C directories git can read, and `dirty`
// is the one whose index holds a .env; `env` is the environment.
function gitStub(on: any, opts: { index?: string; tree?: string; fails?: boolean; argvs?: string[][]; repos?: string[]; dirty?: string; env?: Record<string, string> }) {
  on('tool.call', () => ({ result: 'ran' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: opts.env?.[e.name] }))
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    opts.argvs?.push([...e.argv])
    const dir = e.argv[1] === '-C' ? e.argv[2] : ''
    if (opts.fails || (opts.repos && dir && !opts.repos.includes(dir))) {
      return { value: { exitCode: 128, stdout: '', stderr: `fatal: cannot change to '${dir}': No such file or directory` } }
    }
    const stdout = e.argv.includes('ls-files') ? opts.tree ?? '' : dir && dir === opts.dirty ? '.env\n' : opts.index ?? ''
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

// #31: a -C directory the guard mis-read used to block a clean commit.
// Each case: the command, and the directories git is asked about. None holds a .env.
const DIR = '/path/to/repo'
const GIT_DIRS: [string, string, string[]][] = [
  ['git -C text inside a quoted commit message', `git -C ${DIR} commit -m "Workers: usar git -C en vez de cd"`, [DIR]],
  ['git -C text inside a single-quoted message', `git -C ${DIR} commit -m 'see git -C en'`, [DIR]],
  ['git -C text inside a heredoc message', `git -C ${DIR} commit -m "$(cat <<'EOF'\nWorkers: usar git -C en vez de cd (y git -C otro)\nEOF\n)"`, [DIR]],
  ['a -C directory set earlier in the command', `W=${DIR}; git -C $W add file && git -C $W commit -m "msg"`, [DIR]],
  ['a ${W} and "$W" -C directory', `export W="${DIR}" && git -C "\${W}" add f && git -C "$W" commit -m msg`, [DIR]],
  ['a -C directory joined from two variables', `R=/path; N=to/repo; git -C "$R/$N" commit -m msg`, [DIR]],
  ['a -C directory under $HOME', 'git -C "$HOME/repo" commit -m msg', [DIR]],
  ['a -C directory under ~', 'git -C ~/repo commit -m msg', [DIR]],
  ['git -C a -C b runs in a/b', 'git -C /path -C to/repo commit -m msg', [DIR]],
  ['a quoted Windows -C path', 'git -C "C:\\Program Files\\repo" commit -m msg', ['C:\\Program Files\\repo']],
  ['an unquoted Windows -C path', 'git -C C:\\repo commit -m msg', ['C:\\repo']],
  ['git -C inside bash -c is still checked', `bash -c 'git -C ${DIR} commit -m msg'`, [DIR]],
  ['git -C in a heredoc fed to sh is still checked', `sh <<'EOF'\ngit -C ${DIR} commit -m msg\nEOF`, [DIR]],
]
for (const [name, command, asked] of GIT_DIRS) {
  test(name, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, repos: [DIR, 'C:\\Program Files\\repo', 'C:\\repo'], env: { HOME: '/path/to' } })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
    expect([...new Set(argvs.map(a => a[2]))]).toEqual(asked)
  })
}

test('a .env staged in a -C $W repository is still blocked', async ($, on) => {
  gitStub(on, { index: 'src/app.ts\n.env\n', repos: [DIR] })
  const r = await call($, { tool: 'Bash', command: `W=${DIR}; git -C $W commit -m "msg"` })
  expect(r.deny).toContain('would include a .env file')
})

test('a .env that git add -A would stage in a -C "$W" repository is still blocked', async ($, on) => {
  gitStub(on, { tree: '.env\n', repos: [DIR] })
  const r = await call($, { tool: 'Bash', command: `W="${DIR}"; git -C "$W" add -A && git -C "$W" commit -m msg` })
  expect(r.deny).toContain('could stage and commit .env')
})

// The commit runs in /unsafe, where .env is staged. A W=/safe that may never
// run, or sits in text, must not stand in for it: every value is checked.
const UNSAFE = '/unsafe'
for (const [name, command] of [
  ['an assignment after false &&', `W=${UNSAFE}; false && W=/safe; git -C "$W" commit -m msg`],
  ['an assignment in a quoted message read as code', `W=${UNSAFE}; git commit -m 'W=/safe; git commit'; git -C "$W" commit -m msg`],
  ['an assignment in an if branch', `W=${UNSAFE}; if false; then W=/safe; fi; git -C "$W" commit -m msg`],
  ['an assignment in a subshell', `W=${UNSAFE}; (W=/safe); git -C "$W" commit -m msg`],
  ['an assignment after the git call, in a loop', `W=${UNSAFE}; for i in 1 2; do git -C "$W" commit -m msg; W=/safe; done`],
  ['an assignment through another variable', `S=/safe; U=${UNSAFE}; W=$U; true || W=$S; git -C "$W" commit -m msg`],
  ['an assignment on its own line inside if', `W=${UNSAFE}; if false; then\nW=/safe\nfi; git -C "$W" commit -m msg`],
  ['an assignment on its own line inside a loop', `W=${UNSAFE}\nwhile false; do\n  W=/safe\ndone\ngit -C "$W" commit -m msg`],
  ['an assignment on its own line inside case', `W=${UNSAFE}\ncase x in\n  y)\n    W=/safe\n    ;;\nesac\ngit -C "$W" commit -m msg`],
  ['an assignment on its own line inside { }', `W=${UNSAFE}\nf() {\n  W=/safe\n}\ngit -C "$W" commit -m msg`],
  ['an assignment after && and a newline', `W=${UNSAFE}; false &&\nW=/safe\ngit -C "$W" commit -m msg`],
  ['an assignment piped to another command', `W=${UNSAFE}; W=/safe | cat; git -C "$W" commit -m msg`],
] as const) {
  test(`a .env commit is blocked despite ${name}`, async ($, on) => {
    gitStub(on, { repos: [UNSAFE, '/safe'], dirty: UNSAFE })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toContain('would include a .env file')
  })
}

// W may hold anything from the shell when the only W= might not run
for (const command of ['source vars.sh; if false; then\nW=/safe\nfi; git -C "$W" commit -m msg', 'false &&\nW=/safe\ngit -C "$W" commit -m msg', 'W=/safe &\ngit -C "$W" commit -m msg', 'git commit -m "W=/safe; git commit"; git -C "$W" commit -m msg', 'git -C "$W" commit -m msg; W=/safe']) {
  test(`a -C variable with no assignment that surely runs first is unresolved: ${command}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, repos: ['/safe'] })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toContain("couldn't resolve the git -C directory")
    expect(argvs.some(a => a[2] === '/safe')).toBe(false)
  })
}

for (const command of ['git -C "$UNSET" commit -m msg', 'git -C $UNSET commit -m msg', 'W=$(pwd)/sub; git -C $W commit -m msg', 'for W in a b; do git -C $W commit -m msg; done']) {
  test(`a -C directory that can't be resolved is blocked, and says so: ${command}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, env: { W: DIR } })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toContain("couldn't resolve the git -C directory")
    expect(r.deny).not.toMatch(/No \.env|["']\$/)
    expect(r.deny).toContain('This is not a detected .env: the guard could not check this commit')
    expect(argvs.length).toBe(0)
  })
}

test('an unresolved -C directory is shown as written, without its quotes', async ($, on) => {
  gitStub(on, {})
  const r = await call($, { tool: 'Bash', command: 'git -C "$UNSET" commit -m msg' })
  expect(r.deny).toContain("couldn't resolve the git -C directory `$UNSET`")
})

test('a -C directory git cannot read is blocked as a git problem, not a found .env', async ($, on) => {
  gitStub(on, { repos: [DIR] })
  const r = await call($, { tool: 'Bash', command: 'git -C /nowhere commit -m msg' })
  expect(r.deny).toContain("couldn't read git state in /nowhere")
  expect(r.deny).toContain("cannot change to '/nowhere'")
  expect(r.deny).toContain('This is not a detected .env: the guard could not check this commit')
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
  ['git commit as an if condition', 'if git commit -m wip; then :; fi', true],
  ['wrapper options before git commit', 'env -i sudo -u bob -- git commit -m wip', true],
  ['-c and -C with no space', 'git -cuser.name=x -C. commit -m wip', true],
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
