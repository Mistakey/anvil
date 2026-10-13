import type { On } from 'claude-code'

/**
 * 功能模块交给 `/anvil` 的一个子命令的说明，如 `/anvil panel hide|show`。
 *
 * 执行由功能模块自己注册，匹配器写字面量、和这里的 name、args 对上：
 * `on('command.run', { command: 'anvil', args: /^\s*panel\s+(hide|show)\s*$/ }, async ($, e) => ...)`。
 * 没被功能模块接走的 `/anvil`（不带子命令、子命令未知、后面的词不对）由这里兜底回答。
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

/** `/anvil` 命令入口：会话开始时注册命令，兜底回答功能模块没接走的调用；要最后接入 */
export function registerCommand(on: On, subcommands: readonly Subcommand[]) {
  on('session.start', {}, async ($, e, next) => {
    await $.command.register({
      name: 'anvil',
      description: 'anvil 只作用于当前会话的命令；不带参数时列出子命令',
      argumentHint: '<子命令>',
    })
    return next(e)
  })

  on('command.run', { command: 'anvil' }, async ($, e) => ({ text: answer(subcommands, e.args) }))
}
