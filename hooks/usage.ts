// 用量框的纯逻辑（spec D8）：5h、7d、上下文、花费四行。读数的收集在 register.ts。

import type { RateLimit, Usage } from '../types'
import { cells, fit, padStart } from './text'
import { COLOR, GRID, SEPARATOR, bar, levelColor, restWidth } from './style'
import type { Segment } from './style'

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

/** 152k、1.2M；不到一千原样 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
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
 * 三列网格的一行：标签 | 中间 18 格 | 其余；其余已截到第三列的宽度。
 * `span` 时中间一列占满后两列（rest 不画），如缓存框的保活状态。
 */
export type GridRow = { key: string; label: string; middle: Segment[]; rest: Segment[]; span?: boolean }

/** 把几段文字截到 width 格以内：放不下的那段截断加 `…`，后面的丢掉 */
export function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  const kept: Segment[] = []
  let left = width
  for (const segment of segments) {
    const size = cells(segment.text)
    if (size <= left) {
      kept.push(segment)
      left -= size
      continue
    }
    if (left > 0) kept.push({ ...segment, text: fit(segment.text, left) })
    break
  }
  return kept
}

const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3_600_000 },
  seven_day: { label: '7d', ms: 7 * DAY },
}

const percentCell = (text: string, color: string): Segment => ({ text: `${padStart(text, 4)} `, color })
const muted = (text: string): Segment => ({ text, color: COLOR.muted })

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

function limitRow(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number): GridRow {
  const { label, ms } = WINDOWS[kind] ?? { label: kind, ms: 0 }
  const limit = limits.find(one => one.kind === kind)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  // 没有读数，或窗口已经过了重置时刻：下一条消息才开始新窗口
  if (limit === undefined || resetsAt === null || resetsAt <= now) {
    return { key: kind, label, middle: bar(0), rest: [percentCell('0%', levelColor(0)), muted('发送消息后开始计时')] }
  }
  const percent = limit.percentUsed
  const color = levelColor(percent)
  const rest: Segment[] = [percentCell(`${Math.round(percent)}%`, color), muted(`${formatWhen(resetsAt, now)} 重置`)]
  if (kind === 'five_hour') {
    const at = exhaustAt(percent, resetsAt, ms, now)
    if (at !== null) rest.push(SEPARATOR, { text: `预计 ${formatWhen(at, now)} 用尽`, color: COLOR.high })
  }
  return { key: kind, label, middle: bar(percent), rest }
}

function contextRow(usage: Usage): GridRow {
  const context = usage.context
  const compactions = muted(`已压缩 ${usage.compactions} 次`)
  if (context === null || context.percent === undefined || context.tokens === undefined) {
    const window = context === null ? '' : ` / ${formatTokens(context.window)}`
    return { key: 'context', label: '上下文', middle: bar(0), rest: [percentCell('—', COLOR.muted), { text: '—' }, muted(window), SEPARATOR, compactions] }
  }
  const color = levelColor(context.percent)
  return {
    key: 'context',
    label: '上下文',
    middle: bar(context.percent),
    rest: [
      percentCell(`${Math.round(context.percent)}%`, color),
      { text: formatTokens(context.tokens) },
      muted(` / ${formatTokens(context.window)}`),
      SEPARATOR,
      compactions,
    ],
  }
}

function costRow(usage: Usage): GridRow {
  const usd = (value: number | null) => ({ text: ` ${value === null ? '—' : formatUsd(value)}` })
  return {
    key: 'cost',
    label: '花费',
    middle: [muted('上一条消息'), usd(usage.lastMessageCostUsd)],
    rest: [muted('本会话'), usd(usage.costUsd)],
  }
}

/** 用量框的四行，每行各列都已截到 inner 格（框内宽度）以内 */
export function usageRows(usage: Usage, now: number, inner: number): GridRow[] {
  const rows = [limitRow('five_hour', usage.rateLimits, now), limitRow('seven_day', usage.rateLimits, now), contextRow(usage), costRow(usage)]
  return rows.map(row => ({ ...row, middle: fitSegments(row.middle, GRID.middle), rest: fitSegments(row.rest, restWidth(inner)) }))
}
