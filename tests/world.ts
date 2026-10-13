import type { CommandRunInput, On, PaneOpenArgs, PromptSubmitInput, SessionStartInput, SessionUsage } from 'claude-code'

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

/**
 * 替引擎管面板：记下每次 `$.ui.open` 和 `$.ui.close`。
 * `placed` 是引擎这时肯不肯把面板放下（终端够不够宽），测试中途可以改。
 */
export function panes(on: On) {
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  const shown = new Map<string, boolean>()
  const screen = { placed: true }
  on('ui.open', ($, e) => {
    opens.push(e)
    shown.set(e.id, screen.placed)
    return { value: screen.placed ? { isPlaced: true } : { isPlaced: false, reason: '终端 120 列，不到 144 列' } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)
    shown.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...shown].map(([id, isPlaced]) => ({ id, title: id, isShown: isPlaced, isFocused: false, isPlaced })),
  }))
  return { opens, closes, screen }
}

/** 替引擎回答 `$.session.usage()`；读数可以中途改 */
export function usage(on: On, initial: SessionUsage) {
  const reading = { current: initial }
  on('session.usage', () => ({ value: reading.current }))
  return reading
}

export const anvil = (args: string): CommandRunInput => ({
  command: 'anvil',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})

export const typed = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
