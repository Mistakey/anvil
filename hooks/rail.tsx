// 线上的光（Client 模块，spec D10「流光」）：
// - streak：主会话回复中，一道头亮尾暗、会伸缩的光从左往右走过框间的细槽；
// - glint：翻译中，一点亮光扫过翻译框的上边框（线变成亮一档的颜色，字形不变，标题不碰）。
// 结束后 480ms 里暗下去，暗完停掉自己的计时，画回静止的线。
// 帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）：
// 只重画这一行；相邻同色的格子并成一段。偏离：相位按时钟算（motion.ts）、动完就停。
import type { ClientModule } from 'claude-code'

import { FLOW, clockOf, envelope, follow, glintCells, groove, halt, isMoving, runs, streakCells, ticking } from './motion'
import type { Cell, Ticking } from './motion'

type Props = {
  /** 钩子画面板时的时刻、相位的零点 */
  now: number
  epoch: number
  /** 这一行在面板里的行号：越往下出发越晚 */
  row: number
  width: number
  since: number
  /** 结束的时刻；还在发生时不带 */
  until?: number
  /** glint：静止时的那条线（逐格）和闪光的颜色；不带时是 streak，线是细槽 */
  cells?: Cell[]
  tint?: string
}

type State = { ref: Ticking }

/** 面板的底：细槽从它起渐变 */
const PANE = '#262626'

const Rail: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? ticking(props.now)
  const until = props.until ?? null
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), FLOW.stepMs, () => {
    ref.ticks += 1
    if (!isMoving(clockOf(ref, FLOW.stepMs), until)) halt(ref)
    surface.setState({ ref })
  })
  if (surface.state === undefined) surface.setState({ ref })
  const clock = clockOf(ref, FLOW.stepMs)
  const width = Math.max(1, surface.columns || props.width)
  const env = envelope(clock, props.since, until)
  const lit =
    props.cells && props.tint
      ? glintCells(props.cells, clock - props.epoch, props.row, env, props.tint, 0, width)
      : streakCells(groove(width, PANE), clock - props.epoch, props.row, env)
  return (
    <Box>
      {runs(lit).map(cell => (
        <Text color={cell.color} bold={cell.bold}>
          {cell.ch}
        </Text>
      ))}
    </Box>
  )
}

export default Rail
