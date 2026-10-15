// 输入框上方那一行的 5h、7d 和花费：读数、格式和 5h/7d 的读数存档。读数的收集在 register.ts，画在 band.tsx。

import type { RateLimit, Usage } from '../types'
import { COLOR, ICON, bar, levelColor } from './style'
import type { Segment } from './style'

export const EMPTY_USAGE: Usage = { rateLimits: [], costUsd: null }

/** 引擎的一次读数（`$.session.usage()` 或 `session.measure`）里要的部分 */
export type Reading = {
  rateLimits: readonly RateLimit[]
  cost?: { usd: number }
}

/** 读数里没有 5h、7d（开局还没有响应）时留着原来的：可能是存档里最近的（storedLimits） */
export function applyReading(usage: Usage, reading: Reading): Usage {
  return {
    ...usage,
    rateLimits: reading.rateLimits.length === 0 ? usage.rateLimits : reading.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    costUsd: reading.cost?.usd ?? usage.costUsd,
  }
}

// ---------------------------------------------------------------- 格式

/** 152k、1.2M；不到一千原样。快到一百万时写 1M，不写 1000k */
export function formatTokens(tokens: number): string {
  if (tokens >= 999_500) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(Math.round(tokens))
}

/** $0.31、$123 */
export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

const two = (n: number) => String(n).padStart(2, '0')
const DAY = 86_400_000

