// 面板的动效（spec D10，anvil-k0t.47「流光」）：事情正在发生时，一道光按同一个时钟从左往右扫过，
// 经过的地方各自亮一下——框间的细槽上是一道会伸缩的流光（主会话回复中），正在干活的名字
// （模型名、运行中的子 agent 任务、"进行中"、"正在翻译"）上滚过一段微光，进行中的图标在光到时亮一下，
// 翻译框的上边框上扫过一点亮光；回复结束时速度行的读数和图标从 Claude 的微光色落回原色。没事时完全静止。
// 光是一道斜的波前：每往下一行晚 10ms 出发，从上往下依次扫过。几处共用一个相位零点（主事件开始的时刻）。
// 参照（anvil-k0t.47 调研）：
// - Claude Code 的 spinner：微光是比本色亮一档的颜色（claude #d77757 → claudeShimmer #f59575），一段窗口滚过字，
//   回复中 200ms 一字地慢慢走；颜色插值取到固定的档数，相邻帧颜色相同就不重画。
// - Material 的不定进度条：头和尾用两条不同的缓动，走到中间时被拉长、到两头收短，像有速度的光。
// - Charm harmonica / bubbles：起落都有缓动，出现、消失、落定都不是一下子；这里都用 ease-out。
// - btop：渐变按位置着色（进度条的热度）；flightdeck rail：光走在一条暗线上，只重画在动的那一块（Client）。
// Client 在界面自己的帧时钟上走，做法照 flightdeck 的 hooks/rail.tsx、hooks/elapsed.tsx
// （MIT License, Copyright (c) 2026 Stephen Casella）。偏离：相位按时钟算（钩子给同一个 now 和 epoch），
// 几块 Client 同一时刻同一相位；钩子给了新的 now 就从这一刻重新数（follow，anvil-k0t.39 的 8s → 7s）；
// 动完就停掉自己的计时（halt），不空转。
// 这里只放纯逻辑，Client 模块（rail.tsx、glow.tsx、spinner.tsx、elapsed.tsx）、钩子和测试都从这里取。

import { mix } from './color'

/** 一格：字和颜色（不给颜色是终端的前景色）；lit：落定时跟着从微光色落回来（glow.tsx 的 flash） */
export type Cell = { ch: string; color?: string; bold?: boolean; lit?: boolean }

/**
 * 节奏。一圈 2880ms：光用 2160ms 从左扫到右，歇 720ms（伪终端实测，歇 1080ms 时加上缓入缓出的头尾，
 * 近一半时间细槽上什么都没有）；进行中图标 144ms 一格，一圈正好 20 格。
 * 帧时钟 40ms 一拍（25 帧/秒）：光一拍走一到三格，看着是连着的。
 */
export const FLOW = {
  stepMs: 40,
  cycleMs: 2880,
  sweepMs: 2160,
  /** 流光的尾比头晚出发多少（占一趟的比例）：头尾两条缓动错开，走到中间时拉长 */
  lag: 0.18,
  /** 每往下一行晚出发多少：一道斜的波前 */
  rowMs: 10,
  /** 光从框外多远处出发、走到框外多远处 */
  pad: 3,
  /** 出现、消失、落定的时长 */
  inMs: 360,
  outMs: 480,
  settleMs: 720,
  /** 微光滚过一个词、图标亮一下的时长 */
  shimmerMs: 1000,
  pulseMs: 480,
} as const

/** 进行中图标：四个半圆轮流，144ms 一格 */
export const SPIN = { frames: ['◐', '◓', '◑', '◒'], stepMs: 144 } as const

/** 流光和微光的颜色：本色是 Claude 橙（"正在进行"），亮的一档同 Claude Code 自己的 claudeShimmer */
export const LIGHT = { body: '#d77757', shine: '#f59575', core: '#ffc6ad' } as const

const clamp = (t: number) => Math.min(1, Math.max(0, t))
const mod = (a: number, n: number) => ((a % n) + n) % n

