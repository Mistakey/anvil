// 框与框之间的分隔线（Client 模块，spec D10）：主会话正在回复时一段亮光从左往右扫，其余时候是静止的暗线。
// 只有这一行在界面的帧时钟上重画，面板不跟着重画。照 flightdeck 的 hooks/rail.tsx 改写
// （MIT License, Copyright (c) 2026 Stephen Casella）；偏离见 motion.ts。
import type { ClientModule } from 'claude-code'

import { SWEEP, clockOf, follow, glowStyle, runs, sweep, ticking } from './motion'
import type { Ticking } from './motion'

type Props = {
  /** 主会话正在回复 */
  active: boolean
  /** 线的宽度，和框同宽 */
  width: number
  /** 钩子画面板时的时刻 */
  now: number
  /** 暗线的颜色 */
  rest: string
}

type Ref = Ticking & { active: boolean }
type State = { ref: Ref }

const Rail: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref: Ref = surface.state?.ref ?? { ...ticking(props.now), active: props.active }
  ref.active = props.active
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), SWEEP.stepMs, () => {
    if (ref.active) {
      ref.ticks += 1
      surface.setState({ ref })
    }
  })
  if (surface.state === undefined) surface.setState({ ref })

  const width = Math.max(1, props.width)
  if (!props.active) {
    return (
      <Box>
        <Text color={props.rest}>{'─'.repeat(width)}</Text>
      </Box>
    )
  }
  return (
    <Box>
      {runs(sweep(width, clockOf(ref, SWEEP.stepMs))).map(run => (
        <Text {...glowStyle(run.glow, props.rest)}>{'─'.repeat(run.size)}</Text>
      ))}
    </Box>
  )
}

export default Rail
