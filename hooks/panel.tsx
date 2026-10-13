// anvil 面板的绘制（spec D7、D8、D10）：六个区块的固定顺序、共用的框样式，和三个列表的共同规则
// （旧的在上、新的在下；超出上限时顶部"▴ 更早的 N 条"；展开一个列表时其余收成一行）。
// 只放不碰 `$` 的界面组件：register.ts 的 Pane ui.render 钩子取好元素和数据，交给 drawPanel。
// 打开、隐藏面板、收集读数和按键改变的展开状态都在 register.ts。

import type { Elements, PaneCloseOrigin, RenderElement } from 'claude-code'

import type { ListId, PanelFold } from '../types'
import type { Subcommand } from './command'
import { earlierText, fitCount, fitRows } from './list'
import type { Fit } from './list'
import { COLOR, GRID, ICON, fitSegments, restWidth } from './style'
import type { Segment } from './style'
import { cells, fit, padStart } from './text'
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

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type SectionId = ListId | 'usage' | 'cache'

/** hotkey：列表的展开键（spec D9 的 a / d / m），只有三个列表有 */
type Section = { id: SectionId; icon: string; title: string; color: string; border: string; hotkey?: string }

/** 自上而下的固定顺序；越常看的越靠近输入框。最下面还有两行身份栏（不带框） */
export const SECTIONS: readonly Section[] = [
  { id: 'messages', icon: ICON.messages, title: '我的消息', color: COLOR.text, border: COLOR.faint, hotkey: 'm' },
  { id: 'denials', icon: ICON.denials, title: '自动模式拒绝', color: COLOR.denials, border: COLOR.denialsBorder, hotkey: 'd' },
  { id: 'agents', icon: ICON.agents, title: '子 agent', color: COLOR.agents, border: COLOR.agentsBorder, hotkey: 'a' },
  { id: 'usage', icon: ICON.usage, title: '用量', color: COLOR.usage, border: COLOR.usageBorder },
  { id: 'cache', icon: ICON.cache, title: '缓存', color: COLOR.cache, border: COLOR.cacheBorder },
]

/** 框的边框和左右内边距各占 1 格 */
export const innerWidth = (columns: number) => Math.max(0, columns - 4)

/** 一个区块交给框的内容：右上角的计数或状态，和框里的行 */
export type SectionBody = { status?: Segment[]; rows: RenderElement[] }

/** 列表的一项：第一行是它自己，展开详情时后面跟着详情的几行 */
export type ListItem = { key: string; rows: RenderElement[] }

/** 一个列表交给面板的内容；按上限截、展开、收成一行由面板按共同规则做（list.ts） */
export type ListBody = {
  /** 右上角的计数或状态 */
  status: Segment[]
  /** 量词：消息和拒绝记录用"条"，子 agent 用"个"（D10） */
  unit: string
  /** 第一列（序号或时间）的宽度，"▴" 右对齐在这一列里 */
  lead: number
  /** 旧的在前 */
  items: ListItem[]
  /** 收起时最多显示几条；'fill' 是占满剩余高度（我的消息） */
  limit: number | 'fill'
  /** 一条都没有时框里的那行字 */
  empty: string
}

export type PanelView = {
  /** Pane 的 bodyColumns */
  columns: number
  /** Pane 的 scroll.bodyRows：我的消息框（或展开的列表）拉高到占满剩余高度 */
  rows: number
  bodies: Partial<Record<SectionId, SectionBody>>
  /** 三个列表的内容；还没接上内容的列表照样能展开、收成一行 */
  lists: Partial<Record<ListId, ListBody>>
  fold: PanelFold
  /** 身份栏的两行，接在缓存框下面（不带框） */
  identity?: RenderElement[]
  /** 按了列表的展开键，或焦点在标题、"更早的"那行上按了 Enter */
  onToggle: (id: ListId) => void
}

const isList = (id: SectionId): id is ListId => id === 'messages' || id === 'denials' || id === 'agents'

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

/**
 * 标题。列表的标题是一个 Button：按展开键（或焦点在上面时按 Enter）展开、收起这个列表；
 * 引擎在前面画出"a: "，按键就写在标题上。
 */
function heading(els: Els, section: Section, text: string, onPress: (() => void) | null) {
  const { Button, Text } = els
  const label = (
    <Text color={section.color} bold>
      {text}
    </Text>
  )
  if (!section.hotkey || !onPress) return label
  return (
    <Button key={`list:${section.id}`} label={section.title} plain hotkey={section.hotkey} onPress={onPress}>
      {label}
    </Button>
  )
}

