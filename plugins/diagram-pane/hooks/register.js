// diagram-pane: a side pane that keeps a live picture of the work.
//
//   1. Pinned diagrams: every mermaid block or ASCII box diagram Claude writes
//      is pinned in the pane, newest first, drawn as boxes and arrows.
//   2. Live work map: every few turns (and on /diagram) a cheap Haiku gate asks
//      "did the work change shape?". Only on YES does a fork of the session
//      draw a small JSON graph of what Claude is doing right now.
//   3. Going into a box: a number key opens that box's detail, a mermaid
//      subgraph or one a fork of the session draws. b goes back, t to the top.
//   4. Changing a diagram: Claude reads and changes the pane with the
//      diagram_get and diagram_set tools, and the person can type a change
//      into the pane itself.
//
// Claude learns what the pane shows only through those two tools.

import { findDiagrams, parseMermaid, drawGraph, short } from './draw.js'
import { adoptIds, allIds, applyOps, boxOf, carrySubs, cleanId, levelAt, setLevel, toMermaid, uniqueIds } from './graph.js'

const PANE = 'diagrams'
const TOOL_GET = 'mcp__diagram-pane__diagram_get'
const TOOL_SET = 'mcp__diagram-pane__diagram_set'
const HOME = { root: 'map', path: [] }
const NOTE = 'The map is drawn after a few turns, or now with /diagram'
// Set at each session.start; true for -p / SDK sessions
let headless = false

// Everything the pane shows. Pins are rebuilt from the transcript; the map, the
// edited pins and the view are also saved in $.store.
const S = {
  pins: [],          // [{ kind, code, title, graph, turn, edited }], newest first
  seen: new Set(),   // the code of every diagram pinned so far, to skip repeats
  scanned: 0,        // how many transcript messages we already looked at
  turn: 0,           // prompts the user has sent in this session
  sinceMap: 0,       // turns since the gate last ran
  map: null,         // { title, graph, turn, edited } from the last fork or edit
  mapAt: 0,          // transcript length when the map was drawn
  edits: {},         // pin code -> { graph, title }: the pins someone changed
  view: HOME,        // what the pane shows: { root: 'map' | 'pin', code?, path: [node ids gone into] }
  loading: new Set(),// views whose detail a fork is drawing
  loaded: false,     // the saved map has been read
  caughtUp: false,   // the one early map draw for a session with work but no map was tried
  maxPins: 5,
  every: 3,          // turns between map checks (everyTurns, or DIAGRAM_PANE_EVERY)
  note: NOTE,
  busy: false,       // a gate or fork is running
  sessionId: null,   // the session the state above belongs to
  gen: 0,            // bumped when a new session starts, so late forks drop their reply
  mapEdits: 0,       // bumped on every hand edit of the map, so a map fork that started before one drops its reply
}

// /clear keeps the process (session.start does not fire) but starts a new
// session id: drop the old session's map, pins and view
function startSession(id) {
  if (S.sessionId !== null && S.sessionId !== id) {
    Object.assign(S, {
      pins: [], seen: new Set(), scanned: 0, sinceMap: 0, map: null, mapAt: 0,
      edits: {}, view: HOME, loading: new Set(), loaded: false, caughtUp: false, note: NOTE, gen: S.gen + 1,
    })
  }
  const changed = S.sessionId !== id
  S.sessionId = id
  return changed
}

