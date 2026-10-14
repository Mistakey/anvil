// 面板的动效（spec D10，anvil-k0t.48「呼吸」）：事情正在发生时，几处按同一口气一起呼吸，
// 不歇、不断，固定节奏一直走，结束后静止——框间的细槽上一团 Claude 橙的光从中间涨开、收拢
// （主会话回复中），正在干活的名字（模型名、运行中的子 agent 任务、"进行中"、"正在翻译"）从中间亮起、暗回，
// 进行中的图标跟着亮暗，翻译框的上边框从标题处亮起；回复结束时速度行的读数和图标从 Claude 的微光色落回原色。
// 取代 .47 的流光：流光一圈要歇 720ms、两头从框外进出，细槽上很长时间什么都没有，用户看着时有时停。
// 参照：
// - 呼吸灯：吸气快、呼气慢（吸 40%、呼 60%），两头都是缓的（升余弦），最低处不灭，看着一直在喘气；
// - Claude Code 的 spinner：亮的一档是同色更亮（claude #d77757 → claudeShimmer #f59575），颜色插值取到固定档数；
// - btop：沿线按位置着色——中间最亮、往两头渐暗进细槽，吸气时光铺开、线变粗，呼气时收拢。
// 计时照 flightdeck 的 hooks/rail.tsx、hooks/elapsed.tsx（MIT License, Copyright (c) 2026 Stephen Casella）：
// 每个 Client 挂载时起一次帧计时（`surface.every`），之后按固定节拍自己走，钩子重画不清零、不重起；
// 时刻是挂载时钩子给的 now 加走过的拍数，相位按这个绝对时刻算，几处同相。偏离：节拍 110ms 同 flightdeck，
// 一口气正好 24 拍，每拍相位前进一样多；真实会话里几个 Client 共用一个跟着墙上时钟的拍子（pulseTick），
// 帧时钟慢了、引擎卡过之后一拍一拍追上，后挂载的 Client 也同一拍。
// 这里只放纯逻辑，Client 模块（rail.tsx、glow.tsx、spinner.tsx、elapsed.tsx）、钩子和测试都从这里取。

import { mix } from './color'

/** 一格：字和颜色（不给颜色是终端的前景色）；lit：落定时跟着从微光色落回来（glow.tsx 的 flash） */
export type Cell = { ch: string; color?: string; bold?: boolean; lit?: boolean }

/**
 * 节奏。帧时钟 110ms 一拍（flightdeck 的 rail 也是）；一口气 2640ms，正好 24 拍，吸 40%、呼 60%。
 * 出现、消失、落定都是整拍：440ms 亮起，660ms 暗下去、落定。
 */
export const BREATH = {
  stepMs: 110,
  cycleMs: 2640,
  inhale: 0.4,
  inMs: 440,
  outMs: 660,
  settleMs: 660,
} as const

/** 进行中图标：四个半圆轮流，两拍一格（220ms），一口气正好转三圈 */
export const SPIN = { frames: ['◐', '◓', '◑', '◒'], stepMs: 220 } as const

/** 呼吸的颜色：本色是 Claude 橙（"正在进行"），亮一档同 Claude Code 自己的 claudeShimmer，最亮是光芯 */
export const LIGHT = { body: '#d77757', shine: '#f59575', core: '#ffc6ad' } as const

const clamp = (t: number) => Math.min(1, Math.max(0, t))
const mod = (a: number, n: number) => ((a % n) + n) % n

export const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3

/** 这一刻在一口气里的哪里（0 到 1）：按绝对时刻算，几处同相 */
export const phaseOf = (clock: number) => mod(clock, BREATH.cycleMs) / BREATH.cycleMs

/**
 * 这一刻吸到多满（0 到 1）：吸气 40%、呼气 60%，两段都是升余弦，顶上和底下都是缓的，接缝处不折
 */
export function breath(clock: number): number {
  const t = phaseOf(clock)
  const w = t < BREATH.inhale ? (0.5 * t) / BREATH.inhale : 0.5 + (0.5 * (t - BREATH.inhale)) / (1 - BREATH.inhale)
  return (1 - Math.cos(2 * Math.PI * w)) / 2
}

/**
 * 沿线的明暗：center 处最亮，往两边按高斯渐暗。吸满时最亮处到 1、光铺开（σ 是 reach 的 44%）；
 * 呼尽时最亮处还有 0.62、收拢到 20%：一直亮着，不灭（k0t.48 伪终端看过：0.42 时呼尽那几拍细槽几乎看不见）
 */
export function swell(x: number, center: number, reach: number, level: number): number {
  const sigma = Math.max(0.5, (0.2 + 0.24 * level) * reach)
  const peak = 0.62 + 0.38 * level
  const d = (x + 0.5 - center) / sigma
  return peak * Math.exp(-d * d)
}

