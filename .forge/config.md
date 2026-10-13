# anvil repo config

Claude Code mod：TypeScript 源码由引擎直接加载，没有构建产物。

## Verification

- 改了 `hooks/`、`types/`、`tests/`：跑 AGENTS.md「开发」里的插件 validate、plugin test 和 tsc 类型检查（新 worktree 先按那里的说明生成类型）
- `human acceptance`：交互会话里的界面实际效果、缓存读数、主输入框写入，agent 跑不了；由用户在 `claude --plugin-dir <目录>` 里按 agent 给的步骤实测并回报
