// 用量框的纯逻辑（spec D8、D10）：5h、7d、上下文、花费。读数的收集在 register.ts。

import type { RateLimit, Usage } from '../types'
import { padStart } from './text'
import { COLOR, FIELD, GRID, bar, barWidth, flow, levelColor, piece, valueWidth } from './style'
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
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY = 86_400_000

/** 本地时刻的时分，和它是今天、明天还是星期几（今天为 null） */
function clockOf(at: number, now: number): { hhmm: string; day: string | null } {
  const date = new Date(at)
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((at - today.getTime()) / DAY)
  if (days <= 0) return { hhmm, day: null }
  return { hhmm, day: days === 1 ? '明天' : (WEEKDAYS[date.getDay()] ?? '') }
}

/** 本地时刻：今天写 HH:MM，明天写"明天 HH:MM"，更远写"周四 HH:MM" */
export function formatWhen(at: number, now: number): string {
  const { hhmm, day } = clockOf(at, now)
  return day === null ? hhmm : `${day} ${hhmm}`
}

/** 重置时刻：时间在前，"17:00 周一""01:30 明天"，今天只写 HH:MM（5h、7d 的 ↻ 上下对齐） */
export function formatReset(at: number, now: number): string {
  const { hhmm, day } = clockOf(at, now)
  return day === null ? hhmm : `${hhmm} ${day}`
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

/** 按框内宽度 inner 排一项：值那一列放不下就整块折到下一行，不截断信息 */
export function layoutRow(spec: GridSpec, inner: number, labelWidth: number = GRID.label): GridRow {
  const width = valueWidth(inner, labelWidth)
  const label = typeof spec.label === 'string' ? [{ text: spec.label, color: COLOR.label }] : spec.label
  const detail = spec.detail ? flow(spec.detail, width, width) : []
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

/**
 * 按当前用量线性外推，用尽时刻早于重置时就是"预计用尽"的时刻；否则 null。
 * 窗口开始 = 重置时刻 − 窗口长度。
 */
export function exhaustAt(percent: number, resetsAt: number, windowMs: number, now: number): number | null {
  const elapsed = now - (resetsAt - windowMs)
  if (percent <= 0 || elapsed <= 0 || percent >= 100) return null
  const at = now + (elapsed * (100 - percent)) / percent
  return at < resetsAt ? at : null
}

/** 5h、7d：进度条 百分比；第二行 ↻ 重置时刻，会在重置前用尽时接红字"· 预计 HH:MM 用尽" */
function limitRow(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number, inner: number): GridSpec {
  const { label, ms } = WINDOWS[kind] ?? { label: kind, ms: 0 }
  const limit = limits.find(one => one.kind === kind)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  // 没有读数，或窗口已经过了重置时刻：下一条消息才开始新窗口
  if (limit === undefined || resetsAt === null || resetsAt <= now) {
    return { key: kind, label, value: [meter(0, '0%', inner)], detail: [piece([minor('发送消息后开始计时')])] }
  }
  const percent = limit.percentUsed
  const detail: Piece[] = [piece([minor(`↻ ${formatReset(resetsAt, now)}`)])]
  const at = exhaustAt(percent, resetsAt, ms, now)
  if (at !== null) detail.push(piece([{ text: `预计 ${formatWhen(at, now)} 用尽`, color: COLOR.danger }], { text: ' · ', color: COLOR.danger }))
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

/** 用量框的四项，按框内宽度 inner 排好（layoutRow） */
export function usageRows(usage: Usage, now: number, inner: number): GridRow[] {
  const rows = [
    limitRow('five_hour', usage.rateLimits, now, inner),
    limitRow('seven_day', usage.rateLimits, now, inner),
    contextRow(usage, inner),
    costRow(usage),
  ]
  return rows.map(row => layoutRow(row, inner))
}
