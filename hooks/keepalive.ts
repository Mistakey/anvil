// 缓存保活（spec D3）的纯逻辑：开没开、什么时候发请求、读数判据、停下的原因和缓存框里的保活状态。
// 循环本身（定时器、`$.model.fork`）在 register.ts。
//
// 循环照 cache-tax 的 keepwarm 改写（https://github.com/karanb192/cache-tax，HEAD 06cac47）：
// MIT License, Copyright (c) 2026 Karan Bansal。和它不同的只有 spec 定下的几处：按上下文阈值自动开、
// 不开有界窗口而是每段空闲最多 12 小时、停下只结束这一段空闲；各处注释里写明。

import type { ModelForkResult } from 'claude-code'

import type { KeepaliveStop, KeepaliveView, Settings } from '../types'
import { TTL_MS, isExpired } from './cache'
import type { Cache } from './cache'
import type { Subcommand } from './command'
import { COLOR } from './style'
import type { Segment } from './style'
import { formatTokens } from './usage'

/** 上一次读到缓存之后空闲多久发请求（cache-tax 的 PING_AFTER_MS）：离 1 小时过期还有 10 分钟 */
export const PING_AFTER_MS = 50 * 60 * 1000

/** 一段空闲最多续多久（D3）；cache-tax 是用户开的窗口，默认 6 小时 */
export const IDLE_LIMIT_MS = 12 * 60 * 60 * 1000

/** 只读一遍缓存，回复越短越好：fork 不能设输出上限（cache-tax 的提示词） */
export const PING_PROMPT = 'Reply with the single word: warm'

export const KEEPALIVE_SUBCOMMAND: Subcommand = { name: 'keepalive', summary: '开启或关闭缓存保活' }

/** 保活循环，只在 register.ts 的闭包里，随模块加载新建 */
export type Loop = {
  /** 等着的定时器 */
  pending: { cancel: () => void } | null
  /** 续期请求正在路上 */
  inFlight: boolean
  /** 这一段空闲里续期成功的次数 */
  renewals: number
  stopped: KeepaliveStop | null
  /** 这一段空闲里用 `/anvil keepalive` 重新开启的时刻，12 小时上限从它算起；0 表示没有 */
  restartedAt: number
}

export function freshLoop(): Loop {
  return { pending: null, inFlight: false, renewals: 0, stopped: null, restartedAt: 0 }
}

export function disarm(loop: Loop) {
  loop.pending?.cancel()
  loop.pending = null
}

/** 主会话发出请求：用户回来了，上一段空闲的停下和续期次数都清掉（D3：停下只结束这一段空闲） */
export function startStretch(loop: Loop) {
  disarm(loop)
  loop.renewals = 0
  loop.stopped = null
  loop.restartedAt = 0
}

/** 停下后手动重新开启（D3）：清掉停下，这一段空闲的 12 小时上限从现在重新算 */
export function restart(loop: Loop, now: number) {
  loop.stopped = null
  loop.restartedAt = now
}

export const loopView = (loop: Loop): KeepaliveView => ({ stopped: loop.stopped, renewing: loop.inFlight || loop.renewals > 0, inFlight: loop.inFlight })

/** 默认：`/config` 开着自动开启、上下文达到阈值（D3，阈值与守卫共用）。cache-tax 要用户 `/keepwarm` 手动开，这里按阈值自动开 */
const isAutomatic = (settings: Settings, context: number) => settings.autoKeepalive && context >= settings.threshold

/**
 * 这个会话现在该不该保活：本会话用 `/anvil keepalive` 切换过（override 有值）就照它，不看自动开启和阈值；
 * 没切换过按默认。
 */
export function isEnabled(settings: Settings, override: boolean | null, context: number): boolean {
  return override ?? isAutomatic(settings, context)
}

/**
 * 这一段空闲的截止时刻：最后一次主会话请求 + 12 小时（续期不算请求，不推后它）；
 * 停下后手动重新开启过，就从开启的时刻算起
 */
const deadlineOf = (cache: Cache, loop: Loop) => Math.max(cache.lastRequestAt, loop.restartedAt) + IDLE_LIMIT_MS

/** 上一次读到缓存（主会话请求或续期）之后 50 分钟 */
const pingAtOf = (cache: Cache) => cache.expiresAt - TTL_MS + PING_AFTER_MS

/** 缓存还没有、已过期、刚压缩完：不发请求，等下一次主会话请求（cache-tax：冷了不发） */
const isCold = (cache: Cache, now: number) => cache.lastRequestAt === 0 || cache.expiresAt === 0 || cache.compacted || isExpired(cache, now)