/**
 * 出现和消失：since 起 440ms 亮起来，until 起 660ms 暗下去（都是 ease-out）；
 * 没有 since 当作早就亮着，没有 until 当作还在发生
 */
export function envelope(clock: number, since: number | null, until: number | null): number {
  const rise = since === null ? 1 : easeOut((clock - since) / BREATH.inMs)
  const fall = until === null ? 1 : 1 - easeOut((clock - until) / BREATH.outMs)
  return clamp(Math.min(rise, fall))
}

/** 还在动：没结束，或结束后还没暗完 */
export const isMoving = (clock: number, until: number | null) => until === null || clock < until + BREATH.outMs

/** 落定：until 起 660ms 里从 1 落到 0（ease-out），之外是 0 */
export function settle(clock: number, until: number | null): number {
  if (until === null || clock < until) return 0
  return 1 - easeOut((clock - until) / BREATH.settleMs)
}

/** 框间细槽（静止时就这么画）：中间略亮、两端隐进底色，看着是一道浅浅的刻痕，不是第三条横线 */
export const GROOVE = { peak: '#4a4c51', levels: 6 } as const

export function groove(width: number, background: string): Cell[] {
  return Array.from({ length: width }, (_, x) => {
    const bell = Math.sin((Math.PI * (x + 0.5)) / width) ** 0.8
    return { ch: '─', color: mix(background, GROOVE.peak, Math.round(bell * GROOVE.levels) / GROOVE.levels) }
  })
}

/** 亮度到颜色：细槽 → Claude 橙（0.5）→ 微光色（0.82）→ 光芯（1） */
function ember(from: string, k: number): string {
  if (k < 0.5) return mix(from, LIGHT.body, k / 0.5)
  if (k < 0.82) return mix(LIGHT.body, LIGHT.shine, (k - 0.5) / 0.32)
  return mix(LIGHT.shine, LIGHT.core, (k - 0.82) / 0.18)
}

/** 亮过这一档的格子画粗线：呼尽时中间也留三四格粗线 */
const HEAVY = 0.6

/**
 * 细槽上的呼吸：中间一团 Claude 橙的光，吸气时涨开、变亮，粗线 `━` 从三四格铺到三十来格（两头用 `╼` `╾`
 * 接回细线），光芯到 #ffc6ad；呼气时收拢回中间短短一截亮橙的粗线，不灭。base 是静止的细槽，env 是出现 / 消失的程度。
 */
export function breatheCells(base: readonly Cell[], clock: number, env: number): Cell[] {
  if (env <= 0) return [...base]
  const width = base.length
  const level = breath(clock)
  const heavy = base.map((_, x) => env >= 0.5 && swell(x, width / 2, width, level) >= HEAVY)
  return base.map((cell, x) => {
    const k = swell(x, width / 2, width, level) * env
    if (k < 0.02) return cell
    const ch = heavy[x] ? '━' : heavy[x + 1] ? '╼' : heavy[x - 1] ? '╾' : cell.ch
    return { ...cell, ch, color: ember(cell.color ?? LIGHT.body, k) }
  })
}

const LINE = new Set(['─', '━', '╭', '╮'])

/**
 * 线上的呼吸（翻译框的上边框）：从 center（标题后面那一格）起亮一档（tint），往右渐暗，跟着呼吸涨落；
 * 字形不变，标题等字不碰
 */
export function glintCells(base: readonly Cell[], clock: number, env: number, tint: string, center: number): Cell[] {
  if (env <= 0) return [...base]
  const level = breath(clock)
  const reach = Math.min(base.length, 80)
  return base.map((cell, x) => {
    if (!LINE.has(cell.ch) || cell.color === undefined) return cell
    const k = swell(x, center, reach, level) * env
    return k > 0.02 ? { ...cell, color: mix(cell.color, tint, k) } : cell
  })
}

/**
 * 字上的呼吸：从这段字的中间亮起、往两头渐暗，吸满时整段都染上 shine、中间最亮，呼尽时只剩中间一点。
 * base 是逐格的（宽字后面跟一格空串），每格的颜色是本色
 */
export function wordCells(base: readonly Cell[], clock: number, env: number, shine: string): Cell[] {
  if (env <= 0) return [...base]
  const level = breath(clock)
  const reach = Math.max(4, base.length) * 1.6
  return base.map((cell, x) => {
    if (cell.color === undefined) return cell
    const k = swell(x, base.length / 2, reach, level) * env
    return k > 0.02 ? { ...cell, color: mix(cell.color, shine, k) } : cell
  })
}

/** 进行中图标的颜色：Claude 橙，吸气时亮到光芯 */
export const spinColor = (clock: number) => mix(LIGHT.body, LIGHT.core, breath(clock))

