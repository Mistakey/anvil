// 面板共用的样式（spec D10）：颜色、图标、名称 | 值两列、定宽字段、进度条。

import { gradient, mix } from './color'
import { easeOut } from './motion'
import { cells, fit } from './text'

/** 一段同色文字；一行由几段拼成。color 不给时是终端的前景色（正文） */
export type Segment = { text: string; color?: string; bold?: boolean }

/**
 * 色板（spec D10，anvil-k0t.47）。正文不设颜色，用终端的前景色，和对话里的字同一种白；
 * 中性色三级：次要文字、图标与分隔符、线。对比度按面板的底色量：引擎给面板画的 #262626
 * （伪终端实测），和翻译框所在的终端底色（用户的 Dracula #282a36）：次要 6.0 / 5.6:1，图标 3.9 / 3.7:1，线 2.8 / 2.6:1。
 * 框：侧边和下边是识别色调暗的一档（3.2–3.6:1），上边框从标题处的光（识别色七成）渐暗到侧边的颜色。
 */
export const COLOR = {
  /** 次要文字：名称列、标签与单位、第二行的细节、计数、序号、提示、做完了的列表项 */
  secondary: '#9da3b0',
  /** 图标和分隔符 `·`：不是文字，比次要文字再暗一级 */
  icon: '#7a8194',
  /** 线：进度条之外不承载信息的细线 */
  line: '#666a71',
  /** 进度条的底：比线再暗，填上的那段热度渐变才显得出来 */
  track: '#4a4d54',
  /** 面板的底：引擎画的，mod 改不了；渐变从它起 */
  pane: '#262626',
  /** 正在发生：所有进行中的 ◐、细槽上的呼吸；Claude 橙（引擎画自己的 spinner 用的也是它，主题色 claude 画成这个值） */
  active: '#d77757',
  // 状态色：进度条热度、命中率、缓存有效 / 过期、预测、git 计数；一种颜色一个意思
  ok: '#8fbf7f',
  warn: '#d7bd6f',
  high: '#d79a6f',
  danger: '#e07a7a',
  // 识别色：各框的标题（原色）、上边框的光（从它起）和侧边（同色相调暗的一档）
  cache: '#6cc5c0',
  cacheLine: '#4e7f7c',
  usage: '#7aa7e0',
  usageLine: '#5a7699',
  agents: '#d78fc4',
  agentsLine: '#926787',
  /** 拒绝就是"被拦下"，和状态色的红是同一个意思，用同一个值 */
  denials: '#e07a7a',
  denialsLine: '#a45f5f',
  /** 我的消息是中性的：标题正文色，光从浅灰起，侧边是中性灰 */
  messages: '#c8ccd4',
  messagesLine: '#777b82',
  /** 身份栏的分支（git 的识别色） */
  branch: '#b18bd0',
  /** 翻译框的上下两条线：和引擎画主输入框的线同色（伪终端实测），两条输入框看着是一家 */
  promptLine: '#888888',
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

/** 进度条最长 30 格（用户定，anvil-k0t.46）：面板拖宽时百分比仍靠近名称 */
export const BAR_MAX = 30

/**
 * 进度条的长度：值那一列除了百分比（前面空 1 格）都给进度条，右边留 1 格，最长 BAR_MAX 格。
 * 三条进度条一样长；框 48 列（框内 44 格）起就是 30 格。
 */
export function barWidth(inner: number): number {
  return Math.max(1, Math.min(BAR_MAX, valueWidth(inner) - FIELD.percent - 2))
}

/** 进度条四档：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红（百分比的颜色） */
export function levelColor(percent: number): string {
  if (percent >= 90) return COLOR.danger
  if (percent >= 80) return COLOR.high
  if (percent >= 60) return COLOR.warn
  return COLOR.ok
}

/**
 * 进度条的热度（学 btop）：每一格按它在条上的位置取色，45% 以前绿，往后依次过渡到黄、橙、红，
 * 到 60%、80%、90% 正好是四档的颜色；填到哪，最后一格的颜色就和百分比的颜色一致
 */
export const HEAT = [
  [0, COLOR.ok],
  [45, COLOR.ok],
  [60, COLOR.warn],
  [80, COLOR.high],
  [90, COLOR.danger],
  [100, COLOR.danger],
] as const

/** 定长的进度条：已用部分 `━` 按位置取热度色，其余 `─` 是暗底；相邻同色的格子并成一段 */
export function bar(percent: number, width: number): Segment[] {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  const out: Segment[] = []
  for (let i = 0; i < filled; i += 1) {
    const color = gradient(HEAT, ((i + 0.5) / width) * 100)
    const last = out[out.length - 1]
    if (last && last.color === color) last.text += '━'
    else out.push({ text: '━', color })
  }
  if (width > filled) out.push({ text: '─'.repeat(width - filled), color: COLOR.track })
  return out
}

/**
 * 框的上边框整行（`╭─ 标题 ───…╮`，标题和右上角计数另压在上面）：标题处有光，从标题后面起
 * 由识别色七成的亮度渐暗（ease-out）到侧边的颜色，走到线长的一半多（至少 10 格）；标题前那格是三成半。
 * titleEnd：标题（连同前后的空格和引擎画的"a: "）之后的第一格
 */
export function edgeLine(columns: number, titleEnd: number, ident: string, side: string): Segment[] {
  const cellsOut: Segment[] = [{ text: '╭', color: side }]
  const span = Math.max(1, columns - 1 - titleEnd)
  const reach = Math.min(span, Math.max(10, Math.floor(span * 0.55)))
  const lit = mix(side, ident, 0.7)
  for (let x = 1; x < columns - 1; x += 1) {
    const color = x === 1 ? mix(side, ident, 0.35) : x < titleEnd ? side : mix(lit, side, easeOut((x - titleEnd) / reach))
    const last = cellsOut[cellsOut.length - 1]
    if (last && last.color === color && last.text !== '╭') last.text += '─'
    else cellsOut.push({ text: '─', color })
  }
  if (columns > 1) cellsOut.push({ text: '╮', color: side })
  return cellsOut
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
