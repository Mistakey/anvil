// 画动效的元素（spec D10「呼吸」）：框间细槽上的呼吸、名字的呼吸、进行中图标、运行中的耗时、回复结束的落定。
// 有 Client 时交给 Client 模块在界面的帧时钟上走（rail.tsx、glow.tsx、spinner.tsx、elapsed.tsx），
// 只重画这一小块；没有 Client（`'Client' in els` 为假，或界面的元素表里没有）或这个模块出过错（ui.fault）时
// 退回静止：细槽、名字照常画，◐ 静止，耗时随面板重画更新。退路照 flightdeck register.tsx 的 rail()、clock()
// （MIT License, Copyright (c) 2026 Stephen Casella）。
// 只放不碰 `$` 的元素；出错的模块由 register.ts 的 ui.fault 钩子记下。

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { formatDuration } from './cache'
import { BREATH, SPIN, groove, runs } from './motion'
import type { Cell } from './motion'
import { COLOR } from './style'
import { padStart } from './text'

type Els = Pick<Elements['terminal'], 'Box' | 'Text'> & Partial<Pick<Elements['terminal'], 'Client'>>

/** 四个 Client 模块；ui.fault 报的 module 是插件目录下的路径，按文件名认 */
export const CLIENT_MODULES = ['spinner.tsx', 'elapsed.tsx', 'rail.tsx', 'glow.tsx'] as const
export type ClientModuleName = (typeof CLIENT_MODULES)[number]

/** ui.fault 报的模块路径是哪一个；不认识的为 null */
export function faultedModule(path: string): ClientModuleName | null {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return CLIENT_MODULES.find(one => one === name) ?? null
}

/** 一件事从什么时候起、什么时候结束（还在发生时 until 为 null） */
export type Span = { since: number; until: number | null }

/**
 * 这次绘制里动效怎么画：now 是钩子的时刻（Client 挂载时从它起算，相位按绝对时刻算、几处同相），
 * 各模块能不能用
 */
export type Live = { now: number; spinner: boolean; elapsed: boolean; rail: boolean; glow: boolean }

/** 静止：一个 Client 都不用 */
export const still = (now: number): Live => ({ now, spinner: false, elapsed: false, rail: false, glow: false })

/**
 * 有 Client、模块没出过错才用它。`$.ui.resolve` 在 VS Code 上也给 Client，画出来是空的 Box
 * （AGENTS.md Pitfalls）：只认元素表里有 Client 的终端和桌面
 */
export function liveOf(els: object, surface: RenderSurface, now: number, faulted: readonly string[]): Live {
  const hasClient = (surface === 'terminal' || surface === 'desktop') && 'Client' in els
  const usable = (name: ClientModuleName) => hasClient && !faulted.includes(name)
  return { now, spinner: usable('spinner.tsx'), elapsed: usable('elapsed.tsx'), rail: usable('rail.tsx'), glow: usable('glow.tsx') }
}

/** 还在动：在发生，或结束后还没落定 / 暗完 */
export const isLive = (span: Span | null, now: number) =>
  span !== null && (span.until === null || now < span.until + Math.max(BREATH.outMs, BREATH.settleMs))

/** Client 的 props 里不能有 undefined（引擎拒绝整个绘制）：没有的项不带 */
const defined = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined))

/** 几格字画成静止的一串 Text（相邻同色并成一段） */
export function cellText(els: Pick<Els, 'Text'>, key: string, list: readonly Cell[], inverse = false): RenderElement {
  const { Text } = els
  return (
    <Text key={key} inverse={inverse}>
      {runs(list).map(cell => (
        <Text color={cell.color} bold={cell.bold}>
          {cell.ch}
        </Text>
      ))}
    </Text>
  )
}

/** 一段文字逐格拆开（宽字后面跟一格空串），Client 按格子算明暗 */
export function toCells(text: string, color?: string, bold?: boolean): Cell[] {
  const out: Cell[] = []
  for (const ch of text) {
    const cell: Cell = { ch, ...(color === undefined ? {} : { color }), ...(bold ? { bold } : {}) }
    out.push(cell)
    // 宽字后面那一格和它同色，相邻同色并段时不被拆开
    if (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)) out.push({ ...cell, ch: '' })
  }
  return out
}

/**
 * 进行中图标：◐◓◑◒ 轮流，跟着呼吸亮暗；退路是静止的 ◐。
 * inverse：压在有焦点的 Button 上时跟着反白（引擎只反白 Button 自己的字，压在上面的 Client 不反白）
 */
