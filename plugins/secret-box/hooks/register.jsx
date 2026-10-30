// secret-box: Claude can use a secret without ever seeing it.
//
// Pattern: guard what you can't undo. A secret in the conversation is in the
// transcript for good, so it must never get there:
//   - In: Claude calls request_secret, you paste the value into a masked box,
//     the mod writes it to .env and hands Claude a placeholder.
//   - Out: every secret a tool would show Claude (a `cat .env`, an API answer,
//     a key you paste) is swapped for a placeholder like [REDACTED-SECRET-1a2b3c4d].
//   - Use: a placeholder in a tool's input becomes the real value as the tool
//     runs, so `curl -H "Authorization: Bearer [REDACTED-SECRET-...]"` works.
//   - Never: committing .env is refused, since a pushed key can't be taken back.
//
// The redaction is transcript-redactor, unchanged (./redact.ts, ./detect.ts):
// its hooks do the In, Out and Use. This file adds the box, teaches the vault
// the values in .env, and guards commits. Nothing is written but .env.

import { register as redactor, LIVE_TAG_TOOLS, brand } from './redact.ts'
import { keepSecret } from './detect.ts'

const TOOL = 'mcp__secret-box__request_secret'
const PANE = 'secret-box'
const DOT = '•'

// The one request being collected right now. The real value lives only here,
// in the mod's memory, until it is saved.
let pending = null // { name, reason, value, answer, isInBand }

// A .env key whose name says it holds a secret
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|AUTH|PRIVATE|DSN|SALT|SIGNING|WEBHOOK/i
const ASSIGNMENT = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*)$/gm

export function register(on, options) {
  // request_secret answers with a live placeholder: keep it live
  LIVE_TAG_TOOLS.add(TOOL)
  brand.name = 'secret-box'
  redactor(on, options || {})

  // 1. Give Claude the tool, and teach the vault the secrets already in .env
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'request_secret',
      description:
        'Ask the user for a secret (API key, token, password) without it ever entering the conversation. ' +
        'The user pastes it into a masked box and the mod saves it to the project .env. You get back the ' +
        'variable name and a placeholder like [REDACTED-SECRET-1a2b3c4d]. Write that placeholder in a command ' +
        'or file and it becomes the real value when the tool runs. Use this INSTEAD of asking the user to ' +
        'paste a secret into chat.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Environment variable name, e.g. STRIPE_SECRET_KEY' },
          reason: { type: 'string', description: 'One short line telling the user why it is needed' },
        },
        required: ['name', 'reason'],
      },
      isDeferred: false,
    })
    await learnDotenv($, ['.env'])
    return next(e)
  })

  // 2. The guard: .env may be read (its secrets come back hidden), never committed
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const why = await commitBlockReason($, String(e.command || ''))
    return why ? { deny: `secret-box: ${why} A pushed key can't be taken back.` } : next(e)
  }).catch(() => ({ deny: 'secret-box: the .env guard failed, so this call is blocked to be safe.' }))

  // 3. A call that reads a .env file: learn its secret values before it runs,
  //    so the redactor hides them in the output even when they look weak
  //    (a word password). Reading .env is fine; its secrets come back hidden.
  on('tool.call', { tool: /^(Bash|Read|Grep|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const files = envFiles(e)
    if (files.length > 0) await learnDotenv($, files)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'secret-box: could not check this .env file, so the call is blocked to be safe.' }))

  // @.env would attach the raw file to your prompt
  on('prompt.mention', { path: /(^|[\\/])\.env(\.[\w.-]+)?$/ }, async ($, e, next) =>
    isEnvFile(e.path) ? { deny: 'secret-box: ask Claude to read .env instead; its secrets come back hidden' } : next(e))
    .catch(() => ({ deny: 'secret-box: the .env guard failed' }))

  // 4. The box. Claude calls the tool: open it, wait for you, save, answer.
  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const name = String(e.name || '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { result: `"${name}" is not a valid variable name. Use letters, digits and underscores.` }
    }
    // A plain -p run has no one to type into the box
    if ((await $.session.surfaces()).length === 0) {
      return { result: `secret-box needs an interactive session to collect ${name}. Ask the user to run Claude Code interactively.` }
    }
    if (pending) return { result: `secret-box is already waiting for ${pending.name}. Ask for one secret at a time.` }

    // `answer` stays undefined until Enter (the value) or Escape (empty)
    pending = { name, reason: String(e.reason || ''), value: '', answer: undefined, isInBand: false }
    const opened = await $.ui.open({ id: PANE, title: 'secret-box', focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
    // A narrow terminal (under 144 columns) keeps the pane undrawn: use the band above the prompt instead
    if (!opened.isPlaced) {
      pending.isInBand = true
      await $.ui.close({ id: PANE })
      $.ui.invalidate('ui.render')
      $.ui.toast(`Claude wants ${name}: press ctrl+x then tab to type it in the box above the prompt`, { timeoutMs: 10000 })
    }

    // A hook's own run time is capped at 10 s, but time inside a mods API call
    // is not counted, so wait for the person in short `sleep` processes.
    const deadline = (await $.clock.now()) + 10 * 60_000
    while (pending.answer === undefined && !next.signal.aborted && (await $.clock.now()) < deadline) {
      await pause($)
    }
    const value = pending.answer
    pending = null
    await $.ui.close({ id: PANE })
    $.ui.invalidate('ui.render')
    if (!value) return { result: `The user cancelled. ${name} was not saved.` }

    try {
      const where = await saveToDotenv($, await $.session.cwd(), name, value)
      const tag = keepSecret(value)
      $.ui.toast(`${name} saved to ${where}`)
      // The ONLY things Claude learns: the name, the place, and a placeholder
      return { result: `The user entered ${name}. It was saved to ${where}. You can't see the value. To use it in a command or a file, write ${tag}: it becomes the real value when the tool runs and is hidden again in the output. Code should read it from the environment.` }
    } catch (err) {
      return { result: `Saving ${name} failed: ${String(err && err.message || err).slice(0, 300)}` }
    }
  }).catch(async ($, e, next) => {
    // If the hook itself fails (or times out), drop the request, close the box and tell Claude plainly
    pending = null
    try { await $.ui.close({ id: PANE }) } catch {}
    $.ui.invalidate('ui.render')
    $.ui.log('request_secret failed: ' + JSON.stringify(next.error).slice(0, 500))
    return { result: 'secret-box failed before anything was saved. Nothing was written.' }
  })

  // Draw the box, in our pane or (narrow terminal) in the band above the prompt
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || !pending) return next(e)
    return drawBox($, e, pending)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!pending || !pending.isInBand) return next(e)
    return drawBox($, e, pending)
  })

  // Escape (or any close) on the pane before Enter means cancel
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && pending && !pending.isInBand) pending.answer = ''
    return next(e)
  }).catch(($, e, next) => next(e))
}