export const LIMIT_STOP: KeepaliveStop = { kind: 'limit', reason: '空闲超过 12 小时' }

/**
 * 定时器该等多久（cache-tax 的 arm）：到发请求的时刻，但不晚于过期和这段空闲的截止。
 * 返回 null 表示不用定时；'limit' 表示这段空闲已到上限，该停下。
 */
export function nextDelay(cache: Cache, loop: Loop, now: number): number | 'limit' | null {
  if (isCold(cache, now)) return null
  const deadline = deadlineOf(cache, loop)
  if (now >= deadline) return 'limit'
  return Math.min(deadline - now, cache.expiresAt - now, Math.max(1000, pingAtOf(cache) - now))
}

/**
 * 定时器到点时做什么（cache-tax 的 ping 开头）：到上限就停；冷了或还没到发请求的时刻
 * （定时器停在过期或截止上，或已被新的请求顶替）就重新定时；否则发请求。
 */
export function dueAction(cache: Cache, loop: Loop, now: number): 'limit' | 'rearm' | 'ping' {
  if (cache.lastRequestAt > 0 && now >= deadlineOf(cache, loop)) return 'limit'
  if (isCold(cache, now)) return 'rearm'
  if (now < pingAtOf(cache) - 1000) return 'rearm'
  return 'ping'
}

/** 读数达标：读到了缓存，写入不到读数的 10%（cache-tax 的判据，spec 沿用） */
export function isWarm(reply: Extract<ModelForkResult, { isAnswered: true }>): boolean {
  const { cache_read_input_tokens: read, cache_creation_input_tokens: write } = reply.usage
  return read > 0 && write < 0.1 * read
}

/** fork 的结果为什么不算续上；null 表示续上了 */
export function stopFor(reply: ModelForkResult): KeepaliveStop | null {
  if (reply.isAnswered) return isWarm(reply) ? null : { kind: 'reading', reason: '续期时缓存已过期' }
  switch (reply.reason) {
    case 'api-error':
      return { kind: 'error', reason: `续期请求出错：${reply.status === null ? reply.error : `HTTP ${reply.status}`}` }
    case 'empty-reply':
      return { kind: 'error', reason: '续期请求没有回复' }
    case 'aborted':
      return { kind: 'error', reason: '续期请求被中断' }
    case 'nothing-to-fork':
      return { kind: 'error', reason: '还没有可续期的对话' }
  }
}

export const thrownStop = (error: unknown): KeepaliveStop => ({
  kind: 'error',
  reason: `续期请求出错：${error instanceof Error ? error.message : String(error)}`,
})

/** 续上了：过期时刻以这次请求的时刻顺延（D1）；用户在请求路上回来过，就不往回拨 */
export function renew(cache: Cache, requestedAt: number) {
  cache.expiresAt = Math.max(cache.expiresAt, requestedAt + TTL_MS)
}

// ---------------------------------------------------------------- 缓存框里的保活状态（D3、D10）

export type StatusInput = { settings: Settings; override: boolean | null; context: number; loop: KeepaliveView }

/**
 * 按默认的五种：已启用、进行中（这段空闲里续期过或正在续期）、未启用（自动开启已关闭 / 上下文低于阈值）、已停止（原因）。
 * 本会话切换过的：已关闭（本会话）；开着时已启用、进行中带"（本会话）"，停下照样写已停止（原因）。
 * 已停止：空闲到上限为灰，读数不达标和出错为红；其余开着为正文色，没开为灰。
 */
export function keepaliveStatus({ settings, override, context, loop }: StatusInput): Segment {
  if (override === false) return { text: '已关闭（本会话）', color: COLOR.secondary }
  if (loop.stopped) return { text: `已停止（${loop.stopped.reason}）`, color: loop.stopped.kind === 'limit' ? COLOR.secondary : COLOR.danger }
  if (override === null && !settings.autoKeepalive) return { text: '未启用（自动开启已关闭）', color: COLOR.secondary }
  if (override === null && context < settings.threshold) return { text: `未启用（低于 ${formatTokens(settings.threshold)}）`, color: COLOR.secondary }
  const mark = override ? '（本会话）' : ''
  // 正常在保活是好状态：正文色，不上色（好状态安静，anvil-k0t.46）
  return { text: `${loop.renewing ? '进行中' : '已启用'}${mark}` }
}
