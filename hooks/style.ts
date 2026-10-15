// 输入框上方那一行（band.tsx）和每段回复末尾的读数共用的样式：颜色、图标、热度进度条、按格截断。

import { gradient } from './color'
import { cells, fit } from './text'

/** 一段同色文字；一行由几段拼成。color 不给时是终端的前景色（正文） */
export type Segment = { text: string; color?: string; bold?: boolean }

/**
 * 色板。正文不设颜色，用终端的前景色，和对话里的字同一种白；中性色三级：次要文字、图标与分隔符、进度条的底。
 * band 画在终端自己的底色上（用户的 Dracula #282a36）：次要 5.6:1，图标 3.7:1。
 * 和用户的 statusline（`~/.claude/statusline.mjs`）同一套状态色、分支色，上下两行看着是一家。
 */
export const COLOR = {
  /** 次要文字：标签、重置时刻、计数里不要紧的（?、储藏、无上游） */
  secondary: '#9da3b0',
  /** 图标和分隔符 `·`：不是文字，比次要文字再暗一级 */
  icon: '#7a8194',
  /** 进度条的底：比图标再暗，填上的那段热度渐变才显得出来 */
  track: '#4a4d54',
  // 状态色：进度条热度、百分比、git 计数；一种颜色一个意思
  ok: '#8fbf7f',
  warn: '#d7bd6f',
  high: '#d79a6f',
  danger: '#e07a7a',
  /** 目录图标：一行的开头，给个识别色，不和图标的灰混在一起 */
  dir: '#82aadf',
  /** 分支（git 的识别色，statusline 同色） */
  branch: '#b18bd0',
  /** 花费（statusline 同色） */
  cost: '#7fbfae',
} as const

/** Nerd Font 图标（statusline 同一套字形）；图标后一律留一个空格 */
export const ICON = {
  dir: '\u{F07C}',
  branch: '\u{F418}',
  detached: '\u{F417}',
  worktree: '\u{F402}',
  stash: '\u{F51E}',
  lines: '\u{F440}',
  pause: '\u{F04C}',
  /** 重置时刻 */
  reset: '\u{F0450}',
} as const

export const SEPARATOR: Segment = { text: ' · ', color: COLOR.icon }

/** 百分比的四档：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红 */
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

/** 几段字的格数 */
export const widthOf = (segments: readonly Segment[]) => cells(segments.map(segment => segment.text).join(''))

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
