// 面板共用的样式（spec D10）：颜色、图标、名称 | 值两列、定宽字段、进度条。

import { cells, fit } from './text'

/** 一段同色文字；一行由几段拼成。color 不给时是终端的前景色（正文） */
export type Segment = { text: string; color?: string; bold?: boolean }

/**
 * 色板（spec D10，anvil-k0t.44）。正文不设颜色，用终端的前景色，和对话里的字同一种白；
 * 中性色只有三级：次要文字、图标与分隔符、线。对比度按面板的底色量：引擎给面板画的 #262626
 * （伪终端实测），和翻译框所在的终端底色（用户的 Dracula #282a36）：次要 6.0 / 5.6:1，图标 3.9 / 3.7:1，线 2.2 / 2.1:1。
 */
export const COLOR = {
  /** 次要文字：名称列、标签与单位、第二行的细节、计数、序号、提示、结束了的列表项 */
  secondary: '#9da3b0',
  /** 图标和分隔符 `·`：不是文字，比次要文字再暗一级 */
  icon: '#7a8194',
  /** 线：框与框之间的分隔线、进度条的底、翻译框空着时的边框 */
  line: '#555a6b',
  /** 正在发生：进行中图标、主会话回复时分隔线的呼吸；Claude 橙（引擎的主题色 claude 画成这个值） */
  active: '#d77757',
  // 状态色：进度条四档、命中率、缓存有效 / 过期、git 计数；一种颜色一个意思
  ok: '#8fbf7f',
  warn: '#d7bd6f',
  high: '#d79a6f',
  danger: '#e07a7a',
  /** 调暗的红：翻译失败时翻译框的边框 */
  dangerLine: '#8a4f55',
  // 识别色：各框的标题和边框（spec D10）
  cache: '#6cc5c0',
  usage: '#7aa7e0',
  agents: '#d78fc4',
  /** 拒绝就是"被拦下"，和状态色的红是同一个意思，用同一个值 */
  denials: '#e07a7a',
  /** 身份栏的分支（git 的识别色） */
  branch: '#b18bd0',
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

/** 定长的进度条：已用部分按档着色，其余是线色的底 */
export function bar(percent: number, width: number): Segment[] {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  return [
    { text: '━'.repeat(filled), color: levelColor(clamped) },
    { text: '─'.repeat(width - filled), color: COLOR.line },
  ].filter(segment => segment.text !== '')
}

export const SEPARATOR: Segment = { text: ' · ', color: COLOR.icon }

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
