import type { Register, PromptContextBlock } from 'claude-code'
import {
  makeConfig,
  scrubSecrets,
  scrubPii,
  restore,
  mint,
  walk,
  collect,
  escapeLiteralTags,
  isLiteralTag,
  SECRET_TAG,
  type WalkState,
} from './detect.ts'

// transcript-redactor: keeps secrets (and, if asked, email addresses) out of
// the session transcript. Everything that decides what a secret is lives in
// ./detect.ts; this file only wires it to the events where text enters the
// conversation, and to the tools where a placeholder must become real again.
//
// Every hook fails closed. A hook that throws or runs past its budget is
// skipped by the engine, and for a redactor that would mean the raw text goes
// through. So each one has a `.catch` that withholds instead.

// The scan is linear, but a string past this size could still run past the
// hook's 10 s budget. It is withheld rather than passed on unscanned.
const SCAN_CAP = 16_000_000

// The mod running these hooks. `name` goes on every message the user sees.
// `liveTools` are its own tools whose answer carries live placeholders, so they
// are not turned into quoted (LITERAL) ones; the subagent tools always are.
export type Host = { name: string; liveTools?: readonly string[] }

const SUBAGENT_TOOLS = ['Agent', 'Task']

// Attachments that carry text from outside the engine's own prose: a file,
// a diff of a file, a queued prompt. These get the full scrub, emails too.
const OUTSIDE_TEXT = new Set(['file', 'edited_text_file', 'queued_command'])

type Budget = { budget: { remainingMs: number } }

function guard(text: string, next: Budget): void {
  if (text.length > SCAN_CAP) throw new Error('text too large to scan')
  const needMs = 300 + text.length / 4000
  if (next.budget.remainingMs < needMs) throw new Error('out of time')
}

// A Bash command that writes text into git history or posts it to GitHub.
// Its placeholders stay placeholders: a commit message or an issue body that
// quotes one must not carry the real key off the machine. The whole command
// is left as written, so a step that needs the key goes in its own call.
const PUBLISHES =
  /\bgit\b(?:[ \t]+-[cC][ \t]+\S+|[ \t]+--?[\w-]+(?:=\S+)?)*[ \t]+(?:commit|tag|notes|send-email)\b|\bgh[ \t]+(?:issue|pr|release|gist|discussion|api|repo[ \t]+(?:create|edit))\b/