export function register(on, options) {
  const every = Number(options?.everyTurns) || 3
  S.every = every
  S.maxPins = Number(options?.maxPins) || 5

  on('session.start', async ($, e, next) => {
    // Set at each session.start. In -p / SDK sessions there is no pane to draw into
    headless = e.isInteractive === false
    if (headless) return next(e)
    // Open the pane right away. Unasked, it is placed on a wide terminal (144+ columns);
    // /diagram opens it at any width.
    await $.ui.open({ id: PANE, title: 'Diagrams' })
    try {
      await $.command.register({ name: 'diagram', description: 'Redraw the live work map in the diagram pane', argumentHint: '[force|open]' })
    } catch (err) {
      $.ui.log('could not add /diagram: ' + err.message)
    }
    for (const tool of TOOLS) {
      try {
        await $.tool.register(tool)
      } catch (err) {
        $.ui.log(`could not add ${tool.name}: ` + err.message)
      }
    }
    return next(e)
  })

  // After each main turn: pin new diagrams, and every few turns refresh the map
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Headless: no pane, so skip, unless DIAGRAM_PANE_SYNC or DIAGRAM_PANE_DUMP asks for the work
    const asked = (await $.env.get('DIAGRAM_PANE_SYNC')) || (await $.env.get('DIAGRAM_PANE_DUMP'))
    if ((headless && !asked) || e.agentId || e.isAborted) return result
    const messages = await sync($)
    S.sinceMap += 1
    if (!headless && S.pins.length && !(await $.ui.panes()).some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: 'Diagrams' })
    S.every = Number(await $.env.get('DIAGRAM_PANE_EVERY')) || every
    if (S.sinceMap >= S.every || overdue()) {
      const work = overdue() ? catchUp($, messages) : refreshMap($, messages, false)
      // Headless runs exit when the hook returns, so tests can ask us to wait
      if (await $.env.get('DIAGRAM_PANE_SYNC')) await work
    }
    await redraw($)
    return result
  })

  // /diagram runs the gate now; /diagram force skips the gate and draws the map
  // from scratch; /diagram open gives the pane the keyboard, so number keys work
  on('command.run', { command: 'diagram' }, async ($, e) => {
    const arg = e.args.trim()
    await $.ui.open({ id: PANE, title: 'Diagrams', ...(arg === 'open' ? { focus: true } : {}) })
    const messages = await sync($)
    if (arg === 'open') {
      await redraw($)
      return {}
    }
    const work = refreshMap($, messages, arg === 'force')
    if (await $.env.get('DIAGRAM_PANE_SYNC')) await work
    return {}
  })

  // Claude's way into the pane
  on('tool.call', { tool: TOOL_GET }, async $ => {
    const messages = await sync($)
    // A session with work but no saved map (a reinstall, a new marketplace,
    // --resume into a session never mapped): draw it now, so Claude gets a map
    if (overdue()) await catchUp($, messages)
    return { result: describe() }
  }).catch(() => ({ deny: 'diagram_get failed; the pane is unchanged.' }))

  on('tool.call', { tool: TOOL_SET }, async ($, e) => {
    try {
      await sync($)
      const text = setDiagram(resolveTarget(String(e.target || 'view')), e)
      await saveSaved($)
      if (!(await $.ui.panes()).some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: 'Diagrams' })
      await redraw($)
      return { result: text }
    } catch (err) {
      return { deny: 'diagram_set: ' + err.message }
    }
  }).catch(() => ({ deny: 'diagram_set failed; the pane is unchanged.' }))

  // The pane itself: lines of Text, rows of Buttons, and one Input
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const items = paneItems(Math.max(30, e.props.bodyColumns || 60), actions($))
    return h(Box, { flexDirection: 'column' }, ...items.map(it => {
      if (it.input) return h(Input, it.input)
      if (it.buttons) {
        return h(Box, { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 },
          ...(it.lead ? [h(Text, { bold: true, wrap: 'truncate-end' }, it.lead)] : []),
          ...it.buttons.map(b => h(Button, {
            key: b.key, label: b.label, onPress: b.onPress,
            ...(b.hotkey ? { hotkey: b.hotkey, plain: true } : {}),
          })))
      }
      return h(Text, { color: it.color, bold: it.bold, dimColor: it.dim, wrap: 'truncate-end' }, it.text || ' ')
    }))
  })
}

// No map, yet the transcript already holds a map's worth of turns. The map is
// saved per install, so this is a session mapped by another install (or never):
// waiting `every` more turns would leave the pane empty for no reason.
// One catch-up try per load; after that the usual cadence takes over.
const overdue = () => !S.map && !S.busy && !S.caughtUp && S.turn >= S.every

function catchUp($, messages) {
  S.caughtUp = true
  return refreshMap($, messages, false)
}

// Read the saved map once, then pin what the transcript has that is new
async function sync($) {
  const fresh = startSession(await $.session.id())
  const messages = await $.session.messages()
  S.turn = turnsIn(messages)
  await loadSaved($)
  pinNewDiagrams(messages, S.maxPins)
  if (fresh) await redraw($)
  return messages
}

// ---------------------------------------------------------------------------
// Pinned diagrams
// ---------------------------------------------------------------------------

// A turn is a prompt the user typed (tool results also arrive as user messages)
function turnsIn(messages) {
  return messages.filter(m => m.role === 'user' && m.text && !m.toolResults?.length).length
}

function pinNewDiagrams(messages, maxPins) {
  if (messages.length < S.scanned) S.scanned = 0 // compacted: rescan, `seen` stops repeats
  messages.forEach((m, i) => {
    if (i < S.scanned || m.role !== 'assistant') return
    for (const d of findDiagrams(m.text)) {
      if (S.seen.has(d.code)) continue
      S.seen.add(d.code)
      // An edited pin comes back as edited; else parse mermaid flowcharts into a
      // graph, and show anything else as written
      const edit = S.edits[d.code]
      const graph = edit?.graph || (d.kind === 'mermaid' ? parseMermaid(d.code) : null)
      S.pins.unshift({ ...d, title: edit?.title || d.title, graph, edited: Boolean(edit), turn: turnsIn(messages.slice(0, i)) })
    }
  })
  S.scanned = messages.length
  S.pins.length = Math.min(S.pins.length, maxPins)
}

