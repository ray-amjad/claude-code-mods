// decision-tree: when Claude's reply ends by asking you something, a fork of the
// conversation explains the choice in a side pane. Then you can explore
// any option: the mod forks the real session at that question, plays the answer out in
// the fork, and shows the next question. Each branch is its own session, so nothing you
// explore reaches the main conversation.

const PANE = 'question'

// The answer every explanation is asked for, so the pane can draw it
const SHAPE = '{"question": "the question in one plain line", ' +
  '"context": "one or two sentences: what I need to know to decide", ' +
  '"options": [{"label": "2 to 5 words", "detail": "what it means", ' +
  '"leadsTo": "what happens next if I pick it", "pros": ["short"], "cons": ["short"]}], ' +
  '"recommendation": {"label": "the label of one option", "why": "one sentence"}}'

// The tree for the latest question. A node is { sid, msgId, answer, status, data, children }:
// sid and msgId say which session, cut at which message, a branch below it forks from
let root = null
// Option indexes from the root to the node the pane shows
let path = []
// What the pane shows: 'node' (one question) or 'map' (the whole tree)
let view = 'node'
// Where the session transcripts live, from the Stop hook
let transcriptPath = ''
// Set at each session.start; true for -p / SDK sessions, where the pane is never drawn
let headless = false

