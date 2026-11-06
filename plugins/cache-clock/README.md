# cache-clock

A Claude Code mod that puts one line above the prompt: how long until the prompt cache goes cold, how full the context window is, and a separate clock for subagents while one is warm.

![cache-clock: the band above the Claude Code prompt, showing 59:08 left on the cache, context at 54k of 1M, a subagent clock and the measured 1h TTL](screenshot.png)

Every request to the model writes the conversation to the prompt cache. If the next request arrives before the cache expires, everything so far is read back at a fraction of the price. If it arrives after, the whole context is sent again at full price. Claude Code never shows you which side of that line you are on. This does.

- The countdown restarts on every model request. Subagent requests run their own `sub` clock.
- It turns yellow in the last quarter and red near the end, and pops a toast when the warning time is reached (optionally with a sound).
- At zero it says `cache cold`, and a toast tells you the next message is a full-price write.
- The TTL is read from the session itself: the API records whether each cache write was a 1 hour or a 5 minute one, and the band says `measured` once it has seen one.
- At the warning, if Claude is idle and you haven't replied, it acts while the cache is still warm. You pick what it does in the plugin's settings (`onWarning`):
  - `handoff` (the default): Claude writes a handoff note, `HANDOFF-<first 8 characters of the session id>.md`, in the project root, in case you don't come back. Each session has its own file, so parallel sessions in one folder don't overwrite each other.
  - `off`: just the toast.

  It runs once per idle stretch and re-arms when you send a message.
- Want the session compacted instead? Use Claude Code's own idle compaction (2.1.299 and later, on by default): a conversation of 200K+ tokens left idle for about 54 minutes is compacted before its one-hour cache expires. Turn it on or off with `Idle compaction` in `/config`, and change the 200K minimum with `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`. The mod's own `compact` option is gone; a saved `compact` now acts as `off`.
- `/cache-clock` prints the same line as text.

Does nothing in -p / SDK sessions.

The handoff is the only thing it sends to Claude: one short turn on a warm cache.

## Install

```
claude plugin marketplace add ray-amjad/claude-code-mods
claude plugin install cache-clock@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add ray-amjad/claude-code-mods`, then `/plugin install cache-clock@claude-code-mods`.

## Settings

`onWarning` is a plugin setting: set it with `/plugin configure cache-clock@claude-code-mods`. The rest are optional environment variables. Minutes may be fractional.

| Variable | Default | What it does |
| :- | :- | :- |
| `CACHE_CLOCK_MAIN_TTL_MIN` | 60 | Main session TTL. Setting it pins it; otherwise the mod reads it from the transcript. |
| `CACHE_CLOCK_SUB_TTL_MIN` | 5 | Subagent TTL |
| `CACHE_CLOCK_WARN_MIN` | 5 | Toast, the onWarning action and the colour red when this much is left |
| `CACHE_CLOCK_ON_WARNING` | the setting | `handoff` or `off`; overrides the plugin setting |
| `CACHE_CLOCK_AUTO_HANDOFF` | on | `0` means `off` (kept from older versions) |
| `CACHE_CLOCK_HANDOFF_DIR` | project root | Folder the handoff notes go to |
| `CACHE_CLOCK_SOUND` | off | `1` plays `sounds/cooling.wav` with the warning toast |

To watch the whole cycle in two minutes:

```bash
CACHE_CLOCK_MAIN_TTL_MIN=2 CACHE_CLOCK_WARN_MIN=1.5 claude
```

## How it works

- Every `turn.step` (one per model request) restarts the main clock, or the `sub` clock when the step carries an `agentId`. A one second `$.clock.every` redraws the band and checks the warning.
- `/recap` and `/btw` send the conversation to the model outside a turn, so no `turn.step` fires for them. Their request reads the main cache all the same, so a `command.run` hook on each restarts the main clock too, while the cache is still warm (a bare `/btw` sends nothing and is ignored).
- After each turn it reads the end of the session transcript for the newest main-thread `usage.cache_creation`: tokens in `ephemeral_1h` mean 1 hour, `ephemeral_5m` mean 5 minutes. On `--resume` it seeds the clock from the session's `seconds_since_last_response`.
- Context comes from `$.session.usage()` at start, then the pushed `session.measure` figures.
- The warning action: when the warning fires, no turn is running (`turn.start`/`turn.complete`) and nothing has run since your last prompt, `handoff` calls `$.prompt.submit`. A `prompt.submit` hook re-arms it on your next prompt.

## Limits

- The clock counts from when each request was sent, so it can run a few seconds conservative.
- A message sent while the band says cold still works; it is just a full-price cache write.
- If none of the last 300 transcript lines wrote to the cache, the TTL keeps its previous or default value and is labelled `assumed`.
- State lives in memory, so after a hot reload the clock waits for the next turn.
- A later handoff in the same session overwrites that session's note, and it fires even if you have a draft typed but not sent (the draft stays in the box).
- In a narrow terminal the line drops pieces from the right (the TTL label, then `sub`, then ctx) instead of wrapping.

## Develop

```
claude --plugin-dir ./cache-clock
claude plugin validate .
claude plugin test .
```
