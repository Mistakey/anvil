// 进行中图标（Client 模块，spec D10「呼吸」）：◐◓◑◒ 轮流，220ms 一格（一口气转三圈）；Claude 橙，吸气时亮到光芯。
// 只在事情正在发生时画。帧时钟的用法照 flightdeck 的 hooks/rail.tsx（MIT License, Copyright (c) 2026 Stephen Casella）：
// 挂载时起一次计时，之后按固定节拍走，重画不重起；相位按绝对时刻算（motion.ts），和别处同相。
import type { ClientModule } from 'claude-code'

import { BREATH, beat, clockOf, spinColor, spinGlyph } from './motion'
import type { Beat } from './motion'

type Props = {
  /** 钩子画面板时的时刻：挂载时从它起算 */
  now: number
  /** 所在的那一行有焦点、被引擎反白：图标也反白 */
  inverse?: boolean
}

type State = { ref: Beat }

const always = () => true

const Spinner: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = beat(surface, props.now, BREATH.stepMs, always)
  const clock = clockOf(ref, BREATH.stepMs)
  return (
    <Text color={spinColor(clock)} inverse={props.inverse === true}>
      {spinGlyph(clock)}
    </Text>
  )
}

export default Spinner
