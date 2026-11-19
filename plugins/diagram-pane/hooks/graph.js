// graph.js: the graph tree the pane navigates and edits. No $ here, just data.
//
// A graph is { nodes: [{ id, label, box, now?, sub? }], edges: [{ from, to, label }] }.
// A node's `sub` is its detail: another graph, one level down.
//
//   levelAt(root, path)            -> the graph a path of node ids leads to
//   setLevel(root, path, level)    -> a copy of root with that level replaced
//   applyOps(graph, ops)           -> a patched copy, and what changed
//   uniqueIds(root)                -> a copy where no id appears twice in the tree
//   toMermaid(graph)               -> flowchart source, details as subgraphs

const KIND_BOX = { file: 'single', component: 'round', step: 'double' }

export const clone = g => JSON.parse(JSON.stringify(g))

export const KINDS = Object.keys(KIND_BOX)
export const boxOf = kind => KIND_BOX[kind] || 'single'

// Mermaid ids are words; anything else becomes `_`
export const cleanId = id => String(id).replace(/\W/g, '_') || '_'

// Follow `path` down through each node's `sub`. Returns { graph } when the path
// ends on a level, { graph: null, node } when the last node has no detail yet,
// and { graph: null, node: null } when a node on the path is gone.
export function levelAt(root, path) {
  let g = root
  for (const id of path) {
    const n = g?.nodes.find(n => n.id === id)
    if (!n) return { graph: null, node: null }
    if (!n.sub) return { graph: null, node: n }
    g = n.sub
  }
  return { graph: g, node: null }
}

// A copy of `root` with the level at `path` replaced; the last node on the path
// gets `level` as its detail, created when it had none.
export function setLevel(root, path, level) {
  if (!path.length) return clone(level)
  const out = clone(root)
  let g = out
  path.forEach((id, i) => {
    const n = g.nodes.find(n => n.id === id)
    if (!n) throw new Error(`no node "${id}" on the path`)
    if (i === path.length - 1) n.sub = clone(level)
    else if (!n.sub) throw new Error(`node "${id}" has no detail to go into`)
    else g = n.sub
  })
  return out
}

export function allIds(g, out = new Set()) {
  for (const n of g?.nodes || []) {
    out.add(n.id)
    if (n.sub) allIds(n.sub, out)
  }
  return out
}

// Gives each node of one level (not its subs) an id not in `taken`: a clash
// becomes `base(id)`, then `base(id)2`, `3` ... The level's edges follow.
function renameClashes(g, taken, base) {
  const rename = new Map()
  for (const n of g.nodes) {
    if (taken.has(n.id)) {
      const first = base(n.id)
      let id = first
      for (let i = 2; taken.has(id); i++) id = `${first}${i}`
      rename.set(n.id, id)
      n.id = id
    }
    taken.add(n.id)
  }
  for (const e of g.edges) {
    e.from = rename.get(e.from) || e.from
    e.to = rename.get(e.to) || e.to
  }
}

// Mermaid ids are global, so a detail's ids must not clash with the rest of the
// tree: clashing ones get `prefix_` in front. `taken` is the rest of the tree's ids.
export function adoptIds(level, taken, prefix) {
  const out = clone(level)
  const walk = g => {
    renameClashes(g, taken, id => `${cleanId(prefix)}_${id}`)
    for (const n of g.nodes) if (n.sub) walk(n.sub)
  }
  walk(out)
  return out
}

// Mermaid ids are global, so one id may appear only once in the whole tree.
// Levels are walked top first, so a box on a higher level keeps its id and a
// clashing one further down gets its parent's id in front.
export function uniqueIds(root) {
  const out = clone(root)
  const taken = new Set()
  let level = [{ g: out, prefix: null }]
  while (level.length) {
    const below = []
    for (const { g, prefix } of level) {
      renameClashes(g, taken, id => (prefix ? `${cleanId(prefix)}_${id}` : id))
      for (const n of g.nodes) if (n.sub) below.push({ g: n.sub, prefix: n.id })
    }
    level = below
  }
  return out
}