// One short wait, in a process, so it is not the hook's own time. Mac and
// Linux have `sleep`. A native Windows terminal does not, so there node waits
// where it is installed, else ping, which every Windows has (about 1 s).
export const WAITS = {
  unix: [['sleep', '0.3']],
  windows: [['node', '-e', 'setTimeout(() => {}, 300)'], ['ping', '-n', '2', '127.0.0.1']],
}
let waits = null
async function pause($) {
  waits ||= [...((await $.env.get('OS')) === 'Windows_NT' ? WAITS.windows : WAITS.unix)]
  for (;;) {
    try {
      return await $.process.run(waits[0])
    } catch (err) {
      // Only a command that is not there moves on to the next one
      if (waits.length > 1 && isNotFound(err)) waits.shift()
      else throw err
    }
  }
}
export function isNotFound(err) {
  return /ENOENT|not found/i.test(String((err && err.message) || err))
}

// .env, .env.local, .env.production ... but not .env.example and friends
export function isEnvFile(path) {
  const base = String(path || '').split(/[\\/]/).pop()
  return /^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)
}

// The .env files a tool call reads or names, as written in the call
function envFiles(e) {
  const direct = [e.file_path, e.notebook_path, e.path].filter(isEnvFile)
  const named = String(e.command || '').match(/(?:^|[^\w.\/-])((?:[\w.\/-]*\/)?\.env(?:\.[\w.-]+)?)(?![\w.-])/g) || []
  return [...direct, ...named.map(m => m.replace(/^[^\w.\/-]/, '')).filter(isEnvFile)]
}

