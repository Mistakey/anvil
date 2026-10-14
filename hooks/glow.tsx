// 会呼吸的一段字（Client 模块，spec D10「呼吸」）：
// - breathe：事情在发生时，字从中间亮起、往两头渐暗，跟着呼吸涨落（shine 是亮的颜色）；
//   给了 lit 时字先用 440ms 从本色渐变到 lit（回复中模型名变成 Claude 橙），结束后 660ms 落回本色；
// - flash：事情刚结束，标了 lit 的格子从 shine 用 660ms 落回本色（回复结束速度行的读数和图标）。
// 帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）：
// 挂载时起一次计时，之后按固定节拍走，重画不重起；动完了不再重画。
import type { ClientModule } from 'claude-code'

import { mix } from './color'
import { BREATH, beat, clockOf, envelope, runs, settle, wordCells } from './motion'
import type { Beat, Cell } from './motion'

type Props = {
  now: number
  /** 逐格的字（宽字后面跟一格空串）；没有颜色的是正文色 */
  cells: Cell[]
  since: number
  until?: number
  mode: 'breathe' | 'flash'
  shine: string
  lit?: string
  /** 所在的那一行有焦点、被引擎反白：跟着反白 */
  inverse?: boolean
}

type State = { ref: Beat }

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
  return wordCells(base.map(cell => ({ ...cell, color: cell.color ?? FOREGROUND })), clock, env, props.shine)
}

const done = (props: Props, clock: number) => props.until !== undefined && clock >= props.until + Math.max(BREATH.outMs, BREATH.settleMs)

const Glow: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = beat(surface, props.now, BREATH.stepMs, clock => !done(props, clock - BREATH.stepMs))
  const clock = clockOf(ref, BREATH.stepMs)
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
