import { expect, test } from 'claude-code/testing'

import { fromMsys, isAbsolute, isEnvFile, isNotFound, lexical, WAITS } from '../hooks/register'

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
  // git -z: one name per NUL
  on('process.run', () => ({ value: { exitCode: 0, stdout: (opts.staged ?? '').replace(/\n/g, '\0'), stderr: '' } }))
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
// is the one whose index holds a .env ('' the session's), `untracked` the one
// with an untracked .env; `env` is the environment, `cwd` the session's
// directory (`cwdFails`: it can't be read), and `outside` puts it outside any repository.
// `raw`: the lists go out exactly as written, for names that hold a newline.
function gitStub(on: any, opts: { index?: string; tree?: string; fails?: boolean; argvs?: string[][]; repos?: string[]; dirty?: string; untracked?: string; env?: Record<string, string>; cwd?: string; cwdFails?: boolean; outside?: boolean; envs?: (Record<string, string> | undefined)[]; raw?: boolean }) {
  on('tool.call', () => ({ result: 'ran' }))
  on('session.cwd', () => {
    if (opts.cwdFails) throw new Error('no cwd')
    return { value: opts.cwd ?? '/repo' }
  })
  on('fs.exists', () => ({ value: false }))
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: opts.env?.[e.name] }))
  on('process.run', (_$: unknown, e: { argv: string[]; init?: { env?: Record<string, string> } }) => {
    opts.argvs?.push([...e.argv])
    opts.envs?.push(e.init?.env)
    const dir = e.argv[1] === '-C' ? e.argv[2] : ''
    if (opts.fails || (opts.repos && dir && !opts.repos.includes(dir))) {
      return { value: { exitCode: 128, stdout: '', stderr: `fatal: cannot change to '${dir}': No such file or directory` } }
    }
    if (!dir && opts.outside) {
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }
    }
    // The lists are written one name per line; git -z gives one per NUL
    const list = e.argv.includes('ls-files')
      ? (opts.untracked !== undefined && dir === opts.untracked ? '.env\n' : opts.tree ?? '')
      : opts.dirty !== undefined && dir === opts.dirty ? '.env\n' : opts.index ?? ''
    const stdout = opts.raw ? list : list.replace(/\n/g, '\0')
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
  expect(argvs.some((a) => a.join(' ') === 'git -C ../other -c diff.relative=false diff --cached --name-only -z')).toBe(true)
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

// #34: a cd or pushd before git moves it like -C. The session sits outside any
// repository, as in the issue. Each case: the command, the directories git is
// asked about ('' the session's own).
const dirsAsked = (argvs: string[][]) => [...new Set(argvs.map(a => (a[1] === '-C' ? a[2] : '')))].sort()
const REPRO = 'cd /e/myrepo && git add file.txt && git commit -m "msg"'
const CD_DIRS: [string, string, string[]][] = [
  ['the command from the issue', REPRO, ['/e/myrepo']],
  ['cd X && git commit', `cd ${DIR} && git commit -m msg`, [DIR]],
  ['pushd X && git commit', `pushd ${DIR} && git commit -m msg && popd`, [DIR]],
  ['cd with options', `cd -P -- ${DIR} && git commit -m msg`, [DIR]],
  ['a relative cd joins onto the one before', `cd /path && cd to/repo && git commit -m msg`, [DIR]],
  ['a relative cd from the session directory', 'cd sub && git commit -m msg', ['sub']],
  ['a -C on top of a cd', 'cd /path && git -C to/repo commit -m msg', [DIR]],
  ['an absolute -C after a cd', `cd /elsewhere && git -C ${DIR} commit -m msg`, [DIR]],
  ['cd "$W" with W set earlier', `W=${DIR}; cd "$W" && git add f && git commit -m msg`, [DIR]],
  ['cd ~/repo', 'cd ~/repo && git commit -m msg', [DIR]],
  ['a bare cd goes to HOME', 'cd && git -C repo commit -m msg', [DIR]],
  ['git commit text in the message', `cd ${DIR} && git commit -m "git commit: fix git add"`, [DIR]],
  ['a substitution in the message', `cd ${DIR} && git commit -m "$(printf 'a'; echo b)"`, [DIR]],
  ['a heredoc message', `cd ${DIR} && git commit -m "$(cat <<'EOF'\nfix: cd and git -C\nEOF\n)"`, [DIR]],
  ['a cd after an earlier && step', `echo start && cd ${DIR} && git commit -m msg`, [DIR]],
  ['a cd on a continued line', `cd ${DIR} &&\n  git commit -m msg`, [DIR]],
  ['pushd -n does not move', `pushd -n /elsewhere && git commit -m msg`, ['']],
]
for (const [name, command, asked] of CD_DIRS) {
  test(`a cd before git is checked where it moves: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, cwd: '/scratch', outside: !asked.includes(''), repos: [DIR, '/e/myrepo', 'sub'], env: { HOME: '/path/to' } })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual(asked)
  })
}

// A cd that may not have run (a ; or newline after it, ||, a body, a
// subshell, a pipe, quoted code) leaves git in either place: check both
const CD_UNSURE: [string, string][] = [
  ['a ; after the cd', `cd ${DIR}; git commit -m msg`],
  ['a newline after the cd', `cd ${DIR}\ngit commit -m msg`],
  ['|| after the cd', `cd ${DIR} || echo no; git commit -m msg`],
  ['git after || on the cd', `cd ${DIR} || git commit -m msg`],
  ['a cd after ||', `true || cd ${DIR} && git commit -m msg`],
  ['a ; later in the chain', `cd ${DIR} && true; git commit -m msg`],
  ['a cd inside if', `if true; then cd ${DIR}; fi; git commit -m msg`],
  ['a cd as an if condition', `if cd ${DIR}; then git commit -m msg; fi`],
  ['a cd inside a loop', `for i in 1; do cd ${DIR}; done; git commit -m msg`],
  ['a cd in a subshell', `(cd ${DIR} && git commit -m msg)`],
  ['a cd in a subshell, git after it', `(cd ${DIR}) && git commit -m msg`],
  ['a cd after a pipe', `true | cd ${DIR} && git commit -m msg`],
  ['a cd piped on', `cd ${DIR} | cat && git commit -m msg`],
  ['a cd in the background', `cd ${DIR} & git commit -m msg`],
  ['a cd in bash -c code', `bash -c 'cd ${DIR} && git commit -m msg'`],
  ['a cd in a substitution', `x=$(cd ${DIR} && pwd) && git commit -m msg`],
  ['builtin cd', `builtin cd ${DIR} && git commit -m msg`],
]
for (const [name, command] of CD_UNSURE) {
  test(`a cd that may not have run checks both directories: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, repos: [DIR] })
    expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual(['', DIR])
  })
  test(`a .env staged in the session directory is still blocked: ${name}`, async ($, on) => {
    gitStub(on, { repos: [DIR], dirty: '' })
    expect((await call($, { tool: 'Bash', command })).deny).toContain('would include a .env file')
  })
  test(`a .env staged where the cd goes is still blocked: ${name}`, async ($, on) => {
    gitStub(on, { repos: [DIR], dirty: DIR })
    expect((await call($, { tool: 'Bash', command })).deny).toContain('would include a .env file')
  })
}

