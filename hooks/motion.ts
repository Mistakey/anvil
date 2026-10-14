// 面板的动效（spec D10）：动只表示"正在发生"，没事时完全静止。
// 分隔线的呼吸、进行中图标的转动、运行中子 agent 的耗时，都交给 Client 在界面自己的帧时钟上走，
// 只重画这一小块，面板不跟着重画。做法照 flightdeck 的 hooks/rail.tsx、hooks/elapsed.tsx
// （MIT License, Copyright (c) 2026 Stephen Casella）。偏离：
// - 相位按时钟算，不是各个 Client 自己数帧：钩子画面板时给同一个 now，几条线同一时刻同一个颜色；
// - 钩子给了新的 now 就把帧时钟的计时从这一刻重新起（follow）：flightdeck 只起一次计时，重画后多数出来的
//   不到一拍会让耗时先多走一秒、下次重画再退回去（anvil-k0t.39 伪终端实测 8s → 7s）；
// - 分隔线不跑点：整条线的颜色在线色和 Claude 橙之间慢慢起伏（呼吸，anvil-k0t.44 从三个候选里选定，
//   取代原来的扫光），不是 flightdeck 的「•●」点。
// 这里只放纯逻辑，Client 模块（rail.tsx、spinner.tsx、elapsed.tsx）和测试都从这里取。

/**
 * 呼吸：主会话回复时，整条分隔线的颜色在线色和 Claude 橙之间起伏，periodMs 一个来回，stepMs 换一次颜色。
 * 从线色起步、余弦缓动，颜色分 levels 级，相邻两帧颜色一样时不必重画
 */
export const BREATH = { stepMs: 100, periodMs: 2400, levels: 12 } as const

/** clock 这一刻亮到几成（0 是线色，1 是 Claude 橙），按级取整；几条线同一时刻同一个值 */
export function breathLevel(clock: number): number {
  const phase = (Math.max(0, clock) % BREATH.periodMs) / BREATH.periodMs
  const level = (1 - Math.cos(2 * Math.PI * phase)) / 2
  return Math.round(level * BREATH.levels) / BREATH.levels
}

const channels = (hex: string) => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))

/** 两个 #rrggbb 之间取 t（0–1）处的颜色 */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from)
  const b = channels(to)
  const amount = Math.min(1, Math.max(0, t))
  return `#${a.map((value, index) => Math.round(value + ((b[index] ?? value) - value) * amount).toString(16).padStart(2, '0')).join('')}`
}

/** 分隔线在 clock 这一刻的颜色：rest 是线色，glow 是亮到最高时的颜色 */
export const breathColor = (rest: string, glow: string, clock: number) => mix(rest, glow, breathLevel(clock))

/** 进行中图标：四个半圆轮流，约 120ms 一格 */
export const SPIN = { frames: ['◐', '◓', '◑', '◒'], stepMs: 120 } as const

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