// Keep the details of nodes that survive a redraw. A node survives on the same
// id; with `sameLabel` it must keep its label too (a fork may reuse ids).
export function carrySubs(before, after, { sameLabel = false } = {}) {
  const out = clone(after)
  for (const n of out.nodes) {
    const old = before?.nodes.find(o => o.id === n.id && (!sameLabel || o.label === n.label))
    if (old?.sub && !n.sub) n.sub = clone(old.sub)
  }
  return out
}

export const OPS = ['add_node', 'remove_node', 'relabel', 'set_kind', 'add_edge', 'remove_edge']

// Patch a graph. ops: [{ op, id, label, kind, from, to }], op one of OPS.
// Returns { graph, changes }; throws on an op it cannot apply.
export function applyOps(graph, ops) {
  const g = clone(graph || { nodes: [], edges: [] })
  const changes = []
  const find = id => {
    const n = g.nodes.find(n => n.id === id)
    if (!n) throw new Error(`no node "${id}" (ids: ${g.nodes.map(n => n.id).join(', ') || 'none'})`)
    return n
  }
  for (const o of ops || []) {
    switch (o.op) {
      case 'add_node': {
        const id = cleanId(o.id || o.label)
        if (g.nodes.some(n => n.id === id)) throw new Error(`node "${id}" already exists`)
        g.nodes.push({ id, label: String(o.label || id), box: boxOf(o.kind) })
        changes.push(`added ${id}`)
        break
      }
      case 'remove_node': {
        const n = find(o.id)
        g.nodes = g.nodes.filter(x => x !== n)
        const gone = g.edges.filter(e => e.from === n.id || e.to === n.id).length
        g.edges = g.edges.filter(e => e.from !== n.id && e.to !== n.id)
        changes.push(`removed ${n.id}` + (gone ? ` and ${gone} edge${gone > 1 ? 's' : ''}` : ''))
        break
      }
      case 'relabel': {
        const n = find(o.id)
        n.label = String(o.label ?? n.label)
        changes.push(`relabelled ${n.id}`)
        break
      }
      case 'set_kind': {
        find(o.id).box = boxOf(o.kind)
        changes.push(`${o.id} is now a ${o.kind}`)
        break
      }
      case 'add_edge': {
        find(o.from), find(o.to)
        g.edges.push({ from: o.from, to: o.to, label: String(o.label || '') })
        changes.push(`linked ${o.from} → ${o.to}`)
        break
      }
      case 'remove_edge': {
        const before = g.edges.length
        g.edges = g.edges.filter(e => !(e.from === o.from && e.to === o.to))
        if (g.edges.length === before) throw new Error(`no edge ${o.from} → ${o.to}`)
        changes.push(`unlinked ${o.from} → ${o.to}`)
        break
      }
      default:
        throw new Error(`unknown op "${o.op}"`)
    }
  }
  return { graph: g, changes }
}

// Flowchart source for a graph; a node with a detail becomes a subgraph, so
// parseMermaid reads the whole tree back
export function toMermaid(graph) {
  return ['flowchart TD', ...body(graph, '  ')].join('\n')
}

function body(g, pad) {
  const out = []
  for (const n of g.nodes) {
    if (n.sub?.nodes.length) {
      out.push(`${pad}subgraph ${n.id}["${quote(n.label)}"]`, ...body(n.sub, pad + '  '), `${pad}end`)
    } else {
      const [open, close] = { round: ['("', '")'], double: ['{"', '"}'] }[n.box] || ['["', '"]']
      out.push(`${pad}${n.id}${open}${quote(n.label)}${close}`)
    }
  }
  for (const e of g.edges) out.push(`${pad}${e.from} -->${e.label ? `|${quote(e.label)}|` : ''} ${e.to}`)
  return out
}

const quote = s => String(s).replace(/"/g, "'").replace(/\|/g, '/').replace(/\n/g, '<br>')
