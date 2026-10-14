// 子 agent 列表（spec D8）：序号、状态、任务、模型、耗时；按序号键展开详情（任务、执行、最近调用、回答）。
// 数据来源照 flightdeck（hooks/register.tsx 的 agent.spawn、turn.step、tool.call、turn.complete 和
// core.ts 的 applyStep、noteTool），MIT License, Copyright (c) 2026 Stephen Casella。
// 偏离：回答只取 turn.complete 的 answer，不解析 SubagentHandback 和 <agent-message>（spec Reference comparison）；
// 状态只有四种，被中断的（aborted）算出错。
// 只放不碰 `$` 的纯逻辑和界面组件；事件接线和读写状态在 register.ts。

import type { Elements, RenderElement, TurnCompleteReason, TurnUsage } from 'claude-code'

import type { AgentCall, AgentStatus, SubAgent } from '../types'
import { formatDuration } from './cache'
import { clock, glowText, spin, still, toCells } from './live'
import type { Live } from './live'
import { LIGHT } from './motion'
import type { ListBody, ListItem } from './panel'
import { COLOR, SEPARATOR } from './style'
import type { Segment } from './style'
import { cells, fit, padEnd, padStart, wrap } from './text'
import { formatTokens } from './usage'

/** 收起时最多显示几个（设计稿：三行） */
export const AGENT_LIMIT = 3

/** 存多少个；更早的丢掉，序号照旧往上数 */
const KEEP = 100

/** 存下的回答、任务原文的长度上限 */
const ANSWER_CHARS = 400
const PROMPT_CHARS = 600

// ---------------------------------------------------------------- 数据

export type Spawned = { id: string; description: string; prompt: string; model: string; at: number }

export function spawnAgent(list: readonly SubAgent[], spawned: Spawned): SubAgent[] {
  const agent: SubAgent = {
    id: spawned.id,
    seq: (list.at(-1)?.seq ?? 0) + 1,
    description: spawned.description.replace(/\s+/g, ' ').trim(),
    prompt: spawned.prompt.slice(0, PROMPT_CHARS),
    model: spawned.model,
    status: 'running',
    spawnedAt: spawned.at,
    endedAt: null,
    steps: 0,
    context: 0,
    output: 0,
    lastStop: null,
    calls: [],
    answer: '',
  }
  return [...list, agent].slice(-KEEP)
}

const change = (list: readonly SubAgent[], id: string, edit: (agent: SubAgent) => SubAgent) =>
  list.map(agent => (agent.id === id ? edit(agent) : agent))

/** 一次请求结束：上下文取这一次的整段输入，输出累加（flightdeck 的 applyStep） */
export function stepAgent(
  list: readonly SubAgent[],
  id: string,
  step: { model: string; usage?: TurnUsage | null; stopReason: string | null },
): SubAgent[] {
  return change(list, id, agent => {
    const usage = step.usage
    const context = usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0
    return {
      ...agent,
      model: agent.model || step.model,
      steps: agent.steps + 1,
      context: context > 0 ? context : agent.context,
      output: agent.output + (usage?.output_tokens ?? 0),
      lastStop: step.stopReason,
    }
  })
}

/** 一次工具调用结束：只留最近三次 */
export function callAgent(list: readonly SubAgent[], id: string, call: AgentCall): SubAgent[] {
  return change(list, id, agent => ({ ...agent, calls: [...agent.calls, call].slice(-3) }))
}

/** 一轮结束就是这个子 agent 结束：回答了是已完成（最后一次请求停在 max_tokens 算输出被截断），其余算出错 */
export function completeAgent(
  list: readonly SubAgent[],
  id: string,
  end: { reason: TurnCompleteReason; answer: string; at: number },
): SubAgent[] {
  return change(list, id, agent => {
    const status: AgentStatus = end.reason !== 'answer' ? 'failed' : agent.lastStop === 'max_tokens' ? 'truncated' : 'done'
    return { ...agent, status, endedAt: end.at, answer: end.answer.replace(/\s+/g, ' ').trim().slice(0, ANSWER_CHARS) }
  })
}

