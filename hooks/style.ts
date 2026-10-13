// 面板共用的样式（spec D10，取自设计稿 Version 32）：颜色、图标、三列网格、进度条。

/** 一段同色文字；一行由几段拼成 */
export type Segment = { text: string; color?: string; bold?: boolean }

export const COLOR = {
  text: '#e6e9ee',
  /** 标签、次要文字 */
  muted: '#a7adb8',
  /** 分隔符 `·` 和中性边框 */
  faint: '#5b5f67',
  /** 提示文字；翻译框有内容时的边框 */
  dim: '#8c939f',
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
} as const

/** Nerd Font 图标；图标后一律留一个空格 */
export const ICON = {
  messages: '\u{F075}',
  denials: '\u{F05E}',
  agents: '\u{F06A9}',
  usage: '\u{F029A}',
  cache: '\u{F01BC}',
  translate: '\u{F05CA}',
  done: '\u{F00C}',
  failed: '\u{F00D}',
} as const

/** 用量框和缓存框共用的三列网格：标签 8 格 | 18 格 | 其余，列间空 1 格 */
export const GRID = { label: 8, middle: 18, gap: 1 } as const

/** 网格第三列的宽度 */
export function restWidth(inner: number): number {
  return Math.max(0, inner - GRID.label - GRID.middle - 2 * GRID.gap)
}

/** 进度条四档：低于 60% 绿，60–80% 黄，80–90% 橙，90% 以上红 */
export function levelColor(percent: number): string {
  if (percent >= 90) return COLOR.danger
  if (percent >= 80) return COLOR.high
  if (percent >= 60) return COLOR.warn
  return COLOR.ok
}

/** 占满中间一列的进度条：已用部分按档着色，其余是暗色底 */
export function bar(percent: number, width: number = GRID.middle): Segment[] {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  return [
    { text: '━'.repeat(filled), color: levelColor(clamped) },
    { text: '─'.repeat(width - filled), color: COLOR.track },
  ].filter(segment => segment.text !== '')
}

export const SEPARATOR: Segment = { text: ' · ', color: COLOR.faint }
