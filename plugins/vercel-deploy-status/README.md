# vercel-deploy-status

Pins the Vercel deploy queue of the linked project under the prompt. Every
deploy that is queued, building or just finished gets one line, with its
phase, its target, its branch, how long it has run, and the commit subject.

It never starts a turn and never writes to the transcript. It polls the
`vercel` CLI on your machine and draws the answer. You keep working, and the
deploy sits in the corner of your eye.

Does nothing in -p / SDK sessions.

## Install

```
/plugin install vercel-deploy-status --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope.

## What it looks like

The block lives in the band above the prompt. It sits under the turn
narrator's line and above the prompt itself. The header is dim. A deploy in
flight is yellow, `Ready` is green, `Error` and `Canceled` are red.

You run `git push`. Vercel has not seen it yet:

```
▲ my-site
◌ waiting for a deploy   12s

❯ █
```

The deploy shows up and builds:

```
▲ my-site · 1 building
◐ Building      Production · main  1m 20s  Drop the review card's dead avatar column (#1238)

❯ █
```

A busy afternoon, three deploys on the board at once:

```
▲ my-site · 1 building · 1 queued · 1 finished
◐ Building      Production · main  1m 20s  Drop the review card's dead avatar column (#1238)
○ Queued        Preview · fix/nav  4s  Stop the nav from wrapping on mobile
● Ready         Production · main  took 2m 3s · 4m ago  Rename the pricing page

❯ █
```

One went wrong:

```
▲ my-site · 1 finished
✗ Error         Preview · feat/checkout  took 48s · 1m 10s ago  Add the team checkout

❯ █
```

The band clears on its own. A finished deploy stays for 5 minutes, then its
line goes. When the queue is empty and no push is waiting, the block is not
drawn at all, so an idle session looks like an idle session.

| Dot | Phase |
| --- | --- |
| `○` | Queued |
| `◐` | Building |
| `◑` | Initializing |
| `●` | Ready |
| `✗` | Error |
| `⊘` | Canceled |
| `◌` | Waiting: you pushed, and Vercel has not listed the deploy yet |

## What wakes it

A poll every 60 seconds keeps the block honest while nothing is happening.
Three shell lines make it look now, and then every 15 seconds until the
deploy is done:

- `git push` (with any flags, from any directory in the line)
- `gh pr merge`
- `vercel deploy` or `vercel --prod`

A `--dry-run` on any of them does not count. The hook waits for the command
to finish before it looks, because Vercel has nothing to report until the push
lands. The "waiting for a deploy" line then holds for up to 6 minutes. If no
deploy appears in that window, the block clears and the poll goes back to the
idle rate.

The three commands are matched in the `Bash` tool call's command string. A
push you type into a different terminal is not seen. The next idle poll picks
that deploy up anyway, up to 60 seconds later.

## The three hooks

| Event | What it does |
| --- | --- |
| `session.start` | Finds the `.vercel/project.json` link, reads the project name, and starts the poll loop. If there is no link file, it logs one line and goes quiet for the session |
| `tool.call` on `Bash` | Waits for the command to finish. If the command was a push, a merge or a deploy, it wakes the poll loop |
| `ui.render` on `AbovePrompt` | Draws the header and the rows from the last poll. A 1-second tick keeps the clocks moving between polls |

The poll runs `vercel ls --format json --non-interactive` from the linked
directory. It looks for the link in the session's directory first, then the
repo root, then a short walk of the repo (`$.fs.list`, four levels, skipping
node_modules and dot folders) for a linked package in a monorepo.
The first hit wins.

## Requirements

- The `vercel` CLI on your `PATH`, logged in. Check with `vercel whoami`.
- A `.vercel/project.json` in the repo. `vercel link` writes one.

If either is missing, the plugin logs one line to the debug log and does
nothing else. An error from the CLI is logged once per outage, not once per
poll.

## Options

Every option has a default that works. Options are read from your **user**
settings only. A `pluginConfigs` block in a project's `.claude/settings.json`
is not read.

```json
{
  "pluginConfigs": {
    "vercel-deploy-status@claude-code-mods": {
      "options": {
        "activePollSeconds": 10,
        "holdFinishedMinutes": 10
      }
    }
  }
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `vercelBin` | `vercel` | The executable to run. Set a full path if your shell's `PATH` and Claude Code's differ |
| `activePollSeconds` | `15` | How often to ask Vercel while a deploy is in flight, or a push is waiting on one |
| `idlePollSeconds` | `60` | How often to ask Vercel while nothing is in flight |
| `holdFinishedMinutes` | `5` | How long a finished deploy keeps its line |
| `watchAfterPushMinutes` | `6` | How long a push keeps the active rate while no deploy has appeared |
| `maxRows` | `8` | How many deploys to list before folding the rest into "… and N more" |

When you run it with `--plugin-dir` instead of installing it, the key is
`vercel-deploy-status` or `vercel-deploy-status@inline`.

## Known limits

- `vercel ls` returns the newest deploys, not all of them. A deploy that was
  in flight and then fell off that list is shown as `Ready`, because that is
  the usual way a deploy leaves the list.
- One project per session. The first link file found is the one polled.
- The toast on start and on finish uses the terminal's toast slot, so a toast
  from another plugin can push it out.

## Layout

```
hooks/deploy-status.tsx   the three hooks and the JSX; imports ./queue.ts
hooks/queue.ts            everything with no UI in it: types, the wake regex,
                          the formatters, and the merge of one poll into the
                          next queue. Imports nothing
test/queue.test.mts       58 checks on queue.ts, on bare Node
```

Three rules of this runtime, learned the hard way and marked in the code:
a `.map()` array is not a valid `Box` child, so wrap it in a Fragment; `key`
is a `Button` prop only, so a `Box` with a `key` fails validation and the
whole tree falls back in silence; and nothing inside a hook may be named
`next`. `next` is the continuation each hook is handed, and a local of that
name shadows it, which the loader refuses. The module then registers no hook
at all, so the plugin is silent rather than wrong. `claude plugin validate`
catches it, and `--debug-file` names it.

## Test it

Run the checks from the root of the repo:

```bash
node --experimental-strip-types plugins/vercel-deploy-status/test/queue.test.mts
claude plugin validate plugins/vercel-deploy-status
```

See it live. From a repo with a `.vercel/project.json`:

```bash
claude --plugin-dir /path/to/plugins/vercel-deploy-status
```

Then push a commit, or run `vercel deploy`, and watch the band. To see the
loader's own view, add `--debug-file load.log` and look for the line
`hooks module vercel-deploy-status loaded`.
