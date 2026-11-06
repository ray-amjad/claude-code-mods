// The pure half of transcript-redactor: the config, the vault, the detectors,
// and the walkers. Nothing in here touches `$` or registers a hook, so another
// mod can vendor this file as it is and the tests can run it under plain node.
//
// The value is not deleted. It is put in a vault that lives in this module,
// in memory, for the session, and the transcript gets a placeholder in its
// place: `[REDACTED-SECRET-1a2b3c4d]`. Within one session the same value always
// mints the same placeholder, so the model can still tell one customer from
// another, and the placeholder is swapped back for the real value on the way
// into a tool that runs on this machine, so a `Bash` command or a `Write` still
// carries the real key.
//
// Nothing is written to disk. The vault dies with the session.

export type Kind = 'SECRET' | 'EMAIL' | 'IP' | 'LITERAL'

export type Config = {
  secrets: boolean
  pii: boolean
  emails: boolean
  privateIps: boolean
  restore: boolean
  restoreTools: ReadonlySet<string>
  notify: boolean
  minEntropy: number
  minLength: number
  contextMinEntropy: number
  allow: ReadonlySet<string>
  allowEmails: readonly string[]
  allowPrefix: readonly string[]
  denyPrefix: readonly string[]
  allowUrl: AllowUrl
  // Entries of `allowUrlHosts` that are not a host name, shown once.
  allowUrlRejected: readonly string[]
}

// The tools that run on this machine. A placeholder is only swapped back for
// its real value in these: a tool that hands its input to another model or to
// the network (Agent, WebFetch, WebSearch, SendMessage, an MCP tool) gets the
// placeholder as written.
export const DEFAULT_RESTORE_TOOLS = 'Bash,Write,Edit,MultiEdit,NotebookEdit'

// ---------------------------------------------------------------- the vault

const byValue = new Map<string, string>()
const byTag = new Map<string, string>()
let hidden = 0
let minted: Set<string> | null = null

const TAG = /\[REDACTED-(?:SECRET|EMAIL|IP|LITERAL)-[0-9a-f]{8}\]/g
const WHOLE_TAG = /^\[REDACTED-(?:SECRET|EMAIL|IP|LITERAL)-[0-9a-f]{8}\]$/

function randomHex8(): string {
  const bytes = new Uint8Array(4)
  const crypto = (globalThis as { crypto?: { getRandomValues?: (values: Uint8Array) => Uint8Array } }).crypto
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Swaps a value for its placeholder and remembers both. A value that already
// holds a placeholder from an earlier pass (a key inside a URL password) is
// stored with that placeholder put back, so one restore gives the real text.
export function mint(kind: Kind, raw: string): string {
  hidden++
  const value = kind === 'LITERAL' ? raw : restore(unpark(raw))
  const seen = byValue.get(value)
  if (seen) {
    if (kind === 'SECRET') remember(value)
    minted?.add(seen)
    return seen
  }
  let tag: string
  do tag = `[REDACTED-${kind}-${randomHex8()}]`
  while (byTag.has(tag))
  byValue.set(value, tag)
  byTag.set(tag, value)
  if (kind === 'SECRET') remember(value)
  minted?.add(tag)
  return tag
}

// A secret is hidden again wherever it turns up later: across the session
// when it is distinctive enough (echoable), and within the text being
// scanned right now when it is shorter but still not a plain word.
function remember(value: string): void {
  const echoes = echoable(value)
  if (echoes && !echo.has(value)) {
    echo.add(value)
    echoIndex = null
  }
  if (local && (echoes || localWorthy(value))) local.add(value)
}

// One pass, on purpose: a LITERAL placeholder gives back the placeholder text
// it stands for, and that text must not then turn into the secret.
export function restore(text: string): string {
  if (byTag.size === 0 || !text.includes('[REDACTED-')) return text
  return text.replace(TAG, (tag) => byTag.get(tag) ?? tag)
}

// Hides a value the caller knows is secret wherever it turns up for the rest
// of the session, even one too short or too plain for the echo rule (a word
// password from .env). Values under PREFIX characters can't be indexed.
export function keepSecret(value: string): string {
  const tag = mint('SECRET', value)
  if (value.length >= PREFIX && !echo.has(value)) {
    echo.add(value)
    echoIndex = null
  }
  return tag
}

// How many times a value has been hidden this session. A hook reads it before
// and after a scrub to learn whether anything changed.
export function hiddenCount(): number {
  return hidden
}

// Runs `fn` and hands back every placeholder it minted or reused, so a hook
// can count the values it hid without counting one value twice.
export function collect<T>(fn: () => T): { value: T; tags: Set<string> } {
  const outer = minted
  const tags = new Set<string>()
  minted = tags
  try {
    return { value: fn(), tags }
  } finally {
    minted = outer
    if (outer) for (const t of tags) outer.add(t)
  }
}

// A placeholder read back from a file or a log is quoted text, not a handle.
// Left alone it would turn into the real secret the next time the model
// copied that text into a command. So a live placeholder found in a tool's
// output is swapped for a LITERAL one, which restores to the placeholder text
// and nothing more. Run this before the detectors, so a key the tool printed
// still comes back as its live placeholder.
export function escapeLiteralTags(text: string): string {
  if (byTag.size === 0 || !text.includes('[REDACTED-')) return text
  return text.replace(TAG, (t) => (byTag.has(t) && !t.startsWith('[REDACTED-LITERAL-') ? mint('LITERAL', t) : t))
}

// ------------------------------------------------------- known value echoes

// A value hidden once because of where it sat (after `API_KEY=`, inside a
// URL) is hidden again wherever it turns up, even bare, where no detector
// would fire on it: a tool that echoes a restored key must not print it.
const echo = new Set<string>()
let echoIndex: EchoIndex | null = null
// The values minted during the current scan, to hide at their other spots.
let local: Set<string> | null = null

// Short or all-letter values (`postgres`) are left out: hiding every later
// `postgres` in unrelated output would make the session unreadable.
function echoable(value: string): boolean {
  if (countsUp(value)) return false
  // A slug or a dated name hidden once beside a key name is not worth hiding
  // everywhere: it would turn every path that holds it into a placeholder.
  if (value.split(/[^A-Za-z0-9]+/).every((p) => p === '' || isSlugPart(p))) return false
  if (value.includes('\n')) return value.length >= 40
  return value.length >= 20 || (value.length >= 10 && /[0-9]/.test(value) && /[A-Za-z]/.test(value))
}

// A value too short to hide across the session is still hidden at its other
// spots in the same text, unless it is a plain word or slug (`postgres`
// hidden once in a URL must not turn every `postgres://` into a placeholder).
function localWorthy(value: string): boolean {
  if (value.length < PREFIX || value.length > 400 || value.includes('\n') || countsUp(value)) return false
  if (value.split(/[^A-Za-z0-9]+/).every((p) => p === '' || isSlugPart(p))) return false
  return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value) || value.length >= 12
}

// The known values are found with a rolling hash over their first PREFIX
// characters, so the cost of the scan does not grow with the vault. A regex
// of every value joined by `|` took 40 s on 200 KB once a long session had
// hidden a few thousand values.
const PREFIX = 8
// Under each prefix the values are kept by length, longest first, so a
// prefix that thousands of values share costs one set lookup per length,
// not a walk of the whole list.
type ByLength = { lengths: number[]; values: Set<string> }
type EchoIndex = { hashes: Set<number>; byPrefix: Map<string, ByLength>; top: number }

function prefixHash(text: string, at: number): number {
  let h = 0
  for (let i = 0; i < PREFIX; i++) h = (Math.imul(h, 31) + text.charCodeAt(at + i)) >>> 0
  return h
}

function buildEchoIndex(values: Iterable<string>): EchoIndex {
  const byPrefix = new Map<string, ByLength>()
  for (const v of values) {
    const p = v.slice(0, PREFIX)
    let entry = byPrefix.get(p)
    if (!entry) byPrefix.set(p, (entry = { lengths: [], values: new Set() }))
    if (!entry.lengths.includes(v.length)) entry.lengths.push(v.length)
    entry.values.add(v)
  }
  for (const entry of byPrefix.values()) entry.lengths.sort((a, b) => b - a)
  const hashes = new Set<number>()
  for (const p of byPrefix.keys()) hashes.add(prefixHash(p, 0))
  // 31 to the power PREFIX - 1, to take the oldest character out of the hash.
  let top = 1
  for (let i = 0; i < PREFIX - 1; i++) top = Math.imul(top, 31) >>> 0
  return { hashes, byPrefix, top }
}

function rehideKnown(text: string): string {
  if (echo.size === 0 || text.length < PREFIX) return text
  return rehideWith(text, (echoIndex ??= buildEchoIndex(echo)))
}

// The values minted in one scan, hidden at their other spots in it. A few
// values are found faster one by one than by the rolling hash.
function rehideLocal(text: string, values: Set<string>): string {
  if (values.size > 64) return rehideWith(text, buildEchoIndex(values))
  let out = text
  for (const v of [...values].sort((a, b) => b.length - a.length)) if (out.includes(v)) out = out.split(v).join(mint('SECRET', v))
  return out
}

function rehideWith(text: string, ix: EchoIndex): string {
  if (text.length < PREFIX) return text
  const parts: string[] = []
  let last = 0
  let h = prefixHash(text, 0)
  for (let i = 0; i + PREFIX <= text.length; ) {
    if (ix.hashes.has(h)) {
      const entry = ix.byPrefix.get(text.slice(i, i + PREFIX))
      let found: string | undefined
      if (entry) {
        for (const n of entry.lengths) {
          const v = text.slice(i, i + n)
          if (v.length === n && entry.values.has(v)) {
            found = v
            break
          }
        }
      }
      if (found) {
        parts.push(text.slice(last, i), mint('SECRET', found))
        i += found.length
        last = i
        if (i + PREFIX <= text.length) h = prefixHash(text, i)
        continue
      }
    }
    if (i + PREFIX >= text.length) break
    h = (Math.imul((h - Math.imul(text.charCodeAt(i), ix.top)) >>> 0, 31) + text.charCodeAt(i + PREFIX)) >>> 0
    i++
  }
  if (last === 0) return text
  parts.push(text.slice(last))
  return parts.join('')
}

// ------------------------------------------------------------------ parking

// Some spans are known not to be secrets and are big enough to drown the
// transcript in placeholders: an image in a data: URI, a lockfile hash, a
// thinking-block signature, a base64 attachment. They are parked behind a
// marker for the scan and put back after it. The marker is a character the
// text does not contain; if every candidate is taken, nothing is parked and
// the scan simply hides more.
type Parked = { mark: string; spans: string[]; re: RegExp }
let parked: Parked | null = null
const MARKS = ['\u0000', '\uE000', '\uE001', '\uFDD0']

function startParking(text: string): Parked | null {
  const mark = MARKS.find((m) => !text.includes(m))
  return mark ? { mark, spans: [], re: new RegExp(`${mark}(\\d+)${mark}`, 'g') } : null
}

function park(span: string): string {
  if (!parked) return span
  parked.spans.push(span)
  return `${parked.mark}${parked.spans.length - 1}${parked.mark}`
}

function unpark(text: string): string {
  const p = parked
  if (!p || !text.includes(p.mark)) return text
  let out = text
  for (let i = 0; i < 3 && out.includes(p.mark); i++) out = out.replace(p.re, (_m, n: string) => p.spans[Number(n)] ?? '')
  return out
}

// ------------------------------------------------------------- small tools

// Bits per character. Counted in a reused array for plain ASCII, since the
// scan calls this for every candidate token.
const COUNTS = new Int32Array(128)

function entropy(text: string): number {
  let ascii = true
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 128) {
      ascii = false
      break
    }
  }
  if (!ascii) {
    const counts = new Map<string, number>()
    for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    let h = 0
    for (const n of counts.values()) h -= (n / text.length) * Math.log2(n / text.length)
    return h
  }
  COUNTS.fill(0)
  for (let i = 0; i < text.length; i++) COUNTS[text.charCodeAt(i)]!++
  let h = 0
  for (let c = 0; c < 128; c++) {
    const n = COUNTS[c]!
    if (n > 0) h -= (n / text.length) * Math.log2(n / text.length)
  }
  return h
}

const B64_TABLE = (() => {
  const t = new Int16Array(128).fill(-1)
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < abc.length; i++) t[abc.charCodeAt(i)] = i
  t['-'.charCodeAt(0)] = 62
  t['_'.charCodeAt(0)] = 63
  return t
})()

