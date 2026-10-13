// 缓存状态（spec D1、D2）和冷发送守卫（D4）的纯逻辑：估算、计价、守卫的判定和提示行。
// 钩子和 `$` 调用都在 register.ts。
//
// 估算、牌价表、守卫和会话生命周期照 cache-tax（https://github.com/karanb192/cache-tax，HEAD 06cac47）改写：
// MIT License, Copyright (c) 2026 Karan Bansal。偏离之处在各函数的注释里写明。

import type { ModelUsage, TurnUsage } from 'claude-code'

import type { CacheView } from '../types'

/** 一律按 1 小时 TTL（ADR 0001） */
export const TTL_MS = 60 * 60 * 1000

/** 一轮写入不少于上一轮上下文的一半、且上一轮上下文超过这个量，就算整段重建（cache-tax 的判据） */
const FULL_WRITE_FLOOR = 20000

// 每百万 token 的美元牌价：[缓存读取, 1 小时缓存写入]，取自 cache-tax（2026 年 9 月牌价）。
// 长的系列名在前：模型 id 取第一个包含的行。
const PRICES: ReadonlyArray<readonly [string, number, number]> = [
  ['fable-5-1', 0.25, 20],
  ['fable-5', 1, 20],
  ['opus-5', 0.5, 10],
  ['opus-4', 0.5, 10],
  ['sonnet-5', 0.2, 4],
  ['sonnet', 0.3, 6],
  ['haiku', 0.1, 2],
]

/** 主会话的缓存状态；只在 register.ts 的闭包里，随模块加载新建，`/clear` 时清零 */
export type Cache = {
  /** 最后一次主会话请求的时刻，0 表示本会话还没有 */
  lastRequestAt: number
  /** 过期时刻，0 表示未知（还没有请求）；一般是 lastRequestAt + TTL，恢复会话时可能更早 */
  expiresAt: number
  /** 压缩之后、下一次响应之前：不判过期 */
  compacted: boolean
  /** 上下文输入侧：上一条回复所基于的输入 token（未缓存 + 读 + 写） */
  context: number
  /** 上一条回复的输出 token */
  output: number
  /** 计价用的模型 id */
  model: string | null
  /** 上一条消息（主会话上一轮）的缓存读取量和输入总量 */
  last: { read: number; input: number } | null
  /** 本会话累计的缓存读取量和输入总量 */
  session: { read: number; input: number }
  /** 本会话的冷写：每次重建的 token 数和金额（模型不认识时金额为 null） */
  coldWrites: Array<{ at: number; tokens: number; usd: number | null }>
  /** 本轮已从 turn.step 拿到过回复的读数 */
  steppedThisTurn: boolean
  /** 守卫已拦过一次的那个过期时刻：同一段过期里再提交就放行 */
  ackedFor: number
}

export function freshCache(): Cache {
  return {
    lastRequestAt: 0, expiresAt: 0, compacted: false, context: 0, output: 0, model: null,
    last: null, session: { read: 0, input: 0 }, coldWrites: [], steppedThisTurn: false, ackedFor: 0,
  }
}

/** `/clear` 开始新的对话：之前的一切都不再计价。就地清零，闭包里的引用不变 */
export function resetForClear(c: Cache) {
  Object.assign(c, freshCache(), { model: c.model })
}

function priceOf(model: string | null): readonly [number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write] of PRICES) if (m.includes(family)) return [read, write]
  return null
}

/** 按 1 小时写入价折算重建 tokens 的金额（D2）；模型不认识时为 null */
export function writeUsd(tokens: number, model: string | null): number | null {
  const price = priceOf(model)
  return price ? tokens * price[1] / 1e6 : null
}

const inputOf = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/** 重建量 = 上下文输入侧 + 上一条回复的输出（D1；cache-tax 只算输入侧） */
export const rebuildTokens = (c: Cache) => c.context + c.output

export function isExpired(c: Cache, now: number): boolean {
  return c.expiresAt > 0 && !c.compacted && now >= c.expiresAt
}

/** 主会话发出一次请求（turn.step 开始，或 turn.complete 兜底）：过期时刻顺延到这次请求 + 1 小时 */
export function stampRequest(c: Cache, now: number) {
  c.lastRequestAt = now
  c.expiresAt = now + TTL_MS
}

/** 主会话一次请求的回复到了：上下文以这一条为准，压缩后的"不判过期"到此结束 */
export function recordResponse(c: Cache, usage: TurnUsage) {
  c.context = inputOf(usage)
  c.output = usage.output_tokens
  c.model = usage.model
  c.compacted = false
  c.steppedThisTurn = true
}

