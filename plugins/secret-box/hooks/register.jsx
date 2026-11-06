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
// the values in .env, and guards commits. Nothing is written but the env file
// the secret goes to (.env by default) and its .gitignore line.

import { register as redactor, LIVE_TAG_TOOLS, brand } from './redact.ts'
import { keepSecret } from './detect.ts'

const TOOL = 'mcp__secret-box__request_secret'
const PANE = 'secret-box'
const DOT = '•'

// The one request being collected right now. The real value lives only here,
// in the mod's memory, until it is saved.
let pending = null // { name, reason, file, value, answer, isInBand, startedAt }

// How long the box waits for the person before it gives up
const WAIT_MS = 10 * 60_000

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
    // The box needs a person to paste into, so a headless run gets no request_secret tool
    if (e.isInteractive !== false) await registerBox($)
    await learnDotenv($, ['.env'])
    return next(e)
  })

  // The desktop app and the editors start the session headless (through the
  // SDK) and attach their surface after: the box can draw there, so the tool
  // comes now. A -p run never attaches. A name registered again is replaced.
  on('session.attach', async ($, e, next) => {
    await registerBox($)
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
    // .env, .env.local ...: a file name in the project folder, never a path.
    // No empty or trailing part: Windows drops a trailing dot, so .env.example.
    // would write the committed .env.example.
    const file = String(e.file || '.env').trim()
    if (!isEnvFile(file) || !/^\.env(\.[\w-]+)*$/.test(file)) {
      return { result: `"${file}" is not an env file name. Use .env or a name like .env.local, with no folder.` }
    }
    const now = await $.clock.now()
    // A request past its deadline has no loop left waiting on it: drop it
    if (pending && now - pending.startedAt > WAIT_MS) pending = null
    if (pending) return { result: `secret-box is already waiting for ${pending.name}. Ask for one secret at a time.` }

    // `answer` stays undefined until Enter (the value) or Escape (empty).
    // This call's own request: a stalled call that wakes late reads and clears only its own.
    const req = { name, reason: String(e.reason || ''), file, value: '', answer: undefined, isInBand: false, startedAt: now }
    pending = req
    let value
    try {
      const opened = await $.ui.open({ id: PANE, title: 'secret-box', focus: true, closeOnEscape: true, holdToasts: true, rows: 7 })
      // A narrow terminal (under 144 columns) keeps the pane undrawn: use the band above the prompt instead
      if (!opened.isPlaced) {
        req.isInBand = true
        await $.ui.close({ id: PANE })
        $.ui.invalidate('ui.render')
        $.ui.toast(`Claude wants ${name}: press ctrl+x then tab to type it in the box above the prompt`, { timeoutMs: 10000 })
      }

      // A hook's own run time is capped at 10 s, but time inside a mods API call
      // is not counted, so wait for the person in short processes.
      const deadline = now + WAIT_MS
      while (req.answer === undefined && !next.signal.aborted && (await $.clock.now()) < deadline) {
        await pause($)
      }
      value = req.answer
    } catch (err) {
      return { result: `secret-box could not wait for the box: ${String(err && err.message || err).slice(0, 300)}. Nothing was saved.` }
    } finally {
      // Always let go, whatever threw. The hook's own .catch is not enough: when
      // a hook above it in this plugin answers first, that .catch never runs,
      // and a request left set blocks every later call.
      if (pending === req) pending = null
      try { await $.ui.close({ id: PANE }) } catch {}
      $.ui.invalidate('ui.render')
    }
    if (!value) return { result: `The user cancelled. ${name} was not saved.` }

    try {
      // The project root, not the shell's working directory: after a `cd` into a
      // source folder (an Xcode app folder, a src/ that is bundled whole) the key
      // would end up inside the shipped product.
      const dir = (await $.session.root().catch(() => '')) || await $.session.cwd()
      const where = await saveToDotenv($, dir, file, name, value)
      const tag = keepSecret(value)
      $.ui.toast(`${name} saved to ${where}`)
      // The ONLY things Claude learns: the name, the place, and a placeholder
      // The safe way first: a placeholder in a command that leaves the machine
      // (more so with the sandbox off) can be refused as credential leakage,
      // while code that reads the file passes.
      return { result: `The user entered ${name}. It was saved to ${where}. You can't see the value. To use it, prefer code that reads ${name} from that file (or from the environment once the file is loaded). As a fallback, write ${tag} in a command or a file: it becomes the real value when the tool runs and is hidden again in the output. A command that sends the placeholder off the machine, especially with the sandbox disabled, may be refused by the permission check.` }
    } catch (err) {
      return { result: `Saving ${name} failed: ${String(err && err.message || err).slice(0, 300)}` }
    }
  }).catch(async ($, e, next) => {
    // If the hook itself fails (or times out), close the box and tell Claude plainly.
    // Its own request was let go in `finally`; one another call holds is left alone.
    try { await $.ui.close({ id: PANE }) } catch {}
    $.ui.invalidate('ui.render')
    $.ui.log('request_secret failed: ' + String(next.error && next.error.message).slice(0, 300))
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
      return await $.process.run(waits[0], { timeoutMs: 5000 })
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
// The request_secret tool: what Claude reads about it
async function registerBox($) {
  await $.tool.register({
    name: 'request_secret',
    description:
      'Ask the user for a secret (API key, token, password) without it ever entering the conversation. ' +
      'The user pastes it into a masked box and the mod saves it to the project .env (or the env file named ' +
      'in `file`, such as .env.local). You get back the ' +
      'variable name, the absolute path of the file it was saved to, and a placeholder like ' +
      '[REDACTED-SECRET-1a2b3c4d]. Prefer code that reads the variable from that file. A placeholder written ' +
      'in a command or file becomes the real value when the tool runs, but a command that sends it off the ' +
      'machine can be refused by the permission check. Use this INSTEAD of asking the user to ' +
      'paste a secret into chat.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Environment variable name, e.g. STRIPE_SECRET_KEY' },
        reason: { type: 'string', description: 'One short line telling the user why it is needed' },
        file: { type: 'string', description: 'Env file in the project folder to save to, e.g. .env.local. Default .env' },
      },
      required: ['name', 'reason'],
    },
    isDeferred: false,
  })
}

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