export function spin(els: Els, live: Live, view: { key: string; inverse?: boolean }): RenderElement {
  const { Client, Text } = els
  if (live.spinner && Client) {
    return <Client key={view.key} module="./spinner.tsx" width={1} height={1} props={{ now: live.now, inverse: view.inverse === true }} />
  }
  return (
    <Text key={view.key} color={COLOR.active}>
      {SPIN.frames[0]}
    </Text>
  )
}

/** 接在一段字后面的进行中图标（缓存框保活的"进行中 ◐"）：空一格再画图标，去掉时前面的字不动 */
export function spinAfter(els: Els, live: Live, view: { key: string }): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={`after:${view.key}`} flexShrink={0}>
      <Text> </Text>
      {spin(els, live, view)}
    </Box>
  )
}

/**
 * 框间的细槽：静止时中间略亮、两端隐进底色的一道刻痕；主会话回复中（span 还在动）交给 rail.tsx 画呼吸
 */
export function rail(els: Els, live: Live, view: { key: string; columns: number; span: Span | null }): RenderElement {
  const { Client } = els
  if (live.rail && Client && isLive(view.span, live.now) && view.span) {
    return (
      <Client
        key={view.key}
        module="./rail.tsx"
        width={view.columns}
        height={1}
        props={defined({ now: live.now, width: view.columns, since: view.span.since, until: view.span.until ?? undefined })}
      />
    )
  }
  return cellText(els, view.key, groove(view.columns, COLOR.pane))
}

/**
 * 翻译框的上边框：翻译中从 center（标题后面那一格）起亮一档、跟着呼吸涨落（rail.tsx 的 glint）；静止时就是这几格
 */
export function glintLine(
  els: Els,
  live: Live,
  view: { key: string; cells: Cell[]; columns: number; span: Span | null; tint: string; center: number },
): RenderElement {
  const { Client } = els
  if (live.rail && Client && isLive(view.span, live.now) && view.span) {
    return (
      <Client
        key={view.key}
        module="./rail.tsx"
        width={view.columns}
        height={1}
        props={defined({
          now: live.now,
          width: view.columns,
          since: view.span.since,
          until: view.span.until ?? undefined,
          cells: view.cells.map(cell => defined({ ch: cell.ch, color: cell.color, bold: cell.bold })),
          tint: view.tint,
          center: view.center,
        })}
      />
    )
  }
  return cellText(els, view.key, view.cells)
}

/**
 * 会呼吸的一段字（glow.tsx）：
 * - breathe：事情在发生时从中间亮起、往两头渐暗，跟着呼吸涨落（shine）；给了 lit 时字先从本色渐变到 lit
 *   （回复中模型名变成 Claude 橙），结束后再落回本色；
 * - flash：事情刚结束，标了 lit 的格子从 shine 落回本色（回复结束速度行的读数、图标）。
 * span 不在动时画静止的字。
 */
export function glowText(
  els: Els,
  live: Live,
  view: { key: string; cells: Cell[]; span: Span | null; mode: 'breathe' | 'flash'; shine: string; lit?: string; inverse?: boolean },
): RenderElement {
  const { Client } = els
  if (live.glow && Client && isLive(view.span, live.now) && view.span) {
    return (
      <Client
        key={view.key}
        module="./glow.tsx"
        height={1}
        props={defined({
          now: live.now,
          cells: view.cells.map(cell => defined({ ch: cell.ch, color: cell.color, bold: cell.bold, lit: cell.lit })),
          since: view.span.since,
          until: view.span.until ?? undefined,
          mode: view.mode,
          shine: view.shine,
          lit: view.lit,
          inverse: view.inverse === true,
        })}
      />
    )
  }
  const lit = view.lit
  // 没有 Client 时回复中的模型名直接画成 lit
  const shown = lit && view.span && view.span.until === null ? view.cells.map(cell => ({ ...cell, color: lit })) : view.cells
  return cellText(els, view.key, shown, view.inverse === true)
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
        props={defined({ since: view.since, now: live.now, endAt: null, width: view.width, inverse: view.inverse === true, color: view.color })}
      />
    )
  }
  return (
    <Text key={view.key} color={view.color}>
      {padStart(formatDuration((view.endAt ?? live.now) - view.since), view.width)}
    </Text>
  )
}
