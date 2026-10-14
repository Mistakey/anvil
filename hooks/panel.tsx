// anvil 面板的绘制（spec D7、D8、D10）：区块的固定顺序、共用的框样式，和三个列表的共同规则
// （旧的在上、新的在下；超出上限时顶部"▴ 更早的 N 条"；展开一个列表时其余收成一行；
// 子 agent、自动模式拒绝没有内容时不画，有内容后框高固定）。
// 只放不碰 `$` 的界面组件：register.ts 的 Pane ui.render 钩子取好元素和数据，交给 drawPanel。
// 打开、隐藏面板、收集读数和按键改变的展开状态都在 register.ts。

import type { Elements, PaneCloseOrigin, RenderElement } from 'claude-code'

import type { ListId, PanelFold } from '../types'
import type { Subcommand } from './command'
import { earlierText, fitCount, fitRows } from './list'
import type { Fit } from './list'
import { rail, still } from './live'
import type { Live, Span } from './live'
import { COLOR, GRID, ICON, edgeLine, fitSegments, valueWidth } from './style'
import type { Segment } from './style'
import { cells, fit, padStart } from './text'
import type { GridRow } from './usage'

/** 面板的 id，也是 Pane ui.render 的 requestId；只有一个面板时引擎不画标题 */
export const PANE = { id: 'anvil', title: 'anvil', columns: 70 } as const

export const PANEL_SUBCOMMAND: Subcommand = { name: 'panel', summary: '显示或隐藏 anvil 面板' }

/** 用户手动关掉面板等同用 `/anvil panel` 隐藏；anvil 自己关的、卸载时引擎收掉的不算 */
export const hidesPanel = (origin: PaneCloseOrigin) => origin.kind === 'person'

/**
 * 标题嵌进上边框（spec D10）。翻译框只画上下两条边框、标题自己嵌进上边框，不经过这里（translate.tsx）。
 * 改成 false 时标题退成框内第一行（D10 已定的退路）。
 */
export const TITLE_IN_BORDER = true

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & Partial<Pick<Elements['terminal'], 'Client'>>

/**
 * 带边框的框，标题和右上角状态压在上边框那一行上。压的是带边框 Box 之后的兄弟节点：
 * 绝对定位放在带边框 Box 里面时真实终端不画（.13 第 6 项），放在它后面、同一个外层 Box 里画得出来
 * （.17 在 Windows 伪终端里实测；plugin test 不经过 Ink 的绘制，测不出这一点）。
 * key 给外层；带边框的 Box 的 key 由调用方给（`box:…`）。
 */
export function bordered(
  els: Pick<Els, 'Box'>,
  frame: { key: string; columns: number; grow?: boolean; box: RenderElement; edge?: RenderElement | null; head?: RenderElement | null; status?: RenderElement | null },
): RenderElement {
  const { Box } = els
  const id = frame.key
  return (
    <Box key={id} flexDirection="column" width={frame.columns} flexShrink={0} flexGrow={frame.grow ? 1 : 0}>
      {frame.box}
      {frame.edge ? (
        <Box key={`edge:${id}`} position="absolute" top={0} left={0}>
          {frame.edge}
        </Box>
      ) : null}
      {frame.head ? (
        <Box key={`title:${id}`} position="absolute" top={0} left={2}>
          {frame.head}
        </Box>
      ) : null}
      {frame.status ? (
        <Box key={`status:${id}`} position="absolute" top={0} right={2}>
          {frame.status}
        </Box>
      ) : null}
    </Box>
  )
}

export type SectionId = ListId | 'usage' | 'cache'

/** hotkey：列表的展开键（spec D9 的 a / d / m），只有三个列表有 */
/** color：标题的颜色，不给时是正文色（我的消息是中性的）；glow：上边框的光从它起；border：侧边和下边 */
type Section = { id: SectionId; icon: string; title: string; color?: string; glow: string; border: string; hotkey?: string }

