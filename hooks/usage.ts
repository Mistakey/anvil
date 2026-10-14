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
  const label = typeof spec.label === 'string' ? [{ text: spec.label, color: COLOR.secondary }] : spec.label
  const room = detailWidth ?? width
  const detail = spec.detail ? flow(spec.detail, room, room) : []
  return { key: spec.key, label, labelWidth, lines: [...flow(spec.value, width, width), ...detail] }
}

const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3_600_000 },
  seven_day: { label: '7d', ms: 7 * DAY },
}

/** 第二行的细节：次要色 */
const minor = (text: string): Segment => ({ text, color: COLOR.secondary })

/** 进度条加右对齐的百分比，同色；三条进度条一样长，百分比上下对齐 */
const meter = (percent: number, text: string, inner: number): Piece =>
  piece([...bar(percent, barWidth(inner)), { text: ` ${padStart(text, FIELD.percent)}`, color: levelColor(percent) }])

// ---------------------------------------------------------------- 预测的速度（spec D8）

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
 * 速度看最近多久（lookbackMs）；存档留多久（keepMs，再加那之前最近的一个）；分桶（bucketMs），一个桶只留最后一个读数。
 * 7d 照上周同一时段重演要 7 天前的读数，存档留 8 天；lookbackMs 是存档不足 7 天时 24 小时重放用的
 */
export const TREND = {
  five_hour: { lookbackMs: 3_600_000, keepMs: 3_600_000, bucketMs: 60_000 },
  seven_day: { lookbackMs: DAY, keepMs: 8 * DAY, bucketMs: 5 * 60_000 },
} as const

/** 7d 照上周同一时段重演的周期 */
const WEEK = 7 * DAY

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

/** 面板现算预测用的读数：5h 只用本窗口的存档；7d 全部（补上 total），和本窗口起点的累计用量 */
function forecastSamples(kind: keyof typeof TREND, history: History | undefined, resetsAt: number): { samples: Sample[]; base: number } {
  if (history === undefined) return { samples: [], base: 0 }
  if (kind === 'seven_day') return { samples: withTotals(history), base: windowBase(history, resetsAt) }
  return { samples: sameWindow(history, resetsAt) ? history.samples : [], base: 0 }
}

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
 * 速度：span 毫秒用了 used 个百分点。看最近 lookback：取 now − lookback 之前最近的读数，当作那时的用量
 * （没读数的空档里用量不变），分母固定是 lookback；窗口开始到现在不到 lookback 时，窗口开始前当作没用
 * （现在百分比 ÷ lookback）；窗口开始已超过 lookback、存档里又没有那之前的读数时，退回窗口开始以来的平均
 */
export function burnRate(percent: number, resetsAt: number, windowMs: number, now: number, lookbackMs: number, samples: readonly Sample[]): { used: number; span: number } {
  const elapsed = now - (resetsAt - windowMs)
  if (elapsed < lookbackMs) return { used: percent, span: lookbackMs }
  const before = samples.filter(one => one.at <= now - lookbackMs).at(-1)
  if (before === undefined) return { used: percent, span: elapsed }
  return { used: percent - before.percent, span: lookbackMs }
}

/**
 * 用完时刻；最近一段没用是 null。5h 按 burnRate 匀速外推。
 * 7d 照上周同一时段重演：C(x) 是 x 之前最近读数的 total，一周用 U = C(now) − C(now − 7 天)；还差的 need 先按整周数
 * k = ⌊need ÷ U⌋ 走，余下 r 在最近 7 天里找第一个用到 C(now − 7 天) + r 的时刻，平移到第 k + 1 周。base 是本窗口起点
 * 的累计用量，C(now) = base + 现在百分比；读数没有 total 的按 base + 百分比算。
 * 存档没有 7 天前的读数时退回 24 小时重放（replayDay），只看本窗口的读数
 */
export function emptyAt(kind: keyof typeof TREND, percent: number, resetsAt: number, now: number, samples: readonly Sample[], base: number = 0): number | null {
  const windowMs = WINDOWS[kind]?.ms ?? 0
  if (kind === 'seven_day') {
    const totals = samples.map(one => ({ at: one.at, total: one.total ?? base + one.percent }))
    const weekAgo = now - WEEK
    const start = totals.filter(one => one.at <= weekAgo).at(-1)
    if (start !== undefined) {
      const current = base + percent
      const used = current - start.total
      if (used <= 0) return null
      const need = 100 - percent
      const k = Math.floor(need / used)
      const rest = need - k * used
      if (rest <= 0) return now + k * WEEK
      const recent = [...totals.filter(one => one.at > weekAgo && one.at < now), { at: now, total: current }]
      const ts = recent.find(one => one.total - start.total >= rest)?.at ?? now
      return now + k * WEEK + (ts - weekAgo)
    }
    const windowStart = resetsAt - windowMs
    const inWindow = totals.filter(one => one.at >= windowStart).map(one => ({ at: one.at, percent: one.total - base }))
    return replayDay(percent, resetsAt, now, inWindow)
  }
  const rate = burnRate(percent, resetsAt, windowMs, now, TREND[kind].lookbackMs, samples)
  if (rate.used <= 0 || rate.span <= 0) return null
  return now + ((100 - percent) * rate.span) / rate.used
}