// Cheap check, no model: does the end of the reply ask something?
// A question mark in the last paragraph, or a numbered / lettered / bulleted list of options.
function looksLikeQuestion(answer) {
  const tail = answer.trim().slice(-1500)
  const paragraphs = tail.split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1] || ''
  if (/\?\s*(\*\*|_|`)?\s*$/.test(last) || /\?\s*$/m.test(last)) return true
  const options = tail.match(/^\s*(\d+[.)]|[A-D][.):]|[-*]\s+\*\*Option|Option [A-D1-9])/gm) || []
  return options.length >= 2 && /\b(which|prefer|choose|pick|want|should I|let me know)\b/i.test(tail)
}

// The gate: a small model confirms the question needs a real decision from the user
async function needsDecision($, answer, model) {
  const r = await $.model.complete({
    model,
    system: 'You read the end of an AI coding assistant reply. Answer YES if it ends by asking ' +
      'the user to decide, choose, or supply something before work can go on. Answer NO for ' +
      'rhetorical questions, pleasantries such as "anything else?", or a reply that just reports. ' +
      'Reply with YES or NO only.',
    prompt: answer.trim().slice(-2000),
    maxTokens: 5,
    timeoutMs: 20000,
  })
  return r.isAnswered && /^\s*yes/i.test(r.text)
}

// The first explanation: a model fork replays the conversation and returns the choice as JSON
async function explainRoot($, answer) {
  const node = { sid: await $.session.id(), answer, status: 'thinking', children: [] }
  root = node
  path = []
  view = 'node'
  await openPane($, false)
  $.ui.invalidate('ui.render')

  const r = await $.model.fork({
    prompt: 'Your last reply ended by asking me a question. Do not answer it and do not use tools. ' +
      'Help me answer it. Reply with JSON only, no code fence, in this shape: ' + SHAPE + '. ' +
      'Use the options you offered; if you offered none, give the 2 to 4 answers I would most ' +
      'likely pick. At most 2 pros and 2 cons each. No em or en dashes.',
  })
  settle(node, r.isAnswered ? r.text : '', r.isAnswered ? 'the fork did not return JSON' : r.reason)
  if (root !== node) return
  $.ui.invalidate('ui.render')
}

// Explore option i of the node the pane shows: fork the real session at that node's
// question, tell the fork we picked i, and let it play that out with read-only tools.
// With own, the answer is yours: it joins the question's options first, then is explored
async function explore($, i, own) {
  const tree = root
  const node = nodeAt(path)
  if (own && node && node.data && node.data.options) {
    const options = node.data.options
    i = options.findIndex(o => o.label.toLowerCase() === own.toLowerCase())
    if (i < 0) i = options.push({ label: own, mine: true }) - 1
  }
  const option = node && node.data && node.data.options && node.data.options[i]
  if (!option) return $.ui.toast('decision-tree: no option ' + String.fromCharCode(65 + i) + ' here')
  path = [...path, i]
  view = 'node'
  $.ui.invalidate('ui.render')
  if (node.children[i]) return

  const child = { label: option.label, status: 'exploring', children: [], startedAt: Date.now() }
  node.children[i] = child

  // The message to cut the parent session at: the reply that asked this question
  if (!node.msgId) node.msgId = await lastAssistantId($, node.sid, node.answer)
  if (!node.msgId) $.ui.log('decision-tree: message id not found, forking from the latest point')
  const args = ['claude', '-p', whatIf(option),
    '--resume', node.sid, '--fork-session', '--output-format', 'json',
    '--permission-mode', 'default', '--allowedTools=Read,Grep,Glob',
    '--disallowedTools=Bash,Edit,Write,NotebookEdit']
  if (node.msgId) args.push('--resume-session-at', node.msgId)

  let out = null
  try {
    const run = await $.process.run(args, {
      cwd: await $.session.cwd(),
      env: { DECISION_TREE_CHILD: '1' },
      timeoutMs: 300000,
    })
    out = resultOf(run.stdout)
    if (!out) child.reason = (run.stderr || run.stdout || 'no output').slice(0, 300)
  } catch (err) {
    child.reason = String(err)
  }
  if (root !== tree) return
  if (out) {
    child.sid = out.session_id
    child.answer = out.result
    settle(child, out.result || '', 'the branch did not return JSON')
  } else {
    child.status = 'failed'
  }
  child.ms = Date.now() - child.startedAt
  $.ui.invalidate('ui.render')
}

// The prompt a branch gets: our answer, then the same JSON as the root plus what happened
function whatIf(option) {
  return 'WHAT-IF BRANCH: this is a forked copy of the session for exploring one answer. ' +
    'The real session is not affected. My answer to your question: "' + option.label + '"' +
    (option.detail ? ' (' + option.detail + ')' : '') + '. Carry on as if I picked it, but change no files and run no ' +
    'commands; you may Read, Grep and Glob to make the plan concrete. Then reply with JSON only, ' +
    'no code fence, in this shape, plus two more fields: "outcome" (two to four sentences: what ' +
    'you would do and how things stand after) and "steps" (up to 4 short concrete steps). ' +
    'The question and options are the NEXT decision you would need from me after this; if there ' +
    'is none, give an empty question and options []. Shape: ' + SHAPE + '. No em or en dashes.'
}

// Turn a reply into the node's data, or mark the node failed
function settle(node, text, reason) {
  const data = parseJson(text)
  if (data && Array.isArray(data.options)) {
    node.data = data
    node.status = 'ready'
  } else {
    node.status = 'failed'
    node.reason = node.reason || reason
  }
}

// claude -p --output-format json prints the result object, or the whole event list
function resultOf(stdout) {
  try {
    const out = JSON.parse(stdout)
    const res = Array.isArray(out) ? out.find(x => x.type === 'result') : out
    return res && res.session_id ? res : null
  } catch {
    return null
  }
}

// Find the id of the assistant message that asked the question, in the session's transcript
async function lastAssistantId($, sid, answer) {
  // The Stop hook's transcript path names the folder; without it, rebuild it from the cwd
  // (a Windows path uses \, and a native Windows terminal sets USERPROFILE, not HOME)
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  const folder = transcriptPath ? transcriptPath.replace(/[\\/][^\\/]+$/, '') :
    home + '/.claude/projects/' + (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
  const file = folder + '/' + sid + '.jsonl'
  if (!(await $.fs.exists(file))) return undefined
  // A transcript past $.fs.read's 4 MiB cannot be searched: fork from the latest point
  const lines = (await $.fs.read(file).catch(() => '')).split('\n')
  const want = (answer || '').trim().slice(-60)
  for (let n = lines.length - 1; n >= 0; n--) {
    let row
    try { row = JSON.parse(lines[n]) } catch { continue }
    if (row.type !== 'assistant' || row.isSidechain) continue
    const text = (row.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    if (text && text.trim().endsWith(want)) return row.uuid
  }
  return undefined
}

// The map: one row per question and per option, drawn as a tree with the path to each row
// Question: Which storage?
// ├ A JSON file on disk ▸
// │ └ Q: How should I build it?
// └ B SQLite ★
function mapRows(node, p, prefix, rows) {
  const data = node.data
  if (!data || !data.question) return rows
  rows.push({ text: prefix + 'Q: ' + data.question, path: p, kind: 'question' })
  const pick = (data.recommendation && data.recommendation.label) || ''
  data.options.forEach((o, i) => {
    const last = i === data.options.length - 1
    const child = node.children[i]
    const mark = !child ? '' : child.status === 'exploring' ? '  ...' : child.status === 'failed' ? '  ✗' : '  ▸'
    rows.push({
      text: prefix + (last ? '└ ' : '├ ') + String.fromCharCode(65 + i) + ' ' + o.label + (o.label === pick ? ' ★' : '') + (o.mine ? ' ✎' : '') + mark,
      path: child ? [...p, i] : null,
      kind: child ? 'explored' : 'option',
    })
    if (child && child.status === 'ready') mapRows(child, [...p, i], prefix + (last ? '  ' : '│ '), rows)
  })
  return rows
}

function nodeAt(p) {
  let node = root
  for (const i of p) node = node && node.children[i]
  return node
}

// Continue a branch for real: a new Claude session forked from it, in a Herdr pane if there is one
async function continueBranch($, node) {
  if (!node || !node.sid) return
  const command = 'claude --resume ' + node.sid + ' --fork-session'
  if ((await $.env.get('HERDR_ENV')) === '1') {
    try {
      const split = await $.process.run(['herdr', 'pane', 'split', '--current', '--direction', 'down',
        '--cwd', await $.session.cwd(), '--no-focus'])
      const id = JSON.parse(split.stdout).result.pane.pane_id
      await $.process.run(['herdr', 'pane', 'run', id, command])
      return $.ui.toast('decision-tree: branch opened in pane ' + id)
    } catch (err) {
      $.ui.log('could not open a Herdr pane: ' + err)
    }
  }
  await $.ui.copy({ text: command })
  $.ui.toast('decision-tree: copied ' + command)
}

// Open the side pane. Unasked, Claude Code only places it on a wide terminal.
async function openPane($, asked) {
  // A -p run with DECISION_TREE_WAIT still builds the tree, but has no pane to open
  if (headless) return
  // focus takes only true, so leave it out for an unasked open
  const pane = { id: PANE, title: 'Decision tree' }
  // Asked from /explain: take the keys, Escape closes it, and ask for room above the prompt
  const opened = await $.ui.open(asked ? { ...pane, focus: true, closeOnEscape: true, rows: 30 } : pane)
  if (!opened.isPlaced) $.ui.toast('decision-tree: run /explain to see the pane')
}

// The fork may wrap its JSON in prose or a fence; take the outermost braces
function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    headless = e.isInteractive === false
    if (headless) return next(e)
    await $.command.register({
      name: 'explain',
      description: 'Show the decision tree; A to H explores an option, other <answer> explores your own',
      argumentHint: '[A-H | other <answer> | map | back | top | continue]',
      immediate: true,
    })
    return next(e)
  })

  // Remember where transcripts are written, to find message ids to fork at
  on('classic.Stop', async ($, e, next) => {
    if (e.transcript_path) transcriptPath = e.transcript_path
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // After each of Claude's replies: regex check, then the gate, then the fork
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Headless: nothing would be shown, so skip the gate and the fork, unless DECISION_TREE_WAIT asks for it
    const wait = (await $.env.get('DECISION_TREE_WAIT')) === '1'
    if (headless && !wait) return result
    // A branch's own claude -p run never explains its own replies
    if ((await $.env.get('DECISION_TREE_CHILD')) === '1') return result
    if (e.agentId || e.reason !== 'answer' || !looksLikeQuestion(e.answer)) return result
    if (!(await needsDecision($, e.answer, options.gateModel || 'haiku'))) return result
    // Run the fork without holding up the prompt; in a -p run, wait so the process lives on
    const work = explainRoot($, e.answer).catch(err => $.ui.log('decision-tree failed: ' + err))
    if (wait) await work
    return result
  })

  // /explain opens the pane; /explain B explores option B; back, top and continue move around
  on('command.run', { command: 'explain' }, async ($, e) => {
    if (!root) return { text: 'No question to explain yet.' }
    const raw = (e.args || '').trim()
    const arg = raw.toLowerCase()
    view = arg === 'map' ? 'map' : 'node'
    if (arg === 'back') path = path.slice(0, -1)
    else if (arg === 'top') path = []
    else if (arg === 'continue') await continueBranch($, nodeAt(path))
    else if (/^[a-h]$/.test(arg) || /^other\s+\S/.test(arg)) {
      const own = /^other\s/.test(arg) ? raw.replace(/^other\s+/i, '') : undefined
      const work = explore($, own ? -1 : arg.charCodeAt(0) - 97, own).catch(err => $.ui.log('explore failed: ' + err))
      if ((await $.env.get('DECISION_TREE_WAIT')) === '1') await work
    }
    $.ui.invalidate('ui.render')
    await openPane($, true)
    return {}
  })

  // The pane: where you are in the tree, what the branch did, then the question and its options
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const width = Math.max(30, (e.props.bodyColumns || 60) - 2)
    const node = nodeAt(path)

    if (!root || !node) return <Text dimColor>Waiting for Claude to ask you something.</Text>

    // The breadcrumb: Question › B SQLite › A WAL mode
    const crumbs = ['Question']
    let walk = root
    for (const i of path) {
      crumbs.push(String.fromCharCode(65 + i) + ' ' + walk.children[i].label)
      walk = walk.children[i]
    }
    const nav = (
      <Box gap={2} marginTop={1}>
        {path.length ? <Button key="back" label="Back" onPress={() => { path = path.slice(0, -1); $.ui.invalidate('ui.render') }} /> : null}
        {path.length > 1 ? <Button key="top" label="Top" onPress={() => { path = []; $.ui.invalidate('ui.render') }} /> : null}
        {node.sid && path.length ? <Button key="cont" label="Continue branch" onPress={() => continueBranch($, node)} /> : null}
        <Button key="map" label="Map" onPress={() => { view = 'map'; $.ui.invalidate('ui.render') }} />
        <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    if (node.status === 'thinking') return <Text color="yellow">Reading the conversation to explain the question...</Text>

    // The map: the whole tree at once. Press a question or an explored option to open it.
    if (view === 'map') {
      const here = path.join('.')
      return (
        <Box flexDirection="column" width={width}>
          <Text bold>Map · ★ recommended · ▸ explored · ✎ yours</Text>
          <Text>{' '}</Text>
          {mapRows(root, [], '', []).map((row, n) => {
            // Mark the option you are on, or the first question when you are at the top
            const isHere = row.path && row.path.join('.') === here && (row.kind !== 'question' || !row.path.length)
            const text = (isHere ? '● ' : '  ') + row.text
            if (!row.path) return <Text key={'r' + n} dimColor>{text}</Text>
            return <Button key={'r' + n} plain label={text}
              onPress={() => { path = row.path; view = 'node'; $.ui.invalidate('ui.render') }} />
          })}
          <Box gap={2} marginTop={1}>
            <Button key="node" label="Back to question" onPress={() => { view = 'node'; $.ui.invalidate('ui.render') }} />
            <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }
    if (node.status === 'exploring') {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>{crumbs.join(' › ')}</Text>
          <Text color="yellow">{'Forking the session and playing out "' + node.label + '"... (read-only, about 20 to 60s)'}</Text>
          {nav}
        </Box>
      )
    }
    if (node.status === 'failed') {
      return (
        <Box flexDirection="column" width={width}>
          <Text dimColor>{crumbs.join(' › ')}</Text>
          <Text color="red">Could not explain it: {String(node.reason)}</Text>
          {nav}
        </Box>
      )
    }

    const data = node.data
    const pick = (data.recommendation && data.recommendation.label) || ''
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>{crumbs.join(' › ')}</Text>
        {path.length ? (
          <Box borderStyle="quote" borderColor="magenta" paddingLeft={1} flexDirection="column" marginBottom={1}>
            <Text bold color="magenta">{'If you pick ' + node.label}</Text>
            {data.outcome ? <Text>{data.outcome}</Text> : null}
            {(data.steps || []).map((s, j) => <Text key={'s' + j} color="blue">{(j + 1) + '. ' + s}</Text>)}
            <Text dimColor>{'branch session ' + String(node.sid).slice(0, 8) + (node.ms ? ' · ' + Math.round(node.ms / 1000) + 's' : '')}</Text>
          </Box>
        ) : null}
        {data.question ? (
          <Box borderStyle="double" borderColor="cyan" paddingX={1} flexDirection="column">
            <Text bold color="cyan">{data.question}</Text>
            {data.context ? <Text dimColor>{data.context}</Text> : null}
          </Box>
        ) : <Text dimColor>No further decision on this branch.</Text>}
        {data.options.map((o, i) => {
          const isPick = o.label === pick && !o.mine
          const child = node.children[i]
          const color = isPick ? 'green' : o.mine ? 'yellow' : 'gray'
          return (
            <Box key={'opt' + i} flexDirection="column">
              <Text dimColor>{'  │'}</Text>
              <Box borderStyle={isPick ? 'bold' : 'round'} borderColor={color} paddingX={1} flexDirection="column">
                <Text bold color={color === 'gray' ? 'white' : color}>{String.fromCharCode(65 + i) + '  ' + o.label + (isPick ? '   ★ recommended' : '') + (o.mine ? '   ✎ your answer' : '')}</Text>
                {o.detail ? <Text>{o.detail}</Text> : null}
                {o.leadsTo ? <Text color="blue">{'→ ' + o.leadsTo}</Text> : null}
                {(o.pros || []).map((p, j) => <Text key={'p' + j} color="green">{'+ ' + p}</Text>)}
                {(o.cons || []).map((c, j) => <Text key={'c' + j} color="red">{'- ' + c}</Text>)}
                <Button key={'x' + i} label={child ? (child.status === 'exploring' ? 'Exploring...' : 'Open branch ▸') : 'Explore ▸'}
                  onPress={() => explore($, i)} />
              </Box>
            </Box>
          )
        })}
        {data.question ? (
          <Box flexDirection="column">
            <Text dimColor>{'  │'}</Text>
            <Box borderStyle="round" borderColor="gray" borderDimColor paddingX={1} flexDirection="column">
              <Text dimColor bold>{String.fromCharCode(65 + data.options.length) + '  Other'}</Text>
              <Input key={'other.' + path.join('.')} placeholder="type your own answer" submitLabel="explore"
                onSubmit={value => { if (value.trim()) explore($, -1, value.trim()) }} />
            </Box>
          </Box>
        ) : null}
        {pick ? <Text>{' '}</Text> : null}
        {pick ? <Text color="green">{'★ ' + pick + ': ' + data.recommendation.why}</Text> : null}
        {nav}
      </Box>
    )
  })
}
