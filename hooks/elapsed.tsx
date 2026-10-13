// 运行中子 agent 的耗时（Client 模块，spec D8）：每秒走一次，结束后固定；写法和列宽同列表里的耗时。
// 照 flightdeck 的 hooks/elapsed.tsx 改写（MIT License, Copyright (c) 2026 Stephen Casella）：
// since、now 来自钩子的 `$.clock`，两次重画之间 Client 自己加秒；偏离见 motion.ts 的 follow。
import type { ClientModule } from 'claude-code'

import { formatDuration } from './cache'
import { clockOf, follow, ticking } from './motion'
import type { Ticking } from './motion'
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

type Ref = Ticking & { isRunning: boolean }
type State = { ref: Ref }

const SECOND = 1000

const Elapsed: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref: Ref = surface.state?.ref ?? { ...ticking(props.now), isRunning: props.endAt === null }
  ref.isRunning = props.endAt === null
  follow(ref, props.now, (ms, fn) => surface.every(ms, fn), SECOND, () => {
    if (ref.isRunning) {
      ref.ticks += 1
      surface.setState({ ref })
    }
  })
  if (surface.state === undefined) surface.setState({ ref })
  const at = props.endAt ?? clockOf(ref, SECOND)
  return (
    <Text color={props.color} inverse={props.inverse === true}>
      {padStart(formatDuration(at - props.since), props.width)}
    </Text>
  )
}

export default Elapsed