const pinOf = code => S.pins.find(p => p.code === code)

// ---------------------------------------------------------------------------
// Live work map: the gate, then the fork
// ---------------------------------------------------------------------------

const GATE_SYSTEM = 'You watch a coding agent so a small diagram of its work stays current. Answer with exactly one word: YES or NO.'

const SIDE = '[diagram-pane side request: not from the user. Do not continue the task and do not call tools.]'

const JSON_SHAPE = `{"title":"what it is, max 40 chars","nodes":[{"id":"a","label":"max 20 chars","kind":"file|component|step","now":false}],"edges":[{"from":"a","to":"b","label":"optional, max 10 chars"}]}`

const FORK_PROMPT = `${SIDE}
Draw a compact map of the work in this session right now: the files, components and steps involved, and how they connect.
Reply with ONLY one JSON object, no prose and no code fence:
${JSON_SHAPE}
Map the task, not the chat: steps are steps of the work ("add discount", "run tests"), never "read files" or "explain".
Rules: 3 to 8 nodes. Edges point from earlier to later, or from caller to callee, so the map reads top to bottom. At most 10 edges. Use file basenames as file labels. Set "now": true on the one node being worked on at this moment.`

// The map the person sees goes to the fork, so a redraw builds on it, and on
// their edits, instead of starting over
function basePrompt(map) {
  return `\n\nThe map the user sees now${map.edited ? ' (the user or Claude edited it by hand: keep those edits)' : ''}:\n` +
    `${toMermaid(shallow(map.graph))}\n` +
    'Keep the ids and labels of nodes that still fit. Add, drop or reconnect only what the work changed. Reply with the JSON as above.'
}

async function refreshMap($, messages, force) {
  if (S.busy) return
  S.busy = true
  S.sinceMap = 0
  const gen = S.gen
  try {
    // 1. The cheap gate: skipped only when there is no map yet, or on /diagram force
    if (S.map && !force) {
      S.note = 'gate: checking if the work changed shape...'
      await redraw($)
      const activity = messages.slice(S.mapAt)
      const gate = await $.model.complete({
        model: 'haiku',
        system: GATE_SYSTEM,
        prompt: `CURRENT MAP: ${mapSummary()}\n\nFILES TOUCHED SINCE, NOT ON THE MAP: ${newFiles(activity).join(', ') || 'none'}\n\n` +
          `ACTIVITY SINCE THE MAP WAS DRAWN:\n${digest(activity)}\n\n` +
          'Answer YES if the map is now out of date: the work touched files or components the map lacks, added a step ' +
          '(such as tests, a new feature, a fix), or moved to a different task. Answer NO only if the map still shows the work. YES or NO?',
        maxTokens: 5,
        timeoutMs: 20000,
      })
      if (gen !== S.gen) return
      const yes = gate.isAnswered && /^\s*yes/i.test(gate.text)
      if (!yes) {
        S.note = `gate said same shape at turn ${S.turn}, map kept` + (gate.isAnswered ? '' : ` (${gate.reason})`)
        return
      }
    }
    // 2. The fork: the session's own context, asked for JSON. It cannot call tools.
    // /diagram force draws from scratch; otherwise the fork builds on the current map.
    const base = force ? null : S.map
    const edits = S.mapEdits
    S.note = 'fork: drawing the work map...'
    await redraw($)
    const r = await $.model.fork({ prompt: FORK_PROMPT + (base ? basePrompt(base) : '') })
    if (gen !== S.gen) return // /clear ran meanwhile: this map is the old session's
    if (!r.isAnswered) {
      S.note = r.reason === 'nothing-to-fork' ? 'nothing to map yet: send a prompt first' : 'fork failed: ' + r.reason
      return
    }
    const map = parseMap(r.text)
    if (!map) {
      S.note = 'fork reply was not a graph: ' + short(r.text.replace(/\s+/g, ' '), 60)
      return
    }
    // Someone changed the map while the fork ran: their change wins over a map
    // drawn from what was there before it
    if (S.mapEdits !== edits) {
      S.note = `kept the map as edited at turn ${S.turn}; it refreshes at the next check`
      return
    }
    // Boxes that kept their id and label keep the detail drawn inside them, read
    // from the map as it is now, so a box opened while the fork ran keeps its detail
    const now = force ? null : S.map
    const graph = uniqueIds(now ? carrySubs(now.graph, map.graph, { sameLabel: true }) : map.graph)
    S.map = { title: map.title, graph, turn: S.turn, edited: Boolean(now?.edited) }
    S.mapAt = messages.length
    S.note = `map drawn at turn ${S.turn}`
    await saveSaved($)
  } catch (err) {
    if (gen === S.gen) S.note = 'map error: ' + err.message
  } finally {
    S.busy = false
    await redraw($)
  }
}

