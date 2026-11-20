# Code Mode: a value a script builds itself reaches the model raw

Status: open, two Claude Code bugs, filed upstream as
[anthropics/claude-code#111259](https://github.com/anthropics/claude-code/issues/111259)
and [anthropics/claude-code#111260](https://github.com/anthropics/claude-code/issues/111260).
Found on Claude Code 2.1.329 with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, in an
interactive session.

transcript-redactor scrubs every call a Code Mode script makes (`` $` ``,
`tools.Bash`, `file().text()`), because each one passes `tool.call`. What it
cannot reach is what the script returns, logs or throws when it built that
value itself (string concat, `atob`, decoding). There is no hook in the mod API
on 2.1.329 that sees that output and can rewrite it.

## Repro

1. `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --plugin-dir plugins/transcript-redactor --debug-file /tmp/cm.log`, turn on Code Mode.
2. Prompt: *Run exactly one REPL script, using no tools inside it, that builds
   the string 'ghp_' followed by 36 random characters from [A-Za-z0-9] picked
   with Math.random, and returns that string. Then reply with exactly the value
   you saw, nothing else.*
3. The reply is the raw token. `grep -cE 'ghp_[A-Za-z0-9]{36}'` on the session
   `.jsonl` finds it in 5 records: the queue `enqueue` and `remove`, the
   `poll_events` attachment's `envelopes`, the `api-request-blob` (so the API
   request itself carried it) and the assistant reply. The debug log ends the
   turn with `resultLen=40`.

## Where the output goes, and which hooks see it

| Path | Fires for a mod? | Can it rewrite? |
| --- | --- | --- |
| `tool.call` (catch-all, no matcher), as the redactor registers it | No: never raised for `REPL` itself | – |
| `tool.call` / `tool.run` with `{ tool: 'REPL' }` | Yes | Only the receipt: `next(e)` resolves to `{ result: { result: "(dispatched #1)", asyncDispatched: true, ... } }` |
| The async REPL PostToolUse pass (the one the 2.1.328 changelog points to) | **No.** `classic.PostToolUse` never reaches a hooks module there, not even a `*` hook | A settings `command` hook with `"matcher": "*"` *does* fire there (`PostToolUse:REPL`), gets `tool_response: { code, result, stdout, stderr }`, and its `updatedToolOutput` is used: the model replied with the stand-in, 0 raw tokens in the `.jsonl` |
| `prompt.attachment` for `poll_events` | Yes | **Ignored.** The log says `prompt.attachment poll_events: transcript-redactor (user) rewrote it (433 -> 419 characters)`, yet `resultLen=40` and the `.jsonl` keeps the raw `envelopes`. Returning `{ text: null }` logs `left it out (434 characters)` and is ignored too |

`classic.PostToolUse` does reach a hooks module for an ordinary tool call
(checked with `Bash` in `claude -p`), so only the REPL settle path skips the
module chain. A script that sleeps 20 s before it returns settles the same way
(`poll_events`, no `classic.PostToolUse` for modules), so the settle window is
not the cause.

## The two bugs

1. **The async REPL PostToolUse pass skips hooks modules.** The mod types say a
   `classic.*` event "fires wherever the engine runs the classic hook". Settings
   hooks run in that pass; a module's `classic.PostToolUse` does not. With it,
   the hook below would close the gap with no workaround. Filed as
   [anthropics/claude-code#111259](https://github.com/anthropics/claude-code/issues/111259).
2. **A `prompt.attachment` answer for `poll_events` is ignored.** The rewrite
   or drop is logged as applied, but the `envelopes` are what is sent and stored.
   Filed as [anthropics/claude-code#111260](https://github.com/anthropics/claude-code/issues/111260).

## The hook to add once #111259 is fixed

```ts
on('classic.PostToolUse', async ($, e, next) => {
  const r = await next(e)
  if (e.tool_name !== 'REPL' && e.tool_name !== 'Poll') return r
  // walk r.updatedToolOutput ?? e.tool_response with scrub() (no
  // escapeLiteralTags: the placeholders inner calls minted must stay live),
  // return { ...r, updatedToolOutput }, and withhold on failure.
})
```

## Not shipped

A plugin `command` PostToolUse hook would work today, but it runs in its own
process, away from the vault, so the placeholders it mints could never be
restored and it would need its own copy of the detector. That is a workaround
for an engine bug, so it is left out.
