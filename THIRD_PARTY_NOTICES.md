# Third-party notices

anvil adapts code and ideas from the two projects below. Both are released under the MIT License; their notices are reproduced in full. Each adapted file also names its source and copyright in its header comment.

## Flightdeck

- Source: https://github.com/scasella/claude-flightdeck
- Used in:
  - `hooks/register.ts`: the module layout (one hooks entry holding every `on(...)` and every helper that takes `$`), and the subagent data flow from `agent.spawn`, `turn.step`, `tool.call` and `turn.complete`
  - `hooks/agents.tsx`: the subagent list's data model (`applyStep`, `noteTool`)
  - `hooks/describe.ts`: the secret-masking rules and the one-line tool-call summary (`SECRETS`, `redact`, `describeInput`), also used by `hooks/denials.tsx`
  - `hooks/shape.ts`: merging stored state onto its defaults (`normalize`)
  - `hooks/elapsed.tsx`, `hooks/glow.tsx`, `hooks/rail.tsx`, `hooks/spinner.tsx`, `hooks/live.tsx`: the frame-clock pattern for client-side animation and its static fallback

```
MIT License

Copyright (c) 2026 Stephen Casella

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cache-tax

- Source: https://github.com/karanb192/cache-tax (adapted from HEAD `06cac47`)
- Used in:
  - `hooks/cache.ts`: the cache-state estimate, the price table, the cold-send guard and the session lifecycle
  - `hooks/keepalive.ts`: the keepalive loop (`keepwarm`): when to ping, and how to tell whether a ping read the cache
  - `hooks/register.ts`: the wiring of the keepalive timer (`arm`, `ping`) and the cache estimate

```
MIT License

Copyright (c) 2026 Karan Bansal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