// A fork's JSON becomes the same { nodes, edges } shape a mermaid chart parses to
export function parseMap(text) {
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const nodes = (json.nodes || []).slice(0, 10).map(n => ({
      id: cleanId(n.id),
      label: short(n.label || n.id, 22),
      box: boxOf(n.kind),
      ...(n.now ? { now: true } : {}),
    }))
    const edges = (json.edges || []).slice(0, 14).map(e => ({ from: cleanId(e.from), to: cleanId(e.to), label: short(e.label || '', 10) }))
    return nodes.length ? { title: short(json.title || 'the work', 50), graph: { nodes, edges } } : null
  } catch {
    return null
  }
}

// The map, the edited pins and the view are kept per session in the plugin's
// store, so they survive a reload or --resume
async function loadSaved($) {
  if (S.loaded) return
  S.loaded = true
  const saved = ((await $.store.get('maps')) || {})[S.sessionId]
  if (!saved) return
  if (saved.map) Object.assign(S, { map: saved.map, mapAt: saved.mapAt || 0, note: `map from turn ${saved.map.turn}` })
  if (saved.edits) S.edits = saved.edits
  if (saved.view) S.view = saved.view
}

async function saveSaved($) {
  if (S.sessionId === null) return
  const maps = (await $.store.get('maps')) || {}
  // Edits of pins that fell off the pane are no longer needed
  const edits = Object.fromEntries(Object.entries(S.edits).filter(([code]) => pinOf(code)))
  maps[S.sessionId] = { map: S.map, mapAt: S.mapAt, edits, view: S.view, at: await $.clock.now() }
  // Keep the 20 newest sessions only
  const keep = Object.entries(maps).sort((a, b) => b[1].at - a[1].at).slice(0, 20)
  await $.store.set('maps', Object.fromEntries(keep))
}

function mapSummary() {
  const { nodes, edges } = S.map.graph
  const name = id => nodes.find(n => n.id === id)?.label
  return `"${S.map.title}": ` + nodes.map(n => n.label).join(', ') + '; ' + edges.map(e => `${name(e.from)} -> ${name(e.to)}`).join(', ')
}

// Files Claude read, wrote or edited whose names the map does not mention
function newFiles(messages) {
  const onMap = S.map.graph.nodes.map(n => n.label).join(' ')
  const names = messages.flatMap(m => (m.toolUses || []).map(t => fileName(t.input?.file_path)))
  return [...new Set(names)].filter(n => n && !onMap.includes(n))
}

// The last part of a path, after a / or (on Windows) a \
export function fileName(path) {
  return String(path || '').split(/[\\/]/).pop()
}

// What happened since the map was drawn, as short lines: prompts and tool calls
function digest(messages) {
  const lines = []
  for (const m of messages) {
    if (m.role === 'user' && m.text && !m.toolResults?.length) lines.push('user: ' + short(m.text.replace(/\s+/g, ' '), 160))
    for (const t of m.toolUses || []) {
      const i = t.input || {}
      lines.push(`${t.tool}: ` + short(String(i.file_path || i.path || i.command || i.pattern || i.description || ''), 100))
    }
  }
  return lines.slice(-40).join('\n') || '(nothing)'
}

// One level, without the details inside its boxes: what a prompt needs
const shallow = g => ({ nodes: g.nodes.map(({ sub, ...n }) => n), edges: g.edges })

// ---------------------------------------------------------------------------
// Going into a box
// ---------------------------------------------------------------------------

const rootGraph = (view = S.view) => (view.root === 'pin' ? pinOf(view.code)?.graph : S.map?.graph) || null

const isHome = (view = S.view) => view.root === 'map' && !view.path.length

const viewKey = view => `${view.root}\u0000${view.code || ''}\u0000${view.path.join('/')}`

// The names of the levels down to the view, for the pane's header
function crumbs(view = S.view) {
  const pin = view.root === 'pin' ? pinOf(view.code) : null
  const names = [pin ? short(pin.title || `pin ${S.pins.indexOf(pin) + 1}`, 24) : 'Work map']
  let g = rootGraph(view)
  for (const id of view.path) {
    const n = g?.nodes.find(n => n.id === id)
    names.push(n ? short(n.label, 20) : id)
    g = n?.sub
  }
  return names
}

// A redrawn map or a dropped pin can take the view's boxes away: keep the part
// of the path that is still there
function normalizeView() {
  const v = S.view
  if (v.root === 'pin' && !pinOf(v.code)) return (S.view = HOME)
  let g = rootGraph(v)
  const keep = []
  for (const id of v.path) {
    const n = g?.nodes.find(n => n.id === id)
    if (!n) break
    keep.push(id)
    g = n.sub
  }
  if (keep.length !== v.path.length) S.view = { ...v, path: keep }
}

