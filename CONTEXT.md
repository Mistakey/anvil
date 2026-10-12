# anvil

个人自用的 Claude Code mod，把缓存保活、会话仪表盘和中文→英文翻译输入框合进一个插件，只在 Claude Code 里用。当前只有仓库骨架，尚未设计或实现。

## Language

### 功能

**缓存保活**：
主会话空闲时定时发一个不进对话记录的后台请求，读一遍 prompt 缓存使其不过期；默认关闭，在需要的会话里手动开启。用于长任务中途离开（有事、过夜）的场景。
_Avoid_: 预热（pre-warm 指首次写入缓存）、心跳

**冷发送守卫**：
缓存已过期且上下文较大时，拦下用户的下一条消息一次并提示重建代价，再发一次才放行；用来防止自己误发。
_Avoid_: 冷启动保护

**会话仪表盘**：
展示 Claude Code 会话内部事件（权限检查、子 agent、每轮小结等）的面板；思路取自 **flightdeck**，信息、位置和形态按自己的需要重做，不与 **statusline** 重复。
_Avoid_: flightdeck（专指参考项目）

**翻译输入框**：
独立于**主输入框**的中文输入框：写中文、翻译成英文，再由用户追加或替换进主输入框。目的是练英文、养成用英文和 AI 沟通的习惯。
_Avoid_: 自动翻译、提交拦截翻译

**翻译后端**：
翻译所调用的大模型；用户自有的第三方大模型 API 和订阅内的 Haiku、Sonnet 都可选，不分优先，接自有 API 是为了多一种选择。
_Avoid_: 翻译服务（DeepL 一类专用翻译 API 不是本意）

### 外部

**主输入框**：
Claude Code 自带的提示词输入框；图片、粘贴内容、斜杠命令都由用户在这里自己处理。

**statusline**：
用户的自定义状态栏脚本 `~/.claude/statusline.mjs`；将重做或取消，与 anvil 的分工在设计时确定。

**cache-tax**：
`karanb192/cache-tax`（MIT），**缓存保活**与**冷发送守卫**的参考实现；本地副本 `C:\work\5.code\external\cache-tax`。

**flightdeck**：
`scasella/claude-flightdeck`（MIT），**会话仪表盘**的参考实现；本地副本 `C:\work\5.code\external\claude-flightdeck`。

## Relationships

- **翻译输入框**只往**主输入框**写文本，不拦截主输入框的提交。
- **cache-tax**、**flightdeck** 只作参考：可借用代码和思路（保留 MIT 许可声明），功能最终在 anvil 内实现。
