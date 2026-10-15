// 缓存状态（spec D1、D2）和冷发送守卫（D4）的纯逻辑：估算、计价、守卫的判定和提示行。
// 钩子和 `$` 调用都在 register.ts。
//
// 估算、牌价表、守卫和会话生命周期照 cache-tax（https://github.com/karanb192/cache-tax，HEAD 06cac47）改写：
// MIT License, Copyright (c) 2026 Karan Bansal。偏离之处在各函数的注释里写明。

import type { ModelUsage, TurnUsage } from 'claude-code'

import type { CacheMemory, CacheView } from '../types'

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

/**
 * 主会话的缓存状态；在 register.ts 的闭包里，`/clear` 和会话内恢复别的会话时清零。
 * 每次变化原样写进 `$.state` 的 anvil.cacheMemory，热重载后从那里接上（restoreCache）；形状在 types 里
 */
export type Cache = CacheMemory

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

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPart = (v: unknown): v is { read: number; input: number } => isRecord(v) && isNumber(v.read) && isNumber(v.input)
const isColdWrite = (v: unknown) => isRecord(v) && isNumber(v.at) && isNumber(v.tokens) && (v.usd === null || isNumber(v.usd))

/**
 * 热重载后读回上一次加载写下的缓存状态（anvil.cacheMemory）。没有，或是别的形状（旧代码写的），返回 null：按冷启动。
 */
export function restoreCache(v: unknown): Cache | null {
  if (!isRecord(v)) return null
  const ok = isNumber(v.lastRequestAt) && isNumber(v.expiresAt) && typeof v.compacted === 'boolean' &&
    isNumber(v.context) && isNumber(v.output) && (v.model === null || typeof v.model === 'string') &&
    (v.last === null || isPart(v.last)) && isPart(v.session) && Array.isArray(v.coldWrites) && v.coldWrites.every(isColdWrite) &&
    typeof v.steppedThisTurn === 'boolean' && isNumber(v.ackedFor)
  return ok ? JSON.parse(JSON.stringify(v)) as Cache : null
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
 * 会话内 `/resume`、`/branch` 换的是另一个会话：上一个会话的读数、命中率、冷写都不再算，先清零（同 `/clear`，
 * 计价用的模型保留），再只按引擎给的字段起步。
 * `context_tokens` 是上一条回复的输入加输出，正是重建量；输出部分不单列，记在 context 里。
 * 引擎判定 `prompt_cache_likely_expired` 时，过期时刻最晚取现在：哪怕按 1 小时还没到（引擎知道真实 TTL）。
 *
 * saved 是 anvil 上次写进状态文件的过期时刻，算上了续期；引擎的两个字段只看最后一次主会话回复、不知道续期，
 * 退出前续过期的会话恢复后会被误判过期（用户 2026-10-15 实测被守卫拦下；同一分钟里跨进程 resume 实测缓存全部读到）。
 * saved 比引擎给的晚就照它；但引擎判定已过期、离最后一次回复又不到 1 小时（或没给），说明引擎知道 TTL 更短
 * （超额后 5 分钟），不照它。cache-tax 的 seedFromResume 只看引擎的字段。
 */
export function seedFromResume(c: Cache, e: ResumeFields, now: number, saved: number | null = null) {
  if (e.source !== 'resume' && e.source !== 'fork') return
  resetForClear(c)
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) c.context = e.context_tokens
  if (typeof e.model === 'string') c.model = e.model
  if (typeof e.seconds_since_last_response === 'number') stampRequest(c, now - e.seconds_since_last_response * 1000)
  if (e.prompt_cache_likely_expired === true) c.expiresAt = Math.min(c.expiresAt || now, now)
  const since = e.seconds_since_last_response
  const shortTtl = e.prompt_cache_likely_expired === true && (typeof since !== 'number' || since * 1000 < TTL_MS)
  if (saved !== null && !shortTtl && saved > c.expiresAt) c.expiresAt = saved
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
  const cost = usd === null ? '' : ` (~${formatUsd(usd)})`
  return `anvil: the cache expired ${formatDuration(now - c.expiresAt)} ago; sending this message rebuilds ${formatTokens(rebuild)} tokens${cost}. ` +
    'The message is back in the prompt: press Enter again to send it, or /clear to start a new session if you no longer need this context.'
}
