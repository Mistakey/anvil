import type { PluginOptions } from 'claude-code'

import type { Settings, TranslateBackend } from '../types'

// 默认值只写在插件清单的 userConfig 里：引擎按字段类型校验、填好默认值再交给 register，
// 不在 options 里的值都按清单默认。这里只把 options 收窄成 Settings，碰到引擎没兑现的值就报错。

function number(options: PluginOptions, key: keyof Settings): number {
  const value = options[key]
  if (typeof value !== 'number') throw new Error(`anvil：设置 ${key} 应为数字，收到 ${JSON.stringify(value)}`)
  return value
}

function boolean(options: PluginOptions, key: keyof Settings): boolean {
  const value = options[key]
  if (typeof value !== 'boolean') throw new Error(`anvil：设置 ${key} 应为开关，收到 ${JSON.stringify(value)}`)
  return value
}

function text(options: PluginOptions, key: keyof Settings): string {
  const value = options[key]
  if (typeof value !== 'string') throw new Error(`anvil：设置 ${key} 应为文本，收到 ${JSON.stringify(value)}`)
  return value
}

function backend(options: PluginOptions): TranslateBackend {
  const value = text(options, 'translateBackend')
  if (value === 'haiku' || value === 'sonnet' || value === 'api') return value
  throw new Error(`anvil：设置 translateBackend 应为 haiku、sonnet 或 api，收到 ${JSON.stringify(value)}`)
}

export function readSettings(options: PluginOptions): Settings {
  return {
    showPanel: boolean(options, 'showPanel'),
    showTranslate: boolean(options, 'showTranslate'),
    threshold: number(options, 'threshold'),
    autoKeepalive: boolean(options, 'autoKeepalive'),
    guard: boolean(options, 'guard'),
    translateBackend: backend(options),
    translateApiUrl: text(options, 'translateApiUrl'),
    translateApiModel: text(options, 'translateApiModel'),
  }
}

/**
 * 面板、翻译框在本会话显示不显示（spec D3、D9 的分层）：`/config` 定默认，`/anvil panel`、`/anvil translate` 切本会话。
 * sessionHidden 是本会话切换出的、和默认不同的状态；null 表示按默认（没切换过，或切回了默认）。
 */
export function isShown(byDefault: boolean, sessionHidden: boolean | null): boolean {
  return sessionHidden === null ? byDefault : !sessionHidden
}

/** 切换到 shown 后要记下的 sessionHidden：和默认相同就记 null，本会话之后在 `/config` 改默认照样生效 */
export function sessionHiddenFor(shown: boolean, byDefault: boolean): boolean | null {
  return shown === byDefault ? null : !shown
}

/** 切换后回给用户的一行：和 `/config` 的默认不同时注明只在本会话 */
export function shownText(name: string, shown: boolean, byDefault: boolean): string {
  return `${name}已${shown ? '显示' : '隐藏'}${shown === byDefault ? '' : '（本会话）'}`
}
