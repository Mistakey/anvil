// `/anvil` 命令的纯逻辑：说明和兜底回答。注册和执行都在 register.ts。

/**
 * `/anvil` 注册时的说明，即补全菜单里的灰字；name 留在 register.ts 写字面量，validate 才认得。
 * 照内置命令（`/tui [default|fullscreen]`、`/voice [hold|tap|off]`）和 flightdeck 的写法：
 * description 一句简短的命令说明，argumentHint 在方括号里用 `|` 列出全部子命令（不带参数也能用，所以是方括号）。
 */
export function describe(subcommands: readonly Subcommand[]): { description: string; argumentHint: string } {
  return {
    description: '在本会话切换 anvil 面板、翻译框或缓存保活；不带参数时列出现在的状态',
    argumentHint: `[${subcommands.map(({ name }) => name).join('|')}]`,
  }
}

/**
 * 功能交给 `/anvil` 的一个子命令的说明，如 `/anvil panel`。子命令都是切换：敲一次切一次，只作用于当前会话。
 *
 * 执行在 register.ts 里注册，匹配器写字面量、和这里的 name 对上，不带别的词：
 * `on('command.run', { command: 'anvil', args: /^\s*panel\s*$/ }, async ($, e) => ...)`。
 * 没被接走的 `/anvil`（不带子命令、子命令未知、后面多了词）由兜底的 command.run 用 answer 回答。
 */
export type Subcommand = {
  name: string
  /** 列表里的一句说明 */
  summary: string
}

/** 列表里的一行：子命令和它在本会话现在的状态 */
export type Listed = Subcommand & { state: string }

const USAGE = '用法：/anvil <子命令>，敲一次切换一次，只作用于当前会话'

function list(subcommands: readonly Listed[]): string {
  if (subcommands.length === 0) return `${USAGE}\n  暂无可用的子命令`
  const width = Math.max(...subcommands.map(subcommand => subcommand.name.length))
  const rows = subcommands.map(({ name, summary, state }) => `  /anvil ${name.padEnd(width)}  ${summary}（现在：${state}）`)
  return [USAGE, ...rows].join('\n')
}

/** 兜底的回答：不带子命令时列出子命令和状态；子命令未知或后面多了词（含旧写法 `panel hide`）时先说明再列出 */
export function answer(subcommands: readonly Listed[], args: string): string {
  const asked = args.trim().split(/\s+/).join(' ')
  if (asked === '') return list(subcommands)
  return `没有子命令 ${asked}。\n${list(subcommands)}`
}
