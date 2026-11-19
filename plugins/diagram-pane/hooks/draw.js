// draw.js: turns diagrams into lines of terminal text. No $ here, just strings.
//
//   findDiagrams(markdown)   -> the mermaid and ASCII diagrams in a reply
//   parseMermaid(code)       -> { nodes, edges } for a flowchart, or null
//   drawGraph(graph, width)  -> lines of box-and-arrow text, top to bottom

// ---------------------------------------------------------------------------
// 1. Find diagrams in a reply
// ---------------------------------------------------------------------------

const CORNERS = /[┌┐└┘╭╮╰╯╔╗╚╝]|\+[-=]{3,}/
const ARROWS = /(--+>|──+[>▶]|→|▶|▼|↓|\^)/
const PLAIN = ['', 'text', 'txt', 'ascii', 'plain', 'diagram', 'art']

// Returns [{ kind: 'mermaid' | 'ascii', code, title }] in reply order
export function findDiagrams(markdown) {
  const found = []
  const fence = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g
  let m
  while ((m = fence.exec(markdown))) {
    const lang = m[1].toLowerCase()
    const code = m[2].replace(/\s+$/, '')
    const title = titleBefore(markdown.slice(0, m.index))
    if (lang === 'mermaid') found.push({ kind: 'mermaid', code, title })
    else if (PLAIN.includes(lang) && looksLikeBoxes(code)) found.push({ kind: 'ascii', code, title })
  }
  return found
}

// An ASCII diagram has box corners, or several lines of arrows
function looksLikeBoxes(code) {
  const lines = code.split('\n')
  const corners = lines.filter(l => CORNERS.test(l)).length
  const arrows = lines.filter(l => ARROWS.test(l)).length
  return corners >= 2 || (arrows >= 2 && lines.length <= 40)
}

// A heading, or a line ending in ':', just before the diagram makes a good title
function titleBefore(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).reverse()
  const pick = lines.find(l => /^#+\s/.test(l) || /:\**$/.test(l))
  if (!pick || pick.startsWith('```')) return ''
  return pick.replace(/^#+\s*/, '').replace(/^[-*\d.]+\s+/, '').replace(/[*_`]/g, '').replace(/:$/, '').slice(0, 60)
}

// ---------------------------------------------------------------------------
// 2. Parse a mermaid flowchart into nodes and edges
// ---------------------------------------------------------------------------

// Shape openers, longest first, with their closer and the box we draw for them
const SHAPES = [
  ['([', '])', 'round'], ['[[', ']]', 'single'], ['[(', ')]', 'round'], ['((', '))', 'round'],
  ['{{', '}}', 'double'], ['[/', '/]', 'single'], ['[\\', '\\]', 'single'], ['>', ']', 'single'],
  ['[', ']', 'single'], ['(', ')', 'round'], ['{', '}', 'double'],
]
// Edge operators: an optional label in the middle (-- yes -->) or in pipes (-->|yes|)
const EDGE_MID = /^\s*(?:<)?(?:--|-\.|==)\s+([^|>]+?)\s+(?:-->|--[ox]|---|\.->|-\.-|==>|===)/
const EDGE = /^\s*(?:<)?(?:-\.+->|-\.+-|--+>|--+[ox]|---+|==+>|===+|~~~)(?:\|([^|]*)\|)?/
const SKIP = /^(classDef|class|style|linkStyle|click|direction|%%|accTitle|accDescr)\b/

// A subgraph becomes a node whose `sub` is its contents, so the pane shows it
// as one box and can go into it. Edges that cross a subgraph's border are drawn
// to the subgraph's box on the level where both ends are visible.
export function parseMermaid(code) {
  const stmts = code.split(/[\n;]/).map(l => l.trim()).filter(Boolean)
  if (!/^(graph|flowchart)\b/i.test(stmts[0] || '')) return null
  const nodes = new Map()
  const edges = []
  const stack = []
  for (const stmt of stmts.slice(1)) {
    if (/^subgraph\b/.test(stmt)) {
      const g = readSubgraph(stmt.slice(8).trim())
      const known = nodes.get(g.id)
      if (known) Object.assign(known, { label: g.label, box: 'round', group: true, parent: stack.at(-1) ?? null })
      else nodes.set(g.id, { id: g.id, label: g.label, box: 'round', group: true, parent: stack.at(-1) ?? null })
      stack.push(g.id)
    } else if (/^end$/.test(stmt)) stack.pop()
    else if (!SKIP.test(stmt)) parseStatement(stmt, nodes, edges, stack.at(-1) ?? null)
  }
  if (!nodes.size) return null
  return nest(nodes, edges, null)
}

// `subgraph id`, `subgraph id [Label]`, `subgraph "Label"` or `subgraph Some label`
function readSubgraph(rest) {
  // A quoted label may hold brackets: `subgraph S["arr[0] store"]`
  const m = rest.match(/^(\w+)\s*\[\s*"([^"]*)"\s*\]$/) || rest.match(/^(\w+)\s*\[\s*([^\]"]*)\s*\]$/)
  if (m) return { id: m[1], label: clean(m[2]) || m[1] }
  const label = clean(rest) || 'group'
  return { id: /^\w+$/.test(rest) ? rest : label.replace(/\W+/g, '_'), label }
}