// Decodes the start of a base64 text into one character per byte. The hooks
// run with no Buffer and no atob, so this is done by hand.
function decodeBase64Head(text: string, max = 8192): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (let i = 0; i < text.length && out.length < max; i++) {
    const c = text.charCodeAt(i)
    if (c === 61) break
    const v = c < 128 ? B64_TABLE[c]! : -1
    if (v < 0) continue
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 0xff)
    }
  }
  return out
}

// Ranges of the text that the token scan skips. A `soft` range is skipped
// only when no key name stands in front of the token.
type Span = [start: number, end: number, soft: boolean]

class Spans {
  private list: Span[] = []
  private i = 0
  add(start: number, end: number, soft = false): void {
    if (end > start) this.list.push([start, end, soft])
  }
  seal(): this {
    this.list.sort((a, b) => a[0] - b[0])
    return this
  }
  // Offsets are asked in ascending order, so a cursor keeps this linear.
  at(offset: number): 'hard' | 'soft' | null {
    const l = this.list
    while (this.i < l.length && l[this.i]![1] <= offset) this.i++
    let found: 'hard' | 'soft' | null = null
    for (let j = this.i; j < l.length && l[j]![0] <= offset; j++) {
      if (l[j]![1] > offset) {
        if (!l[j]![2]) return 'hard'
        found = 'soft'
      }
    }
    return found
  }
}

// ------------------------------------------------------------ secret tests

// Escapes that end in a letter or digit and may sit right before a key:
// quoted-printable `=3D`, URL `%3D`, and the `\n` or `"` of escaped JSON.
const ESC = String.raw`[%=]3D|\\[nrtfbv]|\\u[0-9A-Fa-f]{4}`
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

// A vendor prefix only counts at the start of a word, or right after one of
// those escapes. Without this, `task-runner-for-the-build` reads as `sk-`.
// The prefix is written first and the boundary checked behind it, so the
// regex engine can jump between occurrences of the prefix instead of
// testing the boundary at every character of the text.
function word(prefix: string, body: string, edge = 'A-Za-z0-9'): string {
  return String.raw`${prefix}(?<=(?:^|[^${edge}]|${ESC})${prefix})${body}`
}

