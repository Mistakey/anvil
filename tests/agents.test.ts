import type { On, ToolCallInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { agentCounts, completeAgent, modelName, spawnAgent, stepAgent } from '../hooks/agents'
import { describeInput, redact } from '../hooks/describe'
import { CLOSED, earlierText, fitCount, fitRows, scrollList, toggleDetail, toggleList } from '../hooks/list'
import { cells, wrap } from '../hooks/text'
import { SESSION, drain, spawnInput, stepInput, turnInput, usage, world } from './world'

const NOW = 10 * 3_600_000

// ---------------------------------------------------------------- 纯逻辑

test('列表按条数截：收起时只留最新的几条，截掉的就是"更早的"条数', () => {
  expect(fitCount(5, 3)).toEqual({ start: 2, end: 5 })
  expect(fitCount(2, 3)).toEqual({ start: 0, end: 2 })
})

test('列表按行数截：从下往上放，放不下时顶部留一行写更早的条数；滚动后露出更早的', () => {
  // 六条各一行，能放四行：顶部一行"更早的 3 条"，下面最新的三条
  expect(fitRows([1, 1, 1, 1, 1, 1], 4)).toEqual({ start: 3, end: 6 })
  // 都放得下就不留那一行
  expect(fitRows([1, 1, 1], 4)).toEqual({ start: 0, end: 3 })
  // 展开详情的那条占四行
  expect(fitRows([1, 1, 4, 1], 5)).toEqual({ start: 3, end: 4 })
  expect(fitRows([1, 1, 4, 1], 6)).toEqual({ start: 2, end: 4 })
  // 往上滚一条：最新的一条藏到下面
  expect(fitRows([1, 1, 1, 1, 1, 1], 4, 1)).toEqual({ start: 2, end: 5 })
  // 滚过头：上面全放下了，下面补回较新的
  expect(fitRows([1, 1, 1, 1, 1, 1], 4, 5)).toEqual({ start: 0, end: 4 })
  // 一条比整个框还高也照样画出来
  expect(fitRows([9], 4)).toEqual({ start: 0, end: 1 })
})

test('"更早的"那行：收起时写展开键，展开后写滚动查看', () => {
  expect(earlierText(2, '个', 'a', false)).toBe('更早的 2 个 · 按 a 展开')
  expect(earlierText(6, '条', 'd', true)).toBe('更早的 6 条 · 向上滚动查看')
})

test('a / d / m 展开一个列表、再按收起；序号键展开一个子 agent 的详情、再按收起', () => {
  const agentsOpen = toggleList(CLOSED, 'agents')
  expect(agentsOpen.expanded).toBe('agents')
  expect(toggleList(agentsOpen, 'denials').expanded).toBe('denials')
  expect(toggleList(agentsOpen, 'agents').expanded).toBe(null)

  const detail = toggleDetail(CLOSED, 'ag2')
  expect(detail.detail).toBe('ag2')
  expect(toggleDetail(detail, 'ag3').detail).toBe('ag3')
  expect(toggleDetail(detail, 'ag2').detail).toBe(null)
})

test('展开的列表滚动：负数朝上看更早的，不滚到负数，最多滚到最早一条；没展开时不动', () => {
  const open = toggleList(CLOSED, 'agents')
  expect(scrollList(open, -1, 10).scrolled).toBe(1)
  expect(scrollList(scrollList(open, -3, 10), 1, 10).scrolled).toBe(2)
  expect(scrollList(open, 5, 10).scrolled).toBe(0)
  expect(scrollList(open, -50, 10).scrolled).toBe(9)
  expect(scrollList(CLOSED, -1, 10)).toBe(CLOSED)
})

test('子 agent 的四种状态：运行中、已完成、出错（含被中断）、输出被截断', () => {
  const at = NOW
  let list = spawnAgent([], { id: 'a', description: '甲', prompt: '', model: 'claude-haiku-5-5', at })
  for (const id of ['b', 'c', 'd', 'e']) list = spawnAgent(list, { id, description: id, prompt: '', model: 'claude-sonnet-5-5', at })
  expect(list.map(agent => agent.seq)).toEqual([1, 2, 3, 4, 5])

  list = completeAgent(list, 'b', { reason: 'answer', answer: '好了', at })
  list = completeAgent(list, 'c', { reason: 'error', answer: '', at })
  list = completeAgent(list, 'd', { reason: 'aborted', answer: '', at })
  list = stepAgent(list, 'e', { model: 'claude-sonnet-5-5', usage: usage(), stopReason: 'max_tokens' })
  list = completeAgent(list, 'e', { reason: 'answer', answer: '写到一半', at })
  expect(list.map(agent => agent.status)).toEqual(['running', 'done', 'failed', 'failed', 'truncated'])
  expect(agentCounts(list).map(one => one.text).join('')).toBe('1 运行中 · 2 已完成 · 2 出错')
  expect(agentCounts([]).map(one => one.text).join('')).toBe('0 个')
})

test('模型只写系列名；调用摘要遮掉密钥、路径取最后两段', () => {
  expect(modelName('claude-haiku-5-5')).toBe('Haiku')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus')
  expect(modelName('gpt-oss-120b')).toBe('gpt-o…')
  expect(describeInput({ command: 'curl -H "Authorization: Bearer abcdefgh12345" api' })).not.toContain('abcdefgh12345')
  expect(describeInput({ file_path: 'C:\\work\\anvil\\hooks\\panel.tsx' })).toBe('hooks/panel.tsx')
  expect(redact('export OPENAI_API_KEY=sk-proj-1234567890abcdef')).not.toContain('1234567890')
})

test('任务原文按格子折行，超出行数时末尾写省略号', () => {
  expect(wrap('查清 Spinner 从 requesting 切换到 responding 的时刻', 20, 3)).toEqual(['查清 Spinner 从', 'requesting 切换到', 'responding 的时刻'])
  const cut = wrap('一二三四五六七八九十'.repeat(3), 10, 2)
  expect(cut).toHaveLength(2)
  expect(cut[1]?.endsWith('…')).toBe(true)
  for (const line of cut) expect(cells(line)).toBeLessThanOrEqual(10)
})

// ---------------------------------------------------------------- 事件接线与绘制

const pane = (isFocused: boolean, bodyRows = 48) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: {
    title: 'anvil',
    isFocused,
    bodyColumns: 70,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const stop = { reason: 'end_turn' }
  world(on, { stop })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  return { clock, stop }
}

/** 画出来的一个元素里所有的字，按文档顺序 */
function flat(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flat).join('')
  if (node !== null && typeof node === 'object') {
    const { children, props } = node as { children?: unknown; props?: { children?: unknown } }
    return flat(children ?? props?.children ?? [])
  }
  return ''
}

