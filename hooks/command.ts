// `/anvil` 命令的纯逻辑：说明和兜底回答。注册和执行都在 register.ts。

/** `/anvil` 注册时的说明；name 留在 register.ts 写字面量，validate 才认得 */
export const COMMAND = {
  description: 'anvil 只作用于当前会话的命令；不带参数时列出子命令',
  argumentHint: '<子命令>',
} as const

/**
 * 功能交给 `/anvil` 的一个子命令的说明，如 `/anvil panel hide|show`。
 *
 * 执行在 register.ts 里注册，匹配器写字面量、和这里的 name、args 对上：
 * `on('command.run', { command: 'anvil', args: /^\s*panel\s+(hide|show)\s*$/ }, async ($, e) => ...)`。
 * 没被接走的 `/anvil`（不带子命令、子命令未知、后面的词不对）由兜底的 command.run 用 answer 回答。
 */
export type Subcommand = {
  name: string
  /** 子命令后面跟的词，恰好一个，如 `['hide', 'show']` */
  args: readonly string[]
  /** 列表里的一句说明 */
  summary: string
}

const USAGE = '用法：/anvil <子命令>'

const line = (subcommand: Subcommand) => `/anvil ${subcommand.name} ${subcommand.args.join('|')}`

function list(subcommands: readonly Subcommand[]): string {
  if (subcommands.length === 0) return `${USAGE}\n  暂无可用的子命令`
  const width = Math.max(...subcommands.map(subcommand => line(subcommand).length))
  const rows = subcommands.map(subcommand => `  ${line(subcommand).padEnd(width)}  ${subcommand.summary}`)
  return [USAGE, ...rows].join('\n')
}

/** 兜底的回答：不带子命令或子命令未知时列出可用的，子命令认得但后面的词不对时给出它的用法 */
export function answer(subcommands: readonly Subcommand[], args: string): string {
  const [name = ''] = args.trim().split(/\s+/)
  if (name === '') return list(subcommands)
  const subcommand = subcommands.find(one => one.name === name)
  if (subcommand === undefined) return `没有子命令 ${name}。\n${list(subcommands)}`
  return `用法：${line(subcommand)}`
}
