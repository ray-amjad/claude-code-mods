// The commit guard for secret-box: whether a Bash command stages or commits a
// .env file. It reads the command the way bash does (quotes, $VAR, $( ),
// heredocs, cd and -C) and asks git which files a run would touch.

// .env, .env.local, .env.production ... but not .env.example and friends
export function isEnvFile(path) {
  const base = String(path || '').split(/[\\/]/).pop()
  return /^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)
}

// git's global long options that take a value (--git-dir dir, --work-tree=dir ...)
const GIT_VALUE_LONG_OPTS = 'git-dir|work-tree|namespace|exec-path|super-prefix|config-env'
const GIT_VALUE_LONG_OPT = new RegExp(`^--(${GIT_VALUE_LONG_OPTS})$`)

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
// `spans`, when given, collects where the text is only data (see withoutData).
function shellCommands(src, spans = null) {
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
    // The command before follows a single |: it runs in a subshell
    let afterPipe = false
    // The operator that ended the last command at this level
    let lastOp
    const heredocs = []
    // Quoted text and heredoc bodies of the command being read, which are only
    // data if it turns out to be a data program whose output is not piped on
    let pending = []
    let owner = { data: false }
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
    // op: what ends the command (&& || ; | & a newline or ), none at the end)
    const endCmd = (alone = true, op) => {
      endWord()
      if (words.length) {
        words.sure = alone && sureNext && ctl === 0 && depth === 0 && !inSub
        // For a cd: it runs in this shell, at the top of the command, not
        // inside a body, a subshell or a pipe. `atLevel`: at the command's own
        // level, where an operator ends a list. `prev`/`op`: around it.
        words.atLevel = depth === 0 && !inSub
        words.top = alone && !afterPipe && ctl === 0 && words.atLevel
        words.prev = lastOp
        words.op = op
        lastOp = op
        // Only at the top: in ( ), { }, an if or a loop the output may still be
        // piped on as a whole: { cat <<'EOF'; } | sh. (A ) has already
        // taken depth down when it ends the command inside it.)
        const isTop = ctl === 0 && depth === 0 && op !== ')' && !inSub && !BODY.test(literal(words[0]) ?? '')
        owner.data = spans !== null && isTop && op !== '|' && DATA_PROGRAM.test(commandName(words) ?? '')
        if (owner.data) spans.push(...pending)
        afterPipe = false
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
      pending = []
      owner = { data: false }
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
        const from = i
        let to = i
        while (i < src.length) {
          let end = src.indexOf('\n', i)
          if (end < 0) end = src.length
          const line = src.slice(i, end)
          to = i
          i = Math.min(end + 1, src.length)
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          body += line + '\n'
          to = i
        }
        // An unquoted delimiter's body still runs $( ) and backticks
        if (h.owner.data && (h.quoted || !/[`]|\$\(/.test(body))) spans.push([from, to])
        nested(body)
      }
    }
    while (i < src.length) {
      const ch = src[i]
      if (ch === '\n') {
        endCmd(true, '\n')
        if (!cont) sureNext = true
        i++
        readHeredocs()
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        endWord()
        i++
      } else if (ch === '#' && !word) {
        while (i < src.length && src[i] !== '\n') i++
      } else if (ch === ')' && inSub && depth === 0) {
        endCmd(true, ')')
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
        endCmd(!isSub, src[i + 1] === ch && (ch === '&' || ch === '|') ? ch + ch : ch)
        if (isSub && ch === '|') afterPipe = true
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
          heredocs.push({ delim: m[1] ?? m[2] ?? m[3], strip, quoted: !m[3] || m[0].startsWith('\\'), owner })
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
        pending.push([i + 1, end])
        i = end + 1
        nested(text)
      } else if (ch === '$' && src[i + 1] === "'") {
        begin()
        let text = ''
        const from = i + 2
        for (i += 2; i < src.length && src[i] !== "'"; i++) text += src[i] === '\\' && i + 1 < src.length ? src[++i] : src[i]
        pending.push([from, i])
        i++
        part({ lit: text, q: true })
      } else if (ch === '"') {
        let text = ''
        part({ lit: '', q: true })
        const from = i + 1
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
        // $( ) and backticks in double quotes run: such a string is not only data
        if (!/[`]|\$\(/.test(text)) pending.push([from, i])
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
  for (const c of cmds) {
    c.sure = c.top = false
    c.inner = true
  }
  return cmds
}

// Programs that take their quoted arguments and heredoc as data, not as shell
// code: a search pattern, text to print or write, a script in another
// language. (python and node could run a shell themselves; the guard can't
// read a commit made that way anyway, e.g. subprocess.run(['git', 'commit']).)
// Not a shell, ssh, eval, xargs, su, watch ...: what they get is run.
const DATA_PROGRAM = /^(grep|egrep|fgrep|rg|ag|ack|sed|awk|gawk|jq|echo|printf|cat|python[\d.]*|py|node|deno|ruby|perl|php)$/
const WRAPPERS = /^(env|sudo|nohup|nice|time|command|builtin|exec|stdbuf)$/
// Words that open or continue a body (time and ! do not)
const BODY = /^(if|then|elif|else|do|while|until|\{)$/
// What else may run beside the data for it to stay data: programs that run no
// code of their own. Not a shell, ., source, ./x, make, npm run, xargs, find,
// eval, $x ...: any of them could run a file the command just wrote.
const INERT = /^(cd|pushd|popd|pwd|ls|mkdir|touch|true|false|test|\[|:|wc|head|tail|sort|uniq|cut|tr|diff|tee|fi|done|esac|\})$/

// The program a simple command runs: past VAR=x, if/then/do ..., and env,
// sudo, nohup ... with their options. null when that can't be told.
function commandName(words) {
  let wrapped = false
  for (const w of words) {
    const t = literal(w)
    if (t === null) return null
    if (LEADS.test(t) || isAssignment(w) || (wrapped && /^-/.test(t))) continue
    if (WRAPPERS.test(t)) {
      wrapped = true
      continue
    }
    return t.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  }
  return null
}

// The command with the text that is only data blanked out: each quoted
// string and heredoc body given to a DATA_PROGRAM at the command's own level,
// whose output is not piped on (into sh, say). Not blanked: anything in
// $( ) or backticks (its output becomes code or arguments), a double-quoted
// string or unquoted heredoc holding $( ) or a backtick (they run), and
// anything the reading here gets wrong, which is then still checked. Nothing
// is blanked when anything else in the command could run code.
export function withoutData(cmd) {
  const spans = []
  shellCommands(cmd, spans)
  let out = ''
  let at = 0
  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (from < at) continue
    out += cmd.slice(at, from) + cmd.slice(from, to).replace(/[^\n]/g, ' ')
    at = to
  }
  out += cmd.slice(at)
  // Codex, PR #38: data the same command then runs (> run.sh && . ./run.sh)
  // is code. Every command left must be a data program or an inert one.
  const runsOnly = shellCommands(out).every(c => {
    const name = commandName(c)
    return name === null ? c.every(isAssignment) : DATA_PROGRAM.test(name) || INERT.test(name)
  })
  return runsOnly ? out : cmd
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
  if (name !== 'HOME' && name !== 'CDPATH') return null
  try {
    // Each name literal: the engine lists the variables a module reads
    const value = name === 'HOME' ? await $.env.get('HOME') : await $.env.get('CDPATH')
    // An unset CDPATH is no CDPATH; an unset HOME is not known
    if (value == null) return name === 'CDPATH' ? [...new Set([...out, ''])] : null
    return [...new Set([...out, value])]
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
    const sure = all.sure && lead === 0 && (isDeclare || words.every(isAssignment)) ? at : undefined
    for (const w of isDeclare ? words.slice(1) : words) {
      const m = assignmentOf(w)
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

// The repositories a command's git calls run in: each `git -C <dir>`, on top
// of the directory a `cd` or `pushd` before it moved to, and the session's own
// directory ('') for a plain `git`. A directory that can't be worked out comes
// back as { unresolved: the text as written, kind: '-C' or 'cd' }.
async function gitDirs($, cmd) {
  const dirs = new Map()
  const cmds = shellCommands(cmd)
  const vars = assignments(cmds)
  // Where the next command runs if every cd so far in this && chain worked,
  // and where it runs if one of them failed: bash skips the rest of the
  // chain, and the command after the next ; newline or || runs there
  let cur = ['']
  let failed = []
  // bash keeps the directory as text (cd -L, its default) or as the disk
  // resolved it (cd -P, or every cd after set -P). `physical` holds the
  // directories whose text bash resolved; `plain` those it kept as text.
  // `mode` is what a cd with no -L or -P does: 'L', 'P', or 'both' when a
  // set -P may or may not have run.
  const physical = new Set()
  const plain = new Set([''])
  let mode = 'L'
  for (const [index, words] of cmds.entries()) {
    const lead = words.findIndex(w => !LEADS.test(literal(w) ?? '') && !isAssignment(w))
    const moved = lead >= 0 && CD.test(literal(words[lead]) ?? '') ? await cdTargets($, words.slice(lead), vars, index) : undefined
    // eval cd ... moves this shell to a place its text alone can't show
    if (lead >= 0 && literal(words[lead]) === 'eval' && words.slice(lead + 1).some(w => /(^|[\s;&|("'])(cd|pushd|popd)\b/.test(w.raw))) {
      cur = uniq([...cur, { unresolved: unquoted(words.slice(lead).map(w => w.raw).join(' ')), kind: 'cd' }])
    }
    // set -P, set -o physical (and +P, +o physical) change what a cd does after
    if (lead >= 0 && literal(words[lead]) === 'set') {
      const on = physicalOption(words.slice(lead + 1))
      if (on !== undefined) {
        const now = on === null ? 'both' : on ? 'P' : 'L'
        mode = words.sure && lead === 0 && now !== 'both' ? now : mode === now ? now : 'both'
      }
    }
    if (moved) {
      const there = []
      const how = moved.mode ?? mode
      for (const dir of cur) {
        for (const to of moved.to) {
          if (typeof dir !== 'string' || typeof to !== 'string') {
            there.push(join(dir, to))
            continue
          }
          for (const isResolved of [physical.has(dir), ...(plain.has(dir) && physical.has(dir) ? [false] : [])]) {
            // cd -P: the disk resolves the whole path, as git -C does
            if (how !== 'L') {
              const p = join(dir, to)
              physical.add(p)
              there.push(p)
            }
            if (how === 'P') continue
            // cd -L on a resolved directory: the target's own . and .. go by
            // its text, and a .. past it is the resolved directory's parent,
            // which git finds by resolving dir/.. too
            if (isResolved && !isAbsolute(to)) {
              const p = join(dir, lexical(to))
              physical.add(p)
              there.push(p)
            } else {
              const p = await logical($, join(dir, to))
              if (typeof p === 'string') plain.add(p)
              there.push(p)
            }
          }
        }
      }
      there.splice(0, there.length, ...capped(uniq(there), words[lead + 1]?.raw))
      // Only `cd X && ...`, run in this shell with nothing before it that
      // could skip it, surely moves what follows in the chain. Any other cd
      // may or may not have run: check both directories.
      // VAR=x before the cd sets VAR for it alone, and can't keep it from running
      if (words.top && words.slice(0, lead).every(isAssignment) && words.op === '&&' && words.prev !== '||') {
        failed = uniq([...failed, ...cur])
        cur = there
      } else cur = capped(uniq([...cur, ...there]), words[lead + 1]?.raw)
    }
    // git, git.exe or a path to it; then its global options, up to the subcommand
    const at = moved !== undefined ? -1 : words.findIndex(w => /(^|[\\/])git(\.exe)?$/i.test(literal(w) ?? ''))
    if (at >= 0) {
      let found = cur
      let unresolved = null
      for (let k = at + 1; k < words.length; k++) {
        const opt = literal(words[k])
        let value = null
        if (opt === '-C') value = words[++k]
        else if (opt === null && words[k].parts[0].lit?.startsWith('-C') && !words[k].parts[0].q) {
          value = { parts: [{ ...words[k].parts[0], lit: words[k].parts[0].lit.slice(2) }, ...words[k].parts.slice(1)], raw: words[k].raw.slice(2) }
        } else if (opt?.startsWith('-C')) value = { parts: [{ lit: opt.slice(2), q: false }], raw: opt.slice(2) }
        else if (opt === '-c' || GIT_VALUE_LONG_OPT.test(opt ?? '')) k++
        else if (!/^-/.test(opt ?? words[k].parts[0].lit ?? '')) break
        if (!value) continue
        const texts = await expand($, value, vars, index)
        if (!texts) {
          unresolved ??= unquoted(value.raw)
          continue
        }
        // git -C a -C b runs in a/b; an absolute -C starts over
        found = found.flatMap(dir => texts.map(text => join(dir, text)))
        if (found.length > MAX_DIRS) unresolved ??= unquoted(value.raw)
      }
      if (unresolved !== null) dirs.set('?' + unresolved, { unresolved, kind: '-C' })
      else for (const dir of found) dirs.set(key(dir), dir)
    }
    // The end of a list at the command's own level: a failed cd's skip stops here
    if (!words.inner && words.atLevel && words.op !== '&&') {
      cur = uniq([...cur, ...failed])
      failed = []
    }
  }
  // gitRuns saw a commit, but no git call came out here: check the session's repository
  if (dirs.size === 0) dirs.set('', '')
  // git.exe is run directly, not through Git Bash, so it can't read /e/repo
  const windows = await isWindows($)
  return uniq([...dirs.values()].map(dir => (windows && typeof dir === 'string' ? fromMsys(dir) : dir)))
}

// Words before a command that leave it the command: if, then, do ..., and
// builtin or command before cd
const LEADS = /^(if|then|elif|else|do|while|until|!|\{|time|builtin|command)$/
const CD = /^(cd|pushd|popd)$/
// A word that starts NAME=, unquoted: the match holds NAME and the NAME= prefix
const assignmentOf = w => (!w.parts[0]?.q && w.parts[0]?.lit?.match(/^([A-Za-z_]\w*)=/)) || null
const isAssignment = w => assignmentOf(w) !== null

// Where a cd, pushd or popd (words[0]) moves: { to, mode }, `to` each
// directory it may go to, relative or absolute ({ unresolved } when that can't
// be known), `mode` 'P' for -P, 'L' for -L, else undefined; null when it doesn't move
async function cdTargets($, words, vars, at) {
  const name = literal(words[0])
  let k = 1
  let stays = false
  let mode
  for (; k < words.length; k++) {
    const t = literal(words[k])
    if (t === '--') {
      k++
      break
    }
    if (!t || !/^-[LPe@n]+$/.test(t)) break
    // pushd -n and popd -n change only the stack
    if (name !== 'cd' && t.includes('n')) stays = true
    // the last of -L and -P wins
    if (/[LP]/.test(t)) mode = t.replace(/[^LP]/g, '').endsWith('P') ? 'P' : 'L'
  }
  if (stays) return null
  const to = await cdPlaces($, name, words[k], vars, at)
  return { to, mode }
}

async function cdPlaces($, name, target, vars, at) {
  const cannot = raw => [{ unresolved: raw, kind: 'cd' }]
  const written = `${name}${target ? ' ' + unquoted(target.raw) : ''}`
  // popd and a bare pushd go back to a directory from the stack, which may
  // have been set by an earlier call; cd - goes to $OLDPWD, the same
  if (name === 'popd' || !target && name === 'pushd') return cannot(written)
  if (!target) {
    // A bare cd goes home
    const home = await values($, vars, 'HOME', at, new Set())
    return home ?? cannot('cd (HOME is not known)')
  }
  const t = literal(target)
  if (t === '-' || name === 'pushd' && /^[+-]\d+$/.test(t ?? '')) return cannot(written)
  // ~user is another person's home
  if (!target.parts[0].q && /^~[^\/\\]/.test(target.parts[0].lit ?? '')) return cannot(written)
  const texts = await expand($, target, vars, at)
  if (!texts) return cannot(written)
  // A relative target is looked up in each CDPATH folder first. Check them
  // all, and the plain target: which one bash took depends on the disk.
  if (!texts.some(usesCdpath)) return texts
  const cdpath = await values($, vars, 'CDPATH', at, new Set())
  if (!cdpath) return cannot(`${written} (CDPATH is not known)`)
  const roots = [...new Set(cdpath.flatMap(v => v.split(':')).filter(Boolean))]
  const out = texts.flatMap(t => (usesCdpath(t) ? [t, ...roots.map(r => join(r, t))] : [t]))
  return out.length > MAX_DIRS ? cannot(written) : [...new Set(out)]
}

// bash skips CDPATH for /x, ., .., ./x and ../x
function usesCdpath(text) {
  return text !== '' && !isAbsolute(text) && !/^\.\.?([\\/]|$)/.test(text)
}

// Where a cd ends, as the next git sees it. bash's cd -L takes . and .. off
// the text (/a/link/.. is /a), while git -C would resolve the link first, so
// a cd's path is made plain by its text. A relative one with a .. starts
// from the session directory. (cd -P keeps the path for the disk to resolve.)
async function logical($, path) {
  if (typeof path !== 'string' || path === '') return path
  if (!isAbsolute(path) && path.split(/[\\/]/).includes('..')) {
    let cwd = ''
    try { cwd = await $.session.cwd() } catch {}
    if (!cwd) return { unresolved: path, kind: 'cd' }
    path = join(cwd, path)
  }
  return lexical(path)
}

// Whether set's words turn physical on (true), off (false), may do either
// (null: a word the command can't tell) or don't touch it (undefined)
function physicalOption(args) {
  let on
  for (const [n, w] of args.entries()) {
    const t = literal(w)
    if (t === '--') break
    if (t === null) return null
    if (/^-[A-Za-z]*P/.test(t)) on = true
    else if (/^\+[A-Za-z]*P/.test(t)) on = false
    else if (/^[-+][A-Za-z]*o$/.test(t) && literal(args[n + 1] ?? { parts: [] }) === 'physical') on = t[0] === '-'
  }
  return on
}

// A path with its . and .. taken off by its text: /a/b/../c is /a/c
export function lexical(path) {
  const root = path.match(/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]?|[\\/])/)?.[0] ?? ''
  const parts = []
  for (const part of path.slice(root.length).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !root) parts.push(part)
  }
  const top = root.replace(/\\/g, '/')
  if (!parts.length) return top || '.'
  return (top && !top.endsWith('/') ? top + '/' : top) + parts.join('/')
}

// dir, then text on top of it: an absolute text starts over, '' stays
function join(dir, text) {
  if (typeof text !== 'string' || isAbsolute(text)) return text
  if (typeof dir !== 'string') return dir
  return !dir || text === '' ? text || dir : dir.replace(/[\\/]$/, '') + '/' + text
}
const key = dir => (typeof dir === 'string' ? dir : `?${dir.kind}?${dir.unresolved}`)
const uniq = list => [...new Map(list.map(d => [key(d), d])).values()]
const capped = (list, raw) => (list.length > MAX_DIRS ? [{ unresolved: unquoted(raw), kind: 'cd' }] : list)

// The same check the box's wait uses: every Windows sets OS=Windows_NT, in
// Git Bash too, while the session directory's shape can't tell a Git Bash
// /e/repo from a Linux one
export async function isWindows($) {
  try { return (await $.env.get('OS')) === 'Windows_NT' } catch { return false }
}

// /e/repo and /cygdrive/e/repo (Git Bash, Cygwin) as E:/repo; anything else as it is
export function fromMsys(path) {
  const m = String(path).match(/^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)(.*)$/)
  return m ? m[1].toUpperCase() + ':' + (m[2] || '/') : path
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
  const long = GIT_VALUE_LONG_OPTS
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

export async function commitBlockReason($, cmd) {
  if (addsEnvFile(cmd)) {
    return 'staging a .env file is blocked.'
  }
  if (!gitRuns(cmd, 'commit')) return ''
  // The index is read before the command runs. If the same command stages
  // (git add ... && git commit, or commit -a), count what it could stage too:
  // every changed or untracked file git does not ignore.
  const stages = gitRuns(cmd, 'add|stage') || /\bcommit\b[^;&|]*\s(-a|--all|-\w*a\w*)\b/.test(cmd)
  // #37: whether a git commit is still there with the data taken out: one the
  // shell runs, not one named in a grep pattern, a heredoc or a script's text
  const runsCommit = gitRuns(withoutData(cmd), 'commit')
  // In these two cases nothing was checked: say so, so a parsing problem
  // doesn't read like a found secret, or like a clean check
  const unsure = 'This is not a detected .env: the guard could not check this commit, so it blocks it. Name the directory plainly (git -C /path/to/repo) or commit in a separate call.'
  dirs: for (const dir of await gitDirs($, cmd)) {
    if (typeof dir !== 'string') {
      return dir.kind === 'cd'
        ? `couldn't resolve the directory \`${dir.unresolved}\` moves to before git runs (cd -, popd, a variable this command does not set itself, a substitution, or too many possible values). ${unsure}`
        : `couldn't resolve the git -C directory \`${dir.unresolved}\` (a variable this command does not set itself, a substitution, or too many possible values). ${unsure}`
    }
    const git = (args, init) => $.process.run(['git', ...(dir ? ['-C', dir] : []), ...args], init)
    // From a subfolder (cd sub, git -C repo/sub) both must still see the whole
    // tree: git commit takes the whole index, and git add -A, -u, :/ and
    // commit -a stage the whole tree, while ls-files lists only the folder it
    // runs in. So: diff.relative off, which would hide the rest of the index,
    // and ls-files on :/, the top of the tree, with pathspec magic on so :/ is
    // not read as a file name. A git add . from a subfolder is checked against
    // the whole tree too: more than it stages, never less.
    // -z: names come NUL-separated and as they are. Without it git quotes a
    // name with non-ASCII, a quote, a backslash or a newline in it
    // ("caf\303\251/.env"), and the quoted name doesn't end in .env.
    const checks = [git(['-c', 'diff.relative=false', 'diff', '--cached', '--name-only', '-z'], { env: ENGLISH })]
    if (stages) checks.push(git(['ls-files', '-z', '--full-name', '--modified', '--others', '--exclude-standard', '--', ':/'], { env: { ...ENGLISH, GIT_LITERAL_PATHSPECS: '0' } }))
    for (const r of await Promise.all(checks)) {
      if (r.exitCode !== 0) {
        // #37: the command commits nothing, it only names a commit in data,
        // and this directory is in no repository: nothing here can be
        // committed. Any real git commit keeps the block, whatever ran before
        // it (git init, a clone, an unzip ...). Asked on its own: outside a
        // repository git diff --cached becomes diff --no-index and fails on
        // its options instead (exit 129).
        if (!runsCommit && isNotARepo(await git(['rev-parse', '--git-dir'], { env: ENGLISH }))) continue dirs
        const said = String(r.stderr || '').trim().split('\n')[0]
        return `couldn't read git state in ${await where($, dir)}${said ? ` (git: ${said})` : ''}. ${unsure}`
      }
      const env = r.stdout.split('\0').find(isEnvFile)
      if (env) {
        return stages
          ? `this command could stage and commit ${env}. Add it to .gitignore, or stage named files in a separate step.`
          : 'this commit would include a .env file. Unstage it with git rm --cached.'
      }
    }
  }
  return ''
}

// git's own messages, untranslated, so "not a repository" can be told apart.
// LC_ALL=C turns gettext off; LANGUAGE would win over a non-C LC_ALL. A message
// translated anyway is just another failure, and blocks.
const ENGLISH = { LC_ALL: 'C', LANGUAGE: 'C' }

// Whether git failed only because the directory is in no repository. Not a
// missing directory ("cannot change to": the same command may make it), not
// "dubious ownership" (a repository git would not read), not anything else.
export function isNotARepo(r) {
  return r.exitCode === 128 && /^fatal: not a git repository\b/m.test(String(r.stderr || ''))
}

// The directory git ran in, for a message: the session's own is named, since
// a plain git (and a relative -C or cd) runs from there
async function where($, dir) {
  let cwd = ''
  try { cwd = await $.session.cwd() } catch {}
  if (!dir) return cwd ? `${cwd} (the session directory)` : 'the session directory'
  return isAbsolute(dir) || !cwd ? dir : `${dir} (under ${cwd})`
}