const call = (agentId: string, command: string): ToolCallInput => ({ tool: 'Bash', command, tool_use_id: `c-${command}`, agentId }) as ToolCallInput

/** 五个子 agent，四种状态都有：1 已完成、2 出错、3 已完成、4 输出被截断、5 运行中 */
async function fiveAgents($: Engine, clock: { advance: (ms: number) => Promise<void> }, stop: { reason: string }) {
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对面板拖动宽度', { model: 'claude-haiku-5-5' }))
  await $.agent.spawn(spawnInput('调研消息行定位'))
  await $.agent.spawn(spawnInput('核对缓存读数'))
  await $.agent.spawn(spawnInput('整理按键说明'))
  await $.agent.spawn(spawnInput('调研 Spinner 首字时刻'))

  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  await $.tool.call(call('ag1', 'git status'))
  await clock.advance(47_000)
  await $.turn.complete(turnInput({ agentId: 'ag1', answer: '拖动后的宽度会保留' }))
  await $.turn.complete(turnInput({ agentId: 'ag2', reason: 'error', answer: '' }))
  await $.turn.complete(turnInput({ agentId: 'ag3', answer: '读数一致' }))
  stop.reason = 'max_tokens'
  await drain($.turn.step(stepInput({ agentId: 'ag4' })))
  stop.reason = 'end_turn'
  await $.turn.complete(turnInput({ agentId: 'ag4', answer: '写到一半' }))
  await drain($.turn.step(stepInput({ agentId: 'ag5' })))
  await $.tool.call(call('ag5', 'export API_TOKEN=supersecret123 && claude --plugin-dir probe'))
  await $.tool.call(call('ag5', 'grep requesting index.d.ts'))
  await clock.advance(114_000)
}