// Read .env files and hand every secret-named value to the vault, so it is
// hidden wherever it turns up. Never throws: a file it can't read teaches it
// nothing, and the redactor still scans the output.
async function learnDotenv($, files) {
  let cwd = ''
  try { cwd = await $.session.cwd() } catch {}
  for (const f of files) {
    try {
      const path = isAbsolute(f) ? f : f.startsWith('~/') ? f : cwd + '/' + f
      if (path.startsWith('~/') || !(await $.fs.exists(path))) continue
      for (const m of (await $.fs.read(path)).matchAll(ASSIGNMENT)) {
        const value = m[3].trim().replace(/^["']|["']$/g, '')
        if (value.length >= 6 && SECRET_NAME.test(m[2])) keepSecret(value)
      }
    } catch {}
  }
}

// /x on Mac and Linux; C:\x, C:/x or \\server\share on Windows
export function isAbsolute(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

// The repositories a command's git calls run in: each `git -C <dir>`, and the
// session's own repository for a plain `git`
function gitDirs(cmd) {
  const dirs = new Set()
  for (const m of cmd.matchAll(/\bgit((?:[ \t]+-c[ \t]+\S+|[ \t]+-C[ \t]+(?:"[^"]*"|'[^']*'|\S+))*)/g)) {
    const c = m[1].match(/-C[ \t]+("[^"]*"|'[^']*'|\S+)/g)
    if (!c) dirs.add('')
    else dirs.add(c.at(-1).replace(/^-C[ \t]+/, '').replace(/^["']|["']$/g, ''))
  }
  return [...dirs]
}

// Why a Bash command must be blocked: it stages or commits a .env file
async function commitBlockReason($, cmd) {
  // Only `git [-c k=v] [-C dir] add|stage <args>` counts, and the .env must be an
  // argument of that add (not `git worktree add`, not .env elsewhere in the command).
  for (const m of cmd.matchAll(/\bgit(?:[ \t]+-c[ \t]+\S+|[ \t]+-C[ \t]+(?:"[^"]*"|'[^']*'|\S+))*[ \t]+(?:add|stage)\b([^;&|]*)/g)) {
    if (/\.env\b(?!\.(example|sample|template|dist))/.test(m[1])) return 'staging a .env file is blocked.'
  }
  if (!/\bgit\b[^;&|]*\bcommit\b/.test(cmd)) return ''
  // The index is read before the command runs. If the same command stages
  // (git add ... && git commit, or commit -a), count what it could stage too:
  // every changed or untracked file git does not ignore.
  const stages = /\bgit\b[^;&|]*\b(add|stage)\b/.test(cmd) || /\bcommit\b[^;&|]*\s(-a|--all|-\w*a\w*)\b/.test(cmd)
  for (const dir of gitDirs(cmd)) {
    const git = (...args) => $.process.run(['git', ...(dir ? ['-C', dir] : []), ...args])
    const checks = [git('diff', '--cached', '--name-only')]
    if (stages) checks.push(git('ls-files', '--modified', '--others', '--exclude-standard'))
    for (const r of await Promise.all(checks)) {
      if (r.exitCode !== 0) return `could not check what this commit includes${dir ? ' in ' + dir : ''}, so it is blocked.`
      const env = r.stdout.split('\n').find(isEnvFile)
      if (env) {
        return stages
          ? `this command could stage and commit ${env}. Add it to .gitignore, or stage named files in a separate step.`
          : 'this commit would include a .env file. Unstage it with git rm --cached.'
      }
    }
  }
  return ''
}

// The field shows dots; the real text is kept in `p.value`, never drawn.
function drawBox($, e, p) {
  const { Box, Text, Input } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Claude is asking for <Text color="yellow">{p.name}</Text></Text>
      {p.reason ? <Text dimColor>{p.reason}</Text> : null}
      <Input
        key="secret"
        label="value "
        placeholder="paste it here, it stays masked"
        value={DOT.repeat(p.value.length)}
        submitLabel="save"
        autoFocus
        onInput={text => {
          // Everything up to the first non-dot is the part we already hold;
          // the rest is what was just typed or pasted. Backspace shortens the dots.
          let kept = 0
          while (kept < text.length && text[kept] === DOT) kept++
          p.value = p.value.slice(0, Math.min(kept, p.value.length)) + text.slice(kept)
          $.ui.invalidate('ui.render')
        }}
        onSubmit={() => { p.answer = p.value }}
      />
      <Text dimColor>{p.value.length ? `${p.value.length} characters · ` : ''}Enter saves · {p.isInBand ? 'ctrl+x tab to focus, Enter on empty cancels' : 'Esc cancels'} · Claude never sees the value</Text>
    </Box>
  )
}

async function saveToDotenv($, cwd, name, value) {
  const path = cwd + '/.env'
  const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const line = `${name}=${quote(value)}`
  const lines = old.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''))
  const at = lines.findIndex(l => l.startsWith(name + '='))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  await $.fs.write(path, lines.join('\n') + '\n')

  const gi = cwd + '/.gitignore'
  const ignore = (await $.fs.exists(gi)) ? await $.fs.read(gi) : ''
  const isIgnored = ignore.split('\n').some(l => ['.env', '.env*', '*.env', '/.env'].includes(l.trim()))
  if (!isIgnored) await $.fs.write(gi, ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '.env\n')
  return '.env' + (isIgnored ? '' : ' (and added .env to .gitignore)')
}

// Plain values stay bare; anything with spaces, quotes or # gets double quotes.
function quote(v) {
  return /^[A-Za-z0-9_\-.\/:+=@]*$/.test(v) ? v : '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}