function actions($) {
  const go = async view => {
    S.view = view
    await redraw($)
    await saveSaved($)
  }
  return {
    drill: id => drill($, id),
    back: () => go(S.view.path.length ? { ...S.view, path: S.view.path.slice(0, -1) } : HOME),
    top: () => go(HOME),
    openPin: code => go({ root: 'pin', code, path: [] }),
    edit: text => editByFork($, text),
    // A surface that cannot move the focus leaves the field to Tab or a click
    typeChange: () => $.ui.focus({ requestId: PANE, key: inputKey() }).catch(() => {}),
  }
}

async function drill($, id) {
  normalizeView()
  const { graph } = levelAt(rootGraph(), S.view.path)
  const node = graph?.nodes.find(n => n.id === id)
  if (!node) return
  S.view = { ...S.view, path: [...S.view.path, id] }
  await redraw($)
  await saveSaved($)
  if (!node.sub) await expand($, S.view)
}

const DETAIL_PROMPT = (where, parent, node) => `${SIDE}
The user is looking at this diagram in a side pane (${where}):
${toMermaid(shallow(parent))}
They opened the box "${node.label}" (id ${node.id}). Draw what is inside it, one level more detailed: its parts (functions, sub-steps, components, resources) and how they connect.
Use what this session has seen. Where you have not seen the inside, draw only what you can infer, and do not invent file names.
Reply with ONLY one JSON object, no prose and no code fence:
${JSON_SHAPE}
Rules: 3 to 8 nodes, at most 10 edges, edges read top to bottom. Leave "now" false.`

// A box with no detail yet: ask a fork of the session to draw one
async function expand($, view) {
  const key = viewKey(view)
  if (S.loading.has(key)) return
  const id = view.path.at(-1)
  const parentView = { ...view, path: view.path.slice(0, -1) }
  const parent = levelAt(rootGraph(view), parentView.path).graph
  const node = parent?.nodes.find(n => n.id === id)
  if (!node) return
  S.loading.add(key)
  S.note = `fork: drawing the inside of ${short(node.label, 24)}...`
  await redraw($)
  const gen = S.gen
  try {
    const r = await $.model.fork({ prompt: DETAIL_PROMPT(crumbs(parentView).join(' › '), parent, node) })
    if (gen !== S.gen) return
    if (!r.isAnswered) {
      S.note = r.reason === 'nothing-to-fork' ? 'nothing to fork yet: send a prompt first' : 'fork failed: ' + r.reason
      return
    }
    const detail = parseMap(r.text)
    if (!detail) {
      S.note = 'fork reply was not a graph: ' + short(r.text.replace(/\s+/g, ' '), 60)
      return
    }
    // The diagram may have changed while the fork ran: attach only to a box that
    // is still there and still has no detail
    const root = rootGraph(view)
    const at = levelAt(root, view.path)
    if (at.graph || !at.node) return
    commitRoot(view, setLevel(root, view.path, adoptIds(detail.graph, allIds(root), id)), {})
    S.note = `drew the inside of ${short(node.label, 24)}`
    await saveSaved($)
  } catch (err) {
    if (gen === S.gen) S.note = 'detail error: ' + err.message
  } finally {
    S.loading.delete(key)
    await redraw($)
  }
}

// ---------------------------------------------------------------------------
// Changing a diagram: Claude's tools and the pane's own input
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'diagram_get',
    description:
      "Read what the user's diagram side pane shows: the live work map, the diagrams pinned from your replies, and which box " +
      'the user has opened. Each comes back as mermaid with stable node ids; a subgraph is a box with a detail diagram inside ' +
      'that the user can open. Call this when the user talks about "the diagram", "the map", a box or a pin, and before ' +
      'diagram_set. The user can change diagrams from the pane too, so read again instead of trusting an earlier copy.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
  {
    name: 'diagram_set',
    description:
      "Change a diagram in the user's side pane. target: \"view\" (what the user is looking at; the default), \"map\" " +
      '(the live work map) or "pin:N" (a pinned diagram, N as diagram_get lists it). path: node ids to go down through ' +
      "from that diagram's top level (from the open box for \"view\"); the change applies to the last node's detail, " +
      'created if it has none. Give mermaid (a whole flowchart that replaces that level: ids you keep keep their details, ' +
      'subgraph blocks become details the user can open) and/or ops (small patches). The pane then shows the changed ' +
      'level. Edits stay: the automatic map refresh builds on them instead of redrawing over them.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '"view", "map" or "pin:N"' },
        path: { type: 'array', items: { type: 'string' }, description: 'Node ids to go into, top level first' },
        mermaid: { type: 'string', description: 'A flowchart (flowchart TD) that replaces the level' },
        ops: {
          type: 'array',
          description: 'Patches, applied in order after mermaid',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add_node', 'remove_node', 'relabel', 'set_kind', 'add_edge', 'remove_edge'] },
              id: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string', enum: ['file', 'component', 'step'] },
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['op'],
          },
        },
        title: { type: 'string', description: 'A new title for the diagram' },
      },
    },
    isDeferred: false,
  },
]