export const easeInOut = (t: number) => {
  const x = clamp(t)
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

export const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3

/** 这一刻光在第 row 行走到哪：0 到 1 在走，null 在歇 */
export function travel(clock: number, row: number): number | null {
  const t = mod(clock - row * FLOW.rowMs, FLOW.cycleMs)
  return t < FLOW.sweepMs ? t / FLOW.sweepMs : null
}

/** 走到 u 时光在第几格（可以是小数，可以在框外）：中间快、两头慢 */
export const frontAt = (u: number, width: number) => -FLOW.pad + (width + 2 * FLOW.pad) * easeInOut(u)

/** 流光的头尾：头先走，尾晚 lag 出发，两条缓动错开，中间最长 */
export function streakAt(u: number, width: number): { tail: number; head: number } {
  const span = 1 - FLOW.lag
  return { head: frontAt(u / span, width), tail: frontAt((u - FLOW.lag) / span, width) }
}

/**
 * 出现和消失：since 起 360ms 亮起来，until 起 480ms 暗下去（都是 ease-out）；
 * 没有 since 当作早就亮着，没有 until 当作还在发生
 */
export function envelope(clock: number, since: number | null, until: number | null): number {
  const rise = since === null ? 1 : easeOut((clock - since) / FLOW.inMs)
  const fall = until === null ? 1 : 1 - easeOut((clock - until) / FLOW.outMs)
  return clamp(Math.min(rise, fall))
}

/** 还在动：没结束，或结束后还没暗完 */
export const isMoving = (clock: number, until: number | null) => until === null || clock < until + FLOW.outMs

/** 落定：until 起 720ms 里从 1 落到 0（ease-out），之外是 0 */
export function settle(clock: number, until: number | null): number {
  if (until === null || clock < until) return 0
  return 1 - easeOut((clock - until) / FLOW.settleMs)
}

/** 光经过 x 时这一格亮多少：前沿陡、拖尾长（彗星），0 到 1 */
function glow(x: number, front: number, ahead: number, behind: number): number {
  const d = x - front
  const sigma = d > 0 ? ahead : behind
  return Math.exp(-((d / sigma) ** 2))
}

/** 框间细槽（静止时就这么画）：中间略亮、两端隐进底色，看着是一道浅浅的刻痕，不是第三条横线 */
export const GROOVE = { peak: '#4a4c51', levels: 6 } as const

export function groove(width: number, background: string): Cell[] {
  return Array.from({ length: width }, (_, x) => {
    const bell = Math.sin((Math.PI * (x + 0.5)) / width) ** 0.8
    return { ch: '─', color: mix(background, GROOVE.peak, Math.round(bell * GROOVE.levels) / GROOVE.levels) }
  })
}

/**
 * 细槽上的流光：头是粗线、亮，往尾渐细渐暗，两端用半格（╸ ╶）收，走得比一格细。
 * base 是静止的细槽，x0 是这一行在面板里的起点（光按面板的格子走），env 是出现 / 消失的程度。
 */
export function streakCells(base: readonly Cell[], clock: number, row: number, env: number, x0 = 0, width = base.length): Cell[] {
  const u = travel(clock, row)
  if (u === null || env <= 0) return [...base]
  const { head, tail } = streakAt(u, width)
  const length = Math.max(0.001, head - tail)
  return base.map((cell, i) => {
    const x = x0 + i
    const from = cell.color ?? LIGHT.body
    // 头前面一格多的地方先被照亮一点
    if (x >= head) {
      const lit = 0.4 * glow(x + 0.5, head, 1.2, 1)
      return lit > 0.02 ? { ...cell, color: mix(from, LIGHT.body, lit * env) } : cell
    }
    if (x + 1 <= tail) return cell
    const inHead = head - x
    const inTail = x + 1 - tail
    if (inHead < 0.25 || inTail < 0.25) return cell
    const s = clamp((x + 0.5 - tail) / length)
    let ch = s > 0.55 ? '━' : '─'
    if (inHead < 0.75 && inTail >= 1) ch = '╸'
    else if (inTail < 0.75 && inHead >= 1) ch = s > 0.55 ? '╺' : '╶'
    const lit = s < 0.5 ? mix(from, LIGHT.body, s / 0.5) : s < 0.9 ? mix(LIGHT.body, LIGHT.shine, (s - 0.5) / 0.4) : mix(LIGHT.shine, LIGHT.core, (s - 0.9) / 0.1)
    return { ch: env < 0.5 ? cell.ch : ch, color: mix(from, lit, env) }
  })
}

const LINE = new Set(['─', '━', '╭', '╮'])

/** 线上的闪光（翻译框的上边框）：光经过的线变成亮一档的颜色（tint），字形不变；标题等字不碰 */
export function glintCells(base: readonly Cell[], clock: number, row: number, env: number, tint: string, x0 = 0, width = base.length): Cell[] {
  const u = travel(clock, row)
  if (u === null || env <= 0) return [...base]
  const front = frontAt(u, width)
  return base.map((cell, i) => {
    if (!LINE.has(cell.ch) || cell.color === undefined) return cell
    const k = glow(x0 + i + 0.5, front, 1.2, 4.5)
    return k > 0.02 ? { ...cell, color: mix(cell.color, tint, k * env) } : cell
  })
}

/** 波前走到第 x 格是一趟里的哪一刻（0 到 1）：frontAt 的反函数 */
export function arrival(x: number, width: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2
    if (frontAt(mid, width) < x) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 波前到了之后，从到达那一刻起过了多久（毫秒，一圈之内） */
function since(clock: number, row: number, x: number, width: number): number {
  return mod(clock - row * FLOW.rowMs - arrival(x, width) * FLOW.sweepMs, FLOW.cycleMs)
}

/**
 * 字上的微光：波前到了这个词，一段亮光用 1 秒从词头滚到词尾（Claude Code 的微光也这么慢），
 * 经过的字变成亮一档的颜色。base 是逐格的（宽字后面跟一格空串），每格的颜色是本色
 */
export function shimmerCells(base: readonly Cell[], clock: number, row: number, env: number, shine: string, x0 = 0, width = base.length): Cell[] {
  const t = since(clock, row, x0, width)
  if (env <= 0 || t >= FLOW.shimmerMs) return [...base]
  const front = -2 + (base.length + 4) * easeInOut(t / FLOW.shimmerMs)
  return base.map((cell, i) => {
    if (cell.color === undefined) return cell
    const k = glow(i + 0.5, front, 1, 2.4)
    return k > 0.02 ? { ...cell, color: mix(cell.color, shine, k * env) } : cell
  })
}

/** 波前经过第 x 格时进行中图标亮一下：到达后 480ms 里先亮后暗，0 到 1 */
export function pulseAt(clock: number, row: number, x: number, width: number): number {
  const t = since(clock, row, x, width)
  return t < FLOW.pulseMs ? Math.sin((Math.PI * t) / FLOW.pulseMs) ** 2 : 0
}

/** 进行中图标在 clock 这一刻是哪一格 */
export function spinGlyph(clock: number): string {
  const frames = SPIN.frames
  return frames[Math.floor(Math.max(0, clock) / SPIN.stepMs) % frames.length] ?? frames[0]
}

/** 相邻同色的格子并成一段：一行十几个节点，不是几十个 */
export function runs(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = []
  for (const cell of cells) {
    const last = out[out.length - 1]
    if (last && last.color === cell.color && last.bold === cell.bold) last.ch += cell.ch
    else out.push({ ch: cell.ch, ...(cell.color === undefined ? {} : { color: cell.color }), ...(cell.bold ? { bold: true } : {}) })
  }
  return out
}

/**
 * Client 里的时钟。钩子画面板时给 now（`$.clock.now()`）；两次重画之间 Client 每走一拍加一拍的时长。
 * stop：帧时钟上正在走的计时；没在走时为 null。lastNow：上次跟上的 now，还没跟过是 NaN。
 */
export type Ticking = { base: number; ticks: number; lastNow: number; stop: (() => void) | null }

export const ticking = (now: number): Ticking => ({ base: now, ticks: 0, lastNow: Number.NaN, stop: null })

/**
 * 跟上钩子给的 now：第一次和 now 变了时从它重新数，帧时钟的计时也从这一刻重新起，
 * 拍子对齐 now，不会比真实时刻多走；同一次重画里的几块 Client 同一拍走。now 没变时什么都不做。
 */
export function follow(ref: Ticking, now: number, every: (ms: number, fn: () => void) => () => void, stepMs: number, tick: () => void) {
  if (now === ref.lastNow) return
  ref.base = now
  ref.ticks = 0
  ref.lastNow = now
  ref.stop?.()
  ref.stop = every(stepMs, tick)
}

/** 停掉帧时钟上的计时：动完了就不再空转，钩子下次给新的 now 时再起 */
export function halt(ref: Ticking) {
  ref.stop?.()
  ref.stop = null
}

/** 现在的时刻：最近一次给的 now 加上之后走过的拍数 */
export const clockOf = (ref: Ticking, stepMs: number) => ref.base + ref.ticks * stepMs
