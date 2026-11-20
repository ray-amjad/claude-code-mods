import { expect, mock, test } from 'claude-code/testing'
import { parseMermaid } from '../hooks/draw.js'
import { adoptIds, applyOps, carrySubs, levelAt, setLevel, toMermaid } from '../hooks/graph.js'

const NESTED = `flowchart TD
  U[User] --> API
  subgraph API [API layer]
    R[Router] --> H[Handlers]
    subgraph DB [Storage]
      P[(Postgres)]
    end
    H --> P
  end
  H --> Q[Queue]`

test('a subgraph is one box with its contents inside', async () => {
  const g = parseMermaid(NESTED)!
  expect(g.nodes.map(n => n.id)).toEqual(['U', 'API', 'Q'])
  const api = g.nodes[1]
  expect(api.label).toBe('API layer')
  expect(api.sub.nodes.map(n => n.id)).toEqual(['R', 'H', 'DB'])
  expect(api.sub.nodes[2].sub.nodes.map(n => n.id)).toEqual(['P'])
})

test('edges across a subgraph border lift to the box on that level', async () => {
  const g = parseMermaid(NESTED)!
  expect(g.edges).toEqual([
    { from: 'U', to: 'API', label: '' },
    { from: 'API', to: 'Q', label: '' },
  ])
  expect(g.nodes[1].sub.edges).toEqual([
    { from: 'R', to: 'H', label: '' },
    { from: 'H', to: 'DB', label: '' },
  ])
})

test('toMermaid reads back as the same tree', async () => {
  const g = parseMermaid(NESTED)!
  expect(parseMermaid(toMermaid(g))).toEqual(g)
})

test('levelAt and setLevel follow a path of ids', async () => {
  const g = parseMermaid(NESTED)!
  expect(levelAt(g, ['API', 'DB']).graph!.nodes[0].label).toBe('Postgres')
  expect(levelAt(g, ['U']).node!.id).toBe('U')
  expect(levelAt(g, ['nope']).node).toBe(null)
  const out = setLevel(g, ['U'], { nodes: [{ id: 'x', label: 'Browser', box: 'single' }], edges: [] })
  expect(levelAt(out, ['U']).graph!.nodes[0].label).toBe('Browser')
  expect(levelAt(g, ['U']).graph).toBe(null) // the original is untouched
})

test('applyOps patches a level and says what changed', async () => {
  const g = parseMermaid('flowchart TD\n  a[A] --> b[B]')!
  const { graph, changes } = applyOps(g, [
    { op: 'add_node', id: 'c', label: 'Cache', kind: 'component' },
    { op: 'add_edge', from: 'b', to: 'c', label: 'reads' },
    { op: 'relabel', id: 'a', label: 'Client' },
    { op: 'remove_node', id: 'b' },
  ])
  expect(graph.nodes.map(n => [n.id, n.label, n.box])).toEqual([['a', 'Client', 'single'], ['c', 'Cache', 'round']])
  expect(graph.edges).toEqual([])
  expect(changes).toEqual(['added c', 'linked b → c', 'relabelled a', 'removed b and 2 edges'])
  expect(() => applyOps(g, [{ op: 'remove_node', id: 'zz' }])).toThrow('no node "zz"')
})

test('a detail with clashing ids gets them prefixed', async () => {
  const sub = { nodes: [{ id: 'a', label: 'x', box: 'single' }, { id: 'n', label: 'y', box: 'single' }], edges: [{ from: 'a', to: 'n', label: '' }] }
  const out = adoptIds(sub, new Set(['a', 'b']), 'b')
  expect(out.nodes.map(n => n.id)).toEqual(['b_a', 'n'])
  expect(out.edges[0]).toEqual({ from: 'b_a', to: 'n', label: '' })
})

test('carrySubs keeps details on surviving boxes', async () => {
  const before = parseMermaid(NESTED)!
  const after = parseMermaid('flowchart TD\n  API[API] --> Z[New]')!
  expect(carrySubs(before, after).nodes[0].sub.nodes.length).toBe(3)
  expect(carrySubs(before, after, { sameLabel: true }).nodes[0].sub).toBe(undefined)
})

// ---------------------------------------------------------------------------
// Claude's tools, through the engine
// ---------------------------------------------------------------------------

const REPLY = 'Here is the flow:\n\n```mermaid\nflowchart TD\n  A[Cart] --> B[Pay]\n```\n'

function world(on: any) {
  mock.store(on)
  mock.env(on, {})
  mock.clock(on)
  on('session.id', () => ({ value: 's1' }))
  on('ui.panes', () => ({ value: [{ id: 'diagrams', title: 'Diagrams', isPlaced: true }] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'explain checkout', toolUses: [] },
      { role: 'assistant', text: REPLY, toolUses: [] },
    ],
  }))
}

type Answer = { deny?: string; result?: unknown }
const call = async ($: any, input: Record<string, unknown>) => (await $.tool.call(input as never)) as Answer

