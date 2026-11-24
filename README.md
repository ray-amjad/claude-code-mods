# claude-code-mods

Mods for Claude Code: panes, bands above the prompt, prompt guards, secret handling and memory tools. Each one is a plugin with a hooks module that runs inside the session, so it can see every event as it happens, change it, and draw in the terminal.

Every mod installs on its own. Pick the ones you want.

## Install

This repo is a plugin marketplace. Install any mod with one line:

```
/plugin install <mod> --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope. Or add the marketplace once and install from it:

```
/plugin marketplace add ray-amjad/claude-code-mods
/plugin install cache-clock@claude-code-mods
```

## The mods

| Mod | What it does |
| --- | --- |
| [cache-clock](plugins/cache-clock) | A one-line band above the prompt: context used, and a countdown until the prompt cache goes cold. |
| [chief-of-staff-board](plugins/chief-of-staff-board) | A side pane for a coordinator session: what is waiting on you, ready for review, in flight and handled, drawn from a JSON file your coordinator agent keeps current. |
| [decision-tree](plugins/decision-tree) | When Claude ends a reply with a question, explains the choice in a side pane and lets you explore any option, or your own, in a real forked session. |
| [diagram-pane](plugins/diagram-pane) | A side pane that pins every diagram Claude draws, keeps a live map of the work, and lets you go into boxes and change them. |
| [dream-pass](plugins/dream-pass) | A dreaming pass over Claude's memory folder: merges duplicates, rewrites stale entries, removes dead ones and tidies MEMORY.md, with a backup and undo. |
| [jev-skill-suggestion](plugins/jev-skill-suggestion) | Scores every skill against your prompt with TypeSafe Jev as you type. Observe, block or steer which skill loads. |
| [memory-fork](plugins/memory-fork) | Keeps auto-memory up to date in the background: after each turn Haiku decides whether memory needs a change, and a tool-less fork of the session drafts it. |
| [prompt-bouncer](plugins/prompt-bouncer) | Bounces vague prompts before Claude sees them, and suggests the project's own term. |
| [secret-box](plugins/secret-box) | Claude uses a secret without seeing it: a masked box saves keys to `.env`, Claude gets a placeholder, and committing `.env` is refused. |
| [transcript-redactor](plugins/transcript-redactor) | Keeps secrets out of the session transcript: each one becomes a stable placeholder, and the real value goes back in on the way into a tool call. |
| [vercel-deploy-status](plugins/vercel-deploy-status) | Pins the Vercel deploy queue of the linked project under the prompt, with each deploy's phase and elapsed time. |

Each mod's README shows it running, explains how it works, and lists its options.

secret-box already includes transcript-redactor. Run one or the other, not both.

## Work on a mod

Run a mod from its folder without installing it:

```bash
claude --plugin-dir plugins/<mod>
```

Check it before you push:

```bash
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```

## License

MIT. See [LICENSE](LICENSE).
