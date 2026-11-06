# memory-fork

A Claude Code mod that keeps your auto-memory up to date in the background, so the main session never stops to write it.

In -p / SDK sessions no pane is opened. A `claude -p` run exits when the turn ends, before the background write finishes, so set `MEMORY_FORK_WAIT=1` to make it wait. Long-lived SDK sessions don't need it.

![memory-fork in a session: two "remember" turns, the Memory bar above the prompt with the lines added and removed and the files changed, with Open and Hide buttons, the Memory pane showing each run's added, updated and deleted files with their line counts, and the four steps from turn end to files on disk](diagram.png)

After every turn:

1. **Haiku judges the turn.** It reads the last exchange and your `MEMORY.md` index and answers `SKIP` or `UPDATE: <what to save>`.
2. **A fork drafts the change.** `$.model.fork` replays the session's own transcript (served from the prompt cache) with the current memory files attached. Every tool is denied; it can only reply with JSON: `{"write": [{"name", "content"}], "delete": [...]}`.
3. **The mod writes it.** The files are written with `$.fs.write` and deletions run as `rm -f` (on Windows, which has no `rm`, a PowerShell `Remove-Item` that gets the paths in an environment variable, never in the script), only for bare `*.md` names inside the project's memory folder. `MEMORY.md` is never deleted.

A band above the prompt shows the run (`Memory: updating …`, then the lines added and removed and the files changed, as in `Memory: +13 −13 · db-p99-under-10ms.md, MEMORY.md`) with **Open** and **Hide** buttons. **Open** shows a pane listing every run this session, each file with its own `+added −removed` count, and the session total at the top. `/memory-fork` opens the same pane.

The main session is told that memory is handled, and its own `Write`/`Edit` calls into the memory folder are refused.

## Why a model fork, not a subagent

The first version spawned a forked agent to write the files. In auto mode every agent spawn goes to the permission classifier, and the classifier gives no verdict on a spawn the user never typed, so every run failed. A tool-less `$.model.fork` makes no tool calls, and the files are written by the mod's own code.

That also means **the writes skip every permission prompt, in every mode.** The file-name guard is the only limit on them. Read `hooks/register.tsx` before you install it.

## Install

```
/plugin install memory-fork --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Develop

```
claude --plugin-dir ./memory-fork
claude plugin validate .
claude plugin test .
```