// Split a shell command into its simple commands, in order, the way bash
// reads it: quotes, escapes, $VAR / ${VAR}, $( ) and backticks, heredocs.
// A word is a list of parts: { lit, q } text (q: it was quoted), { name } a
// variable, { sub } anything else that expands ($(..), $1, ${x:-y} ...).
// The commands inside $( ) and backticks come out as commands too, and so do
// a quoted string or a heredoc body that itself runs git (bash -c '...',
// ssh host "...", bash <<EOF): a miss there would skip a repository.
function shellCommands(src) {
  const out = []
  let i = 0
  const parse = (inSub) => {
    let words = []
    let word = null
    let depth = 0
    // Whether the next command surely runs once its turn comes: it starts the
    // command or follows ; or a newline, outside ( ), $( ) and every if, loop,
    // case or { } body (ctl counts those open, across newlines), and is not a
    // member of a pipe or a & background job (a subshell)
    let sureNext = true
    let ctl = 0
    // After && || or |, a newline continues the list rather than ending it
    let cont = false
    const heredocs = []
    const begin = () => {
      cont = false
      word ??= { parts: [], start: i }
    }
    const part = (p) => {
      begin()
      const last = word.parts.at(-1)
      if (p.lit !== undefined && last?.lit !== undefined && last.q === p.q) last.lit += p.lit
      else word.parts.push(p)
    }
    const endWord = () => {
      if (word) words.push({ ...word, raw: src.slice(word.start, i) })
      word = null
    }
    const endCmd = (alone = true) => {
      endWord()
      if (words.length) {
        words.sure = alone && sureNext && ctl === 0 && depth === 0 && !inSub
        // if, while ... and { open a body, fi, done, esac and } close one:
        // as the leading words, and { after `function name`
        for (const w of words) {
          const t = literal(w) ?? ''
          if (/^(if|while|until|for|select|case|\{)$/.test(t)) ctl++
          else if (/^(fi|done|esac|\})$/.test(t)) ctl = Math.max(0, ctl - 1)
          else if (t === 'function') {
            if (words.some(x => literal(x) === '{')) ctl++
            break
          } else if (!/^(then|do|else|elif|!|time)$/.test(t)) break
        }
        out.push(words)
      }
      words = []
    }
    // A quoted string or heredoc body that runs git is shell code: read it too
    const nested = (text) => {
      if (gitRuns(text, 'commit|add|stage')) out.push(...unsure(shellCommands(text)))
    }
    const subst = () => {
      // at "$(": read the commands up to the matching ")"
      i += 2
      parse(true)
      i++
    }
    const dollar = () => {
      begin()
      const start = i
      if (src.startsWith('$((', i)) {
        const end = src.indexOf('))', i)
        i = end < 0 ? src.length : end + 2
        return part({ sub: src.slice(start, i) })
      }
      if (src[i + 1] === '(') {
        subst()
        return part({ sub: src.slice(start, i) })
      }
      if (src[i + 1] === '{') {
        const end = src.indexOf('}', i)
        i = end < 0 ? src.length : end + 1
        const inner = src.slice(start + 2, i - 1)
        return part(/^[A-Za-z_]\w*$/.test(inner) ? { name: inner, raw: src.slice(start, i) } : { sub: src.slice(start, i) })
      }
      const name = src.slice(i + 1).match(/^[A-Za-z_]\w*/)
      if (name) {
        i += 1 + name[0].length
        return part({ name: name[0], raw: src.slice(start, i) })
      }
      if (/[0-9@*#?$!-]/.test(src[i + 1] || '')) {
        i += 2
        return part({ sub: src.slice(start, i) })
      }
      i++
      part({ lit: '$', q: false })
    }
    const backtick = () => {
      begin()
      const start = i
      let body = ''
      for (i++; i < src.length && src[i] !== '`'; i++) body += src[i] === '\\' && i + 1 < src.length ? src[++i] : src[i]
      i++
      out.push(...unsure(shellCommands(body)))
      part({ sub: src.slice(start, i) })
    }
    const readHeredocs = () => {
      for (const h of heredocs.splice(0)) {
        let body = ''
        while (i < src.length) {
          let end = src.indexOf('\n', i)
          if (end < 0) end = src.length
          const line = src.slice(i, end)
          i = Math.min(end + 1, src.length)
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          body += line + '\n'
        }
        nested(body)
      }
    }
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\n') {
        endCmd()
        if (!cont) sureNext = true
        i++
        readHeredocs()
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        endWord()
        i++
      } else if (ch === '#' && !word) {
        while (i < src.length && src[i] !== '\n') i++
      } else if (ch === ')' && inSub && depth === 0) {
        endCmd()
        return
      } else if (ch === '&' && src[i + 1] === '>') {
        // &> file: a redirection, not a background job
        endWord()
        i += src[i + 2] === '>' ? 3 : 2
      } else if (';&|()'.includes(ch)) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        // a single | or & puts the command before it in a subshell
        const isSub = (ch === '|' || ch === '&') && src[i + 1] !== ch && src[i - 1] !== ch
        endCmd(!isSub)
        sureNext = ch === ';'
        cont = ch === '&' || ch === '|'
        i++
      } else if (src.startsWith('<<', i) && src[i + 2] !== '<') {
        // a heredoc: its body starts on the next line, and is not shell code
        endWord()
        i += 2
        const strip = src[i] === '-'
        if (strip) i++
        while (src[i] === ' ' || src[i] === '\t') i++
        const m = src.slice(i).match(/^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/)
        if (m) {
          heredocs.push({ delim: m[1] ?? m[2] ?? m[3], strip })
          i += m[0].length
        }
      } else if (ch === '<' || ch === '>') {
        // a redirection: 2>&1, >&2, <<< ... (its target is the next word)
        endWord()
        while (src[i] === '<' || src[i] === '>') i++
        if (src[i] === '&') for (i++; /[0-9-]/.test(src[i] || ''); i++);
      } else if (ch === "'") {
        let end = src.indexOf("'", i + 1)
        if (end < 0) end = src.length
        const text = src.slice(i + 1, end)
        part({ lit: text, q: true })
        i = end + 1
        nested(text)
      } else if (ch === '$' && src[i + 1] === "'") {
        begin()
        let text = ''
        for (i += 2; i < src.length && src[i] !== "'"; i++) text += src[i] === '\\' && i + 1 < src.length ? src[++i] : src[i]
        i++
        part({ lit: text, q: true })
      } else if (ch === '"') {
        let text = ''
        part({ lit: '', q: true })
        for (i++; i < src.length && src[i] !== '"';) {
          if (src[i] === '\\' && '$`"\\\n'.includes(src[i + 1] || 'x')) {
            if (src[i + 1] !== '\n') part({ lit: src[i + 1], q: true })
            text += src.slice(i, i + 2)
            i += 2
          } else if (src[i] === '$') {
            const at = i
            dollar()
            text += src.slice(at, i)
          } else if (src[i] === '`') {
            const at = i
            backtick()
            text += src.slice(at, i)
          } else {
            part({ lit: src[i], q: true })
            text += src[i++]
          }
        }
        i++
        nested(text)
      } else if (ch === '\\') {
        // An escaped space, quote or operator is that character. Any other
        // backslash stays: C:\repo is a Windows path, not C:repo.
        const next = src[i + 1]
        if (next === '\n') i += 2
        else if (next !== undefined && /[\s'"$`;&|<>(){}*?#!~\[\]]/.test(next)) {
          part({ lit: next, q: true })
          i += 2
        } else {
          part({ lit: '\\', q: false })
          i++
        }
      } else if (ch === '$') {
        dollar()
      } else if (ch === '`') {
        backtick()
      } else {
        part({ lit: ch, q: false })
        i++
      }
    }
    endCmd()
  }
  parse(false)
  return out
}

