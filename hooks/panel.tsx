// anvil 面板的绘制（spec D7、D10）：六个区块的固定顺序和共用的框样式。
// 只放不碰 `$` 的界面组件：register.ts 的 Pane ui.render 钩子取好元素和数据，交给 drawPanel。
// 打开、隐藏面板和收集读数都在 register.ts。

import type { Elements, PaneCloseOrigin, RenderElement } from 'claude-code'

import type { Subcommand } from './command'
import { COLOR, GRID, ICON, restWidth } from './style'
import type { Segment } from './style'
import { cells, fit } from './text'
import type { GridRow } from './usage'

/** 面板的 id，也是 Pane ui.render 的 requestId；只有一个面板时引擎不画标题 */
export const PANE = { id: 'anvil', title: 'anvil', columns: 70 } as const

export const PANEL_SUBCOMMAND: Subcommand = { name: 'panel', args: ['hide', 'show'], summary: '在当前会话隐藏或显示 anvil 面板' }

/** 用户手动关掉面板等同 `/anvil panel hide`；anvil 自己关的、卸载时引擎收掉的不算 */
export const hidesPanel = (origin: PaneCloseOrigin) => origin.kind === 'person'

/**
 * 标题嵌进上边框（绝对定位压在边框那一行上）；D11 实测引擎画不出来时改成 false，
 * 标题退成框内第一行（spec D10 已定的退路）。
 */
const TITLE_IN_BORDER = true

type Els = { Box: Elements['terminal']['Box']; Text: Elements['terminal']['Text'] }

export type SectionId = 'messages' | 'denials' | 'agents' | 'usage' | 'cache'

type Section = { id: SectionId; icon: string; title: string; color: string; border: string }

/** 自上而下的固定顺序；越常看的越靠近输入框。最下面还有两行身份栏（不带框） */
export const SECTIONS: readonly Section[] = [
  { id: 'messages', icon: ICON.messages, title: '我的消息', color: COLOR.text, border: COLOR.faint },
  { id: 'denials', icon: ICON.denials, title: '自动模式拒绝', color: COLOR.denials, border: COLOR.denialsBorder },
  { id: 'agents', icon: ICON.agents, title: '子 agent', color: COLOR.agents, border: COLOR.agentsBorder },
  { id: 'usage', icon: ICON.usage, title: '用量', color: COLOR.usage, border: COLOR.usageBorder },
  { id: 'cache', icon: ICON.cache, title: '缓存', color: COLOR.cache, border: COLOR.cacheBorder },
]

/** 框的边框和左右内边距各占 1 格 */
export const innerWidth = (columns: number) => Math.max(0, columns - 4)

/** 一个区块交给框的内容：右上角的计数或状态，和框里的行 */
export type SectionBody = { status?: Segment[]; rows: RenderElement[] }

export type PanelView = {
  /** Pane 的 bodyColumns */
  columns: number
  /** Pane 的 scroll.bodyRows：我的消息框拉高到占满剩余高度 */
  rows: number
  bodies: Partial<Record<SectionId, SectionBody>>
}

function segments(els: Els, list: readonly Segment[]) {
  const { Text } = els
  return list.map(segment => (
    <Text color={segment.color} bold={segment.bold}>
      {segment.text}
    </Text>
  ))
}

/** 右上角状态能用的格数：不压住标题，左右各留一格边框线 */
function statusRoom(columns: number, title: string): number {
  return Math.max(0, columns - 2 - cells(title) - 4)
}

function fitStatus(list: readonly Segment[], room: number): Segment[] {
  const kept: Segment[] = []
  let left = room
  for (const segment of list) {
    const size = cells(segment.text)
    if (size > left) {
      if (left > 1) kept.push({ ...segment, text: fit(segment.text, left) })
      break
    }
    kept.push(segment)
    left -= size
  }
  return kept
}

function frame(els: Els, section: Section, body: SectionBody | undefined, columns: number, isFill: boolean) {
  const { Box, Text } = els
  const title = ` ${section.icon} ${section.title} `
  const status = body?.status ? fitStatus([{ text: ' ' }, ...body.status, { text: ' ' }], statusRoom(columns, title)) : []
  const heading = (
    <Text color={section.color} bold>
      {TITLE_IN_BORDER ? title : title.trim()}
    </Text>
  )
  return (
    <Box
      key={`section:${section.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={section.border}
      paddingX={1}
      width={columns}
      flexShrink={0}
      flexGrow={isFill ? 1 : 0}
    >
      {TITLE_IN_BORDER ? (
        <Box key={`title:${section.id}`} position="absolute" top={-1} left={1}>
          {heading}
        </Box>
      ) : (
        heading
      )}
      {status.length > 0 ? (
        <Box key={`status:${section.id}`} position="absolute" top={-1} right={1}>
          <Text color={COLOR.muted}>{segments(els, status)}</Text>
        </Box>
      ) : null}
      {body?.rows ?? []}
    </Box>
  )
}

/** 用量框、缓存框共用的三列网格的一行 */
export function gridRow(els: Els, row: GridRow, inner: number): RenderElement {
  const { Box, Text } = els
  return (
    <Box key={`row:${row.key}`} columnGap={GRID.gap} width={inner} flexShrink={0}>
      <Box width={GRID.label} flexShrink={0}>
        <Text color={COLOR.muted}>{fit(row.label, GRID.label)}</Text>
      </Box>
      <Box width={GRID.middle} flexShrink={0}>
        <Text>{segments(els, row.middle)}</Text>
      </Box>
      <Box width={restWidth(inner)} flexShrink={0}>
        <Text wrap="truncate">{segments(els, row.rest)}</Text>
      </Box>
    </Box>
  )
}

export function drawPanel(els: Els, view: PanelView): RenderElement {
  const { Box } = els
  const columns = Math.max(1, view.columns)
  return (
    <Box flexDirection="column" width={columns} minHeight={view.rows}>
      {SECTIONS.map(section => frame(els, section, view.bodies[section.id], columns, section.id === 'messages'))}
    </Box>
  )
}