for (const [command, shown] of [
  ['cd - && git commit -m msg', 'cd -'],
  ['cd "$UNSET" && git commit -m msg', 'cd $UNSET'],
  ['cd "$(pwd)/sub" && git commit -m msg', 'cd $(pwd)/sub'],
  ['cd ~bob/repo && git commit -m msg', 'cd ~bob/repo'],
  ['popd && git commit -m msg', 'popd'],
  ['pushd && git commit -m msg', 'pushd'],
  ['pushd +1 && git commit -m msg', 'pushd +1'],
  ['cd && git commit -m msg', 'cd (HOME is not known)'],
  ['W=$(pwd); cd $W && git commit -m msg', 'cd $W'],
] as const) {
  test(`a cd directory that can't be resolved is blocked, and says so: ${command}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toContain(`couldn't resolve the directory \`${shown}\` moves to before git runs`)
    expect(r.deny).toContain('This is not a detected .env: the guard could not check this commit')
    expect(argvs.length).toBe(0)
  })
}

test('an unresolved cd that may not have run is still blocked', async ($, on) => {
  gitStub(on, {})
  expect((await call($, { tool: 'Bash', command: 'cd "$UNSET"; git commit -m msg' })).deny).toContain("couldn't resolve the directory `cd $UNSET`")
})

test('an eval that runs cd is blocked: where it goes is not known', async ($, on) => {
  gitStub(on, {})
  expect((await call($, { tool: 'Bash', command: `cd ${DIR} && eval "cd sub" && git commit -m msg` })).deny).toContain("couldn't resolve the directory `eval cd sub` moves to before git runs")
})