// What diagram_get returns: every diagram as mermaid, and where the user is
export function describe() {
  normalizeView()
  const out = [`The pane shows: ${crumbs().join(' › ')}` +
    (S.view.path.length ? `  (path ${JSON.stringify(S.view.path)} in ${S.view.root === 'map' ? '"map"' : `"pin:${S.pins.indexOf(pinOf(S.view.code)) + 1}"`})` : '')]
  if (S.map) out.push(`\n## map: "${S.map.title}" (turn ${S.map.turn}${S.map.edited ? ', edited' : ''})\n\`\`\`mermaid\n${toMermaid(S.map.graph)}\n\`\`\``)
  else {
    const left = Math.max(1, S.every - S.sinceMap)
    out.push(`\n## map: not drawn yet. Last status: ${S.note}.\n` +
      'This install has no saved map for this session (maps are kept per install, so a reinstall or a new marketplace starts empty). ' +
      `The next check runs after ${left} more turn${left > 1 ? 's' : ''}. The user can run /diagram to draw it now, ` +
      'or diagram_set with target "map" and mermaid draws one by hand.')
  }
  S.pins.forEach((p, i) => {
    out.push(`\n## pin:${i + 1}: "${p.title || 'untitled'}" (turn ${p.turn}${p.edited ? ', edited' : ''})`)
    if (p.graph) out.push(`\`\`\`mermaid\n${toMermaid(p.graph)}\n\`\`\``)
    else out.push(`Not a flowchart, shown as written (mermaid in diagram_set replaces it with one):\n\`\`\`${p.kind === 'mermaid' ? 'mermaid' : 'text'}\n${p.code}\n\`\`\``)
  })
  if (!S.pins.length) out.push('\nNo pinned diagrams.')
  return out.join('\n')
}

function resolveTarget(target) {
  if (target === 'view') {
    normalizeView()
    return { ...S.view }
  }
  if (target === 'map') return { ...HOME }
  const m = /^pin:?\s*(\d+)$/i.exec(target)
  if (m) {
    const pin = S.pins[Number(m[1]) - 1]
    if (!pin) throw new Error(`no ${target}: there ${S.pins.length === 1 ? 'is 1 pin' : `are ${S.pins.length} pins`}`)
    return { root: 'pin', code: pin.code, path: [] }
  }
  throw new Error(`unknown target "${target}": use "view", "map" or "pin:N"`)
}

// Apply { path, mermaid, ops, title } at `view`, show the changed level, and say what changed
export function setDiagram(view, input) {
  const { mermaid, ops, title } = input
  const path = [...view.path, ...(Array.isArray(input.path) ? input.path.map(String) : [])]
  if (!mermaid && !ops?.length && !title) throw new Error('give mermaid, ops or title')
  const root = rootGraph(view)
  let level = { nodes: [], edges: [] }
  if (root) {
    const at = levelAt(root, path)
    if (!at.graph && !at.node) throw new Error(`path ${JSON.stringify(path)} does not lead to a box`)
    level = at.graph || level
  } else if (path.length) throw new Error('that diagram has no boxes to go into yet')
  else if (!mermaid && !ops?.length) throw new Error('that diagram has no boxes yet: give mermaid')

  // Only a new title: the diagram's boxes stay as they are
  if (!mermaid && !ops?.length) {
    commitRoot(view, root, { edited: true, title })
    S.view = { ...view, path }
    return `Retitled ${crumbs().join(' › ')}.`
  }

  let next = level
  const changes = []
  if (mermaid) {
    const parsed = parseMermaid(String(mermaid).replace(/^\s*```(?:mermaid)?\s*\n?|```\s*$/g, ''))
    if (!parsed) throw new Error('mermaid must be a flowchart ("flowchart TD" or "graph TD") with at least one node')
    next = carrySubs(level, parsed)
    changes.push(`redrew it with ${parsed.nodes.length} boxes`)
  }
  if (ops?.length) {
    const r = applyOps(next, ops)
    next = r.graph
    changes.push(...r.changes)
  }
  if (title) changes.push('retitled it')
  // A detail's ids must not clash with the rest of the tree
  if (path.length) next = adoptIds(next, allIds(setLevel(root, path, { nodes: [], edges: [] })), path.at(-1))
  // A detail with no boxes left is no detail: the box goes back to having none
  const tree = path.length ? setLevel(root, path, next.nodes.length ? next : null) : next
  // A box added on top may take an id already used inside a detail: the deeper one is renamed
  commitRoot(view, uniqueIds(tree), { edited: true, title })
  S.view = { ...view, path }
  normalizeView()
  next = levelAt(rootGraph(), S.view.path).graph || { nodes: [], edges: [] }
  return `Changed ${crumbs().join(' › ')}: ${changes.join(', ')}. The pane shows it now:\n` +
    `\`\`\`mermaid\n${toMermaid(next)}\n\`\`\``
}