// ---------------------------------------------------------------- 文字

/** 列表里只写模型系列（设计稿的 6 格一列）：Haiku、Sonnet、Opus；不认识的原样截短 */
export function modelName(id: string): string {
  const family = /(opus|sonnet|haiku|fable)/i.exec(id)?.[1]
  if (family) return family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  return fit(id || '—', 6)
}

/** 运行中的算到现在，结束的算到结束 */
export const elapsed = (agent: SubAgent, now: number) => formatDuration((agent.endedAt ?? now) - agent.spawnedAt)

/**
 * 右上角："2 运行中 · 1 已完成 · 1 出错"，输出被截断算已完成；没有子 agent 时"0 个"。
 * 计数是次要色（框给的颜色），只有出问题的"N 出错"升到红
 */
export function agentCounts(list: readonly SubAgent[]): Segment[] {
  const running = list.filter(agent => agent.status === 'running').length
  const done = list.filter(agent => agent.status === 'done' || agent.status === 'truncated').length
  const failed = list.filter(agent => agent.status === 'failed').length
  const parts: Segment[] = [
    ...(running > 0 ? [{ text: `${running} 运行中` }] : []),
    ...(done > 0 ? [{ text: `${done} 已完成` }] : []),
    ...(failed > 0 ? [{ text: `${failed} 出错`, color: COLOR.danger }] : []),
  ]
  if (parts.length === 0) return [{ text: '0 个' }]
  return parts.flatMap((part, index) => (index === 0 ? [part] : [SEPARATOR, part]))
}

/** 状态符号和颜色：状态都配符号或文字，不只靠颜色（D10） */
const MARK: Record<AgentStatus, Segment> = {
  running: { text: '◐', color: COLOR.active },
  done: { text: '\u{F00C}', color: COLOR.ok },
  truncated: { text: '\u{F00C}', color: COLOR.ok },
  failed: { text: '\u{F00D}', color: COLOR.danger },
}

const TRUNCATED = '输出被截断'

// ---------------------------------------------------------------- 绘制

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'> & Partial<Pick<Elements['terminal'], 'Client'>>

/** 一行的列宽（设计稿 .ag）：序号 2 | 状态 2 | 任务 | 模型 6 | 耗时 6，列间空 1 格；状态列从第 3 格起（序号加列间） */
const COLUMN = { seq: 2, mark: 2, model: 6, time: 6, gap: 1 } as const

/** 框的边框加内边距：框里的第一格在面板的第 2 列 */
const FRAME = 2

/** 任务一列从框里的第几格起：序号、列间、状态、列间 */
const TASK_AT = COLUMN.seq + COLUMN.gap + COLUMN.mark + COLUMN.gap

/** 任务一列的宽度 */
export const taskWidth = (inner: number) =>
  Math.max(4, inner - COLUMN.seq - COLUMN.mark - COLUMN.model - COLUMN.time - 4 * COLUMN.gap)

/** 详情的列宽（设计稿 .dt）：左边空 6 格，标签 8 格，空 1 格，其余是内容 */
const DETAIL = { indent: 6, label: 8, gap: 1 } as const

/** 任务原文在详情里最多占几行 */
const PROMPT_LINES = 3

/** 一个子 agent 那一行的 Button 的 key：按键、焦点（ui.focus 的 element）都认它 */
export const agentKey = (seq: number) => `agent:${seq}`

/** 一行里的几段文字 */
function texts(els: Els, segments: readonly Segment[]) {
  const { Text } = els
  return segments.map(segment => (
    <Text color={segment.color} bold={segment.bold}>
      {segment.text}
    </Text>
  ))
}

