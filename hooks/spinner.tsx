// 进行中图标（Client 模块，spec D10「流光」）：◐◓◑◒ 轮流，144ms 一格；Claude 橙，波前经过时亮到 Claude 的微光色再暗回来。
// 只在事情正在发生时画。帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）；
// 相位按时钟算（motion.ts）。
import type { ClientModule } from 'claude-code'

import { mix } from './color'
import { FLOW, LIGHT, clockOf, follow, pulseAt, spinGlyph, ticking } from './motion'
import type { Ticking } from './motion'

type Props = {
  /** 钩子画面板时的时刻、相位的零点 */
  now: number
  epoch: number
  /** 图标在面板里的行和列、面板宽：波前按它们算到达的时刻 */
  row: number
  x: number
  width: number
  /** 所在的那一行有焦点、被引擎反白：图标也反白 */
  inverse?: boolean
}

type State = { ref: Ticking }

const Spinner: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? ticking(props.now)
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), FLOW.stepMs, () => {
    ref.ticks += 1
    surface.setState({ ref })
  })
  if (surface.state === undefined) surface.setState({ ref })
  const clock = clockOf(ref, FLOW.stepMs) - props.epoch
  return (
    <Text color={mix(LIGHT.body, LIGHT.core, pulseAt(clock, props.row, props.x, props.width))} inverse={props.inverse === true}>
      {spinGlyph(clock)}
    </Text>
  )
}

export default Spinner
