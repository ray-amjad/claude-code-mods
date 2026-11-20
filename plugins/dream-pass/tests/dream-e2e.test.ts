import { expect, mock, test } from 'claude-code/testing'

// /dream end to end over an in-memory folder, with a stubbed fork reply
const memo = (d: string) => `---\nname: x\ndescription: ${d}\nmetadata:\n  type: feedback\n---\nbody\n`

// An in-memory folder behind $.fs and the rm the mod runs
function folder(on: any, files: Record<string, string>) {
  const fs = new Map(Object.entries(files))
  const under = (dir: string) => [...fs.keys()].filter((p) => p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/'))
  on('fs.exists', (_$: unknown, e: any) => ({ value: fs.has(e.path) || [...fs.keys()].some((p) => p.startsWith(e.path + '/')) }))
  on('fs.list', (_$: unknown, e: any) => ({ value: under(e.path).map((p) => ({ name: p.slice(e.path.length + 1), kind: 'file', mtimeMs: 0, size: fs.get(p)!.length })) }))
  on('fs.read', (_$: unknown, e: any) => { if (!fs.has(e.path)) throw new Error('ENOENT ' + e.path); return { value: fs.get(e.path) } })
  on('fs.write', (_$: unknown, e: any) => { fs.set(e.path, e.content ?? e.text ?? e.data); return { value: undefined } })
  on('fs.stat', (_$: unknown, e: any) => ({ value: fs.has(e.path) ? { kind: 'file', size: 1, mtimeMs: 0 } : null }))
  on('process.run', (_$: unknown, e: any) => {
    const argv = e.argv ?? e.command ?? e.args
    if (argv?.[0] === 'rm') for (const p of argv.slice(2)) fs.delete(p)
    return { value: { exitCode: argv?.[0] === 'rm' ? 0 : 1, stdout: '', stderr: '' } }
  })
  return fs
}

test('a dropped overlapping merge keeps its survivor in the index, links redirected', async ($, on) => {
  const dir = '/mem'
  const fs = folder(on, {
    '/mem/MEMORY.md': '# Feedback\n- [a](a.md) - about a, see [[b]]\n- [b](b.md) - about b\n- [c](c.md) - about c\n',
    '/mem/a.md': memo('a'), '/mem/b.md': memo('b'), '/mem/c.md': memo('c'),
  })
  mock.env(on, { DREAM_PASS_MEMORY_DIR: dir, HOME: '/home/u', DREAM_PASS_SYNC: '1' })
  mock.clock(on)
  on('command.run', () => ({}) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: JSON.stringify({
    merged: [{ into: 'a.md', from: ['b.md'], content: memo('a and b') }, { into: 'c.md', from: ['a.md'], content: memo('all') }],
    index: '# Feedback\n- [c](c.md) - everything\n',
  }) } }) as never)
  await $.command.run({ command: 'dream', args: '' } as never)
  const index = fs.get('/mem/MEMORY.md')
  expect(index).toContain('(a.md)')
  expect(index).not.toContain('[[b]]')
})