test('an unresolved cd after the commit does not block it', async ($, on) => {
  gitStub(on, {})
  expect((await call($, { tool: 'Bash', command: 'git commit -m msg && cd -' })).deny).toBeUndefined()
})

test('an absolute -C overrides an unresolved cd', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs, repos: [DIR] })
  expect((await call($, { tool: 'Bash', command: `cd "$UNSET" && git -C ${DIR} commit -m msg` })).deny).toBeUndefined()
  expect(dirsAsked(argvs)).toEqual([DIR])
})

// The same command still refuses a .env in the repository it moves to
test('cd X && git add .env && git commit is blocked', async ($, on) => {
  gitStub(on, { repos: [DIR], outside: true })
  expect((await call($, { tool: 'Bash', command: `cd ${DIR} && git add .env && git commit -m msg` })).deny).toContain('staging a .env file is blocked')
})

test('cd X && git add -A && git commit is blocked with an untracked .env in X', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs, repos: [DIR], untracked: DIR, outside: true })
  const r = await call($, { tool: 'Bash', command: `cd ${DIR} && git add -A && git commit -m msg` })
  expect(r.deny).toContain('could stage and commit .env')
  expect(argvs.some(a => a.join(' ') === `git -C ${DIR} ls-files -z --full-name --modified --others --exclude-standard -- :/`)).toBe(true)
})

test('cd X && git commit is blocked with a .env staged in X', async ($, on) => {
  gitStub(on, { repos: [DIR], dirty: DIR, outside: true })
  expect((await call($, { tool: 'Bash', command: `cd ${DIR} && git commit -m msg` })).deny).toContain('would include a .env file')
})

// git.exe is run directly on Windows, so a Git Bash path becomes a drive path
const MSYS: [string, string, string][] = [
  ['the command from the issue', REPRO, 'E:/myrepo'],
  ['a /cygdrive path', 'cd /cygdrive/e/x && git commit -m msg', 'E:/x'],
  ['a -C path', 'git -C /e/myrepo commit -m msg', 'E:/myrepo'],
  ['a drive root, then -C', 'cd /e && git -C myrepo commit -m msg', 'E:/myrepo'],
  ['a drive path as it is', 'cd E:/myrepo && git commit -m msg', 'E:/myrepo'],
]
for (const [name, command, dir] of MSYS) {
  test(`on Windows an MSYS path is given to git as a drive path: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, repos: [dir], outside: true, cwd: 'C:\\scratch', env: { OS: 'Windows_NT' } })
    expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual([dir])
  })
}

test('off Windows an MSYS-shaped path stays as it is', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs, repos: ['/e/myrepo'], outside: true, cwd: '/scratch' })
  expect((await call($, { tool: 'Bash', command: REPRO })).deny).toBeUndefined()
  expect(dirsAsked(argvs)).toEqual(['/e/myrepo'])
})

test('fromMsys turns only a drive-letter path', async () => {
  expect(fromMsys('/e/myrepo')).toBe('E:/myrepo')
  expect(fromMsys('/c')).toBe('C:/')
  expect(fromMsys('/cygdrive/d/a b')).toBe('D:/a b')
  for (const p of ['/tmp', '/ee/x', '/cygdrive', 'C:/x', 'sub/e', '']) expect(fromMsys(p)).toBe(p)
})

// When git can't read a directory, the message names the one it tried
test('a session directory outside a repository is named in the message', async ($, on) => {
  gitStub(on, { outside: true, cwd: '/scratch' })
  const r = await call($, { tool: 'Bash', command: 'git commit -m msg' })
  expect(r.deny).toContain("couldn't read git state in /scratch (the session directory) (git: fatal: not a git repository")
  expect(r.deny).toContain('This is not a detected .env')
})

test('a cd directory git cannot read is named in the message', async ($, on) => {
  gitStub(on, { repos: [DIR], cwd: '/scratch' })
  const r = await call($, { tool: 'Bash', command: 'cd /nowhere && git commit -m msg' })
  expect(r.deny).toContain("couldn't read git state in /nowhere (git: fatal: cannot change to '/nowhere'")
})

test('a relative cd directory is named with the session directory it is under', async ($, on) => {
  gitStub(on, { repos: [DIR], cwd: '/scratch' })
  const r = await call($, { tool: 'Bash', command: 'cd nowhere && git commit -m msg' })
  expect(r.deny).toContain("couldn't read git state in nowhere (under /scratch)")
})

test('a converted Windows directory is named as given to git', async ($, on) => {
  gitStub(on, { repos: [DIR], cwd: 'C:\\scratch', env: { OS: 'Windows_NT' } })
  const r = await call($, { tool: 'Bash', command: 'cd /e/gone && git commit -m msg' })
  expect(r.deny).toContain("couldn't read git state in E:/gone")
})

// PR #36 review: bash looks a relative cd up in CDPATH first, so every
// CDPATH folder is checked as well as the plain target
const CDPATH_DIRS: [string, string, Record<string, string>, string[]][] = [
  ['CDPATH set in the command', 'CDPATH=/dirty-parent; cd repo && git commit -m msg', {}, ['/dirty-parent/repo', 'repo']],
  ['CDPATH exported in the command', 'export CDPATH=/a:/b && cd repo && git commit -m msg', {}, ['/a/repo', '/b/repo', 'repo']],
  ['CDPATH for the cd alone', 'CDPATH=/dirty-parent cd repo && git commit -m msg', {}, ['/dirty-parent/repo', 'repo']],
  ['CDPATH from the environment', 'cd repo && git commit -m msg', { CDPATH: '/dirty-parent:' }, ['/dirty-parent/repo', 'repo']],
  ['pushd uses CDPATH too', 'pushd repo && git commit -m msg', { CDPATH: '/dirty-parent' }, ['/dirty-parent/repo', 'repo']],
  ['CDPATH and a .hidden target', 'cd .repo && git commit -m msg', { CDPATH: '/p' }, ['.repo', '/p/.repo']],
  ['no CDPATH for ./repo', 'cd ./repo && git commit -m msg', { CDPATH: '/p' }, ['repo']],
  ['no CDPATH for ../repo', 'cd ../repo && git commit -m msg', { CDPATH: '/p' }, ['/repo']],
  ['no CDPATH for an absolute target', `cd ${DIR} && git commit -m msg`, { CDPATH: '/p' }, [DIR]],
  ['no CDPATH set', 'cd repo && git commit -m msg', {}, ['repo']],
]
for (const [name, command, env, asked] of CDPATH_DIRS) {
  test(`a relative cd checks each CDPATH folder: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, cwd: '/scratch', outside: true, env })
    expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual(asked.sort())
  })
}

