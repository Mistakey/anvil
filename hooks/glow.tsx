// 会发光的一段字（Client 模块，spec D10「流光」）：
// - shimmer：事情在发生时，波前到了这段字，一段亮光用 1 秒滚过（Claude Code 自己的微光也是亮一档的同色）；
//   给了 lit 时字先用 360ms 从本色渐变到 lit（回复中模型名变成 Claude 橙），结束后 720ms 落回本色；
// - flash：事情刚结束，标了 lit 的格子从 shine 用 720ms 落回本色（回复结束速度行的读数和图标）。
// 动完就停掉自己的计时。帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）。
import type { ClientModule } from 'claude-code'

import { mix } from './color'
import { FLOW, clockOf, envelope, follow, halt, runs, settle, shimmerCells, ticking } from './motion'
import type { Cell, Ticking } from './motion'

type Props = {
  now: number
  epoch: number
  row: number
  /** 这段字在面板里的起点列、面板宽：光按面板的格子走 */
  x: number
  width: number
  /** 逐格的字（宽字后面跟一格空串）；没有颜色的是正文色 */
  cells: Cell[]
  since: number
  until?: number
  mode: 'shimmer' | 'flash'
  shine: string
  lit?: string
  /** 所在的那一行有焦点、被引擎反白：跟着反白 */
  inverse?: boolean
}

type State = { ref: Ticking }

/** 正文色是终端的前景色，渐变时按用户终端（Dracula）的前景色算，落定后去掉颜色 */
const FOREGROUND = '#f8f8f2'

function paint(props: Props, clock: number): Cell[] {
  const until = props.until ?? null
  if (props.mode === 'flash') {
    const k = settle(clock, until)
    return k <= 0 ? props.cells : props.cells.map(cell => (cell.lit ? { ...cell, color: mix(cell.color ?? FOREGROUND, props.shine, k) } : cell))
  }
  const env = envelope(clock, props.since, until)
  const tint = props.lit === undefined ? 0 : until === null ? env : settle(clock, until)
  const lit = props.lit
  const base = lit === undefined || tint <= 0 ? props.cells : props.cells.map(cell => ({ ...cell, color: mix(cell.color ?? FOREGROUND, lit, tint) }))
  if (until !== null) return base
  // 光是 shine：模型名被 lit 染成 Claude 橙后用更亮的 LIGHT.core，正文色的字用 LIGHT.shine（调用方给）
  return shimmerCells(base.map(cell => ({ ...cell, color: cell.color ?? FOREGROUND })), clock - props.epoch, props.row, env, props.shine, props.x, props.width)
}

const done = (props: Props, clock: number) => props.until !== undefined && clock >= props.until + Math.max(FLOW.outMs, FLOW.settleMs)

const Glow: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? ticking(props.now)
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), FLOW.stepMs, () => {
    ref.ticks += 1
    if (done(props, clockOf(ref, FLOW.stepMs))) halt(ref)
    surface.setState({ ref })
  })
  if (surface.state === undefined) surface.setState({ ref })
  const clock = clockOf(ref, FLOW.stepMs)
  const shown = done(props, clock) ? props.cells : paint(props, clock)
  return (
    <Text inverse={props.inverse === true}>
      {runs(shown).map(cell => (
        <Text color={cell.color} bold={cell.bold}>
          {cell.ch}
        </Text>
      ))}
    </Text>
  )
}

export default Glow
