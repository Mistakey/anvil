// 线上的呼吸（Client 模块，spec D10「呼吸」）：
// - 细槽：主会话回复中，中间一团 Claude 橙的光跟着呼吸涨开、收拢（motion.ts 的 breatheCells）；
// - glint：翻译中，翻译框的上边框从标题后面亮一档、跟着呼吸涨落（字形不变，标题不碰）。
// 结束后 660ms 里暗下去，画回静止的线（暗完那一拍再画一次，之后不再重画）。
// 帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）：
// 挂载时起一次计时，之后按固定节拍走，重画不重起；只重画这一行；相邻同色的格子并成一段。
import type { ClientModule } from 'claude-code'

import { BREATH, beat, breatheCells, clockOf, envelope, glintCells, groove, isMoving, runs } from './motion'
import type { Beat, Cell } from './motion'

type Props = {
  /** 钩子画面板时的时刻：挂载时从它起算 */
  now: number
  width: number
  since: number
  /** 结束的时刻；还在发生时不带 */
  until?: number
  /** glint：静止时的那条线（逐格）、亮的颜色和最亮处；不带时是细槽 */
  cells?: Cell[]
  tint?: string
  center?: number
}

type State = { ref: Beat }

/** 面板的底：细槽从它起渐变 */
const PANE = '#262626'

const Rail: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const until = props.until ?? null
  const ref = beat(surface, props.now, BREATH.stepMs, clock => isMoving(clock - BREATH.stepMs, until))
  const clock = clockOf(ref, BREATH.stepMs)
  const width = Math.max(1, surface.columns || props.width)
  const env = envelope(clock, props.since, until)
  const lit =
    props.cells && props.tint
      ? glintCells(props.cells, clock, env, props.tint, props.center ?? 0)
      : breatheCells(groove(width, PANE), clock, env)
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
