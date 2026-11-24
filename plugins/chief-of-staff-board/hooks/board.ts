// Everything with no UI in it, so a bare Node test can reach it. Imports nothing.

export type Item = { id: string; title: string; note?: string; link?: string; linkLabel?: string }
export type Lists = { updated: string; waiting: Item[]; review: Item[]; working: Item[]; handled: Item[] }

export const EMPTY: Lists = { updated: '', waiting: [], review: [], working: [], handled: [] }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const list = (v: unknown): Item[] =>
  Array.isArray(v)
    ? v
        .filter(i => i && typeof i === 'object' && typeof i.title === 'string')
        .map(i => ({ id: String(i.id ?? ''), title: i.title, note: str(i.note), link: str(i.link), linkLabel: str(i.linkLabel) }))
    : []

/** The board a file's text holds, or null when the text is not a JSON object (a half-written file). */
export function parseBoard(text: string): Lists | null {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  return { updated: String(o.updated ?? ''), waiting: list(o.waiting), review: list(o.review), working: list(o.working), handled: list(o.handled) }
}

/** Where the board file is: the option, with ~/ as the home folder, else board.json in the session's folder. */
export function boardPath(option: unknown, cwd: string, home: string | undefined): string {
  const o = typeof option === 'string' ? option.trim() : ''
  if (!o) return `${cwd}/board.json`
  if (o === '~' || o.startsWith('~/')) return `${home ?? ''}${o.slice(1)}`
  if (o.startsWith('/') || /^[A-Za-z]:[\\/]/.test(o)) return o
  return `${cwd}/${o}`
}

/** A Slack web link as a link the Slack app opens at the thread; any other link, or no team id, unchanged. */
export function slackAppLink(url: string, team: string): string {
  if (!/^T[A-Z0-9]+$/.test(team)) return url
  const m = url.match(/^https:\/\/(?:[^/]+\.)?slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/)
  if (!m) return url
  const thread = url.match(/thread_ts=([\d.]+)/)?.[1]
  return `slack://channel?team=${team}&id=${m[1]}&message=${m[2]}.${m[3]}${thread ? `&thread_ts=${thread}` : ''}`
}

/** Only web and Slack links are opened; anything else in the file is ignored. */
export const isOpenable = (url: string): boolean => /^(https?|slack):\/\//.test(url)

/** The command that opens a link on this operating system. */
export function openArgv(platform: string | undefined, url: string): string[] {
  if (platform === 'macos') return ['open', url]
  if (platform === 'windows') return ['rundll32', 'url.dll,FileProtocolHandler', url]
  if (platform === 'wsl') return ['wslview', url]
  return ['xdg-open', url]
}

export const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)

export const STARTER = JSON.stringify(
  {
    updated: 'not yet',
    waiting: [{ id: 'hello', title: 'Your coordinator has not written the board yet', note: 'Send the setup prompt, then ask it to sweep your open work.' }],
    review: [],
    working: [],
    handled: [],
  },
  null,
  1,
) + '\n'

/** What /board-setup puts in the prompt box: the standing instructions for the coordinator session. */
export const setupPrompt = (file: string): string => `Set yourself up as my chief of staff: the one session I talk to, which keeps track of my other agent threads and answers them for me.

1. Add a section called "The board" to this project's CLAUDE.md (or AGENTS.md if that is the file in use) with these rules, so every later session follows them:

- ${file} is the live board. It has "updated" (a short time, set on every write) and four lists: "waiting" (needs my decision), "review" (finished work for me to look at), "working" (in flight, nothing needed from me) and "handled" (what you did for me, newest first, at most 8).
- Each item has "id" (short, I type it back), "title" (one plain sentence), "note" (one line: who it is from, why, and your recommendation), "link" (the thread, PR or draft) and "linkLabel" (two words at most).
- Write the whole file each time, as valid JSON. Keep "waiting" to about 12 items, most urgent first.
- I answer with "Board <id>: <answer>". Act on it, then move the item to "handled" or remove it.
- Do everything that does not need me, then log it under "handled". Bring me only decisions.
- If I say "ignore" for an item, drop it and never bring it back.

2. Ask me which threads, channels and repositories you should watch, and what you may do without asking.

3. Then do a first sweep and write the board.`
