import type { ClassicEventOf, ModelCompleteResult, On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { faultedModule, liveOf } from '../hooks/live'
import { SPIN, clockOf, follow, spinGlyph, ticking } from '../hooks/motion'
import { PING_AFTER_MS } from '../hooks/keepalive'
import { COLOR, ICON } from '../hooks/style'
import { SESSION, drain, flat, spawnInput, stepInput, turnInput, world } from './world'

const NOW = 10 * 3_600_000

// ---------------------------------------------------------------- 纯逻辑（Client 模块共用，motion.ts）

test('转动图标：◐◓◑◒ 轮流，150ms 一格；第 n 帧按时钟算', () => {
  expect(SPIN.stepMs).toBe(150)
  expect([0, 150, 300, 450, 600].map(spinGlyph)).toEqual(['◐', '◓', '◑', '◒', '◐'])
  expect(spinGlyph(149)).toBe('◐')
  for (const n of [5, 6, 7, 1001]) expect(spinGlyph(n * SPIN.stepMs + 60), `第 ${n} 帧`).toBe(SPIN.frames[n % 4])
})

test('相位按时钟算：同一时刻几个图标同一格；钩子给了新的 now 就从它重新数，帧时钟的计时也重新起', () => {
  const timers: string[] = []
  const every = (ms: number) => {
    const id = `t${timers.length + 1}:${ms}`
    timers.push(id)
    return () => void timers.splice(timers.indexOf(id), 1, `${id} 停`)
  }
  const a = ticking(NOW)
  const b = ticking(NOW)
  follow(a, NOW, every, SPIN.stepMs, () => undefined)
  follow(b, NOW, every, SPIN.stepMs, () => undefined)
  expect(timers).toEqual(['t1:150', 't2:150'])
  a.ticks = 3
  b.ticks = 3
  expect(clockOf(a, SPIN.stepMs)).toBe(NOW + 3 * SPIN.stepMs)
  expect(spinGlyph(clockOf(a, SPIN.stepMs))).toBe(spinGlyph(clockOf(b, SPIN.stepMs)))
  // 同一个 now：不重数，也不重起计时
  follow(a, NOW, every, SPIN.stepMs, () => undefined)
  expect(a.ticks).toBe(3)
  expect(timers).toHaveLength(2)
  // 新的 now：从它重新数，旧的计时停掉、从这一刻重起
  follow(a, NOW + 5000, every, SPIN.stepMs, () => undefined)
  expect(clockOf(a, SPIN.stepMs)).toBe(NOW + 5000)
  expect(timers).toEqual(['t1:150 停', 't2:150', 't3:150'])
})

test('有 Client、模块没出过错才用它；ui.fault 报的路径按文件名认', () => {
  const els = { Client: () => null }
  expect(liveOf(els, 'terminal', 5, [])).toEqual({ now: 5, spinner: true, elapsed: true })
  expect(liveOf(els, 'desktop', 5, [])).toEqual({ now: 5, spinner: true, elapsed: true })
  expect(liveOf(els, 'terminal', 5, ['spinner.tsx'])).toEqual({ now: 5, spinner: false, elapsed: true })
  expect(liveOf(els, 'terminal', 5, ['spinner.tsx', 'elapsed.tsx'])).toEqual({ now: 5, spinner: false, elapsed: false })
  expect(liveOf({}, 'terminal', 5, [])).toEqual({ now: 5, spinner: false, elapsed: false })
  // VS Code 的 resolve 也给 Client，但它的元素表里没有，画出来是空的
  expect(liveOf(els, 'vscode', 5, [])).toEqual({ now: 5, spinner: false, elapsed: false })
  // 分隔线不再有 Client（anvil-k0t.46 去掉了呼吸）
  expect(faultedModule('hooks/rail.tsx')).toBe(null)
  expect(faultedModule('hooks\\elapsed.tsx')).toBe('elapsed.tsx')
  expect(faultedModule('./spinner.tsx')).toBe('spinner.tsx')
  expect(faultedModule('hooks/other.tsx')).toBe(null)
})

// ---------------------------------------------------------------- 面板里的动效

function engine(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { clock, ...w }
}

const sized = (columns: number) => ({
  plugin: 'anvil',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'anvil',
  props: { title: 'anvil', isFocused: false, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 48 }, view: {} },
})

/** VS Code 的元素表没有 Client */
const vscode = (columns: number) => ({ ...sized(columns), surface: 'vscode' as const })

type Cell = { color?: unknown; bold?: unknown; dimColor?: unknown }

