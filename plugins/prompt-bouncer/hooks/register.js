// prompt-bouncer: guard what you can't undo, guarding against the user.
// A vague prompt costs a whole turn of Claude guessing. This mod checks each
// prompt at prompt.submit and drops the vague ones before Claude sees them.
//
//   quick   : instant rules, no model ("fix the thing", "it's broken")
//   project : a Haiku gate that reads the project's own docs and asks
//             "is this specific, and does it use this project's words?"
//
// Escape hatch: run /force <prompt> (or start a claude -p prompt with !). Slash commands always pass.

// Words that point at something without naming it
const VAGUE_NOUNS = /\b(the|that|this|some|those|these)\s+(thing|things|stuff|bug|bugs|issue|issues|problem|error|page|screen|button|function|file|part|bit|one)\b|\b(fix|do|change|update|clean)\s+(stuff|things|everything)\b|\bstuff\b|\bwhatever\b/i
// Pronouns with nothing before them to point back at (first prompt only)
const BARE_PRONOUN = /\b(it|that|this|them|those)\b/i
// Something concrete: a file, a path, code, a name in quotes, CamelCase, snake_case,
// or a Capitalized Name past the first word ("the Billing Panel")
const ANCHOR = /[\w-]+\.[a-z]{1,5}\b|\/[\w.-]+|`[^`]+`|"[^"]+"|\b[A-Z][a-z]+[A-Z]\w*|\b\w+_\w+\b|\s[A-Z][a-z]{2,}/

// Session overrides, set by /bouncer (they reset when the mod reloads)
let modeOverride = null
let bounces = 0
let forceNext = null
// Set at each session.start. In -p / SDK sessions there is no status line or toast to draw
let headless = false

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    headless = e.isInteractive === false
    if (!headless) $.ui.status((await currentMode($, options)) + ' mode')
    try {
      await $.command.register({ name: 'bouncer', description: 'Show prompt-bouncer, or switch it: /bouncer quick|project|off', argumentHint: '[quick|project|off]' })
      await $.command.register({ name: 'force', description: 'Send a prompt past prompt-bouncer', argumentHint: '<prompt>' })
    } catch (err) {
      $.ui.log('could not register commands: ' + err.message)
    }
    return next(e)
  })

  // The guard. It returns { drop } to stop a prompt, or next(e) to let it in.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()

    // Only judge what a person typed, never a notification or a peer's message
    const kind = e.origin && e.origin.kind
    if (kind !== 'composer' && kind !== 'sdk' && kind !== 'bridge' && kind !== undefined) return next(e)

    // Escape hatches: /force sent this one, or it starts with !
    if (forceNext !== null && text === forceNext) { forceNext = null; return next(e) }
    if (text.startsWith('!')) return next({ ...e, text: text.slice(1).trim() })
    if (text.startsWith('/')) return next(e)

    const m = await currentMode($, options)
    if (m === 'off' || text === '') return next(e)

    // Was there a conversation before this prompt? Then "it" can point back at something
    const isFirst = (await $.session.messages()).length === 0

    const verdict = m === 'project'
      ? await projectGate($, text, isFirst, await loadDocs($, options))
      : quickRules(text, isFirst)
    if (verdict.pass) return next(e)

    // Bounce: tell the user why (Claude Code puts the prompt back in the box to fix)
    bounces += 1
    // The toast shows the fix when there is one, else the reason
    if (!headless) $.ui.toast('Bounced. ' + (verdict.suggestion || verdict.reason), { timeoutMs: 8000 })
    // One line: a drop reason with newlines in it is mangled
    return { drop: 'prompt-bouncer: ' + verdict.reason + (verdict.suggestion ? ' Try: ' + verdict.suggestion : '') + ' (Send it anyway: /force <prompt>)' }
  }).catch(($, e, next) => next(e))
  // A bouncer that breaks lets prompts through: it should never lock you out

  // /bouncer shows the mode and the docs it reads; /bouncer quick|project|off switches
  on('command.run', { command: 'bouncer' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'quick' || arg === 'project' || arg === 'off') {
      modeOverride = arg
      if (!headless) $.ui.status(arg + ' mode')
    }
    const docs = await loadDocs($, options)
    return { text: 'mode ' + (await currentMode($, options)) + ', ' + bounces + ' bounced this session. Project docs: ' + (docs.files.join(', ') || 'none found') + ' (' + docs.text.length + ' chars)' }
  })

  // /force <prompt> sends the prompt as your own words, past the bouncer
  on('command.run', { command: 'force' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /force <prompt>' }
    forceNext = text
    // A command can't submit a prompt itself (it would wait on its own turn),
    // so a timer submits it a moment later, once the command has finished
    $.clock.after(50, () => $.prompt.submit({ text, asUser: true }).catch((err) => $.ui.log('force failed: ' + err.message)))
    return {}
  })
}

// The mode: /bouncer override, then PROMPT_BOUNCER_MODE, then /config
async function currentMode($, options) {
  return modeOverride || (await $.env.get('PROMPT_BOUNCER_MODE')) || options.mode || 'quick'
}

// Quick mode: no model, just patterns. Short + vague + nothing named = bounce.
function quickRules(text, isFirst) {
  const words = text.split(/\s+/).length
  if (words > 15 || ANCHOR.test(text)) return { pass: true }
  const noun = text.match(VAGUE_NOUNS)
  if (noun) {
    return { pass: false, reason: '"' + noun[0] + '" doesn\'t say which one. Name the file, feature or component.' }
  }
  const pronoun = text.match(BARE_PRONOUN)
  if (isFirst && pronoun) {
    return { pass: false, reason: '"' + pronoun[0] + '" has nothing to point back to yet. Say what you mean.' }
  }
  return { pass: true }
}

// Project mode: Haiku reads the project's docs and judges the prompt
async function projectGate($, text, isFirst, docs) {
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 300,
    timeoutMs: 20000,
    system: 'You are a gatekeeper for a coding agent. Reply with JSON only, no prose.',
    prompt: [
      // The docs are the same every prompt, so they form the cached prefix
      { text: 'PROJECT DOCS (the project\'s own language):\n\n' + docs.text, cache: true },
      {
        text: 'A developer is about to send this prompt to a coding agent' +
          (isFirst ? ' as the FIRST message of a new session (so "it" or "that" points at nothing)' : ' mid-conversation (short follow-ups like "yes" or "do it" are fine)') +
          ':\n\n<prompt>\n' + text + '\n</prompt>\n\n' +
          'Bounce it if EITHER is true: (1) it uses a loose word where the docs define a precise term ' +
          '(any word in the glossary\'s "Not" column, or a close paraphrase of one, always bounces), or ' +
          '(2) the agent would have to guess what it refers to, because it names no file, feature or component. ' +
          'A prompt that already names a project term or a file passes, even if other words in it are casual. ' +
          'Ordinary verbs and words like "switch", "change" or "update" are not loose terms.\n\n' +
          'Reply {"pass": true} or {"pass": false, "reason": "<one short sentence>", "suggestion": "<under 25 words: the prompt rewritten with the project\'s term; if it could mean two things, ask which one, e.g. this project calls that the billing panel, which one did you mean?>"}',
      },
    ],
  })
  // If Haiku is down or answers nonsense, let the prompt through
  if (!r.isAnswered) return { pass: true }
  try {
    const json = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1))
    return json.pass === false ? { pass: false, reason: json.reason || 'too vague for this project', suggestion: json.suggestion } : { pass: true }
  } catch {
    return { pass: true }
  }
}

// Read the project's docs with $.fs: plain paths, or folder/*.md for every match in one folder
async function loadDocs($, options) {
  const root = await $.session.cwd()
  const max = options.maxDocChars || 20000
  const files = []
  let text = ''
  for (const pattern of String(options.docs || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    let paths = [pattern]
    if (pattern.includes('*')) {
      const dir = pattern.slice(0, pattern.lastIndexOf('/') + 1)
      const re = new RegExp('^' + pattern.slice(dir.length).replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$')
      if (!(await $.fs.exists(root + '/' + dir))) continue
      paths = (await $.fs.list(root + '/' + dir)).filter((f) => f.kind === 'file' && re.test(f.name)).map((f) => dir + f.name).sort()
    }
    for (const path of paths) {
      if (text.length >= max || !(await $.fs.exists(root + '/' + path))) continue
      text += '\n--- ' + path + ' ---\n' + (await $.fs.read(root + '/' + path)).slice(0, max - text.length)
      files.push(path)
    }
  }
  return { files, text }
}
