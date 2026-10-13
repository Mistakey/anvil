// 面板共用的样式（spec D10，取自设计稿 Version 32）：颜色、图标、名称 | 值两列、定宽字段、进度条。

import { cells, fit } from './text'

/** 一段同色文字；一行由几段拼成 */
export type Segment = { text: string; color?: string; bold?: boolean }

export const COLOR = {
  text: '#e6e9ee',
  /** 标签、次要文字 */
  muted: '#a7adb8',
  /** 分隔符 `·` 和中性边框 */
  faint: '#5b5f67',
  /** 提示文字、身份栏的图标；翻译框有内容时的边框 */
  dim: '#8c939f',
  /** 用量框、缓存框的名称列，用量框第二行的细节（󰑐 重置时刻、已用 / 上限），我的消息的序号；取自用户 statusline 的次要标签 */
  label: '#6b7280',
  /** 进度条的底 */
  track: '#3a3f48',
  // 状态色：进度条四档，也用于命中率等
  ok: '#8fbf7f',
  warn: '#d7bd6f',
  high: '#d79a6f',
  danger: '#e07a7a',
  // 识别色（标题）和对应的边框色；识别色避开状态色
  cache: '#6cc5c0',
  cacheBorder: '#497a79',
  usage: '#7aa7e0',
  usageBorder: '#516a8b',
  agents: '#d78fc4',
  agentsBorder: '#845d7b',
  denials: '#e07a7a',
  denialsBorder: '#895152',
  // 身份栏的 git 配色，取自用户原来的 statusline
  branch: '#b18bd0',
  ahead: '#d7a65f',
  added: '#7fae6f',
  deleted: '#c47878',
} as const

/** Nerd Font 图标；图标后一律留一个空格 */
export const ICON = {
  messages: '\u{F075}',
  denials: '\u{F05E}',
  agents: '\u{F06A9}',
  usage: '\u{F029A}',
  cache: '\u{F01BC}',
  // 用量框第二行：重置时刻；预测（nf-md-battery、battery_alert、battery_outline）
  reset: '\u{F0450}',
  battery: '\u{F0079}',
  batteryAlert: '\u{F0083}',
  batteryOut: '\u{F008E}',
  // 身份栏
  dir: '\u{F07C}',
  branch: '\u{F418}',
  detached: '\u{F417}',
  worktree: '\u{F402}',
  stash: '\u{F51E}',
  lines: '\u{F440}',
  pause: '\u{F04C}',
  model: '\u{F4BC}',
  /** 速度行（nf-fa-bolt） */
  speed: '\u{F0E7}',
  translate: '\u{F05CA}',
  done: '\u{F00C}',
  failed: '\u{F00D}',
} as const

/** 用量框和缓存框的两列：名称 | 值，列间空 2 格；名称都是 6 格，两框的值从同一列起 */
export const GRID = { label: 6, gap: 2 } as const

/** 值那一列的宽度；折下去的行也从这一列起 */
export function valueWidth(inner: number, label: number = GRID.label): number {
  return Math.max(0, inner - label - GRID.gap)
}

/** 进度条后的百分比：右对齐 4 格到 100%，数字变长变短时进度条和百分比上下对齐 */
export const FIELD = { percent: 4 } as const

/**
 * 进度条的长度：值那一列除了百分比（前面空 1 格）都给进度条，右边留 1 格。
 * 三条进度条一样长；框 48 列（框内 44 格）时 30 格，和用户的终稿一致。
 */
export function barWidth(inner: number): number {
  return Math.max(1, valueWidth(inner) - FIELD.percent - 2)
}

/** 进度条四档：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红 */
export function levelColor(percent: number): string {
  if (percent >= 90) return COLOR.danger
  if (percent >= 80) return COLOR.high
  if (percent >= 60) return COLOR.warn
  return COLOR.ok
}

/** 定长的进度条：已用部分按档着色，其余是暗色底 */
export function bar(percent: number, width: number): Segment[] {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  return [
    { text: '━'.repeat(filled), color: levelColor(clamped) },
    { text: '─'.repeat(width - filled), color: COLOR.track },
  ].filter(segment => segment.text !== '')
}

export const SEPARATOR: Segment = { text: ' · ', color: COLOR.faint }

/** 一行里不拆开的一块；join 是它和前一块排在同一行时夹在中间的字（如 " · "），折到下一行行首时不画 */
export type Piece = { segments: Segment[]; join?: Segment }

export const piece = (segments: Segment[], join?: Segment): Piece => ({ segments, join })

/**
 * 把几块文字排成几行：第一行 first 格，之后每行 next 格；一块在这一行放不下就整块折到下一行。
 * 只有一块比一整行还宽时才截断加 `…`。
 */
export function flow(pieces: readonly Piece[], first: number, next: number): Segment[][] {
  const lines: Segment[][] = [[]]
  let left = first
  for (const one of pieces) {
    const size = cells(one.segments.map(segment => segment.text).join(''))
    let line = lines[lines.length - 1] ?? []
    let join = line.length > 0 ? one.join : undefined
    if (size + cells(join?.text ?? '') > left && (line.length > 0 || lines.length === 1)) {
      line = []
      lines.push(line)
      left = next
      join = undefined
    }
    if (join) {
      line.push(join)
      left -= cells(join.text)
    }
    const shown = size > left ? fitSegments(one.segments, left) : one.segments
    line.push(...shown)
    left -= cells(shown.map(segment => segment.text).join(''))
  }
  return lines
}

/** 一行几段文字截到 room 格以内：放不下的那段截短、末尾换成 `…`，后面的丢掉 */
export function fitSegments(list: readonly Segment[], room: number): Segment[] {
  const kept: Segment[] = []
  let left = room
  for (const segment of list) {
    const size = cells(segment.text)
    if (size > left) {
      if (left > 1) kept.push({ ...segment, text: fit(segment.text, left) })
      break
    }
    kept.push(segment)
    left -= size
  }
  return kept
}
