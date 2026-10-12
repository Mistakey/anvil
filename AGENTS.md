# anvil

先读 `CONTEXT.md`（是什么、术语、参考项目）和 `docs/roadmap.md`；`docs/out-of-scope/` 里是已经否决的方向，不要再提。

## 开发

- 仓库本身就是一个插件：`.claude-plugin/plugin.json` 是清单，`hooks/hooks.json` 指向入口 `hooks/register.ts`。
- 加载调试：`claude --plugin-dir C:\work\5.code\personal\anvil`，保存即热重载。
- 检查：`claude plugin validate .` 列出挂的事件、调用的 API 和引擎会拒绝的内容；测试：`claude plugin test .` 跑 `*.test.ts`。
- 类型：加载一次后，引擎在 `.claude-plugin/types/` 生成当前构建的声明（已忽略提交）；查 API 就 grep 其中的 `claude-code/index.d.ts`。类型检查：`npx -p typescript tsc -p .`。
- 参考项目源码：`C:\work\5.code\external\cache-tax`、`C:\work\5.code\external\claude-flightdeck`。

## Pitfalls

以下依据 Claude Code 2.1.296 的 mods 类型声明和官方文档；mods 接口仍是早期版本，动手前以当前构建生成的类型为准。

- `$.model.fork` 只接受 `prompt`，不能设 `max_tokens` 或 effort：保活请求的输出长度只能靠提示词压。
- 改 effort 或 thinking 参数会让消息缓存失效：保活请求必须沿用会话原设置，否则会把整段上下文重写一遍。
- mod 拿不到 Claude Code 自己的 prompt 缓存统计（过期时刻、命中率、失效原因），这些只在 statusline 的 stdin JSON（`prompt_cache`）里；mod 侧只能按最后一次请求时间加 TTL 估算，cache-tax 就是这么做的。订阅用户主会话缓存 TTL 默认 1 小时。
- 钩子自身执行上限 10 秒（`prompt.edit` 只有 50 毫秒）；等待 `$` 调用（模型、网络、`$.ui.ask`）的时间不计入。
- `$.http.fetch` 单次 30 秒，请求体和响应体各 4 MiB；接第三方大模型 API 就走它，key 放环境变量或插件配置的敏感项。
- `Spinner`、`TurnDuration` 等渲染点只在终端绘制；面板停靠在对话旁需要终端至少 110 列。
- `Input` 元素回车即提交，文档没写多行和中文输入法支持，翻译输入框需要实测。