/**
 * 自上而下的固定顺序，框与框之间是一道细槽；我的消息占满剩余高度，最下面还有三行身份栏（不带框），占原 statusline 的位置。
 * 标题用识别色原色、加粗；上边框从标题处的光渐暗到侧边，侧边和下边是识别色调暗的一档（anvil-k0t.47）。
 * 我的消息是中性的：标题正文色，光和边框是中性灰
 */
export const SECTIONS: readonly Section[] = [
  { id: 'cache', icon: ICON.cache, title: '缓存', color: COLOR.cache, glow: COLOR.cache, border: COLOR.cacheLine },
  { id: 'usage', icon: ICON.usage, title: '用量', color: COLOR.usage, glow: COLOR.usage, border: COLOR.usageLine },
  { id: 'agents', icon: ICON.agents, title: '子 agent', color: COLOR.agents, glow: COLOR.agents, border: COLOR.agentsLine, hotkey: 'a' },
  { id: 'denials', icon: ICON.denials, title: '自动模式拒绝', color: COLOR.denials, glow: COLOR.denials, border: COLOR.denialsLine, hotkey: 'd' },
  { id: 'messages', icon: ICON.messages, title: '我的消息', glow: COLOR.messages, border: COLOR.messagesLine, hotkey: 'm' },
]

/** 框的边框和左右内边距各占 1 格 */
export const innerWidth = (columns: number) => Math.max(0, columns - 4)

/** 一个区块交给框的内容：右上角的计数或状态，和框里的行 */
export type SectionBody = { status?: Segment[]; rows: RenderElement[] }

/**
 * 列表的一项：第一行是它自己，展开详情时后面跟着详情的几行。
 * height：这一项占的行数，不给时是 rows 的个数（一个元素画成两行的消息给 2）。
 * short：收成一行的画法（我的消息）；占满剩余高度的列表连最新一条都放不下时用它，免得把身份栏挤出面板。
 */
export type ListItem = { key: string; rows: RenderElement[]; height?: number; short?: RenderElement }

const heightOf = (item: ListItem) => Math.max(1, item.height ?? item.rows.length)

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
  /**
   * 数字：收起时框高固定，最多显示最近 limit 条，顶部一行留给"更早的"，条数变多框也不长高；
   * 一条都没有时整个框不画（子 agent、自动模式拒绝）。
   * 'fill'：一直画，占满剩余高度（我的消息）。
   */
  limit: number | 'fill'
  /** 一条都没有时框里的那行字（只有 'fill' 的列表用得到） */
  empty: string
}

export type PanelView = {
  /** Pane 的 bodyColumns */
  columns: number
  /** Pane 的 scroll.bodyRows：我的消息框（或展开的列表）拉高到占满剩余高度 */
  rows: number
  bodies: Partial<Record<SectionId, SectionBody>>
  /** 三个列表的内容；没给的子 agent、自动模式拒绝按没有内容处理（不画） */
  lists: Partial<Record<ListId, ListBody>>
  fold: PanelFold
  /** 身份栏的三行，接在最后一个区块下面（不带框、不加分隔线），贴着面板底边 */
  identity?: RenderElement[]
  /** 按了列表的展开键，或焦点在标题、"更早的"那行上按了 Enter */
  onToggle: (id: ListId) => void
  /** 动效：这次怎么画（live.tsx），和主会话回复的起止（细槽上的呼吸）；不给时静止 */
  motion?: { live: Live; reply: Span | null }
}

const isList = (id: SectionId): id is ListId => id === 'messages' || id === 'denials' || id === 'agents'

/** 固定高度的列表（limit 是数字）收起时框里的行数：顶部"更早的"一行加最近 limit 条 */
const fixedRows = (limit: number) => limit + 1