/**
 * 一个子 agent 的那一行：整行是一个 Button，焦点移上去反白，Enter 或序号键展开详情。
 * 序号 1–9 交给 hotkey：引擎把它画成"1: "，正好占序号一列和列间的空格；10 以后没有按键，自己画序号。
 * 运行中的那项，状态列的 ◐ 转动、耗时每秒走（spec D10）：Button 里只能放字（AGENTS.md Pitfalls），
 * 转动的图标和走的耗时是 Client，绝对定位压在 Button 那两格上；Button 里照样写静止的 ◐ 和按 now 算的耗时，
 * 没有 Client 时就是它们。焦点在这一行时引擎只反白 Button 自己的字，压在上面的两块跟着反白（isFocused）。
 */
function agentRow(els: Els, agent: SubAgent, now: number, inner: number, onPress: () => void, live: Live, isFocused: boolean, row: number): RenderElement {
  const { Box, Button } = els
  const isOver = agent.status !== 'running'
  const width = taskWidth(inner)
  const note = agent.status === 'truncated' ? ` ${TRUNCATED}` : ''
  const task = fit(agent.description || '子 agent', Math.max(1, width - cells(note)))
  // 正在发生的亮，做完的退后，出问题的不退（anvil-k0t.46）：已完成的任务和耗时退到次要色，出错、被截断的任务留正文色
  const recede = agent.status === 'done' ? { color: COLOR.secondary } : {}
  const segments: Segment[] = [
    // 10 以后没有按键，序号和我的消息的序号一样是次要色
    ...(agent.seq > 9 ? [{ text: `${padStart(String(agent.seq), COLUMN.seq)} `, color: COLOR.secondary }] : []),
    { ...MARK[agent.status], text: padEnd(MARK[agent.status].text, COLUMN.mark + COLUMN.gap) },
    { text: task, ...recede },
    ...(note ? [{ text: note, color: COLOR.warn }] : []),
    { text: ' '.repeat(Math.max(0, width - cells(task) - cells(note)) + COLUMN.gap) },
    { text: padStart(modelName(agent.model), COLUMN.model), color: COLOR.secondary },
    { text: ' '.repeat(COLUMN.gap) },
    { text: padStart(elapsed(agent, now), COLUMN.time), ...(isOver ? { color: COLOR.secondary } : {}) },
  ]
  const hotkey = agent.seq <= 9 ? String(agent.seq) : undefined
  const isRunning = agent.status === 'running'
  return (
    <Box key={`row:agent:${agent.id}`} width={inner} flexShrink={0}>
      <Button key={agentKey(agent.seq)} label={agent.description || `子 agent ${agent.seq}`} plain hotkey={hotkey} onPress={onPress}>
        {texts(els, segments)}
      </Button>
      {isRunning && live.spinner ? (
        <Box key={`over:mark:${agent.id}`} position="absolute" top={0} left={COLUMN.seq + COLUMN.gap}>
          {spin(els, live, { key: `spin:agent:${agent.id}`, place: { row, x: FRAME + COLUMN.seq + COLUMN.gap, width: inner + 2 * FRAME }, inverse: isFocused })}
        </Box>
      ) : null}
      {isRunning && live.glow ? (
        <Box key={`over:task:${agent.id}`} position="absolute" top={0} left={TASK_AT}>
          {glowText(els, live, {
            key: `glow:agent:${agent.id}`,
            cells: toCells(task),
            place: { row, x: FRAME + TASK_AT, width: inner + 2 * FRAME },
            span: { since: agent.spawnedAt, until: null },
            mode: 'shimmer',
            shine: LIGHT.shine,
            inverse: isFocused,
          })}
        </Box>
      ) : null}
      {isRunning && live.elapsed ? (
        <Box key={`over:time:${agent.id}`} position="absolute" top={0} left={inner - COLUMN.time}>
          {clock(els, live, { key: `clock:agent:${agent.id}`, since: agent.spawnedAt, endAt: null, width: COLUMN.time, inverse: isFocused })}
        </Box>
      ) : null}
    </Box>
  )
}

