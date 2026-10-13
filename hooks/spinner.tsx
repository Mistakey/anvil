// 进行中图标（Client 模块，spec D10）：◐◓◑◒ 轮流，约 120ms 一格；只在事情正在发生时画。
// 帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）；相位按时钟算（motion.ts）。
import type { ClientModule } from 'claude-code'

import { SPIN, clockOf, follow, spinGlyph, ticking } from './motion'
import type { Ticking } from './motion'

type Props = {
  /** 钩子画面板时的时刻 */
  now: number
  color?: string
  /** 所在的那一行有焦点、被引擎反白：图标也反白 */
  inverse?: boolean
}

type State = { ref: Ticking }

const Spinner: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? ticking(props.now)
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), SPIN.stepMs, () => {
    ref.ticks += 1
    surface.setState({ ref })
  })
  if (surface.state === undefined) surface.setState({ ref })
  return (
    <Text color={props.color} inverse={props.inverse === true}>
      {spinGlyph(clockOf(ref, SPIN.stepMs))}
    </Text>
  )
}

export default Spinner