// A word as written, for a message: "$W" shows as $W
function unquoted(raw) {
  return String(raw || '').replace(/["']/g, '') || '?'
}

// Commands read out of a quoted string, a heredoc or backticks may never run
function unsure(cmds) {
  for (const c of cmds) c.sure = false
  return cmds
}

// A word that is only literal text, as the command will see it
function literal(word) {
  return word.parts.every(p => p.lit !== undefined) ? word.parts.map(p => p.lit).join('') : null
}

// Every text a word could expand to, from what the command assigns (and
// HOME); null when one of them can't be known: $(..), a variable set elsewhere.
async function expand($, word, vars, at, seen = new Set()) {
  let texts = ['']
  for (const [n, p] of word.parts.entries()) {
    let options
    if (p.lit !== undefined) {
      // ~ at the start of an unquoted word is the home folder
      if (n === 0 && !p.q && /^~(\/|\\|$)/.test(p.lit)) {
        const home = await values($, vars, 'HOME', at, seen)
        if (!home) return null
        options = home.map(h => h + p.lit.slice(1))
      } else options = [p.lit]
    } else if (p.name !== undefined) {
      options = await values($, vars, p.name, at, seen)
      if (!options) return null
    } else return null
    texts = texts.flatMap(t => options.map(o => t + o))
    if (texts.length > MAX_DIRS) return null
  }
  return [...new Set(texts)]
}
const MAX_DIRS = 16

// Every value a variable could hold at command `at`: each value the command
// assigns it anywhere, plus the value it had before when no assignment has
// surely run by then. A hook reads only the environment variables it names,
// so HOME is the one known from outside the command.
async function values($, vars, name, at, seen) {
  const own = vars.get(name)
  const out = []
  if (own) {
    if (seen.has(name)) return null // W=$W/x
    for (const w of own.words) {
      const v = w && (await expand($, w, vars, at, new Set([...seen, name])))
      if (!v) return null
      out.push(...v)
    }
    if (own.sureAt < at) return [...new Set(out)]
  }
  if (name !== 'HOME') return null
  try {
    const home = await $.env.get('HOME')
    return home == null ? null : [...new Set([...out, home])]
  } catch { return null }
}

// What a command assigns: name -> every value word given to it anywhere
// (null for a value that can't be known). Not in order and never replaced:
// `false && W=/x`, a loop, or `W=` in a message read as code may or may not
// run, so the guard checks every directory a -C could be.
function assignments(cmds) {
  const vars = new Map()
  // sureAt: the first command index where an assignment has surely run
  const add = (name, word, at) => {
    if (!name) return
    if (!vars.has(name)) vars.set(name, { words: [], sureAt: Infinity })
    const v = vars.get(name)
    v.words.push(word)
    if (at !== undefined) v.sureAt = Math.min(v.sureAt, at)
  }
  const assignment = w => !w.parts[0].q && w.parts[0].lit?.match(/^([A-Za-z_]\w*)=/)
  for (const [at, all] of cmds.entries()) {
    // then W=/x, do W=/x ...: inside a branch or a loop
    const lead = all.findIndex(w => !/^(if|then|elif|else|do|while|until|!|\{|time)$/.test(literal(w) ?? ''))
    if (lead < 0) continue
    const words = all.slice(lead)
    const first = literal(words[0]) ?? ''
    // W=/x, W=/x git ..., export / declare / local / readonly W=/x. Only an
    // assignment alone, run for sure, sets W for what follows; W=/x git ...
    // sets it for that git only, which still expands $W to the old value.
    const isDeclare = /^(export|declare|typeset|local|readonly)$/.test(first)
    const sure = all.sure && lead === 0 && (isDeclare || words.every(assignment)) ? at : undefined
    for (const w of isDeclare ? words.slice(1) : words) {
      const m = assignment(w)
      if (!m) {
        if (isDeclare) continue
        break
      }
      add(m[1], { parts: [{ ...w.parts[0], lit: w.parts[0].lit.slice(m[0].length) }, ...w.parts.slice(1)] }, sure)
    }
    // A loop, unset or read sets a variable to something the command can't tell
    if (/^(for|select)$/.test(first) && words[1]) add(literal(words[1]), null, at)
    if (/^(unset|read|mapfile|readarray|getopts)$/.test(first)) {
      for (const w of words.slice(1)) if (!/^-/.test(literal(w) ?? '-')) add(literal(w), null, at)
    }
  }
  return vars
}

// The repositories a command's git calls run in: each `git -C <dir>`, and the
// session's own repository ('') for a plain `git`. A directory that can't be
// worked out comes back as { unresolved: the text as written }.
async function gitDirs($, cmd) {
  const dirs = new Map()
  const cmds = shellCommands(cmd)
  const vars = assignments(cmds)
  for (const [index, words] of cmds.entries()) {
    // git, git.exe or a path to it; then its global options, up to the subcommand
    const at = words.findIndex(w => /(^|[\\/])git(\.exe)?$/i.test(literal(w) ?? ''))
    if (at < 0) continue
    let found = ['']
    let unresolved = null
    for (let k = at + 1; k < words.length; k++) {
      const opt = literal(words[k])
      let value = null
      if (opt === '-C') value = words[++k]
      else if (opt === null && words[k].parts[0].lit?.startsWith('-C') && !words[k].parts[0].q) {
        value = { parts: [{ ...words[k].parts[0], lit: words[k].parts[0].lit.slice(2) }, ...words[k].parts.slice(1)], raw: words[k].raw.slice(2) }
      } else if (opt?.startsWith('-C')) value = { parts: [{ lit: opt.slice(2), q: false }], raw: opt.slice(2) }
      else if (opt === '-c' || /^--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env)$/.test(opt ?? '')) k++
      else if (!/^-/.test(opt ?? words[k].parts[0].lit ?? '')) break
      if (!value) continue
      const texts = await expand($, value, vars, index)
      if (!texts) {
        unresolved ??= unquoted(value.raw)
        continue
      }
      // git -C a -C b runs in a/b; an absolute -C starts over
      found = found.flatMap(dir => texts.map(text => (!dir || isAbsolute(text) || text === '' ? text || dir : dir.replace(/[\\/]$/, '') + '/' + text)))
      if (found.length > MAX_DIRS) unresolved ??= unquoted(value.raw)
    }
    if (unresolved !== null) dirs.set('?' + unresolved, { unresolved })
    else for (const dir of found) dirs.set(dir, dir)
  }
  // gitRuns saw a commit, but no git call came out here: check the session's repository
  if (dirs.size === 0) dirs.set('', '')
  return [...dirs.values()]
}

// Whether the command runs `git` as a command, then one of `subs`: not the
// same words inside a URL, a file name or an argument. git may follow ; & | (
// { ! ` $( a quote or a newline, then VAR=x assignments, if/then/do/while ...
// and wrappers with their options (sudo -u x --, env -i, xargs -0, time ...),
// as git, git.exe or a path to it, then its global options (-c x, -C dir,
// --git-dir dir, --no-pager ...).
// A miss lets a .env commit through, so when unsure this matches.
const ARG = String.raw`(?:"[^"]*"|'[^']*'|[^\s-]\S*)`
// Wrapper options that take a value (sudo -u x, env -u X, xargs -I {} ...).
// Each token has one reading only, so a long command can't make the regex backtrack.
const VALUE_OPTS = 'ugCDhprtUSadEILnPs'
function gitRunPattern(subs, flags) {
  const start = String.raw`(?:^|[;&|(\x60\n'"{!]|\$\()\s*`
  const option = String.raw`(?:-[${VALUE_OPTS}]\s+[^\s;&|]+|-(?![${VALUE_OPTS}](?:\s|$))\S*)`
  const wrap = String.raw`((?:(?:\w+=${ARG}|if|then|do|else|elif|while|until|(?:time|nohup|exec|xargs|nice|command|env|sudo)(?:\s+${option})*|!|\{)\s+)*)`
  const git = String.raw`(?:"[^"]*[\/\\]git(?:\.exe)?"|'[^']*[\/\\]git(?:\.exe)?'|(?:[^\s"';&|]*[\/\\])?git(?:\.exe)?)`
  const long = 'git-dir|work-tree|namespace|exec-path|super-prefix|config-env'
  const opts = String.raw`(?:\s+(?:-[cC]\s*${ARG}|--(?:${long})(?:=|\s+)${ARG}|--(?!(?:${long})\b)[\w-]+(?:=\S+)?|-[pP]))*`
  // Group 1: the wrappers before git. Group 2: the sub-command's own arguments,
  // up to the next ; & | or newline (a redirection such as 2>&1 or &> does not end them).
  return new RegExp(`${start}${wrap}${git}${opts}\\s+(?:${subs})\\b((?:[^;&|\\n]|[<>]&|&>)*)`, flags)
}
function gitRuns(cmd, subs) {
  return gitRunPattern(subs, '').test(cmd)
}

// Whether a git add / git stage in the command names a .env file: in its own
// arguments, or, when xargs runs it, anywhere before it (the file list comes
// in on stdin). A .env elsewhere in the command (node --env-file=.env, cat .env,
// a second command) is not staged by the add, unless the add's arguments are
// expanded by the shell ($f, `...`, a glob), where any .env could be what they name.
const STAGED_ENV = /\.env\b(?!\.(example|sample|template|dist))/
function addsEnvFile(cmd) {
  for (const m of cmd.matchAll(gitRunPattern('add|stage', 'g'))) {
    if (STAGED_ENV.test(m[2])) return true
    if (/\bxargs\b/.test(m[1]) && STAGED_ENV.test(cmd.slice(0, m.index))) return true
    if (/[$\x60*?[]/.test(m[2]) && STAGED_ENV.test(cmd)) return true
  }
  return false
}

// Why a Bash command must be blocked: it stages or commits a .env file
async function commitBlockReason($, cmd) {
  if (addsEnvFile(cmd)) {
    return 'staging a .env file is blocked.'
  }
  if (!gitRuns(cmd, 'commit')) return ''
  // The index is read before the command runs. If the same command stages
  // (git add ... && git commit, or commit -a), count what it could stage too:
  // every changed or untracked file git does not ignore.
  const stages = gitRuns(cmd, 'add|stage') || /\bcommit\b[^;&|]*\s(-a|--all|-\w*a\w*)\b/.test(cmd)
  // In these two cases nothing was checked: say so, so a parsing problem
  // doesn't read like a found secret, or like a clean check
  const unsure = 'This is not a detected .env: the guard could not check this commit, so it blocks it. Name the directory plainly (git -C /path/to/repo) or commit in a separate call.'
  for (const dir of await gitDirs($, cmd)) {
    if (typeof dir !== 'string') return `couldn't resolve the git -C directory \`${dir.unresolved}\` (a variable this command does not set itself, a substitution, or too many possible values). ${unsure}`
    const git = (...args) => $.process.run(['git', ...(dir ? ['-C', dir] : []), ...args])
    const checks = [git('diff', '--cached', '--name-only')]
    if (stages) checks.push(git('ls-files', '--modified', '--others', '--exclude-standard'))
    for (const r of await Promise.all(checks)) {
      if (r.exitCode !== 0) {
        const said = String(r.stderr || '').trim().split('\n')[0]
        return `couldn't read git state in ${dir || 'the session directory'}${said ? ` (git: ${said})` : ''}. ${unsure}`
      }
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

async function saveToDotenv($, cwd, file, name, value) {
  // A file git tracks would carry the secret into the next commit: refuse it
  let tracked = null
  try { tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', file], { cwd }) } catch {}
  if (tracked && tracked.exitCode === 0) throw new Error(`${file} is tracked by git, so a secret in it would be committed. Pick another file.`)

  // .gitignore first: if that write fails, the secret is never on disk un-ignored
  // C:\proj\.env on Windows, not C:\proj/.env: Claude may copy the path into a command
  const sep = /^[A-Za-z]:\\|^\\\\/.test(cwd) ? '\\' : '/'
  const gi = cwd + sep + '.gitignore'
  const ignore = (await $.fs.exists(gi)) ? await $.fs.read(gi) : ''
  const isIgnored = await gitIgnores($, cwd, file, ignore)
  if (!isIgnored) await $.fs.write(gi, ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + file + '\n')

  const path = cwd + sep + file
  const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const line = `${name}=${quote(value)}`
  const lines = old.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === ''))
  const at = lines.findIndex(l => l.startsWith(name + '='))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  await $.fs.write(path, lines.join('\n') + '\n')
  return path + (isIgnored ? '' : ` (and added ${file} to ${gi})`)
}

// Whether git already ignores the file (any pattern, e.g. `.env*.local`).
// Outside a repository, look for the plain patterns in .gitignore instead.
async function gitIgnores($, cwd, file, ignore) {
  let r = null
  try { r = await $.process.run(['git', 'check-ignore', '-q', file], { cwd }) } catch {}
  if (r && (r.exitCode === 0 || r.exitCode === 1)) return r.exitCode === 0
  const plain = [file, '/' + file, '.env*', ...(file === '.env' ? ['*.env'] : [])]
  return ignore.split('\n').some(l => plain.includes(l.trim()))
}

// Plain values stay bare; anything with spaces, quotes or # gets double quotes.
function quote(v) {
  return /^[A-Za-z0-9_\-.\/:+=@]*$/.test(v) ? v : '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}
