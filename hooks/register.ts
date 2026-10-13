import type { Register } from 'claude-code'

import { registerCommand } from './command'
import type { Subcommand } from './command'
import { publishSettings, readSettings } from './settings'

// 按功能分模块：每个功能模块一个文件，导出 registerXxx(on, settings)，在下面按顺序接入，先接入的钩子在外层先跑。
// 引擎扫描源码的规则见 AGENTS.md Pitfalls「模块结构」：`$` 不跨文件传；session.start 这类几个模块都要的事件
// 一律带匹配器注册（没有更窄的字段可匹配就写 `{}`）。

// 各功能模块导出的 /anvil 子命令说明，按列出的顺序排
const SUBCOMMANDS: readonly Subcommand[] = []

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  publishSettings(on, settings)

  // 功能模块在这里接入

  // 最后接入：兜底回答功能模块没接走的 /anvil
  registerCommand(on, SUBCOMMANDS)
}