/**
 * 主会话一轮结束：记命中率，判断这一轮是否整段重建了缓存。
 *
 * `prev` 是这一轮之前的上下文输入侧。一轮的 usage 是各次请求之和，整段重建发生在第一次请求，
 * 和 cache-tax 一样拿整轮写入量和上一轮上下文比。cache-tax 还把"守卫放行过的那条"一律算成冷写，
 * 这里不算：只按实际写入量记，估算误报时不多记一次。
 */
export function recordTurn(c: Cache, usage: TurnUsage, prev: number, live: number | undefined, now: number) {
  c.model = usage.model
  const input = inputOf(usage)
  c.last = { read: usage.cache_read_input_tokens, input }
  c.session = { read: c.session.read + usage.cache_read_input_tokens, input: c.session.input + input }
  // turn.step 没给出读数时（引擎没有逐次的 usage），退到引擎的实时上下文
  if (!c.steppedThisTurn && live !== undefined && live > 0) c.context = live
  const write = usage.cache_creation_input_tokens
  if (prev > FULL_WRITE_FLOOR && write >= 0.5 * prev) c.coldWrites.push({ at: now, tokens: write, usd: writeUsd(write, c.model) })
  c.compacted = false
  c.steppedThisTurn = false
  c.ackedFor = 0
}

/** 主会话压缩：到下一次响应前不判过期，上下文未知 */
export function recordCompact(c: Cache) {
  c.compacted = true
  c.context = 0
  c.output = 0
  c.ackedFor = 0
}

/** `classic.SessionStart`（resume、fork）给出的字段 */
export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
}

/**
 * 恢复会话时按引擎给的字段起步（D1）。
 *
 * `context_tokens` 是上一条回复的输入加输出，正是重建量；输出部分不单列，记在 context 里。
 * 引擎判定 `prompt_cache_likely_expired` 时，过期时刻最晚取现在：哪怕按 1 小时还没到（引擎知道真实 TTL）。
 */
export function seedFromResume(c: Cache, e: ResumeFields, now: number) {
  if (e.source !== 'resume' && e.source !== 'fork') return
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) {
    c.context = e.context_tokens
    c.output = 0
  }
  if (typeof e.model === 'string') c.model = e.model
  if (typeof e.seconds_since_last_response === 'number') stampRequest(c, now - e.seconds_since_last_response * 1000)
  if (e.prompt_cache_likely_expired === true) c.expiresAt = Math.min(c.expiresAt || now, now)
  c.compacted = false
}

const ratio = (part: { read: number; input: number } | null) => part && part.input > 0 ? part.read / part.input : null

/** 交给显示（缓存框）的读数，写进 `$.state` 的 anvil.cache */
export function view(c: Cache): CacheView {
  const rebuild = rebuildTokens(c)
  return {
    expiresAt: c.expiresAt > 0 ? c.expiresAt : null,
    compacted: c.compacted,
    context: c.context,
    rebuild: { tokens: rebuild, usd: writeUsd(rebuild, c.model) },
    hitRate: { last: ratio(c.last), session: ratio(c.session) },
    coldWrites: { count: c.coldWrites.length, usd: c.coldWrites.reduce((sum, w) => sum + (w.usd ?? 0), 0) },
  }
}

// ---------------------------------------------------------------- 格式（D10 用词）

/** 时长写作 47s / 2m41s / 1h10m */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function formatTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`

// ---------------------------------------------------------------- 冷发送守卫（D4）

/** 守卫看的那次提交 */
export type Submission = { text: string; origin: { kind: string } }

/**
 * 这次提交该不该拦。
 *
 * 只拦用户在主输入框里亲手按 Enter 发给模型的消息（origin composer）：插件、远程、通知、
 * 定时任务等来源都放行（cache-tax 只放行插件；spec 说只拦用户自己的，放回主输入框也只对 composer 有意义）。
 * 斜杠命令放行；`!` 开头的 shell 命令不发给模型，也放行。
 */
export function shouldGuard(c: Cache, submission: Submission, threshold: number, now: number): boolean {
  if (submission.origin.kind !== 'composer') return false
  const head = submission.text.trimStart()
  if (head.startsWith('/') || head.startsWith('!')) return false
  if (!isExpired(c, now) || c.context < threshold) return false
  return c.ackedFor !== c.expiresAt
}

/** drop 原因就是提示行（D4 文案）；模型不认识时省掉金额 */
export function guardText(c: Cache, now: number): string {
  const rebuild = rebuildTokens(c)
  const usd = writeUsd(rebuild, c.model)
  const cost = usd === null ? '' : `（约 ${formatUsd(usd)}）`
  return `anvil：缓存已过期 ${formatDuration(now - c.expiresAt)}，发送这条消息要重建 ${formatTokens(rebuild)} tokens${cost}。` +
    '消息已放回主输入框，再按 Enter 即发送；不需要这段上下文时，可用 /clear 开始新会话。'
}