/** 进行中图标在 clock 这一刻是哪一格 */
export function spinGlyph(clock: number): string {
  const frames = SPIN.frames
  return frames[Math.floor(mod(clock, SPIN.stepMs * frames.length) / SPIN.stepMs)] ?? frames[0]
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
 * Client 里的时钟：base 加上走过的拍数。moving：这一拍要不要重画，每次画的时候按最新的 props 换掉
 * （flightdeck rail 的 `ref.active = props.active`）。
 * wall：墙上时钟；钩子的 now 不是墙上时钟（plugin test 的假时钟）时为 null，这时 base 是挂载时的 now、一拍走一拍；
 * 是墙上时钟时 base 为 0，ticks 是绝对的第几拍（共用的拍子 pulse，耗时是墙上的第几秒）
 */
export type Beat = { base: number; ticks: number; moving: (clock: number) => boolean; wall: (() => number) | null }

export const clockOf = (ref: Beat, stepMs: number) => ref.base + ref.ticks * stepMs

/** 钩子的 now 和墙上时钟差得比这多，就当它不是墙上时钟（真实会话里两者是同一个时钟，k0t.48 伪终端实测） */
const SKEW_MS = 60_000

/** 拍子多久没人走就当它停了：下一个挂载的 Client 直接从墙上时刻起 */
const STALE_MS = 1000

/** 几个 Client 共用的拍子（Client 模块共用这一份 motion.ts，k0t.48 伪终端实测）：第几拍、最近一次走它的墙上时刻 */
export type Pulse = { tick: number; wall: number }

const pulse: Pulse = { tick: 0, wall: Number.NEGATIVE_INFINITY }

/**
 * 落后 behind 拍时这一拍走几拍。帧时钟把 110ms 凑成整帧（伪终端实测约 123ms 一拍），光数拍会越走越慢；
 * 引擎卡住几秒（它自己的 spinner 也停）时拍子会丢。落后整口气的部分一次补上（相位不变，看不出来）；
 * 剩下不到一口气的，落后就多走一拍、超前就这一拍不走，一拍一拍地追，不跳
 */
export function catchUp(behind: number, cycle: number): number {
  const part = mod(behind + cycle / 2, cycle) - cycle / 2
  return 1 + (behind - part) + Math.sign(part)
}

/**
 * 共用的拍子这一刻是第几拍（绝对的：墙上时刻 / 110ms）。advance：帧时钟走了一拍（不是挂载时读一下）。
 * 同一帧里已经有 Client 走过（半拍之内），照抄，几处同一拍。挂载时拍子停了太久（没有别的 Client 在走）
 * 就直接从墙上时刻起；在走的 Client 隔了很久才走下一拍（引擎卡住）时照常一拍一拍追，不跳
 */
export function pulseTick(wallNow: number, advance: boolean, p: Pulse = pulse): number {
  const target = Math.round(wallNow / BREATH.stepMs)
  if (!advance && wallNow - p.wall > STALE_MS) {
    p.tick = target
    p.wall = wallNow
    return p.tick
  }
  if (!advance || wallNow - p.wall < BREATH.stepMs / 2) return p.tick
  p.tick += catchUp(target - (p.tick + 1), BREATH.cycleMs / BREATH.stepMs)
  p.wall = wallNow
  return p.tick
}

/** 画的时候要用到的那点 surface（ClientSurface 的子集，测试可以自己造） */
export type Ticker = {
  readonly state: { ref: Beat } | undefined
  setState: (next: { ref: Beat }) => void
  every: (ms: number, fn: () => void) => () => void
}

/**
 * 挂载时起一次帧计时，之后每拍走一拍、要动时重画；再画（钩子给了新的 now、新的 props）不清零、不重起，
 * 只换 moving。照 flightdeck 的 rail.tsx：`every` 只在 state 还没有时起。
 * 钩子的 now 是墙上时钟时（真实会话），呼吸的拍子用共用的 pulse（几处同一拍，跟着墙上时钟不漂），
 * 耗时（stepMs 不是呼吸的一拍）直接取墙上的第几秒；wall 在 Client 里是 Date.now（k0t.48 伪终端实测可用）
 */
export function beat(surface: Ticker, now: number, stepMs: number, moving: (clock: number) => boolean, wall: () => number = Date.now, p: Pulse = pulse): Beat {
  const held = surface.state?.ref
  if (held) {
    held.moving = moving
    return held
  }
  const synced = Math.abs(wall() - now) < SKEW_MS
  const read = (advance: boolean) => (stepMs === BREATH.stepMs ? pulseTick(wall(), advance, p) : Math.floor(wall() / stepMs))
  const ref: Beat = synced ? { base: 0, ticks: read(false), moving, wall } : { base: now, ticks: 0, moving, wall: null }
  surface.setState({ ref })
  surface.every(stepMs, () => {
    ref.ticks = ref.wall ? read(true) : ref.ticks + 1
    if (ref.moving(clockOf(ref, stepMs))) surface.setState({ ref })
  })
  return ref
}
