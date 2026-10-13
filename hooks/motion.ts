// 面板的动效（spec D10）：动只表示"正在发生"，没事时完全静止。
// 分隔线上的扫光、进行中图标的转动、运行中子 agent 的耗时，都交给 Client 在界面自己的帧时钟上走，
// 只重画这一小块，面板不跟着重画。做法照 flightdeck 的 hooks/rail.tsx、hooks/elapsed.tsx
// （MIT License, Copyright (c) 2026 Stephen Casella）。偏离：
// - 相位按时钟算，不是各个 Client 自己数帧：钩子画面板时给同一个 now，几条线同一时刻扫在同一位置；
// - 钩子给了新的 now 就把帧时钟的计时从这一刻重新起（follow）：flightdeck 只起一次计时，重画后多数出来的
//   不到一拍会让耗时先多走一秒、下次重画再退回去（anvil-k0t.39 伪终端实测 8s → 7s）；
// - 扫光是一段两端渐暗的亮光，不是 flightdeck 的「•●」点。
// 这里只放纯逻辑，Client 模块（rail.tsx、spinner.tsx、elapsed.tsx）和测试都从这里取。

/** 扫光：一段 length 格的亮光，每 stepMs 往右走一格，扫出右端后从左端重来 */
export const SWEEP = { stepMs: 110, length: 6 } as const

/** 进行中图标：四个半圆轮流，约 120ms 一格 */
export const SPIN = { frames: ['◐', '◓', '◑', '◒'], stepMs: 120 } as const

/** Claude 橙：引擎认主题色名 `claude`（伪终端里画成 #d77757），亮光的中段和最亮处用它 */
export const GLOW = 'claude'

/**
 * 亮光两端的暗橙：#d77757 和暗线 #5b5f67 各半。主题色名只有一档，Text 的 dimColor 在引擎里画成灰色 #999999
 * （anvil-k0t.39 伪终端实测），不是暗一些的橙，所以两端用固定色
 */
export const GLOW_FADE = '#996b5f'

/**
 * Client 里的时钟。钩子画面板时给 now（`$.clock.now()`）；两次重画之间 Client 每走一拍加一拍的时长。
 * stop：帧时钟上正在走的计时；还没起时为 null。
 */
export type Ticking = { base: number; ticks: number; lastNow: number; stop: (() => void) | null }

export const ticking = (now: number): Ticking => ({ base: now, ticks: 0, lastNow: now, stop: null })

/**
 * 跟上钩子给的 now：第一次和 now 变了时从它重新数，帧时钟的计时也从这一刻重新起，
 * 拍子对齐 now，不会比真实时刻多走；同一次重画里的几块 Client 同一拍走。now 没变时什么都不做。
 */
export function follow(ref: Ticking, now: number, every: (ms: number, fn: () => void) => () => void, stepMs: number, tick: () => void) {
  if (ref.stop !== null && now === ref.lastNow) return
  ref.base = now
  ref.ticks = 0
  ref.lastNow = now
  ref.stop?.()
  ref.stop = every(stepMs, tick)
}

/** 现在的时刻：最近一次给的 now 加上之后走过的拍数 */
export const clockOf = (ref: Ticking, stepMs: number) => ref.base + ref.ticks * stepMs

/** 进行中图标在 clock 这一刻是哪一格 */
export function spinGlyph(clock: number): string {
  const frames = SPIN.frames
  return frames[Math.floor(Math.max(0, clock) / SPIN.stepMs) % frames.length] ?? frames[0]
}

/** 一格的亮度：rest 是暗线，low、mid、peak 由暗到亮 */
export type Glow = 'rest' | 'low' | 'mid' | 'peak'

/** 亮光自左到右各格的亮度：中间最亮、两端渐暗 */
const SHAPE: readonly Glow[] = ['low', 'mid', 'peak', 'peak', 'mid', 'low']

/**
 * 分隔线在 clock 这一刻各格的亮度。亮光的右端走到第 p 格（p 从 0 起，按拍数对一圈取余），
 * 一圈是 width + length 拍：亮光从左端外面进来，整段扫出右端后再从左端重来。
 */
export function sweep(width: number, clock: number): Glow[] {
  const cells: Glow[] = Array.from({ length: Math.max(0, width) }, () => 'rest')
  const cycle = cells.length + SHAPE.length
  if (cells.length === 0) return cells
  const head = Math.floor(Math.max(0, clock) / SWEEP.stepMs) % cycle
  SHAPE.forEach((glow, index) => {
    const at = head - (SHAPE.length - 1) + index
    if (at >= 0 && at < cells.length) cells[at] = glow
  })
  return cells
}

/** 连续同亮度的格子合成一段，一帧只有几个 Text */
export function runs(cells: readonly Glow[]): { glow: Glow; size: number }[] {
  const out: { glow: Glow; size: number }[] = []
  for (const glow of cells) {
    const last = out[out.length - 1]
    if (last && last.glow === glow) last.size += 1
    else out.push({ glow, size: 1 })
  }
  return out
}

/** 一种亮度画成什么样：暗线用 rest 色；亮光用 Claude 橙，两端暗橙、中间加粗 */
export function glowStyle(glow: Glow, rest: string): { color: string; bold?: true } {
  if (glow === 'rest') return { color: rest }
  if (glow === 'low') return { color: GLOW_FADE }
  if (glow === 'peak') return { color: GLOW, bold: true }
  return { color: GLOW }
}