// A restored value goes into Bash as shell source. One holding any of these
// (quotes, $, backticks, separators, globs) could run as code there, so it is
// never put into a command. Most keys are letters, digits and -_.+/=:
const SHELL_ACTIVE = /[\s$`"'\\;&|<>()*?[\]{}#~]|[\x00-\x1f\x7f]/

// @-mentioned files the engine attaches as media or a page reference, never
// as text. When one is too large for $.fs.read it holds no text to check.
const MEDIA_FILE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|pdf)$/i

function looksBinary(text: string): boolean {
  const head = text.slice(0, 8192)
  return head.includes('\u0000') || (head.match(/�/g)?.length ?? 0) > 8
}

export const register: Register = (on, options) => redact(on, options, { name: 'transcript-redactor' })

export function redact(on: Parameters<Register>[0], options: Parameters<Register>[1], host: Host): void {
  const cfg = makeConfig(options as Record<string, unknown>)
  const liveTools = new Set([...SUBAGENT_TOOLS, ...(host.liveTools ?? [])])
  const WITHHELD = `${host.name} could not scan this result in time, so it was withheld. Narrow the output (head, grep, offset) and retry.`
  const BLOCK_WITHHELD = `[${host.name} withheld this text: the scan failed]`

  const scrub = (text: string): string => {
    let out = text
    if (cfg.secrets) out = scrubSecrets(out, cfg)
    if (cfg.pii) out = scrubPii(out, cfg)
    return out
  }
  const secretsOnly = (text: string): string => (cfg.secrets ? scrubSecrets(text, cfg) : text)
  // An `allowUrlHosts` entry that is not a host name is said once, not dropped silently.
  let warnedHosts = cfg.allowUrlRejected.length === 0

  const countHidden = (tags: Set<string>): number => [...tags].filter((t) => !isLiteralTag(t)).length

  // 1. What the user types. A pasted key never reaches the model as itself,
  //    and neither does the context a hook above attached to the prompt.
  on('prompt.submit', async ($, e, next) => {
    const { value, tags } = collect(() => {
      guard(e.text, next)
      return { text: scrub(e.text), context: e.context?.map((c) => (guard(c, next), scrub(c))) }
    })
    const n = countHidden(tags)
    if (!warnedHosts) {
      warnedHosts = true
      $.ui.toast(`${host.name}: allowUrlHosts ignored ${cfg.allowUrlRejected.join(', ')} (not a host name)`)
    }
    if (n > 0 && cfg.notify) $.ui.toast(`${host.name}: hid ${n} value(s) from the prompt`)
    if (tags.size === 0) return next(e)
    return next({ ...e, text: value.text, ...(value.context ? { context: value.context } : {}) })
  }).catch(($, e, next) => (next.called ? next(e) : { drop: `${host.name} failed to scan this prompt, so it was not sent.` }))

  // 2. Every tool call. On the way in, a placeholder becomes its real value,
  //    but only for a tool that runs on this machine. On the way out, the
  //    result, the text the model reads and any attached context are scanned.
  on('tool.call', async ($, e, next) => {
    const command = (e as { command?: unknown }).command
    const publishes = e.tool === 'Bash' && typeof command === 'string' && PUBLISHES.test(command)
    const isLocal = cfg.restore && cfg.restoreTools.has(e.tool) && !publishes
    // The real values this call was handed. Whatever the tool prints of them
    // comes back hidden, even bare and short, where no detector would fire.
    const handed = new Set<string>()
    const restoreTracked = (s: string): string =>
      restore(s) === s
        ? s
        : s.replace(SECRET_TAG, (t) => {
            const v = restore(t)
            if (v !== t) handed.add(v)
            return v
          })
    const rehideHanded = (text: string): string => {
      let out = text
      for (const v of [...handed].sort((a, b) => b.length - a.length)) if (v.length >= 4 && out.includes(v)) out = out.split(v).join(mint('SECRET', v))
      return out
    }
    const input = isLocal ? (walk({ ...e }, restoreTracked) as typeof e) : e
    if (e.tool === 'Bash' && [...handed].some((v) => SHELL_ACTIVE.test(v))) {
      return {
        deny: `${host.name}: a secret in this command holds shell characters, so its real value was not put into Bash, where it could run as code. Write it to a file with the Write tool and have the command read that file instead.`,
      }
    }
    const r = await next(input)
    if (r.deny !== undefined) {
      // A refusal from beneath may quote the input it refused, real values
      // and all, and the model reads it as the tool's answer.
      const d = collect(() => (guard(r.deny, next), rehideHanded(scrub(escapeLiteralTags(r.deny)))))
      return d.tags.size === 0 ? r : { deny: d.value }
    }

    const escape = !liveTools.has(e.tool)
    const st: WalkState = { incomplete: false }
    const memo = new Map<string, string>()
    const clean = (s: string): string => {
      const done = memo.get(s)
      if (done !== undefined) return done
      guard(s, next)
      const out = rehideHanded(scrub(escape ? escapeLiteralTags(s) : s))
      memo.set(s, out)
      return out
    }
    const { value, tags } = collect(() => ({
      result: walk(r.result, clean, st),
      text: r.text === undefined ? undefined : clean(r.text),
      context: r.context?.map(clean),
    }))
    if (tags.size === 0) return r
    // Something was hidden, and part of the result could not be rewritten:
    // that part may hold the same secret, so the whole result is withheld.
    if (st.incomplete) return { deny: `${host.name}: a secret sits in a part of this result it cannot rewrite (too deep, or not plain data). Narrow the call and retry.` }

    const n = countHidden(tags)
    if (cfg.notify && n > 0) $.ui.notice(e.tool_use_id, `${host.name}: hid ${n} value(s)`)
    const context = value.context ? { context: value.context } : {}
    if (r.isError) return { isError: true as const, result: value.result, text: value.text, ...context }
    return { result: value.result, ...context } as typeof r
  }).catch(async ($, e, next) => {
    if (!next.called) return { deny: WITHHELD }
    const r = await next(e)
    if (r.deny !== undefined) return { deny: WITHHELD }
    if (r.isError) return { isError: true as const, result: WITHHELD, text: WITHHELD }
    return { deny: WITHHELD }
  })

  // 3. The blocks attached to the first message (CLAUDE.md and friends).
  //    Secrets only: the email in there is the user's own, and the engine
  //    puts it there so the model knows who it is talking to.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!cfg.secrets) return r
    const blocks: PromptContextBlock[] = r.blocks.map((b) => {
      guard(b.text, next)
      return { ...b, text: secretsOnly(b.text) }
    })
    // The raw files behind a rewritten CLAUDE.md would carry the key on to
    // the hooks above, so they are left out once any block changed.
    if (blocks.every((b, i) => b.text === r.blocks[i].text)) return r
    return { blocks }
  }).catch(async ($, e, next) => {
    // Keep the blocks, so the model sees that something was held back.
    const r = await next(e)
    return { blocks: r.blocks.map((b) => ({ ...b, text: BLOCK_WITHHELD })) }
  })

  // 4. What the engine injects on its own after the first message: a file
  //    named with @, a diff of a file that changed on disk, a nested
  //    CLAUDE.md, a settings hook's context. None of it passes tool.call.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (r.text == null) return r
    const text = r.text
    guard(text, next)
    const isOutside = e.origin.kind !== 'engine' || OUTSIDE_TEXT.has(e.type)
    const isFile = e.type === 'file' || e.type === 'edited_text_file'
    const out = isOutside ? scrub(isFile ? escapeLiteralTags(text) : text) : secretsOnly(text)
    return out === text ? r : { text: out }
  }).catch(() => ({ text: BLOCK_WITHHELD }))

  // 5. A file named with @ is read with no tool call, and its raw text is
  //    stored in the transcript whatever the model is shown. So a file that
  //    holds a secret is refused here, before it is read, and the model is
  //    told to use the Read tool, whose result is scrubbed.
  on('prompt.mention', async ($, e, next) => {
    if (!cfg.secrets) return next(e)
    let text: string
    try {
      const read = await $.fs.read(e.path)
      if (typeof read !== 'string') return next(e)
      text = read
    } catch {
      // Missing: the engine attaches nothing. An image or a PDF too large to
      // read is attached as media, not text. A text file that is present
      // but unreadable (too large, say) cannot be checked, so it is refused.
      if (!(await $.fs.exists(e.path))) return next(e)
      if (MEDIA_FILE.test(e.path)) return next(e)
      return { deny: `${host.name}: could not check this file for secrets; ask Claude to Read it instead` }
    }
    if (looksBinary(text)) return next(e)
    guard(text, next)
    const { tags } = collect(() => scrubSecrets(text, cfg))
    if (tags.size > 0) return { deny: `${host.name}: this file holds a secret; ask Claude to Read it instead, so the value is replaced by a placeholder` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${host.name}: could not check this file for secrets` }))

  // 6. A subagent's task. The model only ever holds placeholders, and the
  //    Agent tool gets no restore, so this is a second layer: a value that
  //    slipped into the prompt some other way still reaches the subagent as
  //    a placeholder. A workflow agent's prompt cannot be rewritten, only
  //    refused, so one that holds a secret is not started.
  on('agent.spawn', async ($, e, next) => {
    if (!cfg.secrets) return next(e)
    if (e.workflow) {
      guard(e.prompt, next)
      const { tags } = collect(() => secretsOnly(e.prompt))
      if (tags.size === 0) return next(e)
      return { deny: `${host.name}: this workflow agent's prompt holds a secret, and a workflow prompt cannot be rewritten. Pass the value by a file or an env var instead.` }
    }
    guard(e.prompt, next)
    const prompt = secretsOnly(e.prompt)
    const description = secretsOnly(e.description)
    return prompt === e.prompt && description === e.description ? next(e) : next({ ...e, prompt, description })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${host.name} failed to scan this task, so the subagent was not started.` }))
}
