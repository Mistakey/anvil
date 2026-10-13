// 自动模式拒绝列表（spec D8）：时间、工具、命令或路径摘要（遮掉密钥）；选中后显示完整内容和来源
// （主会话，或子 agent 及第几步）。
// 数据取自 `classic.PermissionDenied`：它只在自动模式的分类器拒绝时触发。flightdeck 从 tool.check 的
// deny 和 tool.call 的 deny 取拒绝，那样会混进用户手动拒绝和规则拒绝，这里不照搬。
// 遮密钥照 flightdeck（见 describe.ts）。只放不碰 `$` 的纯逻辑和界面组件；事件接线和读写状态在 register.ts。

import type { Elements, RenderElement } from 'claude-code'

import type { Denial, DenialSource, SubAgent } from '../types'
import type { ListBody, ListItem } from './panel'
import { COLOR } from './style'
import { describeInput, redact } from './describe'
import { cells, fit, padEnd, wrap } from './text'

/** 收起时最多显示几条（设计稿：两行） */
export const DENIAL_LIMIT = 2

/** 存多少条；更早的丢掉 */
const KEEP = 200

/** 完整内容在详情里最多占几行 */
const TEXT_LINES = 12

// ---------------------------------------------------------------- 数据

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 完整内容：命令、路径、网址原样（遮掉密钥），其余工具的参数写成 JSON */
export function denialContent(input: unknown): Pick<Denial, 'kind' | 'text'> {
  const fields = isObject(input) ? input : {}
  const pick = (...names: string[]) => names.map(name => fields[name]).find((value): value is string => typeof value === 'string')
  const command = pick('command')
  if (command !== undefined) return { kind: 'command', text: redact(command) }
  const path = pick('file_path', 'notebook_path', 'path')
  if (path !== undefined) return { kind: 'path', text: redact(path) }
  const url = pick('url')
  if (url !== undefined) return { kind: 'url', text: redact(url) }
  let json = ''
  try {
    json = JSON.stringify(input) ?? ''
  } catch {
    json = describeInput(input)
  }
  return { kind: 'input', text: redact(json) }
}

/** 拒绝发生在哪：主会话；子 agent 取列表里的序号、任务和已记到的请求次数 */
export function denialSource(agentId: string | undefined, agentType: string | undefined, agents: readonly SubAgent[]): DenialSource {
  if (!agentId) return { kind: 'main' }
  const agent = agents.find(one => one.id === agentId)
  if (!agent) return { kind: 'agent', seq: null, description: agentType ?? '', step: null }
  return { kind: 'agent', seq: agent.seq, description: agent.description, step: agent.steps > 0 ? agent.steps : null }
}

/** 记下一条；同一个 tool_use_id 只记一次 */
export function addDenial(list: readonly Denial[], denial: Denial): Denial[] {
  if (list.some(one => one.id === denial.id)) return [...list]
  return [...list, denial].slice(-KEEP)
}

// ---------------------------------------------------------------- 文字

const two = (n: number) => String(n).padStart(2, '0')

/** 本地时刻 HH:MM */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** 列表里那一列的摘要：空白压成一个空格 */
export const summary = (denial: Denial) => denial.text.replace(/\s+/g, ' ').trim()

/** 路径放不下时留开头一段和尽量多的结尾几段，中间写 `…`（设计稿 `C:\…\claude.exe`） */
export function fitPath(path: string, width: number): string {
  if (cells(path) <= width) return path
  const parts = path.split(/(?<=[\\/])/)
  const head = parts[0] ?? ''
  let tail = ''
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const next = (parts[index] ?? '') + tail
    if (cells(head) + 1 + cells(next) > width) break
    tail = next
  }
  if (tail === '') return fit(path, width)
  const slash = head.includes('\\') ? '\\' : '/'
  const joined = `${head}…${slash}${tail}`
  return cells(joined) <= width ? joined : fit(path, width)
}

const KIND_LABEL: Record<Denial['kind'], string> = { command: '命令', path: '路径', url: '网址', input: '参数' }

/** 来源那一行："主会话"，或"子 agent 2「调研 Spinner 首字时刻」第 6 步" */
export function sourceText(source: DenialSource): string {
  if (source.kind === 'main') return '主会话'
  const seq = source.seq === null ? '' : ` ${source.seq}`
  const task = source.description ? `「${source.description}」` : ''
  const step = source.step === null ? '' : `${task ? '' : ' '}第 ${source.step} 步`
  return `子 agent${seq}${task}${step}`
}

