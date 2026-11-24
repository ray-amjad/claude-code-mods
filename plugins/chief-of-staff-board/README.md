# chief-of-staff-board

A side pane for the one session you talk to while other agents do the work.

When you run many agent threads at once (in Slack, on PRs, in other
sessions), reading them all becomes the job. The way out is a coordinator: one
session that watches the threads, answers what it can on your behalf, and
brings you only the decisions. That session is your chief of staff.

This mod is its board. The coordinator keeps one JSON file of what needs you.
The pane draws that file beside the chat, re-reads it every few seconds, and
gives each item two buttons: open the thread, or start your answer.

The mod draws and never decides. What goes on the board is up to the agent.

## Install

```
/plugin install chief-of-staff-board --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope. The pane needs a wide
terminal (about 110 columns or more).

## Set it up

Make a folder for your coordinator, start Claude Code in it, and run:

```
/board-setup
```

It does three things:

1. Creates `board.json` in that folder, if there is none.
2. Opens the pane.
3. Puts a setup prompt in the prompt box. Nothing is sent until you press
   Enter, so read it and change what you like first.

The prompt asks the session to write the board rules into the project's
`CLAUDE.md`, so every later session in that folder follows them. It then asks
you what to watch and what it may do alone, and does a first sweep.

From then on the pane opens by itself in any session started in a folder that
has a `board.json`. `/board` reopens it.

## What it looks like

```
updated 24 Nov 15:45

WAITING ON YOU · 2
ci Tests keep getting stuck: cancel the stuck runs and merge the fix?
  The worker found the cause and built a fix (52 lines, tested). Pick: yes.
[ Open PR #42 ] [ Answer ]
pay Refund the duplicate charge for the March invoice?
  Customer asked twice. Pick: yes, it is our bug.
[ Open thread ] [ Answer ]

READY FOR REVIEW · 1
docs New onboarding page is drafted
[ Open draft ] [ Answer ]

WORKING · 1
mig Database migration, step 2 of 4

HANDLED FOR YOU · 2
Answered the worker's question about the staging URL
Closed three stale questions
```

**Open** goes to the item's link. **Answer** puts `Board <id>: ` in the prompt
box, so you type only the answer.

## The board file

```json
{
  "updated": "24 Nov 15:45",
  "waiting": [
    {
      "id": "ci",
      "title": "Tests keep getting stuck: cancel the stuck runs and merge the fix?",
      "note": "The worker found the cause and built a fix (52 lines, tested). Pick: yes.",
      "link": "https://github.com/acme/app/pull/42",
      "linkLabel": "PR #42"
    }
  ],
  "review": [],
  "working": [],
  "handled": []
}
```

| List | What belongs in it | Shown |
| --- | --- | --- |
| `waiting` | Needs your decision | first 12, with Open and Answer |
| `review` | Finished work for you to look at | first 5, with Open and Answer |
| `working` | In flight, nothing needed from you | first 6 |
| `handled` | What the coordinator did for you | first 6, dimmed |

Only `title` is required on an item. `id` is the short name you type back.
A file that is half-written or not valid JSON is skipped, and the pane keeps
the last good board.

## Options

Every option has a default that works. Set them in the config menu, or in
your user settings:

```json
{
  "pluginConfigs": {
    "chief-of-staff-board@claude-code-mods": {
      "options": {
        "boardFile": "~/chief-of-staff/board.json",
        "slackTeamId": "T0EXAMPLE"
      }
    }
  }
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `boardFile` | empty | Where the board file is. Empty means `board.json` in the folder the session starts in. `~/` is your home folder. Set a full path to see the same board from every session |
| `slackTeamId` | empty | Your Slack workspace id (it starts with `T`). When set, a Slack link opens in the Slack app at the thread. When empty, it opens in the browser |
| `pollSeconds` | `5` | How often the pane re-reads the file |

## How it works

| Event | What it does |
| --- | --- |
| `session.start` | Works out the board file's path, registers `/board` and `/board-setup`, starts the re-read timer, and opens the pane if the file exists |
| `command.run` | `/board` reopens the pane. `/board-setup` creates the starter file and fills the prompt box |
| `ui.render` on `Pane` | Draws the four lists from the last good read |

It reads one file and never starts a turn. The only file it writes is the
starter `board.json`, and only when `/board-setup` finds none. Open runs your
system's opener (`open`, `xdg-open`, or the Windows equivalent) and only for
`http`, `https` and `slack` links. Does nothing in `-p` / SDK sessions.

## Layout

```
hooks/register.tsx   the hooks and the JSX
hooks/board.ts       everything with no UI in it: parsing, paths, links, the
                     setup prompt. Imports nothing
types/index.d.ts     the state contract
test/board.test.mts  checks on board.ts, on bare Node
```

## Test it

```bash
node --experimental-strip-types plugins/chief-of-staff-board/test/board.test.mts
claude plugin validate plugins/chief-of-staff-board
claude --plugin-dir plugins/chief-of-staff-board
```