/** 详情的一行：标签 | 内容 */
function detailRow(els: Els, key: string, label: string, content: readonly Segment[], inner: number): RenderElement {
  const { Box, Text } = els
  const rest = Math.max(1, inner - DETAIL.indent - DETAIL.label - DETAIL.gap)
  return (
    <Box key={key} width={inner} flexShrink={0} paddingLeft={DETAIL.indent} columnGap={DETAIL.gap}>
      <Box width={DETAIL.label} flexShrink={0}>
        <Text color={COLOR.secondary}>{label}</Text>
      </Box>
      <Box width={rest} flexShrink={0}>
        <Text wrap="truncate">{texts(els, content)}</Text>
      </Box>
    </Box>
  )
}

/** 展开的详情：任务、执行、最近调用、回答（设计稿"按序号展开一个子 agent"） */
export function agentDetail(els: Els, agent: SubAgent, inner: number): RenderElement[] {
  const rest = Math.max(1, inner - DETAIL.indent - DETAIL.label - DETAIL.gap)
  const id = agent.id
  const prompt = wrap(agent.prompt || agent.description, rest, PROMPT_LINES)
  const rows = prompt.map((line, index) => detailRow(els, `detail:${id}:task:${index}`, index === 0 ? '任务' : '', [{ text: line }], inner))
  rows.push(
    detailRow(els, `detail:${id}:run`, '执行', [
      { text: `${agent.steps} 步` },
      SEPARATOR,
      { text: '上下文 ', color: COLOR.secondary },
      { text: formatTokens(agent.context) },
      SEPARATOR,
      { text: '输出 ', color: COLOR.secondary },
      { text: formatTokens(agent.output) },
    ], inner),
  )
  const calls = agent.calls.length > 0 ? agent.calls : null
  if (calls) {
    calls.forEach((call, index) => {
      const head = { text: call.tool, bold: true, color: call.isError ? COLOR.danger : undefined }
      const what = call.text ? [{ text: ` ${fit(call.text, Math.max(1, rest - cells(call.tool) - 1))}`, color: COLOR.secondary }] : []
      rows.push(detailRow(els, `detail:${id}:call:${index}`, index === 0 ? '最近调用' : '', [head, ...what], inner))
    })
  } else {
    rows.push(detailRow(els, `detail:${id}:call:0`, '最近调用', [{ text: '—', color: COLOR.secondary }], inner))
  }
  const answer = agent.answer ? fit(agent.answer, rest) : '—'
  rows.push(detailRow(els, `detail:${id}:answer`, '回答', [{ text: answer, color: agent.answer ? undefined : COLOR.secondary }], inner))
  return rows
}

/** 交给面板的子 agent 列表：每个子 agent 一项，展开详情的那项多几行 */
export function agentList(
  els: Els,
  list: readonly SubAgent[],
  view: { detail: string | null; now: number; inner: number; onPress: (agentId: string) => void; live?: Live; focused?: string | null; top?: number },
): ListBody {
  const live = view.live ?? still(view.now)
  // 列表在面板里大约从第几行起（register.ts 按上面几个框的高度算）：光按它算出发的先后
  const top = view.top ?? 0
  const shown = Math.max(0, list.length - AGENT_LIMIT)
  const items: ListItem[] = list.map((agent, index) => ({
    key: agent.id,
    rows: [
      agentRow(els, agent, view.now, view.inner, () => view.onPress(agent.id), live, view.focused === agentKey(agent.seq), top + (shown > 0 ? 1 : 0) + Math.max(0, index - shown)),
      ...(view.detail === agent.id ? agentDetail(els, agent, view.inner) : []),
    ],
  }))
  return { status: agentCounts(list), unit: '个', lead: COLUMN.seq, items, limit: AGENT_LIMIT, empty: '本会话还没有子 agent' }
}