test('子 agent 列表：四种状态各自的符号和文字，右上角计数，超出上限时顶部写更早的个数', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)

  const ui = await $.ui.mount(pane(false))
  const box = flat(await ui.find({ key: 'section:agents' }))
  expect(box).toContain('1 运行中 · 3 已完成 · 1 出错')
  expect(flat(await ui.find({ key: 'row:earlier:agents' }))).toBe(' ▴ 更早的 2 个 · 按 a 展开')
  // 收起时只留最新的三个
  expect(await ui.find({ key: 'agent:2' })).toBeUndefined()
  const third = flat(await ui.find({ key: 'agent:3' }))
  expect(third).toMatch(/^\u{F00C} +核对缓存读数 +Sonnet +\S+$/u)
  const fourth = flat(await ui.find({ key: 'agent:4' }))
  expect(fourth).toContain('整理按键说明 输出被截断')
  const fifth = flat(await ui.find({ key: 'agent:5' }))
  expect(fifth).toMatch(/^◐ +调研 Spinner 首字时刻 +Sonnet +2m41s$/)
  // 一行正好占满框内宽度：引擎画的"5: "加上这行
  expect(cells(fifth) + 3).toBe(70 - 4)
  await ui.unmount()
})

test('按 a 展开子 agent 列表：全部显示，其余两个列表收成一行；再按 a 收起', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: 'list:agents' })
  const second = flat(await ui.find({ key: 'agent:2' }))
  expect(second).toMatch(/^\u{F00D} +调研消息行定位/u)
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/核对面板拖动宽度 +Haiku +47s$/)
  expect(await ui.find({ key: 'row:earlier:agents' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'section:agents' }))).toContain('按 a 收起')
  // 我的消息、自动模式拒绝各收成一行（不再是框），用量、缓存不变
  const messages = await ui.find({ key: 'section:messages' })
  expect(messages?.props.borderStyle).toBeUndefined()
  expect(await ui.find({ key: 'box:messages' })).toBeUndefined()
  expect(flat(messages)).toMatch(/^▸ \S+ 我的消息 ─+$/)
  expect(flat(await ui.find({ key: 'section:denials' }))).toMatch(/^▸ \S+ 自动模式拒绝 ─+$/)
  expect((await ui.find({ key: 'box:usage' }))?.props.borderStyle).toBe('round')

  await ui.press({ key: 'list:agents' })
  expect(await ui.find({ key: 'agent:2' })).toBeUndefined()
  expect((await ui.find({ key: 'box:messages' }))?.props.borderStyle).toBe('round')
  await ui.unmount()
})

test('按 d / m 展开另外两个列表时，子 agent 列表收成一行，计数还在', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: 'list:denials' })
  expect(flat(await ui.find({ key: 'section:agents' }))).toMatch(/^▸ \S+ 子 agent ─+ 1 运行中 · 3 已完成 · 1 出错$/)
  await ui.press({ key: 'list:messages' })
  expect(flat(await ui.find({ key: 'section:denials' }))).toMatch(/^▸ \S+ 自动模式拒绝 ─+$/)
  expect(await ui.find({ key: 'agent:5' })).toBeUndefined()
  await ui.unmount()
})

