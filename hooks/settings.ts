import type { PluginOptions } from 'claude-code'

import type { Settings } from '../types'
import { parseBand } from './band'

// 默认值只写在插件清单的 userConfig 里：引擎按字段类型校验、填好默认值再交给 register，
// 不在 options 里的值都按清单默认。这里只把 options 收窄成 Settings，碰到引擎没兑现的值就报错。

function number(options: PluginOptions, key: keyof Settings): number {
  const value = options[key]
  if (typeof value !== 'number') throw new Error(`anvil: setting ${key} should be a number, got ${JSON.stringify(value)}`)
  return value
}

function boolean(options: PluginOptions, key: keyof Settings): boolean {
  const value = options[key]
  if (typeof value !== 'boolean') throw new Error(`anvil: setting ${key} should be a boolean, got ${JSON.stringify(value)}`)
  return value
}

function string(options: PluginOptions, key: keyof Settings): string {
  const value = options[key]
  if (typeof value !== 'string') throw new Error(`anvil: setting ${key} should be a string, got ${JSON.stringify(value)}`)
  return value
}

export function readSettings(options: PluginOptions): Settings {
  return {
    threshold: number(options, 'threshold'),
    autoKeepalive: boolean(options, 'autoKeepalive'),
    guard: boolean(options, 'guard'),
    band: parseBand(string(options, 'band')),
  }
}
