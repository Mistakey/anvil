// 框与框之间的分隔线（Client 模块，spec D10）：主会话正在回复时整条线的颜色在线色和 Claude 橙之间慢慢起伏（呼吸），
// 其余时候是静止的线色。只有这一行在界面的帧时钟上重画，面板不跟着重画。帧时钟的用法照 flightdeck 的 hooks/rail.tsx
// （MIT License, Copyright (c) 2026 Stephen Casella）；偏离见 motion.ts。
import type { ClientModule } from 'claude-code'

import { BREATH, breathColor, clockOf, follow, ticking } from './motion'
import type { Ticking } from './motion'

type Props = {
  /** 主会话正在回复 */
  active: boolean
  /** 这一段回复从哪一刻起：从线色起步，几条线同一时刻同一个颜色 */
  since: number
  /** 线的宽度，和框同宽 */
  width: number
  /** 钩子画面板时的时刻 */
  now: number
  /** 线色 */
  rest: string
  /** 亮到最高时的颜色 */
  glow: string
}

type Ref = Ticking & { active: boolean }
type State = { ref: Ref }

const Rail: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref: Ref = surface.state?.ref ?? { ...ticking(props.now), active: props.active }
  ref.active = props.active
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), BREATH.stepMs, () => {
    if (ref.active) {
      ref.ticks += 1
      surface.setState({ ref })
    }
  })
  if (surface.state === undefined) surface.setState({ ref })

  const width = Math.max(1, props.width)
  const color = props.active ? breathColor(props.rest, props.glow, clockOf(ref, BREATH.stepMs) - props.since) : props.rest
  return (
    <Box>
      <Text color={color}>{'─'.repeat(width)}</Text>
    </Box>
  )
}

export default Rail
