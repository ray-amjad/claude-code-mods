# transcript-redactor

A Claude Code mod that keeps secrets out of the session transcript without taking them away from Claude. Every key that reaches the conversation (pasted, printed by a tool, sitting in a file) is swapped for a placeholder like `[REDACTED-SECRET-5c1e9a7b]`. Claude works with the placeholder, and it turns back into the real key when a command runs on your machine.

![transcript-redactor: on the left a prompt with a pasted key arrives as a placeholder, a curl command uses the placeholder, and a Read of config/prod.json shows the key as a placeholder with a toast saying 1 value was hidden; on the right the vault, and four steps: scan, swap, restore, forget](screenshot.png)

A key that reaches the conversation is in the transcript for good. It is sent to the model on every turn after, kept in the session file on disk, and replayed into every fork and every subagent. You can't take it back, so the only fix is to never let it in. Keys get in more ways than you'd think: you paste one, a tool prints one (`cat .env`, a config file, an API answer), a file you `@` mention holds one, or CLAUDE.md does.

- **Placeholders on the way in.** A key in your prompt, in CLAUDE.md, in an `@` file or in a hook's context is swapped before Claude reads it.
- **Placeholders on the way out.** Every tool result is scanned before Claude sees it. A `cat .env` shows `PORT=3000` and a placeholder for the key.
- **Real values where they run.** When Claude writes a placeholder into a `Bash` command or a file, the mod puts the real key back first, so `curl -H "Authorization: Bearer [REDACTED-SECRET-5c1e9a7b]"` really authenticates.
- **The same key, the same placeholder.** Claude can still tell two keys apart, and you can still say "use the Stripe key".
- **Memory only.** The vault lives in the mod for the session and is never written to disk.

![The round trip: Claude writes a command with a placeholder, the hook restores the real key, the shell runs it; the tool prints the key, the hook swaps it for the placeholder, Claude reads the placeholder](images/round-trip.png)

## Install

```
claude plugin marketplace add ray-amjad/claude-code-mods
claude plugin install transcript-redactor@claude-code-mods
```

Or inside Claude Code: `/plugin marketplace add ray-amjad/claude-code-mods`, then `/plugin install transcript-redactor@claude-code-mods`.

## Usage

There is nothing to call. Once installed it runs on every turn.

- A tool row says `transcript-redactor: hid 1 value(s)` when something was swapped in a result.
- A toast says the same when a key was swapped out of your prompt.
- Ask Claude to use a key by its placeholder or its name. It never needs the value itself.

### Try it

`test/sample-env.mts` prints a fake `.env` built at run time: fake keys, a database URL with a password, a port and an email.

```
node --experimental-strip-types test/sample-env.mts > /tmp/sample.env
claude
```

Then ask `cat /tmp/sample.env and repeat the values back to me`. The port and the email come back as they are. The two keys and the database password come back as placeholders. Ask `how long is the Anthropic key? use the placeholder` and Claude gets the real length from the shell.

## What it hides and what it keeps

![Hidden: vendor keys such as sk-ant-, sk_live_, ghp_, AKIA and about 60 more, a password after a key name, the password in a postgres URL, Bearer and curl -u values, session cookies and Basic auth, private key blocks, base64 that hides a key, a key it hid once wherever it appears again, and high-entropy tokens. Kept: git SHAs and checksums, file paths and IP addresses, public ids such as price_ and pk_live_, names in code, UUIDs and session ids, images and PDFs in data URIs and attachments, mail headers, and email addresses unless pii is on](images/hidden-kept.png)

A value is hidden when it passes one of these tests:

1. **A vendor shape.** About 70 known key formats (`sk-ant-`, `ghp_`, `AKIA`, `sk_live_`, `whsec_`, `AIza`, `xoxb-` and the rest), a JWT, a Slack or Discord webhook, a `PRIVATE KEY` block, the password in a `postgres://user:pass@host` string, and passwords on CLI flags like `sshpass -p` and `redis-cli -a`.
2. **A short prefix and a long random body.** `imp_` plus 40 characters of lower case and digits, and keys like it from services the list doesn't name yet.
3. **Entropy and mixed case.** A token of 24 characters or more with lower case, upper case and digits, above 3.6 bits per character.
4. **Base64 that hides a key.** A blob (a Kubernetes secret, a GitHub contents answer, a mail attachment) is decoded, and if a key is inside, the whole blob becomes one placeholder.
5. **Entropy and a name.** A shorter token, above 3.0 bits per character, right after `API_KEY=`, `"token":`, `Authorization:`, `password:` and the like, or in a sibling field (a HAR header's `name` and `value`, a Kubernetes `- name:` entry).

And kept, because hiding it would only add noise:

- **Public ids.** Stripe object ids (`price_`, `prod_`, `cus_`, `pk_live_`) and YouTube channel ids are printed in dashboards and code.
- **Names.** `lesson_article_outline_open_v1` and `randomTimestampWithinLast14Days` read as high entropy, but a key isn't built out of words.
- **Alphabets.** A long token that uses every character once is a charset constant.
- **MCP tool names.** `mcp__<server>__<tool>` is judged one part at a time, so a server name holding a UUID doesn't hide the tool from Claude. A random part is still hidden.
- **Bare hex.** A 40-character hex run is a git SHA far more often than a key, so it only counts when a key name sits in front of it.

With `pii` on, public IPv4 addresses and full-form IPv6 addresses are hidden. Email addresses are hidden too unless `hideEmails` is `false`, except `noreply@`, documentation domains like `@example.com`, and anything in `allowEmails`.

## Settings

Set them with `/plugin configure transcript-redactor@claude-code-mods`, or under `pluginConfigs` in your user settings.

| Option | Default | What it does |
| :- | :- | :- |
| `secrets` | `true` | Hide secrets |
| `pii` | `false` | Hide email addresses and public IP addresses |
| `hideEmails` | `true` | With `pii` on, also hide emails; turn off to hide only IPs |
| `redactPrivateIps` | `false` | With `pii` on, also hide private and reserved IPs recognized by the detector |
| `restoreInToolInputs` | `true` | Turn placeholders back into real values before a tool runs |
| `restoreTools` | `Bash,Write,Edit,MultiEdit,NotebookEdit` | The tools that may receive a real value. Tools that send data off the machine (`WebFetch`, MCP tools) are left out on purpose |
| `notify` | `true` | A count on the tool row, a toast on a prompt |
| `minEntropy` | `3.6` | Bits per character for the mixed-case test. Raise it to hide less |
| `minLength` | `24` | Shortest token the mixed-case test looks at |
| `contextMinEntropy` | `3.0` | The floor when a key name sits in front |
| `allow` | empty | Exact strings never to hide, comma separated |
| `allowEmails` | empty | Addresses or `@domain.com` never to hide |
| `allowPrefixes` | empty | Extra id prefixes to treat as public |
| `allowUrlHosts` | empty | Hosts (`app.todoist.com`, `localhost:3000`, `*.example.com`) whose link paths are kept as written. A host covers itself only; `*.` covers its subdomains. The query string and fragment are still scanned, and a vendor-shaped key in the path is still hidden. Don't list a host that puts credentials in the path (Slack webhooks, Telegram bot links, presigned links): a random-looking secret there would be kept too |
| `denyPrefixes` | empty | Prefixes to test even though they look like a public id |

## How it works

Six hooks, one vault.

| Hook | What it does |
| :- | :- |
| `prompt.submit` | Swaps keys out of what you type, and out of context a hook attached to it |
| `prompt.context` | Swaps keys out of CLAUDE.md and the other blocks sent with the first message |
| `tool.call` | Restores placeholders in the input (only for `restoreTools`), runs the tool, then swaps keys out of the result |
| `prompt.attachment` | Swaps keys out of text the engine adds on its own: a changed file's diff, a nested CLAUDE.md, a queued prompt |
| `prompt.mention` | Refuses an `@` file that holds a key, because its raw text is stored before any hook sees it, and tells Claude to `Read` it instead |
| `agent.spawn` | Swaps keys out of a subagent's task |

- **The vault** maps each value to a random placeholder, reused only within the session. Tags use `crypto.getRandomValues` when available, with `Math.random` as the fallback, so a placeholder can't be worked back to its value or matched across sessions.
- **Placeholders already in a file.** If a file Claude reads holds text shaped like a placeholder, it comes back as a `[REDACTED-LITERAL-…]` placeholder that restores to that text, so a crafted file can't trick the mod into writing a real key somewhere.
- **Fail closed.** Every hook has a `.catch`. If a scan breaks, or would run past the hook's 10 second budget, the result is withheld, the prompt isn't sent or the subagent isn't started. Nothing goes through unscanned.
- **Restored values stay hidden.** A value the mod restores into a command is hidden again if that command prints it, even a short one the detector would miss.
- **Results it can't rewrite.** A result that holds a key in a part the mod can't rewrite is withheld whole, with a note to narrow the call.

## Limits

- **It hides what Claude reads, not what Claude does.** With a placeholder Claude can still run a command that transforms the key (`base64`, `rev`) or sends it somewhere, and the transformed output isn't recognized. This stops keys landing in the transcript by accident. It is not a sandbox against a model trying to leak one.
- **A key with no shape and no name is missed.** A plain word password with nothing like `password=` beside it looks like text.
- **`Bash` restores anywhere in the command.** A placeholder Claude writes into a `curl` to any host is sent as the real key. Take `Bash` out of `restoreTools` if you'd rather it never was.
- **No restore when publishing.** A command that runs `git commit`, `git tag` or `gh issue`, `gh pr`, `gh release` (and the like) gets no real values, so a commit message or an issue body keeps the placeholder. A step that needs the key has to be its own command.
- **Files Claude writes get the real value.** A placeholder in a note Claude writes with `Write` or `Edit` lands on disk as the key, and in git if that file is committed.
- **Base64 is checked up to 1 MB,** and PDFs and zip files (docx, xlsx) are treated as media and not decoded.
- **Workflow agents.** A workflow agent's prompt can't be rewritten, so one that holds a key is refused, and a false positive stops that step.
- **The vault is memory only.** Placeholders from an earlier session mean nothing in a new one.
- Mods only load in a folder you have trusted.

## transcript-redactor or secret-box?

[secret-box](../secret-box) is this mod plus a way to hand Claude a new key: a masked box that saves it to `.env`, `.env` values hidden by name, and a guard that refuses to commit `.env`. Run one or the other, not both.

## Develop

```
claude --plugin-dir ./transcript-redactor
claude plugin validate .
claude plugin test .
node --experimental-strip-types test/detect.test.mts
node --experimental-strip-types test/session-privacy.test.mts
node --experimental-strip-types test/random-tags.test.mts
node --experimental-strip-types test/pii-options.test.mts
```

`test/detect.test.mts` holds two lists, 176 values that must be hidden and 117 that must be kept, and times the scan on large inputs. A change to a pattern or a threshold is only done when both lists still pass. `tests/redact.test.ts` covers the hooks: restore, scrub and fail closed.

Tested with Claude Code 2.1.296.

## Original redactor contributions

Random placeholder tags were contributed by [Ben Ellis (@benissimo)](https://github.com/ray-amjad/claude-code-mods/pull/1). The `hideEmails` option was contributed by [Cody Harris (@VibeCodyH)](https://github.com/ray-amjad/claude-code-mods/pull/2). Both implementations are adapted to this mod's current vault and hooks.

To keep emails readable while hiding public IPs, set `pii: true` and `hideEmails: false`. PII hiding remains off by default. The restored IP detector recognizes IPv4 and full-form IPv6; compressed IPv6 is not comprehensively covered.