/**
 * 7d 存档不足 7 天时的 24 小时重放：接下来每天照最近 24 小时逐时段的用法重演——base 是 now − L 时的用量
 * （窗口开始前当作 0），一天用 U = 现在 − base；还差的 need 先按整天数 k = ⌊need ÷ U⌋ 走，余下 r 在最近 24 小时里
 * 找第一个用到 base + r 的时刻，平移到第 k + 1 天。窗口已超过 L、存档里又没有 now − L 之前的读数时，
 * 退回 burnRate 的窗口平均匀速。samples 是本窗口的读数
 */
function replayDay(percent: number, resetsAt: number, now: number, samples: readonly Sample[]): number | null {
  const windowMs = WINDOWS.seven_day?.ms ?? 0
  const { lookbackMs } = TREND.seven_day
  const since = now - lookbackMs
  const before = samples.filter(one => one.at <= since).at(-1)
  const outsideWindow = since < resetsAt - windowMs
  if (outsideWindow || before !== undefined) {
    const base = outsideWindow || before === undefined ? 0 : before.percent
    const day = percent - base
    if (day <= 0) return null
    const need = 100 - percent
    const k = Math.floor(need / day)
    const rest = need - k * day
    if (rest <= 0) return now + k * lookbackMs
    const recent = [...samples.filter(one => one.at > since && one.at < now), { at: now, percent }]
    const ts = recent.find(one => one.percent - base >= rest)?.at ?? now
    return now + k * lookbackMs + (ts - since)
  }
  const rate = burnRate(percent, resetsAt, windowMs, now, lookbackMs, samples)
  if (rate.used <= 0 || rate.span <= 0) return null
  return now + ((100 - percent) * rate.span) / rate.used
}

/** 第二行左列"󰑐 重置时刻"的宽度：按最长的"󰑐 00:00 00-00"留，5h、7d 的右列起点相同；图标用图标色，时刻是次要文字 */
const RESET_WIDTH = cells(`${ICON.reset} 00:00 00-00`)

/**
 * 预测一律"图标 时刻"。好状态只给图标上色：用完时刻晚于重置是绿色的 󰁹 加次要色的时刻（用不完写"󰁹 —"）；
 * 出问题整块红：不晚于重置是"󰂃 用完时刻"，已用满是"󰂎 用满的时刻"（存档里没有 ≥ 100% 的读数写"—"）
 */
function forecast(percent: number, resetsAt: number, empty: number | null, now: number, fullAt: number | undefined): Segment[] {
  if (percent >= 100) return [{ text: `${ICON.batteryOut} ${fullAt === undefined ? '—' : formatWhen(fullAt, now)}`, color: COLOR.danger }]
  if (empty !== null && empty <= resetsAt) return [{ text: `${ICON.batteryAlert} ${formatWhen(empty, now)}`, color: COLOR.danger }]
  return [{ text: `${ICON.battery} `, color: COLOR.ok }, minor(empty === null ? '—' : formatWhen(empty, now))]
}

/**
 * 本会话还没有读数时（引擎的读数来自本进程最近一次 API 响应，开局、`/clear` 后要等第一条消息）
 * 用存档里最近的读数：存档本机会话共用，窗口没过重置时它就是已知最新的用量
 */
function storedLimit(kind: 'five_hour' | 'seven_day', history: History | undefined, now: number): RateLimit | undefined {
  const last = history?.samples.at(-1)
  if (history === undefined || last === undefined || history.resetsAt <= now) return undefined
  return { kind, percentUsed: last.percent, resetsAt: new Date(history.resetsAt).toISOString() }
}

/** 5h、7d：进度条 百分比；第二行两列："󰑐 重置时刻"（次要色） | 预测"图标 时刻" */
function limitRow(kind: 'five_hour' | 'seven_day', limits: readonly RateLimit[], now: number, inner: number, histories: Histories): GridSpec {
  const { label } = WINDOWS[kind] ?? { label: kind }
  const limit = limits.find(one => one.kind === kind) ?? storedLimit(kind, histories[kind], now)
  const resetsAt = parseResetsAt(limit?.resetsAt)
  // 没有读数，或窗口已经过了重置时刻：下一条消息才开始新窗口
  if (limit === undefined || resetsAt === null || resetsAt <= now) {
    return { key: kind, label, value: [meter(0, '0%', inner)], detail: [piece([minor('发送消息后开始计时')])] }
  }
  const percent = limit.percentUsed
  const { samples, base } = forecastSamples(kind, histories[kind], resetsAt)
  const empty = emptyAt(kind, percent, resetsAt, now, samples, base)
  const detail: Piece[] = [
    piece([{ text: `${ICON.reset} `, color: COLOR.icon }, minor(padEnd(formatWhen(resetsAt, now), RESET_WIDTH - cells(`${ICON.reset} `)))]),
    piece(forecast(percent, resetsAt, empty, now, firstFull(samples, base)?.at), minor(' '.repeat(GRID.gap))),
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
