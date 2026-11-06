# prompt-bouncer

A Claude Code mod that stops vague prompts before Claude sees them. When a prompt says "the thing" or "the payments page" and the project calls it something else, the mod drops it, tells you why, and suggests the project's own word.

![prompt-bouncer: on the left "the payments page shows the wrong price, fix it" is bounced with a toast saying this project calls that the Billing Panel; on the right the same request in the project's words goes straight through and Claude answers](screenshot.png)

A vague prompt costs a whole turn of Claude guessing, and a wrong guess stays in the context and sometimes in your files. This mod checks every prompt at `prompt.submit`, the moment you press Enter. A bounced prompt never reaches the model, costs no tokens, and goes back in the prompt box for you to fix.

In -p / SDK sessions the drop still applies, but no status line or bounce toast is drawn.

- **Quick mode** (the default) uses no model and is instant. A short prompt that leans on "the thing", "stuff" or "that bug", or a bare "it" on the first prompt of a session, and names no file, feature or component, is bounced.
- **Project mode** reads the project's own docs (`CLAUDE.md`, `docs/glossary.md`, decision records, specs) and asks Haiku whether the prompt is specific and uses the project's terms. If not, the toast suggests the right one: "This project calls that the Billing Panel. Is the wrong price in the plan display or an invoice?"
- `/force <prompt>` sends anything past it. Slash commands always pass.

It never sends anything to Claude itself. The reason and the suggestion are for you only.

![Quick mode bounces "fix the thing" with no model call; on the right, /force sends a prompt past the bouncer and Claude answers](images/quick.png)

![How it works: you press Enter, the prompt.submit hook picks quick or project mode, project mode reads the docs with $.fs and asks Haiku, and the verdict either drops the prompt or lets Claude have it](images/how-it-works.png)

## Install

```
claude plugin marketplace add ray-amjad/claude-code-mods
claude plugin install prompt-bouncer@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add ray-amjad/claude-code-mods`, then `/plugin install prompt-bouncer@claude-code-mods`.

A line under the prompt shows the mode it's in: `⚠ prompt-bouncer: quick mode`.

## Usage

- Type as usual. A bounced prompt shows a toast, a `Prompt dropped by a hook` line in the transcript, and comes back in the prompt box.
- `/force <prompt>` sends the prompt as your own words, unchecked.
- `/bouncer` shows the mode and which docs it found. `/bouncer quick`, `/bouncer project` or `/bouncer off` switch it for this session.
- In `claude -p`, a prompt starting with `!` passes too (the `!` is removed). In the interactive prompt box `!` is shell mode, so use `/force` there.

### Try project mode

The [`example/`](example) folder is a tiny invoicing app with a glossary (Billing Panel, Plan Switcher, Dunning Run, Seat Ledger), each term with a "Not" column of loose words people use for it:

```
cd example
claude
/bouncer project
```

Then try `the payments page shows the wrong price, fix it`, `add a CSV export to the members table` or `make the retry thing run more often`, and compare with `The Billing Panel shows the wrong plan price`.

## Settings

| Option | Default | What it does |
| :- | :- | :- |
| `mode` | `quick` | `quick` or `project`. Set it with `/plugin configure prompt-bouncer@claude-code-mods`. |
| `docs` | `CLAUDE.md,docs/glossary.md,docs/decisions/*.md,specs/*.md,docs/specs/*.md` | The files project mode reads, comma-separated, from the folder Claude Code runs in. A `*` matches file names inside one folder. |
| `maxDocChars` | 20000 | Docs past this many characters are cut, so the check stays cheap |
| `PROMPT_BOUNCER_MODE` (env) | unset | Overrides `mode` for one session: `PROMPT_BOUNCER_MODE=project claude` |

## How it works

- One hook on `prompt.submit` judges prompts a person typed. Notifications, scheduled prompts and messages from other sessions pass.
- Quick mode is a few regular expressions: a vague noun phrase, or a bare pronoun on a session's first prompt, with nothing concrete named (a file, a path, code in backticks, a quoted name, `CamelCase`, `snake_case`, a Capitalized Name). Prompts over 15 words pass.
- Project mode reads the docs fresh with `$.fs` on every prompt, then makes one `$.model.complete` call to Haiku with the docs as a cached prefix and the prompt after them. Haiku answers JSON: `{ "pass": true }` or a reason and a suggestion. A glossary with a "Not" column of loose words works best, because it tells Haiku exactly what to catch. Nothing is extracted or stored.
- To bounce, the hook returns `{ drop: reason }`, so the prompt never enters the session. Claude Code puts the prompt back in the box itself.
- It fails open: if the hook throws, Haiku is down or its answer isn't JSON, the prompt goes through. A broken bouncer should never lock you out.
- `/force` can't submit from inside its own command (it would wait on its own turn), so a timer submits it a moment later with `$.prompt.submit({ asUser: true })`.

## Limits

- Project mode adds a few seconds to each prompt (one Haiku call). Quick mode adds nothing.
- Haiku is judging, so expect the odd miss or the odd bounce you disagree with. `/force` is there for that.
- Quick mode is English only, and its word lists are short.
- `docs` patterns support `*` inside one folder (`docs/decisions/*.md`), not `**`.
- `/bouncer` mode switches last for the session and reset if the mod reloads.

## Develop

```
claude --plugin-dir ./prompt-bouncer
claude plugin validate .
claude plugin test .
```

Tested with Claude Code 2.1.296.
