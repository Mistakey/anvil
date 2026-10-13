import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

export const SESSION: SessionStartInput = { cwd: '/work', surface: null, isInteractive: true }

// 插件之下的世界：替引擎回答骨架用到的调用，并记下插件注册的命令和写进 `$.state` 的值
export function world(on: On) {
  const commands: string[] = []
  const state = new Map<string, unknown>()
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  // 测试拿到的 `$` 没有 state 这个名词，只能在插件之下看它写了什么，再交给测试工具自带的 state
  on('state.set', ($, e, next) => {
    state.set(`${e.plugin}.${e.key}`, e.value)
    return next(e)
  })
  return { commands, state }
}

export const anvil = (args: string): CommandRunInput => ({
  command: 'anvil',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})
