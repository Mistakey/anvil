// 用量框的纯逻辑（spec D8、D10）：5h、7d、上下文、花费。读数的收集在 register.ts。

import type { RateLimit, Usage } from '../types'
import { cells, padEnd, padStart } from './text'
import { COLOR, FIELD, GRID, ICON, bar, barWidth, flow, levelColor, piece, valueWidth } from './style'
import type { Piece, Segment } from './style'

export const EMPTY_USAGE: Usage = { context: null, rateLimits: [], costUsd: null }

/** 引擎的一次读数（`$.session.usage()` 或 `session.measure`）里用量框要的部分 */
export type Reading = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly RateLimit[]
  cost?: { usd: number }
}

export function applyReading(usage: Usage, reading: Reading): Usage {
  const { tokens, window, percent } = reading.context
  return {
    ...usage,
    context: { tokens, window, percent },
    rateLimits: reading.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
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

// ---------------------------------------------------------------- 行

/**
 * 两列的一项：名称 | 值。值已排到值那一列的宽度以内：lines 的第一行和名称同一行，
 * 其余各是一行，名称那一列空着，从值那一列起（第二行的细节、放不下折下去的块）。
 * labelWidth：名称那一列的宽度。
 */
export type GridRow = { key: string; label: Segment[]; labelWidth: number; lines: Segment[][] }

/** 排版前的一项：value 和名称同一行起，detail 另起一行；每块不拆开，放不下整块折到下一行 */
export type GridSpec = { key: string; label: string | Segment[]; value: Piece[]; detail?: Piece[] }

/**
 * 按框内宽度 inner 排一项：值那一列放不下就整块折到下一行，不截断信息。
 * detailWidth：细节那几行的宽度，默认整个值那一列。
 */
export function layoutRow(spec: GridSpec, inner: number, labelWidth: number = GRID.label, detailWidth?: number): GridRow {
  const width = valueWidth(inner, labelWidth)
  const label = typeof spec.label === 'string' ? [{ text: spec.label, color: COLOR.label }] : spec.label
  const room = detailWidth ?? width
  const detail = spec.detail ? flow(spec.detail, room, room) : []
  return { key: spec.key, label, labelWidth, lines: [...flow(spec.value, width, width), ...detail] }
}

const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3_600_000 },
  seven_day: { label: '7d', ms: 7 * DAY },
}

/** 第二行的细节暗色 */
const minor = (text: string): Segment => ({ text, color: COLOR.label })

/** 进度条加右对齐的百分比，同色；三条进度条一样长，百分比上下对齐 */
const meter = (percent: number, text: string, inner: number): Piece =>
  piece([...bar(percent, barWidth(inner)), { text: ` ${padStart(text, FIELD.percent)}`, color: levelColor(percent) }])

// ---------------------------------------------------------------- 预测的速度（spec D8）

/** 一个读数：时刻（`$.clock.now()` 的毫秒）和当时的百分比 */
export type Sample = { at: number; percent: number }

/** 一个窗口的读数存档（`$.store`，本机会话共用）：属于哪个窗口（重置时刻），读数按时刻排 */
export type History = { resetsAt: number; samples: Sample[] }

/** 各窗口的存档 */
export type Histories = Partial<Record<'five_hour' | 'seven_day', History>>

/** 存档按窗口分键 */
export const HISTORY_KEYS = { five_hour: 'usageHistory.five_hour', seven_day: 'usageHistory.seven_day' } as const

/** 速度看最近多久（lookbackMs）；存档分桶（bucketMs），一个桶只留最后一个读数 */
export const TREND = {
  five_hour: { lookbackMs: 3_600_000, bucketMs: 60_000 },
  seven_day: { lookbackMs: DAY, bucketMs: 5 * 60_000 },
} as const

/**
 * 记下一个读数：重置时刻变了（新窗口）就从空存档起；同一桶只留最后一个；
 * 只留时刻晚于 at − lookback 的读数，加上 at − lookback 之前最近的一个
 */
export function recordSample(history: History | null, kind: keyof typeof TREND, resetsAt: number, sample: Sample): History {
  const { lookbackMs, bucketMs } = TREND[kind]
  const bucket = (at: number) => Math.floor(at / bucketMs)
  const kept = history !== null && history.resetsAt === resetsAt ? history.samples : []
  const samples = [...kept.filter(one => bucket(one.at) !== bucket(sample.at)), sample].sort((a, b) => a.at - b.at)
  const since = sample.at - lookbackMs
  const before = samples.filter(one => one.at <= since).at(-1)
  return { resetsAt, samples: [...(before ? [before] : []), ...samples.filter(one => one.at > since)] }
}

/** `$.store` 里读回来的存档；不是存档的样子就当没有 */
export function parseHistory(value: unknown): History | null {
  if (value === null || typeof value !== 'object') return null
  const { resetsAt, samples } = value as { resetsAt?: unknown; samples?: unknown }
  if (typeof resetsAt !== 'number' || !Array.isArray(samples)) return null
  const valid = samples.every(one => typeof one?.at === 'number' && typeof one?.percent === 'number')
  return valid ? { resetsAt, samples: samples as Sample[] } : null
}

