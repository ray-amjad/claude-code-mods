import { expect, test } from 'claude-code/testing'
import {
  commandFor, conversationSince, isInside, dropDeadPointers, indexProblems, keywords, originIds, parentDir, parsePlan, redirectLinks,
  safeName, snippets, summary, suspects, userRows,
} from '../hooks/register.js'

const memo = (description: string) => `---\nname: x\ndescription: ${description}\nmetadata:\n  type: feedback\n---\nbody\n`

test('a tidy index has no problems, so the periodic check goes on to Haiku', async () => {
  const files = { 'MEMORY.md': '# Feedback\n- [pnpm](pnpm.md) - always pnpm\n', 'pnpm.md': memo('always pnpm') }
  expect(indexProblems(files)).toEqual([])
})

test('code finds a long line, a dead pointer and an unlisted file with no model call', async () => {
  const files = {
    'MEMORY.md': '- [a](a.md) - ' + 'x'.repeat(220) + '\n- [gone](gone.md) - old\n',
    'a.md': memo('a'),
    'stray.md': memo('stray'),
  }
  expect(indexProblems(files)).toEqual([
    '1 index line(s) over 200 chars',
    '1 pointer(s) to missing files',
    '1 file(s) not in the index',
  ])
})

test('parsePlan drops paths, unknown files and any edit to MEMORY.md but the index', async () => {
  const files = { 'MEMORY.md': '', 'a.md': '', 'b.md': '', 'c.md': '' }
  const plan = parsePlan(`Sure: {
    "merged": [{"into": "a.md", "from": ["b.md", "../etc.md", "nope.md", "a.md"], "content": "merged", "why": "dup"}],
    "rewritten": [{"file": "MEMORY.md", "content": "x"}, {"file": "c.md", "content": "new", "why": "stale"}],
    "removed": [{"file": "MEMORY.md"}, {"file": "/etc/passwd.md"}, {"file": "c.md", "why": "dead"}],
    "index": "- [a](a.md) - a"
  }`, files)!
  expect(plan.merged.map((m) => m.from)).toEqual([['b.md']])
  expect(plan.rewritten.map((w) => w.file)).toEqual(['c.md'])
  expect(plan.removed.map((d) => d.file)).toEqual(['c.md'])
  expect(plan.index).toBe('- [a](a.md) - a\n')
})

test('a reply that is not JSON changes nothing', async () => {
  expect(parsePlan('I could not decide.', {})).toBe(null)
})

test('safeName only takes bare .md names', async () => {
  expect(['a.md', 'feedback_x-1.md', '../a.md', '/a.md', '.hidden.md', 'a.txt'].map(safeName))
    .toEqual([true, true, false, false, false, false])
})

test('the gate reads only what was said since the last check', async () => {
  const messages = [
    { role: 'user', text: 'old', toolUses: [] },
    { role: 'assistant', text: 'old reply', toolUses: [] },
    { role: 'user', text: 'we moved to Fly.io', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [] },
  ] as never[]
  expect(conversationSince(messages, 2)).toBe('USER: we moved to Fly.io')
  expect(conversationSince(messages, 4)).toBe('(nothing new)')
})

test('the band counts each kind of change', async () => {
  const changes = [{ kind: 'merged' }, { kind: 'merged' }, { kind: 'removed' }, { kind: 'rewritten' }, { kind: 'index' }]
  expect(summary({ changes })).toBe('2 merged · 1 removed · 1 rewritten')
})

test('the mod drops index lines that point at missing files, whatever the model wrote', async () => {
  const index = '# Project\n- [a](a.md) - kept\n- [gone](gone.md) - dropped\n'
  expect(dropDeadPointers(index, { 'a.md': '' })).toBe('# Project\n- [a](a.md) - kept\n')
})

test('parsePlan keeps only brand new files in added', async () => {
  const plan = parsePlan('{"added":[{"file":"new.md","content":"x"},{"file":"a.md","content":"x"},{"file":"../b.md","content":"x"}]}', { 'a.md': '' })!
  expect(plan.added.map((a) => a.file)).toEqual(['new.md'])
})

test('the band only mentions added files when there are some', async () => {
  expect(summary({ changes: [{ kind: 'added' }, { kind: 'merged' }] })).toBe('1 merged · 0 removed · 0 rewritten · 1 added')
})

test('originIds reads originSessionId and a sources list from the frontmatter only', async () => {
  const a = '11111111-2222-3333-4444-555555555555', b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const text = `---\nname: x\nmetadata:\n  originSessionId: ${a}\n  sources: [${a}, ${b}]\n---\nbody mentions 99999999-2222-3333-4444-555555555555\n`
  expect(originIds(text)).toEqual([a, b])
})

test('suspects are memories that share a word, the closest pairs first', async () => {
  const files = {
    'MEMORY.md': '',
    'feedback_pnpm.md': memo('use pnpm'),
    'feedback_package_manager.md': memo('Always pnpm, never npm or yarn'),
    'reference_noaa_api.md': memo('NOAA tides API notes'),
  }
  expect(keywords('feedback_package_manager.md', files['feedback_package_manager.md'])).toEqual(['package', 'manager', 'pnpm', 'yarn'])
  expect(suspects(files)).toEqual(['feedback_pnpm.md', 'feedback_package_manager.md'])
})

