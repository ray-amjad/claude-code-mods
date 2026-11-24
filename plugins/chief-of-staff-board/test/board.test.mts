// node --experimental-strip-types plugins/chief-of-staff-board/test/board.test.mts
import assert from 'node:assert/strict'
import { boardPath, isOpenable, openArgv, parseBoard, setupPrompt, slackAppLink, STARTER } from '../hooks/board.ts'

assert.equal(boardPath('', '/work/cos', '/home/me'), '/work/cos/board.json')
assert.equal(boardPath(undefined, '/work/cos', '/home/me'), '/work/cos/board.json')
assert.equal(boardPath('~/cos/board.json', '/work', '/home/me'), '/home/me/cos/board.json')
assert.equal(boardPath('/abs/b.json', '/work', '/home/me'), '/abs/b.json')
assert.equal(boardPath('state/b.json', '/work', '/home/me'), '/work/state/b.json')
assert.equal(boardPath('C:\\cos\\b.json', '/work', undefined), 'C:\\cos\\b.json')

const web = 'https://acme.slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=1700000000.000100&cid=C0123ABCD'
assert.equal(slackAppLink(web, ''), web)
assert.equal(slackAppLink(web, 'not a team'), web)
assert.equal(slackAppLink(web, 'T0EXAMPLE'), 'slack://channel?team=T0EXAMPLE&id=C0123ABCD&message=1700000000.123456&thread_ts=1700000000.000100')
assert.equal(slackAppLink('https://slack.com/archives/C0123ABCD/p1700000000123456', 'T0EXAMPLE'), 'slack://channel?team=T0EXAMPLE&id=C0123ABCD&message=1700000000.123456')
assert.equal(slackAppLink('https://github.com/acme/app/pull/7', 'T0EXAMPLE'), 'https://github.com/acme/app/pull/7')

assert.ok(isOpenable('https://example.com') && isOpenable('slack://channel?team=T1'))
assert.ok(!isOpenable('file:///etc/passwd') && !isOpenable('-a Calculator') && !isOpenable('javascript:alert(1)'))

assert.deepEqual(openArgv('macos', 'https://x.test'), ['open', 'https://x.test'])
assert.deepEqual(openArgv('linux', 'https://x.test'), ['xdg-open', 'https://x.test'])
assert.equal(openArgv('windows', 'https://x.test')[0], 'rundll32')

assert.equal(parseBoard('{"updated": "now", "waiting": ['), null)
assert.equal(parseBoard('[]'), null)
const b = parseBoard(JSON.stringify({ updated: 'now', waiting: [{ id: 7, title: 'Merge?', link: 'https://x.test', extra: 1 }, { note: 'no title' }, null], handled: 'oops' }))
assert.deepEqual(b, { updated: 'now', waiting: [{ id: '7', title: 'Merge?', note: undefined, link: 'https://x.test', linkLabel: undefined }], review: [], working: [], handled: [] })
assert.equal(parseBoard(STARTER)?.waiting.length, 1)
assert.ok(setupPrompt('/work/board.json').includes('/work/board.json is the live board'))

console.log('board.test.mts: all checks passed')
