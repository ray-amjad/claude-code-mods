# diagram-pane

A Claude Code mod that opens a side pane with a live picture of the work: every diagram Claude draws, pinned and readable, and a small map of what Claude is doing right now.

![diagram-pane: Claude adds a discount module on the left; on the right the pane has gone into the checkout.js box, its numbered steps drawn as boxes, with a change being typed into the field below](screenshot.png)

Claude explains things with mermaid charts, but in a terminal you only see the raw code, and it scrolls away. Meanwhile the shape of the work (which files, which steps, what connects to what) lives only in Claude's context. This pane shows you both.

Does nothing in -p / SDK sessions, unless `DIAGRAM_PANE_SYNC` or `DIAGRAM_PANE_DUMP` is set (see below).

- **Pinned diagrams.** Whenever a reply has a mermaid code block or an ASCII box diagram, it is pinned in the pane, newest first. Mermaid flowcharts are redrawn as boxes and arrows that fit a 60 column pane.
- **Live work map.** Every few turns (and on `/diagram`) a cheap Haiku call asks whether the work changed shape. Only on yes does a fork of the session return a small graph of the files, components and steps it is working on, and the pane draws it. The node Claude is on right now is marked `▶`.
- **Go into a box.** Boxes are numbered. Press a number to open that box's detail: a mermaid `subgraph` opens at once, and any other box gets a detail drawn by a fork of the session. `b` goes back, `t` to the top. A box marked `▸` already has a detail.
- **Change a diagram.** Press `c` (or Tab to the field) and type a change into the field under a diagram ("split auth into login and token refresh") and a fork redraws it. Or ask Claude: it reads and edits the pane with two tools, `diagram_get` and `diagram_set`.
- Square boxes are files, round ones components, double ones steps or decisions.

Claude sees the pane only through those two tools.

![A mermaid chart in Claude's reply on the left, the same chart drawn as boxes and arrows in the pane on the right](images/pinned.png)

![A plain question: the Haiku gate says the work kept its shape, so the map stays and no fork runs](images/gate.png)

![Claude is asked to add a receipt step: it calls diagram_get and diagram_set, and the map in the pane gains the step and is marked edited](images/tools.png)

## Install

```
claude plugin marketplace add ray-amjad/claude-code-mods
claude plugin install diagram-pane@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add ray-amjad/claude-code-mods`, then `/plugin install diagram-pane@claude-code-mods`.

The pane opens on its own in a terminal 144 columns or wider. Narrower than that, type `/diagram` once and it opens at any width. With fullscreen rendering it docks beside the transcript; in the classic renderer it sits above the prompt.

## Usage

- Ask for a diagram (`explain the checkout flow with a mermaid flowchart`) and it is pinned when the turn ends.
- `/diagram` runs the gate now and redraws the map if the work changed. `/diagram force` skips the gate and draws the map from scratch, dropping edits.
- `/diagram open` gives the pane the keyboard, so number keys work at once. Clicking the pane, or ctrl+x tab, does the same; Esc hands the keys back to the prompt.
- Ask Claude to change what you are looking at: "add the NAT gateway to the network box", "move the cache under the API layer". It calls `diagram_get`, then `diagram_set`, and the pane shows the changed level.

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `everyTurns` | 3 | Turns between work-map checks. Set it with `/plugin configure diagram-pane@claude-code-mods`. |
| `maxPins` | 5 | How many pinned diagrams the pane keeps |
| `DIAGRAM_PANE_EVERY` (env) | unset | Overrides `everyTurns` for one session, handy for a demo: `DIAGRAM_PANE_EVERY=1 claude` |

## How it works

- On `turn.complete` it reads the transcript (`$.session.messages()`) and pins any new mermaid or ASCII diagram it finds in Claude's replies.
- Every N turns the gate runs: `$.model.complete` on Haiku with the current map, the files touched since that are not on it, and a digest of tool calls. It answers YES or NO.
- On YES, `$.model.fork` asks the session itself for `{ title, nodes, edges }` as JSON. A fork sees the whole conversation but cannot call tools, so it is cheap and served mostly from the prompt cache.
- `hooks/draw.js` lays out both mermaid charts and the map the same way: layers top to bottom, boxes wrapped to the pane's width, connectors drawn with box characters.
- A box's detail is stored inside it (`sub`), so the whole map is a tree. `hooks/graph.js` walks it, patches it, and writes it back out as mermaid with each detail as a `subgraph`, which is what `diagram_get` returns.
- Opening a box with no detail forks the session with the level it sits on and asks for the inside as the same JSON. The detail's ids are renamed where they clash with the rest of the tree, since mermaid ids are global.
- `diagram_set` takes a target (`view`, `map` or `pin:N`), a `path` of node ids to go down, and either a whole `mermaid` flowchart for that level or `ops` (`add_node`, `remove_node`, `relabel`, `set_kind`, `add_edge`, `remove_edge`). Boxes that keep their id keep their details.
- An edited map is marked `edited`. The next refresh hands the fork the current map and asks it to keep those edits, and boxes that keep their id and label keep their details.
- The map, the edited pins and the open view are saved per session in `$.store`, so they survive a hot reload or `--resume`. Pins are rebuilt from the transcript, with edits laid back over them.

## Limits

- Only mermaid `graph` and `flowchart` charts are redrawn. Sequence, class, state and other types are pinned as raw code. `diagram_set` with mermaid, or a typed change, can turn one into a flowchart.
- Number keys reach the first nine boxes of a level; Tab or a click reaches the rest. Pinned diagrams on the home view are drawn without numbers: open a pin first to go into its boxes.
- A fork cannot call tools, so a detail it draws holds only what the session has already seen.
- Edges between boxes in different subgraphs are drawn to the subgraph's box on the level where both ends show; inside a subgraph, edges that leave it are not shown.
- Every chart is drawn top to bottom, even `graph LR`, because a narrow pane has no room sideways.
- Edges that skip a row or point back up are not routed. They are listed under the drawing with `⇢` and `↺`. A row too wide for the pane wraps, and edges into the wrapped part are listed the same way.
- ASCII diagrams are only picked up from plain code blocks (no language, or `text`), and shown as written.
- The map check runs after a turn ends, not while Claude is working. Before the first reply there is nothing to fork, and `/diagram` says so.
- The map, edits and view are saved per install: moving the plugin to another marketplace or reinstalling it starts with no saved maps. A session that already has `everyTurns` turns of work gets a fresh map at its next turn or `diagram_get`, without waiting.
- `/clear` starts the pane fresh: the old session's map, pins and view are dropped (its saved map stays under its own id for `--resume`), and a map or detail fork still running from before `/clear` is discarded.
- The map is the model's own summary of the work, so it can include a step such as "run tests" beside the files.

## Develop

```
claude --plugin-dir ./diagram-pane
claude plugin validate .
claude plugin test .
```

For headless runs, `DIAGRAM_PANE_SYNC=1` waits for the gate and fork before the turn ends, and `DIAGRAM_PANE_DUMP=<file>` writes the pane's text to a file.
