// 画动效的元素（spec D10）：进行中图标、运行中的耗时。有 Client 时交给 Client 模块在界面的帧时钟上走
// （spinner.tsx、elapsed.tsx）；没有 Client（`'Client' in els` 为假，或界面的元素表里没有）或这个模块出过错（ui.fault）时
// 退回静止：静止的 ◐、耗时随面板重画更新。退路照 flightdeck register.tsx 的 rail()、clock()
// （MIT License, Copyright (c) 2026 Stephen Casella）。
// 只放不碰 `$` 的元素；出错的模块由 register.ts 的 ui.fault 钩子记下。

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { formatDuration } from './cache'
import { SPIN } from './motion'
import { padStart } from './text'

type Els = Pick<Elements['terminal'], 'Box' | 'Text'> & Partial<Pick<Elements['terminal'], 'Client'>>

/** 三个 Client 模块；ui.fault 报的 module 是插件目录下的路径，按文件名认 */
export const CLIENT_MODULES = ['spinner.tsx', 'elapsed.tsx'] as const
export type ClientModuleName = (typeof CLIENT_MODULES)[number]

/** ui.fault 报的模块路径是哪一个；不认识的为 null */
export function faultedModule(path: string): ClientModuleName | null {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return CLIENT_MODULES.find(one => one === name) ?? null
}

/** 这次绘制里动效怎么画：now 是钩子的时刻，各模块能不能用 */
export type Live = { now: number; spinner: boolean; elapsed: boolean }

/** 静止：一个 Client 都不用 */
export const still = (now: number): Live => ({ now, spinner: false, elapsed: false })

/**
 * 有 Client、模块没出过错才用它。`$.ui.resolve` 在 VS Code 上也给 Client，画出来是空的 Box
 * （AGENTS.md Pitfalls）：只认元素表里有 Client 的终端和桌面
 */
export function liveOf(els: object, surface: RenderSurface, now: number, faulted: readonly string[]): Live {
  const hasClient = (surface === 'terminal' || surface === 'desktop') && 'Client' in els
  const usable = (name: ClientModuleName) => hasClient && !faulted.includes(name)
  return { now, spinner: usable('spinner.tsx'), elapsed: usable('elapsed.tsx') }
}

/** Client 的 props 里不能有 undefined（引擎拒绝整个绘制）：没有颜色就不带这一项 */
const colorOf = (color: string | undefined) => (color === undefined ? {} : { color })

/**
 * 进行中图标：◐◓◑◒ 轮流；退路是静止的 ◐。
 * inverse：压在有焦点的 Button 上时跟着反白（引擎只反白 Button 自己的字，压在上面的 Client 不反白）
 */
export function spin(els: Els, live: Live, view: { key: string; color?: string; inverse?: boolean }): RenderElement {
  const { Client, Text } = els
  if (live.spinner && Client) {
    return <Client key={view.key} module="./spinner.tsx" width={1} height={1} props={{ now: live.now, inverse: view.inverse === true, ...colorOf(view.color) }} />
  }
  return (
    <Text key={view.key} color={view.color}>
      {SPIN.frames[0]}
    </Text>
  )
}

/** 接在一段字后面的进行中图标（缓存框保活的"进行中 ◐"）：空一格再画图标，去掉时前面的字不动 */
export function spinAfter(els: Els, live: Live, view: { key: string; color?: string }): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={`after:${view.key}`} flexShrink={0}>
      <Text> </Text>
      {spin(els, live, view)}
    </Box>
  )
}

/** 运行中的耗时：每秒走，右对齐到 width 格；结束的、退路都是按 now 算好的静止文字 */
export function clock(
  els: Els,
  live: Live,
  view: { key: string; since: number; endAt: number | null; color?: string; width: number; inverse?: boolean },
): RenderElement {
  const { Client, Text } = els
  if (view.endAt === null && live.elapsed && Client) {
    return (
      <Client
        key={view.key}
        module="./elapsed.tsx"
        width={view.width}
        height={1}
        props={{ since: view.since, now: live.now, endAt: null, width: view.width, inverse: view.inverse === true, ...colorOf(view.color) }}
      />
    )
  }
  return (
    <Text key={view.key} color={view.color}>
      {padStart(formatDuration((view.endAt ?? live.now) - view.since), view.width)}
    </Text>
  )
}
