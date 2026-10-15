# anvil

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code 2.1.296+](https://img.shields.io/badge/Claude%20Code-2.1.296%2B%20mod-d97757.svg)](https://docs.claude.com/en/docs/claude-code)

English | [简体中文](README.zh-CN.md)

**A Claude Code mod that keeps long sessions cheap.** It keeps your prompt cache warm while you're away, stops the one message that would rebuild a cold cache, and draws one line above the prompt with where you are and how much of your plan is left.

<p align="center">
  <a href="#install">Install</a> · <a href="#features">Features</a> · <a href="#getting-started">Getting started</a> · <a href="#configure">Configure</a> · <a href="#faq">FAQ</a> · <a href="#development">Development</a>
</p>

## Features

- **Cache keepalive.** When a session with a large context sits idle, anvil sends one background request shortly before the prompt cache expires. The request reads the cache, stays out of the transcript, and keeps your next message from paying for a full rebuild. It runs for up to 12 hours per idle stretch.
- **Cold-send guard.** If the cache has already expired and the context is large, anvil holds back your next message once and tells you what sending it will cost (tokens and an API-price estimate). Press Enter again to send it, or `/clear` to start fresh.
- **A line above the prompt.** Directory · git · 5-hour usage · 7-day usage · session cost. Git shows the branch with ahead/behind, a paused merge or rebase, conflicts, staged, modified, untracked, stashes and uncommitted lines. Each usage window has a 10-cell heat bar, the percentage and its reset time.
- **Each reply's speed.** Output tokens per second and time to first token (TTFT) are added to the end of Claude Code's "Worked for …" line.

Model, effort, context and the cache's real expiry belong to the line below the prompt, your own [status line](#the-line-below-the-prompt). anvil writes its keepalive state to a small file the status line can read.

## Requirements

- **Claude Code 2.1.296 or later** (tested on 2.1.299). Mods are an early-access Claude Code feature and their API can change between releases.
- **A [Nerd Font](https://www.nerdfonts.com/)** in your terminal, for the icons.
- **A Claude subscription** (Pro or Max) is what the keepalive is designed for: anvil assumes the main session's 1-hour cache TTL, which only holds on a subscription.

## Install

Inside Claude Code:

```
/plugin install anvil --marketplace Mistakey/anvil
/reload-plugins
```

<details>
<summary><strong>Step by step, from the terminal, or from a clone</strong></summary>

Add the marketplace, then install from it:

```
/plugin marketplace add Mistakey/anvil
/plugin install anvil@anvil
```

From the terminal:

```sh
claude plugin marketplace add Mistakey/anvil
claude plugin install anvil@anvil
```

Or load it straight from a clone, for one session:

```sh
git clone https://github.com/Mistakey/anvil
claude --plugin-dir ./anvil
```

</details>

The installer may say config options aren't set; the defaults are fine, and [`/config`](#configure) changes them.

## Getting started

### 1. Read the line above the prompt

| Part | Shows |
| --- | --- |
| directory | the repository's name (bold), a linked worktree's name, the subdirectory you're in; outside git, the session's directory |
| git | branch, `↑` ahead and `↓` behind, `no upstream`, a paused `merge` or `rebase 2/5`, `=` conflicts, `+` staged, `!` modified, `?` untracked, stashes, uncommitted `+lines −lines` |
| 5h, 7d | a 10-cell heat bar, the percentage used, and the reset time (`22:00`, or `09:00 10-15` on another day); `—` until the window starts |
| cost | the session cost Claude Code reports (`/cost`) |

Git is re-read after each reply, after a tool that changes files or runs commands, and when you send a message. At session start the usage readings take a few seconds to arrive; until then anvil shows the last readings any of your local sessions saw. When the terminal is narrow, names shorten first, then the bars go, then git keeps only the branch, then the cost and git go; the reset times stay.

### 2. Commands

| Command | Does |
| --- | --- |
| `/anvil` | list the subcommands and their current state |
| `/anvil keepalive` | turn the keepalive off or on for this session, regardless of the threshold |

A new session starts from the defaults you set in `/config`.

### How the keepalive works

- anvil estimates the cache's expiry itself: the last main-session request plus 1 hour.
- When a session's context reaches the threshold (50k tokens by default) and it goes idle, anvil waits 50 minutes and sends one background request (`$.model.fork`) that asks for a one-word reply. It doesn't enter your transcript.
- Each request checks its own usage: if it read close to the whole context and wrote little, the cache counts as renewed and the next request is scheduled. Otherwise the keepalive stops: no cache read, too much written, an error, or 12 hours idle. `/anvil` shows why.
- Stopping only ends the current idle stretch. Once you send a message, the next idle stretch is kept warm again.
- Each request costs about one read of the whole context plus a few output tokens, counted against your plan. Claude Code has to stay open.
- Quitting Claude Code stops the keepalive. When you resume the session later (`claude --resume`, `/resume`), anvil starts from the expiry it recorded, renewals included; the resume info Claude Code provides counts only from the last reply and would call a renewed cache expired.

### How the guard works

- When the cache has expired and the context is at or above the threshold, anvil drops your next message once, puts it back in the prompt, and shows a line like: *anvil: the cache expired 1h10m ago; sending this message rebuilds 152k tokens (~$3.04). …*
- Press Enter again to send it, or use `/clear` if you don't need the old context.
- Slash commands and messages sent by plugins pass straight through. Nothing is blocked right after a compaction or a `/clear`.

### The line below the prompt

The status line is your own script ([`statusLine`](https://docs.claude.com/en/docs/claude-code/statusline) in your settings); Claude Code hands it the model, effort, context and the cache's real state (`prompt_cache`: `hit_ratio`, `warm`, `expires_at`). What it can't know is whether anvil will renew the cache, so anvil writes that for every session to:

```
~/.claude/anvil/sessions/<session_id>.json        # under CLAUDE_CONFIG_DIR when it is set
{ "renews": true, "error": null, "expiresAt": 1791998610193, "at": 1791995010193 }
```

`session_id` is the one in the status line's input. `renews` is true while the keepalive is on and hasn't stopped; `error` is the reason it stopped on a failed renewal (12 hours idle isn't an error); `expiresAt` is anvil's estimate of the expiry (Unix milliseconds, renewals included), which anvil reads back itself when the session is resumed. anvil only writes these files; clean up the ones older than a week from your script if you like. With it, a cache segment can read `󰆼 94% · valid · renewing`, `󰆼 94% · valid until 21:40` or `󰆼 94% · expired 21:40`, colored by state: green when it will renew, yellow when it lasts only until a set time, red once expired.

## Configure

Run `/config` and open anvil's options:

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | `50000` | context size in tokens at which the keepalive turns on by itself and the guard starts guarding |
| `autoKeepalive` | `true` | turn the keepalive on by itself for sessions at or above the threshold; `/anvil keepalive` still toggles it per session |
| `guard` | `true` | hold back the first message after the cache has expired |

## What it touches

| It does | Through |
| --- | --- |
| reads session events: requests and their usage, subagents starting and ending, tool calls, messages you send | the mod hooks |
| sends the keepalive request | `$.model.fork`, only while a session is idle |
| runs `git` in the session's directory, read-only (`--no-optional-locks`) | `$.process.run` |
| keeps recent 5h and 7d readings, shared by your local sessions | `$.store` |
| writes the keepalive state for your status line | `~/.claude/anvil/sessions/` |

Nothing leaves your machine except the keepalive request. `claude plugin validate .` prints every hook and call the mod makes.

## FAQ

**The line above the prompt doesn't appear.**
It gives way while Claude Code shows a survey there, and `ctrl+x ctrl+a` collapses it. If it still doesn't show, look in the transcript for a line from Claude Code that names a failed anvil hook, and [open an issue](https://github.com/Mistakey/anvil/issues) with it.

**The icons show as boxes or question marks.**
Your terminal font isn't a Nerd Font. Install one and select it in the terminal's settings.

**Does the cache state match what Claude Code itself tracks?**
The keepalive and the guard work from anvil's own estimate: a mod can't read Claude Code's cache tracker, so anvil works from request times and usage. Requests anvil doesn't see (another plugin's fork, Claude Code's built-in keepalive) can make it conservative: at worst the guard warns once too often or the keepalive sends one extra request. Your status line gets Claude Code's real figures.

**Does it work on an API key, or with a 5-minute cache?**
The line above the prompt does (5h and 7d stay at `—` without a subscription). The keepalive and the guard assume the 1-hour TTL of a subscription.

**Why are the dollar amounts in the guard API prices if I'm on a subscription?**
How cache reads and writes count against subscription limits isn't documented, so API prices are the only comparable measure. The cost above the prompt is the figure Claude Code reports (`/cost`).

**My organization manages Claude Code.**
Under managed settings, Claude Code doesn't deliver `classic.SessionStart` and `session.compact` to plugins a person installs. There, the cache estimate doesn't pick up a resumed session or a compaction, unless your organization lists anvil in managed settings.

## Development

The repository is the plugin: `.claude-plugin/plugin.json` is the manifest and `hooks/register.ts` is the entry. Claude Code loads the TypeScript directly; there's no build step.

```sh
claude --plugin-dir .              # load it; saving a file hot-reloads
claude plugin validate .           # hooks, calls, and anything Claude Code would reject
claude plugin test .               # run tests/*.test.ts
npx -p typescript tsc -p .         # type-check
```

Type declarations for the current Claude Code build are generated into `.claude-plugin/types/` the first time the plugin loads in an interactive session. Without one, generate them with `CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --plugin-dir . -p "ok" --model haiku --max-turns 1`.

[`CONTEXT.md`](CONTEXT.md) defines the terms, [`AGENTS.md`](AGENTS.md) collects the conventions and the known pitfalls of the mods API, and [`docs/adr/`](docs/adr) records the design decisions. These are in Chinese.

## Acknowledgements

- [Flightdeck](https://github.com/scasella/claude-flightdeck) by Stephen Casella: the module layout and merging stored state onto its defaults.
- [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal: the cache estimate, the keepalive loop and the cold-send guard.

Both are MIT-licensed. [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) lists what anvil adapted from each and reproduces their licenses.

## License

[MIT](LICENSE)
