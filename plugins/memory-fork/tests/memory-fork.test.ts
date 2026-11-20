import { expect, mock, test } from 'claude-code/testing'

import { diff, isInside, lastExchange, lineDiff, parseOps, removeCommand, totals } from '../hooks/register'

test('diff names added, updated and deleted memories with their line counts', async () => {
  const before = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\ntwo\nthree\n'], ['c.md', 'gone\nalso gone\n']])
  const after = new Map([['a.md', 'one\ntwo\n'], ['b.md', 'one\n2\nthree\nfour\n'], ['d.md', 'new\n']])

  expect(diff(before, after)).toEqual([
    { name: 'b.md', kind: 'updated', added: 2, removed: 1 },
    { name: 'd.md', kind: 'added', added: 1, removed: 0 },
    { name: 'c.md', kind: 'deleted', added: 0, removed: 2 },
  ])
  expect(totals(diff(before, after))).toEqual({ added: 3, removed: 3 })
})

test('lineDiff counts a moved line as one removed and one added', async () => {
  expect(lineDiff('a\nb\nc', 'b\nc\na')).toEqual({ added: 1, removed: 1 })
  expect(lineDiff('', '')).toEqual({ added: 0, removed: 0 })
  expect(lineDiff('same\n', 'same')).toEqual({ added: 0, removed: 0 })
})

test('lastExchange starts at the latest typed prompt', async () => {
  const text = lastExchange([
    { role: 'user', text: 'old prompt', toolUses: [] },
    { role: 'assistant', text: 'old answer', toolUses: [] },
    { role: 'user', text: 'remember I prefer bun', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't', text: 'x', isError: false } as never] },
    { role: 'assistant', text: 'Noted.', toolUses: [] },
  ])

  expect(text).toBe('USER: remember I prefer bun\nTOOL: Read\nASSISTANT: Noted.')
})

test('the main session may not write the memory folder', async ($, on) => {
  mock.env(on, { HOME: '/home/r' })
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('tool.call', () => ({ result: 'written' }) as never)

  const blocked = await $.tool.call({ tool: 'Write', file_path: '/home/r/.claude/projects/-w-proj/memory/x.md', content: 'x' })
  const allowed = await $.tool.call({ tool: 'Write', file_path: '/w/proj/x.md', content: 'x' })

  expect(blocked.deny ?? blocked.text).toContain('memory-fork')
  expect(allowed.deny).toBeUndefined()
})

test('MultiEdit and NotebookEdit into the memory folder are blocked too', async ($, on) => {
  mock.env(on, { HOME: '/home/r' })
  on('session.cwd', () => ({ value: '/w/proj' }))
  on('tool.call', () => ({ result: 'written' }) as never)

  const multi = await $.tool.call({ tool: 'MultiEdit', file_path: '/home/r/.claude/projects/-w-proj/memory/x.md', edits: [] } as never)
  const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/home/r/.claude/projects/-w-proj/memory/x.ipynb', new_source: 'x' } as never)
  const allowed = await $.tool.call({ tool: 'MultiEdit', file_path: '/w/proj/x.md', edits: [] } as never)

  expect(multi.deny ?? multi.text).toContain('memory-fork')
  expect(notebook.deny ?? notebook.text).toContain('memory-fork')
  expect(allowed.deny).toBeUndefined()
})

test('parseOps keeps bare memory names and never deletes the index', async () => {
  const ops = parseOps(`Here: {"write": [{"name": "a.md", "content": "x"}, {"name": "../evil.md", "content": "x"}, {"name": "b.txt", "content": "x"}], "delete": ["MEMORY.md", "c.md", "/etc/d.md"]}`)

  expect(ops).toEqual({ write: [{ name: 'a.md', content: 'x' }], delete: ['c.md'] })
})

test('on Windows the memory folder comes from USERPROFILE, and a backslash path is still blocked', async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:\\Users\\User' })
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('tool.call', () => ({ result: 'written' }) as never)

  const blocked = await $.tool.call({ tool: 'Write', file_path: 'C:\\Users\\User\\.claude\\projects\\C--proj\\memory\\x.md', content: 'x' })
  const allowed = await $.tool.call({ tool: 'Write', file_path: 'C:\\proj\\x.md', content: 'x' })

  expect(blocked.deny ?? blocked.text).toContain('memory-fork')
  expect(allowed.deny).toBeUndefined()
})

test('isInside takes / or \\ on Windows, and only / elsewhere', async () => {
  const win = 'C:\\Users\\User/.claude/projects/C--proj/memory'
  expect(isInside('C:\\Users\\User\\.claude\\projects\\C--proj\\memory\\a.md', win)).toBe(true)
  expect(isInside('c:/users/user/.claude/projects/C--proj/memory/a.md', win)).toBe(true)
  expect(isInside('C:\\Users\\User\\.claude\\projects\\C--proj\\memory-old\\a.md', win)).toBe(false)
  expect(isInside('/home/r/.claude/projects/-w/memory/a.md', '/home/r/.claude/projects/-w/memory')).toBe(true)
  expect(isInside('/home/r/.claude/projects/-w/memoryx/a.md', '/home/r/.claude/projects/-w/memory')).toBe(false)
})

test('isInside normalises a share path too', async () => {
  expect(isInside('\\\\srv\\share\\.claude\\projects\\p\\memory\\a.md', '//srv/share/.claude/projects/p/memory')).toBe(true)
  expect(isInside('C:\\Users\\U\\.claude\\projects\\p\\memory\\a.md', 'C:/Users/U/.claude/projects/p/memory')).toBe(true)
})

test('rm deletes on Mac and Linux; PowerShell on Windows, with the paths in an env var', async () => {
  expect(removeCommand(false, ['/m/a.md', '/m/b c.md'])).toEqual([['rm', '-f', '/m/a.md', '/m/b c.md'], {}])
  const paths = ['C:\\m\\a.md', "C:\\m\\b c'; x.md"]
  const [argv, init] = removeCommand(true, paths)
  expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  for (const p of paths) expect(argv[4]).not.toContain(p)
  expect(init).toEqual({ env: { MEMORY_FORK_PATHS: paths.join('\n') } })
})