// Store a changed tree as the map or as the pin it came from
function commitRoot(view, graph, { edited = false, title }) {
  if (view.root === 'map') {
    S.map = {
      title: title || S.map?.title || 'diagram',
      graph,
      turn: S.map?.turn ?? S.turn,
      edited: Boolean(S.map?.edited || edited),
    }
    if (edited) S.mapEdits += 1
    return
  }
  const pin = pinOf(view.code)
  if (!pin) throw new Error('that pin is no longer in the pane')
  pin.graph = graph
  if (title) pin.title = title
  if (edited || pin.edited) {
    pin.edited = true
    S.edits[pin.code] = { graph, title: pin.title }
  }
}

const EDIT_PROMPT = (where, source, text) => `${SIDE}
The user is looking at this diagram in a side pane (${where}):
${source}
They typed this change: "${text}"
Reply with ONLY the changed diagram as a mermaid flowchart ("flowchart TD"), no prose. Keep the ids of boxes that stay.`

// The pane's input: a fork of the session redraws the level the person is on
async function editByFork($, text) {
  text = String(text).trim()
  if (!text) return
  normalizeView()
  const view = { ...S.view }
  const root = rootGraph(view)
  const at = root ? levelAt(root, view.path) : { graph: null }
  const pin = view.root === 'pin' ? pinOf(view.code) : null
  const source = at.graph ? toMermaid(shallow(at.graph)) : !view.path.length && pin ? pin.code : null
  if (!source) {
    S.note = 'nothing to change here yet'
    return redraw($)
  }
  S.note = `fork: changing it: "${short(text, 30)}"...`
  await redraw($)
  const gen = S.gen
  try {
    const r = await $.model.fork({ prompt: EDIT_PROMPT(crumbs(view).join(' › '), source, text) })
    if (gen !== S.gen) return
    if (!r.isAnswered) {
      S.note = r.reason === 'nothing-to-fork' ? 'nothing to fork yet: send a prompt first' : 'fork failed: ' + r.reason
      return
    }
    // The chart is in a code fence, or starts at a line of its own that opens with
    // flowchart or graph (never at those words inside the prose before it)
    const fenced = r.text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/)
    const start = r.text.search(/^[ \t]*(flowchart|graph)\b/m)
    if (!fenced && start < 0) throw new Error('the reply had no flowchart')
    const code = fenced ? fenced[1] : r.text.slice(start)
    setDiagram({ ...view, path: [] }, { path: view.path, mermaid: code })
    S.note = `changed: ${short(text, 40)}`
    await saveSaved($)
  } catch (err) {
    if (gen === S.gen) S.note = 'change failed: ' + err.message
  } finally {
    await redraw($)
  }
}

// ---------------------------------------------------------------------------
// What the pane draws
// ---------------------------------------------------------------------------

// Mark the box Claude is on and the boxes that already have a detail inside.
// With `keys`, also number the first nine boxes: the keys that open them. Pins on
// the home view have no keys of their own, so they are drawn without numbers.
function marked(graph, keys = true) {
  return {
    nodes: graph.nodes.map((n, i) => ({
      ...n,
      label: (keys && i < 9 ? `${i + 1}·` : '') + (n.now ? '▶ ' : '') + n.label + (n.sub ? ' ▸' : ''),
    })),
    edges: graph.edges,
  }
}

// A Button per box: the first nine also have their number as a hotkey, the rest
// are reached with Tab or a click
function nodeButtons(graph, act) {
  return graph.nodes.map((n, i) => ({
    key: 'node:' + n.id,
    ...(i < 9 ? { hotkey: String(i + 1) } : {}),
    label: short(n.label, 16) + (n.sub ? ' ▸' : ''),
    onPress: () => act?.drill(n.id),
  }))
}

// The change field's key: one per view, so text typed for one diagram does not
// follow you into another. A pin is named by its code, not its place in the
// list, which shifts when a new diagram is pinned.
function inputKey(view = S.view) {
  return ['edit', view.root === 'pin' ? 'pin' + hash(view.code || '') : 'map', ...view.path].join('-')
}