/** 没有内容就不画的列表：子 agent、自动模式拒绝（学 flightdeck）；我的消息一直画 */
function isHidden(id: SectionId, list: ListBody | undefined): boolean {
  if (!isList(id) || id === 'messages') return false
  return list === undefined || (typeof list.limit === 'number' && list.items.length === 0)
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
  const taken = `${TITLE_IN_BORDER ? `  ${title}` : title}${section.hotkey && onPress ? 'a: ' : ''}`
  const status = body?.status && body.status.length > 0 ? fitSegments([{ text: ' ' }, ...body.status, { text: ' ' }], statusRoom(columns, taken)) : []
  const head = heading(els, section, title, onPress)
  // 上边框整行自己画：标题处有光，往右渐暗（style.ts 的 edgeLine）；标题、计数再压在它上面
  const titleEnd = 2 + cells(` ${section.hotkey && onPress ? 'a: ' : ''}${title} `)
  const edge = TITLE_IN_BORDER ? <Text key={`edge:${section.id}`}>{segments(els, edgeLine(columns, titleEnd, section.glow, section.border))}</Text> : null
  // 嵌在边框上时左右各空一格；空格放在 Button 外面，引擎画的"a: "才紧挨着标题："╭─ a: 标题 ─"
  const inBorder = (
    <Box key={`head:${section.id}`}>
      <Text> </Text>
      {head}
      <Text> </Text>
    </Box>
  )
  const box = (
    <Box
      key={`box:${section.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={section.border}
      paddingX={1}
      width={columns}
      flexShrink={0}
      flexGrow={isFill ? 1 : 0}
    >
      {TITLE_IN_BORDER ? null : head}
      {body?.rows ?? []}
    </Box>
  )
  return bordered(els, {
    key: `section:${section.id}`,
    columns,
    grow: isFill,
    box,
    edge,
    head: TITLE_IN_BORDER ? inBorder : null,
    status: status.length > 0 ? <Text color={COLOR.secondary}>{segments(els, status)}</Text> : null,
  })
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
        <Text color={COLOR.secondary}>{shownTail}</Text>
      </Button>
    </Box>
  )
}

/** "▴ 更早的 N 个 · 按 a 展开"：收起时是一个 Button（焦点在上面时 Enter 展开），展开时只是一行字 */
function earlierRow(els: Els, section: Section, body: ListBody, count: number, inner: number, isExpanded: boolean, onPress: () => void) {
  const { Box, Button, Text } = els
  const text = fit(`${padStart('▴', body.lead)} ${earlierText(count, body.unit, section.hotkey ?? '', isExpanded)}`, inner)
  const line = <Text color={COLOR.secondary}>{text}</Text>
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

/**
 * 占满剩余高度的列表只有 room 行时：最新一条放不下就收成一行（short），还放不下就不画"更早的"那一行。
 * fitRows 至少画一项、哪怕它比 room 还高，超出的部分会把身份栏挤出面板（anvil-k0t.44 伪终端实测）
 */
function squeeze(items: readonly ListItem[], hasEarlier: boolean, room: number): { items: ListItem[]; hasEarlier: boolean } {
  const total = (list: readonly ListItem[], earlier: boolean) => list.reduce((sum, item) => sum + heightOf(item), 0) + (earlier ? 1 : 0)
  let shown = [...items]
  const last = shown[shown.length - 1]
  if (last?.short && heightOf(last) > 1 && total(shown, hasEarlier) > room) shown = [...shown.slice(0, -1), { key: last.key, rows: [last.short], height: 1 }]
  return { items: shown, hasEarlier: hasEarlier && total(shown, hasEarlier) <= room }
}

/** 列表框里的行：按上限或剩余高度截，截掉的条数写在顶部；固定高度的列表收起时不满就在下面留空行 */
function listRows(els: Els, section: Section, body: ListBody, fitted: Fit, inner: number, isExpanded: boolean, onPress: () => void, room?: number): RenderElement[] {
  const { Box, Text } = els
  if (body.items.length === 0) {
    return [
      <Text key={`empty:${section.id}`} color={COLOR.secondary}>
        {fit(body.empty, inner)}
      </Text>,
    ]
  }
  const sliced = body.items.slice(fitted.start, fitted.end)
  const { items, hasEarlier } = room === undefined ? { items: sliced, hasEarlier: fitted.start > 0 } : squeeze(sliced, fitted.start > 0, room)
  const shown = items.flatMap(item => item.rows)
  const rows = hasEarlier ? [earlierRow(els, section, body, fitted.start, inner, isExpanded, onPress), ...shown] : shown
  const drawn = items.reduce((sum, item) => sum + heightOf(item), 0) + (hasEarlier ? 1 : 0)
  // 占满剩余高度的列表靠框的 flexGrow 撑满，不补空行
  const blank = room === undefined ? Math.max(0, listHeight(body, fitted, isExpanded) - drawn) : 0
  const pads = Array.from({ length: blank }, (_, index) => <Box key={`pad:${section.id}:${index}`} width={inner} height={1} flexShrink={0} />)
  return [...rows, ...pads]
}

/** 列表框里的行数（不含边框）；固定高度的列表收起时至少是固定的行数 */
function listHeight(body: ListBody, fitted: Fit, isExpanded: boolean): number {
  if (body.items.length === 0) return 1
  const rows = body.items.slice(fitted.start, fitted.end).reduce((sum, item) => sum + heightOf(item), 0) + (fitted.start > 0 ? 1 : 0)
  return typeof body.limit === 'number' && !isExpanded ? Math.max(rows, fixedRows(body.limit)) : rows
}

const itemHeights = (body: ListBody) => body.items.map(heightOf)

/**
 * 固定高度的列表收起时画哪几项：最近 limit 条，更早的收进顶部一行。
 * 按序号键展开了一项的详情时照样是这几条，框临时长高放下详情，收起详情后回到固定高度。
 */
const fitFixed = (body: ListBody, limit: number): Fit => fitCount(body.items.length, limit)

/**
 * 用量框、缓存框的两列的一项：名称定宽，值从同一列起。第二行起（细节、放不下折下去的块）
 * 各画成一行，名称那一列空着；一行一个元素，框的高度按元素数算（fitLists）。
 * tail：接在第一行字后面的元素（保活续期请求在路上时转动的图标）；first：换掉第一行的字（续期中"进行中"的呼吸）。
 */
export function gridRow(els: Els, row: GridRow, inner: number, tail?: RenderElement, first?: RenderElement): RenderElement[] {
  const { Box, Text } = els
  const width = valueWidth(inner, row.labelWidth)
  return row.lines.map((line, index) => (
    <Box key={index === 0 ? `row:${row.key}` : `row:${row.key}:${index + 1}`} columnGap={GRID.gap} width={inner} flexShrink={0}>
      <Box width={row.labelWidth} flexShrink={0}>
        {index === 0 ? <Text wrap="truncate">{segments(els, fitSegments(row.label, row.labelWidth))}</Text> : null}
      </Box>
      <Box width={width} flexShrink={0}>
        {index === 0 && first ? first : <Text wrap="truncate">{segments(els, line)}</Text>}
        {index === 0 && tail ? tail : null}
      </Box>
    </Box>
  ))
}

/** 用量框：项与项之间空一行（缓存框不空），空行也是一个元素，框的高度照样按元素数算 */
export function spacedGridRows(els: Els, rows: readonly GridRow[], inner: number): RenderElement[] {
  const { Box } = els
  return rows.flatMap((row, index) => [
    ...(index === 0 ? [] : [<Box key={`space:${row.key}`} width={inner} height={1} flexShrink={0} />]),
    ...gridRow(els, row, inner),
  ])
}

/**
 * 每个列表这次画出哪几项。占满剩余高度的只有一个：展开的列表；没有展开时是我的消息。
 * 其余区块的高度先算出来（没画的占 0 行，收成一行的占 1 行，框占内容加 2 行边框，区块之间的空行各占 1 行），剩下的给它。
 */
function fitLists(view: PanelView, expanded: ListId | null, fillId: SectionId): { fits: Map<ListId, Fit>; room: number } {
  const fits = new Map<ListId, Fit>()
  const shown = SECTIONS.filter(section => !isHidden(section.id, isList(section.id) ? view.lists[section.id as ListId] : undefined))
  let used = (view.identity?.length ?? 0) + Math.max(0, shown.length - 1)
  for (const section of shown) {
    const id = section.id
    const list = isList(id) ? view.lists[id] : undefined
    if (id === fillId) continue
    if (isList(id) && expanded !== null) {
      used += 1
      continue
    }
    if (isList(id) && list) {
      const fitted = typeof list.limit === 'number' ? fitFixed(list, list.limit) : { start: 0, end: list.items.length }
      fits.set(id, fitted)
      used += listHeight(list, fitted, false) + 2
      continue
    }
    used += (view.bodies[id]?.rows.length ?? 0) + 2
  }
  const fill = isList(fillId) ? view.lists[fillId] : undefined
  const room = Math.max(1, view.rows - used - 2)
  if (isList(fillId) && fill) {
    const isExpanded = expanded === fillId
    fits.set(
      fillId,
      !isExpanded && typeof fill.limit === 'number' ? fitFixed(fill, fill.limit) : fitRows(itemHeights(fill), room, isExpanded ? view.fold.scrolled : 0),
    )
  }
  return { fits, room }
}

export function drawPanel(els: Els, view: PanelView): RenderElement {
  const { Box } = els
  const columns = Math.max(1, view.columns)
  const inner = innerWidth(columns)
  // 展开的列表没有内容（如 /clear 之后）就不画它，按全收起排
  const opened = view.fold.expanded
  const expanded = opened !== null && !isHidden(opened, view.lists[opened]) ? opened : null
  const fillId: SectionId = expanded ?? 'messages'
  const { fits, room } = fitLists(view, expanded, fillId)

  // 每个区块画成什么
  const drawn = SECTIONS.map((section): RenderElement | null => {
    const id = section.id
    const isFill = id === fillId
    if (!isList(id)) {
      const body = view.bodies[id]
      return frame(els, section, body, columns, isFill, `${section.icon} ${section.title}`, null)
    }
    const toggle = () => view.onToggle(id)
    const list = view.lists[id]
    if (isHidden(id, list)) return null
    if (expanded !== null && id !== expanded) return folded(els, section, list, columns, toggle)
    const isExpanded = id === expanded
    const title = `${isExpanded ? '▾ ' : ''}${section.icon} ${section.title}`
    if (!list) return frame(els, section, undefined, columns, isFill, title, toggle)
    const fitted = fits.get(id) ?? { start: 0, end: list.items.length }
    const status = isExpanded ? [...list.status, { text: ` · 按 ${section.hotkey} 收起` }] : list.status
    // 我的消息收起时占满剩余高度：按 room 收紧，不把身份栏挤出去
    const squeezed = isFill && !isExpanded && list.limit === 'fill' ? room : undefined
    const body = { status, rows: listRows(els, section, list, fitted, inner, isExpanded, toggle, squeezed) }
    return frame(els, section, body, columns, isFill, title, toggle)
  })

  // 框与框之间是一道细槽（中间略亮、两端隐去的刻痕，不是第三条横线，anvil-k0t.47）；主会话回复中细槽跟着呼吸。
  // 没画的区块不留细槽
  const motion = view.motion ?? { live: still(0), reply: null }
  const spaced = drawn.flatMap((one, index) => {
    if (one === null) return []
    const gap = rail(els, motion.live, { key: `rail:${SECTIONS[index]?.id}`, columns, span: motion.reply })
    return [
      <Box key={`gap:${SECTIONS[index]?.id}`} width={columns} height={1} flexShrink={0}>
        {gap}
      </Box>,
      one,
    ]
  })
  return (
    <Box flexDirection="column" width={columns} minHeight={view.rows}>
      {spaced.slice(1)}
      {view.identity ?? []}
    </Box>
  )
}