test('diagram_set changes a pin, goes into a box, and diagram_get reads it back', async ($, on) => {
  world(on)
  const got = String((await call($, { tool: 'mcp__diagram-pane__diagram_get' })).result)
  expect(got).toContain('## pin:1: "Here is the flow"')
  expect(got).toContain('A["Cart"]')
  expect(got).toContain('A --> B')

  const set = await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'pin:1', ops: [{ op: 'add_node', id: 'C', label: 'Receipt' }, { op: 'add_edge', from: 'B', to: 'C' }] })
  expect(set.deny).toBe(undefined)
  expect(String(set.result)).toContain('added C, linked B → C')

  // A detail inside B, written as mermaid; its A clashes with the top level's A
  const inner = await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'pin:1', path: ['B'], mermaid: 'flowchart TD\n  A[Card] --> V[Verify]' })
  expect(String(inner.result)).toContain('B_A["Card"]')

  const after = String((await call($, { tool: 'mcp__diagram-pane__diagram_get' })).result)
  expect(after).toContain('The pane shows: Here is the flow › Pay')
  expect(after).toContain('subgraph B["Pay"]')
  expect(after).toContain('edited')

  const bad = await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'pin:9', mermaid: 'flowchart TD\n a' })
  expect(bad.deny).toContain('no pin:9')
})

test('diagram_set draws a map when there is none', async ($, on) => {
  world(on)
  const r = await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: 'flowchart TD\n  s[stack.tf] --> v[vpc.tf]', title: 'infra' })
  expect(r.deny).toBe(undefined)
  const got = String((await call($, { tool: 'mcp__diagram-pane__diagram_get' })).result)
  expect(got).toContain('## map: "infra"')
  expect(got).toContain('s["stack.tf"]')
  expect(got).toContain('s --> v')
})

// ---------------------------------------------------------------------------
// The pane: going into a box, back out, and a typed change
// ---------------------------------------------------------------------------

const MAP = `flowchart TD
  web[web.tf] --> net
  subgraph net [network.tf]
    vpc[VPC] --> sub[Subnets]
  end`

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane opens a box, goes back, and takes a typed change (${surface})`, async ($, on) => {
    world(on)
    on('model.fork', () => ({ value: { isAnswered: true, text: '```mermaid\nflowchart TD\n  vpc[VPC] --> sub[Subnets]\n  sub --> nat[NAT gateway]\n```', usage: USAGE } }) as never)
    await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: MAP, title: 'infra' })
    const ui = await $.ui.mount({
      plugin: 'diagram-pane', surface, component: 'Pane', requestId: 'diagrams',
      props: { title: 'Diagrams', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
    })
    expect((await ui.find({ key: 'node:net' }))?.text).toContain('network.tf ▸')

    await ui.press({ key: 'node:net' } as never)
    expect(await ui.find({ type: 'Text', text: /Work map › network\.tf/ } as never)).toBeDefined()
    expect(await ui.find({ key: 'node:vpc' })).toBeDefined()

    await ui.input({ key: 'edit-map-net', text: 'add a NAT gateway' } as never)
    expect(await ui.find({ key: 'node:nat' })).toBeDefined()
    const got = String((await call($, { tool: 'mcp__diagram-pane__diagram_get' })).result)
    expect(got).toContain('nat["NAT gateway"]')
    expect(got).toContain('edited')

    await ui.press({ key: 'back' } as never)
    expect(await ui.find({ type: 'Text', text: /LIVE WORK MAP/ } as never)).toBeDefined()
  })
}

test('a box with no detail gets one from a fork, kept on the map', async ($, on) => {
  world(on)
  const detail = { title: 'web', nodes: [{ id: 'web', label: 'ALB', kind: 'component' }, { id: 'tg', label: 'Target group', kind: 'component' }], edges: [{ from: 'web', to: 'tg' }] }
  on('model.fork', () => ({ value: { isAnswered: true, text: JSON.stringify(detail), usage: USAGE } }) as never)
  await call($, { tool: 'mcp__diagram-pane__diagram_set', target: 'map', mermaid: MAP, title: 'infra' })
  const ui = await $.ui.mount({
    plugin: 'diagram-pane', surface: 'terminal', component: 'Pane', requestId: 'diagrams',
    props: { title: 'Diagrams', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'node:web' } as never)
  // The detail's "web" clashes with the box it sits in, so it is renamed
  expect(await ui.find({ key: 'node:web_web' })).toBeDefined()
  const got = String((await call($, { tool: 'mcp__diagram-pane__diagram_get' })).result)
  expect(got).toContain('subgraph web["web.tf"]')
  expect(got).toContain('web_web --> tg')
})

test('adoptIds keeps a parent edge on its own level when a node inside has the same name', async () => {
  const level = {
    nodes: [
      { id: 'X', label: 'X', kind: 'service' },
      { id: 'Box', label: 'Box', kind: 'service', sub: { nodes: [{ id: 'X', label: 'inner X', kind: 'service' }], edges: [] } },
    ],
    edges: [{ from: 'X', to: 'Box', label: '' }],
  } as any
  const out = adoptIds(level, new Set(['Other']), 'p')
  const top = out.nodes.map((n: any) => n.id)
  expect(top).toContain(out.edges[0].from)
  expect(out.nodes[1].sub.nodes[0].id).not.toBe(out.nodes[0].id)
})

test('diagram_set ops find a node by the name add_node was given', async () => {
  const { graph } = applyOps({ nodes: [], edges: [] }, [
    { op: 'add_node', id: 'my node', label: 'My node', kind: 'service' },
    { op: 'add_node', id: 'db', label: 'DB', kind: 'service' },
    { op: 'add_edge', from: 'my node', to: 'db' },
    { op: 'relabel', id: 'my node', label: 'Renamed' },
  ] as any)
  expect(graph.nodes.map((n: any) => n.id)).toEqual(['my_node', 'db'])
  expect(graph.nodes[0].label).toBe('Renamed')
  expect(graph.edges).toEqual([expect.objectContaining({ from: 'my_node', to: 'db' })])
})
