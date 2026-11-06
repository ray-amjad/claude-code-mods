# decision-tree

A Claude Code mod that turns the question at the end of Claude's reply into a side pane you can explore: every option with what it leads to, and a real forked session for any answer you want to try before you commit.

![decision-tree in a session: Claude's reply lists three storage options and asks which one to use, and the Decision tree pane beside it shows the question, one box per option with what it leads to and its pros and cons, SQLite in green as recommended, and an Other box for your own answer, above the four steps from Claude asking to you exploring](diagram.png)

After every turn:

1. **A regex looks at the end of the reply.** A question mark in the last paragraph, or two or more numbered or lettered options. Most turns stop here, with no model call.
2. **Haiku confirms it.** It answers `YES` if you have to decide something before work can go on, `NO` for "anything else?" and other pleasantries.
3. **A fork explains the choice.** `$.model.fork` replays the session's own transcript (served from the prompt cache), so it knows everything Claude knew. It has no tools and replies with JSON: the question, the context you need, each option with what it leads to and its pros and cons, and a recommendation.
4. **The pane draws it.** One box per option, the recommended one in green, and an Explore button on each. The last box is **Other**: type your own answer and press Enter.

You answer Claude in the prompt as usual. Nothing in the pane goes back to Claude.

Does nothing in -p / SDK sessions, unless `DECISION_TREE_WAIT=1` is set (see below).

## Exploring

![The pane on a branch: "If you pick SQLite" with the steps the forked session would take and its session id, under it the map of every question and option explored, and below the window a graph of the main session with two forks off its question, one for SQLite and one for your own "use Redis" answer, each reaching its own next question](branches.png)

Explore forks the real session at the message that asked the question:

```
claude -p --resume <session> --resume-session-at <that message> --fork-session
```

The fork is told you picked that option and carries on with read-only tools (Read, Grep, Glob). In 12 to 20 seconds the pane shows what it would do, its steps, and the next question it would ask you. Explore again from there to go deeper: each level forks the branch above it.

- **Your own answer**: the Other box, or `/explain other <answer>`, adds it as an option and explores it like the rest.
- **Map**: every question and option you explored as one tree. Press a row to jump to it.
- **Continue branch**: opens the branch as a live session with `claude --resume <branch> --fork-session`, in a new Herdr pane when you're inside Herdr, or copied to your clipboard otherwise.

Every branch is its own session file, so the main conversation never sees any of it.

## Commands

| Command | What it does |
| --- | --- |
| `/explain` | Open the pane for the latest question |
| `/explain b` | Explore option B (A to H) |
| `/explain other <answer>` | Explore your own answer |
| `/explain map` | Show the map |
| `/explain back`, `/explain top` | Move up the tree |
| `/explain continue` | Open the current branch as a live session |

## Install

```
/plugin install decision-tree --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `gateModel` | `haiku` | The model that answers `YES` or `NO` |

## Limits

- Claude Code only opens a pane nobody asked for in a terminal at least 144 columns wide. In a narrower one you get a toast; run `/explain` and the pane opens above the prompt.
- The tree lives in the mod's memory. A new question, a restart or a reload clears it; the branch sessions stay on disk and can still be resumed by id.
- `--resume-session-at` is an undocumented Claude Code flag (tested on 2.1.296). If the mod can't find the message to cut at, it forks from the latest point and says so.
- Each branch is a full `claude -p` run with a turn's cost, and its session file stays in the project's history.

## Develop

```
claude --plugin-dir ./decision-tree
claude plugin validate .
```

In `claude -p`, set `DECISION_TREE_WAIT=1` so the run waits for the fork before it exits.