/**
 * 速度：span 毫秒用了 used 个百分点。看最近 lookback：取 now − lookback 之前最近的读数，当作那时的用量
 * （没读数的空档里用量不变），分母固定是 lookback；窗口开始到现在不到 lookback、或存档里没有那之前的读数时，
 * 退回窗口开始以来的平均
 */
export function burnRate(percent: number, resetsAt: number, windowMs: number, now: number, lookbackMs: number, samples: readonly Sample[]): { used: number; span: number } {
  const elapsed = now - (resetsAt - windowMs)
  const before = samples.filter(one => one.at <= now - lookbackMs).at(-1)
  if (elapsed < lookbackMs || before === undefined) return { used: percent, span: elapsed }
  return { used: percent - before.percent, span: lookbackMs }
}

/** 第二行左列"󰑐 重置时刻"的宽度：按最长的"󰑐 00:00 00-00"留，5h、7d 的右列起点相同 */
const RESET_WIDTH = cells(`${ICON.reset} 00:00 00-00`)

/**
 * 预测只用图标：按速度到 100% 的时刻不晚于重置是红色"󰂃 用完时刻"，否则（速度 ≤ 0 也是）绿色 󰁹；已用满红色 󰂎
 */
function forecast(percent: number, resetsAt: number, rate: { used: number; span: number }, now: number): Segment {
  if (percent >= 100) return { text: ICON.batteryOut, color: COLOR.danger }
  if (rate.used <= 0 || rate.span <= 0) return { text: ICON.battery, color: COLOR.ok }
  const emptyAt = now + ((100 - percent) * rate.span) / rate.used
  if (emptyAt > resetsAt) return { text: ICON.battery, color: COLOR.ok }
  return { text: `${ICON.batteryAlert} ${formatWhen(emptyAt, now)}`, color: COLOR.danger }
}

/** 5h、7d：进度条 百分比；第二行两列：暗色"󰑐 重置时刻" | 预测图标 */
function limitRow(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number, inner: number, histories: Histories): GridSpec {
  const { label, ms } = WINDOWS[kind] ?? { label: kind, ms: 0 }
  const limit = limits.find(one => one.kind === kind)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  // 没有读数，或窗口已经过了重置时刻：下一条消息才开始新窗口
  if (limit === undefined || resetsAt === null || resetsAt <= now) {
    return { key: kind, label, value: [meter(0, '0%', inner)], detail: [piece([minor('发送消息后开始计时')])] }
  }
  const percent = limit.percentUsed
  const history = histories[kind]
  const samples = history !== undefined && history.resetsAt === resetsAt ? history.samples : []
  const rate = burnRate(percent, resetsAt, ms, now, TREND[kind].lookbackMs, samples)
  const detail: Piece[] = [
    piece([minor(padEnd(`${ICON.reset} ${formatWhen(resetsAt, now)}`, RESET_WIDTH))]),
    piece([forecast(percent, resetsAt, rate, now)], minor(' '.repeat(GRID.gap))),
  ]
  return { key: kind, label, value: [meter(percent, `${Math.round(percent)}%`, inner)], detail }
}

/** 上下文：进度条 百分比；第二行 已用 / 上限 */
function contextRow(usage: Usage, inner: number): GridSpec {
  const context = usage.context
  const window = context === null ? '' : ` / ${formatTokens(context.window)}`
  if (context === null || context.percent === undefined || context.tokens === undefined) {
    return { key: 'context', label: '上下文', value: [meter(0, '—', inner)], detail: [piece([minor(`—${window}`)])] }
  }
  const percent = context.percent
  return {
    key: 'context',
    label: '上下文',
    value: [meter(percent, `${Math.round(percent)}%`, inner)],
    detail: [piece([minor(`${formatTokens(context.tokens)}${window}`)])],
  }
}

/** 花费：本会话总额（引擎报的会话花费，`/cost` 同源） */
function costRow(usage: Usage): GridSpec {
  return { key: 'cost', label: '花费', value: [piece([{ text: usage.costUsd === null ? '—' : formatUsd(usage.costUsd) }])] }
}

/** 用量框的四项，按框内宽度 inner 排好（layoutRow）；histories 是 5h、7d 的读数存档，预测的速度从它算 */
export function usageRows(usage: Usage, now: number, inner: number, histories: Histories = {}): GridRow[] {
  const rows = [
    limitRow('five_hour', usage.rateLimits, now, inner, histories),
    limitRow('seven_day', usage.rateLimits, now, inner, histories),
    contextRow(usage, inner),
    costRow(usage),
  ]
  // 第二行不超出百分比那一列的右边界
  return rows.map(row => layoutRow(row, inner, GRID.label, barWidth(inner) + 1 + FIELD.percent))
}