test('snippets cut each matching line around the word', async () => {
  const lines = ['nothing here', 'x'.repeat(200) + ' we moved staging to fly ' + 'y'.repeat(300), 'staging again']
  const hits = snippets(lines, ['staging'])
  expect(hits.length).toBe(2)
  expect(hits[0].length).toBeLessThan(320)
  expect(hits[0]).toContain('we moved staging to fly')
})

test('links to a merged file point at the file it went into, labels kept', async () => {
  expect(redirectLinks('see [[pnpm]] and [[pnpm|the rule]] and [[noaa-api]]', { pnpm: 'package-manager' }))
    .toBe('see [[package-manager]] and [[package-manager|the rule]] and [[noaa-api]]')
})

test('parentDir takes off the last part of a Unix or a Windows path', async () => {
  expect(parentDir('/home/u/.claude/projects/p/memory')).toBe('/home/u/.claude/projects/p')
  expect(parentDir('C:\\Users\\User\\.claude\\projects\\p\\memory')).toBe('C:\\Users\\User\\.claude\\projects\\p')
  expect(parentDir('C:\\Users\\User/.claude/projects/p/memory')).toBe('C:\\Users\\User/.claude/projects/p')
})

test('userRows keeps the user rows of a transcript, LF or CRLF, with no grep', async () => {
  const text = '{"type":"user","a":1}\r\n{"type": "assistant"}\r\n{"type": "user","b":2}\n'
  expect(userRows(text)).toEqual(['{"type":"user","a":1}', '{"type": "user","b":2}'])
  expect(userRows('')).toEqual([])
})

test('Mac and Linux use rm, mv, kill and grep, as before', async () => {
  expect(commandFor(false, 'remove', ['/m/a.md', '/m/b c.md'])).toEqual([['rm', '-f', '/m/a.md', '/m/b c.md'], {}])
  expect(commandFor(false, 'rename', '/m/1', '/m/undone-1')).toEqual([['mv', '/m/1', '/m/undone-1'], {}])
  expect(commandFor(false, 'alive', 4242)).toEqual([['kill', '-0', '4242'], {}])
  expect(commandFor(false, 'userRows', '/t/s.jsonl')).toEqual([['grep', '-E', '"type": ?"user"', '/t/s.jsonl'], {}])
})

test('Windows uses PowerShell, with each path in an env var and never in the script', async () => {
  const paths = ['C:\\m\\a.md', "C:\\m\\b c'; rm -r x.md"]
  for (const [job, arg, to] of [['remove', paths], ['rename', 'C:\\m\\1', 'C:\\m\\undone-1'], ['alive', 4242], ['userRows', 'C:\\t\\s.jsonl']] as const) {
    const [argv, init] = commandFor(true, job, arg, to)
    expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv[4]).toContain('$env:DREAM_PASS_ARG')
    for (const p of [paths, arg, to].flat()) if (p !== undefined) expect(argv[4]).not.toContain(String(p))
  }
  expect(commandFor(true, 'remove', paths)[1]).toEqual({ env: { DREAM_PASS_ARG: paths.join('\n') } })
  expect(commandFor(true, 'rename', 'C:\\m\\1', 'C:\\m\\undone-1')[1]).toEqual({ env: { DREAM_PASS_ARG: 'C:\\m\\1', DREAM_PASS_TO: 'C:\\m\\undone-1' } })
  expect(commandFor(true, 'alive', 4242)[1]).toEqual({ env: { DREAM_PASS_ARG: '4242' } })
})

test('the memory-write guard matches a Windows path with either separator, without case', () => {
  const dir = 'C:\\Users\\U\\.claude\\projects\\C--p\\memory'
  expect(isInside('C:\\Users\\U\\.claude\\projects\\C--p\\memory\\x.md', dir)).toBe(true)
  expect(isInside('c:/users/u/.claude/projects/C--p/memory/x.md', dir)).toBe(true)
  expect(isInside('C:\\Users\\U\\.claude\\projects\\C--p\\memory-other\\x.md', dir)).toBe(false)
  expect(isInside('/home/u/.claude/projects/-p/memory/x.md', '/home/u/.claude/projects/-p/memory')).toBe(true)
  expect(isInside('/home/u/.claude/projects/-p/Memory/x.md', '/home/u/.claude/projects/-p/memory')).toBe(false)
})

test('parsePlan drops a merge with no source left, and every other edit to a merged file', () => {
  const files = { 'a.md': memo('a'), 'b.md': memo('b'), 'c.md': memo('c') }
  const plan = parsePlan(JSON.stringify({
    merged: [
      { into: 'a.md', from: ['b.md'], content: 'ab' },
      { into: 'c.md', from: ['gone.md'], content: 'nothing to merge' },
    ],
    rewritten: [{ file: 'b.md', content: 'undo the merge' }, { file: 'c.md', content: 'c2' }],
    removed: [{ file: 'a.md' }],
    added: [{ file: 'new.md', content: 'n' }],
  }), files)
  expect(plan.merged.map((m: any) => m.into)).toEqual(['a.md'])
  expect(plan.rewritten.map((w: any) => w.file)).toEqual(['c.md'])
  expect(plan.removed).toEqual([])
  expect(plan.added.map((a: any) => a.file)).toEqual(['new.md'])
})
