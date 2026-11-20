// The part of vercel-deploy-status with no UI in it: the shapes `vercel ls`
// returns, the shell lines that mean "a deploy is coming", the merge that
// turns one poll into the next queue, and the formatters the band draws
// with. It imports nothing, so `test/queue.test.mts` loads it on bare Node.

export type State = 'QUEUED' | 'BUILDING' | 'INITIALIZING' | 'READY' | 'ERROR' | 'CANCELED'

export type Deployment = {
  url: string
  name: string
  state: State
  target: string | null
  createdAt: number
  ready?: number
  meta?: {
    githubCommitRef?: string
    githubCommitMessage?: string
  }
}

// One line of the queue: the deploy, and when it left flight (null while it
// is still queued or building).
export type Row = { d: Deployment; finishedAt: number | null }

export const IN_FLIGHT: ReadonlySet<State> = new Set(['QUEUED', 'BUILDING', 'INITIALIZING'])

// A shell line that ends in a Vercel deploy. `git push` carries its own flags,
// so the alternation walks them; a dry run deploys nothing.
const DEPLOYS =
  /(^|[^\w./-])(git(\s+-\S+(\s+\S+)?)*\s+push(\s|$)|gh\s+pr\s+merge(\s|$)|vercel\s+(deploy|--prod)(\s|$))/
const DRY_RUN = /--dry-run/

export function isDeployCommand(command: string): boolean {
  return DEPLOYS.test(command) && !DRY_RUN.test(command)
}

export const LABEL: Record<State, string> = {
  QUEUED: 'Queued',
  BUILDING: 'Building',
  INITIALIZING: 'Initializing',
  READY: 'Ready',
  ERROR: 'Error',
  CANCELED: 'Canceled',
}

export const DOT: Record<State, string> = {
  QUEUED: '○',
  BUILDING: '◐',
  INITIALIZING: '◑',
  READY: '●',
  ERROR: '✗',
  CANCELED: '⊘',
}

export const COLOR: Record<State, string> = {
  QUEUED: 'yellow',
  BUILDING: 'yellow',
  INITIALIZING: 'yellow',
  READY: 'green',
  ERROR: 'red',
  CANCELED: 'red',
}

// The widest label, so the columns line up down the queue.
export const LABEL_WIDTH = Math.max(...Object.values(LABEL).map((l) => l.length))

export function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function cut(text: string, max: number): string {
  const one = text.split('\n')[0].trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function targetOf(d: Deployment): string {
  return d.target === 'production' ? 'Production' : 'Preview'
}

// `vercel ls --format json` prints a line or two of chatter before the JSON
// on some versions, so the parse starts at the first brace.
export function parseList(stdout: string): Deployment[] {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('no JSON in vercel ls output')
  const body = JSON.parse(stdout.slice(start)) as { deployments?: Deployment[] }
  return (body.deployments ?? []).slice().sort((a, b) => b.createdAt - a.createdAt)
}

// The header line: the project, then the counts that are not zero.
export function header(project: string, rows: Row[]): string {
  const queued = rows.filter((r) => r.d.state === 'QUEUED').length
  const building = rows.filter((r) => r.d.state !== 'QUEUED' && IN_FLIGHT.has(r.d.state)).length
  const done = rows.length - queued - building
  const counts = [
    building > 0 ? `${building} building` : '',
    queued > 0 ? `${queued} queued` : '',
    done > 0 ? `${done} finished` : '',
  ].filter(Boolean)
  return [`▲ ${project}`, ...counts].join(' · ')
}

// The time column of one row: how long a deploy has been in flight, or how
// long it took and how long ago it finished.
export function clock(r: Row, now: number): string {
  const d = r.d
  if (IN_FLIGHT.has(d.state)) return elapsed(now - d.createdAt)
  const took = `took ${elapsed((d.ready ?? r.finishedAt ?? now) - d.createdAt)}`
  return r.finishedAt ? `${took} · ${elapsed(now - r.finishedAt)} ago` : took
}

export type Merge = {
  rows: Row[] // the next queue, newest first
  started: Deployment[] // in flight now, and not on the last queue
  finished: Deployment[] // on the last queue in flight, and out of flight now
}

// One poll in, the next queue out. Every deploy in flight goes on the queue.
// A deploy that was in flight and is not any more keeps its line for holdMs
// with its final state. One that fell off the list has finished, and Ready is
// the usual way, so it is shown as Ready.
//
// The local is `nextRows`, not `next`, on purpose. This function is pure and
// could live in the hook module, and there `next` is the continuation every
// hook is handed. A local of that name shadows it and the whole module is
// refused at load, with no hook registered. Keep the name free everywhere.
export function merge(rows: Row[], list: Deployment[], now: number, holdMs: number): Merge {
  const known = new Set(rows.map((r) => r.d.url))
  const nextRows: Row[] = []
  const started: Deployment[] = []
  const finished: Deployment[] = []

  for (const d of list) {
    if (!IN_FLIGHT.has(d.state)) continue
    if (!known.has(d.url)) started.push(d)
    nextRows.push({ d, finishedAt: null })
  }

  for (const r of rows) {
    if (nextRows.some((n) => n.d.url === r.d.url)) continue
    if (IN_FLIGHT.has(r.d.state)) {
      const final = list.find((d) => d.url === r.d.url)
      const d: Deployment = final && !IN_FLIGHT.has(final.state) ? final : { ...r.d, state: 'READY' }
      finished.push(d)
      nextRows.push({ d, finishedAt: now })
    } else if (r.finishedAt !== null && now - r.finishedAt <= holdMs) {
      nextRows.push(r)
    }
  }

  nextRows.sort((a, b) => b.d.createdAt - a.d.createdAt)
  return { rows: nextRows, started, finished }
}

// --- the monorepo search ----------------------------------------------------

// One entry of a folder listing, as `$.fs.list` gives it.
export type Entry = { name: string; kind: string }

// The first folder under `root` that holds .vercel/project.json, shallowest
// first. It used to be `find root -maxdepth 4 ... -path */.vercel/project.json`,
// which a native Windows terminal does not have, so it walks `list` instead:
// the link file at most four levels down (the linked folder at most two),
// skipping node_modules and dot folders other than .vercel. A folder that
// cannot be listed is skipped.
export async function findLinkedBelow(
  root: string,
  list: (dir: string) => Promise<Entry[]>,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  let level = [root]
  for (let depth = 0; depth <= 2 && level.length > 0; depth++) {
    // Each level is listed at once, not one folder after another
    const listed = await Promise.all(level.map(async (dir) => {
      const dirs = (await list(dir).catch(() => [] as Entry[])).filter((e) => e.kind === 'dir')
      const linked = dirs.some((e) => e.name === '.vercel') && (await exists(`${dir}/.vercel/project.json`).catch(() => false))
      return { dir, dirs, linked }
    }))
    const hit = listed.find((l) => l.linked)
    if (hit) return hit.dir
    level = listed.flatMap((l) => l.dirs.filter((e) => e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => `${l.dir}/${e.name}`))
  }
  return null
}