// Shapes that belong to one vendor and mean one thing. These are hidden on
// sight, whatever their entropy. Each has a hint, a cheap test that the text
// could hold one, so a 10 MB log pays only for the shapes it might contain.
// Every quantifier is bounded: an open `{n,}` over a run of millions of
// characters overflows the regex stack.
type Shape = { hint: string | RegExp; re: string }
const VENDOR_SHAPES: readonly Shape[] = [
  { hint: 'sk-ant-', re: word('sk-ant-', '[A-Za-z0-9_-]{16,4096}') },
  // A real OpenAI key has a digit or a capital early on; a kebab word does not.
  { hint: 'sk-', re: word('sk-', '(?=[a-z_-]{0,200}[0-9A-Z])[A-Za-z0-9_-]{20,4096}') },
  { hint: /gh[pousr]_/, re: word('gh[pousr]_', '[A-Za-z0-9]{20,4096}') },
  { hint: 'github_pat_', re: word('github_pat_', '[A-Za-z0-9_]{20,4096}') },
  { hint: 'xox', re: word('xox[baprse]-', '[A-Za-z0-9-]{10,4096}') },
  { hint: 'xapp-', re: word('xapp-', '[0-9]-[A-Za-z0-9-]{10,4096}') },
  { hint: /A[KS]IA/, re: word('A(?:KIA|SIA)', '[0-9A-Z]{16}(?![A-Za-z0-9])') },
  { hint: /[sr]k_(?:live|test)_/, re: word('[sr]k_(?:live|test)_', '[A-Za-z0-9]{16,4096}') },
  { hint: 'whsec_', re: word('whsec_', '[A-Za-z0-9]{16,4096}') },
  { hint: 'AIza', re: word('AIza', '[0-9A-Za-z_-]{30,4096}') },
  { hint: 'ya29.', re: word(String.raw`ya29\.`, '[A-Za-z0-9_-]{20,4096}') },
  { hint: 'npm_', re: word('npm_', '[A-Za-z0-9]{30,4096}') },
  { hint: 'dop_v1_', re: word('dop_v1_', '[a-f0-9]{40,4096}') },
  { hint: 'glpat-', re: word('glpat-', '[A-Za-z0-9_-]{16,4096}') },
  { hint: 'shpat_', re: word('shpat_', '[a-f0-9]{32,4096}') },
  { hint: 'SG.', re: word(String.raw`SG\.`, String.raw`[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{16,4096}`) },
  { hint: 'hooks.slack.com', re: String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/+_-]{16,4096}` },
  { hint: '/api/webhooks/', re: String.raw`https://discord(?:app)?\.com/api/webhooks/[0-9]{1,30}/[A-Za-z0-9_-]{16,4096}` },
  // Prefixes built from words, which the name test would otherwise excuse.
  { hint: 'vercel_blob_rw_', re: word('vercel_blob_rw_', '[A-Za-z0-9]{16}_[A-Za-z0-9]{30}') },
  { hint: 'tskey-', re: word('tskey-', '[a-z]{1,20}-[A-Za-z0-9_-]{20,4096}') },
  { hint: 'pscale_', re: word('pscale_', '(?:tkn|pw|oauth)_[A-Za-z0-9_-]{32,4096}') },
  { hint: 'pdl_', re: word('pdl_', '(?:live|sdbx)_apikey_[A-Za-z0-9_-]{20,4096}') },
  { hint: 'pypi-AgE', re: word('pypi-AgE', '[A-Za-z0-9_-]{50,4096}') },
  { hint: 'sntrys_eyJ', re: word('sntrys_eyJ', '[A-Za-z0-9+/=_-]{50,4096}') },
  { hint: 'pcsk_', re: word('pcsk_', '[A-Za-z0-9_-]{40,4096}') },
  { hint: 'HRKU-AA', re: word('HRKU-AA', '[A-Za-z0-9_-]{40,4096}') },
  { hint: 'dckr_', re: word('dckr_', '(?:pat|oat)_[A-Za-z0-9_-]{20,4096}') },
  { hint: 'figd_', re: word('figd_', '[A-Za-z0-9_-]{30,4096}') },
  { hint: 'GOCSPX-', re: word('GOCSPX-', '[A-Za-z0-9_-]{20,4096}') },
  { hint: /gl(?:rt|dt|ptt|cbt|imt|ft|soat|oas|agent)-/, re: word('gl(?:rt|dt|ptt|cbt|imt|ft|soat|oas|agent)-', '[A-Za-z0-9_-]{20,4096}') },
  { hint: 'bb_live_', re: word('bb_live_', '[A-Za-z0-9_-]{20,4096}') },
  { hint: 'sb_secret_', re: word('sb_secret_', '[A-Za-z0-9_-]{20,4096}') },
  { hint: 'ATATT3', re: word('ATATT3', '[A-Za-z0-9_=-]{100,4096}') },
  // Keys whose secret half sits after a `.`, `:` or `/`.
  { hint: 'pat', re: word('pat', String.raw`[A-Za-z0-9]{14}\.[a-f0-9]{64}`) },
  { hint: /[st]k\.eyJ/, re: word(String.raw`[st]k\.eyJ`, String.raw`[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{20,4096}`) },
  { hint: 'st.', re: word(String.raw`st\.`, String.raw`(?:[0-9a-f]{24}|${UUID})\.[0-9a-f]{32}\.[0-9a-f]{32}`) },
  { hint: /\/[0-9]{8}[0-9/]*:[0-9a-f]{32}/, re: String.raw`(?<![0-9])[0-9]/[0-9]{8,30}(?:/[0-9]{8,30})?:[0-9a-f]{32}` },
  { hint: /-[0-9a-f]{12}:[0-9a-f]{32}/, re: String.raw`(?<![0-9A-Fa-f])${UUID}:[0-9a-f]{32}` },
  // Hugging Face tokens are letters only, so no entropy rule can see them.
  { hint: /(?:hf|api_org)_/, re: word('(?:hf|api_org)_', '[A-Za-z0-9]{34}(?![A-Za-z0-9_])') },
  { hint: 'ops_eyJ', re: word('ops_eyJ', '[A-Za-z0-9+/=_-]{50,4096}') },
  { hint: /fm[12][ar]?_/, re: word('fm[12][ar]?_', '[A-Za-z0-9+/=,_-]{50,4096}') },
  { hint: 'sig=', re: String.raw`(?<=[?&]sig=)[A-Za-z0-9%+/]{30,4096}` },
  { hint: 'AAAAAAAAAAAAAAAAAAAAA', re: word('AAAAAAAAAAAAAAAAAAAAA', '[A-Za-z0-9]{0,200}%[A-Za-z0-9%]{30,4096}') },
  { hint: 'Q~', re: String.raw`[A-Za-z0-9_~.-]{3}[0-9][A-Za-z0-9_~.-]Q~[A-Za-z0-9_~.-]{31,34}` },
  // Lowercase and hex shapes that one vendor owns.
  { hint: 'e2b_', re: word('e2b_', String.raw`[a-f0-9]{40}(?![\w-])`) },
  { hint: 'lsv2_', re: word('lsv2_', String.raw`(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}(?![\w-])`) },
  { hint: /[0-9a-f]-us[0-9]/, re: String.raw`(?:(?<=${ESC})|(?<![A-Za-z0-9]))[a-f0-9]{32}-us[0-9]{1,2}(?![\w-])` },
  { hint: /-[a-f0-9]{8}-[a-f0-9]{8}(?![\w-])/, re: String.raw`(?:(?<=${ESC})|(?<![A-Za-z0-9]))[a-f0-9]{32}-[a-f0-9]{8}-[a-f0-9]{8}(?![\w-])` },
  { hint: /xa[ap]t-/, re: word('xa[ap]t-', String.raw`${UUID}(?![\w-])`) },
  { hint: 'SK', re: word('SK', String.raw`[0-9a-f]{32}(?![\w-])`) },
  { hint: 'tvly-', re: word('tvly-', '(?:dev-|prod-)?[A-Za-z0-9]{32,4096}') },
  { hint: 'tr_', re: word('tr_', '(?:dev|prod|stg|pat)_[A-Za-z0-9]{20,4096}', 'A-Za-z0-9_') },
  { hint: ':AA', re: String.raw`(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])` },
  { hint: /a[ks]-/, re: word('a[ks]-', '[A-Za-z0-9]{22}(?![A-Za-z0-9_-])', 'A-Za-z0-9_-') },
  // Keys that reuse a Stripe id prefix: Resend `re_`, Stripe client secrets.
  { hint: 're_', re: word('re_', '[A-Za-z0-9]{8}_[A-Za-z0-9]{24}(?![A-Za-z0-9_])', 'A-Za-z0-9_') },
  { hint: '_secret_', re: word('(?:pi|seti)_', '[A-Za-z0-9]{14,64}_secret_[A-Za-z0-9]{16,4096}', 'A-Za-z0-9_') },
  // A Klaviyo private key is `pk_` and 34 alnum. Stripe and Clerk publishable
  // keys always carry `live_` or `test_` after `pk_`, so they do not match.
  { hint: 'pk_', re: word('pk_', '[A-Za-z0-9]{34}(?![A-Za-z0-9_])', 'A-Za-z0-9_') },
  // An age identity (SOPS reads it from keys.txt) is upper case and digits.
  { hint: 'AGE-SECRET-KEY-1', re: word('AGE-SECRET-KEY-1', '[0-9A-Z]{58}') },
  { hint: 'AGE-PLUGIN-', re: word('AGE-PLUGIN-[A-Z0-9]{1,40}-1', '[0-9A-Z]{20,4096}') },
  // Tokens that are not mixed case, so no entropy rule sees them alone.
  { hint: /NR(?:AK|II|JS|AA|RA)-/, re: word('NR(?:AK|II|JS|AA|RA)-', '[A-Za-z0-9_-]{27,40}') },
  { hint: 'dt0c01.', re: word(String.raw`dt0c01\.`, String.raw`[A-Z0-9]{24}\.[A-Z0-9]{64}`) },
  { hint: /pat-(?:na|eu|ap)[0-9]-/, re: word('pat-(?:na|eu|ap)[0-9]-', String.raw`${UUID}(?![\w-])`) },
  { hint: /(?:sdk|api)-[0-9a-f]{8}-/, re: word('(?:sdk|api)-', String.raw`${UUID}(?![\w-])`) },
  { hint: 'lin_oauth_', re: word('lin_oauth_', '[a-f0-9]{64}') },
  { hint: 'shippo_', re: word('shippo_(?:live|test)_', '[a-f0-9]{40}') },
  { hint: 'dapi', re: word('dapi', String.raw`[a-f0-9]{32}(?:-[0-9]{1,2})?(?![\w-])`) },
  { hint: ':fx', re: String.raw`(?<![0-9a-f-])${UUID}:fx(?!\w)` },
  { hint: 'access_token$', re: String.raw`access_token\$(?:production|sandbox)\$[a-z0-9]{16}\$[a-f0-9]{32}` },
  // A Twilio auth token is plain hex; it is known by the account SID beside it.
  { hint: /AC[0-9a-f]{32}["']?[ \t]*[,:]/, re: String.raw`(?<=\bAC[0-9a-f]{32}["']?[ \t]*[,:][ \t]*["']?)[0-9a-f]{32}(?![0-9A-Za-z])` },
]

// Each shape also takes in the rest of its token, so a match that stops at a
// `-` or `_` inside a key cannot leave the tail of the key on screen.
const VENDOR = VENDOR_SHAPES.map((s) => ({ hint: s.hint, re: new RegExp(`(?:${s.re})[A-Za-z0-9_-]{0,4096}`, 'g') }))

function scrubVendors(text: string, cfg: Config): string {
  let out = text
  for (const { hint, re } of VENDOR) {
    if (typeof hint === 'string' ? !out.includes(hint) : !hint.test(out)) continue
    out = out.replace(re, (m) => (cfg.allow.has(m) || m.includes('[REDACTED-') ? m : mint('SECRET', m)))
  }
  return out
}

// A private key block, up to its END line (never past the next BEGIN, so a
// file of BEGIN lines is not scanned again for each one). When the END line
// is missing (`head key.pem`), the base64 lines that follow the BEGIN line
// are still taken, and only those.
const PRIVATE_KEY =
  /-----BEGIN[^\n-]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:(?:(?!-----BEGIN)[\s\S]){0,65536}?-----END[^\n-]{0,40}PRIVATE KEY(?: BLOCK)?-----|(?:\r?\n(?:[A-Za-z][A-Za-z-]{0,40}: [^\n]*|[ \t]*))*(?:\r?\n[A-Za-z0-9+/=]{4}[A-Za-z0-9+/=]*(?=\r?\n|$))+)/g
const PUTTY_PRIVATE = /(Private-Lines: \d+\r?\n)((?:[A-Za-z0-9+/=]{1,80}(?:\r?\n|$))+)/g

// A run of dot-separated parts, where a JWT may hide. It has one starting
// point per run, so a long run is scanned once. A JWT regex of its own went
// quadratic on base64 JSON, where every row starts with `eyJ`.
const DOTTED = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)+/g

// The password inside a connection string: postgres://user:PASSWORD@host.
// The user may be empty (redis://:pw@host), and the password may hold `/` or
// `@`: it ends at the `@` that is followed by a host.
const URL_PASSWORD =
  /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:[\]]{0,80}):(?!\d{1,5}(?:[/?#]|$))([^\s"'`<>]{3,200}?)@(?=[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:[/?#\s"'`<>]|$))/gi

// A token used alone as the userinfo: `https://<token>@dev.azure.com/...`,
// the documented clone form for Azure DevOps, GitHub and Bitbucket tokens.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([A-Za-z0-9_-]{20,200})@(?=[A-Za-z0-9.-]{1,253}(?::\d{1,5})?[/:])/g

// A credential in a URL query: ?api_key=, &sig=, ?accessToken=. The value may
// be percent-encoded, so it is decoded before it is judged.
const URL_KEYWORD =
  '(?:[Aa]pi[_-]?[Kk]ey|API[_-]?KEY|[Aa]pikey|[Kk]ey|KEY|[Tt]oken|TOKEN|[Ss]ecret|SECRET|[Ss]ig|SIG|[Ss]ignature|SIGNATURE|[Pp]assword|PASSWORD|[Pp]asswd|[Pp]wd|PWD|[Aa]uth|AUTH|[Cc]redential|CREDENTIAL)'
const URL_PARAM = new RegExp(
  String.raw`([?&;](?:[A-Za-z0-9._-]*[_.-]|[a-z0-9]+(?=[A-Z]))?${URL_KEYWORD}=)((?:[A-Za-z0-9+_~-]|%[0-9A-Fa-f]{2}){8,400}={0,2})(?=[&#\s"'<>)\]]|$)`,
  'g',
)

// Values after a password-like key, judged by the key and not by entropy:
// a human password (`Summer2024!`, `hunter2hunter2`) has too little.
const PW_WORD = String.raw`(?:password|passwd|passphrase|secret|secret[_-]?key|client[_-]?secret|api[_-]?key|apikey|private[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|auth[_-]?token)`
// Short password names (`pass`, `pw`, `pwd`, `passcode`). They count only as
// the whole key or after a separator, so `compass` and `bypass` are left.
const SHORT_PW = String.raw`(?:pass(?:[_-]?code)?|pwd?)`
const SHORT_KEY = new RegExp(String.raw`(?:^|[_.-])${SHORT_PW}$`, 'i')
// A short key (`pass:`) with a number or a short word after it is a count
// or a status, not a password.
const shortKeyStatus = (key: string, v: string): boolean => SHORT_KEY.test(key) && (/^[0-9]+$/.test(v) || /^[a-z]{1,8}$/.test(v))
const STRONG_QUOTED = new RegExp(
  String.raw`((?:^|[\s{,;(\[])(\\?["']?)((?:[A-Za-z0-9._-]*[_.-]|pg)?${PW_WORD}|(?:[A-Za-z0-9._-]*[_.-])?${SHORT_PW})\2[ \t]*[:=][ \t]*)(\\?["'])([^\n]{3,200}?)\4`,
  'gim',
)
// A YAML list item (`- password: x`, compose `- DB_PASS=x`) counts too.
const STRONG_LINE = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?(?:export[ \t]+)?([A-Za-z0-9._-]*${PW_WORD}|(?:[A-Za-z0-9._-]*[_.-])?${SHORT_PW})[ \t]*[:=][ \t]*)([^\s"'#;][^\s"';]{2,199})[ \t]*$`,
  'gim',
)
// `DB_PASS=`: upper case with a separator only, so prose `Pass:` is left.
const ENV_PASS = /^([ \t]*(?:-[ \t]+)?(?:export[ \t]+)?()[A-Z0-9_]*_PASS[ \t]*[:=][ \t]*)([^\s"'#;][^\s"';]{2,199})[ \t]*$/gm
// A Gmail app password written unquoted: four groups of four letters.
const APP_PASSWORD = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?(?:export[ \t]+)?[A-Za-z0-9._-]*${PW_WORD}[ \t]*[:=][ \t]*)([a-z]{4}(?: [a-z]{4}){3})[ \t]*$`,
  'gim',
)
// The line after a YAML block indicator: `password: |` then the value.
const BLOCK_PASSWORD = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?["']?[A-Za-z0-9._-]*${PW_WORD}["']?[ \t]*:[ \t]*[|>][-+]?[0-9]?[ \t]*\r?\n[ \t]+)(\S[^\n]{2,199}?)[ \t]*(?=\r?$)`,
  'gim',
)
// SQL: `CREATE USER x WITH PASSWORD '...'`, MySQL `IDENTIFIED BY '...'`.
const SQL_PASSWORD =
  /(\b(?:(?:with|encrypted|unencrypted)[ \t]+password|identified[ \t]+(?:with[ \t]+\S+[ \t]+)?by(?:[ \t]+password)?)[ \t]+)'([^'\n]{3,200})'/gi
// Terraform: the default of a variable whose name says it is a password.
const HCL_DEFAULT = new RegExp(String.raw`(\bvariable[ \t]+"[\w-]*${PW_WORD}"[ \t]*\{[^{}]{0,400}?\bdefault[ \t]*=[ \t]*")([^"\n]{3,200})"`, 'gi')
// Terraform state: the result of a random_password (usually a database
// master password), and an output that sits under a password-like name.
const TF_RESULT = /("result"\s*:\s*")((?:[^"\\\n]|\\.){3,400})"/g
const TF_OUTPUT = new RegExp(
  String.raw`("([\w.-]{1,100})"\s*:\s*\{\s*(?:"(?:sensitive|type)"\s*:\s*[^,{}]{1,40},\s*){0,4}"value"\s*:\s*")((?:[^"\\\n]|\\.){3,400})"`,
  'g',
)
// A name and its value as sibling fields: a HAR header or form field, a
// Kubernetes env entry. The name decides; the value sits apart from it.
const JSON_NAME_VALUE = /("name"\s*:\s*"([^"\n]{1,100})"\s*,\s*"value"\s*:\s*")((?:[^"\\\n]|\\.){3,400})"/g
const JSON_VALUE_NAME = /("value"\s*:\s*")((?:[^"\\\n]|\\.){3,400})("\s*,\s*"name"\s*:\s*"([^"\n]{1,100})")/g
const YAML_NAME_VALUE =
  /^([ \t]*)(-[ \t]+name:[ \t]*["']?([\w.-]{1,100})["']?[ \t]*\r?\n\1[ \t]+value:[ \t]*(["']?))([^\n"']{3,200}?)\4[ \t]*(?=\r?$)/gm
const PW_NAME = new RegExp(String.raw`^[\w.-]*${PW_WORD}$|^(?:[\w.-]*[_.-])?${SHORT_PW}$`, 'i')
// SQL: an INSERT whose column list names a key or a password.
const SQL_INSERT = /\bINSERT[ \t]+INTO[ \t]+[\w."`[\]]{1,100}[ \t]*\(([^()\n]{1,1000})\)\s*VALUES\s*/gi
// `PGPASSWORD=x psql` is the one common env name with no separator.
const KV_PASSWORD = /((?:^|[\s;&?,])-{0,2}(?:[A-Za-z0-9._-]*[_.-]|pg)?(?:password|passwd)=|[;&?]pwd=)([^\s"'&;,]{3,200})/gim

// A generated password in quotes, with no name beside it: upper, lower,
// digit and a symbol from the Terraform and password-manager sets, no space,
// no path or regex characters. The token scan cuts such a value at each
// symbol, so it is judged whole here.
// The opening quote must follow a space, `=`, `:`, `(`, `,`, `[` or `{`, so
// the text between two strings (`"0"=20cellpadding=3D"`) is not taken.
const QUOTED_VALUE = /(?<=^|[\s:=(,[{])(["'])([^\s"'\\/.,;`]{12,128})\1/gm
const PW_SYMBOL = /[!#$%&*()=+[\]{}<>:?@^~]/

function looksGenerated(v: string): boolean {
  if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[0-9]/.test(v) || !PW_SYMBOL.test(v)) return false
  if (/\$\{|\{\{|%\(|^\^|\$$|[A-Za-z]-[A-Za-z]\]|=>|::|\(\)|<\/?[a-z]|=[0-9A-F]{2}|[0-9]{6}/.test(v)) return false
  // Real words in it: code, a format, a shortcut (`Ctrl+Alt+F12`), a payee
  // with an order number (`Merchant#a12345`).
  const words = v.match(/[A-Za-z]{4,}/g)?.filter((w) => WORDY.test(w)) ?? []
  if (words.length >= 2 || words.some((w) => w.length >= 6)) return false
  // Mostly letters and digits: a run of symbols is binary or markup.
  if ((v.match(/[A-Za-z0-9]/g)?.length ?? 0) * 5 < v.length * 3) return false
  return entropy(v) >= 3.5
}

// Things that stand in for a value without being one: a variable, a call, a
// template, a placeholder, a type, the key's own name, a path.
// A call has to close (`getSecret("x")`), and a YAML tag is a word
// (`!Ref DbPassword`), so a generated password that starts `ab(` or `!` is
// not taken for one.
const REFERENCE =
  /^[A-Za-z_$][\w$.]*\(.*\)[,;]?$|^\$|^\{\{|^<.*>$|^%\(|^!!?[A-Za-z][\w:]*(?:[ \t]|$)|^\*+$|^(?:true|false|null|none|nil|undefined|required|optional|string|str|bool|int|number)$|^(?:process\.env|os\.environ|env\.|config\.|settings\.)|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/i
const SELF_REF =
  /^[{`(]?(?:[a-z][A-Za-z0-9]*)?(?:Password|Passwd|Secret|Key|Token|Pwd)[A-Za-z0-9]*[)},`]*$|^(?:password|passwd|secret|apikey|api_key|pwd|token)[),}]*,?$/
const PLACEHOLDER = /^(?:x{3,}|\.{3,}|…|(?:your|my|<)[_ -]?[a-z_ -]*(?:key|password|secret|token)[a-z_ -]*>?)$/i

function isStandIn(v: string): boolean {
  return (
    REFERENCE.test(v) ||
    SELF_REF.test(v) ||
    PLACEHOLDER.test(v) ||
    /^(?:[/~]|\.\.?\/)/.test(v) ||
    /^\{[\w$.]+\}$/.test(v) ||
    // A test fixture made of words: `test-internal-key`, `fake_secret`.
    (/^(?:[a-z]+[_-])*(?:test|fake|dummy|mock|sample|example|placeholder|changeme)(?:[_-][a-z]+)*$/.test(v) && /[_-]/.test(v)) ||
    // `password: pw,` in an object literal is code, not a value.
    /^[A-Za-z_$][\w$]*,$/.test(v)
  )
}

// Credentials on a command line: `--password x`, `curl -u user:pw`,
// `mysql -pPW`, a .pgpass line, a .netrc entry, `gh secret set --body`.
const CLI_FLAG =
  /((?:^|\s)--?(?:password|passwd|pass|api-key|apikey|api_key|token|client-secret|auth-token|access-token)(?:=|[ \t]+)(["']?))(?![$<{%])([^\s"'=-][^\s"']{2,200})\2/g
const CLI_USERPASS =
  /(\b(?:curl|wget|http|https|xh|httpie|lftp|ftp)\b[^\n|;&]*?\s(?:-u|-U|--user|--proxy-user)(?:[ \t]+|=)["']?[^\s:"'$]+:)(?!\$)([^\s"'`]{3,200})/g
const MYSQL_P =
  /(\b(?:mysql(?:dump|admin|import|sh|check|slap|binlog)?|mariadb(?:-dump|-admin)?)\b[^\n|;&]*?\s-p)(?!\$)([^\s`-][^\s`]{2,200})/g
const PGPASS =
  /^((?:\*|[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(?:\d{1,5}|\*):(?![0-9]+:)[A-Za-z0-9_$*.-]+:[A-Za-z0-9_$*.@-]+:)(?!\/\/)(\S{3,200})$/gm
const NETRC =
  /((?:^|\n)[ \t]*(?:machine[ \t]+\S+|default)(?:\s+(?:login|account|port)[ \t]+\S+)*\s+password[ \t]+)(\S{3,200})(?=[ \t]*(?:\r?\n|$)|\s+(?:machine|default|login|account|macdef)\b)/g
const GH_SECRET = /(\bgh[ \t]+secret[ \t]+set\b[^\n;&|]*?[ \t](?:-b|--body)(?:[ \t]+|=)(["']?))([^\s"']{3,400})(?=\2)/g
// Short password flags that only mean a password for one command:
// `sshpass -p`, `docker login -p`, `mongosh -p`, `7z -pPW`, `sqlcmd -P`,
// `zip -P`, `redis-cli -a`, `ldapsearch -w`. Each is anchored at its command.
const CMD_PW_TOOLS: [cmd: string, flag: string][] = [
  [String.raw`sshpass|(?:docker|podman|nerdctl|helm[ \t]+registry)[ \t]+login|mongo(?:sh|dump|restore|import|export)?`, String.raw`-p[ \t]*`],
  [String.raw`7za?|7zz`, '-p'],
  [String.raw`sqlcmd|zip`, String.raw`-P[ \t]+`],
  [String.raw`redis-cli|valkey-cli`, String.raw`-a[ \t]+`],
  [String.raw`ldap[a-z]+`, String.raw`-w[ \t]+`],
]
const CMD_PW = CMD_PW_TOOLS.map(
  ([cmd, flag]) => new RegExp(String.raw`(\b(?:${cmd})\b[^\n|;&]*?[ \t]${flag}(["']?))(?![$-])([^\s"']{3,200})\2`, 'g'),
)
const CMD_PW_GATE = /sshpass|login|mongo|7z|sqlcmd|zip|redis-cli|valkey-cli|ldap/
// `openssl ... -passout pass:PW`, `smbclient -U user%PW`, `htpasswd -b file
// user PW`, `rabbitmqctl add_user user PW`.
const OPENSSL_PASS = /(-pass(?:in|out)?[ \t]+pass:)([^\s"']{3,200})/g
const SMB_USER = /(\bsmbclient\b[^\n|;&]*?[ \t]-U[ \t]+["']?[^\s%"']+%)([^\s"']{3,200})/g
const HTPASSWD = /(\bhtpasswd[ \t]+-[a-zA-Z]*b[a-zA-Z]*[ \t]+(?:-[a-zA-Z]+[ \t]+)*\S+[ \t]+\S+[ \t]+)(["']?)([^\s"']{3,200})\2/g
const NET_USER = /(\bnet[ \t]+user[ \t]+(?:"[^"\n]{1,64}"|\S+)[ \t]+)(["']?)((?!\/)[^\s"'*]{3,200})\2/gi
const RABBIT_USER = /(\brabbitmqctl[ \t]+(?:add_user|change_password)[ \t]+\S+[ \t]+)(["']?)([^\s"']{3,200})\2/g

// Cookies: every value in a Cookie header, curl -b, or cookies.txt.
const COOKIE = /((?:^|["'\s])(?:(?:set-)?cookie["']?[ \t]*:|-b|--cookie)[ \t]*["']?)([^"'\n]*)/gim
const COOKIE_PAIR = /(^|;[ \t]*)([^=;\s]+=)([^;\s]{16}[^;\s]*)/g
const COOKIE_ATTR = /^(?:path|domain|expires|max-age|samesite|priority)=$/i
const COOKIE_VALUE = /^(?:s%3A)?([A-Za-z0-9_+%-]{16}[A-Za-z0-9_+%-]*)(?:\.[A-Za-z0-9_+%/-]{16}[A-Za-z0-9_+%/-]*)?={0,2}$/i
const COOKIES_TXT =
  /^((?:#HttpOnly_)?\.?[\w.-]+\t(?:TRUE|FALSE)\t\S+\t(?:TRUE|FALSE)\t\d+\t[^\t\n]+\t)([^\t\r\n]{16}[^\t\r\n]*)$/gm
const HAR_COOKIE = /("name"\s*:\s*"[^"]*(?:sess|sid|token|auth)[^"]*"\s*,\s*"value"\s*:\s*")([^"]{16}[^"]*)"/gi

// Basic auth and Docker `auth`: base64 of `user:password`, often short.
const BASIC_AUTH = /((?:["']auth["'][ \t]*:[ \t]*["']|\b[Bb]asic[ \t]+))([A-Za-z0-9+/]{8,200}={0,2})(?![A-Za-z0-9+/=])/g
// A Kubernetes bootstrap token: `abcdef.0123456789abcdef`.
const BOOTSTRAP = /\b([a-z0-9]{6})\.([a-z0-9]{16})\b/g

// Inline media in a data: URI. Only media types: a key put in a JSON or text
// data URI is still scanned. The length floor stops a short key placed after
// a fake image prefix from being excused.
const DATA_URI =
  /data:(?:(?:image|font|audio|video)\/[\w.+-]+|application\/(?:x-)?font-[\w.+-]+|application\/vnd\.ms-fontobject)(?:;[\w-]+=[\w.-]+)*;base64,[A-Za-z0-9+/]{64}[A-Za-z0-9+/]*={0,2}/g

// A base64 blob: one long run, or three or more wrapped lines (a PEM bundle,
// a MIME part). A trailing short line is only taken when a blank line, a
// `--boundary` or the end of the text follows it.
const B64_LINE = String.raw`[A-Za-z0-9+/]{40}[A-Za-z0-9+/]*={0,2}\r?\n`
const BLOB = new RegExp(
  String.raw`(?<![A-Za-z0-9+/=])(?:(?:${B64_LINE}){3}(?:${B64_LINE})*(?:[A-Za-z0-9+/]+={0,2}(?=\r?\n[\r\n-]|\r?\n?$))?|[A-Za-z0-9+/]{256}[A-Za-z0-9+/]*={0,2})`,
  'g',
)
const BLOB_NAME =
  /(?:key|token|secret|password|passwd|credential|auth|private|signature|session|cookie|dsn|cert[_-]?key)[\w.-]*["'\]\s]{0,4}[:=]{1,2}\s*["'`]?\s*$/i
const BLOB_INNER = /PRIVATE KEY|OPENSSH|"private_key"|"client_secret"|"refresh_token"|"password"|"auths"/

// A Claude thinking-block signature, and a redacted thinking block: opaque
// to everyone and useless as a credential. Only the value is parked; the
// thinking text beside it is still scanned.
const THINKING_SIG =
  /("type"\s*:\s*"thinking"\s*,\s*"thinking"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*,\s*"signature"\s*:\s*")([A-Za-z0-9+/]{200}[A-Za-z0-9+/]*={0,2})(?=")/g
const REDACTED_THINKING = /("type"\s*:\s*"redacted_thinking"\s*,\s*"data"\s*:\s*")([A-Za-z0-9+/]{100}[A-Za-z0-9+/]*={0,2})(?=")/g

// A lockfile or SRI integrity hash: exact digest lengths only, so a key
// glued after `sha256-` is still judged.
const SRI = /\bsha(?:1-[A-Za-z0-9+/]{27}=|256-[A-Za-z0-9+/]{43}=|384-[A-Za-z0-9+/]{64}|512-[A-Za-z0-9+/]{86}==)(?![A-Za-z0-9+/=])/g

// Links whose path is kept as written: public font files (the file name is
// a hash, not a secret) and the hosts of the `allowUrlHosts` option (a task
// link like `/app/task/<slug>-<id>`). The host has to follow the scheme and be
// followed by a port or `/`, so `evil.com/<host>/`, `<host>.evil.com` and
// `<host>@evil.com` don't match. The slashes may be JSON-escaped (`\/`). Path
// characters only, so a query string or fragment is still scanned.
type AllowUrl = { hint: RegExp; re: RegExp }
const BUILT_IN_URL_HOSTS = ['fonts.gstatic.com']
const HOST_NAME = /^(?:\*\.)?[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9])?$/
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/

// `https://Host:8080/path` becomes `host`. An IPv6 literal keeps its brackets.
function cleanHost(entry: string): string {
  const h = entry.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^[^@]*@/, '')
  return h.startsWith('[') ? h.replace(/\](?::\d+)?$/, ']') : h.replace(/:\d*$/, '')
}

function allowUrlHosts(entries: string[]): { hosts: string[]; rejected: string[] } {
  const hosts: string[] = []
  const rejected: string[] = []
  for (const e of entries) {
    const h = cleanHost(e)
    if (HOST_NAME.test(h) || IPV6_HOST.test(h)) hosts.push(h)
    else rejected.push(e)
  }
  return { hosts, rejected }
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// `*.example.com` stands for any subdomain of example.com, not example.com.
function allowUrlPattern(hosts: string[]): AllowUrl {
  const all = [...new Set([...BUILT_IN_URL_HOSTS, ...hosts])]
  const alt = all.map((h) => (h.startsWith('*.') ? String.raw`(?:[a-z0-9_-]+\.)+${reEscape(h.slice(2))}` : reEscape(h))).join('|')
  const hint = new RegExp(all.map((h) => reEscape(h.replace(/^\*\./, ''))).join('|'), 'i')
  const slash = String.raw`(?:\/|\\\/)`
  return { hint, re: new RegExp(String.raw`https?:${slash}${slash}(?:${alt})(?::\d{1,5})?${slash}(?:[A-Za-z0-9_.~%-]|${slash})*`, 'gi') }
}

// Parks the path of each allowed link before anything else runs, so neither
// the token scan nor a value hidden elsewhere in the text can touch it. A path
// holding a vendor-shaped key is not parked; the passes judge it as usual.
// Parking also ends the path cleanly: in `/x/ab+<key>` only `/x/ab` is
// parked, and `<key>` is judged on its own.
function parkAllowedUrls(text: string, cfg: Config): string {
  if (!text.includes(':') || !cfg.allowUrl.hint.test(text)) return text
  return text.replace(cfg.allowUrl.re, (m) => (scrubVendors(m, cfg) === m ? park(m) : m))
}

// Mail: an optional `cat -n`, Read or `grep -n` prefix on each line.
const PFX = String.raw`(?:[ \t]*\d+\t|[^\s:]+:\d+[:-])?`
const PFX_RE = new RegExp(`^${PFX}`)
const CTE = new RegExp(String.raw`^${PFX}Content-Transfer-Encoding:[ \t]*base64[ \t]*\r?$`, 'gim')
const CONTENT_TYPE = new RegExp(String.raw`^${PFX}Content-Type:[ \t]*(?:\r?\n${PFX}[ \t]+)?([^;\s]+)`, 'im')
const MAIL_HEADER_NAMES =
  'DKIM-Signature|X-Google-DKIM-Signature|ARC-Seal|ARC-Message-Signature|ARC-Authentication-Results|Authentication-Results|Message-I[Dd]|References|In-Reply-To|Feedback-ID|X-SG-EID|X-SG-ID|X-MSFBL|X-Gm-Message-State|X-Google-Smtp-Source|X-Gm-Gg|X-Gm-Features|X-Received|Received-SPF|Return-Path|Received'
const MAIL_HEADER = new RegExp(String.raw`^${PFX}(?:${MAIL_HEADER_NAMES}):[^\n]*(?:\r?\n${PFX}[ \t][^\n]*){0,12}`, 'gm')
const HEADER_LINE = new RegExp(String.raw`^${PFX}[A-Z][A-Za-z0-9-]*:`)
const ENCODED_WORD = /=\?[\w-]+\?[Bb]\?[A-Za-z0-9+/=]{4}[A-Za-z0-9+/=]*\?=/g
const BOUNDARY = /Content-Type:[ \t]*multipart\/[^\n]*?(?:\r?\n[ \t][^\n]*?)?\bboundary="?([^"\s;]+)"?/gi

// The generic scan. A slash-bearing base64 run (an AWS secret, `openssl rand
// -base64`) is judged whole first; anything else is cut into candidate
// tokens. `/` and `.` are left out of a candidate on purpose: with them in,
// every long file path becomes one. A token never starts inside a `%XX`
// escape, and `=` only counts as padding when nothing follows it.
const CAND_BODY = String.raw`[A-Za-z0-9+_-]{12,200}(?:={1,2}(?![A-Za-z0-9=]))?`
const CANDIDATE_SRC = String.raw`(?<=%[0-9A-Fa-f]{2})(?<!%25)${CAND_BODY}|(?<=%25[0-9A-Fa-f]{2})${CAND_BODY}|(?<!%[0-9A-Fa-f]?|%25[0-9A-Fa-f]?)${CAND_BODY}`
const SLASHED_SRC = String.raw`(?<![A-Za-z0-9+/_.%~-])[A-Za-z0-9+/]{20,300}={0,2}(?![A-Za-z0-9+/=_.%~-])`
const CANDIDATE = new RegExp(CANDIDATE_SRC, 'g')
const SCAN = new RegExp(`(${SLASHED_SRC})|${CANDIDATE_SRC}`, 'g')

// A name to the left of the candidate that says the candidate is a key:
// `API_KEY=`, `"token":`, an escaped `\"token\":`, `&quot;token&quot;:`,
// `Authorization: Bearer `, `Authorization: <any scheme> `, `--api-key `, a
// table cell, a YAML block, a Go header map `X-Api-Key:[`, a Python header
// tuple `('X-Api-Key', '`. `PAT` is a personal access token, not `PATH`.
const NAME_WORDS =
  'key|token|secret|password|passwd|pwd|credential|auth|bearer|private|signature|session|cookie|dsn|salt|nonce|otp|sess(?:ion)?[_-]?id|(?<![A-Za-z])sid|(?<![A-Za-z])sig|(?<![A-Za-z])pat(?![a-z])'
const Q = String.raw`(?:\\{0,3}["'${'`'}]|&(?:quot|apos|#0*3[49]|#x0*2[27]);|\\u00(?:22|27))`
const NAMED = new RegExp(
  '(?:' +
    String.raw`(?:${NAME_WORDS})(?:(?<=key)[_-]?id)?(?:${Q}|\]|\s){0,6}[:=]{1,2}(?:${Q}|\s){0,4}\[?` +
    String.raw`|(?:${NAME_WORDS})[\w-]{0,20}${Q}[ \t]*,[ \t]*${Q}` +
    String.raw`|\bbearer[ \t]+["']?` +
    String.raw`|authorization["']?[ \t]*[:=][ \t]*["']?(?:[A-Za-z][\w-]{0,31}[ \t]+)?` +
    String.raw`|(?:^|\s)--?(?![a-z_-]*(?:public|pub|cache|idempotency|signing|recv)[_-]?key)[a-z_-]*(?:key|token|secret|password|passwd|pw|auth)[ \t]+["']?` +
    String.raw`|\|[ \t]*[\w.-]*(?:key|token|secret|password)[ \t]*\|[ \t]*` +
    String.raw`|(?:key|token|secret|password|passwd|pwd|credential|auth)[\w-]*["']?[ \t]*:[ \t]*[>|][-+1-9]{0,2}[ \t]*\r?\n[ \t]+` +
    ')$',
  'i',
)

// A sibling field name that makes its value a key: the value is then
// judged as if the name stood right before it.
const KEY_NAME = new RegExp(String.raw`(?:${NAME_WORDS}|authorization)`, 'i')

const HEX_ONLY = /^[0-9a-f]+$/i
const PREFIXED_KEY = /^[a-z]{2,12}(?:_v[0-9])?[_-]([a-z0-9]{32,})$/
const DIGITS_ONLY = /^[0-9]+$/
const LETTERS_ONLY = /^[A-Za-z]+$/

// Public ids with a shape rather than a prefix: a YouTube channel or
// playlist, a Monzo transaction, a Vercel deployment, team or project, an
// OpenAI org, a Claude Code session, environment or server tool call. Exact
// lengths only, and the Anthropic ids start `01`, so any other token after
// the same prefix is still judged.
const PUBLIC_SHAPE =
  /^(?:UC[A-Za-z0-9_-]{22}|PL[A-Za-z0-9_-]{16,32}|(?:tx|mm|acc|pot|merch|user)_0000[A-Za-z0-9]{18}|dpl_[A-Za-z0-9]{24,32}|org-[A-Za-z0-9]{24}|team_[A-Za-z0-9]{24}|prj_[A-Za-z0-9]{28}|(?:session|env|srvtoolu)_01[A-Za-z0-9]{22})$/

// Prefixes that name a PUBLIC object id, not a key. Stripe hands these out in
// dashboards, invoices and source code; hiding them makes a session useless
// and protects nothing. `pk_live_` is Stripe's publishable key, also public.
const PUBLIC_PREFIX =
  /^(?:price|prod|cus|sub|sched|in|ch|pi|cs|py|re|txn|il|si|seti|evt|acct|promo|coupon|plan|card|ba|src|dp|du|iv|ii|rcpt|file|link|pm|tok|pk|test|toolu|msg|req|run|wf)_/i
// A public id is the prefix, maybe `live_` or `test_`, then one alnum body.
// `prod_api_key_<random>` is not that shape, so it is judged like any token.
const PUBLIC_ID_BODY = /^(?:(?:live|test)_)?[A-Za-z0-9]+$/
// A WooCommerce consumer secret reuses Stripe's `cs_`; Stripe's never is
// 40 lowercase hex.
// A Klaviyo private key reuses `pk_`, with no `live_` or `test_` after it.
const NOT_PUBLIC = /^cs_[a-f0-9]{40}$|^pk_(?!live_|test_)[A-Za-z0-9]{34}$/
// Generic prefixes a key name in front may override (`API_KEY=test_...`).
const SOFT_PUBLIC = /^(?:test|tok)_/i

// A name written in code (`archived-modules-marker`, `handleCheckoutSession`,
// `lesson_article_outline_open_v1`) reads as high entropy but is a word list.
// A key is not built out of words.
const WORD_PART = /^(?:[a-z]+[0-9]{0,3}|[A-Z][a-z]+[0-9]{0,3}|[A-Z]{2,})$/
const ALNUM_ONLY = /^[A-Za-z0-9]+$/
const SEGMENTS = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g
const WORDY = /^[A-Za-z]?[a-z]{2,}$/
const SLASH_WORD = /^(?:[a-z]+[0-9]{0,3}|[A-Z][a-z]+[0-9]{0,3})$/
const STRICT_CAMEL = /^(?:[a-z]{2,}|[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,})+[0-9]{0,3}$/

// `playerEventBatchV1Schema` splits into six segments of which four are
// words; a random key splits into many segments of which almost none are.
// A camel name has a capital in it: an all-lowercase token with a digit run
// in the middle is a random value more often than a name.
function isCamelName(token: string): boolean {
  if (!ALNUM_ONLY.test(token) || !/[A-Z]/.test(token)) return false
  const segs = token.match(SEGMENTS)
  if (!segs || segs.join('') !== token) return false
  const words = segs.filter((seg) => WORDY.test(seg)).length
  return words >= 2 && words >= segs.length - 2
}

// Every character used once AND mostly in alphabet order: a charset constant.
// The order test matters: a random 24-character key has all distinct
// characters about 1% of the time.
function isAlphabet(token: string): boolean {
  if (token.length < 20) return false
  let runs = 0
  for (let i = 1; i < token.length; i++) if (token.charCodeAt(i) === token.charCodeAt(i - 1) + 1) runs++
  return runs * 2 >= token.length && new Set(token).size === token.length
}

// Half or more of the characters follow the one before in code order:
// `0123456789abcdef`, the base64 alphabet. A sample in docs, never a key.
function countsUp(s: string): boolean {
  let runs = 0
  for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) === s.charCodeAt(i - 1) + 1) runs++
  return runs * 2 >= s.length
}

function isMixed(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)
}

// One word, or a number of up to four digits (a year, a month, a day).
function isSlugPart(part: string): boolean {
  return WORD_PART.test(part) || /^[0-9]{1,4}$/.test(part)
}

// A part made only of words, short acronyms and short numbers: `expenseID`,
// `2026`, `v2Final`. It names something; it is not a random remainder.
function isWordish(part: string): boolean {
  const segs = part.match(SEGMENTS)
  if (!segs || segs.join('') !== part) return false
  return segs.every((seg) => WORDY.test(seg) || /^[A-Z]{2,4}$/.test(seg) || /^[0-9]{1,4}$/.test(seg))
}

function looksLikeName(token: string, named: boolean): boolean {
  if (isCamelName(token)) return true
  // A name beside the token outweighs the alphabet rule.
  if (!named && isAlphabet(token)) return true
  const parts = token.split(/[_-]/)
  if (parts.length < 2) return false
  // Beside a key's name, one key-like part makes the whole token a key:
  // `django-insecure-<random>`, `live-secret-<random>`.
  if (named && parts.some((p) => p.length >= 16 && /[0-9]/.test(p) && /[A-Za-z]/.test(p) && entropy(p) >= 3.0)) return false
  // A long random remainder outweighs any words in front of it
  // (`vercel_blob_rw_<random>`, `dckr_pat_<random>`). Mixed case is asked
  // for, so a hex cache key or a timestamp is not a remainder.
  const residue = parts.filter((p) => !WORD_PART.test(p) && !isCamelName(p) && !isWordish(p)).join('')
  // Words plus one long number (a LinkedIn post slug, a Zoom recording, an
  // Amazon ref tag): the number is an id, not part of a random remainder.
  // Only the parts that are neither words, numbers nor date stamps count,
  // and camel parts are not excused here, since a random string can pass
  // the camel test.
  const longNumber = !named && parts.some((p) => /^[A-Z]{0,4}[0-9]{6,}$/.test(p))
  const randomPart = longNumber ? parts.filter((p) => !WORD_PART.test(p) && !/^[0-9]{1,4}$/.test(p) && !DIGITS_ONLY.test(p) && !DATE_STAMP.test(p)).join('') : ''
  if ((longNumber ? (randomPart.length >= 8 ? 16 : 0) : residue.length) >= 16 && isMixed(residue)) return false
  // Words, dates and short numbers only (`2025-08-26-lesson`): a slug.
  if (parts.every(isSlugPart)) return true
  // Three or more separated parts, two of them plain words: a naming
  // convention (`META_Conv_Lookalike-Customers_FreeTrial_2024Q1`), not a key.
  if (parts.length >= 3 && parts.filter((p) => /^[A-Za-z]{4,}$/.test(p)).length >= 2) return true
  return longNumber && randomPart.length < 8
}
const DATE_STAMP = /^[A-Z]{0,4}(?:19|20)[0-9]{6}$/

function isPublicId(token: string, named: boolean, cfg: Config): boolean {
  if (PUBLIC_SHAPE.test(token)) return true
  if (cfg.allowPrefix.some((p) => token.startsWith(p))) return true
  if (!PUBLIC_PREFIX.test(token) || NOT_PUBLIC.test(token)) return false
  if (cfg.denyPrefix.some((p) => token.startsWith(p))) return false
  if (named && SOFT_PUBLIC.test(token)) return false
  return PUBLIC_ID_BODY.test(token.replace(PUBLIC_PREFIX, ''))
}

// A letters-only key (no digit at all) splits into many short camel
// segments; a camel name of the same length splits into a few long ones.
function lettersLookRandom(token: string, named: boolean, h: number): boolean {
  if (!LETTERS_ONLY.test(token) || !/[a-z]/.test(token) || !/[A-Z]/.test(token)) return false
  const segs = token.match(SEGMENTS) ?? []
  if (named && token.length >= 20 && h >= 3.6 && segs.length * 4 >= token.length) return true
  return token.length >= 24 && h >= 4.0 && segs.length * 3 >= token.length
}

// Claude Code transcripts and most analytics put a `sessionId` UUID on every
// line. A UUID beside that name is an identifier, not a credential; a real
// session cookie is random text, and the cookie rules hide it on their own.
const SESSION_UUID = new RegExp(`^${UUID}$`, 'i')
const SESSION_ID_NAME = new RegExp(String.raw`sess(?:ion)?[_-]?id(?:${Q}|\s){0,6}[:=]{1,2}(?:${Q}|\s){0,4}$`, 'i')

function looksSecret(token: string, before: string, cfg: Config): boolean {
  if (token.startsWith('REDACTED-')) return false
  if (cfg.allow.has(token) || DIGITS_ONLY.test(token)) return false
  const named = NAMED.test(before)
  if (isPublicId(token, named, cfg)) return false
  // `invoice+statements+acct_<id>`: a mail sender address made of words and
  // a public id. Each `+` part has to be one, so base64 is still judged.
  if (token.includes('+') && token.split('+').every((p) => p === '' || WORD_PART.test(p) || isPublicId(p, named, cfg))) return false
  if (named && SESSION_UUID.test(token) && SESSION_ID_NAME.test(before)) return false
  // An MCP tool name (`mcp__<server>__<tool>`) joins two names, and the
  // server's can hold a UUID. Judged whole it reads as a mixed-case key, and
  // a hidden tool name can't be loaded or called. Each part is judged alone.
  if (token.startsWith('mcp__')) {
    const parts = token.slice(5).split('__')
    if (parts.length >= 2 && parts.every(Boolean)) return parts.some((p) => looksSecret(p, before, cfg))
  }
  if (looksLikeName(token, named)) return false

  const h = entropy(token)

  // A bare hex run is a git SHA or a checksum far more often than it is a
  // key, so hex needs a name beside it before it is hidden.
  if (HEX_ONLY.test(token)) return named && token.length >= 24 && h >= cfg.contextMinEntropy

  // A short lowercase prefix and a long random body (imp_ and 40 hex): a
  // vendor key no rule names. A git SHA has no prefix, so it is not caught here.
  const prefixed = token.match(PREFIXED_KEY)
  if (prefixed && /[0-9]/.test(prefixed[1]!) && /[a-z]/.test(prefixed[1]!) && entropy(prefixed[1]!) >= cfg.contextMinEntropy) return true

  if (isMixed(token) && token.length >= cfg.minLength && h >= cfg.minEntropy) return true
  if (lettersLookRandom(token, named, h)) return true
  // Next to a key's name the bar is lower, but the token still has to look
  // like a key: letters and digits together, not a word.
  const alnum = /[0-9]/.test(token) && /[A-Za-z]/.test(token)
  return named && alnum && token.length >= 16 && h >= cfg.contextMinEntropy
}

// A slash-bearing base64 run, judged on the parts that are not words, so a
// path like `uploads/2026/10/12/Report2Final` stays a path.
function slashedSecret(run: string, named: boolean, cfg: Config): boolean {
  if (cfg.allow.has(run)) return false
  const body = run.replace(/=+$/, '').replace(/^\/+/, '')
  if (!body.includes('/') || !isMixed(body) || countsUp(body)) return false
  const parts = body.split('/').filter(Boolean)
  const isWord = (p: string): boolean => SLASH_WORD.test(p) || STRICT_CAMEL.test(p) || DIGITS_ONLY.test(p)
  const words = parts.filter(isWord).length
  if (words * 2 >= parts.length) return false
  if (!isMixed(parts.filter((p) => !isWord(p)).join(''))) return false
  const h = entropy(body)
  return (body.length >= 32 && h >= 4.3) || (named && body.length >= 16 && h >= 3.6)
}

// -------------------------------------------------------------- the passes

// Mints `value` unless it is already a placeholder, allowed, or a stand-in.
function pairOut(cfg: Config, head: string, value: string, tail = ''): string {
  if (WHOLE_TAG.test(value) || cfg.allow.has(value) || isStandIn(value)) return head + value + tail
  return head + mint('SECRET', value) + tail
}

function parkOpaque(text: string): string {
  let out = text
  if (out.includes('"signature"')) out = out.replace(THINKING_SIG, (_m, head: string, sig: string) => head + park(sig))
  if (out.includes('redacted_thinking')) out = out.replace(REDACTED_THINKING, (_m, head: string, data: string) => head + park(data))
  if (out.includes('sha')) out = out.replace(SRI, (m) => park(m))
  return out
}

function scrubKeyBlocks(text: string, cfg: Config): string {
  let out = text
  if (out.includes('PRIVATE KEY')) out = out.replace(PRIVATE_KEY, (m) => (cfg.allow.has(m) ? m : mint('SECRET', m)))
  if (out.includes('Private-Lines:')) out = out.replace(PUTTY_PRIVATE, (_m, head: string, body: string) => head + mint('SECRET', body))
  return out
}

// Walks the dot-separated parts of a run: a part holding `eyJ` and the two
// parts after it are a JWT, when each is long enough.
function scrubJwtChain(chain: string, cfg: Config): string {
  if (!chain.includes('eyJ')) return chain
  const segs = chain.split('.')
  const out: string[] = []
  let k = 0
  while (k < segs.length) {
    const i = k + 2 < segs.length ? segs[k]!.indexOf('eyJ') : -1
    if (i >= 0 && segs[k]!.length - i >= 11 && segs[k + 1]!.length >= 8 && segs[k + 2]!.length >= 8) {
      const jwt = `${segs[k]!.slice(i)}.${segs[k + 1]}.${segs[k + 2]}`
      out.push(segs[k]!.slice(0, i) + (cfg.allow.has(jwt) ? jwt : mint('SECRET', jwt)))
      k += 3
    } else {
      out.push(segs[k]!)
      k += 1
    }
  }
  return out.join('.')
}

// `postgres://user:PASSWORD@host` in docs: the word itself stands in for one.
const URL_PASSWORD_WORD = /^(?:password|passwd|pass|pw|pwd|secret|<[^>]*>)$/i

function scrubUrls(text: string, cfg: Config): string {
  let out = text
  if (out.includes('://')) {
    out = out.replace(URL_PASSWORD, (m, head: string, password: string) =>
      WHOLE_TAG.test(password) || cfg.allow.has(password) || URL_PASSWORD_WORD.test(password) ? m : `${head}:${mint('SECRET', password)}@`,
    )
    out = out.replace(URL_USERINFO, (m, head: string, user: string) => {
      if (cfg.allow.has(user) || !/[0-9]/.test(user) || !/[A-Za-z]/.test(user) || looksLikeName(user, true)) return m
      return entropy(user) >= cfg.contextMinEntropy ? `${head}${mint('SECRET', user)}@` : m
    })
  }
  if (out.includes('=')) {
    out = out.replace(URL_PARAM, (m, head: string, value: string) => (urlParamSecret(value, cfg) ? head + mint('SECRET', value) : m))
  }
  return out
}

function urlParamSecret(raw: string, cfg: Config): boolean {
  if (cfg.allow.has(raw)) return false
  let v = raw
  try {
    v = decodeURIComponent(raw)
  } catch {
    // A broken escape: judge it as it stands.
  }
  if (cfg.allow.has(v) || v.length < 12) return false
  if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length < 2) return false
  if (looksLikeName(v, true)) return false
  return entropy(v) >= cfg.contextMinEntropy
}

function scrubCommandLines(text: string, cfg: Config): string {
  let out = text
  if (/-(?:pass|api|token|client|auth|access)/.test(out)) {
    out = out.replace(CLI_FLAG, (m, head: string, quote: string, v: string) => {
      if (/^[A-Z][A-Z0-9_]*$/.test(v) || /^[A-Za-z_]+=/.test(v) || /^[A-Za-z]+(?:[-_][A-Za-z]+)+$/.test(v)) return m
      return pairOut(cfg, head, v, quote)
    })
  }
  if (/\s-(?:u|U|-user|-proxy-user)\b/.test(out)) {
    out = out.replace(CLI_USERPASS, (m, head: string, v: string) => (DIGITS_ONLY.test(v) ? m : pairOut(cfg, head, v)))
  }
  if (/mysql|mariadb/.test(out)) out = out.replace(MYSQL_P, (_m, head: string, v: string) => pairOut(cfg, head, v))
  if (out.includes(':')) out = out.replace(PGPASS, (_m, head: string, v: string) => pairOut(cfg, head, v))
  if (out.includes('password')) out = out.replace(NETRC, (_m, head: string, v: string) => pairOut(cfg, head, v))
  if (out.includes('gh')) out = out.replace(GH_SECRET, (_m, head: string, _q: string, v: string) => pairOut(cfg, head, v))
  if (CMD_PW_GATE.test(out)) {
    for (const re of CMD_PW) out = out.replace(re, (_m, head: string, q: string, v: string) => pairOut(cfg, head, v, q))
  }
  if (out.includes('pass:')) out = out.replace(OPENSSL_PASS, (_m, head: string, v: string) => pairOut(cfg, head, v))
  if (out.includes('smbclient')) out = out.replace(SMB_USER, (_m, head: string, v: string) => pairOut(cfg, head, v))
  if (out.includes('htpasswd')) out = out.replace(HTPASSWD, (_m, head: string, q: string, v: string) => pairOut(cfg, head, v, q))
  if (/net[ \t]+user/i.test(out)) out = out.replace(NET_USER, (_m, head: string, q: string, v: string) => pairOut(cfg, head, v, q))
  if (out.includes('rabbitmqctl')) out = out.replace(RABBIT_USER, (_m, head: string, q: string, v: string) => pairOut(cfg, head, v, q))
  return out
}

function scrubAssignments(text: string, cfg: Config): string {
  let out = text
  // A value under a key that says it is public is left: a publishable key.
  const value = (head: string, key: string, v: string, tail = ''): string => {
    if (/public|publishable/i.test(key)) return head + v + tail
    if (PUBLIC_PREFIX.test(v) && !/secret|private/i.test(key) && isPublicId(v, false, cfg)) return head + v + tail
    if (shortKeyStatus(key, v)) return head + v + tail
    return pairOut(cfg, head, v, tail)
  }
  // A value whose name sits in a sibling field.
  const sibling = (head: string, name: string, v: string, tail = ''): string => {
    if (PW_NAME.test(name)) return value(head, name, v, tail)
    if (KEY_NAME.test(name) && !/public|publishable/i.test(name) && looksSecret(v, 'key=', cfg)) return head + mint('SECRET', v) + tail
    return head + v + tail
  }
  if (/pass|secret|key|token|pw/i.test(out)) {
    out = out.replace(STRONG_QUOTED, (_m, head: string, _q: string, key: string, quote: string, v: string) => value(head + quote, key, v, quote))
    out = out.replace(APP_PASSWORD, (_m, head: string, v: string) => pairOut(cfg, head, v))
    out = out.replace(STRONG_LINE, (_m, head: string, key: string, v: string) => value(head, key, v))
    out = out.replace(ENV_PASS, (_m, head: string, _k: string, v: string) => value(head, '', v))
    out = out.replace(BLOCK_PASSWORD, (_m, head: string, v: string) => pairOut(cfg, head, v))
    out = out.replace(KV_PASSWORD, (_m, head: string, v: string) => pairOut(cfg, head, v))
  }
  if (PW_SYMBOL.test(out)) {
    out = out.replace(QUOTED_VALUE, (m, q: string, v: string, offset: number, whole: string) => {
      if (!looksGenerated(v) || isStandIn(v) || cfg.allow.has(v)) return m
      // A MIME boundary is random by design and public.
      if (/boundary=$/i.test(whole.slice(Math.max(0, offset - 9), offset))) return m
      return q + mint('SECRET', v) + q
    })
  }
  if (/password|identified/i.test(out)) out = out.replace(SQL_PASSWORD, (_m, head: string, v: string) => pairOut(cfg, head + "'", v, "'"))
  if (out.includes('variable')) out = out.replace(HCL_DEFAULT, (_m, head: string, v: string) => pairOut(cfg, head, v, '"'))
  if (out.includes('"value"')) {
    out = out.replace(JSON_NAME_VALUE, (_m, head: string, name: string, v: string) => sibling(head, name, v, '"'))
    out = out.replace(JSON_VALUE_NAME, (_m, head: string, v: string, tail: string, name: string) => sibling(head, name, v, tail))
    out = out.replace(TF_OUTPUT, (_m, head: string, name: string, v: string) => (PW_NAME.test(name) ? value(head, name, v, '"') : _m))
  }
  if (/"random_(?:password|string)"/.test(out)) {
    out = out.replace(TF_RESULT, (m, head: string, v: string) => (WHOLE_TAG.test(v) || cfg.allow.has(v) ? m : `${head}${mint('SECRET', v)}"`))
  }
  if (/-[ \t]+name:/.test(out)) {
    out = out.replace(YAML_NAME_VALUE, (_m, indent: string, head: string, name: string, q: string, v: string) => sibling(indent + head, name, v, q))
  }
  if (/INSERT[ \t]+INTO/i.test(out)) out = scrubSqlInserts(out, cfg)
  return out
}

// The VALUES rows after an INSERT whose columns name a key or a password:
// the value in that column is hidden. Bounded to 100 rows and 20,000
// characters per INSERT. Quoted values only; a number is never a key.
function scrubSqlInserts(text: string, cfg: Config): string {
  const ranges: [number, number][] = []
  for (const m of text.matchAll(SQL_INSERT)) {
    const names = m[1]!.split(',').map((c) => c.trim().replace(/^[`"[]|[`"\]]$/g, ''))
    const kinds = names.map((n) => (PW_NAME.test(n) ? 'pw' : KEY_NAME.test(n) && !/(?:^|_)id$|public/i.test(n) ? 'key' : ''))
    if (!kinds.some(Boolean)) continue
    const limit = Math.min(text.length, m.index! + m[0].length + 20_000)
    let i = m.index! + m[0].length
    const skipSpace = (): void => {
      while (i < limit && /\s/.test(text[i]!)) i++
    }
    for (let row = 0; row < 100 && text[i] === '('; row++) {
      i++
      for (let col = 0; i < limit && text[i] !== ')'; col++) {
        skipSpace()
        if (text[i] === "'") {
          const from = ++i
          while (i < limit && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1
          const v = text.slice(from, i)
          i++
          const kind = kinds[col]
          if (kind && v.length >= 3 && !cfg.allow.has(v) && (kind === 'pw' ? !isStandIn(v) : looksSecret(v, 'key=', cfg))) ranges.push([from, from + v.length])
        } else {
          while (i < limit && text[i] !== ',' && text[i] !== ')') i++
        }
        skipSpace()
        if (text[i] === ',') i++
        else break
      }
      if (text[i] !== ')') break
      i++
      skipSpace()
      if (text[i] !== ',') break
      i++
      skipSpace()
    }
  }
  if (ranges.length === 0) return text
  const parts: string[] = []
  let last = 0
  for (const [from, to] of ranges) {
    if (from < last) continue
    parts.push(text.slice(last, from), mint('SECRET', text.slice(from, to)))
    last = to
  }
  parts.push(text.slice(last))
  return parts.join('')
}

function cookieSecret(raw: string, cfg: Config): boolean {
  if (cfg.allow.has(raw) || raw.includes('[REDACTED-')) return false
  const m = raw.match(COOKIE_VALUE)
  if (!m) return false
  const body = m[1]!
  if (looksLikeName(body, true)) return false
  return /[0-9]/.test(body) && /[A-Za-z]/.test(body) && entropy(body) >= cfg.contextMinEntropy
}

function scrubCookies(text: string, cfg: Config): string {
  let out = text
  if (/cookie|-b\s/i.test(out)) {
    out = out.replace(COOKIE, (_m, head: string, header: string) =>
      head +
      header.replace(COOKIE_PAIR, (pair, sep: string, name: string, v: string) =>
        !COOKIE_ATTR.test(name) && cookieSecret(v, cfg) ? sep + name + mint('SECRET', v) : pair,
      ),
    )
  }
  if (out.includes('\t')) out = out.replace(COOKIES_TXT, (m, head: string, v: string) => (cookieSecret(v, cfg) ? head + mint('SECRET', v) : m))
  if (out.includes('"value"')) out = out.replace(HAR_COOKIE, (m, head: string, v: string) => (cookieSecret(v, cfg) ? `${head}${mint('SECRET', v)}"` : m))
  return out
}

function scrubAuthBlobs(text: string, cfg: Config): string {
  let out = text
  if (/asic|"auth"|'auth'/.test(out)) {
    out = out.replace(BASIC_AUTH, (m, head: string, v: string) => {
      if (v.length % 4 !== 0 || cfg.allow.has(v)) return m
      return /^[\x21-\x7e]+:[\x20-\x7e]+$/.test(decodeBase64Head(v)) ? head + mint('SECRET', v) : m
    })
  }
  if (out.includes('.')) {
    out = out.replace(BOOTSTRAP, (m, id: string, secret: string, offset: number, whole: string) => {
      if (!/[0-9]/.test(secret) || !/[a-z]/.test(secret) || countsUp(secret)) return m
      return NAMED.test(whole.slice(Math.max(0, offset - 64), offset)) ? `${id}.${mint('SECRET', secret)}` : m
    })
  }
  return out
}

// The decoded start of a base64 text is text, not media: almost no control
// bytes. An image or random bytes fail this at once, and a PDF or a zip
// (docx, xlsx) is known by its first bytes, so the full decode below only
// runs on encoded text.
function decodesToText(b64: string): boolean {
  const head = decodeBase64Head(b64, 512)
  if (head.length < 8 || head.startsWith('%PDF') || head.startsWith('PK\x03\x04')) return false
  let control = 0
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i)
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) control++
  }
  return control * 50 <= head.length
}

const firstHit = (re: RegExp, text: string): RegExpExecArray | null => {
  re.lastIndex = 0
  const m = re.exec(text)
  re.lastIndex = 0
  return m
}

// Decoded text that holds a secret by the hard rules: a vendor shape, a
// private key, a credentials file, a password-like key with a real value,
// or a URL password. These need no entropy, so they stay quiet on mail.
function decodedHoldsSecret(d: string): boolean {
  if (BLOB_INNER.test(d) || d.includes('PRIVATE KEY')) return true
  for (const { hint, re } of VENDOR) {
    if (typeof hint === 'string' ? !d.includes(hint) : !hint.test(d)) continue
    if (firstHit(re, d)) return true
  }
  if (/pass|secret|key|token/i.test(d)) {
    for (const m of d.matchAll(STRONG_LINE)) if (!isStandIn(m[3]!) && !WHOLE_TAG.test(m[3]!) && !shortKeyStatus(m[2]!, m[3]!)) return true
    for (const m of d.matchAll(STRONG_QUOTED)) if (!isStandIn(m[5]!) && !WHOLE_TAG.test(m[5]!) && !shortKeyStatus(m[3]!, m[5]!)) return true
  }
  if (d.includes('://')) for (const m of d.matchAll(URL_PASSWORD)) if (!URL_PASSWORD_WORD.test(m[2]!)) return true
  return false
}

// A base64 text that decodes to text holding a secret. Up to 1 MB of it is
// decoded; the model could decode it as easily.
function base64HoldsSecret(b64: string): boolean {
  if (!decodesToText(b64)) return false
  return decodedHoldsSecret(decodeBase64Head(b64, 1 << 20))
}

// Data URIs are parked whole. A blob is hidden as ONE placeholder when a key
// name stands in front of it, or it decodes to text that holds a key or a
// credentials file; otherwise it is parked, never shredded into thousands.
function parkMedia(text: string, cfg: Config): string {
  let out = text
  if (out.includes(';base64,')) out = out.replace(DATA_URI, (m) => park(m))
  if (/Content-Transfer-Encoding/i.test(out)) out = mintMimeSecrets(out, cfg)
  out = out.replace(BLOB, (m, offset: number, whole: string) => {
    if (cfg.allow.has(m)) return m
    if (m.includes('\n') && !evenlyWrapped(m)) return m
    // The text before it on the same line, at most 120 characters.
    const near = whole.slice(Math.max(0, offset - 120), offset)
    const before = near.slice(near.lastIndexOf('\n') + 1)
    if (BLOB_NAME.test(before) || BLOB_INNER.test(decodeBase64Head(m)) || base64HoldsSecret(m)) return mint('SECRET', m)
    return park(m)
  })
  return out
}

// A base64 MIME body of any type (a text part, an attachment) that decodes
// to a secret is hidden whole. The width test of a blob does not apply, so
// a narrow attachment is caught too.
function mintMimeSecrets(text: string, cfg: Config): string {
  const ranges: [number, number][] = []
  for (const body of mimeBodies(text)) {
    const b64 = text.slice(body.start, body.end).split(/\r?\n/).map(stripPfx).join('')
    if (base64HoldsSecret(b64)) ranges.push([body.start, body.end])
  }
  if (ranges.length === 0) return text
  const parts: string[] = []
  let last = 0
  for (const [from, to] of ranges) {
    const raw = text.slice(from, to)
    parts.push(text.slice(last, from), cfg.allow.has(raw) ? raw : mint('SECRET', raw))
    last = to
  }
  parts.push(text.slice(last))
  return parts.join('')
}

// Wrapped base64 (PEM, MIME, `base64` output) has one line width, 60 or
// more, on every line but the last. A list of keys one per line is not
// excused as a blob unless it looks exactly like that.
function evenlyWrapped(blob: string): boolean {
  const lines = blob.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 3) return false
  const width = lines[0]!.length
  if (width < 60) return false
  for (let i = 0; i < lines.length - 1; i++) if (lines[i]!.length !== width) return false
  return lines[lines.length - 1]!.length <= width
}

function lineAt(text: string, start: number): [string, number] {
  const nl = text.indexOf('\n', start)
  const end = nl < 0 ? text.length : nl
  return [text.slice(start, end).replace(/\r$/, ''), end]
}

const stripPfx = (line: string): string => line.replace(PFX_RE, '')

type MimeBody = { start: number; end: number; lines: [number, number][]; text: boolean }

// The base64 body of every MIME part, found from its
// Content-Transfer-Encoding header, with or without a line prefix. Each line
// is a [start, end] range; a last short line counts only when a blank line
// or a boundary follows it.
function mimeBodies(text: string): MimeBody[] {
  const found: MimeBody[] = []
  if (!/Content-Transfer-Encoding/i.test(text)) return found
  for (const m of text.matchAll(CTE)) {
    const at = m.index!
    // The header block ends at the next blank line; a part's headers are
    // short, so a block that runs on for 20 lines is not a MIME part.
    let pos = text.indexOf('\n', at) + 1
    let bodyStart = -1
    for (let n = 0; pos > 0 && pos < text.length && n < 20; n++) {
      const [line, end] = lineAt(text, pos)
      if (stripPfx(line) === '') {
        bodyStart = end + 1
        break
      }
      pos = end + 1
    }
    if (bodyStart < 0) continue
    // It starts after a blank line or a `--boundary` line.
    let start = text.lastIndexOf('\n', at - 1) + 1
    for (let n = 0; start > 0 && n < 20; n++) {
      const prev = text.lastIndexOf('\n', start - 2) + 1
      const line = stripPfx(text.slice(prev, start - 1).replace(/\r$/, ''))
      if (line === '' || line.startsWith('--')) break
      start = prev
    }
    const type = text.slice(start, bodyStart).match(CONTENT_TYPE)
    const isText = !type || /^(?:text|message|multipart)\//i.test(type[1]!)
    const lines: [number, number][] = []
    let width = 0
    for (let p = bodyStart; p < text.length; ) {
      const [line, end] = lineAt(text, p)
      const body = stripPfx(line)
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) break
      if (width === 0) {
        width = body.length
        if (width < 40) break
      }
      if (body.length === width && !body.endsWith('=')) {
        lines.push([p, end])
        p = end + 1
        continue
      }
      const next = end < text.length ? stripPfx(lineAt(text, end + 1)[0]) : ''
      if (next === '' || next.startsWith('--')) lines.push([p, end])
      break
    }
    if (lines.length > 0) found.push({ start: lines[0]![0], end: lines[lines.length - 1]![1], lines, text: isText })
  }
  return found
}

// The body lines of a non-text base64 MIME part (an attachment) are skipped
// by the token scan. A body that held a secret was already hidden whole.
function mimeBodySpans(text: string, spans: Spans): void {
  for (const body of mimeBodies(text)) if (!body.text) for (const [from, to] of body.lines) spans.add(from, to)
}

// Mail transport headers (DKIM, ARC, Message-ID, Received ...) inside a real
// header block, encoded-word subjects, and multipart boundaries. These are
// soft: a token after `token=` inside one is still judged.
function mailSpans(text: string, spans: Spans, boundaries: Set<string>): void {
  if (/(?:Signature|Seal|Message-I[Dd]|References|Received|Feedback-ID|X-SG-|X-MSFBL|X-Gm-|X-Google-)/.test(text)) {
    for (const m of text.matchAll(MAIL_HEADER)) {
      const at = m.index!
      const end = at + m[0].length
      const prevStart = text.lastIndexOf('\n', at - 2) + 1
      const prev = at > 0 ? text.slice(prevStart, at - 1).replace(/\r$/, '') : ''
      const next = end < text.length ? lineAt(text, end + 1)[0] : ''
      const inBlock = HEADER_LINE.test(prev) || /^[ \t]/.test(stripPfx(prev)) || HEADER_LINE.test(next)
      if (inBlock) spans.add(at, end, true)
    }
  }
  if (text.includes('=?')) for (const m of text.matchAll(ENCODED_WORD)) spans.add(m.index!, m.index! + m[0].length, true)
  if (/multipart\//i.test(text)) for (const m of text.matchAll(BOUNDARY)) boundaries.add(m[1]!.replace(/^-+|[-=]+$/g, ''))
}

function protectedSpans(text: string, boundaries: Set<string>): Spans {
  const spans = new Spans()
  mimeBodySpans(text, spans)
  mailSpans(text, spans, boundaries)
  // The Cloudflare Web Analytics beacon token is public, on every page.
  if (text.includes('data-cf-beacon')) for (const m of text.matchAll(CF_BEACON)) spans.add(m.index!, m.index! + m[0].length)
  return spans.seal()
}

const CF_BEACON = /data-cf-beacon=(?:3D)?'[^'<>]{0,800}'/g
// A content-hashed asset name: words, then a hex hash, then a file type.
const ASSET_EXT = /^\.(?:png|jpe?g|gif|webp|avif|svg|ico|mp3|mp4|m4a|wav|webm|mov|js|mjs|cjs|css|map|woff2?|ttf|otf)(?![A-Za-z0-9])/i
const HASHED_ASSET = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*[-_][0-9a-f]{8,64}$/

// A hashed class name in a <style> block: `.rio-card-header-<hash> {`. It
// has to be kebab case with two lowercase words before the hash, so a key
// built from words and `_` (`acme_live_<random>`) is still judged there.
const CSS_HASHED = /^[a-z]{2,}(?:-[a-z]{2,})+-[A-Za-z0-9]{6,}$/

function cssClass(token: string, offset: number, whole: string, after: string): boolean {
  if (!CSS_HASHED.test(token) || !/^[ \t]*(?:\{|,|\.[A-Za-z])/.test(after)) return false
  if (!/[{},\n]\.$/.test(whole.slice(Math.max(0, offset - 64), offset))) return false
  return whole.lastIndexOf('<style', offset) > whole.lastIndexOf('</style', offset)
}

function scrubTokens(text: string, cfg: Config): string {
  const boundaries = new Set<string>()
  const spans = protectedSpans(text, boundaries)
  const beforeAt = (whole: string, offset: number): string => whole.slice(Math.max(0, offset - 64), offset)
  const isBoundary = (t: string): boolean => {
    const core = t.replace(/^-+|[-=]+$/g, '')
    for (const b of boundaries) if (core.length >= 8 && b.includes(core)) return true
    return false
  }
  const judge = (token: string, offset: number, whole: string): string => {
    const span = spans.at(offset)
    if (span === 'hard') return token
    const after = whole.slice(offset + token.length, offset + token.length + 8)
    if (ASSET_EXT.test(after) && HASHED_ASSET.test(token) && !NAMED.test(beforeAt(whole, offset))) return token
    if (cssClass(token, offset, whole, after)) return token
    if (span === 'soft' || (boundaries.size > 0 && isBoundary(token))) {
      if (!NAMED.test(beforeAt(whole, offset))) return token
    }
    return looksSecret(token, beforeAt(whole, offset), cfg) ? mint('SECRET', token) : token
  }
  return text.replace(SCAN, (m: string, slashed: string | undefined, offset: number, whole: string) => {
    if (slashed === undefined) return judge(m, offset, whole)
    if (m.includes('/')) {
      const span = spans.at(offset)
      const named = NAMED.test(beforeAt(whole, offset))
      if (span !== 'hard' && (span !== 'soft' || named) && slashedSecret(m, named, cfg)) return mint('SECRET', m)
    }
    return m.replace(CANDIDATE, (t: string, o: number) => judge(t, offset + o, whole))
  })
}

export function scrubSecrets(text: string, cfg: Config): string {
  if (text.length < 8) return text
  // A whole value that is base64 (or base64url) of text holding a secret.
  if (text.length >= 256 && BASE64_VALUE.test(text) && !cfg.allow.has(text) && base64HoldsSecret(text)) return mint('SECRET', text)
  const outer = parked
  const outerLocal = local
  parked = startParking(text)
  local = new Set()
  try {
    let out = rehideKnown(parkAllowedUrls(text, cfg))
    out = parkOpaque(out)
    out = scrubKeyBlocks(out, cfg)
    if (out.includes('eyJ')) out = out.replace(DOTTED, (m) => scrubJwtChain(m, cfg))
    out = scrubVendors(out, cfg)
    out = scrubUrls(out, cfg)
    out = scrubCommandLines(out, cfg)
    out = scrubAssignments(out, cfg)
    out = scrubCookies(out, cfg)
    out = scrubAuthBlobs(out, cfg)
    out = parkMedia(out, cfg)
    out = scrubTokens(out, cfg)
    // A value hidden at one spot in this text is hidden at its other spots
    // too: a HAR repeats each query parameter in `url` and `queryString`.
    if (local.size > 0) out = rehideLocal(out, local)
    return unpark(out)
  } finally {
    parked = outer
    local = outerLocal
  }
}

// --------------------------------------------------------------- PII tests

// The local part may not start in the middle of a run: without that the
// scan restarts at every character of a long run and goes quadratic.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g

// Addresses that only ever stand in for a real one: form placeholders, docs
// and test fixtures. Hiding them is noise.
const EXAMPLE_DOMAIN =
  /@(?:example\.(?:com|org|net)|examples?\.[a-z]+|test|invalid|localhost|acme\.com|(?:your)?domain\.com|company\.com|email\.com|mail\.com|foo\.com|bar\.com|sample\.com|placeholder\.[a-z]+)$/i
const EXAMPLE_LOCAL =
  /^(?:you|your|user|username|name|email|someone|test|example|placeholder|first\.last|jane|john|alice|bob|teammate|colleague|member|admin)(?:[.+_-]?[a-z0-9]{0,12})?@/i

function allowedEmail(address: string, cfg: Config): boolean {
  const low = address.toLowerCase()
  if (low.endsWith('@users.noreply.github.com')) return true
  if (low.startsWith('noreply@') || low.startsWith('no-reply@')) return true
  if (EXAMPLE_DOMAIN.test(low) || EXAMPLE_LOCAL.test(low)) return true
  return cfg.allowEmails.some((a) => {
    const rule = a.toLowerCase().trim()
    return rule.startsWith('@') ? low.endsWith(rule) : low === rule
  })
}

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
const IPV4 = new RegExp('(?<![0-9.])(?:' + OCTET + '\\.){3}' + OCTET + '(?![0-9.])', 'g')
const IPV6 = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}(?![0-9A-Za-z:])/g

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true
  if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) return true
  if (parts[0]! >= 224) return true
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true
  return false
}

export function scrubPii(text: string, cfg: Config): string {
  let out = text
  if (cfg.emails && out.includes('@')) {
    out = out.replace(EMAIL, address => (allowedEmail(address, cfg) || cfg.allow.has(address) ? address : mint('EMAIL', address)))
  }
  out = out.replace(IPV4, address => {
    if (cfg.allow.has(address) || (!cfg.privateIps && isPrivateV4(address))) return address
    return mint('IP', address)
  })
  return out.replace(IPV6, address => {
    if (cfg.allow.has(address)) return address
    const lower = address.toLowerCase()
    if (!cfg.privateIps && (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd'))) return address
    return mint('IP', address)
  })
}

// ------------------------------------------------------------- the walkers

// A string under one of these keys is media (an image, a file body) when it
// is one long base64 run; then it is passed through untouched. Anything else
// under the same key is text and is scanned, and so is a run that decodes to
// text holding a secret (a Gmail API `body.data`): scrubSecrets then hides it
// whole.
const MEDIA_KEYS = new Set(['data', 'base64', 'b64_json', 'imageData', 'thumbnail', 'blob'])
const BASE64_VALUE = /^[A-Za-z0-9+/_-]{256}[A-Za-z0-9+/_-]*={0,2}$/
const MAX_DEPTH = 64

// Set when the walk met a part it could not rewrite: deeper than MAX_DEPTH,
// or an object that is not plain data. A hook that finds a secret elsewhere
// in the same result then withholds it rather than hand the part on raw.
export type WalkState = { incomplete: boolean }

export function walk(value: unknown, fn: (s: string) => string, st: WalkState = { incomplete: false }, depth = 0, key = ''): unknown {
  if (typeof value === 'string') return MEDIA_KEYS.has(key) && BASE64_VALUE.test(value) && !base64HoldsSecret(value) ? value : fn(value)
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
  if (depth >= MAX_DEPTH) {
    st.incomplete = true
    return value
  }
  // Array items inherit the key, so `data: [<base64>, ...]` stays media.
  if (Array.isArray(value)) return value.map((v) => walk(v, fn, st, depth + 1, key))
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    st.incomplete = true
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, fn, st, depth + 1, k)
  return out
}

// ------------------------------------------------------------------ config

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return v !== '' && v !== null && v !== undefined && Number.isFinite(n) ? n : fallback
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function makeConfig(options: Record<string, unknown>): Config {
  const tools = options.restoreTools === undefined ? DEFAULT_RESTORE_TOOLS : options.restoreTools
  const urlHosts = allowUrlHosts(strings(options.allowUrlHosts))
  return {
    secrets: bool(options.secrets, true),
    pii: bool(options.pii, false),
    emails: bool(options.hideEmails, true),
    privateIps: bool(options.redactPrivateIps, false),
    restore: bool(options.restoreInToolInputs, true),
    restoreTools: new Set(strings(tools)),
    notify: bool(options.notify, true),
    minEntropy: num(options.minEntropy, 3.6),
    minLength: Math.max(8, num(options.minLength, 24)),
    contextMinEntropy: num(options.contextMinEntropy, 3.0),
    allow: new Set(strings(options.allow)),
    allowEmails: strings(options.allowEmails),
    allowPrefix: strings(options.allowPrefixes),
    denyPrefix: strings(options.denyPrefixes),
    allowUrl: allowUrlPattern(urlHosts.hosts),
    allowUrlRejected: urlHosts.rejected,
  }
}