function frame(els: Els, section: Section, body: SectionBody | undefined, columns: number, isFill: boolean, title: string, onPress: (() => void) | null) {
  const { Box, Text } = els
  // 列表标题前面引擎还画"a: "，占 3 格
  const shown = TITLE_IN_BORDER ? ` ${title} ` : title
  const taken = section.hotkey && onPress ? `${shown}a: ` : shown
  const status = body?.status ? fitSegments([{ text: ' ' }, ...body.status, { text: ' ' }], statusRoom(columns, taken)) : []
  const head = heading(els, section, shown, onPress)
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
          {head}
        </Box>
      ) : (
        head
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

/** 收成一行的列表（设计稿 .fold）："▸ 图标 标题 ──── 计数"；整行是一个 Button，按展开键展开它 */
function folded(els: Els, section: Section, body: ListBody | undefined, columns: number, onPress: () => void): RenderElement {
  const { Box, Button, Text } = els
  const head = `▸ ${section.icon} ${section.title} `
  const status = body ? body.status.map(one => one.text).join('') : ''
  const tail = status ? ` ${status}` : ''
  // 左右各空 1 格；引擎在前面画"a: "占 3 格
  const room = Math.max(0, columns - 2 - 3)
  const shownHead = fit(head, room)
  const line = Math.max(0, room - cells(shownHead) - cells(tail))
  const shownTail = fit(tail, Math.max(0, room - cells(shownHead) - line))
  return (
    <Box key={`section:${section.id}`} width={columns} flexShrink={0} paddingX={1}>
      <Button key={`list:${section.id}`} label={section.title} plain hotkey={section.hotkey} onPress={onPress}>
        <Text color={section.color} bold>
          {shownHead}
        </Text>
        <Text color={section.border}>{'─'.repeat(line)}</Text>
        <Text color={COLOR.muted}>{shownTail}</Text>
      </Button>
    </Box>
  )
}

/** "▴ 更早的 N 个 · 按 a 展开"：收起时是一个 Button（焦点在上面时 Enter 展开），展开时只是一行字 */
function earlierRow(els: Els, section: Section, body: ListBody, count: number, inner: number, isExpanded: boolean, onPress: () => void) {
  const { Box, Button, Text } = els
  const text = fit(`${padStart('▴', body.lead)} ${earlierText(count, body.unit, section.hotkey ?? '', isExpanded)}`, inner)
  const line = <Text color={COLOR.muted}>{text}</Text>
  return (
    <Box key={`row:earlier:${section.id}`} width={inner} flexShrink={0}>
      {isExpanded ? (
        line
      ) : (
        <Button key={`earlier:${section.id}`} label={text.trim()} plain onPress={onPress}>
          {line}
        </Button>
      )}
    </Box>
  )
}

/** 列表框里的行：按上限或剩余高度截，截掉的条数写在顶部 */
function listRows(els: Els, section: Section, body: ListBody, fitted: Fit, inner: number, isExpanded: boolean, onPress: () => void): RenderElement[] {
  const { Text } = els
  if (body.items.length === 0) {
    return [
      <Text key={`empty:${section.id}`} color={COLOR.muted}>
        {fit(body.empty, inner)}
      </Text>,
    ]
  }
  const shown = body.items.slice(fitted.start, fitted.end).flatMap(item => item.rows)
  return fitted.start > 0 ? [earlierRow(els, section, body, fitted.start, inner, isExpanded, onPress), ...shown] : shown
}

/** 列表框里的行数（不含边框） */
function listHeight(body: ListBody, fitted: Fit): number {
  if (body.items.length === 0) return 1
  const rows = body.items.slice(fitted.start, fitted.end).reduce((sum, item) => sum + item.rows.length, 0)
  return rows + (fitted.start > 0 ? 1 : 0)
}

const itemHeights = (body: ListBody) => body.items.map(item => Math.max(1, item.rows.length))

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

/**
 * 每个列表这次画出哪几项。占满剩余高度的只有一个：展开的列表；没有展开时是我的消息。
 * 其余区块的高度先算出来（收成一行的占 1 行，框占内容加 2 行边框），剩下的给它。
 */
function fitLists(view: PanelView, fillId: SectionId): Map<ListId, Fit> {
  const { expanded } = view.fold
  const fits = new Map<ListId, Fit>()
  let used = view.identity?.length ?? 0
  for (const section of SECTIONS) {
    const id = section.id
    if (id === fillId) continue
    if (isList(id) && expanded !== null) {
      used += 1
      continue
    }
    const list = isList(id) ? view.lists[id] : undefined
    if (isList(id) && list) {
      const fitted = fitCount(list.items.length, typeof list.limit === 'number' ? list.limit : list.items.length)
      fits.set(id, fitted)
      used += listHeight(list, fitted) + 2
      continue
    }
    used += (view.bodies[id]?.rows.length ?? 0) + 2
  }
  const fill = isList(fillId) ? view.lists[fillId] : undefined
  if (isList(fillId) && fill) {
    const room = Math.max(1, view.rows - used - 2)
    const isExpanded = expanded === fillId
    fits.set(
      fillId,
      !isExpanded && typeof fill.limit === 'number'
        ? fitCount(fill.items.length, fill.limit)
        : fitRows(itemHeights(fill), room, isExpanded ? view.fold.scrolled : 0),
    )
  }
  return fits
}

export function drawPanel(els: Els, view: PanelView): RenderElement {
  const { Box } = els
  const columns = Math.max(1, view.columns)
  const inner = innerWidth(columns)
  const { expanded } = view.fold
  const fillId: SectionId = expanded ?? 'messages'
  const fits = fitLists(view, fillId)

  const drawn = SECTIONS.map(section => {
    const id = section.id
    const isFill = id === fillId
    if (!isList(id)) return frame(els, section, view.bodies[id], columns, isFill, `${section.icon} ${section.title}`, null)
    const toggle = () => view.onToggle(id)
    const list = view.lists[id]
    if (expanded !== null && id !== expanded) return folded(els, section, list, columns, toggle)
    const isExpanded = id === expanded
    const title = `${isExpanded ? '▾ ' : ''}${section.icon} ${section.title}`
    if (!list) return frame(els, section, undefined, columns, isFill, title, toggle)
    const fitted = fits.get(id) ?? { start: 0, end: list.items.length }
    const status = isExpanded ? [...list.status, { text: ` · 按 ${section.hotkey} 收起` }] : list.status
    const body = { status, rows: listRows(els, section, list, fitted, inner, isExpanded, toggle) }
    return frame(els, section, body, columns, isFill, title, toggle)
  })

  return (
    <Box flexDirection="column" width={columns} minHeight={view.rows}>
      {drawn}
      {view.identity ?? []}
    </Box>
  )
}
