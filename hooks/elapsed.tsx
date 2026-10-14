// 运行中子 agent 的耗时（Client 模块，spec D8）：每秒走一次，结束后固定；写法和列宽同列表里的耗时。
// 照 flightdeck 的 hooks/elapsed.tsx 改写（MIT License, Copyright (c) 2026 Stephen Casella）：
// since、now 来自钩子的 `$.clock`，挂载时起一次 1 秒的计时，之后自己加秒。偏离：钩子重画给了新的 now
// 也不从它重新数（flightdeck 会，计时没对齐 now，耗时会先多走一秒、下次重画再退回，anvil-k0t.39）；
// 真实会话里按墙上的第几秒算（motion.ts 的 beat），引擎卡过、帧时钟慢了也不落后。
import type { ClientModule } from 'claude-code'

import { formatDuration } from './cache'
import { beat, clockOf } from './motion'
import type { Beat } from './motion'
import { padStart } from './text'

type Props = {
  since: number
  now: number
  /** 结束的时刻；运行中为 null */
  endAt: number | null
  color?: string
  /** 右对齐到这么宽 */
  width: number
  /** 所在的那一行有焦点、被引擎反白：耗时也反白 */
  inverse?: boolean
}

type State = { ref: Beat }

const SECOND = 1000

const Elapsed: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const isRunning = props.endAt === null
  const ref = beat(surface, props.now, SECOND, () => isRunning)
  const at = props.endAt ?? clockOf(ref, SECOND)
  return (
    <Text color={props.color} inverse={props.inverse === true}>
      {padStart(formatDuration(at - props.since), props.width)}
    </Text>
  )
}

export default Elapsed
