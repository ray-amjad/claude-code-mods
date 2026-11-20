import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { dropFromListing, gateOf, homeDir, mergeRoster, parseListing, parseSkillMd } from '../hooks/register'

// A session over a mocked store, no skills on disk, and a Jev that ranks
// herdr first and says it fits.
async function start($: Engine, on: On, store: Record<string, unknown>) {
  mock.store(on, store)
  mock.env(on, { HOME: '/nowhere', TYPESAFE_API_KEY: 'test-key' })
  mock.clock(on)
  on('fs.list', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }) as never)
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    const answers: Record<string, unknown> = {}
    for (const key of Object.keys(body.questions)) {
      answers[key] = key === 'which'
        ? { type: 'choice', choice: 'herdr', probabilities: { herdr: 0.9, linkedin: 0.1 } }
        : { type: 'noul', noul: key === 'gate::prose_suffices' ? 0 : 0.9 }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  await $.session.start({ cwd: '/nowhere', surface: null, isInteractive: false })
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
}

const LISTING = 'The following skills are available:\n- herdr: Control Herdr.\n- linkedin: Posts.'

test('parses inline, folded and quoted descriptions', () => {
  const folded = parseSkillMd('---\nname: commit-sweep\ndescription: >\n  Turn a messy tree\n  into commits.\n---\n# Body\nSteps.', 'dir')
  expect(folded?.name).toBe('commit-sweep')
  expect(folded?.description).toBe('Turn a messy tree into commits.')
  expect(folded?.body).toBe('# Body\nSteps.')
  const quoted = parseSkillMd('---\ndescription: "Say hi"\n---\n', 'hello')
  expect(quoted?.name).toBe('hello')
  expect(quoted?.description).toBe('Say hi')
  expect(parseSkillMd('no header', 'x')).toBe(null)
})

test('parses the engine skill listing, plugin names included', () => {
  const skills = parseListing(
    'The following skills are available:\n\n- agent-ready-api-audit\n- skill-creator:skill-creator: Create skills.\n  More detail.\n- herdr: Control Herdr.',
  )
  expect(skills.map(skill => skill.name)).toEqual(['agent-ready-api-audit', 'skill-creator:skill-creator', 'herdr'])
  expect(skills[1]?.description).toBe('Create skills. More detail.')
})

test('the listing decides who exists, the disk brings bodies', () => {
  const merged = mergeRoster(
    [{ name: 'herdr', description: 'long', body: 'BODY' }, { name: 'gone', description: '', body: '' }],
    [{ name: 'herdr', description: 'short', body: '' }, { name: 'plug:in', description: 'p', body: '' }],
  )
  expect(merged).toEqual([
    { name: 'herdr', description: 'long', body: 'BODY' },
    { name: 'plug:in', description: 'p', body: '' },
  ])
})

test('skills are found under USERPROFILE when HOME is unset, as on Windows', () => {
  expect(homeDir('/Users/r', undefined)).toBe('/Users/r')
  expect(homeDir(undefined, 'C:\\Users\\User')).toBe('C:\\Users\\User')
  expect(homeDir('/Users/r', 'C:\\Users\\User')).toBe('/Users/r')
  expect(homeDir(undefined, undefined)).toBe('')
})

test('gate inverts prose_suffices', () => {
  expect(gateOf({ acts_on_user_system: 1, would_follow_documented_procedure: 1, prose_suffices: 1 })).toBe(2 / 3)
})

test('block mode refuses every model skill load', async ($, on) => {
  await start($, on, { mode: 'block' })
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/blocked/)
})

test('a disabled skill is refused in observe mode', async ($, on) => {
  await start($, on, { disabled: ['herdr'] })
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/turned off/)
})

test('steer adds the pick as hidden context and lets only it load', async ($, on) => {
  let context: readonly string[] = []
  on('prompt.submit', (_$, e) => {
    context = e.context ?? []
    return { text: e.text } as never
  })
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
  await start($, on, { mode: 'steer' })
  await $.prompt.submit({ text: 'split the pane and run the tests' } as never)
  expect(context.join('')).toMatch(/Relevant to the current request: herdr/)
  expect((await $.tool.call({ tool: 'Skill', skill: 'linkedin' })).deny).toMatch(/herdr/)
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toBe(undefined)
})

test('observe drops disabled skills from the listing, block hides it', async ($, on) => {
  await start($, on, { disabled: ['herdr'] })
  const observed = await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
  expect(observed.text).toBe('The following skills are available:\n- linkedin: Posts.')
  await $.command.run({ command: 'jev', args: 'block' } as never)
  const blocked = await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
  expect(blocked.text).toBe(null)
})

test('the pane toggles a skill off, and the model can no longer load it', async ($, on) => {
  await start($, on, {})
  const ui = await $.ui.mount({
    plugin: 'jev-skill-suggestion',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jev-skill-suggestion',
    props: { title: 'Jev skills', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect((await ui.find({ key: 'toggle:herdr' }))?.text).toBe('[x]')
  await ui.press({ key: 'toggle:herdr' } as never)
  expect((await ui.find({ key: 'toggle:herdr' }))?.text).toBe('[ ]')
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/turned off/)
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } }

test('/jev off leaves skills to Claude and adds nothing; /jev on brings it back', async ($, on) => {
  let context: readonly string[] = []
  on('prompt.submit', (_$, e) => {
    context = e.context ?? []
    return { text: e.text } as never
  })
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
  await start($, on, { mode: 'steer' })
  await $.command.run({ command: 'jev', args: 'off' } as never)
  expect((await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)).text).toBe(LISTING)
  await $.prompt.submit({ text: 'split the pane and run the tests' } as never)
  expect(context).toEqual([])
  expect((await $.tool.call({ tool: 'Skill', skill: 'linkedin' })).deny).toBe(undefined)
  await $.command.run({ command: 'jev', args: 'on' } as never)
  expect((await $.tool.call({ tool: 'Skill', skill: 'linkedin' })).deny).toMatch(/only the skill Jev picked/)
})

test('/jev off is kept across sessions', async ($, on) => {
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
  await start($, on, { mode: 'block', enabled: false })
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toBe(undefined)
})

test('the band keeps other mods\' bands beneath it', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['other band'] }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  await start($, on, { mode: 'steer' })
  await $.prompt.submit({ text: 'split the pane and run the tests' } as never) // scores, so Jev's band shows
  const ui = await $.ui.mount({ plugin: 'jev-skill-suggestion', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS } as never)
  expect(await ui.find({ type: 'Text', text: /herdr/ } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /other band/ } as never)).toBeDefined()
})

test('a disabled plugin:skill and its run-on lines leave the listing', () => {
  const text = 'The following skills are available:\n- tools:herdr: Control Herdr.\n  More about herdr.\n- linkedin: Posts.'
  expect(dropFromListing(text, new Set(['tools:herdr']))).toBe('The following skills are available:\n- linkedin: Posts.')
  expect(dropFromListing(text, new Set(['tools']))).toBe(text)
})