test('a .env staged in the CDPATH folder is blocked', async ($, on) => {
  gitStub(on, { cwd: '/scratch', outside: true, dirty: '/dirty-parent/repo' })
  expect((await call($, { tool: 'Bash', command: 'CDPATH=/dirty-parent; cd repo && git commit -m msg' })).deny).toContain('would include a .env file')
})

test('a CDPATH that cannot be known blocks a relative cd, and says so', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs })
  const r = await call($, { tool: 'Bash', command: 'CDPATH=$(cat paths); cd repo && git commit -m msg' })
  expect(r.deny).toContain("couldn't resolve the directory `cd repo (CDPATH is not known)` moves to before git runs")
  expect(argvs.length).toBe(0)
})

test('a CDPATH that cannot be known leaves an absolute cd alone', async ($, on) => {
  gitStub(on, { repos: [DIR], outside: true })
  expect((await call($, { tool: 'Bash', command: `CDPATH=$(cat paths); cd ${DIR} && git commit -m msg` })).deny).toBeUndefined()
})

// PR #36 review: cd -L (bash's default) takes .. off the text, git -C would
// follow a link first: /dirty/link/.. is /dirty to bash, whatever link is
const LOGICAL: [string, string, string[]][] = [
  ['an absolute path with ..', 'cd /dirty/link/.. && git commit -m msg', ['/dirty']],
  ['cd -L', 'cd -L /dirty/link/.. && git commit -m msg', ['/dirty']],
  ['a .. after a cd', 'cd /dirty/link && cd .. && git commit -m msg', ['/dirty']],
  ['. parts', 'cd /dirty/./link/. && git commit -m msg', ['/dirty/link']],
  ['a relative .. from the session directory', 'cd link/.. && git commit -m msg', ['/scratch']],
  ['a relative .. above the session directory', 'cd ../other && git commit -m msg', ['/other']],
  ['.. past the root', 'cd /../.. && git commit -m msg', ['/']],
  ['cd -P keeps the path as it is', 'cd -P /dirty/link/.. && git commit -m msg', ['/dirty/link/..']],
  ['-L then -P is physical', 'cd -L -P /dirty/link/.. && git commit -m msg', ['/dirty/link/..']],
  ['a git -C .. stays git\'s own', 'cd /dirty/link && git -C .. commit -m msg', ['/dirty/link/..']],
]
for (const [name, command, asked] of LOGICAL) {
  test(`a cd path is made plain the way bash -L does: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, cwd: '/scratch', outside: true })
    expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual(asked)
  })
}

test('a .env staged where cd /dirty/link/.. lands is blocked', async ($, on) => {
  gitStub(on, { outside: true, repos: ['/dirty', '/safe'], dirty: '/dirty' })
  expect((await call($, { tool: 'Bash', command: 'cd /dirty/link/.. && git commit -m msg' })).deny).toContain('would include a .env file')
})

test('a relative cd with .. is unresolved when the session directory is not known', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs, cwdFails: true })
  const r = await call($, { tool: 'Bash', command: 'cd ../repo && git commit -m msg' })
  expect(r.deny).toContain("couldn't resolve the directory `../repo` moves to before git runs")
  expect(argvs.length).toBe(0)
})

test('lexical takes . and .. off a path by its text', async () => {
  expect(lexical('/a/link/..')).toBe('/a')
  expect(lexical('/a/./b//c/')).toBe('/a/b/c')
  expect(lexical('/..')).toBe('/')
  expect(lexical('a/../..')).toBe('..')
  expect(lexical('a/..')).toBe('.')
  expect(lexical('C:\\repo\\sub\\..')).toBe('C:/repo')
  expect(lexical('C:/..')).toBe('C:/')
  expect(lexical('\\\\server\\share\\a\\..\\b')).toBe('//server/share/b')
})

// PR #36 review 2: after cd -P (or set -P) bash's directory is the resolved
// one, so a later .. is that directory's parent, which git finds by
// resolving the link too: /clean/link -> /dirty/subdir, then .. is /dirty
const PHYSICAL: [string, string, string[]][] = [
  ['cd -P, then cd ..', 'cd -P /clean/link && cd .. && git commit -m msg', ['/clean/link/..']],
  ['cd -P, then a relative cd with its own ..', 'cd -P /clean/link && cd sub/link2/.. && git commit -m msg', ['/clean/link/sub']],
  ['cd -P, then ../x', 'cd -P /clean/link && cd ../x && git commit -m msg', ['/clean/link/../x']],
  ['cd -P, then an absolute -L cd', 'cd -P /clean/link && cd /a/b/.. && git commit -m msg', ['/a']],
  ['pushd -P, then cd ..', 'pushd -P /clean/link && cd .. && git commit -m msg', ['/clean/link/..']],
  ['set -P', 'set -P; cd /clean/link && cd .. && git commit -m msg', ['/clean/link/..']],
  ['set -o physical', 'set -o physical && cd /clean/link/.. && git commit -m msg', ['/clean/link/..']],
  ['set -eP', 'set -eP\ncd /clean/link/.. && git commit -m msg', ['/clean/link/..']],
  ['set -P with pushd', 'set -P; pushd /clean/link/.. && git commit -m msg', ['/clean/link/..']],
  ['cd -L after set -P', 'set -P; cd -L /clean/link/.. && git commit -m msg', ['/clean']],
  ['set +P after set -P', 'set -P; set +P; cd /clean/link/.. && git commit -m msg', ['/clean']],
  ['set +o physical after set -P', 'set -P; set +o physical; cd /clean/link/.. && git commit -m msg', ['/clean']],
  ['set -e alone', 'set -e; cd /clean/link/.. && git commit -m msg', ['/clean']],
  // may or may not have run: both readings are checked
  ['set -P in an if', 'if x; then set -P; fi; cd /clean/link/.. && git commit -m msg', ['/clean', '/clean/link/..']],
  ['set -P after &&', 'true && set -P; cd /clean/link/.. && git commit -m msg', ['/clean', '/clean/link/..']],
  ['set -P in bash -c code', `bash -c 'set -P; git commit -m x'; cd /clean/link/.. && git commit -m msg`, ['', '/clean', '/clean/link/..']],
  ['set with a variable', 'set $OPTS; cd /clean/link/.. && git commit -m msg', ['/clean', '/clean/link/..']],
  ['set -- $args does not touch it', 'set -- $ARGS; cd /clean/link/.. && git commit -m msg', ['/clean']],
  ['an uncertain cd -P', 'cd -P /clean/link; cd .. && git commit -m msg', ['/', '/clean/link/..']],
]
for (const [name, command, asked] of PHYSICAL) {
  test(`a resolved directory is resolved by git too: ${name}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, cwd: '/scratch' })
    expect((await call($, { tool: 'Bash', command })).deny).toBeUndefined()
    expect(dirsAsked(argvs)).toEqual([...asked].sort())
  })
}

