---
name: statusline
description: Set up or change the status line under the prompt that goes with anvil (model and effort, context, prompt cache with anvil's keepalive state), starting from anvil's reference script.
disable-model-invocation: true
---

# anvil status line

anvil draws two lines around the prompt. The line **above** it (folder, git, 5h, 7d, cost) is drawn by anvil's own code. The line **below** it is the user's Claude Code `statusLine` script. This skill writes that script with the user, starting from the reference script next to this file (`statusline.mjs`). If the user doesn't ask for changes, install it as it is.

Speak the user's language. Your job is to agree on the result with them, so show previews and ask; don't just dump the script.

## Hard rules

1. **Data boundary.** The model, effort, context and the real cache state (`prompt_cache`: `hit_ratio`, `warm`, `expires_at`, `requests`, `misses`, …) come only on the status line's stdin. anvil can't see them, so they belong on this line. Whether the cache **renews automatically**, whether a renewal **failed**, and anvil's own estimate of when the cache expires come only from the file anvil writes per session: `<CLAUDE_CONFIG_DIR or ~/.claude>/anvil/sessions/<session_id>.json` = `{ renews: boolean, error: string | null, expiresAt: number | null, at: number }` (Unix ms). The script finds the file by stdin's `session_id`. If the file is missing (anvil not installed yet, or nothing written yet), treat the cache as not renewing. The reference script already does all of this, so keep its cache logic unless the user asks otherwise.
2. **Don't repeat the line above.** anvil's line already shows the folder, git, 5h and 7d limits and the session cost. By default the status line leaves them out. If the user wants one of them here too, say it's already above the prompt first, and add it only if they still want it.
3. **The line above isn't yours to edit.** If the user wants to hide, reorder or turn off parts of the line above, point them to `/config` → anvil → *Line above the prompt* (comma-separated parts `dir, git, 5h, 7d, cost`; empty or `off` hides the line). Never change anvil's plugin files.
4. **Back up before writing.** Before you change anything, copy any existing status line script to `<name>.bak-<YYYYMMDD>` next to it, and tell the user the current `statusLine` value from settings so they can restore it.
5. **Finish only on a nod.** After writing, run a preview (see below) and show it. You're done only when the user says it looks right.

## Steps

1. **Look at what's there.** Read the `statusLine` entry in the user's settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) and the script it runs, if any.
2. **Check the environment.**
   - Run `node --version`. A native install of Claude Code doesn't bring node. If node is missing, ask whether to install it or to have the script ported to bash (macOS/Linux) or PowerShell (Windows), and port it faithfully if they choose that.
   - Ask whether the terminal font is a Nerd Font (the reference uses Nerd Font icons such as `\u{F4BC}`). If it isn't, or the user isn't sure, show a preview. If the icons come out as boxes, swap them for plain characters or drop them.
3. **Show the default.** Run the reference script on the sample input and show the plain-text result:
   `node <this skill's directory>/statusline.mjs < <this skill's directory>/sample.json`
   (strip ANSI codes for your own view). For the real colors, suggest the user run the same command with a `!` prefix. Then ask what they'd like to change.
4. **Adapt.** Anything about the look is open: which parts, order, colors, icons, separators, how it gives way on narrow terminals. Keep rules 1 and 2. Ask once or twice, not a questionnaire.
5. **Install.** Back up (rule 4). Write the script to `~/.claude/statusline.mjs` (or where the user wants it, but never inside the plugin's directory, because plugin updates replace it). Set the user's settings:
   ```json
   "statusLine": { "type": "command", "command": "node <absolute path to the script>", "padding": 0 }
   ```
   Use forward slashes in the path on Windows too. Leave every other setting as it is.
6. **Preview and confirm.** Run the installed script on `sample.json`, and on a copy of it with `"prompt_cache": {}` (a session with no requests yet). Show both. The new line appears in Claude Code on its next refresh, with no restart needed. Wait for the user's OK. If they want more changes, go back to step 4.

## Reference script notes

- Width: the script reads `COLUMNS` (default 120) and steps down from the fullest version (context bar, `warm · keepalive`) to shorter ones until it fits.
- Time is always written as a wall-clock time (`expires 14:05`), never a countdown, because Claude Code reruns the script only when something changes or `expires_at` passes.
- Colors match anvil's palette (`hooks/style.ts`), so the two lines look like one design. If the user restyles this line, mention that the line above keeps anvil's colors.
