// 用量框的纯逻辑（spec D8、D10）：5h、7d、上下文、花费四行。读数的收集在 register.ts。

import type { RateLimit, Usage } from '../types'
import { cells, padEnd, padStart } from './text'
import { COLOR, FIELD, GAP, bar, flow, levelColor, piece, valueWidth } from './style'
import type { Piece, Segment } from './style'

export const EMPTY_USAGE: Usage = {
  context: null,
  rateLimits: [],
  costUsd: null,
  compactions: 0,
  costAtTurnStart: null,
  lastMessageCostUsd: null,
}

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

/** 主会话一轮开始：记下当时的会话花费 */
export function startTurn(usage: Usage, costUsd: number | null): Usage {
  return { ...usage, costAtTurnStart: costUsd, costUsd: costUsd ?? usage.costUsd }
}

/** 主会话一轮结束：上一条消息的花费是两次读数之差 */
export function completeTurn(usage: Usage, costUsd: number | null): Usage {
  const start = usage.costAtTurnStart
  const last = costUsd !== null && start !== null ? Math.max(0, costUsd - start) : usage.lastMessageCostUsd
  return { ...usage, costUsd: costUsd ?? usage.costUsd, costAtTurnStart: null, lastMessageCostUsd: last }
}

export function compacted(usage: Usage): Usage {
  return { ...usage, compactions: usage.compactions + 1 }
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

/** 本地时刻：今天写 HH:MM，明天写"明天 HH:MM"，更远写"周四 HH:MM" */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at)
  const hhmm = `${two(date.getHours())}:${two(date.getMinutes())}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((at - today.getTime()) / DAY)
  if (days <= 0) return hhmm
  if (days === 1) return `明天 ${hhmm}`
  return `${WEEKDAYS[date.getDay()]} ${hhmm}`
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
 * 两列的一行：名称 | 值。值已排到值那一列的宽度以内，放不下的块整块折到下一行：
 * lines 的第一行和名称同一行，其余各是一行，名称那一列空着，从值那一列起。
 */
export type GridRow = { key: string; label: string; lines: Segment[][] }

/** 排版前的一行：值由几块组成，每块不拆开 */
export type GridSpec = { key: string; label: string; value: Piece[] }

/** 按框内宽度 inner 排一行：值那一列放不下就整块折到下一行，不截断信息 */
export function layoutRow(spec: GridSpec, inner: number): GridRow {
  const width = valueWidth(inner)
  return { key: spec.key, label: spec.label, lines: flow(spec.value, width, width) }
}

const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3_600_000 },
  seven_day: { label: '7d', ms: 7 * DAY },
}

const muted = (text: string): Segment => ({ text, color: COLOR.muted })
/** 次要的：上一条、↻ 重置时刻、压缩次数 */
const minor = (text: string): Segment => ({ text, color: COLOR.label })

/** 定宽的数值字段：右对齐补到 width 格（进度条后的百分比） */
export const field = (text: string, width: number) => padStart(text, width)

/** 值那一列开头的定宽字段：左对齐，右侧补空格到 width 格 */
export const lead = (text: string, width: number) => padEnd(text, width)

/** 进度条加定宽的百分比，同色 */
const meter = (percent: number, text: string): Piece => piece([...bar(percent), { text: ` ${field(text, FIELD.percent)}`, color: levelColor(percent) }])

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

/** 5h、7d：进度条 百分比  ↻ 重置时刻（  预计用尽）；↻ 沿用用户 statusline 的写法 */
function limitRow(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number): GridSpec {
  const { label, ms } = WINDOWS[kind] ?? { label: kind, ms: 0 }
  const limit = limits.find(one => one.kind === kind)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  // 没有读数，或窗口已经过了重置时刻：下一条消息才开始新窗口
  if (limit === undefined || resetsAt === null || resetsAt <= now) {
    return { key: kind, label, value: [meter(0, '0%'), piece([minor('发送消息后开始计时')], GAP)] }
  }
  const percent = limit.percentUsed
  const value: Piece[] = [meter(percent, `${Math.round(percent)}%`), piece([minor(`↻ ${formatWhen(resetsAt, now)}`)], GAP)]
  if (kind === 'five_hour') {
    const at = exhaustAt(percent, resetsAt, ms, now)
    if (at !== null) value.push(piece([{ text: `预计 ${formatWhen(at, now)} 用尽`, color: COLOR.high }], GAP))
  }
  return { key: kind, label, value }
}

/** 上下文：已用 / 上限  百分比  压缩 N 次；已用补到定宽（同一个上限下），百分比右对齐 */
function contextRow(usage: Usage): GridSpec {
  const context = usage.context
  const compactions = piece([minor(`压缩 ${usage.compactions} 次`)], GAP)
  if (context === null || context.percent === undefined || context.tokens === undefined) {
    const window = context === null ? [] : [muted(` / ${formatTokens(context.window)}`)]
    return { key: 'context', label: '上下文', value: [piece([{ text: '—' }, ...window]), compactions] }
  }
  const percent = context.percent
  const tokens = formatTokens(context.tokens)
  const window = ` / ${formatTokens(context.window)}`
  const used = [
    { text: tokens },
    muted(lead(window, cells(window) + FIELD.tokens - cells(tokens))),
    { text: ` ${field(`${Math.round(percent)}%`, FIELD.percent)}`, color: levelColor(percent) },
  ]
  return { key: 'context', label: '上下文', value: [piece(used), compactions] }
}

/** 花费：本会话 $  上一条 $；本会话不写"本会话"，上一条暗色 */
function costRow(usage: Usage): GridSpec {
  const usd = (value: number | null) => (value === null ? '—' : formatUsd(value))
  return {
    key: 'cost',
    label: '花费',
    value: [piece([{ text: lead(usd(usage.costUsd), FIELD.usd) }]), piece([minor(`上一条 ${usd(usage.lastMessageCostUsd)}`)], GAP)],
  }
}

/** 用量框的四行，按框内宽度 inner 排好（layoutRow） */
export function usageRows(usage: Usage, now: number, inner: number): GridRow[] {
  const rows = [limitRow('five_hour', usage.rateLimits, now), limitRow('seven_day', usage.rateLimits, now), contextRow(usage), costRow(usage)]
  return rows.map(row => layoutRow(row, inner))
}