test('cd -P /clean/link && cd .. && git commit is blocked with a .env staged where it lands', async ($, on) => {
  gitStub(on, { outside: true, dirty: '/clean/link/..' })
  expect((await call($, { tool: 'Bash', command: 'cd -P /clean/link && cd .. && git commit -m msg' })).deny).toContain('would include a .env file')
})

// Verifier, PR #36: from a subfolder ls-files lists only that folder, while
// git add -A stages the whole tree. The listing must cover the whole tree.
const LS = 'ls-files -z --full-name --modified --others --exclude-standard -- :/'
for (const command of [
  `cd ${DIR}/sub && git add -A && git commit -m x`,
  `cd ${DIR}/sub && git add . && git commit -m x`,
  `cd ${DIR}/sub && git add -u && git commit -m x`,
  `cd ${DIR}/sub && git add :/ && git commit -m x`,
  `cd ${DIR}/sub && git commit -am x`,
  `git -C ${DIR}/sub add -A && git -C ${DIR}/sub commit -m x`,
]) {
  test(`a .env outside the subfolder is still found: ${command}`, async ($, on) => {
    const argvs: string[][] = []
    const envs: (Record<string, string> | undefined)[] = []
    // the stub's listing stands for the whole tree, as :/ asks of git
    gitStub(on, { argvs, envs, tree: 'sub/keep.txt\n.env\n', outside: true })
    const r = await call($, { tool: 'Bash', command })
    expect(r.deny).toContain('could stage and commit .env')
    const at = argvs.findIndex(a => a.includes('ls-files'))
    expect(argvs[at].join(' ')).toBe(`git -C ${DIR}/sub ${LS}`)
    // GIT_LITERAL_PATHSPECS=1 would read :/ as a file name and list nothing
    expect(envs[at]).toEqual({ GIT_LITERAL_PATHSPECS: '0' })
  })
}

