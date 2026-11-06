import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, SessionMessage } from 'claude-code'

import type { Change, Run } from '../types'

const PANE = 'memory-fork'
const runs = atom({ plugin: 'memory-fork', key: 'runs' } as const, [])
const dismissed = atom({ plugin: 'memory-fork', key: 'dismissed' } as const, null)

const JUDGE = `You decide whether a coding assistant should update its persistent memory after one turn of conversation.

Memory holds only facts that help FUTURE sessions and that the repo itself does not record:
- user: who the user is, their role, expertise, preferences
- feedback: a correction or a confirmed way of working the user gave
- project: ongoing goals, constraints, decisions, dates not derivable from code or git
- reference: pointers to external resources (URLs, dashboards, tickets)
It also covers fixing or deleting a memory the turn proved wrong or stale.

Say SKIP for routine work, facts that only matter to this conversation, code structure, or anything already in the index unchanged.

Answer with exactly one line: "UPDATE: <what to save, under 20 words>" or "SKIP".`

// The mod writes the files itself: a spawned agent needs a permission verdict that auto mode will not give a spawn nobody typed.
const writerPrompt = (reason: string, files: Map<string, string>) => `[memory-fork] This message is from the memory-fork plugin, not the user. Do not use tools; answer in text only.

A classifier flagged the latest turn of this conversation for memory: ${reason}

Decide the change to the auto-memory, following the memory rules in your system prompt: one fact per file with frontmatter, update an existing file rather than duplicate, delete a memory the conversation proved wrong, keep MEMORY.md's one-line index in step. The current files:

${[...files].map(([name, text]) => `<file name="${name}">\n${text}\n</file>`).join('\n\n') || '(none)'}

Reply with only a JSON object: {"write": [{"name": "<file>.md", "content": "<whole new file>"}], "delete": ["<file>.md"]}. Bare file names, no paths. Include MEMORY.md whenever the index changes. If nothing is worth saving, reply {"write": [], "delete": []}.`

const isMemoryFile = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(name)

export const parseOps = (text: string) => {
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
    write?: { name?: unknown; content?: unknown }[]
    delete?: unknown[]
  }

  return {
    write: (json.write ?? []).filter(
      (one): one is { name: string; content: string } => isMemoryFile(one.name) && typeof one.content === 'string',
    ),
    delete: (json.delete ?? []).filter(isMemoryFile).filter(name => name !== 'MEMORY.md'),
  }
}

const memoryDir = async ($: EngineInterface) => {
  // A native Windows terminal sets USERPROFILE, not HOME
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const slug = (await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')

  return `${config}/projects/${slug}/memory`
}

// $.fs has no remove, so a command deletes. A native Windows terminal has no
// rm, and node is not promised there, so PowerShell does it, which every
// Windows has. The paths go in an env var, never in the script, so nothing in
// a path can run as code.
export const removeCommand = (isWindows: boolean, paths: string[]): [string[], { env?: Record<string, string> }] =>
  isWindows
    ? [
        [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'foreach ($p in ($env:MEMORY_FORK_PATHS -split "`n")) { if ($p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }',
        ],
        { env: { MEMORY_FORK_PATHS: paths.join('\n') } },
      ]
    : [['rm', '-f', ...paths], {}]

// C:\x, C:/x, or a share: \\server\x or //server/x
const WINDOWS_PATH = /^([A-Za-z]:[\\/]|\\\\|\/\/)/

// Whether path is inside dir, with / or \ as the separator. Windows paths are compared without case.
export const isInside = (path: string, dir: string) => {
  const windows = WINDOWS_PATH.test(dir) || WINDOWS_PATH.test(path)
  const norm = (p: string) => (windows ? p.replace(/\\/g, '/').toLowerCase() : p)

  return norm(path).startsWith(`${norm(dir)}/`)
}

const memoryFiles = async ($: EngineInterface, dir: string): Promise<FsEntry[]> =>
  (await $.fs.list(dir).catch(() => [])).filter(one => one.kind === 'file' && one.name.endsWith('.md'))

const readMemory = async ($: EngineInterface, dir: string) =>
  new Map(
    await Promise.all(
      (await memoryFiles($, dir)).map(async one => [one.name, await $.fs.read(`${dir}/${one.name}`)] as const),
    ),
  )

// File name to content. Memory files are small, so the whole folder is read before and after the fork.
type Snapshot = Map<string, string>

const toLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// Lines added and removed between two texts, counted from their longest common subsequence.
export const lineDiff = (before: string, after: string) => {
  const a = toLines(before)
  const b = toLines(after)
  let row = new Array<number>(b.length + 1).fill(0)
  for (const line of a) {
    const next = [0]
    for (let j = 0; j < b.length; j++) next.push(line === b[j] ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0))
    row = next
  }
  const kept = row[b.length] ?? 0

  return { added: b.length - kept, removed: a.length - kept }
}