/** 本地时刻，一律绝对时刻：当天写 HH:MM，不是当天写 HH:MM MM-DD（时间在前）；不写星期、"明天" */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at)
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  return date.toDateString() === new Date(now).toDateString() ? hhmm : `${hhmm} ${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** 重置时刻：ISO 8601；也认 Unix 秒、毫秒（statusline 见过这几种） */
export function parseResetsAt(resetsAt: string | undefined): number | null {
  if (resetsAt === undefined || resetsAt === '') return null
  if (/^\d+(\.\d+)?$/.test(resetsAt)) {
    const n = Number(resetsAt)
    return n > 1e12 ? n : n * 1000
  }
  const ms = Date.parse(resetsAt)
  return Number.isNaN(ms) ? null : ms
}

// ---------------------------------------------------------------- 读数存档

// 5h、7d 的读数记进 `$.store`（本机会话共用）：本会话还没有读数时先拿存档里最近的画（storedLimits）。
// 7d 记 total 是给以后的用完预测留的（预测先不做，用户 2026-10-14 定；算法见 git 历史里的 emptyAt）。

/**
 * 一个读数：时刻（`$.clock.now()` 的毫秒）和当时的百分比；7d 再记 total，跨重置连续的累计用量
 * （窗口起点的 base + 百分比）
 */
export type Sample = { at: number; percent: number; total?: number }

/**
 * 读数存档（`$.store`，本机会话共用）：当前窗口（重置时刻），读数按时刻排。5h 只存当前窗口的；
 * 7d 跨重置留着，base 是当前窗口起点的累计用量
 */
export type History = { resetsAt: number; base?: number; samples: Sample[] }

/** 各窗口的存档 */
export type Histories = Partial<Record<'five_hour' | 'seven_day', History>>

/** 存档按窗口分键 */
export const HISTORY_KEYS = { five_hour: 'usageHistory.five_hour', seven_day: 'usageHistory.seven_day' } as const

/**
 * 存档留多久（keepMs，再加那之前最近的一个）；分桶（bucketMs），一个桶只留最后一个读数。
 * 7d 留 8 天：照上周同一时段重演要 7 天前的读数
 */
export const TREND = {
  five_hour: { keepMs: 3_600_000, bucketMs: 60_000 },
  seven_day: { keepMs: 8 * DAY, bucketMs: 5 * 60_000 },
} as const

/** 重置时刻晚了这么多才算新窗口：resetsAt 有小抖动时不反复清空存档 */
export const NEW_WINDOW_MS = 10 * 60_000

/** 存档是不是这个窗口的：重置时刻比存档里记的晚 NEW_WINDOW_MS 以上才算新窗口 */
export function sameWindow(history: History, resetsAt: number): boolean {
  return resetsAt - history.resetsAt < NEW_WINDOW_MS
}

/** 7d 的读数补上 total：旧存档没记的按它自己的 base 补 */
const withTotals = (history: History): Sample[] =>
  history.samples.map(one => (one.total === undefined ? { ...one, total: (history.base ?? 0) + one.percent } : one))

/** 窗口 resetsAt 起点的累计用量：同一窗口沿用存档的 base；新窗口在 base 上加旧窗口最后一个读数的百分比 */
function windowBase(history: History | null, resetsAt: number): number {
  if (history === null) return 0
  const base = history.base ?? 0
  return sameWindow(history, resetsAt) ? base : base + (history.samples.at(-1)?.percent ?? 0)
}

/**
 * 记下一个读数：同一窗口沿用存档里记的重置时刻；同一桶只留最后一个。5h 新窗口从空存档起；7d 不清空，
 * 读数记上 total（base + 百分比），新窗口的 base 接上旧窗口。只留时刻晚于 at − keep 的读数，加上 at − keep 之前
 * 最近的一个，和本窗口第一个 ≥ 100% 的读数（用满的时刻）
 */
export function recordSample(history: History | null, kind: keyof typeof TREND, resetsAt: number, sample: Sample): History {
  const { keepMs, bucketMs } = TREND[kind]
  const bucket = (at: number) => Math.floor(at / bucketMs)
  const same = history !== null && sameWindow(history, resetsAt)
  const seven = kind === 'seven_day'
  const base = seven ? windowBase(history, resetsAt) : 0
  const kept = history === null ? [] : seven ? withTotals(history) : same ? history.samples : []
  const entry = seven ? { ...sample, total: base + sample.percent } : sample
  const samples = [...kept.filter(one => bucket(one.at) !== bucket(entry.at)), entry].sort((a, b) => a.at - b.at)
  const since = entry.at - keepMs
  const before = samples.filter(one => one.at <= since).at(-1)
  const pruned = [...(before ? [before] : []), ...samples.filter(one => one.at > since)]
  const full = firstFull([...kept, entry].sort((a, b) => a.at - b.at), base)
  const rest = full === undefined || pruned.includes(full) ? pruned : [full, ...pruned].sort((a, b) => a.at - b.at)
  return { resetsAt: same && history !== null ? history.resetsAt : resetsAt, ...(seven ? { base } : {}), samples: rest }
}

/** 本窗口第一个 ≥ 100% 的读数：7d 按 total − base 算本窗口的百分比，上个窗口的读数不算 */
const firstFull = (samples: readonly Sample[], base: number) => samples.find(one => (one.total ?? one.percent) - base >= 100)

/** `$.store` 里读回来的存档；不是存档的样子就当没有 */
export function parseHistory(value: unknown): History | null {
  if (value === null || typeof value !== 'object') return null
  const { resetsAt, base, samples } = value as { resetsAt?: unknown; base?: unknown; samples?: unknown }
  if (typeof resetsAt !== 'number' || !Array.isArray(samples) || (base !== undefined && typeof base !== 'number')) return null
  const valid = samples.every(one => typeof one?.at === 'number' && typeof one?.percent === 'number' && (one.total === undefined || typeof one.total === 'number'))
  if (!valid) return null
  return base === undefined ? { resetsAt, samples: samples as Sample[] } : { resetsAt, base, samples: samples as Sample[] }
}

/**
 * 本会话还没有读数时（引擎的读数来自本进程最近一次 API 响应，开局、`/clear` 后要等一会儿）
 * 用存档里最近的读数：存档本机会话共用，窗口没过重置时它就是已知最新的用量
 */
export function storedLimits(histories: Histories, now: number): RateLimit[] {
  return (['five_hour', 'seven_day'] as const).flatMap(kind => {
    const history = histories[kind]
    const last = history?.samples.at(-1)
    if (history === undefined || last === undefined || history.resetsAt <= now) return []
    return [{ kind, percentUsed: last.percent, resetsAt: new Date(history.resetsAt).toISOString() }]
  })
}

// ---------------------------------------------------------------- 画在那一行里的段

const LABELS = { five_hour: '5h', seven_day: '7d' } as const

/** 进度条 10 格（用户 2026-10-14 定，和 statusline 的一样长） */
export const BAR_CELLS = 10

/**
 * 5h 或 7d：`5h ━━━━━───── 41% 󰑐 21:40`。重置时刻一直显示（用户定）；没有读数、或窗口已过重置时刻
 * （下一条消息才开始新窗口）写 0% 和 —。withBar 为 false 时不画进度条（窄屏）
 */
export function limitSegments(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number, withBar = true): Segment[] {
  const limit = limits.find(one => one.kind === kind)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  const isCurrent = limit !== undefined && resetsAt !== null && resetsAt > now
  const percent = isCurrent ? Math.min(100, Math.max(0, limit.percentUsed)) : 0
  return [
    { text: `${LABELS[kind]} `, color: COLOR.secondary },
    ...(withBar ? [...bar(percent, BAR_CELLS), { text: ' ' }] : []),
    { text: `${Math.round(percent)}%`, color: levelColor(percent) },
    { text: ` ${ICON.reset} `, color: COLOR.icon },
    { text: isCurrent ? formatWhen(resetsAt, now) : '—', color: COLOR.secondary },
  ]
}

/** 花费：本会话总额（引擎报的会话花费，`/cost` 同源）；还没有读数时不画 */
export function costSegments(usage: Usage): Segment[] {
  return usage.costUsd === null ? [] : [{ text: formatUsd(usage.costUsd), color: COLOR.cost }]
}