test('the index is read whole from a subfolder, whatever diff.relative says', async ($, on) => {
  const argvs: string[][] = []
  gitStub(on, { argvs, index: '.env\n', outside: true })
  const r = await call($, { tool: 'Bash', command: `cd ${DIR}/sub && git commit -m x` })
  expect(r.deny).toContain('would include a .env file')
  expect(argvs.map(a => a.join(' '))).toEqual([`git -C ${DIR}/sub -c diff.relative=false diff --cached --name-only -z`])
})

// Codex, PR #36: without -z git quotes an unusual name ("caf\303\251/.env"),
// which then doesn't end in .env. With -z each name comes as it is.
const ODD_NAMES = ['café/sub/.env', 'a"b c/.env', 'back\\slash/.env', 'tab\there/.env', 'new\nline/.env', '日本/.env.local']
for (const name of ODD_NAMES) {
  test(`a staged .env with an unusual path is found: ${JSON.stringify(name)}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, raw: true, index: `src/a.ts\0${name}\0` })
    expect((await call($, { tool: 'Bash', command: 'git commit -m x' })).deny).toContain('would include a .env file')
    expect(argvs[0]).toContain('-z')
  })
  test(`an untracked .env with an unusual path is found from a subfolder: ${JSON.stringify(name)}`, async ($, on) => {
    const argvs: string[][] = []
    gitStub(on, { argvs, raw: true, tree: `README.md\0${name}\0`, outside: true })
    const r = await call($, { tool: 'Bash', command: `cd ${DIR}/café/sub && git add -A && git commit -m x` })
    expect(r.deny).toContain(`could stage and commit ${name}`)
    expect(argvs.find(a => a.includes('ls-files'))).toContain('-z')
  })
}

test('a name with a newline before .env is one name, not a .env', async ($, on) => {
  // "notes\n.env" is a single odd file, not .env: with -z it is read whole
  gitStub(on, { raw: true, index: 'notes\n.env\0src/a.ts\0' })
  expect((await call($, { tool: 'Bash', command: 'git commit -m x' })).deny).toBeUndefined()
})

test('a clean -z listing with unusual names lets the commit through', async ($, on) => {
  gitStub(on, { raw: true, index: 'café/a.ts\0a"b c/x.env.example\0', tree: 'café/sub/keep.txt\0', outside: true })
  expect((await call($, { tool: 'Bash', command: `cd ${DIR}/café/sub && git add -A && git commit -m x` })).deny).toBeUndefined()
})