// The level of the tree under `parent`: its own nodes, and the edges between them
// after lifting each end to the ancestor that sits on this level
function nest(flat, edges, parent) {
  const parentOf = id => flat.get(id)?.parent ?? null
  const onLevel = id => {
    let cur = id
    for (let hops = 0; cur != null && parentOf(cur) !== parent && hops < 50; hops++) cur = parentOf(cur)
    return cur != null && parentOf(cur) === parent ? cur : null
  }
  const nodes = []
  for (const n of flat.values()) {
    if ((n.parent ?? null) !== parent) continue
    const node = { id: n.id, label: n.label, box: n.box }
    if (n.group) {
      const sub = nest(flat, edges, n.id)
      if (sub.nodes.length) node.sub = sub
    }
    nodes.push(node)
  }
  const out = []
  const seen = new Set()
  for (const e of edges) {
    const from = onLevel(e.from), to = onLevel(e.to)
    if (!from || !to || from === to) continue
    const key = `${from}>${to}>${e.label}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from, to, label: e.label })
  }
  return { nodes, edges: out }
}

// A statement is: group (edge group)*, where a group is node (& node)*.
// A node mentioned inside a subgraph belongs to it, as in mermaid.
function parseStatement(stmt, nodes, edges, parent) {
  let rest = stmt
  let prev = null
  while (rest.trim()) {
    const group = []
    for (;;) {
      const n = readNode(rest)
      if (!n) return
      rest = n.rest
      const known = nodes.get(n.id)
      if (!known) nodes.set(n.id, { id: n.id, label: n.label || n.id, box: n.box || 'single', parent })
      else {
        if (n.label && !known.group) Object.assign(known, { label: n.label, box: n.box })
        // Declared first, linked later: a node moves into a deeper subgraph, never out of one.
        // A subgraph stays where it was declared: moving it could nest it inside itself.
        if (parent && !known.group && known.id !== parent && within(nodes, parent, known.parent)) known.parent = parent
      }
      group.push(n.id)
      const amp = rest.match(/^\s*&\s*/)
      if (!amp) break
      rest = rest.slice(amp[0].length)
    }
    if (prev) for (const from of prev.ids) for (const to of group) edges.push({ from, to, label: prev.label })
    const e = rest.match(EDGE_MID) || rest.match(EDGE)
    if (!e) return
    prev = { ids: group, label: clean(e[1] || '') }
    rest = rest.slice(e[0].length)
  }
}

// Is subgraph `inner` inside `outer` (or is `outer` the top level)?
function within(nodes, inner, outer) {
  if (outer == null) return true
  for (let cur = nodes.get(inner)?.parent, hops = 0; cur != null && hops < 50; cur = nodes.get(cur)?.parent, hops++) {
    if (cur === outer) return true
  }
  return false
}

function readNode(text) {
  const m = text.match(/^\s*([\w]+)/)
  if (!m) return null
  let rest = text.slice(m[0].length)
  for (const [open, close, box] of SHAPES) {
    if (!rest.startsWith(open)) continue
    let body = rest.slice(open.length)
    let label
    const quoted = body.match(/^\s*"([^"]*)"\s*/)
    if (quoted) { label = quoted[1]; body = body.slice(quoted[0].length) }
    const end = body.indexOf(close)
    if (end < 0) return null
    if (label === undefined) label = body.slice(0, end)
    return { id: m[1], label: clean(label), box, rest: body.slice(end + close.length) }
  }
  return { id: m[1], label: '', box: '', rest }
}

function clean(s) {
  return s.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

// ---------------------------------------------------------------------------
// 3. Draw a graph as boxes and arrows, top to bottom, in `width` columns
// ---------------------------------------------------------------------------

const BOX = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', out: '┬' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', out: '┬' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', out: '╤' },
}
// A connector cell remembers which way its lines go: up, down, left, right
const U = 1, D = 2, L = 4, R = 8
const JOIN = { [U | D]: '│', [L | R]: '─', [D | R]: '┌', [D | L]: '┐', [U | R]: '└', [U | L]: '┘',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴', [U | D | L | R]: '┼',
  [U]: '│', [D]: '│', [L]: '─', [R]: '─' }

// graph: { nodes: [{ id, label, box }], edges: [{ from, to, label }] }
export function drawGraph(graph, width) {
  const nodes = graph.nodes
  const ids = new Set(nodes.map(n => n.id))
  const edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
  const layer = layers(nodes, edges)
  const rows = displayRows(nodes, edges, layer, width)

  const place = new Map()
  let y = 0
  const routed = new Set()
  const gaps = []
  rows.forEach((row, r) => {
    // Labels get 22 columns when the row has room, else 16 (what displayRows packed for)
    const roomy = row.reduce((s, n) => s + Math.min(longest(n.label), 22) + 6, -2) <= width
    const boxes = row.map(n => ({ n, lines: wrap(n.label, roomy ? 22 : 16) }))
    boxes.forEach(b => { b.w = Math.max(...b.lines.map(l => l.length)) + 4; b.h = b.lines.length + 2 })
    const total = boxes.reduce((s, b) => s + b.w, 0) + (boxes.length - 1) * 2
    let x = Math.max(0, Math.floor((width - total) / 2))
    for (const b of boxes) { place.set(b.n.id, { ...b, x, y, row: r, cx: x + Math.floor(b.w / 2) }); x += b.w + 2 }
    y += Math.max(...boxes.map(b => b.h))
    // Edges from this row straight to the next one get a 3-line gap to run in
    const next = new Set((rows[r + 1] || []).map(n => n.id))
    const down = edges.filter(e => row.some(n => n.id === e.from) && next.has(e.to))
    down.forEach(e => routed.add(e))
    if (r < rows.length - 1) { gaps.push({ y, edges: down }); y += down.length ? 3 : 1 }
  })

  // Paint onto a grid: boxes as characters, connectors as direction bits
  const grid = Array.from({ length: y }, () => Array.from({ length: width }, () => ({ ch: ' ', bits: 0 })))
  const put = (gy, gx, ch) => { if (grid[gy]?.[gx]) grid[gy][gx].ch = ch }
  const bit = (gy, gx, b) => { if (grid[gy]?.[gx]) grid[gy][gx].bits |= b }
  for (const p of place.values()) {
    const s = BOX[p.n.box] || BOX.single
    put(p.y, p.x, s.tl); put(p.y, p.x + p.w - 1, s.tr)
    put(p.y + p.h - 1, p.x, s.bl); put(p.y + p.h - 1, p.x + p.w - 1, s.br)
    for (let i = 1; i < p.w - 1; i++) { put(p.y, p.x + i, s.h); put(p.y + p.h - 1, p.x + i, s.h) }
    p.lines.forEach((line, i) => {
      put(p.y + 1 + i, p.x, s.v); put(p.y + 1 + i, p.x + p.w - 1, s.v)
      ;[...line.padEnd(p.w - 4)].forEach((c, j) => put(p.y + 1 + i, p.x + 2 + j, c))
    })
  }
  const labels = []
  for (const g of gaps) {
    for (const e of g.edges) {
      const a = place.get(e.from), b = place.get(e.to)
      const s = BOX[a.n.box] || BOX.single
      // Enter straight down when the source sits above the target, else at its centre
      const tx = a.cx > b.x + 1 && a.cx < b.x + b.w - 2 ? a.cx : b.cx
      put(a.y + a.h - 1, a.cx, s.out)
      for (let y = a.y + a.h; y <= g.y; y++) bit(y, a.cx, U | D) // down past shorter boxes
      bit(g.y + 1, a.cx, U)                   // turn onto the bus row
      for (let x = Math.min(a.cx, tx); x < Math.max(a.cx, tx); x++) { bit(g.y + 1, x, R); bit(g.y + 1, x + 1, L) }
      bit(g.y + 1, tx, D)
      put(g.y + 2, tx, '▼')
      if (e.label) labels.push({ e, y: g.y + 2, x: tx + 1 })
    }
  }
  // Labels go beside their arrow once every arrow is down, so none covers another
  const notes = []
  for (const { e, y, x } of labels) {
    const text = ' ' + short(e.label, 14) + ' '
    const free = [...text].every((_, j) => grid[y][x + j] && grid[y][x + j].ch === ' ')
    if (free) [...text.trimEnd()].forEach((c, j) => put(y, x + j, c))
    else notes.push(e)
  }
  const out = grid.map(row => row.map(c => (c.ch === ' ' && c.bits ? JOIN[c.bits] : c.ch)).join('').trimEnd())

  // Edges we could not route straight down are listed under the drawing
  const label = id => short(nodes.find(n => n.id === id).label, 18)
  for (const e of edges) if (!routed.has(e) || notes.includes(e)) {
    const back = layer.get(e.to) <= layer.get(e.from)
    out.push(short(`  ${back ? '↺' : '⇢'} ${label(e.from)} → ${label(e.to)}${e.label ? '  (' + e.label + ')' : ''}`, width))
  }
  return out
}

// Longest-path layers, after dropping the edges that close a cycle
function layers(nodes, edges) {
  const state = new Map()
  const forward = []
  const visit = id => {
    state.set(id, 1)
    for (const e of edges.filter(e => e.from === id)) {
      if (state.get(e.to) === 1) continue // a back edge: skip it for layering
      forward.push(e)
      if (!state.get(e.to)) visit(e.to)
    }
    state.set(id, 2)
  }
  nodes.forEach(n => { if (!state.get(n.id)) visit(n.id) })
  const layer = new Map(nodes.map(n => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false
    for (const e of forward) if (layer.get(e.to) < layer.get(e.from) + 1) { layer.set(e.to, layer.get(e.from) + 1); moved = true }
    if (!moved) break
  }
  return layer
}

// Group nodes by layer, order each layer under its parents, and split a layer
// that is too wide for the pane into several rows
function displayRows(nodes, edges, layer, width) {
  const depth = Math.max(...layer.values())
  const pos = new Map()
  const rows = []
  for (let d = 0; d <= depth; d++) {
    const these = nodes.filter(n => layer.get(n.id) === d)
    const centre = n => {
      const ps = edges.filter(e => e.to === n.id && pos.has(e.from)).map(e => pos.get(e.from))
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : nodes.indexOf(n)
    }
    these.sort((a, b) => centre(a) - centre(b))
    these.forEach((n, i) => pos.set(n.id, i))
    let row = [], used = 0
    for (const n of these) {
      const w = Math.min(longest(n.label), 16) + 4 + (row.length ? 2 : 0)
      if (row.length && used + w > width) { rows.push(row); row = [], used = 0 }
      row.push(n); used += w
    }
    if (row.length) rows.push(row)
  }
  return rows
}

// Word-wrap a label into at most 3 lines of `w` columns
function wrap(text, w) {
  const lines = []
  // A <br> in a mermaid label is a line break we keep
  for (const part of String(text).split('\n')) {
    let cur = ''
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const piece = word.length > w ? word.slice(0, w - 1) + '…' : word
      if (!cur) cur = piece
      else if ((cur + ' ' + piece).length <= w) cur += ' ' + piece
      else { lines.push(cur); cur = piece }
    }
    if (cur) lines.push(cur)
  }
  if (lines.length > 3) { lines.length = 3; lines[2] = short(lines[2] + ' …', w) }
  return lines.length ? lines : ['?']
}

export function short(s, n) {
  s = String(s).replace(/\n/g, ' ')
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'
}

const longest = label => Math.max(...String(label).split('\n').map(l => l.length))