export const diff = (before: Snapshot, after: Snapshot): Change[] => [
  ...[...after].flatMap(([name, text]): Change[] => {
    const old = before.get(name)
    if (old === text) return []

    return [{ name, kind: old === undefined ? 'added' : 'updated', ...lineDiff(old ?? '', text) }]
  }),
  ...[...before]
    .filter(([name]) => !after.has(name))
    .map(([name, text]): Change => ({ name, kind: 'deleted', ...lineDiff(text, '') })),
]

export const totals = (changes: Change[]) =>
  changes.reduce((sum, one) => ({ added: sum.added + one.added, removed: sum.removed + one.removed }), { added: 0, removed: 0 })

export const lastExchange = (messages: SessionMessage[]) => {
  const start = messages.findLastIndex(m => m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length)
  const lines = messages.slice(Math.max(0, start)).flatMap(m => [
    ...(m.text.trim() ? [`${m.role.toUpperCase()}: ${m.text.trim()}`] : []),
    ...m.toolUses.map(t => `TOOL: ${t.tool}`),
  ])
  const text = lines.join('\n')

  return text.length > 12000 ? `${text.slice(0, 4000)}\n…\n${text.slice(-8000)}` : text
}

const setRun = ($: EngineInterface, id: string, patch: Partial<Run>) =>
  update($, runs, list => list.map(run => (run.id === id ? { ...run, ...patch } : run)))

let isBusy = false
let isPending = false

async function consider($: EngineInterface) {
  if (isBusy) {
    isPending = true
    return
  }
  isBusy = true
  try {
    await write($)
  } finally {
    isBusy = false
    if (isPending) {
      isPending = false
      void consider($).catch(() => undefined)
    }
  }
}

