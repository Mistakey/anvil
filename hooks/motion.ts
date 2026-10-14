// 面板的动效（spec D10）：动只表示"正在发生"，没事时完全静止。
// 进行中图标的转动（子 agent、翻译框、保活续期、主会话回复中身份栏的速度行）和运行中子 agent 的耗时，
// 都交给 Client 在界面自己的帧时钟上走，只重画这一小块，面板不跟着重画。做法照 flightdeck 的
// hooks/rail.tsx、hooks/elapsed.tsx（MIT License, Copyright (c) 2026 Stephen Casella）。偏离：
// - 相位按时钟算，不是各个 Client 自己数帧：钩子画面板时给同一个 now，几个图标同一时刻同一格；
// - 钩子给了新的 now 就把帧时钟的计时从这一刻重新起（follow）：flightdeck 只起一次计时，重画后多数出来的
//   不到一拍会让耗时先多走一秒、下次重画再退回去（anvil-k0t.39 伪终端实测 8s → 7s）；
// - 主会话回复中不在分隔线上跑点：框与框之间是空行（anvil-k0t.46），回复中的动效是身份栏速度行的 ◐。
// 这里只放纯逻辑，Client 模块（spinner.tsx、elapsed.tsx）和测试都从这里取。

/** 进行中图标：四个半圆轮流，150ms 一格，转一圈 0.6 秒（anvil-k0t.46 从 120ms 放慢，余光里不显得急） */
export const SPIN = { frames: ['◐', '◓', '◑', '◒'], stepMs: 150 } as const

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

