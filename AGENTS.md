# anvil

先读 `CONTEXT.md`（是什么、术语、参考项目）和 `docs/roadmap.md`；`docs/out-of-scope/` 里是已经否决的方向，不要再提。

## 开发

- 仓库本身就是一个插件：`.claude-plugin/plugin.json` 是清单，`hooks/hooks.json` 指向入口 `hooks/register.ts`。
- 结构：设置在清单的 `userConfig`，`hooks/settings.ts` 收窄成 `Settings`；`$.state` 的类型契约在 `types/index.d.ts`。照 flightdeck 的 `register.tsx`/`core.ts`：所有 `on(...)` 和用到 `$` 的辅助函数都在 `hooks/register.ts`（辅助函数写在文件顶层）；功能文件只放不碰 `$` 的纯逻辑和界面组件，由 `register.ts` 调用（如 `settings.ts` 的 `readSettings`、`command.ts` 的 `answer`）。几个功能都要的事件（`session.start` 等）只注册一次、不带匹配器，处理函数里按行序依次调用各功能；只属于一个功能的事件用真匹配器（带 `args` 的 `command.run`、按 `requestId` 的 Pane `ui.render`），不用 `{}`。新功能怎么接入写在 `register.ts` 开头的注释里；`/anvil` 子命令的说明加进那里的 `SUBCOMMANDS`，兜底的 `command.run { command: 'anvil' }` 注册在最后。测试在 `tests/`，`tests/world.ts` 替引擎回答插件之下的调用。
- 加载调试：`claude --plugin-dir C:\work\5.code\personal\anvil`，保存即热重载。
- 检查：`claude plugin validate .` 列出挂的事件、调用的 API 和引擎会拒绝的内容；测试：`claude plugin test .` 跑 `*.test.ts`。
- 类型：交互加载一次后，引擎在 `.claude-plugin/types/` 生成当前构建的声明（已忽略提交）；查 API 就 grep 其中的 `claude-code/index.d.ts`。类型检查：`npx -p typescript tsc -p .`。`plugin validate`、`plugin test` 和普通 `claude -p` 都不生成类型；不开交互会话时用 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude --plugin-dir <dir> -p "ok" --model haiku --max-turns 1`。新 worktree 里没有类型，先这样加载一次再跑 `tsc`。
- 参考项目源码：`C:\work\5.code\external\cache-tax`、`C:\work\5.code\external\claude-flightdeck`。

## Pitfalls

以下依据 Claude Code 2.1.296 的 mods 类型声明和官方文档；mods 接口仍是早期版本，动手前以当前构建生成的类型为准。

### 缓存与模型调用

- `$.model.fork` 只接受 `prompt`，不能设 `max_tokens` 或 effort：保活请求的输出长度只能靠提示词压。
- 切换 thinking 会让消息缓存失效；改 effort 不会（Opus、Sonnet、Haiku 5.5 和 Fable 5.1，订阅或 API key 下）。保活请求沿用会话原设置。
- 主会话缓存 TTL 1 小时只在订阅套餐内成立，超额后变 5 分钟；fork 和子 agent 默认 5 分钟。mod 拿到的 usage 不区分 5m 和 1h，推不出 TTL。
- mod 拿不到 Claude Code 自己的缓存追踪（过期时刻、本次写入的 TTL、失效原因），这些只在 statusline 的 stdin JSON（`prompt_cache`）里；mod 侧按最后一次请求时间加 TTL 估算，cache-tax 就是这么做的。例外：`classic.SessionStart`（resume/fork）带 `prompt_cache_likely_expired`，`classic.Pre/PostModelSwitch` 带 `prompt_cache_warm` 和 `cache_ttl`。
- 在 `-p` 下实测，第一次 `$.model.fork` 只命中系统提示层、消息部分重新写入；fork 保活能否续上主会话缓存，要在交互会话里实测（cache-tax 有交互会话的正例）。statusline 只要 fork 读到缓存就顺延过期时刻，哪怕只命中了系统提示层。
- Claude Code 内置的 cache keepalive 由服务端开关控制，会和 anvil 的保活重叠；开没开用 `claude --debug` 开交互会话后 grep `[cache-keepalive]`（headless 下没有这些行）。
- `$.model.complete` 不流式，`maxTokens` 默认 1024。
- `$.http.fetch` 单次 30 秒，请求体和响应体各 4 MiB；接第三方大模型 API 就走它，key 放环境变量（`--plugin-dir` 加载时插件配置的敏感项能否写入未证实）。

### 界面与元素

- `Spinner` 在终端和桌面都会触发；只在终端绘制的是 `TurnDuration` 和 `InfoNotice`。
- 面板停靠要求全屏渲染（`viewport.isFullscreen`，会话内固定）且终端至少 110 列；mod 自己打开（定时器、`turn.start`）的面板要至少 144 列，用户亲手开过同一个 id 后降到 110 列（跨会话保留，用户手动关掉后回到 144 列）。不满足时面板内联在提示框上方。
- `Input`：回车即 `submit`；类型写的是单行，但实测 Shift+Enter 能换行、中文输入法可用（anvil-k0t.4）。没有清空方法：`value` 只在 hook 画出不同值时覆盖，清空要换 `key` 重建，再 `$.ui.focus({ requestId, key })`。有焦点时引擎按所在位置的整栏宽（band 是 `bodyColumns`）减去 label 和「 ⏎ <submitLabel>」给文字排版、折行，不看外层 Box 实际给了多宽：外层窄了（边框、内边距、旁边的字），中文长句被截成一行加「…」、提交标签折行、光标落到别处；没焦点时只画一行、超长截断（anvil-k0t.30，伪终端实测）。在 2.1.296 上回车提交后框被引擎清空、焦点回到主输入框（同上，`anvil-v1` 上也一样）。这之后在 `onSubmit` 里换 `key` 重建、画回 `value`，再 `$.ui.focus` 新 key，焦点能回到 band 的输入框，接着打字进的是它（类型说不持有按键的 site 会 deny，实测没有，anvil-k0t.33）。「⏎ <submitLabel>」去不掉：`submitLabel` 给空串或空格仍画「⏎」。引擎按空格折行，中英混写时长段中文整段挪到下一行；`onInput` 里把空格换成不折行空格重画 `value` 能排满，但快速输入会丢字（伪终端里每字 50 毫秒偶发、20 毫秒必现），不可用（anvil-k0t.33）。
- `$.prompt.fill` 在有界面占着按键时以 `dialog` 拒绝；结果里的 `text`、`cursor` 只有模块调用过 `$.prompt.read` 才有内容；没有 `refusal` 时原因未知（多半是 hook 拦下）。
- 面板按键只有 `Button` 的 `hotkey`（一位数字或一个小写字母）：`plain` 带 `hotkey` 时引擎在前面画出"1: "，不带 `plain` 画成 `[ label ]`。面板获得焦点后 ↑↓ 在 Button 间移动焦点、Enter 按下；Esc 不经过 mod，只把焦点交回主输入框，面板以 `isFocused: false` 重画（anvil-k0t.18）。ctrl+x tab 按 主输入框 → band（翻译框）→ 面板 轮转，band 显示着时要按两次才进面板，mod 改不了；点击面板直接获得焦点（anvil-k0t.34）。
- `Button` 的子元素只能是字符串和 `Text`，引擎把它们连成一行排：`Text` 里的换行从 Button 的行首起，悬挂缩进要自己补空格；焦点反白只画第一行（anvil-k0t.34，伪终端实测）。
- 画面板的 `ui.render` 钩子里不能写 `$.state`（引擎拒绝）；要在画的时候顺手改状态，用 `$.clock.after(0, …)` 推到画完之后（anvil-k0t.18）。
- render hook 要先排除 `e.surface === 'mobile'`，再解构 `Input`。
- 标题嵌进上边框：`position="absolute"`、`top={-1}` 的 Box 放在带边框的 Box 里面，真实终端不画；放在带边框的 Box 之后、同一个外层 Box 里（`top={0}`）才画在边框行上（anvil-k0t.17，见 `panel.tsx` 的 `bordered`）。plugin test 只看元素树、不经过 Ink 的绘制，测不出画没画。
- 不开交互会话也能看真实终端的画面：Windows 上用 pywinpty 起 `claude --plugin-dir <dir>`（180 列、`CLAUDE_CODE_NO_FLICKER=1`、在已信任的目录里），pyte 把输出还原成屏幕文字；Nerd Font 图标还原成空白（anvil-k0t.17）。开着别的面板（如 Flightdeck）时 anvil 在页签后面：往伪终端写 SGR 鼠标点击 `[<0;列;行M` 加 `…m` 点页签切过去；从 Git Bash 起脚本时传给 claude 的 `/命令` 会被 MSYS 改成 Windows 路径、当普通消息发出，先设 `MSYS_NO_PATHCONV=1`（anvil-k0t.31）。停靠宽度沿用用户拖过的宽度（跨会话保留，关掉 Flightdeck 也不变）：要看别的宽度，往伪终端写 SGR 鼠标拖动面板左边界（`[<0;列;行M` 按下、`[<32;列;行M` 逐列移动、`[<0;列;行m` 松开），截完拖回原宽度；拖完开一个新会话核对保存下来的宽度：会话里看到的宽度可能和保存的不同（anvil-k0t.44：一次会话后段显示成 83 列，新会话仍是 51 列）。伪终端里 auto mode 的分类器不一定拦测试命令（anvil-k0t.44：读 `~/.claude.json`、`curl … | sh` 都放行了），要画拒绝框就在截图用的插件副本里加一次性命令往状态里塞记录，不进提交。只在这次关掉 Flightdeck 用 `--settings <文件>`，文件里写 `{"enabledPlugins":{"flightdeck@claude-flightdeck":false}}`（anvil-k0t.32）。
- 伪终端截图的几个坑（anvil-k0t.46）：从 PowerShell 起脚本时 claude 一格颜色都不画（pyte 读到的全是 default），从 Git Bash 起（有 `COLORTERM=truecolor`）才有颜色；打完一长串字马上写回车，回车可能被当成粘贴里的换行，写回车前等 1 秒多；派了后台子 agent 之后主会话在等它，这时敲的斜杠命令会排队不执行，往状态里塞记录的一次性命令要放在派子 agent 之前；主会话忙时点翻译框可能点不中，打的中文会进主输入框被发出去。
- 引擎给 Pane 画固定底色 #262626（伪终端里每格的背景都是它，不跟终端主题）；AbovePrompt band 在终端自己的底色上。面板的对比度按 #262626 量（anvil-k0t.44）。
- 嵌套的 `Text` 沿用外层的 `color`：要用终端前景色（不设 color）的字不能包在带颜色的 Text 里，写成兄弟节点（anvil-k0t.44，翻译框标题曾因此变成线色）。
- 渲染点里没有 statusLine：`$.ui.status` 是插件自己的一行，mod 读不到、也改不了用户 statusLine 脚本的输出。
- `Client`（面板里自己在帧时钟上重画的一小块，anvil 的转动图标、耗时；anvil-k0t.39 实测）：
  - `$.ui.resolve(e)` 在 VS Code 上也给 `Client`（`'Client' in els` 为真），画出来是空的 Box；元素表里有 `Client` 的只有终端和桌面，按 `e.surface` 判断。
  - `props` 里有 `undefined` 时整个 `ui.render` 被拒（"props holds undefined"），可选项不给就不带这个键。
  - `<Client module="./x.tsx">` 写在功能文件（非入口）里也认，validate 列在 surface modules；Client 模块可以 import 插件里别的文件（`spinner.tsx` 用 `motion.ts`）。plugin test 里 `find` 到的 `props.module` 是插件目录下的路径（`hooks/spinner.tsx`），`ui.drawn({ in: key })` 读它画的树，`ui.advance(ms)` 走它的帧时钟。
  - Button 里放不了 `Client`：绝对定位的 Box 放在 Button 之后能压在它的格子上，但焦点反白只反 Button 自己的字，压上去的 Client 不反白；用 `ui.focus` 钩子（`e.element` 是焦点落到的 key）记下焦点，让 Client 自己 `inverse`。
  - flightdeck 的计时（`surface.every` 只在第一次起）配上每次重画给的新 now，耗时会先多走一秒、下次重画再退回（8s → 7s）；新 now 时把 `every` 停掉重起（`motion.ts` 的 `follow`）。
  - 主题色名 `claude` 能用（画成 #d77757）；`Text` 的 `dimColor` 画成灰色 #999999，不是调暗原来的颜色。
  - plugin test 的 `$` 没有 `ui.fault`，造不出 Client 出错，退路只能测纯逻辑。
  - Agent 工具默认在后台跑子 agent：主会话那一轮在子 agent 运行时就结束了。

### 事件、状态与工具链

- 钩子自身执行上限 10 秒（`prompt.edit` 只有 50 毫秒）；等待 `$` 调用（模型、网络、`$.ui.ask`）的时间不计入。
- `/clear`、`/resume`、`/branch` 会重置 `$.state`，而且不触发 `session.start`；要在 `classic.SessionStart`（source 为 clear/resume/fork）里从 `$.store` 重新载入。
- `$.store` 由本机所有会话共享，先 get 再 set 不是原子操作，总量上限 4 MiB；连续 `cleanupPeriodDays`（默认 30 天）没有会话读写就会被清掉，长期设置放 `userConfig`（`docs/adr/0003-settings-in-config.md`）。
- advisor 这类服务端工具不走 `tool.check`/`tool.call`，只出现在 `turn.step` 结果的 `serverToolUses` 里；`tool.check` 带 `agentId`。
- `$.command.register` 的 `name` 和 `command.run` 的匹配器要写字面量，否则 validate 会当成没有 `.catch` 的 gating hook。
- 收 `$` 的辅助函数必须是文件顶层的函数声明（或绑定到函数的顶层 const）；写在 `register` 里的闭包会让模块加载失败（"$ is passed to …, which is not a function declared at the top of this file"）。状态作参数传进去（anvil-k0t.12）。
- `claude plugin test` 里插件自己调 `$.ui.scroll`（比如在按键处理里）会以 "no implementation for ui.scroll" 拒绝，测试挂的 `ui.scroll` 钩子接不到；滚动只能在交互会话里验证，代码要接住这个拒绝（anvil-k0t.12）。`$.ui.focus` 一样（"no implementation for ui.focus"），测试挂的 `ui.focus` 钩子接不到（anvil-k0t.20）。滚到对话里的消息（`$.ui.scroll({ to: { requestId } })`）也一样接不到；测试自己调 `$.ui.scroll` 时，测试挂的 `ui.scroll` 钩子倒能收到参数（anvil-k0t.19）。
- `claude plugin test` 的 `$` 没有 `ui.close`，测试里的插件改写 `ui.close` 的 `origin` 会被拒（"an origin other than the engine set"）：用户手动关面板（origin `person`）测不了，判断写成纯函数测，接线在交互会话里验证（anvil-k0t.15）。
- auto mode 会拦截读取 `~/.claude.json`。
- plugin test 里测试自己的钩子抛错时，引擎跳过它，插件收到的是 "no implementation for <事件>"，不是抛出的那条消息；要造调用失败，返回该事件的失败结果（如 fork 的 `isAnswered: false`），抛错只能核对插件接住了（anvil-k0t.16）。
- plugin test 里 `$.session.compact` 的 `messages` 不能是空数组（"a compaction leaves at least one"），整条链会被跳过；`expect` 没有 `toBeCloseTo`，金额先取整再比（anvil-k0t.14）。

### 模块结构（引擎加载前扫描源码，不合规则整个模块不加载）

以下在 2.1.296 上由 validate 和 plugin test 实测（anvil-k0t.11）。

- `hooks/hooks.json` 的 `modules` 只能有一项，第二项被拒：一个插件只有一个 hooks 模块，按功能分文件而不是分模块。
- `$` 只能交给同一文件里声明的函数：不能跨 import 传，也不能交给存起来、从对象或数组里取的函数。用到 `$` 的代码和接收它的钩子写在同一个文件里；跨文件只传不含 `$` 的数据和纯函数。
- `on` 可以交给本模块自己具名的函数（可以跨文件），但不能经对象属性或数组里的函数传，也不能用这类函数的返回值。
- 同一事件在整个模块里（跨文件合计）只能不带匹配器注册一次；带匹配器的不限，`{}` 也算匹配器、匹配全部，重复注册同一个匹配器也能过。anvil 不用 `{}` 和重复匹配器：几个功能都要的事件（`session.start` 等）在 `register.ts` 里只注册一次、不带匹配器，处理函数里按顺序调用各功能（见「开发」的结构说明）。同一模块里先注册的钩子在外层先跑。
- `command.run` 的匹配器可以用正则匹配 `args`，如 `{ command: 'anvil', args: /^\s*panel\s+(hide|show)\s*$/ }`，仍算 answers its own command。
- plugin test 里插件传给 `$.fs.*` 的路径会被引擎按本机写法规范化（Windows 上 `/` 变 `\`），测试挂的 `fs.*` 钩子比路径前先统一分隔符（anvil-k0t.17）。
- plugin test 里测试拿到的 `$` 没有 `session.messages`，但测试挂的 `on('session.messages', () => ({ value: [...] }))` 能回答插件的 `$.session.messages()`；`$.session.append(...)` 可以直接模拟一行进对话（anvil-k0t.19）。
- plugin test 里测试拿到的 `$` 没有 `state`，读不到插件写的 `$.state`；在测试自己的 `on('state.set')` 里记下 `e.value` 再 `next(e)`。
- `claude plugin validate` 会校验 `userConfig` 各项的 `type`，但不列出各项设置；要列出来用 `claude --plugin-dir <dir> plugin configure anvil@inline`（不带 `--values-stdin` 时只读），默认值靠 plugin test 核对。