async function write($: EngineInterface) {
  const id = crypto.randomUUID()
  await update($, runs, list => [...list, { id, at: Date.now(), status: 'classifying', changes: [] } as Run].slice(-20))

  const dir = await memoryDir($)
  const index = await $.fs.read(`${dir}/MEMORY.md`).catch(() => '(empty)')
  const exchange = lastExchange(await $.session.messages())
  const verdict = await $.model.complete({
    model: 'haiku',
    system: JUDGE,
    prompt: `<memory_index>\n${index}\n</memory_index>\n\n<turn>\n${exchange}\n</turn>`,
    maxTokens: 60,
    timeoutMs: 20000,
  })
  if (!verdict.isAnswered) return setRun($, id, { status: 'failed', reason: `haiku: ${verdict.reason}` })

  const line = verdict.text.trim()
  if (!line.startsWith('UPDATE')) return setRun($, id, { status: 'skipped' })

  const reason = line.replace(/^UPDATE:?\s*/, '')
  await setRun($, id, { status: 'forking', reason })
  const before = await readMemory($, dir)
  const reply = await $.model.fork({ prompt: writerPrompt(reason, before) })
  if (!reply.isAnswered) return setRun($, id, { status: 'failed', reason: `fork: ${reply.reason}` })

  let ops: ReturnType<typeof parseOps>
  try {
    ops = parseOps(reply.text)
  } catch {
    return setRun($, id, { status: 'failed', reason: 'fork did not answer with JSON' })
  }
  for (const one of ops.write) await $.fs.write(`${dir}/${one.name}`, one.content)
  if (ops.delete.length > 0) {
    const paths = ops.delete.map(name => `${dir}/${name}`)
    const [argv, init] = removeCommand((await $.env.get('OS')) === 'Windows_NT', paths)
    await $.process.run(argv, init)
  }

  await setRun($, id, { status: 'done', changes: diff(before, await readMemory($, dir)) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Headless hosts have no pane to draw, so no pane and no /memory-fork. The write pipeline still runs on turn.complete.
    if (e.isInteractive === false) return next(e)
    await $.command.register({ name: 'memory-fork', description: 'Show what the memory fork changed' })
    void $.ui.open({ id: PANE, title: 'Memory' })

    return next(e)
  })

  on('command.run', { command: 'memory-fork' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Memory' })

    return { text: 'Memory pane opened.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const dir = await memoryDir($)

    return {
      sections: [
        ...sections,
        {
          id: 'memory-fork:handoff',
          scope: 'session',
          text: `# Memory writes are handled for you\nThe memory-fork plugin decides after every turn whether ${dir} needs a change and makes it in a background fork. Do not write, edit or delete files there yourself; if the user asks you to remember something, acknowledge it and it will be saved when the turn ends. A message starting "[memory-fork]" comes from that plugin, not the user: answer it in text only, without tools.`,
        },
      ],
    }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const dir = await memoryDir($)

    return isInside(e.file_path, dir)
      ? { deny: 'memory-fork: memory is written by the background fork at the end of the turn, not by the main session.' }
      : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      const work = consider($).catch(() => undefined)
      // A -p run exits when the hook returns, so MEMORY_FORK_WAIT=1 holds it open until the write lands
      if ((await $.env.get('MEMORY_FORK_WAIT')) === '1') await work
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const latest = (await read($, runs)).findLast(run => run.status !== 'classifying' && run.status !== 'skipped')
    if (e.props.hasSurvey || !latest || latest.id === (await read($, dismissed))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const files = latest.changes.map(change => change.name).join(', ')
    const sum = totals(latest.changes)

    return (
      <Box>
        <Text color={latest.status === 'failed' ? 'red' : undefined}>
          {latest.status === 'forking' && `Memory: updating (${latest.reason}) `}
          {latest.status === 'done' && 'Memory: '}
          {latest.status === 'done' && latest.changes.length > 0 && <Text color="green">+{sum.added} </Text>}
          {latest.status === 'done' && latest.changes.length > 0 && <Text color="red">−{sum.removed} </Text>}
          {latest.status === 'done' && <Text dimColor>{files ? `· ${files} ` : 'no change '}</Text>}
          {latest.status === 'failed' && `Memory: failed (${latest.reason}) `}
        </Text>
        <Button key="open" label="Open" onPress={() => $.ui.open({ id: PANE, title: 'Memory' })} />
        <Text> </Text>
        <Button key="hide" label="Hide" onPress={() => update($, dismissed, () => latest.id)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const touched = new Set(list.flatMap(run => run.changes.filter(c => c.name !== 'MEMORY.md').map(c => c.name)))
    const session = totals(list.flatMap(run => run.changes))
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const time = (at: number) => new Date(at).toTimeString().slice(0, 5)
    const mark = { added: '+', updated: '~', deleted: '-' } as const
    const colour = { added: 'green', updated: 'yellow', deleted: 'red' } as const

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {touched.size} {touched.size === 1 ? 'memory' : 'memories'} changed this session{'  '}
          </Text>
          <Text color="green">+{session.added}</Text>
          <Text> </Text>
          <Text color="red">−{session.removed}</Text>
        </Box>
        {list.length === 0 && <Text dimColor>Waiting for the first turn to end.</Text>}
        {[...list]
          .reverse()
          .filter(run => run.status !== 'skipped' || run === list[list.length - 1])
          .slice(0, room)
          .map(run => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor={run.status === 'skipped'}>
                {time(run.at)}{' '}
                {run.status === 'classifying' && 'Haiku is checking the turn…'}
                {run.status === 'skipped' && 'nothing to remember'}
                {run.status === 'forking' && `fork writing: ${run.reason}`}
                {run.status === 'done' &&
                  (run.changes.length === 0 ? 'fork changed nothing' : `${run.changes.length} file${run.changes.length === 1 ? '' : 's'} changed`)}
                {run.status === 'failed' && `failed: ${run.reason}`}
              </Text>
              {run.changes.map(change => (
                <Box>
                  <Text color={colour[change.kind]}>
                    {'  '}
                    {mark[change.kind]} {change.name}{'  '}
                  </Text>
                  <Text color="green">+{change.added}</Text>
                  <Text> </Text>
                  <Text color="red">−{change.removed}</Text>
                </Box>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