/** 右上角："23 条" */
export const denialCount = (list: readonly Denial[]) => [{ text: `${list.length} 条` }]

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** 一行的列宽（设计稿 .dn）：时间 5 | 工具 5 | 摘要，列间空 1 格 */
const COLUMN = { time: 5, tool: 5, gap: 1 } as const

/** 摘要一列的宽度 */
export const summaryWidth = (inner: number) => Math.max(4, inner - COLUMN.time - COLUMN.tool - 2 * COLUMN.gap)

/** 详情的列宽（设计稿）：左边空到摘要那一列，标签 4 格，空 1 格，其余是内容 */
const DETAIL = { indent: COLUMN.time + COLUMN.tool + 2 * COLUMN.gap, label: 4, gap: 1 } as const

/** 一条拒绝的那一行：整行是一个 Button，焦点移上去反白，Enter 展开详情 */
function denialRow(els: Els, denial: Denial, inner: number, onPress: () => void): RenderElement {
  const { Box, Button, Text } = els
  const width = summaryWidth(inner)
  const text = denial.kind === 'path' ? fitPath(summary(denial), width) : fit(summary(denial), width)
  return (
    <Box key={`row:denial:${denial.id}`} width={inner} flexShrink={0}>
      <Button key={`denial:${denial.id}`} label={`${denial.tool} ${text}`} plain onPress={onPress}>
        <Text color={COLOR.dim}>{padEnd(clockTime(denial.at), COLUMN.time + COLUMN.gap)}</Text>
        <Text bold>{padEnd(fit(denial.tool, COLUMN.tool), COLUMN.tool + COLUMN.gap)}</Text>
        <Text color={COLOR.muted}>{text}</Text>
      </Button>
    </Box>
  )
}

/** 详情的一行：标签 | 内容 */
function detailRow(els: Els, key: string, label: string, content: string, inner: number): RenderElement {
  const { Box, Text } = els
  const rest = Math.max(1, inner - DETAIL.indent - DETAIL.label - DETAIL.gap)
  return (
    <Box key={key} width={inner} flexShrink={0} paddingLeft={DETAIL.indent} columnGap={DETAIL.gap}>
      <Box width={DETAIL.label} flexShrink={0}>
        <Text color={COLOR.muted}>{label}</Text>
      </Box>
      <Box width={rest} flexShrink={0}>
        <Text wrap="truncate">{content}</Text>
      </Box>
    </Box>
  )
}

/** 展开的详情：完整内容（折行）和来源（设计稿"展开自动模式拒绝"） */
export function denialDetail(els: Els, denial: Denial, inner: number): RenderElement[] {
  const rest = Math.max(1, inner - DETAIL.indent - DETAIL.label - DETAIL.gap)
  const lines = wrap(denial.text, rest, TEXT_LINES)
  const rows = (lines.length > 0 ? lines : ['—']).map((line, index) =>
    detailRow(els, `detail:denial:${denial.id}:text:${index}`, index === 0 ? KIND_LABEL[denial.kind] : '', line, inner),
  )
  const source = wrap(sourceText(denial.source), rest, 2)
  source.forEach((line, index) => rows.push(detailRow(els, `detail:denial:${denial.id}:source:${index}`, index === 0 ? '来源' : '', line, inner)))
  return rows
}

/** 详情在面板展开状态里的 id：和子 agent 的共用一个位置，同时只展开一项 */
export const denialDetailId = (denial: Denial) => `denial:${denial.id}`

/** 交给面板的自动模式拒绝列表：每条一项，展开详情的那条多几行 */
export function denialList(
  els: Els,
  list: readonly Denial[],
  view: { detail: string | null; inner: number; onPress: (detailId: string) => void },
): ListBody {
  const items: ListItem[] = list.map(denial => ({
    key: denial.id,
    rows: [
      denialRow(els, denial, view.inner, () => view.onPress(denialDetailId(denial))),
      ...(view.detail === denialDetailId(denial) ? denialDetail(els, denial, view.inner) : []),
    ],
  }))
  return { status: denialCount(list), unit: '条', lead: COLUMN.time, items, limit: DENIAL_LIMIT, empty: '本会话还没有自动模式拒绝' }
}