/** Client 画出来的一行，逐格展开成颜色 */
function cellsOf(node: unknown): Cell[] {
  if (node === null || typeof node !== 'object') return []
  const { type, props, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  if (type === 'Text') {
    const style: Cell = {}
    if (props?.color !== undefined) style.color = props.color
    if (props?.bold) style.bold = props.bold
    if (props?.dimColor) style.dimColor = props.dimColor
    return [...flat(node)].map(() => style)
  }
  return (children ?? (props?.children as unknown[] | undefined) ?? []).flatMap(cellsOf)
}

/** 一行里各段字和它的颜色（Text 嵌套时沿用外层的颜色） */
function textsOf(node: unknown, inherited?: unknown): { text: string; color?: unknown }[] {
  if (node === null || typeof node !== 'object') return []
  const { type, props, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const color = type === 'Text' && props?.color !== undefined ? props.color : inherited
  const kids = children ?? (props?.children as unknown[] | undefined) ?? []
  const own = kids.filter((kid): kid is string => typeof kid === 'string').join('')
  const nested = kids.filter(kid => typeof kid !== 'string').flatMap(kid => textsOf(kid, color))
  return type === 'Text' && own !== '' ? [{ text: own, color }, ...nested] : nested
}

test('框与框之间空一行，不画分隔线；没有东西在发生时面板上没有转动的图标', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  for (const columns of [50, 70, 90]) {
    const ui = await $.ui.mount(sized(columns))
    for (const id of ['usage', 'messages']) {
      const gap = await ui.find({ key: `gap:${id}` })
      expect(gap?.props, `${columns} 列 ${id}`).toMatchObject({ width: columns, height: 1 })
      expect(flat(gap)).toBe('')
    }
    // 缓存框上面不空行
    expect(await ui.find({ key: 'gap:cache' })).toBeUndefined()
    expect(await ui.find({ key: 'rule:usage' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Client' })).toEqual([])
    expect(flat(await ui.find({ key: 'identity:speed' }))).toBe(`${ICON.speed} —`)
    await ui.unmount()
  }
})

test('主会话正在回复时，身份栏速度行的图标换成转动的 ◐，上一次的读数退到次要色；回复结束复原', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  // 第二轮的第一次请求已经开始、还没结束
  await drain($.turn.step(stepInput()))
  await clock.advance(700)
  const ui = await $.ui.mount(sized(70))
  expect((await ui.find({ key: 'spin:speed' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1, props: { color: COLOR.active, now: NOW + 700 } })
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(NOW + 700))
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:speed' }))).toBe(spinGlyph(NOW + 700 + SPIN.stepMs))
  const numbers = textsOf(await ui.find({ key: 'identity:speed' })).filter(one => /\d|—/.test(one.text))
  expect(numbers.length).toBeGreaterThan(0)
  for (const one of numbers) expect(one.color, one.text).toBe(COLOR.secondary)

  await $.turn.complete(turnInput())
  await ui.redraw()
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  const after = textsOf(await ui.find({ key: 'identity:speed' }))
  expect(after[0]).toMatchObject({ text: ICON.speed, color: COLOR.icon })
  const values = after.filter(one => /\d|—/.test(one.text))
  expect(values.length).toBeGreaterThan(0)
  for (const one of values) expect(one.color, one.text).toBeUndefined()
  await ui.unmount()
})

test('子 agent 的回复不算主会话在回复', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput({ agentId: 'ag1' })))
  const ui = await $.ui.mount(sized(70))
  expect(await ui.find({ key: 'spin:speed' })).toBeUndefined()
  await ui.unmount()
})

test('子 agent 运行中：状态列的 ◐ 原地转动、耗时每秒走；结束后固定', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await clock.advance(5000)
  const ui = await $.ui.mount(sized(70))
  // 压在 Button 的状态列（"1: " 之后）和耗时一列（右对齐 6 格）上
  expect((await ui.find({ key: 'over:mark:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 3 })
  expect((await ui.find({ key: 'over:time:ag1' }))?.props).toMatchObject({ position: 'absolute', top: 0, left: 70 - 4 - 6 })
  expect((await ui.find({ key: 'spin:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', width: 1 })
  expect((await ui.find({ key: 'clock:agent:ag1' }))?.props).toMatchObject({ module: 'hooks/elapsed.tsx', width: 6 })

  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000))
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    5s')
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:agent:ag1' }))).toBe(spinGlyph(NOW + 5000 + SPIN.stepMs))
  await ui.advance(1000 - SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe('    6s')
  await ui.advance(60_000)
  expect(flat(await ui.drawn({ in: 'clock:agent:ag1' }))).toBe(' 1m06s')
  // Button 里照样有静止的 ◐ 和按面板重画时算的耗时，写法和列宽不变
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)

  await clock.advance(2000)
  await $.turn.complete(turnInput({ agentId: 'ag1' }))
  await ui.redraw()
  expect(await ui.find({ key: 'spin:agent:ag1' })).toBeUndefined()
  expect(await ui.find({ key: 'clock:agent:ag1' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^\u{F00C} +核对读数 +Sonnet +7s$/u)
  await ui.unmount()
})

test('缓存框保活：续期请求在路上时"进行中 ◐"，图标接在文字后面，请求结束就去掉', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  // 排在 world 的 fork 之前：这一次续期请求停在路上，放行后读到整段缓存
  on('model.fork', {}, async () => {
    await gate
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 150000, cache_creation_input_tokens: 40 } } }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await drain($.turn.step(stepInput()))
  await $.turn.complete(turnInput())
  await clock.advance(PING_AFTER_MS)

  const ui = await $.ui.mount(sized(70))
  const row = await ui.find({ key: 'row:keepalive' })
  // Client 没有子元素：flat 只拿到它前面空的那一格
  expect(flat(row)).toBe('保活进行中 ')
  expect((await ui.find({ key: 'spin:keepalive' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { color: COLOR.active } })
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(NOW + PING_AFTER_MS))
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:keepalive' }))).toBe(spinGlyph(NOW + PING_AFTER_MS + SPIN.stepMs))

  release()
  await clock.settle()
  await ui.redraw()
  expect(await ui.find({ key: 'spin:keepalive' })).toBeUndefined()
  expect(flat(await ui.find({ key: 'row:keepalive' }))).toBe('保活进行中')
  await ui.unmount()
})

// ---------------------------------------------------------------- 翻译框

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('翻译框正在翻译时 ◐ 原地转动，后面的字不动', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  on('model.complete', async () => {
    await gate
    const value: ModelCompleteResult = { isAnswered: true, text: 'Make it async.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    return { value }
  })
  const { clock } = engine(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'anvil', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const input = await ui.find({ type: 'Input' })
  await ui.input({ key: input?.key ?? '', text: '把函数改成异步的' })
  await clock.settle()
  await ui.redraw()
  const status = await ui.find({ key: 'status:translate' })
  expect(flat(status)).toBe(' 正在翻译')
  expect((await ui.find({ key: 'spin:translate' }))?.props).toMatchObject({ module: 'hooks/spinner.tsx', props: { color: COLOR.active } })
  const now = (await ui.find({ key: 'spin:translate' }))?.props.props as { now: number }
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(now.now))
  await ui.advance(SPIN.stepMs)
  expect(flat(await ui.drawn({ in: 'spin:translate' }))).toBe(spinGlyph(now.now + SPIN.stepMs))
  release()
  await ui.unmount()
})

// ---------------------------------------------------------------- 退路：没有 Client、Client 出错

async function stillPanel($: Engine, ui: Mounted<'terminal', 'Pane'> | Mounted<'vscode', 'Pane'>, columns: number) {
  // 一个 Client 都没有
  expect(await ui.findAll({ type: 'Client' })).toEqual([])
  // 框间是空行
  expect(flat(await ui.find({ key: 'gap:usage' }))).toBe('')
  void columns
  // 运行中的子 agent：Button 里静止的 ◐ 和按 now 算的耗时
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +5s$/)
}

test('没有 Client 的界面：◐ 静止、耗时随面板重画更新，回复中速度行是静止的 ◐', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  await drain($.turn.step(stepInput()))
  await clock.advance(5000)
  const ui = await $.ui.mount(vscode(70))
  await stillPanel($, ui, 70)
  expect(flat(await ui.find({ key: 'identity:speed' }))).toMatch(/^◐/)
  await clock.advance(3000)
  await ui.redraw()
  expect(flat(await ui.find({ key: 'agent:1' }))).toMatch(/^◐ +核对读数 +Sonnet +8s$/)
  await ui.unmount()
})

// Client 出错的退路：plugin test 的 `$` 没有 ui.fault，造不出这个事件（AGENTS.md Pitfalls）；
// 出错的模块不再用、退回静止由上面的 liveOf 单测核对，接线在交互会话里验证

// ---------------------------------------------------------------- 配色

test('四个彩框的标题用识别色加粗、边框用同色相调暗的一档；我的消息边框线色、标题正文色', async ($, on) => {
  engine(on)
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('核对读数'))
  const denied: ClassicEventOf['classic.PermissionDenied'] = {
    session_id: 's1',
    transcript_path: '/work/s1.jsonl',
    cwd: '/work',
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dir' },
    tool_use_id: 'deny1',
    reason: 'classifier',
  }
  await $.classic.PermissionDenied(denied)
  const ui = await $.ui.mount(sized(70))
  const sections: [string, string, string, string][] = [
    ['cache', '缓存', COLOR.cache, COLOR.cacheLine],
    ['usage', '用量', COLOR.usage, COLOR.usageLine],
    ['agents', '子 agent', COLOR.agents, COLOR.agentsLine],
    ['denials', '自动模式拒绝', COLOR.denials, COLOR.denialsLine],
  ]
  const texts = await ui.findAll({ type: 'Text' })
  for (const [id, title, color, border] of sections) {
    expect((await ui.find({ key: `box:${id}` }))?.props.borderColor, id).toBe(border)
    const head = texts.filter(one => (one.text ?? '').endsWith(title))
    expect(head.length, id).toBeGreaterThan(0)
    for (const one of head) expect(one.props, id).toMatchObject({ color, bold: true })
  }
  expect((await ui.find({ key: 'box:messages' }))?.props.borderColor).toBe(COLOR.line)
  await ui.unmount()
})