function hash(text) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// Items of { text, color, bold, dim }, { buttons, lead? } or { input }, cut to `w` columns
function paneItems(w, act) {
  normalizeView()
  const out = []
  const add = (text, style = {}) => out.push({ text, ...style })
  const rule = () => add('─'.repeat(w), { dim: true })
  // The change field, and a c key that moves the focus into it: number keys and
  // b and t stay hotkeys, and the person need not Tab past every box to type
  const input = placeholder => {
    out.push({ buttons: [{ key: 'change', hotkey: 'c', label: 'type a change', onPress: () => act?.typeChange() }] })
    out.push({ input: { key: inputKey(), placeholder, submitLabel: 'change', onSubmit: value => act?.edit(value) } })
    add('keys: click the pane, ctrl+x tab or /diagram open', { dim: true })
  }

  // Inside a box, or a pin opened on its own: that one diagram
  if (!isHome()) {
    const v = S.view
    add(short('◆ ' + crumbs().join(' › '), w), { bold: true, color: v.root === 'map' ? 'cyan' : 'magenta' })
    out.push({ buttons: [
      { key: 'back', hotkey: 'b', label: 'back', onPress: () => act?.back() },
      { key: 'top', hotkey: 't', label: 'top', onPress: () => act?.top() },
    ] })
    const { graph, node } = levelAt(rootGraph(), v.path)
    const pin = v.root === 'pin' ? pinOf(v.code) : null
    if (graph) {
      for (const l of drawGraph(marked(graph), w)) add(l, { color: v.root === 'map' ? 'cyan' : undefined })
      out.push({ buttons: nodeButtons(graph, act) })
    } else if (node) {
      add(S.loading.has(viewKey(v)) ? `… drawing the inside of ${node.label}` : `${node.label} has no detail yet.`, { dim: true })
    } else if (pin) {
      for (const l of pin.code.split('\n')) add(l, { dim: pin.kind === 'mermaid' })
    }
    add((S.busy ? '… ' : '') + S.note, { dim: true })
    if (graph || pin) input('describe a change to this diagram')
    return out
  }

  add(spread('◆ LIVE WORK MAP', S.map ? `turn ${S.map.turn}${S.map.edited ? ', edited' : ''}` : '', w), { bold: true, color: 'cyan' })
  if (S.map) {
    add(S.map.title, { bold: true })
    for (const l of drawGraph(marked(S.map.graph), w)) add(l, { color: 'cyan' })
    add('┌ file  ╭ component  ╔ step  ▶ now  ▸ has detail', { dim: true })
  }
  add((S.busy ? '… ' : '') + S.note, { dim: true })
  if (S.map) {
    out.push({ buttons: nodeButtons(S.map.graph, act) })
    input('describe a change to the map')
  }
  rule()

  add(spread('◆ PINNED DIAGRAMS', S.pins.length ? `${S.pins.length} pinned` : '', w), { bold: true, color: 'magenta' })
  if (!S.pins.length) add('Mermaid or box diagrams Claude writes appear here.', { dim: true })
  S.pins.forEach((p, i) => {
    if (i) add('')
    const what = p.graph ? `flowchart, ${p.graph.nodes.length} boxes` : p.kind === 'mermaid' ? 'mermaid' : 'box diagram'
    const head = short(`${i + 1}. ${p.title || what} · turn ${p.turn}${p.edited ? ' · edited' : ''}`, w - 12)
    out.push({ lead: head, buttons: [{ key: 'pin:' + i, label: 'open ▸', onPress: () => act?.openPin(p.code) }] })
    if (p.graph) for (const l of drawGraph(marked(p.graph, false), w)) add(l)
    else {
      // Not a flowchart we can draw: show the code as written, dimmed for mermaid
      if (p.kind === 'mermaid') add('(raw mermaid: only flowcharts are drawn)', { dim: true })
      for (const l of p.code.split('\n')) add(l, { dim: p.kind === 'mermaid' })
    }
  })
  return out
}

// The pane as plain text: what tests and DIAGRAM_PANE_DUMP read
export function paneText(w = 60) {
  return paneItems(w, null).map(it => {
    if (it.input) return `> ${it.input.placeholder}`
    if (it.buttons) return [it.lead, ...it.buttons.map(b => (b.hotkey ? `${b.hotkey}: ${b.label}` : `[ ${b.label} ]`))].filter(Boolean).join('  ')
    return it.text
  }).join('\n')
}

function spread(left, right, w) {
  return right ? left + ' '.repeat(Math.max(1, w - left.length - right.length)) + right : left
}

// Ask for a redraw, and in tests also write the pane's text to a file
async function redraw($) {
  $.ui.invalidate('ui.render')
  const dump = await $.env.get('DIAGRAM_PANE_DUMP')
  if (dump) await $.fs.write(dump, paneText(60) + '\n')
}