test('按序号键展开一个子 agent 的详情：任务、执行、最近调用（密钥已遮）、回答；再按收起', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: 'agent:5' })
  expect(flat(await ui.find({ key: 'detail:ag5:task:0' }))).toBe('任务调研 Spinner 首字时刻：详细说明')
  expect(flat(await ui.find({ key: 'detail:ag5:run' }))).toBe('执行1 步 · 上下文 151k · 输出 1k')
  const calls = [flat(await ui.find({ key: 'detail:ag5:call:0' })), flat(await ui.find({ key: 'detail:ag5:call:1' }))]
  expect(calls[0]).toContain('最近调用Bash export API_TOKEN=•••')
  expect(calls[0]).not.toContain('supersecret123')
  expect(calls[1]).toBe('Bash grep requesting index.d.ts')
  expect(flat(await ui.find({ key: 'detail:ag5:answer' }))).toBe('回答—')

  // 换一个：回答取 turn.complete 的 answer
  await ui.press({ key: 'agent:4' })
  expect(await ui.find({ key: 'detail:ag5:run' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'detail:ag4:answer' }))).toBe('回答写到一半')

  await ui.press({ key: 'agent:4' })
  expect(await ui.find({ key: 'detail:ag4:answer' })).toBeUndefined()
  await ui.unmount()
})

test('Esc 把焦点交回主输入框后全收起；再进面板也是收起的', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)

  const ui = await $.ui.mount(pane(true))
  await ui.press({ key: 'list:agents' })
  await ui.press({ key: 'agent:1' })
  expect(await ui.find({ key: 'detail:ag1:answer' })).toBeDefined()

  // Esc 不经过 mod：面板以失去焦点重画
  await ui.redraw(pane(false).props)
  await clock.advance(0)
  expect(await ui.find({ key: 'detail:ag1:answer' })).toBeUndefined()
  expect(await ui.find({ key: 'agent:1' }), '失焦后').toBeUndefined()
  expect((await ui.find({ key: 'box:messages' }))?.props.borderStyle).toBe('round')

  await ui.redraw(pane(true).props)
  expect(await ui.find({ key: 'agent:1' }), '再进面板').toBeUndefined()
  expect(await ui.find({ key: 'row:earlier:agents' })).toBeDefined()
  await ui.unmount()
})

test('展开的列表放不下时顶部写更早的个数和"向上滚动查看"', async ($, on) => {
  const { clock, stop } = engine(on)
  await fiveAgents($, clock, stop)
  for (let n = 0; n < 20; n += 1) await $.agent.spawn(spawnInput(`第 ${n + 6} 个`))

  // 面板只有 20 行：两个收成一行的列表、用量 6 行、缓存 2 行，剩下的放不下 25 个
  const ui = await $.ui.mount(pane(true, 20))
  await ui.press({ key: 'list:agents' })
  const earlier = flat(await ui.find({ key: 'row:earlier:agents' }))
  expect(earlier).toMatch(/^ ▴ 更早的 \d+ 个 · 向上滚动查看$/)
  // 最新的一个在最下面
  expect(await ui.find({ key: 'agent:25' })).toBeDefined()
  expect(await ui.find({ key: 'agent:1' })).toBeUndefined()
  await ui.unmount()
})

test('不在列表里的 agentId（引擎自己的 fork 等）的请求、调用和结束不出错也不进列表', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput({ agentId: 'fork-1' })))
  await $.tool.call(call('fork-1', 'ls'))
  await $.turn.complete(turnInput({ agentId: 'fork-1' }))

  const ui = await $.ui.mount(pane(false))
  expect(flat(await ui.find({ key: 'section:agents' }))).toContain('本会话还没有子 agent')
  expect(flat(await ui.find({ key: 'section:agents' }))).toContain('0 个')
  await ui.unmount()
})
